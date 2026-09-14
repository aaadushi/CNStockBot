import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 18790),

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

  feishu: {
    enabled: process.env.ENABLE_FEISHU === 'true',
    appId: process.env.FEISHU_APP_ID ?? '',
    appSecret: process.env.FEISHU_APP_SECRET ?? '',
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? '',
  },
} as const;
