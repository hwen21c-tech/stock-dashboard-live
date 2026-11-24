#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""📌 직전 거래일 강세 Top 8 테마 스냅샷 (last-dynamic-themes.json)

장전(프리마켓 08:00~08:50)에는 네이버 테마 랭킹이 전 종목 0.00%(PREOPEN)로 내려와
`/api/tabs-live` 가 고정 8대 테마(과거 기준)로 폴백한다. 그 자리를 **직전 거래일 마감
실측 Top 8 테마**로 채우기 위해, 정규장 마감 뒤 한 번씩 이 파일을 갱신한다.

    python3 scripts/save_last_dynamic_themes.py                 # 정규장 마감 뒤 네이버 랭킹으로 저장
    python3 scripts/save_last_dynamic_themes.py --if-after-close # 15:30 이전이면 아무 것도 하지 않음
    python3 scripts/save_last_dynamic_themes.py --from-cache      # 일봉 캐시로 재계산(오프라인·확정치)
    python3 scripts/save_last_dynamic_themes.py --backfill 20261116  # 과거 기준일 복원
    python3 scripts/save_last_dynamic_themes.py --check          # 현재 파일 요약만 출력

저장 위치: sd_live/public/data/last-dynamic-themes.json
  · 테마 순위·구성종목은 관제탑 화면과 같은 규칙(노출 상위 4종목 평균 등락률 → 합산 대금)을 쓴다.
  · 값이 전부 0.00%(장전·휴장 응답)면 기존 파일을 덮어쓰지 않는다.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                       # sd_live
DATA_DIR = os.path.join(ROOT, "public", "data")
TARGET = os.path.join(DATA_DIR, "last-dynamic-themes.json")
CACHE_DIR = os.path.join(HERE, ".cache")
THEME_CACHE = os.path.join(CACHE_DIR, "themes.json")
CANDLE_CACHE = os.path.join(CACHE_DIR, "candles.json.gz")

RANK_URL = "https://m.stock.naver.com/api/stocks/theme?page=1&pageSize=100"
DETAIL_URL = "https://m.stock.naver.com/api/stocks/theme/%s?page=1&pageSize=100"
UA = {"User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36"}
TOP_N = 8
STOCK_TOP = 4
CANDIDATES = 20
OUTLIER_ABS_PCT = 100.0   # ±100% 이상은 평균·순위에서 뺀다(신규상장·상한가 첫날 왜곡)
MIN_LEADER_EOK = 300.0    # 기준주(테마 강도) 하한(억)
MIN_FILL_EOK = 100.0      # 기준주가 없을 때 쓰는 저유동성 하한(억)
VALUE_LEADER_MIN_PCT = 3.0  # '실질 거래대금 대장' 최소 상승률(사용자 확정 2026-11-23)

EXCLUDE_RE = re.compile(r"(스팩|SPAC|우선주|ETF|ETN|리츠|인버스|레버리지)", re.I)
SPAC_RE = re.compile(r"(스팩|SPAC)", re.I)
PREF_RE = re.compile(r"^\S*\d*우([A-Z])?(\(전환\))?$")
FUND_RE = re.compile(r"(KODEX|TIGER|ARIRANG|KBSTAR|HANARO|TIMEFOLIO|히어로즈|레버리지|인버스|스팩|SPAC|리츠)", re.I)
WD = "월화수목금토일"


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def now_kst():
    return datetime.now(KST)


