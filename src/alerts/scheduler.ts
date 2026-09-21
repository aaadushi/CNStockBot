/**
 * 定时任务：
 * 1. 收盘日报：A 股收盘后（15:30 北京时间）向所有用户推送自选股日报；
 *    2026-09-19 起附加技术面信号摘要（F5-3，复用 F5-1 /indicators 端点的客观信号，
 *    需 data-service 运行；可用 DAILY_REPORT_SIGNALS=false 关闭）。
 * 2. 异动提醒：盘中（9:30-11:30 / 13:00-15:00）每 N 分钟轮询全部自选股，
 *    涨跌幅绝对值超阈值即推送，每股每日只报一次防刷屏；
 *    2026-09-19 起并入自定义多条件监控规则（F5-4，价格上下限/涨跌幅，AND/OR 组合，
 *    条件粒度每日去重，与阈值提醒合并为一条推送）。
 * 用 setTimeout 实现的极简调度器，避免引入 cron 依赖；
 * 任务变多后建议换成 node-cron 或 BullMQ。
 */
import { config } from '../config.js';
import type { Channel } from '../channels/types.js';
import type { DataProvider, OverseasSummary, Quote } from '../data/provider.js';
import type { Store } from '../storage/store.js';
import { TradeCalendar } from '../data/pythonService.js';
import { describeCondition, evaluateRule } from './rules.js';
import { buildOverseasHints } from '../data/overseasHints.js';

/** 交易日历单例：判断当日是否 A 股交易日（跳法定节假日），服务不可用时降级为只跳周末 */
const tradeCalendar = new TradeCalendar();

/** 当前北京时间（服务器在任何时区都对）。导出供单测使用（配合 vi.setSystemTime）。
 *  已知边界：用"当前时刻"的本地时区偏移做平移，部署在有夏令时的海外服务器且调度窗口
 *  横跨 DST 切换时可能偏 ±1 小时（一年约两次，触发后自愈；国内服务器无 DST 不受影响）（审计 A-406）。 */
export function beijingNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000);
}

/** 计算到下一个"工作日 HH:MM（北京时间）"的毫秒数。导出供单测使用。 */
export function msUntilNextRun(hour: number, minute: number): number {
  const bj = beijingNow();
  const target = new Date(bj);
  target.setHours(hour, minute, 0, 0);
  if (target <= bj) target.setDate(target.getDate() + 1);
  // 跳过周末（6=周六, 0=周日）
  while (target.getDay() === 0 || target.getDay() === 6) target.setDate(target.getDate() + 1);
  return target.getTime() - bj.getTime();
}

/** 是否处于 A 股盘中连续竞价时段（北京时间，仅判断工作日 + 时段；法定节假日由 tradeCalendar 另行判断）。导出供单测使用。 */
export function isTradingTime(bj: Date): boolean {
  const day = bj.getDay();
  if (day === 0 || day === 6) return false;
  const mins = bj.getHours() * 60 + bj.getMinutes();
  return (mins >= 9 * 60 + 30 && mins <= 11 * 60 + 30) || (mins >= 13 * 60 && mins <= 15 * 60);
}

function dateKey(bj: Date): string {
  return `${bj.getFullYear()}-${bj.getMonth() + 1}-${bj.getDate()}`;
}

function formatQuoteLine(q: Quote): string {
  // 涨跌幅可能缺失（如新股首日无昨收），NaN 显示 —（审计 A-310）
  if (!Number.isFinite(q.changePct)) return `➖ ${q.name}（${q.code}） ${q.price.toFixed(2)} 元  涨跌幅 —`;
  const arrow = q.changePct > 0 ? '📈' : q.changePct < 0 ? '📉' : '➖';
  return `${arrow} ${q.name}（${q.code}） ${q.price.toFixed(2)} 元  ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%`;
}

/** 尽力推送：单用户单渠道失败只记日志，不中断当轮其余用户（审计 A-403/A-602） */
async function notifyUser(channels: Channel[], userId: string, text: string): Promise<boolean> {
  let allOk = true;
  for (const ch of channels) {
    try {
      await ch.notify(userId, text);
    } catch (err) {
      allOk = false;
      console.error(`[scheduler] 推送失败（${ch.name} -> ${userId}）:`, err);
    }
  }
  return allOk;
}

/** 单只股票在日报信号区最多展示的信号条数（防超长推送刷屏） */
const MAX_SIGNALS_PER_STOCK = 3;

