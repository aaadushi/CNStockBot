# 功能实现手册（FEATURES）

> **本文件的用途**：修改某个功能前，先在这里找到它——用什么方法/技术实现的、
> 代码在哪几个文件、改的时候要动哪里。每个功能一节，结构固定：
> **实现方式 → 代码位置 → 改动入口 → 注意事项**。
>
> **新增功能时必须在本文档追加一节**；功能删除时移除对应节。
> 功能现状（能用/待做/有问题）看 [STATUS.md](STATUS.md)，原理性架构看
> [ARCHITECTURE.md](ARCHITECTURE.md)，报错排查看 [PITFALLS.md](PITFALLS.md)。

最后更新：2026-09-14

---

## 1. 对话主循环（Agent Loop）

- **实现方式**：经典 ReAct 式循环——组装 `[system, ...历史, user]` 消息 + 全部技能的
  tools 定义发给 LLM；LLM 返回 tool_calls 则逐个执行技能、结果以 tool 消息回传，
  直到 LLM 返回纯文本或达到轮数上限（`MAX_TOOL_ROUNDS = 8`）。
  SYSTEM_PROMPT 在文件顶部，定义了助手人设与全部行为规则（先搜后查、禁荐股、免责声明等）。
- **代码位置**：[src/agent/loop.ts](../src/agent/loop.ts)
- **改动入口**：
  - 调机器人行为/口吻/规则 → 改 `SYSTEM_PROMPT`
  - 调记忆长度 → `MAX_HISTORY`（当前 20 条/人）
  - 改历史存取 → `handleMessage` 首尾对 `store.getHistory/saveHistory` 的调用
- **注意事项**：会话历史只保留 user/assistant 问答对，tool 消息被有意丢弃（STATUS P3）；
  `tool_calls.function.arguments` 是 JSON 字符串必须 parse（PITFALLS.md LLM 条目）。

## 2. LLM 客户端

- **实现方式**：OpenAI 兼容协议（`/chat/completions`）纯 `fetch` 实现，无 SDK。
  DeepSeek/通义/Kimi/智谱均兼容，换模型只改环境变量。
- **代码位置**：[src/llm/client.ts](../src/llm/client.ts)，配置在 [src/config.ts](../src/config.ts) 的 `llm` 节
- **改动入口**：换模型/服务商 → `.env` 的 `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`；
  加超时/重试/流式 → `chat()` 函数
- **注意事项**：模型必须支持 function calling；未配置 API Key 时启动不报错、首次调用才抛错。

## 3. 技能框架

- **实现方式**：每个技能一个目录 `src/skills/bundled/<name>/`，含 `SKILL.md`（说明文档）
  和 `index.ts`（default export 一个 `Skill` 对象：name/description/parameters(JSON Schema)/execute）。
  注册表集中 import 所有技能，`toToolSpecs()` 转成 OpenAI tools 定义喂给 LLM。
  技能通过 `SkillContext { userId, store, data }` 拿依赖，不接触渠道和 LLM。
- **代码位置**：[src/skills/types.ts](../src/skills/types.ts)（接口）、
  [src/skills/registry.ts](../src/skills/registry.ts)（注册表）
- **改动入口**：新增技能 = 建目录写两个文件 + registry 数组追加（CLAUDE.md 有四步流程）
- **注意事项**：技能 execute 返回的**所有**文本（含报错、空结果）都会回传给 LLM，
  应包含对 LLM 下一步行为的指引（PITFALLS.md LLM 条目沉淀的经验）。

## 4. 实时行情查询（get_stock_quote）

- **实现方式**：调 `DataProvider.getQuote(code)`，默认走东财 push2 接口直连；
  格式化为带涨跌 emoji 的多行文本。
- **代码位置**：[src/skills/bundled/quote/index.ts](../src/skills/bundled/quote/index.ts)、
  数据层 [src/data/eastmoney.ts](../src/data/eastmoney.ts)
- **改动入口**：改输出格式 → 技能 `execute`；改行情字段/数据源 → eastmoney.ts
- **注意事项**：价格字段东财放大 100 倍（已除）；停牌/退市返回 `"-"` 会抛错，
  属设计行为（PITFALLS.md）。

## 5. 新闻查询（get_stock_news）

