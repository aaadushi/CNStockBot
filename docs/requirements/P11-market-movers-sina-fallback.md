# REQ-P11：涨跌榜（/market）引入新浪异源降级源

> 需求文档（2026-10-10 建立）。本文档是 P11 实现、验收、审计的基准。
> 关联登记：[STATUS.md](../STATUS.md) P11（东财 IP 封禁期间涨跌榜完全无数据）。

## 背景与目标

东财对本机 IP 的限流/封禁是周期性外部事件（已发生 3+ 次，持续数小时到一天）。
期间行情（腾讯）/日K（新浪）/资金流（新浪）/新闻（AKShare）均有非同 IP 异源托底，
唯独**涨跌榜**（`/api/market/movers`，前端 /market 页）的降级链只有
push2 → push2delay 两个**同 IP** 宿主，双挂期间该页完全空白。

**目标**：为涨跌榜引入第三降级源——新浪财经行情中心排行接口
（`vip.stock.finance.sina.com.cn`，与东财不同 IP 宿主，实测可用），
东财双宿主全挂时 /market 页仍有数据可看。

## 范围

### 做

1. 新增 `src/data/sinaMovers.ts`：封装新浪 `Market_Center.getHQNodeData` 排行接口
   （node=hs_a，沪深京全市场，含北交所，与东财 CLIST_FS 口径一致）：
   - 涨幅榜：`sort=changepercent&asc=0` 首页前 limit 条（过滤 trade<=0 的停牌行）；
   - 跌幅榜：`asc=1` 首页前 limit 条，仅保留 changepercent<0；
   - 平盘榜 + 涨跌平家数：新浪无现成家数接口，改用**边界二分**——
     榜单按 changepercent 有序，二分定位"首个 changepercent<=0"（=上涨家数）与
     "首个 changepercent<0"（=下跌起点），平盘家数 = 两者之间；
     平盘榜从上涨边界起向后扫描收集 changepercent 恰为 0 的条目，凑满 limit 或
     扫满 3 页即停（与东财平盘定位同策略）。单页上限 100 行（实测 num>100 截断）。
2. `EastmoneyProvider.getMovers` 降级链扩展为 **push2 → push2delay → 新浪**，
   缓存 60s 逻辑不变；新浪结果标注 `source: 'sina'`。
3. `MarketMovers` 类型新增可选字段 `source?: string`（降级源标识）；
   /market 前端数据时间旁对 `source==='sina'` 追加"（新浪降级源）"提示。
4. 单测：sinaMovers 解析/二分边界/停牌过滤 + getMovers 三级降级链。

### 不做（明确排除）

- **不修 P12**（/sectors 整页、/funds ETF Tab 的东财封禁降级）——同属 clist 依赖
  但页面与数据形态不同，本需求不覆盖，仍登记在 STATUS P12。
- 不做涨跌家数的跨源精确对齐：新浪口径下停牌股（trade=0）若混在零区会计入平盘家数，
  与东财 ulist（不含停牌）存在口径差，属降级模式可接受误差，只文档化不对齐。
- 不替换东财主源：新浪仅为降级链最后一级，正常情况仍走东财实时数据。
- 不改动 /market 页布局与交互，仅追加降级源提示文案。
- 不引入新浪作为行情/新闻等其他数据的降级源（现有链路已有托底）。

## 功能需求

| # | 需求 |
|---|---|
| FR-1 | 东财 push2、push2delay 均失败时，`getMovers` 自动降级新浪接口并正常返回三榜 + 家数 |
| FR-2 | 新浪降级结果带 `source: 'sina'` 标识；前端数据时间旁展示"（新浪降级源）" |
| FR-3 | 新浪榜单条目代码为 6 位数字代码（剥离 sh/sz/bj 前缀），价格取 trade 字段（字符串→数值） |
| FR-4 | 停牌行（trade<=0）不进入任何榜单；涨跌幅取 changepercent（浮点，不缩放） |
| FR-5 | 家数二分边界精确：upCount=首个 pct<=0 的下标、downCount=total−首个 pct<0 下标、flatCount=差值（排序保证 >0/=0/<0 分段，无并列歧义） |
| FR-6 | 三个源全挂时 getMovers 仍抛错（带最后错误信息），前端维持现有错误态 |
| FR-7 | 60s 进程内缓存对三级链统一生效，降级成功后同样缓存 |

## 非功能需求

- 降级路径请求数可控：榜单首页 2 次 + 边界二分 ≤6 次/边界 + 平盘扫描 ≤3 次，
  全部只在东财双挂时触发；二分与首页请求可并行。
- 新浪接口请求带 10s 超时（与东财一致），不拖住 HTTP 链路。
- 不新增环境变量、不新增端点、不新增启动前置条件。

## 数据模型 / API / 前端改动

- `src/data/provider.ts`：`MarketMovers` 增加 `source?: string`（注释说明降级源标识）。
- `src/data/sinaMovers.ts`（新）：`fetchSinaMovers(limit): Promise<MarketMovers>`。
- `src/data/eastmoney.ts`：`getMovers` 宿主循环追加新浪降级级。
- `public/market/index.html`：`renderOverview` 数据时间文案追加降级源提示。
- `tests/movers-sina.test.ts`（新）+ `tests/movers.test.ts` 补三级降级链用例。

## 验收标准

1. `npm run typecheck`、`npm test` 全绿。
2. 单测覆盖：新浪解析（前缀剥离/停牌过滤）、二分家数边界（合成市场精确值）、
   平盘扫描不误收、push2+push2delay 双挂时自动走新浪并带 source 标识、
   三源全挂抛错、60s 缓存生效。
3. 现有 movers 测试不回退（东财主链行为不变）。
4. （解封期可选实测）`curl /api/market/movers` 正常返回且不带 source 标识。

## 审计要点

- 降级链顺序不可变：新浪只在东财双宿主失败后触发，不得提前/并行请求新浪
  （避免正常情况双倍外部请求）。
- 家数二分不得用"页首元素符号"近似——必须数清边界页内 >0 的条目数。
- 停牌过滤在三个榜单（up/down/flat）都要生效，不得只过滤榜单不过滤平盘。
- 缓存不得跨源污染：一次降级成功后 60s 内直接返回缓存（含 source 标识）。
- 新浪字段（trade 为字符串、changepercent 为浮点）解析口径以本文档为准，
  不得按东财 ×100 缩放处理。
