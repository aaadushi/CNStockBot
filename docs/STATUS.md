# 功能与问题清单（STATUS）

> **本文件的用途**：让接手的 agent / 工程师在 5 分钟内看清——哪些功能已能用、哪些没做、
> 当前最痛的已知问题是什么。**每次完成功能或发现新问题都要更新本文件。**
>
> 分工：架构原理看 [ARCHITECTURE.md](ARCHITECTURE.md)；每个功能"怎么实现的、代码在哪"
> 看 [FEATURES.md](FEATURES.md)；踩过的坑看 [PITFALLS.md](PITFALLS.md)；
> 数据源接口细节看 [DATA_SOURCES.md](DATA_SOURCES.md)。

最后更新：2026-09-26

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
| WebChat 网页聊天 | `src/channels/webchat.ts` + `public/webchat/` | ✅ 可用 | 2026-09-26 起升级为多用户体系：注册/登录/登出 API + session token，业务 API 全改 Bearer 鉴权，原 `ACCESS_TOKEN` 共享口令下线；静态页面不鉴权 |
| 离线通知收件箱（/api/inbox 轮询） | `src/channels/webchat.ts` | ✅ 可用 | **SQLite 持久化**（每用户上限 100 条），重启不丢；同在口令保护内 |
| 收盘日报定时推送（交易日 15:30） | `src/alerts/scheduler.ts` | ✅ 可用 | 已跳法定节假日（交易日历降级只跳周末）；2026-09-14 解决 P2；2026-09-19 起附加技术面信号摘要（F5-3，复用 F5-1 指标端点，需 data-service，`DAILY_REPORT_SIGNALS=false` 可关） |
| 异动提醒（盘中轮询，超阈值推送） | `src/alerts/scheduler.ts` | ✅ 可用 | 默认 ±5%、每 5 分钟，每股每日只报一次；推送失败下轮补报；单用户失败不中断他人；2026-09-19 起并入自定义多条件规则（F5-4：`manage_alerts` 技能配置，价格上下限/涨跌幅、AND/OR 组合、条件粒度每日去重，存 SQLite alert_rules 表） |
| 行情健康探针 | `src/alerts/healthProbe.ts` | ✅ 可用 | 默认每 30 分钟探测 600519，连续失败 2 次判定故障、恢复均记服务端日志；状态见 /health 的 quoteProbe；**故障/恢复推送默认关闭**（`HEALTH_PROBE_ALERT_PUSH=true` 才推，2026-09-22 调整：告警对客户端透明，查询失败由技能层对话内当场转述）；2026-09-14 解决 P4 |
| 大盘指数查询 `get_market_index` | `src/skills/bundled/index/` | ✅ 可用 | 8 个常用指数显式 secid 映射，不传参返回核心指数概览；名称匹配归一化（"创业板指数"等说法可识别）；2026-09-14 新增 |
| Python 数据微服务（行情/新闻/搜索） | `data-service/main.py` | ✅ 可用 | FastAPI + AKShare；AKShare 调用统一 30s 超时（504），财报 NaN/交易日历格式已加固 |
| 飞书渠道 | `src/channels/feishu.ts` | ✅ 可用 | 验签（含 ±5 分钟防重放）/token 缓存/回复/去重/主动推送；chat_id 映射 **kv 表持久化**（只学单聊，防持仓日报进群）；双凭据缺失时 fail-closed |
| 股票浏览页 + 个股详情页（/stocks） | `public/stocks/` + `src/channels/webchat.ts` | ✅ 可用 | F1/F2 完成：自选股圆角卡片列表、页内搜索（同款卡片结果）、详情页行情（含涨跌停价/52 周高低，F3-6）/公司资料/资金流/分红送配（F3-6）/走势图（分时/日K 切换，F3-5）/新闻/公告/财报；API 全部在口令鉴权后；2026-09-15 |
| 历史 K 线数据（走势图数据源） | `data-service/main.py` `/history` + `DataProvider.getHistory` | ✅ 可用 | 前复权日 K；东财 `stock_zh_a_hist` 失败自动降级新浪 `stock_zh_a_daily`（push2his 限流托底，见 PITFALLS）；2026-09-15 起东财源透出成交额/换手率（F3-3），新浪降级源无此列、成交量已归一（股→手）；2026-09-16 起取数链抽为 `_load_bars` 与 /indicators 共用（F5-1） |
| 技术指标分析（F5-1） | `data-service/main.py` `/indicators` + 详情页技术指标卡/均线叠加 | ✅ 可用 | MA/EMA/MACD/RSI/KDJ/BOLL + 支撑/压力关键价位 + 客观信号（金叉/超买等状态描述，非买卖建议），与 /history 同源纯本地 pandas 计算（口径见 DATA_SOURCES）；详情页日 K 叠加 MA5/10/20/60 均线；依赖 data-service 运行；2026-09-16 新增 |
| 前端共享设计系统 | `public/shared/theme.css` | ✅ 可用 | ShadcnUI 风格（黑白灰 + indigo CTA、圆角卡片、微阴影）；webchat 与 stocks 两页共用；2026-09-15 UI 重设计 |
| 全市场涨跌榜（/market） | `public/market/` + `src/channels/webchat.ts` `/api/market/movers` | ✅ 可用 | 今日涨幅榜/跌幅榜/平盘三 Tab + 涨跌平家数总览（沪深京）；东财 clist/ulist 接口，push2 限流自动降级 push2delay（延时 15 分钟，页面标注）；不依赖 data-service；2026-09-15 新增 |
| 基金版块（/funds + 基金技能，F4-B） | `public/funds/` + `src/skills/bundled/fundrank/`、`fundinfo/` + data-service `/funds/*` | ✅ 可用 | 开放式基金排行（按类型）/基金搜索/基金详情净值走势/场内 ETF 实时榜；天天基金数据（支付宝同源）经微服务，依赖 data-service 运行；2026-09-15 新增 |
| 财经快讯（/news + `get_market_news` 技能） | `public/news/` + `src/skills/bundled/marketnews/` + data-service `/market-news` | ✅ 可用 | 全市场财经快讯（区别于个股新闻）；东财全球快讯主源、财联社降级，进程内缓存 90s；网页 60s 自动刷新；依赖 data-service；2026-09-15 新增（F4-A） |
| AI 个股多维分析（F5-2） | `src/skills/bundled/analyze/` + 详情页"AI 多维分析"卡 | ✅ 可用 | `analyze_stock` 技能一次聚合行情估值/公司资料/资金流/技术面（复用 F5-1）/近两期财报/最新新闻六块（allSettled 独立降级），SYSTEM_PROMPT 规则 5 约束 LLM 分维度客观解读；详情页入口复用 /api/chat 链路（结果同步进聊天会话历史）；2026-09-19 新增 |
| 外盘联动监控（/overseas + 盘前推送，F6-4） | `public/overseas/` + data-service `/overseas/summary` + `src/alerts/scheduler.ts` | ✅ 可用 | 隔夜美股三大指数/中概股与美股热门/国际金银原油三块独立降级（失败块带 error），缓存 10 分钟；规则化"A 股相关方向提示"（客观历史相关性映射，非买卖建议）；盘前推送可选（`OVERSEAS_PUSH_ENABLED=true`，交易日约 9:10）；需 data-service；2026-09-19 新增 |
| 板块轮动监控（/sectors，F6-3） | `public/sectors/` + data-service `/sectors/*` + `/api/sectors/*` | ✅ 可用 | 行业板块涨跌排行/资金流排行/板块详情（成分股 + 日 K 走势图）/个股→板块共振（行业匹配当日涨跌与资金流名次，未匹配返回结构化 matched=false）；clist 直连 push2→push2delay 降级（带 source 标注），板块日 K 走 AKShare stock_board_industry_hist_em；依赖 data-service 运行；2026-09-19 新增 |
| K 线形态识别 + 历史成绩单（F6-1） | `data-service` `/patterns` + `get_stock_patterns` 技能 + 详情页"形态分析"卡 | ✅ 可用 | 17 种经典形态（11 种 K 线组合 + 6 种价格结构）纯本地检测（与 /history 同源前复权日 K，检测无未来函数），按形态聚合历史成绩单（信号日后 5/10/20 日上涨占比/平均涨跌幅/平均最大回撤，窗口不完整不计入）；近期出现=近 60 交易日；全部历史事实统计口径，响应带 disclaimer，count<5 提示样本过少；依赖 data-service；2026-09-19 新增 |
| 资金流验货（"狙击手"模式，F6-2） | `data-service` `/verify/{code}` + `/api/stocks/:code/verify` + 详情页"资金流验货"卡 + `analyze_stock` 第七块 | ✅ 可用 | 近 60 交易日形态信号 × 日级资金流（复用 F3-4 取数，东财五档/新浪两档带 source 标注）交叉验证，三档结论（重点观察/中性/存疑，透明阈值规则）+ 客观依据；日级口径（分笔 tick 未接入，尾盘维度缺失）；按 (code,days) 缓存 1h；依赖 data-service；2026-09-21 新增 |
| 选股扫描（/scanner + scan_market 技能，F5-5） | `data-service` `/market-bars/*` + `/scan*` + `public/scanner/` + `src/skills/bundled/scanner/` | ✅ 可用 | 本地全市场日 K 库（baostock→SQLite，仅沪深，盘后增量更新）+ 宽表向量化 7 个预设策略扫描（秒级）；网页独立页 + 聊天技能 + 盘后自动更新（默认开）/扫描摘要推送（默认关 `SCANNER_PUSH_ENABLED`）；客观命中名单口径 + 免责声明；2026-09-21 新增 |
| 策略回测（/backtest，F5-6） | `data-service` `/backtest/{code}` + `public/backtest/` + `GET /api/backtest` | ✅ 可用 | 本地日 K 库单股历史信号回放：7 个预设策略（与扫描同口径同 key）+ 真实 A 股规则（T+1/整手/佣金万2.5/印花税/滑点/止损/持有期）；统计（胜率/盈亏比/最大回撤/累计 vs 买入持有基准）+ 净值曲线 + 逐笔明细；历史业绩不代表未来，页面显著标注；2026-09-22 新增 |
| 安卓 WebView 壳 App（F7-2） | `android/` 独立 Gradle 工程 | ✅ 工程完成 | 首屏服务器地址配置（release 仅 HTTPS / debug 放行局域网明文）+ WebView 装载 /webchat；SSL fail-closed、外链交系统浏览器；认证由网页端 CNStockAuth 完成（壳不经手 token）；**APK 构建/真机验收待构建者在 Android Studio 执行**；2026-09-26 新增 |

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

