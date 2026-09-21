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

/**
 * 数值型环境变量解析：非有限数字（NaN/Infinity）或低于 min 时回退默认值并打警告。
 * 防误配导致 setTimeout(0) 热循环、比较恒 false 静默失效等（审计 A-501/A-405）。
 */
function numEnv(name: string, def: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    console.warn(`[config] ${name}="${raw}" 不是有效数值（要求 >= ${min}），回退默认值 ${def}`);
    return def;
  }
  return n;
}

export const config = {
  port: numEnv('PORT', 18790, 1),

  /** WebChat API 鉴权口令（请求头 Authorization: Bearer <token>），静态页面不鉴权 */
  accessToken: resolveAccessToken(),

  /** OpenAI 兼容的 LLM 接口（DeepSeek / 通义千问 / Kimi / OpenAI 均可） */
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
    /** 单次 LLM 请求超时（毫秒），防对端半挂导致对话永久卡死 */
    timeoutMs: numEnv('LLM_TIMEOUT_MS', 60_000, 1000),
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
    thresholdPct: numEnv('ALERT_THRESHOLD_PCT', 5, 0.1),
    intervalMinutes: numEnv('ALERT_INTERVAL_MINUTES', 5, 1),
  },

  /** 收盘日报：true 时日报附加自选股技术面信号摘要（F5-3，复用 F5-1 /indicators 端点，需 data-service） */
  dailyReport: {
    signals: process.env.DAILY_REPORT_SIGNALS !== 'false',
  },

  /** 盘前外盘推送（F6-4，可选）：true 时交易日约 9:10（北京时间）推送隔夜外盘摘要，
   *  需 data-service 运行；默认关闭 */
  overseasPush: {
    enabled: process.env.OVERSEAS_PUSH_ENABLED === 'true',
  },

  /** 行情健康探针：定时探测常青股票，连续失败即判定行情链路故障并告警 */
  healthProbe: {
    enabled: process.env.HEALTH_PROBE_ENABLED !== 'false',
    intervalMinutes: numEnv('HEALTH_PROBE_INTERVAL_MINUTES', 30, 1),
    code: process.env.HEALTH_PROBE_CODE ?? '600519',
  },

  feishu: {
    enabled: process.env.ENABLE_FEISHU === 'true',
    appId: process.env.FEISHU_APP_ID ?? '',
    appSecret: process.env.FEISHU_APP_SECRET ?? '',
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? '',
    encryptKey: process.env.FEISHU_ENCRYPT_KEY ?? '',
  },
} as const;
