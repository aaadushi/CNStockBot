/**
 * PythonServiceProvider.getProfile 单测（F3-2 公司资料）：
 * URL 拼接、响应透传（含缺失字段为 null）、非 200 与连接失败两种错误分支。
 * fetch 全 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import type { CompanyProfile } from '../src/data/provider.js';

const PROFILE: CompanyProfile = {
  code: '600519',
  name: '贵州茅台',
  industry: '白酒Ⅱ',
  listingDate: '2001-08-27',
  totalShares: 1250081601,
  floatShares: 1250081601,
};

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PythonServiceProvider.getProfile', () => {
  it('URL 拼接正确，响应原样透传', async () => {
    const fn = mockFetchJson(PROFILE);
    const profile = await new PythonServiceProvider().getProfile('600519');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/profile/600519');
    expect(profile).toEqual(PROFILE);
  });

  it('字段缺失（停牌/退市，服务端返回 null）原样透传不补 0', async () => {
    const partial = { code: '835185', name: null, industry: null, listingDate: null, totalShares: null, floatShares: null };
    mockFetchJson(partial);
    const profile = await new PythonServiceProvider().getProfile('835185');
    expect(profile.totalShares).toBeNull();
    expect(profile.industry).toBeNull();
  });

  it('非 200 响应抛错并带状态码', async () => {
    mockFetchJson({ detail: '公司资料获取失败' }, 502);
    await expect(new PythonServiceProvider().getProfile('999999')).rejects.toThrow('502');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().getProfile('600519')).rejects.toThrow('data-service');
  });
});
