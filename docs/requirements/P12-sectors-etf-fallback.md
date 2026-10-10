# REQ-P12：/sectors 整页与 /funds ETF Tab 引入异源降级（腾讯板块 + 新浪 ETF）

> 需求文档（2026-10-10 建立）。本文档是 P12 实现、验收、审计的基准。
> 关联登记：[STATUS.md](../STATUS.md) P12（东财封禁期间 /sectors 整页与 /funds ETF Tab
> 无数据）。前作：[REQ-P11](P11-market-movers-sina-fallback.md)（/market 涨跌榜新浪降级）。

## 背景与目标

东财对本机 IP 的封禁是周期性外部事件。封禁期间：

- /sectors 板块页全部端点（rank / fund-flow / cons / history，均直连东财 clist
  或 push2his）返回 502/500，**整页无数据**；
- /funds 页的排行/搜索/净值走天天基金不受影响，但 **ETF Tab**
  （AKShare `fund_etf_spot_em` 同走东财宿主）同样 502。

2026-10-10 实测确认两个非同 IP 异源可用：

- **腾讯**（`proxy.finance.qq.com` / `web.ifzq.gtimg.cn`，与东财不同 IP）：
  - `cgi/cgi-bin/rank/pt/getRank?board_type=hy2` 板块排行（申万二级 124 个，
    `count=200` 一次全量，字段含涨跌幅/成交额/主力净流入/领涨股/涨家数）；
  - `cgi/cgi-bin/rank/hs/getBoardRankList?board_code=pt…` 板块成分股（翻页）；
  - `web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=pt…,day,,,N,qfq` 板块日 K。
  注意：`board_type=hy1` 实测首次返回数据后持续返回空列表（code 0），
  `board_type=hy`（31 个申万一级）与 `hy2` 稳定——**选定 hy2**，接口必须带
  `Referer: https://stockapp.finance.qq.com/`。
- **新浪**（`vip.stock.finance.sina.com.cn`，P11 已接入）：行情中心
  `Market_Center.getHQNodeData` node=`etf_hq_fund` 场内 ETF 行情
  （`sort=changepercent&asc=0`，单页上限 100 行，num>100 截断，需翻页）。

**目标**：东财宿主全挂期间，/sectors 页恢复"排行 + 资金流 + 成分股 + 走势图"
四块可用数据，/funds ETF Tab 恢复榜单；降级结果带 source 标识，前端明确提示
口径差异。

## 范围

### 做

1. data-service 新增腾讯板块降级封装（`_tx_board_rank` 等，纯函数 + 缓存）：
   - `/sectors/rank` 降级：东财 `_load_sector_rank` 失败 → 腾讯 hy2 全量，
     按 zdf（涨跌幅）排序，source=`tencent`；
   - `/sectors/fund-flow` 降级：同一腾讯缓存客户端按 zljlr（主力净流入）降序，
     source=`tencent`；mainNetInflow=zljlr×10000（万元→元，与东财"元"口径一致）；
   - `/sectors/cons` 降级：名称经降级排行表解析为 pt 代码后走 getBoardRankList
     翻页（count=100/页）；
   - `/sectors/history` 降级：pt 代码走 fqkline（日 K 数组
     `[date,open,close,high,low,volume]`，changePct 收盘环比自算，volume 单位
     手与东财一致，无成交额/换手率字段）。
2. `/funds/etf` 降级：东财 AKShare 失败 → 新浪 etf_hq_fund 翻页
   （num=100/页，至多翻 5 页），字段映射 EtfQuote：
   price=trade、changePct=changepercent、change=pricechange、
   volume=volume÷100（新浪单位"份"→东财口径"手"，2026-10-10 实测核对）、
   amount=amount（元）、turnover=turnoverratio、iopv/discountRate=null、
   time=ticktime。
3. `/funds/etf` 响应结构由裸数组改为 `{source, items}`（source=
   `eastmoney`/`sina`），主服务与前端同步适配。
4. `SectorSource` 类型扩展 `'tencent'`；前端 /sectors `sourceNote` 对
   tencent 显示"（腾讯降级源·申万二级行业，口径与东财行业不同）"；
   /funds ETF Tab 对 source=`sina` 在列表注脚追加"（新浪降级源）"。
5. 单测：Node 侧 funds ETF 新响应结构用例；腾讯板块解析/映射（Node 侧无法
   覆盖 Python，Python 侧以 `py_compile` + 真实接口实测为准）。

### 不做（明确排除）

- **/sectors/of-stock 不做降级**：其依赖 /profile（东财口径行业归属），
  封禁期该端点维持 502/未匹配，属现状，不在本需求范围。
