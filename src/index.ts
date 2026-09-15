/**
 * 入口：装配所有模块并启动 HTTP 服务。
 * 结构参考 CloddsBot 的 gateway 模式，但只保留信息查询所需的最小集合。
 */
import express from 'express';
import { config } from './config.js';
import { Store } from './storage/store.js';
import { createProvider } from './data/index.js';
import { Agent } from './agent/loop.js';
import { WebChatChannel } from './channels/webchat.js';
import { FeishuChannel } from './channels/feishu.js';
import { startScheduler } from './alerts/scheduler.js';
import { getHealthProbeStatus, startHealthProbe } from './alerts/healthProbe.js';
import { listSkills } from './skills/registry.js';
import type { Channel } from './channels/types.js';

const store = new Store();
const data = createProvider();
const agent = new Agent(store, data);

if (!config.llm.apiKey) {
  console.warn('⚠️  未配置 LLM_API_KEY：所有对话功能不可用（行情探针/日报推送不受影响）。请在 .env 中填入后重启。');
}

// 进程级兜底：渠道 handler 漏 catch 时不裸崩无迹（Express 4 不捕获 async 异常）（审计 A-502）
process.on('unhandledRejection', (err) => {
  console.error('[fatal] 未处理的 Promise 拒绝:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] 未捕获异常:', err);
});

const channels: Channel[] = [new WebChatChannel(store, data)];
if (config.feishu.enabled) channels.push(new FeishuChannel(store));

const app = express();
// verify 回调保留原始请求体，飞书事件验签（HMAC 对 raw body 计算）需要它
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    dataProvider: data.name,
    skills: listSkills().map((s) => s.name),
    quoteProbe: getHealthProbeStatus(),
  });
});

for (const ch of channels) ch.mount(app, agent);

// 兜底错误中间件（须注册在所有路由之后）：不向客户端泄露堆栈
app.use(((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[http] 请求处理异常:', err);
  res.status(500).json({ error: 'internal error' });
}) as express.ErrorRequestHandler);

startScheduler(store, data, channels);
if (config.healthProbe.enabled) startHealthProbe(store, data, channels);

const server = app.listen(config.port, () => {
  console.log(`✅ CNStockBot 已启动`);
  console.log(`   WebChat:  http://localhost:${config.port}/webchat`);
  console.log(`   健康检查: http://localhost:${config.port}/health`);
  console.log(`   数据源:   ${data.name} | 技能: ${listSkills().map((s) => s.name).join(', ')}`);
});

// 优雅退出：释放端口与 SQLite 连接（Windows 下句柄不释放会带来文件锁问题）
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n[index] 收到 ${sig}，正在退出…`);
    server.close();
    store.close();
    process.exit(0);
  });
}
