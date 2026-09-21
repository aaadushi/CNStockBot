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
- 成交活跃度（2026-09-15 与腾讯接口交叉实测核对，F3-3）：f47 成交量（**手，不放大**）/
  f48 成交额（**元，不放大**，浮点）/ f168 换手率(%) / f50 量比 —— 后两个放大 100 倍
- 涨跌停与 52 周高低（2026-09-16 经 push2delay fltt=2 与缩放响应交叉实测核对，F3-6）：
  f51 涨停价 / f52 跌停价 / f174 52周最高 / f175 52周最低 —— 均放大 100 倍
- 公司资料（2026-09-15 实测核对，F3-2，`stock_individual_info_em` / `/profile` 端点）：
  f84 总股本 / f85 流通股（单位股，不放大）/ f127 所属行业 / f189 上市时间（yyyymmdd 整数）；
  停牌/退市/已切换代码返回 `"-"`
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

**行业板块（已接入：/sectors 板块轮动页，F6-3，2026-09-19；data-service 内直连 clist 实现）**
```
GET https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2+f:!50&fields=...
```
- 涨跌排行（/sectors/rank）：fs=`m:90 t:2 f:!50`（东财行业板块，含多级行业约 500 个），
  fid=f3 按涨跌幅降序。字段：f12 板块代码（BK）/ f14 名称 / f2 最新价 / f3 涨跌幅 / f4 涨跌额 /
  f6 成交额（元）/ f8 换手率 / f20 总市值（元）/ f104 上涨家数 / f105 下跌家数 /
  f128 领涨股名 / f140 领涨股代码 / f136 领涨股涨跌幅
- 资金流排行（/sectors/fund-flow）：fs=`m:90 t:2`（不带 f:!50），**fid0**=f62（今日主力净流入）
  + stat=1，按主力净流入降序。字段：f62 主力净流入 / f184 主力净占比 / f66/f69 超大单 /
  f72/f75 大单 / f78/f81 中单 / f84/f87 小单（净额元 + 净占比%）/ f204/f205 主力净流入最大个股
- 成分股（/sectors/cons）：fs=`b:{BK代码} f:!50`，字段 f12/f14 成分股代码名称 +
  f2/f3/f4 价涨跌 / f5 成交量（手）/ f6 成交额 / f7 振幅 / f8 换手率 / f9 市盈率（动）/ f23 市净率
- 参数与 AKShare 封装（stock_board_industry_name_em / stock_sector_fund_flow_rank /
  stock_board_industry_cons_em）逐一核对一致；**不走 AKShare 是因为其封装丢弃了成交额/
  领涨股代码/板块代码等必需字段**（2026-09-19 实测其源码确认）
- fltt=2 时数值**不缩放**（与涨跌榜一致）；全量约 500 行需翻页（pz=100 约 5 页，间隔 0.3s
  防限流）；push2 限流自动降级 push2delay（响应带 `source: eastmoney-delay` 标注）

## 腾讯行情（免 key，已接入：东财的自动降级备份）