| # | 事项 | 现状 | 做法 |
|---|---|---|---|
| S1-1 | ~~重启生产双服务（8000/18790）让 F5-5/F5-6 生效~~ | ✅ 2026-09-22 完成（见更新日志批次 13）：8125 临时实例已停，双服务按无 watch 方式重启在最新 main 上，扫描/回测页面、API 与 scan_market 技能链路全部实测通过 | — |
| S1-2 | ~~F5-6 里程碑 tag~~（可选） | ✅ 2026-09-22 完成：PR #33 合并后已在 main（f485b2a）打 `v0.4.0` 并推送，tag 与 package.json 0.4.0 一致 | — |

~~P3、P4 均已于 2026-09-14 解决（见更新日志）。~~

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
| S3-3 | ~~WebChat 共享口令 → 多用户体系~~ | ✅ 已上升为 S4-1 并于 2026-09-26 完成 | 审计 A-601：同口令持有者之间无身份隔离（userId 客户端自报），公网发布前必须完成 |
| S3-4 | ~~进程管理加固（P9 善后）：一键启动脚本（双服务同起）+ /health 暴露 data-service 连通性与进程启动时间/git sha；（可选）data-service 健康探针~~ | ✅ 2026-09-26 完成：`scripts/service.mjs`（start/stop/status/restart + --env-file，端口预检拒双开、日志落盘 logs/、PID 文件、进程树清理）+ .bat/.sh 包装 + npm script；/health 新增 version/gitSha/startedAt/dataService（30s 缓存轻量探测）；定时推送型微服务探针不做（/health 连通性已覆盖观测面，与告警默认关的口径一致）。需求文档 [REQ-S3-4](requirements/S3-4-process-management.md)，FEATURES 第 41 节 |
| S3-5 | 进程守护层：开机自启 + 崩溃自动拉起（Windows 任务计划程序 / pm2-windows-service；Linux 公网部署建议直接 systemd unit） | ⏸️ **挂起（2026-09-26 用户登记）：用户不主动提出前不做，任何 agent 不得自行启动本项**。背景：S3-4 一键脚本（PR #44）是前台监督模式——关窗即停、崩溃整体退出不拉起、注销会话杀进程；用户确认"不关机+不关窗"的当前形态可接受，守护层优先级延后。用户主动提及时，按规范先写需求文档再实现 |

### S4 公网发布前置（新增）

> 项目目标已明确为**公网发布给别人使用**。以下事项从"可选/低优先级"提升为 F7 安卓端 App 公网发布的**前置硬门槛**，必须先于公网部署完成，不可跳过。

| # | 事项 | 现状 | 必须完成的原因 |
|---|---|---|---|
| S4-1 | **S3-3 多用户体系** | ✅ 2026-09-26 完成：注册/登录/登出 API、服务端签发 UUID 会话、业务 API 全改用 session token、密码 bcryptjs 哈希、登录速率限制、前端登录页、测试覆盖；旧匿名数据冷启动隔离 | 审计 A-601：共享口令 + 客户端自报 userId 可被任意越权读删收件箱、冒用身份。公网陌生人共用同一口令不可接受 |
| S4-2 | **A-508 微服务 token 鉴权** | ✅ 2026-09-26 完成：data-service 全局 `Authorization: Bearer <token>` / `X-Data-Service-Token: <token>` 校验（含 `/health`），未配置 `DATA_SERVICE_TOKEN` 拒绝启动；主服务 `pythonService.ts` 的 get/post、`TradeCalendar` 统一带 token；`.env.example`/`config.ts` 新增配置；启动自检警告；新增 5 条 Node 测试 + 2 条 config 测试；需求文档 [REQ-S4-2](requirements/S4-2-data-service-token.md) | data-service 目前无鉴权，安全仅靠 `127.0.0.1` 绑定。公网/跨机器部署时 8000 端口裸奔，会被任意调用消耗数据源额度、触发限流 |
| S4-3 | **HTTPS 部署** | ✅ 2026-09-26 完成：TLS 统一由反向代理终止（应用零证书逻辑）；新增 `docs/deploy/HTTPS.md` 完整部署指南（Caddy 自动证书 / nginx+certbot 两套配置、HSTS 分阶段建议、飞书回调、防火墙端口原则、验证清单）；修复代理部署真实隐患——Express 默认不信代理头会使登录限速退化为全局限速/可被 XFF 伪造绕过，新增 `TRUST_PROXY` 配置（默认 false 零变化，`loopback`=同机反代推荐值，`true` 带滥用风险提示）+ 路由装配前 `app.set('trust proxy', …)`；需求文档 [REQ-S4-3](requirements/S4-3-https-deployment.md)；新增 6 条 config 解析用例 + 4 条 trust proxy 集成用例 | 多用户体系的登录凭证、ACCESS_TOKEN、微服务 token 均不能明文走公网 HTTP |
| S4-4 | **服务端监听地址可配置** | ✅ 2026-09-26 完成：新增 `HOST` 环境变量，默认 `0.0.0.0`，写入 `app.listen(config.port, config.host)`；`.env.example` 与测试覆盖 | 当前主服务写死 `app.listen(config.port)` 无 host 参数，默认只绑 IPv4+IPv6 全地址；需显式支持 `HOST` 环境变量，避免公网部署误绑 |

**建议顺序**：S4-4 → S4-1 → S4-2 → S4-3（HTTPS 可与 S4-1/S4-2 并行准备），全部完成后才进入公网 Beta。
**✅ S4 全部四项已于 2026-09-26 完成，公网发布前置收官；下一步进入 F7 安卓端 App（阶段 1 起）。**

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

### P9 ~~进程管理失控：主服务热重载失效跑旧代码 + data-service 停机无感知~~（已解决，见更新日志 2026-09-19；根因细节见 PITFALLS 旧进程条目 2026-09-16 变种，加固项转入 S3-4）

### P10 ~~盘前时段（9:30 前）行情卡部分字段显示 — / 0.00~~（登记为设计内行为后关闭，见更新日志 2026-09-19；行为细节与排查纪律见 PITFALLS 腾讯盘前条目）

---

## 四、功能路线图（待做，交给下一个 agent）

> ~~F1 股票浏览页+个股详情页、F2 浏览页内搜索~~ 均已于 2026-09-15 完成（见更新日志）。

### F3 个股信息补全 ✅ 全部完成（2026-09-16，F3-1~F3-6，见更新日志）

详情页（/stocks?code=）信息缺口清单已全部补齐：

| # | 信息 | 数据来源建议 | 落点 |
|---|---|---|---|
| ~~F3-1~~ | ~~**估值与规模**~~ | ✅ 2026-09-15 完成（见更新日志） | — |
| ~~F3-2~~ | ~~**公司资料**：所属行业、板块、上市日期、总股本~~ | ✅ 2026-09-15 完成（见更新日志） | — |
| ~~F3-3~~ | ~~**成交活跃度**：成交额、换手率、量比~~ | ✅ 2026-09-15 完成（见更新日志） | — |
| ~~F3-4~~ | ~~**资金流**：主力/超大单净流入~~ | ✅ 2026-09-15 完成（见更新日志） | — || ~~F3-5~~ | ~~**分时数据**（今日分时走势）~~ | ✅ 2026-09-16 完成（见更新日志） | — |
| ~~F3-6~~ | ~~**其他**：涨跌停价、52 周高低、分红送配~~ | ✅ 2026-09-16 完成（见更新日志） | — |

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
| ~~F5-1~~ | ~~**技术指标分析**：MA/EMA/MACD/RSI/KDJ/BOLL + 关键价位（支撑/压力）~~ | ✅ 2026-09-16 完成（见更新日志） | — |
| ~~F5-2~~ | ~~**AI 个股多维分析**~~ | ✅ 2026-09-19 完成（见更新日志） | — |
| F5-3 | ~~**盘后复盘推送**~~ | ✅ 2026-09-19 完成（见更新日志） | — |
| F5-4 | ~~**多条件监控提醒**~~ | ✅ 2026-09-19 完成（见更新日志）。**范围裁剪**：指标信号类条件（金叉/超买等）未纳入盘中轮询——/indicators 基于已完成日 K、盘中不变，该类信号由 F5-3 收盘日报覆盖；盘中条件为价格上下限/涨跌幅三种 | — |

**重资产功能**（共同前置：本地全市场行情库——已于 2026-09-21 随 F5-5 建成）：

