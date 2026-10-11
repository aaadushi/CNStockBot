# REQ-S3-8：Quick Tunnel 隧道守护（崩溃自动拉起 + 假活检测）

> 需求文档（2026-10-11）。本文件是后续代码审计、功能验收、回归测试的基准。
> 对应 STATUS 进程管理系列（S3-4 → S3-5 → S3-7 → 本项），解决 2026-10-11
> 排查的"cloudflared 假活隧道"事故（PITFALLS 第 8 节同日条目）暴露的
> **隧道进程完全无守护**问题。

## 背景与目标

- 现有 `scripts/tunnel-demo.bat` 是**纯前台交互脚本**：关窗/Ctrl+C/进程崩溃即断，
  没有任何自动重启；更危险的是 PITFALLS 记录的"假活"形态——cloudflared 进程
  活着、本地 metrics 端口在听，但隧道注册被边缘持续拒绝（fail 计数涨到 146、
  success 为 0），隧道名存实亡而**无任何表面征兆**。
- 目标：给 Quick Tunnel 加一层与 `service.mjs supervise` 同规格的守护：
  崩溃自动拉起（指数退避）、**周期性读 metrics 判定假活并强制重启**、
  URL 落盘可随时查询、PID/哨兵文件支持 stop/status 管理。

## 范围

### 做

1. 新增 `scripts/tunnel.mjs`（Node 守护进程，零依赖，风格对齐 service.mjs）：
   - 子命令：`start [--port N]` / `stop [--port N]` / `status [--port N]` /
     `url [--port N]`；port 缺省读 `.env` 的 PORT，再退 18790。
   - start 前置检查：cloudflared 可执行存在（PATH 查找）；目标端口
     `/health` 可通。不过则明确报错退出。
   - 每代子进程：`cloudflared tunnel --url http://127.0.0.1:<port>
     --protocol http2 --metrics 127.0.0.1:<metricsPort>`（`--protocol http2`
     为 PITFALLS 2026-10-10 强制项，不可省）。metrics 端口从 20242 起向上
     探测第一个空闲端口。
   - URL 捕获：解析子进程 stdout/stderr 中的 `https://*.trycloudflare.com`，
     首次出现即写入 `logs/tunnel-url-<port>.txt`（覆盖写，重启换新地址后
     自动更新）。
   - 崩溃守护：子进程非预期退出 → 指数退避重启（3s 起、封顶 60s），
     连续失败 20 次放弃；本代运行 ≥60s 视为稳定、连续失败计数清零。
     参数与 service.mjs supervise 完全一致。
   - **假活检测**：每代启动后每 15s 拉取一次
     `http://127.0.0.1:<metricsPort>/metrics`；宽限期 90s（注册本身可能慢），
     之后若 `tunnel_register_success` 合计为 0 且 `tunnel_register_fail`
     合计 > 0，判定假活 → 杀子进程并按崩溃路径重启（日志记明原因）。
     metrics 拉取失败（端口未起/网络）不算假活，只记调试日志。
   - 控制文件按目标端口命名空间化（S3-7 同款教训）：
     `logs/tunnel-<port>.pid`（守护进程）、`logs/tunnel-child-<port>.pid`
     （当前代 cloudflared）、`logs/tunnel-<port>.stop`（哨兵）、
     `logs/tunnel-<port>.log`（日志镜像）、`logs/tunnel-<port>.meta.json`
     （{ metricsPort, startedAt }，status 用）。
   - stop：写哨兵 + taskkill /T 杀守护进程（子进程随树清理）；
     start 开头幂等清理陈旧哨兵与孤儿 cloudflared（旧 child PID 文件指向
     存活进程时先杀再拉新代）。
   - status：守护进程存活、当前 URL、register 成功/失败计数、目标端口
     /health；运行中退出码 0，否则 1。
2. 新增 `scripts/tunnel-supervise.bat`：纯 ASCII + CRLF（PITFALLS 2026-10-10
   三雷），仅把参数转发给 `node tunnel.mjs start`，供双击/Start-Process 拉起。
3. 文档：`docs/deploy/local-tunnel.md` 增补守护模式用法与"假活"排查行；
   `docs/STATUS.md` 更新日志。

### 不做（明确排除）

- 不做命名隧道 / 固定 hostname（阶段 2，域名购买后另行立项）。
- 不做开机自启（任务计划程序），同 S3-5 的边界。
- 不改主服务、data-service 任何代码；不接入 service.mjs 的 supervise
  （隧道是可选组件，保持独立进程独立管理）。
