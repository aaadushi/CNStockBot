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
  // —— 成交活跃度（F3-3，2026-09-15；东财/腾讯均提供，停牌股可能缺失）——
  volume?: number;      // 成交量（手）
  amount?: number;      // 成交额（元）
  turnover?: number;    // 换手率（%）
  volumeRatio?: number; // 量比
  // —— 涨跌停与 52 周高低（F3-6，2026-09-16；腾讯无 52 周字段，降级时缺失）——
  limitUp?: number;    // 涨停价（元）
  limitDown?: number;  // 跌停价（元）
  week52High?: number; // 52 周最高（元）
  week52Low?: number;  // 52 周最低（元）
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
  amount?: number;   // 成交额（元）；仅东财源提供（F3-3），新浪降级源无此列
  turnover?: number; // 换手率（%）；仅东财源提供（F3-3）
}

/** 公司资料（F3-2）：近静态信息，字段缺失（停牌/退市）时为 undefined 而非 0 */
export interface CompanyProfile {
  code: string;
  name?: string;        // 股票简称
  industry?: string;    // 所属行业（东财行业分类，如 "白酒Ⅱ"）
  listingDate?: string; // 上市日期 YYYY-MM-DD
  totalShares?: number; // 总股本（股）
  floatShares?: number; // 流通股（股）
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

// ---- 资金流向（F3-4，2026-09-15 新增；仅微服务模式提供） ----

/** 单日资金流向。金额为元、占比为 %；字段缺失为 null 而非 0 */
export interface FundFlowDay {
  date: string;                      // YYYY-MM-DD
  close: number | null;              // 收盘价
  changePct: number | null;          // 涨跌幅 %
  mainNetInflow: number | null;      // 主力净流入（元）；新浪降级源为"净流入"（含全部资金，口径不同）
  mainNetInflowPct: number | null;   // 主力净流入占比（%）
  superLargeNetInflow: number | null;    // 超大单净流入（元）
  superLargeNetInflowPct: number | null; // 超大单净流入占比（%）
  largeNetInflow?: number | null;    // 大单净流入（元），仅东财源提供
  mediumNetInflow?: number | null;   // 中单净流入（元），仅东财源提供
  smallNetInflow?: number | null;    // 小单净流入（元），仅东财源提供
}

/** 个股资金流向；source 标注口径：eastmoney=东财五档，sina=新浪两档（降级源，口径不同） */
export interface FundFlow {
  code: string;
  source: 'eastmoney' | 'sina';
  items: FundFlowDay[]; // 日期升序
}

// ---- 分时数据（F3-5，2026-09-16 新增；仅微服务模式提供） ----

/** 分时数据点（1 分钟线）；amount/avgPrice 仅数据源提供成交额列时存在 */
export interface IntradayPoint {
  time: string;      // HH:MM（北京时间）
  price: number;     // 该分钟收盘价（元）
  volume: number;    // 成交量（手，新浪源已 ÷100 归一）
  amount?: number;   // 成交额（元）
  avgPrice?: number; // 分时均价（VWAP = 累计成交额/累计成交量，元）
}

/** 个股分时（最近一个交易日）；source 标注口径：eastmoney=东财分钟 K，sina=新浪降级源 */
export interface Intraday {
  code: string;
  date: string;      // 数据所属交易日 YYYY-MM-DD
  source: 'eastmoney' | 'sina';
  points: IntradayPoint[]; // 时间升序
}

// ---- 分红送配（F3-6，2026-09-16 新增；仅微服务模式提供） ----

/** 单次分红送配记录（按公告日期倒序）；日期缺失为 undefined 而非占位串 */
export interface DividendRecord {
  announceDate?: string; // 公告日期 YYYY-MM-DD
  exDate?: string;       // 除权除息日 YYYY-MM-DD
  recordDate?: string;   // 股权登记日 YYYY-MM-DD
  dividend?: number;     // 派息（每 10 股，元，税前）
  bonus?: number;        // 送股（每 10 股，股）
  transfer?: number;     // 转增（每 10 股，股）
  progress?: string;     // 方案进度，如 预案/实施
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

// ---- 技术指标（F5-1，2026-09-16 新增；仅微服务模式提供） ----

/** MA 均线族（周期不足为 null） */
export interface MaValues {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
}

/** MACD：DIF=EMA12-EMA26，DEA=DIF 的 EMA9，macd=2×(DIF-DEA)（国内软件柱值惯例） */
export interface MacdValues {
  dif: number | null;
  dea: number | null;
  macd: number | null;
}

/** RSI（Wilder 平滑，周期不足为 null） */
export interface RsiValues {
  rsi6: number | null;
  rsi12: number | null;
  rsi24: number | null;
}

/** KDJ（9,3,3 递推平滑口径，周期不足为 null） */
export interface KdjValues {
  k: number | null;
  d: number | null;
  j: number | null;
}

/** 布林带（20,2，总体标准差口径，周期不足为 null） */
export interface BollValues {
  upper: number | null;
  mid: number | null;
  lower: number | null;
}

/** 客观技术信号（如 MA 金叉、RSI 超买）；仅状态描述，不含买卖建议（项目红线） */
export interface IndicatorSignal {
  type: string;
  text: string;
}

/** 关键价位：近 120 日分形高低点 3% 容差聚类，最新收盘下/上方最近各至多 2 档 */
export interface KeyLevels {
  support: number[];
  resistance: number[];
}

/** 技术指标汇总（F5-1）；source 标注日 K 数据源（与 /history 降级链一致：eastmoney/sina） */
export interface TechnicalIndicators {
  code: string;
  source: 'eastmoney' | 'sina';
  asOf: string; // 最后一根日 K 日期 YYYY-MM-DD
  latest: {
    close: number;
    ma: MaValues;
    ema: { ema12: number | null; ema26: number | null };
    macd: MacdValues;
    rsi: RsiValues;
    kdj: KdjValues;
    boll: BollValues;
  };
  keyLevels: KeyLevels;
  signals: IndicatorSignal[];
  /** 与 dates 对齐的 MA 序列（走势图叠加用）；前导不足周期为 null */
  series: {
    dates: string[];
    ma5: (number | null)[];
    ma10: (number | null)[];
    ma20: (number | null)[];
    ma60: (number | null)[];
  };
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
  /** 公司资料（行业/上市日期/股本，F3-2）；东财直连无此能力，仅微服务模式提供 */
  getProfile?(code: string): Promise<CompanyProfile>;
  /** 个股资金流向（主力/超大单净流入，F3-4）；东财直连无此能力，仅微服务模式提供 */
  getFundFlow?(code: string, days?: number): Promise<FundFlow>;
  /** 个股分时（1 分钟线，最近一个交易日，F3-5）；东财直连无此能力，仅微服务模式提供 */
  getIntraday?(code: string): Promise<Intraday>;
  /** 分红送配记录（按公告日期倒序，F3-6）；东财直连无此能力，仅微服务模式提供 */
  getDividends?(code: string, limit?: number): Promise<DividendRecord[]>;
  /** 技术指标（MA/EMA/MACD/RSI/KDJ/BOLL + 关键价位，F5-1）；东财直连无此能力，仅微服务模式提供 */
  getIndicators?(code: string, days?: number): Promise<TechnicalIndicators>;
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
