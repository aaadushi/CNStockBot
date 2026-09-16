/**
 * WebChat 渠道：内置网页聊天界面 + 股票浏览页 API。
 * - GET  /webchat                 聊天静态页面（public/webchat/index.html），不鉴权
 * - GET  /stocks                  股票浏览静态页面（public/stocks/），不鉴权
 * - GET  /market                  全市场涨跌榜静态页面（public/market/），不鉴权
 * - GET  /funds                   基金版块静态页面（public/funds/），不鉴权
 * - GET  /news                    财经快讯静态页面（public/news/），不鉴权
 * - GET  /shared                  前端共享静态资源（public/shared/），不鉴权
 * - POST /api/chat                { userId, message } -> { reply }
 * - GET  /api/inbox?userId=       拉取离线通知（读后即删）
 * - GET  /api/watchlist?userId=   自选股列表 + 批量行情（单只失败降级为 {code, error}）
 * - POST /api/watchlist           { userId, code } -> { ok, added }
 * - DELETE /api/watchlist         { userId, code } -> { ok, removed }
 * - GET  /api/stocks/:code        个股详情聚合（行情/新闻/公告/财报/公司资料/资金流/分红送配，各板块独立降级）
 * - GET  /api/stocks/:code/news?sort=hot|time  单块新闻（浏览页排序切换用）
 * - GET  /api/stocks/:code/history?days=  历史 K 线（需 data-service 提供 getHistory）
 * - GET  /api/stocks/:code/intraday       今日分时 1 分钟线（需 data-service 提供 getIntraday，F3-5）
 * - GET  /api/stocks/:code/indicators?days=  技术指标（需 data-service 提供 getIndicators，F5-1）
 * - GET  /api/market/movers?limit=  全市场今日涨跌榜（上涨/下跌/平盘 + 家数统计）
 * - GET  /api/market/news?limit=    全市场财经快讯（需 data-service 提供 getMarketNews）
 * - GET  /api/search?keyword=     股票搜索（薄封装 provider.search，上限 20 条）
 * - GET  /api/funds/rank?type=&limit=   开放式基金排行（需 data-service）
 * - GET  /api/funds/search?keyword=     基金搜索（名称/代码/拼音缩写，需 data-service）
 * - GET  /api/funds/etf?limit=          场内 ETF 实时行情榜（需 data-service）
 * - GET  /api/funds/:code?days=         单只基金详情 + 单位净值走势（需 data-service）
 *
 * 鉴权：所有 /api/* 请求需带请求头 `Authorization: Bearer <ACCESS_TOKEN>`，
 * 口令来自 config.accessToken（.env 的 ACCESS_TOKEN，未配置时启动时随机生成并打印）。
 * 取舍说明：静态页面本身不鉴权——页面不含任何数据，真正的数据都在 API 后面，
 * 保护 API 即可；这样用户打开页面后能先看到界面再输入口令，体验更顺。
 *
 * 离线通知收件箱存 SQLite（store.inbox 表，2026-09-14 起），重启不丢。
 *
 * 已知限制（审计 A-601）：口令是共享口令，持口令者之间**无身份隔离**——
 * userId 由客户端自报，同口令持有者可读他人收件箱/以他人身份对话/改他人自选股。
 * 自用单人口令场景可接受；多人共用前需做 S3-3 多用户体系。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Channel } from './types.js';
import type { Agent } from '../agent/loop.js';
import type { Store } from '../storage/store.js';
import type { DataProvider, Quote, HistoryBar } from '../data/provider.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/channels/webchat.js -> 项目根/public/<子目录>（tsx dev 时 __dirname 是 src/channels，同样上溯两级）
const WEB_ROOT = path.resolve(__dirname, '../../public/webchat');
const STOCKS_ROOT = path.resolve(__dirname, '../../public/stocks');
const MARKET_ROOT = path.resolve(__dirname, '../../public/market');
const FUNDS_ROOT = path.resolve(__dirname, '../../public/funds');
const NEWS_ROOT = path.resolve(__dirname, '../../public/news');
const SHARED_ROOT = path.resolve(__dirname, '../../public/shared');

/** 股票代码统一校验：6 位数字 */
const CODE_RE = /^\d{6}$/;

