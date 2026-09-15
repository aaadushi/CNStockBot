# 功能与问题清单（STATUS）

> **本文件的用途**：让接手的 agent / 工程师在 5 分钟内看清——哪些功能已能用、哪些没做、
> 当前最痛的已知问题是什么。**每次完成功能或发现新问题都要更新本文件。**
>
> 分工：架构原理看 [ARCHITECTURE.md](ARCHITECTURE.md)；每个功能"怎么实现的、代码在哪"
> 看 [FEATURES.md](FEATURES.md)；踩过的坑看 [PITFALLS.md](PITFALLS.md)；
> 数据源接口细节看 [DATA_SOURCES.md](DATA_SOURCES.md)。

最后更新：2026-09-15

---

## 一、已实现功能

| 功能 | 入口 | 状态 | 备注 |
|---|---|---|---|
| 对话主循环（LLM + function calling） | `src/agent/loop.ts` | ✅ 可用 | 会话历史 SQLite 持久化，**含工具调用上下文**（P3 已解决）；同用户消息串行队列防并发覆盖 |
| 技能框架（SKILL.md + 注册表） | `src/skills/` | ✅ 可用 | 新增技能四步见 CLAUDE.md；启动检测技能重名；参数校验助手 `args.ts` |
| 实时行情查询 `get_stock_quote` | `src/skills/bundled/quote/` | ✅ 可用 | 东财公开接口，免 key；**东财失败自动降级腾讯行情**（2026-09-15）；涨跌幅缺失显示 — 而非静默 0；2026-09-15 起输出含估值与市值（F3-1）、成交额/换手率/量比（F3-3） |
| 新闻查询 `get_stock_news` | `src/skills/bundled/news/` | ✅ 可用 | 依赖 Python data-service 运行 |
| 自选股管理 `manage_watchlist` | `src/skills/bundled/watchlist/` | ✅ 可用 | SQLite 持久化，按 userId 隔离；停牌股可入自选（搜索降级验证）；action 白名单防误删 |
| 股票搜索 `search_stock` | `src/skills/bundled/search/` | ✅ 可用 | Python 全量表优先，东财 suggest 降级（降级有日志）；覆盖北交所 4/8/920 |
| 公告查询 `get_stock_announcements` | `src/skills/bundled/announcement/` | ✅ 可用 | 巨潮资讯个股公告，依赖 Python data-service 运行；2026-09-14 新增 |
| 财报查询 `get_stock_financials` | `src/skills/bundled/financials/` | ✅ 可用 | 新浪财务摘要（按报告期），依赖 Python data-service 运行；2026-09-14 新增 |
| WebChat 网页聊天 | `src/channels/webchat.ts` + `public/webchat/` | ✅ 可用 | API 需访问口令（Bearer，恒定时间比较），静态页面不鉴权；2026-09-14 解决 P5 |
| 离线通知收件箱（/api/inbox 轮询） | `src/channels/webchat.ts` | ✅ 可用 | **SQLite 持久化**（每用户上限 100 条），重启不丢；同在口令保护内 |
| 收盘日报定时推送（交易日 15:30） | `src/alerts/scheduler.ts` | ✅ 可用 | 已跳法定节假日（交易日历降级只跳周末）；2026-09-14 解决 P2 |
| 异动提醒（盘中轮询，超阈值推送） | `src/alerts/scheduler.ts` | ✅ 可用 | 默认 ±5%、每 5 分钟，每股每日只报一次；推送失败下轮补报；单用户失败不中断他人 |
| 行情健康探针 | `src/alerts/healthProbe.ts` | ✅ 可用 | 默认每 30 分钟探测 600519，连续失败 2 次告警、恢复通知；状态见 /health 的 quoteProbe；2026-09-14 解决 P4 |
| 大盘指数查询 `get_market_index` | `src/skills/bundled/index/` | ✅ 可用 | 8 个常用指数显式 secid 映射，不传参返回核心指数概览；名称匹配归一化（"创业板指数"等说法可识别）；2026-09-14 新增 |
| Python 数据微服务（行情/新闻/搜索） | `data-service/main.py` | ✅ 可用 | FastAPI + AKShare；AKShare 调用统一 30s 超时（504），财报 NaN/交易日历格式已加固 |
| 飞书渠道 | `src/channels/feishu.ts` | ✅ 可用 | 验签（含 ±5 分钟防重放）/token 缓存/回复/去重/主动推送；chat_id 映射 **kv 表持久化**（只学单聊，防持仓日报进群）；双凭据缺失时 fail-closed |
| 股票浏览页 + 个股详情页（/stocks） | `public/stocks/` + `src/channels/webchat.ts` | ✅ 可用 | F1/F2 完成：自选股圆角卡片列表、页内搜索（同款卡片结果）、详情页行情/公司资料/资金流/走势图/新闻/公告/财报；API 全部在口令鉴权后；2026-09-15 |
| 历史 K 线数据（走势图数据源） | `data-service/main.py` `/history` + `DataProvider.getHistory` | ✅ 可用 | 前复权日 K；东财 `stock_zh_a_hist` 失败自动降级新浪 `stock_zh_a_daily`（push2his 限流托底，见 PITFALLS）；2026-09-15 起东财源透出成交额/换手率（F3-3），新浪降级源无此列、成交量已归一（股→手） |
| 前端共享设计系统 | `public/shared/theme.css` | ✅ 可用 | ShadcnUI 风格（黑白灰 + indigo CTA、圆角卡片、微阴影）；webchat 与 stocks 两页共用；2026-09-15 UI 重设计 |
| 全市场涨跌榜（/market） | `public/market/` + `src/channels/webchat.ts` `/api/market/movers` | ✅ 可用 | 今日涨幅榜/跌幅榜/平盘三 Tab + 涨跌平家数总览（沪深京）；东财 clist/ulist 接口，push2 限流自动降级 push2delay（延时 15 分钟，页面标注）；不依赖 data-service；2026-09-15 新增 |
| 基金版块（/funds + 基金技能，F4-B） | `public/funds/` + `src/skills/bundled/fundrank/`、`fundinfo/` + data-service `/funds/*` | ✅ 可用 | 开放式基金排行（按类型）/基金搜索/基金详情净值走势/场内 ETF 实时榜；天天基金数据（支付宝同源）经微服务，依赖 data-service 运行；2026-09-15 新增 |
| 财经快讯（/news + `get_market_news` 技能） | `public/news/` + `src/skills/bundled/marketnews/` + data-service `/market-news` | ✅ 可用 | 全市场财经快讯（区别于个股新闻）；东财全球快讯主源、财联社降级，进程内缓存 90s；网页 60s 自动刷新；依赖 data-service；2026-09-15 新增（F4-A） |

