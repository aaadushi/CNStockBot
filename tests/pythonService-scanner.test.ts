/**
 * PythonServiceProvider 选股扫描（F5-5）单测：
 * getScanStrategies / runScan / getMarketBarsStatus / triggerMarketBarsUpdate 四个方法的
 * URL 拼接、POST 方法与 full 参数、完整响应透传、非 200 与连接失败错误分支。
 * fetch 全 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import type { MarketBarsStatus, ScanResult, ScanStrategyMeta } from '../src/data/provider.js';

const STRATEGIES: ScanStrategyMeta[] = [
  { key: 'ma_bull', name: 'MA 多头排列', description: '收盘价 ＞ MA5 ＞ MA10 ＞ MA20 ＞ MA60' },
];

const SCAN: ScanResult = {
  strategy: 'ma_bull',
  name: 'MA 多头排列',
  description: '收盘价 ＞ MA5 ＞ MA10 ＞ MA20 ＞ MA60',
  asOf: '2026-09-18',
  stale: false,
  total: 2,
  items: [
    { code: '600519', name: '贵州茅台', close: 1252.57, changePct: -0.36, extra: '收盘 1252.57，MA5 …' },
    { code: '000001', name: null, close: null, changePct: null, extra: '…' },
  ],
  disclaimer: '扫描结果是客观指标条件的筛选命中名单，不构成投资建议。',
};

const STATUS: MarketBarsStatus = {
  running: false,
  phase: 'done',
  startedAt: '2026-09-21T15:40:00+08:00',
  finishedAt: '2026-09-21T16:05:00+08:00',
  total: 5221,
  done: 5221,
  failedCount: 0,
  failed: [],
  todayBarsReady: true,
  lastError: null,
  coverage: 5221,
  lastBarDate: '2026-09-18',
  dbSizeMb: 320.5,
};

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PythonServiceProvider 选股扫描（F5-5）', () => {
  it('getScanStrategies：URL 正确，清单原样透传', async () => {
    const fn = mockFetchJson(STRATEGIES);
    const data = await new PythonServiceProvider().getScanStrategies();
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/scan/strategies');
    expect(data).toEqual(STRATEGIES);
  });

  it('runScan：URL 拼接 strategy/limit，null 字段原样透传', async () => {
    const fn = mockFetchJson(SCAN);
    const data = await new PythonServiceProvider().runScan('ma_bull', 30);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/scan?strategy=ma_bull');
    expect(url).toContain('limit=30');
    expect(data.items[1].name).toBeNull();
    expect(data.disclaimer).toContain('不构成投资建议');
  });

  it('runScan 缺省 limit 走默认值 50', async () => {
    const fn = mockFetchJson(SCAN);
    await new PythonServiceProvider().runScan('ma_bull');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('limit=50');
  });

  it('getMarketBarsStatus：URL 正确，状态字段透传', async () => {
    const fn = mockFetchJson(STATUS);
    const data = await new PythonServiceProvider().getMarketBarsStatus();
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/market-bars/status');
    expect(data.phase).toBe('done');
    expect(data.coverage).toBe(5221);
  });

  it('triggerMarketBarsUpdate：POST 方法 + full 参数透传', async () => {
    const fn = mockFetchJson({ started: true, full: true });
    const data = await new PythonServiceProvider().triggerMarketBarsUpdate(true);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/market-bars/update?full=true');
    expect(init.method).toBe('POST');
    expect(data.started).toBe(true);
  });

  it('triggerMarketBarsUpdate 缺省 full=false；409 冲突抛错带状态码', async () => {
    const fn = mockFetchJson({ detail: '更新任务正在进行中' }, 409);
    await expect(new PythonServiceProvider().triggerMarketBarsUpdate()).rejects.toThrow('409');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('full=false');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().runScan('ma_bull')).rejects.toThrow('data-service');
  });
});
