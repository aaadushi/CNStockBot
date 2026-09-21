# 功能实现手册（FEATURES）

> **本文件的用途**：修改某个功能前，先在这里找到它——用什么方法/技术实现的、
> 代码在哪几个文件、改的时候要动哪里。每个功能一节，结构固定：
> **实现方式 → 代码位置 → 改动入口 → 注意事项**。
>
> **新增功能时必须在本文档追加一节**；功能删除时移除对应节。
> 功能现状（能用/待做/有问题）看 [STATUS.md](STATUS.md)，原理性架构看
> [ARCHITECTURE.md](ARCHITECTURE.md)，报错排查看 [PITFALLS.md](PITFALLS.md)。

最后更新：2026-09-21

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
  格式化为带涨跌 emoji 的多行文本。**2026-09-15 起输出含估值与规模（F3-1）**：
  总市值/流通市值（元→亿/万亿格式化）、市盈率(TTM)/市净率——字段缺失（亏损股 PE、
  数据源降级等）时对应行整条不显示。**同日起含成交活跃度（F3-3）**：成交额（元→亿）、
  换手率（%）、量比——同样缺失整条不显示。
- **代码位置**：[src/skills/bundled/quote/index.ts](../src/skills/bundled/quote/index.ts)、
  数据层 [src/data/eastmoney.ts](../src/data/eastmoney.ts)
- **改动入口**：改输出格式 → 技能 `execute`；改行情字段/数据源 → eastmoney.ts
- **注意事项**：价格字段东财放大 100 倍（已除）；停牌/退市返回 `"-"` 会抛错，
  属设计行为（PITFALLS.md）。

## 5. 新闻查询（get_stock_news）

- **实现方式**：调 `DataProvider.getNews(code, limit, sort)` → Python 微服务 `/news/{code}`
  → `ak.stock_news_em()`，limit 上限 20。**排序可选**（2026-09-15）：`sort=hot`（默认）
  保留东财相关度/热度原序；`sort=time` 按发布时间倒序（先全量排序再截 limit，
  先截再排会漏掉更新的新闻）。浏览页详情的新闻 Tab 有"热度/最新"切换 pill，
  走单块端点 `GET /api/stocks/:code/news?sort=`，前端按 code+sort 缓存。
- **代码位置**：[src/skills/bundled/news/index.ts](../src/skills/bundled/news/index.ts)、
  [src/data/pythonService.ts](../src/data/pythonService.ts)、[data-service/main.py](../data-service/main.py) 的 `/news` 端点
- **改动入口**：换新闻源/加字段 → main.py 端点 + provider.ts 的 `NewsItem` 接口 + 技能格式化；
  改排序行为 → 端点 `sort` 参数 + provider.ts 的 `NewsSort` 类型
- **注意事项**：微服务未启动时技能报错文本含启动提示（`src/data/index.ts` CompositeProvider 包装）；
  交易所正式公告不归本技能管，见下一节 get_stock_announcements。

## 6. 公告查询（get_stock_announcements，2026-09-14 新增）

- **实现方式**：调 `DataProvider.getAnnouncements(code, limit)` → Python 微服务
  `/announcements/{code}`。**双源降级链**（2026-09-15 加）：首选巨潮资讯
  `ak.stock_zh_a_disclosure_report_cninfo()`（沪深京市场，默认近 30 天）；
  巨潮失败（非 JSON/限流/超时）自动降级东财 `ak.stock_individual_notice_report()`
  ——该接口无日期参数、全量翻页（约 1 页/秒），超时放宽 180s + 全量结果按代码
  缓存 6 小时，days/limit 本地过滤。limit 上限 20，微服务侧上限 50。
- **代码位置**：[src/skills/bundled/announcement/](../src/skills/bundled/announcement/)、
  [src/data/pythonService.ts](../src/data/pythonService.ts)、
  [data-service/main.py](../data-service/main.py) 的 `/announcements` 端点与
  `_announcements_em_fallback()`
- **改动入口**：调查询时间窗 → 端点 `days` 参数（默认 30，上限 365）；
  按类别筛选 → `category` 参数（**仅巨潮源支持**，降级到东财时忽略）
- **注意事项**：巨潮结果为空时部分 AKShare 版本抛 `KeyError`，端点已捕获返回空列表；
  主服务侧 60s 超时下，东财降级首次未缓存的大盘股请求可能 504，缓存命中后恢复；
  CLAUDE.md 旧版写的 `ak.stock_notice_report` 是按日期查全市场公告的接口，不要误用。

## 7. 财报查询（get_stock_financials，2026-09-14 新增）

- **实现方式**：调 `DataProvider.getFinancials(code, limit)` → Python 微服务
  `/financials/{code}` → `ak.stock_financial_abstract()`（新浪财经财务摘要，
  按报告期倒序，默认 4 期）。**返回结构随 AKShare 版本分叉**（2026-09-15 兼容）：
  旧版长表（行=报告期）按 col_map 直接取；1.18.94+ 宽表（行=指标、列=报告期）
  走 `_financials_wide()` 透视，优先"常用指标"组取行。参数名同样分叉
  （stock/symbol 双兼容）。技能把各期关键指标格式化成文本回给 LLM，由 LLM 做趋势解读
  （SYSTEM_PROMPT 的免责声明规则自动覆盖）。
- **代码位置**：[src/skills/bundled/financials/](../src/skills/bundled/financials/)、
  [src/data/pythonService.ts](../src/data/pythonService.ts)、
  [data-service/main.py](../data-service/main.py) 的 `/financials` 端点与 `_financials_wide()`
- **改动入口**：增删指标字段 → 端点 rows_map/col_map + provider.ts 的
  `FinancialReport` 接口 + 技能格式化；要数值计算（如同比）→ 先做数值清洗
  （旧版带"元"后缀+千分位逗号，新版是裸数字字符串，两者格式不同）
- **注意事项**：新版宽表指标集**没有**"资产总计/长期负债合计/财务费用"，
  对应新增 netAssets/roe/eps 字段；结构变更可静默全空不报错（PITFALLS 2026-09-15 条目），
  改接口后必须抽查字段值；部分股票历史数据被新浪截断。

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
  **估值与规模字段（F3-1，2026-09-15）**：东财 f162/f163/f164/f167（PE 动/静/TTM、PB，
  放大 100 倍）+ f116/f117（总/流通市值，单位元**不放大**）；腾讯下标 39/52/53/46
  （PE TTM/动/静、PB）+ 44/45（流通/总市值，单位亿元×1e8）。缺失/`"-"`/非正值置 undefined。
  **成交活跃度字段（F3-3，2026-09-15）**：东财 f47 成交量（手）/f48 成交额（元，浮点）
  **不缩放** + f168 换手率/f50 量比（放大 100 倍）；腾讯下标 6（手）/37（成交额万元×1e4）/
  38（换手率%）/49（量比），空串缺失先判空再转数值（`Number('') === 0` 坑），0 是合法值。
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
     **2026-09-19 起附加技术面信号摘要（F5-3）**：`buildSignalSection()` 对每只自选股
     并发调 `data.getIndicators()`（复用 F5-1 端点，默认 250 天），只列出有客观信号
     的股票（金叉/死叉/站上跌破 MA60/突破布林轨/RSI6 超买超卖，文案直接复用端点
     `signals[].text`），单股最多 3 条（`MAX_SIGNALS_PER_STOCK`）防刷屏；
     全区标注"客观状态描述，非买卖建议"。降级规则：全部无信号且零失败 → 信号区整段
     不出现；数据源无 `getIndicators`（纯东财直连）或全部失败 → 一行降级说明；
     单股指标失败 → 其余照常 + "N 只获取失败已跳过"注记。`DAILY_REPORT_SIGNALS=false`
     可整体关闭（`config.dailyReport.signals`）。`buildDailyReport` 已导出供单测
     （`tests/dailyReport.test.ts`）。
  2. **异动提醒**（2026-09-14 新增）：盘中（9:30-11:30 / 13:00-15:00）每 N 分钟
     （`ALERT_INTERVAL_MINUTES`，默认 5）轮询——先汇总全部用户的自选股**去重后并发拉行情**
     （避免多用户重复请求东财），涨跌幅绝对值超阈值（`ALERT_THRESHOLD_PCT`，默认 ±5%）
     即推送；`alerted` 集合按 `${日期}:${代码}` 去重，**每股每日只报一次**，跨天自动清空。
     **2026-09-19 起同一轮询并入自定义多条件规则（F5-4，详见第 32 节）**：用户集合扩为
     "有自选股 ∪ 有启用规则"，规则代码并入去重拉行情集合；阈值命中与规则触发合并为
     一条推送（两段分区），推送成功才统一写去重标记。
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
  详情视图：行情卡（开/高/低/昨收四格 + **估值规模第二行**：总市值/流通市值/PE(TTM)/PB，
  PE(TTM) 缺失时降级显示 PE(动) 并标注口径，F3-1 + **成交活跃度第三行**：成交额/换手率/
  量比，F3-3）+ **公司资料卡**（行业/上市日期/总股本/流通股，F3-2，见第 26 节）+
  手写 SVG 收盘折线图（渐变填充、网格线、hover 十字线 + tooltip、近1月/3月/6月/1年
  区间切换）+ **成交量副图**（F3-3：价格区下方红涨绿跌柱，柱高按区间最大成交量归一，
  tooltip 加成交量/成交额/换手率）+ 新闻/公告/财报 Tab。
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
  日期升序：date/open/close/high/low/volume/changePct，**F3-3 起东财源另透出
  amount 成交额（元）/turnover 换手率（%）可选字段**）→ 微服务 `/history/{code}?days=`
  → `ak.stock_zh_a_hist(period="daily", adjust="qfq")`（东财前复权日 K）；
  **东财失败（含超时）自动降级新浪 `ak.stock_zh_a_daily`**（sh/sz 前缀），新浪无涨跌幅列
  时用收盘价环比补算、无成交额/换手率列则不输出该字段，**成交量按股返回、端点 ÷100
  归一到手**（与东财源口径一致）。start_date 按日历日 2×days 前推后取尾部，保证凑满交易日条数。
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

