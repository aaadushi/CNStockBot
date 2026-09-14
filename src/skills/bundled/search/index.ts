import type { Skill } from '../../types.js';

const skill: Skill = {
  name: 'search_stock',
  description:
    '按股票名称或代码片段搜索 A 股，返回候选代码列表。用户只说股票名称（没说代码）时，必须先用本技能确定代码，再调用其他技能。',
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '搜索关键词：股票名称（如"比亚迪"）、名称片段或代码前几位',
      },
    },
    required: ['keyword'],
  },
  async execute(args, ctx) {
    const keyword = String(args.keyword ?? '').trim();
    if (!keyword) return '请提供搜索关键词';
    if (!ctx.data.search) return '当前数据源不支持搜索，请直接向用户询问 6 位股票代码';

    const results = await ctx.data.search(keyword);
    if (results.length === 0) {
      return [
        `未找到匹配"${keyword}"的 A 股。可能是名称有误，或该股票已退市/尚未上市。`,
        '（重要：请如实告知用户未找到，并请其提供 6 位代码或更准确的名称；不要凭你的记忆给出代码或行情）',
      ].join('\n');
    }
    const lines = results.map((r, i) => `${i + 1}. ${r.name}（${r.code}）`);
    return [
      `找到 ${results.length} 只匹配"${keyword}"的股票：`,
      ...lines,
      '（请核对名称是否为用户所指，再用对应代码调用其他技能；有歧义时把候选列给用户选择）',
    ].join('\n');
  },
};

export default skill;
