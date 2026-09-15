# 功能实现手册（FEATURES）

> **本文件的用途**：修改某个功能前，先在这里找到它——用什么方法/技术实现的、
> 代码在哪几个文件、改的时候要动哪里。每个功能一节，结构固定：
> **实现方式 → 代码位置 → 改动入口 → 注意事项**。
>
> **新增功能时必须在本文档追加一节**；功能删除时移除对应节。
> 功能现状（能用/待做/有问题）看 [STATUS.md](STATUS.md)，原理性架构看
> [ARCHITECTURE.md](ARCHITECTURE.md)，报错排查看 [PITFALLS.md](PITFALLS.md)。

最后更新：2026-09-15

---

## 1. 对话主循环（Agent Loop）

- **实现方式**：经典 ReAct 式循环——组装 `[system, ...历史, user]` 消息 + 全部技能的
  tools 定义发给 LLM；LLM 返回 tool_calls 则逐个执行技能、结果以 tool 消息回传，
  直到 LLM 返回纯文本或达到轮数上限（`MAX_TOOL_ROUNDS = 8`）。
  SYSTEM_PROMPT 在文件顶部，定义了助手人设与全部行为规则（先搜后查、禁荐股、免责声明等）。
  **2026-09-14 起历史保留工具调用上下文**（解决 P3）：整条消息链（含 tool 消息）经
  `trimHistory()` 裁剪后入库——tool 结果超 1200 字符截断、总量 40 条预算、
  丢弃裁剪后链首的孤儿 tool 消息。同一 userId 的消息经 per-user Promise 队列严格串行
  （防并发 read-modify-write 覆盖历史，审计 A-101/A-407）。
- **代码位置**：[src/agent/loop.ts](../src/agent/loop.ts)
- **改动入口**：
  - 调机器人行为/口吻/规则 → 改 `SYSTEM_PROMPT`
  - 调记忆长度/截断策略 → `MAX_HISTORY_MESSAGES` / `TOOL_RESULT_MAX_CHARS` / `trimHistory()`
  - 改历史存取 → `process()` 首尾对 `store.getHistory/saveHistory` 的调用
- **注意事项**：历史含 tool 消息后，**裁剪必须保证 tool 消息紧跟带对应 tool_calls 的
  assistant 消息**（OpenAI 协议要求），改 trimHistory 时先跑 `tests/history.test.ts`；
  `tool_calls.function.arguments` 是 JSON 字符串必须 parse（PITFALLS.md LLM 条目）。

## 2. LLM 客户端

- **实现方式**：OpenAI 兼容协议（`/chat/completions`）纯 `fetch` 实现，无 SDK。
  DeepSeek/通义/Kimi/智谱均兼容，换模型只改环境变量。请求带显式超时
  （`LLM_TIMEOUT_MS`，默认 60s，`AbortSignal.timeout`）；响应校验 `choices[0].message`
  结构，缺失时抛出带原文摘要的错误（审计 A-102/A-103）。
- **代码位置**：[src/llm/client.ts](../src/llm/client.ts)，配置在 [src/config.ts](../src/config.ts) 的 `llm` 节
- **改动入口**：换模型/服务商 → `.env` 的 `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`；
  调超时 → `LLM_TIMEOUT_MS`；加重试/流式 → `chat()` 函数
- **注意事项**：模型必须支持 function calling；未配置 API Key 时启动打醒目 warning、
  首次调用才抛错（A-503）。

## 3. 技能框架

- **实现方式**：每个技能一个目录 `src/skills/bundled/<name>/`，含 `SKILL.md`（说明文档）
  和 `index.ts`（default export 一个 `Skill` 对象：name/description/parameters(JSON Schema)/execute）。
  注册表集中 import 所有技能，`toToolSpecs()` 转成 OpenAI tools 定义喂给 LLM；
  **启动时检测技能重名，重名直接抛错**（审计 A-206）。
  技能通过 `SkillContext { userId, store, data }` 拿依赖，不接触渠道和 LLM。
  参数校验公共助手在 `src/skills/args.ts`：`invalidCodeMessage()`（6 位代码）与
  `normalizeLimit()`（条数归一化到 [1,max]，防 NaN/负数/小数），新技能统一使用。
