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
  // —— 估值与规模（F3-1，2026-09-15；东财/腾讯均提供，亏损股 PE 等可能缺失）——
  peTtm?: number;         // 市盈率（TTM）
  peDynamic?: number;     // 市盈率（动态）
  peStatic?: number;      // 市盈率（静态）
  pb?: number;            // 市净率
  totalMarketCap?: number; // 总市值（元）
  floatMarketCap?: number; // 流通市值（元）
}

export interface NewsItem {
  title: string;
  source?: string;
  url?: string;
  publishedAt?: string;
  summary?: string;
}

/** 全市场财经快讯（区别于个股 NewsItem）；publishTime 为 "YYYY-MM-DD HH:MM:SS"（北京时间） */
export interface MarketNewsItem {
  title: string;
  summary?: string;
  url?: string;        // 财联社降级源无链接，为空串/缺省
  publishTime: string;
  source: string;      // 数据源名称（东方财富 / 财联社）
}

/** 新闻排序：hot=数据源原始相关度/热度序（默认），time=发布时间倒序 */
export type NewsSort = 'hot' | 'time';

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

/** 涨跌榜条目（全市场涨跌浏览页用） */
export interface MoverItem {
  code: string;
  name: string;
  price: number;
  changePct: number; // 涨跌幅 %
}

/** 全市场今日涨跌：三个榜单 + 涨跌平家数统计（2026-09-15 新增，涨跌浏览页） */
export interface MarketMovers {
  up: MoverItem[];   // 涨幅榜（按涨跌幅降序）
  down: MoverItem[]; // 跌幅榜（按涨跌幅升序，即跌得多的在前）
  flat: MoverItem[]; // 平盘（涨跌幅恰为 0）
  upCount: number;   // 全市场上涨家数
  downCount: number;
  flatCount: number;
  time?: string;     // 数据生成时间（北京时间）
  delayed?: boolean; // true = 数据来自延时宿主（push2delay，约延时 15 分钟）
}

// ---- 基金版块（F4-B，2026-09-15 新增；全部仅微服务模式提供） ----

/** 开放式基金排行条目（天天基金数据源，按近1年收益率降序；新基金部分区间收益缺失为 null） */
export interface FundRankItem {
  code: string;
  name: string;
  date: string;              // 净值日期 YYYY-MM-DD
  unitNav: number | null;    // 单位净值
  accumNav: number | null;   // 累计净值
  dayPct: number | null;     // 日增长率 %
  week1: number | null;      // 近1周收益 %
  month1: number | null;     // 近1月收益 %
  month3: number | null;
  month6: number | null;
  year1: number | null;      // 近1年收益 %
  thisYear: number | null;   // 今年来收益 %
  sinceInception: number | null; // 成立来收益 %
  fee?: string;              // 手续费（如 "0.15%"）
}

/** 基金搜索结果条目 */
export interface FundSearchItem {
  code: string;
  name: string;
  type: string; // 基金类型，如 股票型 / 混合型-灵活
}

/** 基金单位净值数据点（日期升序） */
export interface FundNavPoint {
  date: string;           // YYYY-MM-DD
  nav: number | null;     // 单位净值
  changePct: number | null; // 日增长率 %
}

/** 单只开放式基金详情：名称/类型 + 单位净值走势 */
export interface FundInfo {
  code: string;
  name: string;
  type: string;
  latest: FundNavPoint | null;
  history: FundNavPoint[]; // 日期升序
}

/** 场内 ETF 实时行情条目（东财全量快照，按涨跌幅降序） */
export interface EtfQuote {
  code: string;
  name: string;
  price: number | null;        // 最新价
  changePct: number | null;    // 涨跌幅 %
  change: number | null;       // 涨跌额
  volume: number | null;       // 成交量（手）
  amount: number | null;       // 成交额（元）
  turnover: number | null;     // 换手率 %
  iopv: number | null;         // IOPV 实时估值
  discountRate: number | null; // 基金折价率 %
  time?: string;               // 更新时间
}

export interface DataProvider {
  readonly name: string;
  getQuote(code: string): Promise<Quote>;
  getNews(code: string, limit?: number, sort?: NewsSort): Promise<NewsItem[]>;
  /** 大盘指数行情；secid 需调用方显式给出（指数与个股 secid 规则不同，见 PITFALLS 东财条目） */
  getIndexQuote?(secid: string): Promise<Quote>;
  /** 个股公告（交易所正式披露）；东财直连无此能力，仅微服务模式提供 */
  getAnnouncements?(code: string, limit?: number): Promise<Announcement[]>;
  /** 财报摘要（按报告期倒序）；东财直连无此能力，仅微服务模式提供 */
  getFinancials?(code: string, limit?: number): Promise<FinancialReport[]>;
  /** 历史日 K 线（前复权，日期升序）；东财直连无此能力，仅微服务模式提供 */
  getHistory?(code: string, days?: number): Promise<HistoryBar[]>;
  /** 全市场今日涨跌榜（上涨/下跌/平盘 + 家数统计）；仅东财系接口提供 */
  getMovers?(limit?: number): Promise<MarketMovers>;
  /** 全市场财经快讯（区别于个股新闻）；东财直连无此能力，仅微服务模式提供 */
  getMarketNews?(limit?: number): Promise<MarketNewsItem[]>;
  /** 按关键词搜索股票（名称/代码），返回候选代码列表 */
  search?(keyword: string): Promise<{ code: string; name: string }[]>;
  /** 开放式基金排行（天天基金）；东财直连无此能力，仅微服务模式提供 */
  getFundRank?(type?: string, limit?: number): Promise<FundRankItem[]>;
  /** 单只开放式基金详情（名称/类型 + 单位净值走势）；仅微服务模式提供 */
  getFundInfo?(code: string, days?: number): Promise<FundInfo>;
  /** 基金搜索（名称/代码/拼音缩写）；仅微服务模式提供 */
  searchFunds?(keyword: string, limit?: number): Promise<FundSearchItem[]>;
  /** 场内 ETF 实时行情榜（按涨跌幅降序）；仅微服务模式提供 */
  getEtfRank?(limit?: number): Promise<EtfQuote[]>;
}
