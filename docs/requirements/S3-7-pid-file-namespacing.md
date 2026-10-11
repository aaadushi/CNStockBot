# 需求文档：S3-7 PID 文件按端口命名空间化

> **文档编号**：REQ-S3-7
> **对应路线**：[STATUS S3-4/S3-5](../STATUS.md) 遗留问题（PITFALLS 2026-10-11 条目：
> "logs/*.pid 不按 --env-file 隔离"的根治）
> **目标读者**：下一个实现 agent / 代码审查 agent
> **状态**：已完成（2026-10-11，批次 43；含生产迁移，全部验收项通过）

---

## 1. 背景与目标

### 1.1 背景

PITFALLS（2026-10-11）记录的事故：`scripts/service.mjs`（S3-4/S3-5）把 PID 文件路径
写死为 `logs/<服务>.pid`，与 env 文件/端口无关。生产实例（8000/18790）在跑时用
`--env-file` 起替代端口（28000/28790）验证实例，`logs/main.pid` /
`logs/data-service.pid` 被后者覆盖——`status` / `stop` 开始指向验证实例；
验证实例 stop 删 PID 文件后，生产实例变成"有进程无 PID 文件"，`stop-all` 找不到它。
当时靠纪律 + 端口定位法（netstat/taskkill）规避，并登记"根治需把 PID 文件按端口
/env 命名空间化，留待后续需求处理"。本需求即该根治项。

此外同一隐患存在于 supervise 模式的守护进程文件：两个实例同用
`logs/supervisor.pid` / `logs/supervisor.stop` 时，stop 替代实例的哨兵会误杀生产
守护进程。

### 1.2 目标

1. PID 文件、守护进程 PID/哨兵文件按实例端口命名空间化，并行 `--env-file`
   实例互不覆盖、互不误杀；
2. `stop` / `status` 能管理**旧代码（S3-4/S3-5）拉起的存量实例**（遗留非命名空间
   PID 文件回退读取），保证生产无缝迁移，不需要为升级脚本而重启服务；
3. `start` / `supervise` 对外行为零变化（拉起/退避/哨兵语义不变）。

---

## 2. 范围

### 2.1 在本需求内（必须实现）

1. `scripts/service.mjs` 文件路径改造：
   - 由 `resolveEndpoints()` 的结果（mainPort/dsPort）派生全部控制文件路径：
     | 旧路径 | 新路径 |
     |---|---|
     | `logs/main.pid` | `logs/main-<mainPort>.pid` |
     | `logs/data-service.pid` | `logs/data-service-<dsPort>.pid` |
     | `logs/supervisor.pid` | `logs/supervisor-<mainPort>.pid` |
     | `logs/supervisor.stop` | `logs/supervisor-<mainPort>.stop` |
     | `logs/supervisor.log` | `logs/supervisor-<mainPort>.log` |
   - `start` / `supervise` 只写新路径（**不得双写旧路径**，否则并行实例覆盖问题
     原样复现）；
   - `stop` / `status` 读取时**先新后旧回退**：新路径文件不存在时回退读旧路径
     （`logs/main.pid` 等），管理到旧代码拉起的存量实例；用旧路径完成 stop 后
     同时清理新旧两个文件；
   - `cmdStop` 需要拿到 `endpoints`（现签名无参，main 已解析好，传入即可）。
2. 迁移保障：本需求合入后，**不重启生产服务**即可用新脚本 `status` 看到存量
   生产实例（回退读取）、`stop` 停掉它（走旧 PID 文件 + 旧 supervisor 文件回退）。
3. 文档同步：STATUS（新增 S3-7 行 + 更新日志）、FEATURES（第 41/45 节路径与
   "已知边界"改写）、PITFALLS（原条目补"已根治"状态）。

### 2.2 不在本需求内（明确不做）

1. **日志文件不动**：`logs/main.log` / `logs/data-service.log` 仍为两实例共享追加
   （内容交织但不丢数据；排查时以时间戳+端口前缀区分，改动日志路径会影响既有
   排障文档与习惯，收益不值）；
2. **端口预检逻辑不变**：仍按"端口占用即拒绝双开"，不引入实例注册表/锁文件；
3. 主服务 / data-service / 前端 / Android 壳零改动；
4. 开机自启、日志轮转（同 S3-5 明确不做项）。

---

## 3. 用户故事 / 动机

- **US-1（开发）**：用 `--env-file` 起替代端口实例做验证时，生产实例的
  `status` / `stop` 不再被劫持，验证结束各停各的；
- **US-2（运维）**：两个实例同时跑 supervise 模式时，stop 替代实例不会写哨兵
  误杀生产守护进程；
- **US-3（迁移）**：升级脚本本身不需要重启生产服务——新脚本认得旧 PID 文件。

---

## 4. 功能需求

### 4.1 路径派生规则

- 命名空间键 = `mainPort`（主服务端口，实例主键）；data-service PID 用 dsPort
  （同一实例内两者一一对应，任一都唯一标识实例，取各自服务的端口更直观）；
- 路径在 `main` 解析 endpoints 后统一计算并下传，不在各命令里重复拼字符串。

### 4.2 回退读取与归属规则

- `resolvePidFile(primary, legacy)`：primary 存在 → 用之；否则 legacy
  存在 → 用之；都不存在 → 返回 primary 路径（调用方按"无 PID 文件"处理）；
- `rmLegacyUnlessOwnedByOther(legacyFile)`：删除 legacy 文件前检查其记录的 PID
  是否仍是**存活进程**——是则保留并打印提示（该文件属于并行实例，删了就退回
  "有进程无 PID 文件"的老坑）；否则删除；
- `stopOne(name, primary, legacy)`：按回退结果定位 PID；完成停止后删除 resolved
  文件，legacy 文件一律经 `rmLegacyUnlessOwnedByOther` 清理；