- **代码位置**：[src/skills/types.ts](../src/skills/types.ts)（接口）、
  [src/skills/registry.ts](../src/skills/registry.ts)（注册表）、
  [src/skills/args.ts](../src/skills/args.ts)（参数校验助手）
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
- **注意事项**：该接口参数名随 AKShare 版本变动（旧版 `stock`，1.18.94 起 `symbol`，
  端点已做双兼容）；返回值全是带单位的中文字符串；
  部分股票历史数据被新浪截断到 100 条（PITFALLS.md Python 条目）。

## 8. 自选股管理（manage_watchlist）

- **实现方式**：add/remove/list 三操作（**action 白名单校验**，未知值直接返回不执行——
  防 LLM 幻觉出 "delete" 误删，审计 A-201）。add 前先 `getQuote` 验证代码并拿名称；
  **行情接口失败（停牌/退市）时降级用 search 按代码精确匹配验证**，停牌股可入自选
  （2026-09-14 起，审计 A-202）。list 时对每只自选股并发拉实时行情一并展示。存储按 userId 隔离。
- **代码位置**：[src/skills/bundled/watchlist/index.ts](../src/skills/bundled/watchlist/index.ts)、
  存储 [src/storage/store.ts](../src/storage/store.ts)
- **改动入口**：加操作（如清空、排序）→ 技能 parameters 的 enum + execute 分支 + Store 方法
- **注意事项**：涨跌幅缺失（新股首日等）显示为 `—`（Quote.changePct 为 NaN，审计 A-310）。

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
  名称匹配先归一化（去空白/去"指数"后缀/转小写）再全等 + 双向包含兜底（审计 A-205）。

## 11. 行情数据源（东财直连 + 腾讯降级）

- **实现方式**：主源 `fetch` 调 `push2.eastmoney.com/api/qt/stock/get`，带
  `Referer: https://quote.eastmoney.com/` 头与 10s 显式超时；`toSecid()` 做代码→secid 转换
  （沪市 6/900 前缀 `1.`，深市 0/3 与北交所 4/8/920 前缀 `0.`）。
  昨收/涨跌幅缺失时（新股首日等）changePct/prevClose 置 NaN，展示层显示"—"（审计 A-310）。
  **自动降级（2026-09-15）**：东财失败（限流/接口变更）时 CompositeProvider 自动切换
  腾讯行情（`src/data/tencent.ts`，qt.gtimg.cn，GBK 文本协议、价格不放大），
  个股与指数行情都有降级，降级有 console.warn 日志。
- **代码位置**：[src/data/eastmoney.ts](../src/data/eastmoney.ts)（顶部注释列了全部已知字段编码）、
  [src/data/tencent.ts](../src/data/tencent.ts)、降级逻辑 [src/data/index.ts](../src/data/index.ts)
- **改动入口**：加行情字段 → `FIELDS` 常量 + 接口类型 + 解析（东财）/ 下标解析（腾讯）；
  接口失效排查 → PITFALLS.md 东财/腾讯条目
- **注意事项**：secid 规则对指数不通用（000001 股票=平安银行 vs 指数=上证指数），
  指数查询走 `getIndexQuote(secid)` + 技能层显式映射表（见上一节），不要改 `toSecid()`。
  **高频请求 push2 会触发东财 IP 级断连限流**（PITFALLS.md 东财条目，2026-09-14 实测）；
  限流期间健康探针走组合链路（腾讯托底成功则探测为健康），东财故障从降级日志观察。

## 12. Python 数据微服务（data-service）

- **实现方式**：FastAPI + AKShare，包一层 HTTP 给 Node 主服务调用。端点：
  `/health`、`/quote/{code}`（盘口快照）、`/news/{code}`、`/search?keyword=`、
  `/announcements/{code}`（个股公告，巨潮资讯）、`/financials/{code}`（财报摘要，新浪）、
  `/trade-calendar?year=`（交易日历，新浪，进程内缓存 24h）。
  **所有 AKShare 调用经 `run_ak()` 包装：线程池执行 + 30s 整体超时，超时返回 504**
  （防上游挂起耗尽 uvicorn 线程池，审计 A-506）；财报缺失值用 `pd.isna` 判空
  （真值 0 保留，审计 A-504）；交易日历输出用 `strftime` 与列类型解耦（A-505）。
  主服务侧客户端是 `PythonServiceProvider`（60s 超时，连接错误与 HTTP 5xx 分开提示），
  `DATA_PROVIDER=python` 时全量走微服务，默认组合模式把新闻/公告/财报/搜索路由给它。