## 二、待办优先级总表（下一个 agent 从这里开始）

> **分级含义**：S0 = 不做系统跑不起来（环境前置）；S1 = 影响正确性/安全，最该先做；
> S2 = 工程质量，防回归；S3 = 体验与健壮性，有余力再做。
> 代码类问题的详细描述在第三节（P 编号稳定，不重排）。

### S0 环境前置（当前状态：✅ 已就绪，系统可运行）

| # | 事项 | 现状 | 做法 |
|---|---|---|---|
| S0-1 | ~~配置 LLM_API_KEY~~ | ✅ 2026-09-15 已配置 **Kimi 开放平台**（kimi-k3，工具调用实测正常）。注意：Kimi 会员 key（sk-kimi- 开头）不能用于开放平台 API（401），必须用 platform.moonshot.cn 创建的 key | 换服务商时改 .env 的 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL 三行 |
| S0-2 | ~~固定 ACCESS_TOKEN~~ | ✅ 已在 .env 固定 | — |
| S0-3 | ~~安装 data-service 依赖~~ | ✅ 2026-09-14 已建 venv 并装好（akshare 1.18.94），实测 /health、/trade-calendar 通过 | 以后依赖变更：`cd data-service && .venv\Scripts\activate && pip install -r requirements.txt` |
| S0-4 | （可选）飞书凭据 | 未启用 | 需要飞书渠道时配 `FEISHU_*` 系列变量（ENCRYPT_KEY 与 VERIFICATION_TOKEN 至少配其一，否则事件接口 fail-closed） |

### S1 高优先级（代码问题）

~~P3、P4 均已于 2026-09-14 解决（见更新日志）。当前无 S1 事项。~~

### S2 中优先级（工程质量）

| # | 事项 | 现状 |
|---|---|---|
| S2-1 | ~~AUDIT.md 全模块代码审计~~ | ✅ 2026-09-14 首轮完成：6 个并行审查 agent 全覆盖 14 模块，发现 46 条问题（🔴2 🟡25 🔵19），全部修复并经原审查 agent 复核**全部闭环**（含 A-101 复核打回后二次修复；A-508/A-601 争议裁定接受，分别留待非回环部署与 S3-3） |
| S2-2 | ~~scheduler 时间函数 export + 单测~~ | ✅ 已完成（tests/scheduler.test.ts，vi.setSystemTime） |
| S2-3 | ~~Store 公开 close()~~ | ✅ 已完成，测试改用公开方法 |
| S2-4 | ~~fixture + tsconfig 纳入 tests/~~ | ✅ 已完成（tests/fixtures/eastmoney/ 真实响应回放；tsconfig.typecheck.json） |

### S3 低优先级（体验与健壮性）

| # | 事项 | 现状 |
|---|---|---|
| S3-1 | ~~inbox 落 SQLite~~ | ✅ 已完成（每用户上限 100 条） |
| S3-2 | ~~飞书 chat_id 映射持久化~~ | ✅ 已完成（kv 表；只学单聊映射，防持仓日报进群） |
| S3-3 | WebChat 共享口令 → 多用户体系（仅公网部署前才必须做） | 未做。**注意审计 A-601 标注：同口令持有者之间无身份隔离**（userId 客户端自报） |

**原路线图（公告/财报/飞书/持久化/异动提醒/大盘指数）已于 2026-09-14 全部完成；**
**P5 鉴权、P2 法定节假日、P6 测试基座、P3 工具上下文、P4 健康探针同日完成。**
**同日完成首轮全模块代码审计（46 条发现，修复后经原审查 agent 复核全部闭环）。**

## 三、已知问题（按痛感排序）

> 每条给出：影响、根因、建议修法。解决后从本节移除并记入更新日志。
> **P 编号是稳定 ID，解决后不重排**（其他文档按编号引用本节）。

### P2 ~~收盘日报不跳法定节假日~~（已解决，见更新日志 2026-09-14）

### P3 ~~会话历史丢失工具调用上下文~~（已解决，见更新日志 2026-09-14）

### P4 ~~东财接口静默失效无人察觉~~（已解决，见更新日志 2026-09-14；接口本身仍是非官方接口，字段可能变，排查先看 PITFALLS.md）

### P5 ~~无任何鉴权，userId 由前端自报~~（已解决，见更新日志 2026-09-14）

### P6 ~~无自动化测试~~（已解决，见更新日志 2026-09-14）

### P8 LLM 429 限流（Kimi 低等级账号 RPM 配额低，暂不修）
- **影响**：一次对话的工具调用循环会连续发起多轮 LLM 请求，Kimi 新账号/低等级账号
  每分钟配额低，对话偶发 `LLM 请求失败 429`。
- **根因**：Moonshot 按账号等级限 RPM；agent 循环无 429 重试（审计 A-102 的建议修法
  里提过"可选：429/5xx 有限重试"，当时未做）。
- **建议修法**：LLM 客户端对 429/5xx 加 1~2 次指数退避重试（如 5s/15s）；
  或用户在 Kimi 平台充值提升账号等级。**用户决定暂不修（2026-09-15）**。

---

## 四、功能路线图（待做，交给下一个 agent）

> ~~F1 股票浏览页+个股详情页、F2 浏览页内搜索~~ 均已于 2026-09-15 完成（见更新日志）。

### F3 个股信息补全（用户 2026-09-15 指定："这些信息以后都要补上"）

详情页（/stocks?code=）目前只有行情快照、日 K 走势图、新闻/公告/财报。按用户确认的
缺口清单补齐以下信息，**建议按 F3-1 → F3-6 顺序做**（成本从低到高）：

