/**
 * WebChat 渠道认证集成测试：注册/登录/登出、业务端点 401、用户隔离。
 * 使用 supertest 对真实 WebChatChannel.mount 后的 Express app 发请求。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

let Store: (typeof import('../../src/storage/store.js'))['Store'];
let WebChatChannel: (typeof import('../../src/channels/webchat.js'))['WebChatChannel'];
let dataDir: string;
const opened: InstanceType<typeof Store>[] = [];

function makeStore(): InstanceType<typeof Store> {
  const s = new Store();
  opened.push(s);
  return s;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'cnstockbot-auth-routes-'));
  process.env.DATA_DIR = dataDir;
  [{ Store }, { WebChatChannel }] = await Promise.all([
    import('../../src/storage/store.js'),
    import('../../src/channels/webchat.js'),
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
  } as unknown as import('../../src/data/provider.js').DataProvider;
  const agent = {
    handleMessage: async (_userId: string, message: string) => `echo:${message}`,
  } as unknown as import('../../src/agent/loop.js').Agent;
  const channel = new WebChatChannel(store, data);
  channel.mount(app, agent);
  return { app, agent, channel };
}

describe('认证端点', () => {
  it('注册成功并返回 token', async () => {
    const store = makeStore();
    const { app } = buildApp(store);
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', password: 'helloWorld1' });
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('alice');
    expect(res.body.token).toBeDefined();
  });

  it('重复用户名 409', async () => {
    const store = makeStore();
    const { app } = buildApp(store);
    await request(app).post('/api/auth/register').send({ username: 'bob', password: 'helloWorld1' });
    const res = await request(app).post('/api/auth/register').send({ username: 'bob', password: 'helloWorld2' });
    expect(res.status).toBe(409);
  });

  it('登录成功返回 token，错误密码 401 不暴露用户名存在性', async () => {
    const store = makeStore();
    const { app } = buildApp(store);
    await request(app).post('/api/auth/register').send({ username: 'carol', password: 'helloWorld1' });

    const ok = await request(app).post('/api/auth/login').send({ username: 'carol', password: 'helloWorld1' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeDefined();

    const badPwd = await request(app).post('/api/auth/login').send({ username: 'carol', password: 'wrong' });
    expect(badPwd.status).toBe(401);
    expect(badPwd.body.error).toBe('用户名或密码错误');

    const badUser = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'helloWorld1' });
    expect(badUser.status).toBe(401);
    expect(badUser.body.error).toBe('用户名或密码错误');
  });

  it('登出使 token 失效', async () => {
    const store = makeStore();
    const { app } = buildApp(store);
    const reg = await request(app).post('/api/auth/register').send({ username: 'dave', password: 'helloWorld1' });
    const token = reg.body.token;

    const before = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);

    await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);

    const after = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });
});

describe('业务端点鉴权与隔离', () => {
  it('无 token 访问 /api/chat、/api/inbox、/api/watchlist 返回 401', async () => {
    const store = makeStore();
    const { app } = buildApp(store);
    const chat = await request(app).post('/api/chat').send({ message: 'hi' });
    expect(chat.status).toBe(401);
    const inbox = await request(app).get('/api/inbox');
    expect(inbox.status).toBe(401);
    const watchlist = await request(app).get('/api/watchlist');
    expect(watchlist.status).toBe(401);
  });

  it('用户 A 无法读取用户 B 的收件箱（客户端 userId 被忽略）', async () => {
    const store = makeStore();
    const { app } = buildApp(store);
    const a = await request(app).post('/api/auth/register').send({ username: 'user_a', password: 'helloWorld1' });
    const b = await request(app).post('/api/auth/register').send({ username: 'user_b', password: 'helloWorld1' });

    // 给用户 B 发一条收件箱消息
    store.pushInbox(b.body.user.id, '通知给B');

    // 用户 A 带 B 的 userId 参数请求 /api/inbox，应返回 A 自己的空收件箱
    const res = await request(app)
      .get('/api/inbox?userId=' + encodeURIComponent(b.body.user.id))
      .set('Authorization', `Bearer ${a.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });

  it('用户 A 无法操作用户 B 的自选股', async () => {
    const store = makeStore();
    const { app } = buildApp(store);
    const a = await request(app).post('/api/auth/register').send({ username: 'user_a2', password: 'helloWorld1' });
    const b = await request(app).post('/api/auth/register').send({ username: 'user_b2', password: 'helloWorld1' });

    // A 加 B 的自选股，带 B 的 userId，实际加到 A 自己
    await request(app)
      .post('/api/watchlist')
      .set('Authorization', `Bearer ${a.body.token}`)
      .send({ userId: b.body.user.id, code: '600519' });

    const aList = await request(app).get('/api/watchlist').set('Authorization', `Bearer ${a.body.token}`);
    expect(aList.body.stocks.map((s: { code: string }) => s.code)).toContain('600519');

    const bList = await request(app).get('/api/watchlist').set('Authorization', `Bearer ${b.body.token}`);
    expect(bList.body.stocks).toEqual([]);
  });
});
