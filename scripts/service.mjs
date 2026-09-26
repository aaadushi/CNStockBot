#!/usr/bin/env node
/**
 * CNStockBot 双服务进程管理（S3-4）：一条命令拉起/停止 data-service + 主服务。
 *
 * 用法：
 *   node scripts/service.mjs start [--env-file <path>]   前台监督模式启动双服务（保持窗口开启）
 *   node scripts/service.mjs stop  [--env-file <path>]   按 PID 文件停止并清理
 *   node scripts/service.mjs status [--env-file <path>]  查看 PID 存活与端口监听状态
 *   node scripts/service.mjs restart [--env-file <path>] = stop + start
 *
 * 约定：
 * - --env-file 默认 <repo>/.env，**文件值优先于进程环境变量**，便于用替代端口并行验证；
 * - start 为前台监督模式：任一子进程退出则整体收尾；Ctrl+C / 关窗即停止双服务；
 * - 日志同时镜像到控制台与 logs/<服务>.log；PID 写 logs/<服务>.pid；
 * - 端口占用预检拒绝双开（PITFALLS"旧进程占端口"事故防线）；
 * - 只做"拉起/停止/可见"，不做崩溃自动拉起与开机自启（需求文档 REQ-S3-4 明确范围）。
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const logsDir = path.join(repoRoot, 'logs');

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
  if (!command) fatal('缺少子命令：start | stop | status | restart');
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

async function stopOne(name, pidFile) {
  const pid = readPid(pidFile);
  if (!pid) {
    if (existsSync(pidFile)) {
      rmSync(pidFile, { force: true });
      console.log(`[service] ${name}: PID 文件内容无效，已清理`);
    } else {
      console.log(`[service] ${name}: 未运行（无 PID 文件）`);
    }
    return;
  }
  if (!isAlive(pid)) {
    rmSync(pidFile, { force: true });
    console.log(`[service] ${name}: PID ${pid} 已不存在（陈旧 PID 文件），已清理`);
    return;
  }
  console.log(`[service] 停止 ${name} (PID ${pid})…`);
  await killTree(pid);
  const deadline = Date.now() + 3000;
  while (isAlive(pid) && Date.now() < deadline) await sleep(200);
  if (isAlive(pid)) {
    console.log(`[service] ${name} 仍未退出，强制结束`);
    await killTree(pid);
    await sleep(500);
  }
  rmSync(pidFile, { force: true });
  console.log(`[service] ${name}: 已停止`);
}

// ---------- start ----------

async function cmdStart(env, endpoints) {
  const { mainPort, dsHost, dsPort } = endpoints;
  const token = (env.DATA_SERVICE_TOKEN ?? '').trim();
  if (!token) {
    fatal('DATA_SERVICE_TOKEN 未配置（data-service 会拒绝启动）。请在 .env 中设置后重试。');
  }

  // 端口占用预检：拒绝双开（PITFALLS 旧进程占端口事故防线）
  const busy = [];
  if (await portOpen(dsPort)) busy.push(`data-service 端口 ${dsPort}`);
  if (await portOpen(mainPort)) busy.push(`主服务端口 ${mainPort}`);
  if (busy.length > 0) {
    console.error(`[service] ${busy.join('、')} 已被占用，拒绝双开。`);
    console.error('[service] 若是旧实例：先运行 stop（或 scripts/stop-all），再手动确认端口已释放。');
    process.exit(1);
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

  const pidFiles = [
    { name: 'data-service', child: ds, file: path.join(logsDir, 'data-service.pid') },
    { name: '主服务', child: main, file: path.join(logsDir, 'main.pid') },
  ];
  for (const s of pidFiles) {
    if (s.child.pid) writeFileSync(s.file, String(s.child.pid));
  }
  // spawn 同步失败（如 python 不存在）时 'error' 事件触发，pid 可能为 undefined
  for (const s of pidFiles) {
    if (!s.child.pid) {
      console.error(`[service] ${s.name} 启动失败（可执行文件不存在？），查看上方错误`);
    }
  }

  console.log('[service] 双服务已拉起，前台监督中。保持本窗口开启；Ctrl+C 或关闭窗口即停止双服务。');
  console.log(`[service] 日志: logs/data-service.log / logs/main.log；另开窗口可用 "node scripts/service.mjs status" 查看状态。`);

  let shuttingDown = false;
  let exitCode = 0;
  const shutdown = async (reason, code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = code;
    console.log(`\n[service] ${reason}，正在停止双服务…`);
    for (const s of pidFiles) {
      if (s.child.pid && isAlive(s.child.pid)) await killTree(s.child.pid);
    }
    for (const s of pidFiles) rmSync(s.file, { force: true });
    dsLog.end();
    mainLog.end();
    process.exit(exitCode);
  };

  // 监督：任一子进程退出（含崩溃）→ 整体收尾，不留半套服务
  ds.on('exit', (code, signal) => {
    if (!shuttingDown) void shutdown(`data-service 退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`, code ?? 1);
  });
  main.on('exit', (code, signal) => {
    if (!shuttingDown) void shutdown(`主服务退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`, code ?? 1);
  });
  ds.on('error', (err) => {
    if (!shuttingDown) void shutdown(`data-service 启动错误：${err.message}`, 1);
  });
  main.on('error', (err) => {
    if (!shuttingDown) void shutdown(`主服务启动错误：${err.message}`, 1);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => void shutdown(`收到 ${sig}`, 0));
  }
  // Windows 关窗：尽力而为（CTRL_CLOSE 等事件不保证送达，stop 命令可清理残留）
  if (process.platform === 'win32') {
    process.on('SIGHUP', () => void shutdown('收到 SIGHUP', 0));
  }
}

// ---------- stop / status ----------

async function cmdStop() {
  await stopOne('data-service', path.join(logsDir, 'data-service.pid'));
  await stopOne('主服务', path.join(logsDir, 'main.pid'));
}

async function cmdStatus(endpoints) {
  const { mainPort, dsPort } = endpoints;
  const rows = [
    { name: 'data-service', pidFile: path.join(logsDir, 'data-service.pid'), port: dsPort },
    { name: '主服务', pidFile: path.join(logsDir, 'main.pid'), port: mainPort },
  ];
  let allRunning = true;
  for (const r of rows) {
    const pid = readPid(r.pidFile);
    const alive = pid ? isAlive(pid) : false;
    const listening = await portOpen(r.port);
    if (!alive || !listening) allRunning = false;
    console.log(
      `[service] ${r.name}: PID=${alive ? pid : '未运行'} 端口 ${r.port}=${listening ? '监听中' : '未监听'}` +
        (pid && !alive ? '（PID 文件陈旧，可运行 stop 清理）' : ''),
    );
  }
  process.exit(allRunning ? 0 : 1);
}

// ---------- main ----------

const { command, envFile } = parseArgs(process.argv.slice(2));
const env = loadServiceEnv(envFile);
const endpoints = resolveEndpoints(env);

if (command === 'start') {
  await cmdStart(env, endpoints);
} else if (command === 'stop') {
  await cmdStop();
} else if (command === 'status') {
  await cmdStatus(endpoints);
} else if (command === 'restart') {
  await cmdStop();
  await cmdStart(env, endpoints);
} else {
  fatal(`未知子命令：${command}（可用：start | stop | status | restart）`);
}
