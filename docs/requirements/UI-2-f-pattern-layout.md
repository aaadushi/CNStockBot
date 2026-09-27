# 需求文档：UI-2 全站布局改造为 F 型布局（F-Pattern Layout）

> **文档编号**：REQ-UI-2
> **对应路线**：非路线图功能，全站布局风格改造（2026-09-27 用户指定，同分支
> `feat/ui-soft-ui-style` 上接续 UI-1 执行）
> **目标读者**：实现 agent / 代码审查 agent / 后续维护者
> **状态**：已实现（2026-09-27）

---

## 1. 背景与目标

### 1.1 背景

UI-1（REQ-UI-1）已完成全站视觉 token 改造为 Soft UI。用户随后指定布局改为
**F 型布局（F-Pattern Layout）**：基于眼动追踪的 F 形扫描路径——顶部第一条
水平线放最重要内容，左侧垂直线放主内容，文字左对齐、层级清晰、可扫描。

### 1.2 风格冲突仲裁（用户 2026-09-27 拍板）

F 型布局 kit 与 Soft UI kit 的视觉 token 存在直接冲突：

| 冲突项 | F 型布局要求 | Soft UI 要求 | 仲裁 |
|---|---|---|---|
| 圆角 | 禁止 rounded-2xl/3xl，用 rounded-lg | 必须 rounded-2xl/3xl | **Soft UI 优先** |
| 阴影 | shadow-sm/md | shadow-lg/xl 彩色柔影 | **Soft UI 优先** |
| 边框 | 必须有 border-gray-200 | 禁止硬边框 | **Soft UI 优先**（表格细分隔线豁免沿用） |
| 悬停 | translate-x-1 / 下划线 | 上浮 + 柔影扩散 | **Soft UI 优先**（列表标题色偏已覆盖"扫描锁定"诉求） |
| **布局/层级/对齐/响应式** | 顶部优先、左对齐、标题层级、可扫描、max-w-prose | 无相关规定 | **F 型布局规则生效** |

即：**布局与信息层级按 F 型布局，视觉表现维持 Soft UI**。

### 1.3 目标

- 最重要的内容在页面顶部与左上；每页有清晰 h1 > h2 > h3 层级；
- 列表页可快速扫描；长文本行宽受限（max-w-prose ≈ 65-75 字符）；
- 桌面端内容页主内容居左、辅助信息成侧栏；手机端单列堆叠；
- 响应式三档：桌面（主+侧栏）/ 平板（全宽主内容）/ 手机（单列）。

### 1.4 非目标（本需求明确不做）

- 不改动视觉 token（圆角/阴影/边框维持 Soft UI，见 §1.2 仲裁表）；
- 不新增功能/接口/数据：侧栏只搬移**已有**内容，不捏造新内容；
- 不改 JS 数据链路；页面结构只做容器级重排（div 包裹与 class 调整）；
- 不强制所有页面都有物理侧栏——无足够辅助内容的页面用"全宽 + 顶部优先"
  的 F 骨架即可；
- webchat 聊天页为对话式 UI，F 型扫描模型不适用，仅做标题层级处理。

---

## 2. 页面清单与布局方案

| 页面 | 方案 |
|---|---|
| theme.css | 新增 `.page-wide`（max-width 1080px）、`.page-title`（h1 样式）、`.prose`（max-width 42em 限行长）、`.layout-main`/`.layout-aside`（桌面两栏，平板/手机堆叠） |
| /market | 全宽列表页：`.page`→`.page-wide`，顶部总览（已有）→ 榜单列表，行内 hover 扫描反馈沿用现有 |
| /news | 全宽列表页：`.page-wide`，每条快讯摘要 `.prose` 限行长 |
| /stocks 列表 | 全宽列表页：`.page-wide`，搜索（第二水平线）→ 卡片列表（左垂直线） |
| /stocks 详情 | 桌面两栏：左侧主内容 = 行情主卡（价+徽章+时间）+ 走势图 + Tab 卡；右侧侧栏 = 原 stat-grid 统计格竖排 + 其余辅助卡；平板/手机堆叠 |
| /funds | 列表同 /stocks 列表；详情两栏同 /stocks 详情（统计格入侧栏） |
| /sectors | 列表 `.page-wide`；详情两栏（统计格入侧栏） |
| /scanner | `.page-wide`，状态条（顶部）→ 策略 Tab（第二水平线）→ 结果列表 |
| /backtest | `.page-wide`（净值图更宽），表单（顶部）→ 结果 |
| /overseas | 维持现有顶栏 + 三块分区，grid 自适应已满足；加 `.page-title` |
| /webchat | 聊天窗维持窄栏；`.page-header` 不变；仅确保标题层级 |

