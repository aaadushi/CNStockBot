/**
 * TRUST_PROXY 信任链集成测试（S4-3）：反向代理部署下 req.ip 取 X-Forwarded-For
 * 真实客户端 IP（登录限速按真实 IP 计数），未配置时不信任伪造的 XFF 头。
 * 行为由 Express `trust proxy` 提供，本测试锁定装配方式正确。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

async function buildApp(trustProxy: boolean | number | string) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/whoami', (req, res) => {
    res.json({ ip: req.ip });
  });
  return app;
}

describe('trust proxy（S4-3）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('默认（false）：伪造 X-Forwarded-For 不影响 req.ip', async () => {
    const { config } = await import('../src/config.js');
    const app = await buildApp(config.trustProxy);
    const res = await request(app).get('/whoami').set('X-Forwarded-For', '203.0.113.7');
    expect(res.status).toBe(200);
    // 不信任代理头：取 socket 对端（回环），而非伪造的 203.0.113.7
    expect(res.body.ip).not.toBe('203.0.113.7');
  });

  it('loopback：来自回环代理的连接取 XFF 中最左客户端 IP', async () => {
    vi.stubEnv('TRUST_PROXY', 'loopback');
    const { config } = await import('../src/config.js');
    const app = await buildApp(config.trustProxy);
    // 单跳代理（nginx 同机反代）的 XFF 形态：仅真实客户端 IP
    const res = await request(app).get('/whoami').set('X-Forwarded-For', '203.0.113.7');
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('203.0.113.7');
  });

  it('数字 1：只信任最近一跳，同样取真实客户端 IP', async () => {
    vi.stubEnv('TRUST_PROXY', '1');
    const { config } = await import('../src/config.js');
    const app = await buildApp(config.trustProxy);
    const res = await request(app).get('/whoami').set('X-Forwarded-For', '198.51.100.23');
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('198.51.100.23');
  });

  it('true：信任每一跳 XFF', async () => {
    vi.stubEnv('TRUST_PROXY', 'true');
    const { config } = await import('../src/config.js');
    const app = await buildApp(config.trustProxy);
    const res = await request(app).get('/whoami').set('X-Forwarded-For', '192.0.2.99');
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('192.0.2.99');
  });
});
