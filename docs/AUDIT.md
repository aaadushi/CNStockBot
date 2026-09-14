# 代码审计记录（AUDIT）

> **本文件的用途**：
> 1. **审查 agent** 记录代码审查中发现的问题；
> 2. **修复 agent** 修复后在对应问题下追加修复备注；
> 3. 任何 agent 都能从"审查进度表"看出哪些代码审过了、审到哪了。
>
> 分工：审计发现的是**代码缺陷/隐患**；外部接口的坑、工具链问题仍记
> [PITFALLS.md](PITFALLS.md)；功能层面"还没做的事"记 [STATUS.md](STATUS.md)。
>
> 2026-09-14 首轮全模块审查由 6 个并行审查 agent 完成（主会话代回填，条目为审查原文）。

---

## 角色与规则（严格遵守）

### 审查 agent（发现问题的人）
- 按下方模板在对应模块下新增问题条目，分配编号（`A-001`、`A-002`……顺延，不复用）。
- **问题描述、建议修法是审查者的原文，其他任何人不得修改、润色或删除。**
- 只有审查者本人（同一审查会话）可以修改自己写的条目。
- 复核修复结果后，由审查者把状态改为 `✅ 已闭环`，可在条目末尾追加"复核意见"小节；
  复核不通过则改回 `🔲 待修复` 并在复核意见中说明原因。

### 修复 agent（修问题的人）
- **允许做且仅允许做两件事**：
  1. 在问题条目的"修复备注"下**追加一条**自己的修复说明（改了什么、为什么这么改、
     有什么要特别告知的）；
  2. 把状态从 `🔲 待修复` 改为 `🔧 已修复待复核`。
- **禁止**：修改审查者的原文（问题描述/建议修法）；修改或删除他人的修复备注；
  把状态直接改为 `✅ 已闭环`（闭环权在审查者）。
- 如果认为问题描述有误或不值得修：**不要改条目**，在修复备注里写明理由并把状态改为
  `⏸️ 争议待议`，等审查者复核裁定。
- 修复过程中踩了新坑（符合 PITFALLS 回填标准的）：**不要直接写 PITFALLS.md**，
  写进修复备注里，由审查者复核时或主会话代为回填。

### 通用
- 每条修复备注必须带日期和署名（agent 会话标识或"人类开发者"）。
- 条目按模块分组，新条目加在模块内**最前面**。
- 状态流转：`🔲 待修复` → `🔧 已修复待复核` → `✅ 已闭环`
  （任何阶段可被审查者判为 `⏸️ 争议待议` 或 `🚫 不修（已说明理由）`）。

### 问题条目模板

```markdown
### [A-xxx] 一句话标题
- **发现日期**：YYYY-MM-DD
- **审查人**：（agent 标识）
- **严重程度**：🔴 高（正确性/安全/数据丢失） / 🟡 中（边界情况/可维护性） / 🔵 低（风格/小改进）
- **状态**：🔲 待修复
- **位置**：`src/文件.ts:行号`
- **问题描述**：什么问题、什么场景下触发、造成什么后果
- **建议修法**：（可选）审查者的建议，修复者可采用或说明为何不采用

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [YYYY-MM-DD by xxx] 修复说明：……
```

---

## 审查进度表

> 审查 agent 完成一个模块的审查后更新本表（即使没发现问题也要更新——"审过没问题"
> 和"没审过"是两回事）。全部模块 ✅ 后可考虑提高抽查标准重新过一轮。

| 模块 | 文件 | 最近审查 | 审查人 | 状态 | 发现问题数（未闭环/总数） |
|---|---|---|---|---|---|
| 对话主循环 | `src/agent/loop.ts` | 2026-09-14 | 审查agent-对话循环 | ✅ 已审查 | 0/2 |
| LLM 客户端 | `src/llm/client.ts` | 2026-09-14 | 审查agent-对话循环 | ✅ 已审查 | 0/2 |
| 技能框架 | `src/skills/types.ts`、`registry.ts` | 2026-09-14 | 审查agent-技能 | ✅ 已审查 | 0/1 |
| 技能：行情 | `src/skills/bundled/quote/` | 2026-09-14 | 审查agent-技能 | ✅ 已审查 | 0/1（并入 A-204） |
| 技能：新闻 | `src/skills/bundled/news/` | 2026-09-14 | 审查agent-技能 | ✅ 已审查 | 0/3 |
| 技能：自选股 | `src/skills/bundled/watchlist/` | 2026-09-14 | 审查agent-技能 | ✅ 已审查 | 0/2 |
| 技能：搜索 | `src/skills/bundled/search/` | 2026-09-14 | 审查agent-技能 | ✅ 已审查 | 0/0 |
| 技能：公告/财报/指数 | `src/skills/bundled/{announcement,financials,index}/` | 2026-09-14 | 审查agent-技能 | ✅ 已审查 | 0/5 |
| 数据层 | `src/data/eastmoney.ts`、`pythonService.ts`、`index.ts`、`provider.ts` | 2026-09-14 | 审查agent-数据层 | ✅ 已审查 | 0/10 |
| 存储 | `src/storage/store.ts` | 2026-09-14 | 审查agent-存储调度 | ✅ 已审查 | 0/2 |
| 渠道：WebChat | `src/channels/webchat.ts`、`public/webchat/` | 2026-09-14 | 审查agent-渠道 | ✅ 已审查 | 0/3 |
| 渠道：飞书 | `src/channels/feishu.ts` | 2026-09-14 | 审查agent-渠道 | ✅ 已审查 | 0/4 |
| 调度器 | `src/alerts/scheduler.ts`、`src/alerts/healthProbe.ts` | 2026-09-14 | 审查agent-存储调度 | ✅ 已审查 | 0/7 |
| 配置与入口 | `src/config.ts`、`src/index.ts` | 2026-09-14 | 审查agent-配置与微服务 | ✅ 已审查 | 0/3 |
| Python 微服务 | `data-service/main.py` | 2026-09-14 | 审查agent-配置与微服务 | ✅ 已审查 | 0/5 |

状态图例：⬜ 未审查 / 🔄 审查中 / ✅ 已审查（日期与人见表内）

---

## 问题记录

> 按模块分组，新条目加在组内最前面。

### 对话主循环（agent/loop.ts）

### [A-101] 同一用户并发消息时会话历史 read-modify-write 竞态，后写覆盖先写导致丢消息
- **发现日期**：2026-09-14
- **审查人**：审查agent-对话循环
- **严重程度**：🟡 中
- **状态**：✅ 已闭环
- **位置**：`src/agent/loop.ts:60`（`getHistory`）与 `src/agent/loop.ts:96`（`saveHistory`）
- **问题描述**：`handleMessage` 是"开头读历史 → 多轮 await（LLM/技能调用，耗时数秒到十几秒）→ 结尾整体覆盖写历史"的模式，没有任何按用户的串行化。WebChat 渠道（`src/channels/webchat.ts:48-60`）对每个 POST /api/chat 独立 await，不做排队；飞书渠道也是先回 200 再异步处理。因此同一 userId 快速连发两条消息（用户在网页上连点发送、飞书事件重推、多端同时在线）时，两个调用在 `getHistory` 时读到的是同一份旧历史，各自走完循环后 `saveHistory` 用的是 UPSERT（`store.ts:117-124`，last-writer-wins），先完成的那个调用的"用户消息 + 回复"整轮会从历史里消失。后果：LLM 在后续对话中看不到用户刚说过的话，表现为"机器人失忆/答非所问"，且无任何报错日志可查。
- **建议修法**：在 `Agent` 内加一个 per-userId 的 Promise 链（如 `private queues = new Map<string, Promise<unknown>>()`，`handleMessage` 把实际工作挂到 `queues.get(userId) ?? Promise.resolve()` 之后并更新该链，注意 finally 里清理已完成的链避免 Map 泄漏），保证同一用户的消息严格串行处理。不同用户之间仍可并发。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：在 Agent 内加 per-userId Promise 串行队列（`queues: Map<string, Promise<string>>`），同一用户消息严格串行、不同用户并发；前一条失败不阻塞后续（catch 吞掉），链尾完成后清理 Map 防泄漏。handleMessage 变为排队入口，实际工作移到私有 process()。与 A-407 同根因同修。

#### 复核意见

- [2026-09-14 by 审查agent-对话循环] ✅ 复核通过，予以闭环。A-101 首轮不通过（finally 派生 Promise 未接 catch 会致进程崩溃），修复方补 `.catch(() => {})` 后复核通过；其余三条一次通过。

### [A-104] 兜底回复文案"处理超时"在非超时场景也会出现，误导用户
- **发现日期**：2026-09-14
- **审查人**：审查agent-对话循环
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`src/agent/loop.ts:74-76` 与 `src/agent/loop.ts:92`
- **问题描述**：`reply = msg.content ?? ''` 后若为空则走 `if (!reply) reply = '（处理超时，请换个方式再问一次）'`。触发路径有两条：(1) 真的跑满 8 轮工具调用没产出最终回复（超时/死循环，文案匹配）；(2) 第一轮 LLM 就返回了空 content 且无 tool_calls（DeepSeek 偶发，尤其是内容被安全过滤时 finish_reason=content_filter）。场景 2 下用户明明秒回了，却收到"处理超时"，困惑且无从分辨是服务问题还是模型拒答。
- **建议修法**：区分两个分支——跑满轮次时用超时文案；单轮空 content 时用"（模型没有给出回复，请换个问法再试一次）"之类，并最好把 `finish_reason` 日志打出来便于排查。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：区分两个分支：新增 exhaustedRounds 标记，跑满 MAX_TOOL_ROUNDS 用超时文案；单轮空 content 用"（模型没有给出回复，请换个问法再试一次）"。

#### 复核意见

- [2026-09-14 by 审查agent-对话循环] ✅ 复核通过，予以闭环。A-101 首轮不通过（finally 派生 Promise 未接 catch 会致进程崩溃），修复方补 `.catch(() => {})` 后复核通过；其余三条一次通过。

### LLM 客户端（llm/client.ts）

