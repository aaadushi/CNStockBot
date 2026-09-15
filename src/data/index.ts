/**
 * 组合数据源：行情走东财直连（免 key、实时），**东财失败时自动降级腾讯行情**
 * （防东财 IP 限流导致行情全挂，2026-09-15 加）；
 * 新闻/公告走 Python AKShare 微服务（如果已启动，否则给出友好提示）。
 * DATA_PROVIDER=python 时全部走微服务。
 */
import { config } from '../config.js';
import { EastmoneyProvider } from './eastmoney.js';
import { TencentProvider } from './tencent.js';
import { PythonServiceProvider } from './pythonService.js';
import type { Announcement, CompanyProfile, DataProvider, EtfQuote, FinancialReport, FundFlow, FundInfo, FundRankItem, FundSearchItem, HistoryBar, Intraday, MarketMovers, MarketNewsItem, NewsItem, NewsSort, Quote } from './provider.js';

class CompositeProvider implements DataProvider {
  readonly name = 'composite(eastmoney+python)';
  private quote = new EastmoneyProvider();
  private fallback = new TencentProvider();
  private python = new PythonServiceProvider();

  /** 行情：东财优先，失败（限流/接口变更等）自动降级腾讯，降级有日志 */
  async getQuote(code: string): Promise<Quote> {
    try {
      return await this.quote.getQuote(code);
    } catch (err) {
      console.warn('[data] 东财行情失败，降级腾讯行情:', err instanceof Error ? err.message : err);
      return this.fallback.getQuote(code);
    }
  }

  /** 指数行情：东财直连优先（secid 由技能层显式给出），失败降级腾讯 */
  async getIndexQuote(secid: string): Promise<Quote> {
    try {
      return await this.quote.getIndexQuote(secid);
    } catch (err) {
      console.warn('[data] 东财指数行情失败，降级腾讯行情:', err instanceof Error ? err.message : err);
      return this.fallback.getIndexQuote(secid);
    }
  }

  async getNews(code: string, limit = 10, sort: NewsSort = 'hot'): Promise<NewsItem[]> {
    try {
      return await this.python.getNews(code, limit, sort);
    } catch (err) {
      throw new Error(
        `新闻数据不可用：${err instanceof Error ? err.message : String(err)}\n` +
          '提示：进入 data-service 目录运行 `pip install -r requirements.txt && uvicorn main:app` 启动数据微服务。',
      );
    }
  }

  /** 公告只能走微服务（巨潮资讯），未启动时给出带启动提示的错误 */
  async getAnnouncements(code: string, limit = 10): Promise<Announcement[]> {
    try {
      return await this.python.getAnnouncements(code, limit);
    } catch (err) {
      throw new Error(
        `公告数据不可用：${err instanceof Error ? err.message : String(err)}\n` +
          '提示：进入 data-service 目录运行 `pip install -r requirements.txt && uvicorn main:app` 启动数据微服务。',
      );
    }
  }

  /** 财报只能走微服务（新浪财务摘要），未启动时给出带启动提示的错误 */
  async getFinancials(code: string, limit = 4): Promise<FinancialReport[]> {
    try {
      return await this.python.getFinancials(code, limit);
    } catch (err) {
      throw new Error(
        `财报数据不可用：${err instanceof Error ? err.message : String(err)}\n` +
          '提示：进入 data-service 目录运行 `pip install -r requirements.txt && uvicorn main:app` 启动数据微服务。',
      );
    }
  }

  /** 历史 K 线只能走微服务（东财历史行情，AKShare 封装），未启动时给出带启动提示的错误 */
  async getHistory(code: string, days = 120): Promise<HistoryBar[]> {
    try {
      return await this.python.getHistory(code, days);
    } catch (err) {
      throw new Error(
        `历史行情数据不可用：${err instanceof Error ? err.message : String(err)}\n` +
          '提示：进入 data-service 目录运行 `pip install -r requirements.txt && uvicorn main:app` 启动数据微服务。',
      );
    }
  }

