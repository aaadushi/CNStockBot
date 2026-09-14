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

## 2. 东方财富接口（行情数据源）

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

### [2026-09-14] `stock_financial_abstract` 参数名是 `stock`，返回值全是带单位字符串
- **现象**：按惯例写 `symbol="600519"` 会报 TypeError（未知参数）；拿到的"净利润"是
  `"999,862,000.00元"` 这种字符串，直接 `float()` 会炸。
- **根因**：该接口爬新浪财务摘要页，参数命名为 `stock`；页面数值本身带"元"后缀和
  千分位逗号，AKShare 原样返回 str。
- **解法**：调用写 `ak.stock_financial_abstract(stock=code)`；本项目不做数值清洗，
  原样传给 LLM 阅读（端点 `col_map` 注释有说明）。若未来要做同比/环比计算，
  先 strip "元" 和逗号再转 float。
- **涉及文件**：`data-service/main.py` 的 `/financials` 端点
- **预防**：接 AKShare 新接口前先查官方文档确认参数名，不要想当然复用 `symbol`。

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

### [2026-09] 收盘日报在错误时间触发
- **现象**：部署到海外服务器后，15:30 推送变成了凌晨触发。
- **根因**：`new Date()` 用的是服务器本地时区，必须显式换算到北京时间。
- **解法**：见 `msUntilNextRun()` 的换算逻辑（`src/alerts/scheduler.ts:14`）；
  任何新增定时任务都必须用同样的北京时间换算，**不要直接用本地时区 setHours**。
  另注意：该实现只跳过周末，**不跳法定节假日**——节假日会推送空/昨日行情，属已知限制。
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
- **解法**：先 `res.json({ ok: true })` 再异步处理；或按 `message_id` 去重（feishu.ts TODO 项）。
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