/** 取错误文本（中文错误信息约定：err.message 原样回前端） */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 从 Quote 里挑出浏览页契约字段（time/open/high/low/估值规模字段可选） */
function pickQuote(q: Quote) {
  return {
    code: q.code,
    name: q.name,
    price: q.price,
    changePct: q.changePct,
    prevClose: q.prevClose,
    open: q.open,
    high: q.high,
    low: q.low,
    peTtm: q.peTtm,
    peDynamic: q.peDynamic,
    peStatic: q.peStatic,
    pb: q.pb,
    totalMarketCap: q.totalMarketCap,
    floatMarketCap: q.floatMarketCap,
    volume: q.volume,
    amount: q.amount,
    turnover: q.turnover,
    volumeRatio: q.volumeRatio,
    limitUp: q.limitUp,
    limitDown: q.limitDown,
    week52High: q.week52High,
    week52Low: q.week52Low,
    time: q.time,
  };
}

/** 简单分批并发：每批 batchSize 个一起 await，避免一次性打满上游接口（东财限流见 PITFALLS） */
async function mapBatch<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(...(await Promise.all(items.slice(i, i + batchSize).map(fn))));
  }
  return out;
}

/** 校验 Authorization: Bearer <token>，失败返回 401。恒定时间比较防时序侧信道（审计 A-607） */
function requireAccessToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = Buffer.from(token);
  const b = Buffer.from(config.accessToken);
  if (!token || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: '未授权：请提供正确的访问口令' });
    return;
  }
  next();
}

export class WebChatChannel implements Channel {
  readonly name = 'webchat';

  constructor(
    private store: Store,
    private data: DataProvider,
  ) {}

