import type { Skill } from '../../types.js';

const skill: Skill = {
  name: 'get_stock_news',
  description: '查询某只 A 股股票的最新新闻/公告列表。用户问"最近有什么消息/新闻/公告"时使用。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '6 位股票代码' },
      limit: { type: 'number', description: '返回条数，默认 5，最多 20' },
    },
    required: ['code'],
  },
  async execute(args, ctx) {
    const code = String(args.code ?? '');
    const limit = Math.min(Number(args.limit ?? 5), 20);
    const items = await ctx.data.getNews(code, limit);
    if (items.length === 0) return `未找到 ${code} 的近期新闻。`;
    return items
      .map(
        (n, i) =>
          `${i + 1}. ${n.title}` +
          (n.publishedAt ? `\n   时间：${n.publishedAt}` : '') +
          (n.source ? `  来源：${n.source}` : ''),
      )
      .join('\n');
  },
};

export default skill;
