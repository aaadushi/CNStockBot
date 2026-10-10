import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 聊天页 Markdown 加粗渲染器契约（REQ-chat-md-bold，STATUS"其他候选方向"第 6 条方案②）：
 *
 * 真机验收发现 LLM 回复中的 `**加粗**` 以原始字符展示（前端防注入红线：
 * 一律 textContent 渲染）。修复 = 极简 `**...**` 解析渲染器：只允许加粗
 * 这一种语法，其余字符一律按字面文本节点插入，绝不用 innerHTML 拼接
 * 不可信文本。测试模式照 tests/webchat-bridge.test.ts：读内联 HTML，
 * 提取函数源码，用桩 document 做行为级断言。
 */

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'webchat', 'index.html'),
  'utf8',
);

const markerStart = html.indexOf('md-bold-renderer:start');
const markerEnd = html.indexOf('md-bold-renderer:end');
// 提取 renderMdBold + setMsgText 两个函数体（跳过注释行，避免截断 // 前缀）
const fnStart = html.indexOf('function renderMdBold');
const rendererBlock =
  markerStart >= 0 && markerEnd > markerStart && fnStart > markerStart
    ? html.slice(fnStart, html.indexOf('// <<<', fnStart))
    : '';

/** 桩 document：只实现渲染器用到的三个工厂，节点为可断言的普通对象。 */
function makeStubDocument() {
  return {
    createTextNode: (t: string) => ({ nodeType: 3, textContent: t }),
    createElement: (tag: string) => ({
      nodeType: 1,
      tagName: tag,
      textContent: '',
      children: [] as unknown[],
    }),
    createDocumentFragment: () => ({
      nodeType: 11,
      children: [] as unknown[],
      appendChild(c: unknown) {
        (this.children as unknown[]).push(c);
        return c;
      },
    }),
  };
}

type StubNode = {
  nodeType: number;
  textContent: string;
  tagName?: string;
  children?: StubNode[];
};

/** 把桩节点序列化为可比较的结构串：文本=#text:xxx，元素=<tag>xxx</tag> */
function serialize(node: StubNode): string {
  if (node.nodeType === 3) return '#text:' + node.textContent;
  const inner =
    node.children && node.children.length
      ? node.children.map(serialize).join('')
      : node.textContent
        ? '#text:' + node.textContent
        : '';
  return `<${node.tagName}>${inner}</${node.tagName}>`;
}

function render(text: string): string {
  const factory = new Function(
    'document',
    `${rendererBlock}; return renderMdBold;`,
  ) as (doc: unknown) => (t: string) => StubNode;
  const fn = factory(makeStubDocument());
  const frag = fn(text);
  // fragment（nodeType=11）序列化为其子节点的拼接
  if (frag.nodeType === 11) return (frag.children ?? []).map(serialize).join('');
  return serialize(frag);
}

describe('webchat Markdown 加粗渲染器（REQ-chat-md-bold）', () => {
  it('渲染器代码块存在于 webchat 内联脚本', () => {
    expect(rendererBlock.length).toBeGreaterThan(0);
  });

  it('渲染器实现不含 innerHTML / outerHTML / insertAdjacentHTML', () => {
    expect(rendererBlock).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it('addMsg 与回复填充均走 setMsgText（不再直接 textContent 赋原文）', () => {
    const inlineScripts = [
      ...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    const chatScript = inlineScripts.find((s) => s.includes('function addMsg')) ?? '';
    expect(chatScript).toContain('setMsgText(div, text)');
    expect(chatScript).toContain('setMsgText(pending, data.reply');
    expect(chatScript).not.toMatch(/textContent\s*=\s*(text|data\.reply)/);
  });

  it('成对加粗拆分为 strong + 文本节点', () => {
    expect(render('仅供参考，**不构成投资建议**')).toBe(
      '#text:仅供参考，<strong>#text:不构成投资建议</strong>',
    );
  });

  it('一行多段加粗均生效', () => {
    expect(render('a **b** c **d** e')).toBe(
      '#text:a <strong>#text:b</strong>#text: c <strong>#text:d</strong>#text: e',
    );
  });

  it('不成对的 ** 按字面文本保留', () => {
    expect(render('2 ** 3')).toBe('#text:2 ** 3');
    expect(render('**未闭合的加粗')).toBe('#text:**未闭合的加粗');
    expect(render('结尾开个头**')).toBe('#text:结尾开个头**');
  });

  it('空加粗段（****）按字面文本处理，不产生空 strong', () => {
    const out = render('x **** y');
    expect(out).toBe('#text:x #text:****#text: y');
    expect(out).not.toContain('<strong>');
  });

  it('XSS 尝试被转义为纯文本：img onerror 只产生一个文本节点', () => {
    const out = render('<img src=x onerror=alert(1)>');
    // 序列化结果若是单个 #text 节点，说明没有任何元素被创建（注入不可能发生）
    expect(out).toBe('#text:<img src=x onerror=alert(1)>');
  });

  it('加粗段内嵌标签同样只是纯文本（strong.textContent 赋值，不做 HTML 解析）', () => {
    const out = render('**<script>alert(1)</script>**');
    expect(out).toBe('<strong>#text:<script>alert(1)</script></strong>');
  });

  it('null / undefined / 非字符串输入健壮（String 收口，返回空 fragment）', () => {
    expect(render(null as unknown as string)).toBe('');
    expect(render(undefined as unknown as string)).toBe('');
    expect(render('')).toBe('');
  });
});
