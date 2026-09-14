/**
 * Python 数据微服务客户端（data-service/，基于 AKShare）。
 * 适合新闻、公告、财报等东财公开接口不便覆盖的数据。
 */
import { config } from '../config.js';
import type { Announcement, DataProvider, FinancialReport, NewsItem, Quote } from './provider.js';

export class PythonServiceProvider implements DataProvider {
  readonly name = 'python-akshare';
  private base = config.pythonServiceUrl;

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`数据服务请求失败 ${res.status}: ${body.slice(0, 200)}（请确认 data-service 已启动）`);
    }
    return (await res.json()) as T;
  }

  async getQuote(code: string): Promise<Quote> {
    return this.get<Quote>(`/quote/${code}`);
  }

  async getNews(code: string, limit = 10): Promise<NewsItem[]> {
    return this.get<NewsItem[]>(`/news/${code}?limit=${limit}`);
  }

  async getAnnouncements(code: string, limit = 10): Promise<Announcement[]> {
    return this.get<Announcement[]>(`/announcements/${code}?limit=${limit}`);
  }

  async getFinancials(code: string, limit = 4): Promise<FinancialReport[]> {
    return this.get<FinancialReport[]>(`/financials/${code}?limit=${limit}`);
  }

  async search(keyword: string): Promise<{ code: string; name: string }[]> {
    return this.get<{ code: string; name: string }[]>(`/search?keyword=${encodeURIComponent(keyword)}`);
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
      const res = await fetch(`${this.base}/trade-calendar?year=${year}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as string[];
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
