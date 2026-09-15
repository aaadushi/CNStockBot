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
    expect(q.price).toBeCloseTo(1277.03);
    expect(q.prevClose).toBeCloseTo(1277.96);
    expect(q.changePct).toBeCloseTo(-0.07);
    expect(q.open).toBeCloseTo(1281.0);
    expect(q.high).toBeCloseTo(1284.5);
    expect(q.low).toBeCloseTo(1273.0);
    expect(q.time).toBeTruthy();
    // 估值与规模（F3-1）：PE/PB ÷100，市值单位元不缩放
    expect(q.peTtm).toBeCloseTo(19.6);
    expect(q.peDynamic).toBeCloseTo(17.93);
    expect(q.peStatic).toBeCloseTo(19.39);
    expect(q.pb).toBeCloseTo(6.35);
    expect(q.totalMarketCap).toBeCloseTo(1.5964e12, -8);
    expect(q.floatMarketCap).toBeCloseTo(1.5964e12, -8);
  });

  it('suggest-maotai.json：搜索解析只保留 A 股个股代码', async () => {
    mockFetchWith(readFileSync(path.join(FIXTURES, 'suggest-maotai.json'), 'utf-8'));
    const list = await new EastmoneyProvider().search('茅台');
    expect(list).toEqual([{ code: '600519', name: '贵州茅台' }]);
  });
});
