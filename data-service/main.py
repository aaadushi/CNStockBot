"""
CNStockBot 数据微服务：基于 AKShare 的 A 股数据 HTTP 接口。
Node 主服务（src/data/pythonService.ts）通过 HTTP 调用本服务。

启动：
    pip install -r requirements.txt
    uvicorn main:app --host 127.0.0.1 --port 8000

为什么用 Python：A 股免费数据生态（AKShare/Tushare）几乎都在 Python 侧，
包一层 HTTP 比用 Node 逐个逆向东财/新浪接口更稳、更好维护。

安全约定：本服务无鉴权，**必须绑定回环地址**（--host 127.0.0.1）；
需要非回环绑定时应先加 token 校验（审计 A-508）。
"""
from fastapi import FastAPI, HTTPException, Query
from datetime import datetime, timedelta
import asyncio
import logging
import re
import akshare as ak
import pandas as pd
import requests

logger = logging.getLogger("cnstockbot-data")

app = FastAPI(title="CNStockBot Data Service", version="0.1.0")

# AKShare 底层用 requests 且默认无超时；上游挂起会占满 uvicorn 线程池导致全服务无响应。
# 统一在线程池里执行并加整体超时，超时返回 504 而非悬挂（审计 A-506）。
AKSHARE_TIMEOUT = 30  # 秒


async def run_ak(fn, *args, timeout: int = AKSHARE_TIMEOUT, **kwargs):
    """线程池执行 AKShare 同步调用（带超时）。上游异常原样抛出，由端点各自包装。"""
    try:
        return await asyncio.wait_for(asyncio.to_thread(fn, *args, **kwargs), timeout=timeout)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail=f"上游数据源超时（{timeout}s 无响应）")


def _num(v) -> float:
    """安全转 float：None/NaN/非法值 -> 0.0（防 AKShare 列值漂移）。"""
    try:
        if v is None or pd.isna(v):
            return 0.0
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _cell(row, col: str) -> str:
    """安全取单元格字符串：NaN -> ""；真值 0 保留为 "0"（审计 A-504）。"""
    v = row.get(col, None)
    if v is None or (not isinstance(v, str) and pd.isna(v)):
        return ""
    return str(v)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/quote/{code}")
