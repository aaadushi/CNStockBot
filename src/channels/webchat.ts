/**
 * WebChat 渠道：内置网页聊天界面 + 股票浏览页 API。
 * 所有 /api/* 接口（除 /api/auth/*）需带 Authorization: Bearer <session-token>，
 * 由 S4-1 多用户体系在登录/注册后签发。静态页面本身不鉴权。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Channel } from './types.js';
import type { Agent } from '../agent/loop.js';
import type { Store } from '../storage/store.js';
import type { DataProvider, Quote, HistoryBar } from '../data/provider.js';
import { buildOverseasHints } from '../data/overseasHints.js';
import { createAuthRouter } from '../auth/routes.js';
import { requireSession } from '../auth/middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/channels/webchat.js -> 项目根/public/<子目录>（tsx dev 时 __dirname 是 src/channels，同样上溯两级）
const WEB_ROOT = path.resolve(__dirname, '../../public/webchat');
const STOCKS_ROOT = path.resolve(__dirname, '../../public/stocks');
const MARKET_ROOT = path.resolve(__dirname, '../../public/market');
const FUNDS_ROOT = path.resolve(__dirname, '../../public/funds');
const NEWS_ROOT = path.resolve(__dirname, '../../public/news');
const OVERSEAS_ROOT = path.resolve(__dirname, '../../public/overseas');
const SECTORS_ROOT = path.resolve(__dirname, '../../public/sectors');
const SCANNER_ROOT = path.resolve(__dirname, '../../public/scanner');
const BACKTEST_ROOT = path.resolve(__dirname, '../../public/backtest');
const SHARED_ROOT = path.resolve(__dirname, '../../public/shared');

/** 股票代码统一校验：6 位数字 */
const CODE_RE = /^\d{6}$/;
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
    app.use('/overseas', express.static(OVERSEAS_ROOT));
    app.use('/sectors', express.static(SECTORS_ROOT));
    app.use('/scanner', express.static(SCANNER_ROOT));
    app.use('/backtest', express.static(BACKTEST_ROOT));
    app.use('/shared', express.static(SHARED_ROOT));

    // 公开认证路由；之后所有 /api/* 都需要 session token（静态资源不在 /api 下，不鉴权）
    app.use('/api/auth', createAuthRouter(this.store.auth));
    app.use('/api', requireSession(this.store.auth));

    app.post('/api/chat', async (req, res) => {
      const { message } = req.body as { message?: string };
      if (!message) {
        res.status(400).json({ error: '需要 message 字段' });
        return;
      }
      try {
        const reply = await agent.handleMessage(req.user!.userId, message);
        res.json({ reply });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    app.get('/api/inbox', (req, res) => {
      res.json({ messages: this.store.drainInbox(req.user!.userId) });
    });

    // ---- 股票浏览页 API ----

    // 自选股列表 + 批量行情：单只失败（停牌/退市 getQuote 抛错，见 PITFALLS）不拖垮整列
    app.get('/api/watchlist', async (req, res) => {
      const codes = this.store.getWatchlist(req.user!.userId);
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
      const { code } = req.body as { code?: string };
      if (!code || !CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      const added = this.store.addToWatchlist(req.user!.userId, code);
      res.json({ ok: true, added });
    });

    app.delete('/api/watchlist', (req, res) => {
      const { code } = req.body as { code?: string };
      if (!code || !CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      const removed = this.store.removeFromWatchlist(req.user!.userId, code);
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

    // K 线形态识别 + 历史成绩单（F6-1）：依赖可选方法 getPatterns（仅 data-service 模式提供）。
    // 不进详情聚合块——前端独立拉取、失败只影响形态卡片（同 history/intraday/indicators 模式）。
    app.get('/api/stocks/:code/patterns', async (req, res) => {
      const code = req.params.code;
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      if (!this.data.getPatterns) {
        res
          .status(503)
          .json({ error: '形态识别需要 data-service（AKShare 微服务），请确认已启动' });
        return;
      }
      const parsed = Number.parseInt(String(req.query.days ?? ''), 10);
      const days = Number.isNaN(parsed) ? 750 : Math.min(1500, Math.max(30, parsed));
      try {
        res.json({ patterns: await this.data.getPatterns(code, days) });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 资金流验货（F6-2：近期形态信号 × 日级资金流交叉验证，分档结论）：依赖可选方法 getFlowVerify。
    // 不进详情聚合块——验货区由前端独立拉取、失败只影响自己（同 patterns 模式）。
    app.get('/api/stocks/:code/verify', async (req, res) => {
      const code = req.params.code;
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      if (!this.data.getFlowVerify) {
        res
          .status(503)
          .json({ error: '资金流验货需要 data-service（AKShare 微服务），请确认已启动' });
        return;
      }
      const parsed = Number.parseInt(String(req.query.days ?? ''), 10);
      const days = Number.isNaN(parsed) ? 750 : Math.min(1500, Math.max(30, parsed));
      try {
        res.json({ verify: await this.data.getFlowVerify(code, days) });
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

    // 隔夜外盘参考信息（F6-4）：依赖可选方法 getOverseasSummary（微服务 /overseas/summary）。
    // 响应在原始块结构上附加 hints（规则化客观方向提示，仅供参考，非买卖建议）。
    app.get('/api/overseas/summary', async (_req, res) => {
      if (!this.data.getOverseasSummary) {
        res
          .status(503)
          .json({ error: '外盘数据需要 data-service（AKShare 微服务），请确认已启动' });
        return;
      }
      try {
        const summary = await this.data.getOverseasSummary();
        res.json({ ...summary, hints: buildOverseasHints(summary) });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // ---- 板块轮动监控 API（F6-3，2026-09-19；全部依赖 data-service 微服务的可选方法） ----
    const noSectorService = (res: express.Response) =>
      res.status(503).json({ error: '板块数据需要 data-service（AKShare 微服务），请确认已启动' });
    const sectorName = (req: express.Request): string => String(req.query.name ?? '').trim();

    // 行业板块涨跌排行（涨跌幅降序）
    app.get('/api/sectors/rank', async (req, res) => {
      if (!this.data.getSectorRank) {
        noSectorService(res);
        return;
      }
      const parsed = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isNaN(parsed) ? 30 : Math.min(200, Math.max(1, parsed));
      try {
        res.json(await this.data.getSectorRank(limit));
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 行业板块资金流排行（今日主力净流入降序）
    app.get('/api/sectors/fund-flow', async (req, res) => {
      if (!this.data.getSectorFundFlow) {
        noSectorService(res);
        return;
      }
      const parsed = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isNaN(parsed) ? 30 : Math.min(200, Math.max(1, parsed));
      try {
        res.json(await this.data.getSectorFundFlow(limit));
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 板块成分股（涨跌幅降序）
    app.get('/api/sectors/cons', async (req, res) => {
      if (!this.data.getSectorCons) {
        noSectorService(res);
        return;
      }
      const name = sectorName(req);
      if (!name || name.length > 20) {
        res.status(400).json({ error: '需要 name 参数（板块名称或 BK 代码）' });
        return;
      }
      const parsed = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isNaN(parsed) ? 100 : Math.min(500, Math.max(1, parsed));
      try {
        res.json(await this.data.getSectorCons(name, limit));
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 板块日 K 走势（走势图数据源）
    app.get('/api/sectors/history', async (req, res) => {
      if (!this.data.getSectorHistory) {
        noSectorService(res);
        return;
      }
      const name = sectorName(req);
      if (!name || name.length > 20) {
        res.status(400).json({ error: '需要 name 参数（板块名称或 BK 代码）' });
        return;
      }
      const parsed = Number.parseInt(String(req.query.days ?? ''), 10);
      const days = Number.isNaN(parsed) ? 120 : Math.min(500, Math.max(1, parsed));
      try {
        res.json(await this.data.getSectorHistory(name, days));
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 个股→板块共振（所属行业在当日涨跌/资金流排行中的位置；未匹配返回 matched=false 而非报错）
    app.get('/api/sectors/of-stock/:code', async (req, res) => {
      if (!this.data.getSectorOfStock) {
        noSectorService(res);
        return;
      }
      const code = req.params.code;
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      try {
        res.json(await this.data.getSectorOfStock(code));
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // ---- 选股扫描 API（F5-5，2026-09-21；全部依赖 data-service 微服务的可选方法） ----
    const noScannerService = (res: express.Response) =>
      res.status(503).json({ error: '选股扫描需要 data-service（AKShare 微服务），请确认已启动' });

    // 预设扫描策略清单（前端 Tab 与技能描述共用）
    app.get('/api/scanner/strategies', async (_req, res) => {
      if (!this.data.getScanStrategies) {
        noScannerService(res);
        return;
      }
      try {
        res.json({ strategies: await this.data.getScanStrategies() });
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 执行全市场扫描（本地日 K 库 + 预设策略客观指标筛选，结果带 disclaimer）
    app.get('/api/scanner/scan', async (req, res) => {
      if (!this.data.runScan) {
        noScannerService(res);
        return;
      }
      const strategy = String(req.query.strategy ?? '').trim();
      if (!strategy || strategy.length > 30) {
        res.status(400).json({ error: '需要 strategy 参数（策略 key）' });
        return;
      }
      const parsed = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isNaN(parsed) ? 50 : Math.min(200, Math.max(1, parsed));
      try {
        res.json(await this.data.runScan(strategy, limit));
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 本地日 K 库状态（更新进度/覆盖票数/数据截至日期）
    app.get('/api/scanner/status', async (_req, res) => {
      if (!this.data.getMarketBarsStatus) {
        noScannerService(res);
        return;
      }
      try {
        res.json(await this.data.getMarketBarsStatus());
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });

    // 触发日 K 库更新（body {full?: boolean}；更新进行中时上游 409 原样透传错误文本）
    app.post('/api/scanner/update', async (req, res) => {
      if (!this.data.triggerMarketBarsUpdate) {
        noScannerService(res);
        return;
      }
      const full = (req.body as { full?: boolean })?.full === true;
      try {
        res.json(await this.data.triggerMarketBarsUpdate(full));
      } catch (err) {
        const msg = errText(err);
        res.status(msg.includes('409') ? 409 : 500).json({ error: msg });
      }
    });

    // ---- 策略回测 API（F5-6，2026-09-22；依赖 data-service 本地日 K 库） ----

    // 单股策略回测（历史信号回放：T+1/费用/滑点/止损，结果带 disclaimer——历史业绩不代表未来）
    app.get('/api/backtest', async (req, res) => {
      if (!this.data.runBacktest) {
        res.status(503).json({ error: '策略回测需要 data-service（AKShare 微服务），请确认已启动' });
        return;
      }
      const code = String(req.query.code ?? '').trim();
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      const strategy = String(req.query.strategy ?? '').trim() || undefined;
      if (strategy && strategy.length > 30) {
        res.status(400).json({ error: 'strategy 参数过长' });
        return;
      }
      const numParam = (raw: unknown): number | undefined => {
        const v = Number.parseInt(String(raw ?? ''), 10);
        return Number.isNaN(v) ? undefined : v;
      };
      try {
        res.json(await this.data.runBacktest(code, {
          strategy,
          holdDays: numParam(req.query.holdDays),
          stopLossPct: numParam(req.query.stopLossPct),
          days: numParam(req.query.days),
        }));
      } catch (err) {
        res.status(500).json({ error: errText(err) });
      }
    });
  }

  async notify(userId: string, text: string): Promise<void> {
    this.store.pushInbox(userId, text);
  }
}
