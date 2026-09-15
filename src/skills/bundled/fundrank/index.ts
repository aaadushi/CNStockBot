import type { Skill } from '../../types.js';
import { normalizeLimit } from '../../args.js';

/** 与 data-service /funds/rank 端点白名单保持一致（天天基金接口实际支持的类型） */
const FUND_TYPES = ['全部', '股票型', '混合型', '债券型', '指数型', 'QDII', 'FOF'] as const;

/** 百分比格式化：null/NaN（新基金区间收益缺失）显示 — */
function pct(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

const skill: Skill = {
  name: 'get_fund_rank',
  description:
    '查询开放式基金排行榜（按近1年收益率降序，可按基金类型筛选）。用户问"基金排行/哪些基金收益高/股票型基金排名"时使用；场内 ETF 行情不在本技能范围。',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: `基金类型：${FUND_TYPES.join('/')}，默认全部`,
      },
      limit: { type: 'number', description: '返回条数，默认 10，最多 50' },
    },
  },
  async execute(args, ctx) {
    if (!ctx.data.getFundRank) {
      return '基金排行数据不可用：当前数据源不支持（需启动 data-service 数据微服务）。请如实告知用户。';
    }
    const type = String(args.type ?? '全部').trim() || '全部';
    if (!(FUND_TYPES as readonly string[]).includes(type)) {
      return `基金类型只能是：${FUND_TYPES.join('/')}（收到的是"${type}"）。`;
    }
    const limit = normalizeLimit(args.limit, 10, 50);
    const items = await ctx.data.getFundRank(type, limit);
    if (items.length === 0) {
      return `未获取到${type}基金排行数据。请如实告知用户未获取到，不要凭记忆编造排名。`;
    }
    const lines = items.map(
      (f, i) =>
        `${i + 1}. ${f.name}（${f.code}）` +
        `\n   单位净值：${f.unitNav !== null && Number.isFinite(f.unitNav) ? f.unitNav.toFixed(4) : '—'}` +
        `（${f.date}）  日增长率：${pct(f.dayPct)}` +
        `\n   近1月：${pct(f.month1)}  近3月：${pct(f.month3)}  近1年：${pct(f.year1)}  今年来：${pct(f.thisYear)}`,
    );
    return [
      `${type === '全部' ? '' : type}开放式基金排行（按近1年收益率降序，天天基金数据）：`,
      ...lines,
    ].join('\n');
  },
};

export default skill;
