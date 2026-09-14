# CNStockBot —— A 股信息助手

通过聊天机器人查询你所购买股票的行情、新闻与公告。架构参考 [CloddsBot](https://github.com/alsk1992/CloddsBot)，
但只做**信息聚合**，不涉及任何交易功能。

> ⚠️ 本项目所有输出仅供参考，不构成投资建议。

## 功能（当前 MVP）

- 💬 自然语言对话查询 A 股实时行情（"600519 现在多少钱"）
- 📰 个股新闻 / 公告聚合
- ⭐ 自选股管理（"我买了 300750，记一下" / "我的自选股今天怎么样"）
- 📮 收盘日报：每个交易日 15:30 自动推送自选股当日表现
- 🌐 内置网页聊天界面（WebChat），飞书渠道骨架已预留

## 快速开始

**要求：Node.js ≥ 22**

```bash
npm install
cp .env.example .env   # 填入 LLM_API_KEY（推荐 DeepSeek，国内直连且便宜）
npm run dev
```

打开 http://localhost:18790/webchat 开始聊天。

**启用新闻功能**（可选，需要 Python ≥ 3.10）：

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
skills/bundled/    技能（quote / news / watchlist），每个含 SKILL.md 说明
   │
data/              数据源抽象：东财直连（行情）+ Python AKShare 微服务（新闻）
   │
storage/store.ts   JSON 文件存储自选股（可平滑换 SQLite）
```

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。开发者/Agent 交接信息见 [CLAUDE.md](CLAUDE.md)。

## 合规说明

本项目定位为**信息聚合工具**：行情、新闻、公告的汇总与转述。
不提供荐股、买卖点建议或代客理财——这些在国内属于持牌投资咨询业务，请勿越界。
