/**
 * get_stock_patterns（F6-1）：K 线形态识别 + 历史成绩单。
 * 调 DataProvider.getPatterns（微服务 /patterns 端点，纯本地计算），
 * 格式化为"近期出现形态 + 历史成绩单"文本回传 LLM。
 * 红线：全部数字为历史事实统计口径，输出中保留口径说明与免责声明，
 * 并显式指示 LLM 不得转述为预测或买卖建议。
 */
import type { Skill } from '../../types.js';
import { invalidCodeMessage } from '../../args.js';
import type { PatternReport, PatternWindowStats } from '../../../data/provider.js';

/** 平均涨跌幅带符号格式化（%） */
function fmtSigned(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

/** 单个统计窗口（信号日后 N 个交易日）的一行摘要 */
function fmtWindow(w: PatternWindowStats): string {
  if (w.count === 0 || w.upRatio === null || w.avgRet === null || w.avgMaxDrawdown === null) {
    return '样本不足';
  }
  return `上涨占比 ${w.upRatio}%，平均涨跌幅 ${fmtSigned(w.avgRet)}%，平均最大回撤 ${w.avgMaxDrawdown.toFixed(2)}%`;
}

/** 完整报告 -> 回传 LLM 的紧凑文本 */
export function formatPatternReport(report: PatternReport, name?: string): string {
  const srcLabel = report.source === 'sina' ? '新浪财经（降级源）' : '东方财富';
  const head = `${name ? `${name}（${report.code}）` : report.code} K 线形态识别：` +
    `数据截至 ${report.asOf}，统计窗口为近 ${report.days} 个交易日前复权日 K（数据源：${srcLabel}）。`;

  const sections: string[] = [head];

  const recent = report.patterns.filter((p) => p.recentDates.length > 0);
  if (recent.length > 0) {
    sections.push(
      '【近期出现的形态（近约 60 个交易日）】\n' +
        recent.map((p) => `- ${p.name}（${p.direction}）：${p.recentDates.join('、')}`).join('\n'),
    );
  } else {
    sections.push('【近期出现的形态（近约 60 个交易日）】\n未检测到形态库中的形态。');
  }

  if (report.patterns.length > 0) {
    const lines = report.patterns.map((p) => {
      const sampleNote = p.count < 5 ? '（样本过少，统计意义有限）' : '';
      return [
        `- ${p.name}（${p.direction}）：窗口内共出现 ${p.count} 次${sampleNote}`,
        `  5 日：${fmtWindow(p.stats['5'])}`,
        `  10 日：${fmtWindow(p.stats['10'])}`,
        `  20 日：${fmtWindow(p.stats['20'])}`,
      ].join('\n');
    });
    sections.push(
      '【历史成绩单（口径：形态信号日之后 5/10/20 个交易日的实际走势汇总）】\n' + lines.join('\n'),
    );
  } else {
    sections.push('【历史成绩单】\n统计窗口内未检测到形态库中的形态。');
  }

  sections.push(
    '注意：以上全部是历史事实统计，不代表未来表现。转述给用户时必须保留这一口径说明，' +
      '不得把上涨占比等数字表述为对未来的预测，也不得给出任何买卖建议。' +
      report.disclaimer,
  );
  return sections.join('\n\n');
}

const skill: Skill = {
  name: 'get_stock_patterns',
  description:
    'K 线形态识别与历史成绩单（F6-1）：扫描指定股票近约 3 年日 K 上的经典形态' +
    '（吞没/早晨之星/红三兵/双底/头肩底/三角形等 17 种），返回近期出现的形态与每种形态' +
    '历史出现后的 5/10/20 日表现统计（上涨占比/平均涨跌幅/平均最大回撤，历史事实口径）。' +
    '用户问"形态/信号识别/出现某形态后走势"时使用；要全面分析用 analyze_stock。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '6 位股票代码，如 600519（贵州茅台）、002594（比亚迪）' },
    },
    required: ['code'],
  },
  async execute(args, ctx) {
    const code = String(args.code ?? '');
    const bad = invalidCodeMessage(code);
    if (bad) return bad;
    if (!ctx.data.getPatterns) {
      return '形态识别功能需要 data-service 数据微服务，当前数据源不支持。' +
        '请提示用户启动 data-service 后再试。';
    }
    const report = await ctx.data.getPatterns(code);
    // 名称仅用于展示，行情失败（停牌等）退化为代码，不阻塞形态结果
    let name = '';
    try {
      name = (await ctx.data.getQuote(code)).name;
    } catch { /* 名称缺失可接受 */ }
    return formatPatternReport(report, name || undefined);
  },
};

export default skill;
