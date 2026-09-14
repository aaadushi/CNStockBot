/**
 * 东方财富公开 HTTP 接口数据源（免 key，实时行情）。
 * 注意：这是东财网页端使用的非官方接口，字段与可用性可能随时变化。
 * 已知字段（push2 报价接口，价格类字段默认放大 100 倍）：
 *   f43 最新价  f44 最高  f45 最低  f46 今开  f57 代码  f58 名称
 *   f60 昨收    f169 涨跌额  f170 涨跌幅  f86 时间戳
 * 另注意：短时间内高频请求 push2 会触发东财 IP 级断连限流（PITFALLS.md 东财条目）。
 */
import type { DataProvider, NewsItem, Quote } from './provider.js';

const PUSH2 = 'https://push2.eastmoney.com/api/qt/stock/get';
const FIELDS = 'f43,f57,f58,f60,f170,f86';
/** 东财接口显式超时：防对端半挂拖住对话/调度链（审计 A-301） */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * A 股代码 → 东财 secid：
 *   沪市 6/900 开头（900 为沪 B） → 1. 前缀
 *   深市 0/3、北交所 4/8/920 开头   → 0. 前缀
 * 注意 920 是北交所 2024 年启用的新代码段，不能按"9 开头=沪市"处理（审计 A-303）。
 */
export function toSecid(code: string): string {
  const c = code.trim();
  if (!/^\d{6}$/.test(c)) throw new Error(`无效的股票代码: ${code}（应为 6 位数字）`);
  if (/^(4|8|920)/.test(c)) return `0.${c}`; // 北交所
  return c.startsWith('6') || c.startsWith('9') ? `1.${c}` : `0.${c}`;
}

interface EastmoneyQuotePayload {
  data?: {
    f43?: number | '-';
    f57?: string;
    f58?: string;
    f60?: number | '-';
    f170?: number | '-';
    f86?: number;
  } | null;
}

export class EastmoneyProvider implements DataProvider {
  readonly name = 'eastmoney';

  private async fetchQuote(secid: string, label: string): Promise<Quote> {
    const url = `${PUSH2}?secid=${secid}&fields=${FIELDS}`;
    const res = await fetch(url, {
      headers: { Referer: 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`东财行情接口请求失败: HTTP ${res.status}`);
    const json = (await res.json()) as EastmoneyQuotePayload;
    const d = json.data;
    if (!d || d.f43 === undefined || d.f43 === '-') {
      throw new Error(`未找到 ${label} 的行情（代码错误或已退市/停牌）`);
    }
    // 昨收/涨跌幅可能缺失（如新股上市首日无昨收）：不静默取 0，缺涨跌幅但有昨收时自行换算，
    // 实在算不出则置 NaN，由展示层显示"—"（审计 A-310：静默 0 会产生看似正常的错误数据）
    const prevClose = d.f60 === '-' || d.f60 === undefined ? NaN : Number(d.f60) / 100;
    let changePct = d.f170 === '-' || d.f170 === undefined ? NaN : Number(d.f170) / 100;
    if (!Number.isFinite(changePct) && Number.isFinite(prevClose) && prevClose > 0) {
      changePct = ((Number(d.f43) / 100 - prevClose) / prevClose) * 100;
    }
    return {
      code: d.f57 ?? label,
      name: d.f58 ?? label,
      price: Number(d.f43) / 100,
      changePct,
      prevClose,
      time: d.f86 ? new Date(Number(d.f86) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : undefined,
    };
  }

  async getQuote(code: string): Promise<Quote> {
    return this.fetchQuote(toSecid(code), code);
  }

  /** 指数行情。secid 必须显式给出（如 1.000001 上证指数 / 0.399006 创业板指），
   *  不能复用个股 toSecid 规则——000001 个股=平安银行(0.000001)、指数=上证(1.000001)。 */
  async getIndexQuote(secid: string): Promise<Quote> {
    if (!/^[01]\.\d{6}$/.test(secid)) throw new Error(`无效的指数 secid: ${secid}（应形如 1.000001）`);
    // label 用友好文案：指数没有"退市/停牌"，裸 secid 用户也看不懂（审计 A-307）
    return this.fetchQuote(secid, `指数 ${secid}`);
  }

  async getNews(_code: string, _limit = 10): Promise<NewsItem[]> {
    // 东财新闻接口较繁琐，新闻聚合统一走 Python 微服务（AKShare）。
    // 默认组合数据源下本方法不会被调达（Composite 拦截），仅纯东财模式兜底。
    throw new Error('eastmoney 数据源不支持新闻；请启动 data-service（默认组合数据源即可用新闻，无需改 DATA_PROVIDER）');
  }

  /** 名称/代码 → 候选列表。走东财搜索建议接口（免 key），作为 Python 微服务的降级方案。 */
  async search(keyword: string): Promise<{ code: string; name: string }[]> {
    const url =
      `https://searchapi.eastmoney.com/api/suggest/get` +
      `?input=${encodeURIComponent(keyword)}&type=14&count=10`;
    const res = await fetch(url, {
      headers: { Referer: 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`东财搜索接口请求失败: HTTP ${res.status}`);
    const json = (await res.json()) as {
      QuotationCodeTable?: { Data?: { Code?: string; Name?: string }[] | null };
    };
    // type=14 覆盖全市场证券，这里只保留 A 股个股（0/3/6 沪深 + 4/8/920 北交所，与 toSecid 口径一致，
    // 审计 A-304），过滤掉基金、债券、指数等（指数与个股代码规则不同，见 toSecid 注释）
    return (json.QuotationCodeTable?.Data ?? [])
      .filter((d) => d.Code && (/^[03648]\d{5}$/.test(d.Code) || /^920\d{3}$/.test(d.Code)))
      .map((d) => ({ code: d.Code as string, name: d.Name ?? (d.Code as string) }));
  }
}
