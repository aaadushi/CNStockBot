/**
 * 涨跌榜新浪降级源（REQ-P11，解决 STATUS P11）单测：
 * - 新浪排行行解析（code 6 位不带前缀、trade 字符串转数值、changepercent 不缩放）
 * - 停牌行（trade<=0）过滤：不进 up/down/flat 任何榜单
 * - 家数边界二分：合成市场精确验证 upCount/downCount/flatCount（含零区跨页、停牌混排零区）
 * - EastmoneyProvider.getMovers 三级降级链：push2+push2delay 双挂 → 新浪；
 *   东财任一宿主可用 → 不调新浪；三源全挂 → 抛错；60s 缓存对降级结果同样生效
 * fetch 全部 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EastmoneyProvider } from '../src/data/eastmoney.js';
import { fetchSinaMovers } from '../src/data/sinaMovers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const PZ = 100;

interface SinaRow {
  code: string;
  name: string;
  trade: string;
  changepercent: number;
}

/** 按 URL 片段路由的 fetch mock（与 movers.test.ts 同款） */
function mockFetchRouter(routes: Record<string, unknown>) {
  const fn = vi.fn(async (url: string) => {
    for (const [key, payload] of Object.entries(routes)) {
      if (!String(url).includes(key)) continue;
      const body = typeof payload === 'function' ? (payload as (u: string) => unknown)(String(url)) : payload;
      if (body instanceof Error) throw body;
      return { ok: true, status: 200, json: async () => body };
    }
    throw new Error(`未 mock 的请求: ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** 新浪排行处理器：从排好序（降序）的合成全市场数组按 page/num/asc 切片 */
function sinaHandler(market: SinaRow[]) {
  return (url: string) => {
    if (url.includes('getHQNodeStockCount')) return String(market.length);
    const page = Number(/page=(\d+)/.exec(url)?.[1]);
    const num = Number(/num=(\d+)/.exec(url)?.[1]);
    const asc = /asc=([01])/.exec(url)?.[1];
    const rows = asc === '1' ? [...market].reverse() : market;
    return rows.slice((page - 1) * num, page * num);
  };
}

/**
 * 合成全市场（降序）：250 涨 + 零区（3 真平盘 + 2 停牌混排，跨页边界）+ 300 跌。
 * 精确家数口径：up=250，flat=5（含 2 停牌，新浪口径差见 sinaMovers.ts 头注释），down=300。
 */
function buildSinaMarket(): SinaRow[] {
  const rows: SinaRow[] = [];
  for (let i = 0; i < 250; i++) {
    rows.push({ code: `600${String(i).padStart(3, '0')}`, name: `涨${i}`, trade: (10 + i / 100).toFixed(2), changepercent: 5 - i * 0.01 });
  }
  rows.push({ code: '600900', name: '平盘甲', trade: '8.00', changepercent: 0 });
  rows.push({ code: '600901', name: '停牌甲', trade: '0.000', changepercent: 0 });
  rows.push({ code: '600902', name: '平盘乙', trade: '9.10', changepercent: 0 });
  rows.push({ code: '600903', name: '停牌乙', trade: '0.000', changepercent: 0 });
  rows.push({ code: '600904', name: '平盘丙', trade: '7.50', changepercent: 0 });
  for (let i = 0; i < 300; i++) {
    rows.push({ code: `601${String(i).padStart(3, '0')}`, name: `跌${i}`, trade: '5.00', changepercent: -0.01 - i * 0.01 });
  }
  return rows;
}

/** 东财 clist/ulist 全挂路由（双宿主均 fetch failed） */
const EM_ALL_DOWN = {
  'ulist.np': new Error('fetch failed'),
  'clist/get': new Error('fetch failed'),
};

describe('fetchSinaMovers（新浪降级源）', () => {
  it('榜单解析：trade 字符串转数值、changepercent 不缩放、停牌行不进榜', async () => {
    mockFetchRouter({ 'vip.stock.finance.sina.com.cn': sinaHandler(buildSinaMarket()) });
    const m = await fetchSinaMovers(50);
    expect(m.up).toHaveLength(50);
    expect(m.up[0]).toEqual({ code: '600000', name: '涨0', price: 10, changePct: 5 });
    expect(m.up.every((i) => i.changePct > 0)).toBe(true);
    expect(m.down).toHaveLength(50);
    expect(m.down.every((i) => i.changePct < 0)).toBe(true);
    expect(m.down[0].changePct).toBeCloseTo(-0.01 - 299 * 0.01); // 跌得最多的在最前
    // 平盘榜只收真平盘（3 只），停牌行被过滤
    expect(m.flat).toEqual([
      { code: '600900', name: '平盘甲', price: 8, changePct: 0 },
      { code: '600902', name: '平盘乙', price: 9.1, changePct: 0 },
      { code: '600904', name: '平盘丙', price: 7.5, changePct: 0 },
    ]);
    expect(m.source).toBe('sina');
    expect(m.time).toBeTruthy();
  });

  it('家数边界二分：零区跨页 + 停牌混排，家数精确（flat 含停牌为新浪口径差）', async () => {
    mockFetchRouter({ 'vip.stock.finance.sina.com.cn': sinaHandler(buildSinaMarket()) });
    const m = await fetchSinaMovers(50);
    expect(m.upCount).toBe(250);
    expect(m.downCount).toBe(300);
    expect(m.flatCount).toBe(5); // 3 真平盘 + 2 停牌（trade=0 的零区行计入家数，榜单内已过滤）
  });

  it('全部上涨（无下跌段）：downCount=0、flatCount=0，二分不越界', async () => {
    const allUp: SinaRow[] = Array.from({ length: 30 }, (_, i) => ({
      code: `600${String(i).padStart(3, '0')}`, name: `涨${i}`, trade: '10.00', changepercent: 0.01 + i * 0.01,
    }));
    mockFetchRouter({ 'vip.stock.finance.sina.com.cn': sinaHandler(allUp) });
    const m = await fetchSinaMovers(50);
    expect(m.upCount).toBe(30);
    expect(m.downCount).toBe(0);
    expect(m.flatCount).toBe(0);
    expect(m.flat).toEqual([]);
  });

  it('总数异常时抛错（不产出看似正常的错误数据，A-310 同原则）', async () => {
    mockFetchRouter({
      'vip.stock.finance.sina.com.cn': (url: string) =>
        url.includes('getHQNodeStockCount') ? '0' : [],
    });
    await expect(fetchSinaMovers(50)).rejects.toThrow('总数异常');
  });
});

describe('getMovers 三级降级链（REQ-P11）', () => {
  it('push2+push2delay 双挂时自动降级新浪，结果带 source=sina', async () => {
    const fn = mockFetchRouter({
      ...EM_ALL_DOWN,
      'vip.stock.finance.sina.com.cn': sinaHandler(buildSinaMarket()),
    });
    const m = await new EastmoneyProvider().getMovers(50);
    expect(m.source).toBe('sina');
    expect(m.upCount).toBe(250);
    expect(m.delayed).toBeUndefined(); // 新浪是实时数据，不是延时宿主
    expect(fn.mock.calls.some(([u]) => String(u).includes('vip.stock.finance.sina'))).toBe(true);
  });

  it('东财实时宿主可用时绝不请求新浪（降级不提前/不并行）', async () => {
    const market = buildSinaMarket();
    const emRows = market.map((r) => ({ f2: Number(r.trade), f3: r.changepercent, f12: r.code, f14: r.name }));
    const fn = mockFetchRouter({
      'ulist.np': { data: { diff: [{ f104: 250, f105: 300, f106: 5 }] } },
      'clist/get': (url: string) => {
        const pn = Number(/pn=(\d+)/.exec(url)?.[1]);
        const pz = Number(/pz=(\d+)/.exec(url)?.[1]);
        const po = /po=([01])/.exec(url)?.[1];
        const rows = po === '0' ? [...emRows].reverse() : emRows;
        return { data: { total: emRows.length, diff: rows.slice((pn - 1) * pz, pn * pz) } };
      },
      'vip.stock.finance.sina.com.cn': sinaHandler(market),
    });
    const m = await new EastmoneyProvider().getMovers(50);
    expect(m.source).toBeUndefined();
    expect(fn.mock.calls.every(([u]) => !String(u).includes('vip.stock.finance.sina'))).toBe(true);
  });

  it('push2 挂、push2delay 可用时仍走东财延时宿主，不调新浪', async () => {
    const market = buildSinaMarket();
    const emRows = market.map((r) => ({ f2: Number(r.trade), f3: r.changepercent, f12: r.code, f14: r.name }));
    const fn = mockFetchRouter({
      'https://push2.eastmoney.com': new Error('fetch failed'),
      'ulist.np': { data: { diff: [{ f104: 250, f105: 300, f106: 5 }] } },
      'clist/get': (url: string) => {
        const pn = Number(/pn=(\d+)/.exec(url)?.[1]);
        const pz = Number(/pz=(\d+)/.exec(url)?.[1]);
        const po = /po=([01])/.exec(url)?.[1];
        const rows = po === '0' ? [...emRows].reverse() : emRows;
        return { data: { total: emRows.length, diff: rows.slice((pn - 1) * pz, pn * pz) } };
      },
    });
    const m = await new EastmoneyProvider().getMovers(50);
    expect(m.delayed).toBe(true);
    expect(m.source).toBeUndefined();
    expect(fn.mock.calls.some(([u]) => String(u).startsWith('https://push2delay'))).toBe(true);
    expect(fn.mock.calls.every(([u]) => !String(u).includes('vip.stock.finance.sina'))).toBe(true);
  });

  it('三个源全挂时抛错（带最后错误信息）', async () => {
    mockFetchRouter({ '': new Error('fetch failed') }); // 空 key 匹配所有 URL
    await expect(new EastmoneyProvider().getMovers(50)).rejects.toThrow('fetch failed');
  });

  it('降级成功后 60s 缓存生效：第二次调用不再发请求（含新浪）', async () => {
    const fn = mockFetchRouter({
      ...EM_ALL_DOWN,
      'vip.stock.finance.sina.com.cn': sinaHandler(buildSinaMarket()),
    });
    const p = new EastmoneyProvider();
    const first = await p.getMovers(50);
    expect(first.source).toBe('sina');
    const callsAfterFirst = fn.mock.calls.length;
    const again = await p.getMovers(50);
    expect(fn.mock.calls.length).toBe(callsAfterFirst);
    expect(again.source).toBe('sina');
    expect(again.upCount).toBe(250);
  });
});
