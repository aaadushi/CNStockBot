/**
 * 渠道抽象：每种聊天入口（WebChat、飞书、钉钉……）实现 Channel。
 * 参考 CloddsBot 的 src/channels/，但只保留最小接口。
 */
import type { Agent } from '../agent/loop.js';

export interface Channel {
  readonly name: string;
  /** 挂载到 Express 应用（注册路由/中间件） */
  mount(app: import('express').Express, agent: Agent): void;
  /** 主动向用户推送消息（定时提醒用）。无法推送的渠道可存到收件箱等待拉取。 */
  notify(userId: string, text: string): Promise<void>;
}
