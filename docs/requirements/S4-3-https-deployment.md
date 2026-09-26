# 需求文档：S4-3 HTTPS 部署

> **文档编号**：REQ-S4-3  
> **对应路线**：S4 公网发布前置 → S4-3（最后一项）  
> **依赖**：S4-1 多用户体系 ✅ / S4-2 微服务 token 鉴权 ✅ / S4-4 监听地址可配置 ✅  
> **目标读者**：下一个实现 agent / 代码审查 agent / 部署运维者  
> **状态**：待实现

---

## 1. 背景与目标

### 1.1 背景

S4-1 之后系统已有注册/登录体系，用户凭证以 `Authorization: Bearer <session token>`
明文走 HTTP；S4-2 之后主服务↔data-service 之间靠 `DATA_SERVICE_TOKEN` 静态 token
鉴权，token 同样明文传输。项目目标为**公网发布给陌生人使用**，HTTP 明文意味着：

- 登录凭证、session token、微服务 token 可被链路上任意节点嗅探/重放；
- 浏览器对非 HTTPS 站点越来越不友好（不安全警告、权限受限），安卓 App（F7）
  的 WebView/TWA 壳也要求 HTTPS 才能正常行为（TWA 强制 HTTPS）。

TLS 终止统一放在**反向代理层**（nginx / Caddy），主服务与 data-service 本身不改动
传输层——两者仍只监听本机回环，由反向代理对外暴露唯一 HTTPS 入口。

### 1.2 目标

- 提供一套可照做的 HTTPS 公网部署文档（证书申请、反向代理配置、防火墙、验证清单）；
- 消除反向代理部署引入的一个真实代码隐患：Express 默认不信任代理头，
  `req.ip` 会退化为代理地址（127.0.0.1），导致 S4-1 的登录速率限制变成
  **全局限速**（所有用户共享 5 次/60 秒）或被 `X-Forwarded-For` 伪造绕过；
- 给出 HSTS 启用建议与分阶段配置。

---

## 2. 范围

### 2.1 在本需求内（必须实现）

1. `docs/deploy/HTTPS.md` 部署文档，覆盖：
   - 部署架构（反向代理 → 主服务回环；data-service 永不直接暴露）；
   - 域名 / DNS 前置条件；
   - 两条落地路径：**Caddy（推荐，自动签发续期 Let's Encrypt）** 与
     **nginx + certbot** 完整示例配置；
   - 主服务 `.env` 配套配置（`HOST=127.0.0.1`、`TRUST_PROXY`）；
   - HSTS 分阶段建议（先短 max-age 验证，再升级）、安全响应头建议；
   - 飞书渠道回调 URL 的 HTTPS 注意事项；
   - 防火墙/端口暴露原则（只开 443；8000/18790 不对外）；
   - 部署后验证清单（`curl` 检查 TLS、HSTS、HTTP→HTTPS 跳转、登录限速按真实 IP 生效）。
2. `src/config.ts` 新增 `TRUST_PROXY` 配置项（见 4.2）；
   `src/index.ts` 应用 `app.set('trust proxy', config.trustProxy)`。
3. `.env.example` 同步增加 `TRUST_PROXY` 配置项与注释。
4. 测试覆盖：
   - `TRUST_PROXY` 各取值的解析（未配置 / true / false / 数字 / 网段表达式）；
   - 端到端：trust proxy 开启后 Express `req.ip` 取 `X-Forwarded-For` 真实
     客户端 IP（登录限速按真实 IP 计数），未开启时不信任伪造头。

### 2.2 不在本需求内（明确不做）

1. 主服务内置 HTTPS / TLS 证书管理：TLS 一律由反向代理终止，保持应用层零证书逻辑；
2. data-service 直接对公网暴露（继续仅绑回环，S4-2 token 仅作纵深防御）；
3. 具体云厂商/面板（宝塔等）的图形化操作步骤：文档给出通用配置，面板操作由部署者翻译；
4. 国内 CA / OV 证书采购流程（Let's Encrypt 足够，且 Caddy 全自动）；
5. F7 安卓 App 客户端改造（HTTPS 就绪是 F7 的前置，不在本需求内）；
6. 会话改 Cookie + Secure 标记：当前 Bearer token 方案无 Cookie，无此需求；
7. WAF / DDoS 防护等更高层设施。