async def quote(code: str):
    """个股实时行情快照。字段与 src/data/provider.ts 的 Quote 接口对齐。"""
    try:
        df = await run_ak(ak.stock_bid_ask_em, symbol=code)
        # 返回的是 key-value 两列，转成字典
        kv = dict(zip(df["item"], df["value"]))
        return {
            "code": code,
            "name": str(kv.get("名称", code)),
            "price": float(kv.get("最新", 0) or 0),
            "changePct": float(kv.get("涨跌幅", 0) or 0),
            "prevClose": float(kv.get("昨收", 0) or 0),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AKShare 行情获取失败: {e}")


@app.get("/news/{code}")
async def news(
    code: str,
    limit: int = Query(default=10, ge=1, le=50),
    sort: str = Query(default="hot", pattern="^(hot|time)$"),
):
    """个股新闻（东财数据源）。返回 NewsItem[]。

    sort=hot（默认）：东财原始相关度/热度序；sort=time：按发布时间倒序。
    时间序必须先全量构建、排序后再截 limit——先 head 再排会丢掉不在前 N 条里的
    更新新闻（2026-09-15 用户实测发现）。
    """
    try:
        df = await run_ak(ak.stock_news_em, symbol=code)
        items = []
        for _, row in df.iterrows():
            items.append({
                "title": str(row.get("新闻标题", "")),
                "summary": str(row.get("新闻内容", ""))[:120],
                "source": str(row.get("文章来源", "")),
                "url": str(row.get("新闻链接", "")),
                "publishedAt": str(row.get("发布时间", "")),
            })
        if sort == "time":
            # "YYYY-MM-DD HH:MM:SS" 格式可直接按字符串倒序；缺失时间的排最后
            items.sort(key=lambda it: it["publishedAt"], reverse=True)
        return items[:limit]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AKShare 新闻获取失败: {e}")


# --- 名称 -> 代码搜索 ---
# ak.stock_info_a_code_name() 拉全量 A 股代码表（约 5000 行），进程内缓存 24 小时，
# 避免每次搜索都请求一次数据源。
import time

_code_name_cache: dict = {"df": None, "ts": 0.0}
_CODE_NAME_TTL = 24 * 3600


def _load_code_name_table():
    now = time.time()
    if _code_name_cache["df"] is None or now - _code_name_cache["ts"] > _CODE_NAME_TTL:
        _code_name_cache["df"] = ak.stock_info_a_code_name()
        _code_name_cache["ts"] = now
    return _code_name_cache["df"]


@app.get("/search")
async def search(keyword: str = Query(min_length=1), limit: int = Query(default=10, ge=1, le=50)):
    """按名称/代码模糊搜索 A 股，返回 [{code, name}]，按匹配程度排序。"""
    kw = keyword.strip()
    try:
        df = await run_ak(_load_code_name_table)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AKShare 代码表获取失败: {e}")

    def score(code: str, name: str) -> int:
        if name == kw or code == kw:
            return 0  # 完全匹配
        if name.startswith(kw) or code.startswith(kw):
            return 1  # 前缀匹配
        if kw in name:
            return 2  # 包含匹配
        return -1

    matches = []
    for _, row in df.iterrows():
        code, name = str(row["code"]).zfill(6), str(row["name"])
        s = score(code, name)
        if s >= 0:
            matches.append((s, code, name))
    matches.sort(key=lambda m: (m[0], m[1]))
    return [{"code": c, "name": n} for _, c, n in matches[:limit]]


@app.get("/announcements/{code}")
async def announcements(
    code: str,
    limit: int = Query(default=10, ge=1, le=50),
    days: int = Query(default=30, le=365),
    category: str = Query(default=""),
):
    """个股公告。返回 Announcement[]。

    数据源降级链：巨潮资讯 stock_zh_a_disclosure_report_cninfo（交易所正式披露）
    → 东财 stock_individual_notice_report（2026-09-15 巨潮上游返回非 JSON 时托底）。
    category 仅巨潮源支持：年报/半年报/一季报/三季报/业绩预告/权益分派/董事会/
    股东大会/风险提示 等，空串为全部。
    """
    end = datetime.now().strftime("%Y%m%d")
    start = (datetime.now() - timedelta(days=days)).strftime("%Y%m%d")
    try:
        df = await run_ak(
            ak.stock_zh_a_disclosure_report_cninfo,
            symbol=code,
            market="沪深京",
            category=category,
            start_date=start,
            end_date=end,
        )
    except KeyError as e:
        # 巨潮接口在"查询结果为空"时部分 AKShare 版本会抛 KeyError，视作空结果。
        # 但 KeyError 也可能是列结构变化/代码无效，必须留日志可观测（审计 A-507）
        logger.warning("announcements KeyError（按空结果处理，若非空查询请排查列结构）: code=%s err=%s", code, e)
        return []
    except HTTPException as e:
        if e.status_code != 504:
            raise
        logger.warning("announcements 巨潮源超时，降级东财公告: code=%s", code)
        return await _announcements_em_fallback(code, limit, days)
    except Exception as e:
        # 巨潮上游非 JSON / 限流 / 接口变更：降级东财公告（2026-09-15 实测 JSONDecodeError）
        logger.warning("announcements 巨潮源失败，降级东财公告: code=%s err=%s", code, e)
        try:
            return await _announcements_em_fallback(code, limit, days)
        except HTTPException:
            raise
        except Exception as e2:
            raise HTTPException(
                status_code=502,
                detail=f"AKShare 公告获取失败（巨潮: {e}；东财降级: {e2}）",
            )
    items = []
    for _, row in df.head(limit).iterrows():
        items.append({
            "title": str(row.get("公告标题", "")),
            "publishedAt": str(row.get("公告时间", "")),
            "url": str(row.get("公告链接", "")),
        })
    return items


# --- 东财公告降级（巨潮源失败时托底） ---
# ak.stock_individual_notice_report 不支持日期参数，会**全量翻页**拉取该股全部历史公告
# （约 1 页/秒，大盘股可超 30s），所以：超时放宽到 180s + 全量结果按代码缓存 6 小时，
# days/limit 过滤在缓存命中后本地完成。
_notice_cache: dict = {}  # code -> {"ts": float, "items": list}
_NOTICE_CACHE_TTL = 6 * 3600
_NOTICE_TIMEOUT = 180


async def _announcements_em_fallback(code: str, limit: int, days: int):
    """东财个股公告（降级源）。返回与巨潮源同构的 Announcement[]（日期降序）。"""
    now = time.time()
    hit = _notice_cache.get(code)
    if hit is None or now - hit["ts"] > _NOTICE_CACHE_TTL:
        df = await run_ak(
            ak.stock_individual_notice_report, security=code, symbol="全部", timeout=_NOTICE_TIMEOUT
        )
        items = []
        if df is not None and not df.empty:
            for _, row in df.iterrows():
                items.append({
                    "title": str(row.get("公告标题", "")),
                    "publishedAt": str(row.get("公告日期", "")),
                    "url": str(row.get("网址", "")),
                })
        hit = {"ts": now, "items": items}
        _notice_cache[code] = hit
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    return [it for it in hit["items"] if it["publishedAt"][:10] >= cutoff][:limit]


# --- 全市场财经快讯 ---
# 双源降级链（2026-09-15 实测 akshare 1.18.94 两者均可用）：
# 主源东财 stock_info_global_em（约 200 条，列：标题/摘要/发布时间/链接，含 URL）；
# 降级财联社 stock_info_global_cls（约 20 条，列：标题/内容/发布日期/发布时间，无 URL，
# 短快讯"标题"列常为空串，此时取"内容"前段作标题）。
# 结果进程内缓存 90s，防页面自动刷新打爆上游。
_market_news_cache: dict = {"ts": 0.0, "items": []}
_MARKET_NEWS_TTL = 90


def _market_news_from_em(df) -> list:
    items = []
    for _, row in df.iterrows():
        items.append({
            "title": _cell(row, "标题"),
            "summary": _cell(row, "摘要"),
            "publishTime": _cell(row, "发布时间"),
            "url": _cell(row, "链接"),
            "source": "东方财富",
        })
    return [it for it in items if it["title"]]


def _market_news_from_cls(df) -> list:
    items = []
    for _, row in df.iterrows():
        title = _cell(row, "标题")
        content = _cell(row, "内容")
        if not title and content:
            # 财联社短快讯常无标题，取内容前 60 字充任（去掉开头的【】电头由前端/LLM 阅读）
            title = content[:60]
        items.append({
            "title": title,
            "summary": content,
            "publishTime": f"{_cell(row, '发布日期')} {_cell(row, '发布时间')}".strip(),
            "url": "",
            "source": "财联社",
        })
    return [it for it in items if it["title"]]


@app.get("/market-news")
async def market_news(limit: int = Query(default=20, ge=1, le=50)):
    """全市场财经快讯（区别于 /news/{code} 的个股新闻）。返回 MarketNewsItem[]。

    字段：{title, summary, url, publishTime, source}；publishTime 为 "YYYY-MM-DD HH:MM:SS"；
    财联社降级源无 url（空串）。结果按发布时间倒序、进程内缓存 90s。
    """
    now = time.time()
    if not _market_news_cache["items"] or now - _market_news_cache["ts"] > _MARKET_NEWS_TTL:
        try:
            df = await run_ak(ak.stock_info_global_em)
            items = _market_news_from_em(df)
        except Exception as e:
            # 含 HTTPException（超时 504）：主源失败尝试财联社降级
            logger.warning("market-news 东财源失败，降级财联社: err=%s", e)
            try:
                df = await run_ak(ak.stock_info_global_cls)
                items = _market_news_from_cls(df)
            except HTTPException:
                raise
            except Exception as e2:
                raise HTTPException(
                    status_code=502,
                    detail=f"AKShare 财经快讯获取失败（东财: {e}；财联社降级: {e2}）",
                )
        if not items:
            raise HTTPException(status_code=502, detail="AKShare 财经快讯返回为空")
        items.sort(key=lambda it: it["publishTime"], reverse=True)
        _market_news_cache["items"] = items
        _market_news_cache["ts"] = now
    return _market_news_cache["items"][:limit]


# --- 交易日历 ---
# ak.tool_trade_date_hist_sina() 返回全量历史交易日（trade_date 列，datetime.date），
# 进程内缓存 24 小时；主服务再按年缓存（年内数据不变）。
_trade_cal_cache: dict = {"df": None, "ts": 0.0}
_TRADE_CAL_TTL = 24 * 3600


def _load_trade_dates():
    now = time.time()
    if _trade_cal_cache["df"] is None or now - _trade_cal_cache["ts"] > _TRADE_CAL_TTL:
        _trade_cal_cache["df"] = ak.tool_trade_date_hist_sina()
        _trade_cal_cache["ts"] = now
    return _trade_cal_cache["df"]


@app.get("/trade-calendar")
async def trade_calendar(year: int = Query(default=0, ge=0)):
    """A 股交易日历（新浪财经）。返回指定年份的交易日列表 ["YYYY-MM-DD", ...]。
    year 为 0 时返回全部历史。法定节假日等休市日不在列表中。"""
    try:
        df = await run_ak(_load_trade_dates)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AKShare 交易日历获取失败: {e}")
    # 与列类型解耦：AKShare 若改返回 Timestamp，str() 会带 " 00:00:00" 后缀导致主服务全判休市（审计 A-505）
    dates = pd.to_datetime(df["trade_date"]).dt.strftime("%Y-%m-%d").tolist()
    if year:
        prefix = f"{year}-"
        dates = [d for d in dates if d.startswith(prefix)]
    return dates


@app.get("/financials/{code}")
async def financials(code: str, limit: int = Query(default=4, ge=1, le=20)):
    """个股财务报表摘要（新浪财经），按报告期倒序返回最近 limit 期。

    注意：数值是带"元"后缀和千分位逗号的字符串（如 "999,862,000.00元"），
    原样返回给主服务由 LLM 阅读，不做数值清洗。
    兼容性：参数名随版本变动（旧版 stock / 1.18.94 起 symbol）；
    返回结构也随版本变动——旧版是长表（行=报告期，列含"截止日期/主营业务收入"），
    1.18.94 起是**宽表**（行=指标，列含"选项/指标"+每个报告期一列 YYYYMMDD），
    两种结构分别走 _financials_wide / 原长表逻辑（2026-09-15 实测，PITFALLS 已记录）。
    """
    try:
        try:
            df = await run_ak(ak.stock_financial_abstract, symbol=code)
        except TypeError:
            # 旧版 AKShare 参数名为 stock
            df = await run_ak(ak.stock_financial_abstract, stock=code)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AKShare 财报获取失败: {e}")
    if df is None or df.empty:
        return []
    if "指标" in df.columns:
        return _financials_wide(df, limit)
    # 旧版长表：列名 → 稳定输出字段；新浪若改版缺列则该字段为空串
    col_map = {
        "period": "截止日期",
        "revenue": "主营业务收入",
        "netProfit": "净利润",
        "totalAssets": "资产总计",
        "longTermDebt": "长期负债合计",
        "financeCost": "财务费用",
        "netAssetsPerShare": "每股净资产-摊薄/期末股数",
        "cashFlowPerShare": "每股现金流",
    }
    items = []
    for _, row in df.head(limit).iterrows():
        items.append({k: _cell(row, col) for k, col in col_map.items()})
    return items


def _financials_wide(df, limit: int):
    """新版（1.18.94+）宽表透视：行=指标（带"选项"分类列），列=报告期 YYYYMMDD。

    新版指标集与旧长表不同：没有"资产总计/长期负债合计/财务费用"，
    对应输出 netAssets/roe/eps 三个新字段（provider.ts FinancialReport 已加）。
    """
    import re

    date_cols = [c for c in df.columns if re.fullmatch(r"\d{8}", str(c))][:limit]

    def find_row(*names: str):
        """按候选指标名找行：优先"常用指标"组（同名单指标在多组重复出现），找不到退任意组。"""
        for name in names:
            m = df[(df["指标"] == name) & (df["选项"] == "常用指标")]
            if m.empty:
                m = df[df["指标"] == name]
            if not m.empty:
                return m.iloc[0]
        return None

    rows_map = {
        "revenue": find_row("营业总收入", "主营业务收入"),
        "netProfit": find_row("归母净利润", "净利润"),
        "netAssets": find_row("股东权益合计(净资产)"),
        "roe": find_row("净资产收益率(ROE)"),
        "eps": find_row("基本每股收益"),
        "netAssetsPerShare": find_row("每股净资产", "摊薄每股净资产_期末股数"),
        "cashFlowPerShare": find_row("每股现金流"),
    }
    items = []
    for dc in date_cols:
        d = str(dc)
        item = {"period": f"{d[:4]}-{d[4:6]}-{d[6:]}"}
        for k, row in rows_map.items():
            item[k] = "" if row is None else _cell(row, dc)
        items.append(item)
    return items


def _hist_items(df, days: int, cols: dict, volume_div: float = 1):
    """历史 K 线归一化输出（日期升序，尾部 days 条）。

    cols 为输出字段 → 数据源列名映射；无 changePct 列（新浪源）时用收盘价环比计算
    （窗口首条无昨收，置 0.0——只影响图表 tooltip 的首条，不影响折线本身）。
    amount/turnover（成交额/换手率，F3-3）为可选列：cols 里没有（新浪源）则字段不输出。
    volume_div：成交量单位换算除数——新浪源按"股"返回，÷100 归一到"手"与东财源口径一致
    （2026-09-15 实测 600519：新浪 1376172 股 vs 东财 f47 13762 手）。
    """
    if df is None or df.empty:
        return []
    rows = []
    for _, row in df.tail(days).iterrows():
        item = {
            # pd.to_datetime 转换，防范列类型漂移（同 trade-calendar，审计 A-505）
            "date": pd.to_datetime(row[cols["date"]]).strftime("%Y-%m-%d"),
            "open": _num(row.get(cols["open"])),
            "close": _num(row.get(cols["close"])),
            "high": _num(row.get(cols["high"])),
            "low": _num(row.get(cols["low"])),
            "volume": _num(row.get(cols["volume"])) / volume_div,
            "changePct": _num(row.get(cols["changePct"])) if "changePct" in cols else 0.0,
        }
        for opt_key in ("amount", "turnover"):
            # 列存在性也校验：列名漂移时宁可不输出该字段，也不要静默发 0.0（A-310 同原则）
            if opt_key in cols and cols[opt_key] in df.columns:
                item[opt_key] = _num(row.get(cols[opt_key]))
        rows.append(item)
    if "changePct" not in cols:
        prev = None
        for r in rows:
            if prev:
                r["changePct"] = round((r["close"] - prev) / prev * 100, 2)
            prev = r["close"]
    return rows


@app.get("/history/{code}")
async def history(code: str, days: int = Query(default=120, ge=1, le=1500)):
    """个股历史日 K 线（前复权）。按日期升序返回最近 days 个交易日。

    数据源降级链：东财 stock_zh_a_hist → 新浪 stock_zh_a_daily。
    东财 push2his 接口被 IP 限流时（见 PITFALLS 东财条目）新浪可托底（2026-09-15 实测）。
    start_date 按日历日约 2*days 往前推（覆盖周末/节假日），拿到后取尾部
    days 个交易日，保证非交易日不挤占条数。
    """
    end = datetime.now().strftime("%Y%m%d")
    start = (datetime.now() - timedelta(days=days * 2)).strftime("%Y%m%d")
    em_cols = {"date": "日期", "open": "开盘", "close": "收盘",
               "high": "最高", "low": "最低", "volume": "成交量", "changePct": "涨跌幅",
               "amount": "成交额", "turnover": "换手率"}  # 成交额/换手率（F3-3）仅东财源有列
    sina_cols = {"date": "date", "open": "open", "close": "close",
                 "high": "high", "low": "low", "volume": "volume"}
    em_err = None
    try:
        df = await run_ak(
            ak.stock_zh_a_hist,
            symbol=code,
            period="daily",
            start_date=start,
            end_date=end,
            adjust="qfq",
        )
        return _hist_items(df, days, em_cols)
    except Exception as e:
        # 含 HTTPException（超时 504）：上游源失败都应尝试降级而非直接失败
        em_err = e
        logger.warning("history 东财源失败，降级新浪: code=%s err=%s", code, e)
    try:
        # 新浪代码带市场前缀；北交所（4/8/920）新浪不覆盖，此时降级会失败并连同东财错误一起报出
        sina_symbol = f"sh{code}" if code.startswith(("6", "9")) else f"sz{code}"
        df = await run_ak(
            ak.stock_zh_a_daily,
            symbol=sina_symbol,
            start_date=start,
            end_date=end,
            adjust="qfq",
        )
        return _hist_items(df, days, sina_cols, volume_div=100)  # 新浪成交量单位是股，÷100 归一到手
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"AKShare 历史行情获取失败（东财: {em_err}；新浪降级: {e}）",
        )


