#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🦊 폭스시그널 · 장중 브리핑 (Gemini) → 텔레그램 자동 발송
================================================================
평일 10:00 · 11:00 · 13:00 · 14:00 KST 에 GitHub Actions 가 실행한다.
피클 크레딧을 쓰지 않고, Gemini API + 공개 실측 데이터만으로
정규 브리핑의 70~80% 분량(2,000~3,200자) 장중 브리핑을 만들어
텔레그램 채널(@fox_signal_stock)로 보낸다.

5블록 양식
  📌 한줄 요약            지수·외인 현선물 판정·대장 테마·대응 한 줄
  📊 핵심 지표 & 매크로    코스피·코스닥·선물(베이시스)·등락종목수·상한가·원/달러
  💰 투자자별 수급 & 해석  외인(현물·선물)·기관·개인·프로그램 + 왜/의미 해석
  🔥 주도 테마 & 대장주    300억↑ 실측 대장주·상승률·거래대금·재료 + 빠지는 섹터
  🧭 전망 & 시나리오       지지선 대비 위치 + ① 돌파·유지 ② 박스 ③ 이탈 대응

원칙
  · 실측 팩트만 쓴다. 응답에 없는 숫자는 절대 만들지 않는다(검증기가 막는다).
  · 값이 없으면 "미수신"이라고 적는다(0·추정으로 채우지 않는다).
  · Gemini 가 실패하거나 검증을 통과하지 못하면, 같은 5블록 양식을 실측값으로만
    채운 대체(fallback) 본문을 보내고 헤더에 그 사실을 표기한다.

환경변수 (GitHub Secrets)
  GEMINI_API_KEY        Gemini API 키 (필수)
  TELEGRAM_BOT_TOKEN    텔레그램 봇 토큰 (필수, --dry-run 이면 없어도 됨)
  TELEGRAM_CHAT_ID      채널/채팅 id  예) @fox_signal_stock

사용 예
  python3 scripts/intraday_gemini_telegram.py --dry-run
  python3 scripts/intraday_gemini_telegram.py --dry-run --slot 10:00 --force
  python3 scripts/intraday_gemini_telegram.py --print-facts

데이터 소스
  · https://stock-dashboard-live-6frm.vercel.app/api/tabs-live
      주도 테마·구성종목·300억↑ 대장주·선물(KIS·베이시스)·뉴스·상한가·수급 참고
  · https://polling.finance.naver.com/api/realtime?query=SERVICE_INDEX:KOSPI,KOSDAQ
      코스피·코스닥 지수/등락/시고저/거래대금
  · https://stock-dashboard-live-6frm.vercel.app/api/live-briefing
      (네이버 폴링이 막힌 경우 지수 대체용)
  · https://m.stock.naver.com/api/index/{KOSPI,KOSDAQ}/integration
      전일 종가 · 상승/하락 종목수 · 프로그램 매매
  · https://m.stock.naver.com/api/index/{KOSPI,KOSDAQ,FUT}/trend
      외국인·기관·개인 순매수(현물 억원 / 선물 계약)
  · https://m.stock.naver.com/api/stocks/theme?page=1&pageSize=100
      업종(테마) 등락률 전수 → 받는 쪽 / 빠지는 쪽
  · https://m.stock.naver.com/api/stocks/theme/{no}
      약한 테마의 대표 종목(거래대금)
  · https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&reutersCode=FX_USDKRW
      원/달러 환율
  · public/data/supply-latest.json (있으면)
      외인·기관 순매수/순매도 상위 종목(확정 기준일) — 수급 해석 근거
  · public/data/daily_levels.json (있으면)
      {"date":"2026-11-26","kospi":{"s1":4672.55,"s2":4586.8,"r1":4708.54,"r2":4809,"close":4697.51}}
      없으면 전일 종가를 기준선으로 쓴다.

Gemini 모델
  기본 체인 gemini-3.8-flash → 3.5-flash → 3.1-flash-lite → 3.1-flash-lite-preview.
  2026-11 기준 2.5 계열은 신규 사용자에게 닫혀 있고(404), 3.8/3.5 는 429·503 이 잦아
  실제로는 flash-lite 가 먼저 성공하는 날이 많다. 모두 실패하면 실측 대체 본문으로 보낸다.
