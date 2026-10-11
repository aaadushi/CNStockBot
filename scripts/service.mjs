#!/usr/bin/env node
/**
 * CNStockBot 双服务进程管理（S3-4 + S3-5）：
 * 一条命令拉起/停止/守护 data-service + 主服务。
 *
 * 用法：
 *   node scripts/service.mjs start [--env-file <path>]     前台监督模式（保持窗口开启，任一退出即整体停）
 *   node scripts/service.mjs supervise [--env-file <path>] 守护模式：崩溃自动拉起（指数退避，S3-5）
 *   node scripts/service.mjs stop  [--env-file <path>]     按 PID 文件停止（含守护循环，S3-5）
 *   node scripts/service.mjs status [--env-file <path>]    查看守护进程 + PID 存活与端口监听状态
 *   node scripts/service.mjs restart [--env-file <path>]   = stop + start
 *
 * 约定：
 * - --env-file 默认 <repo>/.env，**文件值优先于进程环境变量**，便于用替代端口并行验证；
 * - 子进程日志镜像到控制台与 logs/<服务>.log；PID 写 logs/<服务>-<port>.pid（S3-7
 *   按端口命名空间化，并行 --env-file 实例互不覆盖；stop/status 先新后旧回退读取，
 *   可管理 S3-4/S3-5 旧代码拉起的存量实例）；
 * - 端口占用预检拒绝双开（PITFALLS"旧进程占端口"事故防线）；
 * - supervise 模式（REQ-S3-5）：子进程崩溃自动拉起，3s 起指数退避封顶 60s，
 *   连续失败 20 次放弃；守护进程自身 PID 写 logs/supervisor-<mainPort>.pid，
 *   自身日志写 logs/supervisor-<mainPort>.log；stop 先写
 *   logs/supervisor-<mainPort>.stop 哨兵再杀守护进程，杜绝"stop 后又被拉起"；
 *   守护文件与 PID 文件同口径命名空间化（REQ-S3-7），stop 旧守护时写旧哨兵路径；
 * - 开机自启（任务计划程序/systemd/pm2）不在本脚本范围（REQ-S3-5 明确不做）。
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const logsDir = path.join(repoRoot, 'logs');

/**
 * S3-7：控制文件（PID/哨兵）按实例端口命名空间化，并行 --env-file 实例互不覆盖。
 * legacy 路径为 S3-4/S3-5 旧版文件名，stop/status 先新后旧回退读取以管理存量实例。
 */
function controlFiles(endpoints) {
  const { mainPort, dsPort } = endpoints;
  return {
    mainPid: path.join(logsDir, `main-${mainPort}.pid`),
    mainPidLegacy: path.join(logsDir, 'main.pid'),
    dsPid: path.join(logsDir, `data-service-${dsPort}.pid`),
    dsPidLegacy: path.join(logsDir, 'data-service.pid'),
    supPid: path.join(logsDir, `supervisor-${mainPort}.pid`),
    supPidLegacy: path.join(logsDir, 'supervisor.pid'),
    supStop: path.join(logsDir, `supervisor-${mainPort}.stop`),
    supStopLegacy: path.join(logsDir, 'supervisor.stop'),
    supLog: path.join(logsDir, `supervisor-${mainPort}.log`),
  };
}

// ---------- 参数与 env ----------

function parseArgs(argv) {
  let command = null;
  let envFile = '.env';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env-file') {
      envFile = argv[++i] ?? '';
      if (!envFile) fatal('--env-file 需要一个路径参数');
    } else if (!command) {
      command = a;
    } else {
      fatal(`无法识别的参数：${a}`);
    }
  }
  if (!command) fatal('缺少子命令：start | supervise | stop | status | restart');
  return { command, envFile };
}

function fatal(msg) {
  console.error(`[service] ${msg}`);
  process.exit(1);
}

function loadServiceEnv(envFile) {
  const envPath = path.resolve(repoRoot, envFile);
  let fileEnv = {};
  if (existsSync(envPath)) {
    fileEnv = loadEnv({ path: envPath }).parsed ?? {};
  } else {
    console.warn(`[service] env 文件不存在：${envPath}（继续，依赖进程环境变量）`);
  }
  return { ...process.env, ...fileEnv };
}

