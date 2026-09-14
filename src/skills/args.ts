/**
 * 技能参数校验公共助手（审计 A-203/A-204：各技能曾各自为政，校验口径不一致）。
 */

/** 6 位数字股票代码校验；code 非法时返回给 LLM 的提示文本，合法返回 null */
export function invalidCodeMessage(code: string): string | null {
  return /^\d{6}$/.test(code) ? null : `请提供 6 位数字股票代码（收到的是"${code}"）。`;
}

/**
 * 条数参数归一化：LLM 可能传负数/NaN/小数，
 * 统一截断取整、限制在 [1, max]，非法值回退默认值。
 */
export function normalizeLimit(raw: unknown, def: number, max: number): number {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : def;
}
