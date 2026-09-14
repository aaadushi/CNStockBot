/**
 * 技能系统：参考 CloddsBot 的 SKILL.md 约定。
 * 每个技能一个目录（src/skills/bundled/<name>/），包含：
 *   - SKILL.md   给 LLM / 人类看的说明（触发场景、参数、示例）
 *   - index.ts   导出 Skill 实现（default export）
 * 新增技能：建目录、写两个文件、在 registry.ts 注册。
 */
import type { DataProvider } from '../data/provider.js';
import type { Store } from '../storage/store.js';

export interface SkillContext {
  userId: string;
  store: Store;
  data: DataProvider;
}

export interface Skill {
  /** 技能名，同时作为 LLM function calling 的函数名 */
  name: string;
  /** 一句话描述，LLM 据此决定何时调用 */
  description: string;
  /** JSON Schema 参数定义 */
  parameters: Record<string, unknown>;
  /** 执行并返回纯文本结果（会作为 tool message 回传给 LLM） */
  execute(args: Record<string, unknown>, ctx: SkillContext): Promise<string>;
}
