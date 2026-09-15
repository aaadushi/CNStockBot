# get_market_news

查询全市场财经快讯（7×24 滚动资讯流：宏观、政策、外围市场、行业动态等）。

## 何时触发
- "最近有什么财经新闻" / "今天有什么市场快讯" / "有什么宏观消息"
- 不带具体股票的全市场/宏观资讯询问

## 何时不用
- 问**某只股票**的新闻/消息 → 用 `get_stock_news`（需要 6 位代码）
- 交易所正式公告 → 用 `get_stock_announcements`

## 参数
- `limit`（可选）：返回条数，默认 10，最多 30。

## 数据来源
走 Python 数据微服务 `/market-news`（AKShare `stock_info_global_em` 东财全球财经快讯，
失败自动降级财联社 `stock_info_global_cls`），需先启动 `data-service/`。
未启动时技能会返回明确的错误提示，LLM 应据此告知用户。
微服务侧进程内缓存 90s，同一分钟内多次调用不会重复打上游。
