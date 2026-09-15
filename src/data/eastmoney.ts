/**
 * 东方财富公开 HTTP 接口数据源（免 key，实时行情）。
 * 注意：这是东财网页端使用的非官方接口，字段与可用性可能随时变化。
 * 已知字段（push2 报价接口，价格类字段默认放大 100 倍）：
 *   f43 最新价  f44 最高  f45 最低  f46 今开  f57 代码  f58 名称
 *   f60 昨收    f169 涨跌额  f170 涨跌幅  f86 时间戳
 *   估值与规模（F3-1，2026-09-15 经 push2delay 实测核对）：
 *   f162 市盈率(动) f163 市盈率(静) f164 市盈率(TTM) f167 市净率 —— 均放大 100 倍
 *   f116 总市值 f117 流通市值 —— 单位元，**不放大**（大数值，不能用 ÷100 的价格解析）
 *   成交活跃度（F3-3，2026-09-15 经 push2delay 与腾讯接口交叉实测核对）：
 *   f47 成交量（手）f48 成交额（元）—— 均**不放大**；f168 换手率(%) f50 量比 —— 均放大 100 倍
 * 另注意：短时间内高频请求 push2 会触发东财 IP 级断连限流（PITFALLS.md 东财条目）。
 * 限流期间可用 push2delay.eastmoney.com 同构接口临时验证字段（延时行情，勿作数据源切换）。
 */
import type { DataProvider, MarketMovers, MoverItem, NewsItem, Quote } from './provider.js';

const PUSH2 = 'https://push2.eastmoney.com/api/qt/stock/get';
const FIELDS = 'f43,f44,f45,f46,f47,f48,f50,f57,f58,f60,f170,f86,f116,f117,f162,f163,f164,f167,f168';
/** 东财接口显式超时：防对端半挂拖住对话/调度链（审计 A-301） */
const FETCH_TIMEOUT_MS = 10_000;

/** 涨跌榜（clist 排行榜）宿主降级链：push2 被 IP 限流时用 push2delay 同构接口托底
 *  （延时约 15 分钟，字段结构一致；腾讯无对应榜单接口，见 PITFALLS 东财条目） */
const PUSH2_HOSTS = ['https://push2.eastmoney.com', 'https://push2delay.eastmoney.com'];
/** 全市场 A 股范围：深主板/创业板/沪主板/科创板/北交所 */
const CLIST_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
/** 涨跌榜进程内缓存：榜单页用户会反复刷新/切 Tab，防高频请求触发东财限流 */
const MOVERS_CACHE_MS = 60_000;

/**
 * A 股代码 → 东财 secid：
 *   沪市 6/900 开头（900 为沪 B） → 1. 前缀
 *   深市 0/3、北交所 4/8/920 开头   → 0. 前缀
 * 注意 920 是北交所 2024 年启用的新代码段，不能按"9 开头=沪市"处理（审计 A-303）。
 */
export function toSecid(code: string): string {
  const c = code.trim();
  if (!/^\d{6}$/.test(c)) throw new Error(`无效的股票代码: ${code}（应为 6 位数字）`);
  if (/^(4|8|920)/.test(c)) return `0.${c}`; // 北交所
  return c.startsWith('6') || c.startsWith('9') ? `1.${c}` : `0.${c}`;
}

interface EastmoneyQuotePayload {
  data?: {
    f43?: number | '-';
    f44?: number | '-';
    f45?: number | '-';
    f46?: number | '-';
    f47?: number | '-';
    f48?: number | '-';
    f50?: number | '-';
    f57?: string;
    f58?: string;
    f60?: number | '-';
    f170?: number | '-';
    f86?: number;
    f116?: number | '-';
    f117?: number | '-';
    f162?: number | '-';
    f163?: number | '-';
    f164?: number | '-';
    f167?: number | '-';
    f168?: number | '-';
  } | null;
}