  mount(app: express.Express, agent: Agent): void {
    app.use('/webchat', express.static(WEB_ROOT));
    app.use('/stocks', express.static(STOCKS_ROOT));
    app.use('/market', express.static(MARKET_ROOT));
    app.use('/funds', express.static(FUNDS_ROOT));
    app.use('/news', express.static(NEWS_ROOT));
    app.use('/shared', express.static(SHARED_ROOT));

    // 只保护 /api/*，静态资源（/webchat、/stocks、/market、/news、/shared）不鉴权
    app.use('/api', requireAccessToken);

    app.post('/api/chat', async (req, res) => {
      const { userId, message } = req.body as { userId?: string; message?: string };
      if (!userId || !message) {
        res.status(400).json({ error: '需要 userId 和 message 字段' });
        return;
      }
      try {
        const reply = await agent.handleMessage(userId, message);
        res.json({ reply });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    app.get('/api/inbox', (req, res) => {
      const userId = String(req.query.userId ?? '');
      res.json({ messages: this.store.drainInbox(userId) });
    });

    // ---- 股票浏览页 API ----

    // 自选股列表 + 批量行情：单只失败（停牌/退市 getQuote 抛错，见 PITFALLS）不拖垮整列
    app.get('/api/watchlist', async (req, res) => {
      const userId = String(req.query.userId ?? '');
      if (!userId) {
        res.status(400).json({ error: '需要 userId 参数' });
        return;
      }
      const codes = this.store.getWatchlist(userId);
      const stocks = await mapBatch(codes, 5, async (code) => {
        try {
          return pickQuote(await this.data.getQuote(code));
        } catch (err) {
          return { code, error: errText(err) };
        }
      });
      res.json({ stocks });
    });

    // 加入自选股：不预先校验股票是否存在（停牌股 getQuote 会抛错，会误杀合法代码），
    // 直接信任 store 的写入结果（INSERT OR IGNORE，重复加入返回 added=false）
    app.post('/api/watchlist', (req, res) => {
      const { userId, code } = req.body as { userId?: string; code?: string };
      if (!userId) {
        res.status(400).json({ error: '需要 userId 字段' });
        return;
      }
      if (!code || !CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      const added = this.store.addToWatchlist(userId, code);
      res.json({ ok: true, added });
    });

    app.delete('/api/watchlist', (req, res) => {
      const { userId, code } = req.body as { userId?: string; code?: string };
      if (!userId) {
        res.status(400).json({ error: '需要 userId 字段' });
        return;
      }
      if (!code || !CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      const removed = this.store.removeFromWatchlist(userId, code);
      res.json({ ok: true, removed });
    });

    // 个股详情聚合：行情/新闻/公告/财报/公司资料/资金流/分红送配七块并发，任一失败只影响自己那块（xxxError + null）
    app.get('/api/stocks/:code', async (req, res) => {
      const code = req.params.code;
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      const unsupported = (what: string) =>
        Promise.reject(new Error(`数据源不支持${what}（东财直连无此能力，请启动 data-service）`));
      const [quote, news, announcements, financials, profile, fundFlow, dividends] = await Promise.allSettled([
        this.data.getQuote(code),
        this.data.getNews(code, 10),
        this.data.getAnnouncements ? this.data.getAnnouncements(code, 10) : unsupported('公告'),
        this.data.getFinancials ? this.data.getFinancials(code, 4) : unsupported('财报'),
        this.data.getProfile ? this.data.getProfile(code) : unsupported('公司资料'),
        this.data.getFundFlow ? this.data.getFundFlow(code, 30) : unsupported('资金流'),
        this.data.getDividends ? this.data.getDividends(code, 10) : unsupported('分红送配'),
      ]);
      res.json({
        quote: quote.status === 'fulfilled' ? pickQuote(quote.value) : null,
        quoteError: quote.status === 'rejected' ? errText(quote.reason) : null,
        news: news.status === 'fulfilled' ? news.value : null,
        newsError: news.status === 'rejected' ? errText(news.reason) : null,
        announcements: announcements.status === 'fulfilled' ? announcements.value : null,
        announcementsError:
          announcements.status === 'rejected' ? errText(announcements.reason) : null,
        financials: financials.status === 'fulfilled' ? financials.value : null,
        financialsError: financials.status === 'rejected' ? errText(financials.reason) : null,
        profile: profile.status === 'fulfilled' ? profile.value : null,
        profileError: profile.status === 'rejected' ? errText(profile.reason) : null,
        fundFlow: fundFlow.status === 'fulfilled' ? fundFlow.value : null,
        fundFlowError: fundFlow.status === 'rejected' ? errText(fundFlow.reason) : null,
        dividends: dividends.status === 'fulfilled' ? dividends.value : null,
        dividendsError: dividends.status === 'rejected' ? errText(dividends.reason) : null,
      });
    });

    // 单块新闻（浏览页"热度/时间"排序切换用，避免重拉详情聚合四块）
    app.get('/api/stocks/:code/news', async (req, res) => {
      const code = req.params.code;
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      const sort = String(req.query.sort ?? 'hot');
      if (sort !== 'hot' && sort !== 'time') {
        res.status(400).json({ error: 'sort 只能是 hot 或 time' });
        return;
      }
      const parsed = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isNaN(parsed) ? 10 : Math.min(20, Math.max(1, parsed));
      try {
        res.json({ news: await this.data.getNews(code, limit, sort) });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 历史 K 线：依赖可选方法 getHistory（仅 data-service 模式提供）
    app.get('/api/stocks/:code/history', async (req, res) => {
      const code = req.params.code;
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      if (!this.data.getHistory) {
        res
          .status(503)
          .json({ error: '历史行情需要 data-service（AKShare 微服务），请确认已启动' });
        return;
      }
      const parsed = Number.parseInt(String(req.query.days ?? ''), 10);
      const days = Number.isNaN(parsed) ? 120 : Math.min(500, Math.max(1, parsed));
      try {
        const bars: HistoryBar[] = await this.data.getHistory(code, days);
        res.json({ bars });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 分时数据（今日 1 分钟线）：依赖可选方法 getIntraday（仅 data-service 模式提供）
    app.get('/api/stocks/:code/intraday', async (req, res) => {
      const code = req.params.code;
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      if (!this.data.getIntraday) {
        res.status(503).json({ error: '分时数据需要 data-service（AKShare 微服务），请确认已启动' });
        return;
      }
      try {
        res.json({ intraday: await this.data.getIntraday(code) });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 技术指标（MA/EMA/MACD/RSI/KDJ/BOLL + 关键价位 + 客观信号，F5-1）：依赖可选方法 getIndicators
    app.get('/api/stocks/:code/indicators', async (req, res) => {
      const code = req.params.code;
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      if (!this.data.getIndicators) {
        res
          .status(503)
          .json({ error: '技术指标需要 data-service（AKShare 微服务），请确认已启动' });
        return;
      }
      const parsed = Number.parseInt(String(req.query.days ?? ''), 10);
      const days = Number.isNaN(parsed) ? 250 : Math.min(1500, Math.max(1, parsed));
      try {
        res.json({ indicators: await this.data.getIndicators(code, days) });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 全市场涨跌榜（今日上涨/下跌/平盘）：依赖可选方法 getMovers（东财 clist，不依赖 data-service）
    app.get('/api/market/movers', async (req, res) => {
      if (!this.data.getMovers) {
        res.status(503).json({ error: '当前数据源不支持全市场涨跌榜' });
        return;
      }
      const parsed = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isNaN(parsed) ? 50 : Math.min(100, Math.max(1, parsed));
      try {
        res.json(await this.data.getMovers(limit));
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 全市场财经快讯：依赖可选方法 getMarketNews（微服务 /market-news，东财快讯/财联社降级）
    app.get('/api/market/news', async (req, res) => {
      if (!this.data.getMarketNews) {
        res
          .status(503)
          .json({ error: '财经快讯需要 data-service（AKShare 微服务），请确认已启动' });
        return;
      }
      const parsed = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isNaN(parsed) ? 20 : Math.min(50, Math.max(1, parsed));
      try {
        res.json({ news: await this.data.getMarketNews(limit) });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 股票搜索：薄封装 provider.search（可选方法），结果上限 20 条
    app.get('/api/search', async (req, res) => {
      const keyword = String(req.query.keyword ?? '').trim();
      if (!keyword) {
        res.status(400).json({ error: '需要 keyword 参数' });
        return;
      }
      if (!this.data.search) {
        res.status(503).json({ error: '搜索数据源不可用' });
        return;
      }
      try {
        const results = (await this.data.search(keyword)).slice(0, 20);
        res.json({ results });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // ---- 基金版块 API（F4-B，2026-09-15；全部依赖 data-service 微服务的可选方法） ----

    /** 与 data-service /funds/rank 白名单一致 */
    const FUND_TYPES = new Set(['全部', '股票型', '混合型', '债券型', '指数型', 'QDII', 'FOF']);
    const noFundService = (res: express.Response) =>
      res.status(503).json({ error: '基金数据需要 data-service（AKShare 微服务），请确认已启动' });

    // 开放式基金排行（天天基金，按近1年收益率降序）
    app.get('/api/funds/rank', async (req, res) => {
      if (!this.data.getFundRank) {
        noFundService(res);
        return;
      }
      const type = String(req.query.type ?? '全部');
      if (!FUND_TYPES.has(type)) {
        res.status(400).json({ error: 'type 只能是：全部/股票型/混合型/债券型/指数型/QDII/FOF' });
        return;
      }
      const parsed = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isNaN(parsed) ? 50 : Math.min(100, Math.max(1, parsed));
      try {
        res.json({ items: await this.data.getFundRank(type, limit) });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 基金搜索（名称/代码/拼音缩写），结果上限 20 条
    app.get('/api/funds/search', async (req, res) => {
      if (!this.data.searchFunds) {
        noFundService(res);
        return;
      }
      const keyword = String(req.query.keyword ?? '').trim();
      if (!keyword) {
        res.status(400).json({ error: '需要 keyword 参数' });
        return;
      }
      try {
        res.json({ results: await this.data.searchFunds(keyword, 20) });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 场内 ETF 实时行情榜（按涨跌幅降序）
    app.get('/api/funds/etf', async (req, res) => {
      if (!this.data.getEtfRank) {
        noFundService(res);
        return;
      }
      const parsed = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isNaN(parsed) ? 50 : Math.min(200, Math.max(1, parsed));
      try {
        res.json({ items: await this.data.getEtfRank(limit) });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 单只基金详情 + 单位净值走势（声明在 rank/search/etf 之后，Express 按注册顺序匹配）
    app.get('/api/funds/:code', async (req, res) => {
      if (!this.data.getFundInfo) {
        noFundService(res);
        return;
      }
      const code = req.params.code;
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      const parsed = Number.parseInt(String(req.query.days ?? ''), 10);
      const days = Number.isNaN(parsed) ? 260 : Math.min(1000, Math.max(1, parsed));
      try {
        res.json(await this.data.getFundInfo(code, days));
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });
  }

  async notify(userId: string, text: string): Promise<void> {
    this.store.pushInbox(userId, text);
  }
}
