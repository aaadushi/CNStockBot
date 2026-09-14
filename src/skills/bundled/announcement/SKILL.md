# get_stock_announcements

查询个股的交易所正式公告（年报、分红、减持、停牌等披露文件）。

## 何时触发
- "茅台最近发了什么公告" / "300750 有没有新公告/披露"
- 用户问"消息/新闻"时用 get_stock_news，不要混用

## 数据来源
走 Python 数据微服务（AKShare 的 `stock_zh_a_disclosure_report_cninfo`，巨潮资讯网），
需先启动 `data-service/`。默认查近 30 天，未启动时技能会返回明确的错误提示，LLM 应据此告知用户。
