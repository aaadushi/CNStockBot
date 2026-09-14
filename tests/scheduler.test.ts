/**
 * 调度器时间函数单测：beijingNow / msUntilNextRun / isTradingTime。
 * 用 vi.setSystemTime 冻结系统时间，覆盖时区换算、跨周末调度、盘中时段边界。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { beijingNow, msUntilNextRun, isTradingTime } from '../src/alerts/scheduler.js';

afterEach(() => {
  vi.useRealTimers();
});

/** 冻结到某个 UTC 时刻，返回该时刻的北京时间字段 */
function freezeAt(utcIso: string): Date {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(utcIso));
  return beijingNow();
}

describe('beijingNow', () => {
  it('UTC 02:00 = 北京时间 10:00（与服务器本地时区无关）', () => {
    const bj = freezeAt('2026-09-14T02:00:00Z');
    expect(bj.getHours()).toBe(10);
    expect(bj.getMinutes()).toBe(0);
  });
});

describe('msUntilNextRun', () => {
  it('当天未到点 → 指向当天 15:30', () => {
    // 2026-09-14 是周一；北京时间 10:00（UTC 02:00）
    freezeAt('2026-09-14T02:00:00Z');
    expect(msUntilNextRun(15, 30)).toBe(5.5 * 3_600_000);
  });

  it('当天已过点 → 指向下一工作日', () => {
    // 周一北京时间 16:00（UTC 08:00）→ 周二 15:30，差 23.5 小时
    freezeAt('2026-09-14T08:00:00Z');
    expect(msUntilNextRun(15, 30)).toBe(23.5 * 3_600_000);
  });

  it('周五过点后跳过周末 → 下周一 15:30', () => {
    // 2026-09-11 是周五；北京时间 16:00（UTC 08:00）→ 周一 15:30，差 71.5 小时
    freezeAt('2026-09-11T08:00:00Z');
    expect(msUntilNextRun(15, 30)).toBe(71.5 * 3_600_000);
  });

  it('周六任意时间 → 下周一', () => {
    // 2026-09-12 是周六；北京时间 09:00（UTC 01:00）→ 周一 15:30，差 54.5 小时
    freezeAt('2026-09-12T01:00:00Z');
    expect(msUntilNextRun(15, 30)).toBe(54.5 * 3_600_000);
  });
});

describe('isTradingTime', () => {
  // 入参是"北京时间字段"的 Date（直接用本地字段构造即可，函数只读 getHours/getDay）
  const at = (day: number, h: number, m: number) => new Date(2026, 8, day, h, m); // 2026 年 9 月

  it('盘中时段边界：9:30 / 11:30 / 13:00 / 15:00 均在盘中', () => {
    expect(isTradingTime(at(14, 9, 30))).toBe(true); // 周一
    expect(isTradingTime(at(14, 11, 30))).toBe(true);
    expect(isTradingTime(at(14, 13, 0))).toBe(true);
    expect(isTradingTime(at(14, 15, 0))).toBe(true);
  });

  it('午休与盘前盘后不在盘中', () => {
    expect(isTradingTime(at(14, 9, 29))).toBe(false);
    expect(isTradingTime(at(14, 12, 0))).toBe(false); // 午休
    expect(isTradingTime(at(14, 15, 1))).toBe(false);
  });

  it('周末不在盘中（无论时段）', () => {
    expect(isTradingTime(at(12, 10, 0))).toBe(false); // 周六
    expect(isTradingTime(at(13, 14, 0))).toBe(false); // 周日
  });
});