## 23. 全市场涨跌榜（/market，2026-09-15 新增）

- **实现方式**：与自选股页（/stocks）平行的独立页面——全市场今日涨幅榜/跌幅榜/平盘
  三 Tab + 涨跌平家数总览卡，每榜前 50 条（limit 上限 100），点卡片跳 /stocks?code= 详情页。
  数据链路：`GET /api/market/movers?limit=`（口令鉴权后）→ `DataProvider.getMovers()`
  → 东财 clist 排行榜（`push2 /api/qt/clist/get`，fid=f3 按涨跌幅排序，`fltt=2` 价格**不缩放**）
  + ulist 涨跌平家数统计（`/api/qt/ulist.np/get`，secids=1.000001,0.399001,0.899050
  沪深京三市 f104/f105/f106 求和）。**平盘定位**是主要难点：clist 不支持按值筛选，
  且停牌股（f3="-"）与平盘混排在零区，实现为二分查找"末条不再为正"的第一页
  （零区起点）再向后最多扫 3 页收集 f3 恰为 0 的（大页长 200 减少请求数）。
  **宿主降级**：push2 被 IP 限流时自动切 push2delay 同构接口（延时约 15 分钟，
  响应带 `delayed: true`，页面在数据时间后标注）；结果进程内缓存 60s 防刷新刷限流。
  不依赖 data-service；腾讯无对应榜单接口，故不走腾讯降级。
- **代码位置**：页面 [public/market/index.html](../public/market/index.html)、
  API [src/channels/webchat.ts](../src/channels/webchat.ts)（`/api/market/movers`）、
  数据层 [src/data/eastmoney.ts](../src/data/eastmoney.ts)（`getMovers`/`fetchClistRaw`/
  `fetchMoverCounts`）、接口 [src/data/provider.ts](../src/data/provider.ts)（`MarketMovers`/`MoverItem`）
- **改动入口**：改每榜条数 → 前端 `LIMIT` 与 API limit 上限；改缓存时长 →
  `MOVERS_CACHE_MS`；加榜单（如振幅榜）→ clist 换 fid 排序字段即可
- **注意事项**：clist 的 f2/f3 在 `fltt=2` 下不缩放，与报价接口 ×100 规则相反，别混用；
  停牌股混排零区是实测行为（PITFALLS 东财条目），改平盘定位逻辑前先读；
  测试用合成全市场 mock（`tests/movers.test.ts` 的 `clistHandler`），改请求模式要同步改。

## 24. 财经快讯版块（/news + get_market_news，F4-A，2026-09-15 新增）

- **实现方式**：全市场财经快讯（宏观/政策/外围市场/行业动态的滚动资讯流），区别于
  个股新闻（第 5 节）。数据链路：`GET /api/market/news?limit=`（口令鉴权后，上限 50）
  → `DataProvider.getMarketNews()`（可选方法，返回 `MarketNewsItem[]`：
  title/summary/url/publishTime/source）→ 微服务 `GET /market-news?limit=` →
  **双源降级**：主源东财 `ak.stock_info_global_em()`（约 200 条，列：标题/摘要/发布时间/链接，
  含 URL），失败（含超时）自动降级财联社 `ak.stock_info_global_cls()`（约 20 条，无 URL，
  短快讯"标题"列常为空，取"内容"前 60 字充任标题）；发布时间倒序，进程内缓存 90s。
  聊天技能 `get_market_news`：无股票代码参数，limit 默认 10/上限 30（`normalizeLimit`），
  与 `get_stock_news` 的触发分工写在 SKILL.md，SYSTEM_PROMPT 有 routing 引导（规则 4）。
  网页 `/news` 单文件 SPA：时间倒序列表（标题 + 摘要 + 时间 + 来源，有 URL 可点击
  新窗口打开），60s 自动刷新 + 手动刷新按钮 + 数据更新时间；复用 theme.css 与口令
  鉴权浮层；/stocks 与 /market 页头加"📰 快讯"导航。
- **代码位置**：端点 [data-service/main.py](../data-service/main.py) 的 `/market-news` 与
  `_market_news_from_em/_from_cls`、技能 [src/skills/bundled/marketnews/](../src/skills/bundled/marketnews/)、
  页面 [public/news/index.html](../public/news/index.html)、
  API [src/channels/webchat.ts](../src/channels/webchat.ts)（`/api/market/news`）、
  接口 [src/data/provider.ts](../src/data/provider.ts)（`MarketNewsItem`）
- **改动入口**：换快讯源/加源 → main.py 端点降级链；改缓存时长 → `_MARKET_NEWS_TTL`；
  改网页刷新间隔 → public/news/index.html 的 `AUTO_REFRESH_MS`
- **注意事项**：财联社降级源无 URL（`url` 为空串），前端据此渲染为纯文本块而非链接；
  东财直连模式（无微服务）下 `getMarketNews` 不存在，API 返回 503、技能返回降级提示；
  微服务停掉时 CompositeProvider 包装的错误含启动提示；测试见 `tests/marketNews.test.ts`
  （fetch 全 mock）。

## 25. 基金版块（F4-B，2026-09-15 新增）

- **实现方式**：对标支付宝财富页的基金内容，数据源为天天基金（东财系，与支付宝同源），
  全部经 data-service（AKShare）暴露，列结构均经 akshare 1.18.94 实测。四个端点：
  `/funds/rank?type=&limit=`（`fund_open_fund_rank_em` 开放式基金排行，按近1年收益率降序，
  type 白名单：全部/股票型/混合型/债券型/指数型/QDII/FOF，按类型缓存 10 分钟）；
  `/funds/search?keyword=`（`fund_name_em` 全量基金代码表约 2.8 万行，缓存 24h，
  支持名称/代码/拼音缩写打分排序，复用股票搜索模式）；
  `/funds/{code}?days=`（`fund_open_fund_info_em` 单位净值走势，日期升序，按代码缓存 6h，
  名称/类型从全量代码表解析）；`/funds/etf?limit=`（`fund_etf_spot_em` 场内 ETF 全量
  实时快照，全量翻页 30s+ 故 run_ak 超时放宽 120s + 结果缓存 60s）。
  **FastAPI 路由顺序注意**：`/funds/{code}` 必须声明在 rank/search/etf 之后，否则被当 code 匹配。
  主服务侧 `DataProvider` 加 `FundRankItem/FundSearchItem/FundInfo/EtfQuote`（区间收益缺失
  为 null，展示为 —），CompositeProvider 接线（微服务未启动时技能返回带启动提示的文本）。
- **聊天技能**：`get_fund_rank`（按类型排行，limit 归一化 ≤50）、`get_fund_info`
  （参数支持 6 位代码或名称关键词——名称先走 `/funds/search` 解析再查详情）。
- **网页**：`public/funds/` 单文件 SPA——基金排行类型 Tab + 场内 ETF Tab + 防抖搜索
  （同款卡片结果）+ `?code=` 详情视图（净值信息 + 单位净值走势图，复用 stocks 页手写
  SVG 折线组件带区间切换与 hover tooltip）；复用 theme.css 与口令鉴权浮层；
  API 走 `GET /api/funds/*`（webchat.ts，全部在口令鉴权后）；/stocks 与 /market 页头互加导航。
