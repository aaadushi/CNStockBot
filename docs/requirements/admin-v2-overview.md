# REQ-Admin-V2：管理后台扩展——用户总览 + 运行概览

> 需求文档（2026-10-11）。本文件是后续代码审计、功能验收、回归测试的基准。
> 对应 STATUS「四、其他候选方向」第 8 条（管理后台）的第二个切片：
> 第 7 条（反馈查看）已随 REQ-Feedback-Admin 交付，本次交付"用户总览 + 运行概览"。

## 背景与目标

- 项目目标为公网发布给别人使用，管理员需要**最小必要的运行与用户观测能力**：
  现在除了反馈列表，对用户规模、用户活跃、服务与数据链路状态一无所知，
  出了问题只能登服务器看日志。
- 目标：在 /admin 管理页新增两个**只读**区块——
  1. **运行概览**：构建信息（版本/git sha/启动时间）、data-service 连通性、
     行情健康探针状态、各定时任务开关与预计下次运行时间；
  2. **用户总览**：用户列表（用户名/注册时间/最近活跃/自选股数/监控规则数/
     反馈数）+ 用户总数。
- 复用 REQ-Feedback-Admin 已落地的管理员体系（requireAdmin + ADMIN_USERS），
  不新增鉴权概念。

## 范围

### 做

1. `GET /api/admin/overview`：构建信息 + dataService 探测（复用 health.ts 的
   缓存探测器）+ quoteProbe 状态 + 调度任务开关（收盘日报/异动提醒/盘前外盘/
   盘后扫描更新）与按工作日估算的预计下次运行时间。
2. `GET /api/admin/users`：全用户聚合统计列表（倒序），含用户总数。
3. store 层聚合查询：每用户 自选只数/规则数/反馈数/最近活跃
   （会话创建与会话更新取大），单条 SQL 关联 users 表完成。
4. /admin 前端：新增"运行概览""用户总览"两个区块（现有"意见反馈"保留），
   60s 自动刷新 + 手动刷新；403 逐区块显示"无权访问"。
5. 测试：API 层 401/403/聚合正确性/字段白名单；fail-closed 用例补进
   feedback-admin-unset.test.ts。

### 不做（明确排除）

- **不做推送任务运行状态/历史**（成功失败次数、上次推送时间等）——需要给
  调度器加运行时埋点，独立批次再做；本次只给"开关 + 预计下次运行"。
- 不做任何写操作：不支持禁用用户、清空数据、代发推送、重置密码。
- 不展示任何消息内容：会话历史、收件箱正文、反馈正文（反馈正文留在反馈区块）
  均不进用户总览。
- 不展示 userId（UUID）、会话 token/hash、密码哈希——隐私最小化，
  用户名 + 聚合数字足够运营判断。
- 不收集/展示 UA/IP/设备信息。
- 不做注册速率统计图表、活跃度趋势（本次只要当前快照）。
- 不在任何页面（含 App 壳）加 /admin 的入口链接。
- 不给 LLM 暴露任何管理端能力（管理端不进技能清单）。

## 功能需求

- FR-1 两个新端点均挂在 `app.use('/api', requireSession)` 之后、
  以 `requireAdmin(config.adminUsernames)` 鉴权；未登录 401、非管理员 403、
  ADMIN_USERS 空集合 fail-closed（与 /api/admin/feedback 同一门槛）。
- FR-2 `GET /api/admin/overview` 响应：
  `{ version, gitSha, startedAt, dataService, quoteProbe, scheduler }`。
  - `dataService` 复用 `getDataServiceStatus()`（30s 缓存 + 3s 超时，
    不新增探测压力）；
  - `quoteProbe` 复用 `getHealthProbeStatus()`；
  - `scheduler` 含四个任务：`dailyReport`（enabled 恒 true + signals 开关 +
    nextRunInMs）、`priceAlerts`（enabled/intervalMinutes/thresholdPct，
    nextRunInMs 为 null——轮询循环无固定时刻）、`overseasPush`（enabled 为
    false 时 nextRunInMs 为 null）、`scannerUpdate`（enabled/push/nextRunInMs）。
  - nextRunInMs 用现有 `msUntilNextRun(hour, minute)` 计算（只跳周末的
    工作日估算，法定节假日触发时调度器自动跳过，前端标注"估算"）。
