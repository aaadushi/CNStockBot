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
- **⚠️ 2026-09-15 再加重（不限于 tsx）**：同日 data-service（uvicorn）也复现同款——
  一个昨日修复前启动的旧进程一直占着 8000 端口，`/health` 返回正常但公告/财报
  按旧代码报错。**凡"修复已提交但行为没变"的排查，第一步一律 `netstat -ano | findstr :端口`
  确认在跑的进程是新的**；data-service 与主服务都可能中招。
- **⚠️ 2026-09-16 第三变种（watch 干脆不重载 + 前后端错位）**：主服务 tsx watch 进程
  从 2026-09-15 20:48 启动后**从未热重载**——当晚三次 PR 合并、次日 F5-1 的全部文件
  变更都没生效，跑的是 F3-4 合并前的旧代码。本次的迷惑点在于**静态页面从磁盘实时读取
  （永远最新）而 API 是旧代码**：用户看到最新前端（有"涨停价"行、资金流卡、技术指标卡）
  但数据恒为 —/整块消失/404，极易误判为数据源故障。验证进程新旧的办法：打该版本的
  **特征端点/特征字段**（如 `/api/stocks/:code` 的 quote 是否含 limitUp 键、是否有
  fundFlowError 键），不要只看 /health 的 ok。同事故还发现 data-service 完全停机
  （8000 无监听）且主服务 /health 不反映其状态——完整记录见 STATUS.md P9/P10。

## 2. 东方财富接口（行情数据源）

### [2026-09-16] 腾讯盘前时段返回 "0.00" 字符串（非空串），字段缺失先查进程版本再怀疑数据源
- **现象**：盘前（9:30 前）详情页行情卡今开/最高/最低/成交额显示 —，换手率/量比显示
  0.00%/0.00，看似接口故障。
- **根因**：盘前无成交，腾讯 open/high/low 返回 `"0.00"`、`act()`/`opt()` 的 `v > 0` 判定
  把假 0 置 undefined（A-310 设计），成交额 0 由 fmtCap 显示 — —— 全部是**设计内行为**。
  实测 sz002594（2026-09-16 09:18）：今开/最高/最低 `"0.00"`、成交量/成交额 `"0"`、
  换手率/量比 `"0.00"`，而**涨停价/跌停价盘前就有值**（47=92.73 / 48=75.87）。
- **解法**：无需修。排查"某字段显示 —"的纪律：① 先直查 API 响应（字段是缺失还是有值）；
  ② 字段在 API 里就缺 → 核对运行进程的代码版本是否含该字段的解析（tsx watch 可能没
  重载，见"旧进程"条目 2026-09-16 变种）；③ 确认进程最新后才怀疑数据源，用
  `qt.gtimg.cn/q=<代码>` 抓原始响应逐字段核对。
- **涉及文件**：`src/data/tencent.ts`（opt/act 语义）、`public/stocks/index.html`（fmtCap 对 0 显示 —）
- **预防**： STATUS.md P10 已把盘前行为登记为"设计内"；排查字段缺失类报告按上面三步走，
  不要直接改解析逻辑。

### [2026-09-15] 腾讯字段表 mock 测试里的中文名称会让 GBK 解码吃掉 '~' 分隔符
- **现象**：构造腾讯响应做单测（名称填中文、Buffer.from(text, 'utf-8')），解析后下标 49
  之后的字段整体偏移一位，`f[49]` 读到的不是预期的值。
- **根因**：UTF-8 中文的末字节落在 GBK 前导字节范围（0x81–0xFE），`TextDecoder('gbk')`
  会把它和紧随其后的 `'~'`（0x7E 是合法 GBK 尾字节）拼成一个双字节字符，分隔符被吃掉。
  真实响应本身是 GBK 编码无此问题；只有"utf-8 编码 + GBK 解码"的手写 mock 会触发。
- **解法**：手写 mock 的名称字段用 ASCII（如 'TEST'）；中文名称验证一律走真实 GBK 录制的
  fixture 回放（tests/fixtures/tencent/）。
- **涉及文件**：`tests/tencent.test.ts`
- **预防**：给 GBK 文本协议写 mock 时，非 ASCII 内容必须按 GBK 编码造字节，否则用 ASCII。

### [2026-09-15] 新浪 `stock_zh_a_daily` 的成交量单位是"股"，东财是"手"（差 100 倍）
- **现象**：`/history` 降级到新浪源时，成交量比东财源大 100 倍（600519：新浪 1376172 vs
  东财 f47 13762 手），图表副图/技能输出若直接展示会差两个数量级。
- **根因**：AKShare 两个历史 K 线函数单位口径不同：`stock_zh_a_hist`（东财）成交量=手，
  `stock_zh_a_daily`（新浪）volume=股。
