# 需求文档：S4-2 微服务 token 鉴权

> **文档编号**：REQ-S4-2  
> **对应路线**：S4 公网发布前置 → S4-2  
> **解决审计问题**：[A-508](../AUDIT.md) data-service 无鉴权无 CORS 限制，安全完全依赖"部署时绑定回环"的口头约定  
> **目标读者**：下一个实现 agent / 代码审查 agent  
> **状态**：待实现

---

## 1. 背景与目标

### 1.1 背景

当前 Python 数据微服务 `data-service/main.py` 所有端点均**无鉴权**，仅在 docstring 中约定"必须绑定回环地址 `127.0.0.1`"。这一约定在公网/跨机器部署时不足够：

- 只要 8000 端口可被网络内任意主机访问，任何人都能调用 `/quote`、`/history`、`/scan`、`/market-bars/update` 等端点；
- 恶意或误操作会消耗 AKShare/东财/新浪数据源额度、触发 IP 限流，进而影响主服务稳定性；
- 主服务 `src/data/pythonService.ts` 与 `src/alerts/scheduler.ts`（通过主服务调用）目前不带任何凭证访问微服务。

审计 A-508 当时因"主/微服务同机回环绑定"裁定接受争议。但项目目标已升级为**公网发布给陌生人使用**，跨机器/容器部署成为可能，token 鉴权成为必须项。

### 1.2 目标

为 data-service 与主服务之间的 HTTP 调用增加统一的静态 token 鉴权：

- 微服务端点必须校验请求中的 token；
- 主服务所有调用微服务的出口统一携带 token；
- token 通过环境变量配置，无 token 配置时主服务无法使用微服务功能（fail-closed）；
- 不影响现有网页端用户鉴权（WebChat 的 session token 与 data-service token 是两层独立机制）。

---

## 2. 范围

### 2.1 在本需求内（必须实现）

1. data-service 全局 token 校验中间件，覆盖**所有业务端点**（含 `/health` 可单独决定是否保护，见 4.2）。
2. 主服务 `pythonService.ts` 所有 `get`/`post` 请求统一在 Header 中携带 token。
3. 主服务 `TradeCalendar` 对 `/trade-calendar` 的调用同样携带 token。
4. `src/config.ts` 新增 `DATA_SERVICE_TOKEN` 配置项；`.env.example` 同步增加变量与注释。
5. 主服务启动自检：若 `DATA_PROVIDER=python` 且未配置 `DATA_SERVICE_TOKEN`，打印醒目警告（服务仍可启动，但任何微服务调用都会 401）。
6. 单元/集成测试覆盖：
   - 无 token 访问 data-service 端点返回 401；
   - 错误 token 返回 401；
   - 正确 token 正常透传；
   - 主服务 `PythonServiceProvider` 构造的请求带 token；
   - `TradeCalendar` 请求带 token。

### 2.2 不在本需求内（明确不做）

1. 动态 token / OAuth / JWT：采用单一静态 shared secret，足够覆盖当前"主↔微服务"一对一场景；
2. 按端点分权限（RBAC）：所有主服务调用的端点使用同一个 token；
3. token 轮换/续期机制：手动修改环境变量后重启生效；
4. CORS 策略改造（A-508 提到但已超出本需求）；
5. 微服务端 HTTPS（由 S4-3 统一负责反向代理/TLS）；
6. 修改 WebChat 多用户体系（S4-1）的 session 机制。

### 2.3 暂不强制但建议预留

- 日志中隐藏或截断 token（避免泄露）；
- 响应头 `WWW-Authenticate` 可选返回 `Bearer` 提示。

---

## 3. 用户故事 / 动机

- **US-1（系统管理员）**：公网部署时，即使 data-service 监听地址被意外配置为 `0.0.0.0`，没有 token 的外部请求也会被拒绝，不会被滥用。
- **US-2（后端开发）**：我只需要在一个地方配置 `DATA_SERVICE_TOKEN`，主服务所有微服务调用自动带 token，不需要逐个端点改代码。
- **US-3（审计者）**：我可以通过检查 `pythonService.ts` 确认不存在不带 token 的 fetch 调用；data-service 的 `main.py` 有全局校验依赖。

---

## 4. 功能需求

### 4.1 Token 生成与配置

- Token 为长度 ≥ 32 的随机字符串，由运维/部署人员在 `.env` 中配置；
- 主服务与 data-service 读取**同一个**环境变量 `DATA_SERVICE_TOKEN`；
- 空字符串视为未配置；
- 不强制生成随机默认值（避免用户忘记配置却误以为安全）。

`.env.example` 新增：

```bash
# ===== 数据微服务 token 鉴权（S4-2）=====
# data-service 与主服务之间的共享凭证，必须 >= 32 字符；
# 公网/跨机器部署时必填，否则 8000 端口可被任意调用。
DATA_SERVICE_TOKEN=change-me-to-a-random-string-at-least-32-chars
```

### 4.2 data-service 校验规则

全局 FastAPI 依赖 `verify_data_service_token`：

- 从请求头读取 `Authorization: Bearer <token>`；
- 或从请求头读取 `X-Data-Service-Token: <token>`（便于内部直接 curl 测试）；
- 两个头都没有，或 token 与配置不符 → `401 Unauthorized`，body 可返回 `{"detail":"Invalid or missing data service token"}`；
- 未配置 `DATA_SERVICE_TOKEN` 时：微服务启动即报错退出（fail-closed，避免用户误以为有鉴权）；
- `/health` 端点**必须**纳入校验——让 `/health` 也能暴露"token 校验是否生效"这一事实；不单独开放无鉴权健康检查，避免被扫描滥用。

### 4.3 主服务携带 token

`src/data/pythonService.ts`：

