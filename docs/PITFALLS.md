# 技术坑与排错记录（PITFALLS）

> **本文件的用途**：记录在开发、调试、运行过程中实际踩过的**技术类错误**及其根因与解法，
> 供后续接手的 agent / 工程师在动手前先扫一遍，避免重复犯错。
>
> **与 CLAUDE.md 的分工**：CLAUDE.md 的"已知坑与注意事项"是项目级的高层提醒；
> 本文件是可检索的**病例库**，每条记录带现象、根因、解法。
>
> **何时新增条目**（满足任一即应记录）：
> - 排查时间超过 15 分钟的问题
> - 报错信息有迷惑性、根因与表象不在一起
> - 外部接口/依赖的非直觉行为（返回格式、限流、编码等）
> - 环境/工具链相关的坑（Windows、ESM、Python 版本等）
>
> **回填是义务，不是可选项**：后续开发中每踩一个新坑，解决后应立即按模板回填。
> 每多一条真实病例，下一个 agent 就少浪费一次排查时间——这份文档会随项目一起增值。
> 反之，踩了坑不回填，同样的时间会被反复烧掉。
>
> **条目格式**（复制下面的模板，新条目加在对应分类的**最前面**）：
>
> ```markdown
> ### [YYYY-MM-DD] 一句话标题（现象）
> - **现象**：报错信息或异常行为，尽量贴原始错误文本
> - **根因**：为什么会发生
> - **解法**：怎么修的 / 正确的写法
> - **涉及文件**：`src/xxx.ts`（如适用）
> - **预防**：下次如何避免 / 排查时先看什么
> ```

---

## 1. TypeScript / Node.js / 工具链

### [2026-09-14] Windows 下 node:sqlite 不关连接，临时目录 rmSync 报 EPERM
- **现象**：测试用 `DATA_DIR` 指向临时目录起真实 SQLite，用例全绿，但 `afterAll` 里
  `rmSync(tmpDir, { recursive: true })` 报 `EPERM: operation not permitted`。
- **根因**：Windows 上被进程持有的数据库文件句柄不允许删除；`Store` 的
  `DatabaseSync` 连接没暴露公开 `close()`。
- **解法**：测试里用 `(store as unknown as { db: { close(): void } }).db.close()`
  绕过 TS private 关连接后再清理。**长期建议给 `Store` 加公开的 `close()` 方法**，
  加完后删掉这个绕过写法。
- **涉及文件**：`tests/store.test.ts`、`src/storage/store.ts`
- **预防**：Windows 上写涉及文件句柄的测试，清理失败先查是否有连接/流没关。

### [2026-09-14] Git Bash 下测试脚本的 /tmp 路径与环境变量不一致
- **现象**：测试脚本往 `/tmp/x/data/store.json` 写了文件，程序却从
  `C:/Users/.../Temp/x/data/` 读，迁移逻辑"没触发"，排查半天以为代码有 bug。
- **根因**：Git Bash 会把**命令行环境变量**里的 `/tmp` 转成 Windows 真实临时目录，
  但 Node 代码里硬编码的字符串 `/tmp/...` 不做转换，被当成当前盘符下的 `D:\tmp\...`。
  另外 `process.env.X = ...` 写在模块顶层对静态 import 无效（import 提升，先执行）。
- **解法**：Windows 上写跨进程路径测试时，全流程用同一个 Windows 风格绝对路径；
  环境变量在 shell 里随命令设置（`X=... npx tsx test.mts`），别在脚本里赋值。
- **预防**：测试存储/文件类逻辑时，先 `console.log` 实际解析出的路径再往下排查。

### [2026-09] ESM 项目相对 import 漏写 `.js` 后缀
- **现象**：`npm run dev` 报 `ERR_MODULE_NOT_FOUND`，提示找不到 `./xxx` 模块；但文件明明存在。
- **根因**：本项目 `"type": "module"` + `module: NodeNext`，Node 原生 ESM 不做扩展名补全，
  相对路径 import 必须写全 `./xxx.js`（即使源文件是 `.ts`）。
