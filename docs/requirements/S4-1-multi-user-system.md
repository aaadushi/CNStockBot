# 需求文档：S4-1 多用户体系

> **文档编号**：REQ-S4-1  
> **对应路线**：S4 公网发布前置 → S4-1  
> **解决审计问题**：[A-601](../AUDIT.md) WebChat 的 userId 全靠客户端自报，持有效口令即可越权读删他人收件箱、冒用他人身份对话  
> **目标读者**：下一个实现 agent / 代码审查 agent  
> **状态**：待实现

---

## 1. 背景与目标

### 1.1 背景

当前 WebChat 使用单一共享 `ACCESS_TOKEN` 做 API 鉴权，`userId` 由客户端（localStorage）自报。服务端对 `userId` 不做任何校验。公网发布时，任何拿到口令的人都可以：

- 用任意 `userId` 读取并删除他人的收件箱（`GET /api/inbox?userId=xxx` 为读后即删语义）；
- 用任意 `userId` 调用 `/api/chat`，以他人身份操作自选股、污染会话历史。

### 1.2 目标

引入真正的多用户体系：

- 每个用户拥有独立账号（用户名 + 密码）；
- `userId` 由服务端在登录/注册后签发，客户端不可伪造；
- 自选股、会话历史、收件箱、监控规则全部按服务端签发的 `userId` 隔离；
- 旧的共享 `ACCESS_TOKEN` 不再作为 Web/API 的常规鉴权方式（可保留为系统启动/管理员 bootstrap 用途，但不得替代用户会话）。

---

## 2. 范围

### 2.1 在本需求内（必须实现）

1. 用户注册 `/api/auth/register`
2. 用户登录 `/api/auth/login`
3. 用户登出 `/api/auth/logout`
4. 会话管理：服务端签发、校验、过期
5. 现有业务 API 全面改用服务端签发的 `userId`，拒绝客户端自报
6. 前端登录/注册页替换现有 ACCESS_TOKEN 弹窗
7. 数据隔离：watchlist / chat_history / inbox / alert_rules / kv
8. 密码安全存储（bcrypt / argon2）
9. 登录接口速率限制（如 5 次/分钟/IP）
10. 单元测试覆盖注册/登录/隔离/越权

### 2.2 不在本需求内（明确不做）

1. 邮箱/手机号注册与验证
2. 密码找回/重置（用户遗忘密码时走管理员手动重置或重新注册）
3. OAuth / 第三方登录
4. 双因素认证（2FA）
5. 用户角色/权限系统（RBAC）
6. 用户资料页（头像、昵称等）
7. 管理员后台

### 2.3 暂不强制但建议预留

- 用户注册时的用户名唯一性约束；
- 密码强度校验（至少 8 位，建议包含字母+数字）。

---

## 3. 用户故事

- **US-1**：作为新用户，我可以通过用户名和密码注册账号，注册成功后自动登录。
- **US-2**：作为已有用户，我可以通过用户名和密码登录，获得会话凭证。
- **US-3**：作为登录用户，我的自选股、会话历史、收件箱、监控规则不会被其他用户看到或修改。
- **US-4**：作为登录用户，我无法通过修改本地存储的 `userId` 来冒充他人。
- **US-5**：作为登录用户，我可以点击登出，会话凭证失效。
- **US-6**：作为开发者/审计者，我可以通过需求文档逐项检查实现是否一致。

---

## 4. 功能需求

### 4.1 注册接口

```
POST /api/auth/register
Content-Type: application/json

{
  "username": "string",  // 必填，3~32 字符，只允许字母/数字/下划线/连字符
  "password": "string"   // 必填，建议 >= 8 位
}
```

**响应**：

- `201 Created`：注册成功，返回用户基本信息（不含密码）和会话凭证（与登录一致）。
- `400 Bad Request`：参数缺失/格式错误/用户名不符合规则。
- `409 Conflict`：用户名已存在。
- `500 Internal Server Error`：数据库错误。

### 4.2 登录接口

```
POST /api/auth/login
Content-Type: application/json

{
  "username": "string",
  "password": "string"
}
```

**响应**：

- `200 OK`：登录成功，返回用户基本信息和会话凭证。
- `400 Bad Request`：参数缺失。
- `401 Unauthorized`：用户名或密码错误（统一返回 401，不透露用户名是否存在）。
- `429 Too Many Requests`：同一 IP 登录失败次数超过阈值。

