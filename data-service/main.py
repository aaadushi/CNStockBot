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
import akshare as ak
import pandas as pd

logger = logging.getLogger("cnstockbot-data")

app = FastAPI(title="CNStockBot Data Service", version="0.1.0")

# AKShare 底层用 requests 且默认无超时；上游挂起会占满 uvicorn 线程池导致全服务无响应。
# 统一在线程池里执行并加整体超时，超时返回 504 而非悬挂（审计 A-506）。
AKSHARE_TIMEOUT = 30  # 秒


async def run_ak(fn, *args, **kwargs):
    """线程池执行 AKShare 同步调用（带超时）。上游异常原样抛出，由端点各自包装。"""
    try:
        return await asyncio.wait_for(asyncio.to_thread(fn, *args, **kwargs), timeout=AKSHARE_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail=f"上游数据源超时（{AKSHARE_TIMEOUT}s 无响应）")


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
async def news(code: str, limit: int = Query(default=10, ge=1, le=50)):
    """个股新闻（东财数据源）。返回 NewsItem[]。"""
    try:
        df = await run_ak(ak.stock_news_em, symbol=code)
        items = []
        for _, row in df.head(limit).iterrows():
            items.append({
                "title": str(row.get("新闻标题", "")),
                "summary": str(row.get("新闻内容", ""))[:120],
                "source": str(row.get("文章来源", "")),
                "url": str(row.get("新闻链接", "")),
                "publishedAt": str(row.get("发布时间", "")),
            })
        return items
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
    """个股公告（巨潮资讯网，交易所正式披露）。返回 Announcement[]。

    category 可选值：年报/半年报/一季报/三季报/业绩预告/权益分派/董事会/股东大会/
    风险提示 等（见 ak.stock_zh_a_disclosure_report_cninfo 文档），空串为全部。
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
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AKShare 公告获取失败: {e}")
    items = []
    for _, row in df.head(limit).iterrows():
        items.append({
            "title": str(row.get("公告标题", "")),
            "publishedAt": str(row.get("公告时间", "")),
            "url": str(row.get("公告链接", "")),
        })
    return items


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

    注意：该接口参数名是 stock 而非 symbol；数值是带"元"后缀和千分位逗号的
    字符串（如 "999,862,000.00元"），原样返回给主服务由 LLM 阅读，不做数值清洗。
    """
    try:
        df = await run_ak(ak.stock_financial_abstract, stock=code)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AKShare 财报获取失败: {e}")
    if df is None or df.empty:
        return []
    # 列名 → 稳定输出字段；新浪若改版缺列则该字段为空串
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