"""

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
WEEKDAY_KO = ["월", "화", "수", "목", "금", "토", "일"]

TABS_LIVE_URL = os.environ.get(
    "TABS_LIVE_URL", "https://stock-dashboard-live-6frm.vercel.app/api/tabs-live"
)
NAVER_POLL_URL = "https://polling.finance.naver.com/api/realtime?query="
NAVER_MOBILE = "https://m.stock.naver.com/api/index/"
NAVER_THEME_LIST = "https://m.stock.naver.com/api/stocks/theme?page=1&pageSize=100"
NAVER_THEME_ONE = "https://m.stock.naver.com/api/stocks/theme/"
NAVER_FX_URL = (
    "https://m.stock.naver.com/front-api/marketIndex/prices"
    "?category=exchange&reutersCode=FX_USDKRW"
)
LIVE_BRIEFING_URL = os.environ.get(
    "LIVE_BRIEFING_URL", "https://stock-dashboard-live-6frm.vercel.app/api/live-briefing"
)

CHECKER_URL = "https://hwen21c-tech.github.io/foxsignal-checker/"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

BIG_VALUE_WON = 30_000_000_000  # 300억 — 사용자 확정 기준

DEFAULT_MODELS = [
    "gemini-3.8-flash",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
]
RETRYABLE = {429, 500, 502, 503, 504}

# 텔레그램 한 통 4,096자 · 목표 2,000~3,200자
TG_LIMIT = 4096
BODY_MIN = 1900      # 검증 통과 하한(목표 2,000~3,200자의 5% 여유 — 이보다 짧으면 재작성)
BODY_TARGET_MIN = 2000
BODY_TARGET_MAX = 3200
BODY_MAX = 3900      # 이 위는 잘라서 보내야 하므로 실패로 본다

# 5블록 정식 헤더 — 모델이 흔들려도 이 문구로 고정한다
BLOCK_HEADERS = [
    ("📌", "📌 한줄 요약"),
    ("📊", "📊 핵심 지표 & 매크로"),
    ("💰", "💰 투자자별 수급 & 흐름 해석"),
    ("🔥", "🔥 장중 주도 테마 & 대장주 (300억↑ 실측)"),
    ("🧭", "🧭 오늘 시장 전망 & 시나리오 · 기준선 대응"),
]
REQ_SECTIONS = [h for _, h in BLOCK_HEADERS]


# --------------------------------------------------------------------------- #
# 유틸
# --------------------------------------------------------------------------- #
def log(msg):
    print(msg, flush=True)


def http_json(url, timeout=20, retries=2, headers=None, backoff=2.0):
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode("utf-8", "replace")
            return json.loads(raw)
        except Exception as e:  # noqa: BLE001 — 네트워크/파싱 모두 재시도 대상
            last = e
            if attempt < retries:
                time.sleep(backoff * (attempt + 1))
    raise RuntimeError(f"GET {url[:90]} 실패: {last}")


def fnum(s):
    if s is None:
        return None
    t = str(s).replace(",", "").replace(" ", "").strip()
    t = t.replace("+", "")
    if not t or t in ("-", "."):
        return None
    try:
        v = float(t)
        return v if math.isfinite(v) else None
    except ValueError:
        return None


def sgn(v, dp=0, unit=""):
    if v is None:
        return "미수신"
    sign = "+" if v > 0 else ("-" if v < 0 else "")
    body = f"{abs(v):,.{dp}f}"
    return f"{sign}{body}{unit}"


def pct_text(v):
    if v is None:
        return "미수신"
    sign = "+" if v > 0 else ("" if v == 0 else "-")
    return f"{sign}{abs(v):.2f}%"


def eok_text(v):
    """억원 값 → '1,234억' / '1조 2,345억'"""
    if v is None:
        return "미수신"
    v = round(v)
    if abs(v) >= 10000:
        jo = int(abs(v) // 10000)
        rest = abs(v) % 10000
        sign = "-" if v < 0 else ""
        if rest == 0:
            return f"{sign}{jo}조"
        return f"{sign}{jo}조 {rest:,}억"
    return f"{v:,}억"


def money_text_eok(v_eok):
    if v_eok is None:
        return "미수신"
    if abs(v_eok) >= 10000:
        return eok_text(v_eok)
    if abs(v_eok - round(v_eok)) < 0.05:
        return f"{round(v_eok):,}억"
    return f"{v_eok:,.1f}억"


def won_to_eok(won):
    if won is None:
        return None
    return won / 1e8


def md_date(biz):
    """'20261125' → '11/25' (그 외 형식은 그대로)"""
    s = str(biz or "")
    if len(s) == 8 and s.isdigit():
        return f"{int(s[4:6])}/{int(s[6:8])}"
    return s


# --------------------------------------------------------------------------- #
# 수집
# --------------------------------------------------------------------------- #
def kst_now():
    return datetime.now(KST)


def fetch_tabs_live():
    try:
        return http_json(TABS_LIVE_URL, timeout=35, retries=1), None
    except Exception as e:  # noqa: BLE001
        return None, str(e)


def fetch_index_live():
    url = NAVER_POLL_URL + urllib.parse.quote("SERVICE_INDEX:KOSPI,KOSDAQ") + f"&_={int(time.time() * 1000)}"
    d = http_json(url, timeout=15, retries=2, headers={"Referer": "https://finance.naver.com/"})
    areas = ((d or {}).get("result") or {}).get("areas") or []
    out = {}
    for area in areas:
        for item in area.get("datas") or []:
            code = item.get("cd")
            if code not in ("KOSPI", "KOSDAQ"):
                continue
            out[code] = {
                "price": round(item.get("nv") / 100, 2) if isinstance(item.get("nv"), (int, float)) else None,
                "change": round(item.get("cv") / 100, 2) if isinstance(item.get("cv"), (int, float)) else None,
                "pct": round(float(item.get("cr")), 2) if item.get("cr") is not None else None,
                "open": round(item["ov"] / 100, 2) if item.get("ov") else None,
                "high": round(item["hv"] / 100, 2) if item.get("hv") else None,
                "low": round(item["lv"] / 100, 2) if item.get("lv") else None,
                "volume": (item.get("aq") or 0) * 1000 or None,
                "value_won": (item.get("aa") or 0) * 1e6 or None,
                "market_status": item.get("ms"),
            }
    return out


def fetch_index_via_api():
    """네이버 폴링이 막힌 경우 — 관제탑 /api/live-briefing 의 지수(같은 네이버 실측값)."""
    d = http_json(LIVE_BRIEFING_URL + "?fresh=1", timeout=25, retries=1)
    out = {}
    for r in d.get("indices") or []:
        key = r.get("key")
        if key not in ("KOSPI", "KOSDAQ"):
            continue
        out[key] = {
            "price": r.get("price"),
            "change": r.get("change"),
            "pct": r.get("changePct"),
            "open": r.get("open"),
            "high": r.get("high"),
            "low": r.get("low"),
            "volume": r.get("volume"),
            "value_won": r.get("value"),
            "market_status": r.get("status"),
        }
    return out


def fetch_index_detail(market):
    """integration — 전일 종가·상승/하락 종목수·프로그램 매매"""
    d = http_json(NAVER_MOBILE + market + "/integration", timeout=15, retries=2,
                  headers={"Referer": "https://m.stock.naver.com/"})
    info = {x.get("code"): x.get("value") for x in (d.get("totalInfos") or [])}
    up = d.get("upDownStockInfo") or {}
    prog = d.get("programTrendInfo") or {}
    deal = d.get("dealTrendInfo") or {}
    return {
        "prev_close": fnum(info.get("lastClosePrice")),
        "open": fnum(info.get("openPrice")),
        "high": fnum(info.get("highPrice")),
        "low": fnum(info.get("lowPrice")),
        "value_text": info.get("accumulatedTradingValue"),
        "breadth": {
            "up": fnum(up.get("riseCount")),
            "down": fnum(up.get("fallCount")),
            "flat": fnum(up.get("steadyCount")),
            "upper": fnum(up.get("upperCount")),
            "lower": fnum(up.get("lowerCount")),
        } if up else None,
        "program": {
            "delta": fnum(prog.get("indexDifferenceReal")),
            "bi": fnum(prog.get("indexBiDifferenceReal")),
            "total": fnum(prog.get("indexTotalReal")),
            "bizdate": prog.get("bizdate"),
        } if prog else None,
        "deal_bizdate": deal.get("bizdate"),
    }


def fetch_trend(market):
    d = http_json(NAVER_MOBILE + market + "/trend", timeout=15, retries=2,
                  headers={"Referer": "https://m.stock.naver.com/"})
    return {
        "foreign": fnum(d.get("foreignValue")),
        "organ": fnum(d.get("institutionalValue")),
        "personal": fnum(d.get("personalValue")),
        "bizdate": d.get("bizdate"),
    }


def fetch_fx():
    """원/달러 — 네이버 마켓인덱스(전일·장중 마지막 체결). 실패하면 None."""
    d = http_json(NAVER_FX_URL, timeout=12, retries=1,
                  headers={"Referer": "https://m.stock.naver.com/"})
    rows = (d or {}).get("result") or []
    if not rows:
        raise RuntimeError("fx 응답이 비었습니다")
    r = rows[0]
    price = fnum(r.get("closePrice"))
    if price is None:
        raise RuntimeError("fx 가격 파싱 실패")
    return {
        "name": "원/달러",
        "price": price,
        "change": fnum(r.get("fluctuations")),
        "pct": fnum(r.get("fluctuationsRatio")),
        "traded_date": r.get("localTradedAt") or "",
    }


def fetch_theme_rank():
    d = http_json(NAVER_THEME_LIST, timeout=20, retries=2,
                  headers={"Referer": "https://m.stock.naver.com/"})
    out = []
    for g in d.get("groups") or []:
        rate = fnum(g.get("changeRate"))
        if rate is None:
            continue
        total = fnum(g.get("totalCount"))
        # 장 시작 전에는 전체 0인 빈 껍데기 행이 온다 — 테마로 쓰지 않는다
        if rate == 0 and not total:
            continue
        out.append({
            "no": g.get("no"),
            "name": g.get("name"),
            "pct": rate,
            "total": total,
            "up": fnum(g.get("riseCount")),
            "down": fnum(g.get("fallCount")),
        })
    return out


def fetch_theme_members(theme_no, limit=40):
    d = http_json(f"{NAVER_THEME_ONE}{theme_no}?page=1&pageSize={limit}", timeout=15, retries=1,
                  headers={"Referer": "https://m.stock.naver.com/"})
    rows = []
    for s in d.get("stocks") or []:
        pct = fnum(s.get("fluctuationsRatio"))
        val_m = fnum(s.get("accumulatedTradingValue"))  # 백만원
        if pct is None:
            continue
        rows.append({
            "name": s.get("stockName"),
            "code": s.get("itemCode"),
            "pct": pct,
            "value_eok": (val_m * 1e6) / 1e8 if val_m is not None else None,
        })
    return rows


def read_supply(path):
    """supply-latest.json — 외인·기관 순매수/순매도 상위(확정). 없으면 None."""
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:  # noqa: BLE001
        return None
    g = d.get("groups") or {}

    def grab(key, n):
        rows = []
        for x in (g.get(key) or [])[:n]:
            if not x.get("name"):
                continue
            rows.append({
                "name": x.get("name"),
                "pct": fnum(x.get("pct")),
                "foreign_eok": fnum(x.get("foreignEok")),
                "organ_eok": fnum(x.get("organEok")),
            })
        return rows

    out = {
        "basis_label": d.get("basisLabel"),
        "confirmed": bool(d.get("confirmed")),
        "foreign_buy": grab("foreignBuy", 3),
        "organ_buy": grab("organBuy", 3),
        "foreign_sell": grab("foreignSell", 2),
        "dual_buy": grab("dualBuy", 2),
    }
    if not any(out[k] for k in ("foreign_buy", "organ_buy", "foreign_sell", "dual_buy")):
        return None
    return out


def read_daily_levels(path):
    """public/data/daily_levels.json — 없거나 형식이 다르면 None."""
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:  # noqa: BLE001
        return None
    out = {"date": d.get("date") or d.get("basisDate"), "markets": {}, "source": path,
           "note": d.get("note")}
    markets = d.get("markets") or d
    alias = {"kospi": "코스피", "kosdaq": "코스닥", "코스피": "코스피", "코스닥": "코스닥"}
    for key, name in alias.items():
        node = markets.get(key) if isinstance(markets, dict) else None
        if node is None:
            # 평면 키 (kospi_s1 등) 도 허용
            flat = {}
            for k2, v2 in (markets or {}).items() if isinstance(markets, dict) else []:
                if str(k2).lower().startswith(key + "_"):
                    flat[str(k2).lower()[len(key) + 1:]] = v2
            node = flat or None
        if not isinstance(node, dict):
            continue
        lv = {"s1": None, "s2": None, "r1": None, "r2": None, "close": None}
        for k2, v2 in node.items():
            kk = str(k2).lower()
            num = fnum(v2)
            if num is None:
                continue
            if kk in ("s1", "support1", "first", "1", "l1") and lv["s1"] is None:
                lv["s1"] = num
            elif kk in ("s2", "support2", "second", "2", "l2") and lv["s2"] is None:
                lv["s2"] = num
            elif kk in ("r1", "resist1", "resistance1") and lv["r1"] is None:
                lv["r1"] = num
            elif kk in ("r2", "resist2", "resistance2") and lv["r2"] is None:
                lv["r2"] = num
            elif kk in ("close", "prevclose", "prev_close") and lv["close"] is None:
                lv["close"] = num
        if any(lv[k] is not None for k in lv):
            out["markets"][name] = lv
    if not out["markets"]:
        return None
    return out


def pick_theme_leaders(tabs, limit=3):
    """tabs-live themes → 300억↑ 상승 대장주가 있는 주도 테마.

    같은 종목이 여러 테마에 중복으로 잡히므로(예: 파수AI — 재택근무·마이데이터),
    앞선 테마에서 이미 쓴 종목은 뒤 테마에서 빼고, 남는 대장주가 없으면 테마도 뺀다.
    300억 미만 동반 상승 종목은 '동반'으로만 붙인다(대장주로 쓰지 않는다).
    """
    out = []
    seen = set()
    for t in (tabs or {}).get("themes") or []:
        stocks = t.get("stocks") or []
        big, small = [], []
        for s in stocks:
            val = s.get("value")
            p = s.get("changePct")
            if val is None or p is None:
                continue
            if s.get("name") in seen:
                continue
            row = {
                "name": s.get("name"),
                "pct": round(float(p), 2),
                "value_eok": val / 1e8,
                "value_basis": s.get("valueBasis"),
                "upper_limit": bool(s.get("upperLimit")),
                "role": s.get("role"),
            }
            if val >= BIG_VALUE_WON and p > 0:
                big.append(row)
            elif p > 0 and val >= 5_000_000_000:      # 50억↑ 동반 상승만
                small.append(row)
        if not big:
            continue
        big.sort(key=lambda x: (-x["value_eok"], -x["pct"]))
        small.sort(key=lambda x: (-x["value_eok"], -x["pct"]))
        for s in big:
            seen.add(s["name"])
        out.append({
            "rank": t.get("rank"),
            "name": t.get("name"),
            "avg_pct": t.get("avgPct") if t.get("avgPct") is not None else t.get("avgPctCalc"),
            "calc_pct": t.get("avgPctCalc"),
            "basis_label": t.get("avgPctBasisLabel"),
            "rise": t.get("riseCount"),
            "fall": t.get("fallCount"),
            "total": t.get("stockCount"),
            "leaders": big[:3],
            "leaders_by_pct": sorted(big, key=lambda x: -x["pct"])[:2],
            "co_movers": small[:2],
        })
        if len(out) >= limit:
            break
    return out


def pick_decliners(tabs, limit=2):
    """tabs-live searchTop — 거래대금 300억↑ 하락 대표주."""
    rows = []
    for s in (tabs or {}).get("searchTop") or []:
        val = s.get("value") or 0
        p = s.get("changePct")
        if p is None or p >= 0 or val < BIG_VALUE_WON:
            continue
        rows.append({"name": s.get("name"), "pct": round(float(p), 2), "value_eok": val / 1e8})
    by_value = sorted(rows, key=lambda x: -x["value_eok"])
    by_pct = sorted(rows, key=lambda x: x["pct"])
    picked = []
    for r in (by_value[:1] + by_pct[:1]):
        if all(r["name"] != p["name"] for p in picked):
            picked.append(r)
    return picked[:limit]


def pick_upper_limit(tabs):
    ul = (tabs or {}).get("upperLimit") or {}

    def rows_of(name, n=3):
        out = []
        for s in ul.get(name) or []:
            out.append({
                "name": s.get("name"),
                "pct": round(float(s.get("changePct")), 2) if s.get("changePct") is not None else None,
                "value_text": s.get("valueIntegText") or s.get("valueDispText") or s.get("valueText"),
            })
        return out[:n]

    counts = ul.get("counts") or {}
    return {
        "count": counts.get("confirmed"),
        "near": counts.get("near"),
        "rows": rows_of("confirmed"),
        "near_rows": rows_of("near", 2),
    }


def pick_futures(tabs):
    """KIS 코스피200 선물 — 체결이 있는 시세를 고르고 베이시스까지 넘긴다.

    장전에는 야간(CM), 정규장에는 주간. 개장 직후 주간 시세가 0으로 비어 있으면
    다른 세션으로 건너뛰어 '0.00'을 보내지 않는다.
    """
    fk = (tabs or {}).get("futuresKis") or {}
    if not fk.get("ok"):
        return None
    cands = [fk.get("primaryQuote") or {}, fk.get("day") or {}, fk.get("night") or {}]
    session = fk.get("session") or {}
    q = next((c for c in cands if c.get("price")), None)
    if q is None:
        return None
    contract = q.get("contract") or fk.get("contract") or {}
    return {
        "price": q.get("price"),
        "change": q.get("change"),
        "pct": q.get("changePct"),
        "session": q.get("badge") or session.get("label") or "",
        "market_div": q.get("marketDiv"),
        "live": bool(q.get("live")),
        "label": contract.get("label"),
        "as_of": q.get("asOfKst"),
        "disparity": q.get("disparity"),
        "basis": q.get("basis"),
        "market_basis": q.get("marketBasis"),
        "kospi200": q.get("kospi200"),
        "open_interest": q.get("openInterest"),
        "oi_delta": q.get("openInterestDelta"),
        "volume": q.get("volume"),
        "prev_close": q.get("prevClose"),
    }


def pick_news(tabs, limit=6):
    rows = []
    for n in (tabs or {}).get("news") or []:
        title = (n.get("title") or "").strip()
        if not title:
            continue
        rows.append({
            "title": title,
            "press": n.get("press") or "",
            "time": n.get("time") or "",
            "impact": n.get("impactLevel") or "",
            "direction": n.get("impactDirection") or "",
            "themes": [t for t in (n.get("matchedThemes") or []) if t],
            "beneficiaries": [b.get("name") for b in (n.get("beneficiaryStocks") or []) if b.get("name")][:3],
        })
        if len(rows) >= limit:
            break
    return rows


def _theme_key(name):
    """테마 이름 비교용 — 괄호·공백·가운뎃점 제거."""
    s = re.sub(r"\([^)]*\)", "", str(name or ""))
    s = re.sub(r"[\s·,/]", "", s)
    return s.lower()


def _theme_tokens(name):
    """테마 이름을 뉴스 제목과 맞춰 볼 토큰으로 나눈다(보안주/재택근무/2차전지 등)."""
    s = re.sub(r"\([^)]*\)", " ", str(name or ""))
    raw = re.split(r"[\s·,/&]+", s)
    out = []
    for t in raw:
        t = t.strip()
        if len(t) < 2:
            continue
        if t in ("관련", "기타", "테마", "업종", "증시", "종목"):
            continue
        out.append(t)
    return out


def attach_news_to_themes(themes, news):
    """뉴스 ↔ 테마를 맞춰 테마별 재료 헤드라인을 붙인다.

    ① 뉴스의 matchedThemes 가 테마 이름과 같거나 포함하면
    ② 테마 이름 토큰이 뉴스 제목에 나오면
    ③ 테마 대장주 이름이 뉴스 제목·수해 종목에 나오면
    위 경우에만 붙인다(없으면 None). 재료를 지어내지 않기 위한 장치.
    """
    for t in themes:
        keys = {_theme_key(t.get("name"))}
        keys.discard("")
        tokens = _theme_tokens(t.get("name"))
        leader_names = [s.get("name") for s in (t.get("leaders") or []) if s.get("name")]
        hit = None
        for n in news or []:
            title = n.get("title") or ""
            matched = False
            for mt in n.get("themes") or []:
                mk = _theme_key(mt)
                if mk and (mk in keys or any(k and (k in mk or mk in k) for k in keys)):
                    matched = True
                    break
            if not matched:
                matched = any(tok in title for tok in tokens)
            if not matched:
                matched = any(lname in title for lname in leader_names)
            if not matched and n.get("beneficiaries"):
                matched = any(lname in n["beneficiaries"] for lname in leader_names)
            if matched:
                hit = n
                break
        t["news"] = hit
    return themes


def flow_verdict(fl):
    """외인 현·선물 판정 — 사용자가 정한 임계치(현물 ±1,000억 · 선물 ±1,500계약).

    현물이 0(집계 전)이거나 한쪽이 없으면 판정하지 않는다 — 0을 '순매수'로 읽지 않는다.
    """
    spot = fl.get("spot_foreign_total")
    fut = (fl.get("fut") or {}).get("foreign")
    if spot is None or fut is None or spot == 0 or fut == 0:
        return None
    spot_t, fut_t = 1000.0, 1500.0
    spot_big = abs(spot) >= spot_t
    fut_big = abs(fut) >= fut_t
    if not (spot_big or fut_big or abs(spot) >= 3000 or abs(fut) >= 3000):
        return {
            "label": "중립(임계 미달)",
            "spot": spot, "fut": fut,
            "text": f"임계 미달 — 현물 {sgn(spot)}억 / 선물 {sgn(fut)}계약 (현물 ±1,000억·선물 ±1,500계약 기준)",
        }
    if spot > 0 and fut > 0:
        label = "쌍매수"
        if spot_big and fut_big:
            label = "쌍매수(적극)"
    elif spot < 0 and fut < 0:
        label = "쌍매도"
        if spot_big and fut_big:
            label = "쌍매도(적극)"
    else:
        side = "현물 매도·선물 매수" if spot < 0 < fut else "현물 매수·선물 매도"
        label = f"엇갈림({side})"
    return {
        "label": label, "spot": spot, "fut": fut,
        "text": f"{label} — 현물 {sgn(spot)}억 / 선물 {sgn(fut)}계약",
    }


def collect(script_dir, use_fixture=None, verbose=True):
    """모든 실측값 수집 → facts dict. 실패한 소스는 None 으로 남긴다(추정 금지)."""
    facts = {"errors": [], "asof": {}}
    now = kst_now()
    facts["asof"] = {
        "iso": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "date": now.strftime("%Y-%m-%d"),
        "date_label": now.strftime("%Y-%m-%d") + f"({WEEKDAY_KO[now.weekday()]})",
        "time": now.strftime("%H:%M"),
        "time_sec": now.strftime("%H:%M:%S"),
        "weekday": WEEKDAY_KO[now.weekday()],
    }

    fx = None
    supply = None

    if use_fixture:
        with open(os.path.join(use_fixture, "tabs_live.json"), encoding="utf-8") as f:
            tabs = json.load(f)
        idx = json.load(open(os.path.join(use_fixture, "indices.json"), encoding="utf-8"))
        detail = json.load(open(os.path.join(use_fixture, "detail.json"), encoding="utf-8"))
        trend = json.load(open(os.path.join(use_fixture, "trend.json"), encoding="utf-8"))
        themes = json.load(open(os.path.join(use_fixture, "themes.json"), encoding="utf-8"))
        member_path = os.path.join(use_fixture, "members.json")
        members = json.load(open(member_path, encoding="utf-8")) if os.path.exists(member_path) else {}
        fx_path = os.path.join(use_fixture, "fx.json")
        if os.path.exists(fx_path):
            fx = json.load(open(fx_path, encoding="utf-8"))
        supply_path = os.path.join(use_fixture, "supply.json")
        if os.path.exists(supply_path):
            supply = json.load(open(supply_path, encoding="utf-8"))
    else:
        tabs, err = fetch_tabs_live()
        if err:
            facts["errors"].append(f"tabs-live: {err}")
            if verbose:
                log(f"⚠️ tabs-live 실패 — {err}")
        idx, detail, trend, themes, members = {}, {}, {}, [], {}

        try:
            idx = fetch_index_live()
            if verbose:
                log(f"✓ 지수 {[(k, v['price'], v['pct']) for k, v in idx.items()]}")
        except Exception as e:  # noqa: BLE001
            facts["errors"].append(f"index-live: {e}")
            log(f"⚠️ 지수 실패 — {e}")
            try:
                idx = fetch_index_via_api()
                log(f"↺ 관제탑 API로 지수 대체 {[(k, v['price'], v['pct']) for k, v in idx.items()]}")
            except Exception as e2:  # noqa: BLE001
                facts["errors"].append(f"index-api: {e2}")
                log(f"⚠️ 관제탑 지수도 실패 — {e2}")

        try:
            fx = fetch_fx()
            if verbose:
                log(f"✓ 환율 원/달러 {fx['price']} ({fx['pct']}%)")
        except Exception as e:  # noqa: BLE001
            facts["errors"].append(f"fx: {e}")
            log(f"⚠️ 환율 실패 — {e}")

        for market in ("KOSPI", "KOSDAQ"):
            try:
                detail[market] = fetch_index_detail(market)
            except Exception as e:  # noqa: BLE001
                facts["errors"].append(f"detail-{market}: {e}")
                log(f"⚠️ {market} integration 실패 — {e}")
            try:
                trend[market] = fetch_trend(market)
            except Exception as e:  # noqa: BLE001
                facts["errors"].append(f"trend-{market}: {e}")
                log(f"⚠️ {market} trend 실패 — {e}")
        try:
            trend["FUT"] = fetch_trend("FUT")
        except Exception as e:  # noqa: BLE001
            facts["errors"].append(f"trend-FUT: {e}")
            log(f"⚠️ FUT trend 실패 — {e}")
        try:
            themes = fetch_theme_rank()
            if verbose:
                log(f"✓ 테마 {len(themes)}개")
        except Exception as e:  # noqa: BLE001
            facts["errors"].append(f"theme-rank: {e}")
            log(f"⚠️ 테마 랭킹 실패 — {e}")

    # ---------- 지수 ----------
    def idx_row(code, name):
        live = idx.get(code) or {}
        det = detail.get(code) or {}
        price = live.get("price")
        change = live.get("change")
        p = live.get("pct")
        # 장 시작 전·마감 후에는 0.00%가 '집계 전' 값이다 — 실시간 등락으로 읽히지 않게 표시
        stale = (change == 0 and str(live.get("market_status") or "").upper() in ("PREOPEN", "CLOSE"))
        prev = det.get("prev_close")
        if prev is None and price is not None and change is not None:
            prev = round(price - change, 2)
        breadth = det.get("breadth")
        value_won = live.get("value_won")
        return {
            "name": name,
            "price": price,
            "change": change,
            "pct": p,
            "open": live.get("open") or det.get("open"),
            "high": live.get("high") or det.get("high"),
            "low": live.get("low") or det.get("low"),
            "prev_close": prev,
            "value_eok": won_to_eok(value_won),
            "value_text": det.get("value_text"),
            "breadth": breadth,
            "market_status": live.get("market_status"),
            "stale": stale,
        }

    facts["indices"] = [idx_row("KOSPI", "코스피"), idx_row("KOSDAQ", "코스닥")]
    facts["market_status"] = (idx.get("KOSPI") or {}).get("market_status")
    facts["tabs"] = {
        "generated_at_kst": (tabs or {}).get("generatedAtKst"),
        "generated_at_label": (tabs or {}).get("generatedAtLabel"),
        "session_phase": (tabs or {}).get("sessionPhase"),
        "session_label": (tabs or {}).get("sessionLabel"),
        "market_status": (tabs or {}).get("marketStatus"),
    }

    # ---------- 선물 ----------
    facts["futures"] = pick_futures(tabs)

    # ---------- 수급 ----------
    def flow_row(code):
        t = trend.get(code) or {}
        if all(t.get(k) is None for k in ("foreign", "organ", "personal")):
            return None
        # 장 시작 전에는 0으로 채운 빈 값이 온다 — 0은 실측 수급이 아니라 '집계 전'이다
        if all((t.get(k) or 0) == 0 for k in ("foreign", "organ", "personal")):
            return None
        return {
            "foreign": t.get("foreign"),
            "organ": t.get("organ"),
            "personal": t.get("personal"),
            "bizdate": t.get("bizdate"),
        }

    k = flow_row("KOSPI")
    q = flow_row("KOSDAQ")
    fu = flow_row("FUT")
    spot_foreign = (k["foreign"] + q["foreign"]) if k and q and k["foreign"] is not None and q["foreign"] is not None else None
    spot_organ = (k["organ"] + q["organ"]) if k and q and k["organ"] is not None and q["organ"] is not None else None
    facts["flows"] = {
        "kospi": k, "kosdaq": q, "fut": fu,
        "spot_foreign_total": spot_foreign,
        "spot_organ_total": spot_organ,
        "basis_date": (k or {}).get("bizdate") or (q or {}).get("bizdate") or (fu or {}).get("bizdate"),
        "program": (detail.get("KOSPI") or {}).get("program"),
    }
    facts["flows"]["verdict"] = flow_verdict(facts["flows"])

    # ---------- 환율·수급 종목 ----------
    facts["fx"] = fx
    if supply is None and not use_fixture:
        sp = os.path.abspath(os.path.join(script_dir, "..", "public", "data", "supply-latest.json"))
        supply = read_supply(sp)
    facts["supply"] = supply

    # ---------- 테마 ----------
    themes_out = pick_theme_leaders(tabs)
    news = pick_news(tabs)
    facts["themes"] = attach_news_to_themes(themes_out, news)
    facts["decliners"] = pick_decliners(tabs)
    facts["upper_limit"] = pick_upper_limit(tabs)
    facts["news"] = news

    weak = []
    if themes:
        eligible = [t for t in themes if (t.get("total") or 0) >= 5]
        weak = sorted(eligible, key=lambda x: x["pct"])[:2]
        # 약한 테마 1순위의 대표 종목(거래대금 최대) 1개
        if weak and not use_fixture:
            try:
                members = fetch_theme_members(weak[0]["no"])
            except Exception as e:  # noqa: BLE001
                facts["errors"].append(f"theme-members: {e}")
                members = {}
        if isinstance(members, dict):
            members = members.get(str(weak[0]["no"])) if weak else None
        if weak and members:
            big = [m for m in members if m.get("value_eok")]
            if big:
                top = max(big, key=lambda x: x["value_eok"])
                weak[0]["leader"] = top if top["value_eok"] >= 300 else None
    facts["weak_themes"] = weak

    # ---------- 기준선 ----------
    levels_path = os.path.join(script_dir, "..", "public", "data", "daily_levels.json")
    facts["levels"] = read_daily_levels(os.path.abspath(levels_path))

    facts["long"] = None
    if tabs:
        cp = (tabs.get("closingPicks") or {})
        facts["long"] = {
            "theme_track": [
                {"name": r.get("name"), "pct": r.get("changePct"), "value_eok": r.get("valueEok"),
                 "theme": r.get("themeName")}
                for r in (cp.get("themeTrack") or [])[:2]
            ],
            "supply_track": [
                {"name": r.get("name"), "pct": r.get("changePct"),
                 "foreign_eok": r.get("foreignEok"), "organ_eok": r.get("organEok"),
                 "kind": r.get("supplyKind")}
                for r in (cp.get("supplyTrack") or [])[:2]
            ],
            "basis_note": cp.get("asOfLabel"),
        }
    return facts


# --------------------------------------------------------------------------- #
# FACTS → 프롬프트 텍스트
# --------------------------------------------------------------------------- #
def facts_text(f):
    L = []
    a = f["asof"]
    L.append(f"[기준 시각] {a['date_label']} {a['time_sec']} KST · "
             f"{(f['tabs'] or {}).get('session_phase') or '장중'} · "
             f"시장상태 {(f['tabs'] or {}).get('market_status') or f.get('market_status') or '미수신'}")
    if (f["tabs"] or {}).get("session_label"):
        L.append(f"[세션] {f['tabs']['session_label']}")
    if (f["tabs"] or {}).get("generated_at_label"):
        L.append(f"[관제탑 API 기준] {f['tabs']['generated_at_label']}")
    L.append("")

    L.append("[지수]")
    for r in f["indices"]:
        if r["price"] is None:
            L.append(f"{r['name']} 미수신")
            continue
        parts = [f"{r['name']} {r['price']:,.2f}", f"{sgn(r['change'],2)}p", pct_text(r["pct"])]
        if r["prev_close"] is not None:
            parts.append(f"전일종가 {r['prev_close']:,.2f}")
        if r["open"] is not None:
            parts.append(f"시 {r['open']:,.2f}")
        if r["high"] is not None:
            parts.append(f"고 {r['high']:,.2f}")
        if r["low"] is not None:
            parts.append(f"저 {r['low']:,.2f}")
        if r["value_eok"] is not None:
            parts.append(f"대금 {eok_text(r['value_eok'])}")
        elif r.get("value_text"):
            parts.append(f"대금 {r['value_text']}")
        L.append(" · ".join(parts))
        b = r.get("breadth") or {}
        if r.get("stale"):
            L.append("  ※ 장 시작 전·마감 후 — 위 등락률 0.00%는 집계 전 값이며 직전 거래일 종가입니다.")
        if b.get("up") is not None and not (b.get("up") == 0 and b.get("down") == 0 and r.get("stale")):
            L.append(f"  {r['name']} 상승 {int(b['up'])} / 하락 {int(b['down'])} / 보합 {int(b.get('flat') or 0)}"
                     f" · 상한 {int(b.get('upper') or 0)} · 하한 {int(b.get('lower') or 0)}")
    kb = (f["indices"][0].get("breadth") or {})
    qb = (f["indices"][1].get("breadth") or {})
    if kb.get("up") is not None and qb.get("up") is not None and (kb["up"] + qb["up"]) > 0:
        L.append(f"상승:하락 합계 {int(kb['up'] + qb['up'])} : {int(kb['down'] + qb['down'])}")
    L.append("")

    fu = f.get("futures")
    L.append("[선물]")
    if fu:
        L.append(
            f"{fu.get('label') or '코스피200 선물'} {fu['price']:,.2f} ({sgn(fu.get('change'),2)}p, {pct_text(fu.get('pct'))})"
            f" · {fu.get('session') or ''} · {'실시간' if fu.get('live') else '실시간 아님'}"
        )
        basis_bits = []
        if fu.get("basis") is not None:
            basis_bits.append(f"베이시스 {sgn(fu['basis'],2)}p")
        if fu.get("market_basis") is not None:
            basis_bits.append(f"시장베이시스 {sgn(fu['market_basis'],2)}p")
        if fu.get("disparity") is not None:
            basis_bits.append(f"괴리율 {pct_text(fu['disparity'])}")
        if fu.get("kospi200") is not None:
            basis_bits.append(f"코스피200 {fu['kospi200']:,.2f}")
        if fu.get("open_interest") is not None:
            basis_bits.append(f"미결제 {int(fu['open_interest']):,}계약")
        if fu.get("oi_delta") is not None:
            basis_bits.append(f"미결제 증감 {sgn(fu['oi_delta'])}계약")
        if basis_bits:
            L.append("  " + " · ".join(basis_bits))
        if fu.get("prev_close") is not None:
            L.append(f"  전일 종가 {fu['prev_close']:,.2f}")
    else:
        L.append("코스피200 선물 미수신")
    L.append("")

    fx = f.get("fx")
    L.append("[환율]")
    if fx:
        L.append(f"{fx['name']} {fx['price']:,.2f}원 ({sgn(fx.get('change'),2)}, {pct_text(fx.get('pct'))})"
                 f" · 기준 {fx.get('traded_date') or '미상'}")
    else:
        L.append("원/달러 미수신")
    L.append("")

    fl = f.get("flows") or {}
    L.append(f"[수급] 기준일 {md_date(fl.get('basis_date')) or '미수신'} · 네이버 투자자별 (현물 억원 / 선물 계약)")
    for key, label in (("kospi", "코스피"), ("kosdaq", "코스닥")):
        r = fl.get(key)
        if not r:
            L.append(f"{label} 수급 미수신")
            continue
        L.append(f"{label} 외국인 {sgn(r['foreign'])}억 · 기관 {sgn(r['organ'])}억 · 개인 {sgn(r['personal'])}억")
    if not fl.get("kospi") and not fl.get("kosdaq"):
        L.append("※ 현물 투자자별 수급은 아직 집계 전입니다(장 시작 후값이 잡힙니다). 0을 쓰지 말고 '집계 전'이라 적으십시오.")
    if fl.get("spot_foreign_total") is not None:
        L.append(f"현물 합계 외국인 {sgn(fl['spot_foreign_total'])}억 · 기관 {sgn(fl['spot_organ_total'])}억")
    r = fl.get("fut")
    if r:
        L.append(f"선물 외국인 {sgn(r['foreign'])}계약 · 기관 {sgn(r['organ'])}계약 · 개인 {sgn(r['personal'])}계약"
                 f" (기준 {md_date(r.get('bizdate')) or '미수신'})")
    prog = fl.get("program")
    if prog and prog.get("total") is not None and not (prog["total"] == 0 and prog.get("bi") == 0):
        L.append(f"프로그램 순매수 {sgn(prog['total'])}억 (비차익 {sgn(prog.get('bi'))}억)")
    elif prog:
        L.append("프로그램 매매 집계 전")
    v = fl.get("verdict")
    if v:
        L.append(f"외인 현·선물 판정: {v['text']}")
    else:
        L.append("외인 현·선물 판정: 판정 보류(현물 또는 선물 집계 전)")
    L.append("")

    sup = f.get("supply")
    L.append("[수급 종목] " + (f"확정 {sup.get('basis_label')} 기준" if sup and sup.get("basis_label") else "확정 기준일 미수신"))

    def sup_line(rows, key):
        bits = []
        for x in rows or []:
            amt = x.get(key)
            if amt is None:
                continue
            bits.append(f"{x['name']} {sgn(amt)}억")
        return ", ".join(bits)

    if sup:
        fb = sup_line(sup.get("foreign_buy"), "foreign_eok")
        ob = sup_line(sup.get("organ_buy"), "organ_eok")
        fs = sup_line(sup.get("foreign_sell"), "foreign_eok")
        db = ", ".join(f"{x['name']}(외인 {sgn(x.get('foreign_eok'))}억·기관 {sgn(x.get('organ_eok'))}억)"
                       for x in sup.get("dual_buy") or [])
        if fb:
            L.append(f"- 외국인 순매수 상위: {fb}")
        if ob:
            L.append(f"- 기관 순매수 상위: {ob}")
        if fs:
            L.append(f"- 외국인 순매도 상위: {fs}")
        if db:
            L.append(f"- 외인·기관 동반 매수: {db}")
    if not sup:
        L.append("- 종목별 수급 미수신")
    L.append("")

    L.append("[받는 쪽 — 주도 테마, 거래대금 300억↑ 상승 대장주]")
    if f["themes"]:
        for t in f["themes"]:
            avg = t.get("avg_pct")
            if avg is not None:
                strength = pct_text(avg)
                basis = ""
            else:
                strength = pct_text(t.get("calc_pct"))
                basis = f"{t.get('basis_label') or ''}, "
            head = (f"{t['rank']}위 {t['name']} {strength} ({basis}구성 {int(t.get('total') or 0)}종목"
                    f" · 상승 {int(t.get('rise') or 0)} / 하락 {int(t.get('fall') or 0)})")
            L.append(head)
            for s in t.get("leaders") or []:
                extra = " · 상한가" if s.get("upper_limit") else ""
                L.append(f"   - 대장 {s['name']} {pct_text(s['pct'])} · 대금 {money_text_eok(s['value_eok'])}"
                         f" ({s.get('value_basis') or ''}){extra}")
            for s in t.get("co_movers") or []:
                L.append(f"   - 동반(300억 미만) {s['name']} {pct_text(s['pct'])} · 대금 {money_text_eok(s['value_eok'])}")
            n = t.get("news")
            if n:
                L.append(f"   - 재료(뉴스): {n['title']} ({n.get('press') or ''} {n.get('time') or ''})")
    else:
        L.append("주도 테마 미수신")
    L.append("")

    L.append("[빠지는 쪽 — 하락 업종(전체 테마 중 하위) 및 대금 300억↑ 하락 대표]")
    for t in f.get("weak_themes") or []:
        line = f"{t['name']} {pct_text(t['pct'])} (구성 {int(t.get('total') or 0)} · 상승 {int(t.get('up') or 0)}/하락 {int(t.get('down') or 0)})"
        if t.get("leader"):
            line += f" · 대표 {t['leader']['name']} {pct_text(t['leader']['pct'])} 대금 {money_text_eok(t['leader']['value_eok'])}"
        else:
            line += " · 대표 종목 미수신"
        L.append(line)
    if not f.get("weak_themes"):
        L.append("하락 업종 미수신")
    for d in f.get("decliners") or []:
        L.append(f"하락 대표주 {d['name']} {pct_text(d['pct'])} · 대금 {money_text_eok(d['value_eok'])}")
    L.append("")

    ul = f.get("upper_limit") or {}
    if ul.get("count") is not None and (ul.get("count") or 0) + (ul.get("near") or 0) > 0:
        names = ", ".join(f"{r['name']} {pct_text(r['pct'])}" for r in ul.get("rows") or [])
        L.append(f"[상한가] 확정 {int(ul['count'])}종목" + (f" — {names}" if names else ""))
        if ul.get("near") is not None:
            near = ", ".join(f"{r['name']} {pct_text(r['pct'])}" for r in ul.get("near_rows") or [])
            L.append(f"  상한가 임박 {int(ul['near'])}종목" + (f" — {near}" if near else ""))
        L.append("")
    elif ul.get("count") is not None:
        L.append("[상한가] 집계 전(확정 0 · 임박 0)")
        L.append("")

    L.append("[기준선]")
    lv = f.get("levels")
    if lv and lv.get("markets"):
        for name, node in lv["markets"].items():
            bits = []
            if node.get("s1") is not None:
                bits.append(f"1차 지지 {node['s1']:,.2f}")
            if node.get("s2") is not None:
                bits.append(f"2차 지지 {node['s2']:,.2f}")
            if node.get("r1") is not None:
                bits.append(f"저항1 {node['r1']:,.2f}")
            if node.get("r2") is not None:
                bits.append(f"저항2 {node['r2']:,.2f}")
            if node.get("close") is not None:
                bits.append(f"전일 종가 {node['close']:,.2f}")
            if bits:
                L.append(f"{name} " + " · ".join(bits))
        L.append(f"(출처 daily_levels.json {lv.get('date') or ''})")
        if lv.get("note"):
            L.append(f"(기준 메모: {lv['note']})")
    else:
        L.append("저장된 1·2차 지지선 없음 — 전일 종가를 기준선으로 판단할 것")
    L.append("")

    if f.get("news"):
        L.append("[뉴스·재료]")
        for n in f["news"]:
            tag = ""
            if n.get("impact"):
                tag = f"[{n['impact']}" + (f"/{n['direction']}" if n.get("direction") else "") + "] "
            themes = f" → 관련테마: {', '.join(n['themes'])}" if n.get("themes") else ""
            L.append(f"- {tag}{n['title']} ({n.get('press') or ''} {n.get('time') or ''}){themes}")
        L.append("")

    if f.get("long"):
        lg = f["long"]
        L.append("[관제탑 종가베팅 참고]")
        for r in lg.get("theme_track") or []:
            if r.get("name"):
                L.append(f"- 테마트랙 {r['name']} {pct_text(r.get('pct'))} · {r.get('theme') or ''}")
        for r in lg.get("supply_track") or []:
            if r.get("name"):
                L.append(f"- 수급트랙 {r['name']} {pct_text(r.get('pct'))} · 외인 {sgn(r.get('foreign_eok'))}억 · 기관 {sgn(r.get('organ_eok'))}억 · {r.get('kind') or ''}")
        if lg.get("basis_note"):
            L.append(f"- 기준 {lg['basis_note']}")
        L.append("")

    if f.get("errors"):
        L.append("[수집 실패] " + " | ".join(f["errors"][:4]))
    return "\n".join(L).strip()


SYSTEM_PROMPT = """너는 한국 주식 채널 '폭스시그널'의 장중 정통 브리핑 작성자다.
아래 FACTS에 적힌 실측값만으로, 정규 브리핑의 70~80% 분량(2,000~3,200자) 텔레그램 본문을 쓴다.
읽는 사람은 장중에 폰으로 잠깐 보는 개인 투자자다. 숫자·수급·테마·기준선이 한 번에 잡혀야 한다.

