import type { Skill } from '../../types.js';
import { normalizeLimit } from '../../args.js';

const skill: Skill = {
  name: 'get_market_news',
  description:
    '查询全市场财经快讯（宏观、政策、外围市场、行业动态等滚动资讯）。用户问"最近有什么财经新闻/市场快讯/宏观消息"等不带具体股票的问题时使用；问某只股票的新闻用 get_stock_news。',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: '返回条数，默认 10，最多 30' },
    },
  },
  async execute(args, ctx) {
    if (!ctx.data.getMarketNews) {
      return '当前数据源不支持全市场财经快讯（需启动 data-service 数据微服务）。请如实告知用户该功能暂不可用。';
    }
    const limit = normalizeLimit(args.limit, 10, 30);
    const items = await ctx.data.getMarketNews(limit);
    if (items.length === 0) {
      return '未获取到近期财经快讯。请如实告知用户未找到，不要凭记忆编造新闻。';
    }
    return items
      .map(
        (n, i) =>
          `${i + 1}. ${n.title}` +
          (n.publishTime ? `\n   时间：${n.publishTime}` : '') +
          (n.source ? `  来源：${n.source}` : ''),
      )
      .join('\n');
  },
};

export default skill;