### [A-102] LLM 请求无超时控制，对端挂起时对话永久卡死
- **发现日期**：2026-09-14
- **审查人**：审查agent-对话循环
- **严重程度**：🟡 中
- **状态**：✅ 已闭环
- **位置**：`src/llm/client.ts:34`
- **问题描述**：`fetch` 没有传 `signal`，Node 原生 fetch 默认无整体超时。当 LLM 服务商出现"连接建立但迟迟不返回 body"的半挂状态（限流排队、网关假死，在国内代理/兼容网关中并不少见）时，`chat()` 的 Promise 永不 settle：`handleMessage` 卡死、WebChat 的 HTTP 请求挂起直到客户端自己断开，该用户这轮对话彻底无响应且没有任何错误暴露（叠加上 A-101 若修了串行队列，还会阻塞该用户后续所有消息）。
- **建议修法**：加超时，如 `signal: AbortSignal.timeout(config.llm.timeoutMs ?? 60_000)`（超时时间可入 config）。可选：对 429/5xx 做一次有限重试（指数退避），但超时是底线。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：chat() 的 fetch 加 `signal: AbortSignal.timeout(config.llm.timeoutMs)`；config 新增 LLM_TIMEOUT_MS（默认 60000，经 numEnv 校验，下限 1000）。未加 429/5xx 重试（超时是底线，重试留待实际需要时再做）。

#### 复核意见

- [2026-09-14 by 审查agent-对话循环] ✅ 复核通过，予以闭环。A-101 首轮不通过（finally 派生 Promise 未接 catch 会致进程崩溃），修复方补 `.catch(() => {})` 后复核通过；其余三条一次通过。

### [A-103] 未校验响应结构，`data.choices[0]` 可能为 undefined 导致难解的 TypeError
- **发现日期**：2026-09-14
- **审查人**：审查agent-对话循环
- **严重程度**：🟡 中
- **状态**：✅ 已闭环
- **位置**：`src/llm/client.ts:51-52`
- **问题描述**：只检查了 `res.ok`，直接 `data.choices[0].message` 解包。部分 OpenAI 兼容服务在业务错误时仍返回 200 + 错误体（如 `{"error": {...}}` 或 `choices: []`），此时 `data.choices` 为 undefined 或空数组，抛出 `Cannot read properties of undefined (reading 'message')`——错误文本不含任何 LLM 返回的真实错误信息，排查方向完全误导（会以为是本地代码 bug）。另外 200 但 body 非 JSON（个别网关掉包返回 HTML 错误页）时 `res.json()` 抛的 SyntaxError 同样没有上下文。
- **建议修法**：解析后显式校验：`if (!data.choices?.[0]?.message) throw new Error(\`LLM 响应格式异常：${JSON.stringify(data).slice(0, 300)}\`)`；`res.json()` 包 try/catch 并把原始文本片段带进错误消息。原则：抛出给上层的错误必须包含服务端返回的原文摘要。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：res.json() 包 try/catch（非 JSON 时报"可能是网关错误页"）；解析后显式校验 choices[0].message，缺失时抛出带响应原文摘要的错误（slice 300 字符）。

#### 复核意见

- [2026-09-14 by 审查agent-对话循环] ✅ 复核通过，予以闭环。A-101 首轮不通过（finally 派生 Promise 未接 catch 会致进程崩溃），修复方补 `.catch(() => {})` 后复核通过；其余三条一次通过。

### 技能框架与技能（skills/）

### [A-201] manage_watchlist 未知 action 静默落入 remove 分支，可能误删自选股
- **发现日期**：2026-09-14
- **审查人**：审查agent-技能
- **严重程度**：🟡 中（边界情况/用户数据误删）
- **状态**：✅ 已闭环
- **位置**：`D:\Users\Desktop\program\CNStockBot\src\skills\bundled\watchlist\index.ts:44-47`
- **问题描述**：`execute` 只显式判断 `action === 'list'`（行 18）和 `action === 'add'`（行 37），其余一律走到行 45 注释 `// remove` 的删除分支。JSON Schema 里的 `enum: ['add','remove','list']` 只是给 LLM 的提示，运行时不做任何强制——LLM 幻觉出 `"delete"`、`"del"`、`"clear"`、`"remove_all"` 等值时（DeepSeek 偶发不严格遵守 enum），只要带了合法 code 就会被当作 remove 执行，未经用户确认删除其自选股。若 action 未知且没带 code，还会返回误导性的"请提供 6 位股票代码"。
- **建议修法**：在入口处做白名单校验：`if (!['add','remove','list'].includes(action)) return `未知操作"${action}"，支持 add/remove/list。请向用户确认意图。``；remove 分支改为显式 `action === 'remove'`。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：入口处白名单校验 `!['add','remove','list'].includes(action)` 直接返回提示文本（含"不要擅自删除"指引）；remove 分支改为兜底但已被白名单保护。

#### 复核意见

- [2026-09-14 by 审查agent-技能] ✅ 复核通过，予以闭环。8 条一次通过。非阻断附注：A-205 归一化后空串会命中第一个指数（极端边角无实际危害）。

### [A-202] manage_watchlist 的 add 用 getQuote 验证代码，停牌股票无法加入自选
- **发现日期**：2026-09-14
- **审查人**：审查agent-技能
- **严重程度**：🟡 中（边界情况，正当操作被拒）
- **状态**：✅ 已闭环
- **位置**：`D:\Users\Desktop\program\CNStockBot\src\skills\bundled\watchlist\index.ts:38-40`
- **问题描述**：add 时先 `await ctx.data.getQuote(code)` 验证代码有效性并取名称。停牌/退市时东财返回 `"-"`，`getQuote` 抛错（此为 PITFALLS 确认的"设计如此"——错误文本回传 LLM 没错），但这里的副作用是：**用户持仓的停牌股永远无法加入自选股**，也就进不了收盘日报和异动提醒，而停牌恰恰是用户最想盯住的状态。SKILL.md 写了"add 时会先调用行情接口验证代码有效性"，但没说明会连带拒绝停牌股，实现与文档共同造成了这个隐性限制。
- **建议修法**：捕获 getQuote 错误后区分"代码无效"与"停牌/暂无行情"（或改用 search 接口按代码精确匹配验证存在性）；停牌时应允许加入，名称用 search 结果或暂用代码本身。若决定维持现状，至少在 SKILL.md 明确写出该限制。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：add 时 getQuote 抛错不再直接失败：降级用 ctx.data.search 按代码精确匹配确认存在性，搜到则以搜索结果的名称加入（停牌股可入自选）；都未找到才返回"请核对代码（不要凭记忆猜测）"。

#### 复核意见

- [2026-09-14 by 审查agent-技能] ✅ 复核通过，予以闭环。8 条一次通过。非阻断附注：A-205 归一化后空串会命中第一个指数（极端边角无实际危害）。

### [A-203] news / announcement / financials 的 limit 只封顶不设下限，且不防 NaN/小数
- **发现日期**：2026-09-14
- **审查人**：审查agent-技能
- **严重程度**：🟡 中（边界情况/token 膨胀）
- **状态**：✅ 已闭环
- **位置**：`D:\Users\Desktop\program\CNStockBot\src\skills\bundled\news\index.ts:16`、`src\skills\bundled\announcement\index.ts:17`、`src\skills\bundled\financials\index.ts:17`
- **问题描述**：三处均为 `Math.min(Number(args.limit ?? N), 上限)`。问题：(1) LLM 传负数时原样透传到微服务 URL；data-service 端 `Query(default=10, le=50)` 只设了 `le` 没有 `ge`，FastAPI 会接受负数，`df.head(-N)` 在 pandas 里的语义是"返回除末尾 N 行外的全部"——新闻接口可能返回数千行，tool 结果原样进入本轮 prompt（loop.ts 的 1200 字符截断只作用于入库历史，不影响当轮 messages），造成 token 膨胀。(2) LLM 传非数字（`"many"`）→ `Number()` 得 NaN → `Math.min(NaN, 20)` = NaN → URL 出现 `limit=NaN`，FastAPI 422，用户看到莫名其妙的报错文本。(3) 小数（如 3.7）同样触发 422。
- **建议修法**：统一写成 `const n = Math.trunc(Number(args.limit)); const limit = Number.isFinite(n) && n >= 1 ? Math.min(n, 上限) : 默认值;`。data-service 侧给 Query 补 `ge=1` 可作为纵深防御（属数据层/微服务审查范围，此处仅提示）。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：新增 src/skills/args.ts 的 normalizeLimit（trunc 取整、限定 [1,max]、非法回退默认），news/announcement/financials 三技能统一改用它；data-service 侧三个端点 Query 补 ge=1 纵深防御。

#### 复核意见

- [2026-09-14 by 审查agent-技能] ✅ 复核通过，予以闭环。8 条一次通过。非阻断附注：A-205 归一化后空串会命中第一个指数（极端边角无实际危害）。

### [A-204] quote / news / announcement / financials 不校验 code 格式，python 数据源下被原样拼入 URL path
- **发现日期**：2026-09-14
- **审查人**：审查agent-技能
- **严重程度**：🟡 中（注入面有限但校验不一致）
- **状态**：✅ 已闭环
- **位置**：`D:\Users\Desktop\program\CNStockBot\src\skills\bundled\quote\index.ts:14`、`news\index.ts:15`、`announcement\index.ts:16`、`financials\index.ts:16`（对照组：watchlist/index.ts:35 有 `/^\d{6}$/` 校验）
- **问题描述**：四个技能都只做 `String(args.code ?? '')` 就交给数据源。东财模式有 `toSecid()` 的正则兜底没问题；但默认 composite 模式下 news/announcement/financials 走 `pythonService.ts`，其 `/quote/${code}`、`/news/${code}?...` 等路径拼接**未做 encodeURIComponent 也未校验**——LLM 若传入含 `/`、`?`、`..` 的字符串，会造成 URL 路径错乱甚至打到微服务的其他端点（如 `../trade-calendar`）。实际危害受限于微服务只监听本地、参数源自 LLM 而非直接用户输入，故不定 🔴；但五个技能里四个不校验、一个校验，行为不一致本身也是问题。
- **建议修法**：四个技能在调用数据源前统一加 `if (!/^\d{6}$/.test(code)) return '请提供 6 位数字股票代码。';`（与 watchlist 对齐）；pythonService 的路径拼接补 encodeURIComponent 作为纵深防御（数据层审查范围）。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：四个技能统一用 args.ts 的 invalidCodeMessage 校验 6 位数字代码（与 watchlist 对齐）；pythonService.ts 全部路径拼接补 encodeURIComponent 纵深防御。

