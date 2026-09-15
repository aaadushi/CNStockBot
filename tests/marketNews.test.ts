/**
 * 财经快讯（F4-A）单测：
 * 1) PythonServiceProvider.getMarketNews：URL 拼接（默认/指定 limit）、响应透传、错误分支；
 * 2) get_market_news 技能：格式化、limit 归一化、空结果/数据源不支持分支。
 * fetch 与数据源全部 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import type { MarketNewsItem } from '../src/data/provider.js';
import skill from '../src/skills/bundled/marketnews/index.js';
import type { SkillContext } from '../src/skills/types.js';
import type { DataProvider } from '../src/data/provider.js';
import type { Store } from '../src/storage/store.js';

const ITEMS: MarketNewsItem[] = [
  {
    title: '香港恒生指数跌幅扩大至1%',
    summary: '香港恒生指数下跌1%至24,667.11点',
    publishTime: '2026-09-15 15:42:21',
    url: 'https://finance.eastmoney.com/a/202609153874671796.html',
    source: '东方财富',
  },
  {
    title: '美国10年期国债收益率升至5.033%',
    summary: '财联社9月15日电……',
    publishTime: '2026-09-15 15:20:14',
    url: '',
    source: '财联社',
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

describe('PythonServiceProvider.getMarketNews', () => {
  it('默认 limit=20，URL 拼接正确，响应数组原样透传', async () => {
    const fn = mockFetchJson(ITEMS);
    const items = await new PythonServiceProvider().getMarketNews();
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/market-news?limit=20');
    expect(items).toEqual(ITEMS);
  });

  it('指定 limit 时体现在 query 上', async () => {
    const fn = mockFetchJson(ITEMS);
    await new PythonServiceProvider().getMarketNews(50);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/market-news?limit=50');
  });

  it('非 200 响应抛错并带状态码', async () => {
    mockFetchJson({ detail: 'AKShare 财经快讯获取失败' }, 502);
    await expect(new PythonServiceProvider().getMarketNews()).rejects.toThrow('502');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().getMarketNews()).rejects.toThrow('data-service');
  });
});

describe('get_market_news 技能', () => {
  function makeCtx(getMarketNews?: DataProvider['getMarketNews']): SkillContext {
    return {
      userId: 'test-user',
      store: {} as Store,
      data: { name: 'mock', getMarketNews } as unknown as DataProvider,
    };
  }

  it('格式化输出：编号 + 标题 + 时间 + 来源', async () => {
    const getMarketNews = vi.fn(async () => ITEMS);
    const text = await skill.execute({}, makeCtx(getMarketNews));
    expect(getMarketNews).toHaveBeenCalledWith(10); // 默认 limit=10
    expect(text).toContain('1. 香港恒生指数跌幅扩大至1%');
    expect(text).toContain('时间：2026-09-15 15:42:21');
    expect(text).toContain('来源：东方财富');
    expect(text).toContain('2. 美国10年期国债收益率升至5.033%');
  });

  it('limit 归一化：非法值回退默认，超上限截断', async () => {
    const getMarketNews = vi.fn(async () => ITEMS);
    await skill.execute({ limit: -3 }, makeCtx(getMarketNews));
    expect(getMarketNews).toHaveBeenLastCalledWith(10);
    await skill.execute({ limit: 999 }, makeCtx(getMarketNews));
    expect(getMarketNews).toHaveBeenLastCalledWith(30);
    await skill.execute({ limit: 5 }, makeCtx(getMarketNews));
    expect(getMarketNews).toHaveBeenLastCalledWith(5);
  });

  it('空结果时如实告知，并禁止 LLM 凭记忆作答', async () => {
    const getMarketNews = vi.fn(async () => []);
    const text = await skill.execute({}, makeCtx(getMarketNews));
    expect(text).toContain('未获取到近期财经快讯');
    expect(text).toContain('不要凭记忆编造');
  });

  it('数据源不支持（无 getMarketNews）时给出降级提示，不调用数据源', async () => {
    const text = await skill.execute({}, makeCtx(undefined));
    expect(text).toContain('不支持全市场财经快讯');
    expect(text).toContain('data-service');
  });
});
