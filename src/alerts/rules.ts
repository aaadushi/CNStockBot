/**
 * 多条件监控提醒（F5-4）的领域逻辑：规则类型、参数校验、盘中求值、文案格式化。
 * 全部纯函数/纯数据，不碰 store 与网络，供 scheduler（盘中轮询）与 manage_alerts 技能共用。
 *
 * 范围说明：条件类型为价格上下限 / 涨跌幅阈值（盘中即时数据可判）。
 * 指标信号类条件（金叉/超买等）不在此处——/indicators 基于已完成日 K，盘中不变，
 * 由 F5-3 收盘日报的信号摘要覆盖（见 docs/STATUS.md F5-4 行备注）。
 */
import type { Quote } from '../data/provider.js';

/** 条件类型：价格涨到 ≥ / 价格跌到 ≤ / 涨跌幅绝对值 ≥ */
export type AlertConditionType = 'price_above' | 'price_below' | 'change_pct';

export interface AlertCondition {
  type: AlertConditionType;
  value: number;
}

/** 多条件组合方式：any=任一触发即提醒，all=全部满足才提醒 */
export type AlertCombinator = 'any' | 'all';

/** 一条监控规则（存 SQLite alert_rules 表，conditions 列为 JSON） */
export interface AlertRule {
  id: number;
  userId: string;
  code: string;
  combinator: AlertCombinator;
  conditions: AlertCondition[];
  enabled: boolean;
}

/** 防滥用上限：LLM 可能一次生成超长条件数组/无限加规则 */
export const MAX_CONDITIONS_PER_RULE = 5;
export const MAX_RULES_PER_USER = 20;

export const CONDITION_TYPES: readonly AlertConditionType[] = [
  'price_above',
  'price_below',
  'change_pct',
];

/**
 * 校验并归一化 LLM 传入的条件数组。合法返回 { conditions, error: null }，非法返回
 * { conditions: null, error }（error 文本会回给 LLM，须包含下一步行为指引——PITFALLS LLM 条目）。
 */
export function validateConditions(
  raw: unknown,
): { conditions: AlertCondition[] | null; error: string | null } {
  const fail = (error: string) => ({ conditions: null, error });
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail(
      '请提供至少一个触发条件，形如 {"type":"price_above","value":300}。' +
        '可选类型：price_above=价格涨到≥、price_below=价格跌到≤、change_pct=涨跌幅绝对值≥（%）。',
    );
  }
  if (raw.length > MAX_CONDITIONS_PER_RULE) {
    return fail(`一条规则最多 ${MAX_CONDITIONS_PER_RULE} 个条件，请精简后再试。`);
  }
  const conditions: AlertCondition[] = [];
  for (const item of raw) {
    const type = (item as { type?: unknown })?.type;
    const value = Number((item as { value?: unknown })?.value);
    if (typeof type !== 'string' || !CONDITION_TYPES.includes(type as AlertConditionType)) {
      return fail(`条件类型"${String(type)}"不支持，仅支持 price_above / price_below / change_pct。`);
    }
    if (!Number.isFinite(value) || value <= 0) {
      return fail(`条件阈值必须是大于 0 的数字（收到 ${String((item as { value?: unknown })?.value)}）。`);
    }
    conditions.push({ type: type as AlertConditionType, value });
  }
  return { conditions, error: null };
}

/** 单个条件是否被当前行情触发（changePct 缺失如新股首日时 change_pct 条件不触发） */
export function conditionTriggered(c: AlertCondition, q: Quote): boolean {
  switch (c.type) {
    case 'price_above':
      return q.price >= c.value;
    case 'price_below':
      return q.price <= c.value;
    case 'change_pct':
      return Number.isFinite(q.changePct) && Math.abs(q.changePct) >= c.value;
  }
}

/**
 * 求值一条规则：返回被触发的条件下标数组。
 * combinator=all 时除非全部条件触发，否则返回 null（不触发）。
 */
export function evaluateRule(
  rule: Pick<AlertRule, 'combinator' | 'conditions'>,
  q: Quote,
): number[] | null {
  const fired: number[] = [];
  rule.conditions.forEach((c, i) => {
    if (conditionTriggered(c, q)) fired.push(i);
  });
  if (fired.length === 0) return null;
  if (rule.combinator === 'all' && fired.length < rule.conditions.length) return null;
  return fired;
}

/** 条件的人类可读描述（技能确认文本与推送文案共用） */
export function describeCondition(c: AlertCondition): string {
  switch (c.type) {
    case 'price_above':
      return `价格涨到 ≥ ${c.value} 元`;
    case 'price_below':
      return `价格跌到 ≤ ${c.value} 元`;
    case 'change_pct':
      return `涨跌幅绝对值 ≥ ${c.value}%`;
  }
}

/** 规则的整行描述，如 "#3 600519（任一满足）：价格涨到 ≥ 1500 元；涨跌幅绝对值 ≥ 3%" */
export function describeRule(r: AlertRule, name?: string): string {
  const combo = r.combinator === 'all' ? '全部满足' : '任一满足';
  const label = name ? `${name}（${r.code}）` : r.code;
  const off = r.enabled ? '' : '【已停用】';
  return `#${r.id} ${off}${label}（${combo}）：${r.conditions.map(describeCondition).join('；')}`;
}
