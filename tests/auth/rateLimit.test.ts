import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as rateLimit from '../../src/auth/rateLimit.js';

describe('auth/rateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('失败次数达到上限后锁定', () => {
    const ip = '1.2.3.4';
    for (let i = 0; i < 4; i++) {
      rateLimit.recordFailure(ip);
      expect(rateLimit.isRateLimited(ip)).toBe(false);
    }
    rateLimit.recordFailure(ip);
    expect(rateLimit.isRateLimited(ip)).toBe(true);
  });

  it('窗口过期后重置计数', () => {
    const ip = '1.2.3.5';
    for (let i = 0; i < 5; i++) rateLimit.recordFailure(ip);
    expect(rateLimit.isRateLimited(ip)).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(rateLimit.isRateLimited(ip)).toBe(false);
  });

  it('成功登录清零计数', () => {
    const ip = '1.2.3.6';
    rateLimit.recordFailure(ip);
    rateLimit.recordSuccess(ip);
    expect(rateLimit.isRateLimited(ip)).toBe(false);
  });
});