/**
 * 日报的技术面信号区（F5-3）：逐股并发拉 F5-1 指标端点，只列出有客观信号的股票
 * （金叉/死叉/超买超卖/突破布林轨等状态描述，口径与 F5-1 一致，不含买卖建议）。
 * 返回 null = 本节不出现（全部无信号且零失败，或被配置关闭）；
 * 数据源整体不可用时返回一行降级说明（与详情页"单块失败只标注自己"同一模式）。
 */
async function buildSignalSection(
  data: DataProvider,
  codes: string[],
  quotes: (Quote | null)[],
): Promise<string | null> {
  if (!config.dailyReport.signals) return null;
  if (typeof data.getIndicators !== 'function') {
    return '【技术面信号】暂不可用（当前数据源无指标能力，需启动 data-service）';
  }
  // failed 标记与"无信号"区分：全部失败时给降级说明而不是静默消失
  const results: ({ line: string } | { failed: true } | null)[] = await Promise.all(
    codes.map(async (c, i) => {
      try {
        const ind = await data.getIndicators!(c);
        if (ind.signals.length === 0) return null;
        const name = quotes[i]?.name ?? c;
        const shown = ind.signals
          .slice(0, MAX_SIGNALS_PER_STOCK)
          .map((s) => s.text)
          .join('；');
        return { line: `· ${name}（${c}）：${shown}` };
      } catch {
        return { failed: true };
      }
    }),
  );
  const lines = results.flatMap((r) => (r && 'line' in r ? [r.line] : []));
  const failedCount = results.filter((r) => r && 'failed' in r).length;
  if (lines.length === 0 && failedCount === 0) return null; // 全市场平静，不占版面
  if (lines.length === 0) return '【技术面信号】暂不可用（data-service 未运行或指标计算失败）';
  const header = '【技术面信号】（客观状态描述，非买卖建议）';
  const tail = failedCount > 0 ? `\n（${failedCount} 只技术面数据获取失败，已跳过）` : '';
  return `${header}\n${lines.join('\n')}${tail}`;
}

/** 组装一个用户的收盘日报（行情 + 技术面信号摘要）。导出供单测使用。 */
export async function buildDailyReport(
  store: Store,
  data: DataProvider,
  userId: string,
): Promise<string> {
  const codes = store.getWatchlist(userId);
  const quotes: (Quote | null)[] = await Promise.all(
    codes.map(async (c) => {
      try {
        return await data.getQuote(c);
      } catch {
        return null;
      }
    }),
  );
  const lines = codes.map((c, i) =>
    quotes[i] ? formatQuoteLine(quotes[i]!) : `⚠️ ${c} 行情获取失败`,
  );
  let report = `【收盘日报】你的自选股今日表现：\n${lines.join('\n')}`;
  if (codes.length > 0) {
    const section = await buildSignalSection(data, codes, quotes);
    if (section) report += `\n\n${section}`;
  }
  return `${report}\n\n以上仅供参考，不构成投资建议。`;
}

