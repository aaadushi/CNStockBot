/**
 * 基金版块（F4-B）单测：
 * - PythonServiceProvider 基金方法：URL 拼接、响应透传、错误传播（fetch 全 mock）
 * - get_fund_rank / get_fund_info 技能：入参校验与格式化（ctx.data 全 mock）
 * 不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import fundrank from '../src/skills/bundled/fundrank/index.js';
import fundinfo, { periodReturns } from '../src/skills/bundled/fundinfo/index.js';
import type { SkillContext } from '../src/skills/types.js';
import type { DataProvider, FundInfo, FundRankItem, FundSearchItem } from '../src/data/provider.js';
import type { Store } from '../src/storage/store.js';

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const RANK_ITEMS: FundRankItem[] = [
  {
    code: '005825', name: '申万菱信智能驱动股票A', date: '2026-09-14',
    unitNav: 9.2702, accumNav: 9.7126, dayPct: -0.33, week1: -3.5, month1: -3.02,
    month3: 9.42, month6: 74.32, year1: 117.69, thisYear: 88.95, sinceInception: 981.17, fee: '0.15%',
  },
  {
    code: '110022', name: '易方达消费行业股票', date: '2026-09-14',
    unitNav: 2.837, accumNav: 2.837, dayPct: 0.39, week1: null, month1: null,
    month3: null, month6: null, year1: null, thisYear: 5.2, sinceInception: 183.7, fee: '0.15%',
  },
];

describe('PythonServiceProvider 基金方法', () => {
  it('getFundRank：默认参数 URL 正确，响应原样透传', async () => {
    const fn = mockFetchJson(RANK_ITEMS);
    const items = await new PythonServiceProvider().getFundRank();
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain(`/funds/rank?type=${encodeURIComponent('全部')}&limit=50`);
    expect(items).toEqual(RANK_ITEMS);
  });

  it('getFundRank：type 中文正确编码，limit 体现在 query 上', async () => {
    const fn = mockFetchJson([]);
    await new PythonServiceProvider().getFundRank('股票型', 20);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain(`/funds/rank?type=${encodeURIComponent('股票型')}&limit=20`);
  });

  it('getFundInfo：days 默认 250，URL 拼接正确', async () => {
    const fn = mockFetchJson({ code: '110022', name: 'x', type: '股票型', latest: null, history: [] });
    await new PythonServiceProvider().getFundInfo('110022');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/funds/110022?days=250');
  });

  it('searchFunds：keyword 编码与 limit 透传', async () => {
    const fn = mockFetchJson([]);
    await new PythonServiceProvider().searchFunds('易方达', 5);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain(`/funds/search?keyword=${encodeURIComponent('易方达')}&limit=5`);
  });

  it('getEtfRank：limit 透传，非 200 抛错带状态码', async () => {
    const fn = mockFetchJson([]);
    await new PythonServiceProvider().getEtfRank(100);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/funds/etf?limit=100');

    mockFetchJson({ detail: 'bad' }, 502);
    await expect(new PythonServiceProvider().getEtfRank()).rejects.toThrow('502');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().getFundRank()).rejects.toThrow('data-service');
  });
});

/** 构造基金技能测试 ctx */
function makeCtx(data: Partial<DataProvider>): SkillContext {
  return { userId: 'test-user', store: {} as Store, data: { name: 'mock', ...data } as DataProvider };
}

describe('get_fund_rank 技能', () => {
  it('非法基金类型直接提示，不调用数据源', async () => {
    const getFundRank = vi.fn();
    const text = await fundrank.execute({ type: '货币型' }, makeCtx({ getFundRank }));
    expect(text).toContain('基金类型只能是');
    expect(text).toContain('货币型');
    expect(getFundRank).not.toHaveBeenCalled();
  });

  it('limit 归一化：小数截断、超上限收敛、非法回退默认', async () => {
    const getFundRank = vi.fn(async () => RANK_ITEMS);
    await fundrank.execute({ limit: 12.9 }, makeCtx({ getFundRank }));
    expect(getFundRank).toHaveBeenLastCalledWith('全部', 12);
    await fundrank.execute({ limit: 999 }, makeCtx({ getFundRank }));
    expect(getFundRank).toHaveBeenLastCalledWith('全部', 50);
    await fundrank.execute({ limit: 'abc' }, makeCtx({ getFundRank }));
    expect(getFundRank).toHaveBeenLastCalledWith('全部', 10);
  });

  it('排行格式化：含名称/代码/净值/百分比，缺失区间显示 —', async () => {
    const getFundRank = vi.fn(async () => RANK_ITEMS);
    const text = await fundrank.execute({ type: '股票型', limit: 2 }, makeCtx({ getFundRank }));
    expect(getFundRank).toHaveBeenCalledWith('股票型', 2);
    expect(text).toContain('股票型开放式基金排行');
    expect(text).toContain('1. 申万菱信智能驱动股票A（005825）');
    expect(text).toContain('单位净值：9.2702（2026-09-14）');
    expect(text).toContain('日增长率：-0.33%');
    expect(text).toContain('近1年：+117.69%');
    // 第二只基金近1月/近3月/近1年缺失
    expect(text).toContain('近1月：—');
  });

  it('空结果提示禁止编造排名', async () => {
    const getFundRank = vi.fn(async () => []);
    const text = await fundrank.execute({ type: 'QDII' }, makeCtx({ getFundRank }));
    expect(text).toContain('QDII');
    expect(text).toContain('不要凭记忆编造排名');
  });
});