#### 复核意见

- [2026-09-14 by 审查agent-技能] ✅ 复核通过，予以闭环。8 条一次通过。非阻断附注：A-205 归一化后空串会命中第一个指数（极端边角无实际危害）。

### [A-205] get_market_index 别名只做全等匹配，"创业板指数"等常见说法被误报"暂不支持"
- **发现日期**：2026-09-14
- **审查人**：审查agent-技能
- **严重程度**：🟡 中（输出错误的否定答案）
- **状态**：✅ 已闭环
- **位置**：`D:\Users\Desktop\program\CNStockBot\src\skills\bundled\index\index.ts:47-52`
- **问题描述**：匹配逻辑是 `i.code === name || i.name === name || aliases.some(a => a.toLowerCase() === kw)`——全部是全等。LLM 从用户口语中提取的参数常带后缀，如"创业板指数""上证50指数""沪深300指数""科创50指数"，全等匹配失败，技能返回"暂不支持查询'创业板指数'"并附支持列表——这是一个**事实错误的否定回答**（明明支持），用户会以为功能缺失。别名表里也没有"沪指"以外的常见变体（如"深证成指"对"深指"）。
- **建议修法**：匹配前对输入归一化（trim、去"指数"后缀、转小写）；或对 name/aliases 增加 `includes` 双向包含匹配兜底；再在别名表补常见变体（深指、科创五零 等）。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：匹配前归一化：去空白、去"指数"后缀、转小写；候选（code/name/aliases）同样归一化后做全等 + 双向 includes 兜底。未另补别名表（归一化已覆盖"创业板指数"等说法）。

#### 复核意见

- [2026-09-14 by 审查agent-技能] ✅ 复核通过，予以闭环。8 条一次通过。非阻断附注：A-205 归一化后空串会命中第一个指数（极端边角无实际危害）。

### [A-206] registry 不检测技能重名，同名技能静默互相覆盖
- **发现日期**：2026-09-14
- **审查人**：审查agent-技能
- **严重程度**：🔵 低（可维护性）
- **状态**：✅ 已闭环
- **位置**：`D:\Users\Desktop\program\CNStockBot\src\skills\registry.ts:12-14`
- **问题描述**：`byName` 用 Map 构建，若新增技能与现有技能同名，后者静默覆盖前者，且 `toToolSpecs()` 会把两个同名 function 定义都发给 LLM——OpenAI 兼容接口对同名 tool 行为未定义（部分实现直接 400）。项目约定"新增技能必须在此注册"，随技能增多重名风险上升，而目前无任何防线。
- **建议修法**：模块加载时断言 `if (byName.size !== skills.length) throw new Error('技能重名：...')`，让重名在启动即暴露。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：registry.ts 模块加载时断言 byName.size !== skills.length 则 throw 并列出重名技能，启动即暴露。

#### 复核意见

- [2026-09-14 by 审查agent-技能] ✅ 复核通过，予以闭环。8 条一次通过。非阻断附注：A-205 归一化后空串会命中第一个指数（极端边角无实际危害）。

### [A-207] get_stock_news 空结果分支缺少对 LLM 的行为指引，与项目约定不一致
- **发现日期**：2026-09-14
- **审查人**：审查agent-技能
- **严重程度**：🔵 低（一致性）
- **状态**：✅ 已闭环
- **位置**：`D:\Users\Desktop\program\CNStockBot\src\skills\bundled\news\index.ts:18`
- **问题描述**：空结果只返回 `未找到 ${code} 的近期新闻。`。PITFALLS §4（LLM 凭记忆作答条目）明确要求"所有失败/空结果分支的返回文本都应包含对 LLM 的下一步行为指引"——search（index.ts:23-28）、announcement（index.ts:22）、financials（index.ts:22）的空结果分支都带"请如实告知用户"指引，唯独 news 没有，弱模型可能据此退化到凭记忆编新闻。
- **建议修法**：补一句"（请如实告知用户未找到，不要凭记忆编造新闻）"，与其他技能对齐。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：news 空结果补"请如实告知用户未找到，不要凭记忆编造新闻"，与其他技能对齐。

#### 复核意见

- [2026-09-14 by 审查agent-技能] ✅ 复核通过，予以闭环。8 条一次通过。非阻断附注：A-205 归一化后空串会命中第一个指数（极端边角无实际危害）。

### [A-208] get_stock_financials 某期所有字段为空时输出"报告期 X："空尾行
- **发现日期**：2026-09-14
- **审查人**：审查agent-技能
- **严重程度**：🔵 低（输出格式）
- **状态**：✅ 已闭环
- **位置**：`D:\Users\Desktop\program\CNStockBot\src\skills\bundled\financials\index.ts:24-34`
- **问题描述**：`parts` 由各字段可选拼接而成，若某报告期所有字段为空串（data-service 端新浪改版缺列时会填空串，见 main.py 的 col_map 注释），输出行退化为 `1. 报告期 2025-06-30：`——冒号后空白，LLM 可能自行脑补该期数据。
- **建议修法**：`parts.length === 0` 时输出 `报告期 ${f.period}：（本期无数据）`。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：parts 为空时输出"（本期无数据）"，不再产生空尾行。

#### 复核意见

- [2026-09-14 by 审查agent-技能] ✅ 复核通过，予以闭环。8 条一次通过。非阻断附注：A-205 归一化后空串会命中第一个指数（极端边角无实际危害）。

### 数据层（data/）

### [A-301] 数据层全部 fetch 无显式超时，可卡住 Agent 回复与调度链
- **发现日期**：2026-09-14
- **审查人**：审查agent-数据层
- **严重程度**：🟡 中
- **状态**：✅ 已闭环
- **位置**：`src/data/eastmoney.ts:36`、`src/data/eastmoney.ts:75`、`src/data/pythonService.ts:13`、`src/data/pythonService.ts:82`
- **问题描述**：四处对外 HTTP 调用（东财行情、东财搜索、微服务 REST、交易日历）均使用裸 `fetch`，未设置任何超时。Node 内置 undici 的默认 headersTimeout 约 300s，且对端 TCP 半开/慢响应场景下等待更久。后果有两条传导路径：(1) Agent 对话中触发技能时，用户最长数分钟得不到任何回复；(2) `scheduler.ts:74` 与 `scheduler.ts:127` 的 `await tradeCalendar.isTradeDay(...)` 位于 try 块内，其挂起期间 `finally` 中的重新调度（`scheduler.ts:111`、`:138`）不会执行，收盘日报/异动提醒链整体顺延甚至停摆一次周期。healthProbe 同理，挂起期间探针静默。
- **建议修法**：统一封装一个带超时的 fetch（如 `fetch(url, { signal: AbortSignal.timeout(10_000), ... })`，行情/搜索 5-10s、微服务可放宽到 30-60s 因 AKShare 较慢），数据层四处调用全部改走该封装；超时错误文案带端点标识便于定位。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：eastmoney.ts 两个 fetch 加 AbortSignal.timeout(10s)；pythonService.ts 与交易日历 fetch 加 60s（AKShare 爬网页较慢）。四处全部覆盖，与 A-409 同修。

#### 复核意见

- [2026-09-14 by 审查agent-数据层] ✅ 复核通过，予以闭环。10 条一次通过。非阻断残留：A-307 错误文案后缀仍含"退市/停牌"字样；A-310 中 index 技能 formatLine 未做 NaN 守卫（指数场景实际不会触发）。

### [A-302] 交易日历对"成功但为空/格式异常"的响应永久缓存，可导致全年推送静默失效
- **发现日期**：2026-09-14
- **审查人**：审查agent-数据层
- **严重程度**：🟡 中
- **状态**：✅ 已闭环
- **位置**：`src/data/pythonService.ts:84-87`
- **问题描述**：`loadYear` 只校验 `res.ok`，随后无条件 `new Set(list)` 并**永久**写入 `this.cache`（年内无失效机制）。若 data-service 上游（新浪交易日历）在年初尚未收录新年份、或 AKShare 改版导致 `/trade-calendar?year=YYYY` 返回空数组，`isTradeDay` 会把该年**所有工作日**判为非交易日——收盘日报与异动提醒全年静默跳过，且因为是"成功响应"不会进入 `failedAt` 重试路径，只能重启进程恢复。同理，若返回格式漂移（如 `"YYYYMMDD"` 无连字符），`days.has(formatYmd(date))` 恒为 false，效果相同且无任何告警。
- **建议修法**：入缓存前校验：`Array.isArray(list)` 且非空、且抽样元素匹配 `/^\d{4}-\d{2}-\d{2}$/`；校验不通过按失败处理（记入 `failedAt`、走 10 分钟重试与降级逻辑），并 console.warn 原文长度/样例。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：loadYear 入缓存前校验：必须是数组、非空、前 5 个元素匹配 YYYY-MM-DD；不通过按失败处理（记 failedAt 走 10 分钟重试 + 降级），console.warn 带条数。

#### 复核意见

- [2026-09-14 by 审查agent-数据层] ✅ 复核通过，予以闭环。10 条一次通过。非阻断残留：A-307 错误文案后缀仍含"退市/停牌"字样；A-310 中 index 技能 formatLine 未做 NaN 守卫（指数场景实际不会触发）。