- **代码位置**：端点 [data-service/main.py](../data-service/main.py)（"基金版块（F4-B）"节）、
  接口 [src/data/provider.ts](../src/data/provider.ts)、客户端 [src/data/pythonService.ts](../src/data/pythonService.ts)、
  技能 [src/skills/bundled/fundrank/](../src/skills/bundled/fundrank/) 与
  [fundinfo/](../src/skills/bundled/fundinfo/)、页面 [public/funds/](../public/funds/)、
  API [src/channels/webchat.ts](../src/channels/webchat.ts)、测试 [tests/funds.test.ts](../tests/funds.test.ts)
- **改动入口**：加基金类型 → 端点白名单 + 技能 `FUND_TYPES` 同步；加排行字段 → 端点映射 +
  `FundRankItem` + 前端卡片；调缓存时长 → main.py 各 `_FUND_*_TTL` 常量
- **注意事项**：`fund_etf_spot_em` 耗时 30s+，主服务客户端 60s 超时，首次未缓存请求可能
  刚好踩线（缓存命中后恢复，PITFALLS 已记录）；新基金区间收益字段为 null 不是 bug；
  单只 ETF 行情不走东财 push2 复用路径（push2 对本机限流中未实测，统一走微服务）。

## 26. 公司资料（F3-2，2026-09-15 新增）

- **实现方式**：`DataProvider.getProfile(code)`（可选方法，返回 `CompanyProfile`：
  code/name/industry/listingDate/totalShares/floatShares）→ 微服务 `/profile/{code}`。
  数据源降级链：AKShare `stock_individual_info_em`（东财 push2，item/value 两列，
  中文 key 反查回 f 编码后统一归一化）→ **push2delay 同构直连**（限流期实测字段一致；
  公司资料是近静态信息，不受 15 分钟延时影响）。结果按代码缓存 24h。
  字段口径：f84 总股本 / f85 流通股（单位股，不放大）/ f127 行业 / f189 上市时间
  （yyyymmdd → YYYY-MM-DD）；`"-"`（停牌/退市/已切换代码）置 null 而非 0。
- **落点**：详情页行情卡下方"公司资料"卡（所属行业/上市日期/总股本/流通股四格，
  股本格式化为 亿/万股；数据与错误均无时整块隐藏）；`/api/stocks/:code` 聚合加
  profile/profileError 块（第五块，同样 allSettled 独立降级）。
- **代码位置**：端点 [data-service/main.py](../data-service/main.py)（"公司资料（F3-2）"节，
  `_secid_for/_f_opt/_profile_from_fields/_profile_via_delay_host`）、
  接口 [src/data/provider.ts](../src/data/provider.ts)（`CompanyProfile`）、
  客户端 [src/data/pythonService.ts](../src/data/pythonService.ts)、
  页面 [public/stocks/index.html](../public/stocks/index.html)（`renderProfile`）、
  测试 [tests/pythonService-profile.test.ts](../tests/pythonService-profile.test.ts)
- **改动入口**：加资料字段（如董事长/办公地址）→ main.py fields 参数 + 归一化 +
  `CompanyProfile` + 前端 stats 数组；调缓存 → `_PROFILE_TTL`
- **注意事项**：AKShare 主源 secid 规则只看 `6` 开头（900 开头沪 B 会被分到深市导致
  无数据，此时自动落到 push2delay 降级，其 `_secid_for` 与主服务 toSecid 规则一致）；
  旧北交所代码（4/8 段）切换到 920 段后旧代码返回全 `"-"`，属上游行为不是 bug。

## 27. 资金流向（F3-4，2026-09-15 新增）

- **实现方式**：`DataProvider.getFundFlow(code, days?)`（可选方法，返回 `FundFlow`：
  `{code, source, items: FundFlowDay[]}`，items 日期升序）→ 微服务 `/fund-flow/{code}?days=`
  （默认 30、上限 100，按代码缓存 60s）。数据源降级链：AKShare
  `stock_individual_fund_flow(stock, market)`（东财 push2his fflow/daykline，
  主力/超大单/大单/中单/小单五档净流入 + 占比）→ **新浪 MoneyFlow 直连**
  （`MoneyFlow.ssl_qsfx_zjlrqs`，AKShare 未封装）：仅"净流入 + 超大单"两档，
  **口径与东财不同**（新浪"净流入"含全部资金 ≠ 东财"主力净流入"），响应 `source`
  字段（eastmoney/sina）供前端/调用方标注口径；新浪不覆盖北交所，bj 代码双源失败合并报错。
  字段口径：东财百分数字段已是 % 单位（push2delay 同构接口实测核对，该镜像只回当日 1 行、
  不能作历史降级源）；新浪 changeratio/ratioamount/r0_ratio 是小数、端点 ×100 转百分数；
  数值字段缺失（列名漂移）置 null 而非 0。`FundFlowDay` 的大/中/小单三字段仅东财源输出。
  market 参数映射：4/8/920 → bj（**920 须先于 "9" 判断**）、6/9 → sh、其余 → sz。
- **落点**：详情页公司资料卡下方"资金流向"卡（最新交易日各档净流入汇总格，带符号 亿/万
  格式化、流入红/流出绿；近 15 日主力净流入柱状图：零线上下红绿柱 + hover 分档 tooltip；
  新浪源时"主力净流入"标签改"净流入"并在卡底注明口径差异；数据与错误均无时整块隐藏）；
  `/api/stocks/:code` 聚合加 fundFlow/fundFlowError 块（第六块，allSettled 独立降级，
  30 天窗口）。
- **代码位置**：端点 [data-service/main.py](../data-service/main.py)（"资金流（F3-4）"节，
  `_fund_flow_market/_fund_flow_from_em/_fund_flow_via_sina`）、
  接口 [src/data/provider.ts](../src/data/provider.ts)（`FundFlowDay`/`FundFlow`）、
  客户端 [src/data/pythonService.ts](../src/data/pythonService.ts)、
  页面 [public/stocks/index.html](../public/stocks/index.html)（`renderFundFlow`/
  `drawFundFlowChart`/`fmtFlow`）、
  测试 [tests/pythonService-fundflow.test.ts](../tests/pythonService-fundflow.test.ts)
- **改动入口**：加分档字段 → AKShare 列名 + `_fund_flow_from_em` + `FundFlowDay` +
  前端 cells/tooltip；调缓存 → `_FUND_FLOW_TTL`；F6-2 资金流验货复用本端点
- **注意事项**：主源走 push2his，与 /history 东财源同宿主——限流状态联动（本机 2026-09-15
  仍在封禁，五档列名为 AKShare 源码口径未实测，漂移时降级为 null）；腾讯 `ff_` 资金流接口
  已下线（`v_pv_none_match`，勿再尝试，见 PITFALLS）。

## 28. 分时数据（F3-5，2026-09-16 新增）

- **实现方式**：`DataProvider.getIntraday(code)`（可选方法，返回 `Intraday`：
  `{code, date, source, points: IntradayPoint[]}`，points 时间升序，含 time(HH:MM)/
  price/volume(手)，有成交额列时附 amount 与 avgPrice）→ 微服务 `/intraday/{code}`
  （按代码缓存 60s）。数据源降级链：AKShare `stock_zh_a_hist_min_em(symbol, period="1",
  adjust="")`（东财 push2his 当日 1 分钟 K）→ **新浪 `stock_zh_a_minute`**（symbol 带
  sh/sz/bj 前缀，**bj 北交所实测覆盖**——与日 K/资金流的新浪降级源不同）：返回近约 8 个
  交易日分钟数据，端点只保留最近一个交易日；**新浪成交量单位是股**（与日 K 一致），
  端点 ÷100 归一到手。分时均价 avgPrice = 累计成交额 ÷ 累计成交量（股），即 VWAP，
  两源都有成交额列故两源都输出；成交额列名漂移时整条不输出 amount/avgPrice（不静默发错值）。
  按 date 过滤用 `pd.to_datetime(errors="coerce")`，防列类型漂移。
- **落点**：详情页走势图卡加"分时 | 日K"切换 pill（默认分时，日K 模式下才显示区间 pill）；
  分时图为价格折线 + 渐变填充 + 昨收参考虚线 + VWAP 均价虚线（琥珀色）+ 成交量副图
  （红绿按相对前一分钟涨跌）+ hover tooltip（时间/价格+涨跌幅/均价/成交量），
  图下注明数据日期与数据源（新浪降级源标注）。昨收取自详情聚合 quote 块，quote 失败时
  退化为首价基准不阻塞图表。主服务新增 `GET /api/stocks/:code/intraday`（口令鉴权后）。
