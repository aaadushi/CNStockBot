/**
 * 东财数据源单测：
 * - toSecid：纯函数，A 股代码 → secid 前缀规则（6/9 → "1."，其余 → "0."）
 * - 行情解析：价格类字段放大 100 倍需除以 100、停牌返回 "-" 抛错等
 *   （fetch 全部 mock，不发起真实网络请求）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { toSecid, EastmoneyProvider } from '../src/data/eastmoney.js';

describe('toSecid', () => {
  it('沪市 6 开头 → 前缀 1', () => {
    expect(toSecid('600519')).toBe('1.600519');
    expect(toSecid('601318')).toBe('1.601318');
  });

  it('沪市 9 开头（B 股）→ 前缀 1', () => {
    expect(toSecid('900901')).toBe('1.900901');
  });

  it('深市 0/3 开头 → 前缀 0', () => {
    expect(toSecid('000001')).toBe('0.000001');
    expect(toSecid('300750')).toBe('0.300750');
  });

  it('北交所 4/8 开头 → 前缀 0', () => {
    expect(toSecid('430047')).toBe('0.430047');
    expect(toSecid('830799')).toBe('0.830799');
  });

  it('北交所 920 新代码段 → 前缀 0（不能按"9 开头=沪市"处理，A-303）', () => {
    expect(toSecid('920002')).toBe('0.920002');
  });

  it('容忍首尾空白', () => {
    expect(toSecid(' 600519 ')).toBe('1.600519');
  });

  it.each(['', '12345', '6005190', 'abcdef', '60051a'])('非法代码 %j 抛错', (code) => {
    expect(() => toSecid(code)).toThrow('无效的股票代码');
  });
});

/** 构造一个 fetch mock，返回给定的东财 push2 响应体 */
function mockFetchWith(payload: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status,
    json: async () => payload,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EastmoneyProvider.getQuote 行情解析', () => {
  it('价格字段除以 100 还原，涨跌幅除以 100', async () => {
    mockFetchWith({
      data: { f43: 168900, f57: '600519', f58: '贵州茅台', f60: 167000, f170: 114, f86: 1757908800 },
    });
    const q = await new EastmoneyProvider().getQuote('600519');
    expect(q.code).toBe('600519');
    expect(q.name).toBe('贵州茅台');
    expect(q.price).toBe(1689);
    expect(q.prevClose).toBe(1670);
    expect(q.changePct).toBeCloseTo(1.14);
    expect(q.time).toBeTruthy();
  });

  it('请求 URL 使用 toSecid 规则换算的 secid，且带 Referer 头', async () => {
    const fetchMock = mockFetchWith({
      data: { f43: 1000, f57: '300750', f58: '宁德时代', f60: 990, f170: 101 },
    });
    await new EastmoneyProvider().getQuote('300750');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain('secid=0.300750');
    expect(init.headers.Referer).toBe('https://quote.eastmoney.com/');
  });

  it('停牌/退市（f43 为 "-"）抛错，错误信息包含代码', async () => {
    mockFetchWith({ data: { f43: '-', f57: '600000', f58: '-' } });
    await expect(new EastmoneyProvider().getQuote('600000')).rejects.toThrow('600000');
  });

  it('data 为 null（代码不存在）抛错', async () => {
    mockFetchWith({ data: null });
    await expect(new EastmoneyProvider().getQuote('999999')).rejects.toThrow('999999');
  });

  it('f170/f60 均为 "-" 时（如新股首日无昨收）涨跌幅/昨收为 NaN，由展示层显示 —（A-310）', async () => {
    mockFetchWith({ data: { f43: 1000, f57: '600519', f58: '贵州茅台', f60: '-', f170: '-' } });
    const q = await new EastmoneyProvider().getQuote('600519');
    expect(q.changePct).toBeNaN();
    expect(q.prevClose).toBeNaN();
  });

  it('f170 为 "-" 但有昨收时，涨跌幅由 f43/f60 自行换算', async () => {
    mockFetchWith({ data: { f43: 1010, f57: '600519', f58: '贵州茅台', f60: 1000, f170: '-' } });
    const q = await new EastmoneyProvider().getQuote('600519');
    expect(q.changePct).toBeCloseTo(1.0);
  });

  it('估值与规模字段：PE/PB 除以 100，市值单位元不缩放（F3-1）', async () => {
    mockFetchWith({
      data: {
        f43: 127721, f57: '600519', f58: '贵州茅台', f60: 127796, f170: -6,
        f116: 1596616721613.21, f117: 1596616721613.21,
        f162: 1793, f163: 1940, f164: 1961, f167: 635,
      },
    });
    const q = await new EastmoneyProvider().getQuote('600519');
    expect(q.peDynamic).toBeCloseTo(17.93);
    expect(q.peStatic).toBeCloseTo(19.4);
    expect(q.peTtm).toBeCloseTo(19.61);
    expect(q.pb).toBeCloseTo(6.35);
    expect(q.totalMarketCap).toBeCloseTo(1.5966e12, -8); // 约 1.6 万亿，不 ÷100
    expect(q.floatMarketCap).toBeCloseTo(1.5966e12, -8);
  });

  it('估值字段为 "-"（亏损股 PE 等）时置 undefined 而非抛错或 NaN', async () => {
    mockFetchWith({
      data: {
        f43: 1000, f57: '688001', f58: '测试亏损股', f60: 990, f170: 101,
        f116: 5e10, f117: 3e10, f162: '-', f163: '-', f164: '-', f167: '-',
      },
    });
    const q = await new EastmoneyProvider().getQuote('688001');
    expect(q.peTtm).toBeUndefined();
    expect(q.peDynamic).toBeUndefined();
    expect(q.peStatic).toBeUndefined();
    expect(q.pb).toBeUndefined();
    expect(q.totalMarketCap).toBe(5e10);
    expect(q.floatMarketCap).toBe(3e10);
  });

  it('成交活跃度字段：f47 手/f48 元不缩放，f168 换手率/f50 量比 ÷100（F3-3）', async () => {
    mockFetchWith({
      data: {
        f43: 127275, f57: '600519', f58: '贵州茅台', f60: 127796, f170: -41,
        f47: 13762, f48: 1756915149.0, f168: 11, f50: 57,
      },
    });
    const q = await new EastmoneyProvider().getQuote('600519');
    expect(q.volume).toBe(13762); // 手，不缩放
    expect(q.amount).toBeCloseTo(1756915149, -4); // 元，不缩放
    expect(q.turnover).toBeCloseTo(0.11); // ÷100
    expect(q.volumeRatio).toBeCloseTo(0.57); // ÷100
  });

  it('成交活跃度字段为 "-"（停牌等）时置 undefined 而非抛错（F3-3）', async () => {
    mockFetchWith({
      data: {
        f43: 1000, f57: '600000', f58: '浦发银行', f60: 990, f170: 101,
        f47: '-', f48: '-', f168: '-', f50: '-',
      },
    });
    const q = await new EastmoneyProvider().getQuote('600000');
    expect(q.volume).toBeUndefined();
    expect(q.amount).toBeUndefined();
    expect(q.turnover).toBeUndefined();
    expect(q.volumeRatio).toBeUndefined();
  });

  it('HTTP 非 2xx 抛错并带状态码', async () => {
    mockFetchWith({}, false, 503);
    await expect(new EastmoneyProvider().getQuote('600519')).rejects.toThrow('503');
  });
});