def money_text(won):
    """lib/http.js formatKoreanMoney 와 같은 표기"""
    if won is None:
        return None
    a = abs(won)
    if a >= 1e12:
        jo = int(won // 1e12)
        eok = round((won % 1e12) / 1e8)
        return f"{jo}조 {eok:,}억" if eok > 0 else f"{jo}조"
    if a >= 1e8:
        return f"{round(won / 1e8):,}억"
    if a >= 1e4:
        return f"{round(won / 1e4):,}만"
    return f"{int(won):,}"


def norm_name(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def pick_stocks(rows, top=STOCK_TOP):
    """tabs-live.js pickThemeStocks() · lib/theme-roles.js 와 같은 규칙.

    (2026-11-24 전수 점검) 예전 코드는 '상승 종목 중 거래대금 1위'에게 무조건 '실질 거래대금 대장'을 달았고,
    그 종목이 이미 상승률 대장이면 **두 번째로 대금이 큰 종목**에 그 딱지가 옮겨 붙었다 +
    +3% 기준·±100% 이상치 제외도 빠져 있었다.
      · 👑 상승률 대장 = 상승 종목 중 등락률 1위 (동률이면 거래대금)
      · 💰 실질 거래대금 대장 = **+3% 이상 오른 종목 중** 거래대금 1위 — 둘이 같은 종목이면 👑만 단다.
      · 하락 종목은 '하락 대금 상위'로만 맨 뒤에 붙인다.
    """
    kept = [r for r in (rows or [])
            if isinstance(r.get("changePct"), (int, float)) and abs(r["changePct"]) < OUTLIER_ABS_PCT]
    rising = [r for r in kept if r["changePct"] > 0]
    falling = [r for r in kept if r["changePct"] <= 0]
    by_pct = sorted(rising, key=lambda r: (-r["changePct"], -(r.get("value") or 0)))
    by_val = sorted(rising, key=lambda r: (-(r.get("value") or 0), -r["changePct"]))
    by_val_fall = sorted(falling, key=lambda r: -(r.get("value") or 0))
    out, seen = [], set()

    def push(s, role):
        if not s or len(out) >= top or s["code"] in seen:
            return
        seen.add(s["code"])
        out.append({**s, "role": role})

    pct_leader = by_pct[0] if by_pct else None
    value_leader = next((r for r in by_val if r["changePct"] >= VALUE_LEADER_MIN_PCT
                         and (not pct_leader or r["code"] != pct_leader["code"])), None)
    push(pct_leader, "상승률 대장")
    push(value_leader, "실질 거래대금 대장")
    for s in by_pct:
        push(s, "동반 상승")
    for s in by_val:
        push(s, "거래대금 상위")
    for s in by_val_fall:
        push(s, "하락 대금 상위")
    return out


def make_theme(no, name, rows):
    """테마 1건 — 화면 4종목 + 기준주(대금 300억↑ → 100억↑ 저유동성) + 정확한 테마 평균.

    2026-11-23 수리: 예전에는 순위를 '노출 4종목 평균(top4Avg)'으로 매겨, 타임X AI +182.71%
    한 종목이 낀 '탈모 치료 +50.48%'가 1위로 남았다(실제 테마 평균 +4.66%). 이제 순위·막대는
    기준주 등락률이고, top4Avg 는 참고값으로만 남긴다(스튜디오·성적표와 같은 잣대).
    """
    picked = pick_stocks(rows)
    if not picked:
        return None
    pcts = [s["changePct"] for s in picked if isinstance(s.get("changePct"), (int, float))]
    allp = [r["changePct"] for r in rows if isinstance(r.get("changePct"), (int, float))]
    total = len(rows)
    rise = len([x for x in allp if x > 0])
    fall = len([x for x in allp if x < 0])
    steady = max(0, total - rise - fall)
    sum_value = sum((s.get("value") or 0) for s in picked)
    # ── 기준주 후보: ±100% 이상 이상치 제외, 대금 300억↑ 상승 → 100억↑(저유동성) 상승
    cands = []
    for r in rows:
        chg = r.get("changePct")
        if not isinstance(chg, (int, float)) or chg <= 0 or abs(chg) >= OUTLIER_ABS_PCT:
            continue
        eok = (r.get("value") or 0) / 1e8
        if eok < MIN_FILL_EOK:
            continue
        cands.append((r, eok < MIN_LEADER_EOK, eok))
    cands.sort(key=lambda c: (c[1], -c[0]["changePct"]))
    kept = [x for x in allp if abs(x) < OUTLIER_ABS_PCT]
    return {
        "rank": 0,
        "themeNo": no,
        "name": name,
        "keyword": name,
        "_cands": cands,
        "top4Avg": round(sum(pcts) / len(pcts), 2) if pcts else None,
        "top4Sum": sum_value,
        "avgPct": round(sum(kept) / len(kept), 2) if kept else None,
        "sumValueText": money_text(sum_value),
        "stockCount": total,
        "riseCount": rise,
        "fallCount": fall,
        "steadyCount": steady,
        "riseRatio": round(rise / total * 100, 1) if total else None,
        "stocks": [
            {
                "code": s["code"],
                "name": s["name"],
                "role": s.get("role"),
                "price": s.get("price"),
                "changePct": s.get("changePct"),
                "open": s.get("open"),
                "high": s.get("high"),
                "low": s.get("low"),
                "volume": s.get("volume"),
                "value": s.get("value"),
                "valueText": money_text(s.get("value")),
            }
            for s in picked
        ],
    }


def rank_themes(themes, top_n=TOP_N):
    """기준주(대금 300억↑ → 100억↑ 저유동성 최고 상승)를 테마마다 하나씩 배정하고 그 등락률로 줄을 세운다."""
    themes = [t for t in themes if t and t.get("top4Avg") is not None]
    # 대장 후보가 강한 테마부터 훑으며 서로 다른 종목을 대장으로 잡는다(같은 종목 중복 대장 금지)
    def _top_cand_chg(t):
        """그 테마 1순위 대장 후보의 등락률 — 후보가 없으면 -999.
        (2026-11-24) 예전엔 `_cands` 가 빈 테마에서 튜플 인덱스 오류로 이 함수 전체가 죽었다."""
        for c in (t.get("_cands") or [])[:1]:
            r = c[0] if isinstance(c, (tuple, list)) else c
            if isinstance(r, dict) and isinstance(r.get("changePct"), (int, float)):
                return r["changePct"]
        return -999

    order = sorted(themes, key=lambda t: -_top_cand_chg(t))
    used, out = set(), []
    for t in order:
        pick, low = None, False
        for r, lo, _eok in (t.get("_cands") or []):
            if r["code"] in used:
                continue
            pick, low = r, lo
            break
        if pick is None:
            continue
        used.add(pick["code"])
        t = dict(t)
        t.pop("_cands", None)
        t["leaderCode"] = pick["code"]
        t["leaderName"] = pick["name"]
        t["leaderPct"] = round(pick["changePct"], 2)
        t["leaderValueEok"] = round((pick.get("value") or 0) / 1e8, 1)
        t["lowLiquidity"] = low
        t["baselinePct"] = t["leaderPct"]
        t["baselineRule"] = "기준주(대금 300억↑ → 100억↑ 저유동성 최고 상승) 등락률 · ±100% 이상 제외"
        out.append(t)
    out.sort(key=lambda t: (-(t.get("baselinePct") or -999), -(t.get("top4Sum") or 0)))
    out = out[:top_n]
    for i, t in enumerate(out, start=1):
        t["rank"] = i
    return out


def write_snapshot(themes, as_of, basis_label, source, rank_total=None, write=True):
    payload = {
        "asOfDate": as_of,
        "basisLong": basis_label,
        "shortLabel": f"{int(as_of[4:6])}/{int(as_of[6:8])}",
        "generatedAt": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
        "source": source,
        "rankTotal": rank_total,
        "rule": "기준주(대금 300억↑ → 100억↑ 저유동성 최고 상승) 등락률 → 합산 대금 · 테마 평균 = 구성종목 평균(±100% 이상 제외)",
        "themes": themes,
    }
    if write:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = TARGET + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, TARGET)
    return payload


def all_zero(themes):
    vals = [t.get("top4Avg") for t in themes if t.get("top4Avg") is not None]
    return not vals or all(abs(v) < 0.005 for v in vals)


# ------------------------------------------------------------------ 1) 일봉 캐시 재계산
def load_candle_cache():
    if not os.path.exists(CANDLE_CACHE):
        return {}
    with gzip.open(CANDLE_CACHE, "rt", encoding="utf-8") as f:
        return json.load(f)


def load_theme_groups():
    if not os.path.exists(THEME_CACHE):
        return []
    try:
        return json.load(open(THEME_CACHE)).get("groups") or []
    except Exception:  # noqa: BLE001
        return []


def build_from_cache(basis=None, groups=None, cache=None, write=True):
    """일봉 캐시(종가·거래량)로 직전 거래일 테마 순위를 다시 계산한다(확정치, 네트워크 불필요)."""
    groups = groups if groups is not None else load_theme_groups()
    cache = cache if cache is not None else load_candle_cache()
    if not groups or not cache:
        return {"ok": False, "reason": "테마/일봉 캐시 없음"}

    latest = basis
    if not latest:
        dates = []
        for arr in cache.values():
            if arr:
                dates.append(arr[-1]["date"])
        latest = max(dates) if dates else None
    if not latest:
        return {"ok": False, "reason": "기준일 미확인"}

    def quote(code):
        arr = cache.get(code) or []
        idx = None
        for i in range(len(arr) - 1, -1, -1):
            if arr[i]["date"] == latest:
                idx = i
                break
        if idx is None or idx == 0:
            return None
        cur, prev = arr[idx], arr[idx - 1]
        if not prev.get("c"):
            return None
        return {
            "code": code,
            "price": cur["c"],
            "changePct": round((cur["c"] / prev["c"] - 1) * 100, 2),
            "open": cur.get("o"),
            "high": cur.get("h"),
            "low": cur.get("l"),
            "volume": cur.get("v"),
            "value": (cur.get("c") or 0) * (cur.get("v") or 0),
        }

    themes = []
    for g in groups:
        name = norm_name(g.get("name"))
        if not name or EXCLUDE_RE.search(name):
            continue
        rows = []
        for m in g.get("members") or []:
            nm = str(m.get("name") or "")
            code = m.get("code")
            if not code or SPAC_RE.search(nm) or FUND_RE.search(nm):
                continue
            if PREF_RE.match(nm) and not str(code).endswith("0"):
                continue
            r = quote(code)
            if not r:
                continue
            r["name"] = nm
            rows.append(r)
        if len(rows) < 3:
            continue
        t = make_theme(g.get("no"), name, rows)
        if t:
            themes.append(t)

    picked = rank_themes(themes)
    if not picked:
        return {"ok": False, "reason": "테마 0개"}
    d = datetime.strptime(latest, "%Y%m%d")
    label = f"{d.month}/{d.day}({WD[d.weekday()]}) 정규장 마감"
    payload = write_snapshot(picked, latest, label, "naver-theme-day-candles", len(themes), write=write)
    return {"ok": True, "asOfDate": latest, "themes": [f"{t['rank']}. {t['name']} {t['top4Avg']:+.2f}%" for t in picked],
            "file": TARGET, "written": write, "payload": payload}


# ------------------------------------------------------------------ 2) 네이버 랭킹(마감 직후)
def getj(url, timeout=8):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def build_from_naver(write=True):
    groups = []
    for pg in (1, 2, 3):
        try:
            d = getj(RANK_URL.replace("page=1", f"page={pg}"))
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "reason": f"테마 랭킹 실패: {e}"}
        gs = d.get("groups") or []
        if not gs:
            break
        groups += gs
        if len(groups) >= (d.get("totalCount") or 0):
            break

    rows = []
    for g in groups:
        name = norm_name(g.get("name"))
        if not g.get("no") or not name or EXCLUDE_RE.search(name):
            continue
        try:
            total = int(g.get("totalCount") or 0)
            rate = float(g.get("changeRate"))
        except Exception:  # noqa: BLE001
            continue
        if total < 3:
            continue
        rows.append({"no": g["no"], "name": name, "changeRate": rate, "totalCount": total,
                     "riseCount": int(g.get("riseCount") or 0), "fallCount": int(g.get("fallCount") or 0),
                     "steadyCount": int(g.get("steadyCount") or 0)})
    if not rows:
        return {"ok": False, "reason": "테마 랭킹이 비었습니다(장전·휴장 응답)"}
    rows.sort(key=lambda r: (-r["changeRate"], -r["totalCount"]))
    cand = rows[:CANDIDATES]

    def detail(g):
        try:
            d = getj(DETAIL_URL % g["no"])
        except Exception:  # noqa: BLE001
            return None
        out = []
        for s in d.get("stocks") or []:
            code, nm = s.get("itemCode"), str(s.get("stockName") or "")
            kind = s.get("stockEndType")
            if not code or (kind and kind != "stock"):
                continue
            if SPAC_RE.search(nm) or FUND_RE.search(nm):
                continue
            if PREF_RE.match(nm) and not str(code).endswith("0"):
                continue
            try:
                price = float(s.get("closePriceRaw"))
            except Exception:  # noqa: BLE001
                price = None
            value = None
            try:
                value = float(s.get("accumulatedTradingValueRaw"))
            except Exception:  # noqa: BLE001
                value = None
            try:
                pct = float(s.get("fluctuationsRatio"))
            except Exception:  # noqa: BLE001
                pct = None
            if s.get("compareToPreviousPrice", {}).get("name") in ("FALLING", "LOWER_LIMIT") and pct is not None:
                pct = -abs(pct)
            out.append({"code": code, "name": nm, "price": price, "changePct": pct, "value": value,
                        "open": None, "high": None, "low": None, "volume": None})
        return (g, out)

    themes = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        for res in ex.map(detail, cand):
            if not res:
                continue
            g, stocks = res
            stocks = [s for s in stocks if isinstance(s.get("changePct"), (int, float))]
            if len(stocks) < 3:
                continue
            t = make_theme(g["no"], g["name"], stocks)
            if not t:
                continue
            t["avgPct"] = g["changeRate"]           # 네이버 공식 테마 평균(전체 종목) — 참고용
            t["riseCount"] = g["riseCount"]
            t["fallCount"] = g["fallCount"]
            t["steadyCount"] = g["steadyCount"]
            t["stockCount"] = g["totalCount"]
            t["riseRatio"] = round(g["riseCount"] / g["totalCount"] * 100, 1) if g["totalCount"] else None
            themes.append(t)
    picked = rank_themes(themes)
    if not picked:
        return {"ok": False, "reason": "테마 0개"}
    if all_zero(picked):
        return {"ok": False, "reason": "테마 등락률이 전부 0.00% — 저장하지 않음"}
    today = now_kst().strftime("%Y%m%d")
    d = now_kst()
    label = f"{d.month}/{d.day}({WD[d.weekday()]}) 정규장 마감"
    write_snapshot(picked, today, label, "naver-theme-ranking", len(rows), write=write)
    return {"ok": True, "asOfDate": today, "themes": [f"{t['rank']}. {t['name']} {t.get('baselinePct', t['top4Avg']):+.2f}%"
                                                      + (" (저유동성)" if t.get("lowLiquidity") else "") for t in picked],
            "file": TARGET, "written": write}