# ================= 公司资料（F3-2，2026-09-15） =================
# 主源 AKShare stock_individual_info_em（东财 push2 /qt/stock/get，字段 f 编码）；
# push2 被 IP 限流时降级 push2delay 同构接口（行情延时约 15 分钟，但行业/股本/
# 上市时间是近静态信息，不受延时影响）。按代码缓存 24h。

_profile_cache: dict = {}  # code -> {"ts": float, "data": dict}
_PROFILE_TTL = 24 * 3600


def _secid_for(code: str) -> str:
    """与 src/data/eastmoney.ts 的 toSecid 规则一致：沪市 6/900 → "1."，其余（含北交所 4/8/920）→ "0."。"""
    return ("1." if code.startswith(("6", "900")) else "0.") + code


def _f_opt(v):
    """东财数值字段：'-'（停牌/退市/已切换代码）与非法值 -> None，不用 0 顶替（伪 0 比缺失更糟）。"""
    if v in (None, "-"):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _profile_from_fields(fields: dict, code: str) -> dict:
    """东财 f 编码字典 -> CompanyProfile 结构（与 src/data/provider.ts 对齐）。"""
    # f189 上市时间为 yyyymmdd（int 或 str），防御性只保留数字再切片
    digits = re.sub(r"\D", "", str(fields.get("f189") or ""))
    listing = f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}" if len(digits) == 8 else None
    name = fields.get("f58")
    industry = fields.get("f127")
    return {
        "code": code,
        "name": None if name in (None, "-") else str(name),
        "industry": None if industry in (None, "-") else str(industry),
        "listingDate": listing,
        "totalShares": _f_opt(fields.get("f84")),  # 总股本，单位：股
        "floatShares": _f_opt(fields.get("f85")),  # 流通股，单位：股
    }