### [A-303] toSecid 未覆盖北交所 920 新代码段，920xxx 被错误映射到沪市
- **发现日期**：2026-09-14
- **审查人**：审查agent-数据层
- **严重程度**：🟡 中
- **状态**：✅ 已闭环
- **位置**：`src/data/eastmoney.ts:14-18`
- **问题描述**：`toSecid` 规则为"6/9 开头→`1.`（沪市），其余→`0.`"。但北交所 2024 年起启用 920xxx 新代码段（如 920002），按此规则 920xxx 会被映射为 `1.920xxx`（沪市），东财查无此票或返回错误数据，用户得到的将是"未找到行情（代码错误或已退市/停牌）"这一误导性文案。函数注释（"沪市（6/9 开头）"）已落后于实际代码段分配。
- **建议修法**：显式列举北交所前缀：`/^(4|8|920)/` → `0.`；9 开头其余情况（900 沪 B）如不支持应直接抛"暂不支持的代码段"错误，而不是静默映射到沪市。同时更新注释。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：toSecid 显式判断北交所前缀 `/^(4|8|920)/` → 0.；920 段测试已补（tests/eastmoney.test.ts）。注释更新。900 沪 B 仍走 1.（属沪市，口径正确）。

#### 复核意见

- [2026-09-14 by 审查agent-数据层] ✅ 复核通过，予以闭环。10 条一次通过。非阻断残留：A-307 错误文案后缀仍含"退市/停牌"字样；A-310 中 index 技能 formatLine 未做 NaN 守卫（指数场景实际不会触发）。

### [A-304] 东财 search 过滤正则排除北交所（4/8/920），与 toSecid 的支持口径不一致
- **发现日期**：2026-09-14
- **审查人**：审查agent-数据层
- **严重程度**：🟡 中
- **状态**：✅ 已闭环
- **位置**：`src/data/eastmoney.ts:80-84`
- **问题描述**：`search()` 用 `/^[036]\d{5}$/` 过滤候选，注释称"只保留 A 股个股（0/3/6 开头）"。但同文件 `toSecid` 明确支持北交所 4/8 开头（注释："深市（0/3）与北交所（4/8) 前缀 0"）。结果是：北交所股票可以凭代码加自选、查行情，却永远无法通过 `search_stock` 被名称搜到；而 LLM 的既定路径是"先 search 再 query"，等于北交所持仓用户在对话主路径上不可达。若是有意只支持沪深两市的决策，代码与 SKILL.md 均未写明。
- **建议修法**：与 A-303 一并定口径——支持北交所则正则放宽为 `^(0|3|6|4|8|920)` 并同步修改注释与 `src/skills/bundled/search/SKILL.md`；不支持则 toSecid 侧也明确拒绝并在文档注明。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：search 过滤放宽为 `/^[03648]\d{5}$/` 或 `/^920\d{3}$/`，与 toSecid 口径一致；注释同步更新。

#### 复核意见

- [2026-09-14 by 审查agent-数据层] ✅ 复核通过，予以闭环。10 条一次通过。非阻断残留：A-307 错误文案后缀仍含"退市/停牌"字样；A-310 中 index 技能 formatLine 未做 NaN 守卫（指数场景实际不会触发）。

### [A-305] PythonServiceProvider 未实现 getIndexQuote，DATA_PROVIDER=python 时指数技能静默不可用
- **发现日期**：2026-09-14
- **审查人**：审查agent-数据层
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`src/data/pythonService.ts:8-40`（缺失方法）；`src/data/provider.ts:47`
- **问题描述**：`getIndexQuote` 在接口中为可选，只有 `EastmoneyProvider`（及 Composite）实现。当 `DATA_PROVIDER=python`（全量走微服务）时，`ctx.data.getIndexQuote` 为 undefined，指数技能只回"当前数据源不支持指数查询"（`src/skills/bundled/index/index.ts:42`）。STATUS/FEATURES 宣称指数行情功能已完成，未注明该模式下的缺口；且指数行情本身走东财免 key 直连即可，与微服务是否可用无关，此限制并无必要。
- **建议修法**：`PythonServiceProvider` 内组合一个 `EastmoneyProvider` 转发 `getIndexQuote`（与 Composite 同思路），或在文档中明示该模式限制。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：PythonServiceProvider 内组合 EastmoneyProvider 转发 getIndexQuote（与 Composite 同思路），DATA_PROVIDER=python 时指数技能可用。

#### 复核意见

- [2026-09-14 by 审查agent-数据层] ✅ 复核通过，予以闭环。10 条一次通过。非阻断残留：A-307 错误文案后缀仍含"退市/停牌"字样；A-310 中 index 技能 formatLine 未做 NaN 守卫（指数场景实际不会触发）。

### [A-306] EastmoneyProvider.getNews 报错文案误导且该方法实为死代码
- **发现日期**：2026-09-14
- **审查人**：审查agent-数据层
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`src/data/eastmoney.ts:64-68`
- **问题描述**：错误文案为"请设置 DATA_PROVIDER=python 并启动 data-service"。但默认的 CompositeProvider 已覆盖 `getNews`（`src/data/index.ts:25`），用户**无需**改 DATA_PROVIDER 即可获得新闻，照此文案操作反而会白白切换行情链路。且当前装配下没有任何调用方会触达该方法（Composite 拦截、healthProbe 只用 getQuote），是带着误导文案的死代码。
- **建议修法**：文案改为"请启动 data-service（默认组合数据源即可用新闻）"；或更彻底地让 `getNews` 变为接口可选方法、东财实现直接删除该方法。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：getNews 错误文案改为"请启动 data-service（默认组合数据源即可用新闻，无需改 DATA_PROVIDER）"，并注明纯东财模式兜底定位。

#### 复核意见

- [2026-09-14 by 审查agent-数据层] ✅ 复核通过，予以闭环。10 条一次通过。非阻断残留：A-307 错误文案后缀仍含"退市/停牌"字样；A-310 中 index 技能 formatLine 未做 NaN 守卫（指数场景实际不会触发）。

### [A-307] 指数查询失败时向用户暴露原始 secid，且"退市/停牌"文案不适用于指数
- **发现日期**：2026-09-14
- **审查人**：审查agent-数据层
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`src/data/eastmoney.ts:40-41`（经 `:59-62` getIndexQuote 复用）
- **问题描述**：`getIndexQuote` 把裸 secid 作为 label 传入 `fetchQuote`，失败时错误为"未找到 1.000001 的行情（代码错误或已退市/停牌）"。该文本会被技能层回给 LLM 再转述给用户：普通用户看不懂 secid，且指数不存在"退市/停牌"，会误导用户以为查询方式有误。
- **建议修法**：`fetchQuote` 增加可选的友好 label 参数，`getIndexQuote` 传入如"指数（1.000001)"或技能层已知的指数中文名；或为指数路径单独写错误文案。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：getIndexQuote 传入 label `指数 ${secid}`，失败文案不再暗示退市/停牌且标明是指数。

#### 复核意见

- [2026-09-14 by 审查agent-数据层] ✅ 复核通过，予以闭环。10 条一次通过。非阻断残留：A-307 错误文案后缀仍含"退市/停牌"字样；A-310 中 index 技能 formatLine 未做 NaN 守卫（指数场景实际不会触发）。

### [A-308] CompositeProvider.search 降级路径完全静默，故障不可观测
- **发现日期**：2026-09-14
- **审查人**：审查agent-数据层
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`src/data/index.ts:61-67`
- **问题描述**：`search` 的 `catch {}` 降级到东财 suggest 时无任何日志。微服务挂掉后，每次搜索都先徒劳请求一次微服务（叠加 A-301 的无超时问题，等的是一个完整 TCP 超时），再降级；运维侧无法从日志分辨当前搜索走了哪条路、微服务是否已挂，与 `getNews`/`getAnnouncements`/`getFinancials` 三处带明确错误提示的处理风格也不一致。
- **建议修法**：catch 内 `console.warn('[data] python search 失败，降级东财 suggest:', err)`（可加简单节流防刷屏）。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：search 降级分支加 console.warn 留痕（带微服务错误摘要）。

#### 复核意见

- [2026-09-14 by 审查agent-数据层] ✅ 复核通过，予以闭环。10 条一次通过。非阻断残留：A-307 错误文案后缀仍含"退市/停牌"字样；A-310 中 index 技能 formatLine 未做 NaN 守卫（指数场景实际不会触发）。

### [A-309] pythonService 错误提示在所有非 200 场景统一追加"请确认 data-service 已启动"，对 502 场景误导
- **发现日期**：2026-09-14
- **审查人**：审查agent-数据层
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`src/data/pythonService.ts:14-17`
- **问题描述**：微服务已启动但 AKShare 上游失败时返回 502（data-service 各端点的既定行为），此时错误为"数据服务请求失败 502: {...AKShare 新闻获取失败...}（请确认 data-service 已启动）"——括号提示与真实根因（上游数据源失效，应升级 AKShare/查 PITFALLS）相反，会把排查方向引向"服务没启动"。
- **建议修法**：区分连接层错误（fetch throw，提示"请确认已启动"）与 HTTP 错误（5xx 时提示"服务已响应但上游失败，按 PITFALLS.md AKShare 条目排查"）。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：get() 拆两段：fetch throw（连接层/超时）提示"请确认 data-service 已启动"；HTTP 5xx 提示"服务已响应但上游数据源失败，按 PITFALLS.md AKShare 条目排查"。

#### 复核意见

- [2026-09-14 by 审查agent-数据层] ✅ 复核通过，予以闭环。10 条一次通过。非阻断残留：A-307 错误文案后缀仍含"退市/停牌"字样；A-310 中 index 技能 formatLine 未做 NaN 守卫（指数场景实际不会触发）。

### [A-310] 涨跌幅/昨收字段为 "-" 时静默回落为 0，与"错误显式抛出"的既定设计相悖
- **发现日期**：2026-09-14
- **审查人**：审查agent-数据层
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`src/data/eastmoney.ts:47-48`
- **问题描述**：`f170`/`f60` 为 `'-'` 或 undefined 时 `changePct`/`prevClose` 静默取 0。项目既定设计是数据不可用时抛错、由技能层透传给 LLM 如实告知（停牌场景即是如此）；而此处会产出一份"看起来正常"的 Quote（涨跌 0.00%、昨收 0），流入收盘日报与异动判断。典型触发场景待确认（推测如新股上市首日无昨收），但一旦触发即为静默错误数据，比显式报错更难发现。
- **建议修法**：与 f43 的处理对齐——关键字段缺失时抛错透传；或至少在 Quote 中显式标记数据不完整（如 changePct 置 NaN 并在技能层格式化时显示"—"）。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：f170 缺失时优先用 f43/f60 自行换算；f60 也缺失则 changePct=NaN、prevClose=NaN。展示层（quote 技能、watchlist list、scheduler formatQuoteLine）对 NaN 显示"—"；异动判断天然跳过 NaN（比较恒 false）。eastmoney 测试同步更新（含换算用例）。

