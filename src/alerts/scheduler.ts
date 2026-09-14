/**
 * 定时任务：A 股收盘后（15:30）向所有用户推送自选股日报。
 * 用 setTimeout 实现的极简调度器，避免引入 cron 依赖；
 * 任务变多后建议换成 node-cron 或 BullMQ。
 */
import type { Channel } from '../channels/types.js';
import type { DataProvider } from '../data/provider.js';
import type { Store } from '../storage/store.js';

/** 计算到下一个"工作日 HH:MM（北京时间）"的毫秒数 */
function msUntilNextRun(hour: number, minute: number): number {
  const now = new Date();
  // 转北京时间
  const bj = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000);
  const target = new Date(bj);
  target.setHours(hour, minute, 0, 0);
  if (target <= bj) target.setDate(target.getDate() + 1);
  // 跳过周末（6=周六, 0=周日）
  while (target.getDay() === 0 || target.getDay() === 6) target.setDate(target.getDate() + 1);
  return target.getTime() - bj.getTime();
}

async function buildDailyReport(store: Store, data: DataProvider, userId: string): Promise<string> {
  const codes = store.getWatchlist(userId);
  const lines = await Promise.all(
    codes.map(async (c) => {
      try {
        const q = await data.getQuote(c);
        const arrow = q.changePct > 0 ? '📈' : q.changePct < 0 ? '📉' : '➖';
        return `${arrow} ${q.name}（${q.code}） ${q.price.toFixed(2)} 元  ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%`;
      } catch {
        return `⚠️ ${c} 行情获取失败`;
      }
    }),
  );
  return `【收盘日报】你的自选股今日表现：\n${lines.join('\n')}\n\n以上仅供参考，不构成投资建议。`;
}

export function startScheduler(store: Store, data: DataProvider, channels: Channel[]): void {
  const scheduleDaily = () => {
    const delay = msUntilNextRun(15, 30);
    console.log(`[scheduler] 下次收盘日报推送在 ${(delay / 3_600_000).toFixed(1)} 小时后`);
    setTimeout(async () => {
      try {
        for (const userId of store.allUsers()) {
          const report = await buildDailyReport(store, data, userId);
          for (const ch of channels) await ch.notify(userId, report);
        }
      } catch (err) {
        console.error('[scheduler] 日报推送失败:', err);
      } finally {
        scheduleDaily();
      }
    }, delay);
  };
  scheduleDaily();
}
