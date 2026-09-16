/**
 * fixture 回放测试：用 2026-09-14 录制的东财真实接口响应（tests/fixtures/eastmoney/）
 * 验证解析逻辑对真实响应结构的兼容性。fetch 全部 mock，不回放网络。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EastmoneyProvider } from '../src/data/eastmoney.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/eastmoney');

function mockFetchWith(body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('东财 fixture 回放', () => {
  it('quote-600519.json：行情解析（÷100）与真实字段结构一致', async () => {
    mockFetchWith(readFileSync(path.join(FIXTURES, 'quote-600519.json'), 'utf-8'));
    const q = await new EastmoneyProvider().getQuote('600519');
    expect(q.code).toBe('600519');
    expect(q.name).toBe('贵州茅台');
    expect(q.price).toBeCloseTo(1272.75);
    expect(q.prevClose).toBeCloseTo(1277.96);
    expect(q.changePct).toBeCloseTo(-0.41);
    expect(q.open).toBeCloseTo(1281.0);
    expect(q.high).toBeCloseTo(1284.5);
    expect(q.low).toBeCloseTo(1271.28);
    expect(q.time).toBeTruthy();
    // 估值与规模（F3-1）：PE/PB ÷100，市值单位元不缩放
    expect(q.peTtm).toBeCloseTo(19.54);
    expect(q.peDynamic).toBeCloseTo(17.87);
    expect(q.peStatic).toBeCloseTo(19.33);
    expect(q.pb).toBeCloseTo(6.33);
    expect(q.totalMarketCap).toBeCloseTo(1.59104e12, -8);
    expect(q.floatMarketCap).toBeCloseTo(1.59104e12, -8);
    // 成交活跃度（F3-3）：f47 手/f48 元不缩放，f168 换手率/f50 量比 ÷100
    expect(q.volume).toBe(13762);
    expect(q.amount).toBeCloseTo(1756915149, -4);
    expect(q.turnover).toBeCloseTo(0.11);
    expect(q.volumeRatio).toBeCloseTo(0.57);
    // 涨跌停与 52 周高低（F3-6）：f51/f52/f174/f175 ÷100
    expect(q.limitUp).toBeCloseTo(1405.76);
    expect(q.limitDown).toBeCloseTo(1150.16);
    expect(q.week52High).toBeCloseTo(1539.98);
    expect(q.week52Low).toBeCloseTo(1151.01);
  });

  it('suggest-maotai.json：搜索解析只保留 A 股个股代码', async () => {
    mockFetchWith(readFileSync(path.join(FIXTURES, 'suggest-maotai.json'), 'utf-8'));
    const list = await new EastmoneyProvider().search('茅台');
    expect(list).toEqual([{ code: '600519', name: '贵州茅台' }]);
  });
});
