/**
 * ADMIN_USERS 未配置时的 fail-closed 行为（REQ-Feedback-Admin FR-7）：
 * 任何已登录用户访问 /api/admin/feedback 一律 403；反馈提交路径不受影响。
 * 单独成文件：config 在模块加载时读 env，与 tests/feedback-api.test.ts 的
 * ADMIN_USERS=boss 场景隔离（vitest 文件级隔离）。
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

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'cnstockbot-fb-unset-'));
  process.env.DATA_DIR = dataDir;
  delete process.env.ADMIN_USERS; // 关键前提：未配置管理员
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

describe('ADMIN_USERS 未配置（fail-closed，REQ-Feedback-Admin FR-7）', () => {
  it('任何已登录用户访问管理端一律 403，反馈提交不受影响', async () => {
    const store = new Store();
    opened.push(store);
    const app = express();
    app.use(express.json());
    const data = { name: 'mock' } as unknown as import('../src/data/provider.js').DataProvider;
    const agent = {
      handleMessage: async (_u: string, m: string) => `echo:${m}`,
    } as unknown as import('../src/agent/loop.js').Agent;
    new WebChatChannel(store, data).mount(app, agent);

    const reg = await request(app).post('/api/auth/register').send({ username: 'anyone', password: 'helloWorld1' });
    expect(reg.status).toBe(201);
    const token = reg.body.token as string;

    const list = await request(app).get('/api/admin/feedback').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(403);

    // REQ-Admin-V2：同门槛适用新管理端端点
    const ov = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${token}`);
    expect(ov.status).toBe(403);
    expect(ov.body.scheduler).toBeUndefined();
    const us = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`);
    expect(us.status).toBe(403);
    expect(us.body.items).toBeUndefined();

    const post = await request(app).post('/api/feedback').set('Authorization', `Bearer ${token}`).send({ text: '未配置管理员时也能交反馈' });
    expect(post.status).toBe(200);
  });
});
