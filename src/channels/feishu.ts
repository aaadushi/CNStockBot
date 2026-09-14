/**
 * 飞书（Lark）机器人渠道 —— 骨架 / TODO。
 *
 * 接入步骤（参考 https://open.feishu.cn/document/server-docs/event-subscription-guide）：
 * 1. 在飞书开放平台创建企业自建应用，启用机器人能力，拿到 App ID / Secret。
 * 2. 事件订阅配置请求地址：https://<你的域名>/feishu/events
 * 3. 处理 url_verification 挑战（下方已实现）；接收 im.message.receive_v1 事件。
 * 4. 回复消息需先获取 tenant_access_token，再调 POST /open-apis/im/v1/messages?receive_id_type=chat_id。
 *
 * TODO：
 * - [ ] 校验请求签名（X-Lark-Signature）
 * - [ ] tenant_access_token 缓存与自动刷新
 * - [ ] notify() 主动推送（需要维护 userId -> chat_id 映射）
 * - [ ] 消息去重（飞书会重推事件）
 */
import { config } from '../config.js';
import type { Channel } from './types.js';
import type { Agent } from '../agent/loop.js';

interface FeishuEvent {
  challenge?: string;
  type?: string;
  header?: { event_type?: string };
  event?: {
    sender?: { sender_id?: { open_id?: string } };
    message?: { message_id?: string; chat_id?: string; content?: string };
  };
}

export class FeishuChannel implements Channel {
  readonly name = 'feishu';

  mount(app: import('express').Express, agent: Agent): void {
    app.post('/feishu/events', async (req, res) => {
      const body = req.body as FeishuEvent;

      // URL 验证挑战
      if (body.type === 'url_verification' && body.challenge) {
        res.json({ challenge: body.challenge });
        return;
      }

      if (body.header?.event_type === 'im.message.receive_v1') {
        const openId = body.event?.sender?.sender_id?.open_id ?? 'unknown';
        try {
          const content = JSON.parse(body.event?.message?.content ?? '{}') as { text?: string };
          const reply = await agent.handleMessage(`feishu:${openId}`, content.text ?? '');
          // TODO: 调用飞书 API 把 reply 发回 chat_id
          console.log(`[feishu] 待回复 ${body.event?.message?.chat_id}: ${reply}`);
        } catch (err) {
          console.error('[feishu] 处理消息失败:', err);
        }
        res.json({ ok: true }); // 立即 200，避免飞书重推
        return;
      }

      res.json({ ok: true });
    });
  }

  async notify(_userId: string, _text: string): Promise<void> {
    // TODO: 通过飞书 API 主动推送，需要 config.feishu.appId/appSecret 换取 token
    if (!config.feishu.appId) return;
    console.warn('[feishu] notify 尚未实现');
  }
}
