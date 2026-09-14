/**
 * trimHistory 单测：会话历史保留工具调用上下文（P3）的裁剪规则。
 * 覆盖：tool 结果超长截断、条数预算、孤儿 tool 消息丢弃、合法工具链保留。
 */
import { describe, expect, it } from 'vitest';
import { trimHistory } from '../src/agent/loop.js';
import type { ChatMessage } from '../src/llm/client.js';

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });
const assistantWithCalls = (id: string): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'get_stock_quote', arguments: '{}' } }],
});
const tool = (id: string, content: string): ChatMessage => ({
  role: 'tool',
  tool_call_id: id,
  content,
});

describe('trimHistory', () => {
  it('短历史原样保留（含工具链）', () => {
    const msgs = [user('茅台咋样'), assistantWithCalls('c1'), tool('c1', '行情数据'), assistant('涨了')];
    expect(trimHistory(msgs)).toEqual(msgs);
  });

  it('超长的 tool 结果被截断，其他消息不受影响', () => {
    const long = 'x'.repeat(2000);
    const msgs = [user('查新闻'), assistantWithCalls('c1'), tool('c1', long), assistant('总结')];
    const out = trimHistory(msgs);
    const t = out.find((m) => m.role === 'tool');
    expect(t?.content?.length).toBeLessThan(1300);
    expect(t?.content).toContain('结果过长已截断');
    expect(out.filter((m) => m.role !== 'tool')).toEqual([msgs[0], msgs[1], msgs[3]]);
  });

  it('超过条数预算时从头部丢弃最旧消息', () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) msgs.push(user(`问${i}`), assistant(`答${i}`));
    const out = trimHistory(msgs);
    expect(out.length).toBe(40);
    expect(out[0]).toEqual(user('问10'));
  });

  it('裁剪后链首的孤儿 tool 消息被丢弃（其 assistant.tool_calls 已被切掉）', () => {
    const msgs: ChatMessage[] = [];
    // 前 19 轮纯问答（38 条），最后一轮带工具链（4 条），共 42 条，预算 40
    for (let i = 0; i < 19; i++) msgs.push(user(`问${i}`), assistant(`答${i}`));
    msgs.push(user('查茅台'), assistantWithCalls('c1'), tool('c1', '行情'), assistant('涨了'));
    const out = trimHistory(msgs);
    // 切掉头部 2 条后链首是 user('问1')，工具链完整保留在尾部
    expect(out[0].role).toBe('user');
    const toolIdx = out.findIndex((m) => m.role === 'tool');
    expect(out[toolIdx - 1]).toEqual(assistantWithCalls('c1'));
  });

  it('裁剪恰好落在工具链中间时，孤儿 tool 与其后的 assistant 正常衔接', () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 19; i++) msgs.push(user(`问${i}`), assistant(`答${i}`));
    // 38 条 + 5 条 = 43 条，预算 40 → 切 3 条，链首落在 tool('c1') 上
    msgs.push(user('查茅台'), assistantWithCalls('c1'), tool('c1', '行情'), tool('c2', '新闻'), assistant('涨了'));
    const out = trimHistory(msgs);
    expect(out.length).toBe(40);
    expect(out[0].role).not.toBe('tool'); // 孤儿 tool 被丢弃
    expect(out.every((m, i) => m.role !== 'tool' || out[i - 1]?.role === 'assistant' || out[i - 1]?.role === 'tool')).toBe(true);
  });
});
