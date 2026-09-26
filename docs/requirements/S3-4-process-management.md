# 需求文档：S3-4 进程管理加固（一键启动 + /health 可观测性）

> **文档编号**：REQ-S3-4  
> **对应路线**：[STATUS 待办 S3-4](../STATUS.md)（P9 善后加固项）  
> **目标读者**：下一个实现 agent / 代码审查 agent  
> **状态**：已实现（2026-09-26，见 STATUS 更新日志批次 23）

---

## 1. 背景与目标

### 1.1 背景

P9（进程管理失控）已于 2026-09-19 恢复，但加固项一直未做。当前痛点（2026-09-26 重启双服务时再次确认）：

- 生产双服务（data-service :8000 + 主服务 :18790）随 agent 会话以裸后台进程运行，
  **电脑重启即失**，且启动步骤分散（venv 激活、DATA_SERVICE_TOKEN、uvicorn 参数、
  tsx 路径），手工操作易错；
- 手工启动没有任何"旧进程占端口"防御——PITFALLS 已多次记录旧进程占端口导致
  "改了代码不生效"的排查事故（tsx watch 不重载、uvicorn 同款）；
- `/health` 只暴露数据源名与技能清单，**看不出主服务跑了多久、跑的是哪个版本、
  data-service 现在通不通**——排障时只能翻日志。

### 1.2 目标

1. **一键启动脚本**：一条命令同时拉起 data-service 与主服务，带端口占用预检、
   日志落盘、PID 文件与配套停止/状态命令，Windows 与 POSIX 均可用。
2. **/health 增强**：暴露进程启动时间、版本号、git sha、data-service 连通性
   （带缓存的轻量探测），让"版本对不对、微服务通不通"一眼可见。

---

## 2. 范围

### 2.1 在本需求内（必须实现）

1. `scripts/service.mjs`：跨平台进程管理脚本（Node 单文件，零新依赖），子命令：
   - `start`：端口占用预检（8000/18790 或 env 指定值）→ 拉起 data-service
     （venv uvicorn，带 `DATA_SERVICE_TOKEN`）与主服务（`node node_modules/tsx/dist/cli.mjs
     src/index.ts`，**不用 tsx watch**——避开 PITFALLS 热重载失效坑）→
     stdout 镜像 + 追加写 `logs/*.log` → 写 PID 文件；任一子进程退出则整体收尾退出；
     SIGINT/SIGTERM 时杀掉子进程树并清理 PID 文件；
   - `stop`：按 PID 文件停止（Windows `taskkill /T /F` 杀进程树，POSIX 先 SIGTERM
     后 SIGKILL），清理失效 PID 文件；
   - `status`：显示 PID 存活状态与端口监听状态；
   - `--env-file <path>` 选项：指定 env 文件（默认仓库根 `.env`），**文件值优先**，
     便于在替代端口上并行验证而不碰生产实例。
2. 薄包装入口：`scripts/start-all.bat` / `scripts/stop-all.bat`（Windows 双击/命令行）、
   `scripts/start-all.sh` / `scripts/stop-all.sh`（POSIX），均转调 `service.mjs`。
3. `package.json` 新增 `start:all` / `stop:all` / `status:all` 三个 script。
4. `/health` 响应新增字段（纯增量，不改动现有字段）：
   - `version`：读 package.json；
   - `gitSha`：启动时 `git rev-parse --short HEAD`，失败（无 git/无 .git）为 null；
   - `startedAt`：进程启动时间 ISO 字符串；
   - `dataService`：`{ ok, latencyMs, checkedAt }` 或 `{ ok: false, error, checkedAt }`——
     带 token 调 data-service `/health`，3s 超时，**结果缓存 30s**（防 /health 轮询
     打爆微服务），任何异常不抛出、只标记 ok:false。
5. 启动前置校验：env 中 `DATA_SERVICE_TOKEN` 为空时 `start` 直接报错退出
   （data-service 会 fail-closed 拒启，提前给出人话提示）。
6. `.gitignore` 增加 `logs/`。
7. 测试：
   - `tests/health.test.ts`：dataService 探测成功/失败/超时分支、缓存命中（TTL 内不
     重复发请求、过期后重探）、带 token 头、健康负载字段齐全；
   - 启动脚本以替代端口 env 文件做一次端到端实测（见验收标准）。

### 2.2 不在本需求内（明确不做）

1. **守护/自动重启**（崩溃拉起、开机自启、systemd/Windows 服务注册）：本需求只解决
   "一条命令拉起、一条命令停掉、状态可见"，进程守护留给后续（如需再上 pm2/systemd）；
