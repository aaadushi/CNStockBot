/**
 * SQLite 存储（node:sqlite 内置模块，免原生编译；需 Node.js >= 22.13）。
 * 2026-09-14 从 JSON 文件迁移：公开方法签名保持不变，调用方无感。
 * 启动时若发现旧的 data/store.json，自动迁移自选股数据并把原文件改名 .migrated。
 *
 * 表结构：
 *   watchlists(user_id, code)         自选股，按用户隔离
 *   histories(user_id, messages, updated_at)  会话历史（只存 user/assistant 问答对，JSON 数组）
 */
import { mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

/** 持久化的一条会话消息（只存问答对，不含 system/tool） */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class Store {
  private db: DatabaseSync;

  constructor() {
    mkdirSync(config.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(config.dataDir, 'store.db'));
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
    `);
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
}
