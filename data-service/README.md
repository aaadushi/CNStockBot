# data-service：Python 数据微服务

基于 [AKShare](https://github.com/akfamily/akshare)，为 Node 主服务提供 A 股新闻、公告、财报等
东财公开接口不便覆盖的数据。

## 启动

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
# source .venv/bin/activate

pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

验证：`curl http://127.0.0.1:8000/news/600519?limit=3`

## 接口

| 路径 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /quote/{code}` | 实时行情（Node 侧默认走东财直连，这个是备用） |
| `GET /news/{code}?limit=10` | 个股新闻 |
| `GET /search?keyword=` | 股票名称→代码搜索（全量表缓存 + 模糊匹配） |
| `GET /announcements/{code}` | 个股公告（巨潮资讯，近 30 天） |
| `GET /financials/{code}` | 财报摘要（新浪，按报告期倒序） |
| `GET /history/{code}?days=120` | 历史日 K 线（前复权；东财失败自动降级新浪）。字段：date/open/close/high/low/volume（手，新浪源按股返回已 ÷100 归一）/changePct；东财源另含 amount（成交额，元）/turnover（换手率，%），新浪降级源无此两列则不输出 |
| `GET /profile/{code}` | 公司资料：行业/上市日期/总股本/流通股（东财 push2，限流自动降级 push2delay 同构接口；按代码缓存 24h） |
| `GET /fund-flow/{code}?days=30` | 个股资金流向（东财五档主力/超大单/大单/中单/小单净流入，限流自动降级新浪 MoneyFlow 两档——口径不同，响应带 source 字段标注；按代码缓存 60s，days 上限 100） |
| `GET /intraday/{code}` | 个股分时（1 分钟线，最近一个交易日；东财 stock_zh_a_hist_min_em 主源、新浪 stock_zh_a_minute 降级——新浪返回近 8 个交易日，端点只取最近一日，其成交量按股返回已 ÷100 归一到手）。字段：date/source/points[time/price/volume(手)/amount(元)/avgPrice(VWAP 均价)]；按代码缓存 60s |
| `GET /dividends/{code}?limit=10` | 个股分红送配记录（AKShare stock_history_dividend_detail，东财源，按公告日期倒序；每 10 股口径：派息元税前/送股/转增，含公告日期/除权除息日/股权登记日/进度；无效代码与从未分红均返回空数组；按代码缓存 6h，limit 上限 50） |
| `GET /indicators/{code}?days=250` | 个股技术指标（F5-1，纯本地 pandas 计算，无新外部依赖；输入为与 /history 同源的前复权日 K）：MA/EMA/MACD/RSI/KDJ/BOLL 最新值 + 支撑/压力关键价位（近 120 日分形高低点 3% 聚类）+ 客观信号（金叉/死叉/超买超卖等状态描述，非买卖建议）+ 按日期对齐的 MA 序列（走势图叠加用，前导不足周期为 null）；days 上限 1500；指标口径见 docs/DATA_SOURCES.md |
| `GET /trade-calendar?year=` | 交易日历（新浪，用于跳过法定节假日） |
| `GET /funds/rank?type=&limit=` | 开放式基金排行（天天基金，按近1年收益率降序；type 白名单：全部/股票型/混合型/债券型/指数型/QDII/FOF；按类型缓存 10 分钟） |
| `GET /funds/search?keyword=` | 基金搜索（全量代码表缓存 24h，支持名称/代码/拼音缩写） |
| `GET /funds/etf?limit=` | 场内 ETF 实时行情榜（东财全量快照，翻页 30s+ 故超时 120s + 缓存 60s） |
| `GET /funds/{code}?days=` | 单只基金详情 + 单位净值走势（按代码缓存 6h；须声明在 rank/search/etf 之后） |
| `GET /market-news?limit=20` | 全市场财经快讯（东财全球快讯主源、财联社降级，缓存 90s，上限 50 条） |

## 注意

- AKShare 本质是各财经网站接口的封装，接口失效时升级 `akshare` 版本通常能修复：
  `pip install -U akshare`
- 仅在本地（127.0.0.1）监听即可，不要暴露到公网。
