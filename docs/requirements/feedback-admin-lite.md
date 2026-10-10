# REQ-Feedback-Admin：意见反馈功能 + 最小管理端

> 需求文档（2026-10-10）。本文件是后续代码审计、功能验收、回归测试的基准。
> 对应 STATUS「四、其他候选方向」第 7 条（意见反馈，入口指定在聊天页"刷新"那一块）
> 与第 8 条（管理后台）的最小合做切片：只做"反馈提交 + 管理员查看反馈列表"。

## 背景与目标

- 项目目标为公网发布给别人使用，陌生用户遇到问题时**没有任何渠道联系运营方**。
- 目标：用户在聊天页一键提交意见反馈（文本 + 选填联系方式）；运营方（管理员）
  通过仅自己知道地址的管理页查看反馈列表。
- 用户明确指定的形态：**网页和 App 里都没有进入管理页的入口链接**，只能手动
  输入特定地址（/admin）；进入后必须输入账号和密码（复用现有登录体系），
  非管理员账号看不到任何反馈数据。

## 范围

### 做

1. 聊天页（/webchat）页头新增"反馈"按钮（与退出按钮同款导航样式），点击弹窗：
   反馈文本（必填，1~2000 字）、联系方式（选填，≤100 字），提交后弹窗内显示
   成功确认，失败显示错误原因。
2. 服务端反馈存储：新表 `feedback`，按用户隔离、每用户保留最近 200 条
   （增长有界，模式同 inbox 的 100 条封顶）。
3. 管理员体系（最小实现）：`ADMIN_USERS` 环境变量（逗号分隔用户名）声明管理员；
   users 表**不加列**（无迁移，改配置即生效）；新增 `requireAdmin` 中间件，
   挂在 requireSession 之后做服务端鉴权。
4. 管理页 /admin（public/admin/，静态页本身不鉴权——与全站一致，数据全靠 API
   层鉴权）：登录（复用 CNStockAuth 登录浮层）→ 拉取反馈列表（时间倒序，
   含用户名/时间/联系方式/文本）；非管理员显示"无权访问"。
5. 测试：store 层 + API 层（含 401/403 隔离、参数校验、管理员列表）。

### 不做（明确排除）

- **不做完整管理后台**（用户列表/活跃度/推送任务状态/访问统计等）——
  第 8 条的其余内容仍是独立候选方向，本次只交付"反馈查看"这一个管理端切片。
- 不在任何页面（含 App 壳）加 /admin 的入口链接或跳转。
- 不做反馈的回复/流转状态（已读、处理中、已解决）、邮件通知、Webhook。
- 不收集 UA/IP/设备信息（隐私最小化，只存用户名快照 + 用户填的内容）。
- 不做匿名反馈（API 在 requireSession 之后，必须登录）。
- 不做聊天技能（这是纯 UI 功能，不进 LLM 工具清单）。
- 不做管理员的增删 UI（改 .env 的 ADMIN_USERS 即可）。

## 功能需求

- FR-1 聊天页页头"反馈"按钮：未登录点击时由 apiFetch 自然弹登录浮层，
  登录成功后提交链路继续；弹窗内所有用户可见文本走 textContent/createElement
  （不拼 innerHTML，红线同全站）。
- FR-2 提交校验（服务端为准）：text 去除首尾空白后 1~2000 字；
  contact 去除首尾空白后 ≤100 字（可空）；超限或为空返回 400 带中文错误。
- FR-3 防滥用：每用户反馈条数上限 200（达到后最旧的被删除，模式同 inbox；
  单用户不可能撑爆库）。不引入 IP 级限流（已登录 + 条数封顶足够）。
