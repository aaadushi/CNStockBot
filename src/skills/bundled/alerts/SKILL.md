# manage_alerts

管理用户的个股监控规则（F5-4 多条件监控提醒）：价格上下限 / 涨跌幅阈值，
可多条件 AND/OR 组合；盘中交易时段轮询触发后主动推送，同一条件每天只提醒一次。

## 何时触发
- "茅台涨到 1500 提醒我"（add：price_above 1500）
- "比亚迪跌破 80 或者涨跌幅超过 3% 就告诉我"（add：两个条件 + combinator=any）
- "宁德跌破 280 并且跌幅超 2% 才提醒"（add：combinator=all）
- "我设了哪些提醒"（list）/ "把 3 号提醒删了"（remove：ruleId=3）
- "先别提醒我了"（disable）/ "恢复提醒"（enable）

## 注意
- 与全局异动提醒（ALERT_THRESHOLD_PCT，默认 ±5%，对全部自选股生效）互补：
  本技能是用户按个股自定义的规则，股票**不需要在自选股里**。
- add 时会先验证股票代码存在（停牌股走搜索降级验证，与 manage_watchlist 一致）。
- 条件类型仅三种：price_above（涨到≥）/ price_below（跌到≤）/ change_pct（涨跌幅绝对值≥%）。
  指标信号类提醒（金叉/超买等）盘中日 K 不变，已由收盘日报的技术面信号摘要覆盖。
- 规则存 SQLite `alert_rules` 表，按 userId 隔离；每用户上限 20 条，每条最多 5 个条件。
- 盘中轮询沿用全局 `ALERT_INTERVAL_MINUTES` 频率与交易日历；`ALERT_ENABLED=false` 时
  全局阈值与自定义规则都不轮询。