/** 盘中异动提醒轮询：全局涨跌幅阈值（自选股）+ 用户自定义多条件规则（F5-4）合并推送 */
function startPriceAlerts(store: Store, data: DataProvider, channels: Channel[]): void {
  const threshold = config.alerts.thresholdPct;
  // `${date}:${code}` 阈值提醒；`${date}:r<id>`（all 规则）/ `${date}:r<id>:<条件序号>`（any 规则）自定义提醒
  const alerted = new Set<string>();

  const tick = async (): Promise<void> => {
    const bj = beijingNow();
    try {
      if (isTradingTime(bj) && (await tradeCalendar.isTradeDay(bj))) {
        const today = dateKey(bj);
        // 跨天后清掉前一天的记录
        for (const k of alerted) if (!k.startsWith(today)) alerted.delete(k);

        const rules = store.getEnabledAlertRules();
        // 用户集合 = 有自选股的 + 有监控规则的（规则股票不要求在自选股里）
        const users = [...new Set([...store.allUsers(), ...rules.map((r) => r.userId)])];
        // 先汇总全部用户的自选股与规则股票去重拉行情，避免多用户重复请求东财
        const allCodes = [
          ...new Set([...users.flatMap((u) => store.getWatchlist(u)), ...rules.map((r) => r.code)]),
        ];
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
          const parts: string[] = [];
          // 推送成功才写 alerted 标记，失败下轮补报（审计 A-404：先标记后推送会丢当日提醒）
          const markOnSuccess: string[] = [];

          // —— 全局阈值提醒（自选股涨跌幅超 ±threshold%）——
          const hits = store
            .getWatchlist(userId)
            .map((c) => quotes.get(c))
            .filter((q): q is Quote => !!q && Number.isFinite(q.changePct) && Math.abs(q.changePct) >= threshold)
            .filter((q) => !alerted.has(`${today}:${q.code}`));
          if (hits.length > 0) {
            parts.push(
              `【异动提醒】以下自选股涨跌幅超过 ±${threshold}%：\n` + hits.map(formatQuoteLine).join('\n'),
            );
            markOnSuccess.push(...hits.map((q) => `${today}:${q.code}`));
          }

          // —— 自定义多条件规则（F5-4）——
          const ruleLines: string[] = [];
          for (const r of rules) {
            if (r.userId !== userId) continue;
            const q = quotes.get(r.code);
            if (!q) continue;
            const fired = evaluateRule(r, q);
            if (!fired) continue;
            if (r.combinator === 'all') {
              // all 规则满足时全部条件必然都触发，按规则整体去重（每日一次）
              const key = `${today}:r${r.id}`;
              if (alerted.has(key)) continue;
              ruleLines.push(
                `· #${r.id} ${q.name}（${r.code}）现价 ${q.price.toFixed(2)} 元：` +
                  `${r.conditions.map(describeCondition).join('；')}（已全部满足）`,
              );
              markOnSuccess.push(key);
            } else {
              // any 规则按条件粒度去重：同一规则的不同条件可在不同时间各自触发一次
              const fresh = fired.filter((i) => !alerted.has(`${today}:r${r.id}:${i}`));
              if (fresh.length === 0) continue;
              ruleLines.push(
                `· #${r.id} ${q.name}（${r.code}）现价 ${q.price.toFixed(2)} 元：触发 ` +
                  fresh.map((i) => describeCondition(r.conditions[i])).join('；'),
              );
              markOnSuccess.push(...fresh.map((i) => `${today}:r${r.id}:${i}`));
            }
          }
          if (ruleLines.length > 0) {
            parts.push(`【条件提醒】你的监控规则已触发：\n${ruleLines.join('\n')}`);
          }

          if (parts.length === 0) continue;
          const text = parts.join('\n\n') + '\n\n以上仅供参考，不构成投资建议。';
          if (await notifyUser(channels, userId, text)) {
            for (const k of markOnSuccess) alerted.add(k);
          }
        }
      }
    } catch (err) {
      console.error('[scheduler] 异动提醒轮询失败:', err);
    } finally {
      setTimeout(() => void tick(), config.alerts.intervalMinutes * 60_000);
    }
  };
  console.log(
    `[scheduler] 异动提醒已启动：盘中每 ${config.alerts.intervalMinutes} 分钟轮询，阈值 ±${threshold}%（含自定义监控规则 F5-4）`,
  );
  void tick();
}