- 不做隧道 URL 的主动推送（换地址后人工同步给测试者，Quick Tunnel 语义不变）。
- 不做 Linux/macOS 的 .sh 包装（与 tunnel-demo.sh 现状一致，用
  `node scripts/tunnel.mjs start` 即可）。
- 不做"通过公网 URL 自动巡检 /health 并重启"（metrics 注册计数是更直接的
  假活判据，公网巡检留给人工/后续）。

## 功能需求

- FR-1 start 前置检查失败（cloudflared 缺失 / 主服务未起）打印中文原因，
  退出码 1，不进入守护循环。
- FR-2 URL 文件 `logs/tunnel-url-<port>.txt` 内容**只有** URL 一行；
  获取不到时文件不存在，`url` 子命令输出"尚未获取到隧道地址"。
- FR-3 假活判定只认 metrics 计数：宽限期后 success==0 && fail>0。
  判定后日志输出 `假活判定：register_success=0 register_fail=N，重启隧道`，
  并按崩溃重启路径计次/退避。
- FR-4 stop/status/url 在未运行时的输出与人类可读的错误提示符合
  service.mjs 的措辞风格；status 不受哨兵文件残留影响（start 幂等清理）。
- FR-5 全部日志（含 URL 行、假活判定、退避计划）镜像到控制台与
  `logs/tunnel-<port>.log`。

## 非功能需求

- 纯 Node 标准库实现（spawn/net/fetch/fs），与 service.mjs 同；不新增 npm 依赖。
- scripts/ 不在 tsconfig include 内，与 S3-4/S3-5/S3-7 一致不做 vitest，
  验收以 `npm run typecheck` + `npm test` 不回归 + 真实隧道端到端验证为准。
- Windows 关窗（SIGHUP）尽力而为；stop 命令是可靠停止路径（同 service.mjs）。
- 不破坏 tunnel-demo.bat 现有行为（前台演示脚本保留）。

## 数据模型 / API / 前端改动

纯运维脚本：无数据模型、无 API、无前端改动。新增文件：

```
scripts/tunnel.mjs            守护进程主脚本
scripts/tunnel-supervise.bat  Windows 拉起包装（CRLF + 纯 ASCII）
logs/tunnel-<port>.*          运行时控制/日志文件（gitignore 已覆盖 logs/）
logs/tunnel-url-<port>.txt    当前隧道 URL
```

## 验收标准

1. `node scripts/tunnel.mjs start`（主服务已运行）→ 15-30s 内
   `logs/tunnel-url-<port>.txt` 出现 `https://*.trycloudflare.com`；
   公网 curl 该地址 `/health` 返回 200。
2. 手动 taskkill 掉 cloudflared 子进程 → 守护进程在退避后自动拉起新实例，
   URL 文件更新为新地址（Quick Tunnel 语义：地址必变），日志有记录。
3. `node scripts/tunnel.mjs status` 运行中打印 PID/URL/register 计数且退出码 0；
   未运行退出码 1。
4. `node scripts/tunnel.mjs stop` 后 `status` 显示未运行，且无 cloudflared 残留
   （tasklist 验证）；再次 `start` 正常。
5. 假活路径（可选验证）：以无法注册的参数触发 register fail（或复用事故日
   环境），确认宽限期后被判定假活并重启。无法复现则以代码审查 + 计数解析
   单元逻辑人工核验为准，并在汇报中说明。
6. `npm run typecheck` + `npm test` 不回归；`scripts/tunnel-supervise.bat`
   为 CRLF + 纯 ASCII（`file` 命令验证）。
7. 文档（local-tunnel.md / STATUS.md）已同步。

## 审计要点

- `--protocol http2` 不可省略（PITFALLS 2026-10-10 红线）。
- 假活判定必须同时满足"宽限期后 + success==0 + fail>0"，不得仅凭
  进程存活/端口监听下结论（tasklist/netstat 不可靠已是病例）。
- stop 必须走"哨兵 + 杀守护进程"两步，不得只杀子进程留下守护循环空转。
- 控制文件命名必须带端口命名空间（S3-7 教训），禁止写死
  `logs/tunnel.pid`。
- 不得把隧道 URL 写死进任何 App/前端默认配置（Quick Tunnel 地址随进程死亡）。