---

## 3. 功能需求

### 3.1 theme.css 新增

| # | 需求 |
|---|---|
| L1 | `.page-wide { max-width: 1080px; margin: 0 auto; padding/gap 同 .page }` |
| L2 | `.page-title { font-size: 20px; font-weight: 600; }`（每页 `<main>` 首个元素为 `<h1 class="page-title">`，页名 + 关键状态） |
| L3 | `.prose { max-width: 42em; }` 用于长文本块（快讯摘要、AI 分析结果、免责声明段落） |
| L4 | `.layout-2col { display: flex; gap: 24px; align-items: flex-start; }` + `.layout-main { flex: 1 1 0; min-width: 0; display:flex; flex-direction:column; gap:24px; }` + `.layout-aside { flex: 0 0 300px; display:flex; flex-direction:column; gap:24px; }`；`@media (max-width: 900px)` 时堆叠为单列、aside 全宽 |
| L5 | 响应式：两栏只在 ≥901px 生效，否则 flex-direction: column |

### 3.2 各页改动

- 列表页（market/news/stocks 列表/funds 列表/sectors 列表/scanner/backtest）：
  容器类改 `.page-wide`（或保留 `.page` 但宽度提升——实现取其一，验收看宽度 ≥1000px），
  `<main>` 开头加 `<h1 class="page-title">`；
- 详情页（stocks/funds/sectors）：用 `.layout-2col` 包裹，
  原"行情卡内 stat-grid 统计格"整块移入侧栏竖排（grid 改单列），
  行情卡（价格主区）留主栏顶部；走势图与 Tab 卡在主栏；
- news：`.summary` 块加 `.prose`；
- 交互反馈：列表行 hover 维持 Soft UI 上浮柔影（已覆盖 F 型扫描锁定诉求）；
  动效 duration 保持 200ms 以内（F 型 Fast Feedback）。

### 3.3 明确约束

- 侧栏只放**已有**内容块（统计格、公司资料等现有卡），不新增数据源、
  不新增"热门推荐/标签云"类无数据支撑的装饰区；
- 禁止把重要操作/信息放右下角；退出按钮等操作维持顶部 header 右侧
  （导航区属 F 型第一水平线，允许）；
- 所有大段文字保持左对齐（现状即左对齐，改造不引入 text-align: center）。

---

## 4. 数据模型 / API / 前端改动

- 无后端/API/数据模型改动；
- 前端：theme.css 新增 4 组工具类 + 9 页容器级重排（div 包裹/class/h1 增删）。

---

## 5. 验收标准

1. `npm run typecheck` 与 `npm test` 全绿；
2. 桌面宽度（≥1280px）下内容页内容区 ≥1000px 宽；长文本块行长 ≤42em；
3. 详情页在 ≥901px 呈主+侧两栏，≤900px 单列堆叠，无横向溢出；
4. 每页有且仅有一个 `<h1>`（.page-title），层级 h1 > h2 > h3 清晰；
5. 无 text-align: center 的大段文字（现有 .empty-state/.disclaimer 居中豁免：
   短句状态提示与版权行不属于"大段文字"）；
6. JS 全部 id 引用不破（元素只搬容器不改 id），逐页数据链路行为不变；
7. 浏览器逐页目检：桌面 + 手机宽度（375px）无破版。

---

## 6. 审计要点

- 与 REQ-UI-1 仲裁表一致性：改造中不得把圆角/阴影/边框改回 F 型布局 kit 的值；
- 侧栏内容是否全部来自已有区块（防功能私增）；
- 详情页搬移后 JS（getElementById）引用是否全部仍然有效；
- 响应式断点 900px 两侧是否都无破版。

---

## 7. 补充需求（2026-09-27 同日追加）：顶部导航改左侧竖向边栏

用户截图反馈窄窗口下顶部导航换行错乱，要求：

| # | 需求 |
|---|---|
| S1 | 导航从顶部横条改为**左侧固定竖向边栏**（F 型布局垂直线的直接体现） |
| S2 | 导航项**去掉图标**，纯文字（品牌区 📈 股助手 图标保留） |
| S3 | 一列排不下时**竖向滑动**（overflow-y: auto） |
| S4 | 实现于 theme.css `.page-header`（全 9 页共用），body 加左 padding 偏移；≤768px 退化为顶部横滑条（overflow-x: auto），避免手机端侧栏挤占内容宽度 |
| S5 | 退出按钮在边栏内全宽左对齐 pill 样式（覆盖 .btn-ghost 的悬浮效果） |

**非目标**：不做折叠/汉堡菜单；不动导航项的链接目标与顺序。