| # | 功能 | 实现要点 | 落点 |
|---|---|---|---|
| F5-5 | ~~**选股扫描**~~ | ✅ 2026-09-21 完成（见更新日志）。**范围裁剪**（用户确认）：仅沪深 A 股（北交所无免费批量源）、固定 7 个预设策略（不做自由条件编辑器）；未参考 TSP 18 策略模板全量移植 | 数据层 + /scanner 页 + scan_market 技能 |
| F5-6 | ~~**回测引擎**~~ | ✅ 2026-09-22 完成（见更新日志）：本地日 K 库单股历史信号回放（7 个预设策略与扫描同口径），真实 A 股规则（T+1、整手、佣金/印花税/滑点、止损、持有期白名单），收益统计 + 净值曲线 + 逐笔明细；历史业绩不代表未来，页面显著标注 | 数据层 + /backtest 页 |

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
| F6-1 | ~~**K 线形态识别 + 历史成绩单**~~（先 20 种经典形态：杯柄/双重底/头肩底/红三兵/上升三角形/口袋支点等） | ✅ 2026-09-19 完成（见更新日志）：data-service `/patterns/{code}?days=` 纯本地检测 17 种形态（定义清晰优先于数量，杯柄/口袋支点定义把握不足未纳入）+ 按形态聚合历史成绩单；详情页独立"形态分析"卡 + `get_stock_patterns` 技能；全部历史事实统计口径 + 免责声明 | 详情页独立"形态分析"卡片区 + 聊天可查询 |
| F6-2 | ~~**资金流验货**（"狙击手"模式）~~ | ✅ 2026-09-21 完成（见更新日志）：data-service `/verify/{code}` 对近期形态信号叠加日级资金流交叉验证，三档分档结论（重点观察/中性/存疑，透明阈值规则）；分笔 tick 未接入（日级口径，尾盘维度缺失，已在 FEATURES/DATA_SOURCES 注明） | 详情页独立验货卡 + 作为 F5-2 多维分析的信号源（analyze_stock 第七块） |
| ~~F6-3~~ | ~~**板块轮动监控**~~ | ✅ 2026-09-19 完成（见更新日志）：独立导航页 /sectors（涨跌排行/资金流排行/板块详情/个股→板块共振） | — |
| ~~F6-4~~ | ~~**外盘联动监控**~~ | ✅ 2026-09-19 完成（见更新日志）：/overseas 独立页面 + 规则化方向提示 + 可选盘前推送；**范围扩界说明**已遵守：外盘仅作参考信息源，行情查询/自选股等主功能仍只做 A 股 | — |

**依赖与排期**：整体排在 F3 剩余项、F4-B 之后，与 F5 轻量项交错——F6-1 与 F5-1
共享历史数据/指标计算底座，建议 F5-1 完成后紧接着做；F6-2 依赖 F3-4；F6-3/F6-4
相互独立，可并行。形态库先 20 种跑通"识别 → 历史统计 → 展示"链路再评估扩库
（100+ 形态识别调优成本高，不一次到位）。

**红线补充**（在 F5 红线基础上）：
- "上涨概率 72%"这类数字的口径是**历史事实统计**（过去 N 次类似形态出现后 X 日内
  的实际表现），必须按此口径表述并带免责声明，**禁止表述为对未来的预测或买卖建议**
- F6-4 外盘数据仅作参考信息，不生成任何买卖建议

### F7 安卓端 App（用户 2026-09-22 指定，目标：**公网发布给别人使用**）

**目标**：在**保留现有网页端**（public/ 全部页面与 WebChat）的基础上，让项目能以
App 形式在安卓手机上运行——手机上随时查行情/自选股/收推送，不必开浏览器输地址口令。
网页端与 App 两个入口并存，App 不替代网页端。

**⚠️ 关键变更：项目目标已明确为公网发布给别人使用。F7 不再只是"局域网尝鲜"，而是必须能安全地部署到公网、供陌生人注册/登录/使用。**
因此 F7 的实施顺序调整为：

1. **先完成公网发布前置（新增 S4）**：
   - S4-1 多用户体系（解决 A-601）
   - S4-2 微服务 token 鉴权（解决 A-508）
   - S4-3 HTTPS 部署
   - S4-4 服务端监听地址可配置
2. **再做 App 客户端（F7-1~F7-3）**：WebView/TWA 壳 → 体验加固（本地通知等）。

**架构前提（动手前必须先解决）**：主服务（Express :18790）与 data-service（:8000）
目前只监听 PC 本机回环；App 只是新客户端，**后端必须对手机可达**：

- ~~方案一（原首选，仅自用/家庭同 WiFi）：主服务监听改为 `0.0.0.0`，手机与 PC 同局域网直连~~。
  **因目标改为公网发布，方案一仅作为本地开发调试用途，不再作为发布目标。**
- **方案二（现唯一发布目标）：服务端公网部署 + HTTPS。**
  **前置硬依赖 S4-1/S4-2/S4-3/S4-4，必须全部完成后才能公网 Beta。**

**技术路线候选**（留给实现 agent 选型实测，建议从路线 A 起步验证）：

| 路线 | 方案 | 成本 | 说明 |
|---|---|---|---|
| A（推荐起步） | **WebView / TWA 壳**：Android Studio 原生 WebView 或 Bubblewrap(TWA) 包装现有网页 | 最低 | 现有页面零改动全可用；登录/注册走新的多用户体系 API；服务端地址做成首屏可配置 |
| B | **Capacitor 混合应用**：在 A 基础上获得原生能力 | 中 | 本地通知（收盘日报/异动提醒/扫描摘要落地为系统通知）、后台轮询收件箱；可逐步从 A 升级 |
| C | 原生 / Flutter / RN 重写 | 高，不推荐 | 等于重做全部前端，且每加一个网页功能要双端同步 |

**推送口径**：浏览器端收件箱是 `/api/inbox` 轮询；App 首版沿用前台轮询即可，
原生推送（FCM 国内不可用、厂商通道接入重）**不作首版目标**，路线 B 的本地通知
（App 内轮询 + Local Notifications 弹系统通知）是性价比最高的中间态。

**红线不变**：App 同样只做信息聚合，永不接交易；分析类输出免责声明规则与网页端一致。

**建议拆分（按新的公网目标调整）**：

| 阶段 | 编号 | 目标 | 前置 |
|---|---|---|---|
| 阶段 0 | **S4-1** | 多用户体系：注册/登录/会话管理、userId 服务端签发、自选股/会话/收件箱/规则按用户隔离 | 无 |
| 阶段 0 | **S4-2** | 微服务 token：data-service 端点校验 `DATA_SERVICE_TOKEN`，主服务 `pythonService.ts` 统一带 token | S4-1 可并行 |
| 阶段 0 | **S4-3** | HTTPS 部署文档 + 配置：反向代理（nginx/Caddy/traefik）+ 证书 + HSTS 建议 | S4-1/S4-2 完成后 |
| 阶段 0 | **S4-4** | 服务端监听地址可配置：`HOST` 环境变量，默认 `0.0.0.0`，文档说明绑定风险 | 无 |
| 阶段 1 | **F7-1** | 后端对公网可达（S4 完成后自然达成）：验证多用户登录 API、HTTPS 端到端 | S4 全部 |
| 阶段 2 | **F7-2** | ~~WebView/TWA 壳跑通~~ ✅ 2026-09-26 完成：android/ 原生 WebView 壳工程（零依赖，详见更新日志批次 22 与 FEATURES 第 40 节） | S4 全部 |
| 阶段 3 | **F7-3** | 体验加固：本地通知、后台轮询、图标/启动屏、生物识别/指纹登录（可选） | F7-2 |

落点建议：新目录 `android/`（或独立仓库），不动现有 `src/` 与 `public/`；
多用户体系改动走正常分支 + PR 流程。

### 其他候选方向（无排期）

1. ~~S3-3 多用户体系~~（已并入 S4-1，作为公网发布前置）
2. 详情页 K 线蜡烛图（现有数据已含 OHLC）
3. 浏览页与聊天联动：详情页"问机器人这只股票"按钮（跳转 /webchat 预填问题）
4. 自选股分组 / 成本价录入与持仓盈亏展示
5. P8：LLM 429 指数退避重试（用户决定暂不修，复发时做）

---

## 更新日志

- 2026-09-26：**生产双服务切换为脚本管理**（运维动作，无代码改动）——当日排查用户
  报告"App 其他页面没有数据"，实锤 data-service 停机（主服务正常，聊天/行情走东财
  直连不受影响）。恢复后应用户要求将生产从"agent 会话裸后台进程"切换为
  `scripts/start-all.bat` 独立窗口前台监督模式：停掉旧主服务（PID 35556，2026-09-26
  08:53 启动，跑 S4-2 前旧代码）与会话内临时 data-service，脚本一键拉起双服务到
  最新 main（gitSha ce1de4b）。实测 /health 四新字段齐全、dataService.ok=true
  （22ms）、0.0.0.0:18790 监听（手机端不受影响）、`status` 双服务在线。
  **注意**：服务生命周期跟随那个命令行窗口，关窗/Ctrl+C 即停；重启电脑后重新运行
  `scripts\start-all.bat`。
- 2026-09-26：**登记 S3-5 进程守护层（开机自启 + 崩溃自动拉起）为挂起任务**——用户
  确认 S3-4 一键脚本（PR #44）的"不关机 + 不关窗口 + 服务不崩"运行形态当前可接受，
  守护层（Windows 任务计划程序 / pm2-windows-service / Linux systemd）优先级延后；
  **用户不主动提出前不做**。仅文档改动，无代码。