def _profile_via_delay_host(code: str) -> dict:
    """push2delay 同构降级：与 ak.stock_individual_info_em 同接口不同宿主（2026-09-15 实测字段一致）。"""
    r = requests.get(
        "https://push2delay.eastmoney.com/api/qt/stock/get",
        params={
            "fltt": "2",
            "invt": "2",
            "fields": "f57,f58,f84,f85,f127,f189",
            "secid": _secid_for(code),
        },
        timeout=10,
    )
    r.raise_for_status()
    fields = r.json().get("data")
    if not isinstance(fields, dict):
        raise ValueError(f"push2delay 无此代码数据（代码错误或已退市）: {code}")
    return _profile_from_fields(fields, code)


@app.get("/profile/{code}")
async def profile(code: str):
    """公司资料：所属行业/上市日期/总股本/流通股。返回 CompanyProfile。

    降级链：AKShare stock_individual_info_em（push2）→ push2delay 同构直连；
    结果按代码缓存 24h（公司资料近静态，缓存同时防限流期反复打上游）。
    """
    hit = _profile_cache.get(code)
    if hit and time.time() - hit["ts"] < _PROFILE_TTL:
        return hit["data"]
    em_err = None
    try:
        df = await run_ak(ak.stock_individual_info_em, symbol=code)
        kv = dict(zip(df["item"], df["value"]))
        # AKShare 已把 f 编码映射为中文 key，反查回 f 编码后复用同一套归一化
        zh_to_f = {"股票简称": "f58", "总股本": "f84", "流通股": "f85",
                   "行业": "f127", "上市时间": "f189"}
        data = _profile_from_fields({fk: kv.get(ck) for ck, fk in zh_to_f.items()}, code)
    except Exception as e:
        em_err = e
        logger.warning("profile push2 源失败，降级 push2delay: code=%s err=%s", code, e)
        try:
            data = await run_ak(_profile_via_delay_host, code)
        except Exception as e2:
            raise HTTPException(
                status_code=502,
                detail=f"公司资料获取失败（push2: {em_err}；push2delay 降级: {e2}）",
            )
    _profile_cache[code] = {"ts": time.time(), "data": data}
    return data


