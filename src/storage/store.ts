/**
 * SQLite 存储（node:sqlite 内置模块，免原生编译；需 Node.js >= 22.13）。
 * 2026-09-14 从 JSON 文件迁移：公开方法签名保持不变，调用方无感。
 * 启动时若发现旧的 data/store.json，自动迁移自选股数据并把原文件改名 .migrated。
 *
 * 表结构：
 *   users(id, username, password_hash, created_at, updated_at)  用户账号（S4-1）
 *   sessions(id, user_id, token_hash, expires_at, created_at)   登录会话（S4-1）
 *   watchlists(user_id, code)         自选股，按用户隔离
 *   histories(user_id, messages, updated_at)  会话历史（含工具调用上下文，JSON 数组）
 *   inbox(id, user_id, text, created_at)      离线通知收件箱（WebChat 轮询拉取）
 *   kv(key, value)                            渠道杂项状态（如飞书 openId→chatId 映射）
 *   alert_rules(id, user_id, code, combinator, conditions, enabled, created_at)
 *                                             多条件监控规则（F5-4），conditions 为 JSON 数组
 */
import { mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { AuthService } from '../auth/service.js';
import type { AlertCondition, AlertCombinator, AlertRule } from '../alerts/rules.js';

/** 持久化的一条工具调用（与 OpenAI 兼容协议同构） */
export interface HistoryToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * 持久化的一条会话消息。2026-09-14 起保留工具调用上下文（P3）：
 * assistant 消息可带 tool_calls，其后紧跟对应 tool 消息（tool_call_id 关联）。
 * 裁剪规则（截断/丢弃孤儿 tool 消息）由 agent/loop.ts 的 trimHistory 负责，本层只存取。
 */
export interface HistoryMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: HistoryToolCall[];
  tool_call_id?: string;
}

/** alert_rules 表行结构（rowToRule 的入参） */
interface AlertRuleRow {
  id: number;
  user_id: string;
  code: string;
  combinator: string;
  conditions: string;
  enabled: number;
}

export class Store {
  private db: DatabaseSync;
  readonly auth: AuthService;