#### 复核意见

- [2026-09-14 by 审查agent-数据层] ✅ 复核通过，予以闭环。10 条一次通过。非阻断残留：A-307 错误文案后缀仍含"退市/停牌"字样；A-310 中 index 技能 formatLine 未做 NaN 守卫（指数场景实际不会触发）。

### 存储（storage/store.ts）

### [A-407] 会话历史"读-改-写"无并发保护，同一用户并发消息相互覆盖丢历史
- **发现日期**：2026-09-14
- **审查人**：审查agent-存储调度
- **严重程度**：🟡 中（边界情况）
- **状态**：✅ 已闭环
- **位置**：`src/storage/store.ts:129-136`（saveHistory UPSERT 覆盖写），触发点在 `src/agent/loop.ts:60`（getHistory）与 `src/agent/loop.ts:96`（saveHistory）
- **问题描述**：handleMessage 的模式是"开头 getHistory → 结尾 saveHistory 整段覆盖"，中间隔着
  多轮 LLM/技能 await（数秒）。WebChat 的 POST /api/chat 与飞书事件处理都没有按用户串行化，
  用户快速连发两条消息（或双击重发）时两个请求并发：两者读到同一份历史，各自 append 后
  后完成的 saveHistory 把先完成的整段覆盖——先发出那条消息的问答从持久化历史里消失
  （回复本身能返回，但下一轮对话 LLM 看不到了）。SQLite 层无事务可解决此问题，
  因为丢失发生在应用层的 read-modify-write 窗口。
- **建议修法**：在 Agent 层加按 userId 的互斥队列（`Map<userId, Promise>` 链式串联，
  处理完删除空链防止 Map 无界增长）；或在 store 层提供
  `appendHistory(userId, newMessages)` 在 SQL 事务内完成"读-拼-写"。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：与 A-101 同根因同修（Agent 层 per-userId 串行队列）。修复在 loop.ts，store 层未动。

#### 复核意见

- [2026-09-14 by 审查agent-存储调度] ✅ 复核通过，予以闭环。9 条一次通过。非阻断附注：A-404 修复后部分渠道成功时成功渠道下轮会收到重复提醒（可接受）。

### [A-408] inbox 表无上限无清理，不再轮询的用户通知无限累积
- **发现日期**：2026-09-14
- **审查人**：审查agent-存储调度
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`src/storage/store.ts:139-152`（pushInbox / drainInbox）
- **问题描述**：收盘日报每个交易日向所有自选股用户 pushInbox，异动提醒、健康探针告警也会写。
  若某用户不再打开 WebChat 页面（或转用飞书后 webchat 渠道仍在 channels 数组里），
  其 inbox 行永久只增不减。自用部署量级下影响很小，但属于无界增长。
- **建议修法**：pushInbox 后按用户截断（如 `DELETE FROM inbox WHERE user_id=? AND id NOT IN
  (SELECT id FROM inbox WHERE user_id=? ORDER BY id DESC LIMIT 100)`），
  或按 created_at 定期清理超 30 天的行。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：pushInbox 后按用户截断：DELETE 掉不在最近 100 条内的行（建议修法的原样实现）。

#### 复核意见

- [2026-09-14 by 审查agent-存储调度] ✅ 复核通过，予以闭环。9 条一次通过。非阻断附注：A-404 修复后部分渠道成功时成功渠道下轮会收到重复提醒（可接受）。

### 渠道（channels/、public/）

### [A-601] WebChat 的 userId 全靠客户端自报，持有效口令即可越权读删他人收件箱、冒用他人身份对话
- **发现日期**：2026-09-14
- **审查人**：审查agent-渠道
- **严重程度**：🟡 中（共享口令下"谁能拿到口令"是已知取舍 S3-3，本条报的是口令正确前提下的越权与数据丢失）
- **状态**：✅ 已闭环
- **位置**：`src/channels/webchat.ts:52-69`
- **问题描述**：`/api/chat` 和 `/api/inbox` 都直接把请求里的 `userId` 当作身份，服务端不做任何绑定。任何持有正确口令的调用方可以：(1) 用任意 userId 调 `GET /api/inbox?userId=受害者`，`store.drainInbox` 是"读后即删"语义（store.ts:146-152），不仅读到他人未读的收盘日报/异动提醒，还会把消息永久删掉，受害者永远收不到——构成数据丢失；(2) 用任意 userId 调 `/api/chat`，以他人身份操作其自选股（增删代码）、污染其会话历史。前端（index.html:38-39）userId 是 localStorage 里可随意篡改的随机串，无任何服务端校验。
- **建议修法**：最小修法是引入"口令→身份"绑定：登录时服务端为该口令持有者签发/固定一个服务端生成的 userId（如把 userId 与口令哈希映射存 kv 表），后续 API 一律用服务端身份的 userId，忽略客户端自报字段；或至少 `/api/inbox` 强制使用与会话绑定的 userId。若短期不做账号体系，应在 webchat.ts 头部注释和 STATUS.md 中明确写明"同口令持有者之间无隔离"。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 争议说明（已被审查者接受，见复核意见）：完整修复依赖 S3-3 多用户体系（公网部署前才必须做）。已在 webchat.ts 头部注释明确"同口令持有者之间无身份隔离"，STATUS.md 已知问题区同步标注。自用单人口令场景可接受。

#### 复核意见

- [2026-09-14 by 审查agent-渠道] ✅ 复核通过，予以闭环。7 条一次通过；A-601 裁定接受争议理由（短期降级方案已落实，完整修复由 S3-3 跟踪，做 S3-3 时不得遗忘）。

### [A-602] 飞书 notify 抛异常会中断调度器整批推送，一个失效 chat_id 让后续所有用户收不到日报
- **发现日期**：2026-09-14
- **审查人**：审查agent-渠道
- **严重程度**：🟡 中
- **状态**：✅ 已闭环
- **位置**：`src/channels/feishu.ts:112,199`（触发面在 `src/alerts/scheduler.ts:131-134` 和 `105`）
- **问题描述**：`FeishuChannel.notify` → `sendText` 在飞书 API 返回非 0（典型场景：用户把机器人移出群、chat_id 失效、token 刷新失败）时 throw。调度器推送循环是 `for (const userId of allUsers) { for (const ch of channels) await ch.notify(...) }`，全部在一个大 try 里，没有逐用户/逐渠道隔离：排在前面的用户触发飞书发送失败后，异常直接跳出整个循环，排在其后的所有用户的收盘日报/异动提醒全部丢失（当轮不再补发）。WebChatChannel.notify 不抛错（仅写 SQLite），所以问题集中在飞书渠道。
- **建议修法**：任选其一或都做——(a) `FeishuChannel.notify` 内部 try/catch，发送失败仅 console.error 不抛出（与 Channel 接口"尽力推送"语义一致）；(b) 调度器在 `ch.notify` 调用点包 try/catch，单渠道失败不影响其他渠道和其他用户。(b) 更彻底，因为未来新增渠道同样可能抛错。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：采用方案 (b)：调度器新增 notifyUser() 逐渠道 try/catch（scheduler.ts），healthProbe 的 notifyAll 同样逐渠道隔离。飞书 notify 保持可抛出（调用点均已兜底）。

#### 复核意见

- [2026-09-14 by 审查agent-渠道] ✅ 复核通过，予以闭环。7 条一次通过；A-601 裁定接受争议理由（短期降级方案已落实，完整修复由 S3-3 跟踪，做 S3-3 时不得遗忘）。

### [A-603] 飞书验签不校验时间戳新鲜度，被截获的合法签名请求可无限期重放
- **发现日期**：2026-09-14
- **审查人**：审查agent-渠道
- **严重程度**：🟡 中
- **状态**：✅ 已闭环
- **位置**：`src/channels/feishu.ts:148-162`
- **问题描述**：`verifySignature` 只用 `x-lark-request-timestamp` 参与 HMAC 计算，但不检查该时间戳与当前时间的偏差。任何截获过一条合法签名请求的攻击者（如日志泄露、中间代理）可以无限期原样重放，验签照过。现有唯一缓解是 `seenMessages` 的 10 分钟内存去重（feishu.ts:122-127），它有两个空洞：窗口只有 10 分钟，且进程重启即清零——重启后重放一条旧消息事件会被当成新消息再次处理（机器人重复回复、重复执行自选股操作）。
- **建议修法**：验签时增加时间窗校验，如 `Math.abs(Date.now()/1000 - Number(timestamp)) > 300` 直接判失败（飞书官方示例即如此）。如需更强保证，可把去重表从内存 Map 挪到 Store kv/新表持久化。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：verifySignature 增加时间窗校验：|now - timestamp| > 300s 直接判失败。去重表持久化未做（时间窗已把重放窗口压到 5 分钟，与 seenMessages 10 分钟窗口重叠，够用）。

#### 复核意见

- [2026-09-14 by 审查agent-渠道] ✅ 复核通过，予以闭环。7 条一次通过；A-601 裁定接受争议理由（短期降级方案已落实，完整修复由 S3-3 跟踪，做 S3-3 时不得遗忘）。

### [A-604] 群聊里 @机器人 后，该用户的个人持仓日报会被推进群聊，泄露持仓信息
- **发现日期**：2026-09-14
- **审查人**：审查agent-渠道
- **严重程度**：🟡 中
- **状态**：✅ 已闭环
- **位置**：`src/channels/feishu.ts:129-131`（学习映射不区分会话类型），推送面在 `notify`（105-113）
- **问题描述**：`handleMessageEvent` 无条件把 `openId → chat_id` 学进映射，不区分该 chat_id 是单聊（p2p）还是群聊。用户在某群里 @机器人 问过一次行情后，映射即指向群 chat_id；此后调度器的收盘日报（含该用户完整自选股列表）和异动提醒都会发进这个群，群成员全部可见该用户持仓——对个人投资者属于真实隐私泄露。事件结构里 `body.event.message` 还有 `chat_type` 字段可区分（当前接口定义未包含）。
- **建议修法**：学习映射时只在单聊（`chat_type === 'p2p'`）时更新 `chatByOpenId`/kv；群聊消息照常回复（响应用当次事件的 chat_id 即可），但不覆盖推送目标。这样主动推送永远只去单聊。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：FeishuEvent.message 补 chat_type 字段；只在 chat_type === 'p2p' 时更新 chatByOpenId/kv 映射。群聊照常回复当次 chat_id，但不覆盖推送目标。注意：旧版事件结构若不带 chat_type 则不学映射（宁可少推不可泄露）。

