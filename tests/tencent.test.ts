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
