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
