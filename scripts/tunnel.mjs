#!/usr/bin/env node
/**
 * CNStockBot Quick Tunnel 守护进程（S3-8）：
 * 给 cloudflared 临时隧道加崩溃自动拉起 + 假活检测（REQ-S3-8）。
 *
 * 用法：
 *   node scripts/tunnel.mjs start  [--port N]  守护模式：崩溃/假活自动拉起（指数退避）
 *   node scripts/tunnel.mjs stop   [--port N]  哨兵 + 杀守护进程（子进程随树清理）
 *   node scripts/tunnel.mjs status [--port N]  守护进程/URL/register 计数/目标健康
 *   node scripts/tunnel.mjs url    [--port N]  只打印当前隧道地址
 *
 * 约定：
 * - --port 缺省读 .env 的 PORT，再退 18790；
 * - 每代子进程：cloudflared tunnel --url http://127.0.0.1:<port>
 *   --protocol http2 --metrics 127.0.0.1:<metricsPort>
 *   （--protocol http2 为 PITFALLS 2026-10-10 强制项：默认 QUIC(UDP 7844)
 *     在国内网络常被封，表现为 Error 1033 / HTTP 530）；
 * - 假活检测（PITFALLS 2026-10-11"假活隧道"）：每 15s 读 metrics，宽限期 90s 后
 *   若 tunnel_register_success 合计为 0 且 tunnel_register_fail 合计 > 0，
 *   判定假活并强制重启（进程活着但隧道从未注册成功，tasklist 看不出）；
 * - 控制文件按目标端口命名空间化（S3-7 同款）：
 *   logs/tunnel-<port>.pid / -child-<port>.pid / -<port>.stop / -<port>.log /
 *   -<port>.meta.json / tunnel-url-<port>.txt；
 * - 退避参数与 service.mjs supervise 完全一致：3s 起封顶 60s，连续失败 20 次
 *   放弃，本代 ≥60s 视为稳定清零；
 * - Quick Tunnel 语义不变：每次重启必换新 *.trycloudflare.com 地址，
 *   URL 以 logs/tunnel-url-<port>.txt 为准，绝不能写死进 App/前端。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const logsDir = path.join(repoRoot, 'logs');

// 与 service.mjs supervise 同规格
const STABLE_UPTIME_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 20;
const BACKOFF_BASE_MS = 3_000;
const BACKOFF_CAP_MS = 60_000;
const SENTINEL_POLL_MS = 500;
// S3-8 假活检测
const METRICS_POLL_MS = 15_000; // register 计数轮询间隔
const FAKE_ALIVE_GRACE_MS = 90_000; // 每代启动后的宽限期（注册本身可能慢）
const METRICS_PORT_BASE = 20242; // metrics 端口探测起点
const METRICS_PORT_TRIES = 10;

function controlFiles(port) {
  return {
    pid: path.join(logsDir, `tunnel-${port}.pid`), // 守护进程自身
    childPid: path.join(logsDir, `tunnel-child-${port}.pid`), // 当前代 cloudflared
    stop: path.join(logsDir, `tunnel-${port}.stop`), // 哨兵
    log: path.join(logsDir, `tunnel-${port}.log`),
    meta: path.join(logsDir, `tunnel-${port}.meta.json`),
    url: path.join(logsDir, `tunnel-url-${port}.txt`),
  };
}

// ---------- 参数与 env ----------

function parseArgs(argv) {
  let command = null;
  let port = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0) fatal('--port 需要一个正整数');
    } else if (!command) {
      command = a;
    } else {
      fatal(`无法识别的参数：${a}`);
    }
  }
  if (!command) fatal('缺少子命令：start | stop | status | url');
  return { command, port };
}

function fatal(msg) {
  console.error(`[tunnel] ${msg}`);
  process.exit(1);
}

function resolvePort(cliPort) {
  if (cliPort) return cliPort;
  const envPath = path.join(repoRoot, '.env');
  if (existsSync(envPath)) {
    const parsed = loadEnv({ path: envPath }).parsed ?? {};
    const fromEnv = Number(parsed.PORT);
    if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  }
  return 18790;
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

/** 杀进程树：Windows 必须 taskkill /T（PITFALLS：Git Bash 手敲用 //，脚本内 spawn 无此问题） */
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

/** 常见安装位置兜底：winget 装到机器 PATH 后，已开机的会话进程拿不到新 PATH
 * （stale 环境变量），只看 PATH 会误判"未安装"。返回可执行路径或 null。 */
