/**
 * WebChat 渠道：内置网页聊天界面。
 * - GET  /webchat           静态页面（public/webchat/index.html），不鉴权
 * - POST /api/chat          { userId, message } -> { reply }，需 Bearer 口令
 * - GET  /api/inbox?userId= 拉取离线通知（读后即删），需 Bearer 口令
 *
 * 鉴权：API 请求需带请求头 `Authorization: Bearer <ACCESS_TOKEN>`，
 * 口令来自 config.accessToken（.env 的 ACCESS_TOKEN，未配置时启动时随机生成并打印）。
 * 取舍说明：静态页面本身不鉴权——页面不含任何数据，真正的数据都在 API 后面，
 * 保护 API 即可；这样用户打开页面后能先看到界面再输入口令，体验更顺。
 *
 * 离线通知收件箱存 SQLite（store.inbox 表，2026-09-14 起），重启不丢。
 *
 * 已知限制（审计 A-601）：口令是共享口令，持口令者之间**无身份隔离**——
 * userId 由客户端自报，同口令持有者可读他人收件箱/以他人身份对话。
 * 自用单人口令场景可接受；多人共用前需做 S3-3 多用户体系。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Channel } from './types.js';
import type { Agent } from '../agent/loop.js';
import type { Store } from '../storage/store.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/channels/webchat.js -> 项目根/public/webchat
const WEB_ROOT = path.resolve(__dirname, '../../public/webchat');

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

  constructor(private store: Store) {}

  mount(app: express.Express, agent: Agent): void {
    app.use('/webchat', express.static(WEB_ROOT));

    // 只保护 /api/*，静态资源（/webchat）不鉴权
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
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.get('/api/inbox', (req, res) => {
      const userId = String(req.query.userId ?? '');
      res.json({ messages: this.store.drainInbox(userId) });
    });
  }

  async notify(userId: string, text: string): Promise<void> {
    this.store.pushInbox(userId, text);
  }
}