### 4.3 登出接口

```
POST /api/auth/logout
Authorization: Bearer <session-token>
```

**响应**：

- `200 OK`：会话失效（token 加入黑名单或从服务端删除）。
- `401 Unauthorized`：未提供凭证或凭证无效。

### 4.4 会话凭证

实现 agent 可在以下两种方案中二选一，**必须在需求文档/PR 中说明选型理由**：

| 方案 | 优点 | 缺点 | 适用场景 |
|---|---|---|---|
| **JWT**（有状态自包含） | 服务端无状态，易水平扩展 | 无法服务端主动失效，token 泄露后只能等过期 | 单节点/小团队，优先简单 |
| **Opaque Token**（有状态） | 可服务端失效登出，安全性高 | 需要 sessions 表，水平扩展需共享存储 | 多节点/高安全要求 |

**统一要求**：

- token 必须足够随机（>= 128 bit 熵）；
- 必须设置过期时间（建议 7 天）；
- 生产环境必须通过 HTTPS 传输；
- Web 前端通过 `Authorization: Bearer <token>` 头发送；
- App/WebView 同样通过 Header 发送，token 存储在 App 安全存储（首版可用 localStorage/EncryptedSharedPreferences，后续升级到 Keystore）。

### 4.5 业务 API 鉴权改造

所有 `/api/*` 端点（除 `/api/auth/*`、`/health`、静态资源、飞书事件外）必须：

1. 从 `Authorization: Bearer <token>` 头中解析会话；
2. 由服务端根据会话得到 `userId`；
3. **忽略客户端传来的任何 `userId` 参数**（如 query/body 中的 `userId` 直接丢弃或返回 400）；
4. 凭证无效/过期时返回 `401 Unauthorized`。

涉及改动的端点（至少但不限于）：

- `/api/chat`
- `/api/inbox`
- `/api/watchlist` (GET/POST/DELETE)
- `/api/stocks/:code` 及其子路径
- `/api/search`
- `/api/market/*`
- `/api/funds/*`
- `/api/sectors/*`
- `/api/scanner/*`
- `/api/backtest`
- `/api/overseas/summary`
- `/api/market/news`

### 4.6 数据隔离

SQLite 中所有按 userId 隔离的表，继续使用 `userId` 字段，但含义变为**服务端签发的用户标识**（可以是 UUID、自增 ID 的字符串形式、或用户名，但必须服务端签发且不可伪造）。

涉及表：

- `watchlist`
- `chat_history`
- `inbox`
- `alert_rules`
- `kv`（飞书 chat_id 映射等应继续按用户隔离；但部分系统级 kv 如全局配置可保留 `userId='__system__'`）

### 4.7 前端登录流程

- 首次打开 WebChat/App 时显示登录/注册页；
- 登录成功后前端保存 token，后续所有 `/api/*` 请求自动带 `Authorization` 头；
- token 失效/401 时跳转回登录页；
- 提供登出按钮；
- 移除现有 `ACCESS_TOKEN` 输入弹窗和 localStorage 中的 `userId` 作为身份标识。

---

## 5. 非功能需求

### 5.1 安全

- 密码必须使用 bcrypt（成本因子 >= 10）或 argon2id 哈希，**禁止明文存储**；
- 登录失败响应不得暴露用户名是否存在；
- 登录接口必须增加速率限制，防止暴力破解；
- 密码比较使用库函数自带的安全比较，不得手写 `===`；
- token 必须不可预测；
- 生产环境必须 HTTPS。

### 5.2 性能

- 登录/注册响应时间 P95 < 500ms（不含网络）；
- 会话校验中间件不得明显影响现有 API 延迟。

### 5.3 兼容性

- 新用户体系上线后，旧的 `ACCESS_TOKEN` 鉴权方式对 WebChat API 不再生效；
- 若需要保留旧版客户端兼容，可设置过渡期配置，但**默认关闭**；
- 现有 `data/store.db` 中的匿名数据需要迁移策略（见第 7 节）。

---

## 6. 数据模型

### 6.1 新增表

#### users

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,           -- 服务端签发，建议使用 UUIDv4
  username TEXT UNIQUE NOT NULL, -- 登录名
  password_hash TEXT NOT NULL,   -- bcrypt/argon2id 哈希
  created_at INTEGER NOT NULL,   -- unix timestamp (ms)
  updated_at INTEGER NOT NULL    -- unix timestamp (ms)
);
```

#### sessions（如选用 Opaque Token 方案）

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL, -- SHA-256(token) 或直接用 token 做 id
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
```

