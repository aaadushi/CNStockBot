# 东财接口真实响应 fixture（S2-4）

用途：回放测试验证解析逻辑对**真实接口响应结构**的兼容性
（手写 mock 可能和真实字段脱节）。

| 文件 | 来源 |
|---|---|
| `quote-600519.json` | 2026-09-15 重录：`GET https://push2delay.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f43,f44,f45,f46,f57,f58,f60,f170,f86,f116,f117,f162,f163,f164,f167`（带 Referer 头）。**用 push2delay 是因为当日 push2 对本机 IP 限流未解除**；两者响应结构同构（延时行情，数值是延时的不影响解析验证）。首录于 2026-09-14（push2，仅旧字段） |
| `suggest-maotai.json` | `GET https://searchapi.eastmoney.com/api/suggest/get?input=茅台&type=14&count=10`（带 Referer 头），2026-09-14 录制 |

重新录制：用 curl 带 `Referer: https://quote.eastmoney.com/` 请求上述 URL 覆盖对应文件即可
（push2 可用时优先用 push2，fields 参数保持一致）。
注意：**短时间内高频请求 push2 会触发东财 IP 级断连限流**（连接被直接掐断，curl 报 exit 56），
录制时请求间隔至少几秒；被限流后等几分钟自动恢复（也可能持续十几个小时，2026-09-14 实测）。
