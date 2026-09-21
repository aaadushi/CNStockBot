/**
 * analyze_stock（F5-2）：AI 个股多维分析的数据聚合技能。
 * 一次性并发拉取 行情/估值、公司资料、资金流、技术指标、财报、新闻、资金流验货（F6-2）七块
 * 结构化数据，格式化为紧凑文本回传给 LLM，由 LLM 分维度客观解读（解读与免责声明由 SYSTEM_PROMPT 约束）。
 * 各块独立降级：单块失败/数据源不支持只影响该块文本，不拖垮整体。
 */
import type { Skill } from '../../types.js';
import { invalidCodeMessage } from '../../args.js';
import type {
  Quote,
  CompanyProfile,
  FlowVerifyReport,
  FundFlow,
  TechnicalIndicators,
  FinancialReport,
  NewsItem,
} from '../../../data/provider.js';

/** 金额（元）→ 亿/万亿 可读格式；缺失/非正值返回 null（该行不显示） */
function fmtCap(v?: number): string | null {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return null;
  return v >= 1e12 ? `${(v / 1e12).toFixed(2)} 万亿` : `${(v / 1e8).toFixed(2)} 亿`;
}

/** 带符号净流入（元）→ +亿/-亿/万；0 是合法值，null 缺失 */
function fmtFlow(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)} 亿`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(2)} 万`;
  return `${sign}${Math.round(a)} 元`;
}

const num = (v: number | null | undefined, digits = 2): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';

