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
from datetime import datetime, timedelta, timezone
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


async def _load_bars(code: str, days: int):
    """历史日 K 归一化加载（/history 与 /indicators 共用的取数降级链）。
    返回 (bars, source)：bars 见 _hist_items 输出（日期升序、尾部 days 条）；
    source 标注口径：eastmoney=东财 stock_zh_a_hist，sina=新浪降级源。
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
        return _hist_items(df, days, em_cols), "eastmoney"
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
        return _hist_items(df, days, sina_cols, volume_div=100), "sina"  # 新浪成交量单位是股，÷100 归一到手
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"AKShare 历史行情获取失败（东财: {em_err}；新浪降级: {e}）",
        )


@app.get("/history/{code}")
async def history(code: str, days: int = Query(default=120, ge=1, le=1500)):
    """个股历史日 K 线（前复权）。按日期升序返回最近 days 个交易日。
    取数与降级链见 _load_bars（东财 → 新浪）。"""
    bars, _source = await _load_bars(code, days)
    return bars


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


async def _get_fund_flow_cached(code: str) -> dict:
    """个股资金流取数（/fund-flow 与 /verify 共用）：返回 {code, source, items}（items 日期升序，
    全量约 100 个交易日，截尾由调用方做）。按代码缓存 60s，缓存键与形态/验货缓存独立。"""
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
    return hit["data"]


@app.get("/fund-flow/{code}")
async def fund_flow(code: str, days: int = Query(default=30, ge=1, le=100)):
    """个股资金流向（主力/超大单净流入等）。返回 {code, source, items: FundFlowDay[]}，
    items 日期升序、尾部 days 条。source 标注口径：eastmoney=东财五档（主力/超大单/大单/
    中单/小单）；sina=新浪两档（净流入含全部资金 + 超大单），降级时返回。
    降级链：东财 stock_individual_fund_flow → 新浪 MoneyFlow；按代码缓存 60s。"""
    d = await _get_fund_flow_cached(code)
    return {"code": code, "source": d["source"], "items": d["items"][-days:]}


# ================= 分时数据（F3-5，2026-09-16） =================
# 主源 AKShare stock_zh_a_hist_min_em（东财 push2his 分钟 K，period="1" 当日 1 分钟线）；
# push2his 被 IP 限流时（见 PITFALLS 东财条目）降级新浪 stock_zh_a_minute——该接口返回
# 近约 8 个交易日的 1 分钟数据（约 1970 行），端点只取最近一个交易日。
# 单位口径：新浪分钟成交量是"股"（与日 K 一致，2026-09-16 实测 600519 验证），÷100 归一到
# "手"与东财一致；两源都有成交额列（元），据此累计算出分时均价 VWAP。
# 按代码缓存 60s（分时盘中实时变动；与资金流/涨跌榜同级，防刷新打爆上游）。

_intraday_cache: dict = {}  # code -> {"ts": float, "data": dict}
_INTRADAY_TTL = 60


def _intraday_from_df(df, code: str, source: str, cols: dict, vol_div: float = 1) -> dict:
    """分钟数据归一化：只保留最近一个交易日，输出 time/price/volume(手) 序列。

    cols 为输出字段 → 数据源列名映射。amount（成交额）为可选列：两源当前都有，
    列名漂移时整条不输出 amount/avgPrice，不静默发错值（同 A-310 原则）。
    avgPrice（分时均价线）= 累计成交额 / 累计成交量（换算成股），即 VWAP。
    vol_div：成交量单位换算除数——新浪源按"股"返回，÷100 归一到"手"（同 /history）。
    """
    if df is None or df.empty:
        raise ValueError("分钟数据为空")
    # pd.to_datetime 转换，防范列类型漂移（同 trade-calendar，审计 A-505）
    times = pd.to_datetime(df[cols["time"]], errors="coerce")
    latest = times.dt.strftime("%Y-%m-%d").max()
    if not isinstance(latest, str) or latest == "NaT":
        raise ValueError("分钟数据时间列解析失败")
    has_amount = "amount" in cols and cols["amount"] in df.columns
    points = []
    cum_amount = 0.0
    cum_shares = 0.0
    for (_, row), ts in zip(df.iterrows(), times):
        if pd.isna(ts) or ts.strftime("%Y-%m-%d") != latest:
            continue
        price = _fnum(row.get(cols["price"]))
        vol = _fnum(row.get(cols["volume"]))
        if price is None or vol is None:
            continue  # 缺价/缺量的行直接跳过（不补 0 伪装成交）
        vol_hand = vol / vol_div
        item = {"time": ts.strftime("%H:%M"), "price": price, "volume": vol_hand}
        if has_amount:
            amt = _fnum(row.get(cols["amount"])) or 0.0  # 单分钟成交额为 0 是合法值
            cum_amount += amt
            cum_shares += vol_hand * 100
            item["amount"] = amt
            if cum_shares > 0:
                item["avgPrice"] = round(cum_amount / cum_shares, 3)
        points.append(item)
    if not points:
        raise ValueError("分钟数据为空（最近交易日无数据）")
    return {"code": code, "date": latest, "source": source, "points": points}


@app.get("/intraday/{code}")
async def intraday(code: str):
    """个股分时（1 分钟线，最近一个交易日）。返回 {code, date, source, points: IntradayPoint[]}，
    points 含 time(HH:MM)/price/volume(手)，有成交额列时附 amount 与 avgPrice（VWAP 均价）。
    source 标注口径：eastmoney=东财分钟 K；sina=新浪降级源。
    降级链：东财 stock_zh_a_hist_min_em → 新浪 stock_zh_a_minute；按代码缓存 60s。"""
    hit = _intraday_cache.get(code)
    if hit is None or time.time() - hit["ts"] > _INTRADAY_TTL:
        em_err = None
        try:
            df = await run_ak(ak.stock_zh_a_hist_min_em, symbol=code, period="1", adjust="")
            data = _intraday_from_df(
                df, code, "eastmoney",
                {"time": "时间", "price": "收盘", "volume": "成交量", "amount": "成交额"},
            )
        except Exception as e:
            # 含 HTTPException（超时 504）：上游源失败都应尝试降级而非直接失败（同 /history）
            em_err = e
            logger.warning("intraday 东财源失败，降级新浪: code=%s err=%s", code, e)
            try:
                # 新浪代码带市场前缀；北交所（4/8/920）实测覆盖（2026-09-16 bj920799 验证）
                if code.startswith(("4", "8", "920")):
                    sina_symbol = f"bj{code}"
                else:
                    sina_symbol = f"sh{code}" if code.startswith(("6", "9")) else f"sz{code}"
                df = await run_ak(ak.stock_zh_a_minute, symbol=sina_symbol, period="1", adjust="")
                data = _intraday_from_df(
                    df, code, "sina",
                    {"time": "day", "price": "close", "volume": "volume", "amount": "amount"},
                    vol_div=100,  # 新浪成交量单位是股，÷100 归一到手
                )
            except Exception as e2:
                raise HTTPException(
                    status_code=502,
                    detail=f"分时数据获取失败（东财: {em_err}；新浪降级: {e2}）",
                )
        hit = {"ts": time.time(), "data": data}
        _intraday_cache[code] = hit
    return hit["data"]


# ================= 分红送配（F3-6，2026-09-16） =================
# AKShare stock_history_dividend_detail（indicator="分红"，东财数据源）：
# 列 = 公告日期/送股/转增/派息/进度/除权除息日/股权登记日/红股上市日（2026-09-16 实测 600519）。
# 口径：送股/转增/派息均为"每 10 股"（派息单位元，税前）。按代码缓存 6h（分红是低频事件）。

_dividend_cache: dict = {}  # code -> {"ts": float, "data": list}
_DIVIDEND_TTL = 6 * 3600


def _div_date(v):
    """datetime.date / NaT / None -> 'YYYY-MM-DD' / None。"""
    if v is None or pd.isna(v):
        return None
    return str(v)[:10]


@app.get("/dividends/{code}")
async def dividends(code: str, limit: int = Query(default=10, ge=1, le=50)):
    """个股分红送配记录（按公告日期倒序）。返回 DividendRecord[]：
    announceDate/exDate/recordDate 为 YYYY-MM-DD；dividend=每10股派息(元，税前)，
    bonus=每10股送股，transfer=每10股转增；progress 为方案进度（预案/实施等）。
    从未分红的公司返回空数组（200）；上游失败 502。按代码缓存 6h。"""
    hit = _dividend_cache.get(code)
    if hit is None or time.time() - hit["ts"] > _DIVIDEND_TTL:
        try:
            df = await run_ak(ak.stock_history_dividend_detail, symbol=code, indicator="分红")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"分红送配数据获取失败: {e}")
        items = []
        if df is not None and not df.empty:
            for _, row in df.iterrows():
                items.append({
                    "announceDate": _div_date(row.get("公告日期")),
                    "exDate": _div_date(row.get("除权除息日")),
                    "recordDate": _div_date(row.get("股权登记日")),
                    # 列名漂移时 row.get 得 None -> null 输出，不用 0 顶替（A-310 同原则）
                    "dividend": _fnum(row.get("派息")),
                    "bonus": _fnum(row.get("送股")),
                    "transfer": _fnum(row.get("转增")),
                    "progress": None if pd.isna(row.get("进度")) else str(row.get("进度")),
                })
        hit = {"ts": time.time(), "data": items}
        _dividend_cache[code] = hit
    return hit["data"][:limit]


# ================= 技术指标（F5-1，2026-09-16） =================
# 纯本地 pandas 计算（无新外部依赖），输入为与 /history 同源的前复权日 K（_load_bars）。
# 指标口径（已记录到 docs/DATA_SOURCES.md）：
#   MA(N)     = 收盘价 N 日简单移动平均
#   EMA(N)    = ewm(span=N, adjust=False)
#   MACD      ：DIF = EMA12 - EMA26；DEA = DIF 的 EMA9；MACD柱 = 2×(DIF-DEA)（国内软件惯例）
#   RSI(N)    ：Wilder 平滑（ewm alpha=1/N, min_periods=N），RSI = 100×avgGain/(avgGain+avgLoss)
#   KDJ(9,3,3)：RSV = (C-LLV9)/(HHV9-LLV9)×100；K = SMA(RSV,3,1) 递推平滑（ewm alpha=1/3）；
#               D = K 的同口径平滑；J = 3K-2D
#   BOLL(20,2)：中轨 = MA20；上/下轨 = 中轨 ± 2×20 日总体标准差（ddof=0，通达信口径）
# 关键价位：近 120 根 K 线的分形高/低点（±2 窗口局部极值）+ 区间最高/最低，
#   按 3% 容差聚类取簇均值；最新收盘之下最近 2 档为支撑位、之上最近 2 档为压力位。
# 信号为客观状态描述（如"MA5 上穿 MA20"），不含任何买卖建议（项目红线）。


def _f3(v):
    """指标值输出：None/NaN/Inf/非法 -> None，否则 round(v, 3)（防 pandas NaN 泄漏成非法 JSON）。"""
    try:
        if v is None or pd.isna(v):
            return None
        f = float(v)
        if f != f or f in (float("inf"), float("-inf")):
            return None
        return round(f, 3)
    except (TypeError, ValueError):
        return None


def _key_levels(bars: list, lookback: int = 120) -> dict:
    """近 lookback 根 K 线分形高低点 + 区间极值，3% 容差聚类；收盘下/上方最近各至多 2 档。"""
    seg = bars[-lookback:]
    highs = [b["high"] for b in seg]
    lows = [b["low"] for b in seg]
    cand_high, cand_low = [max(highs)], [min(lows)]
    for i in range(2, len(seg) - 2):
        if highs[i] >= max(highs[i - 2:i + 3]):
            cand_high.append(highs[i])
        if lows[i] <= min(lows[i - 2:i + 3]):
            cand_low.append(lows[i])

    def cluster(vals: list, tol: float = 0.03) -> list:
        """按价格升序扫描，相邻差 ≤3% 的聚成一簇，簇内取均值（密集多底/多顶合并为一档）。"""
        groups = []
        for v in sorted(vals):
            if groups and v - groups[-1][-1] <= tol * v:
                groups[-1].append(v)
            else:
                groups.append([v])
        return [sum(g) / len(g) for g in groups]

    close = bars[-1]["close"]
    support = sorted((c for c in cluster(cand_low) if c < close), key=lambda c: close - c)
    resistance = sorted((c for c in cluster(cand_high) if c > close), key=lambda c: c - close)
    return {
        "support": [round(v, 3) for v in support[:2]],
        "resistance": [round(v, 3) for v in resistance[:2]],
    }


def _ind_signals(bars: list, ma: dict, dif, dea, rsi6, boll_up, boll_dn) -> list:
    """最新一根 K 线的客观技术信号（状态描述，非买卖建议）。数据不足时对应信号不出现。"""

    def last2(s):
        """序列最后两个值 (prev, cur)；不足两个或含 NaN 返回 None。"""
        if len(s) < 2:
            return None
        a, b = _f3(s.iloc[-2]), _f3(s.iloc[-1])
        return (a, b) if a is not None and b is not None else None

    sigs = []
    r6 = _f3(rsi6.iloc[-1]) if len(rsi6) else None
    if r6 is not None:
        if r6 >= 80:
            sigs.append({"type": "rsi_overbought", "text": f"RSI6={r6:.1f}，处于超买区间（≥80）"})
        elif r6 <= 20:
            sigs.append({"type": "rsi_oversold", "text": f"RSI6={r6:.1f}，处于超卖区间（≤20）"})
    if len(bars) < 2:
        return sigs
    c_prev, c_cur = bars[-2]["close"], bars[-1]["close"]
    m5, m20, m60 = last2(ma[5]), last2(ma[20]), last2(ma[60])
    if m5 and m20:
        if m5[0] <= m20[0] and m5[1] > m20[1]:
            sigs.append({"type": "ma_cross_up", "text": "MA5 上穿 MA20（金叉）"})
        elif m5[0] >= m20[0] and m5[1] < m20[1]:
            sigs.append({"type": "ma_cross_down", "text": "MA5 下穿 MA20（死叉）"})
    dd, de = last2(dif), last2(dea)
    if dd and de:
        if dd[0] <= de[0] and dd[1] > de[1]:
            sigs.append({"type": "macd_cross_up", "text": "MACD DIF 上穿 DEA（金叉）"})
        elif dd[0] >= de[0] and dd[1] < de[1]:
            sigs.append({"type": "macd_cross_down", "text": "MACD DIF 下穿 DEA（死叉）"})
    if m60:
        if c_prev <= m60[0] and c_cur > m60[1]:
            sigs.append({"type": "close_above_ma60", "text": "收盘价站上 MA60"})
        elif c_prev >= m60[0] and c_cur < m60[1]:
            sigs.append({"type": "close_below_ma60", "text": "收盘价跌破 MA60"})
    up, dn = _f3(boll_up.iloc[-1]), _f3(boll_dn.iloc[-1])
    if up is not None and c_cur > up:
        sigs.append({"type": "boll_break_up", "text": "收盘价突破布林上轨"})
    if dn is not None and c_cur < dn:
        sigs.append({"type": "boll_break_down", "text": "收盘价跌破布林下轨"})
    return sigs


def _compute_indicators(code: str, source: str, bars: list) -> dict:
    """由归一化日 K bars 计算全部指标，组装 TechnicalIndicators 响应结构。"""
    close = pd.Series([b["close"] for b in bars], dtype="float64")
    high = pd.Series([b["high"] for b in bars], dtype="float64")
    low = pd.Series([b["low"] for b in bars], dtype="float64")

    ma = {n: close.rolling(n).mean() for n in (5, 10, 20, 60)}
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    dif = ema12 - ema26
    dea = dif.ewm(span=9, adjust=False).mean()
    macd_bar = 2 * (dif - dea)

    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    rsi = {}
    for n in (6, 12, 24):
        avg_gain = gain.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
        avg_loss = loss.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
        rsi[n] = 100 * avg_gain / (avg_gain + avg_loss)  # 分母为 0（长期零波动）→ NaN → null

    llv9 = low.rolling(9).min()
    hhv9 = high.rolling(9).max()
    rsv = (close - llv9) / (hhv9 - llv9) * 100  # 9 日最高=最低（极端横盘）→ NaN
    kdj_k = rsv.ewm(alpha=1 / 3, adjust=False).mean()
    kdj_d = kdj_k.ewm(alpha=1 / 3, adjust=False).mean()
    kdj_j = 3 * kdj_k - 2 * kdj_d

    boll_mid = close.rolling(20).mean()
    boll_std = close.rolling(20).std(ddof=0)
    boll_up = boll_mid + 2 * boll_std
    boll_dn = boll_mid - 2 * boll_std

    i = len(bars) - 1
    return {
        "code": code,
        "source": source,
        "asOf": bars[-1]["date"],
        "latest": {
            "close": bars[-1]["close"],
            "ma": {f"ma{n}": _f3(ma[n].iloc[i]) for n in (5, 10, 20, 60)},
            "ema": {"ema12": _f3(ema12.iloc[i]), "ema26": _f3(ema26.iloc[i])},
            "macd": {"dif": _f3(dif.iloc[i]), "dea": _f3(dea.iloc[i]), "macd": _f3(macd_bar.iloc[i])},
            "rsi": {f"rsi{n}": _f3(rsi[n].iloc[i]) for n in (6, 12, 24)},
            "kdj": {"k": _f3(kdj_k.iloc[i]), "d": _f3(kdj_d.iloc[i]), "j": _f3(kdj_j.iloc[i])},
            "boll": {"upper": _f3(boll_up.iloc[i]), "mid": _f3(boll_mid.iloc[i]), "lower": _f3(boll_dn.iloc[i])},
        },
        "keyLevels": _key_levels(bars),
        "signals": _ind_signals(bars, ma, dif, dea, rsi[6], boll_up, boll_dn),
        "series": {
            "dates": [b["date"] for b in bars],
            **{f"ma{n}": [_f3(v) for v in ma[n]] for n in (5, 10, 20, 60)},
        },
    }


@app.get("/indicators/{code}")
async def indicators(code: str, days: int = Query(default=250, ge=1, le=1500)):
    """个股技术指标（F5-1）：MA/EMA/MACD/RSI/KDJ/BOLL + 关键价位 + 客观信号。
    基于与 /history 同源的前复权日 K 纯本地计算（无新外部依赖，降级链一致）。
    latest=最新交易日指标值（周期不足为 null）；series=与 dates 对齐的 MA 序列
    （走势图叠加用，前导不足周期为 null）；keyLevels=支撑/压力位（口径见文件头注释）；
    signals=客观状态信号，不含买卖建议。days 默认 250（够 MA60/MACD 收敛），上限 1500。"""
    bars, source = await _load_bars(code, days)
    if not bars:
        raise HTTPException(
            status_code=502, detail=f"历史行情为空，无法计算技术指标（代码错误或数据源不可用）: {code}"
        )
    try:
        return _compute_indicators(code, source, bars)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"技术指标计算失败: {e}")


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


# ================= 外盘联动监控（F6-4，2026-09-19） =================
# GET /overseas/summary：聚合隔夜外盘参考信息（美股三大指数 / 中概股与热门美股 /
# 国际金银原油），**每块独立降级**——一块失败其余照返，失败块带 error 字段。
# 整体结果进程内缓存 10 分钟（外盘数据变动慢，防刷新打爆上游）。
# 数据源选型（2026-09-19 逐一实测，结论同时登记在 docs/DATA_SOURCES.md 与 PITFALLS）：
# - 美股三大指数：主源腾讯行情 qt.gtimg.cn（usDJI/usIXIC/usINX，GBK 文本协议，
#   字段下标与 A 股同款：3=最新价 4=昨收 30=时间 31=涨跌额 32=涨跌幅 33=最高 34=最低）；
#   降级新浪 ak.index_us_stock_sina（全量日 K，取最后两根收盘算涨跌幅）。
#   东财系未采用：ak.index_global_spot_em 走 push2 clist 的 i: 市场，本机实测连接被掐
#   （exit 56，与 IP 限流同现象）；ak.stock_us_famous_spot_em 走 69.push2 子域同样断连。
# - 中概股/美股热门：腾讯行情固定篮子（usBABA 等，**代码不带交易所后缀**，带 .OQ 后缀
#   反而返回 v_pv_none_match）。
# - 国际金银原油：主源新浪 ak.futures_foreign_commodity_realtime（**必须用交易所代码**
#   XAU/XAG/GC/SI/CL/OIL——传中文名会触发 AKShare 1.18.94 列数不匹配 ValueError；
#   涨跌幅已是 % 单位；行情时间是数据源原始时间，非北京时间）；
#   降级东财 ak.futures_global_spot_em（全量翻页约 32s，超时放宽 60s，取当月连续合约）。

_OVERSEAS_TTL = 600  # 10 分钟
_overseas_cache: dict = {"ts": 0.0, "data": None}

_TENCENT_TIMEOUT = 10  # 秒；腾讯行情直连（requests，不走 run_ak——非 AKShare 调用）

# 腾讯美股指数/个股代码 -> 展示名（名称为空时的兜底；正常响应自带中文名）
_TENCENT_US_INDICES = [
    ("usDJI", ".DJI", "道琼斯工业指数"),
    ("usIXIC", ".IXIC", "纳斯达克综合指数"),
    ("usINX", ".INX", "标普500"),
]
_TENCENT_US_HOT = [
    "usBABA", "usPDD", "usJD", "usNTES", "usBIDU",  # 中概股
    "usNIO", "usXPEV", "usLI", "usBILI", "usTCOM",
    "usAAPL", "usMSFT", "usNVDA", "usTSLA",  # 美股科技热门
]

# 新浪外盘期货交易所代码 -> 展示名（顺序即展示顺序）
_SINA_COMMODITY_SYMBOLS = [
    ("XAU", "伦敦金"),
    ("XAG", "伦敦银"),
    ("GC", "COMEX黄金"),
    ("SI", "COMEX白银"),
    ("CL", "NYMEX原油（WTI）"),
    ("OIL", "布伦特原油"),
]

# 东财全球期货降级源：当月连续合约名称 -> 展示名
_EM_COMMODITY_CONTINUOUS = {
    "COMEX黄金": "COMEX黄金（当月连续）",
    "COMEX白银": "COMEX白银（当月连续）",
    "NYMEX原油": "NYMEX原油（当月连续）",
}


def _parse_tencent_us(text: str) -> dict:
    """解析腾讯行情批量响应（GBK 文本）为 {查询代码: item}。
    与主服务 tencent.ts 同一下标口径：1=名称 2=代码 3=最新价 4=昨收
    30=时间 31=涨跌额 32=涨跌幅。缺失/非数值 -> None（不补 0，同 A-310 原则）。
    停牌/无效代码返回 v_xxx=""（空串），整条跳过。"""
    out = {}
    for m in re.finditer(r'v_([A-Za-z0-9.]+)="([^"]*)"', text):
        qcode, payload = m.group(1), m.group(2)
        f = payload.split("~")
        if len(f) < 33 or not f[3]:
            continue  # 空串或字段不足
        out[qcode] = {
            "code": f[2] or qcode,
            "name": f[1] or qcode,
            "price": _fnum(f[3]),
            "changePct": _fnum(f[32]),
            "time": f[30] or None,
        }
    return out


def _fetch_tencent_us(codes: list) -> dict:
    """批量拉腾讯美股行情（单次请求，逗号拼接）。返回 {查询代码: item}。"""
    r = requests.get(
        "https://qt.gtimg.cn/q=" + ",".join(codes),
        timeout=_TENCENT_TIMEOUT,
    )
    r.raise_for_status()
    r.encoding = "gbk"
    return _parse_tencent_us(r.text)


def _overseas_us_indices_items(quotes: dict) -> list:
    items = []
    for qcode, _sym, fallback_name in _TENCENT_US_INDICES:
        it = quotes.get(qcode)
        if it is None:
            continue
        if not it["name"] or it["name"] == qcode:
            it["name"] = fallback_name
        items.append(it)
    if len(items) < len(_TENCENT_US_INDICES):
        raise ValueError("腾讯美股指数响应不完整")
    return items


async def _block_us_indices() -> dict:
    """美股三大指数块：腾讯行情主源 -> 新浪日 K 降级。"""
    try:
        quotes = await asyncio.to_thread(_fetch_tencent_us, [c for c, _, _ in _TENCENT_US_INDICES])
        return {"source": "tencent", "error": None,
                "items": _overseas_us_indices_items(quotes)}
    except Exception as e:
        logger.warning("overseas 美股指数腾讯源失败，降级新浪: %s", e)
        em_err = e
    # 降级：新浪 ak.index_us_stock_sina 全量日 K，取最后两根算涨跌幅
    try:
        items = []
        for _qcode, sym, name in _TENCENT_US_INDICES:
            df = await run_ak(ak.index_us_stock_sina, symbol=sym)
            if df is None or len(df) < 2:
                raise ValueError(f"新浪 {sym} 日 K 数据不足")
            c_prev, c_cur = float(df["close"].iloc[-2]), float(df["close"].iloc[-1])
            items.append({
                "code": sym,
                "name": name,
                "price": _f3(c_cur),
                "changePct": _f3((c_cur / c_prev - 1) * 100) if c_prev else None,
                "time": str(df["date"].iloc[-1]),  # 收盘日期 YYYY-MM-DD
            })
        return {"source": "sina", "error": None, "items": items}
    except Exception as e2:
        return {"source": None, "error": f"美股指数获取失败（腾讯: {em_err}；新浪降级: {e2}）",
                "items": []}


async def _block_us_hot() -> dict:
    """中概股/美股热门块：腾讯行情固定篮子，单次请求；无降级源（宁缺毋滥）。"""
    try:
        quotes = await asyncio.to_thread(_fetch_tencent_us, _TENCENT_US_HOT)
        items = [quotes[c] for c in _TENCENT_US_HOT if c in quotes]
        if not items:
            raise ValueError("腾讯美股个股响应为空")
        return {"source": "tencent", "error": None, "items": items}
    except Exception as e:
        return {"source": None, "error": f"中概股/美股热门获取失败: {e}", "items": []}


def _commodities_from_sina(df) -> list:
    """新浪外盘期货归一化：按订阅代码顺序输出，涨跌幅已是 % 单位（2026-09-19 实测）。"""
    by_name = {}
    for _, row in df.iterrows():
        by_name[str(row.get("名称", ""))] = row
    items = []
    for sym, name in _SINA_COMMODITY_SYMBOLS:
        # 响应"名称"列与订阅代码的中文名对应（XAU->伦敦金、OIL->布伦特原油）
        row = by_name.get(name.split("（")[0])  # CL 展示名带（WTI）后缀，按原名匹配
        if row is None:
            continue
        t = f"{_cell(row, '日期')} {_cell(row, '行情时间')}".strip()
        items.append({
            "code": sym,
            "name": name,
            "price": _f3(row.get("最新价")),
            "changePct": _f3(row.get("涨跌幅")),
            "time": t or None,
        })
    if not items:
        raise ValueError("新浪外盘期货响应为空")
    return items


async def _block_commodities() -> dict:
    """国际金银原油块：新浪外盘期货主源 -> 东财全球期货（当月连续）降级。"""
    try:
        df = await run_ak(
            ak.futures_foreign_commodity_realtime,
            symbol=[s for s, _ in _SINA_COMMODITY_SYMBOLS],
        )
        return {"source": "sina", "error": None, "items": _commodities_from_sina(df)}
    except Exception as e:
        logger.warning("overseas 商品新浪源失败，降级东财全球期货: %s", e)
        sina_err = e
    try:
        # 全量翻页约 32s（2026-09-19 实测），超时放宽到 60s
        df = await run_ak(ak.futures_global_spot_em, timeout=60)
        items = []
        for _, row in df.iterrows():
            name = str(row.get("名称", ""))
            if name not in _EM_COMMODITY_CONTINUOUS:
                continue
            items.append({
                "code": str(row.get("代码", "")),
                "name": _EM_COMMODITY_CONTINUOUS[name],
                "price": _fnum(row.get("最新价")),
                "changePct": _fnum(row.get("涨跌幅")),
                "time": None,  # 东财全球期货快照无时间列
            })
        if not items:
            raise ValueError("东财全球期货中未找到当月连续合约行")
        # 按 _EM_COMMODITY_CONTINUOUS 声明顺序排序（金/银/油），与新浪主源展示顺序一致
        order = {v: i for i, v in enumerate(_EM_COMMODITY_CONTINUOUS.values())}
        items.sort(key=lambda it: order.get(it["name"], 99))
        return {"source": "eastmoney", "error": None, "items": items}
    except Exception as e2:
        return {"source": None, "error": f"商品获取失败（新浪: {sina_err}；东财降级: {e2}）",
                "items": []}


@app.get("/overseas/summary")
async def overseas_summary():
    """隔夜外盘参考信息汇总（F6-4）。返回 {generatedAt, usIndices, usHot, commodities}，
    每块 {source, error, items: [{code, name, price, changePct, time}]}；
    块级独立降级：失败块 error 非空、items 为空，其余块照常返回。
    时间字段为数据源原始时间（美股为美东时间，新浪商品为数据源时区），非北京时间。
    整体缓存 10 分钟。"""
    now = time.time()
    if _overseas_cache["data"] is None or now - _overseas_cache["ts"] > _OVERSEAS_TTL:
        us_indices, us_hot, commodities = await asyncio.gather(
            _block_us_indices(), _block_us_hot(), _block_commodities()
        )
        # 生成时间固定用北京时间（与时区无关），前端据此标注快照时刻
        from datetime import timezone

        generated_at = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
        _overseas_cache["data"] = {
            "generatedAt": generated_at,
            "usIndices": us_indices,
            "usHot": us_hot,
            "commodities": commodities,
        }
        _overseas_cache["ts"] = now
    return _overseas_cache["data"]
# ================= 板块轮动监控（F6-3，2026-09-19） =================
# 东财行业板块（m:90 t:2）四个能力：涨跌排行 / 资金流排行 / 成分股 / 板块日 K + 个股→板块共振。
# 数据源说明（2026-09-19 实测 akshare 1.18.94）：
# - 排行/资金流/成分股本质是东财 clist 翻页接口（push2）。AKShare 封装（stock_board_industry_name_em /
#   stock_sector_fund_flow_rank / stock_board_industry_cons_em）会丢弃本项目需要的字段
#   （成交额/领涨股代码/板块代码等），故按 AKShare 同参数同字段**直连 clist** 实现，
#   宿主降级链 push2 → push2delay（同构延时镜像，约延时 15 分钟，响应带 source 标注，同 /profile 先例）。
# - 板块日 K 走 AKShare stock_board_industry_hist_em（push2his kline，secid=90.{BK代码}），
#   支持直接传 BK 代码（跳过其内部名称→代码解析，省一次排行表请求）。
# - 个股所属行业复用 /profile 端点（含自身降级链与 24h 缓存），再与排行表匹配。
# 缓存：排行/资金流 60s（盘中实时变动），成分股/板块日 K 10min。

_PUSH2_CLIST_HOSTS = ("https://push2.eastmoney.com", "https://push2delay.eastmoney.com")
_PUSH2_HEADERS = {
    "Referer": "https://quote.eastmoney.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
}
_CLIST_MAX_PAGES = 8  # 行业板块全量约 500 行（含多级行业），pz=100 需 5 页；留余量防膨胀死循环


def _clist_paginated(params: dict):
    """东财 clist 全量翻页（push2 主宿主 → push2delay 延时镜像降级）。
    返回 (rows: list[dict], host: str)；两宿主都失败抛最后一个异常。
    np=1 时 data.diff 为数组；翻页间隔 0.3s 防触发东财 IP 限流（见 PITFALLS 东财条目）。"""
    last_err = None
    for host in _PUSH2_CLIST_HOSTS:
        try:
            rows: list = []
            page = 1
            while True:
                p = dict(params)
                p["pn"] = str(page)
                r = requests.get(
                    f"{host}/api/qt/clist/get", params=p, headers=_PUSH2_HEADERS, timeout=15
                )
                r.raise_for_status()
                data = r.json().get("data")
                if not isinstance(data, dict) or not isinstance(data.get("diff"), list):
                    break
                rows.extend(data["diff"])
                total = int(data.get("total") or 0)
                if not data["diff"] or len(rows) >= total or page >= _CLIST_MAX_PAGES:
                    break
                page += 1
                time.sleep(0.3)
            if not rows:
                raise ValueError("clist 返回空数据")
            return rows, host
        except Exception as e:
            last_err = e
            logger.warning("clist 宿主失败，尝试下一宿主: host=%s err=%s", host, e)
    raise last_err if last_err is not None else ValueError("clist 无可用宿主")


def _clist_source(host: str) -> str:
    """响应数据源标注：push2delay 为延时镜像（约 15 分钟），前端据此标注。"""
    return "eastmoney-delay" if "push2delay" in host else "eastmoney"


def _f_int(v):
    """家数类整数字段：'-'/非法 -> None，否则 int（不经 float 输出 16.0 这种值）。"""
    f = _f_opt(v)
    return None if f is None else int(f)


# --- 行业板块涨跌排行（缓存 60s；/sectors/rank 与名称→代码解析、of-stock 共振共用） ---
# 参数与 AKShare stock_board_industry_name_em 一致（fs=m:90 t:2 f:!50，按 f3 涨跌幅降序），
# 字段在 AKShare 基础上多取 f6 成交额 / f140 领涨股代码（AKShare 封装丢弃了这两列）。
_SECTOR_RANK_FIELDS = "f2,f3,f4,f5,f6,f8,f12,f14,f20,f104,f105,f128,f136,f140"
_sector_rank_cache: dict = {"ts": 0.0, "data": None}
_SECTOR_RANK_TTL = 60


def _sector_rank_item(row: dict, idx: int) -> dict:
    lead = row.get("f128")
    lead_code = row.get("f140")
    return {
        "rank": idx + 1,  # 按涨跌幅降序的 1 起始名次
        "code": str(row.get("f12") or ""),
        "name": str(row.get("f14") or ""),
        "price": _f_opt(row.get("f2")),
        "changePct": _f_opt(row.get("f3")),
        "change": _f_opt(row.get("f4")),
        "amount": _f_opt(row.get("f6")),  # 成交额（元）
        "turnover": _f_opt(row.get("f8")),
        "totalMarketCap": _f_opt(row.get("f20")),
        "upCount": _f_int(row.get("f104")),
        "downCount": _f_int(row.get("f105")),
        "leadStock": None if lead in (None, "-") else str(lead),
        "leadStockCode": None if lead_code in (None, "-") else str(lead_code),
        "leadStockChangePct": _f_opt(row.get("f136")),
    }


async def _load_sector_rank() -> dict:
    """行业板块涨跌排行全量表（涨跌幅降序），进程内缓存 60s。返回 {source, items}。"""
    now = time.time()
    if _sector_rank_cache["data"] is None or now - _sector_rank_cache["ts"] > _SECTOR_RANK_TTL:
        rows, host = await run_ak(
            _clist_paginated,
            {
                "pz": "100",
                "po": "1",
                "np": "1",
                "fltt": "2",
                "invt": "2",
                "fid": "f3",
                "fs": "m:90 t:2 f:!50",
                "ut": "bd1d9ddb04089700cf9c27f6f7426281",
                "fields": _SECTOR_RANK_FIELDS,
            },
        )
        _sector_rank_cache["data"] = {
            "source": _clist_source(host),
            "items": [_sector_rank_item(r, i) for i, r in enumerate(rows)],
        }
        _sector_rank_cache["ts"] = now
    return _sector_rank_cache["data"]


@app.get("/sectors/rank")
async def sector_rank(limit: int = Query(default=30, ge=1, le=500)):
    """行业板块涨跌排行（涨跌幅降序）。返回 {source, items: SectorRankItem[]}，
    缓存 60s。source=eastmoney-delay 表示来自延时镜像（约 15 分钟）。"""
    try:
        data = await _load_sector_rank()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"行业板块排行获取失败: {e}")
    return {"source": data["source"], "items": data["items"][:limit]}


# --- 板块资金流排行（今日主力净流入降序，缓存 60s） ---
# 参数与 AKShare stock_sector_fund_flow_rank(indicator="今日", sector_type="行业资金流") 一致
# （fid0=f62 按主力净流入排序、stat=1）；该 AKShare 封装的输出丢弃板块代码，故直连 clist。
_SECTOR_FF_FIELDS = "f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f204,f205"
_sector_ff_cache: dict = {"ts": 0.0, "data": None}
_SECTOR_FF_TTL = 60


def _sector_ff_item(row: dict, idx: int) -> dict:
    top = row.get("f204")
    top_code = row.get("f205")
    return {
        "rank": idx + 1,  # 按今日主力净流入降序的 1 起始名次
        "code": str(row.get("f12") or ""),
        "name": str(row.get("f14") or ""),
        "price": _f_opt(row.get("f2")),
        "changePct": _f_opt(row.get("f3")),
        "mainNetInflow": _f_opt(row.get("f62")),        # 主力净流入（元）
        "mainNetInflowPct": _f_opt(row.get("f184")),    # 主力净占比（%）
        "superLargeNetInflow": _f_opt(row.get("f66")),
        "superLargeNetInflowPct": _f_opt(row.get("f69")),
        "largeNetInflow": _f_opt(row.get("f72")),
        "largeNetInflowPct": _f_opt(row.get("f75")),
        "mediumNetInflow": _f_opt(row.get("f78")),
        "mediumNetInflowPct": _f_opt(row.get("f81")),
        "smallNetInflow": _f_opt(row.get("f84")),
        "smallNetInflowPct": _f_opt(row.get("f87")),
        "topStock": None if top in (None, "-") else str(top),  # 主力净流入最大个股
        "topStockCode": None if top_code in (None, "-") else str(top_code),
    }


async def _load_sector_fund_flow() -> dict:
    """行业板块今日资金流排行（主力净流入降序），进程内缓存 60s。返回 {source, items}。"""
    now = time.time()
    if _sector_ff_cache["data"] is None or now - _sector_ff_cache["ts"] > _SECTOR_FF_TTL:
        rows, host = await run_ak(
            _clist_paginated,
            {
                "pz": "100",
                "po": "1",
                "np": "1",
                "fltt": "2",
                "invt": "2",
                "fid0": "f62",
                "stat": "1",
                "fs": "m:90 t:2",
                "ut": "b2884a393a59ad64002292a3e90d46a5",
                "fields": _SECTOR_FF_FIELDS,
            },
        )
        _sector_ff_cache["data"] = {
            "source": _clist_source(host),
            "items": [_sector_ff_item(r, i) for i, r in enumerate(rows)],
        }
        _sector_ff_cache["ts"] = now
    return _sector_ff_cache["data"]


@app.get("/sectors/fund-flow")
async def sector_fund_flow(limit: int = Query(default=30, ge=1, le=500)):
    """行业板块资金流排行（今日主力净流入降序）。返回 {source, items: SectorFundFlowItem[]}，
    缓存 60s。"""
    try:
        data = await _load_sector_fund_flow()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"板块资金流排行获取失败: {e}")
    return {"source": data["source"], "items": data["items"][:limit]}


# --- 板块名称→代码解析（成分股/板块日 K 共用） ---
def _norm_board_name(s: str) -> str:
    """板块名归一化：去掉尾部罗马数字行业级别后缀（Ⅰ/Ⅱ/Ⅲ/I/II/III），用于模糊兜底匹配。
    东财多级行业同名不同级（如"白酒Ⅱ"），精确匹配优先，归一化只作兜底。"""
    return re.sub(r"(?:Ⅰ|Ⅱ|Ⅲ|IV|V|I{1,3})$", "", (s or "").strip())


async def _resolve_board(name: str) -> tuple:
    """板块名称或 BK 代码 → (code, name)。BK 代码直传时仍尝试从排行表反查名称
    （排行表失败不阻塞，退回代码占位）；名称经排行表精确匹配，匹配不上按归一化名兜底。
    未匹配抛 404。"""
    name = name.strip()
    if re.fullmatch(r"BK\d{4}", name):
        try:
            hit = next(
                (it for it in (await _load_sector_rank())["items"] if it["code"] == name), None
            )
            if hit is not None:
                return hit["code"], hit["name"]
        except Exception as e:
            logger.warning("BK 代码反查名称失败（用代码占位）: %s err=%s", name, e)
        return name, name
    rank_data = await _load_sector_rank()
    items = rank_data["items"]
    hit = next((it for it in items if it["name"] == name), None)
    if hit is None:
        norm = _norm_board_name(name)
        hit = next((it for it in items if _norm_board_name(it["name"]) == norm), None)
    if hit is None:
        raise HTTPException(status_code=404, detail=f"未找到行业板块: {name}")
    return hit["code"], hit["name"]


# --- 板块成分股（缓存 10min） ---
_SECTOR_CONS_FIELDS = "f12,f14,f2,f3,f4,f5,f6,f7,f8,f9,f23"
_sector_cons_cache: dict = {}  # 板块代码 -> {"ts": float, "data": dict}
_SECTOR_CONS_TTL = 10 * 60


def _sector_cons_item(row: dict) -> dict:
    return {
        "code": str(row.get("f12") or ""),
        "name": str(row.get("f14") or ""),
        "price": _f_opt(row.get("f2")),
        "changePct": _f_opt(row.get("f3")),
        "change": _f_opt(row.get("f4")),
        "volume": _f_opt(row.get("f5")),   # 成交量（手）
        "amount": _f_opt(row.get("f6")),   # 成交额（元）
        "amplitude": _f_opt(row.get("f7")),
        "turnover": _f_opt(row.get("f8")),
        "peDynamic": _f_opt(row.get("f9")),
        "pb": _f_opt(row.get("f23")),
    }


@app.get("/sectors/cons")
async def sector_cons(name: str = Query(min_length=1), limit: int = Query(default=50, ge=1, le=500)):
    """板块成分股（涨跌幅降序）。name 支持板块名称或 BK 代码。
    返回 {code, name, source, items: SectorConsItem[]}，按板块缓存 10min。"""
    code, board_name = await _resolve_board(name)
    hit = _sector_cons_cache.get(code)
    if hit is None or time.time() - hit["ts"] > _SECTOR_CONS_TTL:
        try:
            rows, host = await run_ak(
                _clist_paginated,
                {
                    "pz": "100",
                    "po": "1",
                    "np": "1",
                    "fltt": "2",
                    "invt": "2",
                    "fid": "f3",
                    "fs": f"b:{code} f:!50",
                    "ut": "bd1d9ddb04089700cf9c27f6f7426281",
                    "fields": _SECTOR_CONS_FIELDS,
                },
            )
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"板块成分股获取失败: {e}")
        hit = {
            "ts": time.time(),
            "data": {
                "code": code,
                "name": board_name,
                "source": _clist_source(host),
                "items": [_sector_cons_item(r) for r in rows],
            },
        }
        _sector_cons_cache[code] = hit
    d = hit["data"]
    return {"code": d["code"], "name": d["name"], "source": d["source"], "items": d["items"][:limit]}


# --- 板块日 K 走势（AKShare stock_board_industry_hist_em，push2his；缓存 10min） ---
_sector_hist_cache: dict = {}  # f"{code}:{days}" -> {"ts": float, "data": dict}
_SECTOR_HIST_TTL = 10 * 60


@app.get("/sectors/history")
async def sector_history(name: str = Query(min_length=1), days: int = Query(default=120, ge=1, le=500)):
    """板块日 K 走势（日期升序，尾部 days 条）。name 支持板块名称或 BK 代码。
    返回 {code, name, source, bars: HistoryBar[]}（bars 结构与 /history 一致）。
    AKShare stock_board_industry_hist_em 支持直传 BK 代码（跳过其内部名称解析）。"""
    code, board_name = await _resolve_board(name)
    key = f"{code}:{days}"
    hit = _sector_hist_cache.get(key)
    if hit is None or time.time() - hit["ts"] > _SECTOR_HIST_TTL:
        end = datetime.now().strftime("%Y%m%d")
        start = (datetime.now() - timedelta(days=days * 2)).strftime("%Y%m%d")
        try:
            df = await run_ak(
                ak.stock_board_industry_hist_em,
                symbol=code,
                start_date=start,
                end_date=end,
                period="日k",
                adjust="",
            )
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"板块历史行情获取失败: {e}")
        # 列名与个股 /history 东财源一致（日期/开盘/收盘/最高/最低/成交量/涨跌幅/成交额/换手率），
        # 直接复用同一套归一化
        bars = _hist_items(
            df,
            days,
            {"date": "日期", "open": "开盘", "close": "收盘",
             "high": "最高", "low": "最低", "volume": "成交量", "changePct": "涨跌幅",
             "amount": "成交额", "turnover": "换手率"},
        )
        if not bars:
            raise HTTPException(status_code=502, detail=f"板块历史行情为空: {board_name}")
        hit = {
            "ts": time.time(),
            "data": {"code": code, "name": board_name, "source": "eastmoney", "bars": bars},
        }
        _sector_hist_cache[key] = hit
    return hit["data"]


# --- 个股→板块共振：个股所属行业在当日板块涨跌/资金流排行中的位置 ---
@app.get("/sectors/of-stock/{code}")
async def sector_of_stock(code: str):
    """个股所属行业板块共振信息。返回 {code, name, industry, matched, sector, source}。
    行业取自 /profile（东财行业分类，与板块排行同源口径）；行业缺失或排行表无同名板块时
    返回 matched=false 的结构化响应（不报错）。sector 含涨跌名次 rank/total 与资金流名次
    fundFlowRank/fundFlowTotal（资金流排行失败时仅省略资金流字段，独立降级）。"""
    if not re.fullmatch(r"\d{6}", code):
        raise HTTPException(status_code=400, detail="code 必须是 6 位数字")
    # 复用 /profile 端点（含 push2 → push2delay 降级链与 24h 缓存）
    prof = await profile(code)
    industry = prof.get("industry")
    result: dict = {
        "code": code,
        "name": prof.get("name"),
        "industry": industry,
        "matched": False,
        "sector": None,
    }
    if not industry:
        return result
    try:
        rank_data = await _load_sector_rank()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"板块排行获取失败: {e}")
    items = rank_data["items"]
    hit = next((it for it in items if it["name"] == industry), None)
    if hit is None:
        norm = _norm_board_name(industry)
        hit = next((it for it in items if _norm_board_name(it["name"]) == norm), None)
    if hit is None:
        return result  # 结构化"未匹配"：排行表无该行业同名板块
    sector: dict = {
        "code": hit["code"],
        "name": hit["name"],
        "rank": hit["rank"],
        "total": len(items),
        "changePct": hit["changePct"],
        "upCount": hit["upCount"],
        "downCount": hit["downCount"],
    }
    # 资金流名次独立降级：失败不影响涨跌名次返回
    try:
        ff_items = (await _load_sector_fund_flow())["items"]
        ff_hit = next((it for it in ff_items if it["code"] == hit["code"]), None)
        if ff_hit is not None:
            sector["fundFlowRank"] = ff_hit["rank"]
            sector["fundFlowTotal"] = len(ff_items)
            sector["mainNetInflow"] = ff_hit["mainNetInflow"]
            sector["mainNetInflowPct"] = ff_hit["mainNetInflowPct"]
    except Exception as e:
        logger.warning("of-stock 资金流排行失败（仅省略资金流字段）: code=%s err=%s", code, e)
    result["matched"] = True
    result["sector"] = sector
    result["source"] = rank_data["source"]
    return result
# ================= K 线形态识别 + 历史成绩单（F6-1，2026-09-19） =================
# 全部纯本地计算（基于 _load_bars 的前复权日 K，与 /history、/indicators 同源同降级链），
# 无新外部依赖。形态库 17 种（定义清晰优先于数量，拿不准定义的形态宁可不做）：
#   K 线组合类（11）：十字星、锤子线、上吊线、看涨吞没、看跌吞没、早晨之星、黄昏之星、
#     乌云盖顶、刺透形态、红三兵、三只乌鸦
#   价格结构类（6）：双底、双顶、头肩底、头肩顶、上升三角形、下降三角形
# 检测无未来函数：任一形态在第 i 根 K 线的判定只用 <= i 的数据（背景趋势以信号日前一日为锚）。
# 红线：统计为"历史事实"口径（过去每次出现后 5/10/20 个交易日的实际走势汇总），
# 不含任何预测与买卖建议；响应带 disclaimer，展示层必须保留。

# ---- 单根 K 线特征与背景趋势 ----

def _body(o, c, i):
    return abs(c[i] - o[i])


def _rng(h, l, i):
    return h[i] - l[i]


def _upper_shadow(o, h, c, i):
    return h[i] - max(o[i], c[i])


def _lower_shadow(o, l, c, i):
    return min(o[i], c[i]) - l[i]


def _trend5(c, i):
    """信号日前 5 个交易日累计涨跌幅（只用 <= i-1 的数据）；数据不足返回 None。"""
    if i - 6 < 0:
        return None
    prev = c[i - 6]
    if prev <= 0:
        return None
    return c[i - 1] / prev - 1


# ---- K 线组合类检测器（签名统一为 (o, h, l, c, i) -> bool） ----

def _is_doji(o, h, l, c, i):
    """十字星（中性）：实体 <= 全日振幅 10%，且全日振幅 >= 收盘 1%（过滤无意义的极小 K 线）。"""
    r = _rng(h, l, i)
    if r <= 0 or c[i] <= 0:
        return False
    return _body(o, c, i) <= 0.1 * r and r >= 0.01 * c[i]


def _pin_shape(o, h, l, c, i):
    """锤子/上吊共用形状：实体 >= 振幅 5%（排除十字星），下影线 >= 2 倍实体，上影线 <= 0.5 倍实体。"""
    r = _rng(h, l, i)
    b = _body(o, c, i)
    if r <= 0 or b < 0.05 * r:
        return False
    return _lower_shadow(o, l, c, i) >= 2 * b and _upper_shadow(o, h, c, i) <= 0.5 * b


def _is_hammer(o, h, l, c, i):
    """锤子线（看涨）：下跌背景（前 5 日累计下跌）中出现钉子形状。"""
    t = _trend5(c, i)
    return t is not None and t < 0 and _pin_shape(o, h, l, c, i)


def _is_hanging_man(o, h, l, c, i):
    """上吊线（看跌）：上涨背景中出现钉子形状。"""
    t = _trend5(c, i)
    return t is not None and t > 0 and _pin_shape(o, h, l, c, i)


def _is_bull_engulf(o, h, l, c, i):
    """看涨吞没（看涨）：下跌背景；前一根阴线、当日阳线，当日实体完全包住前一根实体且更大。"""
    if i < 1:
        return False
    t = _trend5(c, i)
    if t is None or t >= 0:
        return False
    if not (c[i - 1] < o[i - 1] and c[i] > o[i]):
        return False
    b1, b2 = _body(o, c, i - 1), _body(o, c, i)
    if b1 <= 0 or b2 <= b1:
        return False
    return o[i] <= c[i - 1] and c[i] >= o[i - 1]


def _is_bear_engulf(o, h, l, c, i):
    """看跌吞没（看跌）：上涨背景；前一根阳线、当日阴线，当日实体完全包住前一根实体且更大。"""
    if i < 1:
        return False
    t = _trend5(c, i)
    if t is None or t <= 0:
        return False
    if not (c[i - 1] > o[i - 1] and c[i] < o[i]):
        return False
    b1, b2 = _body(o, c, i - 1), _body(o, c, i)
    if b1 <= 0 or b2 <= b1:
        return False
    return o[i] >= c[i - 1] and c[i] <= o[i - 1]


def _is_morning_star(o, h, l, c, i):
    """早晨之星（看涨，3 根）：下跌背景（以首根为锚）；首根大阴线（实体 >= 振幅 50%）；
    次根星线（实体 <= 振幅 30%，实体整体低于首根收盘）；末根阳线收复首根实体中点以上。"""
    if i < 2:
        return False
    t = _trend5(c, i - 2)
    if t is None or t >= 0:
        return False
    r1 = _rng(h, l, i - 2)
    b1 = o[i - 2] - c[i - 2]
    if r1 <= 0 or b1 < 0.5 * r1:
        return False
    r2 = _rng(h, l, i - 1)
    if r2 <= 0 or _body(o, c, i - 1) > 0.3 * r2:
        return False
    if max(o[i - 1], c[i - 1]) > c[i - 2]:
        return False
    if c[i] <= o[i]:
        return False
    return c[i] > (o[i - 2] + c[i - 2]) / 2


def _is_evening_star(o, h, l, c, i):
    """黄昏之星（看跌，3 根）：早晨之星的镜像（上涨背景，首根大阳线，末根阴线跌破首根实体中点）。"""
    if i < 2:
        return False
    t = _trend5(c, i - 2)
    if t is None or t <= 0:
        return False
    r1 = _rng(h, l, i - 2)
    b1 = c[i - 2] - o[i - 2]
    if r1 <= 0 or b1 < 0.5 * r1:
        return False
    r2 = _rng(h, l, i - 1)
    if r2 <= 0 or _body(o, c, i - 1) > 0.3 * r2:
        return False
    if min(o[i - 1], c[i - 1]) < c[i - 2]:
        return False
    if c[i] >= o[i]:
        return False
    return c[i] < (o[i - 2] + c[i - 2]) / 2


def _is_dark_cloud(o, h, l, c, i):
    """乌云盖顶（看跌，2 根）：上涨背景；前一根大阳线；当日高开于前高之上、
    收盘深入前一根实体中点以下但未吞没（仍高于前一根开盘）。"""
    if i < 1:
        return False
    t = _trend5(c, i)
    if t is None or t <= 0:
        return False
    r1 = _rng(h, l, i - 1)
    b1 = c[i - 1] - o[i - 1]
    if r1 <= 0 or b1 < 0.5 * r1:
        return False
    mid = (o[i - 1] + c[i - 1]) / 2
    return o[i] > h[i - 1] and c[i] < mid and c[i] > o[i - 1]


def _is_piercing(o, h, l, c, i):
    """刺透形态（看涨，2 根）：乌云盖顶镜像（下跌背景，前一根大阴线，当日低开于前低之下、
    收盘升入前一根实体中点以上但未吞没）。"""
    if i < 1:
        return False
    t = _trend5(c, i)
    if t is None or t >= 0:
        return False
    r1 = _rng(h, l, i - 1)
    b1 = o[i - 1] - c[i - 1]
    if r1 <= 0 or b1 < 0.5 * r1:
        return False
    mid = (o[i - 1] + c[i - 1]) / 2
    return o[i] < l[i - 1] and c[i] > mid and c[i] < o[i - 1]


def _is_three_soldiers(o, h, l, c, i):
    """红三兵（看涨，3 根）：三根实体饱满的阳线（实体 >= 振幅 50%），收盘逐级抬高，
    后两根开盘在前一根实体之内。"""
    if i < 2:
        return False
    for j in (i - 2, i - 1, i):
        r = _rng(h, l, j)
        if r <= 0 or c[j] - o[j] < 0.5 * r:
            return False
    if not (c[i - 2] < c[i - 1] < c[i]):
        return False
    return o[i - 2] <= o[i - 1] <= c[i - 2] and o[i - 1] <= o[i] <= c[i - 1]


def _is_three_crows(o, h, l, c, i):
    """三只乌鸦（看跌，3 根）：红三兵镜像（三根饱满阴线，收盘逐级降低，后两根开盘在前一根实体内）。"""
    if i < 2:
        return False
    for j in (i - 2, i - 1, i):
        r = _rng(h, l, j)
        if r <= 0 or o[j] - c[j] < 0.5 * r:
            return False
    if not (c[i - 2] > c[i - 1] > c[i]):
        return False
    return c[i - 2] <= o[i - 1] <= o[i - 2] and c[i - 1] <= o[i] <= o[i - 1]


# ---- 价格结构类检测器 ----

def _fractals(vals, lo, hi, kind, w=2):
    """[lo, hi) 内的分形点下标：±w 窗口严格局部极值（并列极值不取）。
    右边界自动留 w 根确认（信号日附近的分形点要 w 根后才能确认，天然防未来函数）。"""
    out = []
    for k in range(lo + w, min(hi, len(vals)) - w):
        seg = vals[k - w: k + w + 1]
        if kind == "low" and vals[k] == min(seg) and seg.count(vals[k]) == 1:
            out.append(k)
        elif kind == "high" and vals[k] == max(seg) and seg.count(vals[k]) == 1:
            out.append(k)
    return out


def _is_double_bottom(o, h, l, c, i, window=60):
    """双底（看涨）：近 60 根内两个分形低点价差 <= 3%、间隔 >= 10 根，且底部不高于窗口最低价
    3%（即须为窗口内的显著底部）；其间反弹高点（颈线）高出底部 >= 5%；右底之后未再跌破底部
    （容差 1%）；信号日 = 收盘首次站上颈线。"""
    if i < 30:
        return False
    lo = max(0, i - window + 1)
    win_low = min(l[lo: i + 1])
    if win_low <= 0:
        return False
    fracs = _fractals(l, lo, i, "low")
    for a_i, t1 in enumerate(fracs):
        for t2 in fracs[a_i + 1:]:
            if t2 - t1 < 10:
                continue
            base = min(l[t1], l[t2])
            if base <= 0 or abs(l[t1] - l[t2]) / base > 0.03:
                continue
            if base > win_low * 1.03:
                continue  # 底部须接近窗口最低点（显著底部，防普通波动误判）
            neck = max(h[t1 + 1: t2])
            if neck < max(l[t1], l[t2]) * 1.05:
                continue
            if t2 + 1 < i and min(l[t2 + 1: i]) < base * 0.99:
                continue
            if c[i] > neck and c[i - 1] <= neck:
                return True
    return False


def _is_double_top(o, h, l, c, i, window=60):
    """双顶（看跌）：双底镜像——两个分形高点价差 <= 3%、间隔 >= 10 根，且顶部不低于窗口最高
    价的 3%（显著顶部）；其间回落低点（颈线）低于顶部 >= 5%；右顶之后未再突破顶部
    （容差 1%）；信号日 = 收盘首次跌破颈线。"""
    if i < 30:
        return False
    lo = max(0, i - window + 1)
    win_high = max(h[lo: i + 1])
    if win_high <= 0:
        return False
    fracs = _fractals(h, lo, i, "high")
    for a_i, t1 in enumerate(fracs):
        for t2 in fracs[a_i + 1:]:
            if t2 - t1 < 10:
                continue
            top = max(h[t1], h[t2])
            if top <= 0 or abs(h[t1] - h[t2]) / top > 0.03:
                continue
            if top < win_high * 0.97:
                continue  # 顶部须接近窗口最高点
            neck = min(l[t1 + 1: t2])
            if neck > min(h[t1], h[t2]) * 0.95:
                continue
            if t2 + 1 < i and max(h[t2 + 1: i]) > top * 1.01:
                continue
            if c[i] < neck and c[i - 1] >= neck:
                return True
    return False


def _is_inv_head_shoulders(o, h, l, c, i, window=90):
    """头肩底（看涨）：近 90 根内三个分形低点 左肩-头-右肩：头即窗口最低点（显著头部），
    双肩各比头高 >= 0.5% 且相互价差 <= 5%；颈线取两段反弹高点的较低者（保守水平线），
    头到颈线深度 >= 5%；右肩之后未再破头；信号日 = 收盘首次站上颈线。"""
    if i < 40:
        return False
    lo = max(0, i - window + 1)
    win_low = min(l[lo: i + 1])
    lows = _fractals(l, lo, i, "low")
    for a in range(len(lows)):
        for b in range(a + 1, len(lows)):
            for d in range(b + 1, len(lows)):
                s1, hd, s2 = lows[a], lows[b], lows[d]
                if l[hd] != win_low:
                    continue  # 头必须是窗口最低点（显著头部，防普通三段波动误判）
                if not (l[hd] < l[s1] * 0.995 and l[hd] < l[s2] * 0.995):
                    continue
                if min(l[s1], l[s2]) <= 0 or abs(l[s1] - l[s2]) / min(l[s1], l[s2]) > 0.05:
                    continue
                neck = min(max(h[s1: hd + 1]), max(h[hd: s2 + 1]))
                if neck < l[hd] * 1.05:
                    continue
                if s2 + 1 < i and min(l[s2 + 1: i]) < l[hd]:
                    continue
                if c[i] > neck and c[i - 1] <= neck:
                    return True
    return False


def _is_head_shoulders(o, h, l, c, i, window=90):
    """头肩顶（看跌）：头肩底镜像——头即窗口最高点（显著头部），双肩各比头低 >= 0.5% 且
    相互价差 <= 5%；颈线取两段回落低点的较高者，头到颈线深度 >= 5%；右肩之后未再破头；
    信号日 = 收盘首次跌破颈线。"""
    if i < 40:
        return False
    lo = max(0, i - window + 1)
    win_high = max(h[lo: i + 1])
    highs = _fractals(h, lo, i, "high")
    for a in range(len(highs)):
        for b in range(a + 1, len(highs)):
            for d in range(b + 1, len(highs)):
                s1, hd, s2 = highs[a], highs[b], highs[d]
                if h[hd] != win_high:
                    continue  # 头必须是窗口最高点
                if not (h[hd] > h[s1] * 1.005 and h[hd] > h[s2] * 1.005):
                    continue
                if max(h[s1], h[s2]) <= 0 or abs(h[s1] - h[s2]) / max(h[s1], h[s2]) > 0.05:
                    continue
                neck = max(min(l[s1: hd + 1]), min(l[hd: s2 + 1]))
                if neck > h[hd] * 0.95:
                    continue
                if s2 + 1 < i and max(h[s2 + 1: i]) > h[hd]:
                    continue
                if c[i] < neck and c[i - 1] >= neck:
                    return True
    return False


def _is_asc_triangle(o, h, l, c, i, window=40):
    """上升三角形（看涨）：近 40 根内最近 2~3 个分形高点近似水平（价差 <= 2%，作压力线），
    最近 2~3 个分形低点逐级抬高（各抬升 >= 0.1%），且低点与压力点交错（收敛形态）；
    信号日 = 收盘首次站上压力线。"""
    if i < 25:
        return False
    lo = max(0, i - window + 1)
    highs = _fractals(h, lo, i, "high")[-3:]
    lows = _fractals(l, lo, i, "low")[-3:]
    if len(highs) < 2 or len(lows) < 2:
        return False
    res = sum(h[k] for k in highs) / len(highs)
    if res <= 0 or max(h[k] for k in highs) > res * 1.02 or min(h[k] for k in highs) < res * 0.98:
        return False
    if not all(l[lows[j + 1]] > l[lows[j]] * 1.001 for j in range(len(lows) - 1)):
        return False
    if lows[-1] < highs[0]:
        return False
    return c[i] > res and c[i - 1] <= res


def _is_desc_triangle(o, h, l, c, i, window=40):
    """下降三角形（看跌）：上升三角形镜像——最近 2~3 个分形低点近似水平（支撑线），
    最近 2~3 个分形高点逐级降低；信号日 = 收盘首次跌破支撑线。"""
    if i < 25:
        return False
    lo = max(0, i - window + 1)
    highs = _fractals(h, lo, i, "high")[-3:]
    lows = _fractals(l, lo, i, "low")[-3:]
    if len(highs) < 2 or len(lows) < 2:
        return False
    sup = sum(l[k] for k in lows) / len(lows)
    if sup <= 0 or max(l[k] for k in lows) > sup * 1.02 or min(l[k] for k in lows) < sup * 0.98:
        return False
    if not all(h[highs[j + 1]] < h[highs[j]] * 0.999 for j in range(len(highs) - 1)):
        return False
    if highs[-1] < lows[0]:
        return False
    return c[i] < sup and c[i - 1] >= sup


_PATTERN_DEFS = [
    {"key": "doji", "name": "十字星", "direction": "中性", "detect": _is_doji},
    {"key": "hammer", "name": "锤子线", "direction": "看涨", "detect": _is_hammer},
    {"key": "hanging_man", "name": "上吊线", "direction": "看跌", "detect": _is_hanging_man},
    {"key": "bull_engulf", "name": "看涨吞没", "direction": "看涨", "detect": _is_bull_engulf},
    {"key": "bear_engulf", "name": "看跌吞没", "direction": "看跌", "detect": _is_bear_engulf},
    {"key": "morning_star", "name": "早晨之星", "direction": "看涨", "detect": _is_morning_star},
    {"key": "evening_star", "name": "黄昏之星", "direction": "看跌", "detect": _is_evening_star},
    {"key": "dark_cloud", "name": "乌云盖顶", "direction": "看跌", "detect": _is_dark_cloud},
    {"key": "piercing", "name": "刺透形态", "direction": "看涨", "detect": _is_piercing},
    {"key": "three_soldiers", "name": "红三兵", "direction": "看涨", "detect": _is_three_soldiers},
    {"key": "three_crows", "name": "三只乌鸦", "direction": "看跌", "detect": _is_three_crows},
    {"key": "double_bottom", "name": "双底", "direction": "看涨", "detect": _is_double_bottom},
    {"key": "double_top", "name": "双顶", "direction": "看跌", "detect": _is_double_top},
    {"key": "inv_head_shoulders", "name": "头肩底", "direction": "看涨", "detect": _is_inv_head_shoulders},
    {"key": "head_shoulders", "name": "头肩顶", "direction": "看跌", "detect": _is_head_shoulders},
    {"key": "asc_triangle", "name": "上升三角形", "direction": "看涨", "detect": _is_asc_triangle},
    {"key": "desc_triangle", "name": "下降三角形", "direction": "看跌", "detect": _is_desc_triangle},
]

_PATTERN_WINDOWS = (5, 10, 20)  # 历史成绩单统计窗口（信号日后 N 个交易日）
_RECENT_BARS = 60               # "近期出现"的窗口（近约 60 个交易日）


def _scan_patterns(bars):
    """逐日扫描全部形态，返回 {pattern_key: [信号日下标, ...]}（下标升序）。"""
    o = [b["open"] for b in bars]
    h = [b["high"] for b in bars]
    l = [b["low"] for b in bars]
    c = [b["close"] for b in bars]
    hits = {d["key"]: [] for d in _PATTERN_DEFS}
    for i in range(len(bars)):
        for d in _PATTERN_DEFS:
            if d["detect"](o, h, l, c, i):
                hits[d["key"]].append(i)
    return hits


def _build_pattern_report(code, source, bars, days):
    """形态扫描 + 历史成绩单组装。
    成绩单口径：对每个信号日 i，取之后第 5/10/20 个交易日的收盘计算涨跌幅（相对信号日收盘），
    窗口内最低价相对信号日收盘的最大跌幅作为"最大回撤"；信号日后不足该窗口的不计入该窗口统计。
    """
    n = len(bars)
    closes = [b["close"] for b in bars]
    lows = [b["low"] for b in bars]
    hits = _scan_patterns(bars)
    out = []
    for d in _PATTERN_DEFS:
        idxs = hits[d["key"]]
        if not idxs:
            continue  # 窗口内从未出现的形态不输出（无统计意义）
        stats = {}
        for w in _PATTERN_WINDOWS:
            rets, dds = [], []
            for i in idxs:
                if i + w >= n or closes[i] <= 0:
                    continue
                rets.append(closes[i + w] / closes[i] - 1)
                dds.append(min(lows[i + 1: i + w + 1]) / closes[i] - 1)
            cnt = len(rets)
            stats[str(w)] = {
                "count": cnt,
                "upRatio": round(sum(1 for r in rets if r > 0) / cnt * 100, 1) if cnt else None,
                "avgRet": round(sum(rets) / cnt * 100, 2) if cnt else None,
                "avgMaxDrawdown": round(sum(dds) / cnt * 100, 2) if cnt else None,
            }
        out.append({
            "key": d["key"],
            "name": d["name"],
            "direction": d["direction"],
            "count": len(idxs),
            "recentDates": [bars[i]["date"] for i in idxs if i >= n - _RECENT_BARS],
            "stats": stats,
        })
    # 排序：最近出现过的在前（按最近一次信号日倒序），其次按历史次数降序
    out.sort(key=lambda p: (hits[p["key"]][-1], p["count"]), reverse=True)
    return {
        "code": code,
        "source": source,
        "days": days,
        "asOf": bars[-1]["date"],
        "patterns": out,
        "disclaimer": "形态统计为历史事实口径（该股过去出现该形态后 5/10/20 个交易日的实际走势汇总），"
                      "不代表未来表现，仅供参考，不构成投资建议。",
    }


# 形态是日频数据，盘后不再变化，按 (code, days) 缓存 6 小时（同 /dividends 的低频口径）
_patterns_cache: dict = {}
_PATTERNS_TTL = 6 * 3600


@app.get("/patterns/{code}")
async def patterns_ep(code: str, days: int = Query(default=750, ge=30, le=1500)):
    """K 线形态识别 + 历史成绩单（F6-1）。返回 {code, source, days, asOf, patterns, disclaimer}。
    patterns 按形态聚合：{key, name, direction(看涨/看跌/中性), count(窗口内出现总次数),
    recentDates(近约 60 个交易日内的信号日), stats: {"5"/"10"/"20": {count, upRatio(%),
    avgRet(%), avgMaxDrawdown(%)}}}；窗口样本不足时该窗口各值为 null。
    纯本地计算（输入为与 /history 同源的前复权日 K），按 (code, days) 缓存 6h。"""
    key = (code, days)
    hit = _patterns_cache.get(key)
    if hit is None or time.time() - hit["ts"] > _PATTERNS_TTL:
        bars, source = await _load_bars(code, days)
        if not bars:
            raise HTTPException(
                status_code=502, detail=f"历史行情为空，无法做形态识别（代码错误或数据源不可用）: {code}"
            )
        try:
            data = _build_pattern_report(code, source, bars, days)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"形态识别计算失败: {e}")
        hit = {"ts": time.time(), "data": data}
        _patterns_cache[key] = hit
    return hit["data"]


# ================= 资金流验货（F6-2，2026-09-21） =================
# "狙击手"模式：对 F6-1 检测出的近期触发形态（近约 60 个交易日信号日），叠加 F3-4 资金流
# 做交叉验证，输出三档结论。实现要点：
# - 形态检测复用 _scan_patterns（与 /patterns 同源同规则）；资金流复用 _get_fund_flow_cached
#   （与 /fund-flow 同缓存同降级链，缓存键独立：资金流按 code、验货按 (code, days)）。
# - 口径为**日级资金流**（每日主力净流入/超大单）：分笔 tick（如 ak.stock_intraday_em）
#   未接入——盘中分笔接口稳定性未验证且验货场景日级已够，"尾盘变化"维度因此缺失，
#   口径说明见 docs/FEATURES.md 第 36 节与 docs/DATA_SOURCES.md。
# - 验货窗口：信号日起往后最多 3 个有资金流数据的交易日（资金流源只含近期约 100 个交易日，
#   早于覆盖范围的信号日判"未覆盖"）。
# - 分档规则（透明客观阈值，与 docs/FEATURES.md / docs/DATA_SOURCES.md 同步）：
#   窗口内取主力净流入（新浪降级源为"净流入"，口径含全部资金）非空的交易日，
#   记 pos=为正日数、neg=为负日数、total=合计额：
#     watch（重点观察）：total 与形态方向同号，且同向日数 > 反向日数（资金流印证形态）
#     doubt（存疑）    ：total 与形态方向反号，且反向日数 > 同向日数（资金流背离形态）
#     neutral（中性）  ：其余（正负交错 / 有效值为 0 个 / 信号日未被资金流覆盖 / 中性形态无方向）
# - 红线：三档结论只描述"资金流是否印证形态信号"这一客观事实，不含买卖建议；
#   响应带 disclaimer，展示层必须保留。

_VERIFY_RECENT_BARS = 60  # 与 F6-1 "近期出现"口径一致（_RECENT_BARS）：只验近 60 个交易日的信号
_VERIFY_WINDOW = 3        # 验货窗口：信号日起往后最多 3 个有资金流数据的交易日

# 验货结果按 (code, days) 缓存 1h：形态是日频信号（盘后不变），资金流盘中会变，
# 1h 兼顾 freshness 与上游压力（资金流本身还有 60s 缓存托底）。
_verify_cache: dict = {}
_VERIFY_TTL = 3600


def _fmt_flow_yuan(v: float) -> str:
    """净流入金额（元）→ 带符号的 亿/万/元 文本。"""
    sign = "+" if v > 0 else "-" if v < 0 else ""
    a = abs(v)
    if a >= 1e8:
        return f"{sign}{a / 1e8:.2f} 亿元"
    if a >= 1e4:
        return f"{sign}{a / 1e4:.2f} 万元"
    return f"{sign}{a:.0f} 元"


def _grade_flow_verdict(direction: str, vals: list):
    """分档规则（口径见本节头注释）。vals = 验货窗口内主力净流入非 None 的值（日期升序）。
    返回 (verdict_key, pos, neg, total)：verdict_key ∈ watch/neutral/doubt。"""
    if direction == "中性":
        return "neutral", 0, 0, None
    pos = sum(1 for v in vals if v > 0)
    neg = sum(1 for v in vals if v < 0)
    if not vals:
        return "neutral", pos, neg, None
    total = sum(vals)
    bull = direction == "看涨"
    # 同号且同向日数占优 → 资金流印证形态（watch）；反号且反向日数占优 → 背离（doubt）；其余中性
    same_sign = (total > 0 and pos > neg) if bull else (total < 0 and neg > pos)
    opp_sign = (total < 0 and neg > pos) if bull else (total > 0 and pos > neg)
    if same_sign:
        return "watch", pos, neg, total
    if opp_sign:
        return "doubt", pos, neg, total
    return "neutral", pos, neg, total


def _verify_signal(sig_date: str, direction: str, ff_by_date: dict, ff_dates: list, label: str) -> dict:
    """单个形态信号的资金流验货：返回 {date, verdict, verdictLabel, basis, windowDates,
    mainNetInflowSum}。label = "主力净流入"（东财源）/ "净流入"（新浪降级源）。"""
    if direction == "中性":
        return {
            "date": sig_date, "verdict": "neutral", "verdictLabel": "中性",
            "basis": "中性形态无方向，不做资金流方向比对",
            "windowDates": [], "mainNetInflowSum": None,
        }
    if sig_date not in ff_by_date:
        return {
            "date": sig_date, "verdict": "neutral", "verdictLabel": "中性",
            "basis": "资金流数据未覆盖该信号日（数据源仅含近期约 100 个交易日）",
            "windowDates": [], "mainNetInflowSum": None,
        }
    idx = ff_dates.index(sig_date)
    window = ff_dates[idx: idx + 1 + _VERIFY_WINDOW]  # 信号日 + 之后最多 3 个交易日
    vals = [ff_by_date[d]["mainNetInflow"] for d in window]
    vals = [v for v in vals if v is not None]
    verdict, pos, neg, total = _grade_flow_verdict(direction, vals)
    k = len(window)
    if total is None:
        basis = f"信号日（{sig_date}）起 {k} 个交易日{label}数值均缺失，无法比对"
    elif verdict == "watch":
        basis = (f"信号日（{sig_date}）起 {k} 个交易日中 {pos} 日{label}为正，"
                 f"合计{_fmt_flow_yuan(total)}，方向与{direction}形态一致")
    elif verdict == "doubt":
        basis = (f"信号日（{sig_date}）起 {k} 个交易日中 {neg} 日{label}为负，"
                 f"合计{_fmt_flow_yuan(total)}，方向与{direction}形态背离")
    else:
        basis = (f"信号日（{sig_date}）起 {k} 个交易日{label}正负交错"
                 f"（为正 {pos} 日 / 为负 {neg} 日，合计{_fmt_flow_yuan(total)}），方向不明确")
    return {
        "date": sig_date, "verdict": verdict,
        "verdictLabel": {"watch": "重点观察", "neutral": "中性", "doubt": "存疑"}[verdict],
        "basis": basis, "windowDates": window,
        "mainNetInflowSum": round(total, 2) if total is not None else None,
    }


async def _build_flow_verify(code: str, days: int) -> dict:
    """资金流验货主流程：形态扫描（复用 F6-1）→ 取近期信号 → 资金流交叉验证（复用 F3-4 取数）。
    无近期信号时不拉资金流（省一次上游请求），flowSource 为 None。"""
    bars, bar_source = await _load_bars(code, days)
    if not bars:
        raise HTTPException(
            status_code=502, detail=f"历史行情为空，无法做资金流验货（代码错误或数据源不可用）: {code}"
        )
    n = len(bars)
    hits = _scan_patterns(bars)
    # 近期信号 = 近 60 个交易日内的信号日，按 (形态, 信号日) 展开
    recent = []
    for d in _PATTERN_DEFS:
        for i in hits[d["key"]]:
            if i >= n - _VERIFY_RECENT_BARS:
                recent.append({"key": d["key"], "name": d["name"], "direction": d["direction"],
                               "date": bars[i]["date"], "_i": i})
    recent.sort(key=lambda s: s["_i"], reverse=True)  # 信号日倒序（最近在前）

    base = {
        "code": code, "days": days, "asOf": bars[-1]["date"],
        "barSource": bar_source, "flowSource": None, "flowNote": None, "signals": [],
        "disclaimer": "资金流验货是形态信号方向与日级资金流方向的客观交叉验证结果，"
                      "不构成买卖建议；仅供参考，不构成投资建议。",
    }
    if not recent:
        return base

    ff = await _get_fund_flow_cached(code)  # 失败（双源不可用）抛 502 结构化错误（同 /fund-flow）
    ff_items = [it for it in ff["items"] if it.get("date")]
    ff_by_date = {it["date"]: it for it in ff_items}
    ff_dates = [it["date"] for it in ff_items]  # 日期升序
    label = "主力净流入" if ff["source"] == "eastmoney" else "净流入"

    signals = []
    for s in recent:
        v = _verify_signal(s["date"], s["direction"], ff_by_date, ff_dates, label)
        signals.append({"key": s["key"], "name": s["name"], "direction": s["direction"], **v})

    base["signals"] = signals
    base["flowSource"] = ff["source"]
    if ff["source"] == "sina":
        base["flowNote"] = ("资金流数据源为新浪财经降级源：仅'净流入/超大单'两档，"
                            "且'净流入'含全部资金，与东财'主力净流入'口径不同，不可跨源对比数值。")
    return base


@app.get("/verify/{code}")
async def verify_ep(code: str, days: int = Query(default=750, ge=30, le=1500)):
    """资金流验货（F6-2）：对近约 60 个交易日的形态信号叠加日级资金流交叉验证。
    返回 {code, days, asOf, barSource, flowSource, flowNote, signals, disclaimer}；
    signals 按信号日倒序，每条 {key, name, direction, date, verdict(watch/neutral/doubt),
    verdictLabel(重点观察/中性/存疑), basis, windowDates, mainNetInflowSum}。
    分档规则为透明客观阈值（见本节头注释与 docs/FEATURES.md 第 36 节）。
    按 (code, days) 缓存 1h。"""
    key = (code, days)
    hit = _verify_cache.get(key)
    if hit is None or time.time() - hit["ts"] > _VERIFY_TTL:
        try:
            data = await _build_flow_verify(code, days)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"资金流验货计算失败: {e}")
        hit = {"ts": time.time(), "data": data}
        _verify_cache[key] = hit
    return hit["data"]


# ================= 本地日 K 库（F5-5，2026-09-21） =================
# 全市场选股扫描（F5-5）的数据底座：baostock 批量日 K → 本地 SQLite（WAL）→ 每日盘后增量更新。
# 为什么不用东财/新浪做批量：东财 push2his 有一分钟内约 10 次请求即 IP 断连限流的前科
# （封禁 45 分钟~1 天以上且间歇性复发，见 docs/PITFALLS.md），新浪不覆盖北交所且同为单票接口；
# baostock 是专为批量历史日 K 设计的免费服务，无此限流（2026-09-21 实测 600519 数值与
# 新浪/东财口径一致）。
# 口径：前复权（adjustflag='2'）；成交量按股返回 ÷100 归一到"手"（与 _hist_items 新浪源
# 同一换算）；amount 元直存；pctChg→change_pct(%)；turn→turnover(%，停牌票为空存 None)。
# 北交所（4/8/920）baostock 不覆盖，票池直接排除（仅沪深，docs/DATA_SOURCES.md 注明）。
# 持久化先例：这是本服务第一个磁盘持久化（此前全部为进程内 dict 缓存）。约定：
# 写只发生在更新线程（单写者 + WAL，扫描读不互堵）；连接 check_same_thread=False。
# 已知口径限制：前复权历史值会随新的除权除息整体平移，增量更新只回退重取最近
# _MB_REFETCH_CAL_DAYS 天，更早期的历史值会逐渐陈旧——扫描只依赖近期约 120 根 bar，
# 影响有限；如需精确请用 full=true 全量回填刷新（docs/DATA_SOURCES.md 已注明）。

import json
import os
import sqlite3
import threading

_MB_DB_PATH = os.environ.get(
    "MARKET_BARS_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "market_bars.db"),
)
_MB_BACKFILL_CAL_DAYS = 1100   # 回填窗口：750 个交易日 ≈ 1100 个日历日（与 /patterns 默认 days=750 对齐）
_MB_REFETCH_CAL_DAYS = 10      # 增量更新向前回退的日历日（覆盖上游小幅修正）
_MB_THROTTLE_SEC = 0.05        # 票与票之间的节流间隔（baostock 无东财式限流，保守取值）
_MB_COMMIT_EVERY = 100         # 每 100 只票一个事务 commit
_MB_WAIT_RETRY_SEC = 1800      # 盘后数据未齐时的重试间隔（30 分钟）
_MB_WAIT_DEADLINE_HOUR = 21    # 盘后等待截止（北京时间 21:00，过时放弃等当日数据）
_MB_TODAY_READY_RATIO = 0.5    # 当日 bar 覆盖率达到该比例才判"今日数据已齐"
_MB_FAILED_KEEP = 200          # 状态里保留的失败名单上限（条）

_BJ_TZ = timezone(timedelta(hours=8))

_mb_conn = None
_mb_write_lock = threading.Lock()


def _mb_db():
    """懒初始化 SQLite 连接并建表（WAL：更新写与扫描读并发不互堵）。"""
    global _mb_conn
    if _mb_conn is None:
        os.makedirs(os.path.dirname(_MB_DB_PATH), exist_ok=True)
        conn = sqlite3.connect(_MB_DB_PATH, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            """CREATE TABLE IF NOT EXISTS bars (
                 code TEXT NOT NULL, date TEXT NOT NULL,
                 open REAL, close REAL, high REAL, low REAL,
                 volume REAL, amount REAL, change_pct REAL, turnover REAL,
                 PRIMARY KEY (code, date)
               ) WITHOUT ROWID"""
        )
        conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
        conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')")
        conn.commit()
        _mb_conn = conn
    return _mb_conn


def _mb_meta_set(key: str, value: str):
    with _mb_write_lock:
        conn = _mb_db()
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value))
        conn.commit()


def _bs_mod():
    """baostock 懒加载：缺依赖只影响扫描底座端点，不拖垮新闻/行情等其它端点。"""
    try:
        import baostock as bs
        return bs
    except ImportError:
        raise RuntimeError("缺少依赖 baostock：请在 data-service 环境执行 pip install -r requirements.txt")


def _bs_code(code: str):
    """6 位代码 → baostock 格式（sh./sz.）；北交所（4/8/920）返回 None（baostock 不覆盖）。"""
    if code.startswith(("4", "8", "920")):
        return None
    return f"sh.{code}" if code.startswith(("6", "9")) else f"sz.{code}"


def _bs_float(s):
    """baostock 数值单元格：空串/None/非法 → None（停牌票的 turn 等），不静默发 0。"""
    if s is None or s == "":
        return None
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _bs_fetch_bars(bs, bs_code: str, start: str, end: str) -> list:
    """单票区间日 K（前复权）。返回 [(date, open, close, high, low, volume手, amount元, change_pct, turnover)]。
    停牌日行 baostock 也会返回（volume=0），保留——用量条件天然不命中，价格条件由扫描侧自行处理。"""
    rs = bs.query_history_k_data_plus(
        bs_code,
        "date,open,high,low,close,volume,amount,turn,pctChg",
        start_date=start, end_date=end, frequency="d", adjustflag="2",
    )
    if rs.error_code != "0":
        raise RuntimeError(f"baostock 查询失败: {rs.error_msg}")
    rows = []
    while rs.next():
        d = rs.get_row_data()
        vol = _bs_float(d[5])
        rows.append((
            d[0],                       # date
            _bs_float(d[1]),            # open
            _bs_float(d[4]),            # close
            _bs_float(d[2]),            # high
            _bs_float(d[3]),            # low
            vol / 100 if vol is not None else None,  # 股 → 手
            _bs_float(d[6]),            # amount（元）
            _bs_float(d[8]),            # pctChg → change_pct（%）
            _bs_float(d[7]),            # turn → turnover（%）
        ))
    return rows


# 更新任务状态（进程内；worker 线程写、HTTP 处理读，标量赋值在 GIL 下安全，failed 列表读取方自行拷贝）
_update_state = {
    "running": False,
    "phase": "idle",       # idle | backfill | incremental | waiting-data | done | failed
    "startedAt": None, "finishedAt": None,
    "total": 0, "done": 0, "failedCount": 0,
    "failed": [],          # [{code, error}]，最多 _MB_FAILED_KEEP 条
    "todayBarsReady": None,
    "lastError": None,
}
_update_task = None  # 保留 asyncio.Task 引用，防 GC 提前回收后台任务


def _mb_pool() -> list:
    """扫描票池：全量 A 股代码表（_load_code_name_table，进程内缓存 24h）剔除北交所。"""
    df = _load_code_name_table()
    codes = []
    for _, row in df.iterrows():
        code = str(row["code"]).zfill(6)
        if _bs_code(code) is not None:
            codes.append(code)
    return codes


def _mb_today_coverage(conn, today: str) -> float:
    """当日有 bar 的票数占库内总票数的比例（盘后数据是否到齐的判断依据）。"""
    total = conn.execute("SELECT COUNT(DISTINCT code) FROM bars").fetchone()[0]
    if not total:
        return 0.0
    got = conn.execute("SELECT COUNT(DISTINCT code) FROM bars WHERE date = ?", (today,)).fetchone()[0]
    return got / total


def _mb_update_pass(conn, bs, codes: list, full: bool, today: str) -> None:
    """单轮过票：断点续跑（每票从本地最后日期回退 _MB_REFETCH_CAL_DAYS 天补起），
    单票失败重试 2 次后记入失败名单继续，绝不中断全量任务。"""
    st = _update_state
    st["done"] = 0
    pending_rows = []
    pending_codes = 0

    def flush(force=False):
        nonlocal pending_codes
        if pending_rows and (force or pending_codes >= _MB_COMMIT_EVERY):
            with _mb_write_lock:
                conn.executemany(
                    "INSERT OR REPLACE INTO bars(code, date, open, close, high, low,"
                    " volume, amount, change_pct, turnover)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    pending_rows,
                )
                conn.commit()
            pending_rows.clear()
            pending_codes = 0

    for code in codes:
        try:
            last = None if full else conn.execute(
                "SELECT MAX(date) FROM bars WHERE code = ?", (code,)
            ).fetchone()[0]
            if last is not None and last >= today:
                st["done"] += 1
                continue  # 已是最新（ISO 日期字符串可直接比较）
            if last is None:
                start = (datetime.now() - timedelta(days=_MB_BACKFILL_CAL_DAYS)).strftime("%Y-%m-%d")
            else:
                start = (datetime.strptime(last, "%Y-%m-%d")
                         - timedelta(days=_MB_REFETCH_CAL_DAYS)).strftime("%Y-%m-%d")
            rows, err = None, None
            for backoff in (0, 2, 5):  # 最多 3 次：首次 + 退避 2s/5s 重试
                if backoff:
                    time.sleep(backoff)
                try:
                    rows = _bs_fetch_bars(bs, _bs_code(code), start, today)
                    err = None
                    break
                except Exception as e:
                    err = e
            if err is not None:
                raise err
            if rows:
                pending_rows.extend((code, *r) for r in rows)
            pending_codes += 1
            st["done"] += 1
            flush()
            time.sleep(_MB_THROTTLE_SEC)
        except Exception as e:
            st["failedCount"] += 1
            if len(st["failed"]) < _MB_FAILED_KEEP:
                st["failed"].append({"code": code, "error": str(e)[:200]})
            logger.warning("market-bars 更新跳过失败票: code=%s err=%s", code, e)
    flush(force=True)


def _mb_update_run(full: bool) -> None:
    """盘后更新主流程（独立线程内执行，不堵事件循环）。含"数据未齐"等待重试循环：
    baostock 当日日 K 通常 17:00-18:00 后才齐，15:40 触发时今日数据可能未到——未齐则
    每 30 分钟重跑一轮增量（已入库票按断点天然跳过），至北京时间 21:00 封顶。"""
    st = _update_state
    st.update({
        "running": True, "phase": "backfill" if full else "incremental",
        "startedAt": datetime.now(_BJ_TZ).isoformat(timespec="seconds"),
        "finishedAt": None, "total": 0, "done": 0, "failedCount": 0,
        "failed": [], "todayBarsReady": None, "lastError": None,
    })
    conn = _mb_db()
    today = datetime.now(_BJ_TZ).strftime("%Y-%m-%d")
    try:
        codes = _mb_pool()
        st["total"] = len(codes)
        bs = _bs_mod()
        # 交易日历失败时降级为"不做等待重试"（单轮跑完即收），不阻断更新本身
        try:
            trade_dates = set(pd.to_datetime(_load_trade_dates()["trade_date"]).dt.strftime("%Y-%m-%d"))
            is_trade_day = today in trade_dates
        except Exception as e:
            logger.warning("交易日历获取失败，本轮不做盘后等待重试: %s", e)
            is_trade_day = False
        while True:
            lg = None
            for attempt in range(3):  # login 失败重试 3 次（间隔 2s），仍失败整任务 failed
                try:
                    lg = bs.login()
                    if lg.error_code == "0":
                        break
                    raise RuntimeError(f"baostock 登录失败: {lg.error_msg}")
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(2)
            try:
                _mb_update_pass(conn, bs, codes, full, today)
            finally:
                bs.logout()  # 等待重试间隔长达 30 分钟，登出避免 socket 被服务端挂死
            full = False  # 重试轮一律增量
            if is_trade_day:
                ratio = _mb_today_coverage(conn, today)
                st["todayBarsReady"] = ratio >= _MB_TODAY_READY_RATIO
                if not st["todayBarsReady"] and datetime.now(_BJ_TZ).hour < _MB_WAIT_DEADLINE_HOUR:
                    st["phase"] = "waiting-data"
                    logger.info("market-bars 当日数据未齐（覆盖率 %.1f%%），%d 分钟后重试",
                                ratio * 100, _MB_WAIT_RETRY_SEC // 60)
                    time.sleep(_MB_WAIT_RETRY_SEC)
                    st["phase"] = "incremental"
                    continue
            break
        last_bar = conn.execute("SELECT MAX(date) FROM bars").fetchone()[0]
        _mb_meta_set("last_update_started", st["startedAt"])
        _mb_meta_set("last_update_finished", datetime.now(_BJ_TZ).isoformat(timespec="seconds"))
        if last_bar:
            _mb_meta_set("last_bar_date", last_bar)
        _mb_meta_set("last_update_failed_codes",
                     json.dumps(st["failed"][:100], ensure_ascii=False))
        st["phase"] = "done"
    except Exception as e:
        st["phase"] = "failed"
        st["lastError"] = str(e)[:300]
        logger.error("market-bars 更新任务失败: %s", e)
    finally:
        st["running"] = False
        st["finishedAt"] = datetime.now(_BJ_TZ).isoformat(timespec="seconds")


@app.post("/market-bars/update")
async def market_bars_update(full: bool = Query(default=False)):
    """触发本地日 K 库更新（后台异步执行）：默认增量（断点续跑），full=true 强制全量回填。
    单飞行：已有任务在跑返回 409。进度查询见 GET /market-bars/status。"""
    global _update_task
    if _update_state["running"]:
        raise HTTPException(status_code=409,
                            detail="更新任务正在进行中，进度见 /market-bars/status")
    _update_task = asyncio.create_task(asyncio.to_thread(_mb_update_run, full))
    return {"started": True, "full": full}


@app.get("/market-bars/status")
def market_bars_status():
    """本地日 K 库状态：更新任务进度（running/phase/done/total/failed）+ 库覆盖情况
    （coverage 票数 / lastBarDate / dbSizeMb）。"""
    out = dict(_update_state)
    out["failed"] = list(_update_state["failed"])  # 拷贝，避免与 worker 线程共享引用
    try:
        conn = _mb_db()
        out["coverage"] = conn.execute("SELECT COUNT(DISTINCT code) FROM bars").fetchone()[0]
        out["lastBarDate"] = conn.execute("SELECT MAX(date) FROM bars").fetchone()[0]
    except Exception as e:
        out["coverage"] = None
        out["lastBarDate"] = None
        out["dbError"] = str(e)[:200]
    try:
        out["dbSizeMb"] = (round(os.path.getsize(_MB_DB_PATH) / 1024 / 1024, 1)
                           if os.path.exists(_MB_DB_PATH) else 0)
    except OSError:
        out["dbSizeMb"] = None
    return out
