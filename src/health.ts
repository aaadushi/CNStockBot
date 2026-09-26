/**
 * /health 可观测性（S3-4）：构建信息（版本/git sha/启动时间）+ data-service 连通性探测。
 *
 * 探测设计：
 * - 带 DATA_SERVICE_TOKEN 调微服务 /health（S4-2 起该端点也要求鉴权）；
 * - 3s 超时，结果进程内缓存 30s——/health 常被监控轮询，不缓存会打爆微服务；
 * - 任何异常只标记 ok:false，绝不抛出（/health 自身必须始终可用）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

/** 探测结果缓存时长：/health 轮询场景下足够新鲜，又不会对微服务造成压力 */
const PROBE_CACHE_MS = 30_000;
/** 单次探测超时：微服务本地回环，3s 足够；超时即视为不通 */
const PROBE_TIMEOUT_MS = 3_000;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function readGitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim() || null;
  } catch {
    // 部署环境无 git / 无 .git 目录是正常情况，不视为错误
    return null;
  }
}

/** 进程启动时间（模块加载即服务启动），ISO 字符串 */
export const startedAt = new Date().toISOString();
export const version = readVersion();
export const gitSha = readGitSha();

export interface DataServiceOk {
  ok: true;
  latencyMs: number;
  checkedAt: string;
}

export interface DataServiceDown {
  ok: false;
  error: string;
  checkedAt: string;
}

export type DataServiceStatus = DataServiceOk | DataServiceDown;

interface ProbeOptions {
  /** 测试注入用；默认全局 fetch */
  fetchFn?: typeof fetch;
  /** 测试注入用；默认 Date.now */
  now?: () => number;
  baseUrl?: string;
  token?: string;
}

/**
 * data-service 连通性探测器工厂（可注入 fetch/now 便于单测）。
 * 并发调用共享同一次在途探测，TTL 内直接返回缓存。
 */
export function createDataServiceProber(options: ProbeOptions = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const baseUrl = options.baseUrl ?? config.pythonServiceUrl;
  const token = options.token ?? config.dataServiceToken;

  let cached: { at: number; status: DataServiceStatus } | null = null;
  let inflight: Promise<DataServiceStatus> | null = null;

  async function probeOnce(): Promise<DataServiceStatus> {
    const started = now();
    try {
      const res = await fetchFn(`${baseUrl}/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { ok: false, error: `data-service /health 返回 ${res.status}`, checkedAt: new Date(now()).toISOString() };
      }
      return { ok: true, latencyMs: now() - started, checkedAt: new Date(now()).toISOString() };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(now()).toISOString(),
      };
    }
  }

  return async function getDataServiceStatus(): Promise<DataServiceStatus> {
    if (cached && now() - cached.at < PROBE_CACHE_MS) return cached.status;
    if (!inflight) {
      inflight = probeOnce()
        .then((status) => {
          cached = { at: now(), status };
          return status;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}

/** 默认探测器（index.ts /health 用；单测请用工厂注入） */
export const getDataServiceStatus = createDataServiceProber();