```
GET https://qt.gtimg.cn/q=sh600519
```
- **GBK 编码**纯文本（必须 `TextDecoder('gbk')` 解码，直接 text() 乱码），`~` 分隔：
  `v_sh600519="1~名称~代码~最新价~昨收~今开~...~时间yyyyMMddHHmmss~涨跌额~涨跌幅%~..."`
  关键索引：1=name 2=code 3=price 4=prevClose 30=time 32=changePct（另 33=high 34=low）
  估值索引（2026-09-15 与东财 f 字段交叉实测一致）：39=PE(TTM) 52=PE(动) 53=PE(静) 46=PB、
  44=流通市值 / 45=总市值（**单位亿元**，×1e8 转元）
  成交活跃度索引（2026-09-15 与东财交叉实测一致，F3-3）：6=成交量(手) /
  37=成交额（**万元**，×1e4 转元）/ 38=换手率(%) / 49=量比 —— 均不缩放；空串=缺失（注意
  `Number('') === 0` 的坑，解析前要先判空串）
  涨跌停索引（2026-09-16 与东财 f51/f52 实测一致，F3-6）：47=涨停价 / 48=跌停价（不缩放）；
  **腾讯无 52 周高低字段**，降级时 Quote.week52High/week52Low 缺失
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
| `ak.fund_open_fund_rank_em(symbol)` | 开放式基金排行，天天基金（已接入 /funds/rank；symbol 为类型：全部/股票型/混合型/债券型/指数型/QDII/FOF，按近1年收益率降序返回该类型全量，耗时数秒，按类型缓存 10 分钟） |
| `ak.fund_open_fund_info_em(symbol, indicator)` | 单只基金单位净值走势（已接入 /funds/{code}；indicator="单位净值走势"，返回全量历史、日期升序，列：净值日期/单位净值/日增长率，按代码缓存 6h） |
| `ak.fund_name_em()` | 全量基金代码表约 2.8 万行（已接入 /funds/search，缓存 24h；含基金简称/拼音缩写/类型列） |
| `ak.fund_etf_spot_em()` | 场内 ETF 全量实时快照，东财（已接入 /funds/etf；全量翻页 30s+，run_ak 超时放宽 120s + 缓存 60s；含 IOPV/溢价率列） |
| `ak.stock_info_global_em()` | 东财全球财经快讯，约 200 条（已接入 /market-news 主源；列：标题/摘要/发布时间/链接，含 URL） |
| `ak.stock_info_global_cls()` | 财联社电报，约 20 条（已接入 /market-news 降级源；列：标题/内容/发布日期/发布时间，无 URL；短快讯"标题"常为空，端点取"内容"前 60 字充任） |
| `ak.stock_zh_a_hist(symbol, period, start_date, end_date, adjust)` | 个股历史日 K，东财 push2his（已接入 /history 主源；列：日期/开盘/收盘/最高/最低/成交量（**手**）/成交额（元）/涨跌幅/换手率，成交额与换手率 F3-3 起透出） |
| `ak.stock_zh_a_daily(symbol, start_date, end_date, adjust)` | 个股历史日 K，新浪（已接入 /history 降级源；**成交量单位是股**，端点 ÷100 归一到手；无成交额/换手率/涨跌幅列，涨跌幅由收盘价比算，不覆盖北交所） |
| `ak.stock_individual_fund_flow(stock, market)` | 个股资金流向，东财 push2his fflow/daykline（已接入 /fund-flow 主源；market=sh/sz/bj 按代码前缀映射——920 段属北交所须先于 "9" 判断；列：日期/收盘价/涨跌幅/主力·超大单·大单·中单·小单净流入-净额与净占比，百分数字段已是 % 单位） |
| `ak.stock_zh_a_hist_min_em(symbol, period, adjust)` | 个股分钟 K，东财 push2his（已接入 /intraday 主源；period="1" 当日 1 分钟线仅支持 adjust=""；列：时间/开盘/收盘/最高/最低/涨跌幅/涨跌额/成交量（手）/成交额（元）/振幅/换手率——列名为 AKShare 文档口径，主源限流中未实测） |
| `ak.stock_zh_a_minute(symbol, period, adjust)` | 个股分钟 K，新浪（已接入 /intraday 降级源；symbol 带市场前缀 sh/sz/bj——**bj 北交所实测覆盖**，与日 K 降级源不同；返回近约 8 个交易日约 1970 行，端点只取最近一日；**成交量单位是股**，端点 ÷100 归一到手；列：day/open/high/low/close/volume/amount） |
| `ak.stock_history_dividend_detail(symbol, indicator)` | 个股分红送配明细，东财（已接入 /dividends；indicator="分红"，按公告日期倒序，列：公告日期/送股/转增/派息/进度/除权除息日/股权登记日/红股上市日——送股/转增/派息均**每 10 股**口径，派息为元、税前；日期列为 date 对象或 NaT；**无效代码返回空表不报错**，与"从未分红"无法区分；按代码缓存 6h） |
| `ak.futures_foreign_commodity_realtime(symbol)` | 新浪外盘期货实时（已接入 /overseas/summary 商品块主源，F6-4）：symbol 必须用**交易所代码列表**（XAU 伦敦金/XAG 伦敦银/GC COMEX黄金/SI COMEX白银/CL NYMEX原油/OIL 布伦特原油，全表见 `ak.futures_foreign_commodity_subscribe_exchange_symbol()`）；**传中文名会触发 AKShare 1.18.94 列数不匹配 ValueError**（实测）；列：名称/最新价/涨跌幅（**已是 % 单位**）/昨日结算价/行情时间/日期（数据源原始时间，非北京时间） |
| `ak.index_us_stock_sina(symbol)` | 新浪美股指数全量日 K（已接入 /overseas/summary 指数块降级源，F6-4）：symbol ∈ {.DJI 道指, .IXIC 纳指综合, .INX 标普500, .NDX 纳指100}；约 1s 返回 2004 年至今全量（5700+ 行），端点取最后两根收盘算涨跌幅 |
| `ak.futures_global_spot_em()` | 东财全球期货全量实时快照（已接入 /overseas/summary 商品块降级源，F6-4）：全量翻页约 32s（640 行，超时放宽 60s），取"当月连续"行（GC00Y COMEX黄金/SI00Y COMEX白银/CL00Y NYMEX原油）；列：代码/名称/最新价/涨跌幅（%）；走 push2his 翻页，push2his 限流时不可用 |
| `ak.index_global_spot_em()` | 东财全球指数（**选型放弃**，F6-4 实测）：走 push2 clist 的 `i:` 市场，2026-09-19 本机实测连接被掐（exit 56，与 IP 限流同现象），不可用 |
| `ak.stock_us_famous_spot_em(symbol)` | 东财美股知名个股（**选型放弃**，F6-4 实测）：走 69.push2.eastmoney.com 子域，2026-09-19 实测断连 |

