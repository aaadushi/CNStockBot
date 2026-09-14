import type { Skill } from '../../types.js';
import { invalidCodeMessage } from '../../args.js';

const skill: Skill = {
  name: 'get_stock_quote',
  description: '查询单只 A 股股票的实时行情（最新价、涨跌幅）。用户提到某只股票现状时使用。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '6 位股票代码，如 600519（贵州茅台）、000001（平安银行）' },
    },
    required: ['code'],
  },
  async execute(args, ctx) {
    const code = String(args.code ?? '');
    const bad = invalidCodeMessage(code);
    if (bad) return bad;
    const q = await ctx.data.getQuote(code);
    const arrow = q.changePct > 0 ? '📈' : q.changePct < 0 ? '📉' : '➖';
    return [
      `${q.name}（${q.code}）${arrow}`,
      `最新价：${q.price.toFixed(2)} 元`,
      // 涨跌幅/昨收可能缺失（如新股上市首日无昨收），NaN 时显示 — 而不是 "NaN"（审计 A-310）
      `涨跌幅：${Number.isFinite(q.changePct) ? `${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%` : '—'}`,
      `昨收：${Number.isFinite(q.prevClose) && q.prevClose > 0 ? `${q.prevClose.toFixed(2)} 元` : '—'}`,
      q.time ? `行情时间：${q.time}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  },
};

export default skill;
