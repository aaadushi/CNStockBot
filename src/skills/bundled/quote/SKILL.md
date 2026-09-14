# get_stock_quote

查询单只 A 股实时行情。

## 何时触发
- "茅台现在多少钱" / "600519 行情" / "平安银行涨了吗"

## 参数
- `code`（必填）：6 位股票代码。若用户只说名称，先调 search_stock 技能解析代码（SYSTEM_PROMPT 已引导该流程）。

## 数据来源
默认走东方财富公开接口（`src/data/eastmoney.ts`），免 key、实时。
