/**
 * 东财全市场涨跌榜（getMovers）单测：
 * - clist 排行榜解析（fltt=2 价格不缩放、停牌 "-" 过滤）
 * - 涨跌平家数统计（f104/f105/f106 沪深京三市求和）
 * - 平盘定位：停牌股与平盘混排在零区，二分找零区起点后扫描收集 f3 恰为 0 的
 * - 宿主降级：push2 失败自动切 push2delay；结果缓存 60s
 * fetch 全部 mock，不发起真实网络请求；真实响应回放用 fixtures/eastmoney/clist-gainers-5.json。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EastmoneyProvider } from '../src/data/eastmoney.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/eastmoney');

afterEach(() => {
  vi.unstubAllGlobals();
});

type Row = { f2: number | '-'; f3: number | '-'; f12: string; f14: string };

/** 按 URL 片段路由的 fetch mock：value 为响应体、Error（请求失败）或 (url) => 响应体 */
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

/** clist 处理器：从排好序（降序）的合成全市场数组按 pn/pz/po 切片 */
function clistHandler(market: Row[]) {
  return (url: string) => {
    const pn = Number(/pn=(\d+)/.exec(url)?.[1]);
    const pz = Number(/pz=(\d+)/.exec(url)?.[1]);
    const po = /po=([01])/.exec(url)?.[1];
    const rows = po === '0' ? [...market].reverse() : market;
    return { data: { total: market.length, diff: rows.slice((pn - 1) * pz, pn * pz) } };
  };
}

/** 合成全市场：100 涨 + 零区（停牌与真平盘混排）+ 195 跌，模拟东财真实排序 */
function buildMarket(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 100; i++) {
    rows.push({ f2: 10 + i, f3: 5 - i * 0.04, f12: `6000${String(i).padStart(2, '0')}`, f14: `涨${i}` });
  }
  rows.push({ f2: '-', f3: '-', f12: '600901', f14: '停牌甲' });
  rows.push({ f2: 8, f3: 0, f12: '600201', f14: '平盘甲' });
  rows.push({ f2: '-', f3: '-', f12: '600902', f14: '停牌乙' });
  rows.push({ f2: 9, f3: 0, f12: '600202', f14: '平盘乙' });
  rows.push({ f2: 7.5, f3: 0, f12: '600203', f14: '平盘丙' });
  for (let i = 0; i < 195; i++) {
    rows.push({ f2: 5, f3: -0.01 - i * 0.04, f12: `6010${String(i).padStart(2, '0')}`, f14: `跌${i}` });
  }
  return rows;
}

/** 沪深京三条家数统计（对应合成市场：100 涨 / 195 跌 / 3 平） */
const COUNTS_3MKTS = {
  data: { diff: [{ f104: 60, f105: 120, f106: 2 }, { f104: 30, f105: 60, f106: 1 }, { f104: 10, f105: 15, f106: 0 }] },
};

