import type { Skill } from '../../types.js';
import { invalidCodeMessage } from '../../args.js';

const skill: Skill = {
  name: 'manage_watchlist',
  description: '管理用户的自选股列表：添加、删除或查看。用户说"加我自选股""我买了XXX""看看我的持仓/自选"时使用。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'remove', 'list'], description: '操作类型' },
      code: { type: 'string', description: '6 位股票代码，action 为 add/remove 时必填' },
    },
    required: ['action'],
  },
  async execute(args, ctx) {
    const action = String(args.action);
    const code = args.code ? String(args.code) : null;

    // 白名单校验：LLM 幻觉出的未知 action（如 "delete"）不得落入 remove 分支误删（审计 A-201）
    if (!['add', 'remove', 'list'].includes(action)) {
      return `未知操作"${action}"，仅支持 add/remove/list。请向用户确认意图后再操作，不要擅自删除。`;
    }

    if (action === 'list') {
      const list = ctx.store.getWatchlist(ctx.userId);
      if (list.length === 0) return '自选股列表为空。可以告诉我你买了哪些股票，我帮你加入自选。';
      // 顺便带最新行情，一次给用户全貌
      const lines = await Promise.all(
        list.map(async (c) => {
          try {
            const q = await ctx.data.getQuote(c);
            const pct = Number.isFinite(q.changePct)
              ? `${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%`
              : '—';
            return `${q.name}（${q.code}）：${q.price.toFixed(2)} 元  ${pct}`;
          } catch {
            return `${c}：行情获取失败`;
          }
        }),
      );
      return `你的自选股（${list.length} 只）：\n${lines.join('\n')}`;
    }

    if (!code || invalidCodeMessage(code)) return '请提供 6 位股票代码。';

    if (action === 'add') {
      // 先验证代码真实存在，顺便拿到名称。
      // 停牌/退市时行情接口抛错（PITFALLS：设计如此），降级用搜索确认代码存在——
      // 停牌股也应允许加入自选（那正是用户最想盯的状态）（审计 A-202）
      let name: string | null = null;
      try {
        name = (await ctx.data.getQuote(code)).name;
      } catch {
        const found = ((await ctx.data.search?.(code)) ?? []).find((r) => r.code === code);
        if (found) name = found.name;
      }
      if (!name) return `未找到代码 ${code} 对应的股票，请核对后再试（不要凭记忆猜测）。`;
      const added = ctx.store.addToWatchlist(ctx.userId, code);
      return added
        ? `已添加 ${name}（${code}）到你的自选股。`
        : `${name}（${code}）已在自选股中。`;
    }
    // action === 'remove'
    const removed = ctx.store.removeFromWatchlist(ctx.userId, code);
    return removed ? `已从自选股移除 ${code}。` : `${code} 不在你的自选股中。`;
  },
};

export default skill;