- 2026-09-26（批次 23）：**S3-4 进程管理加固完成（P9 善后项清零）**——一键启动脚本 +
  /health 可观测性。改动：
  - 新增 [scripts/service.mjs](../scripts/service.mjs)（Node 单文件零新依赖，跨平台）：
    `start` 前台监督模式（端口占用预检拒双开 → data-service 走 venv uvicorn 带
    `DATA_SERVICE_TOKEN` + 主服务走 `node tsx src/index.ts` 非 watch；日志同屏镜像 +
    追加 logs/；PID 文件；任一子进程退出整体杀树收尾）、`stop`（taskkill /T /F 或
    SIGTERM→SIGKILL，陈旧 PID 自动清理，幂等）、`status`（PID+端口双指标，全运行
    退出码 0）、`restart`、`--env-file`（文件值优先，替代端口并行验证不碰生产）；
    薄包装 `scripts/start-all.bat`/`stop-all.bat`（**ASCII-only + chcp 65001**：.bat 写
    中文注释会在 GBK 控制台被 cmd 误解析成命令，实测踩到）与 `start-all.sh`/
    `stop-all.sh`；npm script `start:all`/`stop:all`/`status:all`；`.gitignore` 加 logs/；
  - /health 新增 `version`/`gitSha`/`startedAt`/`dataService` 四字段（[src/health.ts](../src/health.ts)）：
    dataService 为带 token 调微服务 /health 的轻量探测，3s 超时、进程内缓存 30s
    （两次 /health 仅一次真实探测，实测 data-service 侧仅 1 条 access log）、异常
    绝不抛出（data-service 停止时主服务仍 ok:true + dataService.ok:false，实测）；
  - 需求文档 [docs/requirements/S3-4-process-management.md](requirements/S3-4-process-management.md)，
    FEATURES 新增第 41 节，README 新增"一键启动双服务"节；
  - 验证：`npm run typecheck` + `npm test` 全绿（286 测试，新增 health.test.ts 8 条：
    构建信息 3 + 探测器成功/无 token/非 2xx/连接异常/缓存 TTL/并发共享在途 6）；
    端到端实测（替代端口 8127/18827 + 临时 env 文件，验后已停并清理）：一键拉起
    双服务、/health 四新字段正确（gitSha 与 main HEAD 一致）、探测缓存命中、
    重复 start 被预检拒绝、status/stop/重复 stop 退出码与端口释放全部正确、
    缺 token 直接报错、.bat 包装可用、data-service 停机时 /health 优雅降级。
  - **范围说明**：崩溃自动拉起/开机自启/systemd/pm2 注册、定时推送型 data-service
    健康探针均按需求文档明确不做；生产实例（18790）未动，如需切换为脚本管理，
    先停旧进程再 `scripts/start-all.bat`。
- 2026-09-26（批次 22）：**F7-2 安卓 WebView 壳 App 工程完成（F7 阶段 2）**——S4 收官后
  进入 F7 的第一项产出。改动：
  - 新增 `android/` 独立 Gradle 工程（路线 A：原生 WebView 壳）：applicationId
    `com.cnstockbot.app`，minSdk 24 / targetSdk 34，Kotlin（AGP 8.5.2 + KGP 1.9.24），
    **零第三方依赖**（纯 Android 框架，Android Studio 打开即 Sync），构建与安装说明
    见 [android/README.md](../android/README.md)；
  - 首屏服务端地址配置：`ServerUrl.normalize()` 纯函数归一化（缺协议补 https、
    只保留 scheme+authority），release 拒绝明文 HTTP（主 manifest 恒
    `usesCleartextTraffic=false`），debug 包经 `src/debug/AndroidManifest.xml` 单独
    放开明文供局域网调试；地址存私有 SharedPreferences；
  - WebView 主界面：进度条、返回键按历史回退、同源链接内开/外部链接交系统浏览器、
    错误页+重试、**SSL 校验失败一律阻断无绕过**、菜单（刷新/切换服务器/关于）；
  - 认证不经手：登录/注册由网页端 `CNStockAuth` 完成，session token 存 WebView
    localStorage，`src/`、`public/`、data-service 零改动；
  - 最小自适应图标（vector，indigo 主题色，无 PNG 素材）；
  - 需求文档 [docs/requirements/F7-2-android-webview-shell.md](requirements/F7-2-android-webview-shell.md)，
    FEATURES.md 新增第 40 节；
  - 验证：全部 XML 通过合法性解析、工程文件齐全自洽（applicationId/包名/资源引用
    一致）；**APK 构建与真机验收未做（本机无 Android SDK/Gradle），由构建者在
    Android Studio 中执行 REQ-F7-2 验收标准 1~6**；主服务 `npm run typecheck` +
    `npm test` 不受影响（278 测试）。
  - **F7-1 说明**：公网可达端到端验证依赖真实公网部署（域名 + 反向代理 + 证书，
    按 [docs/deploy/HTTPS.md](deploy/HTTPS.md)），壳可先用局域网地址开发调试，
    两者并行不冲突。
- 2026-09-26（批次 21）：**S4-3 HTTPS 部署完成——S4 公网发布前置全部收官**。改动：
  - 新增 [docs/deploy/HTTPS.md](deploy/HTTPS.md) 部署指南：反向代理架构（443 →
    127.0.0.1:18790，data-service 永不对外）、Caddy（自动 ACME）与 nginx+certbot 两套
    可复制配置、HSTS 分阶段建议（300s 验证 → 1 年 + includeSubDomains 风险提示）、
    飞书回调 URL、防火墙端口硬约束、部署后验证清单与故障排查表；
  - 修复代理部署真实隐患：Express 默认 `trust proxy=false` 时 `req.ip` 退化为代理
    地址，S4-1 登录限速会变成全局限速（所有用户共享 5 次/60s）或被 XFF 伪造绕过；
    [src/config.ts](config.ts) 新增 `TRUST_PROXY`（默认 false 零变化 / `loopback` 同机
    反代推荐 / 数字跳数 / `true` 带滥用警告），[src/index.ts](../src/index.ts) 路由
    装配前 `app.set('trust proxy', config.trustProxy)`；
  - `.env.example` 新增 `TRUST_PROXY` 配置与风险注释；README 新增"公网部署"节；
  - 需求文档 [docs/requirements/S4-3-https-deployment.md](requirements/S4-3-https-deployment.md)；
  - 测试：`tests/config.test.ts` +6 条（未配置/true/false/数字/字符串解析）、新增
    `tests/trustProxy.test.ts` 4 条（默认不信伪造 XFF / loopback 取真实 IP / 数字 1 /
    true 信任链），实测还验证了 Express 信任链安全语义：多跳 XFF 中不可信代理地址
    不会被错当客户端 IP；
  - 验证：`npm run typecheck` + `npm test` 全绿（278 测试）。
  - **交接提醒（生产）**：S4-2 已合 main 但生产双服务仍跑旧代码；生产 `.env` 本次
    已补 `DATA_SERVICE_TOKEN`（64 位十六进制强随机，gitignored），下次重启 data-service
    前无需再手动配置。
- 2026-09-26（批次 20）：**S4-2 微服务 token 鉴权完成**——公网发布前置第三项，解决审计
  A-508。改动：
  - data-service：[data-service/main.py](data-service/main.py) 启动时读 `DATA_SERVICE_TOKEN`，
    未配置即 `sys.exit(1)`（fail-closed）；新增 `verify_data_service_token` 全局依赖注入
    FastAPI app，覆盖全部 32 端点（**含 /health**）；接受 `Authorization: Bearer <token>`
    与 `X-Data-Service-Token: <token>` 两种 Header；`secrets.compare_digest` 防时序侧信道；
  - 主服务：[src/data/pythonService.ts](src/data/pythonService.ts) 新增 `authHeaders()` 模块级
    函数，`PythonServiceProvider.get/post` 与 `TradeCalendar.loadYear` 三处 fetch 统一带
    token；token 只出现在 Header 不出现在 URL；
  - 配置：[src/config.ts](src/config.ts) 新增 `dataServiceToken`；`.env.example` /
    [README.md](README.md) / [data-service/README.md](data-service/README.md) 同步配置说明与
    启动命令；
  - 启动自检：[src/index.ts](src/index.ts) `DATA_PROVIDER=python` 且 token 空时打醒目 warning；
  - 测试：`tests/pythonService-token.test.ts` 新建 5 条（get/post 带 token、空 token 不带
    Header、401 错误透传、TradeCalendar 带 token）+ `tests/config.test.ts` 追加 2 条；
  - 文档：[docs/requirements/S4-2-data-service-token.md](docs/requirements/S4-2-data-service-token.md)
    需求文档建立，FEATURES.md 新增第 39 节，STATUS S4-2 行更新；
  - 验证：`npm run typecheck` + `npm test` 全绿（269 测试）+ `py_compile` 通过；
    uvicorn 真实进程手动验证：缺 token 启动失败 / 无 token→401 / 错 token→401 /
    Bearer 与 X-Header 正确 token→200。
- 2026-09-26（批次 19）：**S4-1 多用户体系完成**——公网发布前置第二项，解决审计 A-601。改动：
  - 后端：新增 `src/auth/*` 模块（`password.ts`/`token.ts`/`rateLimit.ts`/`service.ts`/`middleware.ts`/`routes.ts`），实现注册/登录/登出、bcryptjs 密码哈希、opaque session token（SHA-256 存库）、IP 登录速率限制；
  - `src/storage/store.ts` 新增 `users`/`sessions` 表；`src/config.ts` 新增 `auth` 配置块（`SESSION_TTL_HOURS`/`BCRYPT_ROUNDS`/`LOGIN_RATE_LIMIT_*`）；`.env.example` 同步；
  - `src/channels/webchat.ts` 移除 `ACCESS_TOKEN` 共享口令中间件，业务 API 全部改用 `requireSession` 注入 `req.user`；`userId` 参数静默忽略；
  - 前端：新建 `public/shared/auth.js` 提供 `CNStockAuth`（登录/注册/登出、`apiFetch` 自动带 Bearer、401 弹登录浮层），`public/webchat/index.html` 改为登录/注册卡片，`public/{stocks,market,news,funds,sectors,overseas,scanner,backtest}/index.html` 全部迁移到 `CNStockAuth.apiFetch` 并加登出入口；
  - 数据迁移采用方案 A 冷启动：旧匿名数据保留在库但新会话不可访问；
  - 新增 `tests/auth/*.test.ts` 覆盖密码、速率限制、session CRUD、路由集成与跨用户隔离；
  - 更新 `docs/STATUS.md` / `README.md` / `CLAUDE.md`（目录地图加 `src/auth/` 与 `public/shared/auth.js`）。
  - 验证：`npm run typecheck` + `npm test` 全绿（262 测试）。
- 2026-09-26（批次 18）：**S4-4 服务端监听地址可配置完成**——公网发布前置第一项。改动：
  - `src/config.ts` 新增 `HOST` 环境变量，默认 `0.0.0.0`（监听所有接口），空字符串回退默认值；
  - `src/index.ts` `app.listen` 改为 `app.listen(config.port, config.host)`，启动日志打印监听地址；
  - `.env.example` 增加 `HOST` 配置项与注释；
  - 新增 `tests/config.test.ts` 覆盖 HOST 默认值/环境变量覆盖/数值回退行为；
  - `docs/STATUS.md` S4-4 行更新为完成，测试：typecheck + 243 测试全绿。
