/**
 * 飞书（Lark）机器人渠道。
 *
 * 接入步骤（参考 https://open.feishu.cn/document/server-docs/event-subscription-guide）：
 * 1. 在飞书开放平台创建企业自建应用，启用机器人能力，拿到 App ID / Secret。
 * 2. 事件订阅配置请求地址：https://<你的域名>/feishu/events
 * 3. 环境变量：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_VERIFICATION_TOKEN /
 *    FEISHU_ENCRYPT_KEY（事件订阅里开启"加密策略"后必填，用于验签）。
 * 4. 机器人回复与主动推送都走 POST /open-apis/im/v1/messages?receive_id_type=chat_id，
 *    鉴权用 tenant_access_token（本文件内缓存 + 提前 2 分钟自动刷新）。
 *
 * 实现要点：
 * - 验签：X-Lark-Signature = HMAC-SHA256(key=ENCRYPT_KEY,
 *   msg= timestamp\nnonce\nENCRYPT_KEY\n原始请求体) 的 hex。需要原始请求体，
 *   由 index.ts 的 express.json({ verify }) 把 rawBody 挂到 req 上。
 * - 事件立即 200 再异步处理，避免飞书因超时重推（PITFALLS.md 渠道条目）。
 * - 消息按 message_id 去重（保留 10 分钟）；userId -> chat_id 映射从收到的消息学习，
 *   持久化到 Store 的 kv 表（2026-09-14 起，重启后免用户先发消息；内存 Map 作缓存）。
 */
import crypto from 'node:crypto';
import type { Express, Request } from 'express';
import { config } from '../config.js';
import type { Channel } from './types.js';
import type { Agent } from '../agent/loop.js';
import type { Store } from '../storage/store.js';

const FEISHU_API = 'https://open.feishu.cn';
const DEDUP_TTL_MS = 10 * 60 * 1000;

interface FeishuEvent {
  challenge?: string;
  type?: string;
  token?: string; // 旧版事件结构的 verification token
  header?: { event_type?: string; token?: string };
  event?: {
    sender?: { sender_id?: { open_id?: string } };
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string; // p2p=单聊，group=群聊
      message_type?: string;
      content?: string;
    };
  };
}

/** 取原始请求体（index.ts 的 express.json verify 回调挂载） */
function rawBodyOf(req: Request): string {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  return raw ? raw.toString('utf8') : JSON.stringify(req.body ?? {});
}

export class FeishuChannel implements Channel {
  readonly name = 'feishu';
  private token: { value: string; expiresAt: number } | null = null;
  /** openId -> chatId，从收到的消息学习；内存缓存，持久化在 Store kv 表 */
  private chatByOpenId = new Map<string, string>();
  /** messageId -> 处理时间戳，事件去重 */
  private seenMessages = new Map<string, number>();

  constructor(private store: Store) {}

  mount(app: Express, agent: Agent): void {
    // fail-closed：ENCRYPT_KEY 与 VERIFICATION_TOKEN 都未配置时事件接口完全无鉴权，
    // 任何人可伪造事件烧 LLM 额度——此时拒绝处理所有事件（审计 A-605）
    const noAuth = !config.feishu.encryptKey && !config.feishu.verificationToken;
    if (noAuth) {
      console.error(
        '[feishu] 未配置 FEISHU_ENCRYPT_KEY 和 FEISHU_VERIFICATION_TOKEN，' +
          '事件接口将拒绝所有请求（至少配置其一才处理事件）',
      );
    }

    app.post('/feishu/events', (req, res) => {
      const body = req.body as FeishuEvent;

      if (noAuth) {
        res.status(401).json({ error: 'feishu channel not configured' });
        return;
      }

      // URL 验证挑战（配置请求地址时飞书发的一次性请求）
      if (body.type === 'url_verification' && body.challenge) {
        res.json({ challenge: body.challenge });
        return;
      }

      // 验签（配置了 ENCRYPT_KEY 才启用；未配置则跳过并在启动时告警）
      if (!this.verifySignature(req)) {
        console.warn('[feishu] 验签失败，已丢弃事件');
        res.status(401).json({ error: 'invalid signature' });
        return;
      }

      // verification token 二次校验（旧版在 body.token，新版在 header.token）
      const expected = config.feishu.verificationToken;
      if (expected) {
        const got = body.header?.token ?? body.token ?? '';
        if (got !== expected) {
          console.warn('[feishu] verification token 不匹配，已丢弃事件');
          res.status(401).json({ error: 'invalid token' });
          return;
        }
      }

      res.json({ ok: true }); // 立即 200，避免飞书重推

      if (body.header?.event_type === 'im.message.receive_v1') {
        this.handleMessageEvent(body, agent).catch((err) =>
          console.error('[feishu] 处理消息失败:', err),
        );
      }
    });

    if (!config.feishu.encryptKey) {
      console.warn('[feishu] 未配置 FEISHU_ENCRYPT_KEY，事件验签已跳过（公网部署请务必配置）');
    }
  }

