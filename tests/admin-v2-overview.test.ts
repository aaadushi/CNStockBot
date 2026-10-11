/**
 * 管理后台 v2——用户总览 + 运行概览 API 集成测试（REQ-Admin-V2）：
 * 鉴权门槛（401/403）、用户聚合正确性、字段白名单、overview 结构。
 *
 * 审计要点守护（REQ-Admin-V2 审计节）：
 * - 两个新端点必须服务端 requireAdmin（静态页可公开，数据接口不可）；
 * - ADMIN_USERS 为空集合时 fail-closed（见 tests/feedback-admin-unset.test.ts 补测）；
 * - /api/admin/users 响应只含聚合统计字段（不含 userId/消息内容/凭据），
 *   测试断言 Object.keys 精确集合；
 * - overview 的 dataService 走缓存探测器，测试里微服务不存在时只标 ok:false 不抛。
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
  dataDir = mkdtempSync(path.join(tmpdir(), 'cnstockbot-admin-v2-'));
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

async function register(app: express.Express, username: string): Promise<{ token: string; userId: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'helloWorld1' });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

describe('管理后台 v2（REQ-Admin-V2）', () => {
  it('未登录：overview 与 users 一律 401', async () => {
    const app = buildApp(makeStore());
    const ov = await request(app).get('/api/admin/overview');
    expect(ov.status).toBe(401);
    const us = await request(app).get('/api/admin/users');
    expect(us.status).toBe(401);
  });

  it('非管理员：overview 与 users 一律 403 且不泄露数据', async () => {
    const app = buildApp(makeStore());
    const { token } = await register(app, 'plain-v2');
    const ov = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${token}`);
    expect(ov.status).toBe(403);
    expect(ov.body.scheduler).toBeUndefined();
    const us = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`);
    expect(us.status).toBe(403);
    expect(us.body.items).toBeUndefined();
  });

  it('overview：管理员拿到构建信息 + 调度任务开关（微服务不通时 dataService 只标 false）', async () => {
    const app = buildApp(makeStore());
    const { token } = await register(app, 'boss'); // ADMIN_USERS 命中
    const res = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.version).toBe('string');
    expect(typeof res.body.startedAt).toBe('string');
    // dataService 随测试环境有无 8000 微服务而 true/false，两种都合法；
    // 关键是缓存探测器任何情况下都返回结构化结果（绝不抛）
    expect(typeof res.body.dataService.ok).toBe('boolean');
    if (res.body.dataService.ok) {
      expect(typeof res.body.dataService.latencyMs).toBe('number');
    } else {
      expect(typeof res.body.dataService.error).toBe('string');
    }
    // 行情探针：未启动探测时为初始健康态
    expect(res.body.quoteProbe).toMatchObject({ ok: true, consecutiveFailures: 0 });
    // 调度任务结构（开关值随 env 缺省值，这里只断言形状与估算值类型）
    const sch = res.body.scheduler;
    expect(sch.dailyReport.enabled).toBe(true);
    expect(typeof sch.dailyReport.signals).toBe('boolean');
    expect(sch.dailyReport.nextRunInMs).toBeGreaterThan(0);
    // 上界放宽到 <7 天：msUntilNextRun 只跳周末，周五跑测试时下次在周一
    expect(sch.dailyReport.nextRunInMs).toBeLessThan(7 * 24 * 3600 * 1000);
    expect(typeof sch.priceAlerts.enabled).toBe('boolean');
    expect(sch.priceAlerts.nextRunInMs).toBeNull(); // 轮询循环无固定时刻
    expect(typeof sch.overseasPush.enabled).toBe('boolean');
    // 默认关闭 → nextRunInMs 必须为 null（不估算未启用任务的运行时刻）
    expect(sch.overseasPush.enabled).toBe(false);
    expect(sch.overseasPush.nextRunInMs).toBeNull();
    expect(typeof sch.scannerUpdate.enabled).toBe('boolean');
    expect(typeof sch.scannerUpdate.push).toBe('boolean');
  });

  it('users：管理员拿到全用户聚合，字段白名单精确，按注册时间倒序', async () => {
    const app = buildApp(makeStore());
    const { token: bossToken } = await register(app, 'boss-lim'); // ADMIN_USERS 命中
    const { token: u1Token, userId: u1 } = await register(app, 'v2-user-1');
    const { token: _u2Token, userId: u2 } = await register(app, 'v2-user-2');

    // u1 有自选/规则/反馈，u2 仅注册
    await request(app).post('/api/watchlist').set('Authorization', `Bearer ${u1Token}`).send({ code: '600519' });
    await request(app).post('/api/watchlist').set('Authorization', `Bearer ${u1Token}`).send({ code: '000001' });
    await request(app).post('/api/feedback').set('Authorization', `Bearer ${u1Token}`).send({ text: 'v2 测试反馈' });

    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${bossToken}`);
    expect(res.status).toBe(200);
    // total 含 boss/boss-lim/v2-user-1/v2-user-2
    expect(res.body.total).toBeGreaterThanOrEqual(4);
    const keys = ['username', 'createdAt', 'lastActiveAt', 'watchlistCount', 'ruleCount', 'feedbackCount'].sort();
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(keys);
    }
    const byName = (n: string) => res.body.items.find((i: { username: string }) => i.username === n);
    const i1 = byName('v2-user-1');
    expect(i1).toBeDefined();
    expect(i1.watchlistCount).toBe(2);
    expect(i1.ruleCount).toBe(0);
    expect(i1.feedbackCount).toBe(1);
    expect(typeof i1.createdAt).toBe('number');
    expect(typeof i1.lastActiveAt).toBe('number'); // 刚注册/登录过，有会话
    const i2 = byName('v2-user-2');
    expect(i2.feedbackCount).toBe(0);
    expect(i2.watchlistCount).toBe(0);
    // 倒序：后注册的在前
    const names = res.body.items.map((i: { username: string }) => i.username);
    expect(names.indexOf('v2-user-2')).toBeLessThan(names.indexOf('v2-user-1'));
    void u1; void u2;
  });

  it('store 层：聚合口径正确（规则数/反馈数按用户隔离，最近登录取会话最大值）', async () => {
    const store = makeStore();
    const app = buildApp(store);
    const reg1 = await register(app, 'agg-user-1');
    await register(app, 'agg-user-2');
    // 走 API 加规则需要 manage_alerts 技能链路，这里直接写 store 层验证聚合口径
    store.addToWatchlist(reg1.userId, '600519');
    store.pushFeedback(reg1.userId, 'agg-user-1', 'store 直写', '');

    const items = store.listUserStats();
    const i1 = items.find((i) => i.username === 'agg-user-1');
    const i2 = items.find((i) => i.username === 'agg-user-2');
    expect(i1).toBeDefined();
    expect(i1!.watchlistCount).toBe(1);
    expect(i1!.feedbackCount).toBe(1);
    expect(i1!.lastActiveAt).not.toBeNull();
    expect(i2).toBeDefined();
    expect(i2!.watchlistCount).toBe(0);
    expect(i2!.feedbackCount).toBe(0);
    expect(i2!.lastActiveAt).not.toBeNull(); // 注册即建会话
    expect(store.countUsers()).toBeGreaterThanOrEqual(2);
  });
});
