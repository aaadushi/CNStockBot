import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * App 壳桥接契约（REQ-F7-3 F1~F4 / F16）：
 *
 * /api/inbox 是 drain 语义（读后即删），webchat 页是唯一轮询者；安卓壳的
 * 本地通知依赖本页把 drain 到的消息经 window.CNStockAndroid 桥转交原生层。
 * 后续重构若把桥接改丢，App 通知会静默失效——本用例守护该契约。
 *
 * 同时守护：桥接调用必须有存在性判断与 try/catch 兜底，桥异常不得影响
 * 聊天渲染（2026-09-27 批次 25 生产事故的同类教训：前端一个抛错可以
 * 杀死整页脚本）。
 */

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'webchat', 'index.html'),
  'utf8',
);

// 定位收件箱轮询代码块（/api/inbox 调用到 setInterval 结束）
const pollStart = html.indexOf("/api/inbox");
const pollEnd = html.indexOf('}, 30000)', pollStart);
const pollBlock = pollStart >= 0 && pollEnd > pollStart ? html.slice(pollStart, pollEnd) : '';

describe('webchat App 壳桥接契约（REQ-F7-3）', () => {
  it('收件箱轮询代码块存在', () => {
    expect(pollBlock.length).toBeGreaterThan(0);
  });

  it('drain 到消息后调用 CNStockAndroid.onInboxMessages', () => {
    expect(pollBlock).toContain('window.CNStockAndroid');
    expect(pollBlock).toContain('onInboxMessages');
  });

  it('桥接调用有存在性判断（浏览器无桥对象）', () => {
    expect(pollBlock).toMatch(/window\.CNStockAndroid\s*\)/);
  });

  it('桥接调用有 try/catch 兜底，不阻塞聊天渲染', () => {
    expect(pollBlock).toMatch(/try\s*\{\s*window\.CNStockAndroid\.onInboxMessages/);
  });

  it('桥接在 addMsg 渲染之后调用（先保证消息进聊天窗）', () => {
    expect(pollBlock.indexOf('addMsg')).toBeLessThan(
      pollBlock.indexOf('window.CNStockAndroid'),
    );
  });
});
