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

启动隧道（Windows 双击或命令行；Linux/macOS 用 `scripts/tunnel-demo.sh`）：

```bat
scripts\tunnel-demo.bat        :: 端口默认读 .env 的 PORT，再退 18790
scripts\tunnel-demo.bat 8125   :: 也可显式指定
```

脚本会做两个前置检查：cloudflared 是否在 PATH、主服务 `/health` 是否可通，
不过就直接报错提示。通过后 cloudflared 前台运行，输出中形如
`https://some-words.trycloudflare.com` 的一行就是演示 URL，把它填进 App 首屏
服务器地址即可（release 版 App 仅接受 https，隧道地址天然满足）。

关闭窗口 / Ctrl+C 即断开隧道。

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