# ================= 资金流（F3-4，2026-09-15） =================
# 主源 AKShare stock_individual_fund_flow（东财 push2his /qt/stock/fflow/daykline）：
# 主力/超大单/大单/中单/小单五档净流入，百分数字段已是 % 单位（push2delay 同构接口实测核对，
# 该镜像只回当日 1 行，仅可用于字段核对、不能作历史降级源）。
# 降级源新浪 MoneyFlow（ssl_qsfx_zjlrqs，直连 requests）：仅"净流入/超大单净流入"两档，
# 且口径与东财不同（新浪"净流入"含全部资金，≠ 东财"主力净流入"；其 r0 超大单口径也不同），
# 响应里 source 字段供前端/调用方区分标注。新浪不覆盖北交所（4/8/920）。
# 按代码缓存 60s（资金流盘中实时变动；与涨跌榜同级，防刷新打爆上游）。

_fund_flow_cache: dict = {}  # code -> {"ts": float, "data": dict}
_FUND_FLOW_TTL = 60


def _fund_flow_market(code: str) -> str:
    """AKShare market 参数映射。注意 920 段属北交所，必须先于 "9"（沪市 B 股 900）判断。"""
    if code.startswith(("4", "8", "920")):
        return "bj"
    if code.startswith(("6", "9")):
        return "sh"
    return "sz"


