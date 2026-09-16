/**
 * PythonServiceProvider.getIndicators 单测（F5-1 技术指标）：
 * URL 拼接与 days 参数、完整响应透传（含 null 字段）、非 200 与连接失败两种错误分支。
 * fetch 全 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import type { TechnicalIndicators } from '../src/data/provider.js';

const INDICATORS: TechnicalIndicators = {
  code: '600519',
  source: 'eastmoney',
  asOf: '2026-09-15',
  latest: {
    close: 1450.0,
    ma: { ma5: 1440.1, ma10: 1430.2, ma20: 1420.3, ma60: 1410.4 },
    ema: { ema12: 1441.5, ema26: 1431.6 },
    macd: { dif: 9.9, dea: 8.8, macd: 2.2 },
    rsi: { rsi6: 65.5, rsi12: 60.1, rsi24: null }, // 周期不足为 null，原样透传
    kdj: { k: 70.1, d: 65.2, j: 79.9 },
    boll: { upper: 1480.0, mid: 1420.3, lower: 1360.6 },
  },
  keyLevels: { support: [1420.0, 1380.0], resistance: [1480.0] },
  signals: [{ type: 'ma_cross_up', text: 'MA5 上穿 MA20（金叉）' }],
  series: {
    dates: ['2026-09-14', '2026-09-15'],
    ma5: [null, 1440.1],
    ma10: [null, 1430.2],
    ma20: [null, 1420.3],
    ma60: [null, 1410.4],
  },
};

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PythonServiceProvider.getIndicators', () => {
  it('URL 拼接正确（含 days 参数），完整响应原样透传', async () => {
    const fn = mockFetchJson(INDICATORS);
    const data = await new PythonServiceProvider().getIndicators('600519', 250);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/indicators/600519');
    expect(url).toContain('days=250');
    expect(data).toEqual(INDICATORS);
  });

  it('缺省 days 走默认值 250', async () => {
    const fn = mockFetchJson(INDICATORS);
    await new PythonServiceProvider().getIndicators('600519');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('days=250');
  });

  it('null 字段（周期不足/无信号空数组）原样透传不补占位', async () => {
    mockFetchJson(INDICATORS);
    const data = await new PythonServiceProvider().getIndicators('600519');
    expect(data.latest.rsi.rsi24).toBeNull();
    expect(data.series.ma5[0]).toBeNull();
    expect(data.keyLevels.resistance).toHaveLength(1);
  });

  it('非 200 响应抛错并带状态码', async () => {
    mockFetchJson({ detail: '历史行情为空，无法计算技术指标' }, 502);
    await expect(new PythonServiceProvider().getIndicators('999999')).rejects.toThrow('502');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().getIndicators('600519')).rejects.toThrow('data-service');
  });
});
