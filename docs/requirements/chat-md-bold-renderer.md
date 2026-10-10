# 需求文档：聊天页 LLM 回复 Markdown 加粗渲染器

> **文档编号**：REQ-chat-md-bold（非路线图小修，对应 STATUS"其他候选方向"第 6 条方案②）
> **目标读者**：实现 agent / 代码审查 agent / 后续维护者
> **状态**：已实现（2026-10-10）

---

## 1. 背景与目标

### 1.1 背景

2026-10-10 F7-2 真机验收发现：聊天页（/webchat）LLM 回复中的 `**加粗**`
以原始字符展示（如"**仅供参考，不构成投资建议**"）。根因是前端防注入红线——
所有接口文本一律 `textContent` 渲染，不解析任何 Markdown。

STATUS"其他候选方向"第 6 条给出两条修法：

- 方案①：SYSTEM_PROMPT 引导 LLM 输出纯文本（零风险、治标）；
- **方案②（本需求选定）**：前端写极简 `**加粗**` 解析渲染器（只允许加粗
  这一种语法，其余字符一律转义，仍须防注入）。

选定方案②的原因：LLM 对纯文本输出的服从度不可控（换模型/换提示词后可能
复发），前端渲染层解决一劳永逸，且实现面极小、可控。

### 1.2 目标

- 聊天页气泡中的成对 `**...**` 渲染为 `<strong>` 加粗；
- 不成对的 `**` 按字面文本原样显示；
- 防注入红线不破：所有非加粗文本一律以 `textContent` 方式插入（等价转义），
  全链路禁止 `innerHTML` 拼接不可信文本。

### 1.3 非目标（本需求明确不做）

- **不做**斜体（`*x*` / `_x_`）、链接、标题、列表、代码块、删除线等任何其他
  Markdown 语法——LLM 输出中高频的加粗是唯一支持项，其余字符按字面渲染；
- **不改动** `src/agent/loop.ts` 的 SYSTEM_PROMPT（方案①明确不采用）；
- **不改**其他页面（/stocks /market /news /funds /overseas /sectors
  /scanner /backtest /inbox 等继续全量 textContent）；
- **不引入**任何 Markdown 解析库（marked / markdown-it 等）：体积与安全
  审计成本不必要，自实现约 20 行纯函数；
- **不改**安卓壳（android/）与后端任何 API。

---

## 2. 范围

**改**：`public/webchat/index.html`（聊天页内联脚本：新增渲染函数 + addMsg
与回复填充处改调用它；必要的一行 `.msg strong` 样式）。

**不改**：`src/`、`data-service/`、`android/`、其他 public 页面、
后端 API、SYSTEM_PROMPT。

---

## 3. 功能需求

### 3.1 解析渲染函数

- 新增纯函数级解析器（建议命名 `renderMdBold(text)`）：接收字符串，返回
  DOM 构建结果（直接往目标节点追加子节点），**不返回 HTML 字符串**。
- 仅识别成对的 `**...**`：bold 段内容创建 `<strong>`（或 `<b>`）节点；
  其余文本一律创建文本节点（`document.createTextNode` / `textContent`）。
- 不成对的 `**`（奇数个、或未闭合）按字面文本处理：全部走文本节点，
  用户看到的与改动前完全一致。
- 支持一行内多段加粗（`a **b** c **d** e` → 文本/a-strong/文本/strong/文本）。
- 空加粗段（`****`）按字面文本处理（不产生空 strong）。
- 函数实现中不得出现 `innerHTML` / `outerHTML` / `insertAdjacentHTML`。

### 3.2 应用范围

- assistant 气泡（`addMsg(text, 'bot')` 渲染路径 + 回复填充
  `pending.textContent = ...` 两处）走新渲染函数；
- 用户气泡与收件箱推送消息若复用 `addMsg`，自然同样生效——不为其单独
  扩语法（用户输入原文含 `**` 时按 3.1 规则同样渲染，语义自洽）；
- 错误气泡（.error）同样走该函数。

### 3.3 样式

- `.msg strong` 样式适配两种气泡（用户气泡白字加粗、机器人气泡深色加粗），
  仅权重/颜色微调，不动布局。

---

## 4. 非功能需求

### 4.1 防注入红线（最高优先级）

- 所有来自接口/用户的文本，除成对 `**` 包裹的"内容文本"（同样以 textContent
  进 `<strong>` 节点，不解析内部任何标记）外，一律不产生任何 HTML 标记；
- 回归测试必须覆盖 XSS 尝试：如 `<img src=x onerror=alert(1)>`、
  `<script>`、`**<img ...>**`（加粗段内嵌标签）等输入，断言产物为纯文本
  节点 / strong 内纯文本，绝不允许出现元素注入。

### 4.2 兼容性

- 只用 Chrome 83（安卓壳 WebView 下限，见 PITFALLS WebView 条目）可用 API：
  `String.prototype.split`/正则、`document.createElement`、`createTextNode`；
  禁止 `replaceChildren`（Chrome 86+）等新 API。

### 4.3 性能与健壮性

- 纯函数、无正则灾难性回溯风险（pattern 只用固定分隔符 `**` 字面切分）；
- 对 `null`/`undefined`/非字符串输入健壮（addMsg 各调用点统一收口，
  `String(text ?? '')`）。

---

## 5. 数据模型 / API / 前端改动

- 数据模型：无。
- 后端 API：无（渲染纯前端）。
- 前端：`public/webchat/index.html` 内联脚本 + 一处内联样式。
- 测试：`tests/webchat-md-bold.test.ts`（照 `tests/webchat-bridge.test.ts`
  模式：读内联 HTML → 用正则/结构断言提取函数体并做行为级校验）。

---

## 6. 验收标准

1. 聊天页收到含 `**重点**` 的回复 → 气泡中"重点"二字加粗显示，其余文本
   与原文一致；
2. 回复含不成对 `**`（如"2 ** 3"、"**未闭合"）→ 原样显示 `**` 字符；
3. 一行多段加粗均生效；
4. 输入 `<img src=x onerror=...>` 等 XSS 文本（无论是否在 `**` 内）→
   页面无任何脚本执行 / 元素注入，仅以纯文本展示；
5. `npm run typecheck` 与 `npm test` 全绿；
6. Chrome 83 WebView 真机/模拟器下渲染正常（无新 API 调用）。

## 7. 审计要点

- [ ] 解析器实现中不存在 `innerHTML`/`outerHTML`/`insertAdjacentHTML` 调用；
- [ ] 所有非 strong 文本均以 textContent/createTextNode 插入；
- [ ] 不成对 `**` 的字面保留有测试覆盖；
- [ ] XSS 用例（普通文本 + 加粗段内嵌标签）断言为纯文本；
- [ ] 未改动 SYSTEM_PROMPT 与其他页面；
- [ ] STATUS"其他候选方向"第 6 条已标记完成，更新日志已补批次。
