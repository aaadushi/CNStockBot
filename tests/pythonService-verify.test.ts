/**
 * PythonServiceProvider.getFlowVerify / CompositeProvider.getFlowVerify 单测（F6-2 资金流验货）：
 * URL 拼接与 days 参数、完整响应透传（三档分档值 / null 字段 / 空信号列表）、
 * 非 200 与连接失败两种错误分支、Composite 降级错误文案。
 * 分档规则本身在 data-service（Python）侧计算，边界由合成数据 sanity check 覆盖；
 * 这里验证 provider 层的解析与透传语义。fetch 全 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PythonServiceProvider } from '../src/data/pythonService.js';
import { createProvider } from '../src/data/index.js';
import type { FlowVerifyReport } from '../src/data/provider.js';

const REPORT: FlowVerifyReport = {
  code: '600519',
  days: 750,
  asOf: '2026-09-18',
  barSource: 'eastmoney',
  flowSource: 'eastmoney',
  flowNote: null,
  signals: [
    {
      key: 'bull_engulf',
      name: '看涨吞没',
      direction: '看涨',
      date: '2026-09-10',
      verdict: 'watch',
      verdictLabel: '重点观察',
      basis: '信号日（2026-09-10）起 3 个交易日中 2 日主力净流入为正，合计+1.20 亿元，方向与看涨形态一致',
      windowDates: ['2026-09-10', '2026-09-11', '2026-09-14'],
      mainNetInflowSum: 1.2e8,
    },
    {
      key: 'evening_star',
      name: '黄昏之星',
      direction: '看跌',
      date: '2026-08-20',
      verdict: 'doubt',
      verdictLabel: '存疑',
      basis: '信号日（2026-08-20）起 3 个交易日中 2 日主力净流入为正，合计+0.50 亿元，方向与看跌形态背离',
      windowDates: ['2026-08-20', '2026-08-21', '2026-08-24'],
      mainNetInflowSum: 5e7,
    },
    {
      key: 'doji',
      name: '十字星',
      direction: '中性',
      date: '2026-09-01',
      verdict: 'neutral',
      verdictLabel: '中性',
      basis: '中性形态无方向，不做资金流方向比对',
      windowDates: [],
      mainNetInflowSum: null, // null 字段原样透传
    },
  ],
  disclaimer: '资金流验货是形态信号方向与日级资金流方向的客观交叉验证结果……仅供参考，不构成投资建议。',
};

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PythonServiceProvider.getFlowVerify', () => {
  it('URL 拼接正确（含 days 参数），完整响应原样透传（三档分档值）', async () => {
    const fn = mockFetchJson(REPORT);
    const data = await new PythonServiceProvider().getFlowVerify('600519', 750);
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('/verify/600519');
    expect(url).toContain('days=750');
    expect(data).toEqual(REPORT);
    expect(data.signals.map((s) => s.verdict)).toEqual(['watch', 'doubt', 'neutral']);
  });

  it('缺省 days 走默认值 750', async () => {
    const fn = mockFetchJson(REPORT);
    await new PythonServiceProvider().getFlowVerify('600519');
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toContain('days=750');
  });

  it('无近期信号的空结果原样透传（signals=[]、flowSource=null）', async () => {
    mockFetchJson({ ...REPORT, signals: [], flowSource: null, flowNote: null });
    const data = await new PythonServiceProvider().getFlowVerify('600519');
    expect(data.signals).toEqual([]);
    expect(data.flowSource).toBeNull();
  });

  it('新浪降级源口径提示字段透传', async () => {
    mockFetchJson({ ...REPORT, flowSource: 'sina', flowNote: '资金流数据源为新浪财经降级源……' });
    const data = await new PythonServiceProvider().getFlowVerify('600519');
    expect(data.flowSource).toBe('sina');
    expect(data.flowNote).toContain('新浪');
  });

  it('非 200 响应抛错并带状态码', async () => {
    mockFetchJson({ detail: '资金流获取失败' }, 502);
    await expect(new PythonServiceProvider().getFlowVerify('999999')).rejects.toThrow('502');
  });

  it('连接失败（服务未启动）抛错并提示启动 data-service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(new PythonServiceProvider().getFlowVerify('600519')).rejects.toThrow('data-service');
  });
});

describe('CompositeProvider.getFlowVerify 降级错误文案', () => {
  it('微服务连接失败时抛出带启动提示的错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    const provider = createProvider(); // 默认 eastmoney 组合模式
    await expect(provider.getFlowVerify!('600519')).rejects.toThrow('资金流验货数据不可用');
    await expect(provider.getFlowVerify!('600519')).rejects.toThrow('uvicorn');
  });
});
