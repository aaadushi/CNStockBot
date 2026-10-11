# 自测临时公网隧道（Cloudflare Quick Tunnel）

> 用途：**开发自测 / 临时演示**阶段（不买服务器、不买域名）把本机服务暴露到公网。
> 正式发布路线不受影响，见 [HTTPS.md](HTTPS.md)。需求文档：
> [REQ-Dev-Tunnel](../requirements/dev-tunnel-demo.md)。

## 1. 它解决什么问题

- 手机 App 外出实测、给少数人演示时，需要公网可访问的 https 地址
- 家宽入站 80/443 被封、无固定公网 IP，传统端口映射不可行
- Quick Tunnel 从本机**主动向外**建立加密连接，不需要公网 IP、不需要开任何端口

```
手机/他人浏览器 ──https──▶ Cloudflare ──加密隧道──▶ 你的电脑（cloudflared ─▶ 127.0.0.1:18790）
```

零成本：不要域名、不要注册、不要付费（Cloudflare 免费功能）。

## 2. 用法

前置：主服务已在运行（`scripts\start-all.bat`），已安装 cloudflared：

```bash
# Windows（winget / scoop / 手动下载均可）
winget install cloudflare.cloudflared
```

### 2.1 守护模式（推荐，S3-8）：崩溃自动拉起 + 假活检测

临时 URL 动辄要挂几小时到几天给外出设备用，纯前台窗口"关窗即断"且假活无征兆，
推荐用守护进程（REQ-S3-8）：

```bat
scripts\tunnel-supervise.bat        :: 端口默认读 .env 的 PORT，再退 18790
```

等价命令：`node scripts\tunnel.mjs start [--port N]`。管理能力：

```bash
node scripts/tunnel.mjs status   # 守护进程/当前 URL/register 成功失败计数/主服务健康
node scripts/tunnel.mjs url      # 只打印当前隧道地址（= logs\tunnel-url-<port>.txt）
node scripts/tunnel.mjs stop     # 哨兵 + 杀守护进程（cloudflared 随进程树清理）
```

- 每代 cloudflared 带 `--protocol http2`（PITFALLS 2026-10-10 红线）与
  `--metrics 127.0.0.1:<port>`；地址从输出捕获写入
  `logs\tunnel-url-<port>.txt`，**重启换新地址后自动更新**。
- 崩溃/假活自动拉起：退避 3s 起封顶 60s，连续失败 20 次放弃。
- **假活检测**：每 15s 读 metrics，宽限 90s 后若 `tunnel_register_success==0`
  且 `tunnel_register_fail>0`，判定"进程活着但隧道从未注册成功"并强制重启
  （PITFALLS 2026-10-11 假活隧道事故的自动化解法；人工核验仍可用
  `curl http://127.0.0.1:<metrics端口>/metrics | grep tunnel_register`）。
- 无人值守拉起（关窗也能活）：用 PowerShell
  `Start-Process -FilePath scripts\tunnel-supervise.bat -WindowStyle Hidden`。
- 停止务必走 `tunnel.mjs stop`（只关窗口在守护模式下不生效）。

### 2.2 前台演示模式（tunnel-demo.bat，保留）

前台运行 cloudflared，输出中形如 `https://some-words.trycloudflare.com` 的一行
就是演示 URL，把它填进 App 首屏服务器地址即可（release 版 App 仅接受 https，
隧道地址天然满足）。关闭窗口 / Ctrl+C 即断开隧道。

## 3. URL 生命周期（重要，别误解）

| 情形 | URL 是否变化 |
|---|---|
| `cloudflared` 进程一直运行（几小时~几天） | **不变**，可当"半固定地址"用 |
| 主服务（CNStockBot）重启、更新 | 不变，与隧道无关 |
| 关闭 cloudflared 窗口 / Ctrl+C / 进程崩溃 | 大概率变化（下次启动重新分配） |
| 电脑关机、重启、**Windows 睡眠/休眠** | 连接断开；恢复后可能换新 URL |
| 网络断开较久 | Cloudflare 判定会话失效，可能回收 |

因此：**临时 URL 只用于"现在填进去测"，绝不能写死进 App 默认配置或告诉用户
"以后就访问这个地址"**。Windows 自测期间建议关闭睡眠（设置 → 电源 → 睡眠=从不，
或插电使用），否则合盖即断。

## 4. 安全注意

隧道 = 你的电脑对公网开放。S4-1 的防护（bcrypt 密码、登录限速、session token）
此时是唯一天然屏障，开隧道前自查：

- `.env` 中生产数据已有强密码用户；不要注册弱密码账号
- 隧道只暴露主服务（18790）；data-service（8000）不经隧道、仍只听回环
- 演示结束随手关窗，不要长期挂着一个你不看管的公网入口

## 5. 与正式部署路线的关系（成本分阶段）

| 阶段 | 动作 | 成本 |
|---|---|---|
| **1. 自测（当前）** | 局域网 IP 直连；外出/演示用本文 Quick Tunnel | 0 元 |
| **2. 给少数朋友试用** | 购买域名（~15 元/年首年价）+ Cloudflare 命名隧道（固定 hostname，仍是免费功能） | ≈15 元/年 |
| **3. 正式发布** | 域名与 Cloudflare 配置原封不动，后端搬到云主机（Oracle 免费层或付费 VPS），按 [HTTPS.md](HTTPS.md) 部署 | 域名续费 + 服务器 |

三个阶段域名/隧道层配置向后兼容，升级只动"服务跑在哪台机器"。

## 6. 故障排查

| 现象 | 原因与做法 |
|---|---|
| 访问隧道地址报 **Cloudflare Error 1033** 或 HTTP 530 | 隧道没连上：国内网络常封 UDP 7844（QUIC）。脚本已内置 `--protocol http2` 规避；手动执行时也加上该参数 |
| 隧道地址返回 **404 / Cannot GET /** | 新版已修：根路径自动 302 到 /webchat（REQ-Root-Redirect）；旧版服务才需要手动加 `/webchat` || 启动后一直没有 trycloudflare URL | 等 10-30 秒；仍无则看窗口报错，多为出站被拦 |
| 之前能用，突然全断 | 看隧道窗口是否还开着、电脑是否睡眠/断网；守护模式下 `node scripts\tunnel.mjs status` 看 register 计数与 URL；重启隧道后**地址会变**，记得发新地址 |
| 怀疑假活（进程在但谁都打不开） | `node scripts\tunnel.mjs status`：register 计数 success=0 / fail 增长即实锤；守护模式会自动重启，手动模式 taskkill 后重开 |
