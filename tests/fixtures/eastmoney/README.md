# 东财接口真实响应 fixture（S2-4）

录制日期：2026-09-14。用途：回放测试验证解析逻辑对**真实接口响应结构**的兼容性
（手写 mock 可能和真实字段脱节）。

| 文件 | 来源 |
|---|---|
| `quote-600519.json` | `GET https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f43,f57,f58,f60,f170,f86`（带 Referer 头） |
| `suggest-maotai.json` | `GET https://searchapi.eastmoney.com/api/suggest/get?input=茅台&type=14&count=10`（带 Referer 头） |
| `clist-gainers-5.json` | 2026-09-15 录：`GET https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f12,f14,f2,f3`（涨幅榜首页；当日 push2 限流，用同构延时宿主录制） |
| `ulist-mover-counts.json` | 2026-09-15 录：`GET https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001,0.899050&fields=f104,f105,f106`（沪深京涨跌平家数） |

重新录制：用 curl 带 `Referer: https://quote.eastmoney.com/` 请求上述 URL 覆盖对应文件即可。
注意：**短时间内高频请求 push2 会触发东财 IP 级断连限流**（连接被直接掐断，curl 报 exit 56），
录制时请求间隔至少几秒；被限流后等几分钟自动恢复。
