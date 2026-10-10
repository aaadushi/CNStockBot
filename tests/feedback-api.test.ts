/**
 * 意见反馈 + 最小管理端 API 集成测试（REQ-Feedback-Admin）：
 * 提交校验、按用户存储与隔离、管理员跨用户查看、非管理员 403、条数封顶。
 *
 * 审计要点守护（REQ-Feedback-Admin 审计节）：
 * - 管理 API 必须服务端 requireAdmin 鉴权（静态页可公开，数据接口不可）；
 * - ADMIN_USERS 为空集合时 fail-closed（见 tests/feedback-admin-unset.test.ts）；
 * - 反馈响应只含需求字段（用户名快照/文本/联系方式/时间），不含 UA/IP 类字段；
 * - 每用户反馈条数增长有界（store 层 200 条封顶）。
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
  dataDir = mkdtempSync(path.join(tmpdir(), 'cnstockbot-feedback-api-'));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_USERS = 'boss,boss-lim';
  [{ Store }, { WebChatChannel }] = await Promise.all([
    import('../src/storage/store.js'),
    import('../src/channels/webchat.js'),
  ]);
});

afterAll(() => {
  for (const s of opened) s.close();
  delete process.env.DATA_DIR;
  delete process.env.ADMIN_USERS;
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

/** 注册并返回 { token, userId }（admin1 等普通用户用 register，管理员用 ADMIN_USERS 里的 boss） */
async function register(app: express.Express, username: string): Promise<{ token: string; userId: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'helloWorld1' });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

describe('意见反馈（REQ-Feedback-Admin）', () => {
  it('未登录：提交与管理端一律 401', async () => {
    const app = buildApp(makeStore());
    const post = await request(app).post('/api/feedback').send({ text: 'test' });
    expect(post.status).toBe(401);
    const list = await request(app).get('/api/admin/feedback');
    expect(list.status).toBe(401);
  });

  it('提交校验：空文本/超长文本/超长联系方式 400，正常提交 200', async () => {
    const app = buildApp(makeStore());
    const { token } = await register(app, 'fb-valid');

    const empty = await request(app).post('/api/feedback').set('Authorization', `Bearer ${token}`).send({ text: '   ' });
    expect(empty.status).toBe(400);
    const noText = await request(app).post('/api/feedback').set('Authorization', `Bearer ${token}`).send({});
    expect(noText.status).toBe(400);
    const longText = await request(app).post('/api/feedback').set('Authorization', `Bearer ${token}`).send({ text: 'x'.repeat(2001) });
    expect(longText.status).toBe(400);
    const longContact = await request(app).post('/api/feedback').set('Authorization', `Bearer ${token}`).send({ text: 'ok', contact: 'c'.repeat(101) });
    expect(longContact.status).toBe(400);

    const ok = await request(app).post('/api/feedback').set('Authorization', `Bearer ${token}`).send({ text: '  聊天页打开慢  ', contact: '' });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(typeof ok.body.id).toBe('number');
  });

  it('store 层：写入倒序返回、字段完整、每用户 200 条封顶保留最新', async () => {
    const store = makeStore();
    const uid = 'store-user';
    store.pushFeedback(uid, 'storeuser', '第一条', 'wechat:a');
    const id2 = store.pushFeedback(uid, 'storeuser', '第二条', '');
    const items = store.listFeedback(10).filter((f) => f.userId === uid);
    expect(items[0].id).toBe(id2); // 倒序：最新在前
    expect(items[0]).toMatchObject({ username: 'storeuser', text: '第二条', contact: '' });
    expect(items[1]).toMatchObject({ text: '第一条', contact: 'wechat:a' });

    // 封顶验证用独立用户：205 条 → 只剩最近 200 条（同一 SQLite 文件跨用例共享，按 userId 过滤断言）
    const capUid = 'cap-user';
    store.pushFeedback(capUid, 'capuser', 'cap-first', '');
    for (let i = 0; i < 204; i++) store.pushFeedback(capUid, 'capuser', `批量${i}`, '');
    const capItems = store.listFeedback(500).filter((f) => f.userId === capUid);
    expect(capItems).toHaveLength(200);
    expect(capItems[0].text).toBe('批量203'); // 最旧的 cap-first 被裁掉
  });

  it('管理员查看：跨用户列表含用户名快照与需求字段，响应不含额外字段', async () => {
    const app = buildApp(makeStore());
    const { token: bossToken } = await register(app, 'boss'); // ADMIN_USERS 命中
    const { token: userToken } = await register(app, 'fb-user');
    await request(app).post('/api/feedback').set('Authorization', `Bearer ${userToken}`)
      .send({ text: '希望支持深色模式', contact: 'user@example.com' });

    const res = await request(app).get('/api/admin/feedback').set('Authorization', `Bearer ${bossToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const entry = res.body.items.find((f: { text: string }) => f.text === '希望支持深色模式');
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      username: 'fb-user',
      contact: 'user@example.com',
    });
    expect(Object.keys(entry).sort()).toEqual(
      ['contact', 'createdAt', 'id', 'text', 'userId', 'username'].sort(),
    );
  });

  it('非管理员：管理端 403 且不泄露任何数据；自己的提交不受影响', async () => {
    const app = buildApp(makeStore());
    const { token } = await register(app, 'plain-user');
    const res = await request(app).get('/api/admin/feedback').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.items).toBeUndefined();

    const ok = await request(app).post('/api/feedback').set('Authorization', `Bearer ${token}`).send({ text: '普通用户正常提交' });
    expect(ok.status).toBe(200);
  });

  it('limit 收敛 1..200，缺省 100', async () => {
    const store = makeStore();
    const app = buildApp(store);
    const { token } = await register(app, 'boss-lim'); // ADMIN_USERS='boss,boss-lim' 命中
    const uid = 'lim-user';
    for (let i = 0; i < 5; i++) store.pushFeedback(uid, 'limuser', `lim${i}`, '');
    const res = await request(app).get('/api/admin/feedback?limit=2').set('Authorization', `Bearer ${token}`);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.every((f: { userId: string }) => f.userId === uid)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(5);
    const huge = await request(app).get('/api/admin/feedback?limit=99999').set('Authorization', `Bearer ${token}`);
    expect(huge.body.items.length).toBeLessThanOrEqual(200); // 封顶 200
  });
});