2. **data-service 定时健康探针 + 推送**（S3-4 原列的可选项）：/health 连通性探测已覆盖
   "通不通"的观测面；与 2026-09-22 用户反馈一致（告警对客户端透明、默认不推送），
   不再单建一套推送型探针；
3. 修改 `src/alerts/healthProbe.ts`（行情链路探针）既有行为；
4. Docker/容器化编排（公网部署文档 S4-3 已给反向代理方案，容器化无排期）；
5. 日志轮转（logs/ 追加写，量大后人工清理或由后续需求处理）；
6. 前端/Android 客户端任何改动（/health 无消费方，纯运维端点）。

---

## 3. 用户故事 / 动机

- **US-1（部署者）**：电脑重启后我运行 `scripts/start-all.bat` 一条命令就能把两个服务
  拉起来，日志在 logs/ 下，不用再记 venv 路径和 token 传递。
- **US-2（排查者）**：怀疑"改了代码没生效"时，我先 `status` 看端口与 PID，再 curl
  /health 对比 gitSha 与当前 main，30 秒内定位是不是旧进程（PITFALLS 占端口事故的
  第一道防线）。
- **US-3（运维）**：网页端大面积降级时，我 curl /health 看 `dataService.ok` 就能区分
  "data-service 挂了"还是"上游数据源挂了"，不用登服务器翻日志。

---

## 4. 功能需求

### 4.1 service.mjs 启动流程

1. 解析 `--env-file`（默认 `<repo>/.env`），文件不存在仅警告（主服务自身有随机
   ACCESS_TOKEN 兜底等逻辑，不强制 env 文件存在）；
2. 读 `DATA_SERVICE_TOKEN`（空 → 报错退出）；读 `PORT`（默认 18790）、
   `PYTHON_SERVICE_URL`（解析出 host/port，默认 127.0.0.1:8000）；
3. 端口预检：两个目标端口任一已被监听 → 打印占用者与"先 stop 或杀旧进程"提示，
   退出码 1（不允许双开，避免数据目录/库文件竞争）；
4. 确保 `logs/` 目录存在；以追加流打开 `logs/data-service.log`、`logs/main.log`；
5. 拉起 data-service：可执行文件解析顺序
   `data-service/.venv/Scripts/uvicorn.exe`（win32）→ `data-service/.venv/bin/uvicorn`
   → `python -m uvicorn`（PATH 兜底）；cwd=data-service；参数
   `main:app --host <host> --port <port>`；env 继承父进程并叠加 env 文件值；
6. 拉起主服务：`node node_modules/tsx/dist/cli.mjs src/index.ts`，cwd=仓库根；
7. 两路 stdout/stderr 同时镜像到控制台与对应日志文件；PID 写入
   `logs/data-service.pid`、`logs/main.pid`；
8. 监督：任一子进程退出（含崩溃）→ 打印退出码 → 停止另一进程 → 清理 PID 文件 →
   以该退出码退出；
9. 自身收到 SIGINT/SIGTERM → 同样收尾（杀进程树、清理 PID 文件）。

### 4.2 stop / status

- `stop`：读 PID 文件 → 存活则杀（win32 `taskkill /pid <pid> /T /F`；POSIX 先
  SIGTERM，2s 后仍存活再 SIGKILL）→ 删除 PID 文件；PID 文件不存在/进程已死 →
  提示并清理陈旧文件，退出码 0；
- `status`：逐服务显示 PID（或"未运行"）与端口监听状态（net.connect 探测），
  **双服务全部运行退出码 0，否则 1**（部分运行视为异常，便于脚本判断）。

### 4.3 /health 新字段

```jsonc
{
  "ok": true,
  "version": "0.4.0",          // package.json；读取失败 "unknown"
  "gitSha": "c357764",          // 短 sha；无 git 环境 null
  "startedAt": "2026-09-26T08:00:00.000Z",
  "dataProvider": "composite",
  "dataService": {              // 缓存 30s 的轻量探测
    "ok": true, "latencyMs": 12, "checkedAt": "2026-09-26T08:00:30.000Z"
    // 失败时: { "ok": false, "error": "connect ECONNREFUSED …", "checkedAt": "…" }
  },
  "skills": [ /* 不变 */ ],
  "quoteProbe": { /* 不变 */ }
}
```

- 探测请求：`GET {PYTHON_SERVICE_URL}/health`，带 `Authorization: Bearer <token>`，
  `AbortSignal.timeout(3000)`；HTTP 非 2xx 视为 ok:false（error 含状态码）；
- 实现落点：新模块 `src/health.ts`（构建信息 + 探测函数 + 缓存），`src/index.ts`
  的 `/health` handler 改为 async 并合并新字段；
- 探测工厂可注入 fetch/now 以便单测（`createDataServiceProber`），默认实例给
  index.ts 用。

