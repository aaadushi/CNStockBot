import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 前端页面结构健全性：每个 public 子目录的 index.html 内联脚本里通过 $('id')
 * 引用的元素，必须在同文件 HTML 中以 id="..." 定义。
 *
 * 背景（2026-09-27 生产事故）：S4-1 迁移给 6 个页面加了
 * `const logoutBtn = $('logout-btn'); logoutBtn.onclick = ...`，
 * 但这些页面的 header 里没有 id="logout-btn" 元素——脚本启动即 TypeError，
 * 整页内联脚本死亡，页面表现为"永远加载中、没有任何 API 请求"。
 * node --check 只能查语法查不到这种运行时缺失。
 */

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const pages = readdirSync(PUBLIC_DIR)
  .map((d) => join(PUBLIC_DIR, d, 'index.html'))
  .filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });

describe('public 页面内联脚本引用的元素 id 必须存在', () => {
  expect(pages.length).toBeGreaterThanOrEqual(8);

  for (const page of pages) {
    it(page.replace(/\\/g, '/').replace(/.*public\//, 'public/'), () => {
      const html = readFileSync(page, 'utf8');
      const definedIds = new Set(
        [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
      );
      const inlineScripts = [
        ...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g),
      ].map((m) => m[1]);
      expect(inlineScripts.length).toBeGreaterThan(0);

      const referenced = new Set<string>();
      for (const script of inlineScripts) {
        for (const m of script.matchAll(/\$\('([^']+)'\)/g)) {
          referenced.add(m[1]);
        }
      }

      const missing = [...referenced].filter((id) => !definedIds.has(id));
      expect(missing).toEqual([]);
    });
  }
});
