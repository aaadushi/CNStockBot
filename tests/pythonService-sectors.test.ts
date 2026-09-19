/**
 * PythonServiceProvider 板块轮动（F6-3）单测：
 * 五个方法的 URL 拼接（含 name 编码 / days、limit 参数）、响应透传、
 * 非 200 与连接失败两种错误分支。fetch 全 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import type { SectorCons, SectorFundFlow, SectorHistory, SectorRank, StockSectorInfo } from '../src/data/provider.js';

const RANK: SectorRank = {
  source: 'eastmoney-delay',
  items: [
    {
      rank: 1,
      code: 'BK0420',
      name: '航空机场',
      price: 3972.77,
      changePct: 1.05,
      change: 41.41,
      amount: 1280330539.0,
      turnover: 5.72,
      totalMarketCap: 22183679000,
      upCount: 5,
      downCount: 0,
      leadStock: '中国东航',
      leadStockCode: '600115',
      leadStockChangePct: 3.55,
    },
  ],
};

const FLOW: SectorFundFlow = {
  source: 'eastmoney',
  items: [
    {
      rank: 1,
      code: 'BK0420',
      name: '航空机场',
      price: 3972.77,
      changePct: 1.05,
      mainNetInflow: 92713920.0,
      mainNetInflowPct: 3.55,
      superLargeNetInflow: 125498640.0,
      superLargeNetInflowPct: 4.8,
      largeNetInflow: -32784720.0,
      largeNetInflowPct: -1.25,
      mediumNetInflow: -26323072.0,
      mediumNetInflowPct: -1.01,
      smallNetInflow: -66390832.0,
      smallNetInflowPct: -2.54,
      topStock: '中国东航',
      topStockCode: '600115',
    },
  ],
};

const CONS: SectorCons = {
  code: 'BK0420',
  name: '航空机场',
  source: 'eastmoney-delay',
  items: [
    {
      code: '600115',
      name: '中国东航',
      price: 4.5,
      changePct: 3.55,
      change: 0.15,
      volume: 123456,
      amount: 550000000,
      amplitude: 4.1,
      turnover: 1.2,
      peDynamic: 25.3,
      pb: 1.8,
    },
  ],
};

const HISTORY: SectorHistory = {
  code: 'BK0420',
  name: '航空机场',
  source: 'eastmoney',
  bars: [
    { date: '2026-09-17', open: 3930.58, close: 3931.36, high: 3945.74, low: 3912.16, volume: 5374951, changePct: -0.07, amount: 2018312000, turnover: 0.5 },
    { date: '2026-09-18', open: 3940.44, close: 3972.77, high: 3980.43, low: 3938.32, volume: 6515728, changePct: 1.05, amount: 2614883000, turnover: 0.61 },
  ],
};

const OF_STOCK: StockSectorInfo = {
  code: '600519',
  name: '贵州茅台',
  industry: '白酒Ⅱ',
  matched: true,
  source: 'eastmoney-delay',
  sector: {
    code: 'BK0477',
    name: '白酒Ⅱ',
    rank: 12,
    total: 496,
    changePct: 0.83,
    upCount: 15,
    downCount: 4,
    fundFlowRank: 30,
    fundFlowTotal: 496,
    mainNetInflow: -120000000,
    mainNetInflowPct: -1.2,
  },
};

const OF_STOCK_UNMATCHED: StockSectorInfo = {
  code: '999999',
  name: null,
  industry: null,
  matched: false,
  sector: null,
};

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PythonServiceProvider 板块轮动（F6-3）', () => {
  it('getSectorRank：URL 拼接与响应透传（含延时源标注）', async () => {
    const fn = mockFetchJson(RANK);
    const rank = await new PythonServiceProvider().getSectorRank(50);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/sectors/rank?limit=50');
    expect(rank).toEqual(RANK);
    expect(rank.source).toBe('eastmoney-delay');
    expect(rank.items[0].leadStockCode).toBe('600115');
  });

  it('getSectorRank：limit 缺省默认 30', async () => {
    const fn = mockFetchJson(RANK);
    await new PythonServiceProvider().getSectorRank();
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/sectors/rank?limit=30');
  });

  it('getSectorFundFlow：URL 拼接与五档资金流字段透传', async () => {
    const fn = mockFetchJson(FLOW);
    const flow = await new PythonServiceProvider().getSectorFundFlow(20);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/sectors/fund-flow?limit=20');
    expect(flow.items[0].mainNetInflow).toBe(92713920.0);
    expect(flow.items[0].smallNetInflowPct).toBe(-2.54);
  });

  it('getSectorCons：板块名称经 encodeURIComponent 编码', async () => {
    const fn = mockFetchJson(CONS);
    const cons = await new PythonServiceProvider().getSectorCons('航空机场', 100);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain(`/sectors/cons?name=${encodeURIComponent('航空机场')}&limit=100`);
    expect(cons.items[0].peDynamic).toBe(25.3);
  });

  it('getSectorHistory：URL 拼接与 bars 透传', async () => {
    const fn = mockFetchJson(HISTORY);
    const hist = await new PythonServiceProvider().getSectorHistory('航空机场', 250);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/sectors/history?');
    expect(url).toContain(`name=${encodeURIComponent('航空机场')}`);
    expect(url).toContain('days=250');
    expect(hist.bars).toHaveLength(2);
    expect(hist.bars[1].changePct).toBe(1.05);
  });

  it('getSectorOfStock：命中场景透传（涨跌名次 + 资金流名次）', async () => {
    const fn = mockFetchJson(OF_STOCK);
    const info = await new PythonServiceProvider().getSectorOfStock('600519');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/sectors/of-stock/600519');
    expect(info.matched).toBe(true);
    expect(info.sector?.rank).toBe(12);
    expect(info.sector?.fundFlowRank).toBe(30);
  });

  it('getSectorOfStock：未匹配场景是结构化响应而非报错', async () => {
    mockFetchJson(OF_STOCK_UNMATCHED);
    const info = await new PythonServiceProvider().getSectorOfStock('999999');
    expect(info.matched).toBe(false);
    expect(info.sector).toBeNull();
  });

  it('非 200 响应抛错并带状态码（如板块名不存在 404）', async () => {
    mockFetchJson({ detail: '未找到行业板块: 不存在板块' }, 404);
    await expect(new PythonServiceProvider().getSectorCons('不存在板块')).rejects.toThrow('404');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().getSectorRank()).rejects.toThrow('data-service');
  });
});