  constructor() {
    mkdirSync(config.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(config.dataDir, 'store.db'));
    this.auth = new AuthService(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watchlists (
        user_id TEXT NOT NULL,
        code TEXT NOT NULL,
        PRIMARY KEY (user_id, code)
      );
      CREATE TABLE IF NOT EXISTS histories (
        user_id TEXT PRIMARY KEY,
        messages TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alert_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        code TEXT NOT NULL,
        combinator TEXT NOT NULL,
        conditions TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `);
    this.auth.initTables();
    this.migrateLegacyJson();
  }

  /** 一次性迁移：旧 JSON 存储（2026-09-14 之前的版本）→ SQLite */
  private migrateLegacyJson(): void {
    const legacy = path.join(config.dataDir, 'store.json');
    if (!existsSync(legacy)) return;
    try {
      const data = JSON.parse(readFileSync(legacy, 'utf-8')) as {
        watchlists?: Record<string, string[]>;
      };
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO watchlists (user_id, code) VALUES (?, ?)',
      );
      for (const [userId, codes] of Object.entries(data.watchlists ?? {})) {
        for (const code of codes) insert.run(userId, code);
      }
      renameSync(legacy, `${legacy}.migrated`);
      console.log('[store] 已将 store.json 迁移到 SQLite（原文件重命名为 store.json.migrated）');
    } catch (err) {
      console.error('[store] store.json 迁移失败，保留原文件:', err);
    }
  }

  getWatchlist(userId: string): string[] {
    const rows = this.db
      .prepare('SELECT code FROM watchlists WHERE user_id = ? ORDER BY rowid')
      .all(userId) as { code: string }[];
    return rows.map((r) => r.code);
  }

  addToWatchlist(userId: string, code: string): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO watchlists (user_id, code) VALUES (?, ?)')
      .run(userId, code);
    return Number(res.changes) > 0;
  }

  removeFromWatchlist(userId: string, code: string): boolean {
    const res = this.db
      .prepare('DELETE FROM watchlists WHERE user_id = ? AND code = ?')
      .run(userId, code);
    return Number(res.changes) > 0;
  }

  /** 所有有自选股列表的用户（定时推送用） */
  allUsers(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT user_id FROM watchlists').all() as {
      user_id: string;
    }[];
    return rows.map((r) => r.user_id);
  }

  getHistory(userId: string): HistoryMessage[] {
    const row = this.db
      .prepare('SELECT messages FROM histories WHERE user_id = ?')
      .get(userId) as { messages: string } | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.messages) as HistoryMessage[];
    } catch {
      return []; // 数据损坏时宁可丢历史也不让对话挂掉
    }
  }

  saveHistory(userId: string, messages: HistoryMessage[]): void {
    this.db
      .prepare(
        `INSERT INTO histories (user_id, messages, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
      )
      .run(userId, JSON.stringify(messages), Date.now());
  }

  /** 写入一条离线通知（WebChat 收件箱）。每用户只保留最近 100 条，防不再轮询的用户无限累积（审计 A-408） */
  pushInbox(userId: string, text: string): void {
    this.db
      .prepare('INSERT INTO inbox (user_id, text, created_at) VALUES (?, ?, ?)')
      .run(userId, text, Date.now());
    this.db
      .prepare(
        `DELETE FROM inbox WHERE user_id = ? AND id NOT IN
         (SELECT id FROM inbox WHERE user_id = ? ORDER BY id DESC LIMIT 100)`,
      )
      .run(userId, userId);
  }

  /** 取出并清空某用户的全部离线通知（轮询语义：读后即删），按写入顺序返回 */
  drainInbox(userId: string): string[] {
    const rows = this.db
      .prepare('SELECT id, text FROM inbox WHERE user_id = ? ORDER BY id')
      .all(userId) as { id: number; text: string }[];
    if (rows.length > 0) this.db.prepare('DELETE FROM inbox WHERE user_id = ?').run(userId);
    return rows.map((r) => r.text);
  }

  // ---- 多条件监控规则（F5-4） ----

  /** 新增监控规则，返回自增 id（conditions 入库前必须已过 validateConditions） */
  addAlertRule(
    userId: string,
    code: string,
    combinator: AlertCombinator,
    conditions: AlertCondition[],
  ): number {
    const res = this.db
      .prepare(
        'INSERT INTO alert_rules (user_id, code, combinator, conditions, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      )
      .run(userId, code, combinator, JSON.stringify(conditions), Date.now());
    return Number(res.lastInsertRowid);
  }

  private rowToRule(r: AlertRuleRow): AlertRule | null {
    let conditions: AlertCondition[];
    try {
      const parsed = JSON.parse(r.conditions) as unknown;
      if (!Array.isArray(parsed)) return null; // 数据损坏：宁可跳过该规则也不让轮询挂掉
      conditions = parsed as AlertCondition[];
    } catch {
      return null;
    }
    return {
      id: r.id,
      userId: r.user_id,
      code: r.code,
      combinator: r.combinator === 'all' ? 'all' : 'any',
      conditions,
      enabled: r.enabled === 1,
    };
  }

  /** 某用户的全部监控规则（含已停用，list 用），按创建顺序 */
  getAlertRules(userId: string): AlertRule[] {
    const rows = this.db
      .prepare(
        'SELECT id, user_id, code, combinator, conditions, enabled FROM alert_rules WHERE user_id = ? ORDER BY id',
      )
      .all(userId) as unknown as AlertRuleRow[];
    return rows.flatMap((r) => {
      const rule = this.rowToRule(r);
      return rule ? [rule] : [];
    });
  }

  /** 全部用户的启用中规则（盘中轮询用） */
  getEnabledAlertRules(): AlertRule[] {
    const rows = this.db
      .prepare(
        'SELECT id, user_id, code, combinator, conditions, enabled FROM alert_rules WHERE enabled = 1 ORDER BY id',
      )
      .all() as unknown as AlertRuleRow[];
    return rows.flatMap((r) => {
      const rule = this.rowToRule(r);
      return rule ? [rule] : [];
    });
  }

  /** 某用户的规则条数（配合 MAX_RULES_PER_USER 防滥用） */
  countAlertRules(userId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM alert_rules WHERE user_id = ?')
      .get(userId) as { n: number };
    return Number(row.n);
  }

  /** 删除规则（按 userId 隔离，删别人的规则返回 false） */
  removeAlertRule(userId: string, id: number): boolean {
    const res = this.db
      .prepare('DELETE FROM alert_rules WHERE user_id = ? AND id = ?')
      .run(userId, id);
    return Number(res.changes) > 0;
  }

  /** 启用/停用规则（按 userId 隔离），规则不存在返回 false */
  setAlertRuleEnabled(userId: string, id: number, enabled: boolean): boolean {
    const res = this.db
      .prepare('UPDATE alert_rules SET enabled = ? WHERE user_id = ? AND id = ?')
      .run(enabled ? 1 : 0, userId, id);
    return Number(res.changes) > 0;
  }

  /** 渠道杂项状态读写（如飞书 openId→chatId 映射，key 形如 "feishu:chat:<openId>"） */
  getKv(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /**
   * 关闭底层数据库连接。生产进程随退出自动释放，主要给测试用：
   * Windows 上被进程持有的数据库文件句柄不允许删除，不关连接清理临时目录会 EPERM。
   */
  close(): void {
    this.db.close();
  }
}
