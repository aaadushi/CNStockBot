/**
 * WebChat 渠道：内置网页聊天界面。
 * - GET  /webchat           静态页面（public/webchat/index.html），不鉴权
 * - POST /api/chat          { userId, message } -> { reply }，需 Bearer 口令
 * - GET  /api/inbox?userId= 拉取离线通知（定时推送的消息暂存在这里），需 Bearer 口令
 *
 * 鉴权：API 请求需带请求头 `Authorization: Bearer <ACCESS_TOKEN>`，
 * 口令来自 config.accessToken（.env 的 ACCESS_TOKEN，未配置时启动时随机生成并打印）。
 * 取舍说明：静态页面本身不鉴权——页面不含任何数据，真正的数据都在 API 后面，
 * 保护 API 即可；这样用户打开页面后能先看到界面再输入口令，体验更顺。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Channel } from './types.js';
import type { Agent } from '../agent/loop.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/channels/webchat.js -> 项目根/public/webchat
const WEB_ROOT = path.resolve(__dirname, '../../public/webchat');

/** 校验 Authorization: Bearer <token>，失败返回 401 */
function requireAccessToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token !== config.accessToken) {
    res.status(401).json({ error: '未授权：请提供正确的访问口令' });
    return;
  }
  next();
}

export class WebChatChannel implements Channel {
  readonly name = 'webchat';
  private inbox = new Map<string, string[]>();

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
      const msgs = this.inbox.get(userId) ?? [];
      this.inbox.delete(userId);
      res.json({ messages: msgs });
    });
  }

  async notify(userId: string, text: string): Promise<void> {
    const list = this.inbox.get(userId) ?? [];
    list.push(text);
    this.inbox.set(userId, list);
  }
}
