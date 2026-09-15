# 数据源备忘

## 东方财富公开接口（免 key）

**实时行情**
```
GET https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f43,f57,f58,f60,f170,f86
```
- 需要 `Referer: https://quote.eastmoney.com/` 请求头
- 常用字段：f43 最新价 / f44 最高 / f45 最低 / f46 今开 / f57 代码 / f58 名称 /
  f60 昨收 / f169 涨跌额 / f170 涨跌幅 / f86 时间戳（秒）
- 估值与规模（2026-09-15 实测核对，F3-1）：f162 PE(动) / f163 PE(静) / f164 PE(TTM) /
  f167 PB —— 放大 100 倍；f116 总市值 / f117 流通市值 —— 单位元，**不放大**
- 价格类字段放大 100 倍；停牌返回 `"-"`
- push2 被 IP 限流时可用 `push2delay.eastmoney.com` 同构接口（延时行情）临时验证字段/录 fixture

**搜索建议（已接入：search_stock 技能的降级方案）**
```
GET https://searchapi.eastmoney.com/api/suggest/get?input=茅台&type=14&count=10
```
- 返回 `QuotationCodeTable.Data[]`，含 Code/Name 等字段
- type=14 覆盖全市场证券，需自行过滤出 0/3/6 开头的 A 股个股（见 `src/data/eastmoney.ts` 的 `search()`）

**指数行情（已接入：get_market_index 技能）**
- 与个股行情同一个 push2 接口，只是 secid 规则不同：上证指数 `1.000001`、深证成指 `0.399001`、
  创业板指 `0.399006`、沪深300 `1.000300`、北证50 `0.899050`
- **不能复用个股 `toSecid()` 规则**；技能内置显式映射表，新增指数先查东财行情页确认 secid

**全市场涨跌榜（已接入：/market 涨跌浏览页，2026-09-15）**
```
GET https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f12,f14,f2,f3
GET https://push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001,0.899050&fields=f104,f105,f106
```
- clist：排行榜。fid=f3 按涨跌幅排序，po=1 降序/0 升序；fs 为全 A 范围（深主板/创业板/
  沪主板/科创板/北交所）。f2 最新价 / f3 涨跌幅 / f12 代码 / f14 名称；
  **`fltt=2` 时 f2/f3 是不缩放的浮点数**（与报价接口 ×100 相反！）；停牌股 f2/f3 为 `"-"`，
  且与涨跌幅 0 的股票**混排在零区**（平盘定位须二分查找，见 PITFALLS）
- ulist：涨跌平家数统计。f104 上涨 / f105 下跌 / f106 平盘；secid 1.000001=沪、
  0.399001=深、**0.899050=北交所**（实测可返回北交所全区统计），三市求和
- push2 限流时两个端点都可换 `push2delay.eastmoney.com` 同构托底（延时约 15 分钟）

## 腾讯行情（免 key，已接入：东财的自动降级备份）

```
GET https://qt.gtimg.cn/q=sh600519
```
- **GBK 编码**纯文本（必须 `TextDecoder('gbk')` 解码，直接 text() 乱码），`~` 分隔：
  `v_sh600519="1~名称~代码~最新价~昨收~今开~...~时间yyyyMMddHHmmss~涨跌额~涨跌幅%~..."`
  关键索引：1=name 2=code 3=price 4=prevClose 30=time 32=changePct（另 33=high 34=low）
  估值索引（2026-09-15 与东财 f 字段交叉实测一致）：39=PE(TTM) 52=PE(动) 53=PE(静) 46=PB、
  44=流通市值 / 45=总市值（**单位亿元**，×1e8 转元）
- 价格**不放大**，与东财 ×100 不同；停牌/无效代码返回空串（`v_xx=""`）
- 代码前缀：沪市 6/9→sh，深市 0/3→sz，北交所 4/8/920→bj；指数同规则（sh000001 上证指数）
- 触发条件：东财 push2 被 IP 限流或接口变更时自动托底（见 `src/data/index.ts` CompositeProvider）
- 实测 fixture：`tests/fixtures/tencent/quote-600519.txt`

## AKShare（Python，经 data-service 暴露）

| 函数 | 用途 |
|---|---|
| `ak.stock_news_em(symbol)` | 个股新闻（已接入 /news） |
| `ak.stock_bid_ask_em(symbol)` | 实时盘口快照（已接入 /quote） |
| `ak.stock_zh_a_disclosure_report_cninfo(symbol, market, keyword, category, start_date, end_date)` | 个股公告，巨潮资讯（已接入 /announcements；无 period 参数，按日期范围查） |
| `ak.stock_notice_report(symbol, date)` | 公告大全，**按日期查全市场**（非个股接口，未接入；勿用于个股公告） |
| `ak.stock_financial_abstract(symbol)` | 财报摘要，新浪（已接入 /financials；**参数名随版本变动**：旧版 `stock`、1.18.94 起 `symbol`，端点已双兼容；返回带"元"单位的字符串） |
| `ak.stock_info_a_code_name()` | 全量代码名称表（已接入 /search，进程内缓存 24h） |
| `ak.tool_trade_date_hist_sina()` | 交易日历，新浪（已接入 /trade-calendar?year=，进程内缓存 24h；返回 trade_date 为 date 对象，`str()` 即 "YYYY-MM-DD"） |

AKShare 文档：https://akshare.akfamily.xyz/

## 备用/付费选项

- Tushare（积分制，数据规整）：https://tushare.pro
- 聚宽 / Wind / iFinD：商业化后再考虑

## 合规红线

免费接口的 TOS 通常禁止商业转售数据。本项目定位为个人自用工具；
如果未来商业化，必须采购授权数据源（Wind/iFinD/交易所信息服务商）。
