#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🦊 폭스시그널 · 장중 속보 (Gemini) → 텔레그램 자동 발송
================================================================
평일 10:00 · 11:00 · 13:00 · 14:00 KST 에 GitHub Actions 가 실행한다.
피클 크레딧을 쓰지 않고, Gemini API + 공개 실측 데이터만으로 5단 속보를 만들어
텔레그램 채널(@fox_signal_stock)로 보낸다.

원칙
  · 실측 팩트만 쓴다. 응답에 없는 숫자는 절대 만들지 않는다(검증기가 막는다).
  · 값이 없으면 "미수신"이라고 적는다(0·추정으로 채우지 않는다).
  · Gemini 가 실패하거나 검증을 통과하지 못하면, 같은 5단 양식을 실측값으로만
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
      주도 테마·300억↑ 대장주·선물(KIS)·뉴스·상한가·수급 참고
  · https://polling.finance.naver.com/api/realtime?query=SERVICE_INDEX:KOSPI,KOSDAQ
      코스피·코스닥 지수/등락/시고저/거래대금
  · https://m.stock.naver.com/api/index/{KOSPI,KOSDAQ}/integration
      전일 종가 · 상승/하락 종목수 · 프로그램 매매
  · https://m.stock.naver.com/api/index/{KOSPI,KOSDAQ,FUT}/trend
      외국인·기관·개인 순매수(현물 억원 / 선물 계약)
  · https://m.stock.naver.com/api/stocks/theme?page=1&pageSize=100
      업종(테마) 등락률 전수 → 받는 쪽 / 빠지는 쪽
  · https://m.stock.naver.com/api/stocks/theme/{no}
      약한 테마의 대표 종목(거래대금)
  · public/data/daily_levels.json (있으면)
      {"date":"2026-11-26","kospi":{"s1":4700,"s2":4650},"kosdaq":{"s1":645,"s2":635}}
      없으면 전일 종가를 기준선으로 쓴다.
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


def fetch_theme_rank():
    d = http_json(NAVER_THEME_LIST, timeout=20, retries=2,
                  headers={"Referer": "https://m.stock.naver.com/"})
    out = []
    for g in d.get("groups") or []:
        rate = fnum(g.get("changeRate"))
        if rate is None:
            continue
        out.append({
            "no": g.get("no"),
            "name": g.get("name"),
            "pct": rate,
            "total": fnum(g.get("totalCount")),
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


def read_daily_levels(path):
    """public/data/daily_levels.json — 없거나 형식이 다르면 None."""
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:  # noqa: BLE001
        return None
    out = {"date": d.get("date") or d.get("basisDate"), "markets": {}, "source": path}
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
        s1 = s2 = None
        for k2, v2 in node.items():
            kk = str(k2).lower()
            num = fnum(v2)
            if num is None:
                continue
            if kk in ("s1", "support1", "first", "1", "l1") and s1 is None:
                s1 = num
            elif kk in ("s2", "support2", "second", "2", "l2") and s2 is None:
                s2 = num
        if s1 is not None or s2 is not None:
            out["markets"][name] = {"s1": s1, "s2": s2}
    if not out["markets"]:
        return None
    return out


def pick_theme_leaders(tabs, limit=3):
    """tabs-live themes → 300억↑ 상승 대장주가 있는 주도 테마.

    같은 종목이 여러 테마에 중복으로 잡히므로(예: 파수AI — 재택근무·마이데이터),
    앞선 테마에서 이미 쓴 종목은 뒤 테마에서 빼고, 남는 대장주가 없으면 테마도 뺀다.
    """
    out = []
    seen = set()
    for t in (tabs or {}).get("themes") or []:
        stocks = t.get("stocks") or []
        big = []
        for s in stocks:
            val = s.get("value")
            p = s.get("changePct")
            if val is None or p is None:
                continue
            if s.get("name") in seen:
                continue
            if val >= BIG_VALUE_WON and p > 0:
                big.append({
                    "name": s.get("name"),
                    "pct": round(float(p), 2),
                    "value_eok": val / 1e8,
                    "value_basis": s.get("valueBasis"),
                })
        if not big:
            continue
        big.sort(key=lambda x: (-x["value_eok"], -x["pct"]))
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
        })
        if len(out) >= limit:
            break
    return out


