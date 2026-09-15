/**
 * WebChat 渠道：内置网页聊天界面 + 股票浏览页 API。
 * - GET  /webchat                 聊天静态页面（public/webchat/index.html），不鉴权
 * - GET  /stocks                  股票浏览静态页面（public/stocks/），不鉴权
 * - GET  /shared                  前端共享静态资源（public/shared/），不鉴权
 * - POST /api/chat                { userId, message } -> { reply }
 * - GET  /api/inbox?userId=       拉取离线通知（读后即删）
 * - GET  /api/watchlist?userId=   自选股列表 + 批量行情（单只失败降级为 {code, error}）
 * - POST /api/watchlist           { userId, code } -> { ok, added }
 * - DELETE /api/watchlist         { userId, code } -> { ok, removed }
 * - GET  /api/stocks/:code        个股详情聚合（行情/新闻/公告/财报，各板块独立降级）
 * - GET  /api/stocks/:code/news?sort=hot|time  单块新闻（浏览页排序切换用）
 * - GET  /api/stocks/:code/history?days=  历史 K 线（需 data-service 提供 getHistory）
 * - GET  /api/search?keyword=     股票搜索（薄封装 provider.search，上限 20 条）
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
    app.use('/shared', express.static(SHARED_ROOT));

    // 只保护 /api/*，静态资源（/webchat、/stocks、/shared）不鉴权
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

    // 个股详情聚合：行情/新闻/公告/财报四块并发，任一失败只影响自己那块（xxxError + null）
    app.get('/api/stocks/:code', async (req, res) => {
      const code = req.params.code;
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'code 必须是 6 位数字' });
        return;
      }
      const unsupported = (what: string) =>
        Promise.reject(new Error(`数据源不支持${what}（东财直连无此能力，请启动 data-service）`));
      const [quote, news, announcements, financials] = await Promise.allSettled([
        this.data.getQuote(code),
        this.data.getNews(code, 10),
        this.data.getAnnouncements ? this.data.getAnnouncements(code, 10) : unsupported('公告'),
        this.data.getFinancials ? this.data.getFinancials(code, 4) : unsupported('财报'),
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
  }

  async notify(userId: string, text: string): Promise<void> {
    this.store.pushInbox(userId, text);
  }
}