def _pct100(v):
    """新浪比率字段是小数（-0.0738 = -7.38%），×100 转百分数；缺失 -> None。"""
    f = _fnum(v)
    return None if f is None else f * 100


def _fund_flow_from_em(df, code: str) -> dict:
    """东财源归一化：五档净流入 + 占比，日期升序。列名为 AKShare 公开文档口径，
    列名漂移时 _fnum 取不到会置 None（不静默发 0，同 A-310 原则）。"""
    items = []
    for _, row in df.iterrows():
        items.append({
            "date": str(row.get("日期", "")),
            "close": _fnum(row.get("收盘价")),
            "changePct": _fnum(row.get("涨跌幅")),
            "mainNetInflow": _fnum(row.get("主力净流入-净额")),
            "mainNetInflowPct": _fnum(row.get("主力净流入-净占比")),
            "superLargeNetInflow": _fnum(row.get("超大单净流入-净额")),
            "superLargeNetInflowPct": _fnum(row.get("超大单净流入-净占比")),
            "largeNetInflow": _fnum(row.get("大单净流入-净额")),
            "mediumNetInflow": _fnum(row.get("中单净流入-净额")),
            "smallNetInflow": _fnum(row.get("小单净流入-净额")),
        })
    return {"code": code, "source": "eastmoney", "items": items}


def _fund_flow_via_sina(code: str) -> dict:
    """新浪 MoneyFlow 降级源（直连 requests，AKShare 未封装）：仅沪深，两档净流入。
    返回字段（2026-09-15 实测）：opendate/trade（收盘价）/changeratio（涨跌幅，小数）/
    netamount（净流入，元）/ratioamount（净流入占比，小数）/r0_net（超大单净流入，元）/
    r0_ratio（超大单占比，小数）。按日期倒序返回，翻转为升序与东财源一致。"""
    symbol = f"sh{code}" if code.startswith(("6", "9")) else f"sz{code}"
    r = requests.get(
        "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs",
        params={"page": 1, "num": 100, "sort": "opendate", "asc": 0, "daima": symbol},
        timeout=10,
    )
    r.raise_for_status()
    r.encoding = "gbk"
    rows = r.json()
    if not isinstance(rows, list):
        raise ValueError(f"新浪资金流响应格式异常: {str(rows)[:100]}")
    items = []
    for row in reversed(rows):
        items.append({
            "date": str(row.get("opendate", "")),
            "close": _fnum(row.get("trade")),
            "changePct": _pct100(row.get("changeratio")),
            "mainNetInflow": _fnum(row.get("netamount")),
            "mainNetInflowPct": _pct100(row.get("ratioamount")),
            "superLargeNetInflow": _fnum(row.get("r0_net")),
            "superLargeNetInflowPct": _pct100(row.get("r0_ratio")),
        })
    return {"code": code, "source": "sina", "items": items}


