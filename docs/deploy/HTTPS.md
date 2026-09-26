# HTTPS 公网部署指南（S4-3）

> 本文档是 CNStockBot 公网发布的标准部署方式：TLS 统一由**反向代理**终止，
> 主服务（:18790）与 data-service（:8000）始终只监听本机回环，应用代码零证书逻辑。
> 前置依赖：S4-1 多用户体系 ✅、S4-2 微服务 token ✅、S4-4 HOST 可配置 ✅。

---

## 1. 架构与端口

```
                 互联网用户（浏览器 / 安卓 App / 飞书回调）
                        │  https://cnstock.example.com
                        ▼
              ┌─────────────────────┐
              │  反向代理 :443/:80   │  Caddy 或 nginx（TLS 终止、HSTS、HTTP→HTTPS 跳转）
              └─────────┬───────────┘
                        │  http://127.0.0.1:18790（仅回环）
                        ▼
              ┌─────────────────────┐
              │  主服务 :18790       │  Express（HOST=127.0.0.1, TRUST_PROXY=loopback）
              └─────────┬───────────┘
                        │  http://127.0.0.1:8000 + Bearer token（仅回环）
                        ▼
              ┌─────────────────────┐
              │  data-service :8000  │  FastAPI（DATA_SERVICE_TOKEN 强制）
              └─────────────────────┘
```

**端口原则（安全硬约束）**：

| 端口 | 对外 | 说明 |
|---|---|---|
| 443 | ✅ 开放 | 唯一公网入口，TLS |
| 80 | ✅ 开放 | 仅用于 ACME 证书签发与 HTTP→HTTPS 跳转 |
| 18790（主服务） | ❌ 禁止 | 只允许回环访问；若可被绕过代理直连，`TRUST_PROXY` 的信任前提失效（客户端可伪造 XFF 绕过登录限速） |
| 8000（data-service） | ❌ 禁止 | 永不对外，S4-2 token 只是纵深防御 |

云主机安全组 / 系统防火墙双重确认：公网入方向只有 80/443。

## 2. 前置条件

1. 一个域名（如 `cnstock.example.com`），A 记录指向服务器公网 IP；
2. 服务器 80/443 端口可达（云安全组 + 系统防火墙同时放行）；
3. 代码为最新 main，`.env` 已配置 `DATA_PROVIDER=python`、`DATA_SERVICE_TOKEN`
   （≥32 位强随机）、`LLM_API_KEY` 等（见 `.env.example`）。

## 3. 路径 A：Caddy（推荐）

Caddy 自动签发并续期 Let's Encrypt 证书，配置最短，无需额外安装 certbot。

`/etc/caddy/Caddyfile`（Windows 下为 Caddyfile 同级启动）：