- **解法**：所有相对 import 带 `.js` 后缀，如 `import { config } from '../config.js'`。
- **预防**：新写文件时 typecheck 能抓住大部分；运行时才报的是被字符串拼接/动态 import 的路径。
  提交前必跑 `npm run typecheck`。

### [2026-09] tsx watch 下进程不退出导致端口占用
- **现象**：重启 `npm run dev` 报 `EADDRINUSE: address already in use :::3000`。
- **根因**：Windows 上 watch 模式旧进程偶尔残留。
- **解法**：`netstat -ano | findstr :3000` 找到 PID 后 `taskkill //PID <pid> //F`
  （Git Bash 下双斜杠转义），或换端口。
- **预防**：结束开发用 Ctrl+C 而不是直接关终端窗口。
- **⚠️ 2026-09-15 加重版**：tsx watch 每次文件变更派生新子进程，**杀父进程（npm/tsx）
  不会带走已派生的旧子进程**——旧子进程继续占着端口、用旧代码/旧环境变量服务，
  新子进程 EADDRINUSE 崩溃，表现为"改了代码/换了 env 却不生效"（本次排查财报修复
  不生效，实际请求全落在旧子进程上）。联调验证期建议用 `npx tsx src/index.ts`
  （无 watch）跑主服务；验证某进程是否最新，直接打它的独占特征端点而不是看 /health。

## 2. 东方财富接口（行情数据源）

### [2026-09-15] 腾讯行情接口是 GBK 编码 + 字段下标无任何文档
- **现象**：直接 `res.text()` 得到乱码（如 `ę́`）；按 JSON 解析会炸。
- **根因**：`qt.gtimg.cn` 返回 GBK 编码的纯文本 `v_sh600519="1~名称~代码~..."`（~ 分隔），
  无官方文档，字段只能靠下标。
- **解法**：`new TextDecoder('gbk').decode(await res.arrayBuffer())`；关键下标
  1=name 2=code 3=price 4=prevClose 30=time 32=changePct（见 src/data/tencent.ts 与
  DATA_SOURCES.md）。**价格不放大**（与东财 ×100 不同），停牌返回空串。
- **涉及文件**：`src/data/tencent.ts`
- **预防**：接新数据源先录 fixture（tests/fixtures/）再写解析，编码问题 fixture 回放立刻暴露。

### [2026-09-14] 高频请求 push2 触发 IP 级断连限流（连接被直接掐断，无 HTTP 错误码）
- **现象**：curl 请求 `push2.eastmoney.com` 突然报 `exit 56`（Recv failure），
  详细日志显示 TLS 握手正常、请求发出后 `schannel: server closed abruptly (missing close_notify)`；
  Node fetch 同样 `fetch failed`。无 403/429 等状态码，之前同样的请求完全正常。
- **根因**：短时间内连续多次请求（录制 fixture 时一分钟内发了约 10 次）触发东财 IP 级限流，
  服务端直接断 TCP 连接，不给任何 HTTP 层错误。换浏览器 User-Agent 无效。
- **解法**：只能等待限流解除（2026-09-14 实测封禁持续超过 45 分钟仍未恢复，恢复时长未知）。
  录制 fixture/调试时请求间隔至少几秒，避免触发。
  这正是 P4 健康探针存在的意义——限流期间探针会计入连续失败并告警，属预期行为。
- **预防**：任何脚本/循环调东财接口都要带间隔；排查"行情全挂"时先区分是字段变了
  （有响应体）还是被限流（连接被掐）。

### [2026-09] 东财接口 403 / 返回空数据
- **现象**：请求 `push2.eastmoney.com` 返回 403 或 `data: null`。
- **根因**：缺少 `Referer: https://quote.eastmoney.com/` 请求头，东财会拒绝"非浏览器来源"的请求。
- **解法**：所有东财请求必须带 Referer 头（已在 `eastmoney.ts` 中处理，新增东财端点时别忘了）。
- **涉及文件**：`src/data/eastmoney.ts`

