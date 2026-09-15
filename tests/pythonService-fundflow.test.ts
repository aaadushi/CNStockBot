/**
 * PythonServiceProvider.getFundFlow 单测（F3-4 资金流）：
 * URL 拼接（含 days 参数）、响应透传（东财五档/新浪两档、null 字段不补 0）、
 * 非 200 与连接失败两种错误分支。fetch 全 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import type { FundFlow } from '../src/data/provider.js';

const FUND_FLOW_EM: FundFlow = {
  code: '600519',
  source: 'eastmoney',
  items: [
    {
      date: '2026-09-14',
      close: 1277.96,
      changePct: 0.22,
      mainNetInflow: -183102157.94,
      mainNetInflowPct: -8.84,
      superLargeNetInflow: -183102157.94,
      superLargeNetInflowPct: -8.84,
      largeNetInflow: 50000000,
      mediumNetInflow: 80000000,
      smallNetInflow: 53102157.94,
    },
    {
      date: '2026-09-15',
      close: 1272.75,
      changePct: -0.41,
      mainNetInflow: -62055328.0,
      mainNetInflowPct: -3.53,
      superLargeNetInflow: 29835616.0,
      superLargeNetInflowPct: 1.7,
      largeNetInflow: -91890944.0,
      mediumNetInflow: 62080784.0,
      smallNetInflow: -25459.0,
    },
  ],
};

/** 新浪降级源：无大/中/小单字段，缺失字段为 null 不补 0 */
const FUND_FLOW_SINA: FundFlow = {
  code: '600519',
  source: 'sina',
  items: [
    {
      date: '2026-09-15',
      close: 1273.7,
      changePct: -0.33,
      mainNetInflow: -127656042.38,
      mainNetInflowPct: -7.38,
      superLargeNetInflow: -130488492.57,
      superLargeNetInflowPct: -7.54,
    },
  ],
};

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PythonServiceProvider.getFundFlow', () => {
  it('URL 拼接正确（含 days 参数），东财五档响应原样透传', async () => {
    const fn = mockFetchJson(FUND_FLOW_EM);
    const flow = await new PythonServiceProvider().getFundFlow('600519', 30);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/fund-flow/600519?days=30');
    expect(flow).toEqual(FUND_FLOW_EM);
    expect(flow.items[1].smallNetInflow).toBe(-25459.0);
  });

  it('days 缺省默认 30', async () => {
    const fn = mockFetchJson(FUND_FLOW_EM);
    await new PythonServiceProvider().getFundFlow('600519');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/fund-flow/600519?days=30');
  });

  it('新浪降级源两档结构透传，大/中/小单字段缺省', async () => {
    mockFetchJson(FUND_FLOW_SINA);
    const flow = await new PythonServiceProvider().getFundFlow('600519');
    expect(flow.source).toBe('sina');
    expect(flow.items[0].largeNetInflow).toBeUndefined();
    expect(flow.items[0].mainNetInflow).toBe(-127656042.38);
  });

  it('非 200 响应抛错并带状态码', async () => {
    mockFetchJson({ detail: '资金流获取失败' }, 502);
    await expect(new PythonServiceProvider().getFundFlow('999999')).rejects.toThrow('502');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().getFundFlow('600519')).rejects.toThrow('data-service');
  });
});
