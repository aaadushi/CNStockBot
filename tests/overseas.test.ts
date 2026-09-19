/**
 * F6-4 外盘联动监控单测：
 * - PythonServiceProvider.getOverseasSummary：URL 与响应透传、非 200/连接失败两种错误分支
 * - CompositeProvider.getOverseasSummary：微服务失败时的降级错误文案（带启动提示）
 * - buildOverseasHints：规则映射的触发/不触发/块失败跳过
 * - buildOverseasPushText：盘前推送文案构造（块齐全/块失败降级/免责声明）
 * fetch 全 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import { createProvider } from '../src/data/index.js';
import { buildOverseasHints } from '../src/data/overseasHints.js';
import { buildOverseasPushText } from '../src/alerts/scheduler.js';
import type { OverseasBlock, OverseasSummary } from '../src/data/provider.js';

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function block(items: OverseasBlock['items'], error: string | null = null): OverseasBlock {
  return { source: error ? null : 'tencent', error, items };
}

function makeSummary(overrides: Partial<OverseasSummary> = {}): OverseasSummary {
  return {
    generatedAt: '2026-09-19 09:10:00',
    usIndices: block([
      { code: '.DJI', name: '道琼斯工业指数', price: 51682.64, changePct: -0.18, time: '2026-09-18 17:52:27' },
      { code: '.IXIC', name: '纳斯达克综合指数', price: 26522.55, changePct: 0.39, time: '2026-09-18 17:15:59' },
      { code: '.INX', name: '标普500', price: 7650.5, changePct: 0.17, time: '2026-09-18 17:29:48' },
    ]),
    usHot: block([
      { code: 'BABA.N', name: '阿里巴巴', price: 113.24, changePct: 0.8, time: '2026-09-18 16:05:15' },
      { code: 'PDD.OQ', name: '拼多多', price: 78.9, changePct: -0.5, time: '2026-09-18 16:00:02' },
    ]),
    commodities: block([
      { code: 'XAU', name: '伦敦金', price: 4378.29, changePct: 0.84, time: '2026-09-19 04:54:00' },
      { code: 'CL', name: 'NYMEX原油（WTI）', price: 95.41, changePct: -1.87, time: '2026-09-19 04:59:58' },
    ]),
    ...overrides,
  };
}

describe('PythonServiceProvider.getOverseasSummary', () => {
  it('URL 为 /overseas/summary，响应原样透传（含块级 error 字段）', async () => {
    const summary = makeSummary({ usHot: block([], '中概股/美股热门获取失败: boom') });
    const fn = mockFetchJson(summary);
    const got = await new PythonServiceProvider().getOverseasSummary();
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/overseas/summary');
    expect(got).toEqual(summary);
    expect(got.usHot.error).toContain('boom');
  });

  it('非 200 响应抛错并带状态码', async () => {
    mockFetchJson({ detail: '上游数据源超时' }, 504);
    await expect(new PythonServiceProvider().getOverseasSummary()).rejects.toThrow('504');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().getOverseasSummary()).rejects.toThrow('data-service');
  });
});

describe('CompositeProvider.getOverseasSummary 降级错误文案', () => {
  it('微服务连接失败时抛出带启动提示的错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    const provider = createProvider(); // 默认 eastmoney 组合模式
    await expect(provider.getOverseasSummary!()).rejects.toThrow('外盘数据不可用');
    await expect(provider.getOverseasSummary!()).rejects.toThrow('uvicorn');
  });
});

describe('buildOverseasHints', () => {
  it('各品种波动均在阈值内时返回一条"无显著方向提示"', () => {
    const hints = buildOverseasHints(makeSummary());
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('无显著方向提示');
  });

  it('纳指大涨 ≥1.5% 触发科技板块提示（含"仅供参考"，无买卖建议措辞）', () => {
    const s = makeSummary();
    s.usIndices.items[1].changePct = 2.3;
    const hints = buildOverseasHints(s);
    expect(hints.some((h) => h.includes('纳斯达克') && h.includes('科技') && h.includes('仅供参考'))).toBe(true);
    expect(hints.join('')).not.toMatch(/买入|卖出|建议买|建议卖/);
  });

  it('黄金 |涨跌幅| ≥1% 触发贵金属提示；原油 -1.87% 低于 2% 阈值不触发', () => {
    const s = makeSummary();
    s.commodities.items[0].changePct = 1.2;
    const hints = buildOverseasHints(s);
    expect(hints.some((h) => h.includes('金价') && h.includes('贵金属'))).toBe(true);
    expect(hints.some((h) => h.includes('原油'))).toBe(false);
  });

  it('中概篮子均值 |≥1.5%| 触发中概联动提示（等权平均）', () => {
    const s = makeSummary();
    s.usHot.items[0].changePct = 4.33;
    s.usHot.items[1].changePct = 1.51; // 均值 2.92
    const hints = buildOverseasHints(s);
    expect(hints.some((h) => h.includes('中概') && h.includes('+2.92%'))).toBe(true);
  });

  it('失败的块（error 非空）不参与映射', () => {
    const s = makeSummary({
      usIndices: block([], '美股指数获取失败'),
      usHot: block([], 'fail'),
      commodities: block([], 'fail'),
    });
    const hints = buildOverseasHints(s);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('无显著方向提示');
  });

  it('涨跌幅为 null 的条目不参与计算也不报错', () => {
    const s = makeSummary();
    s.usHot.items = [
      { code: 'X', name: '停牌股', price: null, changePct: null },
      { code: 'BABA.N', name: '阿里巴巴', price: 113.24, changePct: 0.5 },
    ];
    const hints = buildOverseasHints(s);
    expect(hints).toHaveLength(1); // 单只 0.5% 低于阈值
  });
});

describe('buildOverseasPushText', () => {
  it('块齐全时含三大块 + 方向提示 + 免责声明', () => {
    const text = buildOverseasPushText(makeSummary());
    expect(text).toContain('【盘前外盘参考】');
    expect(text).toContain('道琼斯工业指数 51682.64  -0.18%');
    expect(text).toContain('中概股与美股热门篮子：2 只平均 +0.15%（涨 1 / 跌 1）');
    expect(text).toContain('伦敦金 4378.29  +0.84%');
    expect(text).toContain('【方向提示】');
    expect(text).toContain('以上仅供参考，不构成投资建议。');
  });

  it('指数/商品块失败时降级为"暂不可用"行，不阻塞其余块', () => {
    const text = buildOverseasPushText(
      makeSummary({
        usIndices: block([], 'fail'),
        commodities: block([], 'fail'),
      }),
    );
    expect(text).toContain('美股三大指数：暂不可用');
    expect(text).toContain('国际金银原油：暂不可用');
    expect(text).toContain('中概股与美股热门篮子'); // usHot 块仍在
  });

  it('中概块失败时不输出篮子统计行', () => {
    const text = buildOverseasPushText(makeSummary({ usHot: block([], 'fail') }));
    expect(text).not.toContain('热门篮子');
    expect(text).toContain('以上仅供参考，不构成投资建议。');
  });
});
