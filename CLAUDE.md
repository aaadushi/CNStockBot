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
> 7. [docs/deploy/HTTPS.md](docs/deploy/HTTPS.md) —— 公网部署指南（S4-3：反向代理 + TLS + HSTS）

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
  storage/store.ts    SQLite 存储（node:sqlite）：自选股 + 会话历史（含工具上下文）+ 收件箱 + kv + alert_rules 监控规则（F5-4）+ users/sessions 表（S4-1），按 userId 隔离
  auth/               多用户认证（S4-1）：password/token/rateLimit/service/middleware/routes
    password.ts       用户名/密码校验、bcryptjs 哈希/校验
    token.ts          opaque session token 生成与 SHA-256 hash
    rateLimit.ts      IP 登录失败速率限制
    service.ts        AuthService：用户/会话 CRUD、过期清理
    middleware.ts     requireSession：Bearer token → req.user
    routes.ts         /api/auth/register|login|logout
  channels/
    types.ts          Channel 接口：mount(app, agent) + notify(userId, text)
    webchat.ts        网页聊天 + 收件箱 + 股票浏览页 API（/api/watchlist、/api/stocks/:code、/api/search）
    feishu.ts         飞书渠道：验签(含防重放)/回复/主动推送，chat_id 映射 kv 持久化；默认不启用
  alerts/scheduler.ts 定时任务：收盘日报（15:30 北京时间，含技术面信号摘要 F5-3）+ 盘中异动提醒（全局阈值 + 自定义多条件规则 F5-4）
  alerts/rules.ts     监控规则领域逻辑（条件类型/校验/求值/文案，纯函数，scheduler 与 manage_alerts 技能共用）
  alerts/healthProbe.ts 行情健康探针：定时探测常青股票，故障记日志+入 /health，推送默认关（P4）