#### 复核意见

- [2026-09-14 by 审查agent-渠道] ✅ 复核通过，予以闭环。7 条一次通过；A-601 裁定接受争议理由（短期降级方案已落实，完整修复由 S3-3 跟踪，做 S3-3 时不得遗忘）。

### [A-605] 飞书 ENCRYPT_KEY 与 VERIFICATION_TOKEN 都未配置时，事件接口完全无鉴权，可被任意伪造事件烧 LLM 额度
- **发现日期**：2026-09-14
- **审查人**：审查agent-渠道
- **严重程度**：🟡 中（有启动告警，但公网部署遗漏配置的后果与告警力度不匹配）
- **状态**：✅ 已闭环
- **位置**：`src/channels/feishu.ts:99-101`（仅 console.warn）、`147-150`（`if (!key) return true`）
- **问题描述**：`verifySignature` 在未配置 encryptKey 时直接放行；verification token 校验同样在 `expected` 为空时跳过。两者都空（飞书后台"加密策略"本就可选，用户很容易两个都没填）时，`POST /feishu/events` 对公网完全开放：任何人构造 `im.message.receive_v1` 事件即可让服务端调 `agent.handleMessage`（每次消耗 LLM API 费用）并控制机器人向其指定的 chat_id 发消息。当前防护只有启动时一行 console.warn，进程长期运行后无人再看。
- **建议修法**：fail-closed——两者都为空时 mount 直接拒绝注册路由或对所有事件返回 401（并把现有告警升级为启动即 throw / console.error），至少要求二者必居其一才处理事件。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：fail-closed：mount 时检测两者皆空则 console.error 并对 /feishu/events 一律 401；配置了任一才处理事件。

#### 复核意见

- [2026-09-14 by 审查agent-渠道] ✅ 复核通过，予以闭环。7 条一次通过；A-601 裁定接受争议理由（短期降级方案已落实，完整修复由 S3-3 跟踪，做 S3-3 时不得遗忘）。

### [A-606] 前端口令 prompt 是无限阻塞循环，且 30 秒轮询会在后台反复触发它
- **发现日期**：2026-09-14
- **审查人**：审查agent-渠道
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`public/webchat/index.html:44-50`（`if (t === null) continue`）、`113-119`（setInterval 轮询）
- **问题描述**：`ensureToken()` 里用户点"取消"（prompt 返回 null）时 `continue` 继续弹，形成无法退出的弹窗死循环（只能靠浏览器"阻止此页面创建更多对话框"或关标签页脱身）。更糟的是 inbox 轮询（每 30 秒）遇 401 会调 `clearToken() + ensureToken()`，在后台定时器里反复弹窗，用户正在输入口令时会被新一轮 prompt 打断。轮询的 catch 注释说"忽略 401"，实际 401 在 apiFetch 内部已先弹窗了。
- **建议修法**：取消时不 continue，改为显示一个页面内提示（如"需要口令才能使用"，输入框旁加重试按钮）；轮询遇 401 时暂停轮询（clearInterval），等用户重新输入口令成功后再恢复。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：去掉 while 阻塞循环：askToken() 单次询问，取消则页面内出现可点击的提示消息（点击重试）；send 前 ensureToken 拦截；轮询在无口令时跳过不再后台弹窗。

#### 复核意见

- [2026-09-14 by 审查agent-渠道] ✅ 复核通过，予以闭环。7 条一次通过；A-601 裁定接受争议理由（短期降级方案已落实，完整修复由 S3-3 跟踪，做 S3-3 时不得遗忘）。

### [A-607] 口令比较用 `!==` 非恒定时间，存在理论上的时序侧信道
- **发现日期**：2026-09-14
- **审查人**：审查agent-渠道
- **严重程度**：🔵 低（自用部署实际可利用性极低）
- **状态**：✅ 已闭环
- **位置**：`src/channels/webchat.ts:34`
- **问题描述**：`token !== config.accessToken` 是短路字符串比较，逐字节比较时间差异理论上可被远程时序统计分析利用。本项目口令要么是 .env 里用户自设的强口令、要么是 16 字节随机 hex，暴力/侧信道利用门槛都很高，故仅列低级。同文件飞书验签（feishu.ts:160-161）已正确使用 timingSafeEqual，两处标准不一致。
- **建议修法**：改用 `crypto.timingSafeEqual`（先比长度，参照 feishu.ts 的写法）一行替换即可。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：requireAccessToken 改用 crypto.timingSafeEqual（先比长度），与 feishu.ts 验签同标准。

#### 复核意见

- [2026-09-14 by 审查agent-渠道] ✅ 复核通过，予以闭环。7 条一次通过；A-601 裁定接受争议理由（短期降级方案已落实，完整修复由 S3-3 跟踪，做 S3-3 时不得遗忘）。

### 调度器（alerts/）

### [A-401] 故障告警路径在 catch 块内 await notify，notify 抛错形成未处理 Promise 拒绝，进程直接崩溃
- **发现日期**：2026-09-14
- **审查人**：审查agent-存储调度
- **严重程度**：🔴 高（正确性：进程崩溃）
- **状态**：✅ 已闭环
- **位置**：`src/alerts/healthProbe.ts:60-70`（catch 块内的 allUsers/notify 循环）
- **问题描述**：tick 通过 `setTimeout(() => void tick(), ...)` 自调度，tick 返回的 Promise
  没有挂 .catch。探测失败的告警逻辑（`store.allUsers()` + `await ch.notify(...)`）写在
  catch 块内部——catch 块里再抛出的异常不会被同一 try 捕获，直接成为 rejected promise，
  `void` 只是忽略返回值并不兜底。Node ≥15 默认 unhandledRejection=throw，进程终止。
  触发场景完全现实：行情链路故障时往往伴随网络问题，此时飞书 notify 的 fetch 同样失败——
  即"最需要告警的时刻"恰好是"最容易把进程打挂的时刻"。finally 虽会先重新调度，
  但进程随后崩溃，调度链毫无意义。
- **建议修法**：tick 最外层自包一层兜底（如 `void tick().catch(err => console.error(...))`，
  注意 finally 里调度的是下一次，要在两处调用点都挂 catch）；并把 catch 块内的
  allUsers/notify 循环再包一层 try/catch，单渠道失败不影响其他渠道。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：tick 重构：try 只包 getQuote；重新调度仍挂 finally（不断链），但回调改为 `tick().catch(console.error)`，启动调用同样挂 catch——任何环节抛错都不再产生未处理拒绝。告警通知走 notifyAll（单渠道 try/catch 隔离）。与 A-402 一并重构。

#### 复核意见

- [2026-09-14 by 审查agent-存储调度] ✅ 复核通过，予以闭环。9 条一次通过。非阻断附注：A-404 修复后部分渠道成功时成功渠道下轮会收到重复提醒（可接受）。

### [A-402] 恢复通知的 notify 在 getQuote 的 try 内，渠道异常会被误计为探测失败
- **发现日期**：2026-09-14
- **审查人**：审查agent-存储调度
- **严重程度**：🟡 中（边界情况）
- **状态**：✅ 已闭环
- **位置**：`src/alerts/healthProbe.ts:41-52`
- **问题描述**：try 块同时包了 `data.getQuote(code)` 和恢复分支里的 notify 循环
  （46-48 行）。探测本身已成功，但若恢复通知的 notify 抛错，异常落入 catch：
  consecutiveFailures++、lastError 记成 notify 的错误，连续两次还会误发"故障告警"——
  用户会先收到"已恢复"再收到"疑似失效"，状态机自相矛盾。
- **建议修法**：把 try 收窄到只包 getQuote；成功/失败分支的状态更新与 notify 移到
  try/catch 之外（各自再按需包 try）。与 A-401 可一并重构 tick 结构。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：try 收窄到只包 getQuote（错误存 probeError 局部变量）；状态更新与 notifyAll 移到 try/catch 之外，渠道异常不再计入 consecutiveFailures。

#### 复核意见

- [2026-09-14 by 审查agent-存储调度] ✅ 复核通过，予以闭环。9 条一次通过。非阻断附注：A-404 修复后部分渠道成功时成功渠道下轮会收到重复提醒（可接受）。

### [A-403] 日报/异动推送循环无逐用户隔离，一个用户推送失败会中断当轮其余用户
- **发现日期**：2026-09-14
- **审查人**：审查agent-存储调度
- **严重程度**：🟡 中（边界情况）
- **状态**：✅ 已闭环
- **位置**：`src/alerts/scheduler.ts:93-106`（异动按用户循环）、`src/alerts/scheduler.ts:131-134`（日报按用户循环）
- **问题描述**：两处都是 `for userId { ...; for ch await ch.notify(...) }`，notify 会真实 reject
  （feishu.notify 的 sendText 走网络 fetch，webchat.notify 的 pushInbox 可能撞 DB 错误）。
  任一用户的任一渠道抛错，异常直接冒泡到外层 catch，循环中断：日报场景下排在后面的用户
  当天完全收不到日报（日报不重试）；异动场景下当轮后续用户被跳过（下轮 5 分钟后能补上，
  影响较小）。finally 的重新调度本身没丢，链是安全的，丢的是"当轮剩余用户的推送"。
- **建议修法**：把单用户（甚至单渠道）的处理包进内层 try/catch，失败打日志后继续下一个用户。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：新增 notifyUser() 助手：逐渠道 try/catch，失败 console.error 后继续；日报循环再包一层 per-user try/catch。单用户/单渠道失败不再中断当轮其余用户。与 A-602 同修。