- **实现方式**：调 `DataProvider.getNews(code, limit)` → Python 微服务 `/news/{code}`
  → `ak.stock_news_em()`，limit 上限 20。
- **代码位置**：[src/skills/bundled/news/index.ts](../src/skills/bundled/news/index.ts)、
  [src/data/pythonService.ts](../src/data/pythonService.ts)、[data-service/main.py](../data-service/main.py) 的 `/news` 端点
- **改动入口**：换新闻源/加字段 → main.py 端点 + provider.ts 的 `NewsItem` 接口 + 技能格式化
- **注意事项**：微服务未启动时技能报错文本含启动提示（`src/data/index.ts` CompositeProvider 包装）；
  交易所正式公告不归本技能管，见下一节 get_stock_announcements。

## 6. 公告查询（get_stock_announcements，2026-09-14 新增）

- **实现方式**：调 `DataProvider.getAnnouncements(code, limit)` → Python 微服务
  `/announcements/{code}` → `ak.stock_zh_a_disclosure_report_cninfo()`（巨潮资讯网，
  沪深京市场，默认近 30 天）。limit 上限 20，微服务侧上限 50。
- **代码位置**：[src/skills/bundled/announcement/](../src/skills/bundled/announcement/)、
  [src/data/pythonService.ts](../src/data/pythonService.ts)、
  [data-service/main.py](../data-service/main.py) 的 `/announcements` 端点
- **改动入口**：调查询时间窗 → main.py 端点的 `days` 参数（默认 30，上限 365）；
  按类别筛选（年报/分红/风险提示等）→ 端点已留 `category` 参数，技能层需要时再加
- **注意事项**：结果为空时部分 AKShare 版本抛 `KeyError`，端点已捕获并返回空列表
  （PITFALLS.md Python 条目）；CLAUDE.md 旧版写的 `ak.stock_notice_report` 是
  按日期查全市场公告的接口，不适合个股查询，不要误用（DATA_SOURCES.md）。

## 7. 财报查询（get_stock_financials，2026-09-14 新增）

- **实现方式**：调 `DataProvider.getFinancials(code, limit)` → Python 微服务
  `/financials/{code}` → `ak.stock_financial_abstract(stock=code)`（新浪财经财务摘要，
  按报告期倒序，默认 4 期）。技能把各期关键指标格式化成文本回给 LLM，由 LLM 做趋势解读
  （SYSTEM_PROMPT 的免责声明规则自动覆盖）。
- **代码位置**：[src/skills/bundled/financials/](../src/skills/bundled/financials/)、
  [src/data/pythonService.ts](../src/data/pythonService.ts)、
  [data-service/main.py](../data-service/main.py) 的 `/financials` 端点
- **改动入口**：增删指标字段 → main.py 端点的 `col_map` + provider.ts 的
  `FinancialReport` 接口 + 技能格式化；要数值计算（如同比）→ 先在端点里清洗掉
  "元"后缀和千分位逗号（目前原样返回字符串，只适合 LLM 阅读）
- **注意事项**：该接口参数名是 `stock` 而非 `symbol`；返回值全是带单位的中文字符串；
  部分股票历史数据被新浪截断到 100 条（PITFALLS.md Python 条目）。

## 8. 自选股管理（manage_watchlist）

- **实现方式**：add/remove/list 三操作。add 前先 `getQuote` 验证代码真实存在（顺便拿名称）；
  list 时对每只自选股并发拉实时行情一并展示。存储按 userId 隔离。
- **代码位置**：[src/skills/bundled/watchlist/index.ts](../src/skills/bundled/watchlist/index.ts)、
  存储 [src/storage/store.ts](../src/storage/store.ts)
- **改动入口**：加操作（如清空、排序）→ 技能 parameters 的 enum + execute 分支 + Store 方法
- **注意事项**：add 的 `getQuote` 验证意味着停牌股票**加不进**自选（会抛错）——
  如需支持加停牌股，把验证降级为 search 或捕获错误后仅按代码添加。

## 9. 股票搜索（search_stock，2026-09 新增）