---

## 3. 用户故事 / 动机

- **US-1（部署者）**：我照着 `docs/deploy/HTTPS.md` 用 Caddy 或 nginx 半小时内
  把站点以 HTTPS 上线，证书自动续期，不用改一行应用代码。
- **US-2（安全审查者）**：公网部署后登录限速按攻击者真实 IP 计数，而不是把
  所有用户共享一个限速桶；也不存在 XFF 头伪造绕过。
- **US-3（用户）**：浏览器地址栏不再提示"不安全"，登录凭证不被明文传输。

---

## 4. 功能需求

### 4.1 部署文档（docs/deploy/HTTPS.md）

必须包含以下章节，配置可直接复制使用：

1. **架构与端口**：公网 443 → 反向代理 → `127.0.0.1:18790`（主服务）；
   data-service `127.0.0.1:8000` 仅在回环，任何情况下不开防火墙端口；
2. **前置条件**：域名 A 记录指向服务器公网 IP、80/443 可达；
3. **路径 A：Caddy**（推荐）：完整 `Caddyfile` 示例，自动 ACME 签发与续期；
4. **路径 B：nginx + certbot**：完整 server 块（TLS 参数、HTTP→HTTPS 跳转、
   `proxy_pass`、`X-Forwarded-For` 等转发头、`client_max_body_size`）；
5. **主服务配套**：`.env` 设 `HOST=127.0.0.1`（S4-4）、`TRUST_PROXY=loopback`；
   启动日志确认监听地址；
6. **HSTS 建议**：分阶段（`max-age=300` 验证 → `max-age=31536000; includeSubDomains`
   的条件与风险提示）；HSTS 在代理层配置，应用层不输出；
7. **飞书渠道**：事件回调 URL 改为 `https://<域名>/api/feishu/verify`
   （以实际挂载路径为准），飞书要求回调可公网验证；
8. **验证清单**：`curl -I https://域名`（200 + 安全头）、
   `curl -I http://域名`（301→https）、`openssl s_client` 或浏览器查看证书链、
   连续错误密码登录触发 429 且不影响另一 IP。

### 4.2 TRUST_PROXY 配置与信任链

`src/config.ts` 新增：

| 环境变量 | 取值 | 语义 |
|---|---|---|
| `TRUST_PROXY`（未配置/空） | `false`（默认） | 不信任任何代理头，`req.ip`=socket 对端。直接暴露部署/本地开发的安全默认 |
| `TRUST_PROXY=true` | `true` | 信任每一跳 XFF（仅当代理不可被绕过时使用，文档注明风险） |
| `TRUST_PROXY=1` | `1` | 只信任最近一跳（代理与应用同机单跳时的精确取值） |
| `TRUST_PROXY=loopback` | `'loopback'` | 信任来自回环地址的 XFF（nginx 同机反代的推荐值） |
| `TRUST_PROXY=loopback, 10.0.0.0/8` 等 | 原样字符串 | Express 信任列表语法，透传给 `app.set('trust proxy', …)` |

实现要点：

- 解析函数：未配置/空 → `false`；`'true'`/`'false'` → 布尔；纯数字 → 数值；
  其余原样字符串；
- `src/index.ts` 在装配任何路由**之前** `app.set('trust proxy', config.trustProxy)`；
- 注释必须写清风险：`true` 表示信任所有来源 XFF，若 18790 端口可被绕过代理
  直接访问，客户端可伪造 XFF 绕过登录限速——故文档要求防火墙/绑定
  保证外部流量只能经代理进入；
- 登录限速（`src/auth/routes.ts` 的 `clientIp`）不改代码，`req.ip` 行为由
  Express 信任链自动修正。

### 4.3 HSTS 与应用层行为

- HSTS 响应头只由反向代理添加，应用层不输出、不感知；
- 应用层不根据 `X-Forwarded-Proto` 做任何重定向（避免双重跳转与开放重定向面）；
- `/health` 保持无鉴权（既有设计），反向代理层可选择不暴露或加 IP 白名单
  （文档建议，非代码）。