- **代码位置**：端点 [data-service/main.py](../data-service/main.py)（"分时数据（F3-5）"节，
  `_intraday_from_df`）、接口 [src/data/provider.ts](../src/data/provider.ts)
  （`IntradayPoint`/`Intraday`）、客户端 [src/data/pythonService.ts](../src/data/pythonService.ts)、
  API [src/channels/webchat.ts](../src/channels/webchat.ts)、
  页面 [public/stocks/index.html](../public/stocks/index.html)（`loadIntraday`/`drawIntraday`/
  `chartMode`/mode-pills）、测试 [tests/pythonService-intraday.test.ts](../tests/pythonService-intraday.test.ts)
- **改动入口**：调缓存 → `_INTRADAY_TTL`；加分时字段 → 两源 cols 映射 + `_intraday_from_df`
  + `IntradayPoint` + 前端 tooltip；F5/F6 的盘中信号可复用本端点
- **注意事项**：主源走 push2his，与 /history、/fund-flow 东财源同宿主——限流状态联动
  （本机 2026-09-16 仍在封禁，东财源列名为 AKShare 文档口径未实测，漂移时
  time/price/volume 缺失会跳过该行、amount 缺列则 avgPrice 不输出）；新浪源首个分钟 bar
  （09:31）的成交额含集合竞价，avgPrice 首点可能偏离首价，属上游口径不是 bug。

## 29. 涨跌停价 / 52 周高低 / 分红送配（F3-6，2026-09-16 新增）

- **涨跌停价与 52 周高低（走 Quote，不依赖微服务）**：`Quote` 新增可选字段
  limitUp/limitDown/week52High/week52Low。东财 push2 字段 f51 涨停价 / f52 跌停价 /
  f174 52周最高 / f175 52周最低——**均放大 100 倍**（2026-09-16 经 push2delay fltt=2
  不缩放响应与默认缩放响应交叉实测核对一致），复用 priceField 解析（"-" 置 undefined）。
  腾讯降级源 47=涨停价 / 48=跌停价（不缩放，与东财实测一致，opt() 解析）；
  **腾讯无 52 周字段**，降级时缺失，前端显示 —。
- **分红送配（微服务）**：data-service `GET /dividends/{code}?limit=`（默认 10、上限 50，
  按代码缓存 6h——分红是低频事件）→ AKShare `stock_history_dividend_detail(symbol,
  indicator="分红")`（东财数据源）。口径：**送股/转增/派息均为每 10 股**（派息单位元，
  税前）。日期列 NaT/None 置 null；列名漂移时 row.get 得 None 输出 null 不补 0。
  **无效代码上游返回空表，端点回 200 []**（与"从未分红"无法区分，不是错误）。
  `DataProvider` 加 `DividendRecord` 与 `getDividends`，CompositeProvider 接线。
- **落点**：详情页行情统计格加涨停价/跌停价/52周最高/52周最低四格；
  资金流卡下方新增"分红送配"卡（公告日期/除权除息日/每10股派息/送股/转增/进度
  六列表格，0 值显示 —，卡下注明每 10 股口径与免责声明）；
  `/api/stocks/:code` 聚合扩为七块（+dividends/dividendsError 独立降级）。
  **未进对话技能输出**（路线图落点仅为详情页；若需要可在 quote 技能格式化中补行）。
- **代码位置**：字段解析 [src/data/eastmoney.ts](../src/data/eastmoney.ts) /
  [src/data/tencent.ts](../src/data/tencent.ts)、接口 [src/data/provider.ts](../src/data/provider.ts)、
  端点 [data-service/main.py](../data-service/main.py)（"分红送配（F3-6）"节）、
  客户端 [src/data/pythonService.ts](../src/data/pythonService.ts)、
  API [src/channels/webchat.ts](../src/channels/webchat.ts)（pickQuote + 聚合七块）、
  页面 [public/stocks/index.html](../public/stocks/index.html)（renderQuote 统计格 /
  renderDividends / dividend-card）、测试 [tests/pythonService-dividends.test.ts](../tests/pythonService-dividends.test.ts)
  + eastmoney/tencent/fixtures 三处新用例（fixture 自 push2delay 重录含新字段）
- **改动入口**：调缓存 → `_DIVIDEND_TTL`；加送配字段 → 端点 items 映射 + `DividendRecord`
  + 前端表格列；东财字段编码变动 → eastmoney.ts 顶部注释清单先核对 push2delay

## 30. 技术指标分析（F5-1，2026-09-16 新增）