- 在 `get`/`post` 的 `fetch` 中统一增加 header：
  - `Authorization: Bearer <DATA_SERVICE_TOKEN>`
- `TradeCalendar.loadYear` 的 `fetch` 同样增加该 header；
- token 从 `config.dataServiceToken` 读取。

`src/config.ts`：

- 新增字段 `dataServiceToken: string`；
- 读取 `process.env.DATA_SERVICE_TOKEN ?? ''`。

### 4.4 启动自检

在 `src/index.ts` 启动流程中：

- 若 `config.dataProvider === 'python'` 且 `config.dataServiceToken` 为空，打印醒目警告：
  ```
  [warn] DATA_PROVIDER=python 但 DATA_SERVICE_TOKEN 未配置，data-service 调用将因 401 失败。
  ```
- 服务仍可启动（与 LLM_API_KEY 缺失警告同风格），便于开发阶段只调行情不启动 data-service；
- 不影响 `DATA_PROVIDER=eastmoney` 模式（该模式不调用微服务）。

### 4.5 错误降级

主服务收到 data-service 返回 401 时，应把错误文本透传给上层调用者，最终由技能层/页面层按既有降级文案处理，不特殊隐藏。

---

## 5. 非功能需求

### 5.1 安全

- token 不参与任何 URL query string，只能出现在 Header；
- 日志、错误信息中不得完整打印 token（可截断前 4 位）；
- 静态 token 仅用于服务间认证，不暴露给浏览器/App 前端；
- 生产环境 `.env` 文件权限建议 600。

### 5.2 性能

- token 校验为纯内存字符串比较，不得引入数据库查询；
- 不得增加主服务到 data-service 的请求延迟（header 传输可忽略）。

### 5.3 兼容性

- 开发阶段可设置 `DATA_PROVIDER=eastmoney` 完全绕过本需求；
- data-service 端点增加 token 校验后，旧版主服务无法访问——这是预期行为；
- 不需要数据迁移。

---

## 6. 数据模型 / API / 配置改动

### 6.1 数据模型

无新增表，无现有表结构改动。

### 6.2 data-service 端点改动

| 端点 | 改动 |
|---|---|
| 全部端点 | 新增全局依赖：校验 `Authorization: Bearer <token>` 或 `X-Data-Service-Token: <token>` |
| `/health` | 同样纳入校验（让探测也能验证 token 链路） |

### 6.3 主服务 API 改动

| 端点 | 改动 |
|---|---|
| 无 | 本需求只改主服务到 data-service 的内部 HTTP 调用，不新增/修改对外暴露的 `/api/*` 端点 |

### 6.4 配置改动

| 文件 | 改动 |
|---|---|
| `.env.example` | 新增 `DATA_SERVICE_TOKEN` 配置项与注释 |
| `src/config.ts` | 新增 `config.dataServiceToken` |
| `data-service/main.py` | 启动时读取 `DATA_SERVICE_TOKEN`，未配置则退出 |

### 6.5 测试改动

| 文件 | 改动 |
|---|---|
| `tests/pythonService*.test.ts` | 补充 token 头部校验相关用例（可与 mock server 配合断言 request header） |
| `tests/config.test.ts` | 增加 `DATA_SERVICE_TOKEN` 读取/默认空值用例 |
| 新增 `tests/dataServiceToken.test.ts`（可选） | 用 FastAPI TestClient + 依赖覆盖测试主校验逻辑 |

---

## 7. 验收标准

实现完成后，以下检查必须全部通过：

- [ ] `.env.example` 包含 `DATA_SERVICE_TOKEN` 及说明。
- [ ] `src/config.ts` 暴露 `config.dataServiceToken`。
- [ ] data-service 未配置 `DATA_SERVICE_TOKEN` 时启动失败并提示。
- [ ] data-service 配置 `DATA_SERVICE_TOKEN=abc` 后，无 Header 的请求返回 401。
- [ ] 错误 token（如 `Authorization: Bearer wrong`）返回 401。
- [ ] 正确 token 通过 `Authorization: Bearer <token>` 可正常访问所有原有端点。
- [ ] 正确 token 通过 `X-Data-Service-Token: <token>` 也可正常访问。
- [ ] 主服务 `pythonService.ts` 的 `get`/`post` 请求均带 `Authorization: Bearer <token>`。
- [ ] 主服务 `TradeCalendar` 对 `/trade-calendar` 的请求带 token。
- [ ] 主服务 `DATA_PROVIDER=python` 且 token 为空时启动打印醒目警告。
- [ ] `npm run typecheck` 通过。
- [ ] `npm test` 全绿（含新增 token 相关测试）。
- [ ] `python -m py_compile data-service/main.py` 通过。

---

## 8. 审计要点

审查 agent 对照本需求文档验收时重点检查：

- **A-508 是否真正解决**：data-service 是否所有业务端点都有 token 校验，而不是仅靠注释约定；
- `/health` 是否也被保护（避免成为信息泄露/探测入口）；
- `pythonService.ts` 中是否存在任何不带 token 的 `fetch` 调用；
- `TradeCalendar` 是否带 token；
- token 是否只出现在 Header，不出现在 URL；
- 错误响应是否不泄露真实 token；
- 测试是否覆盖 401/正确 token/主服务 header 透传三种场景。

---

## 9. 后续依赖

S4-2 完成后，方可进行：

- **S4-3 HTTPS 部署**：token 本身也必须在 TLS 保护下传输；
- **F7 安卓端 App 公网 Beta**：App 连接公网部署的主服务，data-service 与主服务可能跨容器/机器通信，必须有 token 鉴权。

---

## 10. 参考

- [审计 A-508](../AUDIT.md)
- [STATUS.md S4 小节](../STATUS.md)
- [CLAUDE.md 下一步路线](../../CLAUDE.md)