---

## 5. 非功能需求

### 5.1 安全

- 文档必须强调：**防火墙层面保证 8000/18790 不对公网开放**，否则攻击者可绕过
  代理直接 HTTP 访问应用，TRUST_PROXY 的信任前提即失效；
- `TRUST_PROXY=true` 的滥用风险必须在 `.env.example` 注释与部署文档中同时写明；
- 示例配置默认 TLS 1.2+、推荐加密套件，禁用弱协议（TLSv1.0/1.1）。

### 5.2 兼容性

- `TRUST_PROXY` 默认值 `false`，未配置的现有部署（局域网直连）行为完全不变；
- 反向代理只是新增一层转发，应用无版本迁移。

---

## 6. 数据模型 / API / 配置改动

### 6.1 数据模型

无。

### 6.2 对外 API 改动

无（不新增/修改任何 `/api/*` 端点；仅 `req.ip` 在代理后的取值修正）。

### 6.3 配置改动

| 文件 | 改动 |
|---|---|
| `.env.example` | 新增 `TRUST_PROXY` 及注释（含风险说明） |
| `src/config.ts` | 新增 `config.trustProxy: boolean \| number \| string` |
| `src/index.ts` | `app.set('trust proxy', config.trustProxy)` |
| 新增 `docs/deploy/HTTPS.md` | 完整部署文档 |

### 6.4 测试改动

| 文件 | 改动 |
|---|---|
| `tests/config.test.ts` | 追加 `TRUST_PROXY` 解析用例 |
| 新增 `tests/trustProxy.test.ts` | Express 实例验证：开启后 `req.ip` 取 XFF 真实 IP、限速按 IP 隔离；未开启时不受 XFF 影响 |

---

## 7. 验收标准

- [ ] `docs/deploy/HTTPS.md` 存在且包含 Caddy 与 nginx+certbot 两套可复制配置、
      HSTS 分阶段建议、飞书回调说明、防火墙原则、验证清单。
- [ ] `TRUST_PROXY` 未配置时 `config.trustProxy === false`，应用行为与现状完全一致。
- [ ] `TRUST_PROXY=loopback` 时，来自回环连接且带 `X-Forwarded-For` 的请求，
      `req.ip` 取 XFF 中最左真实客户端 IP（登录限速按真实 IP 计数）。
- [ ] `TRUST_PROXY` 未配置时，伪造 `X-Forwarded-For` 不影响 `req.ip`。
- [ ] `.env.example` 含 `TRUST_PROXY` 注释（含 `true` 的风险提示）。
- [ ] `npm run typecheck` 通过；`npm test` 全绿（含新增用例）。
- [ ] README 增加公网部署入口指引（链接到部署文档）。

---

## 8. 审计要点

- **trust proxy 设置位置**：必须在路由装配前，且仅出现一次；
- **默认值安全**：不配置即不信任任何代理头，局域网直连现状零变化；
- **限速无回归**：代理后限速按真实客户端 IP；直接访问时 XFF 伪造无效；
- **文档与代码一致性**：文档中的 `.env` 示例与 `.env.example` 实际内容一致；
- **data-service 暴露面**：文档必须明确 8000 端口永不对外，且
  `DATA_SERVICE_TOKEN` 配置仍是强制项（纵深防御）。

---

## 9. 后续依赖

S4-3 完成后，S4 公网发布前置全部收官，方可进行：

- **F7 安卓端 App 公网 Beta**（WebView/TWA 壳要求 HTTPS；App 首屏配置服务端
  域名即本需求部署产物）；
- 公网 Beta 邀请真实用户注册使用。

---

## 10. 参考

- [STATUS.md S4 小节](../STATUS.md)
- [S4-4 需求文档](S4-4-host-configurable.md)（如存在；HOST 环境变量）
- [S4-2 需求文档](S4-2-data-service-token.md)（data-service token，纵深防御）
- Express `trust proxy` 官方文档：https://expressjs.com/en/guide/behind-proxies.html
- Let's Encrypt：https://letsencrypt.org/ ；Caddy：https://caddyserver.com/
