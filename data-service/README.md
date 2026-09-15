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
| `GET /history/{code}?days=120` | 历史日 K 线（前复权；东财失败自动降级新浪） |
| `GET /profile/{code}` | 公司资料：行业/上市日期/总股本/流通股（东财 push2，限流自动降级 push2delay 同构接口；按代码缓存 24h） |
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
