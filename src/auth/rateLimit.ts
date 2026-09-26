/**
 * 登录接口速率限制：基于内存 Map 的 IP 失败计数。
 * 阈值与窗口通过环境变量配置（S4-1 非功能需求）。
 */
import { config } from '../config.js';

interface Attempt {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, Attempt>();

function nowMs(): number {
  return Date.now();
}

function getKey(ip: string): Attempt {
  const existing = attempts.get(ip);
  if (existing && existing.resetAt > nowMs()) return existing;
  const fresh: Attempt = { count: 0, resetAt: nowMs() + config.auth.loginRateLimitWindowMs };
  attempts.set(ip, fresh);
  return fresh;
}

export function recordFailure(ip: string): void {
  const a = getKey(ip);
  a.count += 1;
}

export function recordSuccess(ip: string): void {
  attempts.delete(ip);
}

export function isRateLimited(ip: string): boolean {
  const a = getKey(ip);
  return a.count >= config.auth.loginRateLimitMax;
}

export function getAttemptCount(ip: string): number {
  return getKey(ip).count;
}
