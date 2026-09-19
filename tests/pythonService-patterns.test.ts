/**
 * PythonServiceProvider.getPatterns 单测（F6-1 K 线形态识别）：
 * URL 拼接与 days 参数、完整响应透传（含 null 字段）、非 200 与连接失败两种错误分支。
 * fetch 全 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import type { PatternReport } from '../src/data/provider.js';

const REPORT: PatternReport = {
  code: '600519',
  source: 'eastmoney',
  days: 750,
  asOf: '2026-09-18',
  patterns: [
    {
      key: 'three_soldiers',
      name: '红三兵',
      direction: '看涨',
      count: 3,
      recentDates: ['2026-08-12'],
      stats: {
        '5': { count: 3, upRatio: 66.7, avgRet: 1.23, avgMaxDrawdown: -2.1 },
        '10': { count: 3, upRatio: 66.7, avgRet: 2.4, avgMaxDrawdown: -3.0 },
        // 窗口样本为 0 时各值为 null，原样透传
        '20': { count: 0, upRatio: null, avgRet: null, avgMaxDrawdown: null },
      },
    },
  ],
  disclaimer: '形态统计为历史事实口径……不构成投资建议。',
};

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PythonServiceProvider.getPatterns', () => {
  it('URL 拼接正确（含 days 参数），完整响应原样透传', async () => {
    const fn = mockFetchJson(REPORT);
    const data = await new PythonServiceProvider().getPatterns('600519', 750);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/patterns/600519');
    expect(url).toContain('days=750');
    expect(data).toEqual(REPORT);
  });

  it('缺省 days 走默认值 750', async () => {
    const fn = mockFetchJson(REPORT);
    await new PythonServiceProvider().getPatterns('600519');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('days=750');
  });

  it('null 字段（窗口样本不足）原样透传不补占位', async () => {
    mockFetchJson(REPORT);
    const data = await new PythonServiceProvider().getPatterns('600519');
    expect(data.patterns[0].stats['20'].count).toBe(0);
    expect(data.patterns[0].stats['20'].upRatio).toBeNull();
  });

  it('非 200 响应抛错并带状态码', async () => {
    mockFetchJson({ detail: '历史行情为空，无法做形态识别' }, 502);
    await expect(new PythonServiceProvider().getPatterns('999999')).rejects.toThrow('502');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().getPatterns('600519')).rejects.toThrow('data-service');
  });
});