**腾讯美股行情（直连 requests，非 AKShare，已接入 /overseas/summary 指数块主源与中概股块，F6-4）**
```
GET https://qt.gtimg.cn/q=usDJI,usIXIC,usINX        # 美股三大指数
GET https://qt.gtimg.cn/q=usBABA,usPDD,...          # 美股个股/中概股
```
- 与 A 股腾讯行情同一 GBK 文本协议、同一下标：1=名称 2=代码 3=最新价 4=昨收 30=时间
  31=涨跌额 32=涨跌幅（%）33=最高 34=最低；价格**不放大**
- **代码不带交易所后缀**（`usBABA`/`usAAPL` 正常；带 `.OQ`/`.N` 后缀反而整批返回
  `v_pv_none_match`——2026-09-19 实测，详见 PITFALLS）
- 指数时间为美东时间（如 2026-09-18 17:52:27），非北京时间
- **境外源稳定性风险提示**：腾讯美股/新浪外盘期货均为非官方公开接口，可用性无保障；
  /overseas/summary 三块独立降级 + 10 分钟缓存兜底，单块失效不影响其余块 |
| `ak.stock_board_industry_hist_em(symbol, start_date, end_date, period, adjust)` | 行业板块日 K，东财 push2his kline（secid=90.{BK代码}；已接入 /sectors/history，F6-3；**支持直传 BK 代码**跳过其内部名称→代码解析；列：日期/开盘/收盘/最高/最低/涨跌幅/涨跌额/成交量/成交额/振幅/换手率——与个股 /history 东财源列名一致，端点复用同一套归一化；按 code+days 缓存 10min。push2his 限流时无降级源，返回结构化 502） |
| `ak.stock_board_industry_name_em()` / `ak.stock_sector_fund_flow_rank(indicator, sector_type)` / `ak.stock_board_industry_cons_em(symbol)` | 行业板块涨跌排行 / 板块资金流排行 / 板块成分股（**未接入 AKShare 封装**：实测其输出丢弃成交额/领涨股代码/板块代码等必需字段，/sectors/rank、/sectors/fund-flow、/sectors/cons 按其同参数同字段直连东财 clist 实现，见上方"行业板块"节） |

**技术指标本地计算（/indicators，F5-1，2026-09-16；非外部接口，无新依赖）**

输入是与 /history 同源的前复权日 K（`_load_bars`：东财 stock_zh_a_hist → 新浪降级），
全部指标由 pandas 本地计算，响应 `source` 字段标注日 K 数据源。口径：

- **MA(N)** = 收盘价 N 日简单移动平均（N=5/10/20/60）
- **EMA(N)** = `ewm(span=N, adjust=False)`（N=12/26，为 MACD 中间量，latest 里也透出）
- **MACD**：DIF = EMA12 − EMA26；DEA = DIF 的 EMA9；**MACD柱 = 2×(DIF−DEA)**（国内软件惯例，
  比国外口径多 ×2）
- **RSI(N)**（N=6/12/24）：Wilder 平滑 `ewm(alpha=1/N, adjust=False, min_periods=N)`，
  RSI = 100×avgGain/(avgGain+avgLoss)；长期零波动分母为 0 → NaN → null
- **KDJ(9,3,3)**：RSV = (C−LLV9)/(HHV9−LLV9)×100；K = SMA(RSV,3,1) 递推平滑
  （`ewm(alpha=1/3, adjust=False)`），D = K 的同口径平滑，J = 3K−2D；
  9 日最高=最低（极端横盘）RSV → NaN