describe('EastmoneyProvider.getIndexQuote', () => {
  it.each(['000001', '2.000001', '1.00001', 'abc', '1.0000010'])('非法 secid %j 抛错', (secid) => {
    mockFetchWith({ data: {} });
    return expect(new EastmoneyProvider().getIndexQuote(secid)).rejects.toThrow('无效的指数 secid');
  });

  it('合法 secid 原样透传（不套用个股 toSecid 规则）', async () => {
    const fetchMock = mockFetchWith({
      data: { f43: 388899, f57: '000001', f58: '上证指数', f60: 387000, f170: 49 },
    });
    const q = await new EastmoneyProvider().getIndexQuote('1.000001');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('secid=1.000001');
    expect(q.price).toBeCloseTo(3888.99);
  });
});

describe('EastmoneyProvider.search 结果过滤', () => {
  it('只保留 0/3/6 开头的 6 位 A 股代码，过滤基金/债券/指数', async () => {
    mockFetchWith({
      QuotationCodeTable: {
        Data: [
          { Code: '600519', Name: '贵州茅台' },
          { Code: '000001', Name: '平安银行' },
          { Code: '110059', Name: '浦发转债' }, // 转债，过滤
          { Code: '510300', Name: '沪深300ETF' }, // 基金，过滤
          { Code: '300750', Name: '宁德时代' },
        ],
      },
    });
    const results = await new EastmoneyProvider().search('测试');
    expect(results).toEqual([
      { code: '600519', name: '贵州茅台' },
      { code: '000001', name: '平安银行' },
      { code: '300750', name: '宁德时代' },
    ]);
  });

  it('接口返回空数据时返回空数组', async () => {
    mockFetchWith({ QuotationCodeTable: { Data: null } });
    expect(await new EastmoneyProvider().search('不存在')).toEqual([]);
  });
});
