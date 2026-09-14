/**
 * 行情数据源抽象。
 * 所有数据源都实现 DataProvider，技能层不关心数据来自哪里。
 * 新增数据源（Tushare、腾讯行情等）：实现本接口，在 index.ts 的 createProvider 里接线。
 */

export interface Quote {
  code: string;       // 6 位代码，如 600519
  name: string;       // 股票名称
  price: number;      // 最新价（元）
  changePct: number;  // 涨跌幅（%）
  prevClose: number;  // 昨收
  time?: string;      // 行情时间
}

export interface NewsItem {
  title: string;
  source?: string;
  url?: string;
  publishedAt?: string;
  summary?: string;
}

export interface Announcement {
  title: string;
  url?: string;
  publishedAt?: string;
}

export interface DataProvider {
  readonly name: string;
  getQuote(code: string): Promise<Quote>;
  getNews(code: string, limit?: number): Promise<NewsItem[]>;
  /** 个股公告（交易所正式披露）；东财直连无此能力，仅微服务模式提供 */
  getAnnouncements?(code: string, limit?: number): Promise<Announcement[]>;
  /** 按关键词搜索股票（名称/代码），返回候选代码列表 */
  search?(keyword: string): Promise<{ code: string; name: string }[]>;
}
