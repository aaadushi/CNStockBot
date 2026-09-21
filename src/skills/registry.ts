import type { Skill } from './types.js';
import type { ToolSpec } from '../llm/client.js';
import quote from './bundled/quote/index.js';
import news from './bundled/news/index.js';
import watchlist from './bundled/watchlist/index.js';
import search from './bundled/search/index.js';
import announcement from './bundled/announcement/index.js';
import financials from './bundled/financials/index.js';
import marketIndex from './bundled/index/index.js';
import marketNews from './bundled/marketnews/index.js';
import fundrank from './bundled/fundrank/index.js';
import fundinfo from './bundled/fundinfo/index.js';
import analyze from './bundled/analyze/index.js';
import alerts from './bundled/alerts/index.js';
import patterns from './bundled/patterns/index.js';
import scanner from './bundled/scanner/index.js';

/** 所有已注册技能。新增技能时在此追加。 */
const skills: Skill[] = [quote, news, watchlist, search, announcement, financials, marketIndex, marketNews, fundrank, fundinfo, analyze, alerts, patterns, scanner];

const byName = new Map(skills.map((s) => [s.name, s]));

// 同名技能会静默互相覆盖、且重复 tool 定义可能让 LLM 接口报错——启动即暴露（审计 A-206）
if (byName.size !== skills.length) {
  const seen = new Set<string>();
  const dup = skills.filter((s) => (seen.has(s.name) ? true : (seen.add(s.name), false)));
  throw new Error(`技能重名：${dup.map((s) => s.name).join(', ')}，请检查 registry.ts 注册表`);
}

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
