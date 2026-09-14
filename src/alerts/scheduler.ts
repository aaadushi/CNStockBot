/**
 * 定时任务：
 * 1. 收盘日报：A 股收盘后（15:30 北京时间）向所有用户推送自选股日报。
 * 2. 异动提醒：盘中（9:30-11:30 / 13:00-15:00）每 N 分钟轮询全部自选股，
 *    涨跌幅绝对值超阈值即推送，每股每日只报一次防刷屏。
 * 用 setTimeout 实现的极简调度器，避免引入 cron 依赖；
 * 任务变多后建议换成 node-cron 或 BullMQ。
 */
import { config } from '../config.js';
import type { Channel } from '../channels/types.js';
import type { DataProvider, Quote } from '../data/provider.js';
import type { Store } from '../storage/store.js';

/** 当前北京时间（服务器在任何时区都对） */
function beijingNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000);
}

/** 计算到下一个"工作日 HH:MM（北京时间）"的毫秒数 */
function msUntilNextRun(hour: number, minute: number): number {
  const bj = beijingNow();
  const target = new Date(bj);
  target.setHours(hour, minute, 0, 0);
  if (target <= bj) target.setDate(target.getDate() + 1);
  // 跳过周末（6=周六, 0=周日）
  while (target.getDay() === 0 || target.getDay() === 6) target.setDate(target.getDate() + 1);
  return target.getTime() - bj.getTime();
}

/** 是否处于 A 股盘中交易时段（北京时间，仅判断工作日 + 连续竞价时段，不跳法定节假日——见 STATUS P2） */
function isTradingTime(bj: Date): boolean {
  const day = bj.getDay();
  if (day === 0 || day === 6) return false;
  const mins = bj.getHours() * 60 + bj.getMinutes();
  return (mins >= 9 * 60 + 30 && mins <= 11 * 60 + 30) || (mins >= 13 * 60 && mins <= 15 * 60);
}

function dateKey(bj: Date): string {
  return `${bj.getFullYear()}-${bj.getMonth() + 1}-${bj.getDate()}`;
}

function formatQuoteLine(q: Quote): string {
  const arrow = q.changePct > 0 ? '📈' : q.changePct < 0 ? '📉' : '➖';
  return `${arrow} ${q.name}（${q.code}） ${q.price.toFixed(2)} 元  ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%`;
}

async function buildDailyReport(store: Store, data: DataProvider, userId: string): Promise<string> {
  const codes = store.getWatchlist(userId);
  const lines = await Promise.all(
    codes.map(async (c) => {
      try {
        return formatQuoteLine(await data.getQuote(c));
      } catch {
        return `⚠️ ${c} 行情获取失败`;
      }
    }),
  );
  return `【收盘日报】你的自选股今日表现：\n${lines.join('\n')}\n\n以上仅供参考，不构成投资建议。`;
}

/** 盘中异动提醒轮询 */
function startPriceAlerts(store: Store, data: DataProvider, channels: Channel[]): void {
  const threshold = config.alerts.thresholdPct;
  const alerted = new Set<string>(); // `${date}:${code}`，每股每日只报一次

  const tick = async (): Promise<void> => {
    const bj = beijingNow();
    try {
      if (isTradingTime(bj)) {
        const today = dateKey(bj);
        // 跨天后清掉前一天的记录
        for (const k of alerted) if (!k.startsWith(today)) alerted.delete(k);

        // 先汇总全部用户的自选股去重拉行情，避免多用户重复请求东财
        const users = store.allUsers();
        const allCodes = [...new Set(users.flatMap((u) => store.getWatchlist(u)))];
        const quotes = new Map<string, Quote>();
        await Promise.all(
          allCodes.map(async (c) => {
            try {
              quotes.set(c, await data.getQuote(c));
            } catch {
              /* 单只失败忽略（停牌/退市等），本轮跳过 */
            }
          }),
        );

        for (const userId of users) {
          const hits = store
            .getWatchlist(userId)
            .map((c) => quotes.get(c))
            .filter((q): q is Quote => !!q && Math.abs(q.changePct) >= threshold)
            .filter((q) => !alerted.has(`${today}:${q.code}`));
          if (hits.length === 0) continue;
          for (const q of hits) alerted.add(`${today}:${q.code}`);
          const text =
            `【异动提醒】以下自选股涨跌幅超过 ±${threshold}%：\n` +
            hits.map(formatQuoteLine).join('\n') +
            '\n\n以上仅供参考，不构成投资建议。';
          for (const ch of channels) await ch.notify(userId, text);
        }
      }
    } catch (err) {
      console.error('[scheduler] 异动提醒轮询失败:', err);
    } finally {
      setTimeout(() => void tick(), config.alerts.intervalMinutes * 60_000);
    }
  };
  console.log(
    `[scheduler] 异动提醒已启动：盘中每 ${config.alerts.intervalMinutes} 分钟轮询，阈值 ±${threshold}%`,
  );
  void tick();
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
  if (config.alerts.enabled) startPriceAlerts(store, data, channels);
}