### [2026-09] 价格数值比实际大 100 倍
- **现象**：茅台报价显示 170000 元。
- **根因**：push2 接口价格类字段（f43/f44/f45/f46/f60/f169/f170）默认放大 100 倍返回。
- **解法**：解析时除以 100。注意涨跌幅 f170 也是放大 100 倍的百分数（如 123 = +1.23%）。
- **涉及文件**：`src/data/eastmoney.ts:43-50`

### [2026-09] 停牌/退市股票 getQuote 抛错被当成 bug
- **现象**：查询某股票报"未找到 xxx 的行情"。
- **根因**：停牌或退市时东财字段返回字符串 `"-"` 而不是数字——**这是设计如此**，
  技能层会把错误文本回给 LLM，由 LLM 转述给用户。
- **解法**：不是 bug，不要"修"。新增字段解析时必须处理 `'-'` 分支。
- **涉及文件**：`src/data/eastmoney.ts:40-41`

### [2026-09] secid 前缀写反导致查不到股票
- **现象**：深市股票（如 000001 平安银行）用 `1.000001` 查询返回的是上证指数或空数据。
- **根因**：东财 secid 规则：沪市（6/9 开头）→ `1.` 前缀，深市（0/3）与北交所（4/8）→ `0.`。
  **注意 `000001` 作为股票是平安银行（深市，`0.000001`），作为上证指数是 `1.000001`，
  两者 secid 不同**——做指数行情功能时这里极易混淆。
- **解法**：统一走 `toSecid()`；做指数功能时需单独的指数 secid 映射，不能复用个股规则。
- **涉及文件**：`src/data/eastmoney.ts:14-18`

## 3. Python / AKShare（data-service）

### [2026-09-15] akshare 1.18.94 `stock_financial_abstract` 返回结构从长表变宽表（静默全空）
- **现象**：`/financials` 端点不报错，但每期所有字段都是空串——比报错更阴，
  冒烟只看"返回 4 条"会误以为正常。
- **根因**：1.18.94 起该接口返回**宽表**：行=指标（前两列"选项/指标"），
  之后每个报告期一列（YYYYMMDD）；旧代码按长表列名（截止日期/主营业务收入…）取数，
  全部 miss 后 `_cell` 兜底为空串。且新版指标集删掉了"资产总计/长期负债合计/财务费用"，
  参数名也从 stock 改回 symbol。
- **解法**：端点检测 `"指标" in df.columns` 分流——宽表走 `_financials_wide()` 透视
  （优先"常用指标"组取行，同名单指标在多组重复）；输出新增 netAssets/roe/eps 字段，
  旧三字段仅旧版路径填充。验证接口类改动必须**看字段内容**，不能只看条数。
- **涉及文件**：`data-service/main.py`（/financials、_financials_wide）、
  `src/data/provider.ts`（FinancialReport 新字段）
- **预防**：升级 AKShare 后对每个已接端点跑一次真实调用并**抽查字段值**；
  结构变更可以完全不报错。

### [2026-09-15] 巨潮公告上游返回非 JSON（JSONDecodeError），降级东财公告接口
- **现象**：`/announcements` 报 `AKShare 公告获取失败: Expecting value: line 1 column 1
  (char 0)`——巨潮 cninfo 接口返回了空响应/HTML 而非 JSON（限流或接口变更）。
- **根因**：`ak.stock_zh_a_disclosure_report_cninfo` 对上游响应直接 `json()`，不做容错。
- **解法**：公告端点加降级链——巨潮失败（含 504 超时）自动切
  `ak.stock_individual_notice_report`（东财，列：公告标题/公告日期/网址）。
  注意东财该接口**无日期参数、全量翻页**（约 1 页/秒，大盘股 >30s）：超时放宽到 180s
  （run_ak 加了 timeout 参数），全量结果按代码缓存 6 小时，days/limit 本地过滤。
  主服务侧 60s 超时下，首次未缓存的大盘股请求可能 504，下轮缓存命中即恢复（可接受）。
