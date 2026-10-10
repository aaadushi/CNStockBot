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
 *   inbox(id, user_id, text, created_at, read) 离线通知收件箱（WebChat drain 拉取，
 *                                      F7-4 起归档保留 + 已读标记，drain=标记已读不再删除）
 *   kv(key, value)                            渠道杂项状态（如飞书 openId→chatId 映射）
 *   alert_rules(id, user_id, code, combinator, conditions, enabled, created_at)
 *                                             多条件监控规则（F5-4），conditions 为 JSON 数组
 *   feedback(id, user_id, username, text, contact, created_at)
 *                                             意见反馈（REQ-Feedback-Admin），每用户保留最近 200 条
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

/** 收件箱归档条目（F7-4 消息中心 /api/inbox/history 用） */
export interface InboxEntry {
  id: number;
  text: string;
  createdAt: number;
  read: boolean;
}

/** 意见反馈条目（REQ-Feedback-Admin，管理端 /api/admin/feedback 用） */
export interface FeedbackEntry {
  id: number;
  userId: string;
  username: string;
  text: string;
  contact: string;
  createdAt: number;
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
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        text TEXT NOT NULL,
        contact TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
    `);
    this.auth.initTables();
    this.migrateInboxReadColumn();
    this.migrateLegacyJson();
  }

  /**
   * F7-4 迁移：存量 inbox 表无 read 列时补列，默认值 1（视为已读）——
   * 老库里的消息已被 drain 消费过（当时读后即删，留存的都是历史残留），
   * 若默认未读会造成"老消息全亮未读"。
   */
  private migrateInboxReadColumn(): void {
    const cols = this.db.prepare('PRAGMA table_info(inbox)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'read')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN read INTEGER NOT NULL DEFAULT 1');
    }
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

  /**
   * 写入一条离线通知（WebChat 收件箱），初始为未读。
   * 每用户只保留最近 100 条，防不再轮询的用户无限累积（审计 A-408；F7-4 起
   * drain 不再删除，归档保留全靠这里的条数上限兜底，增长有界）。
   */
  pushInbox(userId: string, text: string): void {
    this.db
      .prepare('INSERT INTO inbox (user_id, text, created_at, read) VALUES (?, ?, ?, 0)')
      .run(userId, text, Date.now());
    this.db
      .prepare(
        `DELETE FROM inbox WHERE user_id = ? AND id NOT IN
         (SELECT id FROM inbox WHERE user_id = ? ORDER BY id DESC LIMIT 100)`,
      )
      .run(userId, userId);
  }

  /**
   * 取出某用户的全部未读通知并按写入顺序返回（drain 语义：聊天页唯一轮询者，
   * 每条消息只被消费一次）。
   * F7-4 起不再删除，而是把取走的消息标记为已读——消息中心（/inbox）可以回查
   * 历史，且不会出现"聊天里看过、消息中心还显示未读"的矛盾（REQ-F7-4 FR-2）。
   */
  drainInbox(userId: string): string[] {
    const rows = this.db
      .prepare('SELECT id, text FROM inbox WHERE user_id = ? AND read = 0 ORDER BY id')
      .all(userId) as { id: number; text: string }[];
    if (rows.length > 0) {
      const mark = this.db.prepare('UPDATE inbox SET read = 1 WHERE id = ?');
      for (const r of rows) mark.run(r.id);
    }
    return rows.map((r) => r.text);
  }

  /**
   * 非破坏拉取收件箱归档（F7-4 消息中心）：不删除、不置读，按时间倒序返回
   * 最近 limit 条 + 未读数。limit 由调用方（API 层）收敛，不做全表扫描。
   */
  getInboxHistory(userId: string, limit: number): { messages: InboxEntry[]; unreadCount: number } {
    const messages = this.db
      .prepare(
        'SELECT id, text, created_at, read FROM inbox WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(userId, limit) as { id: number; text: string; created_at: number; read: number }[];
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND read = 0')
      .get(userId) as { n: number };
    return {
      messages: messages.map((r) => ({
        id: r.id,
        text: r.text,
        createdAt: r.created_at,
        read: r.read === 1,
      })),
      unreadCount: n,
    };
  }

  /** 把当前用户全部未读通知标记为已读（F7-4 消息中心"全部标为已读"），返回标记条数 */
  markInboxRead(userId: string): number {
    const res = this.db
      .prepare('UPDATE inbox SET read = 1 WHERE user_id = ? AND read = 0')
      .run(userId);
    return Number(res.changes);
  }

  // ---- 意见反馈（REQ-Feedback-Admin） ----

  /**
   * 写入一条意见反馈。username 为提交时快照（当前无改名功能，快照只是双保险）。
   * 每用户只保留最近 200 条，防单用户无限累积（模式同 pushInbox 的 100 条封顶）。
   * 返回自增 id。
   */
  pushFeedback(userId: string, username: string, text: string, contact: string): number {
    const res = this.db
      .prepare(
        'INSERT INTO feedback (user_id, username, text, contact, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(userId, username, text, contact, Date.now());
    this.db
      .prepare(
        `DELETE FROM feedback WHERE user_id = ? AND id NOT IN
         (SELECT id FROM feedback WHERE user_id = ? ORDER BY id DESC LIMIT 200)`,
      )
      .run(userId, userId);
    return Number(res.lastInsertRowid);
  }

  /** 反馈总量（管理端 total 用） */
  countFeedback(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM feedback').get() as { n: number };
    return Number(row.n);
  }

  /**
   * 管理员查看全部用户反馈（跨用户视图，唯一门槛是 API 层的 requireAdmin），
   * 按时间倒序返回最近 limit 条。limit 由调用方（API 层）收敛，不做全表扫描。
   */
  listFeedback(limit: number): FeedbackEntry[] {
    const rows = this.db
      .prepare(
        'SELECT id, user_id, username, text, contact, created_at FROM feedback ORDER BY id DESC LIMIT ?',
      )
      .all(limit) as {
      id: number;
      user_id: string;
      username: string;
      text: string;
      contact: string;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      text: r.text,
      contact: r.contact,
      createdAt: r.created_at,
    }));
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
