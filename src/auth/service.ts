/**
 * 用户与会话服务：封装 users/sessions 表的存储操作。
 * S4-1 多用户体系核心；所有 userId 由服务端签发（UUID）。
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { hashToken, generateToken } from './token.js';

export interface User {
  id: string;
  username: string;
  createdAt: number;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
}

export class AuthService {
  constructor(private db: DatabaseSync) {}

  /** 初始化 users / sessions 表 */
  initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    `);
    this.deleteExpiredSessions();
  }

  /** 创建用户；用户名已存在时返回 null */
  createUser(username: string, passwordHash: string): User | null {
    const id = randomUUID();
    const now = Date.now();
    try {
      this.db
        .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, username, passwordHash, now, now);
      return { id, username, createdAt: now };
    } catch (err) {
      // SQLite UNIQUE 冲突
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) return null;
      throw err;
    }
  }

  /** 按用户名查用户（登录用） */
  getUserByUsername(username: string): { id: string; username: string; passwordHash: string; createdAt: number } | null {
    const row = this.db
      .prepare('SELECT id, username, password_hash, created_at FROM users WHERE username = ?')
      .get(username) as
      | { id: string; username: string; password_hash: string; created_at: number }
      | undefined;
    if (!row) return null;
    return { id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: row.created_at };
  }

  /** 创建会话；返回明文 token（仅一次） */
  createSession(userId: string): { session: Session; token: string } {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const id = randomUUID();
    const now = Date.now();
    const expiresAt = now + config.auth.sessionTtlHours * 60 * 60 * 1000;
    this.db
      .prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, tokenHash, expiresAt, now);
    return {
      session: { id, userId, tokenHash, expiresAt, createdAt: now },
      token,
    };
  }

  /** 按 token hash 查会话，并返回用户名 */
  getSessionByTokenHash(tokenHash: string): (Session & { username: string }) | null {
    const now = Date.now();
    const row = this.db
      .prepare(`
        SELECT s.id, s.user_id, s.token_hash, s.expires_at, s.created_at, u.username
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
      `)
      .get(tokenHash, now) as
      | { id: string; user_id: string; token_hash: string; expires_at: number; created_at: number; username: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      username: row.username,
    };
  }

  /** 删除会话（登出） */
  deleteSession(tokenHash: string): boolean {
    const res = this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return Number(res.changes) > 0;
  }

  /** 清理过期会话 */
  deleteExpiredSessions(): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }
}
