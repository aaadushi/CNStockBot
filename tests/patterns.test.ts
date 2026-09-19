/**
 * get_stock_patterns 技能（F6-1）单测：
 * 1) 代码校验；2) 报告格式化（近期出现/成绩单/免责声明/样本过少提示）；
 * 3) 可选方法缺失（data-service 未启动）降级提示；4) 行情名称获取失败退化为代码；
 * 5) 窗口样本不足分支。DataProvider 全部 mock，不发起真实网络请求。
 */
import { describe, it, expect } from 'vitest';
import skill, { formatPatternReport } from '../src/skills/bundled/patterns/index.js';
import type { SkillContext } from '../src/skills/types.js';
import type { DataProvider, PatternReport, Quote } from '../src/data/provider.js';
import type { Store } from '../src/storage/store.js';

const REPORT: PatternReport = {
  code: '600519',
  source: 'eastmoney',
  days: 750,
  asOf: '2026-09-18',
  patterns: [
    {
      key: 'three_soldiers',
      name: '红三兵',
      direction: '看涨',
      count: 3,
      recentDates: ['2026-08-12'],
      stats: {
        '5': { count: 3, upRatio: 66.7, avgRet: 1.23, avgMaxDrawdown: -2.1 },
        '10': { count: 3, upRatio: 66.7, avgRet: 2.4, avgMaxDrawdown: -3.0 },
        '20': { count: 2, upRatio: 50.0, avgRet: -0.5, avgMaxDrawdown: -4.2 },
      },
    },
    {
      key: 'doji',
      name: '十字星',
      direction: '中性',
      count: 12,
      recentDates: [],
      stats: {
        '5': { count: 12, upRatio: 50.0, avgRet: 0.1, avgMaxDrawdown: -1.0 },
        '10': { count: 11, upRatio: 54.5, avgRet: 0.3, avgMaxDrawdown: -1.6 },
        '20': { count: 0, upRatio: null, avgRet: null, avgMaxDrawdown: null },
      },
    },
  ],
  disclaimer: '形态统计为历史事实口径，不代表未来表现，仅供参考，不构成投资建议。',
};

function makeCtx(data: Partial<DataProvider>): SkillContext {
  return { userId: 'u1', store: {} as Store, data: data as DataProvider };
}

const QUOTE: Quote = { code: '600519', name: '贵州茅台', price: 1500, changePct: 1.2, prevClose: 1482 };

describe('get_stock_patterns 技能', () => {
  it('非法代码返回提示且不调用数据源', async () => {
    let called = false;
    const ctx = makeCtx({
      getPatterns: async () => {
        called = true;
        return REPORT;
      },
    });
    const out = await skill.execute({ code: 'abc' }, ctx);
    expect(out).toContain('6 位数字');
    expect(called).toBe(false);
  });

  it('data-service 缺失（getPatterns 不存在）返回带启动提示的降级文本', async () => {
    const out = await skill.execute({ code: '600519' }, makeCtx({}));
    expect(out).toContain('data-service');
    expect(out).toContain('不支持');
  });

  it('完整格式化：名称行/近期出现/成绩单/样本过少提示/免责声明', async () => {
    const ctx = makeCtx({
      getPatterns: async () => REPORT,
      getQuote: async () => QUOTE,
    });
    const out = await skill.execute({ code: '600519' }, ctx);
    expect(out).toContain('贵州茅台（600519）');
    expect(out).toContain('数据截至 2026-09-18');
    expect(out).toContain('近期出现的形态');
    expect(out).toContain('红三兵（看涨）：2026-08-12');
    expect(out).toContain('窗口内共出现 3 次（样本过少');
    expect(out).toContain('上涨占比 66.7%');
    expect(out).toContain('平均涨跌幅 +1.23%');
    expect(out).toContain('平均最大回撤 -2.10%');
    expect(out).toContain('历史事实统计');
    expect(out).toContain('不构成投资建议');
  });

  it('行情名称获取失败（停牌等）退化为代码，不阻塞形态输出', async () => {
    const ctx = makeCtx({
      getPatterns: async () => REPORT,
      getQuote: async () => {
        throw new Error('未找到行情');
      },
    });
    const out = await skill.execute({ code: '600519' }, ctx);
    expect(out).toContain('600519');
    expect(out).toContain('红三兵');
  });

  it('窗口样本为 0 显示"样本不足"；无近期形态时近期区有说明', async () => {
    const text = formatPatternReport(REPORT);
    expect(text).toContain('20 日：样本不足'); // doji 的 20 日窗口 count=0
    const noRecent: PatternReport = {
      ...REPORT,
      patterns: REPORT.patterns.map((p) => ({ ...p, recentDates: [] })),
    };
    expect(formatPatternReport(noRecent)).toContain('未检测到形态库中的形态');
  });

  it('窗口内无任何形态时成绩单为为空说明且仍带免责声明', () => {
    const empty: PatternReport = { ...REPORT, patterns: [] };
    const text = formatPatternReport(empty);
    expect(text).toContain('统计窗口内未检测到形态库中的形态');
    expect(text).toContain('不构成投资建议');
  });
});