describe('EastmoneyProvider.getMovers', () => {
  it('涨幅/跌幅榜解析 + 家数三市求和；停牌 "-" 行不混入榜单', async () => {
    const market = buildMarket();
    mockFetchRouter({ 'ulist.np': COUNTS_3MKTS, 'clist/get': clistHandler(market) });
    const m = await new EastmoneyProvider().getMovers(50);
    expect(m.up).toHaveLength(50);
    expect(m.up[0]).toEqual({ code: '600000', name: '涨0', price: 10, changePct: 5 });
    expect(m.up.every((i) => i.changePct > 0)).toBe(true);
    expect(m.down).toHaveLength(50);
    expect(m.down.every((i) => i.changePct < 0)).toBe(true);
    expect(m.down[0].changePct).toBeCloseTo(-0.01 - 194 * 0.04); // 跌得最多的在最前
    expect(m.upCount).toBe(100);
    expect(m.downCount).toBe(195);
    expect(m.flatCount).toBe(3);
    expect(m.delayed).toBeUndefined(); // 实时宿主不标注延时
    expect(m.time).toBeTruthy();
  });

  it('平盘定位：二分找到零区，只收 f3 恰为 0 的（停牌混排不误收）', async () => {
    const market = buildMarket();
    mockFetchRouter({ 'ulist.np': COUNTS_3MKTS, 'clist/get': clistHandler(market) });
    const m = await new EastmoneyProvider().getMovers(50);
    expect(m.flat).toEqual([
      { code: '600201', name: '平盘甲', price: 8, changePct: 0 },
      { code: '600202', name: '平盘乙', price: 9, changePct: 0 },
      { code: '600203', name: '平盘丙', price: 7.5, changePct: 0 },
    ]);
  });

  it('flatCount 为 0 时不发平盘定位请求', async () => {
    const market = buildMarket();
    const fn = mockFetchRouter({
      'ulist.np': { data: { diff: [{ f104: 100, f105: 195, f106: 0 }] } },
      'clist/get': clistHandler(market),
    });
    const m = await new EastmoneyProvider().getMovers(50);
    expect(m.flat).toEqual([]);
    // 只有家数统计 + 涨幅首页 + 跌幅首页 3 个请求
    expect(fn.mock.calls).toHaveLength(3);
  });

  it('push2 失败自动降级 push2delay（延时行情托底）', async () => {
    const market = buildMarket();
    const fn = mockFetchRouter({
      'https://push2.eastmoney.com': new Error('fetch failed'), // 模拟 IP 限流断连
      'ulist.np': COUNTS_3MKTS,
      'clist/get': clistHandler(market),
    });
    const m = await new EastmoneyProvider().getMovers(50);
    expect(m.upCount).toBe(100);
    expect(m.up[0].code).toBe('600000');
    expect(m.delayed).toBe(true); // 延时宿主数据要标注，展示层提示用户
    // 先尝试 push2（失败），随后降级到 push2delay 并成功
    expect(String(fn.mock.calls[0][0])).toContain('https://push2.eastmoney.com');
    expect(fn.mock.calls.some(([u]) => String(u).startsWith('https://push2delay'))).toBe(true);
  });

  it('两个宿主都失败时抛错（带最后一次错误信息）', async () => {
    mockFetchRouter({ '': new Error('fetch failed') }); // 空 key 匹配所有 URL
    await expect(new EastmoneyProvider().getMovers(50)).rejects.toThrow('fetch failed');
  });

  it('结果缓存 60s：第二次调用不再发请求', async () => {
    const market = buildMarket();
    const fn = mockFetchRouter({ 'ulist.np': COUNTS_3MKTS, 'clist/get': clistHandler(market) });
    const p = new EastmoneyProvider();
    await p.getMovers(50);
    const callsAfterFirst = fn.mock.calls.length;
    const again = await p.getMovers(50);
    expect(fn.mock.calls.length).toBe(callsAfterFirst);
    expect(again.upCount).toBe(100);
  });

  it('真实响应回放：clist-gainers-5.json + ulist-mover-counts.json', async () => {
    mockFetchRouter({
      'ulist.np': JSON.parse(readFileSync(path.join(FIXTURES, 'ulist-mover-counts.json'), 'utf-8')),
      'clist/get': (url: string) => {
        if (url.includes('pn=1&pz=5&po=1')) {
          return JSON.parse(readFileSync(path.join(FIXTURES, 'clist-gainers-5.json'), 'utf-8'));
        }
        return { data: { total: 5915, diff: [] } }; // 二分/扫描打到空页
      },
    });
    const m = await new EastmoneyProvider().getMovers(5);
    expect(m.up).toHaveLength(5);
    expect(m.up[0]).toEqual({ code: '688004', name: '博汇科技', price: 27.38, changePct: 19.98 });
    // 北交所 920 段也在榜单范围内
    expect(m.up[4].code).toBe('920200');
    // 家数 = 沪(550/1757/42) + 深(564/2337/32) + 京(72/266/5)
    expect(m.upCount).toBe(1186);
    expect(m.downCount).toBe(4360);
    expect(m.flatCount).toBe(79);
    expect(m.flat).toEqual([]);
  });
});