/** data-service 的 host/port 从 PYTHON_SERVICE_URL 解析（默认 127.0.0.1:8000） */
function resolveEndpoints(env) {
  const mainPort = Number(env.PORT) || 18790;
  let dsHost = '127.0.0.1';
  let dsPort = 8000;
  try {
    const u = new URL(env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000');
    dsHost = u.hostname || dsHost;
    dsPort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch {
    console.warn('[service] PYTHON_SERVICE_URL 解析失败，回退 127.0.0.1:8000');
  }
  return { mainPort, dsHost, dsPort };
}

function requireToken(env) {
  const token = (env.DATA_SERVICE_TOKEN ?? '').trim();
  if (!token) {
    fatal('DATA_SERVICE_TOKEN 未配置（data-service 会拒绝启动）。请在 .env 中设置后重试。');
  }
}

// ---------- 小工具 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (open) => {
      sock.destroy();
      resolve(open);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

function readPid(pidFile) {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** S3-7：先新后旧回退选 PID 文件（新版命名空间文件优先，旧版文件兜底存量实例）。 */
function resolvePidFile(primary, legacy) {
  if (existsSync(primary)) return primary;
  if (legacy && existsSync(legacy)) return legacy;
  return primary;
}

/**
 * S3-7：删除 legacy PID 文件；若它指向另一个仍在运行的进程（属于并行实例），
 * 则保留并提示——那是别人的归属文件，删了就又退回"有进程无 PID 文件"的老坑。
 */
function rmLegacyUnlessOwnedByOther(legacyFile) {
  if (!legacyFile || !existsSync(legacyFile)) return;
  const pid = readPid(legacyFile);
  if (pid && isAlive(pid)) {
    console.log(`[service] 保留旧版 ${path.basename(legacyFile)}：仍指向运行中的其他实例进程（PID ${pid}）`);
    return;
  }
  rmSync(legacyFile, { force: true });
}

/** 杀进程树：Windows 必须 taskkill /T（npx/cmd 中间层直接 kill 会留孤儿） */
function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const t = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      t.on('exit', () => resolve());
      t.on('error', () => resolve());
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // 进程已退出
      }
      resolve();
    }
  });
}

async function stopOne(name, primaryFile, legacyFile) {
  const pidFile = resolvePidFile(primaryFile, legacyFile);
  const usingLegacy = pidFile === legacyFile && existsSync(pidFile);
  const pid = readPid(pidFile);
  if (!pid) {
    if (existsSync(pidFile)) {
      rmSync(pidFile, { force: true });
      console.log(`[service] ${name}: PID 文件内容无效，已清理`);
    } else {
      console.log(`[service] ${name}: 未运行（无 PID 文件）`);
    }
    rmLegacyUnlessOwnedByOther(legacyFile);
    return;
  }
  if (!isAlive(pid)) {
    rmSync(pidFile, { force: true });
    rmLegacyUnlessOwnedByOther(legacyFile);
    console.log(`[service] ${name}: PID ${pid} 已不存在（陈旧 PID 文件），已清理`);
    return;
  }
  console.log(`[service] 停止 ${name} (PID ${pid}${usingLegacy ? '，旧版 PID 文件' : ''})…`);
  await killTree(pid);
  const deadline = Date.now() + 3000;
  while (isAlive(pid) && Date.now() < deadline) await sleep(200);
  if (isAlive(pid)) {
    console.log(`[service] ${name} 仍未退出，强制结束`);
    await killTree(pid);
    await sleep(500);
  }
  rmSync(pidFile, { force: true });
  rmLegacyUnlessOwnedByOther(legacyFile);
  console.log(`[service] ${name}: 已停止`);
}

// ---------- start / supervise 共用：跑"一代"子进程 ----------

/**
 * 拉起一代双服务并监督。resolve 值：
 * - { reason: 'child-exit', name, code, startedAt }  某个子进程退出（另一个已一并清理）
 * - { reason: 'signal', detail, startedAt }          收到了 shutdown()（SIGINT/Ctrl+C/关窗/stop 哨兵）
 * 端口预检失败返回 null（错误信息已打印）。
 */