/** 行情与估值块 */
function fmtQuote(q: Quote): string {
  const lines = [
    `最新价 ${num(q.price)} 元，涨跌幅 ${Number.isFinite(q.changePct) ? `${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%` : '—'}，昨收 ${num(q.prevClose)} 元`,
  ];
  const cap = [
    q.totalMarketCap !== undefined ? `总市值 ${fmtCap(q.totalMarketCap) ?? '—'}` : null,
    q.floatMarketCap !== undefined ? `流通市值 ${fmtCap(q.floatMarketCap) ?? '—'}` : null,
    q.peTtm !== undefined ? `PE(TTM) ${num(q.peTtm)}` : q.peDynamic !== undefined ? `PE(动态) ${num(q.peDynamic)}` : null,
    q.pb !== undefined ? `PB ${num(q.pb)}` : null,
  ].filter(Boolean);
  if (cap.length) lines.push(cap.join('，'));
  const activity = [
    q.amount !== undefined ? `成交额 ${fmtCap(q.amount) ?? '—'}` : null,
    q.turnover !== undefined ? `换手率 ${num(q.turnover)}%` : null,
    q.volumeRatio !== undefined ? `量比 ${num(q.volumeRatio)}` : null,
  ].filter(Boolean);
  if (activity.length) lines.push(activity.join('，'));
  const band = [
    q.limitUp !== undefined ? `涨停价 ${num(q.limitUp)}` : null,
    q.limitDown !== undefined ? `跌停价 ${num(q.limitDown)}` : null,
    q.week52High !== undefined ? `52周高 ${num(q.week52High)}` : null,
    q.week52Low !== undefined ? `52周低 ${num(q.week52Low)}` : null,
  ].filter(Boolean);
  if (band.length) lines.push(band.join('，'));
  if (q.time) lines.push(`行情时间：${q.time}`);
  return lines.join('\n');
}

function fmtProfile(p: CompanyProfile): string {
  const shares = (v?: number) =>
    v === undefined || !Number.isFinite(v) || v <= 0
      ? '—'
      : v >= 1e8
        ? `${(v / 1e8).toFixed(2)} 亿股`
        : `${(v / 1e4).toFixed(2)} 万股`;
  return `所属行业：${p.industry ?? '—'}，上市日期：${p.listingDate ?? '—'}，总股本 ${shares(p.totalShares)}，流通股 ${shares(p.floatShares)}`;
}

/** 资金流块：最新交易日两档 + 近 5 日主力净流入合计 */
function fmtFundFlow(ff: FundFlow): string {
  const sina = ff.source === 'sina'; // 新浪降级源"净流入"含全部资金，口径与东财"主力净流入"不同
  const label = sina ? '净流入' : '主力净流入';
  const items = ff.items;
  if (items.length === 0) return '（无资金流数据）';
  const last = items[items.length - 1];
  const lines = [
    `最近交易日（${last.date}）：${label} ${fmtFlow(last.mainNetInflow)}，超大单 ${fmtFlow(last.superLargeNetInflow)}` +
      (typeof last.largeNetInflow === 'number' ? `，大单 ${fmtFlow(last.largeNetInflow)}` : ''),
  ];
  // 近 5 日合计（null 项跳过；全部为 null 则不显示该行）
  const recent = items.slice(-5);
  const vals = recent.map((it) => it.mainNetInflow).filter((v): v is number => typeof v === 'number');
  if (vals.length > 0) {
    lines.push(`近 ${recent.length} 日${label}合计：${fmtFlow(vals.reduce((a, b) => a + b, 0))}`);
  }
  if (sina) lines.push('（数据源：新浪财经降级源，"净流入"含全部资金，与东财"主力净流入"口径不同）');
  return lines.join('\n');
}

/** 技术面块：指标现值 + 关键价位 + 客观信号 */
function fmtIndicators(ind: TechnicalIndicators): string {
  const t = ind.latest;
  const lines = [
    `收盘 ${num(t.close)}；MA5/10/20/60：${num(t.ma.ma5)} / ${num(t.ma.ma10)} / ${num(t.ma.ma20)} / ${num(t.ma.ma60)}`,
    `MACD：DIF ${num(t.macd.dif, 3)}，DEA ${num(t.macd.dea, 3)}，柱 ${num(t.macd.macd, 3)}`,
    `RSI6/12/24：${num(t.rsi.rsi6, 1)} / ${num(t.rsi.rsi12, 1)} / ${num(t.rsi.rsi24, 1)}`,
    `KDJ：K ${num(t.kdj.k)}，D ${num(t.kdj.d)}，J ${num(t.kdj.j)}`,
    `BOLL 上/中/下轨：${num(t.boll.upper)} / ${num(t.boll.mid)} / ${num(t.boll.lower)}`,
  ];
  const lv = (arr: number[]) => (arr.length ? arr.map((v) => v.toFixed(2)).join(' / ') : '—');
  lines.push(`关键价位：支撑 ${lv(ind.keyLevels.support)}；压力 ${lv(ind.keyLevels.resistance)}`);
  if (ind.signals.length > 0) {
    lines.push(`当前信号（客观状态描述）：${ind.signals.map((s) => s.text).join('；')}`);
  }
  lines.push(`（数据截至 ${ind.asOf}，日 K 源：${ind.source === 'sina' ? '新浪降级源' : '东方财富'}）`);
  return lines.join('\n');
}

function fmtFinancials(items: FinancialReport[]): string {
  if (items.length === 0) return '（无财报数据）';
  return items
    .map((f) =>
      [
        `${f.period}：营收 ${f.revenue ?? '—'}`,
        `净利润 ${f.netProfit ?? '—'}`,
        f.roe !== undefined ? `ROE ${f.roe}%` : null,
        f.eps !== undefined ? `EPS ${f.eps}` : null,
      ]
        .filter(Boolean)
        .join('，'),
    )
    .join('\n');
}

function fmtNews(items: NewsItem[]): string {
  if (items.length === 0) return '（近期无新闻）';
  return items.map((n, i) => `${i + 1}. ${n.title}${n.publishedAt ? `（${n.publishedAt}）` : ''}`).join('\n');
}

/** 资金流验货块（F6-2）：近期形态信号 × 日级资金流交叉验证的分档结论 */
function fmtFlowVerify(v: FlowVerifyReport): string {
  if (v.signals.length === 0) return '近期（约 60 个交易日）未触发形态信号，无验货对象。';
  const lines = v.signals.map(
    (s) => `- ${s.date} ${s.name}（${s.direction}）：${s.verdictLabel} — ${s.basis}`,
  );
  if (v.flowSource === 'sina') {
    lines.push('（资金流为新浪财经降级源："净流入"含全部资金，与东财"主力净流入"口径不同）');
  }
  lines.push('（验货结论为形态信号与日级资金流方向的客观交叉验证，仅供参考，不构成投资建议）');
  return lines.join('\n');
}

/** 聚合结果统一格式化：fulfilled 走 formatter，rejected 标注暂不可用 */
function block<T>(title: string, r: PromiseSettledResult<T>, fmt: (v: T) => string): string {
  if (r.status === 'fulfilled') return `【${title}】\n${fmt(r.value)}`;
  const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
  return `【${title}】暂不可用：${reason}`;
}

const skill: Skill = {
  name: 'analyze_stock',
  description:
    '个股多维分析（F5-2）：一次性聚合指定股票的行情/估值、公司资料、资金流、技术指标、近两期财报、最新新闻' +
    '与资金流验货（近期形态信号的资金流交叉验证，F6-2），' +
    '返回结构化数据快照，供你分维度客观解读。用户要求"分析/全面评价/怎么看/能不能买"某只股票时使用；' +
    '只回答行情数字用 get_stock_quote 即可，不必调本技能。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '6 位股票代码，如 600519（贵州茅台）、002594（比亚迪）' },
    },
    required: ['code'],
  },
  async execute(args, ctx) {
    const code = String(args.code ?? '');
    const bad = invalidCodeMessage(code);
    if (bad) return bad;

    const data = ctx.data;
    const unsupported = (what: string) =>
      Promise.reject(new Error(`数据源不支持${what}（需启动 data-service 数据微服务）`));
    // 七块并发、独立降级：单块失败只影响该块（与详情聚合 /api/stocks/:code 同一模式）
    const [quote, profile, fundFlow, indicators, financials, news, flowVerify] =
      await Promise.allSettled([
        data.getQuote(code),
        data.getProfile ? data.getProfile(code) : unsupported('公司资料'),
        data.getFundFlow ? data.getFundFlow(code, 15) : unsupported('资金流'),
        data.getIndicators ? data.getIndicators(code, 250) : unsupported('技术指标'),
        data.getFinancials ? data.getFinancials(code, 2) : unsupported('财报'),
        data.getNews(code, 5, 'time'), // 分析看最新动态，用时间倒序
        data.getFlowVerify ? data.getFlowVerify(code) : unsupported('资金流验货'),
      ]);

    const name = quote.status === 'fulfilled' ? quote.value.name : '';
    const header = `${name ? `${name}（${code}）` : code}多维数据快照：` +
      '以下为客观数据，请按维度（行情估值/资金/技术/基本面/消息面）如实解读，' +
      '不得给出买卖建议、目标价或收益承诺。';
    return [
      header,
      block('行情与估值', quote, fmtQuote),
      block('公司资料', profile, fmtProfile),
      block('资金流', fundFlow, fmtFundFlow),
      block('技术面', indicators, fmtIndicators),
      block('基本面（近两期财报）', financials, fmtFinancials),
      block('消息面（最新 5 条新闻）', news, fmtNews),
      block('资金流验货', flowVerify, fmtFlowVerify),
    ].join('\n\n');
  },
};

export default skill;
