/**
 * PythonServiceProvider.getIntraday 单测（F3-5 分时数据）：
 * URL 拼接、响应透传（含 amount/avgPrice 可选字段）、新浪降级源 source 标注、
 * 非 200 与连接失败两种错误分支。fetch 全 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import type { Intraday } from '../src/data/provider.js';

const INTRADAY_EM: Intraday = {
  code: '600519',
  date: '2026-09-16',
  source: 'eastmoney',
  points: [
    { time: '09:30', price: 1275.0, volume: 1200, amount: 1530000000, avgPrice: 1275.0 },
    { time: '09:31', price: 1276.5, volume: 800, amount: 1021200000, avgPrice: 1275.47 },
    { time: '09:32', price: 1274.2, volume: 650, amount: 828230000, avgPrice: 1275.24 },
  ],
};

/** 新浪降级源：同样有 amount/avgPrice（微服务统一归一），source 标注 sina */
const INTRADAY_SINA: Intraday = {
  code: '000001',
  date: '2026-09-15',
  source: 'sina',
  points: [
    { time: '14:59', price: 11.25, volume: 5300, amount: 59625000, avgPrice: 11.2 },
    { time: '15:00', price: 11.28, volume: 9100, amount: 102648000, avgPrice: 11.22 },
  ],
};

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PythonServiceProvider.getIntraday', () => {
  it('URL 拼接正确，东财源响应原样透传（含 avgPrice）', async () => {
    const fn = mockFetchJson(INTRADAY_EM);
    const intraday = await new PythonServiceProvider().getIntraday('600519');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/intraday/600519');
    expect(intraday).toEqual(INTRADAY_EM);
    expect(intraday.points[1].avgPrice).toBe(1275.47);
  });

  it('新浪降级源透传，source 标注 sina', async () => {
    mockFetchJson(INTRADAY_SINA);
    const intraday = await new PythonServiceProvider().getIntraday('000001');
    expect(intraday.source).toBe('sina');
    expect(intraday.date).toBe('2026-09-15');
    expect(intraday.points).toHaveLength(2);
  });

  it('可选字段缺失时原样缺省（不补 0）', async () => {
    const noAmount: Intraday = {
      code: '600519',
      date: '2026-09-16',
      source: 'eastmoney',
      points: [{ time: '09:30', price: 1275.0, volume: 1200 }],
    };
    mockFetchJson(noAmount);
    const intraday = await new PythonServiceProvider().getIntraday('600519');
    expect(intraday.points[0].amount).toBeUndefined();
    expect(intraday.points[0].avgPrice).toBeUndefined();
  });

  it('非 200 响应抛错并带状态码', async () => {
    mockFetchJson({ detail: '分时数据获取失败' }, 502);
    await expect(new PythonServiceProvider().getIntraday('999999')).rejects.toThrow('502');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().getIntraday('600519')).rejects.toThrow('data-service');
  });
});