```
cnstock.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:18790

    # 安全响应头（HSTS 见第 6 节，建议先小规模验证再开启长 max-age）
    header {
        -Server
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

启动：`caddy run`（或注册为系统服务 `caddy start`）。首次访问即自动完成 ACME 挑战并签发证书。

## 4. 路径 B：nginx + certbot

### 4.1 安装与签发

```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d cnstock.example.com   # 自动改 nginx 配置并设置续期
```

### 4.2 nginx server 块

```nginx
# HTTP：跳转 HTTPS（certbot 会自动加 443 块；此处保留 80 的跳转与 ACME）
server {
    listen 80;
    server_name cnstock.example.com;
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name cnstock.example.com;

    ssl_certificate     /etc/letsencrypt/live/cnstock.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cnstock.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:18790;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        # 只从真实对端重建 XFF：客户端伪造的 XFF 不会进入应用
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180s;   # 覆盖扫描/回测等长请求（主服务内部超时 150s）
    }
}
```

要点：
- `proxy_read_timeout 180s` ≥ 主服务对 data-service 长请求（扫描/回测 150s）的处理时长；
- `X-Forwarded-Proto` 用于让应用识别原始协议（当前应用层不依赖它，仅作规范转发）；
- 证书续期由 certbot systemd timer 自动完成（`certbot renew --dry-run` 可验证）。

## 5. 主服务配套配置

`.env`（应用与代理**同机**部署时）：

```bash
# 只让反向代理本机访问（S4-4）
HOST=127.0.0.1
PORT=18790
# 信任来自回环代理的 X-Forwarded-For，登录限速按真实客户端 IP 计数（S4-3）
# 注意：防火墙必须保证 18790 不能绕过代理被公网直连，否则客户端可伪造 XFF 绕过限速
TRUST_PROXY=loopback
```

启动日志应显示 `监听地址: 127.0.0.1:18790`。

**绝对不要用 `TRUST_PROXY=true`** 除非流量在架构上不可能绕过代理（如容器中代理是唯一 ingress）——`true` 信任所有来源的 XFF 头，直连应用的攻击者可用伪造 IP 绕过登录限速。

## 6. HSTS 建议（分阶段）

HSTS 强制浏览器只以 HTTPS 访问，防 SSL 剥离攻击。**配置在代理层，应用层不输出。**

1. **第一阶段（验证期，1~2 周）**：
   ```
   Strict-Transport-Security: max-age=300
   ```
2. **第二阶段（稳定后）**：确认所有子域都已支持 HTTPS 后再升级：
   ```
   Strict-Transport-Security: max-age=31536000; includeSubDomains
   ```
   风险提示：`includeSubDomains` 会覆盖全部子域，若任一子域不支持 HTTPS 将被浏览器拒绝访问；不要加 `preload` 除非你确定要进浏览器预载列表且能长期维持全站 HTTPS。

## 7. 飞书渠道注意事项

- 事件回调 URL 改为 `https://cnstock.example.com/api/feishu/verify`（以
  [src/channels/feishu.ts](../src/channels/feishu.ts) 实际挂载路径为准）；
- 飞书要求回调地址可公网验证且建议 HTTPS；启用加密策略时 `FEISHU_ENCRYPT_KEY`
  必填；
- 飞书主动推送（server → 飞书 API）与入站回调互相独立，配置 HTTPS 不影响推送。

## 8. 部署后验证清单

```bash
# 1. HTTPS 正常 + 安全头
curl -sI https://cnstock.example.com | grep -E 'HTTP|Strict-Transport|X-Content-Type'
# 2. HTTP 跳转 HTTPS
curl -sI http://cnstock.example.com | head -1        # 期望 301/308 到 https
# 3. 证书链（应看到 Let's Encrypt，有效期 90 天）
echo | openssl s_client -connect cnstock.example.com:443 2>/dev/null | openssl x509 -noout -issuer -dates
# 4. WebChat 页面与登录 API
curl -s https://cnstock.example.com/webchat >/dev/null && echo OK
curl -s -X POST https://cnstock.example.com/api/auth/register \
  -H 'Content-Type: application/json' -d '{"username":"smoketest","password":"Passw0rd!x"}'
```

应用层验证：

- [ ] `/health` 返回 ok（如不想暴露可只在代理层加 IP 白名单）；
- [ ] 登录页连续 5 次错误密码触发 429；**换一台机器/网络**登录不受影响
      （证明限速按真实 IP 而非全局生效）；
- [ ] data-service 从公网不可达：`curl -m 3 http://<服务器公网IP>:8000/health` 超时/拒绝；
- [ ] 主服务从公网不可绕过代理直连 18790（同上报错）。

## 9. 故障排查

| 现象 | 排查 |
|---|---|
| 登录正常但总触发 429 | 代理未正确传 XFF，或 `TRUST_PROXY` 未配置——所有用户被当成同一 IP |
| 伪造 XFF 能绕过限速 | 18790 可被公网直连绕过代理：检查防火墙/安全组；不要把 `TRUST_PROXY` 设为 `true` 了事 |
| 扫描/回测请求 504 | 代理 `proxy_read_timeout` 太短（需 ≥180s） |
| 证书签发失败 | 80 端口未放行 / DNS 未生效；`curl http://域名/.well-known/acme-challenge/...` 自测 |
| 飞书回调验证失败 | 回调 URL 必须公网 https 可达且路径正确 |

---

相关文档：[S4-3 需求文档](../requirements/S4-3-https-deployment.md) ·
[README](../README.md) · [.env.example](../.env.example)
