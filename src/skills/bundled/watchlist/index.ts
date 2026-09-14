import type { Skill } from '../../types.js';

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

    if (action === 'list') {
      const list = ctx.store.getWatchlist(ctx.userId);
      if (list.length === 0) return '自选股列表为空。可以告诉我你买了哪些股票，我帮你加入自选。';
      // 顺便带最新行情，一次给用户全貌
      const lines = await Promise.all(
        list.map(async (c) => {
          try {
            const q = await ctx.data.getQuote(c);
            return `${q.name}（${q.code}）：${q.price.toFixed(2)} 元  ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%`;
          } catch {
            return `${c}：行情获取失败`;
          }
        }),
      );
      return `你的自选股（${list.length} 只）：\n${lines.join('\n')}`;
    }

    if (!code || !/^\d{6}$/.test(code)) return '请提供 6 位股票代码。';

    if (action === 'add') {
      // 先验证代码真实存在，顺便拿到名称
      const q = await ctx.data.getQuote(code);
      const added = ctx.store.addToWatchlist(ctx.userId, code);
      return added
        ? `已添加 ${q.name}（${code}）到你的自选股。`
        : `${q.name}（${code}）已在自选股中。`;
    }
    // remove
    const removed = ctx.store.removeFromWatchlist(ctx.userId, code);
    return removed ? `已从自选股移除 ${code}。` : `${code} 不在你的自选股中。`;
  },
};

export default skill;