- **BOLL(20,2)**：中轨 = MA20；上/下轨 = 中轨 ± 2×20 日**总体标准差**（`std(ddof=0)`，通达信口径）
- **关键价位**：近 120 根日 K 的分形高/低点（±2 窗口局部极值）+ 区间最高/最低，
  按 3% 容差聚类取簇均值（密集多底/多顶合并为一档）；最新收盘之下最近 2 档为支撑位、
  之上最近 2 档为压力位。属客观统计口径，非预测
- **signals**：最新一根 K 线的客观状态信号——MA5/MA20 金叉死叉、MACD DIF/DEA 金叉死叉、
  收盘价站上/跌破 MA60、收盘价突破/跌破布林上下轨、RSI6 ≥80 超买 / ≤20 超卖；
  仅状态描述，**不含买卖建议**（项目红线）
- 周期不足的值一律为 null（不补 0）；数值统一 round 3 位小数；交叉验证：18 项指标
  与朴素循环参考实现逐值核对一致（2026-09-16，容差 0.01）

**K 线形态识别本地计算（/patterns，F6-1，2026-09-19；非外部接口，无新依赖）**

输入同样是 `_load_bars` 的前复权日 K（默认 750 根≈3 年），纯本地检测，响应 `source`
字段标注日 K 数据源。形态库 17 种（方向标签：看涨/看跌/中性），每个检测器的参数与阈值
写在 `data-service/main.py` 对应函数 docstring；概要：

- **背景趋势**：信号日前 5 个交易日累计涨跌幅（只用 ≤ i-1 的数据）定下跌/上涨背景
- **K 线组合**：十字星（实体≤振幅 10% 且振幅≥收盘 1%）、锤子线/上吊线（下影线≥2 倍实体、
  上影线≤0.5 倍实体、实体≥振幅 5%）、吞没（实体完全包住前一根且更大）、早晨/黄昏之星
  （首根实体≥振幅 50%、星线实体≤振幅 30% 且跳空、末根收复/跌破首根实体中点）、
  乌云盖顶/刺透（高开/低开越前高/前低，收盘过中点但未吞没）、红三兵/三只乌鸦
  （三根实体≥振幅 50% 的同向线，收盘逐级推进，后两根开盘在前一根实体内）
- **价格结构**（分形点 = ±2 窗口严格局部极值，右边界留 2 根确认防未来函数）：
  双底/双顶（60 根窗口，两极值价差 ≤3%、间隔 ≥10 根、接近窗口最低/高点（3% 容差）、
  颈线深度 ≥5%）、头肩底/顶（90 根窗口，头即窗口最低/最高点、双肩价差 ≤5%、
  颈线深度 ≥5%）、上升/下降三角形（40 根窗口，一侧最近 2~3 个分形点近似水平（≤2%），
  另一侧逐级推进）；信号日 = 收盘首次突破颈线/压力/支撑线（`c[i-1] ≤ 线 < c[i]`），
  同一形态的颈线回踩再突破各计一次信号
- **历史成绩单口径**：对每个信号日 i，统计之后第 5/10/20 个交易日的表现——
  upRatio = 上涨占比（%，收盘 i+w > 收盘 i 的比例）、avgRet = 平均涨跌幅（%，收盘对收盘）、
  avgMaxDrawdown = 平均最大回撤（%，窗口内**最低价**相对信号日收盘的跌幅均值）；
  i+w 超出数据末尾的出现**不计入**该窗口统计；窗口样本为 0 时各值为 null；
  count<5 属样本过少（前端/技能均提示）。全部为历史事实统计，不含预测
- "近期出现" = 近 60 个自然交易日内（bars 尾部 60 根）的信号日列表

**资金流验货本地计算（/verify/{code}，F6-2，2026-09-21；非新外部接口）**

输入 = F6-1 形态检测的近期信号日（近 60 个交易日）+ F3-4 资金流取数（`/fund-flow` 同源：
东财 `stock_individual_fund_flow` 五档主源 → 新浪 MoneyFlow 两档降级，响应带
barSource/flowSource 双标注）。**口径为日级资金流**——分笔 tick（如
`ak.stock_intraday_em`）未接入（稳定性未实测，验货场景日级已够），"尾盘变化"维度缺失。
分档规则（透明客观阈值，与 FEATURES 第 36 节同步）：

- **验货窗口**：信号日起往后最多 3 个有资金流数据的交易日
- **取值**：窗口内主力净流入（新浪降级源为"净流入"，口径含全部资金，文案随 source 切换）
  非 null 的日值；记 pos=为正日数、neg=为负日数、total=合计额（0 值不计入 pos/neg）