### 6.2 现有表改造

确认以下表已有 `userId` 字段，无需改结构，只需改语义：

- `watchlist(userId, code, ...)`
- `chat_history(userId, ...)`
- `inbox(userId, ...)`
- `alert_rules(userId, ...)`
- `kv(key, userId, value)`

**注意**：原 `userId` 可能是客户端自报的任意字符串。上线时需要决定是否迁移旧数据，或让老用户重新注册（见第 7 节）。

---

## 7. 数据迁移策略（二选一，实现时说明）

### 方案 A：冷启动（推荐，简单）

- 多用户体系上线时，要求所有现有用户重新注册；
- 清空或归档旧 `data/store.db`；
- 在登录页明确提示"公网版需重新注册账号"。

### 方案 B：一次性迁移

- 启动时扫描现有 `watchlist/chat_history/inbox/alert_rules` 表中的 distinct `userId`；
- 为每个 distinct `userId` 在 `users` 表中创建一个占位账号（用户名 = 原 userId，随机密码）；
- 提供"首次登录时设置用户名/密码"的迁移流程；
- 复杂度较高，若时间紧优先选方案 A。

**本需求默认采用方案 A**，如需改为方案 B 必须经用户确认。

---

## 8. API 改动清单

| 方法 | 路径 | 改动 |
|---|---|---|
| POST | `/api/auth/register` | 新增 |
| POST | `/api/auth/login` | 新增 |
| POST | `/api/auth/logout` | 新增 |
| * | `/api/*`（除上述及 /health、静态、飞书） | 鉴权中间件改为校验 session token，忽略客户端 userId |

---

## 9. 前端改动清单

| 位置 | 改动 |
|---|---|
| `public/webchat/index.html` / 对应 JS | 新增登录/注册页；移除 ACCESS_TOKEN 弹窗；移除 localStorage `userId` 身份；请求统一带 Authorization 头 |
| 所有 public 页面 | 若独立页面也需要鉴权，统一通过共享 JS 模块处理 token |
| UI | 登录页包含：用户名输入、密码输入、登录/注册切换、错误提示、登出入口 |

---

## 10. 验收标准

实现完成后，以下检查必须全部通过：

- [ ] `POST /api/auth/register` 可创建用户，密码以哈希存储，重复用户名返回 409。
- [ ] `POST /api/auth/login` 正确用户返回 token，错误密码返回 401（不提示用户名是否存在）。
- [ ] `POST /api/auth/logout` 使 token 失效（或 JWT 黑名单生效）。
- [ ] 不带 token 访问 `/api/chat`、`/api/inbox`、`/api/watchlist` 返回 401。
- [ ] 用户 A 登录后无法读取/删除用户 B 的收件箱（即使手动构造 userId 参数）。
- [ ] 用户 A 登录后无法操作用户 B 的自选股。
- [ ] 客户端 localStorage 中不再存放作为身份的 `userId`。
- [ ] 数据库中 passwords 表不存在明文密码。
- [ ] `npm test` 新增并通过 auth 相关测试。
- [ ] `npm run typecheck` 通过。

---

## 11. 审计要点

审查 agent 对照本需求文档验收时重点检查：

- **A-601 是否真正解决**：所有业务 API 是否完全依赖服务端签发的 userId，客户端自报 userId 是否被彻底忽略或拒绝；
- 密码是否哈希存储；
- 登录失败是否不泄露用户名存在性；
- 是否有速率限制；
- token 是否不可预测、是否有过期时间；
- 登出是否真正失效会话（JWT 方案需有黑名单或短过期+刷新机制）；
- 测试是否覆盖越权场景。

---

## 12. 后续依赖

S4-1 完成后，方可进行：

- **S4-2 微服务 token 鉴权**：data-service 端点校验 `DATA_SERVICE_TOKEN`，主服务统一携带；
- **S4-3 HTTPS 部署**：登录凭证必须 HTTPS 传输；
- **F7-2 App 客户端开发**：App 使用新的注册/登录 API。

---

## 13. 参考

- [审计 A-601](../AUDIT.md)
- [STATUS.md S4 小节](../STATUS.md)
- [CLAUDE.md 下一步路线](../../CLAUDE.md)