data-service/         Python FastAPI + AKShare 微服务（新闻/公告/财报/历史K线；AKShare 调用统一 30s 超时）；含本地全市场日 K 库（baostock→SQLite data/market_bars.db，F5-5 选股扫描底座，线程内禁止裸调 AKShare，见 PITFALLS 2026-09-21 条目）
android/              F7-2 安卓 WebView 壳 App（独立 Gradle 工程，零第三方依赖）：首屏服务器地址配置 + WebView 装载 /webchat；认证由网页端 CNStockAuth 完成，壳不经手 token；构建见 android/README.md
scripts/              S3-4 进程管理：service.mjs 一键拉起/停止 data-service + 主服务（start/stop/status/restart，端口预检、日志落盘 logs/、PID 文件），start-all/stop-all 的 .bat/.sh 包装
public/webchat/       内置聊天网页
public/stocks/        股票浏览页 + 个股详情页 SPA（F1/F2，手写 SVG 走势图）
public/market/        全市场涨跌榜页（涨幅/跌幅/平盘三 Tab + 家数总览，东财 clist/ulist）
public/funds/         基金版块页（F4-B：排行/ETF Tab + 搜索 + 净值走势图，数据经 data-service）
public/overseas/      外盘联动页（F6-4：美股指数/中概股/国际金银原油 + 方向提示，数据经 data-service）
public/sectors/       板块轮动页（F6-3：涨跌/资金流排行 + 板块详情（成分股+走势图）+ 个股→板块共振，数据经 data-service）
public/scanner/       选股扫描页（F5-5：本地日 K 库 + 7 预设策略全市场扫描 + 库状态/手动更新，数据经 data-service）
public/backtest/      策略回测页（F5-6：单股历史信号回放，T+1/费用/滑点/止损，净值曲线 vs 基准 + 逐笔明细，数据经 data-service）
public/shared/        前端共享设计系统 theme.css + auth.js（S4-1：CNStockAuth 登录/注册/登出/apiFetch）
tests/                vitest 单测（npm test）；fixtures/eastmoney/ 为真实接口响应回放
docs/                 文档库：STATUS（功能与问题）/ FEATURES（实现手册）/ PITFALLS（踩坑病例）/ AUDIT（代码审计）/ 架构与数据源
```

## 开发工作流

> ⚠️ **Git 流程（必须遵守）**：任何改动先 `git checkout -b feat/xxx` 切分支，
> 推送到远程后开 PR 合并到 main，**不要直接提交/推送到 main**。
> 分支命名、提交信息格式、PR 规范、回退方法见 [docs/WORKFLOW.md](docs/WORKFLOW.md)。

> ⚠️ **需求文档流程（必须遵守，2026-09-26 起执行）**：
> **任何新功能开发前，必须先写需求文档到 `docs/requirements/<feature-id>-<short-name>.md`**。
> 需求文档是后续代码审计、功能验收、回归测试的基准，避免实现 agent 私自扩大/裁剪范围。
> 需求文档必须包含：背景与目标、范围（含明确不做的事项）、功能需求、非功能需求、数据模型/API/前端改动、验收标准、审计要点。
> 代码审计时审查 agent 必须对照需求文档逐项检查实现是否一致。

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
2. ~~F3 个股信息补全~~ ✅ 2026-09-16 全部完成（F3-1~F3-6：估值/市值、公司资料、
   成交活跃度、资金流、分时数据、涨跌停价/52周高低/分红送配，详见 STATUS 更新日志）。
3. ~~F4 基金与财经资讯版块~~ ✅ 2026-09-15 完成（F4-A 财经快讯 + F4-B 基金版块）。
4. **F5 分析与监控增强**（用户 2026-09-15 指定，参考 tickflow-stock-panel）：技术指标
   （MA/MACD/RSI/KDJ/BOLL + 关键价位）、AI 个股多维分析、盘后复盘推送、多条件监控提醒
   四项轻量能力（排期在 F3/F4-B 之后），选股扫描与回测引擎两项重资产后置（前置：本地
   全市场行情库）。**红线：永不荐股、不做买卖建议与价格预测**，分析 = 客观指标计算 +
   LLM 汇总解读。**进度：F5-1 技术指标分析 2026-09-16 完成，F5-2 AI 个股多维分析
   2026-09-19 完成**（analyze_stock 技能 + 详情页"AI 多维分析"卡），**F5-3/F5-4 轻量项
   均于 2026-09-19 完成**（盘后复盘信号摘要 + 多条件监控提醒 manage_alerts 技能）。
   剩余 F5-5/F5-6（选股扫描/回测引擎，重资产，前置：本地全市场行情库）与 F6 系列。
   **F5-5 于 2026-09-21 完成**（本地日 K 库 + /scanner 页 + scan_market 技能 + 盘后自动更新），
   **F5-6 于 2026-09-22 完成**（/backtest 端点 + 独立页：真实 A 股规则历史信号回放，
   F5 路线图收官）。生产双服务已于 2026-09-22 重启生效（S1-1 ✅），里程碑 tag
   v0.4.0 同日打完（S1-2 ✅）——**F5 系列全部收官**。
   详见 [docs/STATUS.md](docs/STATUS.md) 第四节。
5. **F6 形态识别与多维共振分析**（用户 2026-09-15 指定，参考小红书博主"递归熵"的系统）：
   K 线形态识别 + 历史成绩单（先 20 种经典形态）、资金流验货、板块轮动监控、外盘联动
   监控。**各功能网页端独立区块/入口呈现**（用户明确要求）；概率数字按历史统计口径表述。
   **进度：F6-4 外盘联动监控 2026-09-19 完成**（/overseas 独立页 + 规则化方向提示 +
   可选盘前推送 OVERSEAS_PUSH_ENABLED）。
   **进度：F6-1 于 2026-09-19 完成**（/patterns 端点 17 种形态 + get_stock_patterns 技能 +
   详情页"形态分析"卡）；**F6-3 板块轮动监控 2026-09-19 完成**（/sectors 独立导航页）；
   **F6-2 资金流验货 2026-09-21 完成**（/verify 端点三档分档结论 + 详情页独立验货卡 +
   analyze_stock 第七块，日级资金流口径）。
   详见 [docs/STATUS.md](docs/STATUS.md) 第四节。
6. **S4 公网发布前置（新增，优先级最高）**：项目目标已明确为"公网发布给别人使用"，以下事项从"可选/低优先级"提升为 F7 安卓端 App 公网发布的**前置硬门槛**，必须先于客户端完成：
   - **S4-1 多用户体系**（解决审计 A-601）：WebChat 共享口令 + 客户端自报 userId → 独立账号注册/登录、服务端签发 userId、自选股/会话/收件箱/监控规则按用户隔离；
   - **S4-2 微服务 token 鉴权**（解决审计 A-508）：data-service 端点校验 `DATA_SERVICE_TOKEN`，主服务 `pythonService.ts` 统一携带 token；
   - **S4-3 HTTPS 部署**：反向代理 + TLS 证书 + HSTS 建议，禁止登录凭证/微服务 token 明文走公网；
   - **S4-4 服务端监听地址可配置**：支持 `HOST` 环境变量，默认 `0.0.0.0`，文档说明绑定风险。
   完成顺序建议：S4-4 → S4-1 → S4-2 → S4-3（HTTPS 可与 S4-1/S4-2 并行准备）。
7. **F7 安卓端 App**（用户 2026-09-22 指定，目标：**公网发布给别人使用**）：保留现有网页端，新增安卓 App 入口。**不再以局域网方案为发布目标**，公网部署是唯一发布目标。
   关键前提、阶段拆分与路线候选见 [docs/STATUS.md](docs/STATUS.md) 第四节 F7。
   **进度：S4 全部四项已于 2026-09-26 完成（公网发布前置收官）；F7-2 安卓 WebView 壳
   工程同日完成**（android/ 独立 Gradle 工程，零依赖；APK 构建/真机验收待 Android
   Studio 执行）；剩余 F7-1（公网部署后端到端验证，依赖域名+反代+证书落地）与
   F7-3（本地通知/图标启动屏等体验加固）。
8. P8：LLM 429 重试（Kimi 低等级账号限流，用户决定暂不修，复发时做）。

后续迭代按 [docs/STATUS.md](docs/STATUS.md) 第四节执行。

## 文档维护义务（每次改动代码后对照执行）

| 你做了什么 | 必须更新 |
|---|---|
| 完成了路线图上的功能 / 发现新的项目级问题 | [docs/STATUS.md](docs/STATUS.md)（含更新日志） |
| **开始实现新功能前** | **[docs/requirements/](docs/requirements/) 下对应需求文档（必须先写）** |
| 新增或删除了功能模块 | [docs/FEATURES.md](docs/FEATURES.md)（追加/移除对应一节） |
| 排查并解决了一个坑（>15 分钟、报错有迷惑性、外部接口非直觉行为） | [docs/PITFALLS.md](docs/PITFALLS.md)（按模板回填） |
| 做代码审查 / 修复了审计问题 | [docs/AUDIT.md](docs/AUDIT.md)（严格遵守其中的角色权限规则） |
| 改了目录结构、开发流程、关键决策 | 本文件（CLAUDE.md） |
| 新增/下线了用户可见功能、接口端点、启动前置条件 | [README.md](README.md)（及 [data-service/README.md](data-service/README.md)，如涉及微服务端点） |

对照上表逐行判断，**仅更新适用的行；均不适用则无需动文档**，不必为此请示。
原则：文档和代码不同步，比没有文档更糟——下一个 agent 会被误导。

## 环境变量

见 `.env.example`，每个变量都有中文注释。
