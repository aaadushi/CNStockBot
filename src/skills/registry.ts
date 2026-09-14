import type { Skill } from './types.js';
import type { ToolSpec } from '../llm/client.js';
import quote from './bundled/quote/index.js';
import news from './bundled/news/index.js';
import watchlist from './bundled/watchlist/index.js';
import search from './bundled/search/index.js';
import announcement from './bundled/announcement/index.js';
import financials from './bundled/financials/index.js';
import marketIndex from './bundled/index/index.js';

/** 所有已注册技能。新增技能时在此追加。 */
const skills: Skill[] = [quote, news, watchlist, search, announcement, financials, marketIndex];

const byName = new Map(skills.map((s) => [s.name, s]));

export function listSkills(): Skill[] {
  return skills;
}

export function getSkill(name: string): Skill | undefined {
  return byName.get(name);
}

/** 转成 OpenAI 兼容的 tools 定义，喂给 LLM */
export function toToolSpecs(): ToolSpec[] {
  return skills.map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));
}