[절대 규칙]
1. FACTS에 있는 숫자만 쓴다. FACTS에 없는 숫자·전망치·목표가·예상 지수·지표(VIX·국채금리·달러인덱스 등)를 만들지 않는다.
2. 합계·평균·증감률을 새로 계산하지 않는다. FACTS에 이미 적힌 값만 인용한다.
3. 숫자는 FACTS의 표기(쉼표·소수점)를 그대로 옮긴다. 단위(억/조/계약/%/p)와 기준을 바꾸지 않는다.
4. FACTS가 '미수신'·'미집계'·'실시간 아님'이라고 하면 숨기지 말고 그대로 적는다.
5. FACTS의 날짜·시각을 바꾸지 않는다. 수급 기준일이 오늘이 아니면 '기준 11/25'처럼 기준일을 밝힌다.
6. 출력은 맨 첫 줄 헤드라인 + 아래 5개 블록만. 인사·서론·면책·맺음말·마크다운(**·##·표·```) 금지.
7. 분량은 장중 2,000~3,200자. 블록별 목표: 📌 1줄(약 100자) / 📊 약 450자 / 💰 약 600자
   / 🔥 약 900자 / 🧭 약 500자. 한 줄은 40~80자로 끊어 폰 화면에서 읽히게 하고,
   한 줄에 몰아 쓰지 말고 항목마다 '- '로 시작하는 줄로 나눈다.
8. 매수·매도 '추천'이 아니라 조건부 대응만 쓴다. '반드시·무조건·수익 보장' 금지.
9. 원인·재료는 FACTS의 [뉴스·재료]·[수급 종목]에 적힌 것만 쓴다. FACTS에 없는 원인 추정
   ('패닉', '실망 매물', '차익실현', '기관 매도', '외인 환헤지', '기대감', '수혜', '순환매')을 새로 만들지 않는다.
   해석을 붙이는 줄은 반드시 '[해석]'으로 시작한다. '[재료]'·'[전망]' 같은 새 라벨을 만들지 않는다.
   헤드라인·본문에서 '출발'·'개장'이라고 쓰지 않는다(장 시작 전이면 '개장 전', 장중이면 '상승/하락'으로만).
10. [기준 시각]의 국면을 지킨다. '장전'·'프리마켓'이면 '마감'·'종가 확정'·'출발'·'개장'이라고 쓰지 않고,
    선물이 '실시간 아님'이면 세션 표기(예: 15:45 마감)를 함께 적는다.
    FACTS가 '집계 전'이라 적은 값(등락 0.00%·수급 0억·등락종목수 0)은 0으로 쓰지 말고 '집계 전'이라 쓰며,
    그것으로 시장 방향을 단정하지 않는다.
11. 거래대금 300억 미만 종목은 '동반'으로만 언급한다. 대장주로 쓰지 않는다.
12. 상한가는 FACTS에 '상한가' 표시가 있는 종목만 그렇게 쓴다. 등락률만 보고 단정하지 않는다.
13. 순위는 FACTS에 적힌 순위만 쓴다('대금 1위' 같은 새 순위 주장 금지). 테마·종목·공시를 새로 만들지 않는다.
    상한가 '확정' 수와 '임박' 수를 더하지 않는다. 테마의 '구성 종목수'와 '상승/하락 종목수'를 섞지 않는다.
14. 모든 문장은 '~습니다/~입니다' 존댓말. 이모지는 형식에 있는 것만 쓴다.

[출력 형식]
{헤드라인 한 줄 — 지수 방향 + 핵심 수급 또는 대장 테마, 30자 안팎}

📌 한줄 요약
코스피 {값} {등락률} · 코스닥 {값} {등락률} · 외인 {현·선물 판정} · 대장 테마 {테마} — {지금 대응 한 줄}

📊 핵심 지표 & 매크로
- 코스피 {값} ({등락}p / {등락률}) — 전일 종가 {값}
- 코스피 시 {값} · 고 {값} · 저 {값} · 대금 {값}
- 코스닥 {값} ({등락}p / {등락률}) — 전일 종가 {값}
- 코스닥 고 {값} · 저 {값} · 대금 {값}
- 선물 {값} ({등락률}, {세션}) · 베이시스 {값}p · 미결제 {계약}
- 상승:하락 코스피 {상승}:{하락} / 코스닥 {상승}:{하락} · 상한가 확정 {개수}종목
- 원/달러 {값}원 ({등락률}, {기준일})

💰 투자자별 수급 & 흐름 해석
- 외국인 현물 코스피 {값} · 코스닥 {값}
- 외국인 선물 {계약} ({기준일})
- 기관 현물 코스피 {값} · 코스닥 {값} · 선물 {계약}
- 개인 코스피 {값} · 프로그램 {값}
- 현·선물 판정: {FACTS의 판정 문장}
- 외인 순매수 상위 {종목} · 기관 순매수 상위 {종목}
- [해석] {왜 이런 수급이 나왔는지, 어떤 의미인지 — FACTS 근거로 2~3줄}

🔥 장중 주도 테마 & 대장주 (거래대금 300억↑)
- {테마1} {등락률} — 구성 {종목수}종목, 상승 {상승} / 하락 {하락}
- 대장 {종목} {등락률} ({거래대금})
- 동반 {종목} {등락률} ({거래대금})
- 재료: {FACTS에 붙은 뉴스 헤드라인} (없으면 '재료 뉴스 미수신' 한 번만)
- {테마2} {등락률} — 구성 {상승}상승/{하락}하락
- 대장 {종목} {등락률} ({거래대금})
- 재료: {헤드라인 또는 미수신}
- {테마3} {등락률}
- 대장 {종목} {등락률} ({거래대금})
- 빠지는 쪽: {업종} {등락률}
- 하락 대표주: {종목} {등락률} ({거래대금})
- 테마 총평: {오늘 자금이 어느 테마로 몰리고 어디서 빠지는지 한 문장 — 새 수치 계산 금지}

🧭 오늘 시장 전망 & 시나리오 · 기준선 대응
- 현재 코스피 {값} — 1차 지지 {값} 대비 {위/아래}, 2차 지지 {값} · 저항1 {값}
- 코스닥 {값} — 1차 지지 {값} · 저항1 {값}
- ① 돌파·유지: {숫자 조건} → {행동}
- ② 박스: {숫자 조건} → {행동}
- ③ 이탈: {숫자 조건} → {행동}
- 대응 원칙: {오늘 비중·추격 여부·손절 기준을 FACTS 기준선으로 한 줄}
- 체크포인트: {다음에 확인할 것 — FACTS의 기준선·수급·상한가 중에서}
""" + CHECKER_URL + """

[작성 지침]
- 📌 는 정확히 한 줄이다(두 줄 금지). 지수 방향·외인 현선물 판정·대장 테마·대응이 모두 들어가야 한다.
- 📊 는 FACTS의 지수·선물·베이시스·등락종목수·상한가·환율만 쓴다. 없는 값은 그 줄을 빼고 '미수신'으로 남긴다.
  코스피·코스닥은 전일 종가·고가·저가·거래대금을 각각 한 줄로 나눠 적는다.
- 💰 는 시장 전체 투자자별 수급(현물 억원, 선물 계약)과 프로그램 수치를 줄별로 쓰고, 이어서 [수급 종목]의
  외인·기관 순매수·순매도 상위 종목을 근거로 '[해석]' 줄을 2~3줄 쓴다. 해석은 FACTS에 있는 종목·수급·뉴스로만 연결한다.
- 🔥 는 [받는 쪽]의 2~3개 테마를 순서대로 쓴다. 테마마다 ① 첫 줄: 테마·등락률·(구성 상승/하락)
  ② 둘째 줄: 대장주와 등락률·거래대금 ③ 셋째 줄: 동반 종목과 재료(뉴스) — 로 나눠 적는다.
  '재료(뉴스)'가 FACTS의 그 테마 줄에 '재료(뉴스):'로 붙어 있을 때만 그 헤드라인을 인용하고,
  없으면 재료를 지어내지 말고 '재료 뉴스 미수신'이라 적는다. [뉴스·재료] 목록의 다른 헤드라인을
  특정 테마의 상승 이유로 끌어다 붙이지 않는다(테마↔뉴스 연결은 FACTS에 표시된 것만).
  마지막에 [빠지는 쪽]을 대비시키되, 업종의 대표 종목은 FACTS에 '대표'로 붙은
  종목만 쓰고 없으면 업종 등락률만 쓴다. '하락 대표주'는 FACTS에 그렇게 적힌 종목만 별도 줄로 쓰고
  업종 옆에 '— 대표'로 이어 붙이지 않는다.
- 🧭 는 [기준선]의 1차·2차 지지와 저항을 써서 세 경우(① 돌파·유지 / ② 박스 / ③ 이탈)를 숫자로 나눈다.
  지지선이 없으면 전일 종가를 기준으로 쓴다. 각 경우의 행동은 '관망 / 분할 / 추격 금지 / 비중 축소' 중에서
  조건과 함께 단호하게 쓴다. 마지막 줄은 다음 확인 항목이다.
- 같은 숫자를 여러 블록에서 다시 써도 된다. 분량을 채우려고 없는 사실을 늘리지는 않는다.
  단, FACTS에 있는 수치·종목·테마·기준선은 빠짐없이 인용한다(인용만으로 분량이 채워진다).
- 🔥 마지막에 '테마 총평' 한 줄을 반드시 넣는다. 🧭 마지막에 '체크포인트' 한 줄을 반드시 넣는다.
- 다 쓰고 나서 글자 수를 세라. 2,000자보다 짧으면 FACTS에 있는 다른 수치·종목·기준선을 각 블록에 더 붙여 늘려라.
- 문장은 짧고 단정하게. '~로 보입니다'를 반복하지 말고 근거 숫자를 먼저 쓴다."""


def call_gemini(api_key, model, system_prompt, user_text, timeout=60, max_tokens=4096,
                temperature=0.35, thinking_budget=0):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    body = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
    }
    if thinking_budget is not None:
        body["generationConfig"]["thinkingConfig"] = {"thinkingBudget": thinking_budget}
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            pass
        # thinkingConfig 미지원 모델이면 한 번만 빼고 재시도
        if e.code == 400 and "thinking" in detail.lower() and "thinkingConfig" in body["generationConfig"]:
            body["generationConfig"].pop("thinkingConfig", None)
            req = urllib.request.Request(
                url, data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json", "User-Agent": UA},
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
        else:
            raise
    cands = data.get("candidates") or []
    if not cands:
        raise RuntimeError(f"후보 없음: {json.dumps(data)[:200]}")
    parts = (cands[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text:
        raise RuntimeError(f"빈 응답: finish={cands[0].get('finishReason')}")
    usage = data.get("usageMetadata") or {}
    usage["finishReason"] = cands[0].get("finishReason")
    return text, usage


# --------------------------------------------------------------------------- #
# 검증
# --------------------------------------------------------------------------- #
NUM_RE = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?")
URL_RE = re.compile(r"https?://\S+")
# FACTS에 없는 '원인·심리' 어휘 — [해석] 줄이 아니면 쓰지 않는다(숫자와 같은 방식으로 막는다)
RISK_WORDS = ["기대감", "수혜주", "수혜", "차익실현", "차익 실현", "실망 매물", "매물 소화", "순환매",
              "패닉", "공포 심리", "저가 매수세", "반발 매수", "기관 매도", "외인 환헤지"]
SAFE_INTS = set(range(0, 31)) | {32, 45, 50, 60, 100, 150, 200, 300, 500, 1000, 1200,
                                1500, 2000, 2500, 3000, 3200, 4096, 2025, 2026, 2027}


def numbers_in(text):
    out = []
    for m in NUM_RE.finditer(URL_RE.sub(" ", text)):
        try:
            out.append(float(m.group(0).replace(",", "")))
        except ValueError:
            pass
    return out


def allowed_numbers(ftext):
    allowed = set()
    for v in numbers_in(ftext):
        allowed.add(round(v, 4))
        allowed.add(float(round(v)))          # 정수 반올림 허용
        allowed.add(float(math.floor(v)))     # 내림 표기 허용 (4,697.51 → 4,697)
        allowed.add(float(math.ceil(v)))      # 올림 표기 허용
        allowed.add(round(v, 1))              # 소수 1자리 반올림 허용
        allowed.add(round(v, 2))
        if abs(v) >= 100:                     # 억 → 조 변환 허용
            allowed.add(round(v / 10000, 1))
            allowed.add(round(v / 10000, 2))
        if abs(v) >= 10000:                   # 원 → 억/조 표기 변환 허용
            allowed.add(round(v / 1e8, 1))
            allowed.add(round(v / 1e8, 0))
    allowed |= SAFE_INTS
    return allowed


def body_min_chars(facts):
    """근거가 얇은 장전에는 2,000자를 강요하지 않는다(빈말로 채우는 것보다 짧은 게 낫다).

    등락종목수·투자자별 수급·판정·테마·하락 섹터·상한가·종목수급 중 5개 이상이 잡히는
    정상 장중에는 2,000자 목표를 그대로 요구한다.
    """
    rich = 0
    idx = facts.get("indices") or []
    if any((r.get("breadth") or {}).get("up") for r in idx):
        rich += 1
    fl = facts.get("flows") or {}
    if fl.get("kospi"):
        rich += 1
    if fl.get("verdict"):
        rich += 1
    if facts.get("themes"):
        rich += 1
    if facts.get("decliners") or facts.get("weak_themes"):
        rich += 1
    if (facts.get("upper_limit") or {}).get("count"):
        rich += 1
    if facts.get("supply"):
        rich += 1
    return BODY_TARGET_MIN if rich >= 5 else 1400


def normalize_headers(body):
    """5블록 헤더를 정식 문구로 고정한다(모델이 흔들려도 양식이 유지되게)."""
    out = []
    for ln in body.splitlines():
        s = ln.strip()
        probe = re.sub(r"^[-•*]\s*", "", s)   # '- 📊 ...' 처럼 불릿이 붙은 헤더도 잡는다
        replaced = False
        for emoji, header in BLOCK_HEADERS:
            if probe.startswith(emoji):
                out.append(header)
                replaced = True
                break
        if not replaced:
            out.append(ln)
    return "\n".join(out)


def validate_body(body, ftext, phase=None, min_chars=BODY_MIN):
    """(ok, 문제점 리스트). 숫자 창작·형식 누락·분량 미달을 잡는다."""
    problems = []
    lines = [ln.strip() for ln in body.strip().splitlines() if ln.strip()]
    if not lines:
        return False, ["본문 비어 있음"]
    if len(lines) < 14:
        problems.append(f"줄 수 부족({len(lines)}자 아님)")

    n_chars = len(body)
    if n_chars < min_chars:
        problems.append(f"분량 부족({n_chars}자 < {BODY_TARGET_MIN}~{BODY_TARGET_MAX}자 목표)")
    if n_chars > BODY_MAX:
        problems.append(f"본문 과다({n_chars}자 > {BODY_MAX}자)")

    positions = {}
    for i, ln in enumerate(lines):
        for _, header in BLOCK_HEADERS:
            if ln.strip() == header and header not in positions:
                positions[header] = i
    for sec in REQ_SECTIONS:
        if sec not in positions:
            problems.append(f"섹션 누락: {sec}")
    if len(positions) == len(REQ_SECTIONS):
        order = [positions[s] for s in REQ_SECTIONS]
        if order != sorted(order):
            problems.append("섹션 순서 어긋남")

    # 📌 한 줄 요약은 두 줄 이상이면 안 된다
    try:
        i = positions["📌 한줄 요약"]
        j = positions["📊 핵심 지표 & 매크로"]
        block = [ln for ln in lines[i + 1:j] if ln.strip()]
        if len(block) > 1:
            problems.append(f"한줄 요약이 {len(block)}줄")
        if not block:
            problems.append("한줄 요약 내용 없음")
    except KeyError:
        pass

    # 🧭 시나리오 3분기(① ② ③)
    try:
        i = positions["🧭 오늘 시장 전망 & 시나리오 · 기준선 대응"]
        tail = "\n".join(lines[i + 1:])
        missing = [m for m in ("①", "②", "③") if m not in tail]
        if missing:
            problems.append(f"시나리오 누락: {''.join(missing)}")
        if len(tail) < 120:
            problems.append("🧭 분량 부족")
    except KeyError:
        pass

    # 🔥 테마 블록에 300억↑ 대장 종목 흔적
    try:
        i = positions["🔥 장중 주도 테마 & 대장주 (300억↑ 실측)"]
        j = positions["🧭 오늘 시장 전망 & 시나리오 · 기준선 대응"]
        block = "\n".join(lines[i + 1:j])
        if len(block) < 150:
            problems.append("🔥 테마 블록 분량 부족")
    except KeyError:
        pass

    if "**" in body or "##" in body:
        problems.append("마크다운 금지 위반")
    if phase in ("장전", "프리마켓", "정규장"):
        # 시각(06:00·15:45)이 앞에 붙은 '마감'은 선물 세션 표기라 위반이 아니다
        probe = re.sub(r"\d{1,2}:\d{2}", " ", body)
        if re.search(r"(?:정규장|장)\s*마감|종가\s*확정|마감했|(?:상승|하락|보합|급등|급락)\s*마감", probe):
            problems.append(f"국면 불일치: {phase}인데 '마감' 서술")

    allowed = allowed_numbers(ftext)
    unknown = []
    for n in numbers_in(body):
        hit = any(abs(n - a) <= 0.011 or (a != 0 and abs(n - a) / abs(a) < 1e-9) for a in allowed)
        if not hit:
            unknown.append(n)
    if unknown:
        uniq = []
        for n in unknown:
            if all(abs(n - u) > 1e-9 for u in uniq):
                uniq.append(n)
        problems.append("근거 없는 숫자: " + ", ".join(f"{n:g}" for n in uniq[:8]))

    # FACTS에 없는 원인·심리 어휘([해석] 줄 제외) — 뉴스 제목에 있는 말은 허용
    bad_words = []
    for ln in lines:
        if ln.startswith("[해석]"):
            continue
        for w in RISK_WORDS:
            if w in ln and w not in ftext:
                bad_words.append(w)
    if bad_words:
        uniq_w = []
        for w in bad_words:
            if w not in uniq_w:
                uniq_w.append(w)
        problems.append("근거 없는 원인 어휘: " + ", ".join(uniq_w[:5]))

    # 상한가 '확정' 수와 '임박' 수를 더해 버린 경우(예: 2+1=3)
    m = re.search(r"상한가\s*(?:확정\s*)?(\d+)\s*종목", body)
    if m:
        n = int(m.group(1))
        confirmed = set(numbers_in(re.search(r"\[상한가\] 확정 (\d+)종목", ftext).group(1)))
        near_m = re.search(r"상한가 임박 (\d+)종목", ftext)
        near = {float(near_m.group(1))} if near_m else set()
        if confirmed and float(n) not in confirmed and float(n) not in near:
            problems.append(f"상한가 수 불일치({n}종목 — FACTS와 다름)")
    return (not problems), problems


def clean_body(text):
    t = text.replace("\r", "").strip()
    t = re.sub(r"^\s*```[a-z]*\s*", "", t)
    t = t.replace("```", "")
    t = t.replace("**", "").replace("##", "")
    lines = [ln.rstrip() for ln in t.splitlines()]
    # 헤더를 Gemini가 다시 쓴 경우 제거
    while lines and lines[0].lstrip().startswith("🦊"):
        lines.pop(0)
    while lines and not lines[0].strip():
        lines.pop(0)
    # '헤드라인:' / '제목:' 접두어 제거
    if lines:
        lines[0] = re.sub(r"^\s*(헤드라인|제목)\s*[:：\-—]\s*", "", lines[0]).strip()
    # 과도한 빈 줄 정리(2줄 이상 → 1줄)
    out = []
    blank = 0
    for ln in lines:
        if not ln.strip():
            blank += 1
            if blank >= 2:
                continue
        else:
            blank = 0
        out.append(ln.strip())
    return normalize_headers("\n".join(out).strip())


def build_header(slot):
    return f"🦊 폭스시그널 · {slot} 장중 브리핑 [🤖 Gemini AI 자동 작성]"


def fit_telegram(text, limit=TG_LIMIT - 96):
    """텔레그램 4,096자 한도에 맞춘다(줄 경계에서 자른다)."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    idx = cut.rfind("\n")
    if idx > limit * 0.6:
        cut = cut[:idx]
    return cut.rstrip() + "\n… (분량 한도로 이하 생략)"


def _idx_line(r):
    if r["price"] is None:
        return f"{r['name']} 미수신"
    tail = "집계 전" if r.get("stale") else pct_text(r["pct"])
    return f"{r['name']} {r['price']:,.2f} ({sgn(r['change'],2)}p / {tail})"


def _breadth(r):
    b = r.get("breadth") or {}
    if b.get("up") is None:
        return "미수신"
    if (b.get("up") or 0) == 0 and (b.get("down") or 0) == 0:
        return "집계 전"
    return f"{int(b['up'])}:{int(b['down'])}"


def fallback_body(f):
    """Gemini 실패 시 — 실측값만으로 같은 5블록 양식."""
    k, q = f["indices"][0], f["indices"][1]
    fl = f.get("flows") or {}
    fu = f.get("futures")
    fx = f.get("fx")
    lv = (f.get("levels") or {}).get("markets") or {}
    kospi_lv = lv.get("코스피") or {}
    kosdaq_lv = lv.get("코스닥") or {}

    headline_bits = [x for x in (_idx_line(k), _idx_line(q)) if "미수신" not in x]
    headline = " · ".join(headline_bits) if headline_bits else "장중 시황"
    verdict = (fl.get("verdict") or {}).get("label")
    if verdict:
        headline += f" · 외인 {verdict}"
    elif f.get("themes"):
        headline += f" · {f['themes'][0]['name']} 강세"

    basis = f"기준 {md_date(fl.get('basis_date'))}" if fl.get("basis_date") else "기준일 미수신"

    # 📌
    summary = " · ".join(x for x in (_idx_line(k), _idx_line(q)) if "미수신" not in x) or "지수 미수신"
    if verdict:
        summary += f" · 외인 {verdict}"
    if f.get("themes"):
        t0 = f["themes"][0]
        lead = (t0.get("leaders") or [None])[0]
        summary += f" · 대장 테마 {t0['name']} {pct_text(t0.get('avg_pct'))}"
        if lead:
            summary += f"({lead['name']} {pct_text(lead['pct'])})"
    action_line = ""
    if k["price"] is not None and kospi_lv.get("s1") is not None:
        if k["price"] < kospi_lv["s1"]:
            action_line = "1차 지지 이탈 — 지지 회복 확인 전 추격 금지·비중 축소"
        elif kospi_lv.get("r1") is not None and k["price"] >= kospi_lv["r1"]:
            action_line = "저항1 위 유지 — 주도 테마 눌림만 분할 대응"
        else:
            action_line = "지지~저항 사이 박스 — 관망하며 거래대금 동반 확인"
    else:
        action_line = "실측값 확인 전 관망"
    summary += f" — {action_line}"

    # 📊
    macro = [_idx_line(k), _idx_line(q)]
    if k.get("prev_close") is not None:
        macro.append(f"코스피 전일 종가 {k['prev_close']:,.2f}" + (f" · 대금 {eok_text(k['value_eok'])}" if k.get("value_eok") else ""))
    if q.get("prev_close") is not None:
        macro.append(f"코스닥 전일 종가 {q['prev_close']:,.2f}" + (f" · 대금 {eok_text(q['value_eok'])}" if q.get("value_eok") else ""))
    if fu:
        basis_bit = f" · 베이시스 {sgn(fu.get('basis'),2)}p" if fu.get("basis") is not None else ""
        macro.append(f"선물 {fu['price']:,.2f} ({pct_text(fu.get('pct'))}, {fu.get('session') or ''}){basis_bit}")
    else:
        macro.append("선물 미수신")
    macro.append(f"상승:하락 코스피 {_breadth(k)} / 코스닥 {_breadth(q)}")
    ul = f.get("upper_limit") or {}
    if ul.get("count") is not None:
        if (ul.get("count") or 0) + (ul.get("near") or 0) > 0:
            macro.append(f"상한가 확정 {int(ul['count'])}종목 · 임박 {int(ul.get('near') or 0)}종목")
        else:
            macro.append("상한가 집계 전")
    if fx:
        macro.append(f"원/달러 {fx['price']:,.2f}원 ({pct_text(fx.get('pct'))}, 기준 {fx.get('traded_date') or '미상'})")
    else:
        macro.append("원/달러 미수신")

    # 💰
    flow = []
    for key, label in (("kospi", "코스피"), ("kosdaq", "코스닥")):
        r = fl.get(key)
        flow.append(f"{label} 외인 {sgn(r['foreign'])}억·기관 {sgn(r['organ'])}억·개인 {sgn(r['personal'])}억"
                    if r else f"{label} 수급 미수신")
    if fl.get("fut"):
        r = fl["fut"]
        flow.append(f"선물 외인 {sgn(r['foreign'])}계약·기관 {sgn(r['organ'])}계약 ({basis})")
    else:
        flow.append("선물 수급 미수신")
    prog = fl.get("program")
    if prog and prog.get("total") and not (prog["total"] == 0 and prog.get("bi") == 0):
        flow.append(f"프로그램 순매수 {sgn(prog['total'])}억 (비차익 {sgn(prog.get('bi'))}억)")
    if verdict:
        flow.append(f"외인 현·선물 판정: {(fl.get('verdict') or {}).get('text')}")
    else:
        flow.append("외인 현·선물 판정: 현물 수급 집계 전으로 판정 보류")
    sup = f.get("supply")
    if sup:
        fb = ", ".join(f"{x['name']} {sgn(x.get('foreign_eok'))}억" for x in sup.get("foreign_buy") or [])
        ob = ", ".join(f"{x['name']} {sgn(x.get('organ_eok'))}억" for x in sup.get("organ_buy") or [])
        if fb:
            flow.append(f"외인 순매수 상위(확정 {sup.get('basis_label') or ''}): {fb}")
        if ob:
            flow.append(f"기관 순매수 상위: {ob}")
    flow.append("[해석] 수급 해석 문장은 Gemini 응답 실패로 생략했습니다. 위 수치는 수집된 실측값 그대로입니다.")

    # 🔥
    themes = []
    for t in (f.get("themes") or [])[:3]:
        leaders = t.get("leaders") or []
        if not leaders:
            continue
        themes.append(f"{t['name']} {pct_text(t.get('avg_pct'))}"
                      f" (구성 {int(t.get('rise') or 0)}상승/{int(t.get('fall') or 0)}하락)")
        for s in leaders[:2]:
            themes.append(f"대장 {s['name']} {pct_text(s['pct'])} · 대금 {money_text_eok(s['value_eok'])}"
                          + (" · 상한가" if s.get("upper_limit") else ""))
        co = t.get("co_movers") or []
        if co:
            themes.append("동반: " + ", ".join(f"{s['name']} {pct_text(s['pct'])}" for s in co))
        n = t.get("news")
        if n:
            themes.append(f"재료: {n['title']} ({n.get('press') or ''})")
    if not themes:
        themes.append("주도 테마 미수신")
    weak = []
    for t in (f.get("weak_themes") or [])[:2]:
        line = f"{t['name']} {pct_text(t['pct'])}"
        if t.get("leader"):
            line += f" · 대표 {t['leader']['name']} {pct_text(t['leader']['pct'])} ({money_text_eok(t['leader']['value_eok'])})"
        weak.append(line)
    if not weak:
        for d in (f.get("decliners") or [])[:2]:
            weak.append(f"하락 대표 {d['name']} {pct_text(d['pct'])} ({money_text_eok(d['value_eok'])})")
    if weak:
        themes.append("빠지는 쪽: " + " · ".join(weak))
    ul = f.get("upper_limit") or {}
    if ul.get("rows"):
        themes.append("상한가: " + ", ".join(f"{r['name']} {pct_text(r['pct'])}" for r in ul["rows"]))

    # 🧭
    view = []
    if k["price"] is not None:
        s1 = kospi_lv.get("s1")
        s2 = kospi_lv.get("s2")
        r1 = kospi_lv.get("r1")
        pos = []
        if s1 is not None:
            pos.append(f"1차 지지 {s1:,.2f} {'위' if k['price'] >= s1 else '아래'}")
        if s2 is not None:
            pos.append(f"2차 지지 {s2:,.2f}")
        if r1 is not None:
            pos.append(f"저항1 {r1:,.2f}")
        view.append(f"현재 코스피 {k['price']:,.2f} — " + " · ".join(pos) if pos
                    else f"현재 코스피 {k['price']:,.2f} — 저장된 지지선 없음")
        if s1 is not None and r1 is not None:
            view.append(f"① 돌파·유지: {r1:,.2f} 위 유지 시 → 주도 테마 눌림 분할, 추격 매수 금지")
            view.append(f"② 박스: {s1:,.2f}~{r1:,.2f} 왕복 시 → 관망, 거래대금 동반 확인 전 진입 보류")
            view.append(f"③ 이탈: {s1:,.2f} 아래 종가 이탈 시 → 비중 축소, 반등 확인 전 신규 진입 금지")
        elif s1 is not None:
            view.append(f"① 지지 {s1:,.2f} 위 유지 시 → 주도 테마 눌림 분할")
            view.append(f"② {s1:,.2f} 부근 박스 → 관망")
            view.append(f"③ {s1:,.2f} 이탈 시 → 비중 축소·추격 금지")
        else:
            view.append("① 전일 종가 위 유지 시 → 주도 테마 눌림 분할")
            view.append("② 전일 종가 부근 박스 → 관망")
            view.append("③ 전일 종가 이탈 시 → 비중 축소·추격 금지")
    else:
        view.append("지수 미수신 — 기준선 판단 불가")
        view.append("① ② ③ 시나리오는 실측값 수신 후 판단")
    if kosdaq_lv.get("s1") is not None and q["price"] is not None:
        view.append(f"코스닥 1차 지지 {kosdaq_lv['s1']:,.2f} / 현재 {q['price']:,.2f}")
    view.append("체크포인트: 1차 지지 회복 여부 · 외인 선물 방향 · 상한가 확대 여부")

    return "\n".join([
        headline,
        "📌 한줄 요약",
        summary,
        "📊 핵심 지표 & 매크로",
        *[f"- {x}" for x in macro],
        "💰 투자자별 수급 & 흐름 해석",
        *[f"- {x}" for x in flow],
        "🔥 장중 주도 테마 & 대장주 (300억↑ 실측)",
        *[f"- {x}" for x in themes],
        "🧭 오늘 시장 전망 & 시나리오 · 기준선 대응",
        *[f"- {x}" for x in view],
        CHECKER_URL,
    ])


# --------------------------------------------------------------------------- #
# 발송
# --------------------------------------------------------------------------- #
def send_telegram(token, chat_id, text, timeout=20, retries=3):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": True,
    }).encode("utf-8")
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
            if not data.get("ok"):
                raise RuntimeError(f"Telegram 응답 오류: {str(data)[:200]}")
            return data["result"]["message_id"]
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"텔레그램 발송 실패: {last}")


