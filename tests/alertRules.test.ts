/**
 * F5-4 多条件监控提醒单测：
 * - rules.ts 纯函数：validateConditions / conditionTriggered / evaluateRule / describe*
 * - Store alert_rules 表 CRUD（临时目录真实 SQLite 往返，不碰项目 data/；
 *   同一文件内所有 Store 实例共享同一个临时库，各用例用不同 userId 隔离断言）
 * - manage_alerts 技能：add/list/remove/enable/disable 与各类非法入参
 * 外部数据（getQuote/search）全 mock，不打网络。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  validateConditions,
  conditionTriggered,
  evaluateRule,
  describeCondition,
  describeRule,
  MAX_CONDITIONS_PER_RULE,
  type AlertRule,
} from '../src/alerts/rules.js';
import type { Quote, DataProvider } from '../src/data/provider.js';
import type { SkillContext } from '../src/skills/types.js';
import skill from '../src/skills/bundled/alerts/index.js';

// ---------- 纯函数 ----------

function quote(partial: Partial<Quote>): Quote {
  return { code: '600519', name: '贵州茅台', price: 1500, changePct: 1, prevClose: 1485, ...partial };
}

describe('validateConditions', () => {
  it('合法条件数组原样通过', () => {
    const r = validateConditions([
      { type: 'price_above', value: 1500 },
      { type: 'change_pct', value: 3 },
    ]);
    expect(r.error).toBeNull();
    expect(r.conditions).toHaveLength(2);
  });

  it('空数组 / 非数组 / 缺 type / 未知 type / 非正阈值均报错且带指引', () => {
    expect(validateConditions([]).error).toContain('至少一个触发条件');
    expect(validateConditions('x').error).toContain('至少一个触发条件');
    expect(validateConditions([{ value: 3 }]).error).toContain('不支持');
    expect(validateConditions([{ type: 'rsi_overbought', value: 80 }]).error).toContain('不支持');
    expect(validateConditions([{ type: 'price_above', value: 0 }]).error).toContain('大于 0');
    expect(validateConditions([{ type: 'price_above', value: 'abc' }]).error).toContain('大于 0');
  });

  it('超过单规则条件上限报错', () => {
    const tooMany = Array.from({ length: MAX_CONDITIONS_PER_RULE + 1 }, () => ({
      type: 'price_above',
      value: 1,
    }));
    expect(validateConditions(tooMany).error).toContain('最多');
  });
});

describe('conditionTriggered / evaluateRule', () => {
  it('price_above / price_below / change_pct 各自触发与边界', () => {
    expect(conditionTriggered({ type: 'price_above', value: 1500 }, quote({ price: 1500 }))).toBe(true);
    expect(conditionTriggered({ type: 'price_above', value: 1500 }, quote({ price: 1499 }))).toBe(false);
    expect(conditionTriggered({ type: 'price_below', value: 80 }, quote({ price: 80 }))).toBe(true);
    expect(conditionTriggered({ type: 'price_below', value: 80 }, quote({ price: 81 }))).toBe(false);
    expect(conditionTriggered({ type: 'change_pct', value: 5 }, quote({ changePct: -5.2 }))).toBe(true);
    expect(conditionTriggered({ type: 'change_pct', value: 5 }, quote({ changePct: 4.9 }))).toBe(false);
  });

  it('changePct 缺失（新股首日 NaN）时 change_pct 不触发', () => {
    expect(conditionTriggered({ type: 'change_pct', value: 1 }, quote({ changePct: NaN }))).toBe(false);
  });

  it('combinator=any：任一触发即返回触发下标；all：未全触发返回 null', () => {
    const conditions = [
      { type: 'price_above', value: 1500 },
      { type: 'change_pct', value: 5 },
    ] as const;
    const q = quote({ price: 1600, changePct: 1 }); // 只触发条件 0
    expect(evaluateRule({ combinator: 'any', conditions: [...conditions] }, q)).toEqual([0]);
    expect(evaluateRule({ combinator: 'all', conditions: [...conditions] }, q)).toBeNull();
    const q2 = quote({ price: 1600, changePct: 6 }); // 两个都触发
    expect(evaluateRule({ combinator: 'all', conditions: [...conditions] }, q2)).toEqual([0, 1]);
    expect(evaluateRule({ combinator: 'any', conditions: [...conditions] }, quote({ price: 1 }))).toBeNull();
  });
});

describe('describe*', () => {
  it('条件与规则文案', () => {
    expect(describeCondition({ type: 'price_above', value: 1500 })).toBe('价格涨到 ≥ 1500 元');
    expect(describeCondition({ type: 'change_pct', value: 3 })).toBe('涨跌幅绝对值 ≥ 3%');
    const rule: AlertRule = {
      id: 3,
      userId: 'u',
      code: '600519',
      combinator: 'all',
      conditions: [{ type: 'price_below', value: 1400 }],
      enabled: false,
    };
    expect(describeRule(rule, '贵州茅台')).toBe('#3 【已停用】贵州茅台（600519）（全部满足）：价格跌到 ≤ 1400 元');
  });
});

// ---------- Store alert_rules 表 ----------

let Store: (typeof import('../src/storage/store.js'))['Store'];
let dataDir: string;
const opened: InstanceType<typeof Store>[] = [];
function makeStore(): InstanceType<typeof Store> {
  const s = new Store();
  opened.push(s);
  return s;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'cnstockbot-alerts-test-'));
  // config 在模块加载时读取环境变量，必须先设 DATA_DIR 再动态 import
  process.env.DATA_DIR = dataDir;
  ({ Store } = await import('../src/storage/store.js'));
});

afterAll(() => {
  for (const s of opened) s.close();
  delete process.env.DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Store 监控规则', () => {
  it('新增 / 查询 / 启停 / 删除往返，字段完整还原', () => {
    const s = makeStore();
    const id = s.addAlertRule('crud', '600519', 'all', [
      { type: 'price_above', value: 1500 },
      { type: 'change_pct', value: 3 },
    ]);
    expect(id).toBeGreaterThan(0);
    const [r] = s.getAlertRules('crud');
    expect(r).toMatchObject({
      id,
      userId: 'crud',
      code: '600519',
      combinator: 'all',
      enabled: true,
      conditions: [
        { type: 'price_above', value: 1500 },
        { type: 'change_pct', value: 3 },
      ],
    });
    expect(s.countAlertRules('crud')).toBe(1);

    expect(s.setAlertRuleEnabled('crud', id, false)).toBe(true);
    expect(s.getEnabledAlertRules().filter((x) => x.userId === 'crud')).toEqual([]);
    expect(s.setAlertRuleEnabled('crud', id, true)).toBe(true);
    expect(s.getEnabledAlertRules().map((x) => x.id)).toContain(id);

    expect(s.removeAlertRule('crud', id)).toBe(true);
    expect(s.getAlertRules('crud')).toEqual([]);
  });

  it('按 userId 隔离：删/停别人的规则返回 false', () => {
    const s = makeStore();
    const id = s.addAlertRule('alice', '300750', 'any', [{ type: 'price_below', value: 280 }]);
    expect(s.removeAlertRule('bob', id)).toBe(false);
    expect(s.setAlertRuleEnabled('bob', id, false)).toBe(false);
    expect(s.getAlertRules('bob')).toEqual([]);
    // alice 的规则仍在且启用
    expect(s.getEnabledAlertRules().filter((r) => r.userId === 'alice')).toHaveLength(1);
  });

  it('非法 combinator / 损坏 JSON 行读取时跳过而非抛错', () => {
    const s = makeStore();
    const id = s.addAlertRule('dirty', '000001', 'any', [{ type: 'price_above', value: 10 }]);
    // 模拟历史/外部写入的脏数据
    (s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db
      .prepare('UPDATE alert_rules SET combinator = ?, conditions = ? WHERE id = ?')
      .run('xor', 'not-json', id);
    expect(s.getAlertRules('dirty')).toEqual([]); // 损坏行跳过
    expect(s.getEnabledAlertRules().filter((r) => r.userId === 'dirty')).toEqual([]);
  });
});

// ---------- manage_alerts 技能 ----------

function makeCtx(store: InstanceType<typeof Store>, userId: string): SkillContext {
  const data = {
    name: 'mock',
    getQuote: async (code: string) => quote({ code, name: `股票${code}` }),
    search: async () => [],
  } as unknown as DataProvider;
  return { userId, store, data };
}

describe('manage_alerts 技能', () => {
  it('add：校验代码 + 条件，入库并返回确认文案', async () => {
    const s = makeStore();
    const out = await skill.execute(
      {
        action: 'add',
        code: '600519',
        conditions: [
          { type: 'price_above', value: 1500 },
          { type: 'change_pct', value: 3 },
        ],
      },
      makeCtx(s, 'sk-add'),
    );
    expect(out).toMatch(/已创建监控规则 #\d+/);
    expect(out).toContain('股票600519（600519）');
    expect(out).toContain('任一条件满足');
    expect(out).toContain('价格涨到 ≥ 1500 元');
    expect(s.getAlertRules('sk-add')).toHaveLength(1);
  });

  it('add：combinator=all 与停牌股搜索降级验证', async () => {
    const s = makeStore();
    const ctx = makeCtx(s, 'sk-all');
    // 行情抛错（停牌），走 search 降级验证
    (ctx.data as { getQuote: unknown }).getQuote = async () => {
      throw new Error('停牌');
    };
    (ctx.data as { search: unknown }).search = async () => [{ code: '000001', name: '平安银行' }];
    const out = await skill.execute(
      { action: 'add', code: '000001', combinator: 'all', conditions: [{ type: 'price_below', value: 9 }] },
      ctx,
    );
    expect(out).toContain('全部满足');
    expect(s.getAlertRules('sk-all')[0]).toMatchObject({ combinator: 'all', code: '000001' });
  });

  it('add：非法代码 / 空条件 / 未知股票均拒绝且不入库', async () => {
    const s = makeStore();
    const ctx = makeCtx(s, 'sk-bad');
    expect(await skill.execute({ action: 'add', code: 'abc' }, ctx)).toContain('6 位');
    expect(await skill.execute({ action: 'add', code: '600519', conditions: [] }, ctx)).toContain(
      '至少一个触发条件',
    );
    (ctx.data as { getQuote: unknown }).getQuote = async () => {
      throw new Error('无此股');
    }; // search 默认返回 [] → 验证失败
    expect(
      await skill.execute({ action: 'add', code: '999999', conditions: [{ type: 'price_above', value: 1 }] }, ctx),
    ).toContain('未找到');
    expect(s.getAlertRules('sk-bad')).toEqual([]);
  });

  it('list：空列表与带规则列表（带行情名称与去重说明）', async () => {
    const s = makeStore();
    const ctx = makeCtx(s, 'sk-list');
    expect(await skill.execute({ action: 'list' }, ctx)).toContain('还没有设置');
    s.addAlertRule('sk-list', '600519', 'any', [{ type: 'price_above', value: 1500 }]);
    const out = await skill.execute({ action: 'list' }, ctx);
    expect(out).toMatch(/#\d+ 股票600519（600519）（任一满足）：价格涨到 ≥ 1500 元/);
    expect(out).toContain('同一条件每天只提醒一次');
  });

  it('remove / disable / enable：按编号操作，隔离他人规则', async () => {
    const s = makeStore();
    const ctx = makeCtx(s, 'sk-ops');
    const id = s.addAlertRule('sk-ops', '600519', 'any', [{ type: 'price_above', value: 1500 }]);
    expect(await skill.execute({ action: 'disable', ruleId: id }, ctx)).toContain('已停用');
    expect(s.getEnabledAlertRules().filter((r) => r.userId === 'sk-ops')).toEqual([]);
    expect(await skill.execute({ action: 'enable', ruleId: id }, ctx)).toContain('已恢复');
    // 他人视角操作同 id 失败
    expect(await skill.execute({ action: 'remove', ruleId: id }, makeCtx(s, 'bob'))).toContain('没有找到');
    expect(await skill.execute({ action: 'remove', ruleId: id }, ctx)).toContain('已删除');
    expect(await skill.execute({ action: 'remove', ruleId: 999 }, ctx)).toContain('没有找到');
    expect(await skill.execute({ action: 'remove' }, ctx)).toContain('规则编号');
  });

  it('未知 action 白名单拦截，不执行任何操作', async () => {
    const s = makeStore();
    const out = await skill.execute({ action: 'delete', ruleId: 1 }, makeCtx(s, 'sk-wl'));
    expect(out).toContain('未知操作');
    expect(out).toContain('不要擅自删除');
  });
});