| # | 信息 | 数据来源建议 | 落点 |
|---|---|---|---|
| ~~F3-1~~ | ~~**估值与规模**~~ | ✅ 2026-09-15 完成（见更新日志） | — |
| ~~F3-2~~ | ~~**公司资料**：所属行业、板块、上市日期、总股本~~ | ✅ 2026-09-15 完成（见更新日志） | — |
| ~~F3-3~~ | ~~**成交活跃度**：成交额、换手率、量比~~ | ✅ 2026-09-15 完成（见更新日志） | — |
| ~~F3-4~~ | ~~**资金流**：主力/超大单净流入~~ | ✅ 2026-09-15 完成（见更新日志） | — || F3-5 | **分时数据**（今日分时走势） | `ak.stock_zh_a_hist_min_em(symbol=code, period="1")` 或东财 trends2 接口；注意数据量大，前端图可复用现有 SVG 折线组件 | 详情页走势图加"分时/日K"切换 |
| F3-6 | **其他**（低优先）：涨跌停价、52 周高低、分红送配 | 涨跌停：东财 push2 f51/f52（抓包核对）；分红：`ak.stock_history_dividend_detail` | 详情页补充展示 |

**通用注意**：
- 东财字段全是 f 编码且价格类放大 100 倍，动手前先读 PITFALLS 东财条目
- data-service 新端点必须走 `run_ak()`（30s 超时）；耗时接口配缓存（参考公告降级的 `_notice_cache`）
- API 加端点挂 `/api` 口令鉴权后；前端所有接口文本一律 `textContent` 渲染
- 完成后更新 STATUS（本节移除对应行 + 更新日志）、FEATURES、如涉及端点更新 data-service/README

### F4 基金与财经资讯版块（用户 2026-09-15 指定，开发中）

用户要求：项目内可查看"支付宝相关版块"与"财经相关内容"——经确认，范围是
**股票 + 基金相关内容**：基金（净值/排行/场内 ETF，对标支付宝财富页的基金版块）
与全市场财经快讯。呈现形式：**网页新页面 + 聊天技能都做**（与 F1/F2 模式一致）。
拆分为两个可并行的子任务链：

**F4-A 财经快讯版块**（全市场股票/基金资讯，区别于个股新闻）

| # | 事项 | 数据来源建议 | 落点 |
|---|---|---|---|
| ~~F4-A1~~ | ~~快讯数据~~ | ✅ 2026-09-15 完成（见更新日志）：`/market-news`，东财 `stock_info_global_em` 主源（实测 200 条含 URL）+ 财联社 `stock_info_global_cls` 降级，缓存 90s | 数据层 |
| ~~F4-A2~~ | ~~聊天技能~~ | ✅ 2026-09-15 完成：`get_market_news`（`src/skills/bundled/marketnews/`），SYSTEM_PROMPT 加了与个股新闻的 routing 引导 | 对话 |
| ~~F4-A3~~ | ~~网页~~ | ✅ 2026-09-15 完成：`/news` 页（60s 自动刷新）+ `GET /api/market/news`（口令鉴权后），/stocks 与 /market 页头加导航 | 前端 |

**F4-B 基金版块**（对标支付宝财富页的基金内容）

| # | 事项 | 数据来源建议 | 落点 |
|---|---|---|---|
| ~~F4-B1~~ | ~~开放式基金排行/净值~~ | ✅ 2026-09-15 完成（见更新日志） | — |
| ~~F4-B2~~ | ~~场内 ETF 行情~~ | ✅ 2026-09-15 完成（push2 复用路径放弃，统一走微服务，理由见 PITFALLS/DATA_SOURCES） | — |
| ~~F4-B3~~ | ~~聊天技能 `get_fund_rank` / `get_fund_info`~~ | ✅ 2026-09-15 完成 | — |
| ~~F4-B4~~ | ~~网页 `/funds`（排行/ETF Tab + 搜索 + 净值走势图）~~ | ✅ 2026-09-15 完成 | — |

**通用注意**（沿用 F3 约定）：
- data-service 新端点必须走 `run_ak()`（30s 超时）；耗时接口配进程内缓存（参考公告 `_notice_cache` 与搜索代码表缓存）
- API 加端点挂 `/api` 口令鉴权后；前端所有接口文本一律 `textContent` 渲染
- 基金/快讯输出同样必须带"仅供参考，不构成投资建议"（对话技能走 SYSTEM_PROMPT 既有规则）
- 完成后更新 STATUS（本节对应行标 ✅ + 更新日志）、FEATURES（新增节）、DATA_SOURCES（新 AKShare 函数入表）、如涉及端点更新 data-service/README

### F5 分析与监控增强（用户 2026-09-15 指定，参考 tickflow-stock-panel）

