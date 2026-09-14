/**
 * 东方财富公开 HTTP 接口数据源（免 key，实时行情）。
 * 注意：这是东财网页端使用的非官方接口，字段与可用性可能随时变化。
 * 已知字段（push2 报价接口，价格类字段默认放大 100 倍）：
 *   f43 最新价  f44 最高  f45 最低  f46 今开  f57 代码  f58 名称
 *   f60 昨收    f169 涨跌额  f170 涨跌幅  f86 时间戳
 */
import type { DataProvider, NewsItem, Quote } from './provider.js';

const PUSH2 = 'https://push2.eastmoney.com/api/qt/stock/get';
const FIELDS = 'f43,f57,f58,f60,f170,f86';

/** A 股代码 → 东财 secid：沪市(6/9 开头) 前缀 1；深市(0/3) 与北交所(4/8) 前缀 0 */
export function toSecid(code: string): string {
  const c = code.trim();
  if (!/^\d{6}$/.test(c)) throw new Error(`无效的股票代码: ${code}（应为 6 位数字）`);
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
    const res = await fetch(url, { headers: { Referer: 'https://quote.eastmoney.com/' } });
    if (!res.ok) throw new Error(`东财行情接口请求失败: HTTP ${res.status}`);
    const json = (await res.json()) as EastmoneyQuotePayload;
    const d = json.data;
    if (!d || d.f43 === undefined || d.f43 === '-') {
      throw new Error(`未找到 ${label} 的行情（代码错误或已退市/停牌）`);
    }
    return {
      code: d.f57 ?? label,
      name: d.f58 ?? label,
      price: Number(d.f43) / 100,
      changePct: d.f170 === '-' || d.f170 === undefined ? 0 : Number(d.f170) / 100,
      prevClose: d.f60 === '-' || d.f60 === undefined ? 0 : Number(d.f60) / 100,
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
    return this.fetchQuote(secid, secid);
  }

  async getNews(_code: string, _limit = 10): Promise<NewsItem[]> {
    // 东财新闻接口较繁琐，新闻聚合统一走 Python 微服务（AKShare）。
    // 若需要纯 Node 实现，可调研东财 search-api-web 或抓取公告 RSS。
    throw new Error('eastmoney 数据源暂不支持新闻，请设置 DATA_PROVIDER=python 并启动 data-service');
  }

  /** 名称/代码 → 候选列表。走东财搜索建议接口（免 key），作为 Python 微服务的降级方案。 */
  async search(keyword: string): Promise<{ code: string; name: string }[]> {
    const url =
      `https://searchapi.eastmoney.com/api/suggest/get` +
      `?input=${encodeURIComponent(keyword)}&type=14&count=10`;
    const res = await fetch(url, { headers: { Referer: 'https://quote.eastmoney.com/' } });
    if (!res.ok) throw new Error(`东财搜索接口请求失败: HTTP ${res.status}`);
    const json = (await res.json()) as {
      QuotationCodeTable?: { Data?: { Code?: string; Name?: string }[] | null };
    };
    // type=14 覆盖全市场证券，这里只保留 A 股个股（0/3/6 开头的 6 位代码），
    // 过滤掉基金、债券、指数等（指数与个股代码规则不同，见 toSecid 注释）
    return (json.QuotationCodeTable?.Data ?? [])
      .filter((d) => d.Code && /^[036]\d{5}$/.test(d.Code))
      .map((d) => ({ code: d.Code as string, name: d.Name ?? (d.Code as string) }));
  }
}
