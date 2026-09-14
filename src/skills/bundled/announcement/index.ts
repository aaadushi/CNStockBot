import type { Skill } from '../../types.js';
import { invalidCodeMessage, normalizeLimit } from '../../args.js';

const skill: Skill = {
  name: 'get_stock_announcements',
  description:
    '查询某只 A 股股票的上市公司正式公告（交易所/巨潮披露，如年报、分红、减持、停复牌等）。用户问"公告/披露"时使用；新闻媒体类消息用 get_stock_news。',
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
    const bad = invalidCodeMessage(code);
    if (bad) return bad;
    const limit = normalizeLimit(args.limit, 5, 20);
    if (!ctx.data.getAnnouncements) return '当前数据源不支持公告查询（需要启动 data-service）';

    const items = await ctx.data.getAnnouncements(code, limit);
    if (items.length === 0) {
      return `未找到 ${code} 近 30 天的公告。请如实告知用户；如用户想查更早的公告，说明目前只支持近 30 天范围。`;
    }
    return items
      .map(
        (a, i) =>
          `${i + 1}. ${a.title}` +
          (a.publishedAt ? `\n   披露时间：${a.publishedAt}` : '') +
          (a.url ? `\n   原文：${a.url}` : ''),
      )
      .join('\n');
  },
};

export default skill;
