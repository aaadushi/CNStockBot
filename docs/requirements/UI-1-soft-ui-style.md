# 需求文档：UI-1 全站 UI 风格改造为 Soft UI（柔和界面风）

> **文档编号**：REQ-UI-1
> **对应路线**：非路线图功能，全站视觉风格统一改造（2026-09-27 用户指定）
> **目标读者**：实现 agent / 代码审查 agent / 后续维护者
> **状态**：已实现（2026-09-27）

---

## 1. 背景与目标

### 1.1 背景

当前前端为 ShadcnUI 风格（黑白灰、细边框、`--radius: 12px`、轻阴影），由
[public/shared/theme.css](../../../public/shared/theme.css) 单一设计系统承载，
9 个页面（webchat / stocks / market / news / funds / overseas / sectors /
scanner / backtest）全部共用。用户指定全站改为 **Soft UI（柔和界面风）**：
圆润大圆角、彩色柔和阴影、低饱和主色、悬浮上浮交互、无硬边框。

### 1.2 目标

- 将共享设计系统 theme.css 改造为 Soft UI token（见 §4），一次改动全站生效；
- 所有页面组件（卡片/按钮/输入框/徽章/导航/header/认证浮层）符合 Soft UI 规则；
- 禁止项零违规（见 §5 验收标准）；
- 页面功能、接口、JS 逻辑零改动——**纯视觉层改造**。

### 1.3 非目标（本需求明确不做）

- 不引入 Tailwind / 任何构建工具：项目前端为无构建手写 CSS，Soft UI 的
  Tailwind token 映射为 CSS 变量与工具类实现；
- 不改页面布局结构、不改 SVG 走势图绘制逻辑、不改任何接口与数据链路；
- 不改 A 股语义色（红涨绿跌）——行情语义色不属于 UI 强调色，保留；
- 不做暗色模式；不做响应式断点重构（沿用现有布局）；
- 不改安卓壳（android/）——壳内 WebView 装载网页，风格自动继承；
- 字体不更换（Soft UI 禁 Inter/Roboto 等烂大街字体，现有系统字体栈符合）。

---

## 2. 范围

**改**：`public/shared/theme.css`（token 重写）+ 各页面 index.html 中
与 Soft UI 冲突的内联 `<style>` / `style=` 覆盖。

**不改**：`src/`、`data-service/`、`android/`、页面 HTML 结构、JS 逻辑。

---

## 3. 功能需求（视觉规则映射）

### 3.1 theme.css token 映射

| Soft UI 规则 | 实现 |
|---|---|
| 主圆角 rounded-2xl / rounded-3xl | `--radius: 16px`（卡片/按钮/输入），卡片专用 `--radius-lg: 24px`，徽章保持 pill |
| 阴影带色+透明度 | `shadow-md/lg/xl` → 带 indigo 色调的柔和阴影（如 `shadow-indigo-500/20` 悬停、`shadow-gray-200/50` 常态） |
| 背景浅色调 | `--bg: #f8fafc`（slate-50），卡片 `--card: #ffffff` |
| 低饱和主色 | indigo-500/600 保留（#4f46e5 / #4f46e5 hover 用 #6366f5 柔和化） |
| 无硬边框 | 所有组件 `border: 0`（或 `border: 1px solid transparent`），层次靠阴影 |
| 按钮悬浮 | `hover:-translate-y-0.5` + `hover:shadow-xl`（彩色柔影）+ `transition-all duration-200`；active `scale(0.97)` |
| 输入框 | `bg-gray-50`、`border-0`、`rounded-2xl`、`focus:ring-2 ring-indigo-500/50`（柔光环）+ `focus:bg-white` |
| 卡片 | `rounded-3xl`、`shadow-xl shadow-gray-200/50`、`hover:shadow-2xl hover:-translate-y-1 transition-all duration-300` |
| 图标圆形底 | 提供 `.icon-chip`：`rounded-full bg-[accent]/10` |
| 间距 | 卡片 padding 20→24px（p-6），页面卡片间距 16→24px（gap-6） |

### 3.2 各页面清扫

- 内联 `<style>` 中所有 `border: 1px solid var(--border)`（或硬色值）、
  小圆角（≤8px 的非徽章元素）、无模糊硬阴影（`box-shadow` 无 blur 分量）改为
  Soft UI 等价实现；
- `style=` 内联属性中同上违规项；
- 特例豁免：SVG 走势图内部的坐标/网格线、表格细分隔线（`border-bottom` 1px
  低对比度分隔线属于数据可读性需求，允许 `var(--border)` 0.5px~1px 浅色线，
  不算硬边框）、`border-radius: 2px` 的图例色条（3px 高小色块，非 UI 组件）。

---

## 4. 数据模型 / API / 前端改动

- 无后端改动；无 API 改动；无数据模型改动。
- 前端：仅 `public/shared/theme.css` + 9 个 `public/*/index.html` 的内联样式。

---

## 5. 验收标准

1. `npm run typecheck` 与 `npm test` 全绿（不应有变化，纯静态文件）。
2. 全站 grep 无 Soft UI 禁止项：
   `border: 1px solid #000` 类硬黑边框、纯黑 `#000000` 背景、
   非徽章/色块元素的 `border-radius ≤ 8px`、无模糊硬阴影。
3. 对照用户提供的 Soft UI 自检清单逐条过：
   按钮/卡片/输入框 token 齐全；hover/focus/active 状态齐全；
   无嵌套卡片观感（卡片内直接放内容，不再套 `.card`）；无渐变文字、
   无单侧粗边框装饰、无 glassmorphism。
4. 每页人工/浏览器打开目检：布局不破、图表正常、可读性不下降。
5. 端到端验证：启动主服务打开 `/webchat`、`/stocks` 等页面目检
   （无 LLM_API_KEY 时以静态检查为准并注明）。

---

## 6. 审计要点

- 是否只动了视觉层（HTML 结构 / JS 逻辑零变化）——diff 应只含 CSS 与 class/style 属性；
- 禁止项 grep 是否为零（见 §5.2）；
- 红涨绿跌语义色是否被误改；
- 行情数据表格的可读性分隔线是否保留。
