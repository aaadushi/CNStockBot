/**
 * 收盘日报组装单测（F5-3）：行情行 + 技术面信号区的组合与降级行为。
 * Store / DataProvider 全 mock，不打网络、不碰真实 SQLite。
 */
import { describe, it, expect } from 'vitest';
import { buildDailyReport } from '../src/alerts/scheduler.js';
import type { Store } from '../src/storage/store.js';
import type { DataProvider, Quote, TechnicalIndicators } from '../src/data/provider.js';

function makeQuote(code: string, changePct: number): Quote {
  return { code, name: `股票${code}`, price: 10, changePct, prevClose: 10 };
}

/** 只带 signals 的最小指标对象（buildDailyReport 只读 signals） */
function makeIndicators(signals: { type: string; text: string }[]): TechnicalIndicators {
  return {
    code: '600519',
    source: 'sina',
    asOf: '2026-09-19',
    latest: {
      close: 10,
      ma: { ma5: null, ma10: null, ma20: null, ma60: null },
      ema: { ema12: null, ema26: null },
      macd: { dif: null, dea: null, macd: null },
      rsi: { rsi6: null, rsi12: null, rsi24: null },
      kdj: { k: null, d: null, j: null },
      boll: { upper: null, mid: null, lower: null },
    },
    keyLevels: { support: [], resistance: [] },
    signals,
    series: { dates: [], ma5: [], ma10: [], ma20: [], ma60: [] },
  };
}

function makeStore(codes: string[]): Store {
  return { getWatchlist: () => codes } as unknown as Store;
}

interface ProviderOverrides {
  quoteFail?: (code: string) => boolean;
  indicators?: (code: string) => Promise<TechnicalIndicators>;
  hasIndicators?: boolean; // false = 模拟纯东财直连模式（无 getIndicators 方法）
}

function makeProvider(codes: string[], o: ProviderOverrides = {}): DataProvider {
  const p: Partial<DataProvider> = {
    name: 'mock',
    getQuote: async (code: string) => {
      if (o.quoteFail?.(code)) throw new Error('停牌');
      return makeQuote(code, 1.23);
    },
  };
  if (o.hasIndicators !== false) {
    p.getIndicators = o.indicators ?? (async () => makeIndicators([]));
  }
  return p as DataProvider;
}

const SIGNALS = [
  { type: 'macd_cross_up', text: 'MACD DIF 上穿 DEA（金叉）' },
  { type: 'close_above_ma60', text: '收盘价站上 MA60' },
];

describe('buildDailyReport', () => {
  it('行情 + 信号齐全：包含行情行、信号区与免责声明', async () => {
    const data = makeProvider(['600519'], {
      indicators: async () => makeIndicators(SIGNALS),
    });
    const report = await buildDailyReport(makeStore(['600519']), data, 'u1');
    expect(report).toContain('【收盘日报】');
    expect(report).toContain('股票600519（600519）');
    expect(report).toContain('+1.23%');
    expect(report).toContain('【技术面信号】（客观状态描述，非买卖建议）');
    expect(report).toContain('· 股票600519（600519）：MACD DIF 上穿 DEA（金叉）；收盘价站上 MA60');
    expect(report.endsWith('以上仅供参考，不构成投资建议。')).toBe(true);
  });

  it('单只行情失败降级为 ⚠️ 行，信号区照常', async () => {
    const data = makeProvider(['600519', '000001'], {
      quoteFail: (c) => c === '000001',
      indicators: async () => makeIndicators(SIGNALS),
    });
    const report = await buildDailyReport(makeStore(['600519', '000001']), data, 'u1');
    expect(report).toContain('⚠️ 000001 行情获取失败');
    expect(report).toContain('【技术面信号】');
  });

  it('所有股票都无信号时不出信号区（不占版面）', async () => {
    const data = makeProvider(['600519']); // 默认 indicators 返回空 signals
    const report = await buildDailyReport(makeStore(['600519']), data, 'u1');
    expect(report).not.toContain('【技术面信号】');
  });

  it('数据源无指标能力（纯东财直连）时给降级说明行', async () => {
    const data = makeProvider(['600519'], { hasIndicators: false });
    const report = await buildDailyReport(makeStore(['600519']), data, 'u1');
    expect(report).toContain('【技术面信号】暂不可用（当前数据源无指标能力，需启动 data-service）');
  });

  it('单只指标失败：其余股票信号照常 + 失败计数注记', async () => {
    const data = makeProvider(['600519', '000001'], {
      indicators: async (c) => {
        if (c === '000001') throw new Error('data-service 未运行');
        return makeIndicators(SIGNALS);
      },
    });
    const report = await buildDailyReport(makeStore(['600519', '000001']), data, 'u1');
    expect(report).toContain('· 股票600519（600519）：MACD');
    expect(report).toContain('（1 只技术面数据获取失败，已跳过）');
    expect(report).not.toContain('000001）：MACD');
  });

  it('指标全部失败：信号区整体降级说明，不拖垮行情区', async () => {
    const data = makeProvider(['600519'], {
      indicators: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const report = await buildDailyReport(makeStore(['600519']), data, 'u1');
    expect(report).toContain('股票600519（600519）');
    expect(report).toContain('【技术面信号】暂不可用（data-service 未运行或指标计算失败）');
  });

  it('单股信号超过 3 条时只列前 3 条', async () => {
    const many = [
      { type: 'a', text: '信号一' },
      { type: 'b', text: '信号二' },
      { type: 'c', text: '信号三' },
      { type: 'd', text: '信号四' },
    ];
    const data = makeProvider(['600519'], { indicators: async () => makeIndicators(many) });
    const report = await buildDailyReport(makeStore(['600519']), data, 'u1');
    expect(report).toContain('信号一；信号二；信号三');
    expect(report).not.toContain('信号四');
  });

  it('空自选股：不出信号区', async () => {
    const data = makeProvider([]);
    const report = await buildDailyReport(makeStore([]), data, 'u1');
    expect(report).not.toContain('【技术面信号】');
    expect(report.endsWith('以上仅供参考，不构成投资建议。')).toBe(true);
  });
});
