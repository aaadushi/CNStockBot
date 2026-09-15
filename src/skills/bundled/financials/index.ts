import type { Skill } from '../../types.js';
import { invalidCodeMessage, normalizeLimit } from '../../args.js';

const skill: Skill = {
  name: 'get_stock_financials',
  description:
    '查询某只 A 股股票的财务报表摘要（按报告期的营业收入、净利润、总资产、每股净资产等关键指标），用于回答业绩、基本面、赚不赚钱类问题。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '6 位股票代码' },
      limit: { type: 'number', description: '返回最近几个报告期，默认 4，最多 8' },
    },
    required: ['code'],
  },
  async execute(args, ctx) {
    const code = String(args.code ?? '');
    const bad = invalidCodeMessage(code);
    if (bad) return bad;
    const limit = normalizeLimit(args.limit, 4, 8);
    if (!ctx.data.getFinancials) return '当前数据源不支持财报查询（需要启动 data-service）';

    const items = await ctx.data.getFinancials(code, limit);
    if (items.length === 0) {
      return `未找到 ${code} 的财报摘要数据。请如实告知用户（可能是数据源暂未收录该股票）。`;
    }
    const lines = items.map((f, i) => {
      const parts = [
        f.revenue && `营收 ${f.revenue}`,
        f.netProfit && `净利润 ${f.netProfit}`,
        f.netAssets && `净资产 ${f.netAssets}`,
        f.roe && `ROE ${f.roe}`,
        f.eps && `每股收益 ${f.eps}`,
        f.totalAssets && `总资产 ${f.totalAssets}`,
        f.longTermDebt && `长期负债 ${f.longTermDebt}`,
        f.netAssetsPerShare && `每股净资产 ${f.netAssetsPerShare}`,
        f.cashFlowPerShare && `每股现金流 ${f.cashFlowPerShare}`,
        f.financeCost && `财务费用 ${f.financeCost}`,
      ].filter(Boolean);
      // 某期所有字段为空时显式标注，避免"报告期 X："空尾行诱导 LLM 脑补数据（审计 A-208）
      return `${i + 1}. 报告期 ${f.period}：${parts.length > 0 ? parts.join('，') : '（本期无数据）'}`;
    });
    return [
      ...lines,
      '（数值为新浪财务摘要原始数据，未经审计口径调整；可据此为用户解读营收/利润趋势，结尾记得附免责声明）',
    ].join('\n');
  },
};

export default skill;