def pick_decliners(tabs):
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
    return picked


def pick_upper_limit(tabs):
    ul = (tabs or {}).get("upperLimit") or {}
    rows = []
    for s in ul.get("confirmed") or []:
        rows.append({
            "name": s.get("name"),
            "pct": round(float(s.get("changePct")), 2) if s.get("changePct") is not None else None,
            "value_text": s.get("valueText"),
        })
    counts = ul.get("counts") or {}
    return {
        "count": counts.get("confirmed"),
        "near": counts.get("near"),
        "rows": rows[:3],
    }


def pick_futures(tabs):
    fk = (tabs or {}).get("futuresKis") or {}
    q = fk.get("primaryQuote") or {}
    if not fk.get("ok") or q.get("price") is None:
        return None
    contract = q.get("contract") or {}
    session = fk.get("session") or {}
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
    }


def pick_news(tabs, limit=3):
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
            "themes": n.get("matchedThemes") or [],
        })
        if len(rows) >= limit:
            break
    return rows


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

    if use_fixture:
        with open(os.path.join(use_fixture, "tabs_live.json"), encoding="utf-8") as f:
            tabs = json.load(f)
        idx = json.load(open(os.path.join(use_fixture, "indices.json"), encoding="utf-8"))
        detail = json.load(open(os.path.join(use_fixture, "detail.json"), encoding="utf-8"))
        trend = json.load(open(os.path.join(use_fixture, "trend.json"), encoding="utf-8"))
        themes = json.load(open(os.path.join(use_fixture, "themes.json"), encoding="utf-8"))
        member_path = os.path.join(use_fixture, "members.json")
        members = json.load(open(member_path, encoding="utf-8")) if os.path.exists(member_path) else {}
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
            "breadth": breadth,
            "market_status": live.get("market_status"),
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

    # ---------- 테마 ----------
    facts["themes"] = pick_theme_leaders(tabs)
    facts["decliners"] = pick_decliners(tabs)
    facts["upper_limit"] = pick_upper_limit(tabs)
    facts["news"] = pick_news(tabs)

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
        L.append(" · ".join(parts))
        b = r.get("breadth") or {}
        if b.get("up") is not None:
            L.append(f"  {r['name']} 상승 {int(b['up'])} / 하락 {int(b['down'])} / 보합 {int(b.get('flat') or 0)}"
                     f" · 상한 {int(b.get('upper') or 0)} · 하한 {int(b.get('lower') or 0)}")
    kb = (f["indices"][0].get("breadth") or {})
    qb = (f["indices"][1].get("breadth") or {})
    if kb.get("up") is not None and qb.get("up") is not None:
        L.append(f"상승:하락 합계 {int(kb['up'] + qb['up'])} : {int(kb['down'] + qb['down'])}")
    L.append("")

    fu = f.get("futures")
    L.append("[선물]")
    if fu:
        L.append(
            f"{fu.get('label') or '코스피200 선물'} {fu['price']:,.2f} ({sgn(fu.get('change'),2)}p, {pct_text(fu.get('pct'))})"
            f" · {fu.get('session') or ''} · {'실시간' if fu.get('live') else '실시간 아님'}"
        )
    else:
        L.append("코스피200 선물 미수신")
    L.append("")

    fl = f.get("flows") or {}
    L.append(f"[수급] 기준일 {md_date(fl.get('basis_date')) or '미수신'} · 네이버 투자자별 (현물 억원 / 선물 계약)")
    for key, label in (("kospi", "코스피"), ("kosdaq", "코스닥")):
        r = fl.get(key)
        if not r:
            L.append(f"{label} 수급 미수신")
            continue
        L.append(f"{label} 외국인 {sgn(r['foreign'])}억 · 기관 {sgn(r['organ'])}억 · 개인 {sgn(r['personal'])}억")
    if fl.get("spot_foreign_total") is not None:
        L.append(f"현물 합계 외국인 {sgn(fl['spot_foreign_total'])}억 · 기관 {sgn(fl['spot_organ_total'])}억")
    r = fl.get("fut")
    if r:
        L.append(f"선물 외국인 {sgn(r['foreign'])}계약 · 기관 {sgn(r['organ'])}계약 · 개인 {sgn(r['personal'])}계약")
    prog = fl.get("program")
    if prog and prog.get("total") is not None:
        L.append(f"프로그램 순매수 {sgn(prog['total'])}억 (비차익 {sgn(prog.get('bi'))}억)")
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
            head = f"{t['rank']}위 {t['name']} {strength} ({basis}구성 {int(t.get('total') or 0)} · 상승 {int(t.get('rise') or 0)}/하락 {int(t.get('fall') or 0)})"
            L.append(head)
            for s in t.get("leaders") or []:
                L.append(f"   - {s['name']} {pct_text(s['pct'])} · 대금 {money_text_eok(s['value_eok'])} ({s.get('value_basis') or ''})")
    else:
        L.append("주도 테마 미수신")
    L.append("")

    L.append("[빠지는 쪽 — 하락 업종(전체 테마 중 하위) 및 대금 300억↑ 하락 대표]")
    for t in f.get("weak_themes") or []:
        line = f"{t['name']} {pct_text(t['pct'])} (구성 {int(t.get('total') or 0)} · 상승 {int(t.get('up') or 0)}/하락 {int(t.get('down') or 0)})"
        if t.get("leader"):
            line += f" · 대표 {t['leader']['name']} {pct_text(t['leader']['pct'])} 대금 {money_text_eok(t['leader']['value_eok'])}"
        L.append(line)
    if not f.get("weak_themes"):
        L.append("하락 업종 미수신")
    for d in f.get("decliners") or []:
        L.append(f"하락 대표주 {d['name']} {pct_text(d['pct'])} · 대금 {money_text_eok(d['value_eok'])}")
    L.append("")

    ul = f.get("upper_limit") or {}
    if ul.get("count") is not None:
        names = ", ".join(f"{r['name']} {pct_text(r['pct'])}" for r in ul.get("rows") or [])
        L.append(f"[상한가] 확정 {int(ul['count'])}종목" + (f" — {names}" if names else ""))
        L.append("")

    L.append("[기준선]")
    lv = f.get("levels")
    if lv and lv.get("markets"):
        for name, node in lv["markets"].items():
            s1 = node.get("s1")
            s2 = node.get("s2")
            L.append(f"{name} 1차 {s1:,.2f} · 2차 {s2:,.2f}" if s1 is not None and s2 is not None
                     else f"{name} " + (f"1차 {s1:,.2f}" if s1 is not None else f"2차 {s2:,.2f}"))
        L.append(f"(출처 daily_levels.json {lv.get('date') or ''})")
    else:
        L.append("저장된 1·2차 지지선 없음 — 전일 종가를 기준선으로 판단할 것")
    L.append("")

    if f.get("news"):
        L.append("[뉴스]")
        for n in f["news"]:
            L.append(f"- {n['title']} ({n.get('press') or ''} {n.get('time') or ''})")
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


