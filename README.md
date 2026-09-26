# CNStockBot —— A 股信息助手

通过聊天机器人查询你所购买股票的行情、新闻与公告。架构参考 [CloddsBot](https://github.com/alsk1992/CloddsBot)，
但只做**信息聚合**，不涉及任何交易功能。

> ⚠️ 本项目所有输出仅供参考，不构成投资建议。

## 功能

- 💬 自然语言对话查询 A 股实时行情（"600519 现在多少钱"），会话历史含工具调用上下文，可追问细节
- 🔍 股票名称→代码搜索（说"比亚迪"即可，不用记代码）
- 📰 个股新闻 / 公告 / 财报摘要聚合
- ⭐ 自选股管理（"我买了 300750，记一下" / "我的自选股今天怎么样"）
- 📈 大盘指数查询（上证/深成/创业板/沪深300 等）
- 📮 收盘日报：每个交易日 15:30 自动推送自选股当日表现（跳法定节假日），附加技术面信号摘要（金叉/超买等客观状态描述，需 data-service）
- 🚨 异动提醒：盘中自选股涨跌幅超阈值（默认 ±5%）主动推送；支持自定义多条件监控规则（"涨到 X 元 / 跌幅超 Y% 提醒我"，对话中设置，AND/OR 组合，每日去重）
- 🩺 行情健康探针：定时探测行情链路，状态见 /health（故障推送默认关，需 `HEALTH_PROBE_ALERT_PUSH=true`）
- 🌐 内置网页聊天界面（WebChat，**S4-1 多用户体系**：注册/登录/登出 + session token 鉴权）；飞书渠道已实现（验签/回复/主动推送），默认关闭
- 📊 股票浏览页（/stocks）：自选股卡片列表 + 页内搜索 + 个股详情页（行情含估值与市值、成交额/换手率/量比、涨跌停价/52 周高低、公司资料、资金流向、分红送配、分时/日K 走势图（含 VWAP 均价线与成交量副图）、技术指标面板与均线叠加（MA/MACD/RSI/KDJ/BOLL + 支撑/压力位）、形态分析（17 种经典 K 线形态识别 + 历史成绩单，历史统计口径）、资金流验货（近期形态信号 × 资金流方向交叉验证，重点观察/中性/存疑三档客观结论）、AI 多维分析（一键生成，复用聊天链路）、新闻/公告/财报）
- 🚀 全市场涨跌榜（/market）：今日涨幅榜/跌幅榜/平盘 + 涨跌平家数总览，点卡片跳个股详情
- 📰 财经快讯（/news + `get_market_news` 技能）：全市场财经快讯滚动列表，60s 自动刷新（需 data-service）
- 💰 基金版块（/funds）：开放式基金排行（按类型）/基金搜索/净值走势图/场内 ETF 实时榜，对标支付宝财富页基金内容；对话可查"基金排行""某基金怎么样"
- 🌐 外盘联动（/overseas，F6-4）：隔夜美股三大指数 / 中概股与美股热门 / 国际金银原油快照 + 基于规则的"A 股相关方向提示"（客观历史相关性映射，非买卖建议）；可选盘前推送（交易日约 9:10，`OVERSEAS_PUSH_ENABLED=true` 开启，需 data-service）
- 🏭 板块轮动页（/sectors）：行业板块涨跌排行/资金流排行、板块详情（成分股 + 日 K 走势图）、"查个股所属板块"共振查询（所属行业当日涨跌与资金流名次）；需 data-service
- 🔍 选股扫描（/scanner + `scan_market` 技能，F5-5）：本地全市场日 K 库（baostock 前复权，沪深约 5200 只，每日盘后自动增量更新）上的 7 个预设策略客观指标筛选（MA 多头排列/MACD 金叉/RSI 超卖/放量突破/缩量回踩/布林下轨/均线金叉），网页独立页 + 对话可查（"帮我扫描 MACD 金叉的股票"）；结果为客观命中名单，不构成投资建议；需 data-service 且首次需触发回填（数小时，断点续跑）
- 🧪 策略回测（/backtest，F5-6）：对单只股票按预设策略（与扫描同 7 个）做历史信号回放——真实 A 股规则（T+1、整手、佣金/印花税/滑点、可设止损与持有期），输出胜率/盈亏比/最大回撤/累计收益 vs 买入持有基准 + 净值曲线 + 逐笔交易明细；历史业绩不代表未来，不构成投资建议；需 data-service 且已回填日 K 库

## 快速开始

**要求：Node.js ≥ 22.13**（`node:sqlite` 免 flag 的最低版本）

```bash
npm install
cp .env.example .env   # 填入 LLM_API_KEY（推荐 DeepSeek，国内直连且便宜）
npm run dev
```

服务默认监听 `0.0.0.0:18790`（可通过 `.env` 的 `HOST`/`PORT` 调整）。
打开 http://localhost:18790/webchat ，按提示注册或登录账号后使用。
其他页面入口：/stocks、/market、/news、/funds、/overseas、/sectors、/scanner、/backtest。
选股扫描与策略回测需 data-service 且已回填日 K 库（见下）。

> **注意（S4-1）**：WebChat 已改为多用户体系，需先注册/登录获取 session token；旧的共享 `ACCESS_TOKEN` 不再作为常规 API 鉴权方式。

**启用新闻/公告/财报/历史走势/搜索/财经快讯/基金版块/板块轮动/选股扫描/策略回测功能**（需要 Python ≥ 3.10；行情/指数/涨跌榜不需要 data-service）：

```bash
cd data-service
pip install -r requirements.txt

# 设置 DATA_SERVICE_TOKEN（S4-2）：data-service 与主服务之间的共享静态 token，
# 未配置时 data-service 拒绝启动；公网/跨机器部署时务必使用强随机字符串。
DATA_SERVICE_TOKEN=change-me-to-a-random-string-at-least-32-chars \
  uvicorn main:app --host 127.0.0.1 --port 8000
```

同时请在主服务 `.env` 中设置相同的 `DATA_SERVICE_TOKEN`。

> **注意（S4-2）**：data-service 自 2026-09-26 起启用 token 鉴权，未配置 `DATA_SERVICE_TOKEN`
> 时拒绝启动；旧版主服务无法访问新版 data-service，升级需两端同步。

## 架构一览

```
用户（WebChat / 飞书）
   │
channels/          渠道适配：HTTP <-> 统一消息
   │
agent/loop.ts      Agent 循环：LLM function calling 调度技能
   │
skills/bundled/    技能（quote / search / news / announcement / financials / watchlist / index / marketnews / fundrank / fundinfo / analyze / alerts / patterns），每个含 SKILL.md 说明
   │
data/              数据源抽象：东财直连（行情/指数）+ Python AKShare 微服务（新闻/公告/财报/搜索/历史K线/交易日历）
   │
storage/store.ts   SQLite 存储（node:sqlite）：自选股 + 会话历史 + 离线收件箱 + kv + users/sessions 表（S4-1），按 userId 隔离
auth/              多用户认证：密码哈希、session token、登录限速、requireSession 中间件
```

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。开发者/Agent 交接信息见 [CLAUDE.md](CLAUDE.md)。

## 合规说明

本项目定位为**信息聚合工具**：行情、新闻、公告的汇总与转述。
不提供荐股、买卖点建议或代客理财——这些在国内属于持牌投资咨询业务，请勿越界。