- **涉及文件**：`data-service/main.py`（/announcements、_announcements_em_fallback）
- **预防**：接三方资讯接口默认假设上游会返回非 JSON；耗时型接口必须配缓存。

### [2026-09-15] `stock_zh_a_hist` 连接被掐断（东财 push2his 独立限流），需新浪源降级
- **现象**：`GET /history/600519` 报 `AKShare 历史行情获取失败: ('Connection aborted.',
  RemoteDisconnected('Remote end closed connection without response'))`；同一时刻
  实时行情（push2）却正常。
- **根因**：`ak.stock_zh_a_hist` 走的是东财 push2his（历史行情）接口，与 push2（实时）
  限流计数独立；本机 IP 前一日录 fixture 高频请求触发的限流未完全解除，push2his 仍被掐。
- **解法**：`/history` 端点加数据源降级链——东财 `stock_zh_a_hist` 失败（含 30s 超时 504）
  自动降级新浪 `ak.stock_zh_a_daily(symbol=sh/sz 前缀, adjust="qfq")`；新浪无"涨跌幅"列，
  用收盘价环比补算。两源都挂则 502 并带出两个原始错误。
- **涉及文件**：`data-service/main.py` 的 `/history` 端点
- **预防**：AKShare 里凡走东财的接口都要假设 push2/push2his 会分别被限流；
  新端点设计时先想好降级源。新浪源不覆盖北交所（4/8/920）。

### [2026-09-14] `stock_financial_abstract` 参数名是 `stock`，返回值全是带单位字符串
- **现象**：按惯例写 `symbol="600519"` 会报 TypeError（未知参数）；拿到的"净利润"是
  `"999,862,000.00元"` 这种字符串，直接 `float()` 会炸。
- **根因**：该接口爬新浪财务摘要页，参数命名为 `stock`；页面数值本身带"元"后缀和
  千分位逗号，AKShare 原样返回 str。
- **解法**：调用写 `ak.stock_financial_abstract(stock=code)`；本项目不做数值清洗，
  原样传给 LLM 阅读（端点 `col_map` 注释有说明）。若未来要做同比/环比计算，
  先 strip "元" 和逗号再转 float。
  **⚠️ 2026-09-15 更新**：akshare 1.18.94 已把参数名改回 `symbol`，旧调用报
  `unexpected keyword argument 'stock'`。端点已改为 `symbol` 优先、`TypeError` 时
  回退 `stock`，两个版本都兼容。
- **涉及文件**：`data-service/main.py` 的 `/financials` 端点
- **预防**：接 AKShare 新接口前先查官方文档确认参数名，不要想当然复用 `symbol`；
  升级 AKShare 后用 `inspect.signature` 核对存量调用的参数名。

### [2026-09-14] 巨潮公告接口查询结果为空时抛 KeyError 而非返回空表
- **现象**：`ak.stock_zh_a_disclosure_report_cninfo` 对无公告的代码/时间范围抛 `KeyError`，
  端点 502，主服务把它当"服务故障"报给用户。
- **根因**：部分 AKShare 版本对空结果 DataFrame 直接做列索引（AKShare Issue #7251）。
- **解法**：端点单独 `except KeyError: return []`，空结果与接口故障区分开；
  其他异常仍包成 502。
- **涉及文件**：`data-service/main.py` 的 `/announcements` 端点
- **预防**：给 AKShare 新端点写空结果用例（如查一只新上市/冷门股的远期公告）再上线。

### [2026-09-14] `ak.stock_notice_report` 名字像个股公告接口，实际按日期查全市场
- **现象**：按 CLAUDE.md 旧版提示用它做"个股公告"，发现 symbol 参数是公告类型筛选
  （"全部"/"沪市"/"深市"等），必填 `date`，返回当天全市场公告。
