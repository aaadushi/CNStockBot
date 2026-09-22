/**
 * 行情健康探针单测（2026-09-22 新增，随"告警推送默认关闭"行为调整）。
 * 覆盖：默认对客户端透明（不推送）、HEALTH_PROBE_ALERT_PUSH=true 恢复推送、
 * 单次抖动不误判故障。定时器一律 fake，探测间隔取默认 30 分钟。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Channel } from '../src/channels/types.js';
import type { DataProvider } from '../src/data/provider.js';
import type { Store } from '../src/storage/store.js';

const INTERVAL_MS = 30 * 60_000;

function makeDeps(getQuote: () => Promise<unknown>) {
  const store = { allUsers: () => ['u1'] } as unknown as Store;
  const channel: Channel = {
    name: 'webchat',
    mount: vi.fn(),
    notify: vi.fn<Channel['notify']>().mockResolvedValue(undefined),
  };
  const data = { getQuote: vi.fn(getQuote) } as unknown as DataProvider;
  return { store, channel, data };
}

async function importProbe() {
  vi.resetModules();
  return await import('../src/alerts/healthProbe.js');
}

describe('行情健康探针告警推送策略', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.HEALTH_PROBE_ALERT_PUSH;
    vi.resetModules();
  });

  it('默认（alertPush 关）：连续失败达阈值也不推送，状态照常记录；恢复同样静默', async () => {
    vi.useFakeTimers();
    const deps = makeDeps(() => Promise.reject(new Error('fetch failed')));
    const probe = await importProbe();

    probe.startHealthProbe(deps.store, deps.data, [deps.channel]);
    await vi.advanceTimersByTimeAsync(0); // 首次 tick：第 1 次失败
    expect(probe.getHealthProbeStatus().ok).toBe(true); // 未达阈值

    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // 第 2 次失败 → 判定故障
    const down = probe.getHealthProbeStatus();
    expect(down.ok).toBe(false);
    expect(down.consecutiveFailures).toBe(2);
    expect(down.lastError).toBe('fetch failed');
    expect(deps.channel.notify).not.toHaveBeenCalled(); // 关键断言：客户端无感

    // 恢复：getQuote 转为成功，同样不推送
    (deps.data.getQuote as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve({}));
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(probe.getHealthProbeStatus().ok).toBe(true);
    expect(deps.channel.notify).not.toHaveBeenCalled();
  });

  it('HEALTH_PROBE_ALERT_PUSH=true：故障推一次告警、恢复推一次通知，故障期不重复推', async () => {
    process.env.HEALTH_PROBE_ALERT_PUSH = 'true';
    vi.useFakeTimers();
    const deps = makeDeps(() => Promise.reject(new Error('fetch failed')));
    const probe = await importProbe();

    probe.startHealthProbe(deps.store, deps.data, [deps.channel]);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.channel.notify).not.toHaveBeenCalled(); // 第 1 次失败不推

    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // 第 2 次失败 → 告警
    expect(deps.channel.notify).toHaveBeenCalledTimes(1);
    expect(deps.channel.notify).toHaveBeenCalledWith(
      'u1',
      expect.stringContaining('数据源告警'),
    );

    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // 故障期持续失败不重复推
    expect(deps.channel.notify).toHaveBeenCalledTimes(1);

    (deps.data.getQuote as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve({}));
    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // 恢复 → 推恢复通知
    expect(deps.channel.notify).toHaveBeenCalledTimes(2);
    expect(deps.channel.notify).toHaveBeenLastCalledWith(
      'u1',
      expect.stringContaining('数据源恢复'),
    );
  });

  it('单次抖动不误判故障（alertPush 开也不推）', async () => {
    process.env.HEALTH_PROBE_ALERT_PUSH = 'true';
    vi.useFakeTimers();
    let fail = true;
    const deps = makeDeps(() =>
      fail ? Promise.reject(new Error('抖动')) : Promise.resolve({}),
    );
    const probe = await importProbe();

    probe.startHealthProbe(deps.store, deps.data, [deps.channel]);
    await vi.advanceTimersByTimeAsync(0); // 失败 1 次
    fail = false;
    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // 随后成功 → 计数清零
    const st = probe.getHealthProbeStatus();
    expect(st.ok).toBe(true);
    expect(st.consecutiveFailures).toBe(0);
    expect(deps.channel.notify).not.toHaveBeenCalled();
  });
});