- FR-4 管理员判定：请求处理时实时查 `config.adminUsernames`
  （Set，模块加载时从环境变量解析一次）；非管理员访问 /api/admin/* 一律 403
  `{ error: '无权访问：需要管理员账号' }`。
- FR-5 反馈列表：`GET /api/admin/feedback?limit=`，limit 收敛 1..200、缺省 100；
  返回 `{ items, total }`，items 按 created_at 倒序。
- FR-6 管理页加载流程：无 token → showAuthOverlay → 登录后自动加载；
  有 token → 直接加载；403 → 页面显示"当前账号不是管理员"且无任何数据渲染；
  60s 自动刷新 + 手动刷新按钮（节奏同消息中心）。
- FR-7 ADMIN_USERS 未配置时：adminUsernames 为空 Set，无人是管理员，
  /api/admin/feedback 对所有人 403（fail-closed，不误放行）。

## 非功能需求

- 前端新代码只用 Chrome 83 可用 API（安卓壳 WebView 下限，见 PITFALLS 第 7 节）；
  显隐浮层用 hidden 属性。
- 全链路（存储、API、渲染）不信任用户输入：SQLite 参数化 + 渲染 textContent。
- 不破坏现有行为：inbox drain 语义、聊天链路、其余 9 页零改动（除 webchat 页头加一个按钮）。
- typecheck + npm test 全绿；新增测试不少于 8 条。

## 数据模型 / API / 前端改动

**表（store.ts，CREATE TABLE IF NOT EXISTS）**

```sql
feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,          -- 提交时用户名快照
  text TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)
-- 索引：CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at)
```

store 新方法：`pushFeedback(userId, username, text, contact)`（含每用户 200 条封顶
DELETE，模式照抄 pushInbox store.ts:193-203）、`listFeedback(limit)`
（倒序，行→FeedbackEntry { id, userId, username, text, contact, createdAt }）、
`countFeedback()`（管理员 total 用）。

**API（webchat.ts，均挂在 app.use('/api', requireSession) 之后）**

- `POST /api/feedback`：body `{ text, contact? }`；校验失败 400；成功 `{ ok: true, id }`。
- `GET /api/admin/feedback`：`requireAdmin(config.adminUsernames)`；limit 收敛；
  `{ items, total }`。
- `app.use('/admin', express.static(ADMIN_ROOT))`（照 INBOX_ROOT 模式 webchat.ts:100）。

**中间件/配置**

- `src/auth/middleware.ts` 新增 `requireAdmin(adminUsernames: ReadonlySet<string>)`
  工厂：req.user 缺失 401、username 不在集合 403。
- `src/config.ts` 新增 `adminUsernames: Set<string>`（ADMIN_USERS 逗号分隔、
  去空白、忽略空段）；`.env.example` 加注释。

**前端**

- `public/webchat/index.html`：页头加 `<button class="nav btn-ghost" id="feedback-btn">反馈</button>`
  （logout-btn 之前）；新增反馈弹窗（复用 .auth-overlay/.auth-card 样式，
  DOM 全 createElement + textContent）。
- 新增 `public/admin/index.html`：最小页头（brand + "管理后台" + 退出按钮，无导航链接）、
  反馈列表卡片（复用 inbox 页 .msg-item 结构风格）。

## 验收标准

1. 登录用户在聊天页点"反馈"→ 填文本提交 → 弹窗显示成功；空文本/超长返回明确错误。
2. 未登录点"反馈"→ 弹登录浮层 → 登录后可正常提交。
3. 非管理员登录访问 /admin → 页面显示"不是管理员"；直接 curl
   `GET /api/admin/feedback` 带非管理员 token → 403。
4. ADMIN_USERS 配置的用户登录 /admin → 看到全部用户反馈（倒序、含用户名）；
   未配置 ADMIN_USERS 时任何账号 403。
5. `npm run typecheck` + `npm test` 全绿；前端结构测试（frontend-pages）不回归。

## 审计要点

- requireAdmin 必须服务端鉴权（不能只在前端隐藏入口）；静态 /admin 页可公开访问，
  但不得在无有效管理员 session 时渲染任何反馈数据。
- 反馈文本在存（参数化绑定）与显（textContent）两侧都不得有可注入路径；
  弹窗实现禁止 innerHTML 拼接用户可控文本。
- ADMIN_USERS 为空时 fail-closed（无人可访问管理 API）。
- 管理 API 不得接受任何按用户过滤参数而变成"任意用户查他人反馈"的越权面
  （本设计管理端本来就是跨用户视图，唯一门槛是 requireAdmin）。
- /webchat 改动不得触碰 drain 轮询、JS 桥接、md-bold 渲染器既有行为。