- **代码位置**：[data-service/main.py](../data-service/main.py)、
  客户端 [src/data/pythonService.ts](../src/data/pythonService.ts)、
  组合逻辑 [src/data/index.ts](../src/data/index.ts)
- **改动入口**：加数据能力 = main.py 加端点 + `DataProvider` 接口加方法 +
  PythonServiceProvider 加调用 + CompositeProvider 接线 + （可选）新技能
- **注意事项**：AKShare 接口失效先 `pip install -U akshare`（PITFALLS.md）；
  端点统一用 try/except 包成 502 结构化错误，别让堆栈传到主服务；
  **无鉴权，必须绑定回环地址启动**（`--host 127.0.0.1`）。

## 13. WebChat 渠道与离线收件箱

- **实现方式**：Express 静态托管 `public/webchat/` 聊天页；`POST /api/chat`
  同步等 Agent 回复；`notify()` 的消息写 SQLite `inbox` 表（2026-09-14 起重启不丢，
  每用户只留最近 100 条），前端轮询 `GET /api/inbox` 取走（读后即删）。
  **访问口令鉴权（2026-09-14，解决 P5）**：`requireAccessToken` 中间件保护所有 `/api/*`，
  校验 `Authorization: Bearer <token>`（恒定时间比较，A-607），失败 401；口令来自
  `config.accessToken`（`.env` 的 `ACCESS_TOKEN`，未配置时启动随机生成并打印控制台）；
  静态页面不鉴权；前端首次打开弹窗输口令存 localStorage，点取消不阻塞循环、
  页面内出可点击的重试提示（A-606）。
- **代码位置**：[src/channels/webchat.ts](../src/channels/webchat.ts)、
  前端 [public/webchat/](../public/webchat/)、渠道接口 [src/channels/types.ts](../src/channels/types.ts)
- **改动入口**：改鉴权方式（如多用户）→ `requireAccessToken` 中间件 + 前端 `apiFetch()`；
  通知改 WebSocket/SSE → `notify()` 与前端轮询逻辑
- **注意事项**：口令是明文共享口令、非多用户体系；**同口令持有者之间无身份隔离**
  （userId 客户端自报，审计 A-601 标注为已知限制，S3-3 解决）；
  公网部署建议在 .env 固定强口令并配合 HTTPS。

## 14. 飞书渠道（2026-09-14 补完）

- **实现方式**：`/feishu/events` 接收事件——url_verification 挑战应答、
  X-Lark-Signature 验签（HMAC-SHA256，key 为 `FEISHU_ENCRYPT_KEY`，对
  `timestamp\nnonce\nkey\nrawBody` 计算）+ **时间戳 ±5 分钟新鲜度校验**（防重放，A-603）、
  verification token 二次校验、message_id 去重（10 分钟窗口），然后**立即 200、异步处理**。
  文本消息解析后喂给 Agent（群聊自动去掉 `@_user_N` 占位符），回复走
  `POST /open-apis/im/v1/messages?receive_id_type=chat_id`；tenant_access_token
  内存缓存、到期前 2 分钟自动刷新。`notify()` 主动推送依赖 openId→chat_id 映射——
  **只在单聊（chat_type=p2p）时学习映射**（防持仓日报误推群聊泄露持仓，A-604），
  持久化在 Store kv 表（2026-09-14 起重启不丢，内存 Map 作缓存）。
  **fail-closed**：ENCRYPT_KEY 与 VERIFICATION_TOKEN 都未配置时事件接口一律 401（A-605）。
- **代码位置**：[src/channels/feishu.ts](../src/channels/feishu.ts)（文件头有完整接入步骤）；
  rawBody 保留逻辑在 [src/index.ts](../src/index.ts) 的 `express.json({ verify })`
