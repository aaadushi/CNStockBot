/**
 * PythonServiceProvider.getDividends 单测（F3-6 分红送配）：
 * URL 拼接与 limit 参数、响应透传（含缺失字段为 null）、非 200 与连接失败两种错误分支。
 * fetch 全 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import type { DividendRecord } from '../src/data/provider.js';

const RECORDS: DividendRecord[] = [
  {
    announceDate: '2026-06-22',
    exDate: '2026-06-26',
    recordDate: '2026-06-25',
    dividend: 280.24,
    bonus: 0,
    transfer: 0,
    progress: '实施',
  },
  {
    announceDate: '2025-12-11',
    exDate: '2025-12-19',
    recordDate: '2025-12-18',
    dividend: 239.57,
    bonus: 0,
    transfer: 0,
    progress: '实施',
  },
];

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PythonServiceProvider.getDividends', () => {
  it('URL 拼接正确（含 limit 参数），响应原样透传', async () => {
    const fn = mockFetchJson(RECORDS);
    const items = await new PythonServiceProvider().getDividends('600519', 10);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/dividends/600519');
    expect(url).toContain('limit=10');
    expect(items).toEqual(RECORDS);
  });

  it('缺省 limit 走默认值 10', async () => {
    const fn = mockFetchJson(RECORDS);
    await new PythonServiceProvider().getDividends('600519');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('limit=10');
  });

  it('从未分红的公司返回空数组，原样透传', async () => {
    mockFetchJson([]);
    const items = await new PythonServiceProvider().getDividends('000001');
    expect(items).toEqual([]);
  });

  it('字段缺失（服务端返回 null，如预案阶段无除权除息日）原样透传不补占位', async () => {
    const partial = [{ announceDate: '2026-03-01', exDate: null, recordDate: null, dividend: 100, bonus: null, transfer: null, progress: '预案' }];
    mockFetchJson(partial);
    const items = await new PythonServiceProvider().getDividends('600519');
    expect(items[0].exDate).toBeNull();
    expect(items[0].progress).toBe('预案');
  });

  it('非 200 响应抛错并带状态码', async () => {
    mockFetchJson({ detail: '分红送配数据获取失败' }, 502);
    await expect(new PythonServiceProvider().getDividends('999999')).rejects.toThrow('502');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().getDividends('600519')).rejects.toThrow('data-service');
  });
});
