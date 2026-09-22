/**
 * PythonServiceProvider 策略回测（F5-6）单测：
 * runBacktest 的 URL 拼接（默认参数与显式参数）、完整响应透传、
 * 非 200 与连接失败错误分支、CompositeProvider 降级提示。
 * fetch 全 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import { createProvider } from '../src/data/index.js';
import type { BacktestResult } from '../src/data/provider.js';

const RESULT: BacktestResult = {
  code: '000001',
  name: '平安银行',
  strategy: 'ma_cross_up',
  strategyName: 'MA5 金叉 MA20',
  strategyDesc: 'MA5 当日上穿 MA20',
  asOf: '2026-09-21',
  days: 750,
  bars: 729,
  params: {
    holdDays: 20, stopLossPct: 7, capital: 100000,
    commissionRate: 0.00025, commissionMin: 5, stampTax: 0.0005, slippage: 0.001,
  },
  rules: '信号日次日开盘价买入……',
  stats: {
    trades: 15, closedTrades: 14, winRate: 64.286, avgRetPct: 1.562,
    avgWinPct: 3.942, avgLossPct: -2.723, profitFactor: 2.606,
    bestRetPct: 10.42, worstRetPct: -4.937, avgHoldDays: 20,
    totalRetPct: 22.778, maxDrawdownPct: -13.204, benchmarkRetPct: 24.406,
    excessRetPct: -1.628, finalEquity: 122777.565,
  },
  skippedSignals: 11,
  trades: [
    {
      signalDate: '2024-01-03', buyDate: '2024-01-04', buyPrice: 7.724,
      sellDate: '2024-02-01', sellPrice: 7.893, holdDays: 20,
      reason: 'hold', reasonLabel: '持有期满', retPct: 2.087, pnl: 2080.083,
    },
  ],
  equityCurve: [{ date: '2023-09-18', equity: 100000, benchmark: 100000 }],
  disclaimer: '回测是对历史数据的客观回放……不构成任何投资建议。',
};

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PythonServiceProvider 策略回测（F5-6）', () => {
  it('runBacktest：URL 拼接默认参数（ma_bull / 20 / 7 / 750）', async () => {
    const fn = mockFetchJson(RESULT);
    const data = await new PythonServiceProvider().runBacktest('000001');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/backtest/000001?');
    expect(url).toContain('strategy=ma_bull');
    expect(url).toContain('hold_days=20');
    expect(url).toContain('stop_loss_pct=7');
    expect(url).toContain('days=750');
    expect(data.stats.closedTrades).toBe(14);
    expect(data.trades[0].reason).toBe('hold');
    expect(data.disclaimer).toContain('不构成');
  });

  it('runBacktest：显式参数覆盖默认值', async () => {
    const fn = mockFetchJson(RESULT);
    await new PythonServiceProvider().runBacktest('600519', {
      strategy: 'rsi_oversold', holdDays: 10, stopLossPct: 0, days: 250,
    });
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/backtest/600519?');
    expect(url).toContain('strategy=rsi_oversold');
    expect(url).toContain('hold_days=10');
    expect(url).toContain('stop_loss_pct=0');
    expect(url).toContain('days=250');
  });

  it('runBacktest：null 字段原样透传（无闭环交易时统计为 null）', async () => {
    const empty: BacktestResult = {
      ...RESULT,
      stats: { ...RESULT.stats, closedTrades: 0, winRate: null, avgRetPct: null, profitFactor: null },
      trades: [],
    };
    mockFetchJson(empty);
    const data = await new PythonServiceProvider().runBacktest('000001');
    expect(data.stats.winRate).toBeNull();
    expect(data.trades).toHaveLength(0);
  });

  it('runBacktest：非 200 抛错带状态码与上游错误文本', async () => {
    mockFetchJson({ detail: '本地日 K 库中无 999999 的数据' }, 404);
    await expect(new PythonServiceProvider().runBacktest('999999')).rejects.toThrow('404');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().runBacktest('000001')).rejects.toThrow('data-service');
  });

  it('CompositeProvider：微服务失败包装为带启动提示的错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    const provider = createProvider(); // 默认组合模式（东财 + 微服务）
    await expect(provider.runBacktest!('000001')).rejects.toThrow('uvicorn');
  });
});