- **解法**：`/history` 端点新浪路径 `_hist_items(..., volume_div=100)` 归一到手。
  新浪源也无成交额/换手率列，这两字段降级时直接不输出（HistoryBar 可选字段）。
- **涉及文件**：`data-service/main.py`（/history、_hist_items）
- **预防**：接同一数据的不同源时，数值单位（手/股、元/万元/亿元）要逐字段交叉核对；
  用同一只票同日数据对比是最快的核对法。


### [2026-09-15] clist 排行榜里停牌股与平盘股混排在"零区"，平盘定位不能靠家数算页码
- **现象**：涨跌浏览页"平盘"Tab 返回 0 条，但 ulist 家数统计显示全市场有 80+ 只平盘股。
- **根因**：两个叠加的非直觉行为——① clist 按涨跌幅降序时，停牌股（f3=`"-"`）不排在末尾，
  而是**与涨跌幅恰为 0 的股票混排在零区**（实测 f3 序列：…0.1 → 0/"-" 混杂 → 负数）；
  ② ulist 家数统计（f104/f105/f106）不含停牌股，且必须带北交所 secid（0.899050）才是全市场
  ——只用 1.000001+0.399001 会漏掉北交所约 70 只上涨股，按上涨家数算零区页码必然偏前。
- **解法**：放弃"家数算页码"，改为二分查找"末条不再为正（含 '-'）"的第一页作为零区起点，
  向后扫描收集 f3 恰为 0 的条目；页内最后一个**数值**涨跌幅为负即停（不能用 "-" 判断）。
  实现在 `src/data/eastmoney.ts` 的 `fetchMovers()`。
- **涉及文件**：`src/data/eastmoney.ts`、`tests/movers.test.ts`
- **预防**：clist 的排序语义里 `"-"` 不是"排最后"；凡按值分段定位，先用真实响应观察边界区
  （零区/负区交界）的实际排列。另注意 clist 加 `fltt=2` 后 f2/f3 **不缩放**，与报价接口相反。

### [2026-09-15] push2delay 宿主：push2 限流期的同构延时接口（含估值字段交叉核对结果）
- **现象**：push2 对本机 IP 断连限流持续超 20 小时（curl exit 56，前一日录 fixture 高频触发），
  期间无法调东财任何 push2 端点、无法实测新字段编码。
- **根因**：东财 IP 级限流恢复时长不确定（几小时到 1 天+）；push2 与 push2his 限流独立。
- **解法**：`push2delay.eastmoney.com` 提供**同构的延时行情接口**（同 URL 路径/字段编码，
  行情延时约 15 分钟）：stock/get、clist/get、ulist.np/get 实测均可用，限流期可用于验证字段、
  录 fixture；涨跌榜已把它作为自动降级宿主（返回数据标 `delayed: true`）。
  **注意它是延时行情，不要把个股实时报价切过去**（个股降级走腾讯）。
  估值字段实测核对结果（600519，与腾讯接口交叉一致）：
  f162 市盈率（动） f163 市盈率（静） f164 市盈率（TTM) f167 市净率 —— **均放大 100 倍**；
  f116 总市值 f117 流通市值 —— **单位元，不放大**（大数值，误用 ÷100 会差 100 倍）。
  腾讯侧对应下标：39=PE(TTM) 52=PE（动） 53=PE（静） 46=PB 44/45=流通/总市值（**单位亿元**，×1e8 转元）。
  F3-3 补充（2026-09-15 同法核对）：f47 成交量（手）/ f48 成交额（元，浮点）—— **不放大**；
  f168 换手率 / f50 量比 —— 放大 100 倍。腾讯侧：6=成交量（手） 37=成交额（万元，×1e4 转元）
  38=换手率（%) 49=量比，均不缩放；空串=缺失（先判空串再 Number，`Number('') === 0`）。
  F3-2 补充：`ak.stock_individual_info_em` 同样走 push2，限流期必挂（ConnectionError 断连，
  无 HTTP 码）；data-service `/profile` 已内置 push2delay 同构直连降级（公司资料是静态信息，
  不受延时影响；f189 上市时间为 yyyymmdd 整数）。
- **涉及文件**：`src/data/eastmoney.ts`（FIELDS 与解析、PUSH2_HOSTS）、`src/data/tencent.ts`、
  `data-service/main.py`（`/profile` 的 `_profile_via_delay_host`）
- **预防**：东财"全挂"时先区分 push2 限流 vs 字段变更；限流期验证/调试用 push2delay；
  接新字段时市值类大数值字段先确认是否缩放。

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

