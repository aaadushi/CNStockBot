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
    expect(q.price).toBeCloseTo(1277.96);
    expect(q.prevClose).toBeCloseTo(1275.16);
    expect(q.changePct).toBeCloseTo(0.22);
    expect(q.time).toBeTruthy();
  });

  it('suggest-maotai.json：搜索解析只保留 A 股个股代码', async () => {
    mockFetchWith(readFileSync(path.join(FIXTURES, 'suggest-maotai.json'), 'utf-8'));
    const list = await new EastmoneyProvider().search('茅台');
    expect(list).toEqual([{ code: '600519', name: '贵州茅台' }]);
  });
});
