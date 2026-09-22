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
| `GET /patterns/{code}?days=750` | K 线形态识别 + 历史成绩单（F6-1，纯本地计算，与 /history 同源前复权日 K）：17 种经典形态（11 种 K 线组合 + 6 种价格结构，检测无未来函数），按形态聚合 {name/direction/count/recentDates(近 60 交易日)/stats}；stats 为信号日后 5/10/20 日的上涨占比/平均涨跌幅（收盘口径）/平均最大回撤（窗口内最低价口径），窗口不完整不计入；响应带 disclaimer（历史事实统计口径，不构成投资建议）；days 范围 30~1500，按 (code,days) 缓存 6h |
| `GET /verify/{code}?days=750` | 资金流验货（F6-2：近期形态信号 × 资金流交叉验证）：对近 60 个交易日的形态信号，取信号日起最多 3 个有资金流数据的交易日的主力净流入（复用 /fund-flow 取数与降级链，新浪降级源为"净流入"口径）做方向比对，输出三档结论（watch 重点观察 / doubt 存疑 / neutral 中性，透明阈值规则见 docs/FEATURES.md 第 36 节）+ 客观依据；日级口径（分笔 tick 未接入）；无近期信号时 signals 为空且 flowSource=null；响应带 disclaimer；按 (code,days) 缓存 1h |
| `GET /trade-calendar?year=` | 交易日历（新浪，用于跳过法定节假日） |
| `GET /funds/rank?type=&limit=` | 开放式基金排行（天天基金，按近1年收益率降序；type 白名单：全部/股票型/混合型/债券型/指数型/QDII/FOF；按类型缓存 10 分钟） |
| `GET /funds/search?keyword=` | 基金搜索（全量代码表缓存 24h，支持名称/代码/拼音缩写） |
| `GET /funds/etf?limit=` | 场内 ETF 实时行情榜（东财全量快照，翻页 30s+ 故超时 120s + 缓存 60s） |
| `GET /funds/{code}?days=` | 单只基金详情 + 单位净值走势（按代码缓存 6h；须声明在 rank/search/etf 之后） |
| `GET /market-news?limit=20` | 全市场财经快讯（东财全球快讯主源、财联社降级，缓存 90s，上限 50 条） |
| `GET /overseas/summary` | 隔夜外盘参考信息汇总（F6-4）：美股三大指数（腾讯 usDJI/usIXIC/usINX 主源、新浪日 K 降级）、中概股与美股热门篮子（腾讯）、国际金银原油（新浪外盘期货主源、东财全球期货当月连续降级）。每块独立降级（失败块带 error 字段、其余照返），整体缓存 10 分钟；时间字段为数据源原始时间（美股为美东时间） |
| `GET /sectors/rank?limit=` | 行业板块涨跌排行（东财 clist 直连，push2 限流自动降级 push2delay 延时镜像、响应带 source 标注；涨跌幅降序，含成交额/上涨下跌家数/领涨股，缓存 60s） |
| `GET /sectors/fund-flow?limit=` | 行业板块资金流排行（今日主力净流入降序，五档净流入+净占比+最大净流入个股，缓存 60s） |
| `GET /sectors/cons?name=&limit=` | 板块成分股（涨跌幅降序；name 支持板块名称或 BK 代码，未知名称 404；按板块缓存 10min） |
| `GET /sectors/history?name=&days=` | 板块日 K 走势（AKShare stock_board_industry_hist_em，BK 代码直传；bars 结构与 /history 一致；按 code+days 缓存 10min；push2his 限流时返回结构化 502） |
| `GET /sectors/of-stock/{code}` | 个股→板块共振：所属行业（复用 /profile）在当日板块涨跌/资金流排行中的名次；行业缺失或无同名板块返回 `matched=false` 而非报错 |
| `POST /market-bars/update?full=` | 触发本地日 K 库更新（F5-5，后台异步）：腾讯 fqkline 主源 + baostock 兜底（双源）前复权日 K 批量落 SQLite `data/market_bars.db`（WAL，约 640-750 交易日窗口，仅沪深约 5200 只）；断点续跑 + 失败票名单 + 断线熔断重连 + 盘后数据未齐 30 分钟重试至 21:00；单飞行（进行中 409）；首次全量回填约 1.5 小时（腾讯源），日常增量约 10 分钟 |
| `GET /market-bars/status` | 日 K 库状态：running/phase/done/total/failedCount + coverage/lastBarDate/dbSizeMb |
| `GET /scan/strategies` | 预设扫描策略清单（F5-5，7 个：ma_bull/macd_gold/rsi_oversold/vol_break_20d/pullback_ma20/boll_lower/ma_cross_up），口径描述的一源共用 |
| `GET /scan?strategy=&limit=50` | 全市场选股扫描（F5-5）：本地日 K 库宽表向量化计算（指标口径与 /indicators 一致），返回 {asOf/stale/total/items[code/name/close/changePct/extra]/disclaimer}；ST/退默认剔除；库为空 503、未知策略 400；结果缓存随数据 asOf 失效 |
| `GET /backtest/{code}?strategy=&hold_days=20&stop_loss_pct=7&days=750` | 单股策略回测（F5-6）：本地日 K 库历史信号回放，7 个预设策略与 /scan 同 key 同口径；真实 A 股规则（T+1、整手、佣金万 2.5 最低 5 元、印花税 0.05%、滑点 0.1%、止损/持有期白名单），返回 {params/rules/stats/trades/equityCurve/disclaimer}；北交所 400、库中无票 404、bar<90 回 422、库空 503 |

**选股扫描（F5-5）与策略回测（F5-6）使用前提**：先启动本服务，再触发一次回填
（`curl -X POST http://127.0.0.1:8000/market-bars/update`，首次数小时、断点续跑可中断）；
主服务默认每个交易日 15:40 自动触发增量更新（`SCANNER_AUTO_UPDATE=false` 关闭）。
库文件位于 `data-service/data/market_bars.db`（已 gitignore，约 300-500MB，删除后需重新回填）。

## 注意

- AKShare 本质是各财经网站接口的封装，接口失效时升级 `akshare` 版本通常能修复：
  `pip install -U akshare`
- 仅在本地（127.0.0.1）监听即可，不要暴露到公网。
