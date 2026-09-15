# CLAUDE.md —— 开发交接文档

> 本文档面向下一个接手开发的 agent / 工程师。读完本文件即可了解项目的
> 目的、现状、约定和下一步该做什么。请保持本文件与代码同步更新。
>
> **docs/ 下的配套文档**（按建议阅读顺序）：
> 1. [docs/STATUS.md](docs/STATUS.md) —— 功能与问题清单：哪些已能用、哪些待做、当前痛点
> 2. [docs/FEATURES.md](docs/FEATURES.md) —— 功能实现手册：每个功能怎么实现的、代码在哪
> 3. [docs/PITFALLS.md](docs/PITFALLS.md) —— 技术坑病例库：动手前必扫，踩坑必回填
> 4. [docs/AUDIT.md](docs/AUDIT.md) —— 代码审计记录：审查发现的问题与修复备注（含审查进度表）
> 5. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) / [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) —— 架构原理与数据源细节
> 6. [docs/WORKFLOW.md](docs/WORKFLOW.md) —— **提交规范与版本管理：改动必须走分支 + PR，禁止直接推 main**

## 项目目的与定位

**CNStockBot 是一个 A 股（中国大陆股市）信息助手聊天机器人。**

目标用户：持有 A 股的个人投资者。核心价值：用户用自然语言告诉机器人自己买了哪些股票，
之后通过对话随时查询这些股票的实时行情、新闻、公告，并接收每日收盘推送。

灵感与架构来源：同目录下的 CloddsBot（AI 交易终端，面向加密货币/预测市场）。
**关键区别：本项目只做信息聚合，永不接入交易下单功能**（国内股票自动交易无合法个人接口，
且荐股/代客理财属持牌业务）。所有面向用户的个股分析输出必须带"仅供参考，不构成投资建议"。

## 技术栈与关键决策

| 决策 | 选择 | 原因 |
|---|---|---|
| 主服务 | TypeScript + Node.js 22.13+ + Express | 与 CloddsBot 一致；22.13 起 `node:sqlite` 免 flag |
| LLM | OpenAI 兼容协议，纯 fetch 实现（`src/llm/client.ts`） | DeepSeek/通义/Kimi/智谱都兼容，国内可直连，免 SDK 依赖 |
| 默认模型 | DeepSeek（`deepseek-chat`） | 国内直连、便宜、function calling 稳定 |
| 行情数据 | 东方财富公开接口直连（`src/data/eastmoney.ts`），失败自动降级腾讯行情（`src/data/tencent.ts`） | 免 key、实时；东财会 IP 限流，腾讯托底 |
| 新闻/公告数据 | Python 微服务 + AKShare（`data-service/`） | A 股免费数据生态在 Python 侧，包 HTTP 比 Node 逆向更稳 |
| 存储 | SQLite（`node:sqlite` 内置模块，`src/storage/store.ts`） | 免原生编译、零依赖；旧 JSON 自动迁移 |
| 调度 | 手写 setTimeout 调度器（`src/alerts/scheduler.ts`） | 收盘日报 + 异动提醒两个任务；任务再多换 node-cron |
| 会话历史 | SQLite 持久化，含工具调用上下文（`src/agent/loop.ts` 的 trimHistory 裁剪） | 同用户消息经 per-user 串行队列防并发覆盖 |

## 目录地图