  /** 主动推送：userId 形如 "feishu:<openId>"，chat_id 从内存缓存或 Store kv 表取 */
  async notify(userId: string, text: string): Promise<void> {
    const openId = userId.replace(/^feishu:/, '');
    const chatId = this.chatByOpenId.get(openId) ?? this.store.getKv(`feishu:chat:${openId}`);
    if (!chatId) {
      console.warn(`[feishu] 无法推送 ${userId}：尚未记录其 chat_id（用户需先给机器人发一条消息）`);
      return;
    }
    await this.sendText(chatId, text);
  }

  private async handleMessageEvent(body: FeishuEvent, agent: Agent): Promise<void> {
    const msg = body.event?.message;
    const openId = body.event?.sender?.sender_id?.open_id;
    if (!msg?.message_id || !msg.chat_id || !openId) return;
    if (msg.message_type !== 'text') return; // 图片/富文本等暂不处理

    // 去重：飞书超时重推会带相同 message_id
    const now = Date.now();
    if (this.seenMessages.has(msg.message_id)) return;
    this.seenMessages.set(msg.message_id, now);
    for (const [id, ts] of this.seenMessages) {
      if (now - ts > DEDUP_TTL_MS) this.seenMessages.delete(id);
    }

    // 学习 userId -> chat_id 映射（内存缓存 + 落盘，重启后仍可主动推送）。
    // 只学单聊：群聊 @机器人 学到的群 chat_id 会让持仓日报推进群里，泄露持仓（审计 A-604）
    if (msg.chat_type === 'p2p') {
      this.chatByOpenId.set(openId, msg.chat_id);
      this.store.setKv(`feishu:chat:${openId}`, msg.chat_id);
    }

    let text: string;
    try {
      const content = JSON.parse(msg.content ?? '{}') as { text?: string };
      // 群聊 @机器人 时文本里带 @_user_1 占位符，去掉再喂给 Agent
      text = (content.text ?? '').replace(/@_user_\d+/g, '').trim();
    } catch {
      return; // content 不是合法 JSON，忽略
    }
    if (!text) return;

    const reply = await agent.handleMessage(`feishu:${openId}`, text);
    await this.sendText(msg.chat_id, reply);
  }

  /** X-Lark-Signature 验签 + 时间戳新鲜度校验（±5 分钟防重放，审计 A-603）；未配置 ENCRYPT_KEY 时直接放行 */
  private verifySignature(req: Request): boolean {
    const key = config.feishu.encryptKey;
    if (!key) return true;
    const timestamp = req.header('x-lark-request-timestamp') ?? '';
    const nonce = req.header('x-lark-request-nonce') ?? '';
    const signature = req.header('x-lark-signature') ?? '';
    if (!timestamp || !nonce || !signature) return false;
    // 时间戳太旧/太新的请求直接拒：被截获的合法签名不能无限期重放
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    const digest = crypto
      .createHmac('sha256', key)
      .update(`${timestamp}\n${nonce}\n${key}\n${rawBodyOf(req)}`)
      .digest('hex');
    // 长度不等时 timingSafeEqual 会抛错，先比较长度
    return signature.length === digest.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  }

  /** tenant_access_token：内存缓存，到期前 2 分钟自动刷新 */
  private async tenantToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const res = await fetch(`${FEISHU_API}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: config.feishu.appId,
        app_secret: config.feishu.appSecret,
      }),
    });
    const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`获取 tenant_access_token 失败: ${data.msg ?? res.status}`);
    }
    this.token = {
      value: data.tenant_access_token,
      expiresAt: Date.now() + ((data.expire ?? 7200) - 120) * 1000,
    };
    return this.token.value;
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    const token = await this.tenantToken();
    const res = await fetch(`${FEISHU_API}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });
    const data = (await res.json()) as { code?: number; msg?: string };
    if (data.code !== 0) {
      throw new Error(`飞书消息发送失败: ${data.msg ?? res.status}（chat_id=${chatId}）`);
    }
  }
}
