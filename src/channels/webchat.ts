/**
 * WebChat 渠道：内置网页聊天界面。
 * - GET  /webchat           静态页面（public/webchat/index.html）
 * - POST /api/chat          { userId, message } -> { reply }
 * - GET  /api/inbox?userId= 拉取离线通知（定时推送的消息暂存在这里）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Channel } from './types.js';
import type { Agent } from '../agent/loop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/channels/webchat.js -> 项目根/public/webchat
const WEB_ROOT = path.resolve(__dirname, '../../public/webchat');

export class WebChatChannel implements Channel {
  readonly name = 'webchat';
  private inbox = new Map<string, string[]>();

  mount(app: express.Express, agent: Agent): void {
    app.use('/webchat', express.static(WEB_ROOT));

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