用户指定参考开源项目 [tickflow-stock-panel](https://github.com/shy3130/tickflow-stock-panel)
（自托管 A 股量化工作台：选股 + 监控 + 回测 + AI 复盘），引入其**分析与监控**能力。
**红线（动手前必须读）**：本项目永不荐股、不做交易下单；"分析/预测"的范围限定为
**技术指标与关键价位等客观计算 + LLM 汇总解读**，禁止输出买卖建议、价格目标预测、
涨停预测（TSP 项目本身同样声明不做这些）。一切分析类输出带"仅供参考，不构成投资建议"。

**排期**：在 F3 剩余项与 F4-B 完成后启动；内部按 F5-1 → F5-2/3/4（轻量，可并行）
→ F5-5/6（重资产，后置）推进。

**轻量功能**（数据基础已有，成本可控）：

| # | 功能 | 实现要点 | 落点 |
|---|---|---|---|
| F5-1 | **技术指标分析**：MA/EMA/MACD/RSI/KDJ/BOLL + 关键价位（支撑/压力） | data-service 基于现有 `/history` 前复权日 K **纯本地计算**（pandas，无新外部依赖），新增如 `/indicators/{code}` 端点；关键价位可用近 N 日高低点 + 均线簇等客观方法，算法选定后在 DATA_SOURCES 记录口径 | 数据层 + 详情页（走势图叠加均线 + 指标面板） |
| F5-2 | **AI 个股多维分析** | 新聊天技能 `analyze_stock`：一次聚合行情/估值/财报/新闻/技术面（F5-1）结构化数据，交 LLM 生成多维度解读；详情页加"AI 分析"入口（复用 /api/chat 链路） | 对话 + 详情页 |
| F5-3 | **盘后复盘推送** | 收盘日报（15:30）升级：附加自选股技术面信号摘要（如 MA 金叉/死叉、RSI 超买超卖、突破关键价位），走现有 notify 链路；信号口径与 F5-1 一致 | alerts/scheduler |
| F5-4 | **多条件监控提醒** | 异动提醒从单一涨跌幅阈值升级为**可配置多条件**（价格上下限 / 涨跌幅 / 指标信号），AND/OR 组合；沿用"每股每条件每日一次"去重与推送失败补报机制；条件配置存 SQLite | alerts/scheduler + storage |

**重资产功能**（共同前置：本地全市场行情库，做完 F5-1~4 再评估启动）：

| # | 功能 | 实现要点 | 落点 |
|---|---|---|---|
| F5-5 | **选股扫描** | 前置：data-service 建本地全市场日 K 缓存（建议 DuckDB 或 SQLite，每日盘后增量更新任务，注意东财/新浪限流节奏）；然后指标条件全市场扫描；可参考 TSP 的 18 个内置策略模板 | 数据层 + 新页面/技能 |
| F5-6 | **回测引擎** | 前置同 F5-5；真实 A 股规则（T+1、手续费、滑点、止损）；对单股策略做历史信号回放与收益统计。**回测结果同样不构成投资建议**，页面与技能输出须显著标注历史业绩不代表未来 | 数据层 + 新页面 |

**通用注意**（沿用 F3/F4 约定）：
- data-service 新端点必须走 `run_ak()` 超时包装；指标计算虽为本地运算，端点仍统一
  try/except 包成结构化错误
- API 加端点挂 `/api` 口令鉴权后；前端所有接口文本一律 `textContent` 渲染
- 完成后更新 STATUS、FEATURES（新增节）、DATA_SOURCES（指标口径入表）、
  如涉及端点更新 data-service/README

### F6 形态识别与多维共振分析（用户 2026-09-15 指定，参考小红书博主"递归熵"的个人量化系统）

参考来源：小红书帖子（公众号"递归熵"），介绍其 DeepSeek 驱动的个人量化系统：
pattern_analyzer（K 线形态识别 + 历史成绩单）、狙击手模块（分笔资金验货）、
四维共振决策（形态 + 资金 + 板块 + 历史数据）、全市场扫描 + 自选池深度盯盘两条线、
板块轮动监控、美股联动。**该系统核心理念与项目红线一致**——"机器不负责替我赚钱，
机器负责替我把值得研究的机会找出来"；所有概率数字都是历史统计口径，不是预测。

**呈现要求（用户明确指定）**：各能力在网页端**分成独立区块/独立入口**，方便用户
分版块查看，不要揉在一起——详情页内用独立卡片区，全市场类功能用独立导航页。

| # | 功能 | 实现要点 | 落点 |
|---|---|---|---|
| F6-1 | **K 线形态识别 + 历史成绩单**（先 20 种经典形态：杯柄/双重底/头肩底/红三兵/上升三角形/口袋支点等） | data-service 基于 `/history` 长窗口（约 3 年日 K）**纯本地计算**：形态匹配 → 统计该形态历史出现次数、出现后 5/10/20 日表现（上涨占比/平均涨跌幅/最大回撤）。**输出模板必须带"过去 N 次中 X 次上涨……历史统计不代表未来表现，仅供参考，不构成投资建议"** | 详情页独立"形态分析"卡片区 + 聊天可查询 |
| F6-2 | **资金流验货**（"狙击手"模式） | 依赖 F3-4 资金流数据：形态触发时叠加资金流交叉验证（大单方向/主动买卖/尾盘变化），输出分档结论（重点观察 / 存疑 / 观察名单）；分笔 tick 数据（如 `ak.stock_intraday_em`）接入前需实测稳定性，不稳则用日级资金流替代并在 FEATURES 注明口径 | 详情页独立验货区 + 作为 F5-2 多维分析的信号源 |
| F6-3 | **板块轮动监控** | 东财板块接口（`ak.stock_board_industry_*`）：行业板块涨跌/资金流强弱排行、个股-板块共振判断 | 独立页面区块（/market 扩展或新页面） |
| F6-4 | **外盘联动监控** | 美股板块异动 + 国际金银价格（AKShare 美股/期货接口，接入前实测），每交易日开盘前生成"A 股相关方向提示"。**范围扩界说明**：外盘仅作参考信息源，行情查询/自选股等主功能仍只做 A 股 | 独立区块 + 盘前推送（可选） |

**依赖与排期**：整体排在 F3 剩余项、F4-B 之后，与 F5 轻量项交错——F6-1 与 F5-1
共享历史数据/指标计算底座，建议 F5-1 完成后紧接着做；F6-2 依赖 F3-4；F6-3/F6-4
相互独立，可并行。形态库先 20 种跑通"识别 → 历史统计 → 展示"链路再评估扩库
（100+ 形态识别调优成本高，不一次到位）。

**红线补充**（在 F5 红线基础上）：
- "上涨概率 72%"这类数字的口径是**历史事实统计**（过去 N 次类似形态出现后 X 日内
  的实际表现），必须按此口径表述并带免责声明，**禁止表述为对未来的预测或买卖建议**
- F6-4 外盘数据仅作参考信息，不生成任何买卖建议

### 其他候选方向（无排期）

1. **S3-3 多用户体系**（公网部署前必做）：WebChat 共享口令 → 独立账号，解决 A-601 身份隔离
2. 详情页 K 线蜡烛图（现有数据已含 OHLC）
3. 浏览页与聊天联动：详情页"问机器人这只股票"按钮（跳转 /webchat 预填问题）
4. 自选股分组 / 成本价录入与持仓盈亏展示
5. P8：LLM 429 指数退避重试（用户决定暂不修，复发时做）

---

## 更新日志

- 2026-09-15（夜间批次 5）：**F3-4 资金流完成**——data-service 新增 `GET /fund-flow/{code}?days=`
  （默认 30、上限 100，按代码缓存 60s）。降级链：主源 AKShare `stock_individual_fund_flow`
  （东财 push2his fflow/daykline，主力/超大单/大单/中单/小单五档净流入，market=sh/sz/bj 按
  代码前缀映射——**920 段属北交所须先于 "9" 判断**）；push2his 限流（本机仍在封禁）自动降级
  **新浪 MoneyFlow**（`MoneyFlow.ssl_qsfx_zjlrqs` 直连，AKShare 未封装）：仅"净流入/超大单"
  两档且口径不同（新浪"净流入"含全部资金 ≠ 东财"主力净流入"），响应带 `source` 字段
  （eastmoney/sina）供前端标注；新浪不覆盖北交所，bj 代码双源失败合并报错。
  **字段口径核对**：东财百分数字段已是 % 单位（push2delay 同构接口实测——该镜像只回当日 1 行，
  不能作历史降级源）；新浪 changeratio/ratioamount/r0_ratio 是**小数需 ×100**。
  腾讯 `ff_` 资金流接口已下线（返回 `v_pv_none_match`，PITFALLS 已记录）。
  主服务：`DataProvider` 加 `FundFlowDay`/`FundFlow` 与 `getFundFlow`，CompositeProvider 接线；
  `/api/stocks/:code` 聚合扩为六块（+fundFlow/fundFlowError 独立降级）。前端：详情页公司资料卡
  下方新增"资金流向"卡（最新交易日主力/超大单/大/中/小单汇总格 + **近 15 日主力净流入柱状图**
  零线上下红绿柱 + hover 分档 tooltip；新浪源标签改"净流入"并注明口径差异）。
  验证：typecheck + 122 测试全绿（fundflow 5 条新用例）+ py_compile 通过；端到端实测
  /fund-flow 沪深两码（sina 降级路径，数值与新浪网页口径一致）、bj 码 502 合并报错、
  无效代码 502、days 上限 422、/api/stocks 聚合六块正确且 bj 码资金流块独立降级不拖垮其他块、
  401 正常、详情页内联 JS node --check 通过（验证端口 8104/18804，验后已停）。
  **未覆盖**：东财主源五档列名未实测（push2his 对本机限流中，列名为 AKShare 源码口径，
  漂移时 _fnum 置 null 而非静默 0）。顺带修正 PITFALLS 里 data-service 地址环境变量的
  过时名字（DATA_SERVICE_URL → 实际为 PYTHON_SERVICE_URL）。

- 2026-09-15（夜间批次 4）：**F3-3 成交活跃度完成**——`Quote` 新增 volume/amount/turnover/
  volumeRatio 可选字段。东财 push2 加 f47（成交量，手）/f48（成交额，元，浮点）——**不缩放**，
  f168（换手率）/f50（量比）——放大 100 倍（push2delay + 腾讯实时响应交叉实测核对一致；
  腾讯侧 6=手 / 37=成交额万元×1e4 / 38=换手率 / 49=量比，空串缺失先判空再 Number）。
  `HistoryBar` 加 amount/turnover 可选字段，`/history` 东财源透出"成交额/换手率"列
  （列名漂移时不输出该字段而非静默 0）；**顺带修复新浪降级源成交量单位差 100 倍的问题**
  （新浪按股返回，÷100 归一到手，PITFALLS 已记录）。落点三处：详情页统计格加成交额/
  换手率/量比、走势图加**成交量副图**（红涨绿跌柱，tooltip 加成交量/成交额/换手率）、
  `get_stock_quote` 技能输出加成交活跃度行（缺失整条不显示）。
  验证：typecheck + 112 测试全绿（东财/腾讯解析 4 条新用例 + fixture 重录回放 + quote
  技能格式化 2 条）+ py_compile 通过；端到端实测 /api/stocks/600519 聚合 quote 含成交
  字段（东财直连路径，与 push2delay/腾讯三方数值一致）、/history 新浪降级路径成交量归一
  且 amount/turnover 正确缺省、401/无效代码正常（验证端口 8103/18803，验后已停）。
  **未覆盖**：东财源 /history 的 amount/turnover 列透出未实测（push2his 对本机限流中，
  列名为 AKShare 公开文档口径，漂移时降级为不输出该字段）。另记录新坑：手写腾讯 mock
  用中文名称会被 GBK 解码吃掉 '~' 分隔符致下标偏移（测试已改用 ASCII 名称）。

- 2026-09-15（夜间批次 3）：**F3-2 公司资料完成**——data-service 新增 `GET /profile/{code}`
  （所属行业/上市日期/总股本/流通股）：主源 AKShare `stock_individual_info_em`（东财 push2），
  push2 限流自动降级 **push2delay 同构直连**（公司资料为近静态信息，不受 15 分钟延时影响；
  沪深京三市实测通过，旧北交所代码切换 920 段后返回全 "-" 为上游行为），按代码缓存 24h；
  `"-"`（停牌/退市）置 null 不补 0。主服务：`DataProvider` 加 `CompanyProfile`/`getProfile`，
  CompositeProvider 接线；`/api/stocks/:code` 聚合扩为五块（+profile/profileError 独立降级）。
  前端：详情页行情卡下方新增"公司资料"卡（行业/上市日期/总股本/流通股四格，股本格式化
  亿/万股；无数据整块隐藏、失败卡内降级提示）。验证：typecheck + 106 测试全绿（profile
  4 条新用例）+ py_compile 通过；端到端实测 /profile/600519、/profile/920799、无效代码
  502 双源错误信息、缓存命中、/api/stocks/600519 聚合 profile 块正确、401 正常。
  同批：重启主服务与 data-service（旧进程分别停在 F4 合并前/昨日修复前的代码上）。

- 2026-09-15（夜间批次 2）：**新增 F6 路线图（形态识别与多维共振分析）**——用户指定第二个
  参考方向：小红书博主"递归熵"的个人量化系统（pattern_analyzer 形态识别+历史成绩单 /
  狙击手资金验货 / 四维共振 / 板块轮动 / 美股联动）。四项新能力全部采纳并拆为 F6-1~F6-4：
  形态识别先做 20 种经典形态跑通"识别→历史统计→展示"链路；资金流验货依赖 F3-4；
  板块轮动与外盘联动独立成块。**用户明确要求各功能在网页端分成独立区块/入口呈现**。
  红线补充：概率数字一律按"历史事实统计"口径表述并带免责声明，禁止表述为预测；
  外盘仅作参考信息源。CLAUDE.md 路线图节同步。
- 2026-09-15（夜间批次）：**新增 F5 路线图（分析与监控增强）**——用户指定参考开源项目
  tickflow-stock-panel（A 股「选股+监控+回测」量化工作台），采纳其技术指标分析、
  AI 个股多维分析、多条件监控提醒、盘后复盘推送四项轻量能力（排期在 F3 剩余项与
  F4-B 之后，F5-1 先行），选股扫描与回测引擎两项重资产功能确认要做、排进路线图后置
  （共同前置：本地全市场行情库）。红线写入第四节：永不荐股/不做买卖建议与价格预测，
  分析范围限定为客观技术指标计算 + LLM 汇总解读。CLAUDE.md 路线图节同步。
- 2026-09-15（傍晚批次 2）：**F4-B 基金版块上线**——对标支付宝财富页的基金内容。
  后端：data-service 新增 4 端点（均经 akshare 1.18.94 实测选型）：`/funds/rank?type=&limit=`
  （`fund_open_fund_rank_em` 天天基金开放式排行，按类型缓存 10 分钟）、`/funds/search?keyword=`
  （`fund_name_em` 全量基金表约 2.8 万行，缓存 24h + 打分排序）、`/funds/{code}?days=`
  （`fund_open_fund_info_em` 单位净值走势，按代码缓存 6h）、`/funds/etf?limit=`
  （`fund_etf_spot_em` 全量场内 ETF 实时快照，全量翻页 30s+ 故超时放宽 120s + 缓存 60s）；
  `DataProvider` 加 `FundRankItem/FundSearchItem/FundInfo/EtfQuote` 与对应方法，
  CompositeProvider 接线。技能：`get_fund_rank`（按类型排行）、`get_fund_info`
  （单只基金净值/走势，支持代码或名称——名称先走基金搜索解析）。前端：新增
  `public/funds/` SPA（排行类型 Tab + 场内 ETF Tab + 防抖搜索 + 详情净值走势图，
  复用 theme.css 与手写 SVG 折线组件）；webchat.ts 加 `/api/funds/*` 系列端点
  （全部在口令鉴权后）；/stocks 与 /market 页头加"💰 基金"导航。
  验证：typecheck + 94 测试全绿（funds 9 条新用例）+ py_compile 通过；端到端实测
  四个微服务端点与主服务 API 均返回真实数据、无 token 401、/funds 静态页 200
  （验证端口 8102/18802，验后已停）。
- 2026-09-15（傍晚批次 2）：**F4-A 财经快讯版块完成**——数据层：data-service 新增
  `GET /market-news?limit=`（上限 50），主源东财 `stock_info_global_em`（实测返回约 200 条，
  列：标题/摘要/发布时间/链接，含 URL），失败自动降级财联社 `stock_info_global_cls`
  （约 20 条，无 URL，短快讯"标题"常为空、取"内容"前 60 字充任），发布时间倒序 +
  进程内缓存 90s 防刷新打爆上游；`DataProvider` 新增 `MarketNewsItem`/`getMarketNews`，
  CompositeProvider 接线（微服务未启动返回带启动提示的结构化错误）。对话：新增
  `get_market_news` 技能（无代码参数的全市场快讯，与 `get_stock_news` 分工写在 SKILL.md，
  SYSTEM_PROMPT 加 routing 引导）。网页：新增 `/news` 页（时间倒序列表、有 URL 可点击
  新窗口打开、60s 自动刷新 + 手动刷新 + 数据更新时间），API `GET /api/market/news?limit=`
  挂口令鉴权后，/stocks 与 /market 页头加"📰 快讯"导航。验证：typecheck + 85 测试全绿
  （新增 8 条：provider URL/透传/错误分支 + 技能格式化/limit 归一化/降级提示）；
  端到端实测 /market-news 与 /api/market/news 返回真实快讯、401 正常、微服务停掉时
  降级错误提示正确；/webchat 发"最近有什么财经新闻"实测 LLM 调用技能并汇总输出。
- 2026-09-15（傍晚批次）：**新增 F4 路线图（基金与财经资讯版块）**——用户要求项目内
  可查看"支付宝相关版块"与"财经相关内容"，经确认范围为股票+基金相关内容：
  基金（净值/排行/场内 ETF，对标支付宝财富页基金版块）与全市场财经快讯；
  呈现形式为网页新页面 + 聊天技能。第四节落为 F4-A（财经快讯）/F4-B（基金版块）
  两个并行子任务链（含数据来源与落点建议），由多个 agent 并行开发。
- 2026-09-15（午后批次 3）：**全市场涨跌浏览页（/market）上线**——用户指定需求：与自选股页
  区分开的全市场今日涨跌浏览。后端：`DataProvider.getMovers()` 新能力，东财 clist 排行榜
  （fltt=2 不缩放）+ ulist 涨跌平家数（沪深京三市 secid 求和）；停牌股与平盘**混排在零区**
  导致"按上涨家数算页码"定位失效，改为二分查找零区起点再扫描（PITFALLS 已记录）；
  push2 限流自动降级 push2delay 同构接口（返回 `delayed: true`，页面标注"延时约 15 分钟"）；
  结果缓存 60s 防刷新触发限流。前端：新增 `public/market/`（涨跌平家数总览卡 +
  涨幅/跌幅/平盘三 Tab 同款圆角卡片，点卡片跳详情页），复用 theme.css 与口令鉴权；
  /stocks 页头加"📊 涨跌榜"导航。验证：typecheck + 73 测试全绿（movers 7 条新用例：
  合成全市场 mock 二分定位/停牌过滤/宿主降级/缓存 + 真实 fixture 回放）；端到端实测
  /api/market/movers 三榜与家数正确（含北交所），401 与 /market 静态页正常。
- 2026-09-15（午后批次 2）：**运行环境核实**——发现 data-service 在跑的是昨日修复前的旧进程
  （公告/财报报旧错），重启后详情页四块全链路实测通过：行情含估值字段（腾讯降级路径）、
  新闻 10 条、财报 4 期、公告链路正常（茅台近 30 天无公告返回 0 条是正确行为，120 天窗口有数据；
  巨潮上游仍返回非 JSON，实际走东财降级源）。东财 push2 对本机限流仍未解除（已超 20h），
  行情全程由腾讯托底。PITFALLS 的"旧进程占端口"条目加重：不限于 tsx watch，uvicorn 同款。
- 2026-09-15（午后批次）：**F3-1 估值与规模完成**——`Quote` 新增 peTtm/peDynamic/peStatic/pb/
  totalMarketCap/floatMarketCap 可选字段；东财 push2 加 f162/f163/f164/f167（PE/PB，×100）与
  f116/f117（市值，单位元不缩放），腾讯下标 39/52/53/46/44/45（市值亿元×1e8）——两源字段编码
  经 push2delay 同构接口 + 腾讯实时响应交叉实测一致（push2 本机限流中，验证方法见 PITFALLS）。
  落点三处：详情页行情卡加第二行统计格（总市值/流通市值/PE(TTM)/PB，PE 缺失时降级 PE(动) 标注）、
  `get_stock_quote` 技能输出加市值与 PE/PB 行（缺失整条不显示）、watchlist/详情 API 契约同步。
  验证：typecheck + 70 测试全绿（新增东财估值 ÷100/缩放规则、"-" 置 undefined、腾讯估值下标 3 条用例，
  fixture 自 push2delay 重录）；端到端 `/api/stocks/600519` 实测返回完整估值字段（腾讯降级路径；
  东财路径因 IP 限流未实测，解析由真实结构 fixture 回放覆盖）。
- 2026-09-15（深夜批次 3）：**新增 F3 路线图（个股信息补全）**——用户确认详情页信息缺口
  （估值/市值、公司资料、成交活跃度、资金流、分时数据等），STATUS 第四节落为
  F3-1~F3-6 排期表（含数据来源与落点建议），交给下一个 agent。
- 2026-09-15（深夜批次 2）：**新闻排序可切换**——`/news` 端点加 `sort` 参数：
  `hot`（默认，东财相关度/热度原序）/ `time`（发布时间倒序）；`DataProvider.getNews`
  加可选 sort 透传；新增单块端点 `GET /api/stocks/:code/news?sort=`；浏览页新闻 Tab
  加"热度/最新"切换 pill（按 code+sort 前端缓存）。实测两种排序与非法参数 400 均正确。
- 2026-09-15（深夜批次）：**修复 akshare 1.18.94 引发的公告/财报双故障**（用户浏览详情页发现）。
  财报：`stock_financial_abstract` 返回结构从长表变宽表（行=指标、列=报告期），旧映射静默全空
  ——端点按 `"指标" in df.columns` 分流，宽表走 `_financials_wide()` 透视；FinancialReport
  新增 netAssets/roe/eps（新版无"资产总计/长期负债/财务费用"）；技能格式化与详情页表格
  （+ROE 列、金额亿/万格式化）同步。公告：巨潮上游返回非 JSON（JSONDecodeError）——
  `/announcements` 加东财 `stock_individual_notice_report` 降级链（全量翻页 180s 超时 +
  按代码缓存 6h）。另记录 tsx watch 旧子进程占端口致"修复不生效"的排查过程（PITFALLS 加重版）。
  验证：端到端详情聚合四块（行情/新闻/公告/财报）全部实测通过，66 测试全绿。
- 2026-09-15（下午批次）：**F1/F2 完成——股票浏览页 + 个股详情页 + 页内搜索，同步 UI 重设计**。
  后端：data-service 新增 `/history/{code}` 历史 K 线端点（前复权日 K，东财失败自动降级新浪）；
  `DataProvider` 新增 `getHistory` 与 `Quote.open/high/low` 可选字段（东财 f44/45/46、腾讯
  下标 5/33/34 均已接线）；webchat.ts 新增浏览页 API（GET/POST/DELETE /api/watchlist 批量行情、
  /api/stocks/:code 四块独立降级聚合、/api/stocks/:code/history、/api/search），全部在口令鉴权后。
  前端：新增 `public/shared/theme.css` ShadcnUI 风格设计系统（黑白灰 + indigo CTA）、
  `public/stocks/` 浏览页 SPA（自选股圆角卡片、防抖搜索同款卡片结果、详情页手写 SVG 折线图
  带 hover tooltip 与 1月/3月/6月/1年 区间切换、新闻/公告/财报 Tab）；webchat 聊天页重设计
  （卡片式布局、建议 chip、卡片式口令输入替代 window.prompt）。
  顺带修复：akshare 1.18.94 `stock_financial_abstract` 参数名 stock→symbol 兼容
  （symbol 优先、TypeError 回退 stock）。验证：typecheck + 66 测试全绿 + 全链路冒烟
  （自选增删/批量行情/搜索/详情聚合/历史 K 线/401 均实测通过；公告块因巨潮上游限流返回
  非 JSON，按设计降级为 announcementsError 展示）。
- 2026-09-15：新增 [docs/WORKFLOW.md](WORKFLOW.md) 提交规范与版本管理——此后改动一律走
  分支 + PR 合入 main（禁止直接推 main），含分支命名、提交信息格式、revert 回退方法与
  里程碑 tag 规则。CLAUDE.md 开发工作流节同步。
- 2026-09-15：**环境就绪**——LLM 接入 Kimi 开放平台 kimi-k3（对话链路实测可用；
  会员 key 不能用的坑已记入 PITFALLS），ACCESS_TOKEN 已固定。Kimi 429 限流记为 P8（暂不修）。
  新增待办功能路线图（第四节）：F1 股票浏览页+个股详情页（折线图/往期数据）、
  F2 浏览页内搜索，交给下一个 agent。
- 2026-09-15：**行情链路加腾讯自动降级**——东财 push2 触发 IP 级限流（前一日录 fixture
  时高频请求所致，超 14 小时未解除），新增 `src/data/tencent.ts`（qt.gtimg.cn，GBK 文本
  协议），CompositeProvider 的 getQuote/getIndexQuote 东财失败时自动切腾讯（有降级日志）。
  实测降级链路返回正确行情。新增 6 条腾讯解析单测（含 GBK fixture 回放），共 62 条全绿。
- 2026-09-14（傍晚批次）：**首轮全模块代码审计**——6 个并行审查 agent 覆盖全部 14 模块，
  发现 46 条问题（🔴2：A-401 探针告警路径可致进程崩溃、A-501 数值误配可致热循环；
  🟡25 🔵19），主会话作为修复 agent 全部修复，原审查 agent 复核后**46 条全部闭环**
  （A-101 首轮复核打回——finally 派生 Promise 未接 catch，二次修复后通过；
  A-508/A-601 争议理由被裁定接受，分别留待非回环部署与 S3-3 落地时处理）。
  同批顺带完成：S2-2/S2-3/S2-4（scheduler 导出+单测、Store.close()、fixture+typecheck 纳 tests/）。
  验证：typecheck（含 tests/）+ 56 测试全绿 + data-service/main.py py_compile 通过。
- 2026-09-14（傍晚批次）：解决问题 P3——会话历史保留工具调用上下文。完整消息链
  （含 tool 消息）经 `trimHistory()` 裁剪入库：tool 结果超 1200 字符截断、总量 40 条预算、
  链首孤儿 tool 消息丢弃（OpenAI 协议要求）；用户追问细节不再只靠 LLM 记忆。
- 2026-09-14（傍晚批次）：解决问题 P4——行情健康探针上线（`src/alerts/healthProbe.ts`）：
  默认每 30 分钟探测 600519，连续失败 2 次推送告警、恢复推送通知；状态暴露在
  /health 的 quoteProbe 字段；新增 HEALTH_PROBE_ENABLED/INTERVAL_MINUTES/CODE 配置。
- 2026-09-14（傍晚批次）：S3-1/S3-2 完成——离线通知收件箱落 SQLite（每用户上限 100 条）；
  飞书 chat_id 映射持久化到 kv 表（重启后免用户先发消息），且只在单聊学习映射
  （防持仓日报误推群聊）。S0-3 完成——data-service venv 建好，akshare 1.18.94。
- 2026-09-14：解决问题 P5——WebChat 增加访问口令鉴权。`config.ts` 新增 `accessToken`
  （读 `.env` 的 `ACCESS_TOKEN`，未配置时启动随机生成并打印到控制台）；`webchat.ts`
  用中间件保护所有 `/api/*`（Bearer 校验，失败 401），静态页面与 `/health`、
  `/feishu/events` 不鉴权；前端首次打开弹窗输入口令存 localStorage，401 时自动要求
  重输。注意：口令是明文共享口令，非多用户体系；公网部署建议在 .env 固定强口令并配合 HTTPS。
- 2026-09-14：解决问题 P2——收盘日报与异动提醒跳过法定节假日。data-service 新增
  `/trade-calendar?year=` 端点（`ak.tool_trade_date_hist_sina`，进程内缓存 24h）；
  主服务新增 `TradeCalendar` 类（按年缓存，服务不可用时降级为只跳周末，失败结果
  缓存 10 分钟防重试风暴）；调度器在日报触发和异动轮询前判断交易日；新增配置
  `TRADE_CALENDAR_ENABLED`（默认 true，收编在 `config.tradeCalendarEnabled`）。
- 2026-09-14：解决问题 P6——搭建 vitest 测试基座（`npm test`），首批 35 条单测：
  toSecid 规则、东财行情解析（÷100 / `"-"` / Referer，fetch 全 mock）、search_stock
  技能格式化、Store 自选股/会话历史 SQLite 往返（临时目录隔离，不碰项目 data/）。
  scheduler 时间函数未导出，待 export 后补测；外部接口层仍待录制 fixture。
  （以上三项由三个并行 agent 完成，验证：typecheck + 35 测试全绿。）
- 2026-09-14：get_market_index 技能上线（大盘指数行情）——8 个常用指数显式 secid
  映射（规避 000001 个股/指数歧义），不传参返回核心指数概览；东财直连，已用真实
  接口验证。**原路线图全部完成。**
- 2026-09-14：异动提醒上线——盘中（工作日 9:30-11:30 / 13:00-15:00 北京时间）每
  N 分钟轮询全部自选股，涨跌幅超阈值（默认 ±5%）主动推送，每股每日只报一次；
  新增配置 ALERT_ENABLED / ALERT_THRESHOLD_PCT / ALERT_INTERVAL_MINUTES；
  全部用户代码去重后并发拉行情避免重复请求东财。路线图仅剩大盘指数行情。
- 2026-09-14：存储换 SQLite（node:sqlite 内置模块，`data/store.db`）+ 会话历史持久化，
  解决问题 P1 与 P7；旧 store.json 启动时自动迁移并改名 .migrated；
  `engines` 提升为 Node >= 22.13；下一任务建议从待办第 1 条（异动提醒）开始。
- 2026-09-14：飞书渠道补完——X-Lark-Signature 验签（新增 FEISHU_ENCRYPT_KEY 配置）、
  tenant_access_token 内存缓存自动刷新、回复消息 API 接通、message_id 去重（10 分钟窗口）、
  notify() 主动推送（chat_id 映射从收到的消息学习，内存态）；index.ts 的 express.json
  增加 verify 回调保留 rawBody；下一任务建议从待办第 1 条（会话持久化 + SQLite）开始。
- 2026-09-14：get_stock_financials 技能上线（新浪财务摘要，按报告期倒序，默认 4 期）；
  data-service 新增 `/financials/{code}` 端点；下一任务建议从待办第 1 条（飞书渠道补完）开始。
- 2026-09-14：get_stock_announcements 技能上线（巨潮资讯个股公告，近 30 天）；
  data-service 新增 `/announcements/{code}` 端点；get_stock_news 职责收窄为新闻/资讯，
  与公告技能分工；下一任务建议从待办第 1 条（财报技能）开始。
- 2026-09-14：search_stock 技能上线（名称→代码）；SYSTEM_PROMPT 增加先搜后查与
  搜不到禁止凭记忆作答的约束；建立 STATUS/FEATURES/PITFALLS/AUDIT 文档体系。
  **本日起项目开发交接给新 agent**，下一任务建议从待办第 1 条（公告技能）开始。
