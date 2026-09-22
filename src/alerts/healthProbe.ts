/**
 * 行情数据源健康探针（P4）：东财是非官方公开接口，字段编码可能静默变化。
 * 定时探测一只常青股票（默认 600519 贵州茅台），连续失败即判定行情链路故障：
 * 每次失败打日志，故障发生/恢复各记一条服务端日志，状态暴露在 /health 端点
 * （getHealthProbeStatus）。
 *
 * 推送策略（2026-09-22 调整）：故障/恢复**默认不主动推送到聊天端**——告警对客户端
 * 透明，用户实际查询失败时由技能层把错误文本回给 LLM 当场转述；推送需显式开
 * HEALTH_PROBE_ALERT_PUSH=true（运维自查场景）。避免限流抖动期"告警/恢复"反复刷屏。
 *
 * 注意：探测走的是当前配置的 getQuote 链路——默认组合数据源下探的是东财直连；
 * DATA_PROVIDER=python 时探的是微服务行情端点，同样有意义。
 */
import { config } from '../config.js';
import type { Channel } from '../channels/types.js';
import type { DataProvider } from '../data/provider.js';
import type { Store } from '../storage/store.js';

export interface ProbeStatus {
  ok: boolean;               // 当前是否健康（false = 连续失败达阈值，已告警）
  consecutiveFailures: number;
  lastCheckAt: string | null; // ISO 时间
  lastError: string | null;
}

/** 连续失败多少次判定为故障（单次网络抖动不告警） */
const FAILURE_THRESHOLD = 2;

const status: ProbeStatus = {
  ok: true,
  consecutiveFailures: 0,
  lastCheckAt: null,
  lastError: null,
};

/** 供 /health 端点读取的探针状态快照 */
export function getHealthProbeStatus(): ProbeStatus {
  return { ...status };
}

export function startHealthProbe(store: Store, data: DataProvider, channels: Channel[]): void {
  const { code, intervalMinutes, alertPush } = config.healthProbe;

  /** 尽力推送：单渠道失败只记日志，绝不影响探针状态机与其他渠道（审计 A-401/A-402） */
  const notifyAll = async (text: string): Promise<void> => {
    for (const userId of store.allUsers()) {
      for (const ch of channels) {
        try {
          await ch.notify(userId, text);
        } catch (err) {
          console.error(`[health-probe] 告警推送失败（${ch.name} -> ${userId}）:`, err);
        }
      }
    }
  };

  const tick = async (): Promise<void> => {
    // try 只包探测本身；状态更新与通知在其外，渠道异常不会被误计为探测失败
    let probeError: string | null = null;
    try {
      await data.getQuote(code);
    } catch (err) {
      probeError = err instanceof Error ? err.message : String(err);
    } finally {
      status.lastCheckAt = new Date().toISOString();
      // 重新调度挂在 finally：探测/通知任何环节抛错都不断链；catch 兜底防未处理拒绝
      setTimeout(() => {
        tick().catch((err) => console.error('[health-probe] tick 未捕获异常:', err));
      }, intervalMinutes * 60_000);
    }

    if (!probeError) {
      if (!status.ok) {
        console.log(`[health-probe] 行情链路已恢复（${code} 探测成功）`);
        if (alertPush) await notifyAll('✅【数据源恢复】行情接口已恢复正常。');
      }
      status.ok = true;
      status.consecutiveFailures = 0;
      status.lastError = null;
      return;
    }

    status.consecutiveFailures++;
    status.lastError = probeError;
    console.warn(
      `[health-probe] ${code} 探测失败（连续第 ${status.consecutiveFailures} 次）:`,
      probeError,
    );
    if (status.ok && status.consecutiveFailures >= FAILURE_THRESHOLD) {
      status.ok = false;
      console.error('[health-probe] 行情链路疑似失效，按 PITFALLS.md 东财条目排查');
      if (alertPush) {
        const text =
          '⚠️【数据源告警】行情接口连续多次探测失败，行情/指数查询可能不可用。\n' +
          `最近错误：${probeError}\n` +
          '如持续失败请查看服务日志，并按 docs/PITFALLS.md 东财条目排查（接口字段可能已变化）。';
        await notifyAll(text);
      }
    }
  };

  console.log(`[health-probe] 行情探针已启动：每 ${intervalMinutes} 分钟探测 ${code}`);
  tick().catch((err) => console.error('[health-probe] tick 未捕获异常:', err));
}
