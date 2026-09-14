/**
 * search_stock 技能单测：execute 的入参校验与结果格式化逻辑。
 * 数据源（ctx.data.search）全部 mock，不发起真实网络请求。
 */
import { describe, it, expect, vi } from 'vitest';
import skill from '../src/skills/bundled/search/index.js';
import type { SkillContext } from '../src/skills/types.js';
import type { DataProvider } from '../src/data/provider.js';
import type { Store } from '../src/storage/store.js';

/** 构造测试用 SkillContext，只注入 data.search 行为，store 不使用 */
function makeCtx(search?: DataProvider['search']): SkillContext {
  return {
    userId: 'test-user',
    store: {} as Store,
    data: { name: 'mock', search } as unknown as DataProvider,
  };
}

describe('search_stock 技能', () => {
  it('空关键词直接提示，不调用数据源', async () => {
    const search = vi.fn();
    expect(await skill.execute({ keyword: '' }, makeCtx(search))).toBe('请提供搜索关键词');
    expect(await skill.execute({ keyword: '   ' }, makeCtx(search))).toBe('请提供搜索关键词');
    expect(await skill.execute({}, makeCtx(search))).toBe('请提供搜索关键词');
    expect(search).not.toHaveBeenCalled();
  });

  it('数据源不支持搜索时给出降级提示', async () => {
    const text = await skill.execute({ keyword: '比亚迪' }, makeCtx(undefined));
    expect(text).toContain('不支持搜索');
    expect(text).toContain('6 位股票代码');
  });

  it('无结果时如实告知，并禁止 LLM 凭记忆作答', async () => {
    const search = vi.fn(async () => []);
    const text = await skill.execute({ keyword: '不存在的股' }, makeCtx(search));
    expect(text).toContain('未找到匹配"不存在的股"');
    expect(text).toContain('不要凭你的记忆');
    expect(search).toHaveBeenCalledWith('不存在的股');
  });

  it('有关键词首尾空白时 trim 后再搜索', async () => {
    const search = vi.fn(async () => []);
    await skill.execute({ keyword: ' 比亚迪 ' }, makeCtx(search));
    expect(search).toHaveBeenCalledWith('比亚迪');
  });

  it('有结果时返回编号候选列表，包含名称与代码', async () => {
    const search = vi.fn(async () => [
      { code: '002594', name: '比亚迪' },
      { code: '300999', name: '金龙鱼' },
    ]);
    const text = await skill.execute({ keyword: '比' }, makeCtx(search));
    expect(text).toContain('找到 2 只匹配"比"的股票');
    expect(text).toContain('1. 比亚迪（002594）');
    expect(text).toContain('2. 金龙鱼（300999）');
    expect(text).toContain('有歧义时把候选列给用户选择');
  });
});