  /** 公司资料只能走微服务（东财个股资料，AKShare 封装 + push2delay 降级），未启动时给出带启动提示的错误 */
  async getProfile(code: string): Promise<CompanyProfile> {
    try {
      return await this.python.getProfile(code);
    } catch (err) {
      throw new Error(
        `公司资料不可用：${err instanceof Error ? err.message : String(err)}\n` +
          '提示：进入 data-service 目录运行 `pip install -r requirements.txt && uvicorn main:app` 启动数据微服务。',
      );
    }
  }

  /** 个股资金流只能走微服务（东财个股资金流 + 新浪降级，F3-4），未启动时给出带启动提示的错误 */
  async getFundFlow(code: string, days = 30): Promise<FundFlow> {
    try {
      return await this.python.getFundFlow(code, days);
    } catch (err) {
      throw new Error(
        `资金流数据不可用：${err instanceof Error ? err.message : String(err)}\n` +
          '提示：进入 data-service 目录运行 `pip install -r requirements.txt && uvicorn main:app` 启动数据微服务。',
      );
    }
  }

  /** 个股分时只能走微服务（东财分钟 K + 新浪降级，F3-5），未启动时给出带启动提示的错误 */
  async getIntraday(code: string): Promise<Intraday> {
    try {
      return await this.python.getIntraday(code);
    } catch (err) {
      throw new Error(
        `分时数据不可用：${err instanceof Error ? err.message : String(err)}\n` +
          '提示：进入 data-service 目录运行 `pip install -r requirements.txt && uvicorn main:app` 启动数据微服务。',
      );
    }
  }

  /** 全市场涨跌榜：走东财 clist（内部 push2 → push2delay 宿主降级 + 60s 缓存）。
   *  腾讯无对应榜单接口，故不走腾讯降级；不依赖 data-service。 */
  async getMovers(limit = 50): Promise<MarketMovers> {
    return this.quote.getMovers(limit);
  }

  /** 全市场财经快讯只能走微服务（东财全球快讯/财联社降级），未启动时给出带启动提示的错误 */
  async getMarketNews(limit = 20): Promise<MarketNewsItem[]> {
    try {
      return await this.python.getMarketNews(limit);
    } catch (err) {
      throw new Error(
        `财经快讯数据不可用：${err instanceof Error ? err.message : String(err)}\n` +
          '提示：进入 data-service 目录运行 `pip install -r requirements.txt && uvicorn main:app` 启动数据微服务。',
      );
    }
  }

  /** 搜索优先走 Python 微服务（全量代码表，匹配更准）；未启动时降级到东财搜索建议接口 */
  async search(keyword: string): Promise<{ code: string; name: string }[]> {
    try {
      return await this.python.search(keyword);
    } catch (err) {
      // 降级必须留痕，否则微服务挂掉后故障不可观测（审计 A-308）
      console.warn('[data] python 搜索失败，降级东财 suggest:', err instanceof Error ? err.message : err);
      return this.quote.search(keyword);
    }
  }

  /** 基金版块（F4-B）只能走微服务（天天基金/东财 ETF，AKShare 封装），未启动时给出带启动提示的错误 */
  private fundUnavailable(err: unknown): Error {
    return new Error(
      `基金数据不可用：${err instanceof Error ? err.message : String(err)}\n` +
        '提示：进入 data-service 目录运行 `pip install -r requirements.txt && uvicorn main:app` 启动数据微服务。',
    );
  }

  async getFundRank(type = '全部', limit = 50): Promise<FundRankItem[]> {
    try {
      return await this.python.getFundRank(type, limit);
    } catch (err) {
      throw this.fundUnavailable(err);
    }
  }

  async getFundInfo(code: string, days = 250): Promise<FundInfo> {
    try {
      return await this.python.getFundInfo(code, days);
    } catch (err) {
      throw this.fundUnavailable(err);
    }
  }

  async searchFunds(keyword: string, limit = 10): Promise<FundSearchItem[]> {
    try {
      return await this.python.searchFunds(keyword, limit);
    } catch (err) {
      throw this.fundUnavailable(err);
    }
  }

  async getEtfRank(limit = 50): Promise<EtfQuote[]> {
    try {
      return await this.python.getEtfRank(limit);
    } catch (err) {
      throw this.fundUnavailable(err);
    }
  }
}

export function createProvider(): DataProvider {
  if (config.dataProvider === 'python') return new PythonServiceProvider();
  return new CompositeProvider();
}