- **实现方式**：双层数据源——优先 Python 微服务 `/search`（`ak.stock_info_a_code_name()`
  全量代码表进程内缓存 24h，按"完全 > 前缀 > 包含"三级打分排序）；微服务不可用时
  CompositeProvider 自动降级到东财 suggest 接口（`searchapi.eastmoney.com`，
  过滤 0/3/6 开头代码排除基金/债券/指数）。
- **代码位置**：[src/skills/bundled/search/](../src/skills/bundled/search/)、
  [src/data/index.ts](../src/data/index.ts)（降级逻辑）、
  [src/data/eastmoney.ts](../src/data/eastmoney.ts) `search()`（suggest 接口）、
  [data-service/main.py](../data-service/main.py) `/search` 端点（缓存与打分）
- **改动入口**：调匹配规则/排序 → main.py 的 `score()`；调缓存时长 → `_CODE_NAME_TTL`；
  加拼音搜索 → main.py（需引入 pypinyin 依赖）
- **注意事项**：SYSTEM_PROMPT 已引导"先搜后查、有歧义让用户选、搜不到禁止凭记忆作答"，
  改 prompt 时别删掉这条；suggest 接口字段是非官方的（PITFALLS.md 东财条目）。

## 10. 大盘指数查询（get_market_index，2026-09-14 新增）

- **实现方式**：技能内置"常用指数 → 东财 secid"显式映射表（8 个：上证/深成/创业板/
  沪深300/上证50/中证500/科创50/北证50），调 `DataProvider.getIndexQuote(secid)`
  走东财 push2 直连（与个股行情同一个接口，`fetchQuote` 共用）。支持名称/别名/代码匹配；
  不传 `name` 时并发拉 4 个核心指数返回大盘概览。
- **代码位置**：[src/skills/bundled/index/](../src/skills/bundled/index/)、
  [src/data/eastmoney.ts](../src/data/eastmoney.ts) `getIndexQuote()`
- **改动入口**：加指数 → 技能里的 `INDICES` 表（**必须到东财行情页确认 secid 再填**）；
  调概览名单 → `CORE_CODES`
- **注意事项**：指数 secid 规则与个股不同，**禁止复用 `toSecid()` 推导**——000001
  个股=平安银行（0.000001）、指数=上证指数（1.000001）（PITFALLS.md 东财条目）；
  指数点位同样放大 100 倍返回（fetchQuote 已统一除 100）。

## 11. 行情数据源（东财直连）

- **实现方式**：`fetch` 调 `push2.eastmoney.com/api/qt/stock/get`，带
  `Referer: https://quote.eastmoney.com/` 头；`toSecid()` 做代码→secid 转换
  （沪市 6/9 开头前缀 `1.`，其余 `0.`）。
- **代码位置**：[src/data/eastmoney.ts](../src/data/eastmoney.ts)（顶部注释列了全部已知字段编码）
- **改动入口**：加行情字段 → `FIELDS` 常量 + 接口类型 + 解析；接口失效排查 →
  PITFALLS.md 东财条目（浏览器抓包对比）
- **注意事项**：secid 规则对指数不通用（000001 股票=平安银行 vs 指数=上证指数），
  指数查询走 `getIndexQuote(secid)` + 技能层显式映射表（见上一节），不要改 `toSecid()`。

## 12. Python 数据微服务（data-service）

- **实现方式**：FastAPI + AKShare，包一层 HTTP 给 Node 主服务调用。端点：
  `/health`、`/quote/{code}`（盘口快照）、`/news/{code}`、`/search?keyword=`、
  `/announcements/{code}`（个股公告，巨潮资讯）、`/financials/{code}`（财报摘要，新浪）、
  `/trade-calendar?year=`（交易日历，新浪，进程内缓存 24h；2026-09-14 新增，供调度器跳法定节假日）。
  主服务侧客户端是 `PythonServiceProvider`，`DATA_PROVIDER=python` 时全量走微服务，
  默认组合模式把新闻/公告/财报/搜索路由给它。
- **代码位置**：[data-service/main.py](../data-service/main.py)、
  客户端 [src/data/pythonService.ts](../src/data/pythonService.ts)、
  组合逻辑 [src/data/index.ts](../src/data/index.ts)
- **改动入口**：加数据能力 = main.py 加端点 + `DataProvider` 接口加方法 +
  PythonServiceProvider 加调用 + CompositeProvider 接线 + （可选）新技能