- 不做板块资金流分档（超大单/大单/中单/小单）与主力净占比的跨源对齐：
  腾讯只有主力净流入总额，分档字段与 mainNetInflowPct 降级时置 null
  （前端已容错）。
- 不做涨/跌家数的跨源精确对齐：腾讯 zgb 给"上涨家数/总家数"，无平盘拆分，
  降级时 downCount 置 null、upCount 取 zgb 上涨数（文档化口径差）。
- 不用腾讯板块数据替换东财主源；不做封禁探测/自动切换 UI，降级只在
  东财请求失败后触发。
- 不改 /sectors、/funds 页面布局与交互，仅追加降级源提示文案。
- 不引入新环境变量、新端点、新启动前置条件。

## 功能需求

| # | 需求 |
|---|---|
| FR-1 | 东财 clist/push2his 失败时，/sectors/rank、/sectors/fund-flow、/sectors/cons、/sectors/history 自动降级腾讯并返回 source=`tencent` 的结构化数据 |
| FR-2 | 降级仅在东财失败后触发：正常情况不得提前/并行请求腾讯（避免双倍外部请求）；60s 排行/资金流缓存与 10min 成分/历史缓存对降级结果同样生效 |
| FR-3 | /sectors/fund-flow 降级按 zljlr 降序，mainNetInflow 单位为元（×10000） |
| FR-4 | /sectors/cons 降级支持翻页拉全成分股；code 剥离 sh/sz/bj 前缀为 6 位数字 |
| FR-5 | /sectors/history 降级返回日期升序尾部 days 条，changePct 由收盘环比自算，volume 单位为手 |
| FR-6 | 东财与腾讯都失败时各端点仍返回 502（带最后错误信息），前端维持现有错误态 |
| FR-7 | /funds/etf 东财失败时降级新浪并返回 source=`sina`；volume ÷100 归一到"手"；涨跌幅降序 |
| FR-8 | /funds/etf 正常时 source=`eastmoney`，主服务与前端对新结构兼容 |
| FR-9 | 前端对 source=`tencent`/`sina` 展示降级源提示文案 |

## 非功能需求

- 降级路径请求数可控：板块排行/资金流共享一次 getRank（全量 124 条，缓存
  60s）；成分股每板块翻页 ≤5 页（缓存 10min）；板块日 K 每次 1 请求
  （缓存 10min）；ETF 新浪翻页 ≤5 页（缓存 60s）。全部只在东财失败后触发。
- 腾讯接口带 10s 超时与 `Referer` 头；新浪接口带 10s 超时。
- 不新增环境变量、不新增端点、不新增启动前置条件。

## 数据模型 / API / 前端改动

- data-service/main.py：新增腾讯板块降级函数；`/sectors/rank`、`/sectors/
  fund-flow`、`/sectors/cons`、`/sectors/history` 加降级级；`/funds/etf`
  加新浪降级级且响应改 `{source, items}`。
- src/data/provider.ts：`SectorSource` 增加 `'tencent'`；新增
  `EtfRank { source: string; items: EtfQuote[] }`；`getEtfRank` 返回
  `Promise<EtfRank>`。
- src/data/pythonService.ts、src/data/index.ts：getEtfRank 类型同步。
- src/channels/webchat.ts：`/api/funds/etf` 直接透传 `{source, items}`。
- public/sectors/index.html：`sourceNote` 增加 tencent 分支。
- public/funds/index.html：ETF Tab 注脚追加新浪降级源提示。
- tests/funds.test.ts：getEtfRank 新结构断言。

## 验收标准

1. `npm run typecheck`、`npm test` 全绿；`python -m py_compile
   data-service/main.py` 通过。
2. 单测覆盖：ETF 新响应结构透传。
3. 真实接口实测（本机当前东财未封禁，降级链用临时断host/直接调用降级函数
   验证）：腾讯 hy2 排行/成分/日 K、新浪 ETF 翻页字段映射正确。
4. 现有 sectors/funds 测试不回退（东财主链行为不变）。

## 审计要点

- 降级链顺序不可变：腾讯/新浪只在东财失败后触发，不得提前/并行请求。
- 腾讯字段单位必须换算：zljlr/turnover 为万元、zsz/ltsz 为亿元、新浪 ETF
  volume 为份——不得直接当元/手使用。
- fund-flow 降级排序必须按 zljlr 数值降序，不得依赖 getRank 返回顺序
  （返回顺序是涨跌幅序）。
- 降级结果必须带 source 标识，不得静默混源。
- cons/history 的名称解析在降级模式下走腾讯排行表（pt 代码），BK 代码在
  降级模式下无法解析时应返回结构化错误而非张冠李戴。