function runOneGeneration(env, endpoints, files, mode = 'start') {
  const { mainPort, dsHost, dsPort } = endpoints;

  // 端口占用预检：拒绝双开（PITFALLS 旧进程占端口事故防线）
  const precheck = (async () => {
    const busy = [];
    if (await portOpen(dsPort)) busy.push(`data-service 端口 ${dsPort}`);
    if (await portOpen(mainPort)) busy.push(`主服务端口 ${mainPort}`);
    if (busy.length > 0) {
      console.error(`[service] ${busy.join('、')} 已被占用，拒绝双开。`);
      console.error('[service] 若是旧实例：先运行 stop（或 scripts/stop-all），再手动确认端口已释放。');
      return false;
    }
    return true;
  })();

  const startedAt = Date.now();
  let shuttingDown = false;
  let shutdownDetail = '';
  let finished = false;
  let finishResolve;
  const stopped = new Promise((resolve) => {
    finishResolve = resolve;
  });

  const gen = {
    startedAt,
    stopped,
    /** 请求本代收尾：杀掉双服务（触发 signal 结果），不再重启。 */
    shutdown(detail) {
      if (shuttingDown || finished) return;
      shuttingDown = true;
      shutdownDetail = detail;
      for (const s of gen._services ?? []) {
        if (s.child.pid && isAlive(s.child.pid)) void killTree(s.child.pid);
      }
    },
  };

  void (async () => {
    if (!(await precheck)) {
      finished = true;
      finishResolve(null);
      return;
    }

    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!existsSync(tsxCli)) fatal('未找到 node_modules/tsx，请先在仓库根目录执行 npm install');

    mkdirSync(logsDir, { recursive: true });

    // data-service：优先 venv 内的 uvicorn，回退 PATH 上的 python -m uvicorn
    const venvUvicorn =
      process.platform === 'win32'
        ? path.join(repoRoot, 'data-service', '.venv', 'Scripts', 'uvicorn.exe')
        : path.join(repoRoot, 'data-service', '.venv', 'bin', 'uvicorn');
    const useVenv = existsSync(venvUvicorn);
    const dsCmd = useVenv ? venvUvicorn : process.platform === 'win32' ? 'python' : 'python3';
    const dsArgs = [...(useVenv ? [] : ['-m', 'uvicorn']), 'main:app', '--host', dsHost, '--port', String(dsPort)];
    if (!useVenv) console.warn('[service] 未找到 data-service/.venv，回退 PATH 上的 python -m uvicorn');

    const childEnv = { ...env, PYTHONIOENCODING: env.PYTHONIOENCODING || 'utf-8' };

    console.log(`[service] 启动 data-service: ${dsCmd} ${dsArgs.join(' ')}（cwd data-service/）`);
    const ds = spawn(dsCmd, dsArgs, {
      cwd: path.join(repoRoot, 'data-service'),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    console.log(`[service] 启动主服务: node tsx src/index.ts（PORT=${mainPort}）`);
    const main = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 日志镜像：控制台 + logs/<服务>.log 追加
    const dsLog = createWriteStream(path.join(logsDir, 'data-service.log'), { flags: 'a' });
    const mainLog = createWriteStream(path.join(logsDir, 'main.log'), { flags: 'a' });
    const mirror = (stream, logStream) => {
      if (!stream) return;
      stream.on('data', (chunk) => {
        process.stdout.write(chunk);
        logStream.write(chunk);
      });
    };
    mirror(ds.stdout, dsLog);
    mirror(ds.stderr, dsLog);
    mirror(main.stdout, mainLog);
    mirror(main.stderr, mainLog);

    const services = [
      { name: 'data-service', child: ds, file: files.dsPid },
      { name: '主服务', child: main, file: files.mainPid },
    ];
    gen._services = services;
    for (const s of services) {
      if (s.child.pid) writeFileSync(s.file, String(s.child.pid));
    }
    // spawn 同步失败（如 python 不存在）时 'error' 事件触发，pid 可能为 undefined
    for (const s of services) {
      if (!s.child.pid) {
        console.error(`[service] ${s.name} 启动失败（可执行文件不存在？），查看上方错误`);
      }
    }

    const modeHint =
      mode === 'supervise'
        ? '守护 supervise 模式：崩溃自动拉起；stop 命令或 Ctrl+C 终止守护。'
        : '前台 start 模式：保持本窗口开启；Ctrl+C 或关闭窗口即停止双服务。';
    console.log(`[service] 双服务已拉起。${modeHint}`);

    const cleanup = () => {
      for (const s of services) rmSync(s.file, { force: true });
      dsLog.end();
      mainLog.end();
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      cleanup();
      finishResolve({ ...result, startedAt });
    };

    // 先退出者是"肇事者"；另一个由我们 killTree 清理，其退出事件不重复记录
    let crashInfo = null;
    const onChildExit = (s, code, signal) => {
      if (finished) return;
      if (shuttingDown) {
        finish({ reason: 'signal', detail: shutdownDetail });
        return;
      }
      if (!crashInfo) {
        crashInfo = { name: s.name, code: code ?? 1 };
        console.error(`[service] ${s.name} 退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`);
        // 崩溃路径：另一个一并清理后收尾，由调用方决定是整体退出（start）还是重启（supervise）
        const other = services.find((x) => x !== s);
        void (async () => {
          if (other && other.child.pid && isAlive(other.child.pid)) await killTree(other.child.pid);
          await sleep(300); // 等端口释放，下一代预检才不会误报双开
          finish({ reason: 'child-exit', ...crashInfo });
        })();
      }
    };

    ds.on('exit', (code, signal) => onChildExit(services[0], code, signal));
    main.on('exit', (code, signal) => onChildExit(services[1], code, signal));
    ds.on('error', (err) => {
      if (!finished) console.error(`[service] data-service 启动错误：${err.message}`);
      onChildExit(services[0], 1, null);
    });
    main.on('error', (err) => {
      if (!finished) console.error(`[service] 主服务启动错误：${err.message}`);
      onChildExit(services[1], 1, null);
    });

    // spawn 是异步的：若期间已收到停止信号（shutdown 时 _services 尚不存在），立即补杀
    if (shuttingDown) {
      for (const s of services) {
        if (s.child.pid && isAlive(s.child.pid)) void killTree(s.child.pid);
      }
    }
  })();

  return gen;
}

/** start / supervise 共用的信号处理：收到信号即收尾本代。返回解绑函数。 */
function bindShutdownSignals(gen) {
  const handler = (sig) => {
    console.log(`\n[service] 收到 ${sig}，正在停止双服务…`);
    gen.shutdown(`收到 ${sig}`);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, handler);
  // Windows 关窗：尽力而为（CTRL_CLOSE 等事件不保证送达，stop 命令可清理残留）
  if (process.platform === 'win32') process.on('SIGHUP', handler);
  return () => {
    for (const sig of ['SIGINT', 'SIGTERM']) process.off(sig, handler);
    if (process.platform === 'win32') process.off('SIGHUP', handler);
  };
}

// ---------- start ----------

async function cmdStart(env, endpoints, files) {
  requireToken(env);
  const gen = runOneGeneration(env, endpoints, files);
  const unbind = bindShutdownSignals(gen);
  const result = await gen.stopped;
  unbind();
  if (result === null) process.exit(1); // 端口预检失败
  if (result.reason === 'child-exit') {
    console.log(`[service] ${result.name} 退出，双服务已停止。查看 logs/ 排查原因。`);
    process.exit(result.code ?? 1);
  }
  console.log(`[service] ${result.detail ?? '停止请求'}，双服务已停止。`);
  process.exit(0);
}

// ---------- supervise（S3-5：崩溃自动拉起） ----------

const STABLE_UPTIME_MS = 60_000; // 本代运行 ≥60s 视为稳定，连续失败计数清零
const MAX_CONSECUTIVE_FAILURES = 20; // 连续失败上限：防崩溃风暴
const BACKOFF_BASE_MS = 3_000; // 退避 3s → 6s → 12s → … 封顶 60s
const BACKOFF_CAP_MS = 60_000;
const SENTINEL_POLL_MS = 500; // 退避等待期间哨兵轮询间隔（stop 即时打断）

async function cmdSupervise(env, endpoints, files) {
  requireToken(env);
  mkdirSync(logsDir, { recursive: true });

  // 幂等：清掉上次强杀遗留的哨兵（新旧路径都清），再写自身 PID
  rmSync(files.supStop, { force: true });
  rmSync(files.supStopLegacy, { force: true });
  writeFileSync(files.supPid, String(process.pid));

  const supLog = createWriteStream(files.supLog, { flags: 'a' });
  const slog = (msg) => {
    const line = `[supervisor ${new Date().toISOString()}] ${msg}`;
    console.log(line);
    supLog.write(line + '\n');
  };

  let gen = null;
  let stopRequested = false;
  const requestStop = (detail) => {
    stopRequested = true;
    if (gen) gen.shutdown(detail);
  };
  const sigHandler = (sig) => requestStop(`收到 ${sig}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, sigHandler);
  if (process.platform === 'win32') process.on('SIGHUP', sigHandler);

  /** 可打断的睡眠：stop 请求或哨兵出现即返回 false。 */
  const sleepInterruptible = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (stopRequested || existsSync(files.supStop)) return false;
      await sleep(Math.min(SENTINEL_POLL_MS, deadline - Date.now()));
    }
    return !stopRequested && !existsSync(files.supStop);
  };

  slog(`守护模式启动（PID ${process.pid}）。崩溃自动拉起（退避 3s 起封顶 60s，连续失败 ${MAX_CONSECUTIVE_FAILURES} 次放弃）；stop 命令终止守护。`);

  let consecutiveFailures = 0;
  let exitCode = 0;
  while (true) {
    if (stopRequested || existsSync(files.supStop)) {
      slog('收到停止请求，退出守护。');
      break;
    }
    gen = runOneGeneration(env, endpoints, files, 'supervise');
    const result = await gen.stopped;
    gen = null;
    if (result === null) {
      // 端口预检失败：按失败计次并退避重试（stop 可终止等待）
      consecutiveFailures++;
      slog(`端口预检失败（第 ${consecutiveFailures} 次连续失败），稍后重试。`);
    } else if (result.reason === 'signal') {
      slog(`${result.detail}，退出守护。`);
      break;
    } else {
      const uptimeSec = (Date.now() - result.startedAt) / 1000;
      if (uptimeSec * 1000 >= STABLE_UPTIME_MS) {
        consecutiveFailures = 0;
        slog(`${result.name} 退出（code=${result.code}），本代运行 ${uptimeSec.toFixed(1)}s（≥60s 视为稳定，连续失败计数清零）。`);
      } else {
        consecutiveFailures++;
        slog(`${result.name} 退出（code=${result.code}），本代运行 ${uptimeSec.toFixed(1)}s，第 ${consecutiveFailures} 次连续失败。`);
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        slog(`连续失败达上限 ${MAX_CONSECUTIVE_FAILURES} 次，放弃自动拉起，需人工介入（查 logs/main.log 或 logs/data-service.log）。`);
        exitCode = 1;
        break;
      }
    }
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1));
    slog(`${Math.round(delay / 1000)}s 后重启双服务…（stop 可终止等待）`);
    if (!(await sleepInterruptible(delay))) {
      slog('等待期间收到停止请求，退出守护。');
      break;
    }
  }

  // 收尾：清理 PID 文件与哨兵（子进程已由 generation 内部清理）；新旧路径都清
  rmSync(files.supPid, { force: true });
  rmSync(files.supPidLegacy, { force: true });
  rmSync(files.supStop, { force: true });
  rmSync(files.supStopLegacy, { force: true });
  supLog.end();
  process.exit(exitCode);
}

// ---------- stop / status ----------

/**
 * 旧版守护进程归属校验（S3-7）：子服务已按新版 PID 文件运行、守护进程却命中旧版
 * 文件时，说明该旧守护属于另一实例（如生产 supervise + 替代端口 start 并行），
 * 不得写它的哨兵/杀它，否则停验证实例会顺手杀掉生产守护。
 */
function legacySupervisorBelongsElsewhere(files) {
  const supLegacy = readPid(files.supPidLegacy);
  if (!supLegacy || !isAlive(supLegacy)) return false; // 没有活着的旧守护，无从误杀
  const mainFile = resolvePidFile(files.mainPid, files.mainPidLegacy);
  const dsFile = resolvePidFile(files.dsPid, files.dsPidLegacy);
  const childUsesPrimary = mainFile === files.mainPid || dsFile === files.dsPid;
  return childUsesPrimary; // 子服务走新版文件 → 旧守护不是本实例的
}

async function cmdStop(files) {
  // S3-5：先写哨兵再杀守护进程，杜绝"stop 完又被守护循环拉起"。
  // S3-7：旧守护进程（S3-5 代码）轮询的是旧哨兵路径，回退命中旧 PID 文件时
  // 必须把哨兵写到旧路径，否则旧守护收不到停止信号会被误杀后又被拉起；
  // 但若旧守护属于另一实例（本子服务按新版 PID 文件运行），则一律不得触碰。
  const belongsElsewhere = legacySupervisorBelongsElsewhere(files);
  const supUsingLegacy =
    !belongsElsewhere && resolvePidFile(files.supPid, files.supPidLegacy) === files.supPidLegacy && existsSync(files.supPidLegacy);
  const supStopTarget = supUsingLegacy ? files.supStopLegacy : files.supStop;
  let supPid = readPid(resolvePidFile(files.supPid, files.supPidLegacy));
  if (supPid && belongsElsewhere) {
    console.warn(
      `[service] 检测到旧版守护进程（PID ${supPid}）属于另一实例（本子服务按新版 PID 文件运行），已跳过；` +
        '如需停止它，请在它对应的 env/端口下执行 stop。',
    );
    supPid = null;
  }
  if (supPid) {
    writeFileSync(supStopTarget, String(Date.now()));
    if (isAlive(supPid)) {
      console.log(`[service] 停止守护进程 (PID ${supPid}${supUsingLegacy ? '，旧版 supervisor PID 文件' : ''})…`);
      await killTree(supPid);
      const deadline = Date.now() + 3000;
      while (isAlive(supPid) && Date.now() < deadline) await sleep(200);
      if (isAlive(supPid)) console.log('[service] 守护进程仍在，继续清理子服务');
    }
  }
  await stopOne('data-service', files.dsPid, files.dsPidLegacy);
  await stopOne('主服务', files.mainPid, files.mainPidLegacy);
  // 收尾：新版路径直接清；旧版路径仅在不属于其他存活实例时清（半迁移防误删）
  rmSync(files.supPid, { force: true });
  rmSync(files.supStop, { force: true });
  rmLegacyUnlessOwnedByOther(files.supPidLegacy);
  if (!existsSync(files.supPidLegacy)) rmSync(files.supStopLegacy, { force: true });
}

async function cmdStatus(endpoints, files) {
  const { mainPort, dsPort } = endpoints;
  // S3-5：守护进程状态行（不影响退出码）；S3-7：先新后旧回退读取 +
  // 归属校验（旧守护属于另一实例时不把它报成本实例的守护）
  const supFile = resolvePidFile(files.supPid, files.supPidLegacy);
  const supUsingLegacy = supFile === files.supPidLegacy && existsSync(supFile);
  const supPid = readPid(supFile);
  const supAlive = supPid ? isAlive(supPid) : false;
  if (supAlive && !(supUsingLegacy && legacySupervisorBelongsElsewhere(files))) {
    console.log(
      `[service] 守护进程: PID=${supPid} 运行中（supervise 模式${supUsingLegacy ? '，旧版 supervisor PID 文件' : ''}）`,
    );
  } else if (supAlive) {
    console.log(`[service] 守护进程: 未运行（本实例无守护；检测到另一实例的旧版守护进程 PID=${supPid}，未代管）`);
  } else {
    if (supPid) {
      rmSync(supFile, { force: true });
      console.log('[service] 守护进程: 未运行（陈旧 PID 文件已清理）');
    } else {
      console.log('[service] 守护进程: 未运行（前台 start 模式或无守护）');
    }
  }
  const rows = [
    { name: 'data-service', pidFile: files.dsPid, pidLegacy: files.dsPidLegacy, port: dsPort },
    { name: '主服务', pidFile: files.mainPid, pidLegacy: files.mainPidLegacy, port: mainPort },
  ];
  let allRunning = true;
  for (const r of rows) {
    const pidFile = resolvePidFile(r.pidFile, r.pidLegacy);
    const usingLegacy = pidFile === r.pidLegacy && existsSync(pidFile);
    const pid = readPid(pidFile);
    const alive = pid ? isAlive(pid) : false;
    const listening = await portOpen(r.port);
    if (!alive || !listening) allRunning = false;
    console.log(
      `[service] ${r.name}: PID=${alive ? pid : '未运行'} 端口 ${r.port}=${listening ? '监听中' : '未监听'}` +
        (alive && usingLegacy ? '（旧版 PID 文件）' : '') +
        (pid && !alive ? '（PID 文件陈旧，可运行 stop 清理）' : ''),
    );
  }
  process.exit(allRunning ? 0 : 1);
}

// ---------- main ----------

const { command, envFile } = parseArgs(process.argv.slice(2));
const env = loadServiceEnv(envFile);
const endpoints = resolveEndpoints(env);
const files = controlFiles(endpoints);

if (command === 'start') {
  await cmdStart(env, endpoints, files);
} else if (command === 'supervise') {
  await cmdSupervise(env, endpoints, files);
} else if (command === 'stop') {
  await cmdStop(files);
} else if (command === 'status') {
  await cmdStatus(endpoints, files);
} else if (command === 'restart') {
  await cmdStop(files);
  await cmdStart(env, endpoints, files);
} else {
  fatal(`未知子命令：${command}（可用：start | supervise | stop | status | restart）`);
}