- 2026-09-26（批次 17）：**建立"新功能前必须先写需求文档"的工程规范**——用户明确后续新功能开发前必须建立需求文档，以便审计功能时对照验收、避免实现 agent 扩大/裁剪范围、便于维护。改动：
  - [CLAUDE.md](CLAUDE.md) 开发工作流新增需求文档流程（必须遵守）；文档维护义务表新增"开始实现新功能前 → docs/requirements/"一行；
  - 新建 `docs/requirements/` 目录；
  - 为 **S4-1 多用户体系** 编写第一份需求文档 [docs/requirements/S4-1-multi-user-system.md](requirements/S4-1-multi-user-system.md)，覆盖背景目标、范围、用户故事、功能/非功能需求、数据模型、迁移策略、API/前端改动、验收标准、审计要点；
  - [docs/STATUS.md](docs/STATUS.md) S4-1 行链接到需求文档；
  - 项目记忆同步记录该规范。
- 2026-09-22（批次 16）：**明确项目下一阶段目标为"公网发布给别人使用"**——用户确认 F7 安卓端 App 不走局域网方案，必须公网部署。文档调整：
  - [docs/STATUS.md](docs/STATUS.md) 新增 S4 公网发布前置（S4-1 多用户体系 / S4-2 微服务 token / S4-3 HTTPS / S4-4 监听地址可配置），将 S3-3/A-508 从"低优先级/可选"提升为 F7 硬依赖；
  - F7 节重写：删除"方案一（局域网）作为首选"的表述，改为方案一仅限本地调试，公网发布为唯一目标；
  - 给出阶段 0~阶段 3 的拆分顺序：先完成 S4 全部前置，再做 App 客户端（F7-1~F7-3）；
  - [CLAUDE.md](CLAUDE.md) 下一步路线同步更新。
- 2026-09-22（批次 15）：**行情健康探针告警推送默认关闭（用户反馈）**——用户报告聊天端
  在无输入时反复弹出"⚠️数据源告警 / ✅数据源恢复"消息（本机东财限流抖动期探针反复
  翻转所致），要求后端错误对客户端透明、只在用户实际查询失败时提示。改动：新增配置
  `HEALTH_PROBE_ALERT_PUSH`（默认 false），故障/恢复不再主动推送到聊天端，仅记服务端
  日志并暴露在 /health 的 quoteProbe；查询失败的当面提示本就有（技能层把错误文本回给
  LLM 转述），链路不变。设 `HEALTH_PROBE_ALERT_PUSH=true` 可恢复旧推送行为。
  验证：typecheck + 238 测试全绿（新增 tests/healthProbe.test.ts 3 条：默认不推送且
  状态照常记录 / alertPush=true 故障恢复各推一次且故障期不重复 / 单次抖动不误判）。
- 2026-09-22（批次 14）：**新增 F7 路线图（安卓端 App）**——用户指定新方向：保留现有
  网页端，让项目以 App 形式在安卓手机运行。第四节落为 F7 节：架构前提（后端对手机
  可达——局域网 0.0.0.0 监听首选 / 公网部署前置 S3-3 + A-508）、技术路线候选
  （A WebView/TWA 壳推荐起步 / B Capacitor 升级本地通知 / C 原生重写不推荐）、
  推送口径（首版前台轮询，原生推送不作首版目标）、建议拆分 F7-1~F7-3，
  CLAUDE.md 路线图节同步为第 7 项。
- 2026-09-22（批次 13）：**S1-1 完成——生产双服务重启，F5-5/F5-6 全链路生效**。
  停掉 8125 临时验证实例（PID 40676）与旧生产进程（data-service PID 34072、
  主服务 PID 39472），按 P9 教训以无 watch 方式重启在最新 main 上
  （uvicorn 8000 + `npx tsx src/index.ts` 18790）。实测验证：/health 技能清单含
  scan_market、数据源 composite 正常；/scanner、/backtest 静态页 200（301→/ 路径）；
  /api 无口令 401；/api/scanner/status 返回库覆盖 5222 只、lastBarDate 2026-09-22、
  280.6MB；扫描 macd_gold 命中 572 只真实名单（asOf 2026-09-22，stale=false）；
  回测 000001 ma_cross_up 返回完整统计（730 根 bar，名称"平安银行"正确解析）；
  /api/chat 发"用 MACD 金叉策略扫描全市场"实测 LLM 调用 scan_market 并输出
  带口径与免责声明的命中名单。**注意**：进程冷启动后首次扫描实测 128s
  （宽表面板 + 名称表预热，provider 超时 150s 恰好覆盖），名称表首取失败时
  items 的 name 降级为 null（note 注明），复测缓存命中后 8.6s 且名称齐全——
  属既有设计的冷启动行为，非回归。S1-2 版本号随本 PR 升 0.4.0；PR 合并后已在
  main（f485b2a）打 `v0.4.0` tag 并推送，**F5 路线图至此全部收官**。
- 2026-09-22（批次 12）：**F5 系列收官与收尾登记**——F5-6 回测引擎经用户手动合并
  （PR #30），F5-5 底座双源加固随后合入（PR #31）；**首次全市场回填完成**
  （11:56→13:31 约 1.5 小时，5222/5222 零失败，数据截至当日，库文件 280MB，
  全库扫描抽测正常）。合并后 main 复核：typecheck + 235 测试全绿。
  **遗留收尾已登记为 S1-1/S1-2（见待办总表）**：重启生产双服务（含停 8125 临时
  验证实例）让扫描/回测生效；F5-6 里程碑 tag v0.4.0（可选）。
- 2026-09-22（批次 11）：**F5-5 底座加固——批量日 K 改双源（腾讯主源 + baostock 兜底）**。
  首日 baostock 回填跑到 22%（1149/5221）后，baostock 免费服务端从 22:00 起先大面积
  "网络接收错误"、次日连登录都秒拒（10001011"登录用户过多"，持续 12+ 小时，PITFALLS
  已回填）——免费批量源不可作唯一依赖。新增腾讯 fqkline 主源
  （`web.ifzq.gtimg.cn`，免登录、单票一次约 640 根前复权日 K、实测 1.1s/票，全市场回填
  约 1.5 小时 vs baostock 8 小时）：volume 已是手不换算、无 amount/turnover/change_pct 列
  （置 NULL/环比补算）、无效代码判空。`_DualFetcher` 双源封装：腾讯失败懒登录 baostock
  兜底，baostock 登录失败一次本轮禁用。验证：py_compile + sanity 20 项全过（腾讯解析
  字段/单位/param 格式/无效代码、双源降级矩阵、pass 断点/count 分档/熔断、真实接口核对
  600519 收盘与量）；腾讯主源回填实测约 50 票/分钟零失败推进中。
- 2026-09-22（批次 10）：**F5-6 回测引擎完成（F5 路线图收官）**——本地日 K 库上的单股
  策略历史信号回放。**数据层**：data-service 新增 `GET /backtest/{code}?strategy=&hold_days=&
  stop_loss_pct=&days=`（days 默认 750、范围 120~750，结果缓存键含 asOf 同扫描模式）——
  信号掩码复用扫描同一公式集 `_wide_indicators`（pandas Series/DataFrame 语义一致，
  7 策略条件逐条相同；状态类条件取上升沿防每日重复开仓）；交易规则全透明披露
  （随响应 rules 字段）：信号日次日开盘价 +0.1% 滑点买入、固定本金 10 万整手（不足一手
  跳过）、T+1、止损=买入价×(1-p%) 盘中最低价触及按 min(开盘,止损价) 成交（跳空按开盘价）、
  持有期满（5/10/20/60 白名单）收盘卖、数据末端强平（data_end 计入净值但不计入胜率等
  闭环统计，与 F6-1"窗口不完整不计入"同原则）、佣金万 2.5 双边最低 5 元 + 卖出印花税
  0.05%、同一时间只持有一笔（skippedSignals 计数）。校验：北交所 400（仅沪深）、
  库中无票 404、bar<90 回 422、库空 503。**主服务**：provider 4 类型 + `runBacktest`
  可选方法（客户端超时 150s 覆盖冷启动名称表预热），CompositeProvider 复用
  scannerUnavailable 降级文案；webchat 挂 /backtest 静态页 + `GET /api/backtest`
  （口令鉴权后，code 6 位校验）。**网页**：/backtest 独立导航页——条件卡（代码输入 +
  datalist 搜索建议 + 策略/持有期/止损下拉）+ 统计格（累计 vs 基准 vs 超额/最大回撤/
  胜率/盈亏比等）+ 净值曲线 SVG（双线 + hover tooltip）+ 交易明细表 + 规则说明 +
  显著免责声明条；支持 ?code= 预填；9 页页头加"🧪 回测"导航。**聊天侧不新增技能**
  （路线图落点为数据层+新页面，参数组合适合表单交互）。验证：typecheck + 241 测试全绿
  （新增 tests/pythonService-backtest.test.ts 6 条）+ py_compile 通过；Python sanity
  26 项全过（信号上升沿/T+1/止损与跳空成交价/费用与整手数学/data_end 不计统计/持仓期
  信号忽略/资金不足跳过/缓存 asOf 失效）；端到端实测（验证端口 8126/18826，验后已停并
  清理）：真实库 000001（729 根 bar）三策略回测结果合理（ma_cross_up 胜率 64.3%、
  macd_gold 22 笔含止损触发）、400/404/401 分支正确、名称表解析正常、/backtest 静态页
  200、内联 JS node --check 通过。**未覆盖**：日线涨跌停无法成交的特殊情形未建模
  （如止损日一字跌停实际卖不出——当前按止损价/开盘价成交，口径偏乐观，已属已知简化）。