# ------------------------------------------------------------------ 3) 뒤처리
def save_after_close(force=False, write=True):
    """정규장 마감(15:30) 뒤 한 번 — 오늘 이미 저장했으면 즉시 건너뛴다."""
    now = now_kst()
    if now.weekday() >= 5:
        return {"ok": False, "skipped": "주말"}
    if now.hour * 60 + now.minute < 15 * 60 + 30:
        return {"ok": False, "skipped": "장중"}
    today = now.strftime("%Y%m%d")
    if not force and os.path.exists(TARGET):
        try:
            cur = json.load(open(TARGET))
            if str(cur.get("asOfDate")) == today:
                return {"ok": True, "skipped": f"이미 저장({today})"}
        except Exception:  # noqa: BLE001
            pass
    return build_from_naver(write=write)


def summary():
    if not os.path.exists(TARGET):
        return {"ok": False, "reason": "파일 없음", "path": TARGET}
    d = json.load(open(TARGET))
    return {"ok": True, "path": TARGET, "asOfDate": d.get("asOfDate"), "basisLong": d.get("basisLong"),
            "generatedAt": d.get("generatedAt"), "source": d.get("source"),
            "themes": [f"{t['rank']}. {t['name']} {t.get('baselinePct', t['top4Avg']):+.2f}%"
                       + (" (저유동성)" if t.get("lowLiquidity") else "")
                       + f" ← {t.get('leaderName') or '—'} "
                       + " / ".join(f"{s['name']} {s['changePct']:+.1f}%" for s in t["stocks"])
                       for t in d.get("themes") or []]}


def main():
    ap = argparse.ArgumentParser(description="직전 거래일 강세 Top 8 테마 스냅샷")
    ap.add_argument("--from-cache", action="store_true", help="일봉 캐시로 재계산(오프라인)")
    ap.add_argument("--backfill", help="과거 기준일 재계산(YYYYMMDD, 일봉 캐시)")
    ap.add_argument("--if-after-close", action="store_true", help="정규장 마감 전이면 건너뜀")
    ap.add_argument("--check", action="store_true", help="현재 파일 요약만")
    ap.add_argument("--dry", action="store_true", help="파일을 쓰지 않고 결과만")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    if args.check:
        print(json.dumps(summary(), ensure_ascii=False, indent=1))
        return 0
    if args.backfill or args.from_cache:
        res = build_from_cache(basis=args.backfill, write=not args.dry)
    elif args.if_after_close:
        res = save_after_close(force=args.force, write=not args.dry)
    else:
        res = build_from_naver(write=not args.dry) if args.force else save_after_close(force=False, write=not args.dry)
    res.pop("payload", None)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    return 0 if res.get("ok") or res.get("skipped") else 1


if __name__ == "__main__":
    sys.exit(main())
