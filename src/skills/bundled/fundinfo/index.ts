import type { Skill } from '../../types.js';
import type { FundNavPoint } from '../../../data/provider.js';

/**
 * 从单位净值历史（日期升序）计算区间收益率。
 * 按交易日回推：近1周≈5、近1月≈22、近3月≈63、近6月≈126、近1年≈252 个交易日；
 * 历史不足（新基金）的区间不返回。导出供单测使用。
 */
export function periodReturns(history: FundNavPoint[]): { label: string; pct: number }[] {
  const pts = history.filter(
    (p): p is { date: string; nav: number; changePct: number | null } =>
      p.nav !== null && Number.isFinite(p.nav) && p.nav > 0,
  );
  const PERIODS: [string, number][] = [
    ['近1周', 5],
    ['近1月', 22],
    ['近3月', 63],
    ['近6月', 126],
    ['近1年', 252],
  ];
  const out: { label: string; pct: number }[] = [];
  for (const [label, n] of PERIODS) {
    if (pts.length <= n) continue; // 基点不存在（历史不足）
    const base = pts[pts.length - 1 - n].nav;
    const last = pts[pts.length - 1].nav;
    out.push({ label, pct: ((last - base) / base) * 100 });
  }
  return out;
}

function pct(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

const CODE_RE = /^\d{6}$/;

const skill: Skill = {
  name: 'get_fund_info',
  description:
    '查询单只开放式基金的详情：最新单位净值、日增长率与近期走势（近1月/近3月/近1年等区间收益）。用户问某只基金怎么样/净值多少时使用；参数可以是 6 位基金代码或基金名称（名称会先搜索匹配）。',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: '6 位基金代码（如 110022），或基金名称关键词（如 "易方达消费"）',
      },
    },
    required: ['code'],
  },
  async execute(args, ctx) {
    let code = String(args.code ?? '').trim();
    if (!code) return '请提供基金代码或名称。';
    if (!ctx.data.getFundInfo) {
      return '基金数据不可用：当前数据源不支持（需启动 data-service 数据微服务）。请如实告知用户。';
    }
    if (!CODE_RE.test(code)) {
      // 名称/拼音关键词 → 代码：走基金搜索（与股票 search_stock 分工，这只查基金）
      if (!ctx.data.searchFunds) return '请提供 6 位数字基金代码。';
      const found = await ctx.data.searchFunds(code, 5);
      if (found.length === 0) {
        return (
          `未找到匹配"${code}"的基金。请如实告知用户没找到，请其提供 6 位基金代码或更准确的名称——` +
          '禁止凭记忆给出基金代码或净值。'
        );
      }
      // 完全匹配（名称或代码全等）直接采用；否则多候选交给用户选择
      const exact = found.find((f) => f.name === code || f.code === code);
      if (!exact && found.length > 1) {
        const list = found.map((f, i) => `${i + 1}. ${f.name}（${f.code}，${f.type}）`).join('\n');
        return `找到多只匹配"${code}"的基金：\n${list}\n有歧义时把候选列给用户选择，确认后再用对应代码重新查询。`;
      }
      code = (exact ?? found[0]).code;
    }
    const info = await ctx.data.getFundInfo(code);
    const latest = info.latest;
    const returns = periodReturns(info.history);
    return [
      `${info.name || code}（${info.code}${info.type ? `，${info.type}` : ''}）`,
      latest
        ? `最新单位净值：${latest.nav !== null ? latest.nav.toFixed(4) : '—'}（${latest.date}）` +
          `  日增长率：${pct(latest.changePct)}`
        : '暂无净值数据',
      returns.length
        ? `区间收益（按单位净值）：${returns.map((r) => `${r.label} ${pct(r.pct)}`).join('  ')}`
        : '',
      `近 ${info.history.length} 个交易日净值走势数据已获取，如需细节可追问。`,
    ]
      .filter(Boolean)
      .join('\n');
  },
};

export default skill;
