/**
 * 腾讯行情接口数据源（qt.gtimg.cn，免 key），作为东财的**自动降级备份**。
 * 背景：东财 push2 会对高频请求做 IP 级断连限流（PITFALLS.md 东财条目），
 * 限流期间腾讯接口不受影响，可托底行情/指数查询。
 *
 * 响应格式（GBK 编码纯文本，~ 分隔）：
 *   v_sh600519="1~名称~代码~最新价~昨收~今开~成交量~...~时间yyyyMMddHHmmss~涨跌额~涨跌幅%~..."
 *   索引：1=name 2=code 3=price 4=prevClose 30=time 32=changePct
 * 代码前缀规则：沪市 6/9 → sh，深市 0/3 → sz，北交所 4/8/920 → bj。
 */
import type { DataProvider, NewsItem, Quote } from './provider.js';

const QT = 'https://qt.gtimg.cn/q=';
const FETCH_TIMEOUT_MS = 10_000;

/** 6 位代码 → 腾讯前缀代码（sh600519 / sz000001 / bj920002）。920 必须先于 9 判断（北交所新段） */
export function toTencentCode(code: string): string {
  const c = code.trim();
  if (!/^\d{6}$/.test(c)) throw new Error(`无效的股票代码: ${code}（应为 6 位数字）`);
  if (/^(4|8|920)/.test(c)) return `bj${c}`; // 北交所
  if (/^(6|9)/.test(c)) return `sh${c}`;
  return `sz${c}`; // 0/3
}

/** 东财 secid（1.000001 / 0.399006）→ 腾讯指数代码（sh000001 / sz399006） */
function secidToTencent(secid: string): string {
  const [mkt, code] = secid.split('.');
  return `${mkt === '1' ? 'sh' : 'sz'}${code}`;
}

export class TencentProvider implements DataProvider {
  readonly name = 'tencent';

  private async fetchQuote(symbol: string, label: string): Promise<Quote> {
    const res = await fetch(`${QT}${symbol}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`腾讯行情接口请求失败: HTTP ${res.status}`);
    // 响应是 GBK 编码，必须用 TextDecoder 转码，直接 text() 会乱码
    const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
    const m = /="(.*)"/.exec(text);
    const f = m?.[1]?.split('~') ?? [];
    const price = Number(f[3]);
    if (!m || f.length < 33 || !Number.isFinite(price) || price <= 0) {
      throw new Error(`未找到 ${label} 的行情（代码错误或已退市/停牌）`);
    }
    // 时间格式 20260914161450 → 可读字符串
    const rawTime = String(f[30] ?? '');
    const time = /^\d{14}$/.test(rawTime)
      ? `${rawTime.slice(0, 4)}-${rawTime.slice(4, 6)}-${rawTime.slice(6, 8)} ${rawTime.slice(8, 10)}:${rawTime.slice(10, 12)}:${rawTime.slice(12, 14)}`
      : undefined;
    const prevClose = Number(f[4]);
    const changePct = Number(f[32]);
    return {
      code: String(f[2] ?? label),
      name: String(f[1] ?? label),
      price,
      // 与东财口径一致：缺失置 NaN 由展示层显示 —（A-310）
      changePct: Number.isFinite(changePct) ? changePct : NaN,
      prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : NaN,
      time,
    };
  }

  async getQuote(code: string): Promise<Quote> {
    return this.fetchQuote(toTencentCode(code), code);
  }

  async getIndexQuote(secid: string): Promise<Quote> {
    if (!/^[01]\.\d{6}$/.test(secid)) throw new Error(`无效的指数 secid: ${secid}（应形如 1.000001）`);
    return this.fetchQuote(secidToTencent(secid), `指数 ${secid}`);
  }

  async getNews(_code: string, _limit = 10): Promise<NewsItem[]> {
    throw new Error('tencent 数据源不支持新闻（请启动 data-service）');
  }
}