function whichCloudflared() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, ['cloudflared'], { encoding: 'utf8' });
  if (r.status === 0) {
    const first = (r.stdout || '').split('\n')[0].trim();
    if (first) return first;
  }
  if (process.platform === 'win32') {
    for (const dir of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
      if (!dir) continue;
      const candidate = path.join(dir, 'cloudflared', 'cloudflared.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 解析 Prometheus 文本格式的 register 计数（PITFALLS 假活判据）。
 * 返回 { success, fail }（各 label 变体求和）；无相关行返回 null。
 */
export function parseRegisterCounters(metricsText) {
  let success = 0;
  let fail = 0;
  let found = false;
  for (const raw of String(metricsText).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(cloudflared_tunnel_tunnel_register_\w+)(?:\{[^}]*\})?\s+(\d+(?:\.\d+)?)$/.exec(line);
    if (!m) continue;
    if (m[1].includes('_success')) {
      success += Number(m[2]);
      found = true;
    } else if (m[1].includes('_fail')) {
      fail += Number(m[2]);
      found = true;
    }
  }
  return found ? { success, fail } : null;
}

async function fetchRegisterCounters(metricsPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${metricsPort}/metrics`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return parseRegisterCounters(await res.text());
  } catch {
    return null; // metrics 未起/网络问题：不算假活（FR-3）
  }
}

/** 从 20242 起找第一个空闲端口作 metrics 端口 */
async function pickMetricsPort() {
  for (let i = 0; i < METRICS_PORT_TRIES; i++) {
    const p = METRICS_PORT_BASE + i;
    if (!(await portOpen(p))) return p;
  }
  return null;
}

// ---------- start：守护循环 ----------

/**
 * 拉起一代 cloudflared 并监督。resolve 值：
 * - { reason: 'crash', code, startedAt }    子进程退出（含假活被杀）
 * - { reason: 'signal', detail, startedAt } 收到 stop/shutdown
 */
function runOneGeneration(binPath, port, files, metricsPort, log) {
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
    shutdown(detail) {
      if (shuttingDown || finished) return;
      shuttingDown = true;
      shutdownDetail = detail;
      if (gen._child?.pid && isAlive(gen._child.pid)) void killTree(gen._child.pid);
    },
  };

  void (async () => {
    const args = [
      'tunnel',
      '--url',
      `http://127.0.0.1:${port}`,
      '--protocol',
      'http2',
      '--metrics',
      `127.0.0.1:${metricsPort}`,
    ];
    log(`启动 cloudflared: ${binPath} ${args.join(' ')}`);
    const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    gen._child = child;
    if (child.pid) writeFileSync(files.childPid, String(child.pid));
    writeFileSync(files.meta, JSON.stringify({ metricsPort, startedAt }));

    // 输出镜像 + trycloudflare URL 捕获（stdout/stderr 都解析，URL 行实际走 stderr）
    const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
    let urlCaptured = false;
    const handleChunk = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(chunk);
      logStream.write(chunk);
      if (!urlCaptured) {
        const m = urlRe.exec(text);
        if (m) {
          urlCaptured = true;
          writeFileSync(files.url, m[0] + '\n');
          log(`隧道地址: ${m[0]}（已写入 ${path.basename(files.url)}；Quick Tunnel 重启必换地址）`);
        }
      }
    };
    const logStream = createWriteStream(files.log, { flags: 'a' });
    child.stdout?.on('data', handleChunk);
    child.stderr?.on('data', handleChunk);

    // ---- 假活检测：宽限期后 success==0 && fail>0 即重启 ----
    let pollTimer = null;
    const pollMetrics = async () => {
      if (finished || shuttingDown) return;
      const uptimeMs = Date.now() - startedAt;
      if (uptimeMs < FAKE_ALIVE_GRACE_MS) {
        pollTimer = setTimeout(() => void pollMetrics(), METRICS_POLL_MS);
        return;
      }
      const counters = await fetchRegisterCounters(metricsPort);
      if (counters === null) {
        log(`metrics 暂不可读（127.0.0.1:${metricsPort}），跳过本轮判定`, true);
      } else if (counters.success === 0 && counters.fail > 0) {
        log(`假活判定：register_success=0 register_fail=${counters.fail}（进程活着但隧道从未注册成功），重启隧道`);
        void killTree(child.pid);
        return; // 退出路径交给 'exit' 事件（reason=crash）
      }
      pollTimer = setTimeout(() => void pollMetrics(), METRICS_POLL_MS);
    };
    pollTimer = setTimeout(() => void pollMetrics(), METRICS_POLL_MS);

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(pollTimer);
      rmSync(files.childPid, { force: true });
      logStream.end();
      finishResolve({ ...result, startedAt });
    };

    child.on('exit', (code, signal) => {
      if (finished) return;
      if (shuttingDown) {
        finish({ reason: 'signal', detail: shutdownDetail });
        return;
      }
      log(`cloudflared 退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`);
      finish({ reason: 'crash', code: code ?? 1 });
    });
    child.on('error', (err) => {
      if (!finished) log(`cloudflared 启动错误：${err.message}`);
      finish({ reason: 'crash', code: 1 });
    });

    // spawn 异步期间已收到停止信号：立即补杀
    if (shuttingDown && child.pid && isAlive(child.pid)) void killTree(child.pid);
  })();

  return gen;
}

