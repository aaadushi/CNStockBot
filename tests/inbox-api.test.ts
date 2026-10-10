/**
 * 消息中心 API 集成测试（REQ-F7-4）：
 * /api/inbox/history 非破坏拉取、/api/inbox/read 标记已读、未登录 401、
 * 以及"聊天页 drain 与消息中心 history 并存"的互抢防护。
 *
 * 审计要点守护（REQ-F7-4 审计节）：
 * - history 不得删除/置读服务端消息；
 * - drain 取走的消息必须视为已读（两处未读状态自洽）；
 * - 消息中心若改成轮询 drain 接口，本文件的"history 两轮拉取 + drain 不受影响"
 *   用例会立刻失败。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

let Store: (typeof import('../src/storage/store.js'))['Store'];
let WebChatChannel: (typeof import('../src/channels/webchat.js'))['WebChatChannel'];
let dataDir: string;
const opened: InstanceType<typeof Store>[] = [];

function makeStore(): InstanceType<typeof Store> {
  const s = new Store();
  opened.push(s);
  return s;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'cnstockbot-inbox-api-'));
  process.env.DATA_DIR = dataDir;
  [{ Store }, { WebChatChannel }] = await Promise.all([
    import('../src/storage/store.js'),
    import('../src/channels/webchat.js'),
  ]);
});

afterAll(() => {
  for (const s of opened) s.close();
  delete process.env.DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function buildApp(store: InstanceType<typeof Store>) {
  const app = express();
  app.use(express.json());
  const data = {
    name: 'mock',
    getQuote: async () => { throw new Error('no quote in test'); },
  } as unknown as import('../src/data/provider.js').DataProvider;
  const agent = {
    handleMessage: async (_userId: string, message: string) => `echo:${message}`,
  } as unknown as import('../src/agent/loop.js').Agent;
  new WebChatChannel(store, data).mount(app, agent);
  return app;
}

/** 注册并返回 { token, userId }；userId 是服务端签发的 UUID（S4-1），收件箱按它隔离 */
async function register(app: express.Express, username: string): Promise<{ token: string; userId: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'helloWorld1' });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

describe('消息中心 API（REQ-F7-4）', () => {
  it('未登录访问 history / read 一律 401', async () => {
    const app = buildApp(makeStore());
    const h = await request(app).get('/api/inbox/history');
    expect(h.status).toBe(401);
    const r = await request(app).post('/api/inbox/read');
    expect(r.status).toBe(401);
  });

  it('history 非破坏：两轮拉取内容一致，未读数不变', async () => {
    const store = makeStore();
    const app = buildApp(store);
    const { token, userId } = await register(app, 'hist1');
    store.pushInbox(userId, '收盘日报：今日概览');
    store.pushInbox(userId, '异动提醒：贵州茅台 +5%');

    const first = await request(app).get('/api/inbox/history').set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.unreadCount).toBe(2);
    expect(first.body.messages).toHaveLength(2);
    expect(first.body.messages[0].text).toBe('异动提醒：贵州茅台 +5%'); // 倒序
    expect(first.body.messages.every((m: { read: boolean }) => !m.read)).toBe(true);

    const second = await request(app).get('/api/inbox/history').set('Authorization', `Bearer ${token}`);
    expect(second.body).toEqual(first.body); // 不删除、不置读
  });

  it('drain（聊天页）与 history（消息中心）并存：drain 不删归档，取走即已读', async () => {
    const store = makeStore();
    const app = buildApp(store);
    const { token, userId } = await register(app, 'coexist');
    store.pushInbox(userId, 'msg-A');
    store.pushInbox(userId, 'msg-B');

    // 消息中心先拉（未读 2）
    const before = await request(app).get('/api/inbox/history').set('Authorization', `Bearer ${token}`);
    expect(before.body.unreadCount).toBe(2);

    // 聊天页 drain：取走 2 条，行为不变
    const drain = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
    expect(drain.status).toBe(200);
    expect(drain.body.messages).toEqual(['msg-A', 'msg-B']);
    const drainAgain = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
    expect(drainAgain.body.messages).toEqual([]); // 不重复消费

    // 消息中心回查：归档仍在，且 drain 取走的视为已读（未读自洽，REQ-F7-4 FR-2）
    const after = await request(app).get('/api/inbox/history').set('Authorization', `Bearer ${token}`);
    expect(after.body.messages).toHaveLength(2);
    expect(after.body.messages.every((m: { read: boolean }) => m.read)).toBe(true);
    expect(after.body.unreadCount).toBe(0);
  });

  it('POST /api/inbox/read 标记已读，未读数归零', async () => {
    const store = makeStore();
    const app = buildApp(store);
    const { token, userId } = await register(app, 'reader');
    store.pushInbox(userId, 'x');
    store.pushInbox(userId, 'y');

    const res = await request(app).post('/api/inbox/read').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(2);
    expect(res.body.unreadCount).toBe(0);

    const h = await request(app).get('/api/inbox/history').set('Authorization', `Bearer ${token}`);
    expect(h.body.unreadCount).toBe(0);
    expect(h.body.messages.every((m: { read: boolean }) => m.read)).toBe(true);
  });

  it('按用户隔离：A 的消息不出现在 B 的 history', async () => {
    const store = makeStore();
    const app = buildApp(store);
    const { token: tokenA, userId: userIdA } = await register(app, 'iso-a');
    const { token: tokenB } = await register(app, 'iso-b');
    store.pushInbox(userIdA, '只给 A');

    const hA = await request(app).get('/api/inbox/history').set('Authorization', `Bearer ${tokenA}`);
    expect(hA.body.messages.map((m: { text: string }) => m.text)).toEqual(['只给 A']);
    const hB = await request(app).get('/api/inbox/history').set('Authorization', `Bearer ${tokenB}`);
    expect(hB.body.messages).toEqual([]);
    expect(hB.body.unreadCount).toBe(0);
  });

  it('limit 参数收敛在 1..100，缺省 50', async () => {
    const store = makeStore();
    const app = buildApp(store);
    const { token, userId } = await register(app, 'lim');
    for (let i = 0; i < 60; i++) store.pushInbox(userId, `m${i}`);

    const def = await request(app).get('/api/inbox/history').set('Authorization', `Bearer ${token}`);
    expect(def.body.messages).toHaveLength(50); // 缺省 50
    const small = await request(app).get('/api/inbox/history?limit=5').set('Authorization', `Bearer ${token}`);
    expect(small.body.messages).toHaveLength(5);
    const huge = await request(app).get('/api/inbox/history?limit=99999').set('Authorization', `Bearer ${token}`);
    expect(huge.body.messages).toHaveLength(60); // limit 封顶 100，全部返回
  });
});
