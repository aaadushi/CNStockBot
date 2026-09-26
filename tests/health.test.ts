/**
 * /health 可观测性（S3-4）测试：构建信息字段 + data-service 连通性探测器。
 * 探测器经 createDataServiceProber 工厂注入 fetch/now，不触网。
 */
import { describe, it, expect } from 'vitest';
import { createDataServiceProber, gitSha, startedAt, version } from '../src/health.js';

function jsonResponse(status = 200) {
  return new Response(JSON.stringify({ ok: true }), { status });
}

describe('/health 构建信息（S3-4）', () => {
  it('version 来自 package.json', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('gitSha 为短 sha 或 null（无 git 环境），startedAt 为合法 ISO 时间', () => {
    expect(gitSha === null || /^[0-9a-f]{7,40}$/.test(gitSha ?? '')).toBe(true);
    expect(Number.isNaN(Date.parse(startedAt))).toBe(false);
  });
});

describe('data-service 连通性探测器（S3-4）', () => {
  it('探测成功：ok=true 且带 latencyMs/checkedAt，请求带 token 头', async () => {
    let t = 1_000;
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8000/health');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
      t += 12;
      return jsonResponse();
    };
    const prober = createDataServiceProber({ fetchFn: fetchFn as typeof fetch, now: () => t, baseUrl: 'http://127.0.0.1:8000', token: 'tok-1' });

    const status = await prober();
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.latencyMs).toBe(12);
      expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false);
    }
  });

  it('token 为空时不发送 Authorization 头', async () => {
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
      return jsonResponse();
    };
    const prober = createDataServiceProber({ fetchFn: fetchFn as typeof fetch, now: () => 0, baseUrl: 'http://127.0.0.1:8000', token: '' });
    expect((await prober()).ok).toBe(true);
  });

  it('非 2xx：ok=false 且 error 含状态码', async () => {
    const prober = createDataServiceProber({
      fetchFn: (async () => jsonResponse(401)) as typeof fetch,
      now: () => 0,
      baseUrl: 'http://127.0.0.1:8000',
      token: 'wrong',
    });
    const status = await prober();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.error).toContain('401');
  });

  it('连接层异常：ok=false 且绝不抛出（/health 必须始终可用）', async () => {
    const prober = createDataServiceProber({
      fetchFn: (async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
      }) as typeof fetch,
      now: () => 0,
      baseUrl: 'http://127.0.0.1:8000',
      token: 'tok',
    });
    const status = await prober();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.error).toContain('ECONNREFUSED');
  });

  it('缓存：TTL 内不重复探测，过期后重探', async () => {
    let calls = 0;
    let t = 0;
    const fetchFn = async () => {
      calls += 1;
      return jsonResponse();
    };
    const prober = createDataServiceProber({ fetchFn: fetchFn as typeof fetch, now: () => t, baseUrl: 'http://x', token: '' });

    await prober();
    t = 29_000;
    await prober();
    expect(calls).toBe(1);
    t = 30_001;
    await prober();
    expect(calls).toBe(2);
  });

  it('并发调用共享同一次在途探测', async () => {
    let calls = 0;
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((r) => (release = r));
    const fetchFn = async () => {
      calls += 1;
      return gate;
    };
    const prober = createDataServiceProber({ fetchFn: fetchFn as typeof fetch, now: () => 0, baseUrl: 'http://x', token: '' });

    const p1 = prober();
    const p2 = prober();
    release(jsonResponse());
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(s1.ok).toBe(true);
    expect(s2.ok).toBe(true);
  });
});
