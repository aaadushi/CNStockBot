import type { Skill } from '../../types.js';
import type { Quote } from '../../../data/provider.js';

/**
 * 常用指数 → 东财 secid 显式映射。
 * 注意：指数 secid 规则与个股不同（PITFALLS.md 东财条目），新增指数时
 * 必须到东财行情页确认 secid，不要按个股规则推导。
 */
const INDICES: { code: string; name: string; secid: string; aliases: string[] }[] = [
  { code: '000001', name: '上证指数', secid: '1.000001', aliases: ['上证', '沪指', '上证综指', '大盘'] },
  { code: '399001', name: '深证成指', secid: '0.399001', aliases: ['深成指', '深成', '深证'] },
  { code: '399006', name: '创业板指', secid: '0.399006', aliases: ['创业板'] },
  { code: '000300', name: '沪深300', secid: '1.000300', aliases: ['沪深三百', 'hs300', 'csi300'] },
  { code: '000016', name: '上证50', secid: '1.000016', aliases: ['上证五十'] },
  { code: '000905', name: '中证500', secid: '1.000905', aliases: ['中证五百'] },
  { code: '000688', name: '科创50', secid: '1.000688', aliases: ['科创'] },
  { code: '899050', name: '北证50', secid: '0.899050', aliases: ['北证'] },
];

/** 不传 name 时的概览默认拉这几个核心指数 */
const CORE_CODES = ['000001', '399001', '399006', '000300'];

function formatLine(q: Quote): string {
  const arrow = q.changePct > 0 ? '📈' : q.changePct < 0 ? '📉' : '➖';
  return `${arrow} ${q.name} ${q.price.toFixed(2)} 点  ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%`;
}

const skill: Skill = {
  name: 'get_market_index',
  description:
    '查询大盘指数行情（上证指数、深证成指、创业板指、沪深300、上证50、中证500、科创50、北证50）。用户问"今天大盘怎么样/指数涨了吗"时使用；不传 name 返回核心指数概览。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '指数名称、别名或代码（如"上证指数""创业板""000300"）；不传则返回核心指数概览',
      },
    },
  },
  async execute(args, ctx) {
    if (!ctx.data.getIndexQuote) return '当前数据源不支持指数查询';
    const name = String(args.name ?? '').trim();

    if (name) {
      // 归一化：去空白、去"指数"后缀、转小写——LLM 常传"创业板指数""沪深300指数"这类说法，
      // 纯全等匹配会把明明支持的指数误报为"暂不支持"（审计 A-205）
      const kw = name.replace(/\s+/g, '').replace(/指数$/, '').toLowerCase();
      const idx = INDICES.find((i) => {
        const candidates = [i.code, i.name, ...i.aliases].map((c) =>
          c.replace(/指数$/, '').toLowerCase(),
        );
        return candidates.some((c) => c === kw || c.includes(kw) || kw.includes(c));
      });
      if (!idx) {
        return [
          `暂不支持查询"${name}"。目前支持的指数：`,
          ...INDICES.map((i) => `- ${i.name}（${i.code}）`),
          '（请如实告知用户；如需新增指数，需在技能的映射表中补充 secid）',
        ].join('\n');
      }
      const q = await ctx.data.getIndexQuote(idx.secid);
      return formatLine(q) + (q.time ? `\n行情时间：${q.time}` : '');
    }

    const core = INDICES.filter((i) => CORE_CODES.includes(i.code));
    const lines = await Promise.all(
      core.map(async (i) => {
        try {
          return formatLine(await ctx.data.getIndexQuote!(i.secid));
        } catch {
          return `⚠️ ${i.name} 行情获取失败`;
        }
      }),
    );
    return `【大盘概览】\n${lines.join('\n')}`;
  },
};

export default skill;