- **改动入口**：启用开关与凭据 → `.env`（`ENABLE_FEISHU`/`FEISHU_APP_ID`/
  `FEISHU_APP_SECRET`/`FEISHU_VERIFICATION_TOKEN`/`FEISHU_ENCRYPT_KEY`）；
  支持图片/富文本消息 → `handleMessageEvent` 的 `message_type` 分支
- **注意事项**：验签依赖原始请求体，**改全局 JSON 中间件时不能删掉 verify 回调**
  （PITFALLS.md 渠道条目）；事件结构不带 chat_type 的旧格式不会学习映射
  （宁可少推不可泄露）。

## 15. 定时任务（收盘日报 + 异动提醒）

- **实现方式**：手写 `setTimeout` 调度器（北京时间显式换算），现有两个任务：
  1. **收盘日报**：每工作日 15:30 对自选股并发拉行情，格式化成带 emoji 的报告，
     单只失败降级为"获取失败"行，末尾固定附免责声明，通过所有渠道的 `notify()` 推送。
  2. **异动提醒**（2026-09-14 新增）：盘中（9:30-11:30 / 13:00-15:00）每 N 分钟
     （`ALERT_INTERVAL_MINUTES`，默认 5）轮询——先汇总全部用户的自选股**去重后并发拉行情**
     （避免多用户重复请求东财），涨跌幅绝对值超阈值（`ALERT_THRESHOLD_PCT`，默认 ±5%）
     即推送；`alerted` 集合按 `${日期}:${代码}` 去重，**每股每日只报一次**，跨天自动清空。
  推送统一走 `notifyUser()`：逐渠道 try/catch，单用户/单渠道失败不中断当轮其余用户；
  **推送成功才写 alerted 标记**，失败下轮补报（审计 A-403/A-404/A-602）。
- **代码位置**：[src/alerts/scheduler.ts](../src/alerts/scheduler.ts)，
  启动接线在 [src/index.ts](../src/index.ts) `startScheduler(...)`
- **改动入口**：改推送时间/格式 → `buildDailyReport` / `msUntilNextRun`；
  调阈值/频率/开关 → `.env` 的 `ALERT_*` 变量；加新定时任务 → `startScheduler` 里加调度循环
- **注意事项**：法定节假日已跳（2026-09-14，解决 P2）——两个任务触发前先
  `await tradeCalendar.isTradeDay()`（`TradeCalendar` 在 `src/data/pythonService.ts`，
  数据来自 data-service `/trade-calendar`，按年缓存且入缓存前校验格式（A-302）；
  服务挂掉自动降级为只跳周末，可用 `TRADE_CALENDAR_ENABLED=false` 关闭）。
  节假日判断放在**触发时**而不是算延迟时，`finally` 里的重新调度不能丢（PITFALLS.md
  调度条目）；新任务必须复用 `beijingNow()` 换算，别直接用本地时区；
  海外 DST 时区服务器在切换日可能偏 ±1 小时（已知边界，A-406）。

## 16. 行情健康探针（2026-09-14 新增，解决 P4）

- **实现方式**：东财是非官方公开接口、可能静默失效，故定时（`HEALTH_PROBE_INTERVAL_MINUTES`，
  默认 30 分钟）探测常青股票（`HEALTH_PROBE_CODE`，默认 600519）的 `getQuote` 链路。
  连续失败 2 次判定故障：向所有用户推送一条告警（一次故障只推一次），恢复时推恢复通知；
  状态实时暴露在 `GET /health` 的 `quoteProbe` 字段。探测只包 getQuote 本身，
  通知与状态更新在 try 外且逐渠道隔离（审计 A-401/A-402）。
- **代码位置**：[src/alerts/healthProbe.ts](../src/alerts/healthProbe.ts)，
  接线在 [src/index.ts](../src/index.ts) `startHealthProbe(...)`
- **改动入口**：开关/频率/探测标的 → `.env` 的 `HEALTH_PROBE_*`；
  `HEALTH_PROBE_ENABLED=false` 完全关闭
- **注意事项**：探测走当前配置的 quote 链路（默认组合 = 东财直连；DATA_PROVIDER=python
  时探微服务行情端点）；tick 自调度挂 finally + catch 兜底，改结构时两者都不能丢。

## 17. 存储（SQLite）