export function startScheduler(store: Store, data: DataProvider, channels: Channel[]): void {
  const scheduleDaily = () => {
    const delay = msUntilNextRun(15, 30);
    console.log(`[scheduler] 下次收盘日报推送在 ${(delay / 3_600_000).toFixed(1)} 小时后`);
    setTimeout(async () => {
      try {
        // 触发时再判断当日是否交易日：法定节假日（春节/国庆等休市日）跳过推送
        if (!(await tradeCalendar.isTradeDay(beijingNow()))) {
          console.log('[scheduler] 今日非交易日，跳过收盘日报推送');
          return;
        }
        for (const userId of store.allUsers()) {
          try {
            const report = await buildDailyReport(store, data, userId);
            await notifyUser(channels, userId, report);
          } catch (err) {
            // 单用户失败不中断其余用户的当日日报（审计 A-403）
            console.error(`[scheduler] ${userId} 日报推送失败:`, err);
          }
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
  if (config.overseasPush.enabled) startOverseasPush(store, data, channels);
  if (config.scanner.autoUpdate) startScannerUpdate(store, data, channels);
}

// ---- 盘前外盘推送（F6-4，可选，OVERSEAS_PUSH_ENABLED=true 开启） ----

/** 外盘报价行：`· 名称 价格  涨跌幅`；价格/涨跌幅缺失显示 —（不补 0，同 A-310 原则） */
function formatOverseasLine(it: { name: string; price: number | null; changePct: number | null }): string {
  const price = typeof it.price === 'number' && Number.isFinite(it.price) ? String(it.price) : '—';
  if (typeof it.changePct !== 'number' || !Number.isFinite(it.changePct)) {
    return `· ${it.name} ${price}  涨跌幅 —`;
  }
  return `· ${it.name} ${price}  ${it.changePct >= 0 ? '+' : ''}${it.changePct.toFixed(2)}%`;
}

/** 组装盘前外盘推送文案（纯函数，导出供单测）。块失败降级为一行说明，不阻塞其余块。 */
export function buildOverseasPushText(summary: OverseasSummary): string {
  const parts: string[] = [
    `【盘前外盘参考】隔夜外盘与 A 股相关方向提示（快照 ${summary.generatedAt} 北京时间）`,
  ];

  if (summary.usIndices.error) {
    parts.push('美股三大指数：暂不可用');
  } else {
    parts.push(`美股三大指数（美东收盘）：\n${summary.usIndices.items.map(formatOverseasLine).join('\n')}`);
  }

  if (!summary.usHot.error && summary.usHot.items.length > 0) {
    const valid = summary.usHot.items.filter(
      (it) => typeof it.changePct === 'number' && Number.isFinite(it.changePct),
    );
    if (valid.length > 0) {
      const avg = valid.reduce((s, it) => s + (it.changePct ?? 0), 0) / valid.length;
      const upCount = valid.filter((it) => (it.changePct ?? 0) > 0).length;
      parts.push(
        `中概股与美股热门篮子：${valid.length} 只平均 ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%（涨 ${upCount} / 跌 ${valid.length - upCount}）`,
      );
    }
  }

  if (summary.commodities.error) {
    parts.push('国际金银原油：暂不可用');
  } else {
    parts.push(`国际金银原油：\n${summary.commodities.items.map(formatOverseasLine).join('\n')}`);
  }

  const hints = buildOverseasHints(summary);
  parts.push(`【方向提示】（基于历史相关性的客观映射，仅供参考）\n${hints.map((h) => `· ${h}`).join('\n')}`);
  return `${parts.join('\n\n')}\n\n以上仅供参考，不构成投资建议。`;
}

/** 盘前外盘推送：交易日约 9:10（北京时间）向有自选股或有监控规则的用户推送外盘摘要 */
function startOverseasPush(store: Store, data: DataProvider, channels: Channel[]): void {
  const scheduleNext = () => {
    const delay = msUntilNextRun(9, 10);
    console.log(`[scheduler] 下次盘前外盘推送在 ${(delay / 3_600_000).toFixed(1)} 小时后`);
    setTimeout(async () => {
      try {
        // 触发时再判断交易日（与收盘日报同一结构；法定节假日跳过，日历挂掉降级为只跳周末）
        if (!(await tradeCalendar.isTradeDay(beijingNow()))) {
          console.log('[scheduler] 今日非交易日，跳过盘前外盘推送');
          return;
        }
        if (typeof data.getOverseasSummary !== 'function') {
          console.warn('[scheduler] 当前数据源无外盘能力（需 data-service），跳过盘前外盘推送');
          return;
        }
        const summary = await data.getOverseasSummary();
        const text = buildOverseasPushText(summary);
        // 用户集合 = 有自选股 ∪ 有监控规则（与异动提醒一致）
        const users = [
          ...new Set([...store.allUsers(), ...store.getEnabledAlertRules().map((r) => r.userId)]),
        ];
        for (const userId of users) {
          await notifyUser(channels, userId, text); // 单用户失败只记日志（notifyUser 内部处理）
        }
      } catch (err) {
        console.error('[scheduler] 盘前外盘推送失败:', err);
      } finally {
        scheduleNext();
      }
    }, delay);
  };
  console.log('[scheduler] 盘前外盘推送已启动：交易日约 9:10（北京时间）推送隔夜外盘摘要');
  scheduleNext();
}

// ---- 选股扫描盘后更新与可选推送（F5-5，2026-09-21） ----

/** 扫描推送摘要里每个策略最多列出的股票数（防超长推送刷屏） */
const SCAN_PUSH_TOP_N = 3;
/** 更新完成后推送摘要时，每个策略扫描返回的条数 */
const SCAN_PUSH_PER_STRATEGY = 5;
/** 等待更新完成的轮询间隔（毫秒）与封顶时刻（北京时间 21:30，过时放弃当日推送） */
const SCAN_PUSH_POLL_MS = 5 * 60_000;
const SCAN_PUSH_DEADLINE_MINUTES = 21 * 60 + 30;

/**
 * 组装盘后扫描推送文案（纯函数，导出供单测）。
 * 每个策略一行命中数 + 前 SCAN_PUSH_TOP_N 只（代码+名称），全部策略零命中返回 null（不占版面）。
 * 红线：文案只陈述"客观指标条件命中名单"，不含任何推荐/买卖暗示。
 */
export function buildScanPushText(
  results: { name: string; total: number; items: { code: string; name: string | null }[] }[],
  asOf: string,
): string | null {
  const nonEmpty = results.filter((r) => r.total > 0);
  if (nonEmpty.length === 0) return null;
  const lines = nonEmpty.map((r) => {
    const top = r.items
      .slice(0, SCAN_PUSH_TOP_N)
      .map((it) => `${it.name ?? ''}（${it.code}）`)
      .join('、');
    return `· ${r.name}：${r.total} 只命中${top ? `（${top}${r.total > SCAN_PUSH_TOP_N ? ' 等' : ''}）` : ''}`;
  });
  return (
    `【盘后扫描摘要】本地日 K 库数据截至 ${asOf}，以下预设条件的客观命中情况：\n` +
    `${lines.join('\n')}\n\n命中名单是客观指标条件的筛选结果，不代表推荐；` +
    `完整结果见 /scanner 页面。\n\n以上仅供参考，不构成投资建议。`
  );
}

/**
 * 盘后扫描更新：交易日约 15:40（北京时间）触发 data-service 增量更新本地日 K 库
 * （fire-and-forget，结果只记日志）。SCANNER_PUSH_ENABLED=true 时轮询更新状态，
 * 完成后对全部预设策略跑扫描并把摘要推送给有自选股 ∪ 有监控规则的用户；
 * 到北京时间 21:30 仍未完成则放弃当日推送（只记日志）。
 */
function startScannerUpdate(store: Store, data: DataProvider, channels: Channel[]): void {
  const pollAndPush = async (): Promise<void> => {
    const bj = beijingNow();
    if (bj.getHours() * 60 + bj.getMinutes() > SCAN_PUSH_DEADLINE_MINUTES) {
      console.warn('[scheduler] 扫描更新到 21:30 仍未完成，放弃当日扫描推送');
      return;
    }
    const status = await data.getMarketBarsStatus!();
    if (status.running) {
      setTimeout(() => void pollAndPush(), SCAN_PUSH_POLL_MS);
      return;
    }
    if (status.phase !== 'done') {
      console.warn(`[scheduler] 扫描更新未正常完成（phase=${status.phase}），跳过当日扫描推送`);
      return;
    }
    if (!data.getScanStrategies || !data.runScan) return;
    const strategies = await data.getScanStrategies();
    let asOf = '';
    const results = await Promise.all(
      strategies.map(async (s) => {
        const r = await data.runScan!(s.key, SCAN_PUSH_PER_STRATEGY);
        asOf = asOf || r.asOf;
        return { name: r.name, total: r.total, items: r.items };
      }),
    );
    const text = buildScanPushText(results, asOf);
    if (!text) {
      console.log('[scheduler] 今日全部扫描策略零命中，不推送');
      return;
    }
    const users = [
      ...new Set([...store.allUsers(), ...store.getEnabledAlertRules().map((r) => r.userId)]),
    ];
    for (const userId of users) {
      await notifyUser(channels, userId, text); // 单用户失败只记日志（notifyUser 内部处理）
    }
  };

  const scheduleNext = () => {
    const delay = msUntilNextRun(15, 40);
    console.log(`[scheduler] 下次盘后扫描更新在 ${(delay / 3_600_000).toFixed(1)} 小时后`);
    setTimeout(async () => {
      try {
        // 触发时再判断交易日（与收盘日报同一结构；法定节假日跳过，日历挂掉降级为只跳周末）
        if (!(await tradeCalendar.isTradeDay(beijingNow()))) {
          console.log('[scheduler] 今日非交易日，跳过盘后扫描更新');
          return;
        }
        if (typeof data.triggerMarketBarsUpdate !== 'function') {
          console.warn('[scheduler] 当前数据源无扫描能力（需 data-service），跳过盘后扫描更新');
          return;
        }
        await data.triggerMarketBarsUpdate(false); // 单飞行：已在跑时上游 409，视为已触发
        console.log('[scheduler] 已触发盘后日 K 库增量更新');
        if (config.scanner.pushEnabled) {
          setTimeout(() => void pollAndPush(), SCAN_PUSH_POLL_MS);
        }
      } catch (err) {
        // 409（更新已在进行中）也走这里：等价于已触发，只记日志不告警
        console.log('[scheduler] 盘后扫描更新触发结果：', err instanceof Error ? err.message : err);
      } finally {
        scheduleNext();
      }
    }, delay);
  };
  console.log(
    `[scheduler] 盘后扫描更新已启动：交易日约 15:40（北京时间）触发日 K 库增量更新` +
      (config.scanner.pushEnabled ? '（完成后推送扫描摘要）' : '（推送关闭）'),
  );
  scheduleNext();
}