### 4.4 错误与边界

- env 文件缺 `DATA_SERVICE_TOKEN`：start 报错退出（不拉起任何进程）；
- venv 不存在：回退 PATH 上的 `python -m uvicorn`，再失败则子进程非零退出被监督
  逻辑捕获并打印日志尾部提示；
- /health 探测失败不影响 `ok: true`（主服务自身健康）与既有字段；
- git 命令不可用/仓库无 .git：`gitSha: null`，不抛错。

---

## 5. 非功能需求

- **零新依赖**：脚本只用 Node 内置模块（child_process/net/fs/path/url）+ 项目已有
  的 dotenv；主服务侧只用内置模块；
- **幂等安全**：stop 可重复执行；PID 文件陈旧自动清理；start 拒绝端口双开；
- **性能**：/health 的 dataService 探测缓存 30s，连续轮询不会打爆微服务；
  探测超时 3s 不拖慢 /health 响应；
- **兼容性**：/health 纯增量字段，无消费方需要同步改；Windows/POSIX 脚本行为一致；
- **可测试**：探测逻辑工厂注入；脚本逻辑薄（spawn/杀进程）以端到端实测验收。

---

## 6. 数据模型 / API / 配置改动

| 位置 | 改动 |
|---|---|
| `scripts/service.mjs` | 新增：进程管理脚本（start/stop/status，--env-file） |
| `scripts/start-all.bat` / `stop-all.bat` | 新增：Windows 薄包装 |
| `scripts/start-all.sh` / `stop-all.sh` | 新增：POSIX 薄包装（chmod +x） |
| `src/health.ts` | 新增：version/gitSha/startedAt + dataService 探测（30s 缓存） |
| `src/index.ts` | `/health` handler 改 async，合并新字段 |
| `package.json` | 新增 `start:all` / `stop:all` / `status:all` scripts |
| `.gitignore` | 新增 `logs/` |
| `tests/health.test.ts` | 新增：探测与负载字段单测 |
| `README.md` | 快速开始节补一键启动说明 |
| `docs/FEATURES.md` | 新增第 41 节 |
| `docs/STATUS.md` | S3-4 行更新 + 更新日志 |

无数据库改动，无对外 `/api/*` 改动，无配置项新增（复用 PORT/PYTHON_SERVICE_URL/
DATA_SERVICE_TOKEN）。

---

## 7. 验收标准

- [x] `node scripts/service.mjs start` 在干净环境下一条命令拉起双服务，日志同时进
      控制台与 `logs/*.log`，PID 文件生成；
- [x] 端口已被占用时 start 拒绝双开并给出明确提示；
- [x] `stop` 后双端口释放、PID 文件清理；`stop` 重复执行不报错；
- [x] `status` 正确显示运行/停止状态；
- [x] 子进程崩溃/CTRL+C 时整体收尾，不留孤儿进程占端口（PITFALLS 占端口事故防线）；
- [x] `DATA_SERVICE_TOKEN` 为空时 start 直接报错且不拉起进程；
- [x] `--env-file` 指向替代端口 env 时，双服务在替代端口拉起，生产端口不受影响；
- [x] `curl /health` 返回 version/gitSha/startedAt/dataService 四新字段，与实际情况
      一致（data-service 停止时 `dataService.ok=false` 且主服务仍 `ok:true`）；
- [x] /health 连续请求两次，第二次命中 30s 缓存（data-service 侧无新请求）；
- [x] `npm run typecheck` 通过；`npm test` 全绿（含新增 health 测试）。

---

## 8. 审计要点

- start 是否**不用** `tsx watch`（PITFALLS 热重载失效坑）；是否带端口预检；
- 子进程退出/信号收尾是否杀**进程树**（Windows npx/cmd 中间层会留孤儿）；
- /health 探测是否带 token、是否缓存、异常是否绝不抛出（不能让 /health 500）；
- gitSha 获取失败是否降级 null 而非崩溃；
- 脚本是否零新依赖、.gitignore 是否覆盖 logs/；
- 实测验收是否用替代端口 env 文件（不得动生产 8000/18790 实例）。

---

## 9. 后续依赖

- 一键启动脚本是 F7-1（公网部署端到端验证）部署手册的现实前置——部署者按
  HTTPS.md 配好反代后用 start-all 拉起应用；
- 若后续需要崩溃自动拉起/开机自启，在本脚本基础上再评估 pm2/systemd（本需求
  明确不做）。

---

## 10. 参考

- [STATUS S3-4](../STATUS.md)（P9 善后加固项）
- [PITFALLS 旧进程占端口条目](../PITFALLS.md)
- [docs/deploy/HTTPS.md](../deploy/HTTPS.md)（部署侧反代方案，S4-3）