- **实现方式**：`node:sqlite` 内置模块（DatabaseSync，免原生编译；需 Node >= 22.13），
  单文件 `data/store.db`（已 gitignore）。表：`watchlists(user_id, code)` 自选股、
  `histories(user_id, messages, updated_at)` 会话历史（JSON 数组，含工具调用上下文）、
  `inbox(id, user_id, text, created_at)` 离线通知（每用户上限 100 条）、
  `kv(key, value)` 渠道杂项状态（飞书 chat_id 映射等）。
  启动时若发现旧版 `data/store.json` 自动迁移自选股并改名为 `.migrated`。
  公开 `close()` 方法供测试/优雅退出释放句柄。
- **代码位置**：[src/storage/store.ts](../src/storage/store.ts)
- **改动入口**：存新数据 → 建新表 + 对应读写方法（保持同步方法风格，node:sqlite 全同步 API）
- **注意事项**：node:sqlite 在 Node 24 仍打印 ExperimentalWarning（功能可用，忽略即可）；
  `prepare().run()` 返回的 `changes` 可能是 bigint，比较前用 `Number()` 包一层；
  单文件锁解决了多实例互踩（原 STATUS P7），但仍不建议多实例同时写。

## 18. 配置与启动装配

- **实现方式**：全部配置来自 `.env`（dotenv），集中在 `config.ts` 一个对象里导出，
  代码里禁止直接读 `process.env`。**数值型配置统一走 `numEnv(name, def, min)`**：
  非有限数或越界回退默认并打警告（防 setTimeout(0) 热循环等误配事故，审计 A-501/A-405）。
  `src/index.ts` 是装配层：Store → DataProvider → Agent → Channels → Scheduler →
  HealthProbe → Express listen；`GET /health` 暴露数据源、技能清单与探针状态；
  含进程级兜底（unhandledRejection/uncaughtException 记日志、Express 错误中间件）
  与 SIGINT/SIGTERM 优雅退出（server.close + store.close）。
- **代码位置**：[src/config.ts](../src/config.ts)、[src/index.ts](../src/index.ts)、
  环境变量说明 `.env.example`
- **改动入口**：加配置 → config.ts 加字段（数值走 numEnv） + `.env.example` 加中文注释
- **注意事项**：项目是 ESM（`"type": "module"`），相对 import 必须带 `.js` 后缀（PITFALLS.md 工具链条目）。

## 19. 测试基座（vitest，2026-09-14 新增）

- **实现方式**：vitest 3.x（零配置文件，默认 node 环境 + Vite 内置 NodeNext 解析，
  直接 import src 下的 TS 模块）；`npm test` = `vitest run`。
  现有 56 条单测（6 个文件）：
  `tests/eastmoney.test.ts`（toSecid 规则含北交所 920 段、行情解析 ÷100 / `"-"` / NaN 处理 / Referer，fetch 全 mock）、
  `tests/search.test.ts`（search_stock 入参校验与格式化，mock ctx）、
  `tests/store.test.ts`（真实 SQLite 往返：自选股/历史/收件箱/kv，`DATA_DIR` 指向临时目录隔离，Store.close() 清理）、
  `tests/history.test.ts`（trimHistory 裁剪规则：截断/预算/孤儿 tool 消息）、
  `tests/scheduler.test.ts`（beijingNow/msUntilNextRun/isTradingTime，vi.setSystemTime 冻结时间）、
  `tests/fixtures.test.ts`（东财真实响应 fixture 回放，fixture 在 `tests/fixtures/eastmoney/`）。
- **代码位置**：[tests/](../tests/)、`package.json` 的 `test` script
- **改动入口**：加测试 → `tests/*.test.ts` 直接加文件；外部接口层用 mock fetch /
  录制 fixture（录制方法见 `tests/fixtures/eastmoney/README.md`），不打真实网络
- **注意事项**：typecheck 走 `tsconfig.typecheck.json`（含 tests/），构建仍走
  `tsconfig.json`（只含 src/）；Windows 下 Store 不关连接会导致临时目录删不掉，
  用公开 `close()` 清理（PITFALLS.md 工具链条目）。

## 20. 股票浏览页 + 个股详情页（F1/F2，2026-09-15 新增）

