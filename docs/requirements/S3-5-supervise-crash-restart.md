# 需求文档：S3-5 进程守护——崩溃自动拉起（supervise 模式）

> **文档编号**：REQ-S3-5
> **对应路线**：[STATUS 待办 S3-5](../STATUS.md)（进程守护层，用户 2026-10-11 主动提出启动本项）
> **目标读者**：下一个实现 agent / 代码审查 agent
> **状态**：实现中

---

## 1. 背景与目标

### 1.1 背景

S3-4（REQ-S3-4）交付的 `scripts/service.mjs` 是**前台监督模式**：任一子进程崩溃 →
整体收尾退出，崩溃后双服务整体停摆，必须人工重新拉起。STATUS S3-5 原登记的守护层
包含"开机自启 + 崩溃自动拉起"。

### 1.2 范围裁剪（2026-10-11 用户明确指定）

- **只做崩溃自动拉起**；
- **开机自启不做**——启动服务仍由人手动执行（Windows 任务计划程序 / systemd /
  pm2 均不在本需求内，日后若要做另起需求）；
- 验证通过后，生产双服务从 `start` 前台模式迁移到 `supervise` 守护模式。

### 1.3 目标

1. `service.mjs` 新增 `supervise` 子命令：子服务崩溃后自动重启（指数退避 +
   连续失败上限），人工 `stop` 能正确终止守护循环；
2. `stop` / `status` 升级：与守护循环正确交互，stop 后绝不再被拉起；
3. 保持 `start` 子命令对外行为**零变化**（两种模式并存，前台模式仍是开发调试首选）。

---

## 2. 范围

### 2.1 在本需求内（必须实现）

1. `scripts/service.mjs` 重构 + 新子命令：
   - 抽出 `runOneGeneration(env, endpoints)`：端口预检 → 拉起双服务 → 写 PID 文件 →
     镜像日志（子进程日志 + supervisor 自身日志均追加落盘 `logs/`），返回 Promise，
     resolve 值为 `{ reason: 'child-exit', code, name } | { reason: 'signal', sig }`；
   - `start` 改为薄壳：跑一代 → cleanup（杀进程树、删 PID 文件、关日志流）→
     以子进程退出码退出。**对外行为与 S3-4 完全一致**；
   - `supervise`：
     - 启动前置同 `start`（`DATA_SERVICE_TOKEN` 校验）；
     - 写自身 PID 到 `logs/supervisor.pid`；清除上次遗留的停止哨兵
       `logs/supervisor.stop`；
     - 主循环：哨兵存在 → 清理退出 0；否则跑一代：
       - `signal` → 正常清理退出 0；
       - `child-exit` → 记录日志（服务名 + 退出码 + 本代运行时长）：
         本代时长 ≥ 60s 视为稳定运行，连续失败计数清零；否则计数 +1，
         **≥ 20 次** → 打日志"需人工介入"并以退出码 1 收尾（防崩溃风暴）；
         否则指数退避 3s → 6s → 12s → … 封顶 60s 后进入下一代；
       - 退避等待期间每 500ms 检查哨兵，stop 可即时打断等待；
     - supervisor 自己的日志行写 `logs/supervisor.log`（追加流 + 控制台），
       无窗运行（Start-Process 脱离会话）时重启事件有迹可查；
     - Windows 关窗（SIGHUP）/ SIGINT / SIGTERM 语义同 start：当前代收尾、
       不再重启、清理退出。
   - `stop` 升级：写哨兵 → 若 `supervisor.pid` 存活则 `killTree` 杀守护进程并
     等其退出（≤3s）→ 照旧 `stopOne` 两个子服务 → 删除 `supervisor.pid` 与哨兵；
     守护进程未运行时行为与现状一致（幂等，可重复执行）；
   - `status` 增加守护行（运行中 PID / 未运行），退出码逻辑不变（只看双服务）。
2. 薄包装 `scripts/supervise-all.bat`（CRLF、`%~dp0` 转调、rem 注释纯 ASCII——
   PITFALLS bat 三雷教训）。
3. `package.json` 新增 `supervise:all` script。
4. 端到端实测（替代端口 env 文件）+ 生产迁移到 supervise 模式（见验收标准）。

### 2.2 不在本需求内（明确不做）

1. **开机自启**：Windows 任务计划程序注册、Linux systemd unit、macOS launchd 均不做；
2. **pm2 / pm2-windows-service / node-windows** 等进程管理器依赖（与项目零依赖基线不符）；
3. `start` 子命令语义任何变化（前台监督、整体收尾、Ctrl+C/关窗即停）；
4. 主服务 / data-service / 前端 / Android 壳任何改动；
5. 日志轮转（沿用现状：追加写，量大人工清理）。

---

## 3. 用户故事 / 动机

- **US-1（运维）**：服务半夜崩溃后不需要人工干预，supervise 自动拉起并在
  `logs/supervisor.log` 留下重启记录（时间 + 退出码 + 第几次重试）。
- **US-2（运维）**：我想停服维护时，照旧敲 `stop`，守护循环随之终止，
  不会出现"stop 完又被拉起"的竞态。
