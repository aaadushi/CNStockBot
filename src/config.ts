import 'dotenv/config';
import { randomBytes } from 'node:crypto';

/**
 * WebChat API 访问口令：优先读 .env 的 ACCESS_TOKEN；
 * 未配置时随机生成一个并打印到控制台（自用部署够用，重启后会变）。
 */
function resolveAccessToken(): string {
  const fromEnv = process.env.ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const generated = randomBytes(16).toString('hex');
  console.log('[config] 未配置 ACCESS_TOKEN，本次启动随机生成访问口令：', generated);
  console.log('[config] 如需固定口令，请在 .env 中设置 ACCESS_TOKEN');
  return generated;
}

export const config = {
  port: Number(process.env.PORT ?? 18790),

  /** WebChat API 鉴权口令（请求头 Authorization: Bearer <token>），静态页面不鉴权 */
  accessToken: resolveAccessToken(),

  /** OpenAI 兼容的 LLM 接口（DeepSeek / 通义千问 / Kimi / OpenAI 均可） */
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
  },

  /** 行情数据源：eastmoney = 内置直连东方财富公开接口；python = 本地 AKShare 微服务 */
  dataProvider: process.env.DATA_PROVIDER ?? 'eastmoney',
  pythonServiceUrl: process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000',

  dataDir: process.env.DATA_DIR ?? './data',

  /** 交易日历：true 时收盘日报/异动提醒跳过法定节假日（data-service 不可用时自动降级为只跳周末） */
  tradeCalendarEnabled: process.env.TRADE_CALENDAR_ENABLED !== 'false',

  /** 异动提醒：盘中轮询自选股，涨跌幅超阈值主动推送 */
  alerts: {
    enabled: process.env.ALERT_ENABLED !== 'false',
    thresholdPct: Number(process.env.ALERT_THRESHOLD_PCT ?? 5),
    intervalMinutes: Number(process.env.ALERT_INTERVAL_MINUTES ?? 5),
  },

  feishu: {
    enabled: process.env.ENABLE_FEISHU === 'true',
    appId: process.env.FEISHU_APP_ID ?? '',
    appSecret: process.env.FEISHU_APP_SECRET ?? '',
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? '',
    encryptKey: process.env.FEISHU_ENCRYPT_KEY ?? '',
  },
} as const;