@app.get("/fund-flow/{code}")
async def fund_flow(code: str, days: int = Query(default=30, ge=1, le=100)):
    """个股资金流向（主力/超大单净流入等）。返回 {code, source, items: FundFlowDay[]}，
    items 日期升序、尾部 days 条。source 标注口径：eastmoney=东财五档（主力/超大单/大单/
    中单/小单）；sina=新浪两档（净流入含全部资金 + 超大单），降级时返回。
    降级链：东财 stock_individual_fund_flow → 新浪 MoneyFlow；按代码缓存 60s。"""
    hit = _fund_flow_cache.get(code)
    if hit is None or time.time() - hit["ts"] > _FUND_FLOW_TTL:
        em_err = None
        try:
            df = await run_ak(
                ak.stock_individual_fund_flow, stock=code, market=_fund_flow_market(code)
            )
            data = _fund_flow_from_em(df, code)
        except Exception as e:
            # 含 HTTPException（超时 504）：上游源失败都应尝试降级而非直接失败（同 /history）
            em_err = e
            logger.warning("fund-flow 东财源失败，降级新浪: code=%s err=%s", code, e)
            if _fund_flow_market(code) == "bj":
                raise HTTPException(
                    status_code=502,
                    detail=f"资金流获取失败（东财: {em_err}；北交所新浪降级源不覆盖）",
                )
            try:
                data = await run_ak(_fund_flow_via_sina, code)
            except Exception as e2:
                raise HTTPException(
                    status_code=502,
                    detail=f"资金流获取失败（东财: {em_err}；新浪降级: {e2}）",
                )
        if not data["items"]:
            raise HTTPException(
                status_code=502, detail=f"资金流数据为空（代码错误或数据源不可用）: {code}"
            )
        hit = {"ts": time.time(), "data": data}
        _fund_flow_cache[code] = hit
    d = hit["data"]
    return {"code": code, "source": d["source"], "items": d["items"][-days:]}


# ================= 基金版块（F4-B，2026-09-15） =================
# 开放式基金数据来自天天基金（东财系，与支付宝财富页同源）；场内 ETF 为东财全量实时快照。
# 列结构均经 akshare 1.18.94 实测（见 docs/DATA_SOURCES.md）。

def _fnum(v):
    """安全转 float，None/NaN/非法 -> None。
    基金百分比列（新基金的近1年等）大量缺失，不能用 0 顶替（会伪装成真实收益）。"""
    try:
        if v is None or pd.isna(v):
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


# --- 全量基金代码表（基金搜索 + 基金详情名称/类型解析共用，约 2.8 万行，缓存 24h） ---
_fund_name_cache: dict = {"df": None, "ts": 0.0}
_FUND_NAME_TTL = 24 * 3600


def _load_fund_name_table():
    now = time.time()
    if _fund_name_cache["df"] is None or now - _fund_name_cache["ts"] > _FUND_NAME_TTL:
        _fund_name_cache["df"] = ak.fund_name_em()
        _fund_name_cache["ts"] = now
    return _fund_name_cache["df"]


# --- 开放式基金排行 ---
# ak.fund_open_fund_rank_em(symbol) 按近1年收益率降序返回该类型全量（股票型千只以上），
# 耗时数秒，按类型缓存 10 分钟。
_FUND_RANK_TYPES = ("全部", "股票型", "混合型", "债券型", "指数型", "QDII", "FOF")
_fund_rank_cache: dict = {}  # type -> {"ts": float, "items": list}
_FUND_RANK_TTL = 10 * 60


async def _load_fund_rank(symbol: str):
    now = time.time()
    hit = _fund_rank_cache.get(symbol)
    if hit is None or now - hit["ts"] > _FUND_RANK_TTL:
        df = await run_ak(ak.fund_open_fund_rank_em, symbol=symbol)
        items = []
        for _, row in df.iterrows():
            items.append({
                "code": str(row.get("基金代码", "")),
                "name": str(row.get("基金简称", "")),
                "date": str(row.get("日期", "")),
                "unitNav": _fnum(row.get("单位净值")),
                "accumNav": _fnum(row.get("累计净值")),
                "dayPct": _fnum(row.get("日增长率")),
                "week1": _fnum(row.get("近1周")),
                "month1": _fnum(row.get("近1月")),
                "month3": _fnum(row.get("近3月")),
                "month6": _fnum(row.get("近6月")),
                "year1": _fnum(row.get("近1年")),
                "thisYear": _fnum(row.get("今年来")),
                "sinceInception": _fnum(row.get("成立来")),
                "fee": str(row.get("手续费", "")),
            })
        hit = {"ts": now, "items": items}
        _fund_rank_cache[symbol] = hit
    return hit["items"]


@app.get("/funds/rank")
async def fund_rank(type: str = Query(default="全部"), limit: int = Query(default=50, ge=1, le=100)):
    """开放式基金排行（天天基金）。按近1年收益率降序，返回 FundRankItem[]。
    type 支持：全部/股票型/混合型/债券型/指数型/QDII/FOF。"""
    if type not in _FUND_RANK_TYPES:
        raise HTTPException(status_code=400, detail=f"type 只能是：{'/'.join(_FUND_RANK_TYPES)}")
    try:
        items = await _load_fund_rank(type)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AKShare 基金排行获取失败: {e}")
    return items[:limit]


@app.get("/funds/search")
async def fund_search(keyword: str = Query(min_length=1), limit: int = Query(default=10, ge=1, le=50)):
    """基金搜索（名称/代码/拼音缩写），返回 [{code, name, type}]，按匹配程度排序。
    打分规则与 /search 一致：完全 > 前缀 > 包含，拼音缩写兜底（如 "YFD"）。"""
    kw = keyword.strip()
    if not kw:
        raise HTTPException(status_code=400, detail="keyword 不能为空")
    try:
        df = await run_ak(_load_fund_name_table)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AKShare 基金代码表获取失败: {e}")

    def score(code: str, name: str, abbr: str) -> int:
        if name == kw or code == kw:
            return 0  # 完全匹配
        if name.startswith(kw) or code.startswith(kw):
            return 1  # 前缀匹配
        if kw in name:
            return 2  # 包含匹配
        if kw.upper() in abbr:
            return 3  # 拼音缩写匹配
        return -1

    matches = []
    for _, row in df.iterrows():
        code = str(row["基金代码"]).zfill(6)
        name = str(row["基金简称"])
        s = score(code, name, str(row["拼音缩写"]))
        if s >= 0:
            matches.append((s, code, name, str(row["基金类型"])))
    matches.sort(key=lambda m: (m[0], m[1]))
    return [{"code": c, "name": n, "type": t} for _, c, n, t in matches[:limit]]