/** clist 排行榜响应（fltt=2 时 f2/f3 为不缩放的浮点数；停牌股 f2/f3 为 "-"） */
interface EastmoneyClistRow {
  f2?: number | '-';
  f3?: number | '-';
  f12?: string;
  f14?: string;
}
interface EastmoneyClistPayload {
  data?: { total?: number; diff?: EastmoneyClistRow[] } | null;
}

/** ulist 涨跌家数统计响应：f104 上涨 / f105 下跌 / f106 平盘 */
interface EastmoneyUlistPayload {
  data?: { diff?: { f104?: number; f105?: number; f106?: number }[] } | null;
}

export class EastmoneyProvider implements DataProvider {
  readonly name = 'eastmoney';

  private async fetchQuote(secid: string, label: string): Promise<Quote> {
    const url = `${PUSH2}?secid=${secid}&fields=${FIELDS}`;
    const res = await fetch(url, {
      headers: { Referer: 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`东财行情接口请求失败: HTTP ${res.status}`);
    const json = (await res.json()) as EastmoneyQuotePayload;
    const d = json.data;
    if (!d || d.f43 === undefined || d.f43 === '-') {
      throw new Error(`未找到 ${label} 的行情（代码错误或已退市/停牌）`);
    }
    // 昨收/涨跌幅可能缺失（如新股上市首日无昨收）：不静默取 0，缺涨跌幅但有昨收时自行换算，
    // 实在算不出则置 NaN，由展示层显示"—"（审计 A-310：静默 0 会产生看似正常的错误数据）
    const prevClose = d.f60 === '-' || d.f60 === undefined ? NaN : Number(d.f60) / 100;
    let changePct = d.f170 === '-' || d.f170 === undefined ? NaN : Number(d.f170) / 100;
    if (!Number.isFinite(changePct) && Number.isFinite(prevClose) && prevClose > 0) {
      changePct = ((Number(d.f43) / 100 - prevClose) / prevClose) * 100;
    }
    // 开盘/最高/最低同样放大 100 倍且可能为 "-"（停牌），缺失时置 undefined（可选字段）
    const priceField = (v: number | '-' | undefined) =>
      v === '-' || v === undefined ? undefined : Number(v) / 100;
    // 估值字段：PE/PB 放大 100 倍；市值单位元不放大。缺失/"-" 置 undefined（亏损股 PE 东财返回 "-"）
    const capField = (v: number | '-' | undefined) =>
      v === '-' || v === undefined ? undefined : Number(v);
    return {
      code: d.f57 ?? label,
      name: d.f58 ?? label,
      price: Number(d.f43) / 100,
      changePct,
      prevClose,
      open: priceField(d.f46),
      high: priceField(d.f44),
      low: priceField(d.f45),
      peTtm: priceField(d.f164),
      peDynamic: priceField(d.f162),
      peStatic: priceField(d.f163),
      pb: priceField(d.f167),
      totalMarketCap: capField(d.f116),
      floatMarketCap: capField(d.f117),
      // 成交活跃度（F3-3）：f47 手/f48 元不缩放，f168 换手率/f50 量比放大 100 倍
      volume: capField(d.f47),
      amount: capField(d.f48),
      turnover: priceField(d.f168),
      volumeRatio: priceField(d.f50),
      time: d.f86 ? new Date(Number(d.f86) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : undefined,
    };
  }

  async getQuote(code: string): Promise<Quote> {
    return this.fetchQuote(toSecid(code), code);
  }

  /** 指数行情。secid 必须显式给出（如 1.000001 上证指数 / 0.399006 创业板指），
   *  不能复用个股 toSecid 规则——000001 个股=平安银行(0.000001)、指数=上证(1.000001)。 */
  async getIndexQuote(secid: string): Promise<Quote> {
    if (!/^[01]\.\d{6}$/.test(secid)) throw new Error(`无效的指数 secid: ${secid}（应形如 1.000001）`);
    // label 用友好文案：指数没有"退市/停牌"，裸 secid 用户也看不懂（审计 A-307）
    return this.fetchQuote(secid, `指数 ${secid}`);
  }

  // ---- 全市场涨跌榜（涨跌浏览页，2026-09-15 新增） ----

  private moversCache: { at: number; value: MarketMovers } | null = null;

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: { Referer: 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`东财接口请求失败: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** 单页排行榜原始行：po=1 按涨跌幅降序（涨幅榜），po=0 升序（跌幅榜）。
   *  注意 fltt=2：f2 最新价/f3 涨跌幅为**不缩放**的浮点数（与报价接口 ×100 不同）。
   *  停牌股 f2/f3 为 "-"，且在降序排序中与涨跌幅 0 的股票**混排在零区**（2026-09-15 实测）。 */
  private async fetchClistRaw(
    host: string,
    po: 0 | 1,
    pn: number,
    pz: number,
  ): Promise<{ total: number; rows: EastmoneyClistRow[] }> {
    const url =
      `${host}/api/qt/clist/get?pn=${pn}&pz=${pz}&po=${po}&np=1&fltt=2&invt=2` +
      `&fid=f3&fs=${CLIST_FS}&fields=f12,f14,f2,f3`;
    const json = await this.fetchJson<EastmoneyClistPayload>(url);
    return { total: json.data?.total ?? 0, rows: json.data?.diff ?? [] };
  }

  /** 原始行 → 榜单条目；停牌行（f2/f3 为 "-"）返回 null 由调用方过滤 */
  private static toMover(d: EastmoneyClistRow): MoverItem | null {
    if (typeof d.f2 !== 'number' || typeof d.f3 !== 'number' || !d.f12) return null;
    return { code: d.f12, name: d.f14 ?? d.f12, price: d.f2, changePct: d.f3 };
  }

  /** 沪深京涨跌平家数统计（1.000001=沪、0.399001=深、0.899050=北交所，f104/f105/f106 求和） */
  private async fetchMoverCounts(host: string): Promise<{ up: number; down: number; flat: number }> {
    const url = `${host}/api/qt/ulist.np/get?secids=1.000001,0.399001,0.899050&fields=f104,f105,f106`;
    const json = await this.fetchJson<EastmoneyUlistPayload>(url);
    const diff = json.data?.diff ?? [];
    if (diff.length === 0) throw new Error('东财涨跌家数统计返回为空');
    let up = 0, down = 0, flat = 0;
    for (const d of diff) {
      up += d.f104 ?? 0;
      down += d.f105 ?? 0;
      flat += d.f106 ?? 0;
    }
    return { up, down, flat };
  }

  /** 平盘二分/扫描用的大页长：页数少 → 请求数少（防触发东财限流） */
  private static readonly FLAT_SCAN_PZ = 200;

  private async fetchMovers(host: string, limit: number): Promise<MarketMovers> {
    const [counts, upPage, downPage] = await Promise.all([
      this.fetchMoverCounts(host),
      this.fetchClistRaw(host, 1, 1, limit),
      this.fetchClistRaw(host, 0, 1, limit),
    ]);
    const toList = (rows: EastmoneyClistRow[]) =>
      rows.map((d) => EastmoneyProvider.toMover(d)).filter((m): m is MoverItem => m !== null);
    const up = toList(upPage.rows);
    const down = toList(downPage.rows).filter((i) => i.changePct < 0);

    // 平盘定位：clist 不支持按值筛选，且停牌股（f3="-"）与平盘混排在零区、
    // ulist 家数统计不含停牌股，无法靠"上涨家数"精确算页码——改为二分查找
    // "末条不再为正"的第一页（零区起点），再向后扫描收集 f3 恰为 0 的条目
    const flat: MoverItem[] = [];
    if (counts.flat > 0 && upPage.total > 0) {
      const pz = EastmoneyProvider.FLAT_SCAN_PZ;
      let lo = 1;
      let hi = Math.max(1, Math.ceil(upPage.total / pz));
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const page = await this.fetchClistRaw(host, 1, mid, pz);
        const last = page.rows[page.rows.length - 1];
        const pastGain = !last || last.f3 === '-' || (typeof last.f3 === 'number' && last.f3 <= 0);
        if (pastGain) hi = mid; else lo = mid + 1;
      }
      // 从零区起点向后扫描：页内最后一个**数值**涨跌幅为负则零区已翻完（不能用 "-" 判断，
      // 停牌行与 0 混排）；flat 凑满 limit 或扫满 3 页即停
      for (let pn = lo; pn < lo + 3 && flat.length < limit; pn++) {
        const page = await this.fetchClistRaw(host, 1, pn, pz);
        if (page.rows.length === 0) break;
        for (const d of page.rows) {
          if (d.f3 === 0 && flat.length < limit) {
            const m = EastmoneyProvider.toMover(d);
            if (m) flat.push(m);
          }
        }
        const lastNumeric = [...page.rows].reverse().find((r) => typeof r.f3 === 'number');
        if (lastNumeric && (lastNumeric.f3 as number) < 0) break;
      }
    }
    return {
      up,
      down,
      flat,
      upCount: counts.up,
      downCount: counts.down,
      flatCount: counts.flat,
      time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    };
  }

  /** 全市场今日涨跌榜。宿主按 push2 → push2delay 降级（延时数据），结果缓存 60s */
  async getMovers(limit = 50): Promise<MarketMovers> {
    if (this.moversCache && Date.now() - this.moversCache.at < MOVERS_CACHE_MS) {
      return this.moversCache.value;
    }
    let lastErr: unknown;
    for (const host of PUSH2_HOSTS) {
      try {
        const value = await this.fetchMovers(host, limit);
        if (host.includes('delay')) value.delayed = true; // 延时宿主，展示层提示
        this.moversCache = { at: Date.now(), value };
        return value;
      } catch (err) {
        lastErr = err;
        console.warn(`[data] 东财涨跌榜 ${host} 失败，尝试下一宿主:`, err instanceof Error ? err.message : err);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async getNews(_code: string, _limit = 10): Promise<NewsItem[]> {
    // 东财新闻接口较繁琐，新闻聚合统一走 Python 微服务（AKShare）。
    // 默认组合数据源下本方法不会被调达（Composite 拦截），仅纯东财模式兜底。
    throw new Error('eastmoney 数据源不支持新闻；请启动 data-service（默认组合数据源即可用新闻，无需改 DATA_PROVIDER）');
  }

  /** 名称/代码 → 候选列表。走东财搜索建议接口（免 key），作为 Python 微服务的降级方案。 */
  async search(keyword: string): Promise<{ code: string; name: string }[]> {
    const url =
      `https://searchapi.eastmoney.com/api/suggest/get` +
      `?input=${encodeURIComponent(keyword)}&type=14&count=10`;
    const res = await fetch(url, {
      headers: { Referer: 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`东财搜索接口请求失败: HTTP ${res.status}`);
    const json = (await res.json()) as {
      QuotationCodeTable?: { Data?: { Code?: string; Name?: string }[] | null };
    };
    // type=14 覆盖全市场证券，这里只保留 A 股个股（0/3/6 沪深 + 4/8/920 北交所，与 toSecid 口径一致，
    // 审计 A-304），过滤掉基金、债券、指数等（指数与个股代码规则不同，见 toSecid 注释）
    return (json.QuotationCodeTable?.Data ?? [])
      .filter((d) => d.Code && (/^[03648]\d{5}$/.test(d.Code) || /^920\d{3}$/.test(d.Code)))
      .map((d) => ({ code: d.Code as string, name: d.Name ?? (d.Code as string) }));
  }
}