SYSTEM_PROMPT = """너는 한국 주식 채널 '폭스시그널'의 장중 속보 작성자다.
아래 FACTS에 적힌 실측값만으로 텔레그램용 5단 속보 본문을 쓴다.

[절대 규칙]
1. FACTS에 있는 숫자만 쓴다. FACTS에 없는 숫자·전망치·목표가·예상 지수를 만들지 않는다.
2. 합계·평균·증감률을 새로 계산하지 않는다. FACTS에 이미 적힌 값만 인용한다.
3. 숫자는 FACTS의 표기(쉼표·소수점)를 그대로 옮긴다. 단위(억/조/계약/%/p)를 바꾸지 않는다.
4. FACTS가 '미수신'이거나 '실시간 아님'이라고 하면 그 사실을 숨기지 않고 그대로 적는다.
5. FACTS의 날짜·시각을 바꾸지 않는다. 오늘 날짜와 다른 기준일이면 '기준 11/25'처럼 기준일을 밝힌다.
6. 출력은 아래 4개 블록만. 머리말·인사·인사말·설명·면책·마크다운(**·##·표) 금지.
   첫 줄은 헤드라인 **문장만** 쓴다. '헤드라인:' 같은 접두어를 붙이지 않는다.
7. 전체 900자 이내. 각 블록 1~3줄. 폴드8 세로 화면에서 읽기 좋게 한 줄에 몰아쓰지 않는다.
8. 매수·매도 '추천'이 아니라 판단과 대응만 쓴다. 근거 없는 확신('반드시', '무조건') 금지.
9. 🔄 는 정확히 두 줄이다(더 만들지 않는다).
   - 받는 쪽: '업종 — 대장 종목'을 한 줄에.
   - 빠지는 쪽: 하락 업종 한 줄. 업종이 없을 때만 '하락 대표 종목' 한 줄을 쓴다.
   업종과 종목을 서로 다른 출처에서 끌어다 '—'로 이어 붙이지 않는다.
10. 🧭 첫 줄에는 반드시 숫자를 넣어 기준선과의 관계를 적는다
    (예: '코스피 4,697.51 — 전일 종가 5,006.03 대비 -6.16%').
11. [기준 시각]의 국면을 지켜라. '장전'·'정규장'이면 '마감'·'종가 확정'이라고 쓰지 않는다
    (장중이면 '장중'·'현재'로 쓴다). 선물이 '실시간 아님'이면 세션 표기를 함께 적는다.
12. 원인·이유는 FACTS의 [뉴스]·[수급]에 적힌 것만 쓴다. FACTS에 없는 원인 추정
    ('패닉', '실망 매물', '차익실현', '기관 매도')을 새로 만들지 않는다.

[출력 형식 — 첫 줄은 헤드라인 문장 하나]
{지수 방향 + 핵심 수급 또는 주도 테마를 25자 내외로}
📊 지수
코스피 {값} ({등락}) · 코스닥 {값} ({등락}) · 선물 {값} ({등락}, {세션}) · 상승:하락 코스피 {상승}:{하락} / 코스닥 {상승}:{하락}
💰 수급
외국인 현물 코스피 {값}·코스닥 {값} / 외국인 선물 {계약} · 기관 현물 코스피 {값}·코스닥 {값} · 개인 코스피 {값} ({기준일})
🔄 빠지는 쪽 vs 받는 쪽
- 받는 쪽: {업종} {등락} — 대장 {종목} {등락} ({대금})
- 빠지는 쪽: {업종} {등락}
🧭 폭스시그널의 시각
{숫자가 들어간 기준선 판단 1줄 — 지지/이탈/근접}
{대응 1줄 — 관망/분할/추격금지/비중축소 중에서 단호하게}
""" + CHECKER_URL + """

[작성 지침]
- 헤드라인은 FACTS의 지수·수급·테마를 조합해 한 문장으로. '무엇이 왜'인지 드러나게.
- 📊 는 FACTS의 지수·선물·상승:하락만. 상승:하락은 **코스피·코스닥을 따로** 쓴다(합계만 쓰지 않는다).
- 💰 는 시장 전체 투자자별 수급(현물 억원, 선물 계약). 기준일이 오늘이 아니면 '(기준 M/D)'를 붙인다.
- 🔄 받는 쪽은 FACTS의 주도 테마와 300억↑ 대장주, 빠지는 쪽은 하락 업종, 약한 종목은 하락 대표주에서 고른다.
- 🧭 은 FACTS의 [기준선] 또는 전일 종가와 현재 지수를 비교해 판단한다. 지지선이 없으면 전일 종가를 기준으로 쓴다.
- 선물이 '실시간 아님'이면 표기 그대로 두고, 실시간인 것처럼 쓰지 않는다.
- 문장은 짧게. 이모지는 형식에 있는 것만 쓴다."""