- 2026-09-21（批次 9）：**F5-5 选股扫描完成（F5 重资产第一项）**——拆 3 个 PR 合入
  （#26 数据底座 / #27 扫描引擎 / 集成本批）。**数据底座**：data-service 新增本地全市场
  日 K 库（本服务首个磁盘持久化）——baostock 批量前复权日 K（新依赖 baostock>=0.9；
  不选东财批量：push2his 一分钟约 10 次请求即封 IP 数小时的前科）→ SQLite
  `data-service/data/market_bars.db`（WAL 单写者，750 交易日窗口，票池 5221 只沪深 A 股，
  北交所无免费批量源排除）；更新器断点续跑 + 单票失败重试 2 次记名单 + **连续 20 票失败
  熔断重连**（实测 baostock socket 死后每票静默报"网络接收错误"，票级重试无效）+
  盘后数据未齐 30 分钟重试至 21:00；`POST /market-bars/update`（单飞行 409）+
  `GET /market-bars/status`。**扫描引擎**：宽表向量化（`_load_panel` 全票 150 根 pivot +
  `_wide_indicators` 整帧计算，口径与 F5-1 `_compute_indicators` 逐条一致），7 个预设策略
  （MA 多头排列/MACD 金叉/RSI 超卖/放量突破 20 日新高/缩量回踩 MA20/触及布林下轨/
  MA5 金叉 MA20），ST/退剔除，asOf 缓存键，实测 2.5s。**主服务**：provider 4 类型 + 4 可选
  方法（pythonService 新增 post<T>，runScan/trigger 超时 150s）；webchat `/scanner` 静态页 +
  `/api/scanner/*` 4 端点（409 透传）；scheduler 新增 `startScannerUpdate`（交易日 15:40 触发，
  `SCANNER_AUTO_UPDATE` 默认开）+ 可选扫描摘要推送（`SCANNER_PUSH_ENABLED` 默认关，
  `buildScanPushText` 纯函数，7 策略命中数 + 前 3 只，全零不推送，21:30 封顶）。
  **技能**：`scan_market`（策略七 key 枚举，limit 硬钳 10，输出 <1200 字符），SYSTEM_PROMPT
  规则 10。**网页**：/scanner 独立导航页（状态条 + 策略 Tab + 结果卡 + 三类空态），
  8 页页头加"🔍 扫描"导航（顺带补齐 funds 缺快讯、sectors/overseas 互链）。
  验证：typecheck + 229 测试全绿（pythonService-scanner 7 + scanner 技能 7 + scheduler 5）+
  py_compile 通过；Python sanity 28+28 项全过（宽表对拍/策略暴力复算/定点触发/ST 剔除/
  缓存失效/熔断/断点续跑/单位归一）；端到端实测（8125 端口 + 真实回填数据）：
  /scan 两策略 2.5-2.8s 返回真实命中、409/400/503 分支正确、断点续跑与熔断重连实测恢复。
  **未覆盖**：完整回填（5221 票）尚在进行中（首次回填实测约 10 票/分钟需数小时，
  一次性成本）；盘后定时触发与推送链路未实测（结构与外盘推送同款）；东财主源行情
  路径与本功能无关（扫描只走本地库）。
- 2026-09-21（批次 8）：**F6-2 资金流验货（"狙击手"模式）完成**——形态触发时叠加资金流
  交叉验证。data-service 新增 `GET /verify/{code}?days=`（默认 750、范围 30~1500，
  按 (code,days) 缓存 1h）：复用 F6-1 的 `_scan_patterns` 形态检测取近 60 个交易日信号日，
  叠加 F3-4 资金流取数（`/fund-flow` 端点的取数+降级链抽为共用 `_get_fund_flow_cached`，
  按 code 缓存 60s，与验货缓存键独立）做交叉验证。**分档规则（透明客观阈值）**：
  验货窗口 = 信号日起往后最多 3 个有资金流数据的交易日，取主力净流入（新浪降级源为
  "净流入"，口径含全部资金，文案与 flowNote 随 source 切换）非空值，记 pos=为正日数、
  neg=为负日数、total=合计额——total 与形态方向同号且同向日数占优 → **重点观察**；
  反号且反向日数占优 → **存疑**；其余（正负交错/全缺失/信号日未被资金流覆盖/中性形态）
  → **中性**。日级口径：分笔 tick（ak.stock_intraday_em）未接入，"尾盘变化"维度缺失，
  已在 FEATURES/DATA_SOURCES 注明。无近期信号时不拉资金流直接返回空列表（flowSource=null）。
  主服务：`DataProvider` 加 `FlowVerifyReport`/`FlowVerifySignal` 类型与 `getFlowVerify`，
  CompositeProvider 接线；新增 `GET /api/stocks/:code/verify?days=`（口令鉴权后，
  **不进详情聚合块**）。`analyze_stock` 聚合扩为七块（+资金流验货，allSettled 独立降级），
  SYSTEM_PROMPT 规则 5 补验货块的解读约束（分档结论只作客观参考）。详情页"形态分析"卡
  下方新增独立"资金流验货"卡：每个近期信号一条目（信号日/形态名/分档 badge——中性配色，
  不用红绿 + 客观依据 + 资金流 source 口径标注 + 免责声明），近期无信号时整卡隐藏。
  聊天侧未新增独立技能（验货经 analyze_stock 与详情页触达；get_stock_patterns 不带验货
  以免形态查询翻倍上游调用）。验证：typecheck + 210 测试全绿（新增
  tests/pythonService-verify.test.ts 8 条：URL/透传/三档分档值/空信号/新浪口径/错误分支/
  Composite 降级文案；analyze 测试扩 4 条：验货块齐全/独立降级/方法缺失/无信号与新浪口径）
  + py_compile 通过；分档规则合成数据 sanity check 23 项全过（一致/背离/交错/无数据/
  未覆盖/中性形态/正负日数相等/含 0 值/无信号不拉资金流）；端到端实测（验证端口 8124/18824，
  验后已停并清理）：/verify 实测 600519（双顶+头肩顶信号判"重点观察"，与看跌形态方向一致）、
  002594（看涨吞没"重点观察"、头肩底"中性"交错）、600036（含"存疑"背离样本）三档全部
  实测命中（资金流 sina 降级路径，口径标注正确），无效代码 502、days 超限 422、缓存命中
  2.4ms、API 401/400/200 正常、详情聚合七块无回归、/api/chat"帮我多维度分析一下比亚迪"
  实测 LLM 调用 analyze_stock 并输出含验货块的七维解读（分档按客观参考转述、含免责声明）、
  详情页内联 JS node --check 通过。**未覆盖**：东财五档资金流主源路径未实测（push2his
  对本机间歇性限流中，与 /fund-flow 同链路由既有降级逻辑托底）；无近期信号的真实股票
  空结果端到端未遇到（大盘股近 60 日常有十字星），空路径行为由合成数据 sanity check 覆盖。
- 2026-09-19（批次 7）：**F6-4 外盘联动监控完成**——data-service 新增
  `GET /overseas/summary`（缓存 10 分钟，三块独立降级、失败块带 error）：
  美股三大指数（腾讯 qt.gtimg.cn usDJI/usIXIC/usINX 主源 → 新浪 `index_us_stock_sina`
  日 K 降级）、中概股与美股热门篮子 14 只（腾讯固定篮子，无降级源宁缺毋滥）、
  国际金银原油（新浪 `futures_foreign_commodity_realtime` 交易所代码 XAU/XAG/GC/SI/CL/OIL
  主源 → 东财 `futures_global_spot_em` 当月连续合约降级，超时放宽 60s）。
  **选型均经实测**：东财 `index_global_spot_em`（push2 clist 的 i: 市场）与
  `stock_us_famous_spot_em`（69.push2 子域）本机断连不可用；AKShare 候选函数的中文
  symbol 触发列数不匹配——均记入 PITFALLS。主服务：`getOverseasSummary` 接入
  provider/CompositeProvider（客户端超时放宽 90s，商品降级链最坏 30s+32s）；
  `GET /api/overseas/summary` 挂口令鉴权后，响应附加 `hints`（规则化"A 股相关方向提示"，
  `src/data/overseasHints.ts` 纯函数：指数/中概篮子/黄金/原油四组阈值规则，
  措辞全部"历史上与 X 板块情绪相关，仅供参考"，红线遵守）。前端：新增
  `public/overseas/` 独立导航页（方向提示卡 + 三个报价卡 + 双时间标注），
  stocks/market/news/funds 四页页头加"🌐 外盘"导航。盘前推送（可选项已做）：
  scheduler 新增 `startOverseasPush`（交易日约 9:10 北京时间，复用交易日历判断与
  notify 通道，推送给有自选股 ∪ 有监控规则的用户），`OVERSEAS_PUSH_ENABLED=true`
  开启（默认 false），文案构造 `buildOverseasPushText` 纯函数导出。
  验证：typecheck + 180 测试全绿（tests/overseas.test.ts 12 条：provider URL/透传/
  错误分支、Composite 降级文案、提示规则触发/不触发/块失败跳过、推送文案构造）+
  py_compile 通过；端到端实测（验证端口 8123/18823，验后已停并清理）：/overseas/summary
  三块全部真实数据（腾讯指数 3 条/个股 14 条、新浪商品 6 条，2.7s），缓存命中 2.4ms，
  **降级链实测**：强制腾讯失败 → 指数块走新浪日 K 返回一致数值，强制新浪失败 → 商品块
  走东财当月连续合约成功，中概块失败 → error 字段正确降级；/api/overseas/summary
  无口令 401、带口令 200 且 hints 正确生成；/overseas 静态页 200；盘前推送开关开启后
  调度日志正确（下次触发 41.1 小时后=周一 9:10，周末已跳）；前端内联 JS node --check
  通过。**未覆盖**：9:10 定时触发本身未实测（今日周六，调度结构与收盘日报同款）；
  生产实例（8000/18790）未动，本分支合入后需重启两个服务生效。
