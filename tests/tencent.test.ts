/**
 * 腾讯行情数据源单测（东财的自动降级备份）：
 * toTencentCode 前缀规则、GBK 响应解析、停牌/无效代码抛错。
 * 真实响应 fixture 回放见末尾（tests/fixtures/tencent/quote-600519.txt，GBK 原文）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toTencentCode, TencentProvider } from '../src/data/tencent.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/tencent');

/** 腾讯接口返回 GBK 字节流，mock 时也必须给二进制，走真实的 GBK 解码路径 */
function mockFetchWith(buf: Buffer): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(new Uint8Array(buf), { status: 200 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toTencentCode', () => {
  it('沪市 6/9 → sh，深市 0/3 → sz，北交所 4/8/920 → bj', () => {
    expect(toTencentCode('600519')).toBe('sh600519');
    expect(toTencentCode('900901')).toBe('sh900901');
    expect(toTencentCode('000001')).toBe('sz000001');
    expect(toTencentCode('300750')).toBe('sz300750');
    expect(toTencentCode('430047')).toBe('bj430047');
    expect(toTencentCode('920002')).toBe('bj920002');
  });

  it('非法代码抛错', () => {
    expect(() => toTencentCode('abc')).toThrow('无效的股票代码');
  });
});

describe('TencentProvider.getQuote', () => {
  it('fixture 回放：GBK 响应正确解析（名称不乱码、价格不缩放）', async () => {
    mockFetchWith(readFileSync(path.join(FIXTURES, 'quote-600519.txt')));
    const q = await new TencentProvider().getQuote('600519');
    expect(q.code).toBe('600519');
    expect(q.name).toBe('贵州茅台'); // GBK 解码正确则不乱码
    expect(q.price).toBeCloseTo(1277.96); // 腾讯不放大 100 倍
    expect(q.prevClose).toBeCloseTo(1275.16);
    expect(q.changePct).toBeCloseTo(0.22);
    expect(q.time).toBe('2026-09-14 16:14:50');
  });

  it('fixture 回放：估值与规模字段（39=PE TTM 52=PE动 53=PE静 46=PB 44/45=市值亿元→元）', async () => {
    mockFetchWith(readFileSync(path.join(FIXTURES, 'quote-600519.txt')));
    const q = await new TencentProvider().getQuote('600519');
    expect(q.peTtm).toBeCloseTo(19.62);
    expect(q.peDynamic).toBeCloseTo(17.94);
    expect(q.peStatic).toBeCloseTo(19.41);
    expect(q.pb).toBeCloseTo(6.36);
    expect(q.totalMarketCap).toBeCloseTo(15975.54e8, -6); // 亿元 ×1e8 → 元
    expect(q.floatMarketCap).toBeCloseTo(15975.54e8, -6);
  });

  it('估值字段缺失或为 0（指数/亏损股）时置 undefined', async () => {
    // 构造一个估值相关下标为 0/空 的响应（价格等基础字段正常）
    const f = new Array(60).fill('0');
    f[1] = '测试指数'; f[2] = '000001'; f[3] = '3888.99'; f[4] = '3870.00'; f[32] = '0.49';
    mockFetchWith(Buffer.from(`v_sh000001="${f.join('~')}";`, 'utf-8'));
    const q = await new TencentProvider().getQuote('000001');
    expect(q.peTtm).toBeUndefined();
    expect(q.pb).toBeUndefined();
    expect(q.totalMarketCap).toBeUndefined();
    expect(q.floatMarketCap).toBeUndefined();
  });

  it('fixture 回放：成交活跃度字段（6=手 37=万元→元 38=换手率% 49=量比，F3-3）', async () => {
    mockFetchWith(readFileSync(path.join(FIXTURES, 'quote-600519.txt')));
    const q = await new TencentProvider().getQuote('600519');
    expect(q.volume).toBe(16571); // 手
    expect(q.amount).toBeCloseTo(211662e4, -2); // 万元 ×1e4 → 元
    expect(q.turnover).toBeCloseTo(0.13);
    expect(q.volumeRatio).toBeCloseTo(0.64);
  });

  it('成交活跃度字段为空串（缺失）时置 undefined，0 为合法值不吞掉', async () => {
    // 名称必须用 ASCII：UTF-8 中文末字节是合法 GBK 前导字节，GBK 解码会把紧随其后的
    // '~' 分隔符吃掉导致后续下标整体偏移（真实响应本身是 GBK 编码，无此问题）
    const f = new Array(60).fill('0');
    f[1] = 'TEST'; f[2] = '000001'; f[3] = '10.00'; f[4] = '9.90'; f[32] = '1.01';
    f[6] = '0'; f[37] = '0'; f[38] = '0'; f[49] = ''; // 量比缺失，其余为合法 0
    mockFetchWith(Buffer.from(`v_sz000001="${f.join('~')}";`, 'utf-8'));
    const q = await new TencentProvider().getQuote('000001');
    expect(q.volume).toBe(0);
    expect(q.amount).toBe(0);
    expect(q.turnover).toBe(0);
    expect(q.volumeRatio).toBeUndefined(); // 空串不能静默变 0（Number('') === 0 的坑）
  });

  it('无效代码/停牌（价格为 0 或空）抛错，错误信息包含代码', async () => {
    mockFetchWith(Buffer.from('v_xx999999="";', 'utf-8'));
    await expect(new TencentProvider().getQuote('999999')).rejects.toThrow('999999');
  });

  it('HTTP 非 2xx 抛错并带状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(new TencentProvider().getQuote('600519')).rejects.toThrow('503');
  });
});

describe('TencentProvider.getIndexQuote', () => {
  it('东财 secid 转成腾讯指数代码（1.000001 → sh000001）', async () => {
    const fn = mockFetchWith(readFileSync(path.join(FIXTURES, 'quote-600519.txt')));
    await new TencentProvider().getIndexQuote('1.000001');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('q=sh000001');
  });
});
