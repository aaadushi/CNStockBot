/**
 * scan_market（F5-5）：全市场选股扫描——本地日 K 库 + 预设策略客观指标筛选。
 * 调 DataProvider.runScan（微服务 /scan 端点，宽表向量化本地计算），
 * 格式化为"策略口径 + TOP N 命中名单 + 数据日期 + 免责声明"文本回传 LLM。
 * 红线：命中名单是客观指标条件的筛选结果，输出中保留口径说明与免责声明，
 * 并显式指示 LLM 不得转述为推荐或买卖建议。
 */
import type { Skill } from '../../types.js';
import { normalizeLimit } from '../../args.js';
import type { ScanResult } from '../../../data/provider.js';

/** 回传 LLM 的命中条数上限：tool 结果超 1200 字符会被截断入库（agent/loop.ts），
 *  10 条 × 约 60 字符 + 头尾模板约 350 字符，处于安全区 */
const MAX_ITEMS_IN_REPLY = 10;

/** 预设策略 key 白名单（与 data-service /scan/strategies 同源文字，改动需同步） */
export const SCAN_STRATEGY_KEYS = [
  'ma_bull',
  'macd_gold',
  'rsi_oversold',
  'vol_break_20d',
  'pullback_ma20',
  'boll_lower',
  'ma_cross_up',
] as const;

/** 扫描结果 -> 回传 LLM 的紧凑文本。导出供单测。 */
export function formatScanResult(result: ScanResult): string {
  const head =
    `全市场扫描（策略：${result.name}，口径：${result.description}）：` +
    `数据截至 ${result.asOf}${result.stale ? '（非最新交易日）' : ''}，共 ${result.total} 只命中。`;

  const sections = [head];
  if (result.items.length === 0) {
    sections.push('无命中股票。');
  } else {
    const lines = result.items.map((it, i) => {
      const price = it.close === null ? '—' : it.close.toFixed(2);
      const pct =
        it.changePct === null ? '—' : `${it.changePct >= 0 ? '+' : ''}${it.changePct.toFixed(2)}%`;
      return `${i + 1}. ${it.name ?? ''}（${it.code}）收盘 ${price} 元（${pct}）：${it.extra}`;
    });
    sections.push(lines.join('\n'));
    if (result.total > result.items.length) {
      sections.push(`（仅列出前 ${result.items.length} 条，完整 ${result.total} 条见 /scanner 页面）`);
    }
  }
  if (result.note) sections.push(`注意：${result.note}`);
  sections.push(
    '转述给用户时必须保留数据截至日期与"客观指标筛选命中名单"的口径，' +
      '不得表述为推荐买入或任何买卖建议、不得预测涨跌。' +
      result.disclaimer,
  );
  return sections.join('\n');
}

const skill: Skill = {
  name: 'scan_market',
  description:
    '全市场选股扫描（F5-5）：在本地日 K 库（沪深 A 股，盘后更新）上按预设策略做客观指标筛选，' +
    '返回命中股票名单（代码/名称/收盘/涨跌幅/触发条件的具体数值）。策略 key：' +
    'ma_bull=MA 多头排列、macd_gold=MACD 金叉、rsi_oversold=RSI 超卖、' +
    'vol_break_20d=放量突破 20 日新高、pullback_ma20=缩量回踩 MA20、boll_lower=触及布林下轨、' +
    'ma_cross_up=MA5 金叉 MA20。用户问"全市场哪些股票满足某条件/帮我扫描/选股"时使用；' +
    '单只股票的分析用 analyze_stock 或 get_stock_patterns。',
  parameters: {
    type: 'object',
    properties: {
      strategy: {
        type: 'string',
        enum: [...SCAN_STRATEGY_KEYS],
        description: '预设策略 key（七选一；用户中文描述映射到最近的一个，无对应策略时告知可选清单）',
      },
      limit: { type: 'number', description: '返回条数上限（默认 10，最大 10）' },
    },
    required: ['strategy'],
  },
  async execute(args, ctx) {
    if (!ctx.data.runScan) {
      return '选股扫描功能需要 data-service 数据微服务，当前数据源不支持。' +
        '请提示用户启动 data-service 后再试。';
    }
    const strategy = String(args.strategy ?? '');
    if (!(SCAN_STRATEGY_KEYS as readonly string[]).includes(strategy)) {
      return `未知策略：${strategy}。可选策略：${SCAN_STRATEGY_KEYS.join(' / ')}`;
    }
    const limit = normalizeLimit(args.limit, MAX_ITEMS_IN_REPLY, MAX_ITEMS_IN_REPLY);
    return formatScanResult(await ctx.data.runScan(strategy, limit));
  },
};

export default skill;