```
src/
  index.ts            入口：装配 store/data/agent/channels/scheduler，起 Express
  config.ts           全部配置来自 .env，集中在此
  llm/client.ts       OpenAI 兼容 chat/completions + function calling 客户端
  agent/loop.ts       Agent 循环：消息 -> LLM -> 技能调用 -> 回复；含 SYSTEM_PROMPT
  skills/
    types.ts          Skill 接口 + SkillContext（userId/store/data）
    registry.ts       技能注册表：新技能必须在此 import 并加入数组（启动时检测重名）
    args.ts           技能参数校验助手：invalidCodeMessage / normalizeLimit
    bundled/<name>/   每个技能一个目录：SKILL.md（说明）+ index.ts（default export Skill）
  data/
    provider.ts       DataProvider 接口：getQuote / getNews / search
    eastmoney.ts      东财公开接口（行情）；secid 规则：沪市 6/900→"1."，深市 0/3 与北交所 4/8/920→"0."
    tencent.ts        腾讯行情（东财的自动降级备份；GBK 文本协议，价格不放大）
    pythonService.ts  AKShare 微服务客户端 + TradeCalendar（交易日历，按年缓存+格式校验）
    index.ts          createProvider()：默认组合（行情东财+腾讯降级 + 新闻微服务）
  storage/store.ts    SQLite 存储（node:sqlite）：自选股 + 会话历史（含工具上下文）+ 收件箱 + kv，按 userId 隔离
  channels/
    types.ts          Channel 接口：mount(app, agent) + notify(userId, text)
    webchat.ts        网页聊天 + 收件箱 + 股票浏览页 API（/api/watchlist、/api/stocks/:code、/api/search）
    feishu.ts         飞书渠道：验签(含防重放)/回复/主动推送，chat_id 映射 kv 持久化；默认不启用
  alerts/scheduler.ts 定时任务：收盘日报（15:30 北京时间）+ 盘中异动提醒（超阈值推送）
  alerts/healthProbe.ts 行情健康探针：定时探测常青股票，连续失败告警（P4）
data-service/         Python FastAPI + AKShare 微服务（新闻/公告/财报/历史K线；AKShare 调用统一 30s 超时）
public/webchat/       内置聊天网页
public/stocks/        股票浏览页 + 个股详情页 SPA（F1/F2，手写 SVG 走势图）
public/market/        全市场涨跌榜页（涨幅/跌幅/平盘三 Tab + 家数总览，东财 clist/ulist）
public/funds/         基金版块页（F4-B：排行/ETF Tab + 搜索 + 净值走势图，数据经 data-service）
public/shared/        前端共享设计系统 theme.css（各页面共用，/shared 静态挂载）
tests/                vitest 单测（npm test）；fixtures/eastmoney/ 为真实接口响应回放
docs/                 文档库：STATUS（功能与问题）/ FEATURES（实现手册）/ PITFALLS（踩坑病例）/ AUDIT（代码审计）/ 架构与数据源
```

## 开发工作流

> ⚠️ **Git 流程（必须遵守）**：任何改动先 `git checkout -b feat/xxx` 切分支，
> 推送到远程后开 PR 合并到 main，**不要直接提交/推送到 main**。
> 分支命名、提交信息格式、PR 规范、回退方法见 [docs/WORKFLOW.md](docs/WORKFLOW.md)。

```bash
# 首次设置
cp .env.example .env   # 然后填入 LLM_API_KEY（不填则所有对话功能不可用）
npm install

# 主服务（进程 1）
npm run dev          # tsx watch 热重载开发
npm run typecheck    # 提交前必须过
npm test             # vitest 单测（tests/），提交前必须全绿
npm run build && npm start   # 生产运行

# 数据微服务（进程 2，新闻/搜索的主数据源需要它；只调行情可以不启动）
cd data-service
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

注意：本项目是 ESM（`"type": "module"`，module NodeNext），**相对 import 必须带 `.js` 后缀**。

### 完成一项改动后的验收清单

1. `npm run typecheck` 与 `npm test` 通过；改了 Python 则 `python -m py_compile data-service/main.py` 通过
2. `GET http://localhost:18790/health` 返回数据源与技能清单符合预期
3. 打开 `http://localhost:18790/webchat` 发一条覆盖你改动的消息，确认链路通
   （改技能就触发该技能；改数据层就分别在有/无 data-service 两种状态下验证）。
   无法执行时（无 LLM_API_KEY / data-service 未运行 / 改动不涉及对话链路），
   以 typecheck + npm test 为准，并在汇报中明确写明"端到端验证未做及原因"，
   不要停下来等待人工验证
4. 按下方的文档维护义务更新该更新的文档

## 如何新增一个技能（示例：龙虎榜）

1. `mkdir src/skills/bundled/longhubang`
2. 写 `SKILL.md`：触发场景、参数、数据来源（照抄 quote/SKILL.md 的格式）
3. 写 `index.ts`：`default export` 一个 `Skill` 对象（参照 quote/index.ts）
4. 在 `src/skills/registry.ts` import 并加入 `skills` 数组
5. 如果数据东财接口给不了，在 `data-service/main.py` 加端点，并在 `DataProvider` 接口加方法

## 如何新增一个渠道（示例：钉钉）

实现 `Channel` 接口（`src/channels/types.ts`），在 `src/index.ts` 里按环境变量启用。
参考 `feishu.ts` 的完整实现（验签、token 缓存、去重、主动推送的 userId→chat_id 映射）。
个人微信无官方 API、第三方方案有封号风险，**不要做**。

## 已知坑与注意事项

> 详细的排错病例库在 [docs/PITFALLS.md](docs/PITFALLS.md)：**改动 `src/data/`、
> `src/channels/`、`src/alerts/`、`data-service/` 之前先扫一遍对应章节**；
> 新踩的坑（排查 >15 分钟、报错有迷惑性、外部接口非直觉行为）必须按模板回填。

