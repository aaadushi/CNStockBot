/**
 * analyze_stock 技能（F5-2）单测：
 * 1) 代码校验；2) 六块聚合的格式化输出；3) 单块失败独立降级；
 * 4) 可选方法缺失（data-service 未启动）提示；5) 新浪资金流降级源口径标注。
 * DataProvider 全部 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi } from 'vitest';
import skill from '../src/skills/bundled/analyze/index.js';
import type { SkillContext } from '../src/skills/types.js';
import type {
  DataProvider,
  Quote,
  CompanyProfile,
  FundFlow,
  TechnicalIndicators,
  FinancialReport,
  NewsItem,
} from '../src/data/provider.js';
import type { Store } from '../src/storage/store.js';

const QUOTE: Quote = {
  code: '600519',
  name: '贵州茅台',
  price: 1500,
  changePct: 1.23,
  prevClose: 1481.76,
  peTtm: 22.5,
  pb: 8.1,
  totalMarketCap: 1.88e12,
  floatMarketCap: 1.88e12,
  amount: 5.2e9,
  turnover: 0.35,
  volumeRatio: 1.1,
  limitUp: 1630,
  limitDown: 1333.6,
  week52High: 1900,
  week52Low: 1300,
  time: '2026-09-18 15:00:00',
};

const PROFILE: CompanyProfile = {
  code: '600519',
  industry: '白酒Ⅱ',
  listingDate: '2001-08-27',
  totalShares: 12.56e8,
  floatShares: 12.56e8,
};

const FUND_FLOW: FundFlow = {
  code: '600519',
  source: 'eastmoney',
  items: [
    { date: '2026-09-14', close: 1480, changePct: 0.1, mainNetInflow: 1e8, mainNetInflowPct: 2, superLargeNetInflow: 6e7, superLargeNetInflowPct: 1.2 },
    { date: '2026-09-15', close: 1485, changePct: 0.3, mainNetInflow: -5e7, mainNetInflowPct: -1, superLargeNetInflow: -2e7, superLargeNetInflowPct: -0.4 },
    { date: '2026-09-16', close: 1478, changePct: -0.5, mainNetInflow: null, mainNetInflowPct: null, superLargeNetInflow: null, superLargeNetInflowPct: null },
    { date: '2026-09-17', close: 1482, changePct: 0.3, mainNetInflow: 3e7, mainNetInflowPct: 0.6, superLargeNetInflow: 1e7, superLargeNetInflowPct: 0.2 },
    { date: '2026-09-18', close: 1500, changePct: 1.2, mainNetInflow: 2e8, mainNetInflowPct: 4, superLargeNetInflow: 1.2e8, superLargeNetInflowPct: 2.4 },
  ],
};

const INDICATORS: TechnicalIndicators = {
  code: '600519',
  source: 'eastmoney',
  asOf: '2026-09-18',
  latest: {
    close: 1500,
    ma: { ma5: 1490, ma10: 1470, ma20: 1450, ma60: 1400 },
    ema: { ema12: 1480, ema26: 1455 },
    macd: { dif: 25.123, dea: 20.456, macd: 9.334 },
    rsi: { rsi6: 72.3, rsi12: 65.1, rsi24: 58.9 },
    kdj: { k: 80.12, d: 75.34, j: 89.68 },
    boll: { upper: 1520, mid: 1450, lower: 1380 },
  },
  keyLevels: { support: [1450, 1400], resistance: [1520] },
  signals: [{ type: 'ma_golden_cross', text: 'MA5 上穿 MA20（金叉）' }],
  series: { dates: [], ma5: [], ma10: [], ma20: [], ma60: [] },
};

const FINANCIALS: FinancialReport[] = [
  { period: '2026-06-30', revenue: '900亿元', netProfit: '450亿元', roe: '18.5', eps: '35.8' },
  { period: '2026-03-31', revenue: '450亿元', netProfit: '230亿元', roe: '9.2', eps: '18.3' },
];

const NEWS: NewsItem[] = [
  { title: '贵州茅台发布半年报', publishedAt: '2026-09-18 10:00' },
  { title: '白酒板块午后拉升', publishedAt: '2026-09-17 14:30' },
];

function makeCtx(overrides: Partial<DataProvider> = {}): SkillContext {
  const data: Partial<DataProvider> = {
    name: 'mock',
    getQuote: vi.fn(async () => QUOTE),
    getProfile: vi.fn(async () => PROFILE),
    getFundFlow: vi.fn(async () => FUND_FLOW),
    getIndicators: vi.fn(async () => INDICATORS),
    getFinancials: vi.fn(async () => FINANCIALS),
    getNews: vi.fn(async () => NEWS),
    ...overrides,
  };
  return { userId: 'test-user', store: {} as Store, data: data as DataProvider };
}

describe('analyze_stock 技能', () => {
  it('非法代码直接返回提示，不调用数据源', async () => {
    const ctx = makeCtx();
    const text = await skill.execute({ code: 'abc' }, ctx);
    expect(text).toContain('6 位数字股票代码');
    expect(ctx.data.getQuote).not.toHaveBeenCalled();
  });

  it('六块数据齐全时输出完整快照（含各块标题与关键数值）', async () => {
    const text = await skill.execute({ code: '600519' }, makeCtx());
    expect(text).toContain('贵州茅台（600519）多维数据快照');
    expect(text).toContain('【行情与估值】');
    expect(text).toContain('最新价 1500.00 元');
    expect(text).toContain('涨跌幅 +1.23%');
    expect(text).toContain('总市值 1.88 万亿');
    expect(text).toContain('PE(TTM) 22.50');
    expect(text).toContain('【公司资料】');
    expect(text).toContain('白酒Ⅱ');
    expect(text).toContain('【资金流】');
    expect(text).toContain('主力净流入 +2.00 亿');
    // 近 5 日主力净流入合计：1e8 - 5e7 + (null 跳过) + 3e7 + 2e8 = 2.8e8
    expect(text).toContain('近 5 日主力净流入合计：+2.80 亿');
    expect(text).toContain('【技术面】');
    expect(text).toContain('MA5/10/20/60：1490.00 / 1470.00 / 1450.00 / 1400.00');
    expect(text).toContain('MA5 上穿 MA20（金叉）');
    expect(text).toContain('【基本面（近两期财报）】');
    expect(text).toContain('2026-06-30：营收 900亿元，净利润 450亿元，ROE 18.5%');
    expect(text).toContain('【消息面（最新 5 条新闻）】');
    expect(text).toContain('1. 贵州茅台发布半年报（2026-09-18 10:00）');
    // 红线提示：技能结果内嵌对 LLM 的约束
    expect(text).toContain('不得给出买卖建议');
  });

  it('新闻按时间倒序拉取（getNews 第三参 time），资金流取 15 天、指标取 250 天', async () => {
    const ctx = makeCtx();
    await skill.execute({ code: '600519' }, ctx);
    expect(ctx.data.getNews).toHaveBeenCalledWith('600519', 5, 'time');
    expect(ctx.data.getFundFlow).toHaveBeenCalledWith('600519', 15);
    expect(ctx.data.getIndicators).toHaveBeenCalledWith('600519', 250);
    expect(ctx.data.getFinancials).toHaveBeenCalledWith('600519', 2);
  });

  it('单块失败独立降级：资金流报错只影响该块，其余正常', async () => {
    const ctx = makeCtx({
      getFundFlow: vi.fn(async () => {
        throw new Error('AKShare 资金流获取失败');
      }),
    });
    const text = await skill.execute({ code: '600519' }, ctx);
    expect(text).toContain('【资金流】暂不可用：AKShare 资金流获取失败');
    expect(text).toContain('【行情与估值】');
    expect(text).toContain('【技术面】');
    expect(text).toContain('【消息面（最新 5 条新闻）】');
  });

  it('行情失败时其余块仍返回，标题退化为纯代码', async () => {
    const ctx = makeCtx({
      getQuote: vi.fn(async () => {
        throw new Error('股票可能已停牌或退市');
      }),
    });
    const text = await skill.execute({ code: '600519' }, ctx);
    expect(text).toContain('600519多维数据快照');
    expect(text).toContain('【行情与估值】暂不可用：股票可能已停牌或退市');
    expect(text).toContain('【公司资料】');
  });

  it('可选方法缺失（data-service 未启动）时对应块提示需启动微服务', async () => {
    const ctx = makeCtx({
      getProfile: undefined,
      getFundFlow: undefined,
      getIndicators: undefined,
      getFinancials: undefined,
    });
    const text = await skill.execute({ code: '600519' }, ctx);
    expect(text).toContain('【公司资料】暂不可用：数据源不支持公司资料（需启动 data-service 数据微服务）');
    expect(text).toContain('【资金流】暂不可用：数据源不支持资金流');
    expect(text).toContain('【技术面】暂不可用：数据源不支持技术指标');
    expect(text).toContain('【基本面（近两期财报）】暂不可用：数据源不支持财报');
    // 行情与新闻不依赖 data-service，正常返回
    expect(text).toContain('最新价 1500.00 元');
    expect(text).toContain('1. 贵州茅台发布半年报');
  });

  it('新浪降级源资金流：标签改"净流入"并注明口径差异', async () => {
    const ctx = makeCtx({
      getFundFlow: vi.fn(async () => ({ ...FUND_FLOW, source: 'sina' as const })),
    });
    const text = await skill.execute({ code: '600519' }, ctx);
    expect(text).toContain('净流入 +2.00 亿');
    expect(text).toContain('口径不同');
  });
});