- **数据层（纯本地计算，无新外部依赖）**：data-service `GET /indicators/{code}?days=`
  （默认 250、上限 1500）。先把原 `/history` 的取数降级链抽成共用函数 `_load_bars(code, days)`
  （东财 stock_zh_a_hist → 新浪 stock_zh_a_daily，返回 `(bars, source)`），`/history` 与
  `/indicators` 同源同降级。指标全部由 pandas 在归一化日 K 上计算：MA(5/10/20/60)、
  EMA(12/26)、MACD（柱 = 2×(DIF−DEA)，国内惯例）、RSI(6/12/24，Wilder 平滑）、
  KDJ(9,3,3 递推平滑）、BOLL(20,2，总体标准差 ddof=0）——完整口径见 DATA_SOURCES.md
  "技术指标本地计算"节。响应四块：`latest`（最新交易日各指标值，周期不足为 null）、
  `keyLevels`（支撑/压力位：近 120 日分形高低点 + 区间极值，3% 容差聚类，收盘下/上方
  最近各至多 2 档）、`signals`（客观状态信号：MA/MACD 金叉死叉、站上/跌破 MA60、
  突破布林轨、RSI6 超买超卖——**仅状态描述，不含买卖建议**）、`series`（与 dates 对齐的
  MA 序列，走势图叠加用）。NaN/Inf 经 `_f3` 一律置 null（防非法 JSON）；历史为空 502。
- **主服务**：`DataProvider` 加 `TechnicalIndicators` 系列类型与 `getIndicators`，
  PythonServiceProvider/CompositeProvider 接线（未启动微服务给带启动提示的错误）；
  新增 `GET /api/stocks/:code/indicators?days=`（口令鉴权后，days 上限 1500）。
  **不进详情聚合七块**——指标面板与均线叠加由前端独立拉取，失败只影响自己（同 history/intraday 模式）。
- **落点（详情页两处）**：① 走势图卡下方新增"技术指标"卡——均线/MACD/RSI/KDJ/BOLL/
  关键价位六个分组格 + 客观信号 chips（统一中性配色，不用红涨绿跌，避免暗示买卖方向）
  + 卡下注明数据日期/数据源/口径与免责声明；② 日 K 走势图叠加 MA5/10/20/60 四条均线
  （琥珀/紫/蓝/灰细线，chart-head 彩色图例，tooltip 附均线值）——指标 series 与 bars
  **按日期对齐**（区间切换不用重拉指标）；指标后到或失败时日 K 图照常画价格线，不阻塞。
  分时模式不叠加均线（均线是日级指标）。
- **代码位置**：端点与计算 [data-service/main.py](../data-service/main.py)（"技术指标（F5-1）"节
  + `_load_bars` 抽取）、接口 [src/data/provider.ts](../src/data/provider.ts)、
  客户端 [src/data/pythonService.ts](../src/data/pythonService.ts)、
  组合源 [src/data/index.ts](../src/data/index.ts)、
  API [src/channels/webchat.ts](../src/channels/webchat.ts)、
  页面 [public/stocks/index.html](../public/stocks/index.html)（indicator-card /
  renderIndicators / maOverlayFor / drawChart MA 叠加）、
  测试 [tests/pythonService-indicators.test.ts](../tests/pythonService-indicators.test.ts)
- **改动入口**：改指标口径 → `_compute_indicators` + DATA_SOURCES.md 同步；改关键价位算法 →
  `_key_levels`（lookback/tol 参数）；加信号 → `_ind_signals`；加均线叠加线 →
  端点 ma 周期集合 + 前端 `MA_DEFS`；F5-2（AI 多维分析）/F5-3（盘后复盘信号摘要）/
  F6-1（形态识别底座）直接复用本端点

## 31. AI 个股多维分析（analyze_stock，F5-2，2026-09-19 新增）

- **定位**：一次对话聚合一只股票的多维数据并交 LLM 解读——不再由 LLM 逐技能多轮调用。
  红线：技能只返回**客观数据快照**（结果头部内嵌"不得给出买卖建议、目标价或收益承诺"的约束），
  解读口径与免责声明由 SYSTEM_PROMPT 规则 5/8 约束（分维度客观陈述、标注缺失维度、
  结尾固定"以上仅供参考，不构成投资建议"）。
- **技能实现**：[src/skills/bundled/analyze/index.ts](../src/skills/bundled/analyze/index.ts)。
  参数仅 `code`；`Promise.allSettled` 并发拉七块——行情/估值（getQuote）、公司资料
  （getProfile）、资金流（getFundFlow，15 天，含近 5 日主力净流入合计）、技术面
  （getIndicators，250 天，复用 F5-1 端点）、基本面（getFinancials，近两期）、
  消息面（getNews，5 条**时间倒序**）、资金流验货（getFlowVerify，F6-2，2026-09-21 加入，
  见第 36 节）。各块独立降级：单块失败/方法缺失
  （data-service 未启动）只在该块标注"暂不可用：原因"，其余块照常返回——
  与详情聚合 /api/stocks/:code 同一模式。新闻用 time 排序（分析看最新动态，
  与详情页默认热度序不同）。
- **SYSTEM_PROMPT 引导**（[src/agent/loop.ts](../src/agent/loop.ts) 规则 5）：
  "分析/全面评价/怎么看/能不能买"→ analyze_stock；只问行情数字 → get_stock_quote，
  避免大材小用（analyze 一次触发 6 个数据调用 + 2 轮 LLM，注意 P8 限流）。
- **详情页入口**（[public/stocks/index.html](../public/stocks/index.html) 技术指标卡下方
  "AI 多维分析"卡）：点击"生成分析"→ **复用 /api/chat 链路**（POST 当前页 localStorage
  userId + "请多维度分析一下{name}（{code}）"），回复渲染在卡内（textContent + pre-wrap）。
  因走 /api/chat，分析结果**同步出现在聊天页会话历史**，可去聊天页追问细节。
  切换股票时清空上一只的结果；请求中禁用按钮防重发；迟到响应按 code 校验丢弃。
- **代码位置**：技能 src/skills/bundled/analyze/（SKILL.md + index.ts）、注册
  [src/skills/registry.ts](../src/skills/registry.ts)、SYSTEM_PROMPT
  [src/agent/loop.ts](../src/agent/loop.ts)、页面 public/stocks/index.html
  （ai-card / runAiAnalysis / renderAi）、测试 [tests/analyze.test.ts](../tests/analyze.test.ts)
- **改动入口**：改聚合维度/每块取数 → analyze/index.ts 的 Promise.allSettled 列表与
  fmt* 格式化函数；改解读口径 → SYSTEM_PROMPT 规则 5；改前端交互 → renderAi/runAiAnalysis

## 32. 多条件监控提醒（manage_alerts，F5-4，2026-09-19 新增）

- **定位**：异动提醒从单一全局涨跌幅阈值升级为**用户可配置的多条件规则**——用户按个股
  自定义触发条件，与全局阈值提醒（对全部自选股生效）互补；规则股票**不要求在自选股里**。
- **领域逻辑（纯函数）**：[src/alerts/rules.ts](../src/alerts/rules.ts)。条件类型三种：
  `price_above`（价格涨到 ≥）/ `price_below`（价格跌到 ≤）/ `change_pct`（涨跌幅绝对值 ≥ %）；
  组合方式 `combinator=any`（任一触发）/ `all`（全部满足）。`validateConditions()` 校验
  LLM 入参（未知类型/非正阈值/超 5 个条件均拒绝并回指引文本），`evaluateRule()` 对 Quote
  求值返回触发条件下标（all 未全触发返回 null；changePct NaN 时 change_pct 不触发），
  `describeCondition/describeRule` 产出中文文案（技能确认与推送共用）。
  **范围裁剪**：指标信号类条件（金叉/超买等）不在盘中轮询——/indicators 基于已完成日 K、
  盘中不变，该类信号由 F5-3 收盘日报信号摘要覆盖。
- **存储**：SQLite `alert_rules(id, user_id, code, combinator, conditions(JSON), enabled,
  created_at)`；Store 新增 addAlertRule/getAlertRules/getEnabledAlertRules/countAlertRules/
  removeAlertRule/setAlertRuleEnabled，全部按 userId 隔离；损坏 JSON 行读取时跳过不抛错；
  每用户上限 `MAX_RULES_PER_USER=20` 条防滥用。
- **技能**：`manage_alerts`（[src/skills/bundled/alerts/](../src/skills/bundled/alerts/)），
  action 白名单 add/list/remove/enable/disable（未知 action 拦截，同 A-201）；add 前验证
  代码存在（停牌股走 search 降级，同 A-202）；list 带行情名称展示（行情失败退化为代码）；
  SYSTEM_PROMPT 规则 3 加了 routing（"涨到 X 提醒我"→ manage_alerts）。
- **调度**（scheduler.ts `startPriceAlerts`，与阈值提醒同一轮询）：每轮先取
  `getEnabledAlertRules()`，规则代码并入去重拉行情集合；触发判定后按粒度去重——
  all 规则按 `${date}:r<id>` 每日一次，any 规则按 `${date}:r<id>:<条件序号>` **每条件每日一次**
  （同一规则的不同条件可在不同时刻各自触发一次）；与阈值命中合并为一条两段式推送
  （【异动提醒】+【条件提醒】），推送成功才写去重标记、失败下轮补报（沿用 A-404 语义）。
- **代码位置**：领域 [src/alerts/rules.ts](../src/alerts/rules.ts)、调度
  [src/alerts/scheduler.ts](../src/alerts/scheduler.ts)、存储 [src/storage/store.ts](../src/storage/store.ts)、
  技能 [src/skills/bundled/alerts/](../src/skills/bundled/alerts/)、测试
  [tests/alertRules.test.ts](../tests/alertRules.test.ts)
- **改动入口**：加条件类型 → rules.ts 三处（类型/校验/求值/文案）+ 技能 parameters 枚举 +
  SKILL.md；调上限 → `MAX_CONDITIONS_PER_RULE`/`MAX_RULES_PER_USER`；改去重粒度 →
  scheduler 的 markOnSuccess 键规则；加网页管理界面 → webchat.ts 加 /api/alerts 端点
  （口令鉴权后）+ 复用 Store CRUD
- **注意事项**：`ALERT_ENABLED=false` 时全局阈值与自定义规则都停止轮询；规则触发文案中的
  价格/涨跌幅是触发时刻的客观状态，推送末尾固定免责声明，不得改写为买卖建议；
  轮询每轮全量读启用规则（行数小，无需缓存）。

## 33. 外盘联动监控（/overseas，F6-4，2026-09-19 新增）

- **定位**：隔夜外盘参考信息聚合（美股三大指数 / 中概股与美股热门 / 国际金银原油）+
  规则化"A 股相关方向提示"。**范围扩界红线**：外盘仅作参考信息源，行情查询/自选股等
  主功能仍只做 A 股；方向提示是"历史上与 X 板块情绪相关"的客观映射，禁止买卖建议。
- **数据层**（data-service `GET /overseas/summary`，main.py 文件末尾"外盘联动监控"节）：
  三块**独立降级**——单块失败返回 `{source: null, error: 原因, items: []}`，其余块照常；
  整体进程内缓存 10 分钟。数据源选型（2026-09-19 逐一实测，口径见 DATA_SOURCES）：
  - 美股三大指数：主源腾讯行情 qt.gtimg.cn（usDJI/usIXIC/usINX，GBK 文本，下标与 A 股
    同款 1=名称 3=最新价 30=时间 32=涨跌幅）；降级新浪 `ak.index_us_stock_sina`
    （全量日 K 取最后两根收盘算涨跌幅）。东财系不可用：`index_global_spot_em` 走
    push2 clist 的 i: 市场本机实测被掐，`stock_us_famous_spot_em` 走 69.push2 子域断连。
  - 中概股/美股热门：腾讯行情固定篮子 14 只（BABA/PDD/JD/NTES/BIDU/NIO/XPEV/LI/BILI/TCOM
    + AAPL/MSFT/NVDA/TSLA），单次请求；**代码不带交易所后缀**（带 .OQ 反而 none_match）；
    无降级源（宁缺毋滥）。
  - 国际金银原油：主源新浪 `ak.futures_foreign_commodity_realtime([XAU,XAG,GC,SI,CL,OIL])`
    （**必须用交易所代码**，中文名触发 AKShare 1.18.94 列数不匹配 ValueError；涨跌幅已是
    % 单位）；降级东财 `ak.futures_global_spot_em`（全量翻页约 32s，超时放宽 60s，
    取 GC00Y/SI00Y/CL00Y 当月连续合约行）。
- **主服务**：`DataProvider.getOverseasSummary()`（provider.ts 类型 OverseasSummary/
  OverseasBlock/OverseasQuote），PythonServiceProvider 透传（超时放宽 90s——商品块
  降级链最坏 30s+32s），CompositeProvider 接线带启动提示降级错误。
- **方向提示**（[src/data/overseasHints.ts](../src/data/overseasHints.ts)，纯函数可测）：
  阈值规则——指数 |涨跌幅|≥1.5% → 科技/大盘情绪提示；中概篮子等权均值 |≥1.5%| →
  中概/港股联动提示；黄金 |≥1%| → 贵金属板块提示；原油 |≥2%| → 石油石化/航运提示；
  无触发返回一条"波动不大"说明；失败块不参与映射；所有文案以"仅供参考"结尾。
- **API**：`GET /api/overseas/summary`（口令鉴权后，webchat.ts），响应 = 微服务原始三块
  + `hints`（主服务侧生成，供网页与盘前推送共用同一口径）。
- **网页**：`public/overseas/`（/overseas）：方向提示卡 + 三个报价卡（tile 网格，
  涨跌徽章），快照生成时间（北京时间）与各条目数据源原始时间（美股为美东）分别标注；
  stocks/market/news/funds 四页页头加"🌐 外盘"导航；全部 textContent 渲染。
- **盘前推送（可选）**：scheduler.ts `startOverseasPush`——交易日约 9:10（北京时间，
  复用 msUntilNextRun + tradeCalendar 触发时判断）向"有自选股 ∪ 有监控规则"的用户
  推送外盘摘要 + 方向提示；`OVERSEAS_PUSH_ENABLED=true` 开启（默认 false）；
  文案构造 `buildOverseasPushText` 纯函数导出（块失败降级"暂不可用"行）。
- **代码位置**：端点 data-service/main.py 末尾节、类型 src/data/provider.ts、提示
  src/data/overseasHints.ts、调度 src/alerts/scheduler.ts、API src/channels/webchat.ts、
  前端 public/overseas/index.html、测试 tests/overseas.test.ts
- **改动入口**：换数据源 → main.py 对应 `_block_*` 函数；调提示阈值 → overseasHints.ts
  顶部常量；改篮子 → `_TENCENT_US_HOT`；改缓存 → `_OVERSEAS_TTL`
- **注意事项**：东财 push2 对本机间歇性断连（2026-09-19 复现，见 PITFALLS），外盘三块
  特意全部不走 push2 主路径；主服务 60s 默认超时对"新浪 30s 超时 + 东财翻页 32s"的
  最坏降级链不够，getOverseasSummary 客户端超时已放宽 90s。
## 34. 板块轮动监控（/sectors，F6-3，2026-09-19 新增）

- **定位**：东财行业板块（m:90 t:2，含多级行业约 500 个）的轮动监控独立导航页：
  涨跌排行 / 资金流排行 / 板块详情（成分股 + 日 K 走势图）/ "查个股所属板块"共振查询。
  纯客观数据呈现，**不做任何板块推荐**；页面注明数据口径与"仅供参考，不构成投资建议"。
- **data-service**（[data-service/main.py](../data-service/main.py) 末尾"板块轮动监控"节）：
  - `GET /sectors/rank?limit=`：涨跌排行（涨跌幅降序，缓存 60s）。字段：名次/板块代码（BK）/
    名称/最新价/涨跌幅/涨跌额/成交额/换手率/总市值/上涨下跌家数/领涨股（名称+代码+涨跌幅）。
  - `GET /sectors/fund-flow?limit=`：资金流排行（今日主力净流入降序，缓存 60s）。
    主力/超大单/大单/中单/小单五档净流入与净占比 + 主力净流入最大个股。
  - `GET /sectors/cons?name=&limit=`：板块成分股（涨跌幅降序，按板块缓存 10min）；
    name 支持板块名称或 BK 代码（代码直传时尝试从排行表反查名称）。
  - `GET /sectors/history?name=&days=`：板块日 K（日期升序，缓存 10min），bars 结构与个股
    /history 一致（复用 `_hist_items` 归一化，列名与东财个股日 K 相同）。
  - `GET /sectors/of-stock/{code}`：个股→板块共振。所属行业复用 /profile（含其降级链与
    24h 缓存），与涨跌排行表匹配（精确优先，其次去罗马数字后缀归一化兜底）；命中返回
    板块当日涨跌名次 rank/total 与资金流名次 fundFlowRank/fundFlowTotal（资金流排行失败
    仅省略资金流字段，独立降级）；行业缺失或无同名板块返回 `matched=false` 结构化响应。
  - **实现选型**：排行/资金流/成分股本质是东财 clist 翻页接口，AKShare 封装
    （stock_board_industry_name_em / stock_sector_fund_flow_rank / stock_board_industry_cons_em）
    会丢弃本项目需要的字段（成交额/领涨股代码/板块代码），故按 AKShare 同参数同字段
    **直连 clist**（`_clist_paginated`：push2 主宿主 → push2delay 延时镜像降级，
    翻页间隔 0.3s 防限流，响应带 `source: eastmoney/eastmoney-delay` 标注）；
    板块日 K 走 AKShare `stock_board_industry_hist_em`（push2his，支持 BK 代码直传）。
- **主服务**：`DataProvider` 新增 `SectorRank/SectorFundFlow/SectorCons/SectorHistory/
  StockSectorInfo` 类型与五个可选方法（[src/data/provider.ts](../src/data/provider.ts)），
  PythonServiceProvider 与 CompositeProvider 接线（微服务未启动时给带启动提示的错误）；
  webchat.ts 挂 `/sectors` 静态页与 `/api/sectors/*` 五个端点（全部在口令鉴权后，
  code 校验 6 位数字、name 必填且 ≤20 字符）。
- **前端**：[public/sectors/index.html](../public/sectors/index.html)（复用 theme.css，
  全部 textContent 渲染）——列表视图：个股查板块输入框（代码直查/名称先走 /api/search
  解析）+ 涨跌排行/资金流排行两个 Tab（卡片含名次/领涨股/涨跌家数/成交额或主力净流入）；
  详情视图（?name=）：走势图（手写 SVG 折线，近1月/3月/6月/1年区间切换，hover tooltip）
  与成分股表（点击跳 /stocks 个股详情）**独立加载互不阻塞**；延时镜像数据页面标注
  "延时约 15 分钟"。/stocks、/market、/news、/funds 页头导航加"🏭 板块"入口。
- **测试**：[tests/pythonService-sectors.test.ts](../tests/pythonService-sectors.test.ts)
  9 条用例（五方法 URL 拼接含中文编码/参数默认值、响应透传、matched=false 结构化响应、
  404/连接失败分支），fetch 全 mock 不碰真实网络。
- **改动入口**：加板块字段 → main.py 的 `_SECTOR_*_FIELDS` + 对应 `_sector_*_item` 归一化 +
  provider.ts 类型；调缓存 → `_SECTOR_*_TTL`；概念板块（m:90 t:3）→ `_clist_paginated`
  调用处换 fs 参数。
- **注意事项**：push2his（板块日 K）与 push2（clist）限流独立，板块日 K 限流期返回
  结构化 502，只影响走势图区块；排行表全量约 500 行需翻页约 5 次，60s 缓存是限流防线，
  不要缩短；`/api/sectors/of-stock` 的行业匹配依赖"profile 行业名 = 板块名"同源性
  （均为东财行业分类），东财若改分类口径会表现为 matched=false 增多而非报错。
## 35. K 线形态识别 + 历史成绩单（F6-1，2026-09-19 新增）

- **数据层（纯本地计算，无新外部依赖）**：data-service `GET /patterns/{code}?days=`
  （默认 750≈3 年、范围 30~1500，按 (code,days) 缓存 6h）。输入是与 /history 同源的
  前复权日 K（`_load_bars`：东财→新浪降级，响应带 `source`）。形态库 17 种
  （定义清晰优先于数量；杯柄/口袋支点定义把握不足未纳入）：
  - **K 线组合 11 种**：十字星（中性，实体≤振幅 10% 且振幅≥1%）、锤子线/上吊线
    （下影线≥2 倍实体、上影线≤0.5 倍实体，背景分别为前 5 日累计下跌/上涨）、
    看涨/看跌吞没（反向背景 + 当日实体完全包住前一根且更大）、早晨/黄昏之星
    （大实体 + 跳空星线 + 收复/跌破首根实体中点）、乌云盖顶/刺透（高开/低开越前高/低，
    收盘深入中点以下/以上但未吞没）、红三兵/三只乌鸦（三根饱满同向线，收盘逐级推进，
    后两根开盘在前一根实体内）；
  - **价格结构 6 种**：双底/双顶（60 根窗口，两底/顶价差 ≤3%、间隔 ≥10 根、底部/顶部
    须接近窗口最低/高点（3% 容差，显著极值）、颈线深度 ≥5%，信号日=收盘首次突破颈线）、
    头肩底/头肩顶（90 根窗口，头即窗口最低/最高点、双肩价差 ≤5%、颈线深度 ≥5%）、
    上升/下降三角形（40 根窗口，最近 2~3 个分形高点/低点近似水平（≤2%）作压力/支撑线，
    另一侧分形点逐级抬/降，信号日=收盘首次突破）。
    结构类信号日的"首次突破"判定（`c[i-1] ≤ neck < c[i]`）天然去重，但同一形态的颈线
    回踩再突破会各计一次信号（口径见 DATA_SOURCES）。
  - **无未来函数**：任一形态在第 i 根的判定只用 ≤ i 的数据；分形点右边界留 2 根确认
    （`_fractals` 的 `min(hi, len-w)`），背景趋势以信号日前一日为锚。
  - **历史成绩单**：对每个信号日 i，5/10/20 窗口各统计 upRatio（上涨占比 %）/
    avgRet（平均涨跌幅 %，收盘对收盘）/avgMaxDrawdown（窗口内最低价相对信号日收盘的
    平均最大跌幅 %）；i+w 超出数据末尾的出现不计入该窗口；窗口样本为 0 时各值 null。
    响应按形态聚合（{key,name,direction,count,recentDates,stats}），只含窗口内出现过
    的形态，按最近一次出现倒序；recentDates = 近 60 个交易日的信号日；响应带
    `disclaimer`（历史事实口径 + 不构成投资建议），**展示层必须保留**。
- **主服务**：`DataProvider` 加 `PatternReport/PatternStat/PatternWindowStats` 类型与
  `getPatterns`，PythonServiceProvider/CompositeProvider 接线（未启动微服务给带启动提示
  的错误）；新增 `GET /api/stocks/:code/patterns?days=`（口令鉴权后，days 钳到 30~1500）。
  **不进详情聚合七块**——形态卡由前端独立拉取，失败只影响自己（同 indicators 模式）。
- **聊天技能 `get_stock_patterns`**：[src/skills/bundled/patterns/](../src/skills/bundled/patterns/)。
  参数仅 code；输出 = 头部（数据截至/窗口/数据源）+ 近期出现形态（近 60 日）+ 历史成绩单
  （逐形态三窗口一行摘要，count<5 附"样本过少"）+ 口径与免责声明，并内嵌对 LLM 的红线指令
  （不得表述为预测/买卖建议）。股票名称仅用于展示，行情失败退化为代码不阻塞。
  SYSTEM_PROMPT 规则 9 加 routing（"形态/信号识别/形态后走势"→ 本技能）。
- **详情页落点**：AI 多维分析卡下方独立"形态分析"卡（`patterns-card`）——近期触发 chips
  （中性配色同指标信号，避免暗示操作方向）+ 历史成绩单表格（形态/方向/历史次数/
  信号后 5/10/20 日，每格两行：上涨占比·均涨幅 + 平均最大回撤，count<5 标注样本过少）+
  口径与免责声明双脚注；数据缺失整块隐藏、失败卡内降级提示；全部文本 textContent 渲染。
- **代码位置**：端点与检测器 [data-service/main.py](../data-service/main.py)（"K 线形态
  识别（F6-1）"节，文件末尾）、接口 [src/data/provider.ts](../src/data/provider.ts)、
  客户端 [src/data/pythonService.ts](../src/data/pythonService.ts)、组合源
  [src/data/index.ts](../src/data/index.ts)、API [src/channels/webchat.ts](../src/channels/webchat.ts)、
  页面 [public/stocks/index.html](../public/stocks/index.html)（loadPatterns/renderPatterns）、
  测试 [tests/pythonService-patterns.test.ts](../tests/pythonService-patterns.test.ts) +
  [tests/patterns.test.ts](../tests/patterns.test.ts)
- **改动入口**：调形态阈值/加形态 → main.py 检测器 + `_PATTERN_DEFS`（每个检测器头部注释
  写明参数口径）；改统计窗口 → `_PATTERN_WINDOWS`；调缓存 → `_PATTERNS_TTL`；
  改前端列 → renderPatterns 的 winCell；F6-2 资金流验货可复用本端点的信号日输出
- **注意事项**：结构形态触发频率对阈值敏感（2026-09-19 实测调校：双底/顶从"任意分形对"
  收紧到"窗口显著极值"后 750 日内触发次数从 26/59 降到 4/9）；改阈值后用合成 K 线
  重跑定点识别 + 用真实数据看 count 分布两步验证。

## 36. 资金流验货（"狙击手"模式，F6-2，2026-09-21 新增）

- **定位**：对 F6-1 检测出的**近期触发形态**（近约 60 个交易日信号日），叠加 F3-4 资金流
  做交叉验证，输出三档分档结论 + 客观依据。红线：只描述"资金流是否印证形态信号"这一客观
  事实，不含买卖建议；响应与展示带"仅供参考，不构成投资建议"。
- **data-service**（[data-service/main.py](../data-service/main.py) 文件末尾"资金流验货"节）：
  `GET /verify/{code}?days=`（默认 750、范围 30~1500，按 (code,days) 缓存 1h）。
  流程：`_load_bars` 取日 K（与 /history、/patterns 同源同降级链）→ `_scan_patterns`
  复用 F6-1 形态检测取近期信号 → 有信号才调 `_get_fund_flow_cached`（/fund-flow 端点的
  取数+降级链抽出的共用函数，按 code 缓存 60s，**缓存键与验货缓存独立**；东财五档主源、
  新浪两档降级，source 透出）逐信号验货；无近期信号时直接返回空列表（flowSource=null，
  不拉资金流）。资金流取数失败抛 502 结构化错误（同 /fund-flow 先例）。
  **验货窗口与分档规则（透明客观阈值，改动须同步本节与 DATA_SOURCES）**：
  窗口 = 信号日起往后最多 3 个有资金流数据的交易日（`_VERIFY_WINDOW=3`）；取窗口内
  主力净流入（新浪降级源为"净流入"，口径含全部资金，basis 文案与报告级 flowNote 随
  source 切换）非 None 的值，记 pos=为正日数、neg=为负日数、total=合计额（0 值两者都不计）：
  - `watch`（重点观察）：total 与形态方向同号 **且** 同向日数 > 反向日数（资金流印证形态）
  - `doubt`（存疑）：total 与形态方向反号 **且** 反向日数 > 同向日数（资金流背离形态）
  - `neutral`（中性）：其余——正负交错 / 有效值为 0 个 / 信号日未被资金流覆盖
    （资金流源仅含近期约 100 个交易日）/ 中性形态（十字星）无方向可比
  **口径限制**：只用**日级资金流**——分笔 tick（如 `ak.stock_intraday_em`）稳定性未实测
  未接入，"尾盘变化"维度因此缺失（验货场景日级已够）；新浪源只有"净流入/超大单"两档，
  结论均基于"净流入"档。每条信号输出 {key/name/direction/date/verdict/verdictLabel/basis/
  windowDates/mainNetInflowSum}，signals 按信号日倒序。
- **主服务**：`DataProvider` 加 `FlowVerifyReport/FlowVerifySignal/FlowVerifyVerdict` 类型与
  `getFlowVerify`（[src/data/provider.ts](../src/data/provider.ts)），PythonServiceProvider
  透传 `/verify/{code}?days=`，CompositeProvider 接线（微服务未启动给带启动提示的错误）。
  新增 `GET /api/stocks/:code/verify?days=`（口令鉴权后，days 钳到 30~1500）；
  **不进详情聚合七块**——验货卡由前端独立拉取、失败只影响自己（同 patterns 模式）。
- **analyze_stock 第七块**（[src/skills/bundled/analyze/index.ts](../src/skills/bundled/analyze/index.ts)
  `fmtFlowVerify`）：聚合列表加 `getFlowVerify`（allSettled 独立降级，失败只在该块标注
  暂不可用）；输出每个信号一行"日期 形态（方向）：分档 — 客观依据"+ 新浪口径注记 +
  "客观交叉验证仅供参考"声明；无近期信号输出"无验货对象"。SYSTEM_PROMPT 规则 5 补了
  验货块的解读约束（分档结论只作客观参考，不得表述为买卖信号）。
- **详情页落点**：[public/stocks/index.html](../public/stocks/index.html) 形态分析卡下方
  独立"资金流验货"卡（verify-card / loadVerify / renderVerify）——每个近期信号一条目：
  信号日 + 形态名（方向）+ 分档 badge（**中性配色**：watch 用 indigo 弱化底、neutral/doubt
  灰色，不用红涨绿跌避免暗示买卖方向）+ 客观依据；卡底注明数据截至、资金流数据源（日级
  口径）、验货规则摘要、新浪 flowNote 与免责声明；近期无信号且无错误时整卡隐藏；全部文本
  textContent 渲染。
- **聊天侧决策**：不新增独立技能，验货经 analyze_stock 与详情页触达；get_stock_patterns
  也**不**附带验货分档——避免形态查询翻倍上游调用（形态/资金流各一次上游取数），
  需要验货的用户走多维分析即可。
- **测试**：[tests/pythonService-verify.test.ts](../tests/pythonService-verify.test.ts)
  8 条（URL/透传/三档分档值/空信号/新浪口径/非 200/连接失败/Composite 降级文案，fetch 全
  mock）+ [tests/analyze.test.ts](../tests/analyze.test.ts) 验货块 4 条（齐全/独立降级/
  方法缺失/无信号与新浪口径）。**分档规则本身在 Python 侧**，vitest 不直接覆盖——
  边界（一致/背离/交错/无数据/未覆盖/正负日数相等/含 0 值/无信号不拉资金流）由合成数据
  sanity check 覆盖（2026-09-21 实测 23 项全过，临时脚本未提交）。
- **改动入口**：调分档阈值/窗口 → main.py `_grade_flow_verdict`/`_VERIFY_WINDOW` +
  本节 + DATA_SOURCES 同步；调近期窗口 → `_VERIFY_RECENT_BARS`；调缓存 → `_VERIFY_TTL`；
  接分笔 tick → 先实测稳定性（PITFALLS 资金流派生条目口径），再在 `_verify_signal` 里
  加维度并同步文档
- **注意事项**：资金流源（东财 ~100 日 / 新浪 num=100）覆盖范围外的早期信号日会判
  "未覆盖"（neutral），不是 bug；`_fund_flow_cache` 缓存全量 items，/fund-flow 截尾、
  /verify 按日期索引，两入口共用同一份缓存。

## 37. 选股扫描（/scanner + scan_market，F5-5，2026-09-21 新增）

- **定位**：在本地全市场日 K 库上按**预设策略模板**做全市场客观指标筛选，产出
  "符合客观条件的股票名单"。红线：结果只是指标条件的命中名单，所有输出带
  "仅供参考，不构成投资建议"，不含买卖建议/推荐暗示。**范围裁剪（用户 2026-09-21 确认）**：
  仅沪深 A 股（北交所无免费批量数据源）、固定 7 个预设策略（不做自由条件编辑器）。
- **数据底座（本地日 K 库，本服务首个磁盘持久化）**：baostock 批量前复权日 K →
  SQLite `data-service/data/market_bars.db`（stdlib sqlite3，WAL 单写者，
  `bars(code,date,…)` WITHOUT ROWID + meta 表；750 个交易日窗口，实测约 5221 只/300-500MB）。
  字段口径（volume 股÷100→手、amount 元、turn→turnover、pctChg→change_pct、停牌票
  turn 存 NULL）与已知坑（长窗口慢/连接熔断/会话互斥）见 DATA_SOURCES 与 PITFALLS
  2026-09-21 条目。
- **更新器**（[data-service/main.py](../data-service/main.py) "本地日 K 库"节）：
  `POST /market-bars/update?full=` 触发（单飞行 409）、`GET /market-bars/status` 查进度
  （running/phase/done/total/failed/coverage/lastBarDate/dbSizeMb）。断点续跑
  （每票 MAX(date) 续起，回退 10 个日历日覆盖上游修正）；单票失败重试 2 次记名单不中断；
  **连续 20 票失败熔断**（baostock socket 死亡后票级重试无效）→ 登出重连续跑（上限 5 次）；
  盘后数据未齐（baostock 当日 K 约 17-18 点齐）每 30 分钟重跑增量至北京时间 21:00 封顶。
  **线程内禁止裸调 AKShare**：票池/交易日历在 async 端点经 run_ak 超时包装预热后传入
  （东财全量代码表限流期实测超 30s，预热放宽 120s，缓存 24h）。
- **扫描引擎**（"全市场扫描"节）：`_load_panel` 一次读出全票最近 150 根 bar pivot 成
  宽表，`_wide_indicators` 整帧向量化（口径与 F5-1 `_compute_indicators` 逐条一致，
  合成数据对拍验证）；策略取末行布尔掩码，单策略秒级（实测 2.5s @ 约 1600 票部分回填）。
  结果缓存键含数据 asOf（更新完成即自然失效，无 TTL）。**7 个预设策略**（key 与口径的
  单一事实源是 `/scan/strategies` 端点）：ma_bull=MA 多头排列 / macd_gold=MACD 金叉 /
  rsi_oversold=RSI6≤20 / vol_break_20d=放量突破 20 日新高（量比降序）/ pullback_ma20=
  缩量回踩 MA20 / boll_lower=触及布林下轨 / ma_cross_up=MA5 金叉 MA20。ST/退按名称剔除
  （名称表不可用时降级不剔除 + note 注明）。
- **主服务**：`DataProvider` 加 `ScanStrategyMeta/ScanResultItem/ScanResult/MarketBarsStatus`
  与 4 个可选方法（getScanStrategies/runScan/getMarketBarsStatus/triggerMarketBarsUpdate，
  [src/data/provider.ts](../src/data/provider.ts)）；pythonService.ts 加 `post<T>` 私有方法
  （与 get 同包装）；runScan/trigger 客户端超时放宽 150s（冷启动名称表预热最坏约 120s）。
  webchat.ts 挂 `/scanner` 静态页与 4 个 API（/api/scanner/strategies、scan、status、
  update，口令鉴权后；update 的上游 409 原样透传）。
- **调度**：`startScannerUpdate`（[src/alerts/scheduler.ts](../src/alerts/scheduler.ts)，
  仿 startOverseasPush）：交易日约 15:40 触发增量更新（fire-and-forget；
  `SCANNER_AUTO_UPDATE=false` 关闭）。`SCANNER_PUSH_ENABLED=true`（默认关）时轮询
  status 至完成后对 7 策略各扫 5 条组装摘要（`buildScanPushText` 纯函数：命中数 +
  前 3 只，全零命中不推送），推送给有自选股 ∪ 有监控规则的用户；21:30 未完放弃当日推送。
- **技能**：`scan_market`（[src/skills/bundled/scanner/](../src/skills/bundled/scanner/)）：
  参数 strategy（七 key 枚举）+ limit（硬钳 10）；输出 TOP 10 + 总数 + asOf +
  "/scanner 页面"引导 + 口径与免责声明（总长 <1200 字符截断线）。SYSTEM_PROMPT 规则 10
  routing + 红线约束。
- **网页**：`/scanner` 独立导航页（[public/scanner/index.html](../public/scanner/index.html)）：
  状态条（数据截至/覆盖票数/stale 黄标/更新进度 5s 轮询/"立即更新"按钮）+ 策略 Tab
  （/scan/strategies 动态渲染 + 口径描述行）+ 结果卡列表（代码/名称/收盘/涨跌幅/触发数值，
  点击跳详情页）；空态区分"库为空（引导首更）/无命中/服务未启动"；全 textContent。
  8 个页面页头加"🔍 扫描"导航，顺带补齐 funds 缺快讯、sectors/overseas 互链。
- **测试**：[tests/pythonService-scanner.test.ts](../tests/pythonService-scanner.test.ts)
  7 条（4 方法 URL/POST/透传/409/连接失败）+ [tests/scanner.test.ts](../tests/scanner.test.ts)
  7 条（白名单/降级/格式化/截断/钳制/长度上限/key 清单一源）+ scheduler.test.ts 追加
  5 条（buildScanPushText 文案 3 条 + SCANNER_* 配置解析 2 条）。**策略判定在 Python 侧**：
  宽表口径对拍（vs _compute_indicators，5 票×9 指标）、7 策略暴力复算一致、工程化定点
  触发、ST 剔除、缓存失效、熔断等由合成数据 sanity check 覆盖（2026-09-21 实测 28+28
  项全过，临时脚本未提交）。
- **改动入口**：调策略阈值 → main.py `_SCAN_STRATEGIES` + /scan/strategies 文案 + 技能
  description + 本节同步；加策略 → 同四处 + sanity 定点用例；调回填窗口 →
  `_MB_BACKFILL_CAL_DAYS`；调熔断/重连 → `_MB_CIRCUIT_BREAK`/`_MB_RECONNECT_MAX`；
  调面板宽度 → `_SCAN_PANEL_BARS`（注意 MA60/BOLL 周期 + EMA 收敛余量）
- **注意事项**：扫描口径是 baostock 前复权，个股页 /indicators 是东财/新浪前复权，
  复权因子精度差异致数值微小偏差（<0.5%），两者不作逐位一致性承诺；前复权历史值随新
  除权平移，增量更新只回退 10 个日历日，更早期历史逐渐陈旧——扫描只用近期 150 根，
  影响有限，需要精确时 `POST /market-bars/update?full=true` 全量刷新。