- 2026-09-19（批次 6）：**F6-3 板块轮动监控完成**——独立导航页 `/sectors`：
  涨跌排行 / 资金流排行双 Tab、板块详情（成分股表 + 日 K 走势图）、"查个股所属板块"
  共振查询（代码直查/名称经 /api/search 解析，返回所属行业板块当日涨跌幅名次与资金流名次）。
  data-service 新增 5 端点：`/sectors/rank`、`/sectors/fund-flow`（缓存 60s）、
  `/sectors/cons`、`/sectors/history`（缓存 10min）、`/sectors/of-stock/{code}`。
  **实现选型**（实测 akshare 1.18.94 后确定）：排行/资金流/成分股按 AKShare 同参数
  **直连东财 clist**（封装丢弃成交额/领涨股代码/板块代码等必需字段），宿主降级
  push2 → push2delay（响应带 source 标注，页面标"延时约 15 分钟"）；板块日 K 走
  AKShare `stock_board_industry_hist_em`（BK 代码直传跳过内部名称解析）；of-stock
  行业复用 /profile 端点，匹配精确优先 + 罗马数字后缀归一化兜底，未匹配返回
  matched=false 而非报错；资金流名次失败仅省略该字段（端点内独立降级）。
  主服务：provider.ts 加 SectorRank 等 5 类型与 5 方法、CompositeProvider 接线；
  webchat.ts 挂 /sectors 静态页 + /api/sectors/*（口令鉴权后）；前端复用 theme.css
  与手写 SVG 折线，/stocks、/market、/news、/funds 页头加"🏭 板块"导航。
  验证：typecheck + 176 测试全绿（新增 9 条：URL 拼接/透传/未匹配结构化/404/连接失败）+
  py_compile 通过；端到端实测（验证端口 8122/18822 + 独立临时数据目录，验后已停并清理）：
  rank/fund-flow/cons/of-stock 均返回真实数据（实测 600519→白酒Ⅱ 名次 351/496、
  资金流名次 152/496；002594→乘用车），401/400 正常，/sectors 静态页 200，
  内联 JS node --check 通过。**未覆盖**：板块日 K 端到端未复验——验证窗口内 push2his
  对本机 IP 断连限流（间歇性，本批早前同机直接调用 stock_board_industry_hist_em 实测
  返回 14 行、列名与归一化映射一致），限流期该端点返回结构化 502 只影响走势图区块。
- 2026-09-19（批次 5）：**F6-1 K 线形态识别 + 历史成绩单完成（F6 路线图启动）**——
  data-service 新增 `GET /patterns/{code}?days=`（默认 750、上限 1500，按 (code,days)
  缓存 6h）：基于 `_load_bars` 同源前复权日 K **纯本地检测 17 种经典形态**（K 线组合 11 种：
  十字星/锤子线/上吊线/看涨吞没/看跌吞没/早晨之星/黄昏之星/乌云盖顶/刺透形态/红三兵/
  三只乌鸦；价格结构 6 种：双底/双顶/头肩底/头肩顶/上升三角形/下降三角形；杯柄/口袋支点
  定义把握不足未纳入），检测器全部只用信号日及之前数据（分形右边界留 2 根确认，
  合成 K 线截断重放验证无未来函数）；结构类要求显著极值（双底/顶须接近窗口最低/高点、
  头肩头即窗口极值），信号日为颈线/压力线首次突破日。历史成绩单：每个信号日之后
  5/10/20 个交易日的上涨占比/平均涨跌幅（收盘口径）/平均最大回撤（窗口内最低价相对
  信号日收盘），窗口不完整的出现不计入该窗口统计；近期出现 = 近 60 个交易日信号日列表。
  主服务：`DataProvider` 加 `PatternReport` 系列类型与 `getPatterns`，CompositeProvider
  接线；新增 `GET /api/stocks/:code/patterns?days=`（口令鉴权后，**不进详情聚合块**）。
  新技能 `get_stock_patterns`（`src/skills/bundled/patterns/`，SYSTEM_PROMPT 加规则 9
  routing 与红线约束），输出近期形态 + 成绩单摘要 + count<5 样本过少提示 + 免责声明。
  详情页 AI 多维分析卡下方新增独立"形态分析"卡：近期触发 chips（中性配色）+ 历史成绩单
  表格（5/10/20 日三窗口：上涨占比·均涨幅·平均最大回撤，样本过少标注）+ 口径与免责脚注。
  验证：typecheck + 178 测试全绿（新增 11 条：provider 5 + 技能 6）+ py_compile 通过；
  合成 K 线 sanity check 34 项全过（13 种形态定点识别 + 截断重放无前视 + 报告统计口径）；
  端到端实测（验证端口 8121/18821 + 独立临时数据目录，验后已停并清理）：/patterns 沪深
  各一只有真实结果（sina 降级源，push2his 仍限流）、缓存命中 2.9ms、主服务 API
  401/400/200 正常、详情聚合七块无回归、/api/chat 实测 LLM 调用 get_stock_patterns 并
  按历史统计口径输出（含样本过少提示与免责声明）、详情页内联 JS node --check 通过。
  **未覆盖**：东财主源路径未实测（push2his 对本机限流中，与 /history 同链路由既有逻辑托底）。
- 2026-09-19（批次 4）：**F5-4 多条件监控提醒完成（F5 轻量项收官）**——异动提醒从单一
  全局涨跌幅阈值升级为用户可配置的多条件规则：新增 `manage_alerts` 技能
  （`src/skills/bundled/alerts/`，add/list/remove/enable/disable 白名单 action），
  条件类型 price_above（涨到≥）/ price_below（跌到≤）/ change_pct（涨跌幅绝对值≥%），
  一条规则最多 5 个条件、combinator=any（任一触发）/all（全部满足）；规则存 SQLite
  `alert_rules` 表（新增 Store CRUD：按 userId 隔离、损坏 JSON 行读取时跳过），
  每用户上限 20 条；add 前验证代码存在（停牌股走搜索降级，同 manage_watchlist）。
  调度：`startPriceAlerts` 轮询并入规则求值——用户集合扩为"有自选股 ∪ 有规则"
  （规则股票不要求在自选股里），规则代码并入去重拉行情集合；all 规则按规则每日去重、
  any 规则按条件粒度每日去重（同一规则的不同条件可在不同时刻各自触发一次），
  与阈值命中合并为一条推送，推送成功才写去重标记（失败下轮补报沿用）。
  领域逻辑抽为 `src/alerts/rules.ts` 纯函数（validateConditions/evaluateRule/describe*），
  scheduler 与技能共用。**范围裁剪**（路线图原列"指标信号"条件）：指标信号基于已完成
  日 K、盘中不变，盘中轮询无意义，该类提醒由 F5-3 收盘日报信号摘要覆盖。
  SYSTEM_PROMPT 规则 3 加 manage_alerts routing。
  验证：typecheck + 167 测试全绿（新增 tests/alertRules.test.ts 16 条：条件校验/求值
  边界/any/all 组合/NaN 涨跌幅/文案/Store CRUD 与用户隔离/脏行跳过/技能全流程）；
  端到端实测（验证端口 18809 + 独立临时数据目录 + 生产 data-service 8000，验后已停并
  清理）：/health 技能清单含 manage_alerts、无口令 401、/api/chat 发"宁德时代涨到350元
  或者跌幅超过6%就告诉我"实测 LLM 建规则 #1（SQLite 行核对无误）、"查看我的提醒"
  正确列出。**未覆盖**：盘中触发推送未实测（今日周六非交易日，轮询条件分支不进；
  求值/去重逻辑由单测覆盖，轮询/推送链路与既有阈值提醒同路径）。
- 2026-09-19（批次 3）：**F5-3 盘后复盘推送完成**——收盘日报（15:30）升级：行情行之后
  附加【技术面信号】区，逐股并发拉 F5-1 `/indicators` 端点（默认 250 天口径），
  只列出**有客观信号**的股票（金叉/死叉/站上跌破 MA60/突破布林轨/RSI6 超买超卖，
  文案与 F5-1 端点完全一致，全区标注"客观状态描述，非买卖建议"），单股最多 3 条防刷屏。
  降级行为：全部无信号且零失败 → 信号区整段不出现（不占版面）；数据源无指标能力
  （纯东财直连）或全部失败（data-service 未运行）→ 一行降级说明；单股失败 →
  其余照常 + "N 只获取失败已跳过"注记；单股行情失败降级 ⚠️ 行为不变。
  新增配置 `DAILY_REPORT_SIGNALS`（默认 true，可整体关闭信号区）。
  `buildDailyReport` 导出供单测（`tests/dailyReport.test.ts` 8 条新用例：
  齐全/单股行情失败/零信号省略/无指标能力/单股指标失败/全部失败/信号截断/空自选）。
  验证：typecheck + 151 测试全绿；端到端连真实数据链（生产 data-service 8000，
  sina 降级源）实测 buildDailyReport：300750 真实触发"RSI6=12.9 超卖"信号正确入报，
  无信号的 600519 正确省略，免责声明在尾。**未覆盖**：15:30 定时触发点本身未实测
  （调度结构未改，触发链路由既有 scheduler 测试与运行实例托底）。
- 2026-09-19（批次 2）：**F5-2 AI 个股多维分析完成**——新技能 `analyze_stock`
  （`src/skills/bundled/analyze/`）：`Promise.allSettled` 并发聚合六块（行情/估值、
  公司资料、资金流 15 天含近 5 日主力净流入合计、技术面复用 F5-1 /indicators 250 天、
  近两期财报、最新 5 条新闻按时间倒序），单块失败/方法缺失只在该块标注"暂不可用"
  不拖垮整体；结果头部内嵌红线约束（不得给出买卖建议/目标价/收益承诺），
  SYSTEM_PROMPT 新增规则 5（"分析/怎么看/能不能买"→ analyze_stock 分维度客观解读，
  只问行情数字仍走 get_stock_quote）。详情页技术指标卡下方新增"AI 多维分析"卡：
  点击后**复用 /api/chat 链路**（localStorage userId + 预填分析请求），回复渲染卡内
  （textContent + pre-wrap），并同步进聊天页会话历史可追问；切换股票清空旧结果、
  请求中禁重发、迟到响应按 code 丢弃。验证：typecheck + 143 测试全绿（analyze 7 条
  新用例：格式化/六块齐全/单块降级/可选方法缺失/新浪口径标注/取数参数）+ 详情页内联
  JS node --check 通过；端到端实测（验证端口 18808 + 生产 data-service 8000，验后已停并
  清理进程与临时数据目录）：/health 技能清单含 analyze_stock、无口令 401、
  /api/chat"帮我多维度分析一下600519"实测 LLM 调用 analyze_stock 并输出六维度解读
  （含超卖/支撑位等客观描述与固定免责声明，无买卖建议）。**未覆盖**：无（全链路含
  data-service 真实数据实测通过）。
- 2026-09-19：**解决 P9、关闭 P10**——按 P9 建议修法第 1 条执行恢复：杀掉残留旧进程
  （PID 26168，2026-09-15 20:48 启动，含子进程 2164），以最新 main 代码重启主服务
  （`npx tsx src/index.ts` 无 watch，避开 tsx watch 不重载的坑）并拉起 data-service
  （uvicorn 8000）。恢复后全链路实测：/api/stocks/002594 聚合七块全部有数据（quote 含
  limitUp/limitDown/week52——**东财 push2 限流已自行解除**，week52 为东财独有字段可证；
  fundFlow 30 条 sina 源、dividends 10 条、profile 行业"乘用车"、news/announcements
  各 10 条、financials 4 期）、/api/funds/rank、/api/stocks/600519/indicators（F5-1）、
  /api/stocks/002594/intraday、/api/market/news 全部正常返回。P9/P10 从已知问题节撤下
  （根因与排查纪律留在 PITFALLS），加固项保留为 S3-4（一键启动脚本 + /health 暴露
  版本与 data-service 连通性）。
- 2026-09-16（批次 3）：**排查用户报告的"大面积没有数据"（详情见 P9/P10，未改代码）**——
  用户截图报告基金页、快讯页、详情页公司资料/分时/技术指标/新闻/公告/财报无数据，且
  行情卡多字段显示 —。排查实锤两个独立根因叠加：①主服务 tsx watch 进程自
  2026-09-15 20:48 起从未热重载，跑 F3-4 合并前旧代码（实证：/api/stocks/002594 的
  quote 无 F3-6 的 limitUp 键、无 fundFlowError 键；静态页面从磁盘读是最新前端 →
  前后端版本错位）；②data-service 完全未运行（8000 无监听、无 python 进程，停机原因
  不可考）→ 全部微服务依赖块降级。盘前字段缺失（今开/最高/最低/成交额 —、换手率/量比
  0.00）经腾讯源实测确认是**设计内行为**（盘前无成交 + A-310 防假 0；涨停价盘前实测
  有值 92.73/75.87，截图里显示 — 是根因①所致）。文档落点：STATUS 新增 P9（进程管理失控，
  含立即重启/一键启动脚本//health 版本暴露/探针扩展四级修法）与 P10（盘前行为登记为
  设计内），S3-4 立项进程管理加固，PITFALLS 旧进程条目加 2026-09-16 第三变种 +
  新增腾讯盘前行为条目。**修复动作（重启服务等）留给下一个 agent 按 P9 执行。**
- 2026-09-16（批次 2）：**F5-1 技术指标分析完成（F5 路线图启动）**——data-service 新增
  `GET /indicators/{code}?days=`（默认 250、上限 1500）：原 `/history` 取数降级链抽为共用
  `_load_bars`（东财→新浪，返回 `(bars, source)`），指标在与 /history 同源的前复权日 K 上
  **纯本地 pandas 计算**（无新外部依赖）：MA(5/10/20/60)、EMA(12/26)、MACD（柱=2×(DIF−DEA)，
  国内惯例）、RSI(6/12/24，Wilder 平滑）、KDJ(9,3,3 递推平滑）、BOLL(20,2，总体标准差
  ddof=0）——口径全文见 DATA_SOURCES.md"技术指标本地计算"节。响应四块：latest（周期不足
  为 null，NaN/Inf 经 `_f3` 置 null）/ keyLevels（近 120 日分形高低点+区间极值 3% 聚类，
  收盘下/上方最近各至多 2 档）/ signals（金叉死叉/站上跌破 MA60/突破布林轨/RSI6 超买超卖，
  **仅客观状态描述，不含买卖建议**）/ series（按 dates 对齐的 MA 序列）。主服务：
  `DataProvider` 加 `TechnicalIndicators` 系列类型与 `getIndicators`，CompositeProvider
  接线；新增 `GET /api/stocks/:code/indicators?days=`（口令鉴权后；**不进详情聚合七块**，
  前端独立拉取、失败只影响自己）。前端详情页两处落点：走势图卡下方新增"技术指标"卡
  （六个分组格 + 信号 chips **中性配色** + 口径与免责声明脚注）；日 K 走势图叠加
  MA5/10/20/60 均线（琥珀/紫/蓝/灰，彩色图例，tooltip 附均线值，series 与 bars 按日期
  对齐故区间切换免重拉；指标后到/失败不阻塞价格线）。验证：typecheck + 136 测试全绿
  （indicators 5 条新用例）+ py_compile 通过；指标数学经**朴素循环参考实现交叉核对 18 项
  一致**（容差 0.01，含短序列/恒定价格边界）；端到端实测 /indicators 真实数据（sina 降级
  路径，MA20 与 BOLL 中轨一致、KDJ/RSI 低位与"跌破 MA60"信号互证）、无效代码 502、
  days 上限 422、主服务 API 401/400/200、详情聚合七块无回归、内联 JS node --check 通过
  （验证端口 8107/18807，验后已停）。**未覆盖**：东财主源路径未实测（push2his 对本机
  限流中，与 /history 同链路由既有逻辑托底）。
- 2026-09-16：**F3-6 完成（F3 个股信息补全收官）**——涨跌停价/52 周高低/分红送配。
  涨跌停与 52 周高低走 Quote：`Quote` 新增 limitUp/limitDown/week52High/week52Low；
  东财 push2 加 f51/f52（涨跌停）/f174/f175（52 周高低）——**均放大 100 倍**（push2delay
  fltt=2 与默认缩放响应交叉实测核对一致）；腾讯降级源 47=涨停价/48=跌停价（不缩放，
  与东财实测一致），**腾讯无 52 周字段**，降级时缺失、展示层显示 —。分红送配走微服务：
  data-service 新增 `GET /dividends/{code}?limit=`（默认 10、上限 50，按代码缓存 6h），
  AKShare `stock_history_dividend_detail`（indicator="分红"），口径为每 10 股
  （派息元，税前）；日期 NaT/列名漂移置 null 不补占位；**无效代码上游返回空表 → 200 []**
  （与"从未分红"无法区分，口径已注明）。主服务：`DataProvider` 加 `DividendRecord` 与
  `getDividends`，CompositeProvider 接线；`/api/stocks/:code` 聚合扩为七块
  （+dividends/dividendsError 独立降级）。前端：详情页统计格加涨停价/跌停价/52周最高/
  52周最低，资金流卡下方新增"分红送配"卡（公告日期/除权除息日/每10股派息/送股/转增/进度
  六列表格，0 值显示 —，卡下注明口径）。验证：typecheck + 131 测试全绿（东财/腾讯新字段
  3 条 + dividends 6 条新用例，fixture 自 push2delay 重录含新字段）+ py_compile 通过；
  端到端实测 /dividends（真实分红数据、缓存命中 2ms、limit 上限 422、无效代码 200 []）、
  聚合七块无错误块、涨跌停字段经腾讯降级路径返回正确、401 正常、详情页内联 JS
  node --check 通过（验证端口 8106/18806，验后已停）。
  **未覆盖**：东财 push2 主路径新字段未实测（本机限流中，字段编码经 push2delay +
  腾讯交叉核对，fixture 回放覆盖解析）。

- 2026-09-16：**F3-5 分时数据完成**——data-service 新增 `GET /intraday/{code}`
  （按代码缓存 60s）。降级链：主源 AKShare `stock_zh_a_hist_min_em`（东财 push2his 当日
  1 分钟 K）→ **新浪 `stock_zh_a_minute`**（sh/sz/bj 前缀，**bj 北交所实测覆盖**——与日 K/
  资金流的新浪降级源不同；返回近约 8 个交易日分钟数据，端点只取最近一个交易日；
  **新浪分钟成交量单位是股**，端点 ÷100 归一到手，与日 K 同一换算口径）。
  分时均价 avgPrice = 累计成交额 ÷ 累计成交量（VWAP），两源都有成交额列故都输出；
  成交额列漂移时整条不输出 amount/avgPrice。主服务：`DataProvider` 加
  `IntradayPoint`/`Intraday` 与 `getIntraday`，CompositeProvider 接线；新增
  `GET /api/stocks/:code/intraday`（口令鉴权后）。前端：详情页走势图加"分时 | 日K"
  切换 pill（默认分时，日K 模式才显示区间 pill）；分时图为价格折线 + 昨收参考虚线 +
  VWAP 均价虚线（琥珀色）+ 成交量副图（红绿按相对前一分钟涨跌）+ hover tooltip
  （时间/价格+涨跌幅/均价/成交量），图下注明数据日期与数据源；昨收失败时退化为首价
  基准不阻塞图表。验证：typecheck + 122 测试全绿（intraday 5 条新用例）+ py_compile
  通过；端到端实测 /intraday 沪深京三码（sina 降级路径，238 点/日，均价线数值合理）、
  无效代码 502 双源合并报错、缓存命中（59ms）、主服务 API 401/400/200 正常、
  详情页内联 JS node --check 通过（验证端口 8105/18805，验后已停）。
  **未覆盖**：东财主源列名未实测（push2his 对本机限流中，列名为 AKShare 文档口径，
  漂移时 time/price/volume 缺失跳行、amount 缺列则 avgPrice 不输出）。

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
