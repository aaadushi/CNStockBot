/* CNStockBot WebView 兼容层（F7-2 真机验收发现，2026-10-10）
 *
 * 背景：国产 ROM（无 Google Play）的 WebView 常冻结在出厂版本——验收机
 * Vivo V1838A（Android 10）WebView 为 Chrome 83（2020），而各数据页
 * （market/stocks/funds/sectors/news/overseas/scanner/backtest）大量使用
 * Element.replaceChildren（Chrome 86+ 才有），脚本在首个渲染调用处抛
 * TypeError 后整页无数据；/webchat 未使用该 API 所以聊天一直正常。
 *
 * 本文件必须在各页面业务脚本之前加载（script 标签置于 /shared/auth.js 之前），
 * 只补页面实际用到且旧内核缺失的 API。已核对 Chrome 83 支持的：optional
 * chaining/nullish（80）、fetch（42）、URLSearchParams（49）、Promise.allSettled
 * （76）、String.matchAll（73）、Object.fromEntries（73）——当前均无需补。
 */
(function () {
  'use strict';

  // Element.replaceChildren（Chrome 86+）：参数可为 Node 或字符串，
  // 字符串按规范转为 Text 节点；append 多参即此语义（Chrome 54+）。
  if (typeof Element.prototype.replaceChildren !== 'function') {
    Element.prototype.replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      this.append.apply(this, arguments);
    };
  }
})();
