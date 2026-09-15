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
  open?: number;      // 今开（部分数据源不提供）
  high?: number;      // 最高（部分数据源不提供）
  low?: number;       // 最低（部分数据源不提供）
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

/** 单期财报摘要；数值为带单位的中文格式字符串（如 "999,862,000.00元"），未做数值清洗 */
export interface FinancialReport {
  period: string;           // 报告期截止日期，如 2025-06-30
  revenue?: string;         // 营业总收入
  netProfit?: string;       // 净利润（新版数据源为归母净利润）
  netAssets?: string;       // 股东权益合计（净资产）；akshare ≥1.18.94 宽表提供
  roe?: string;             // 净资产收益率（%）；akshare ≥1.18.94 宽表提供
  eps?: string;             // 基本每股收益；akshare ≥1.18.94 宽表提供
  netAssetsPerShare?: string;  // 每股净资产
  cashFlowPerShare?: string;   // 每股现金流
  // 以下三个仅旧版 akshare（长表）提供，新版宽表无此指标，保留字段以兼容旧部署
  totalAssets?: string;     // 资产总计
  longTermDebt?: string;    // 长期负债合计
  financeCost?: string;     // 财务费用
}

/** 历史日 K 线（前复权），按日期升序 */
export interface HistoryBar {
  date: string;      // YYYY-MM-DD
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;    // 成交量（手）
  changePct: number; // 涨跌幅 %
}

export interface DataProvider {
  readonly name: string;
  getQuote(code: string): Promise<Quote>;
  getNews(code: string, limit?: number): Promise<NewsItem[]>;
  /** 大盘指数行情；secid 需调用方显式给出（指数与个股 secid 规则不同，见 PITFALLS 东财条目） */
  getIndexQuote?(secid: string): Promise<Quote>;
  /** 个股公告（交易所正式披露）；东财直连无此能力，仅微服务模式提供 */
  getAnnouncements?(code: string, limit?: number): Promise<Announcement[]>;
  /** 财报摘要（按报告期倒序）；东财直连无此能力，仅微服务模式提供 */
  getFinancials?(code: string, limit?: number): Promise<FinancialReport[]>;
  /** 历史日 K 线（前复权，日期升序）；东财直连无此能力，仅微服务模式提供 */
  getHistory?(code: string, days?: number): Promise<HistoryBar[]>;
  /** 按关键词搜索股票（名称/代码），返回候选代码列表 */
  search?(keyword: string): Promise<{ code: string; name: string }[]>;
}