- **根因**：该接口对应东财"公告大全"页面（按日浏览），不是个股维度。
- **解法**：个股公告用 `ak.stock_zh_a_disclosure_report_cninfo`（巨潮资讯，
  symbol=股票代码 + start_date/end_date 日期范围，**没有 period 参数**）。
- **涉及文件**：`data-service/main.py`、`docs/DATA_SOURCES.md`

### [2026-09] AKShare 接口突然返回空 / 报解析错误
- **现象**：之前好用的 `ak.stock_news_em` 突然抛 KeyError 或返回空 DataFrame。
- **根因**：AKShare 大量接口是爬网页解析的，目标网站改版就失效。
- **解法**：先 `pip install -U akshare`（社区跟进很快，升级能修复大部分问题）；
  升级无效再去 AKShare GitHub Issues 搜函数名。
- **预防**：data-service 依赖不锁死 AKShare 小版本；给端点加 try/except 返回结构化错误，
  而不是让 500 堆栈传到主服务。

### [2026-09] 主服务报"新闻获取失败"但东财行情正常
- **现象**：quote 技能正常，news 技能全部失败。
- **根因**：Python data-service 没启动（默认组合是行情东财直连 + 新闻走微服务，
  两者互相独立）。
- **解法**：确认 data-service 已启动且 `DATA_SERVICE_URL` 配置正确；
  微服务启动较慢（AKShare import 重），health check 通过前主服务调用会失败。
- **涉及文件**：`src/data/pythonService.ts`、`src/data/index.ts`、`data-service/main.py`

## 4. LLM / Agent

### [2026-09-15] Kimi 会员 key 不能用于开放平台 API；低等级账号 429 限流
- **现象 1**：填了 kimi.com 会员体系的 key（`sk-kimi-...` 开头）调
  `api.moonshot.cn/v1` 报 401 `Invalid Authentication`。
- **根因 1**：会员 key 与开放平台 API key 是两套体系。开放平台 key 需在
  platform.moonshot.cn 创建（`sk-` 开头、中间无 "kimi-"），且独立计费（会员不含 API 额度）。
- **现象 2**：key 有效后偶发 429。新账号/低等级账号 RPM 配额低，agent 循环一次对话
  多轮调用容易瞬间打满。
- **解法**：429 先重试；频繁出现则给 LLM 客户端加 429 指数退避重试（STATUS P8），
  或在平台充值提升等级。模型名以 `GET /v1/models` 返回为准（如 kimi-k3），
  不要凭文档记忆填（`kimi-k2-0711-preview` 这类旧名可能已下线）。
- **预防**：换 LLM 服务商时，先用 curl 验证 key + 模型名 + function calling 再改 .env。

### [2026-09] LLM 把股票名称映射成错误代码 / 搜不到时凭记忆作答
- **现象**：用户说"比亚迪"，LLM 填了错误的 code 参数调用技能；或搜索未命中后，LLM 不调工具、直接凭记忆编行情。
- **根因**：名称→代码靠模型自身知识无校验；prompt 约束（"不要凭记忆"）不是硬保证，弱模型/长对话/工具报错时容易退化到记忆作答。
- **解法**：`search_stock` 技能做名称→代码解析（SYSTEM_PROMPT 引导先搜后查）；搜索返回的候选带真实名称供 LLM 核对；**空结果和工具报错的提示文本里直接嵌入"如实告知、禁止凭记忆给出代码或行情"的指令**——tool message 的约束力比 system prompt 更贴近当下决策。
- **涉及文件**：`src/agent/loop.ts`（SYSTEM_PROMPT）、`src/skills/bundled/search/`
- **预防**：新增技能时，所有"失败/空结果"分支的返回文本都应包含对 LLM 的下一步行为指引，而不仅是给人看的错误描述。

