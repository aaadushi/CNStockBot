/**
 * Python 数据微服务客户端（data-service/，基于 AKShare）。
 * 适合新闻、公告、财报等东财公开接口不便覆盖的数据。
 */
import { config } from '../config.js';
import { EastmoneyProvider } from './eastmoney.js';
import type { Announcement, CompanyProfile, DataProvider, EtfQuote, FinancialReport, FundFlow, FundInfo, FundRankItem, FundSearchItem, HistoryBar, Intraday, MarketNewsItem, NewsItem, NewsSort, Quote } from './provider.js';

/** 微服务显式超时：AKShare 爬网页较慢，放宽到 60s；防上游挂起拖死调度链（审计 A-301/A-506） */
const FETCH_TIMEOUT_MS = 60_000;

export class PythonServiceProvider implements DataProvider {
  readonly name = 'python-akshare';
  private base = config.pythonServiceUrl;
  /** 指数行情始终走东财直连（免 key，与微服务可用性无关；审计 A-305） */
  private indexQuote = new EastmoneyProvider();

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      // 连接层失败（服务没启动/网络不通/超时）才提示启动（审计 A-309）
      throw new Error(
        `数据服务连接失败：${err instanceof Error ? err.message : String(err)}（请确认 data-service 已启动）`,
      );
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `数据服务请求失败 ${res.status}: ${body.slice(0, 200)}` +
          (res.status >= 500 ? '（服务已响应但上游数据源失败，按 PITFALLS.md AKShare 条目排查）' : ''),
      );
    }
    return (await res.json()) as T;
  }

  async getQuote(code: string): Promise<Quote> {
    return this.get<Quote>(`/quote/${encodeURIComponent(code)}`);
  }

  async getNews(code: string, limit = 10, sort: NewsSort = 'hot'): Promise<NewsItem[]> {
    return this.get<NewsItem[]>(`/news/${encodeURIComponent(code)}?limit=${limit}&sort=${sort}`);
  }

  async getAnnouncements(code: string, limit = 10): Promise<Announcement[]> {
    return this.get<Announcement[]>(`/announcements/${encodeURIComponent(code)}?limit=${limit}`);
  }

  async getFinancials(code: string, limit = 4): Promise<FinancialReport[]> {
    return this.get<FinancialReport[]>(`/financials/${encodeURIComponent(code)}?limit=${limit}`);
  }

  async getHistory(code: string, days = 120): Promise<HistoryBar[]> {
    return this.get<HistoryBar[]>(`/history/${encodeURIComponent(code)}?days=${days}`);
  }

  async getProfile(code: string): Promise<CompanyProfile> {
    return this.get<CompanyProfile>(`/profile/${encodeURIComponent(code)}`);
  }

  async getFundFlow(code: string, days = 30): Promise<FundFlow> {
    return this.get<FundFlow>(`/fund-flow/${encodeURIComponent(code)}?days=${days}`);
  }

  async getIntraday(code: string): Promise<Intraday> {
    return this.get<Intraday>(`/intraday/${encodeURIComponent(code)}`);
  }

  async getMarketNews(limit = 20): Promise<MarketNewsItem[]> {
    return this.get<MarketNewsItem[]>(`/market-news?limit=${limit}`);
  }

  async getIndexQuote(secid: string): Promise<Quote> {
    return this.indexQuote.getIndexQuote(secid);
  }

  async search(keyword: string): Promise<{ code: string; name: string }[]> {
    return this.get<{ code: string; name: string }[]>(`/search?keyword=${encodeURIComponent(keyword)}`);
  }

  async getFundRank(type = '全部', limit = 50): Promise<FundRankItem[]> {
    return this.get<FundRankItem[]>(`/funds/rank?type=${encodeURIComponent(type)}&limit=${limit}`);
  }

  async getFundInfo(code: string, days = 250): Promise<FundInfo> {
    return this.get<FundInfo>(`/funds/${encodeURIComponent(code)}?days=${days}`);
  }

  async searchFunds(keyword: string, limit = 10): Promise<FundSearchItem[]> {
    return this.get<FundSearchItem[]>(
      `/funds/search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`,
    );
  }

  async getEtfRank(limit = 50): Promise<EtfQuote[]> {
    return this.get<EtfQuote[]>(`/funds/etf?limit=${limit}`);
  }
}

/** 格式化为交易日历用的 'YYYY-MM-DD'（补零；date 应是已换算好的北京时间 Date） */
function formatYmd(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/**
 * 交易日历：判断某天是否 A 股交易日（跳过法定节假日）。
 * 数据源是 data-service 的 /trade-calendar 端点，按年缓存（年内日历不变）。
 *
 * 降级策略（重要）：data-service 不可用 / 拉取失败时不阻塞推送，
 * 降级为"只跳周末"的原行为——周末必不是交易日，工作日一律视为交易日。
 * 失败结果短期缓存 FAIL_RETRY_MS，避免每次轮询都打挂掉的服务。
 * 可用 TRADE_CALENDAR_ENABLED=false 完全关闭日历查询。
 */
export class TradeCalendar {
  private base = config.pythonServiceUrl;
  private enabled = config.tradeCalendarEnabled;
  /** year -> 该年交易日集合（'YYYY-MM-DD'） */
  private cache = new Map<number, Set<string>>();
  /** year -> 上次拉取失败的时间戳 */
  private failedAt = new Map<number, number>();
  private static FAIL_RETRY_MS = 10 * 60_000;

  async isTradeDay(date: Date): Promise<boolean> {
    const day = date.getDay();
    if (day === 0 || day === 6) return false; // 周末一定休市，无需查日历
    if (!this.enabled) return true;
    const days = await this.loadYear(date.getFullYear());
    if (!days) return true; // 日历不可用：降级为"工作日即交易日"
    return days.has(formatYmd(date));
  }

  private async loadYear(year: number): Promise<Set<string> | null> {
    const hit = this.cache.get(year);
    if (hit) return hit;
    const failTs = this.failedAt.get(year);
    if (failTs !== undefined && Date.now() - failTs < TradeCalendar.FAIL_RETRY_MS) return null;
    try {
      const res = await fetch(`${this.base}/trade-calendar?year=${year}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as string[];
      // 入缓存前校验：空数组或格式漂移（如 "YYYY-MM-DD 00:00:00"）按失败处理走重试/降级，
      // 否则会把全年工作日误判为非交易日，推送静默全停（审计 A-302/A-505）
      if (
        !Array.isArray(list) ||
        list.length === 0 ||
        !list.slice(0, 5).every((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))
      ) {
        throw new Error(`交易日历响应格式异常（条数=${Array.isArray(list) ? list.length : '非数组'}）`);
      }
      const set = new Set(list);
      this.cache.set(year, set);
      this.failedAt.delete(year);
      return set;
    } catch (err) {
      console.warn(`[trade-calendar] ${year} 年交易日历获取失败，降级为只跳周末:`, err);
      this.failedAt.set(year, Date.now());
      return null;
    }
  }
}
