/**
 * AuthService 单测：用户/会话 CRUD、过期清理。
 * 复用 store 测试基座：临时目录 + 动态 import + close + rmSync。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let Store: (typeof import('../../src/storage/store.js'))['Store'];
let dataDir: string;
const opened: InstanceType<typeof Store>[] = [];

function makeStore(): InstanceType<typeof Store> {
  const s = new Store();
  opened.push(s);
  return s;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'cnstockbot-auth-test-'));
  process.env.DATA_DIR = dataDir;
  ({ Store } = await import('../../src/storage/store.js'));
});

afterAll(() => {
  for (const s of opened) s.close();
  delete process.env.DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('AuthService', () => {
  it('创建用户并查用户名', () => {
    const store = makeStore();
    const user = store.auth.createUser('alice', 'hash123');
    expect(user).not.toBeNull();
    expect(user?.username).toBe('alice');

    const found = store.auth.getUserByUsername('alice');
    expect(found?.passwordHash).toBe('hash123');
  });

  it('重复用户名返回 null', () => {
    const store = makeStore();
    expect(store.auth.createUser('bob', 'hash1')).not.toBeNull();
    expect(store.auth.createUser('bob', 'hash2')).toBeNull();
  });

  it('创建/查询/删除会话', () => {
    const store = makeStore();
    const user = store.auth.createUser('carol', 'hash')!;
    const { session, token } = store.auth.createSession(user.id);

    const found = store.auth.getSessionByTokenHash(require('node:crypto').createHash('sha256').update(token).digest('hex'));
    expect(found?.userId).toBe(user.id);

    const deleted = store.auth.deleteSession(session.tokenHash);
    expect(deleted).toBe(true);
    expect(store.auth.getSessionByTokenHash(session.tokenHash)).toBeNull();
  });

  it('过期会话被清理', () => {
    const store = makeStore();
    const user = store.auth.createUser('dave', 'hash')!;
    const { session } = store.auth.createSession(user.id);

    // 伪造过期：直接改表
    store['db']
      .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1000, session.id);

    store.auth.deleteExpiredSessions();
    expect(store.auth.getSessionByTokenHash(session.tokenHash)).toBeNull();
  });
});
