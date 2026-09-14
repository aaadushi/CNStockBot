# get_stock_news

查询个股最新新闻与媒体报道（交易所正式公告用 get_stock_announcements）。

## 何时触发
- "茅台最近有什么新闻" / "帮我看看 300750 的消息面"

## 数据来源
走 Python 数据微服务（AKShare 的 `stock_news_em`），需先启动 `data-service/`。
未启动时技能会返回明确的错误提示，LLM 应据此告知用户。
