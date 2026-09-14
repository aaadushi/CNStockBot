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

/** 已打开的 Store 实例：afterAll 里统一 close()，否则 Windows 下删不掉临时目录 */
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
  for (const s of opened) s.close(); // Store 已提供公开 close()（2026-09-14 起）
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

  it('会话历史支持工具调用上下文（tool 消息与 tool_calls 字段往返）', () => {
    const s = makeStore();
    s.saveHistory('u4', [
      { role: 'user', content: '茅台咋样' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_stock_quote', arguments: '{"code":"600519"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '贵州茅台 1277.96 元 +0.22%' },
      { role: 'assistant', content: '涨了 0.22%' },
    ]);
    const back = makeStore().getHistory('u4');
    expect(back).toHaveLength(4);
    expect(back[1].tool_calls?.[0].function.name).toBe('get_stock_quote');
    expect(back[2].tool_call_id).toBe('c1');
  });
});

describe('Store 离线通知收件箱', () => {
  it('push / drain 往返，读后即删，按写入顺序', () => {
    const s = makeStore();
    expect(s.drainInbox('u5')).toEqual([]); // 空收件箱
    s.pushInbox('u5', '第一条');
    s.pushInbox('u5', '第二条');
    expect(makeStore().drainInbox('u5')).toEqual(['第一条', '第二条']);
    expect(s.drainInbox('u5')).toEqual([]); // 已清空
  });

  it('按 userId 隔离', () => {
    const s = makeStore();
    s.pushInbox('alice', '给 alice');
    s.pushInbox('bob', '给 bob');
    expect(s.drainInbox('alice')).toEqual(['给 alice']);
    expect(s.drainInbox('bob')).toEqual(['给 bob']);
  });
});

describe('Store KV（渠道杂项状态）', () => {
  it('set / get 往返，覆盖更新，缺失返回 null', () => {
    const s = makeStore();
    expect(s.getKv('feishu:chat:nobody')).toBeNull();
    s.setKv('feishu:chat:ou_1', 'oc_aaa');
    expect(makeStore().getKv('feishu:chat:ou_1')).toBe('oc_aaa');
    s.setKv('feishu:chat:ou_1', 'oc_bbb');
    expect(s.getKv('feishu:chat:ou_1')).toBe('oc_bbb');
  });
});
