# scan_market

全市场选股扫描（F5-5）：基于本地日 K 库（baostock 前复权日 K，每日盘后增量更新，
仅沪深 A 股、不含北交所）跑预设策略的客观指标筛选，返回命中股票名单（代码/名称/
收盘/涨跌幅/触发条件的具体数值）。

## 何时触发
- "帮我扫描一下全市场 MACD 金叉的股票" / "现在有哪些股票 RSI 超卖" / "选股/筛股/全市场扫描"
- 与 get_stock_patterns 的分工：本技能是全市场多股票筛选；单只股票的形态/技术分析用
  get_stock_patterns 或 analyze_stock。

## 参数
- `strategy`（必填）：预设策略 key，七选一：
  - `ma_bull` MA 多头排列（收盘＞MA5＞MA10＞MA20＞MA60）
  - `macd_gold` MACD 金叉（DIF 当日上穿 DEA）
  - `rsi_oversold` RSI 超卖（RSI6 ≤ 20）
  - `vol_break_20d` 放量突破 20 日新高（收盘突破前 20 日最高且量＞2 倍 20 日均量）
  - `pullback_ma20` 缩量回踩 MA20（收盘距 MA20 ±2% 且缩量且 MA20 向上）
  - `boll_lower` 触及布林下轨（收盘低于 BOLL 下轨）
  - `ma_cross_up` MA5 金叉 MA20
- 用户用中文描述条件时映射到最近的 key；没有对应的预设策略时如实告知可选清单，
  不要编造条件。

## 数据来源
Python data-service `GET /scan?strategy=&limit=`：本地日 K 库（SQLite，宽表向量化计算，
秒级）；结果为盘后数据（响应带 asOf 数据截至日期，stale=true 表示非最新交易日）。
微服务未启动或日 K 库为空时返回带引导的错误文本。

## 红线
返回的是**客观指标条件在历史数据上的命中名单**，不是推荐。转述时必须保留
"数据截至日期 + 客观筛选口径 + 免责声明"，不得表述为推荐买入、"值得关注"式暗示
或涨跌预测。