### [2026-09-15] 资金流接口选型：腾讯 ff_ 已下线；push2delay 镜像 fflow 只回 1 行；新浪比率是小数
- **现象**：接入个股资金流（F3-4）时三路探源——① 腾讯 `qt.gtimg.cn/q=ff_sh600519`
  返回 `v_pv_none_match="1"`（接口已下线，不是参数错误）；② `push2delay.eastmoney.com`
  确实镜像了 push2his 的 `/api/qt/stock/fflow/daykline/get`，**但无视 lmt 参数只回当日
  1 行**，不能作历史降级源（仍可用于核对字段口径：东财百分数字段已是 % 单位，实测
  f63 涨跌幅 -0.41 = -0.41%）；③ 新浪 `MoneyFlow.ssl_qsfx_zjlrqs` 可用，但
  changeratio/ratioamount/r0_ratio 是**小数**（-0.0738 = -7.38%），直接当百分数展示会小 100 倍。
- **根因**：`ak.stock_individual_fund_flow` 走 push2his（与 /history 东财源同宿主，
  限流状态联动——本机封禁中全 subdomain 都被掐）；腾讯旧资金流接口随行情协议迭代下线；
  新浪 MoneyFlow 字段无文档，单位只能靠与行情/成交额交叉验算。
- **解法**：主源 AKShare `stock_individual_fund_flow`（五档，market=sh/sz/bj，**920 段
  属北交所须先于 "9" 判断**），降级新浪 MoneyFlow 直连（两档，小数 ×100，不覆盖北交所）；
  两源**口径不同**（新浪"净流入"含全部资金 ≠ 东财"主力净流入"），响应带 source 字段标注，
  前端按源切换标签，不可跨源对比数值。
- **涉及文件**：`data-service/main.py`（/fund-flow、_fund_flow_via_sina）
- **预防**：给"看似有多个免费源"的数据选型时，先用同一只票同日数据逐一实测再定降级链；
  废弃接口的典型信号是 `v_pv_none_match`（腾讯）与只回 1 行（delay 镜像的翻页类接口）。

### [2026-09-15] `fund_etf_spot_em` 全量翻页 30s+，默认 run_ak 30s 超时刚好踩线
- **现象**：接入场内 ETF 实时榜时，akshare 1.18.94 实测 `ak.fund_etf_spot_em()` 需翻页
  约 16 页、耗时 30s 以上，按统一 30s 超时直接 504
- **根因**：该接口无分页参数，AKShare 内部串行翻全量页
- **解法**：该端点单独放宽 run_ak 超时到 120s + 结果缓存 60s（防刷新打爆上游）；
  主服务客户端超时 60s，首次未缓存请求可能仍踩线，缓存命中后恢复
- **涉及文件**：`data-service/main.py`（/funds/etf 端点）
- **预防**：接入 AKShare 全量快照类接口（无分页参数的榜单/代码表）先实测耗时，
  超 10s 的一律配进程内缓存；`fund_open_fund_rank_em` 同样按类型返回全量（千只级），
  已按类型缓存 10 分钟

### [2026-09-15] FastAPI 中 `/funds/{code}` 路径参数路由会吞掉 `/funds/rank` 等固定路径
- **现象**：若 `/funds/{code}` 声明在 `/funds/rank`、`/funds/search`、`/funds/etf` 之前，
  访问 /funds/rank 会被当作 code="rank" 匹配，报"基金不存在"类错误
- **根因**：FastAPI/Starlette 按声明顺序匹配路由，路径参数路由优先即遮蔽固定路径
- **解法**：`/funds/{code}` 一律声明在同前缀固定路径之后（main.py 基金版块节有注释）
- **涉及文件**：`data-service/main.py`
- **预防**：新增 `/xxx/{param}` 型端点时检查同前缀固定路径的声明顺序
### [2026-09-15] 财联社快讯 `stock_info_global_cls` 的"标题"列常为空串，且无链接
- **现象**：接入财经快讯降级源时发现返回 DataFrame 约半数行"标题"为空（短电报只有"内容"），
  且全表无 URL 列；直接按"标题"渲染会出现一批空白条目。
- **根因**：财联社电报原文就是一句话快讯，AKShare 把电报体塞进"内容"列，"标题"只对有正式
  标题的长文填充；该接口本来就不提供原文链接。
- **解法**：`/market-news` 端点的 `_market_news_from_cls()` 对空标题取"内容"前 60 字充任，
  `url` 固定空串（前端据此渲染为纯文本块而非链接）；空标题行最后再过滤一道兜底。
- **涉及文件**：`data-service/main.py`（/market-news）
- **预防**：接 AKShare 资讯类接口先 `df.head()` 抽查**每一列的空值率**，不要假设"标题"列必填。

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
- **解法**：确认 data-service 已启动且 `PYTHON_SERVICE_URL` 配置正确；
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
