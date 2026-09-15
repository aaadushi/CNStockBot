/**
 * PythonServiceProvider.getHistory 单测：
 * URL 拼接（默认/指定 days）、响应透传、非 200 响应抛错。
 * fetch 全 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import type { HistoryBar } from '../src/data/provider.js';

const BARS: HistoryBar[] = [
  { date: '2026-09-10', open: 1700.0, close: 1712.5, high: 1715.0, low: 1698.0, volume: 21000, changePct: 0.74 },
  { date: '2026-09-11', open: 1713.0, close: 1705.3, high: 1718.8, low: 1701.2, volume: 18500, changePct: -0.42 },
];

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PythonServiceProvider.getHistory', () => {
  it('默认 days=120，URL 拼接正确，响应数组原样透传', async () => {
    const fn = mockFetchJson(BARS);
    const bars = await new PythonServiceProvider().getHistory('600519');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/history/600519?days=120');
    expect(bars).toEqual(BARS);
  });

  it('指定 days 时体现在 query 上', async () => {
    const fn = mockFetchJson(BARS);
    await new PythonServiceProvider().getHistory('000001', 60);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/history/000001?days=60');
  });

  it('非 200 响应抛错并带状态码', async () => {
    mockFetchJson({ detail: 'AKShare 历史行情获取失败' }, 502);
    await expect(new PythonServiceProvider().getHistory('600519')).rejects.toThrow('502');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().getHistory('600519')).rejects.toThrow('data-service');
  });
});