- **注意事项**：AKShare 接口失效先 `pip install -U akshare`（PITFALLS.md）；
  端点统一用 try/except 包成 502 结构化错误，别让堆栈传到主服务。

## 13. WebChat 渠道与离线收件箱

- **实现方式**：Express 静态托管 `public/webchat/` 聊天页；`POST /api/chat`
  同步等 Agent 回复；`notify()` 的消息存内存 Map，前端轮询 `GET /api/inbox` 取走（取后即删）。
  **访问口令鉴权（2026-09-14，解决 P5）**：`requireAccessToken` 中间件保护所有 `/api/*`，
  校验 `Authorization: Bearer <token>`，失败 401；口令来自 `config.accessToken`
  （`.env` 的 `ACCESS_TOKEN`，未配置时启动随机生成并打印控制台）；静态页面不鉴权；
  前端首次打开弹窗输口令存 localStorage，401 时清除并要求重输。
- **代码位置**：[src/channels/webchat.ts](../src/channels/webchat.ts)、
  前端 [public/webchat/](../public/webchat/)、渠道接口 [src/channels/types.ts](../src/channels/types.ts)
- **改动入口**：改鉴权方式（如多用户）→ `requireAccessToken` 中间件 + 前端 `apiFetch()`；
  通知改 WebSocket/SSE → `notify()` 与前端轮询逻辑
- **注意事项**：inbox 是内存存储，重启丢通知；口令是明文共享口令、非多用户体系，
  公网部署建议在 .env 固定强口令并配合 HTTPS。

## 14. 飞书渠道（2026-09-14 补完）

- **实现方式**：`/feishu/events` 接收事件——url_verification 挑战应答、
  X-Lark-Signature 验签（HMAC-SHA256，key 为 `FEISHU_ENCRYPT_KEY`，对
  `timestamp\nnonce\nkey\nrawBody` 计算）、verification token 二次校验、
  message_id 去重（10 分钟窗口），然后**立即 200、异步处理**。文本消息解析后喂给
  Agent（群聊自动去掉 `@_user_N` 占位符），回复走
  `POST /open-apis/im/v1/messages?receive_id_type=chat_id`；tenant_access_token
  内存缓存、到期前 2 分钟自动刷新。`notify()` 主动推送依赖 openId→chat_id 映射
  （从收到的消息学习，内存态）。
- **代码位置**：[src/channels/feishu.ts](../src/channels/feishu.ts)（文件头有完整接入步骤）；
  rawBody 保留逻辑在 [src/index.ts](../src/index.ts) 的 `express.json({ verify })`
- **改动入口**：启用开关与凭据 → `.env`（`ENABLE_FEISHU`/`FEISHU_APP_ID`/
  `FEISHU_APP_SECRET`/`FEISHU_VERIFICATION_TOKEN`/`FEISHU_ENCRYPT_KEY`）；
  支持图片/富文本消息 → `handleMessageEvent` 的 `message_type` 分支
- **注意事项**：验签必须配置 `FEISHU_ENCRYPT_KEY`，未配置会跳过并告警（仅限内网调试）；
  chat_id 映射重启即丢，重启后用户需先发一条消息才能收到收盘推送；
  验签依赖原始请求体，**改全局 JSON 中间件时不能删掉 verify 回调**（PITFALLS.md 渠道条目）。

## 15. 定时任务（收盘日报 + 异动提醒）

- **实现方式**：手写 `setTimeout` 调度器（北京时间显式换算），现有两个任务：
  1. **收盘日报**：每工作日 15:30 对自选股并发拉行情，格式化成带 emoji 的报告，
     单只失败降级为"获取失败"行，末尾固定附免责声明，通过所有渠道的 `notify()` 推送。
  2. **异动提醒**（2026-09-14 新增）：盘中（9:30-11:30 / 13:00-15:00）每 N 分钟
     （`ALERT_INTERVAL_MINUTES`，默认 5）轮询——先汇总全部用户的自选股**去重后并发拉行情**
     （避免多用户重复请求东财），涨跌幅绝对值超阈值（`ALERT_THRESHOLD_PCT`，默认 ±5%）
     即推送；`alerted` 集合按 `${日期}:${代码}` 去重，**每股每日只报一次**，跨天自动清空。