- **watch（重点观察）**：total 与形态方向同号 且 同向日数 > 反向日数（资金流印证形态）
- **doubt（存疑）**：total 与形态方向反号 且 反向日数 > 同向日数（资金流背离形态）
- **neutral（中性）**：其余——正负交错 / 有效值为 0 个 / 信号日未被资金流覆盖
  （资金流源仅含近期约 100 个交易日）/ 中性形态（十字星）无方向可比
- 三档结论只描述资金流与形态方向的客观一致性，**不含买卖建议**；响应带 disclaimer
- 无近期信号时不拉资金流直接返回空列表（flowSource=null）；按 (code, days) 缓存 1h

**baostock（已接入：本地全市场日 K 库的批量数据源，F5-5，2026-09-21）**

```
bs.login() → bs.query_history_k_data_plus("sh.600519",
    "date,open,high,low,close,volume,amount,turn,pctChg",
    start_date, end_date, frequency="d", adjustflag="2") → bs.logout()
```
- 免费 socket 会话服务，专为批量历史日 K 设计，无东财式 IP 限流——选它做全市场批量的
  原因：东财 push2his 有一分钟约 10 次请求即封 IP 数小时的前科（见 PITFALLS）
- **字段口径**：前复权（adjustflag='2'）；volume 单位是**股**（端点 ÷100 归一到手，
  与新浪源同一换算，2026-09-21 实测 600519 = 1376172 股 ≈ 东财 13762 手）；
  amount 元直存；pctChg→change_pct（%）；turn→turnover（%，停牌票为空存 NULL）；
  停牌日行照常返回（volume=0）
- **不覆盖北交所**（4/8/920），票池直接排除；扫描范围 = 沪深 A 股（约 5200 只）
- 当日日 K 盘后约 17:00-18:00 才齐：更新器内建"数据未齐"等待重试（30 分钟间隔，
  北京时间 21:00 封顶）
- 已知坑（详见 PITFALLS 2026-09-21 baostock 条目）：长窗口查询约 5-6s/票
  （首次全量回填数小时，断点续跑）；socket 死亡后每票静默报"网络接收错误"，
  须熔断重连；同账号并发会话互相挂起

**全市场扫描本地计算（/scan，F5-5，2026-09-21；非外部接口）**

输入 = 本地日 K 库（baostock 前复权，SQLite `data-service/data/market_bars.db`）中
全部股票最近 150 根 bar，pivot 成宽表（index=date × columns=code）后**整帧向量化**
计算指标——口径与"技术指标本地计算"节（/indicators，F5-1）逐条一致，唯一差异是
窗口长度（扫描 150 根 vs /indicators 默认 250 根），EMA 类指标在窗口前段有收敛差异、
最后一行可忽略（合成数据对拍验证，容差 5e-4 含 round(3) 舍入）。7 个预设策略的
阈值口径写在 `/scan/strategies` 端点返回的 description（单一事实源），
实现见 `data-service/main.py` 全市场扫描节。结果缓存键含数据 asOf（盘后更新完成
即自然失效）。ST/退市股默认剔除（名称表不可用时降级为不剔除并在 note 注明）。

**新浪 MoneyFlow（直连 requests，非 AKShare，已接入 /fund-flow 降级源）**
```
GET https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=100&sort=opendate&asc=0&daima=sh600519
```
- GBK 编码 JSON 数组，按日期倒序；字段：opendate 日期 / trade 收盘价 / changeratio 涨跌幅 /
  netamount 净流入（元）/ ratioamount 净流入占比 / r0_net 超大单净流入 / r0_ratio 超大单占比
  —— **changeratio/ratioamount/r0_ratio 是小数**（-0.0738 = -7.38%），端点 ×100 转百分数
- 口径与东财不同：新浪"净流入"含全部资金 ≠ 东财"主力净流入"，r0 超大单口径也不同——
  响应带 source 字段供前端标注，两源数值不可直接对比
- 不覆盖北交所（4/8/920）

AKShare 文档：https://akshare.akfamily.xyz/

## 备用/付费选项

- Tushare（积分制，数据规整）：https://tushare.pro
- 聚宽 / Wind / iFinD：商业化后再考虑

## 合规红线

免费接口的 TOS 通常禁止商业转售数据。本项目定位为个人自用工具；
如果未来商业化，必须采购授权数据源（Wind/iFinD/交易所信息服务商）。
