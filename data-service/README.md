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
| `GET /trade-calendar?year=` | 交易日历（新浪，用于跳过法定节假日） |

## 注意

- AKShare 本质是各财经网站接口的封装，接口失效时升级 `akshare` 版本通常能修复：
  `pip install -U akshare`
- 仅在本地（127.0.0.1）监听即可，不要暴露到公网。
