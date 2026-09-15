import type { Skill } from '../../types.js';
import { invalidCodeMessage } from '../../args.js';

const skill: Skill = {
  name: 'get_stock_quote',
  description: '查询单只 A 股股票的实时行情（最新价、涨跌幅、估值与市值）。用户提到某只股票现状时使用。',
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
    // 市值（元）→ 亿/万亿
    const capText = (v?: number) =>
      v === undefined || !Number.isFinite(v) || v <= 0
        ? null
        : v >= 1e12
          ? `${(v / 1e12).toFixed(2)} 万亿`
          : `${(v / 1e8).toFixed(2)} 亿`;
    // 估值字段可能缺失（亏损股 PE、数据源降级等），缺失的行整条不显示
    const ratioText = (v?: number) =>
      v === undefined || !Number.isFinite(v) || v <= 0 ? null : v.toFixed(2);
    const caps = [
      q.totalMarketCap !== undefined ? `总市值：${capText(q.totalMarketCap) ?? '—'}` : null,
      q.floatMarketCap !== undefined ? `流通市值：${capText(q.floatMarketCap) ?? '—'}` : null,
    ].filter(Boolean);
    const valuations = [
      q.peTtm !== undefined ? `市盈率(TTM)：${ratioText(q.peTtm) ?? '—'}` : null,
      q.pb !== undefined ? `市净率：${ratioText(q.pb) ?? '—'}` : null,
    ].filter(Boolean);
    return [
      `${q.name}（${q.code}）${arrow}`,
      `最新价：${q.price.toFixed(2)} 元`,
      // 涨跌幅/昨收可能缺失（如新股上市首日无昨收），NaN 时显示 — 而不是 "NaN"（审计 A-310）
      `涨跌幅：${Number.isFinite(q.changePct) ? `${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%` : '—'}`,
      `昨收：${Number.isFinite(q.prevClose) && q.prevClose > 0 ? `${q.prevClose.toFixed(2)} 元` : '—'}`,
      caps.length ? caps.join('，') : '',
      valuations.length ? valuations.join('，') : '',
      q.time ? `行情时间：${q.time}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  },
};

export default skill;