# --------------------------------------------------------------------------- #
# 실행
# --------------------------------------------------------------------------- #
def market_guard(facts, force=False):
    """휴장·장외에 잘못 보내지 않는다. (skip, reason)"""
    now = kst_now()
    if force:
        return False, "force"
    if now.weekday() >= 5:
        return True, "주말"
    minutes = now.hour * 60 + now.minute
    if minutes < 8 * 60 + 50 or minutes > 15 * 60 + 40:
        return True, f"장외 시간({now.strftime('%H:%M')})"
    biz = (facts.get("flows") or {}).get("basis_date")
    today = now.strftime("%Y%m%d")
    ms = facts.get("market_status")
    if biz and biz != today and ms == "CLOSE":
        return True, f"휴장 추정(수급 기준일 {biz})"
    return False, "장중"


def main(argv=None):
    ap = argparse.ArgumentParser(description="폭스시그널 장중 브리핑 (Gemini → 텔레그램)")
    ap.add_argument("--dry-run", action="store_true", help="발송하지 않고 본문만 출력")
    ap.add_argument("--print-facts", action="store_true", help="수집한 FACTS만 출력")
    ap.add_argument("--slot", default=None, help="헤더 시각 표기 (기본: 현재 KST HH:MM)")
    ap.add_argument("--force", action="store_true", help="휴장/장외 가드 무시(테스트용)")
    ap.add_argument("--model", default=None, help="Gemini 모델 고정 (기본: 폴백 체인)")
    ap.add_argument("--models", default=None, help="콤마로 구분한 폴백 체인")
    ap.add_argument("--out", default=None, help="결과 JSON 저장 경로 (본문·facts·검증)")
    ap.add_argument("--out-text", default=None, help="발송 본문 텍스트 저장 경로")
    ap.add_argument("--env-file", action="append", default=[], help="환경변수 파일(.env 형식)")
    ap.add_argument("--fixture", default=None, help="오프라인 테스트용 JSON 폴더")
    ap.add_argument("--no-ai", action="store_true", help="Gemini 호출 없이 대체 본문만 생성")
    ap.add_argument("--timeout", type=int, default=60, help="Gemini 호출 타임아웃(초)")
    ap.add_argument("--max-tokens", type=int, default=4096, help="Gemini maxOutputTokens")
    ap.add_argument("--summary", default=None, help="결과 JSON 을 Actions 요약(markdown)으로 출력")
    args = ap.parse_args(argv)

    if args.summary:
        print_summary(args.summary)
        return 0

    for path in args.env_file:
        load_env_file(path)

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    tg_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = (os.environ.get("TELEGRAM_CHAT_ID") or os.environ.get("TELEGRAM_CHANNEL") or "").strip()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    facts = collect(script_dir, use_fixture=args.fixture)
    ftext = facts_text(facts)

    if args.print_facts:
        print(ftext)
        return 0

    skip, reason = market_guard(facts, force=args.force)
    if skip:
        log(f"⏭ 발송 생략 — {reason}")
        if args.out:
            write_out(args.out, {"skipped": True, "reason": reason, "facts": facts})
        return 0

    slot = args.slot or facts["asof"]["time"]
    header = build_header(slot)

    gens = []
    body = None
    validation = None
    soft_best = None   # 분량만 모자란 초안 — 형식·숫자를 통과한 것 중 가장 긴 것
    if not args.no_ai and api_key:
        models = [args.model] if args.model else (
            [m.strip() for m in args.models.split(",") if m.strip()] if args.models else DEFAULT_MODELS
        )
        base_text = f"FACTS:\n{ftext}\n\n위 FACTS만으로 5블록 장중 브리핑 본문을 작성하라."
        started = time.time()

        def model_timeout(name):
            base = args.timeout if args.timeout != 60 else 40
            return base + 15 if "lite" in name else base + 10

        def try_models(model_list, pass_no):
            nonlocal body, validation, soft_best
            for model in model_list:
                prompt = base_text
                for attempt in (1, 2):
                    if time.time() - started > 240:
                        return
                    try:
                        t0 = time.time()
                        text, usage = call_gemini(
                            api_key, model, SYSTEM_PROMPT, prompt,
                            timeout=model_timeout(model),
                            max_tokens=args.max_tokens,
                            thinking_budget=0,
                        )
                        cand = clean_body(text)
                        ok, problems = validate_body(cand, ftext, phase=(facts.get("tabs") or {}).get("session_phase"),
                                                     min_chars=body_min_chars(facts))
                        gens.append({"model": model, "pass": pass_no, "attempt": attempt, "ok": ok,
                                     "problems": problems, "chars": len(cand),
                                     "sec": round(time.time() - t0, 1), "usage": usage})
                        if ok:
                            body = cand
                            validation = {"ok": True, "problems": [], "chars": len(cand)}
                            log(f"✓ Gemini({model}) 생성·검증 통과 ({len(cand)}자, {time.time()-t0:.1f}s)")
                            return
                        hard = [p for p in problems
                                if not p.startswith(("분량 부족", "줄 수 부족"))]
                        if not hard and len(cand) >= 1500:
                            if soft_best is None or len(cand) > soft_best[0]:
                                soft_best = (len(cand), cand, problems, model)
                                log(f"… Gemini({model}) 형식·숫자는 통과, 분량 {len(cand)}자 — 후보로 보류")
                        log(f"… Gemini({model}) 검증 실패({len(cand)}자): {problems}")
                        if attempt == 1:
                            bad = [p.split(": ")[-1] for p in problems if p.startswith("근거 없는 숫자")]
                            extra = f"\n\n[재작성 지시] 아래 숫자는 FACTS에 없다. 쓰지 마라: {', '.join(bad)}" if bad else ""
                            if any(p.startswith("분량 부족") for p in problems):
                                extra += ("\n[재작성 지시] 분량이 모자란다. 각 블록을 3~6줄로 늘리고,"
                                          " FACTS에 있는 수치·종목·테마·기준선을 빠짐없이 인용해 2,000~3,200자로 써라.")
                            extra += f"\n[이전 초안의 문제] {' / '.join(problems)}"
                            prompt = (base_text + extra +
                                      "\nFACTS의 숫자만 그대로 옮기고, 지시한 5블록 형식·국면·2,000~3,200자를 지켜 다시 써라.")
                    except urllib.error.HTTPError as e:
                        detail = ""
                        try:
                            detail = e.read().decode("utf-8", "replace")[:120]
                        except Exception:  # noqa: BLE001
                            pass
                        gens.append({"model": model, "pass": pass_no, "attempt": attempt,
                                     "ok": False, "error": f"HTTP {e.code} {detail[:60]}"})
                        log(f"… Gemini({model}) HTTP {e.code} — 다음 모델")
                        break  # 같은 모델 재시도 없이 다음 모델로
                    except Exception as e:  # noqa: BLE001
                        gens.append({"model": model, "pass": pass_no, "attempt": attempt,
                                     "ok": False, "error": str(e)[:160]})
                        log(f"… Gemini({model}) 실패: {str(e)[:100]}")
                        break

        try_models(models, 1)
        if not body and any(g.get("error", "").startswith(("HTTP 429", "HTTP 503", "HTTP 500")) for g in gens):
            log("… 전 모델 실패 — 5초 뒤 한 번 더 시도")
            time.sleep(5)
            retry = [m for m in models if m in {g["model"] for g in gens
                                                if g.get("error", "").startswith(("HTTP 429", "HTTP 503", "HTTP 500"))}]
            try_models(retry, 2)

        # 분량만 모자란 초안이 있으면 대체(fallback)보다 그 초안을 살린다
        if not body and soft_best:
            body = soft_best[1]
            validation = {
                "ok": True,
                "problems": ["분량 미달이나 형식·숫자 검증 통과 → 최선 초안 채택"] + soft_best[2],
                "chars": soft_best[0],
                "model": soft_best[3],
            }
            log(f"↺ 분량 미달 최선 초안 채택 ({soft_best[0]}자, {soft_best[3]})")

    generator = "gemini"
    if not body:
        body = fallback_body(facts)
        generator = "fallback"
        validation = {"ok": True, "problems": ["Gemini 미사용 — 실측 대체 본문"], "chars": len(body)}
        log("⚠️ Gemini 본문 없음 → 실측 대체 본문으로 발송")

    header_line = header if generator == "gemini" else header.replace(
        "[🤖 Gemini AI 자동 작성]", "[🤖 자동 작성 · 실측 요약]")
    message = f"{header_line}\n{body}".strip()
    if generator == "gemini" and CHECKER_URL not in message:
        message += "\n" + CHECKER_URL
    message = fit_telegram(message)

    print("\n" + "=" * 60)
    print(message)
    print("=" * 60)
    log(f"본문 {len(message)}자 (헤더 포함, 텔레그램 한도 {TG_LIMIT}자)")

    message_id = None
    if args.dry_run:
        log("DRY-RUN — 텔레그램 발송하지 않음")
    else:
        if not tg_token or not chat_id:
            log("❌ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 없음 — 발송 불가")
            if args.out:
                write_out(args.out, {"ok": False, "reason": "missing telegram env", "message": message})
            return 2
        message_id = send_telegram(tg_token, chat_id, message)
        log(f"✓ 텔레그램 발송 완료 message_id={message_id}")

    if args.out_text:
        os.makedirs(os.path.dirname(os.path.abspath(args.out_text)), exist_ok=True)
        with open(args.out_text, "w", encoding="utf-8") as fh:
            fh.write(message + "\n")
    if args.out:
        write_out(args.out, {
            "ok": True, "generator": generator, "model": gens[-1]["model"] if gens else None,
            "validation": validation, "generations": gens, "message": message,
            "message_chars": len(message),
            "message_id": message_id, "slot": slot, "facts": facts, "facts_text": ftext,
        })
    return 0


