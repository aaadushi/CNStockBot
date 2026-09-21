/**
 * scan_market 技能（F5-5 全市场选股扫描）单测：
 * 1) 策略 key 白名单校验；2) 结果格式化（头部口径/命中行/TOP N 截断/免责声明/数据日期）；
 * 3) 可选方法缺失（data-service 未启动）降级提示；4) limit 归一化钳制；
 * 5) 输出长度不超过 tool 结果入库截断线（1200 字符）。DataProvider 全部 mock。
 */
import { describe, it, expect } from 'vitest';
import skill, { formatScanResult, SCAN_STRATEGY_KEYS } from '../src/skills/bundled/scanner/index.js';
import type { SkillContext } from '../src/skills/types.js';
import type { DataProvider, ScanResult } from '../src/data/provider.js';
import type { Store } from '../src/storage/store.js';

function makeItem(i: number): ScanResult['items'][number] {
  return {
    code: `60000${i}`,
    name: `测试股${i}`,
    close: 10 + i,
    changePct: 1.5,
    extra: `RSI6=${18 - i * 0.1}，处于超卖区间（≤20）`,
  };
}

const RESULT: ScanResult = {
  strategy: 'rsi_oversold',
  name: 'RSI 超卖',
  description: 'RSI6 ≤ 20，处于超卖区间（客观状态描述，非买入信号）',
  asOf: '2026-09-18',
  stale: false,
  total: 30,
  items: Array.from({ length: 10 }, (_, i) => makeItem(i)),
  disclaimer: '扫描结果是客观指标条件的筛选命中名单，不构成投资建议。',
};

function makeCtx(data: Partial<DataProvider>): SkillContext {
  return { userId: 'u1', store: {} as Store, data: data as DataProvider };
}

describe('scan_market 技能', () => {
  it('未知策略 key 返回可选清单且不调用数据源', async () => {
    let called = false;
    const ctx = makeCtx({
      runScan: async () => {
        called = true;
        return RESULT;
      },
    });
    const out = await skill.execute({ strategy: 'no_such' }, ctx);
    expect(out).toContain('未知策略');
    expect(out).toContain('ma_bull');
    expect(called).toBe(false);
  });

  it('data-service 缺失（runScan 不存在）返回带启动提示的降级文本', async () => {
    const out = await skill.execute({ strategy: 'ma_bull' }, makeCtx({}));
    expect(out).toContain('data-service');
    expect(out).toContain('不支持');
  });

  it('完整格式化：策略口径/数据日期/命中行/总数截断提示/免责声明', async () => {
    const out = await skill.execute({ strategy: 'rsi_oversold' }, makeCtx({ runScan: async () => RESULT }));
    expect(out).toContain('RSI 超卖');
    expect(out).toContain('RSI6 ≤ 20');
    expect(out).toContain('数据截至 2026-09-18');
    expect(out).toContain('共 30 只命中');
    expect(out).toContain('测试股0（600000）');
    expect(out).toContain('+1.50%');
    expect(out).toContain('完整 30 条见 /scanner 页面');
    expect(out).toContain('不构成投资建议');
    expect(out).toContain('不得表述为推荐买入');
  });

  it('stale=true 时标注"非最新交易日"；零命中输出说明', async () => {
    const stale: ScanResult = { ...RESULT, stale: true, total: 0, items: [] };
    const out = await skill.execute(
      { strategy: 'rsi_oversold' },
      makeCtx({ runScan: async () => stale }),
    );
    expect(out).toContain('非最新交易日');
    expect(out).toContain('无命中股票');
    expect(out).toContain('不构成投资建议');
  });

  it('limit 归一化：LLM 传超大值被钳到 10', async () => {
    let gotLimit = 0;
    const ctx = makeCtx({
      runScan: async (_s: string, limit?: number) => {
        gotLimit = limit ?? -1;
        return RESULT;
      },
    });
    await skill.execute({ strategy: 'ma_bull', limit: 500 }, ctx);
    expect(gotLimit).toBe(10);
  });

  it('输出长度不超过 tool 结果入库截断线（1200 字符）', () => {
    const text = formatScanResult(RESULT);
    expect(text.length).toBeLessThanOrEqual(1200);
  });

  it('策略 key 清单与描述内嵌一致（7 个预设）', () => {
    expect(SCAN_STRATEGY_KEYS).toHaveLength(7);
    for (const k of SCAN_STRATEGY_KEYS) expect(skill.description).toContain(k);
  });
});
