import type { Skill } from '../../types.js';
import { invalidCodeMessage } from '../../args.js';
import {
  describeCondition,
  describeRule,
  validateConditions,
  MAX_RULES_PER_USER,
  type AlertCombinator,
} from '../../../alerts/rules.js';

/**
 * manage_alerts（F5-4 多条件监控提醒）：用户按个股自定义触发条件
 * （价格上下限 / 涨跌幅阈值，AND/OR 组合），盘中轮询触发后主动推送。
 * 与全局异动提醒（单一涨跌幅阈值、对全部自选股生效）互补；规则股票不要求在自选股里。
 */
const skill: Skill = {
  name: 'manage_alerts',
  description:
    '管理用户的个股监控提醒：为某只股票设置价格上下限或涨跌幅阈值条件（可多个条件任意/全部组合），' +
      '盘中触发后主动推送提醒。用户说"XX涨到300提醒我""跌破80告诉我""查看/删除我的提醒"时使用。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'list', 'remove', 'enable', 'disable'],
        description: '操作类型',
      },
      code: { type: 'string', description: '6 位股票代码，action 为 add 时必填' },
      conditions: {
        type: 'array',
        description: '触发条件列表，action 为 add 时必填；一条规则最多 5 个条件',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['price_above', 'price_below', 'change_pct'],
              description: 'price_above=价格涨到≥，price_below=价格跌到≤，change_pct=涨跌幅绝对值≥（%）',
            },
            value: { type: 'number', description: '阈值（价格单位元，change_pct 单位 %）' },
          },
          required: ['type', 'value'],
        },
      },
      combinator: {
        type: 'string',
        enum: ['any', 'all'],
        description: '多条件组合：any=任一触发即提醒（默认），all=全部满足才提醒',
      },
      ruleId: { type: 'number', description: '规则编号（list 结果里的 #N），remove/enable/disable 时必填' },
    },
    required: ['action'],
  },
  async execute(args, ctx) {
    const action = String(args.action);

    // 白名单校验：LLM 幻觉出的未知 action 不得落入删除分支（同 manage_watchlist 的 A-201 教训）
    if (!['add', 'list', 'remove', 'enable', 'disable'].includes(action)) {
      return `未知操作"${action}"，仅支持 add/list/remove/enable/disable。请向用户确认意图后再操作，不要擅自删除。`;
    }

    if (action === 'list') {
      const rules = ctx.store.getAlertRules(ctx.userId);
      if (rules.length === 0) {
        return '你还没有设置监控提醒。可以告诉我类似"茅台涨到 1500 提醒我"，我帮你创建规则。';
      }
      // 带名称展示更友好；行情失败（停牌等）退化为只显示代码
      const names = await Promise.all(
        rules.map(async (r) => {
          try {
            return (await ctx.data.getQuote(r.code)).name;
          } catch {
            return undefined;
          }
        }),
      );
      const lines = rules.map((r, i) => describeRule(r, names[i]));
      return (
        `你的监控提醒（${rules.length} 条）：\n${lines.join('\n')}\n\n` +
        '规则在盘中交易时段生效，触发后推送提醒，同一条件每天只提醒一次；删除/停用告诉我规则编号即可。'
      );
    }

    if (action === 'add') {
      const code = args.code ? String(args.code) : null;
      if (!code || invalidCodeMessage(code)) return '请提供 6 位股票代码。';
      const v = validateConditions(args.conditions);
      if (!v.conditions) return v.error ?? '条件格式不正确。';
      const count = ctx.store.countAlertRules(ctx.userId);
      if (count >= MAX_RULES_PER_USER) {
        return `你的监控规则已达上限 ${MAX_RULES_PER_USER} 条，请先删除不再需要的规则（用 list 查看编号）。`;
      }
      const combinator: AlertCombinator = args.combinator === 'all' ? 'all' : 'any';
      // 验证代码真实存在并拿名称；停牌股行情抛错时降级用搜索确认（同 manage_watchlist A-202）
      let name: string | null = null;
      try {
        name = (await ctx.data.getQuote(code)).name;
      } catch {
        const found = ((await ctx.data.search?.(code)) ?? []).find((r) => r.code === code);
        if (found) name = found.name;
      }
      if (!name) return `未找到代码 ${code} 对应的股票，请核对后再试（不要凭记忆猜测）。`;
      const id = ctx.store.addAlertRule(ctx.userId, code, combinator, v.conditions);
      return (
        `已创建监控规则 #${id}：${name}（${code}），` +
        `${combinator === 'all' ? '以下条件全部满足' : '以下任一条件满足'}时提醒：\n` +
        v.conditions.map((c) => `· ${describeCondition(c)}`).join('\n') +
        '\n规则在盘中交易时段生效，同一条件每天只提醒一次。'
      );
    }

    // remove / enable / disable：都要 ruleId
    const ruleId = Math.trunc(Number(args.ruleId));
    if (!Number.isFinite(ruleId) || ruleId < 1) {
      return '请提供规则编号（用 list 操作查看你的规则编号，形如 #3）。';
    }
    if (action === 'remove') {
      const removed = ctx.store.removeAlertRule(ctx.userId, ruleId);
      return removed
        ? `已删除监控规则 #${ruleId}。`
        : `没有找到编号为 #${ruleId} 的规则（只能操作自己的规则，可先用 list 查看编号）。`;
    }
    const enabled = action === 'enable';
    const ok = ctx.store.setAlertRuleEnabled(ctx.userId, ruleId, enabled);
    return ok
      ? `已${enabled ? '恢复' : '停用'}监控规则 #${ruleId}。`
      : `没有找到编号为 #${ruleId} 的规则（只能操作自己的规则，可先用 list 查看编号）。`;
  },
};

export default skill;
