/**
 * Agent 对话循环：接收用户消息 → LLM 决定是否调用技能 → 执行技能 → 回传结果 → 生成最终回复。
 * 会话历史持久化在 Store（SQLite），进程重启不丢；只存 user/assistant 问答对。
 */
import { chat, type ChatMessage } from '../llm/client.js';
import { getSkill, toToolSpecs } from '../skills/registry.js';
import type { SkillContext } from '../skills/types.js';
import type { DataProvider } from '../data/provider.js';
import type { Store } from '../storage/store.js';

const SYSTEM_PROMPT = `你是"股助手"，一个 A 股信息助手。用户会向你询问他们所购买股票的相关信息。

规则：
1. 用户提到具体股票时，优先使用技能查询真实数据，不要凭记忆编造行情、价格或新闻。
2. 用户只说股票名称而不确定代码时，先用 search_stock 搜索确认代码（核对返回名称是否为用户所指，
   有歧义时把候选列给用户选择），再进行后续查询。不要凭记忆猜代码。
   若 search_stock 返回"未找到"或搜索工具本身报错，直接告知用户没找到、请其提供 6 位代码或更准确的名称——
   此时禁止凭记忆给出代码，更禁止凭记忆回答行情。
3. 用户说"我买的股票/我的持仓"时，指的是其自选股列表，用 manage_watchlist 查询。
4. 所有输出用中文，简洁、口语化，适合在聊天软件里阅读。
5. 你可以汇总和解读公开信息，但不得给出明确的买卖指令或收益承诺。
6. 每次涉及个股分析的回复结尾，附上一句"以上仅供参考，不构成投资建议"。`;

const MAX_TOOL_ROUNDS = 8;
const MAX_HISTORY = 20; // 每个用户保留的最近消息条数

export class Agent {
  constructor(
    private store: Store,
    private data: DataProvider,
  ) {}

  async handleMessage(userId: string, text: string): Promise<string> {
    const history = this.store.getHistory(userId);
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: text },
    ];
    const ctx: SkillContext = { userId, store: this.store, data: this.data };
    const tools = toToolSpecs();

    let reply = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const msg = await chat(messages, tools);
      messages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        reply = msg.content ?? '';
        break;
      }
      // 执行所有工具调用，结果作为 tool 消息回传
      for (const call of msg.tool_calls) {
        const skill = getSkill(call.function.name);
        let result: string;
        try {
          if (!skill) throw new Error(`未知技能: ${call.function.name}`);
          const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
          result = await skill.execute(args, ctx);
        } catch (err) {
          result = `技能执行出错：${err instanceof Error ? err.message : String(err)}`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
    if (!reply) reply = '（处理超时，请换个方式再问一次）';

    // 更新会话历史（不含 system，不含中间工具消息，只保留问答对），持久化到 Store
    history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    this.store.saveHistory(userId, history.slice(-MAX_HISTORY));
    return reply;
  }
}
