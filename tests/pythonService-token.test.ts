/**
 * PythonServiceProvider / TradeCalendar 向 data-service 发送 token 的测试（S4-2）。
 * config.ts 在模块加载时读 env，需在动态 import 前 stub 环境变量。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

function mockFetchJson(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('PythonServiceProvider 数据微服务 token（S4-2）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('get 请求带 Authorization: Bearer <token>', async () => {
    vi.stubEnv('DATA_SERVICE_TOKEN', 'secret-token');
    const { PythonServiceProvider } = await import('../src/data/pythonService.js');
    const fetchMock = mockFetchJson({ code: '600519', name: '贵州茅台', price: 1500 });

    const provider = new PythonServiceProvider();
    await provider.getQuote('600519');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer secret-token');
  });

  it('post 请求带 Authorization: Bearer <token>', async () => {
    vi.stubEnv('DATA_SERVICE_TOKEN', 'secret-token');
    const { PythonServiceProvider } = await import('../src/data/pythonService.js');
    const fetchMock = mockFetchJson({ started: true, full: false });

    const provider = new PythonServiceProvider();
    await provider.triggerMarketBarsUpdate(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string> }];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer secret-token');
  });

  it('token 为空时不发送 Authorization 头', async () => {
    vi.stubEnv('DATA_SERVICE_TOKEN', '');
    const { PythonServiceProvider } = await import('../src/data/pythonService.js');
    const fetchMock = mockFetchJson({ code: '600519', name: '贵州茅台', price: 1500 });

    const provider = new PythonServiceProvider();
    await provider.getQuote('600519');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('收到 401 时抛出包含状态码的错误', async () => {
    vi.stubEnv('DATA_SERVICE_TOKEN', 'secret-token');
    const { PythonServiceProvider } = await import('../src/data/pythonService.js');
    mockFetchJson({ detail: 'Invalid or missing data service token' }, 401);

    const provider = new PythonServiceProvider();
    await expect(provider.getQuote('600519')).rejects.toThrow(/数据服务请求失败 401/);
  });
});

describe('TradeCalendar 数据微服务 token（S4-2）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('请求交易日历时带 Authorization: Bearer <token>', async () => {
    vi.stubEnv('DATA_SERVICE_TOKEN', 'calendar-token');
    const { TradeCalendar } = await import('../src/data/pythonService.js');
    const fetchMock = mockFetchJson(['2026-01-02', '2026-01-05']);

    const cal = new TradeCalendar();
    // 2026-01-05 是周一，且在上面的交易日历中
    const result = await cal.isTradeDay(new Date('2026-01-05T00:00:00+08:00'));

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain('/trade-calendar?year=2026');
    expect(init.headers.Authorization).toBe('Bearer calendar-token');
  });
});