- **实现方式**：`/stocks` 单文件 SPA（无框架、无 CDN，原生 HTML/CSS/JS），
  URL query 区分视图（`?code=` 为详情页，pushState/popstate 路由）。
  列表视图：自选股圆角卡片（一行一只）+ 顶部防抖搜索（结果同款卡片，可一键加自选）；
  详情视图：行情卡（开/高/低/昨收四格）+ 手写 SVG 收盘折线图（渐变填充、网格线、
  hover 十字线 + tooltip、近1月/3月/6月/1年 区间切换）+ 新闻/公告/财报 Tab。
  设计系统抽在 `public/shared/theme.css`（CSS 变量 + 通用组件类），webchat 与 stocks 共用；
  口令鉴权为卡片式浮层（localStorage `cnstockbot_token`/`cnstockbot_uid`，与 webchat 互通）。
- **代码位置**：页面 [public/stocks/index.html](../public/stocks/index.html)、
  设计系统 [public/shared/theme.css](../public/shared/theme.css)、
  API [src/channels/webchat.ts](../src/channels/webchat.ts)（`GET/POST/DELETE /api/watchlist`、
  `GET /api/stocks/:code`、`:code/history`、`/api/search`，全部在 `/api` 口令中间件后）
- **改动入口**：改卡片/图表样式 → stocks/index.html 的 `<style>` 与 drawChart()；
  改配色/圆角/阴影全局风格 → theme.css 变量；改 API 契约 → webchat.ts + 前端同步改
- **注意事项**：前端所有接口文本一律 `textContent` 渲染（防 XSS）；
  详情聚合四块（行情/新闻/公告/财报）`Promise.allSettled` 独立降级，单块失败不影响其他块；
  停牌股在列表中显示 `{code, error}` 而非消失（getQuote 抛错是设计行为，PITFALLS）。

## 21. 历史 K 线数据（getHistory，2026-09-15 新增）

- **实现方式**：`DataProvider.getHistory(code, days)`（可选方法，返回 `HistoryBar[]`
  日期升序：date/open/close/high/low/volume/changePct）→ 微服务 `/history/{code}?days=`
  → `ak.stock_zh_a_hist(period="daily", adjust="qfq")`（东财前复权日 K）；
  **东财失败（含超时）自动降级新浪 `ak.stock_zh_a_daily`**（sh/sz 前缀），新浪无涨跌幅列
  时用收盘价环比补算。start_date 按日历日 2×days 前推后取尾部，保证凑满交易日条数。
- **代码位置**：[data-service/main.py](../data-service/main.py) 的 `/history` 端点与
  `_hist_items()` 归一化、[src/data/pythonService.ts](../src/data/pythonService.ts)、
  接口定义 [src/data/provider.ts](../src/data/provider.ts)（`HistoryBar`）
- **改动入口**：加字段（如成交额/换手率）→ main.py `_hist_items` 映射 + provider.ts
  `HistoryBar` + 前端 chart；换复权方式 → 端点 `adjust` 参数（hfq/qfq/空）
- **注意事项**：东财 push2his 与 push2 限流独立，可能实时行情正常而历史接口被掐
  （降级链即为此设计，PITFALLS.md Python 条目）；新浪源不覆盖北交所；
  东财直连模式（无微服务）下 `getHistory` 不存在，API 返回 503 提示。

## 22. 前端共享设计系统（theme.css，2026-09-15 新增）

- **实现方式**：ShadcnUI 风格单一 CSS 文件（无构建）：CSS 变量定义黑白灰色板 +
  indigo CTA 强调色 + A 股红涨绿跌语义色，通用组件类（.card/.btn/.input/.badge/
  .skeleton/.auth-overlay）。经 `express.static('/shared')` 提供，webchat 与 stocks
  两页 `<link>` 引入后只写页内少量特有样式。
- **代码位置**：[public/shared/theme.css](../public/shared/theme.css)
- **改动入口**：全局风格（色板/圆角/阴影/字号层级）→ 改 `:root` 变量与组件类；
  新页面 → 引入 theme.css 并复用组件类，不要另起色板
- **注意事项**：离线约束——禁止 CDN/外链资源（图表手写 SVG、无框架）；
  `--up`/`--down` 是 A 股红涨绿跌语义色，只用於行情数据，不要当 UI 强调色用。