- **US-3（排查者）**：某次反复崩溃（如配置错误）时，守护层不会在 60s 内
  刷 20 个崩溃循环占满日志，而是退避到上限后放弃并提示人工介入。

---

## 4. 功能需求

### 4.1 supervise 重启策略

| 参数 | 值 | 说明 |
|---|---|---|
| 稳定运行判定 | 本代时长 ≥ 60s | 达到则连续失败计数清零 |
| 退避序列 | 3s × 2^n（n=0,1,2,…），封顶 60s | 3 → 6 → 12 → 24 → 48 → 60 → 60 … |
| 连续失败上限 | 20 次 | 达到即放弃自动拉起，退出码 1，日志提示人工介入 |
| 哨兵轮询间隔 | 500ms | 退避等待期间 stop 即时生效 |

### 4.2 文件约定

| 文件 | 用途 | 生命周期 |
|---|---|---|
| `logs/supervisor.pid` | 守护进程 PID | supervise 启动时写、退出/stop 时删 |
| `logs/supervisor.stop` | 停止哨兵 | stop 写、supervise 退出时删 |
| `logs/supervisor.log` | 守护进程自身日志（追加） | 人工清理 |

### 4.3 错误与边界

- `DATA_SERVICE_TOKEN` 为空：supervise 与 start 一样直接报错退出；
- 守护进程被强杀（taskkill /F）未来得及清哨兵：下次 supervise 启动时
  **先清哨兵再写自身 PID**（幂等）；
- stop 时守护进程恰在拉起新一代的间隙：哨兵先写，新一代启动前的哨兵检查
  兜底，随后 stopOne 按 PID 文件清理；
- status 的 `supervisor.pid` 陈旧（进程已死）：显示"未运行（陈旧 PID 文件已清理）"
  并顺手清理，与现有子服务 PID 陈旧处理同风格。

---

## 5. 非功能需求

- **零新依赖**：只动 `scripts/`（Node 内置模块）与 `package.json` 一行；
- **幂等安全**：stop 可重复执行；supervise 重复启动仍受端口预检拦截（拒绝双开）；
- **可观测**：每次自动拉起都落 `logs/supervisor.log`（时间、服务名、退出码、
  重试序号）；`/health` 不变；
- **兼容性**：`start` / `stop` / `status` / `restart` 原有调用方式与退出码不变。

---

## 6. 数据模型 / API / 配置改动

| 位置 | 改动 |
|---|---|
| `docs/requirements/S3-5-supervise-crash-restart.md` | 本文件（先行） |
| `scripts/service.mjs` | 重构（抽 generation）+ supervise 子命令 + stop/status 升级 |
| `scripts/supervise-all.bat` | 新增薄包装 |
| `package.json` | 新增 `supervise:all` script |
| `docs/STATUS.md` | S3-5 行更新 + 更新日志 |
| `docs/FEATURES.md` | 新增进程管理 supervise 模式一节 |
| `README.md` | 快速开始补 supervise 说明 |

无数据库改动，无 `/api/*` 改动，无新增环境变量。

---

## 7. 验收标准

- [ ] `npm run typecheck` 通过；`npm test` 全绿；
- [ ] 替代端口 env 文件下：`supervise` 拉起双服务，`supervisor.pid` 写入；
- [ ] taskkill 杀主服务子进程 → `logs/supervisor.log` 出现崩溃记录 →
      退避后端口恢复（自动拉起成功）；
- [ ] 连续快速杀 2~3 次 → 日志中退避时长递增；
- [ ] `stop` 后：守护进程退出、双服务停止、30s 内无重新拉起、
      `supervisor.pid` / `supervisor.stop` 清理干净；重复 stop 不报错；
- [ ] `status` 守护行两态显示正确；
- [ ] `start` 前台模式行为不变（Ctrl+C 整体收尾、端口预检拒绝双开）；
- [ ] 生产迁移：`stop` 旧实例 → Start-Process 拉起 supervise-all（脱离会话）→
      `status` 双在线、`curl /health` 的 `dataService.ok=true`。

---

## 8. 审计要点

- `start` 子命令对外行为是否零变化（重构不得改语义）；
- stop 的"先写哨兵再杀守护进程"顺序是否杜绝"stop 后又被拉起"竞态；
- 退避等待期间能否被 stop 即时打断（500ms 轮询）；
- 连续失败 20 次上限是否真实兜底（不得无限重启）；
- supervise 重复启动是否仍被端口预检拦截；
- 端到端验证是否全程使用替代端口 env 文件（不得动生产 8000/18790，
  直至显式迁移步骤）。

---

## 9. 后续依赖

- 本需求只做"崩溃自动拉起"。若未来用户提出开机自启，在本需求 supervise
  模式基础上再评估 Windows 任务计划程序 / systemd（届时另写需求文档）。

---

## 10. 参考

- [STATUS S3-5](../STATUS.md)（进程守护层登记项）
- [REQ-S3-4](S3-4-process-management.md)（service.mjs 前一代需求，本需求在其上扩展）
- [PITFALLS bat 三雷条目](../PITFALLS.md)（bat 必须 CRLF + 纯 ASCII 注释）
