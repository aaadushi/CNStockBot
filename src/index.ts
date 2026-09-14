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
import { listSkills } from './skills/registry.js';
import type { Channel } from './channels/types.js';

const store = new Store();
const data = createProvider();
const agent = new Agent(store, data);

const channels: Channel[] = [new WebChatChannel()];
if (config.feishu.enabled) channels.push(new FeishuChannel());

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
  res.json({ ok: true, dataProvider: data.name, skills: listSkills().map((s) => s.name) });
});

for (const ch of channels) ch.mount(app, agent);

startScheduler(store, data, channels);

app.listen(config.port, () => {
  console.log(`✅ CNStockBot 已启动`);
  console.log(`   WebChat:  http://localhost:${config.port}/webchat`);
  console.log(`   健康检查: http://localhost:${config.port}/health`);
  console.log(`   数据源:   ${data.name} | 技能: ${listSkills().map((s) => s.name).join(', ')}`);
});