def print_summary(path):
    """Actions $GITHUB_STEP_SUMMARY 용 markdown."""
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception as e:  # noqa: BLE001
        print(f"- 결과 JSON 읽기 실패: {e}")
        return
    if d.get("skipped"):
        print(f"- 생략 사유: {d.get('reason')}")
        return
    print(f"- 생성기: **{d.get('generator')}** · 모델: `{d.get('model')}`")
    print(f"- 본문 길이: **{d.get('message_chars') or len(d.get('message') or '')}자** (텔레그램 한도 4,096자)")
    print(f"- 텔레그램 message_id: `{d.get('message_id')}`")
    print(f"- 검증: `{d.get('validation')}`")
    for g in d.get("generations") or []:
        status = "OK" if g.get("ok") else "FAIL"
        chars = f"{g.get('chars')}자 " if g.get("chars") else ""
        sec = f"{g.get('sec')}s" if g.get("sec") else ""
        head = f"{g.get('model')} " + (f"p{g.get('pass')} " if g.get("pass") else "") + f"try{g.get('attempt')} {status} {chars}{sec}"
        parts = [head]
        if g.get("error"):
            parts.append(str(g["error"])[:80])
        if g.get("problems"):
            parts.append(" ".join(g["problems"])[:140])
        print(f"  · {' — '.join(parts)}")


def write_out(path, obj):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)


def load_env_file(path):
    """KEY=VALUE 형식(.env) 읽기. 이미 있는 환경변수는 덮어쓰지 않는다."""
    if not path or not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


if __name__ == "__main__":
    sys.exit(main())
