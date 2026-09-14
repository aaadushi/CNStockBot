"""
CNStockBot 数据微服务：基于 AKShare 的 A 股数据 HTTP 接口。
Node 主服务（src/data/pythonService.ts）通过 HTTP 调用本服务。

启动：
    pip install -r requirements.txt
    uvicorn main:app --host 127.0.0.1 --port 8000

为什么用 Python：A 股免费数据生态（AKShare/Tushare）几乎都在 Python 侧，
包一层 HTTP 比用 Node 逐个逆向东财/新浪接口更稳、更好维护。
"""
from fastapi import FastAPI, HTTPException, Query
from datetime import datetime, timedelta
import akshare as ak

app = FastAPI(title="CNStockBot Data Service", version="0.1.0")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/quote/{code}")
def quote(code: str):
    """个股实时行情快照。字段与 src/data/provider.ts 的 Quote 接口对齐。"""
    try:
        df = ak.stock_bid_ask_em(symbol=code)
        # 返回的是 key-value 两列，转成字典
        kv = dict(zip(df["item"], df["value"]))
        return {
            "code": code,
            "name": str(kv.get("名称", code)),
            "price": float(kv.get("最新", 0) or 0),
            "changePct": float(kv.get("涨跌幅", 0) or 0),
            "prevClose": float(kv.get("昨收", 0) or 0),
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AKShare 行情获取失败: {e}")


@app.get("/news/{code}")
def news(code: str, limit: int = Query(default=10, le=50)):
    """个股新闻（东财数据源）。返回 NewsItem[]。"""
    try:
        df = ak.stock_news_em(symbol=code)
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
def search(keyword: str = Query(min_length=1), limit: int = Query(default=10, le=50)):
    """按名称/代码模糊搜索 A 股，返回 [{code, name}]，按匹配程度排序。"""
    kw = keyword.strip()
    try:
        df = _load_code_name_table()
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
def announcements(
    code: str,
    limit: int = Query(default=10, le=50),
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
        df = ak.stock_zh_a_disclosure_report_cninfo(
            symbol=code,
            market="沪深京",
            category=category,
            start_date=start,
            end_date=end,
        )
    except KeyError:
        # 巨潮接口在"查询结果为空"时部分 AKShare 版本会抛 KeyError，视作空结果
        return []
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


@app.get("/financials/{code}")
def financials(code: str, limit: int = Query(default=4, le=20)):
    """个股财务报表摘要（新浪财经），按报告期倒序返回最近 limit 期。

    注意：该接口参数名是 stock 而非 symbol；数值是带"元"后缀和千分位逗号的
    字符串（如 "999,862,000.00元"），原样返回给主服务由 LLM 阅读，不做数值清洗。
    """
    try:
        df = ak.stock_financial_abstract(stock=code)
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
        items.append({k: str(row.get(col, "") or "") for k, col in col_map.items()})
    return items
