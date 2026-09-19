/**
 * 「A 股相关方向提示」（F6-4）：基于隔夜外盘数据的**规则化客观映射**。
 *
 * 红线约束：全部是"历史上与 X 板块情绪相关"的参考性表述，禁止任何买卖建议、
 * 价格预测；文案末尾统一由调用方附"仅供参考，不构成投资建议"。
 *
 * 规则一览（阈值均为经验性客观口径，写在代码里而非 LLM 生成，保证可复现）：
 * - 纳指/标普/道指涨跌幅绝对值 ≥ 1.5% → 对应 A 股板块情绪提示（科技/大盘）
 * - 中概股篮子平均涨跌幅绝对值 ≥ 1.5% → 中概映射与港股联动情绪提示
 * - 黄金（伦敦金/COMEX黄金取其一）涨跌幅绝对值 ≥ 1% → 黄金贵金属板块提示
 * - 原油（WTI/布伦特取其一）涨跌幅绝对值 ≥ 2% → 石油石化/航运板块提示
 * 无规则触发时返回一条"波动不大"说明。块失败（error 非空）的块不参与映射。
 */
import type { OverseasBlock, OverseasSummary } from './provider.js';

/** 涨跌幅百分比文案：+2.30% / -1.05% */
function pct(p: number): string {
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
}

/** 从块里按名称关键词找第一条有涨跌幅的条目 */
function findPct(block: OverseasBlock, ...keywords: string[]): { name: string; changePct: number } | null {
  for (const kw of keywords) {
    const hit = block.items.find(
      (it) => it.name.includes(kw) && typeof it.changePct === 'number' && Number.isFinite(it.changePct),
    );
    if (hit) return { name: hit.name, changePct: hit.changePct! };
  }
  return null;
}

const INDEX_THRESHOLD = 1.5; // 指数涨跌幅触发阈值（%）
const CN_STOCK_THRESHOLD = 1.5; // 中概股篮子均值触发阈值（%）
const GOLD_THRESHOLD = 1.0; // 黄金触发阈值（%）
const OIL_THRESHOLD = 2.0; // 原油触发阈值（%）

/** 由外盘汇总生成方向提示文案列表（无触发时返回一条"波动不大"说明）。 */
export function buildOverseasHints(summary: OverseasSummary): string[] {
  const hints: string[] = [];

  // —— 美股三大指数 ——
  if (!summary.usIndices.error) {
    const nasdaq = findPct(summary.usIndices, '纳斯达克');
    const sp = findPct(summary.usIndices, '标普');
    const dow = findPct(summary.usIndices, '道琼斯');
    if (nasdaq && Math.abs(nasdaq.changePct) >= INDEX_THRESHOLD) {
      const dir = nasdaq.changePct > 0 ? '上涨' : '下跌';
      hints.push(
        `隔夜纳斯达克综合指数${dir} ${pct(nasdaq.changePct)}，历史上与 A 股科技成长板块开盘情绪相关，仅供参考`,
      );
    }
    const bigIndex = sp ?? dow;
    if (bigIndex && Math.abs(bigIndex.changePct) >= INDEX_THRESHOLD) {
      const dir = bigIndex.changePct > 0 ? '上涨' : '下跌';
      hints.push(
        `隔夜${bigIndex.name}${dir} ${pct(bigIndex.changePct)}，历史上与 A 股大盘整体开盘情绪相关，仅供参考`,
      );
    }
  }

  // —— 中概股篮子（按个股涨跌幅算术平均，等权） ——
  if (!summary.usHot.error) {
    const cn = summary.usHot.items.filter((it) => typeof it.changePct === 'number' && Number.isFinite(it.changePct));
    if (cn.length > 0) {
      const avg = cn.reduce((s, it) => s + it.changePct!, 0) / cn.length;
      if (Math.abs(avg) >= CN_STOCK_THRESHOLD) {
        const dir = avg > 0 ? '走强' : '走弱';
        hints.push(
          `隔夜中概股与美股热门篮子平均${dir}（均值 ${pct(avg)}，${cn.length} 只等权），历史上与中概映射及港股联动情绪相关，仅供参考`,
        );
      }
    }
  }

  // —— 国际商品 ——
  if (!summary.commodities.error) {
    const gold = findPct(summary.commodities, '伦敦金', '黄金');
    if (gold && Math.abs(gold.changePct) >= GOLD_THRESHOLD) {
      const dir = gold.changePct > 0 ? '上涨' : '下跌';
      hints.push(
        `国际金价（${gold.name}）${dir} ${pct(gold.changePct)}，历史上与 A 股黄金、贵金属板块情绪相关，仅供参考`,
      );
    }
    const oil = findPct(summary.commodities, '原油');
    if (oil && Math.abs(oil.changePct) >= OIL_THRESHOLD) {
      const dir = oil.changePct > 0 ? '上涨' : '下跌';
      hints.push(
        `国际油价（${oil.name}）${dir} ${pct(oil.changePct)}，历史上与 A 股石油石化、航运等板块情绪相关，仅供参考`,
      );
    }
  }

  if (hints.length === 0) {
    hints.push('隔夜外盘各品种波动均在提示阈值内，无显著方向提示。');
  }
  return hints;
}