- **守护进程归属门** `legacySupervisorBelongsElsewhere(files)`：旧版守护进程
  存活、且子服务已按**新版** PID 文件运行时，判定该旧守护属于另一实例——
  `stop` 不得写它的哨兵/杀它（否则停验证实例会顺手杀掉生产守护），`status`
  不把它报成本实例的守护（显示"检测到另一实例的旧版守护进程 PID=x，未代管"）；
  子服务同样回退命中旧版文件（生产迁移场景）时，旧守护视为本实例所有，正常
  走"写旧哨兵路径 → 杀守护"流程；
- `cmdStop` 的守护段：通过归属门后，回退命中旧 PID 文件时把哨兵写到**旧路径**
  （旧 supervise 进程轮询的是旧路径，写新路径它收不到 → "stop 后又被拉起"
  竞态复活）。

### 4.3 错误与边界

- 新旧 PID 文件同时存在且指向不同存活进程（并行实例/半迁移状态）：以新文件
  为准处理本实例；旧文件经 `rmLegacyUnlessOwnedByOther` **保留**（归属并行
  实例），不警告误报——守护进程侧由归属门给出"未代管"说明；
- 子服务新版 + 守护进程旧版（典型：生产 supervise 旧代码 + 替代端口 start）：
  stop/status 对旧守护一律"跳过 + 说明"，绝不写旧哨兵或杀旧守护；
- `status` 对不存在的 namespaced 文件 + 存在的 legacy 文件：正常走回退，
  不算"PID 文件陈旧"；陈旧文件（PID 已死）照旧顺手清理；
- 旧 supervise 进程被杀后写不了旧哨兵清理——无影响，stop 最后统一清理新旧
  哨兵（legacy 哨兵仅在 legacy supervisor 不属于存活实例时删除）。

---

## 5. 非功能需求

- **零新依赖**：仍只动 `scripts/` 与文档；
- **幂等安全**：stop 可重复执行；回退读取不改变任何退出码语义；
- **兼容性**：`.bat` / `.sh` 薄包装、npm scripts 全部不变（透传 `--env-file`）。

---

## 6. 数据模型 / API / 配置改动

| 位置 | 改动 |
|---|---|
| `docs/requirements/S3-7-pid-file-namespacing.md` | 本文件（先行） |
| `scripts/service.mjs` | 路径派生 + 写新读旧回退 + cmdStop 接收 endpoints |
| `docs/STATUS.md` | S3-7 行 + 更新日志 |
| `docs/FEATURES.md` | 第 41/45 节 PID 路径与"已知边界"更新 |
| `docs/PITFALLS.md` | 2026-10-11 条目补"已根治"注记 |

无数据库改动，无 `/api/*` 改动，无新增环境变量，无测试改动（service.mjs 无单测，
验证靠端到端命令）。

---

## 7. 验收标准

- [x] `npm run typecheck` 通过；`npm test` 全绿（44 文件 341 用例，本需求不改
      src/，零波动）；
- [x] **不重启生产**前提下：`node scripts/service.mjs status` 能显示存量生产
      实例（回退读取旧 PID 文件，守护行显示运行中）；
- [x] 替代端口 env 文件：`start` 拉起验证实例 → 生产实例的 `status` 仍指向
      生产 PID；验证实例写出的 PID 文件为 `logs/main-28790.pid` /
      `logs/data-service-28000.pid`（旧路径文件未被触碰/创建）；
- [x] 验证实例 `stop --env-file <alt>`：只停验证实例；生产守护进程存活
      （tasklist 实证）；legacy PID 文件全部被"保留"而非误删；生产 status
      无变化；
- [x] 生产实例 stop（旧 PID 文件回退路径，写旧哨兵 + 杀旧守护）→ 新旧 PID
      文件全部清理干净 → 以 supervise 模式重新拉起生产（PowerShell Start-Process
      脱离会话拉起 supervise-all.bat，新守护 PID 21288）→ `status` 守护行 +
      双服务在线，`/health` 的 `gitSha=18320ba`、`dataService.ok=true`；
- [x] 迁移后 `logs/` 不再残留无对应进程的旧式 `*.pid` / `supervisor.*` 控制
      文件（旧 `supervisor.log` 历史日志按计划保留）。

---

## 8. 审计要点

- 回退读取是否"先新后旧"；stop 收尾对 legacy 文件是否一律经
  `rmLegacyUnlessOwnedByOther`（指向存活进程时**必须保留**，不得无条件删）；
- `start` / `supervise` 是否只写新路径（双写旧路径 = 本需求白做）；
- 守护进程归属门：`stop` 在"子服务新版 + 守护旧版"时是否跳过旧守护（不写哨兵、
  不 killTree）；`status` 是否不把它报成本实例守护；
- 归属门通过（旧守护确属本实例）时，哨兵是否写到**旧路径**（写新路径旧进程
  轮询不到，"stop 后又被拉起"竞态复活）；
- 命名空间键是否取自 endpoints 解析结果（不得自己再读一遍 env）；
- 文档（STATUS/FEATURES/PITFALLS）与实际文件名是否逐字一致。

---

## 9. 后续依赖

- 无直接依赖。若未来日志也需要按实例隔离（如长期并行验证常态化），另起需求；
- 开机自启需求落地时需基于命名空间后的文件约定设计（届时另写需求文档）。

---

## 10. 参考

- [PITFALLS 2026-10-11 "S3-4 遗留：logs/*.pid 不按 --env-file 隔离"](../PITFALLS.md)
- [REQ-S3-4](S3-4-process-management.md)（service.mjs 初代需求）
- [REQ-S3-5](S3-5-supervise-crash-restart.md)（supervise 模式需求，守护文件约定来源）