### [2026-09] tool_calls 的 arguments 是字符串不是对象
- **现象**：直接 `toolCall.function.arguments.code` 拿到 undefined。
- **根因**：OpenAI 兼容协议里 `function.arguments` 是 **JSON 字符串**，必须先 `JSON.parse`；
  且 LLM 偶尔产出非法 JSON（多余逗号、未闭合），parse 要包 try/catch。
- **涉及文件**：`src/agent/loop.ts`

## 5. 调度 / 时区

### [2026-09-14] 调度器节假日判断放在"触发时"而非"算延迟时"——结构不能乱改
- **现象**：（设计约束，非 bug 记录）给调度器加法定节假日判断时，容易想把
  `msUntilNextRun` 改成 async 直接算到"下一个交易日"。
- **根因**：`msUntilNextRun` 是同步函数，调度链靠 `finally` 里的 `scheduleDaily()`
  重新调度保持不断链；改成 async 会动整个调度结构，风险大且无必要。
- **解法**：保持现有结构——`msUntilNextRun` 只同步跳周末，节假日判断在定时器
  **触发那一刻**做（`await tradeCalendar.isTradeDay(...)`，非交易日打日志跳过当日），
  `finally` 里的重新调度照常执行。改动 scheduler.ts 时**不能丢 `finally` 的重新调度**。
- **涉及文件**：`src/alerts/scheduler.ts`、`src/data/pythonService.ts`（TradeCalendar）

### [2026-09] 收盘日报在错误时间触发
- **现象**：部署到海外服务器后，15:30 推送变成了凌晨触发。
- **根因**：`new Date()` 用的是服务器本地时区，必须显式换算到北京时间。
- **解法**：见 `msUntilNextRun()` 的换算逻辑（`src/alerts/scheduler.ts:14`）；
  任何新增定时任务都必须用同样的北京时间换算，**不要直接用本地时区 setHours**。
  法定节假日已跳（`TradeCalendar`，2026-09-14 起），交易日历服务挂掉时降级为只跳周末。
- **涉及文件**：`src/alerts/scheduler.ts`

## 6. 渠道

### [2026-09-14] 飞书验签结果偶发不匹配：express.json 消费了原始请求体
- **现象**：按官方算法算 HMAC-SHA256 本地复现正确，但线上验签总失败。
- **根因**：签名是对**原始请求体字节**计算的；`express.json()` 解析后再
  `JSON.stringify(body)` 得到的字符串与原字节可能不同（空格、key 顺序、Unicode 转义），
  HMAC 自然对不上。
- **解法**：`express.json({ verify: (req, _res, buf) => req.rawBody = buf })` 保留原始
  Buffer，验签时用 rawBody（已在 `src/index.ts` + `feishu.ts rawBodyOf()` 处理）。
  **改全局 JSON 中间件时不能删 verify 回调。**
- **涉及文件**：`src/index.ts`、`src/channels/feishu.ts`
- **预防**：任何需要验签的 webhook（飞书/钉钉/GitHub）都必须用 raw body 验签。

### [2026-09] 飞书事件重复触发机器人回复
- **现象**：用户发一条消息，机器人回了两三条。
- **根因**：飞书要求事件接口快速返回 200，否则重推同一事件。
- **解法**：先 `res.json({ ok: true })` 再异步处理；并已按 `message_id` 去重
  （10 分钟窗口，2026-09-14 起已实现于 feishu.ts）。
- **涉及文件**：`src/channels/feishu.ts`

---

## 排查速查

| 症状 | 先看哪里 |
|---|---|
| 行情全挂 | `eastmoney.ts` 顶部注释 + 浏览器抓包对比东财页面 |
| 新闻/公告挂，行情正常 | data-service 是否启动、`pip install -U akshare` |
| LLM 不调用技能 | `.env` 的 `LLM_MODEL` 是否支持 function calling |
| 推送时间不对 | 服务器时区 + `scheduler.ts` 的北京时间换算 |
| 启动报模块找不到 | import 是否漏 `.js` 后缀 |
