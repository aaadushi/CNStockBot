/**
 * get_stock_quote 技能单测：成交活跃度（F3-3）输出格式。
 * 数据源（ctx.data.getQuote）全部 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi } from 'vitest';
import skill from '../src/skills/bundled/quote/index.js';
import type { SkillContext } from '../src/skills/types.js';
import type { DataProvider, Quote } from '../src/data/provider.js';
import type { Store } from '../src/storage/store.js';

function makeCtx(quote: Partial<Quote>): SkillContext {
  return {
    userId: 'test-user',
    store: {} as Store,
    data: {
      name: 'mock',
      getQuote: vi.fn(async () => ({
        code: '600519',
        name: '贵州茅台',
        price: 1272.75,
        changePct: -0.41,
        prevClose: 1277.96,
        ...quote,
      })),
    } as unknown as DataProvider,
  };
}

describe('get_stock_quote 技能', () => {
  it('输出含成交额/换手率/量比行（F3-3）', async () => {
    const text = await skill.execute(
      { code: '600519' },
      makeCtx({ amount: 1756915149, turnover: 0.11, volumeRatio: 0.57 }),
    );
    expect(text).toContain('成交额：17.57 亿');
    expect(text).toContain('换手率：0.11%');
    expect(text).toContain('量比：0.57');
  });

  it('成交活跃度字段缺失时该行整条不显示', async () => {
    const text = await skill.execute({ code: '600519' }, makeCtx({}));
    expect(text).not.toContain('成交额');
    expect(text).not.toContain('换手率');
    expect(text).not.toContain('量比');
  });
});
