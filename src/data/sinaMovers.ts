/**
 * 新浪财经行情中心排行接口（vip.stock.finance.sina.com.cn，免 key）——
 * 东财涨跌榜（push2/push2delay）双宿主全挂时的第三降级源（REQ-P11，解决 STATUS P11）。
 *
 * 接口：`Market_Center.getHQNodeData?node=hs_a&sort=changepercent&asc=0|1&page=&num=`
 *   asc=0 涨跌幅降序（涨幅榜）、asc=1 升序（跌幅榜）；单页上限 100 行（num>100 实测截断）。
 *   沪深京全市场（含北交所 bj 段），停牌股 trade="0.000" 与零区混排（同东财零区行为）。
 *   另用 `Market_Center.getHQNodeStockCount?node=hs_a` 取全市场总数。
 * 行字段（与东财 clist 不同，**不放大 100 倍**）：
 *   code 6 位数字代码（symbol 带 sh/sz/bj 前缀，弃用） name 名称
 *   trade 最新价（**字符串**） changepercent 涨跌幅浮点 % pricechange 涨跌额
 *
 * 已知口径差（降级模式可接受，见需求文档）：
 * - 新浪无现成涨跌平家数接口：按 changepercent 有序性二分边界求得
 *   （upCount=首个 pct<=0 下标；downCount=total−首个 pct<0 下标；flatCount=差值）。
 *   排序保证 >0/=0/<0 分段，边界处按页首符号二分 + 边界页内线性确认，精确无并列歧义。
 * - 停牌股（trade<=0）changepercent 为 0，会计入 flatCount（东财 ulist 不含停牌），
 *   榜单内已过滤（不进 up/down/flat 任何榜单），家数口径差不另外对齐。
 */
import type { MarketMovers, MoverItem } from './provider.js';

const API = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center';
const FETCH_TIMEOUT_MS = 10_000;
/** 单页行数：新浪实测 num>100 截断为 100，固定 100 便于二分 */
const PZ = 100;
/** 平盘扫描页数上限（与东财平盘定位同策略：凑满 limit 或扫满即停） */
const FLAT_SCAN_MAX_PAGES = 3;

interface SinaRow {
  code?: string;
  name?: string;
  trade?: string;
  changepercent?: number | string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`新浪排行接口请求失败: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** 原始行 → 榜单条目；停牌行（trade<=0）/ 缺字段行返回 null 由调用方过滤 */
function toMover(d: SinaRow): MoverItem | null {
  const price = Number(d.trade);
  const changePct = Number(d.changepercent);
  if (!d.code || !Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(changePct)) return null;
  return { code: d.code, name: d.name ?? d.code, price, changePct };
}

/** 拉一页排行（asc=0 降序 / asc=1 升序），返回原始行（可能为空页） */
async function fetchPage(asc: 0 | 1, page: number): Promise<SinaRow[]> {
  const url =
    `${API}.getHQNodeData?page=${page}&num=${PZ}&sort=changepercent&asc=${asc}` +
    `&node=hs_a&symbol=&_s_r_a=page`;
  const json = await fetchJson<SinaRow[]>(url);
  if (!Array.isArray(json)) throw new Error('新浪排行接口返回结构异常（非数组）');
  return json;
}

/**
 * 在 asc=0（降序）全序列上定位第一个满足 pred 的元素下标（全局序号）。
 * pred 必须单调：有序序列中不满足段在前、满足段在后。
 * 策略：按"页末元素是否满足 pred"二分定位边界页（页内有序 ⇒ 页末满足则边界必在本页或更早，
 * 页末不满足则整页都在不满足段），再页内线性确认。
 * 排序保证 >0/=0/<0 分段（平盘恰为 0，与正/负是不同值），边界计数精确无并列歧义。
 * 返回 [0, total]（全部不满足返回 total，首个即满足返回 0）。
 */
async function binaryBoundary(total: number, pred: (row: SinaRow) => boolean): Promise<number> {
  const pages = Math.max(1, Math.ceil(total / PZ));
  let pageLo = 1;
  let pageHi = pages;
  while (pageLo < pageHi) {
    const mid = (pageLo + pageHi) >> 1;
    const rows = await fetchPage(0, mid);
    const last = rows[rows.length - 1];
    if (last !== undefined && pred(last)) pageHi = mid; // 页末已满足：边界在本页或更早
    else pageLo = mid + 1;                               // 页末不满足：整页在不满足段，边界更晚
  }
  const rows = await fetchPage(0, pageLo);
  const base = (pageLo - 1) * PZ;
  for (let i = 0; i < rows.length; i++) {
    if (pred(rows[i])) return base + i;
  }
  return Math.min(total, base + rows.length);
}

/** 全市场今日涨跌榜（新浪降级源）。limit = 每榜显示条数 */
export async function fetchSinaMovers(limit: number): Promise<MarketMovers> {
  const total = Number(await fetchJson<string | number>(`${API}.getHQNodeStockCount?node=hs_a`));
  if (!Number.isFinite(total) || total <= 0) throw new Error('新浪排行全市场总数异常');

  // 涨幅/跌幅首页 + 家数二分边界并行（二分只依赖 total，相互独立）
  const [upRows, downRows, upBoundary, downBoundary] = await Promise.all([
    fetchPage(0, 1),
    fetchPage(1, 1),
    binaryBoundary(total, (r) => Number(r.changepercent) <= 0),
    binaryBoundary(total, (r) => Number(r.changepercent) < 0),
  ]);

  const up = upRows
    .map(toMover)
    .filter((m): m is MoverItem => m !== null)
    .slice(0, limit);
  const down = downRows
    .map(toMover)
    .filter((m): m is MoverItem => m !== null && m.changePct < 0)
    .slice(0, limit);

  // 平盘榜：从上涨边界（首个 pct<=0）所在页起向后扫描，
  // 收集 changepercent 恰为 0 的条目，进下跌段即停；凑满 limit 或扫满 FLAT_SCAN_MAX_PAGES 即止
  const flat: MoverItem[] = [];
  if (downBoundary > upBoundary) {
    const startPage = Math.floor(upBoundary / PZ) + 1;
    for (let pn = startPage; pn < startPage + FLAT_SCAN_MAX_PAGES && flat.length < limit; pn++) {
      const rows = await fetchPage(0, pn);
      if (rows.length === 0) break;
      for (const d of rows) {
        if (Number(d.changepercent) < 0) break; // 已进下跌段，零区翻完
        const m = toMover(d);
        if (m && m.changePct === 0 && flat.length < limit) flat.push(m);
      }
    }
  }

  return {
    up,
    down,
    flat,
    upCount: upBoundary,
    downCount: total - downBoundary,
    flatCount: downBoundary - upBoundary,
    time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    source: 'sina',
  };
}