# --- 场内 ETF 实时行情 ---
# ak.fund_etf_spot_em() 全量翻页约 16 页、耗时 30s+（2026-09-15 实测），
# 超时放宽到 120s + 结果缓存 60s（与涨跌榜同级，防刷新触发上游限流）。
_etf_cache: dict = {"ts": 0.0, "items": []}
_ETF_TTL = 60
_ETF_TIMEOUT = 120


@app.get("/funds/etf")
async def fund_etf(limit: int = Query(default=50, ge=1, le=500)):
    """场内 ETF 实时行情榜（东财全量快照），按涨跌幅降序，返回 EtfQuote[]。"""
    now = time.time()
    if now - _etf_cache["ts"] > _ETF_TTL:
        try:
            df = await run_ak(ak.fund_etf_spot_em, timeout=_ETF_TIMEOUT)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"AKShare ETF 行情获取失败: {e}")
        items = []
        for _, row in df.iterrows():
            items.append({
                "code": str(row.get("代码", "")),
                "name": str(row.get("名称", "")),
                "price": _fnum(row.get("最新价")),
                "changePct": _fnum(row.get("涨跌幅")),
                "change": _fnum(row.get("涨跌额")),
                "volume": _fnum(row.get("成交量")),
                "amount": _fnum(row.get("成交额")),
                "turnover": _fnum(row.get("换手率")),
                "iopv": _fnum(row.get("IOPV实时估值")),
                "discountRate": _fnum(row.get("基金折价率")),
                "time": str(row.get("更新时间", "")),
            })
        # 涨跌幅降序，缺失值（None）排最后
        items.sort(key=lambda it: (it["changePct"] is None, -(it["changePct"] or 0)))
        _etf_cache["ts"] = now
        _etf_cache["items"] = items
    return _etf_cache["items"][:limit]


# --- 单只基金详情 + 单位净值走势 ---
# ak.fund_open_fund_info_em(symbol, indicator="单位净值走势") 返回全量历史
# （列：净值日期/单位净值/日增长率，日期升序），按代码缓存 6 小时（净值每日只更新一次）。
# 注意：必须声明在 /funds/rank、/funds/search、/funds/etf 之后，否则它们会被当 code 匹配。
_fund_info_cache: dict = {}  # code -> {"ts": float, "points": list}
_FUND_INFO_TTL = 6 * 3600


@app.get("/funds/{code}")
async def fund_info(code: str, days: int = Query(default=250, ge=1, le=2000)):
    """单只开放式基金详情：名称/类型 + 单位净值走势（日期升序，尾部 days 条）。
    返回 {code, name, type, latest, history: FundNavPoint[]}。"""
    import re

    if not re.fullmatch(r"\d{6}", code):
        raise HTTPException(status_code=400, detail="基金代码必须是 6 位数字")
    now = time.time()
    hit = _fund_info_cache.get(code)
    if hit is None or now - hit["ts"] > _FUND_INFO_TTL:
        try:
            df = await run_ak(
                ak.fund_open_fund_info_em, symbol=code, indicator="单位净值走势"
            )
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"AKShare 基金净值获取失败: {e}")
        if df is None or df.empty:
            raise HTTPException(
                status_code=404, detail=f"未找到基金 {code} 的净值数据（请核对 6 位基金代码）"
            )
        points = []
        for _, row in df.iterrows():
            points.append({
                # pd.to_datetime 转换，防范列类型漂移（同 trade-calendar，审计 A-505）
                "date": pd.to_datetime(row["净值日期"]).strftime("%Y-%m-%d"),
                "nav": _fnum(row.get("单位净值")),
                "changePct": _fnum(row.get("日增长率")),
            })
        hit = {"ts": now, "points": points}
        _fund_info_cache[code] = hit
    # 名称/类型来自全量代码表（缓存 24h）；代码表失败降级为空串，不阻塞净值返回
    name, ftype = "", ""
    try:
        table = await run_ak(_load_fund_name_table)
        m = table[table["基金代码"].astype(str).str.zfill(6) == code]
        if not m.empty:
            name = str(m.iloc[0]["基金简称"])
            ftype = str(m.iloc[0]["基金类型"])
    except Exception as e:
        logger.warning("fund_info 名称表查询失败（不影响净值返回）: code=%s err=%s", code, e)
    points = hit["points"][-days:]
    return {
        "code": code,
        "name": name,
        "type": ftype,
        "latest": points[-1] if points else None,
        "history": points,
    }