describe('get_fund_info 技能', () => {
  const INFO: FundInfo = {
    code: '110022',
    name: '易方达消费行业股票',
    type: '股票型',
    latest: { date: '2026-09-14', nav: 2.837, changePct: 0.39 },
    history: [
      { date: '2026-08-14', nav: 2.9, changePct: null },
      ...Array.from({ length: 20 }, (_, i) => ({
        date: `2026-08-${String(15 + i).padStart(2, '0')}`,
        nav: 2.9 + i * 0.001,
        changePct: 0.1,
      })),
      { date: '2026-09-14', nav: 2.837, changePct: 0.39 },
    ],
  };

  it('空参数直接提示，不调用数据源', async () => {
    const getFundInfo = vi.fn();
    expect(await fundinfo.execute({}, makeCtx({ getFundInfo }))).toBe('请提供基金代码或名称。');
    expect(getFundInfo).not.toHaveBeenCalled();
  });

  it('6 位代码直接查询，输出含净值/日增长率/类型', async () => {
    const getFundInfo = vi.fn(async () => INFO);
    const text = await fundinfo.execute({ code: '110022' }, makeCtx({ getFundInfo }));
    expect(getFundInfo).toHaveBeenCalledWith('110022');
    expect(text).toContain('易方达消费行业股票（110022，股票型）');
    expect(text).toContain('最新单位净值：2.8370（2026-09-14）');
    expect(text).toContain('日增长率：+0.39%');
  });

  it('名称多候选时返回候选列表，不直接查询', async () => {
    const found: FundSearchItem[] = [
      { code: '110022', name: '易方达消费行业股票', type: '股票型' },
      { code: '118002', name: '易方达消费精选股票', type: '股票型' },
    ];
    const searchFunds = vi.fn(async () => found);
    const getFundInfo = vi.fn();
    const text = await fundinfo.execute({ code: '易方达消费' }, makeCtx({ searchFunds, getFundInfo }));
    expect(text).toContain('找到多只匹配"易方达消费"的基金');
    expect(text).toContain('110022');
    expect(getFundInfo).not.toHaveBeenCalled();
  });

  it('名称唯一匹配时自动解析为代码再查询', async () => {
    const searchFunds = vi.fn(async () => [ { code: '110022', name: '易方达消费行业股票', type: '股票型' } ]);
    const getFundInfo = vi.fn(async () => INFO);
    const text = await fundinfo.execute({ code: '易方达消费' }, makeCtx({ searchFunds, getFundInfo }));
    expect(getFundInfo).toHaveBeenCalledWith('110022');
    expect(text).toContain('最新单位净值：2.8370');
  });

  it('搜索无结果时如实告知并禁止凭记忆作答', async () => {
    const searchFunds = vi.fn(async () => []);
    const text = await fundinfo.execute(
      { code: '不存在的基金' },
      makeCtx({ searchFunds, getFundInfo: vi.fn() }),
    );
    expect(text).toContain('未找到匹配"不存在的基金"的基金');
    expect(text).toContain('禁止凭记忆');
  });
});

describe('periodReturns（区间收益计算）', () => {
  const mk = (navs: number[]): FundInfo['history'] =>
    navs.map((nav, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, nav, changePct: null }));

  it('按交易日回推基点计算收益率', () => {
    // 23 个点：近1月（22）基点 = 第 1 个点
    const r = periodReturns(mk([2.0, ...Array(21).fill(2.2), 2.5]));
    const m1 = r.find((x) => x.label === '近1月');
    expect(m1).toBeDefined();
    expect(m1!.pct).toBeCloseTo(((2.5 - 2.0) / 2.0) * 100, 6);
    // 23 个点只有 近1周(5) 与 近1月(22)
    expect(r.map((x) => x.label)).toEqual(['近1周', '近1月']);
  });

  it('历史不足的区间不返回；nav 为 null/0 的点被过滤', () => {
    const pts = mk([1.0, 1.1, 1.2]);
    pts.push({ date: '2026-02-01', nav: null, changePct: null });
    pts.push({ date: '2026-02-02', nav: 0, changePct: null });
    const r = periodReturns(pts);
    expect(r).toEqual([]); // 有效点只有 3 个，不足任何区间
  });
});
