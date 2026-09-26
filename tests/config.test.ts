/**
 * 配置单测：数值解析、HOST 默认值、环境变量覆盖（S4-4）。
 * config.ts 在模块加载时读 env，通过 vi.stubEnv 控制环境后动态 import 重新加载。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function loadConfig(): Promise<{ config: Record<string, unknown> }> {
  const mod = await import('../src/config.js');
  return mod as { config: Record<string, unknown> };
}

describe('config 数值解析', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('PORT', '');
    vi.stubEnv('ALERT_INTERVAL_MINUTES', '');
    vi.stubEnv('ALERT_THRESHOLD_PCT', '');
    vi.stubEnv('LLM_TIMEOUT_MS', '');
    vi.stubEnv('HOST', '');
    vi.stubEnv('DATA_SERVICE_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('PORT 默认 18790', async () => {
    vi.stubEnv('PORT', '');
    const { config } = await loadConfig();
    expect(config.port).toBe(18790);
  });

  it('非法 PORT 回退默认值', async () => {
    vi.stubEnv('PORT', 'abc');
    const { config } = await loadConfig();
    expect(config.port).toBe(18790);
  });

  it('HOST 默认 0.0.0.0（S4-4）', async () => {
    vi.stubEnv('HOST', '');
    const { config } = await loadConfig();
    expect(config.host).toBe('0.0.0.0');
  });

  it('HOST 可被环境变量覆盖为 127.0.0.1（S4-4）', async () => {
    vi.stubEnv('HOST', '127.0.0.1');
    const { config } = await loadConfig();
    expect(config.host).toBe('127.0.0.1');
  });

  it('ALERT_INTERVAL_MINUTES 非法值回退 5', async () => {
    vi.stubEnv('ALERT_INTERVAL_MINUTES', 'NaN');
    const { config } = await loadConfig();
    expect((config.alerts as { intervalMinutes: number }).intervalMinutes).toBe(5);
  });

  it('DATA_SERVICE_TOKEN 默认空字符串', async () => {
    vi.stubEnv('DATA_SERVICE_TOKEN', '');
    const { config } = await loadConfig();
    expect(config.dataServiceToken).toBe('');
  });

  it('DATA_SERVICE_TOKEN 读取环境变量并去除首尾空格（S4-2）', async () => {
    vi.stubEnv('DATA_SERVICE_TOKEN', '  secret-token  ');
    const { config } = await loadConfig();
    expect(config.dataServiceToken).toBe('secret-token');
  });
});
