/**
 * Agent 对话循环：接收用户消息 → LLM 决定是否调用技能 → 执行技能 → 回传结果 → 生成最终回复。
 * 会话历史持久化在 Store（SQLite），进程重启不丢；2026-09-14 起保留工具调用上下文（P3），
 * 用户追问细节时 LLM 能看到上一轮工具返回的原始数据。
 */
import { chat, type ChatMessage } from '../llm/client.js';
import { getSkill, toToolSpecs } from '../skills/registry.js';
import type { SkillContext } from '../skills/types.js';
import type { DataProvider } from '../data/provider.js';
import type { Store, HistoryMessage } from '../storage/store.js';

const SYSTEM_PROMPT = `你是"股助手"，一个 A 股信息助手。用户会向你询问他们所购买股票的相关信息。

规则：
1. 用户提到具体股票时，优先使用技能查询真实数据，不要凭记忆编造行情、价格或新闻。
2. 用户只说股票名称而不确定代码时，先用 search_stock 搜索确认代码（核对返回名称是否为用户所指，
   有歧义时把候选列给用户选择），再进行后续查询。不要凭记忆猜代码。
   若 search_stock 返回"未找到"或搜索工具本身报错，直接告知用户没找到、请其提供 6 位代码或更准确的名称——
   此时禁止凭记忆给出代码，更禁止凭记忆回答行情。
   基金同理：基金名或代码都可直接传给 get_fund_info（内部会先搜索确认代码），基金排行用 get_fund_rank；
   同样禁止凭记忆编造基金代码、净值或排名。
3. 用户说"我买的股票/我的持仓"时，指的是其自选股列表，用 manage_watchlist 查询。
4. 所有输出用中文，简洁、口语化，适合在聊天软件里阅读。
5. 你可以汇总和解读公开信息，但不得给出明确的买卖指令或收益承诺。
6. 每次涉及个股分析的回复结尾，附上一句"以上仅供参考，不构成投资建议"。`;

const MAX_TOOL_ROUNDS = 8;
/** 历史消息总条数预算（含 tool 消息；一轮问答可能产生 assistant+多条 tool+assistant 共数条） */
const MAX_HISTORY_MESSAGES = 40;
/** 单条 tool 结果入库前的最大字符数，超长截断防 token 膨胀（行情/新闻原文往往很长） */
const TOOL_RESULT_MAX_CHARS = 1200;

/**
 * 把一轮对话后的完整消息链（不含 system）裁剪成可持久化、可安全回传给 LLM 的历史。
 * 规则：
 * 1. tool 消息内容超长截断（保留开头，模型追问细节一般只需前文数据）；
 * 2. 总条数超预算时从头部丢弃最旧的消息；
 * 3. 丢弃后若链首是 tool 消息（它响应的 assistant.tool_calls 已被切掉），一并丢弃——
 *    OpenAI 兼容协议要求 tool 消息必须紧跟带对应 tool_calls 的 assistant 消息，
 *    孤儿 tool 消息会导致 API 报错。
 * 调用约定：入参不含 system 消息（返回类型因此可收窄为 HistoryMessage[]）。
 */
export function trimHistory(messages: ChatMessage[]): HistoryMessage[] {
  const truncated = messages.map((m) =>
    m.role === 'tool' && m.content && m.content.length > TOOL_RESULT_MAX_CHARS
      ? { ...m, content: `${m.content.slice(0, TOOL_RESULT_MAX_CHARS)} ……（结果过长已截断）` }
      : m,
  );
  const cut = truncated.slice(-MAX_HISTORY_MESSAGES);
  let start = 0;
  while (start < cut.length && cut[start].role === 'tool') start++;
  return cut.slice(start) as HistoryMessage[];
}

export class Agent {
  /** 按 userId 的串行队列：同一用户的消息排队处理，防并发 read-modify-write 覆盖会话历史（审计 A-101/A-407） */
  private queues = new Map<string, Promise<string>>();

  constructor(
    private store: Store,
    private data: DataProvider,
  ) {}

  handleMessage(userId: string, text: string): Promise<string> {
    const prev = this.queues.get(userId) ?? Promise.resolve('');
    // 前一条消息即使失败也不阻塞后续（catch 吞掉，错误已在原调用处返回）
    const next = prev.catch(() => '').then(() => this.process(userId, text));
    this.queues.set(userId, next);
    // 链尾完成后清理 Map，防无界增长；finally 派生的 Promise 必须接 catch，
    // 否则 next 拒绝时它成为未处理拒绝导致进程崩溃（复核发现）
    void next.finally(() => {
      if (this.queues.get(userId) === next) this.queues.delete(userId);
    }).catch(() => {});
    return next;
  }

  private async process(userId: string, text: string): Promise<string> {
    const history = this.store.getHistory(userId);
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: text },
    ];
    const ctx: SkillContext = { userId, store: this.store, data: this.data };
    const tools = toToolSpecs();

    let reply = '';
    let exhaustedRounds = true;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const msg = await chat(messages, tools);
      messages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        reply = msg.content ?? '';
        exhaustedRounds = false;
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
    // 区分两种空回复：跑满工具轮次 vs 模型首轮返回空内容（可能是内容过滤），文案不混淆（审计 A-104）
    if (!reply) {
      reply = exhaustedRounds
        ? '（处理超时，请换个方式再问一次）'
        : '（模型没有给出回复，请换个问法再试一次）';
    }

    // 更新会话历史：保留完整消息链（含 tool 调用与结果，截断超长结果后入库），
    // 下一轮对话 LLM 能看到上一轮工具返回的原始数据，追问细节不靠记忆（P3）
    this.store.saveHistory(userId, trimHistory(messages.slice(1)));
    return reply;
  }
}