def call_gemini(api_key, model, system_prompt, user_text, timeout=60, max_tokens=1400,
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
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    cands = data.get("candidates") or []
    if not cands:
        raise RuntimeError(f"후보 없음: {json.dumps(data)[:200]}")
    parts = (cands[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text:
        raise RuntimeError(f"빈 응답: finish={cands[0].get('finishReason')}")
    usage = data.get("usageMetadata") or {}
    return text, usage


# --------------------------------------------------------------------------- #
# 검증
# --------------------------------------------------------------------------- #
REQ_SECTIONS = ["📊 지수", "💰 수급", "🔄 빠지는 쪽 vs 받는 쪽", "🧭 폭스시그널의 시각"]
NUM_RE = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?")
URL_RE = re.compile(r"https?://\S+")
SAFE_INTS = set(range(0, 31)) | {100, 300, 500, 1000, 1500, 2000, 3000, 5000, 2025, 2026, 2027}


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


def validate_body(body, ftext, phase=None):
    """(ok, 문제점 리스트). 숫자 창작·형식 누락을 잡는다."""
    problems = []
    lines = [ln.strip() for ln in body.strip().splitlines() if ln.strip()]
    if not lines:
        return False, ["본문 비어 있음"]
    if len(lines) < 6:
        problems.append(f"줄 수 부족({len(lines)})")
    if len(body) > 1600:
        problems.append(f"본문 과다({len(body)}자)")
    for sec in REQ_SECTIONS:
        if sec not in body:
            problems.append(f"섹션 누락: {sec}")
    if CHECKER_URL not in body:
        problems.append("체커 링크 누락")
    if "**" in body or "##" in body:
        problems.append("마크다운 금지 위반")
    if phase in ("장전", "정규장") and re.search(r"(?:상승|하락|급락|급등|보합)\s*마감|마감했", body):
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
    return (not problems), problems


def clean_body(text):
    t = text.replace("\r", "").strip()
    t = re.sub(r"^\s*```[a-z]*\s*", "", t)
    t = t.replace("```", "")
    t = t.replace("**", "").replace("##", "")
    lines = [ln.rstrip() for ln in t.splitlines()]
    # 헤더를 Gemini가 다시 쓴 경우 제거
    while lines and ("장중 속보" in lines[0] and "폭스시그널" in lines[0]):
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
    return "\n".join(out).strip()


def build_header(slot):
    return f"🦊 폭스시그널 · {slot} 장중 속보 [🤖 Gemini AI 자동 작성]"


def fallback_body(f):
    """Gemini 실패 시 — 실측값만으로 같은 5단 양식."""
    k, q = f["indices"][0], f["indices"][1]
    fl = f.get("flows") or {}
    fu = f.get("futures")

    def idx_line(r):
        if r["price"] is None:
            return f"{r['name']} 미수신"
        return f"{r['name']} {r['price']:,.2f} ({pct_text(r['pct'])})"

    def breadth(r):
        b = r.get("breadth") or {}
        return f"{int(b['up'])}:{int(b['down'])}" if b.get("up") is not None else "미수신"

    fut_line = (f"{fu['price']:,.2f} ({pct_text(fu.get('pct'))}, {fu.get('session') or ''})" if fu else "미수신")

    headline_bits = [x for x in (idx_line(k), idx_line(q)) if "미수신" not in x]
    headline = " · ".join(headline_bits) if headline_bits else "장중 시황"
    if fl.get("spot_foreign_total") is not None:
        headline += f" · 외인 현물 {sgn(fl['spot_foreign_total'])}억"
    elif f["themes"]:
        headline += f" · {f['themes'][0]['name']} 강세"

    basis = f"[기준 {md_date(fl.get('basis_date'))}] " if fl.get("basis_date") else ""

    def side(r, label):
        if not r:
            return f"{label} 미수신"
        return f"{label} 외인 {sgn(r['foreign'])}억·기관 {sgn(r['organ'])}억·개인 {sgn(r['personal'])}억"

    fut_flow = (f"선물 외인 {sgn(fl['fut']['foreign'])}계약" if fl.get("fut") else "선물 수급 미수신")

    recv = []
    for t in (f.get("themes") or [])[:2]:
        lead = (t.get("leaders") or [None])[0]
        recv.append(f"- {t['name']} {pct_text(t.get('avg_pct'))}" + (
            f" — {lead['name']} {pct_text(lead['pct'])} ({money_text_eok(lead['value_eok'])})" if lead else ""))
    if not recv:
        recv.append("- 주도 테마 미수신")
    weak = []
    if f.get("weak_themes"):
        t = f["weak_themes"][0]
        line = f"- {t['name']} {pct_text(t['pct'])}"
        if t.get("leader"):
            line += f" — 대표 {t['leader']['name']} {pct_text(t['leader']['pct'])} ({money_text_eok(t['leader']['value_eok'])})"
        weak.append(line)
    elif f.get("decliners"):
        d = f["decliners"][0]
        weak.append(f"- {d['name']} {pct_text(d['pct'])} ({money_text_eok(d['value_eok'])})")
    if not weak:
        weak.append("- 하락 대표 미수신")

    # 기준선 판단
    view = []
    lv = (f.get("levels") or {}).get("markets") or {}
    kospi_lv = lv.get("코스피")
    if k["price"] is not None and kospi_lv and kospi_lv.get("s1") is not None:
        if k["price"] < kospi_lv["s1"]:
            view.append(f"코스피 {kospi_lv['s1']:,.2f} 1차 지지선 아래 — 이탈 상태")
            action = "지지 회복 확인 전 추격 금지 · 비중 축소"
        elif kospi_lv.get("s2") is not None and k["price"] < kospi_lv["s2"]:
            view.append(f"코스피 1차 {kospi_lv['s1']:,.2f} 지지선 근처")
            action = "1차 지지 확인 전 소액·관망"
        else:
            view.append(f"코스피 1차 지지선 {kospi_lv['s1']:,.2f} 위 유지")
            action = "주도 테마 눌림만 분할 대응"
    elif k["price"] is not None and k.get("prev_close") is not None:
        diff = k["price"] - k["prev_close"]
        view.append(f"코스피 전일 종가 {k['prev_close']:,.2f} 대비 {sgn(diff,2)}p ({pct_text(k.get('pct'))})")
        action = ("전일 종가 회복 전 관망 · 추격 금지" if diff < 0 else "전일 종가 위 유지 — 주도주 눌림 분할")
    else:
        view.append("지수 미수신 — 기준선 판단 불가")
        action = "실측값 확인 전 관망"
    if fl.get("spot_foreign_total") is not None and fl["spot_foreign_total"] < 0:
        action += " · 외인 순매도 지속"

    return "\n".join([
        headline,
        "📊 지수",
        f"{idx_line(k)} · {idx_line(q)} · 선물 {fut_line} · 상승:하락 코스피 {breadth(k)} / 코스닥 {breadth(q)}",
        "💰 수급",
        f"{basis}{side(fl.get('kospi'), '코스피')}",
        f"{side(fl.get('kosdaq'), '코스닥')} · {fut_flow}",
        "🔄 빠지는 쪽 vs 받는 쪽",
        *recv,
        *weak,
        "🧭 폭스시그널의 시각",
        *view,
        action,
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
    ap = argparse.ArgumentParser(description="폭스시그널 장중 속보 (Gemini → 텔레그램)")
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
    if not args.no_ai and api_key:
        models = [args.model] if args.model else (
            [m.strip() for m in args.models.split(",") if m.strip()] if args.models else DEFAULT_MODELS
        )
        base_text = f"FACTS:\n{ftext}\n\n위 FACTS만으로 5단 속보 본문을 작성하라."
        started = time.time()

        def model_timeout(name):
            base = args.timeout if args.timeout != 60 else 30
            return base + 10 if "lite" in name else base

        def try_models(model_list, pass_no):
            nonlocal body, validation
            for model in model_list:
                prompt = base_text
                for attempt in (1, 2):
                    if time.time() - started > 200:
                        return
                    try:
                        t0 = time.time()
                        text, usage = call_gemini(
                            api_key, model, SYSTEM_PROMPT, prompt,
                            timeout=model_timeout(model),
                            max_tokens=1600 if attempt == 1 else 1200,
                            thinking_budget=0,
                        )
                        cand = clean_body(text)
                        ok, problems = validate_body(cand, ftext, phase=(facts.get("tabs") or {}).get("session_phase"))
                        gens.append({"model": model, "pass": pass_no, "attempt": attempt, "ok": ok,
                                     "problems": problems, "sec": round(time.time() - t0, 1),
                                     "usage": usage})
                        if ok:
                            body = cand
                            validation = {"ok": True, "problems": []}
                            log(f"✓ Gemini({model}) 생성·검증 통과 ({time.time()-t0:.1f}s)")
                            return
                        log(f"… Gemini({model}) 검증 실패: {problems}")
                        if attempt == 1:
                            bad = [p.split(": ")[-1] for p in problems if p.startswith("근거 없는 숫자")]
                            extra = f"\n\n[재작성 지시] 아래 숫자는 FACTS에 없다. 쓰지 마라: {', '.join(bad)}" if bad else ""
                            extra += f"\n[이전 초안의 문제] {' / '.join(problems)}"
                            prompt = (base_text + extra +
                                      "\nFACTS의 숫자만 그대로 옮기고, 지시한 5단 형식·국면·900자 이내를 지켜 다시 써라.")
                    except urllib.error.HTTPError as e:
                        detail = ""
                        try:
                            detail = e.read().decode("utf-8", "replace")[:120]
                        except Exception:  # noqa: BLE001
                            pass
                        gens.append({"model": model, "pass": pass_no, "attempt": attempt,
                                     "ok": False, "error": f"HTTP {e.code}"})
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
            try_models([m for m in models if m in {g["model"] for g in gens if g.get("error", "").startswith(("HTTP 429", "HTTP 503", "HTTP 500"))}], 2)

    generator = "gemini"
    if not body:
        body = fallback_body(facts)
        generator = "fallback"
        validation = {"ok": True, "problems": ["Gemini 미사용 — 실측 대체 본문"]}
        log("⚠️ Gemini 본문 없음 → 실측 대체 본문으로 발송")

    suffix = "" if generator == "gemini" else " · Gemini 응답 실패로 실측 요약 자동 발송"
    header_line = header if generator == "gemini" else header.replace("[🤖 Gemini AI 자동 작성]",
                                                                     "[🤖 자동 작성 · 실측 요약]")
    message = f"{header_line}\n{body}".strip()
    if generator == "gemini" and CHECKER_URL not in message:
        message += "\n" + CHECKER_URL

    print("\n" + "=" * 60)
    print(message)
    print("=" * 60)

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
    print(f"- 텔레그램 message_id: `{d.get('message_id')}`")
    print(f"- 검증: `{d.get('validation')}`")
    for g in d.get("generations") or []:
        status = "OK" if g.get("ok") else "FAIL"
        parts = [f"{g.get('model')} p{g.get('pass')} try{g.get('attempt')} {status} {g.get('sec', '')}s"
                 if g.get("pass") else f"{g.get('model')} try{g.get('attempt')} {status} {g.get('sec', '')}s"]
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