- **东财接口是非官方公开接口**，字段编码（f43 等）和可用性可能变化。挂了先看
  `src/data/eastmoney.ts` 顶部注释，用浏览器打开东财行情页抓包对比。
- 东财价格类字段默认**放大 100 倍**返回，解析时除以 100（已在代码中处理）。
- 停牌/退市股票东财返回 `"-"`，`getQuote` 会抛错，技能层会把错误文本回给 LLM，
  LLM 会转述给用户——这是设计如此，不是 bug。
- LLM 不认识股票名称→代码的映射时（如"比亚迪"→002594），已有 `search_stock` 技能
  （`src/skills/bundled/search/`）：SYSTEM_PROMPT 已引导先 search 再 query。搜索优先走
  Python 微服务（AKShare 全量代码表缓存），未启动时自动降级到东财 suggest 接口。
- AKShare 升级能修复大部分数据失效问题：`pip install -U akshare`。
- `data/store.db`（SQLite）与旧的 `data/store.json` 都是运行时数据，已 gitignore。

## 下一步路线

**原路线图与 P2/P3/P4/P5/P6 已全部完成**（截至 2026-09-14），首轮全模块代码审计
同日完成（46 条发现全部处理并复核闭环，见 [docs/AUDIT.md](docs/AUDIT.md)）。
2026-09-15 环境已就绪（Kimi kimi-k3 接入，行情链路加了腾讯降级）。

剩余事项（按优先级）：
1. ~~F1/F2 新功能~~ ✅ 2026-09-15 完成：股票浏览页 + 个股详情页（SVG 折线图、往期数据）
   + 页内搜索；数据层新增历史 K 线能力（东财失败降级新浪，PITFALLS 已记录）。
2. **F3 个股信息补全**（用户指定，详见 [docs/STATUS.md](docs/STATUS.md) 第四节）：
   估值/市值、公司资料、成交活跃度、资金流、分时数据等，按 F3-1→F3-6 顺序做。
3. **F4 基金与财经资讯版块**（用户 2026-09-15 指定，开发中）：网页新页面 + 聊天技能，
   查看基金（净值/排行/场内 ETF，对标支付宝财富页基金版块）与股票/基金财经快讯；
   拆为 F4-A（财经快讯）/F4-B（基金版块）两个并行子任务，详见 [docs/STATUS.md](docs/STATUS.md) 第四节。
4. **F5 分析与监控增强**（用户 2026-09-15 指定，参考 tickflow-stock-panel）：技术指标
   （MA/MACD/RSI/KDJ/BOLL + 关键价位）、AI 个股多维分析、盘后复盘推送、多条件监控提醒
   四项轻量能力（排期在 F3/F4-B 之后），选股扫描与回测引擎两项重资产后置（前置：本地
   全市场行情库）。**红线：永不荐股、不做买卖建议与价格预测**，分析 = 客观指标计算 +
   LLM 汇总解读。详见 [docs/STATUS.md](docs/STATUS.md) 第四节。
5. S3-3 多用户体系（仅公网部署前必须做，落地时一并解决 A-601 同口令无身份隔离）；
   A-508 微服务 token（仅非回环部署时需要）。
6. P8：LLM 429 重试（Kimi 低等级账号限流，用户决定暂不修，复发时做）。

后续迭代按 [docs/STATUS.md](docs/STATUS.md) 第四节执行。

## 文档维护义务（每次改动代码后对照执行）

| 你做了什么 | 必须更新 |
|---|---|
| 完成了路线图上的功能 / 发现新的项目级问题 | [docs/STATUS.md](docs/STATUS.md)（含更新日志） |
| 新增或删除了功能模块 | [docs/FEATURES.md](docs/FEATURES.md)（追加/移除对应一节） |
| 排查并解决了一个坑（>15 分钟、报错有迷惑性、外部接口非直觉行为） | [docs/PITFALLS.md](docs/PITFALLS.md)（按模板回填） |
| 做代码审查 / 修复了审计问题 | [docs/AUDIT.md](docs/AUDIT.md)（严格遵守其中的角色权限规则） |
| 改了目录结构、开发流程、关键决策 | 本文件（CLAUDE.md） |
| 新增/下线了用户可见功能、接口端点、启动前置条件 | [README.md](README.md)（及 [data-service/README.md](data-service/README.md)，如涉及微服务端点） |

对照上表逐行判断，**仅更新适用的行；均不适用则无需动文档**，不必为此请示。
原则：文档和代码不同步，比没有文档更糟——下一个 agent 会被误导。

## 环境变量

见 `.env.example`，每个变量都有中文注释。
