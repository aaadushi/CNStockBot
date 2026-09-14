/**
 * Store 存储单测：自选股 CRUD / 用户隔离 / 会话历史持久化。
 * Store 无纯函数（全部走 node:sqlite），这里用临时目录起真实 SQLite 库做往返测试，
 * 不触碰项目的 data/ 目录。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let Store: (typeof import('../src/storage/store.js'))['Store'];
let dataDir: string;

/** 已打开的 Store 实例：afterAll 里统一关闭底层 DatabaseSync，否则 Windows 下删不掉临时目录 */
const opened: InstanceType<typeof Store>[] = [];

function makeStore(): InstanceType<typeof Store> {
  const s = new Store();
  opened.push(s);
  return s;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'cnstockbot-test-'));
  // config 在模块加载时读取环境变量，必须先设 DATA_DIR 再动态 import
  process.env.DATA_DIR = dataDir;
  ({ Store } = await import('../src/storage/store.js'));
});

afterAll(() => {
  for (const s of opened) {
    // Store 未暴露 close()，TS private 仅是编译期约束，测试里直接关底层连接
    (s as unknown as { db: { close(): void } }).db.close();
  }
  delete process.env.DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Store 自选股', () => {
  it('新用户自选股为空', () => {
    expect(makeStore().getWatchlist('nobody')).toEqual([]);
  });

  it('添加 / 查询 / 删除往返', () => {
    const s = makeStore();
    expect(s.addToWatchlist('u1', '600519')).toBe(true);
    expect(s.addToWatchlist('u1', '300750')).toBe(true);
    expect(s.getWatchlist('u1')).toEqual(['600519', '300750']);
    expect(s.removeFromWatchlist('u1', '600519')).toBe(true);
    expect(s.getWatchlist('u1')).toEqual(['300750']);
  });

  it('重复添加返回 false（幂等），删除不存在的代码返回 false', () => {
    const s = makeStore();
    expect(s.addToWatchlist('u2', '000001')).toBe(true);
    expect(s.addToWatchlist('u2', '000001')).toBe(false);
    expect(s.getWatchlist('u2')).toEqual(['000001']);
    expect(s.removeFromWatchlist('u2', '999999')).toBe(false);
  });

  it('按 userId 隔离，allUsers 只包含有自选股的用户', () => {
    const s = makeStore();
    s.addToWatchlist('alice', '600519');
    s.addToWatchlist('bob', '300750');
    expect(s.getWatchlist('alice')).toEqual(['600519']);
    expect(s.getWatchlist('bob')).toEqual(['300750']);
    s.removeFromWatchlist('alice', '600519');
    expect(s.getWatchlist('alice')).toEqual([]); // 不影响 bob
    expect(s.getWatchlist('bob')).toEqual(['300750']);

    const users = makeStore().allUsers();
    expect(users).toContain('bob');
    expect(users).toContain('u2'); // 上一个用例残留，同一临时库
    expect(users).not.toContain('alice');
  });
});

describe('Store 会话历史', () => {
  it('无历史返回空数组', () => {
    expect(makeStore().getHistory('ghost')).toEqual([]);
  });

  it('保存 / 读取往返，覆盖式更新', () => {
    const s = makeStore();
    s.saveHistory('u3', [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
    ]);
    expect(makeStore().getHistory('u3')).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
    ]);
    s.saveHistory('u3', [{ role: 'user', content: '第二轮' }]);
    expect(s.getHistory('u3')).toEqual([{ role: 'user', content: '第二轮' }]);
  });
});