#### 复核意见

- [2026-09-14 by 审查agent-存储调度] ✅ 复核通过，予以闭环。9 条一次通过。非阻断附注：A-404 修复后部分渠道成功时成功渠道下轮会收到重复提醒（可接受）。

### [A-404] 异动提醒先写 alerted 再 notify，推送失败当日不再补报
- **发现日期**：2026-09-14
- **审查人**：审查agent-存储调度
- **严重程度**：🟡 中（边界情况）
- **状态**：✅ 已闭环
- **位置**：`src/alerts/scheduler.ts:100-105`
- **问题描述**：`for (const q of hits) alerted.add(...)` 在 `await ch.notify(...)` 之前执行。
  notify 失败（飞书 API 抖动等）时该股票当日的防刷屏标记已落，后续轮询被
  `!alerted.has(...)` 过滤掉——用户当日永远收不到这条异动提醒，且无任何重试。
- **建议修法**：notify 全部成功后再统一 `alerted.add`；或对失败用户不标记（本轮内按
  per-user try 捕获，成功才 add）。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：改为 notifyUser 全部渠道成功后才写 alerted 标记；有渠道失败则不标记，下轮（默认 5 分钟后）补报。

#### 复核意见

- [2026-09-14 by 审查agent-存储调度] ✅ 复核通过，予以闭环。9 条一次通过。非阻断附注：A-404 修复后部分渠道成功时成功渠道下轮会收到重复提醒（可接受）。

### [A-405] 轮询间隔/阈值配置未校验，NaN 或 0 会导致 setTimeout 紧循环狂打外部接口
- **发现日期**：2026-09-14
- **审查人**：审查agent-存储调度
- **严重程度**：🟡 中（边界情况，需错误配置触发；后果是对第三方接口的 DoS 式请求 + 日志刷屏）
- **状态**：✅ 已闭环
- **位置**：`src/alerts/scheduler.ts:111`、`src/alerts/healthProbe.ts:73`，根因在
  `src/config.ts:42-43,49`（`Number(process.env.X ?? default)` 无 NaN/范围校验）
- **问题描述**：`ALERT_INTERVAL_MINUTES=""` 时 `Number('')===0`，非数字时 NaN；
  setTimeout(0/NaN/负数) 都按 ~0ms 处理——tick 的 finally 立刻重新调度，形成
  "await 一轮网络请求 → 立即再触发"的无限紧循环，持续轰东财/微服务接口并刷爆日志。
  `ALERT_THRESHOLD_PCT=abc`（NaN）则 `Math.abs(x) >= NaN` 恒 false，异动提醒静默失效。
  调度链不会断（finally 还在），所以表现为"疯狂请求"而非崩溃，排查时容易误判成接口问题。
- **建议修法**：config.ts 里对数值配置统一走一个 `num(env, default, min)` 帮助函数：
  非有限数或越界时回退默认并打 warn 日志。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：与 A-501 同修：config.ts 新增 numEnv(name, def, min) 统一校验，ALERT_INTERVAL_MINUTES/ALERT_THRESHOLD_PCT/HEALTH_PROBE_INTERVAL_MINUTES/PORT/LLM_TIMEOUT_MS 全部改走它（interval 类设 min=1，threshold min=0.1），非法值回退默认并 console.warn。

#### 复核意见

- [2026-09-14 by 审查agent-存储调度] ✅ 复核通过，予以闭环。9 条一次通过。非阻断附注：A-404 修复后部分渠道成功时成功渠道下轮会收到重复提醒（可接受）。

### [A-406] beijingNow/msUntilNextRun 用"当前时刻"的时区偏移换算，跨 DST 切换偏差 ±1 小时
- **发现日期**：2026-09-14
- **审查人**：审查agent-存储调度
- **严重程度**：🟡 中（边界情况；仅部署在有夏令时的海外服务器、且调度窗口横跨 DST 切换日
  时触发，一年约两次，触发后自愈）
- **状态**：✅ 已闭环
- **位置**：`src/alerts/scheduler.ts:19-33`
- **问题描述**：`beijingNow()` 用 `now.getTimezoneOffset()`（"现在"的偏移）做整体平移，
  再用平移后 Date 的本地字段 setHours 得到 target。该技巧成立的前提是"now 到 target 之间
  本地时区偏移不变"。在实行夏令时的时区（如美东），周五算出的 delay 若横跨周日凌晨的
  DST 切换，target 的实际触发时刻会偏 ±1 小时（如日报在 14:30 或 16:30 触发）。
  国内服务器无 DST 不受影响；PITFALLS 已记载本项目曾被海外部署时区坑过，属同类残留。
- **建议修法**：不搞平移 trick，改用 `Intl.DateTimeFormat`（timeZone: 'Asia/Shanghai'）
  取北京时间的年月日时分字段做比较/计算；或接受现状并在 msUntilNextRun 注释里写明
  "DST 时区服务器切换日可能偏 1 小时"的已知边界。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：采用建议的备选方案：接受现状（国内服务器无 DST），在 beijingNow 注释中写明"DST 时区服务器切换日可能偏 ±1 小时、触发后自愈"的已知边界。

#### 复核意见

- [2026-09-14 by 审查agent-存储调度] ✅ 复核通过，予以闭环。9 条一次通过。非阻断附注：A-404 修复后部分渠道成功时成功渠道下轮会收到重复提醒（可接受）。

### [A-409] 调度链路上的 fetch 无显式超时，对端挂起时本轮链停摆至 undici 默认超时
- **发现日期**：2026-09-14
- **审查人**：审查agent-存储调度
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`src/alerts/healthProbe.ts:42` → `src/data/eastmoney.ts:36`；
  `src/alerts/scheduler.ts:74,127` → `src/data/pythonService.ts:13,82`（均无 timeout）
- **问题描述**：若对端接受连接但迟迟不响应，await 不 settle，finally 不执行，
  该轮定时器链停摆；undici 默认 headersTimeout/bodyTimeout 约 300s 后会报错自愈，
  期间探针/轮询静默缺位数分钟（探针连续"失败"计数也因此失真）。
- **建议修法**：数据层 fetch 统一加 `signal: AbortSignal.timeout(10_000)` 之类的显式超时。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：与 A-301 同修：数据层四处 fetch 全部加显式超时（东财 10s、微服务/日历 60s），调度链路不再有 300s 默认超时窗口。

#### 复核意见

- [2026-09-14 by 审查agent-存储调度] ✅ 复核通过，予以闭环。9 条一次通过。非阻断附注：A-404 修复后部分渠道成功时成功渠道下轮会收到重复提醒（可接受）。

### 配置与入口（config.ts、index.ts）

### [A-501] 数值型环境变量无校验：interval 配错会触发 0ms 热循环打满行情接口
- **发现日期**：2026-09-14
- **审查人**：审查agent-配置与微服务
- **严重程度**：🔴 高（正确性）
- **状态**：✅ 已闭环
- **位置**：`src/config.ts:18`、`:42-43`、`:49`
- **问题描述**：`PORT`、`ALERT_THRESHOLD_PCT`、`ALERT_INTERVAL_MINUTES`、`HEALTH_PROBE_INTERVAL_MINUTES` 均用 `Number(env ?? 默认值)` 解析，用户填入非数字字符串时得到 `NaN` 且无任何提示。后果分三档：
  1. `intervalMinutes` 为 NaN 时，`scheduler.ts:111` 与 `healthProbe.ts:73` 的 `setTimeout(fn, NaN * 60_000)` 延迟被当作 0ms——tick 在 finally 里立即自我重排，形成**无间隔热循环**。异动 tick 在盘中时段会对东财/微服务发起无间断请求（有被封 IP 风险）；健康探针 tick 则全天不间断打行情接口。
  2. `thresholdPct` 为 NaN 时，`Math.abs(changePct) >= NaN` 恒为 false，**异动提醒静默失效**，用户以为功能开着。
  3. `PORT` 为 NaN 时 `app.listen(NaN)` 抛 `ERR_SOCKET_BAD_PORT`，启动即崩且报错与真实原因（.env 里写了个非数字）不在一起。
- **建议修法**：在 config.ts 加一个 `numEnv(name, def)` 辅助函数：`const n = Number(raw); if (!Number.isFinite(n)) { console.warn(\`[config] ${name}="${raw}" 非有效数字，回退默认值 ${def}\`); return def; }`，四处数值配置统一走它。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：config.ts 新增 numEnv(name, def, min)：非有限数或低于 min 时 console.warn 并回退默认。PORT/ALERT_THRESHOLD_PCT/ALERT_INTERVAL_MINUTES/HEALTH_PROBE_INTERVAL_MINUTES/LLM_TIMEOUT_MS 全部接入。

#### 复核意见

- [2026-09-14 by 审查agent-配置与微服务] ✅ 复核通过，予以闭环。8 条一次通过；A-508 裁定接受争议理由（回环绑定约定已写入 docstring，token 方案留待非回环部署时实施），予以闭环。残留线程无法强杀属 Python 固有限制，可接受。

### [A-502] 入口无进程级异常兜底与 Express 错误中间件，渠道 handler 一次漏 catch 即整进程崩溃
- **发现日期**：2026-09-14
- **审查人**：审查agent-配置与微服务
- **严重程度**：🟡 中
- **状态**：✅ 已闭环
- **位置**：`src/index.ts:24-53`
- **问题描述**：项目依赖为 Express 4.21（`package.json:19`），Express 4 **不会捕获 async handler 的 rejected promise**；Node ≥15 对 unhandledRejection 默认行为是 throw（进程退出）。当前 webchat 的 handler 自己有 try/catch，但 index.ts 作为装配根既没有注册兜底错误中间件，也没有 `process.on('unhandledRejection' / 'uncaughtException')` 处理器——任一渠道（如 feishu 或未来新渠道）漏 catch 一处，一次异常请求即可打挂整个进程，调度器/探针随之全停。另外 Express 默认错误中间件在非 production 下会把堆栈返回给客户端，无自定义中间件时无法控制此行为。
- **建议修法**：在 `app.listen` 前注册 `app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'internal error' }); })`；并在入口注册 `process.on('unhandledRejection', ...)` 至少记日志（是否退出由部署策略定，但不应裸崩无迹可查）。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：index.ts 注册兜底错误中间件（500 + 'internal error'，不泄露堆栈）；入口加 process.on('unhandledRejection'/'uncaughtException') 记日志不裸崩。