async function cmdStart(port, files) {
  // 前置检查 1：cloudflared 可执行
  const binPath = whichCloudflared();
  if (!binPath) {
    fatal('未找到 cloudflared。安装：winget install cloudflare.cloudflared（见 docs/deploy/local-tunnel.md）');
  }
  // 前置检查 2：主服务健康
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    fatal(`主服务未响应 http://127.0.0.1:${port}/health（${e.message}）。先用 scripts\\start-all.bat 拉起双服务。`);
  }
  // 幂等：清陈旧哨兵；杀掉旧守护（若活着）与其孤儿 cloudflared
  rmSync(files.stop, { force: true });
  const staleSup = readPid(files.pid);
  if (staleSup && isAlive(staleSup)) {
    console.log(`[tunnel] 发现已在运行的守护进程（PID ${staleSup}），先停止再启动`);
    writeFileSync(files.stop, String(Date.now()));
    await killTree(staleSup);
    await sleep(1000);
  }
  rmSync(files.pid, { force: true });
  const staleChild = readPid(files.childPid);
  if (staleChild && isAlive(staleChild)) {
    console.log(`[tunnel] 清理无守护的孤儿 cloudflared（PID ${staleChild}）`);
    await killTree(staleChild);
    await sleep(500);
  }
  rmSync(files.childPid, { force: true });

  mkdirSync(logsDir, { recursive: true });
  writeFileSync(files.pid, String(process.pid));

  const logStream = createWriteStream(files.log, { flags: 'a' });
  const log = (msg, debug = false) => {
    const line = `[tunnel ${new Date().toISOString()}] ${msg}`;
    if (!debug) console.log(line);
    logStream.write(line + '\n');
  };

  log(`守护模式启动（PID ${process.pid}，目标端口 ${port}）。崩溃/假活自动拉起（退避 3s 起封顶 60s，连续失败 ${MAX_CONSECUTIVE_FAILURES} 次放弃）；stop 命令终止守护。`);

  let stopRequested = false;
  const requestStop = (detail) => {
    stopRequested = true;
    if (gen) gen.shutdown(detail);
  };
  const sigHandler = (sig) => requestStop(`收到 ${sig}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, sigHandler);
  if (process.platform === 'win32') process.on('SIGHUP', sigHandler);

  const sleepInterruptible = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (stopRequested || existsSync(files.stop)) return false;
      await sleep(Math.min(SENTINEL_POLL_MS, deadline - Date.now()));
    }
    return !stopRequested && !existsSync(files.stop);
  };

  let gen = null;
  let consecutiveFailures = 0;
  let exitCode = 0;
  while (true) {
    if (stopRequested || existsSync(files.stop)) {
      log('收到停止请求，退出守护。');
      break;
    }
    const metricsPort = await pickMetricsPort();
    if (metricsPort === null) {
      consecutiveFailures++;
      log(`找不到空闲 metrics 端口（${METRICS_PORT_BASE}~${METRICS_PORT_BASE + METRICS_PORT_TRIES - 1} 全被占用），第 ${consecutiveFailures} 次连续失败，稍后重试。`);
    } else {
      gen = runOneGeneration(binPath, port, files, metricsPort, log);
      const result = await gen.stopped;
      gen = null;
      if (result.reason === 'signal') {
        log(`${result.detail}，退出守护。`);
        break;
      }
      const uptimeSec = (Date.now() - result.startedAt) / 1000;
      if (uptimeSec * 1000 >= STABLE_UPTIME_MS) {
        consecutiveFailures = 0;
        log(`本代运行 ${uptimeSec.toFixed(1)}s（≥60s 视为稳定，连续失败计数清零）。`);
      } else {
        consecutiveFailures++;
        log(`本代运行 ${uptimeSec.toFixed(1)}s，第 ${consecutiveFailures} 次连续失败。`);
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log(`连续失败达上限 ${MAX_CONSECUTIVE_FAILURES} 次，放弃自动拉起，需人工介入（查 ${path.basename(files.log)}）。`);
        exitCode = 1;
        break;
      }
    }
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1));
    log(`${Math.round(delay / 1000)}s 后重启隧道…（stop 可终止等待）`);
    if (!(await sleepInterruptible(delay))) {
      log('等待期间收到停止请求，退出守护。');
      break;
    }
  }

  if (gen) gen.shutdown('守护退出');
  rmSync(files.pid, { force: true });
  rmSync(files.childPid, { force: true });
  rmSync(files.stop, { force: true });
  rmSync(files.meta, { force: true });
  // 等日志流冲刷完再自然退出（Windows 下 process.exit 与未清句柄竞争会触发
  // libuv 断言崩溃，见 cmdStatus 同款注释）
  logStream.end(() => {
    process.exitCode = exitCode;
  });
}

// ---------- stop / status / url ----------

async function cmdStop(port, files) {
  const supPid = readPid(files.pid);
  if (!supPid) {
    rmSync(files.pid, { force: true });
    console.log('[tunnel] 守护进程: 未运行（无 PID 文件）');
  } else if (!isAlive(supPid)) {
    rmSync(files.pid, { force: true });
    console.log(`[tunnel] 守护进程: PID ${supPid} 已不存在（陈旧 PID 文件），已清理`);
  } else {
    writeFileSync(files.stop, String(Date.now()));
    console.log(`[tunnel] 停止守护进程 (PID ${supPid})…`);
    await killTree(supPid);
    const deadline = Date.now() + 3000;
    while (isAlive(supPid) && Date.now() < deadline) await sleep(200);
    if (isAlive(supPid)) console.log('[tunnel] 守护进程仍在，继续清理 cloudflared');
    rmSync(files.pid, { force: true });
  }
  // 兜底：清残留 cloudflared（child PID 文件）
  const childPid = readPid(files.childPid);
  if (childPid && isAlive(childPid)) {
    console.log(`[tunnel] 清理残留 cloudflared (PID ${childPid})…`);
    await killTree(childPid);
  }
  rmSync(files.childPid, { force: true });
  rmSync(files.stop, { force: true });
  rmSync(files.meta, { force: true });
  rmSync(files.url, { force: true }); // 地址已失效，避免 status 误导
  console.log('[tunnel] 已停止。注意：Quick Tunnel 地址已失效，重开必换新地址。');
}

async function cmdStatus(port, files) {
  let running = true;
  const supPid = readPid(files.pid);
  const supAlive = supPid ? isAlive(supPid) : false;
  if (supAlive) {
    console.log(`[tunnel] 守护进程: PID=${supPid} 运行中（supervise 模式）`);
  } else {
    running = false;
    if (supPid) {
      rmSync(files.pid, { force: true });
      console.log('[tunnel] 守护进程: 未运行（陈旧 PID 文件已清理）');
    } else {
      console.log('[tunnel] 守护进程: 未运行');
    }
  }

  const url = existsSync(files.url) ? readFileSync(files.url, 'utf8').trim() : '';
  console.log(`[tunnel] 隧道地址: ${url || '尚未获取（或已被清理）'}`);

  const counters = existsSync(files.meta) ? await fetchRegisterCounters(JSON.parse(readFileSync(files.meta, 'utf8')).metricsPort) : null;
  console.log(
    `[tunnel] register 计数: ${counters ? `success=${counters.success} fail=${counters.fail}` : '不可读（未运行或 metrics 未起）'}` +
      (counters && counters.success > 0 ? '（隧道已注册成功）' : '') +
      (counters && counters.success === 0 && counters.fail > 0 ? '（⚠ 假活特征：进程在但从未注册成功）' : ''),
  );

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
    console.log(`[tunnel] 主服务 127.0.0.1:${port}/health: HTTP ${res.status}`);
  } catch (e) {
    console.log(`[tunnel] 主服务 127.0.0.1:${port}/health: 不可达（${e.message}）`);
  }
  // 用 exitCode 自然退出：Windows 下 process.exit() 与未清完的异步句柄
  // （fetch/AbortSignal 定时器）竞争会触发 libuv 断言崩溃（async.c:76）
  process.exitCode = running ? 0 : 1;
}

function cmdUrl(files) {
  if (!existsSync(files.url)) {
    console.log('[tunnel] 尚未获取到隧道地址（守护进程运行后见 logs 下 url 文件）');
    process.exit(1);
  }
  console.log(readFileSync(files.url, 'utf8').trim());
  process.exit(0);
}

// ---------- main ----------

const { command, port: cliPort } = parseArgs(process.argv.slice(2));
const port = resolvePort(cliPort);
const files = controlFiles(port);

if (command === 'start') {
  await cmdStart(port, files);
} else if (command === 'stop') {
  await cmdStop(port, files);
} else if (command === 'status') {
  await cmdStatus(port, files);
} else if (command === 'url') {
  cmdUrl(files);
} else {
  fatal(`未知子命令：${command}（可用：start | stop | status | url）`);
}
