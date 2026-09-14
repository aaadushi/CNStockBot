# 数据源备忘

## 东方财富公开接口（免 key）

**实时行情**
```
GET https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f43,f57,f58,f60,f170,f86
```
- 需要 `Referer: https://quote.eastmoney.com/` 请求头
- 常用字段：f43 最新价 / f44 最高 / f45 最低 / f46 今开 / f57 代码 / f58 名称 /
  f60 昨收 / f169 涨跌额 / f170 涨跌幅 / f86 时间戳（秒）
- 价格类字段放大 100 倍；停牌返回 `"-"`

**搜索建议（已接入：search_stock 技能的降级方案）**
```
GET https://searchapi.eastmoney.com/api/suggest/get?input=茅台&type=14&count=10
```
- 返回 `QuotationCodeTable.Data[]`，含 Code/Name 等字段
- type=14 覆盖全市场证券，需自行过滤出 0/3/6 开头的 A 股个股（见 `src/data/eastmoney.ts` 的 `search()`）

## AKShare（Python，经 data-service 暴露）

| 函数 | 用途 |
|---|---|
| `ak.stock_news_em(symbol)` | 个股新闻（已接入 /news） |
| `ak.stock_bid_ask_em(symbol)` | 实时盘口快照（已接入 /quote） |
| `ak.stock_zh_a_disclosure_report_cninfo(symbol, market, keyword, category, start_date, end_date)` | 个股公告，巨潮资讯（已接入 /announcements；无 period 参数，按日期范围查） |
| `ak.stock_notice_report(symbol, date)` | 公告大全，**按日期查全市场**（非个股接口，未接入；勿用于个股公告） |
| `ak.stock_financial_abstract(stock)` | 财报摘要，新浪（已接入 /financials；**参数名是 stock**，返回带"元"单位的字符串） |
| `ak.stock_info_a_code_name()` | 全量代码名称表（已接入 /search，进程内缓存 24h） |

AKShare 文档：https://akshare.akfamily.xyz/

## 备用/付费选项

- Tushare（积分制，数据规整）：https://tushare.pro
- 腾讯行情：`qt.gtimg.cn/q=sh600519`（纯文本，适合极简行情，未接入）
- 聚宽 / Wind / iFinD：商业化后再考虑

## 合规红线

免费接口的 TOS 通常禁止商业转售数据。本项目定位为个人自用工具；
如果未来商业化，必须采购授权数据源（Wind/iFinD/交易所信息服务商）。