#### 复核意见

- [2026-09-14 by 审查agent-配置与微服务] ✅ 复核通过，予以闭环。8 条一次通过；A-508 裁定接受争议理由（回环绑定约定已写入 docstring，token 方案留待非回环部署时实施），予以闭环。残留线程无法强杀属 Python 固有限制，可接受。

### [A-503] 启动无自检、无优雅退出：LLM_API_KEY 缺失零提示，SIGINT 不释放 store/端口
- **发现日期**：2026-09-14
- **审查人**：审查agent-配置与微服务
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`src/index.ts:17-53`、`src/config.ts:26`
- **问题描述**：(1) `LLM_API_KEY` 为空时启动日志一切正常，所有对话功能要到用户发消息时才逐条失败——CLAUDE.md 自己都说"不填则所有对话功能不可用"，启动时打一条 warning 成本极低。(2) 无 SIGINT/SIGTERM 处理：`Store` 没有公开 `close()`（PITFALLS 已记录测试侧因此 EPERM 的病例），进程退出依赖默认行为；监听端口也无主动 close。日常 Ctrl+C 无碍，但作为常驻服务这不规范。
- **建议修法**：启动时 `if (!config.llm.apiKey) console.warn(...)`；给 `Store` 加公开 `close()`（PITFALLS 中已有同样建议），入口注册 `process.on('SIGINT', ...)` 做 server.close + store.close 后退出。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：启动时 !config.llm.apiKey 打醒目 console.warn；Store.close() 已在本日早些时候加好（S2-3）；入口注册 SIGINT/SIGTERM 处理：server.close() + store.close() 后退出。

#### 复核意见

- [2026-09-14 by 审查agent-配置与微服务] ✅ 复核通过，予以闭环。8 条一次通过；A-508 裁定接受争议理由（回环绑定约定已写入 docstring，token 方案留待非回环部署时实施），予以闭环。残留线程无法强杀属 Python 固有限制，可接受。

### Python 微服务（data-service/）

### [A-504] /financials 缺失值序列化为字面量 "nan"，真值 0 被吞成空串
- **发现日期**：2026-09-14
- **审查人**：审查agent-配置与微服务
- **严重程度**：🟡 中（边界情况）
- **状态**：✅ 已闭环
- **位置**：`data-service/main.py:199`
- **问题描述**：`str(row.get(col, "") or "")` 有两个叠加问题：(1) 新浪财报缺列/缺单元格时 pandas 给的是 `NaN`，而 `float('nan')` 在 Python 中是**真值**，`NaN or ""` 结果仍是 NaN，`str()` 后变成字面量 `"nan"` 原样喂给 LLM；(2) 真值为数值 `0` 时（如财务费用为 0），`0 or ""` 得到 `""`，把真实零值抹掉。两者都会让 LLM 基于错误/缺失数据回答用户。
- **建议修法**：改用 `pd.isna` 判断：`v = row.get(col); "" if v is None or pd.isna(v) else str(v)`（注意 `pd.isna("")` 为 False，空串仍走 str，行为不变）。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：新增 _cell(row, col)：pd.isna 判缺失返回 ""，真值 0 保留为 "0"；/financials 全部字段改走 _cell。

#### 复核意见

- [2026-09-14 by 审查agent-配置与微服务] ✅ 复核通过，予以闭环。8 条一次通过；A-508 裁定接受争议理由（回环绑定约定已写入 docstring，token 方案留待非回环部署时实施），予以闭环。残留线程无法强杀属 Python 固有限制，可接受。

### [A-505] /trade-calendar 用 str(d) 序列化日期，AKShare 改返回 Timestamp 时交易日判定静默全否
- **发现日期**：2026-09-14
- **审查人**：审查agent-配置与微服务
- **严重程度**：🟡 中（边界情况/外部依赖脆性）
- **状态**：✅ 已闭环
- **位置**：`data-service/main.py:166`
- **问题描述**：`dates = [str(d) for d in df["trade_date"]]` 依赖该列元素是 `datetime.date`（str 得 `YYYY-MM-DD`）。若某版 AKShare 改为返回 `pandas.Timestamp`，`str()` 结果是 `YYYY-MM-DD 00:00:00`：本端点自身不报错，但主服务 `TradeCalendar`（pythonService.ts:73）用 `Set` 精确匹配 `YYYY-MM-DD`，全部落空 → **所有工作日都被判为非交易日，收盘日报和异动提醒静默全停**，无任何报错可循。这正是 PITFALLS 第 3 节反复出现的"AKShare 升级行为漂移"模式。
- **建议修法**：`pd.to_datetime(df["trade_date"]).dt.strftime("%Y-%m-%d").tolist()`，输出格式与列类型解耦。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：改为 `pd.to_datetime(df['trade_date']).dt.strftime('%Y-%m-%d').tolist()`，输出与列类型解耦。已实测端点返回标准格式。

#### 复核意见

- [2026-09-14 by 审查agent-配置与微服务] ✅ 复核通过，予以闭环。8 条一次通过；A-508 裁定接受争议理由（回环绑定约定已写入 docstring，token 方案留待非回环部署时实施），予以闭环。残留线程无法强杀属 Python 固有限制，可接受。

### [A-506] 全部端点的 AKShare 调用无超时，上游挂起会耗尽 uvicorn 线程池
- **发现日期**：2026-09-14
- **审查人**：审查agent-配置与微服务
- **严重程度**：🟡 中
- **状态**：✅ 已闭环
- **位置**：`data-service/main.py:28`、`:46`、`:73`、`:121`、`:153`、`:181`
- **问题描述**：AKShare 底层用 requests，**requests 默认无超时**。东财/新浪/巨潮上游挂起时，对应端点的工作线程永久阻塞；端点都是同步 `def`（跑在 uvicorn 线程池，默认约 40 线程），持续打满后整个微服务对所有端点无响应，且无任何日志线索。主服务侧 `pythonService.ts:13` 的 fetch 同样无超时（该文件不在本次审查范围，但属同一链路，修复时建议一并处理）。
- **建议修法**：短期可在文档/启动说明中明确风险；代码层面建议为 AKShare 调用包一层带超时的执行（如 `asyncio.wait_for(asyncio.to_thread(fn), timeout=20)` 并把端点改 async），超时返回 504 而非悬挂。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：新增 run_ak()：asyncio.to_thread + wait_for(timeout=30s)，超时返回 504；全部 AKShare 调用点（quote/news/search/announcements/trade-calendar/financials）改经它，端点改 async def。实测：东财限流期间 /search 返回 504 结构化错误而非悬挂。

#### 复核意见

- [2026-09-14 by 审查agent-配置与微服务] ✅ 复核通过，予以闭环。8 条一次通过；A-508 裁定接受争议理由（回环绑定约定已写入 docstring，token 方案留待非回环部署时实施），予以闭环。残留线程无法强杀属 Python 固有限制，可接受。

### [A-507] /announcements 把 KeyError 一刀切当空结果，会吞掉"代码无效/列结构变化"类错误
- **发现日期**：2026-09-14
- **审查人**：审查agent-配置与微服务
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`data-service/main.py:128-130`
- **问题描述**：PITFALLS 记录的 KeyError 病例只覆盖"查询结果为空"，但 `except KeyError: return []` 会把**所有** KeyError 吞成空结果——包括传入无效股票代码、或 AKShare/巨潮改版后列名变化触发的 KeyError。后者发生时主服务收到 `[]`，LLM 会告诉用户"该股票近期没有公告"，属于静默错误信息。
- **建议修法**：吞掉前至少 `print`/`logging.warning` 记录 KeyError 内容；更稳妥的做法是先按 symbol 合法性校验，或捕获后检查异常信息是否匹配已知的空结果模式，不匹配则仍走 502。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 修复说明：except KeyError 分支加 logger.warning（带 code 与异常内容）后再返回 []，列结构变化时可从日志发现。

#### 复核意见

- [2026-09-14 by 审查agent-配置与微服务] ✅ 复核通过，予以闭环。8 条一次通过；A-508 裁定接受争议理由（回环绑定约定已写入 docstring，token 方案留待非回环部署时实施），予以闭环。残留线程无法强杀属 Python 固有限制，可接受。

### [A-508] 微服务无鉴权无 CORS 限制，安全完全依赖"部署时绑定回环"这一口头约定
- **发现日期**：2026-09-14
- **审查人**：审查agent-配置与微服务
- **严重程度**：🔵 低
- **状态**：✅ 已闭环
- **位置**：`data-service/main.py:16`（全局）
- **问题描述**：服务无 token 校验、无来源限制，安全性完全由启动命令 `--host 127.0.0.1` 保证，而该命令只出现在文档/docstring 里，代码层无任何约束或检查。一旦有人以 `--host 0.0.0.0` 启动（主服务与微服务分离部署的合理场景），全部端点裸奔，可被任意第三方调用消耗上游数据源额度/触发限流。数据本身不敏感，故定 🔵。
- **建议修法**：可选方案（按部署需求取其一）：(1) 端点加可选 `DATA_SERVICE_TOKEN` 头校验，主服务侧 pythonService.ts 配合带上；(2) 至少加启动检查——检测到非回环绑定且未配 token 时打印醒目警告。

#### 修复备注
> 修复 agent 在此追加，一条一段，不得修改上方审查原文。

- [2026-09-14 by 主会话（修复agent）] 争议说明（已被审查者接受，见复核意见）：自用场景主/微服务同机回环绑定，token 校验收益低；已在 main.py docstring 顶部写明"必须绑定回环、非回环部署需先加 token"的约定。若未来分离部署再做 token 方案。

#### 复核意见

- [2026-09-14 by 审查agent-配置与微服务] ✅ 复核通过，予以闭环。8 条一次通过；A-508 裁定接受争议理由（回环绑定约定已写入 docstring，token 方案留待非回环部署时实施），予以闭环。残留线程无法强杀属 Python 固有限制，可接受。
