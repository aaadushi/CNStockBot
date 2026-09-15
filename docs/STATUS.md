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
| 实时行情查询 `get_stock_quote` | `src/skills/bundled/quote/` | ✅ 可用 | 东财公开接口，免 key；**东财失败自动降级腾讯行情**（2026-09-15）；涨跌幅缺失显示 — 而非静默 0；2026-09-15 起输出含估值与市值（F3-1） |
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
| 股票浏览页 + 个股详情页（/stocks） | `public/stocks/` + `src/channels/webchat.ts` | ✅ 可用 | F1/F2 完成：自选股圆角卡片列表、页内搜索（同款卡片结果）、详情页行情/走势图/新闻/公告/财报；API 全部在口令鉴权后；2026-09-15 |
| 历史 K 线数据（走势图数据源） | `data-service/main.py` `/history` + `DataProvider.getHistory` | ✅ 可用 | 前复权日 K；东财 `stock_zh_a_hist` 失败自动降级新浪 `stock_zh_a_daily`（push2his 限流托底，见 PITFALLS） |
| 前端共享设计系统 | `public/shared/theme.css` | ✅ 可用 | ShadcnUI 风格（黑白灰 + indigo CTA、圆角卡片、微阴影）；webchat 与 stocks 两页共用；2026-09-15 UI 重设计 |
| 全市场涨跌榜（/market） | `public/market/` + `src/channels/webchat.ts` `/api/market/movers` | ✅ 可用 | 今日涨幅榜/跌幅榜/平盘三 Tab + 涨跌平家数总览（沪深京）；东财 clist/ulist 接口，push2 限流自动降级 push2delay（延时 15 分钟，页面标注）；不依赖 data-service；2026-09-15 新增 |

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
| F3-2 | **公司资料**：所属行业、板块、上市日期、总股本 | `ak.stock_individual_info_em(symbol=code)`（东财个股资料）；data-service 加 `/profile/{code}`，`DataProvider` 加 `getProfile` | 详情页行情卡下方加"公司资料"行/卡 |
| F3-3 | **成交活跃度**：成交额、换手率、量比 | 实时：东财 push2 加 f47 成交量/f48 成交额/f168 换手率/f50 量比（同样抓包核对）；历史：`stock_zh_a_hist` 本就有"成交额/换手率"列，`/history` 端点 `_hist_items` 加映射即可 | Quote/HistoryBar 加可选字段；详情页统计格 + 走势图可加成交量副图 |
| F3-4 | **资金流**：主力/超大单净流入 | `ak.stock_individual_fund_flow(stock=code, market=...)`（东财个股资金流，market 参数 sh/sz/bj 按代码前缀映射）→ data-service `/fund-flow/{code}` | 详情页新 Tab 或独立卡片 |
| F3-5 | **分时数据**（今日分时走势） | `ak.stock_zh_a_hist_min_em(symbol=code, period="1")` 或东财 trends2 接口；注意数据量大，前端图可复用现有 SVG 折线组件 | 详情页走势图加"分时/日K"切换 |
| F3-6 | **其他**（低优先）：涨跌停价、52 周高低、分红送配 | 涨跌停：东财 push2 f51/f52（抓包核对）；分红：`ak.stock_history_dividend_detail` | 详情页补充展示 |

**通用注意**：
- 东财字段全是 f 编码且价格类放大 100 倍，动手前先读 PITFALLS 东财条目
- data-service 新端点必须走 `run_ak()`（30s 超时）；耗时接口配缓存（参考公告降级的 `_notice_cache`）
- API 加端点挂 `/api` 口令鉴权后；前端所有接口文本一律 `textContent` 渲染
- 完成后更新 STATUS（本节移除对应行 + 更新日志）、FEATURES、如涉及端点更新 data-service/README

### 其他候选方向（无排期）

1. **S3-3 多用户体系**（公网部署前必做）：WebChat 共享口令 → 独立账号，解决 A-601 身份隔离
2. 详情页 K 线蜡烛图（现有数据已含 OHLC）
3. 浏览页与聊天联动：详情页"问机器人这只股票"按钮（跳转 /webchat 预填问题）
4. 自选股分组 / 成本价录入与持仓盈亏展示
5. P8：LLM 429 指数退避重试（用户决定暂不修，复发时做）

---

## 更新日志

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