- **代码位置**：[src/alerts/scheduler.ts](../src/alerts/scheduler.ts)，
  启动接线在 [src/index.ts](../src/index.ts) `startScheduler(...)`
- **改动入口**：改推送时间/格式 → `buildDailyReport` / `msUntilNextRun`；
  调阈值/频率/开关 → `.env` 的 `ALERT_*` 变量；加新定时任务 → `startScheduler` 里加调度循环
- **注意事项**：法定节假日已跳（2026-09-14，解决 P2）——两个任务触发前先
  `await tradeCalendar.isTradeDay()`（`TradeCalendar` 在 `src/data/pythonService.ts`，
  数据来自 data-service `/trade-calendar`，按年缓存；服务挂掉自动降级为只跳周末，
  可用 `TRADE_CALENDAR_ENABLED=false` 关闭）。节假日判断放在**触发时**而不是算延迟时，
  `finally` 里的重新调度不能丢（PITFALLS.md 调度条目）；新任务必须复用 `beijingNow()`
  换算，别直接用本地时区。

## 16. 存储（SQLite）

- **实现方式**：`node:sqlite` 内置模块（DatabaseSync，免原生编译；需 Node >= 22.13），
  单文件 `data/store.db`（已 gitignore）。表：`watchlists(user_id, code)` 自选股、
  `histories(user_id, messages, updated_at)` 会话历史（JSON 数组，只存问答对）。
  启动时若发现旧版 `data/store.json` 自动迁移自选股并改名为 `.migrated`。
- **代码位置**：[src/storage/store.ts](../src/storage/store.ts)
- **改动入口**：存新数据 → 建新表 + 对应读写方法（保持同步方法风格，node:sqlite 全同步 API）
- **注意事项**：node:sqlite 在 Node 24 仍打印 ExperimentalWarning（功能可用，忽略即可）；
  `prepare().run()` 返回的 `changes` 可能是 bigint，比较前用 `Number()` 包一层；
  单文件锁解决了多实例互踩（原 STATUS P7），但仍不建议多实例同时写。

## 17. 配置与启动装配

- **实现方式**：全部配置来自 `.env`（dotenv），集中在 `config.ts` 一个对象里导出，
  代码里禁止直接读 `process.env`。`src/index.ts` 是装配层：Store → DataProvider →
  Agent → Channels → Scheduler → Express listen，`GET /health` 暴露数据源与技能清单。
- **代码位置**：[src/config.ts](../src/config.ts)、[src/index.ts](../src/index.ts)、
  环境变量说明 `.env.example`
- **改动入口**：加配置 → config.ts 加字段 + `.env.example` 加中文注释
- **注意事项**：项目是 ESM（`"type": "module"`），相对 import 必须带 `.js` 后缀（PITFALLS.md 工具链条目）。

## 18. 测试基座（vitest，2026-09-14 新增）

- **实现方式**：vitest 3.x（零配置文件，默认 node 环境 + Vite 内置 NodeNext 解析，
  直接 import src 下的 TS 模块）；`npm test` = `vitest run`。首批 35 条单测：
  `tests/eastmoney.test.ts`（toSecid 规则、行情解析 ÷100 / `"-"` / Referer，fetch 全 mock）、
  `tests/search.test.ts`（search_stock 入参校验与格式化，mock ctx）、
  `tests/store.test.ts`（真实 SQLite 往返，`DATA_DIR` 指向临时目录隔离）。
- **代码位置**：[tests/](../tests/)、`package.json` 的 `test` script
- **改动入口**：加测试 → `tests/*.test.ts` 直接加文件；外部接口层用 mock fetch /
  录制 fixture，不打真实网络
- **注意事项**：tsconfig `include` 只有 `src/**`，tests/ 不在 typecheck 范围
  （vitest 转译不做类型检查），如要纳入需另建 tsconfig；Windows 下 Store 的
  DatabaseSync 不关连接会导致临时目录删不掉，目前用绕过 TS private 的方式 close
  （PITFALLS.md 工具链条目，长期建议给 Store 加公开 `close()`）；scheduler 的
  时间函数未导出，export 后即可补测。