- FR-3 `GET /api/admin/users` 响应 `{ items, total }`；items 按注册时间
  倒序，每条形如 `{ username, createdAt, lastActiveAt, lastActiveAt 为 null,
  watchlistCount, ruleCount, feedbackCount }`；`lastActiveAt` = 该用户
  会话最近创建时间（histories.updated_at 不在此口径内，避免把"存了一条
  历史"当成活跃——见审计要点）；无任何活跃记录时为 null。
- FR-4 store 聚合查询单条 SQL（users LEFT JOIN 相关子查询 COUNT/MAX），
  全表行数 = users 表行数（公网 Beta 初期量级，无分页；users 表爆炸增长
  属于运营层面问题，超 500 行时再加 limit——本次加 LIMIT 500 封顶防御）。
- FR-5 /admin 前端三个区块并列（F 型布局：h1 页标题 + h2 区块标题）；
  每区块独立 403/错误态；60s 轮询三个端点（feedback 沿用既有逻辑）。
- FR-6 前端只读渲染：所有动态文本 textContent；只用 Chrome 83 可用 API
  （无 replaceChildren 以外的 86+ API；compat.js 已 polyfill）。

## 非功能需求

- typecheck + npm test 全绿；新增测试不少于 8 条。
- 不破坏现有行为：/api/admin/feedback 契约不变，其余 9 页零改动。
- dataService 探测复用缓存探测器，管理页 60s 轮询不增加微服务压力。
- 前端结构测试（frontend-pages）不回归。

## 数据模型 / API / 前端改动

**store.ts（无新表，只读聚合）**

- `export interface UserStatEntry { username; createdAt; lastActiveAt: number | null;
  watchlistCount; ruleCount; feedbackCount }`
- `countUsers(): number`
- `listUserStats(): UserStatEntry[]`：SQL 形如
  `SELECT u.username, u.created_at,
     (SELECT COUNT(*) FROM watchlists w WHERE w.user_id=u.id),
     (SELECT COUNT(*) FROM alert_rules r WHERE r.user_id=u.id),
     (SELECT COUNT(*) FROM feedback f WHERE f.user_id=u.id),
     (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id=u.id)
   FROM users u ORDER BY u.created_at DESC LIMIT 500`

**API（webchat.ts，照 /api/admin/feedback 模式）**

- `GET /api/admin/overview`（requireAdmin）：组装 health.ts / healthProbe.ts /
  scheduler.ts（msUntilNextRun）的现有导出 + config 调度开关。
- `GET /api/admin/users`（requireAdmin）：`{ items: store.listUserStats(),
  total: store.countUsers() }`。

**前端（public/admin/index.html）**

- h1 "管理后台"下三个 h2 区块：运行概览（键值卡片：版本/gitSha/启动时间/
  dataService 状态与延迟/探针状态/四个任务行：名称+开关+参数+预计下次）、
  用户总览（总数 + 表格：用户名/注册时间/最近活跃/自选/规则/反馈；
  lastActiveAt 为 null 显示"—"）、意见反馈（现有实现原样保留）。
- 三个区块共用一个 load()，分别请求三个端点；403 分区块显示"无权访问"。

## 验收标准

1. 管理员登录 /admin → 三个区块都有数据；非管理员 → 三个区块均显示
   "无权访问"，网络面板无数据返回；未登录 → 登录浮层。
2. 运行概览的 dataService 状态与直接 curl /health 的 dataService 一致；
   任务开关与 .env 配置一致（改 OVERSEAS_PUSH_ENABLED 重启后可见）。
3. 注册两个用户、给其中一个加自选/规则/反馈 → 用户总览数字正确、
   按注册时间倒序；新注册无活跃的用户 lastActiveAt 显示"—"。
4. curl 两个新端点：无 token 401、非管理员 token 403、管理员 200。
5. `npm run typecheck` + `npm test` 全绿。

## 审计要点

- 两个新端点必须服务端 requireAdmin（静态页可公开，数据接口不可）；
  ADMIN_USERS 为空时一律 403。
- 用户总览响应字段白名单：不得包含 userId/token/hash/消息内容/密码相关
  字段（测试断言 Object.keys 精确集合）。
- listUserStats 全表 LIMIT 500 封顶，防超大表拖垮管理页。
- 活跃口径必须写清：lastActiveAt 取 sessions.created_at 最大值（最近一次
  登录），不含 histories.updated_at——避免"打开过页面但只读了历史"被计为
  活跃，也避免会话表清理后活跃归零的争议。
- overview 不得绕过 getDataServiceStatus 的缓存直连微服务（探测压力）。
- /admin 前端不得引入 innerHTML 拼接任何接口返回文本。
