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
- 📮 收盘日报：每个交易日 15:30 自动推送自选股当日表现（跳法定节假日）
- 🚨 异动提醒：盘中自选股涨跌幅超阈值（默认 ±5%）主动推送
- 🩺 行情健康探针：定时探测行情链路，接口失效主动告警
- 🌐 内置网页聊天界面（WebChat，API 访问口令保护）；飞书渠道已实现（验签/回复/主动推送），默认关闭
- 📊 股票浏览页（/stocks）：自选股卡片列表 + 页内搜索 + 个股详情页（历史走势折线图、新闻/公告/财报）
- 🚀 全市场涨跌榜（/market）：今日涨幅榜/跌幅榜/平盘 + 涨跌平家数总览，点卡片跳个股详情
- 💰 基金版块（/funds）：开放式基金排行（按类型）/基金搜索/净值走势图/场内 ETF 实时榜，对标支付宝财富页基金内容；对话可查"基金排行""某基金怎么样"

## 快速开始

**要求：Node.js ≥ 22.13**（`node:sqlite` 免 flag 的最低版本）

```bash
npm install
cp .env.example .env   # 填入 LLM_API_KEY（推荐 DeepSeek，国内直连且便宜）
npm run dev
```

打开 http://localhost:18790/webchat 、http://localhost:18790/stocks 、http://localhost:18790/market 或 http://localhost:18790/funds ，按提示输入访问口令
（口令 = `.env` 的 `ACCESS_TOKEN`；未配置时启动日志会打印一个随机口令）。

**启用新闻/公告/财报/历史走势/搜索/基金版块功能**（需要 Python ≥ 3.10；行情/指数/涨跌榜不需要 data-service）：

```bash
cd data-service
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

## 架构一览

```
用户（WebChat / 飞书）
   │
channels/          渠道适配：HTTP <-> 统一消息
   │
agent/loop.ts      Agent 循环：LLM function calling 调度技能
   │
skills/bundled/    技能（quote / search / news / announcement / financials / watchlist / index），每个含 SKILL.md 说明
   │
data/              数据源抽象：东财直连（行情/指数）+ Python AKShare 微服务（新闻/公告/财报/搜索/历史K线/交易日历）
   │
storage/store.ts   SQLite 存储（node:sqlite）：自选股 + 会话历史 + 离线收件箱 + kv，按 userId 隔离
```

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。开发者/Agent 交接信息见 [CLAUDE.md](CLAUDE.md)。

## 合规说明

本项目定位为**信息聚合工具**：行情、新闻、公告的汇总与转述。
不提供荐股、买卖点建议或代客理财——这些在国内属于持牌投资咨询业务，请勿越界。
