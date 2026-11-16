#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""📊🎯 관제탑 비중법사 · 홍인기 자동 재스캔 (rescan_strategies.py)

전 종목 실측 일봉을 다시 받아 「비중법사 기준봉·1일차」와 「홍인기 D+0·D+1·D+2」 후보를
새로 계산하고, 관제탑(public/index.html) 안의 내장 스냅샷과 public/data/*.json 을
최신 기준일로 갈아끼운다. UI·4분할선·200일 캔들·타점 계산 로직은 건드리지 않는다.

    python3 scripts/rescan_strategies.py                 # 오늘 기준 1회 (필요 없으면 skip)
    python3 scripts/rescan_strategies.py --force         # 무조건 다시 스캔
    python3 scripts/rescan_strategies.py --dry           # JSON만 만들고 HTML은 그대로
    python3 scripts/rescan_strategies.py --check         # 네트워크 없이 현재 HTML 점검
    python3 scripts/rescan_strategies.py --basis 20261112 --dry   # 과거 기준일 검증

종료 코드: 0 정상 · 3 일봉 수집이 시간 예산에 걸려 다음 실행에서 이어받기 · 1 오류
"""
import argparse
import gzip
import json
import math
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PUB = os.path.join(ROOT, "public")
DATA_DIR = os.path.join(PUB, "data")
CACHE_DIR = os.path.join(HERE, ".cache")
CANDLE_CACHE = os.path.join(CACHE_DIR, "candles.json.gz")
THEME_CACHE = os.path.join(CACHE_DIR, "themes.json")
INDEX_CACHE = os.path.join(CACHE_DIR, "index-days.json")
STATE_PATH = os.path.join(CACHE_DIR, "state.json")
HTML = os.path.join(PUB, "index.html")
LATEST = os.path.join(DATA_DIR, "strategies-latest.json")

UA = {"User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36"}
WD = "월화수목금토일"
CAFE_MIN, CAFE_STOP = 2.0, -3.0          # 카페 통계(56717·38802) 기준봉 +2% / 손절 -3%
BIJ_TH = {"chg": 5.0, "volX": 1.8, "valueEok": 300.0, "bodyRate": 10.0, "upperMax": 12.0}

ETF_PAT = re.compile(r"(KODEX|TIGER|ARIRANG|KBSTAR|HANARO|SOL |ACE |RISE |PLUS |TIMEFOLIO|BNK|ETN|레버리지|인버스|스팩|리츠|KTOP|KRX|FOCUS|히어로즈|마이다스|우리 |WON |파워|합성)", re.I)
PREF_PAT = re.compile(r"(우B?|우C|1우|2우B?|3우B?)$")


# ------------------------------------------------------------------ 공통 유틸
def log(msg):
    print(msg, file=sys.stderr, flush=True)


def now_kst():
    return datetime.now(KST)


def get(url, timeout=20, retries=2):
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:          # noqa: BLE001 — 네이버가 종종 한 번씩 끊는다
            last = e
            time.sleep(0.3 + i * 0.7)
    raise last


def getj(url, timeout=20):
    return json.loads(get(url, timeout).decode("utf-8", "ignore"))


def num(s):
    if s is None:
        return None
    s = str(s).replace(",", "").replace("%", "").strip()
    if s in ("", "N/A", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def dshort(d):
    return f"{d[4:6]}/{d[6:8]}"


def dlong(d):
    y, m, dd = d[:4], d[4:6], d[6:8]
    try:
        w = WD[datetime(int(y), int(m), int(dd)).weekday()]
    except Exception:                 # noqa: BLE001
        w = ""
    return f"{y}-{m}-{dd}({w})"


def dlong_short(d):
    try:
        w = WD[datetime(int(d[:4]), int(d[4:6]), int(d[6:8])).weekday()]
    except Exception:                 # noqa: BLE001
        w = ""
    return f"{d[4:6]}/{d[6:8]}({w})"


def next_trading_day(basis):
    """기준일 다음 평일(공휴일은 알 수 없으므로 주말만 건너뛴다)."""
    d = datetime(int(basis[:4]), int(basis[4:6]), int(basis[6:8]))
    d += timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d.strftime("%Y%m%d")


def pct(a, b):
    return (a / b - 1) * 100 if b else 0.0


def nf(v):
    return f"{v:,.0f}"


def ps(v):
    return f"{v:+.2f}%"


# ------------------------------------------------------------------ 1) 거래일
def trading_days(count=6):
    """KOSPI 지수 일봉에서 최근 거래일을 얻는다(공휴일 반영). 실패하면 캐시."""
    days = []
    try:
        xml = get("https://fchart.stock.naver.com/sise.nhn?symbol=KOSPI&timeframe=day&count=30&requestType=0", timeout=15).decode("euc-kr", "ignore")
        days = [m.group(1).split("|")[0] for m in re.finditer(r'<item data="([^"]+)"\s*/>', xml)]
        days = days[-count:]
        if days:
            os.makedirs(CACHE_DIR, exist_ok=True)
            json.dump({"at": now_kst().strftime("%Y-%m-%d %H:%M:%S"), "days": days}, open(INDEX_CACHE, "w"))
    except Exception as e:             # noqa: BLE001
        log(f"  ! 지수 일봉 실패({e}) — 캐시 사용")
        try:
            days = json.load(open(INDEX_CACHE))["days"][-count:]
        except Exception:              # noqa: BLE001
            days = []
    return days


# ------------------------------------------------------------------ 2) 유니버스
def fetch_rank(kind, market, pages=30):
    out, total = [], None
    for p in range(1, pages + 1):
        try:
            data = getj(f"https://m.stock.naver.com/api/stocks/{kind}/{market}?page={p}&pageSize=100")
        except Exception as e:         # noqa: BLE001
            log(f"  ! {kind}/{market} p{p}: {e}")
            break
        if total is None:
            total = data.get("totalCount")
        stocks = data.get("stocks") or []
        if not stocks:
            break
        out.extend(stocks)
        if total and len(out) >= total:
            break
        time.sleep(0.03)
    return out, total


def build_universe(pages=30):
    rows, totals = [], {}
    for market, label in (("KOSPI", "코스피"), ("KOSDAQ", "코스닥")):
        up, t1 = fetch_rank("up", market, pages)
        dn, t2 = fetch_rank("down", market, pages)
        totals[label] = {"up": t1, "down": t2}
        log(f"  {label}: 상승 {len(up)}건(총 {t1}) · 하락 {len(dn)}건(총 {t2})")
        for r in up + dn:
            r["_market"] = label
            rows.append(r)
        # 전 종목 명단(시가총액순) — 상승·하락 랭킹은 '오늘 움직인 종목'만 주므로
        #  장중에 돌리면 기준일(예: 직전 거래일) 후보가 통째로 빠진다. 명단으로 메꾼다.
        try:
            mv, t3 = fetch_rank("marketValue", market, pages)
            for r in mv:
                r["_market"] = label
                r["_list_only"] = True
                rows.append(r)
            log(f"  {label}: 전 종목 명단 {len(mv)}건(총 {t3})")
        except Exception as e:         # noqa: BLE001
            log(f"  ! {label} 전 종목 명단 실패: {e}")
    seen, uni = set(), []
    for r in rows:
        code, name = r.get("itemCode"), r.get("stockName") or ""
        if not code or not re.match(r"^\d{6}$", code) or code in seen:
            continue
        if ETF_PAT.search(name) or PREF_PAT.search(name):
            continue
        p, val = num(r.get("fluctuationsRatio")), num(r.get("accumulatedTradingValue"))
        if r.get("_list_only"):
            # 명단(시총순) 행은 당일 등락률·대금이 비어 있을 수 있다 - 후보 판정은 일봉(per)으로 하므로 0으로 둔다.
            p = 0.0 if p is None else p
            val = 0.0 if val is None else val
        elif p is None or val is None:
            continue
        seen.add(code)
        uni.append({"code": code, "name": name, "market": r["_market"], "pct": p,
                    "value_eok": round(val / 100, 1), "status": r.get("marketStatus")})
    uni.sort(key=lambda x: -x["value_eok"])
    for i, u in enumerate(uni):
        u["rank"] = i + 1
    log(f"  유니버스 {len(uni)}종목 (대금 1위 {uni[0]['name']} {uni[0]['value_eok']:,.0f}억)" if uni else "  유니버스 0종목")
    return uni, totals


# ------------------------------------------------------------------ 3) 테마
def build_themes(ttl_hours=12):
    if os.path.exists(THEME_CACHE):
        try:
            d = json.load(open(THEME_CACHE))
            saved = datetime.strptime(d.get("savedAt", ""), "%Y-%m-%d %H:%M:%S")
            age = (datetime.now() - saved).total_seconds() / 3600
            if d.get("groups") and age < ttl_hours:
                log(f"  테마 캐시 {len(d['groups'])}개 재사용 ({age:.1f}h 전)")
                return d["groups"]
        except Exception:              # noqa: BLE001
            pass
    groups = []
    for pg in (1, 2, 3, 4):
        try:
            d = getj(f"https://m.stock.naver.com/api/stocks/theme?page={pg}&pageSize=100")
        except Exception as e:         # noqa: BLE001
            log(f"  ! 테마 목록 p{pg}: {e}")
            break
        gs = d.get("groups") or []
        if not gs:
            break
        groups += gs

    def detail(g):
        try:
            det = getj(f"https://m.stock.naver.com/api/stocks/theme/{g['no']}?page=1&pageSize=100")
        except Exception:              # noqa: BLE001
            return None
        mem = [{"code": s.get("itemCode"), "name": s.get("stockName")}
               for s in (det.get("stocks") or []) if s.get("itemCode")]
        return {"no": g["no"], "name": g["name"], "members": mem}

    out = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        for r in ex.map(detail, groups):
            if r and r["members"]:
                out.append(r)
    if out:
        os.makedirs(CACHE_DIR, exist_ok=True)
        json.dump({"savedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "groups": out},
                  open(THEME_CACHE, "w"), ensure_ascii=False)
    log(f"  테마 {len(out)}개 수집")
    return out


# ------------------------------------------------------------------ 4) 일봉 캐시
def load_cache():
    if not os.path.exists(CANDLE_CACHE):
        return {}
    try:
        with gzip.open(CANDLE_CACHE, "rt", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:             # noqa: BLE001
        log(f"  ! 캐시 읽기 실패({e}) — 새로 시작")
        return {}


def save_cache(cache):
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = CANDLE_CACHE + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as f:
        json.dump(cache, f, separators=(",", ":"))
    os.replace(tmp, CANDLE_CACHE)


def seed_cache(seed_path, cache):
    """기존 핸드오프의 candles_all.json 이 있으면 첫 수집을 건너뛴다."""
    if cache or not seed_path or not os.path.exists(seed_path):
        return cache
    try:
        log(f"  기존 일봉 DB 시드: {seed_path}")
        cache = json.load(open(seed_path))
        log(f"  {len(cache)}종목 시드 완료")
        save_cache(cache)
    except Exception as e:             # noqa: BLE001
        log(f"  ! 시드 실패: {e}")
        cache = {}
    return cache


def fetch_candles_one(code, count):
    try:
        raw = get(f"https://fchart.stock.naver.com/sise.nhn?symbol={code}&timeframe=day&count={count}&requestType=0", timeout=15)
    except Exception:                  # noqa: BLE001
        return code, None
    xml = raw.decode("euc-kr", "ignore")
    items = []
    for m in re.finditer(r'<item data="([^"]+)"\s*/>', xml):
        p = m.group(1).split("|")
        if len(p) < 6:
            continue
        try:
            items.append({"date": p[0], "o": float(p[1]), "h": float(p[2]),
                          "l": float(p[3]), "c": float(p[4]), "v": float(p[5])})
        except ValueError:
            continue
    items.sort(key=lambda x: x["date"])
    return code, items


def merge_bars(old, new):
    by = {b["date"]: b for b in (old or [])}
    for b in new or []:
        by[b["date"]] = b
    out = [by[k] for k in sorted(by)]
    return out[-400:]


def refresh_candles(cache, codes, basis, workers=8, budget=420.0, recent=90):
    """캐시가 기준일까지 와 있지 않은 종목만 최근 봉을 다시 받아 합친다."""
    todo = []
    for c in codes:
        cs = cache.get(c)
        if cs and len(cs) > 130 and cs[-1]["date"] >= basis:
            continue
        todo.append(c)
    log(f"  일봉 갱신 대상 {len(todo)}/{len(codes)}종목")
    t0 = time.time()
    done = 0
    incomplete = 0
    if todo:
        def job(code):
            return fetch_candles_one(code, recent if (cache.get(code) and len(cache.get(code)) > 130) else 260)

        with ThreadPoolExecutor(max_workers=workers) as ex:
            for code, bars in ex.map(job, todo):
                done += 1
                if bars:
                    cache[code] = merge_bars(cache.get(code), bars)
                else:
                    incomplete += 1
                if done % 200 == 0:
                    save_cache(cache)
                    log(f"    {done}/{len(todo)} ({time.time() - t0:.0f}s)")
                if time.time() - t0 > budget:
                    log(f"  ! 시간 예산 {budget:.0f}s 초과 — {done}/{len(todo)}까지만 저장")
                    break
    save_cache(cache)
    left = [c for c in codes if not (cache.get(c) and len(cache.get(c)) > 130)]
    log(f"  일봉 확보 {len(cache)}종목 · 실패 {incomplete} · 데이터 부족 {len(left)} ({time.time() - t0:.0f}s)")
    return len(left) <= max(60, len(codes) // 40)


# ------------------------------------------------------------------ 5) 지표 계산
def sma(vals, n):
    out, run = [], 0.0
    for i, v in enumerate(vals):
        run += v
        if i >= n:
            run -= vals[i - n]
        out.append(run / n if i >= n - 1 else None)
    return out


def day_records(code, cs, days):
    idx = {c["date"]: i for i, c in enumerate(cs)}
    closes = [c["c"] for c in cs]
    s5, s20, s120 = sma(closes, 5), sma(closes, 20), sma(closes, 120)
    pcts = [0.0] + [pct(cs[k]["c"], cs[k - 1]["c"]) for k in range(1, len(cs))]
    recs = {}
    for d in days:
        i = idx.get(d)
        if i is None or i < 122 or i >= len(cs):
            continue
        cur, prev = cs[i], cs[i - 1]
        win = cs[i - 120:i]
        hi = max(x["h"] for x in win)
        hi_date = max(win, key=lambda x: x["h"])["date"]
        p = pcts[i]
        prior10 = sum(1 for k in range(i - 60, i) if pcts[k] >= 10.0)
        recs[d] = {
            "date": d, "i": i,
            "o": cur["o"], "h": cur["h"], "l": cur["l"], "c": cur["c"], "v": cur["v"],
            "prevClose": prev["c"], "pct": round(p, 2),
            "valueEok": round(cur["v"] * cur["c"] / 1e8, 1),
            "hi120": hi, "hi120Date": hi_date,
            "dist120": round((hi - cur["c"]) / cur["c"] * 100 if cur["c"] else 999.0, 2),
            "breakout": cur["c"] >= hi,
            "big": p >= 10.0,
            "firstBig": (p >= 10.0 and cur["c"] >= hi and prior10 == 0),
            "priorBig60": prior10,
            "upper": round((cur["h"] - cur["c"]) / cur["c"] * 100 if cur["c"] else 0.0, 2),
            "body": round((cur["c"] - cur["o"]) / cur["o"] * 100 if cur["o"] else 0.0, 2),
            "sma5": s5[i], "sma20": s20[i], "sma120": s120[i],
        }
    return recs


# ------------------------------------------------------------------ 6) 홍인기
HONG_STEPS = [("d30", "② 대금 30·500억↑"), ("up5", "③ +5%↑"), ("theme3", "④⑤ 테마 3종목"),
              ("break", "⑥ 120일 전고점"), ("bigbar", "장대양봉 +10%"), ("first", "첫 장대양봉")]


def build_hong(uni, per, themes, days, totals, cap=12):
    names = {u["code"]: u for u in uni}
    D0_, D1_, D2_ = days[0], days[1], days[2]
    L0, L1, L2 = dshort(D0_), dshort(D1_), dshort(D2_)

    MEM = {}
    for t in themes:
        for m in t["members"]:
            MEM.setdefault(m["code"], []).append(t)

    RANK = {}
    for d in days:
        vals = sorted(((c, per[c][d]["valueEok"]) for c in per if d in per[c]), key=lambda x: -x[1])
        RANK[d] = {code: i + 1 for i, (code, _) in enumerate(vals)}

    def rec(code, day):
        return per.get(code, {}).get(day)

    def rank_of(code, day):
        return RANK.get(day, {}).get(code, 9999)

    def big_on(code, day):
        r = rec(code, day)
        return bool(r and r["pct"] >= 10.0)

    def anchor_on(code, day):
        r = rec(code, day)
        return bool(r and r["pct"] >= 10.0 and r["breakout"])

    def day_theme(code, day):
        if code not in per or day not in per[code]:
            return None
        best = None
        for t in MEM.get(code, []):
            pcts = [per[m["code"]][day]["pct"] for m in t["members"]
                    if m["code"] in per and day in per[m["code"]]]
            if len(pcts) < 2:
                continue
            rate = sum(pcts) / len(pcts)
            ups = [{"code": m["code"], "name": m["name"], "pct": per[m["code"]][day]["pct"]}
                   for m in t["members"]
                   if m["code"] in per and day in per[m["code"]] and per[m["code"]][day]["pct"] >= 5.0]
            comps = [x for x in ups if x["code"] != code]
            cand = {"name": t["name"], "rate": round(rate, 2),
                    "companions": sorted(comps, key=lambda x: -x["pct"]),
                    "companionCount": len(comps)}
            if best is None or cand["rate"] > best["rate"]:
                best = cand
        return best

    def steps_of(code, day):
        r = rec(code, day)
        th = day_theme(code, day)
        rank = rank_of(code, day)
        st = {"d30": rank <= 30 and r["valueEok"] >= 500,
              "up5": r["pct"] >= 5.0,
              "theme3": bool(th) and th["companionCount"] >= 2,
              "break": r["breakout"] or r["dist120"] <= 3.0,
              "bigbar": r["pct"] >= 10.0,
              "first": r["firstBig"]}
        return st, th, rank

    def derive(code):
        cs = CANDLES_REF.get(code)
        if not cs:
            return None
        closes = [c["c"] for c in cs]
        last = cs[-1]
        avg20v = sum(c["v"] for c in cs[-21:-1]) / 20 if len(cs) >= 21 else 0
        daysx = []
        for i in range(max(1, len(cs) - 90), len(cs)):
            if cs[i - 1]["c"] == 0:
                continue
            daysx.append((cs[i]["date"], pct(cs[i]["c"], cs[i - 1]["c"]), cs[i]["v"]))
        streak = best = 0
        for _, dd, _ in daysx:
            if dd >= 10.0:
                streak += 1
                best = max(best, streak)
            else:
                streak = 0

        def sm(n):
            return sum(closes[-n:]) / n if len(closes) >= n else closes[-1]

        return {
            "candles": [{"d": c["date"], "o": c["o"], "h": c["h"], "l": c["l"], "c": c["c"], "v": c["v"]} for c in cs[-130:]],
            "spark15": [[c["date"], c["c"], c["v"]] for c in cs[-15:]],
            "chg5": round(pct(last["c"], closes[-6]), 2) if len(closes) >= 6 else 0.0,
            "chg20": round(pct(last["c"], closes[-21]), 2) if len(closes) >= 21 else 0.0,
            "volRatio": round(last["v"] / avg20v, 2) if avg20v else None,
            "m5": round(sm(5), 1), "m20": round(sm(20), 1), "m120": round(sm(120), 1),
            "kki": {"limitUp": sum(1 for _, dd, _ in daysx if dd >= 29.0),
                    "up20": sum(1 for _, dd, _ in daysx if dd >= 20.0),
                    "up10": sum(1 for _, dd, _ in daysx if dd >= 10.0),
                    "maxDay": round(max((dd for _, dd, _ in daysx), default=0.0), 2),
                    "maxStreak": best},
        }

    # ---- 후보 선정 (기준일 D+0 / 전일 기준봉 D+1 / 전전일 기준봉 D+2)
    d0_codes = sorted([c for c in per if anchor_on(c, D2_)], key=lambda c: -per[c][D2_]["valueEok"])[:cap]
    d1_all = [c for c in per if big_on(c, D1_) and rec(c, D1_)["valueEok"] >= 200
              and rec(c, D2_) and rec(c, D2_)["l"] < rec(c, D1_)["c"]]
    d1_all.sort(key=lambda c: -rec(c, D2_)["valueEok"])
    d1_codes = [c for c in d1_all if c not in d0_codes][:4]
    d2_all = [c for c in per if anchor_on(c, D0_) and c not in d0_codes + d1_codes
              and rec(c, D1_) and rec(c, D1_)["c"] and pct(rec(c, D1_)["c"], rec(c, D0_)["c"]) >= CAFE_MIN]
    d2_codes = sorted(d2_all, key=lambda c: -rec(c, D2_)["valueEok"])[:2]

    # 근접 = 6단계 중 장대양봉 계열만 미달 (기준일)
    near_codes = []
    for code in per:
        if D2_ not in per[code] or code in d0_codes:
            continue
        st, th, rank = steps_of(code, D2_)
        miss = [k for k, v in st.items() if not v]
        if miss and all(k in ("bigbar", "first") for k in miss):
            near_codes.append(code)
    near_codes.sort(key=lambda c: -per[c][D2_]["valueEok"])
    near_codes = near_codes[:2]

    def strip(code, anchor_day):
        out = []
        ai = days.index(anchor_day) if anchor_day in days else None
        for i, d in enumerate(days):
            r = rec(code, d)
            if not r:
                out.append({"d": d, "none": True})
                continue
            if ai is None or i < ai:
                tag, cls = ("장대양봉 · 전고 미달", "miss") if big_on(code, d) else ("—", "none")
            elif i == ai:
                tag, cls = ("D+0 기준봉", "d0") if anchor_on(code, d) else ("기준봉 · 전고 미달", "miss")
            else:
                k = i - ai
                if anchor_on(code, d):
                    tag, cls = f"D+{k} · 재부합 D+0", "d0"
                elif k == 1:
                    tag, cls = "D+1 눌림", "d1"
                else:
                    tag, cls = f"D+{k} 연장", "d2"
            out.append({"d": d, "o": r["o"], "h": r["h"], "l": r["l"], "c": r["c"], "pct": r["pct"],
                        "valueEok": r["valueEok"], "tag": tag, "cls": cls,
                        "breakout": r["breakout"], "big": big_on(code, d)})
        return out

    def plan(code):
        r = rec(code, D2_)
        base, bar = r["c"], r["pct"]
        ok = bar >= CAFE_MIN
        return {"base": base, "bar": round(bar, 2), "pass": ok,
                "tp5": round(base * 1.05), "tp10": round(base * 1.10),
                "stop": round(base * (1 + CAFE_STOP / 100)),
                "verdict": (f"B — {L2} 기준봉 {ps(bar)} (≥ +2%) · {dshort(next_trading_day(D2_))} 눌림 매수 유효") if ok
                           else (f"G — {L2} 기준봉 {ps(bar)} (< +2%) · {dshort(next_trading_day(D2_))} 신규 눌림 패스")}

    def gap_stats(code, base_day, day):
        a, b = rec(code, base_day), rec(code, day)
        return {"gap": round(pct(b["o"], a["c"]), 2), "low": round(pct(b["l"], a["c"]), 2),
                "high": round(pct(b["h"], a["c"]), 2), "close": round(pct(b["c"], a["c"]), 2),
                "base": a["c"]}

    def card(code, kind):
        r = rec(code, D2_)
        dv = derive(code)
        st, th, rank = steps_of(code, D2_)
        passed = sum(1 for k, _ in HONG_STEPS if st[k])
        reasons, flags = [], []
        if kind == "D0":
            reasons.append(f"⑥ {L2} <b>120일 전고점 {nf(r['hi120'])}원({dshort(r['hi120Date'])})을 종가로 돌파</b> · "
                           f"{ps(r['pct'])} ({nf(r['c'])}원) · 위꼬리 {r['upper']:.1f}%")
            reasons.append(f"장대양봉 {ps(r['pct'])} · 직전 60거래일 +10%↑ {r['priorBig60']}회 → "
                           f"{'첫 장대양봉 아님(재부합)' if r['priorBig60'] else '첫 장대양봉'}")
            reasons.append(f"② 거래대금 {nf(r['valueEok'])}억 · 전 종목 {rank}위 — 홍인기 기준(상위 30·500억) "
                           f"{'<b>충족</b>' if st['d30'] else '<b>미달</b>'}")
            if th:
                cs = ", ".join(f"{m['name']} {m['pct']:+.1f}%" for m in th["companions"][:4])
                reasons.append(f"④⑤ 테마 <b>{th['name']}</b>(테마 {th['rate']:+.2f}%) — 5%↑ 동반 {th['companionCount']}종목" + (f" ({cs})" if cs else ""))
            else:
                reasons.append("④⑤ 네이버 테마 분류상 같은 테마 5%↑ 동반 종목 없음 — 개별 재료")
        elif kind == "D1":
            p0 = rec(code, D1_)
            g = gap_stats(code, D1_, D2_)
            reasons.append(f"{L1} <b>기준봉</b> {ps(p0['pct'])} ({nf(p0['c'])}원 · 대금 {nf(p0['valueEok'])}억 · {rank_of(code, D1_)}위) "
                           f"— 120일 전고점 {nf(p0['hi120'])}원 {'<b>돌파</b>' if p0['breakout'] else '대비 ' + ps(-p0['dist120'])}")
            low_txt = ("<b>눌림 없음</b>(저가 = 전일 종가)" if g["low"] >= 0 else f"저가 {nf(r['l'])}원(<b>눌림 {g['low']:+.2f}%</b>)")
            reasons.append(f"{L2} <b>D+1</b> 기준선(전일 종가) {nf(g['base'])}원 → 시가 {nf(r['o'])}원({ps(g['gap'])} 갭) · "
                           f"{low_txt} · 고가 {nf(r['h'])}원(반등 {g['high']:+.2f}%) · 종가 {ps(g['close'])}")
            if th:
                reasons.append(f"④⑤ 테마 <b>{th['name']}</b> — 5%↑ 동반 {th['companionCount']}종목 · {L2} 대금 {nf(r['valueEok'])}억 {rank}위")
            else:
                reasons.append(f"② {L2} 대금 {nf(r['valueEok'])}억 · 전 종목 {rank}위 · 위꼬리 {r['upper']:.1f}%")
        elif kind == "NEAR":
            miss = [lab for k, lab in HONG_STEPS if not st[k]]
            reasons.append(f"{L2} 실측 <b>{ps(r['pct'])}</b>({nf(r['c'])}원) · 시가 {nf(r['o'])}원 · 고가 {nf(r['h'])}원 · 저가 {nf(r['l'])}원 · 위꼬리 {r['upper']:.1f}%")
            reasons.append(f"② 거래대금 {nf(r['valueEok'])}억 · 전 종목 <b>{rank}위</b> {'✓' if st['d30'] else '✕'} · ③ {ps(r['pct'])} {'✓' if st['up5'] else '✕'} · "
                           f"⑥ 120일 전고점 {nf(r['hi120'])}원({dshort(r['hi120Date'])}) "
                           + ("을 종가로 돌파 ✓" if r["breakout"] else "까지 " + ps(-r["dist120"]))
                           + (f" · ④⑤ {th['name']} 5%↑ 동반 {th['companionCount']}종목 ✓" if th and th["companionCount"] >= 2 else ""))
            reasons.append(f"미달 — <b>{' / '.join(miss)}</b>. 장대양봉 기준은 +10%인데 실제 {ps(r['pct'])}, "
                           f"직전 60거래일 +10%↑ {r['priorBig60']}회 → 6단계 중 {len(miss)}개에서 멈춤")
        else:
            p0, p1 = rec(code, D0_), rec(code, D1_)
            b1 = pct(p1["c"], p0["c"])
            g = gap_stats(code, D1_, D2_)
            reasons.append(f"{L0} <b>D+0</b> {ps(p0['pct'])}({nf(p0['c'])}원 · 전고점 돌파 장대양봉) → "
                           f"{L1} <b>D+1</b> {ps(b1)} — 기준봉 {'+2%↑ 유지(B)' if b1 >= CAFE_MIN else '+2% 미달'}")
            low_txt2 = ("<b>눌림 없음</b>(저가 = 전일 종가)" if g["low"] >= 0 else f"저가 {nf(r['l'])}원(<b>눌림 {g['low']:+.2f}%</b>)")
            reasons.append(f"{L2} <b>D+2</b> 기준선 {nf(g['base'])}원 → 시가 {nf(r['o'])}원({ps(g['gap'])} 갭) · "
                           f"{low_txt2} · 고가 {nf(r['h'])}원(반등 {g['high']:+.2f}%) · 종가 {ps(g['close'])}")
            reasons.append(f"② 대금 {nf(r['valueEok'])}억 · 전 종목 {rank}위 · 위꼬리 {r['upper']:.1f}%")
        reasons.append(f"끼 판별 실측(최근 90거래일) — 상한가 {dv['kki']['limitUp']}회 · +20%↑ {dv['kki']['up20']}회 · "
                       f"+10%↑ {dv['kki']['up10']}회 · 최대 {dv['kki']['maxDay']:+.1f}% · 연속 장대 {dv['kki']['maxStreak']}일")

        if r["valueEok"] < 500:
            flags.append(f"거래대금 {nf(r['valueEok'])}억 — 홍인기 기준(500억·상위 30) 미달. 얇은 종목이라 호가 충격이 큼")
        if r["upper"] >= 3:
            flags.append(f"위꼬리 +{r['upper']:.1f}% — 봉 위쪽에 매물이 남음")
        if dv["chg5"] >= 40:
            flags.append(f"5일 누적 {dv['chg5']:+.1f}% — 이미 달린 자리(추격 구간)")
        if kind in ("D1", "D2"):
            g = gap_stats(code, D1_, D2_)
            if g["low"] <= CAFE_STOP:
                flags.append(f"장중 저가 {g['low']:+.2f}% — 카페 손절선(-3%)을 건드렸다(종가 {ps(r['pct'])})")
            if r["pct"] < 0:
                flags.append(f"종가 {ps(r['pct'])} — 눌림 뒤 반등이 종가까지 이어지지 않음")
        pl = plan(code)
        if not pl["pass"]:
            flags.append(f"{L2} 기준봉 {ps(pl['bar'])} — +2% 미달 → <b>다음 거래일 신규 눌림 매수 패스(G)</b>")

        return {
            "code": code, "name": names[code]["name"], "market": names[code]["market"], "kind": kind,
            "tier": f"{passed}/6", "tierNum": passed,
            "theme": (th["name"] if th else None), "themeRate": (th["rate"] if th else None),
            "companions": (th["companionCount"] if th else 0),
            "close": r["c"], "pct": r["pct"], "valueEok": r["valueEok"], "rank": rank,
            "o": r["o"], "h": r["h"], "l": r["l"], "prevClose": r["prevClose"],
            "hi120": r["hi120"], "hi120Date": r["hi120Date"], "dist120": r["dist120"], "breakout": r["breakout"],
            "upper": r["upper"], "chg5": dv["chg5"], "chg20": dv["chg20"], "volRatio": dv["volRatio"],
            "kki": dv["kki"], "m5": dv["m5"], "m20": dv["m20"], "m120": dv["m120"],
            "steps": [{"k": k, "label": lab, "ok": bool(st[k])} for k, lab in HONG_STEPS],
            "strip": strip(code, {"D0": D2_, "D1": D1_, "D2": D0_, "NEAR": None}[kind]),
            "plan": pl, "reasons": reasons, "flags": flags,
            "levels": {"open": r["o"], "high": r["h"], "low": r["l"], "close": r["c"],
                       "prevClose": r["prevClose"], "hi120": r["hi120"], "hi120Date": r["hi120Date"],
                       "m5": dv["m5"], "m20": dv["m20"], "m120": dv["m120"]},
            "spark15": dv["spark15"], "candles": dv["candles"],
        }

    cards = [card(c, "D0") for c in d0_codes]
    cards += [card(c, "D1") for c in d1_codes]
    cards += [card(c, "D2") for c in d2_codes]
    cards += [card(c, "NEAR") for c in near_codes]

    # ---- KPI · 파이프라인 (기준일)
    funnel = []
    for code in per:
        if D2_ not in per[code]:
            continue
        r = per[code][D2_]
        st, th, rank = steps_of(code, D2_)
        if (r["pct"] >= 5.0 and r["valueEok"] >= 300) or (rank <= 30 and r["valueEok"] >= 500):
            funnel.append({"code": code, "name": names[code]["name"], "market": names[code]["market"],
                           "pct": r["pct"], "valueEok": r["valueEok"], "rank": rank, "st": st, "theme": th,
                           "hi120": r["hi120"], "dist120": r["dist120"], "breakout": r["breakout"],
                           "big": r["big"], "firstBig": r["firstBig"], "priorBig60": r["priorBig60"]})
    funnel.sort(key=lambda x: -x["valueEok"])

    d0_all = [c for c in per if anchor_on(c, D2_)]
    d1_events = [c for c in per if big_on(c, D1_)]
    d2_next = len([c for c in d1_codes if rec(c, D2_) and rec(c, D2_)["pct"] >= CAFE_MIN])
    n1616 = len([c["code"] for c in cards if rec(c["code"], D2_) and rec(c["code"], D2_)["pct"] >= CAFE_MIN])

    pipe = {
        "universe": len(uni), "scanned": len(per),
        "up5": len([c for c in per if rec(c, D2_) and rec(c, D2_)["pct"] >= 5.0]),
        "up5_500": len([x for x in funnel if x["pct"] >= 5.0 and x["valueEok"] >= 500]),
        "top30": len([x for x in funnel if x["st"]["d30"] and x["pct"] >= 5.0]),
        "theme3": len([x for x in funnel if x["st"]["d30"] and x["st"]["up5"] and x["st"]["theme3"]]),
        "break": len([x for x in funnel if x["st"]["d30"] and x["st"]["up5"] and x["st"]["theme3"] and x["st"]["break"]]),
        "bigbar": len([x for x in funnel if all(x["st"][k] for k in ("d30", "up5", "theme3", "break", "bigbar"))]),
        "d0": len([x for x in funnel if all(x["st"][k] for k, _ in HONG_STEPS)]),
        "d0chart": len(d0_all), "near": len(near_codes), "d1": len(d1_codes), "d2": len(d2_codes),
    }

    # ---- 탈락 사유 (기준일 · 모달)
    ORDER = [k for k, _ in HONG_STEPS]
    rej = []
    for x in funnel:
        miss = [k for k in ORDER if not x["st"][k]]
        if not miss:
            continue
        why = []
        if "d30" in miss:
            why.append({"k": "② 거래대금 상위 30·500억", "v": f"{x['rank']}위 · {nf(x['valueEok'])}억"})
        if "up5" in miss:
            why.append({"k": "③ 당일 +5%↑", "v": ps(x["pct"])})
        if "theme3" in miss:
            th = x["theme"]
            why.append({"k": "④⑤ 같은 테마 5%↑ 3종목", "v": (f"{th['name']} · 동반 {th['companionCount']}종목" if th else "테마 미확인(개별 재료)")})
        if "break" in miss:
            why.append({"k": "⑥ 120일 전고점", "v": f"전고점 {nf(x['hi120'])}원이 현재가 {x['dist120']:+.1f}% 위"})
        if "bigbar" in miss:
            why.append({"k": "장대양봉(+10%)", "v": ps(x["pct"])})
        if "first" in miss:
            why.append({"k": "첫 장대양봉", "v": f"직전 60거래일 +10%↑ {x['priorBig60']}회"})
        rej.append({"name": x["name"], "code": x["code"], "pct": x["pct"], "valueEok": x["valueEok"],
                    "rank": x["rank"], "why": why})
    for c in d0_codes:
        r = rec(c, D2_)
        th = day_theme(c, D2_)
        rej.append({"name": names[c]["name"], "code": c, "pct": r["pct"], "valueEok": r["valueEok"],
                    "rank": rank_of(c, D2_), "chart_ok": True,
                    "why": [{"k": "② 거래대금 상위 30·500억", "v": f"{rank_of(c, D2_)}위 · {nf(r['valueEok'])}억"},
                            {"k": "④⑤ 같은 테마 5%↑ 3종목", "v": (f"{th['name']} · 동반 {th['companionCount']}종목" if th else "테마 미확인(개별 재료)")}]})
    rej.sort(key=lambda x: -x["valueEok"])

    return {
        "basisDate": D2_,
        "basisLabel": f"{dlong(D2_)} 정규장 종가 — 3거래일({dshort(D0_)}~{dshort(D2_)}) 실측",
        "basisLongLabel": dlong(D2_),
        "generatedAt": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
        "universe": len(uni), "apiTotals": totals, "scanned": len(per), "days": days, "pipe": pipe,
        "kpi": {"d0": pipe["d0"], "d0chart": len(d0_all), "d1cand": len(d0_codes), "d1real": len(d1_codes),
                "d1events": len(d1_events), "d2cand": d2_next, "d2real": len(d2_codes),
                "near": len(near_codes), "n1616": n1616},
        "cards": cards, "reject": rej,
    }


# ------------------------------------------------------------------ 7) 비중법사
def build_bij(uni, per, days, base_count=2403, card_n=6, reject_n=40):
    names = {u["code"]: u for u in uni}
    BASIS = days[2]
    L2 = dshort(BASIS)
    rows = []
    for code, cs in CANDLES_REF.items():
        r = per.get(code, {}).get(BASIS)
        if not r or len(cs) < 70:
            continue
        nm = names.get(code) or {"name": code, "market": ""}
        o, h, l, c, v = r["o"], r["h"], r["l"], r["c"], r["v"]
        if not c or not o:
            continue
        hist = cs[:-1]
        hi60 = max(x["h"] for x in hist[-60:])
        vol20 = sum(x["v"] for x in hist[-20:]) / min(20, len(hist)) or 1
        rows.append({
            "code": code, "name": nm["name"], "market": nm.get("market") or "",
            "o": o, "h": h, "l": l, "c": c, "prevClose": r["prevClose"], "chg": r["pct"],
            "bodyRate": round((c - o) / o * 100, 2), "upper": round((h - c) / c * 100, 2) if c else 0.0,
            "lower": round((o - l) / o * 100, 2) if o else 0.0,
            "volX": round(v / vol20, 2) if vol20 else 0.0,
            "valueEok": round(c * v / 1e8, 1),
            "hi60": hi60, "hi120": r["hi120"],
            "break60": c > hi60, "break120": r["breakout"],
            "dist120": round((c / r["hi120"] - 1) * 100, 2) if r["hi120"] else None,
            "candles": [{"d": x["date"], "o": x["o"], "h": x["h"], "l": x["l"], "c": x["c"], "v": x["v"]} for x in cs[-200:]],
            "spark15": [[x["date"], x["c"], x["v"]] for x in cs[-15:]],
        })

    for r in rows:
        ck = {
            "chg": r["chg"] >= BIJ_TH["chg"],
            "break": r["break60"] or (r["dist120"] or -99) >= -0.5,
            "body": r["c"] > r["o"] and r["bodyRate"] >= BIJ_TH["bodyRate"],
            "value": r["valueEok"] >= BIJ_TH["valueEok"],
            "vol": r["volX"] >= BIJ_TH["volX"],
            "tail": r["upper"] <= BIJ_TH["upperMax"],
        }
        r["checks"] = ck
        r["passCount"] = sum(1 for x in ck.values() if x)
        # 기준봉은 5조건을 모두 만족해야 한다 — 거래대금 300억(ck["value"])을 빼면
        #  아리바이오랩·진양화학·진양폴리 같은 얇은 종목이 기준봉으로 잘못 통과한다.
        r["isBase"] = ck["chg"] and ck["break"] and ck["body"] and ck["tail"] and ck["value"]
        if r["isBase"]:
            if r["break120"] and r["chg"] >= 10 and r["valueEok"] >= 100 and r["volX"] >= 1.5:
                r["grade"] = "A"
            elif (r["valueEok"] >= BIJ_TH["valueEok"] and (ck["vol"] or r["chg"] >= 10)) or r["valueEok"] >= 500:
                r["grade"] = "B"
            else:
                r["grade"] = "C"
            r["score"] = round(r["chg"] + math.log10(max(r["valueEok"], 1)) * 6 + min(r["volX"], 12) * 1.2
                               + r["bodyRate"] * 0.3 - r["upper"] * 0.4 + (4 if r["grade"] == "A" else 0), 1)
        else:
            why = []
            if not ck["chg"]:
                why.append(f"당일 {r['chg']:+.2f}% — +5% 미달(강한 봉 아님)")
            if not ck["break"]:
                why.append(f"60일 전고점 미달(종가 {r['c']:,.0f}원 · 60일 최고 {r['hi60']:,.0f}원 / 120일 최고 {r['hi120']:,.0f}원) — 돌파가 아니라 반등")
            if not ck["body"]:
                why.append(f"몸통 {r['bodyRate']:+.2f}% — 양봉 몸통 10% 미달(기준 상향)")
            if not ck["tail"]:
                why.append(f"위꼬리 {r['upper']:.1f}% — 봉 위쪽 매물대")
            if not ck["value"]:
                why.append(f"거래대금 {r['valueEok']:.1f}억 — 300억 미달(얇은 종목)")
            if not ck["vol"]:
                why.append(f"거래량 20일평균 대비 {r['volX']:.2f}배 — 1.8배 미달")
            r["reasons"] = why

    GO = {"A": 0, "B": 1, "C": 2}
    base = sorted([r for r in rows if r["isBase"]], key=lambda r: (GO[r["grade"]], -r["score"]))
    rejects = sorted([r for r in rows if not r["isBase"] and r["chg"] >= BIJ_TH["chg"]],
                     key=lambda r: (-r["passCount"], -r["chg"]))
    rejects = [r for r in rejects if r["passCount"] >= 4][:reject_n]   # 6조건 중 4개 이상 = '아깝게 탈락'(잘리지 않게 빠듯하게 자른다)
    # 탈락 후보는 사유·수치만 보여 준다(모달도 reasons 만 쓴다) — 200일 봉·15일 봉을 같이 실으면
    #  후보 40종목에서 페이지가 600KB 넘게 불어난다.
    for r in rejects:
        r.pop("candles", None)
        r.pop("spark15", None)
    cards = base[:card_n]
    for r in cards:
        r["plan"] = {"stop": r["c"], "gapZone": [r["c"], None], "papaLow": r["c"],
                     "papaNote": "1일차 고가가 잡히면 [기준봉 종가 ~ 종가+(1일차고가-종가)/4] 가 매수존",
                     "body": round(r["c"] - r["o"], 1)}

    nxt = next_trading_day(BASIS)
    return {
        "basisDate": BASIS,
        "basisLabel": f"{dlong(BASIS)} 정규장 종가 확정 실측 · 1일차 = {dlong_short(nxt)}",
        "basisLongLabel": dlong(BASIS),
        "generatedAt": now_kst().strftime("%Y-%m-%d"),
        "universe": max(base_count, len(CANDLES_REF)),
        "scanned": len(rows),
        "baseCount": len(base),
        "up5Count": sum(1 for r in rows if r["chg"] >= 5),
        "thresholds": BIJ_TH,
        "cards": cards,
        "rejects": rejects,
        "baseAll": [{k: r[k] for k in ("code", "name", "market", "chg", "volX", "valueEok", "bodyRate",
                                       "upper", "break60", "break120", "grade")} for r in base],
    }


CANDLES_REF = {}


# ------------------------------------------------------------------ 8) HTML 갱신
HONG_MARK = "<!-- 🎯 홍인기 탭 엔진 (HonginkiTab"
BIJ_MARK = "<!-- 📊 비중법사 탭 엔진 (BijoongTab"


def patch_inline_data(html, hong_json, bij_json):
    """엔진 블록 안의 `const DATA = {...};` 한 줄만 새 JSON으로 바꾼다."""
    lines = html.split("\n")
    done = {"hong": 0, "bij": 0}
    zone = None
    for i, ln in enumerate(lines):
        if HONG_MARK in ln:
            zone = "hong"
        elif BIJ_MARK in ln:
            zone = "bij"
        elif "/🎯 홍인기 탭 엔진 END" in ln or "/📊 비중법사 탭 엔진 END" in ln:
            zone = None
        if zone and ln.startswith("const DATA = {"):
            payload = hong_json if zone == "hong" else bij_json
            lines[i] = "const DATA = " + payload + ";"
            done[zone] += 1
            zone = None
    return "\n".join(lines), done


def patch_labels(html, hong, bij):
    """정적 라벨(탭 머리글·주석)도 새 기준일로 맞춘다. 문장 구조는 건드리지 않는다."""
    basis_long = hong["basisLongLabel"]                       # 2026-11-13(금)
    basis_short = dshort(hong["basisDate"])                   # 11/13
    days = hong["days"]
    span = f"{dshort(days[0])}~{dshort(days[2])}"
    span_long = f"{days[0][:4]}-{dshort(days[0])}~{dshort(days[2])}"
    nxt = bij["basisLabel"].split("1일차 = ")[-1]             # 11/16(월)
    nxt_short = nxt.split("(")[0]
    nxt_label = nxt.replace("(", " ").replace(")", "")
    subs = [
        (r"실측 기준일 \d{4}-\d{2}-\d{2}\([월화수목금토일]\)", f"실측 기준일 {basis_long}"),
        (r"3일 판정 — \d{4}-\d{2}-\d{2}\([월화수목금토일]\) 종가", f"3일 판정 — {basis_long} 종가"),
        (r"기준봉일 <b>\d{4}-\d{2}-\d{2}\([월화수목금토일]\) 정규장 종가 확정</b>", f"기준봉일 <b>{basis_long} 정규장 종가 확정</b>"),
        (r"<b>1일차 = \d{1,2}/\d{1,2}\([월화수목금토일]\)</b>", f"<b>1일차 = {nxt}</b>"),
        (r"(id=\"kUp5\">—</div><div class=\"k-s\">)\d{1,2}/\d{1,2} 강한 봉", rf"\g<1>{basis_short} 강한 봉"),
        (r"🎯 \d{1,2}/\d{1,2} 기준봉 확정", f"🎯 {basis_short} 기준봉 확정"),
        (r"\d{1,2}/\d{1,2} 종가 실측 [\d,]+종목", f"{basis_short} 종가 실측 {bij['scanned']:,}종목"),
        (r"\d{1,2}/\d{1,2} 종가 실측 복기", f"{basis_short} 종가 실측 복기"),
        (r"\d{4}-\d{1,2}-\d{1,2}~\d{1,2}-\d{1,2} 실제 일봉", f"{span_long} 실제 일봉"),
        (r"\(3거래일 \d{1,2}/\d{1,2}~\d{1,2}/\d{1,2}", f"(3거래일 {span}"),
        (r"1일차\(\d{1,2}/\d{1,2} [월화수목금토일]\)", f"1일차({nxt_label})"),
        (r"기준봉 20\d{2}-\d{2}-\d{2}", f"기준봉 {basis_long[:10]}"),
        (r"내장 fchart 일봉\(20\d{2}-\d{2}-\d{2}까지", f"내장 fchart 일봉({basis_long[:10]}까지"),
        (r"정적 미러는 20\d{2}-\d{2}-\d{2} 조회 스냅샷", f"정적 미러는 {now_kst().strftime('%Y-%m-%d')} 조회 스냅샷"),
    ]
    n = 0
    for pat, rep in subs:
        html, k = re.subn(pat, rep, html)
        n += k
    return html, n


# ------------------------------------------------------------------ 9) 검증
def validate_html(path=HTML):
    """인라인 <script> 구문(esprima) · DIV 균형 · 필수 블록 존재 검사."""
    try:
        import esprima
    except ImportError:
        esprima = None
    src = open(path, encoding="utf-8").read()
    report = {"file": path, "bytes": len(src), "scripts": 0, "syntax_errors": [], "div_delta": 0, "blocks": {}}
    for i, m in enumerate(re.finditer(r"<script\b([^>]*)>([\s\S]*?)</script\s*>", src, re.I), 1):
        attrs, body = m.group(1) or "", m.group(2)
        if re.search(r"\bsrc\s*=", attrs, re.I):
            continue
        tm = re.search(r"type\s*=\s*[\"']?([^\"'\s>]+)", attrs, re.I)
        if tm and not re.search(r"javascript|ecmascript|^module$", tm.group(1), re.I):
            continue
        report["scripts"] += 1
        if esprima is not None:
            try:
                esprima.parseScript(body)
            except Exception as e:     # noqa: BLE001
                report["syntax_errors"].append(f"inline#{i}: {e}")
    report["div_delta"] = len(re.findall(r"<div\b", src)) - len(re.findall(r"</div>", src))
    report["blocks"] = {"HonginkiTab": src.count("HonginkiTab"), "BijoongTab": src.count("BijoongTab"),
                        "hiStockGrid": src.count("hiStockGrid"), "bjCards": src.count("id=\"cards\"")}
    report["ok"] = not report["syntax_errors"] and abs(report["div_delta"]) <= 2 and src.count("HonginkiTab") > 0 and src.count("BijoongTab") > 0
    return report


# ------------------------------------------------------------------ 10) 실행
def main():
    global CANDLES_REF
    ap = argparse.ArgumentParser(description="관제탑 비중법사·홍인기 자동 재스캔")
    ap.add_argument("--basis", help="기준일 강제(YYYYMMDD) — 과거 검증용")
    ap.add_argument("--force", action="store_true", help="오늘 이미 갱신됐어도 다시 스캔")
    ap.add_argument("--dry", action="store_true", help="JSON만 만들고 index.html은 건드리지 않음")
    ap.add_argument("--check", action="store_true", help="네트워크 없이 현재 index.html만 점검")
    ap.add_argument("--if-stale-hours", type=float, default=0.0, help="이 시간 안에 갱신된 데이터면 skip")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--budget", type=float, default=420.0, help="일봉 수집 시간 예산(초)")
    ap.add_argument("--pages", type=int, default=30, help="랭킹 API 페이지 수(100개/페이지)")
    ap.add_argument("--limit", type=int, default=0, help="테스트용 종목 수 제한")
    ap.add_argument("--seed", default="", help="첫 실행 때 재사용할 기존 일봉 DB(JSON 경로, 선택)")
    args = ap.parse_args()

    t_start = time.time()
    os.makedirs(DATA_DIR, exist_ok=True)

    if args.check:
        rep = validate_html()
        print(json.dumps(rep, ensure_ascii=False, indent=1))
        return 0 if rep["ok"] else 1

    # ---- 기준일
    days_all = trading_days(40)
    if not days_all:
        log("거래일 확인 실패 — 중단")
        return 1
    if args.basis:
        basis = args.basis
        days = [d for d in days_all if d <= basis][-3:]
        if len(days) < 3:
            # 강제 기준일이 캐시 범위 밖 — 캔들에서 3일을 다시 찾는다
            days = days_all[-3:]
            basis = days[-1]
    else:
        basis = days_all[-1]
        now = now_kst()
        # 장중(15:35 이전)이면 오늘 봉은 미완성 → 직전 거래일을 기준으로
        if basis == now.strftime("%Y%m%d") and now.hour * 60 + now.minute < 15 * 60 + 35:
            basis = days_all[-2]
        days = [d for d in days_all if d <= basis][-3:]
    if len(days) < 3:
        log(f"거래일 3개를 확보하지 못했습니다: {days}")
        return 1
    log(f"기준일 {dlong(basis)} · 3거래일 {days}")

    # ---- 이미 최신이면 skip
    if not args.force and args.if_stale_hours > 0 and os.path.exists(LATEST):
        try:
            cur = json.load(open(LATEST))
            age = (now_kst() - datetime.strptime(cur["generatedAt"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST)).total_seconds() / 3600
            if cur.get("basisDate") == basis and age < args.if_stale_hours:
                log(f"이미 최신({cur['basisDate']} · {age:.1f}h 전) — 재스캔 건너뜀")
                return 0
        except Exception:              # noqa: BLE001
            pass

    # ---- 유니버스 + 테마 + 일봉
    log("[1/4] 유니버스")
    uni, totals = build_universe(args.pages)
    if not uni:
        # 장전(09:00 이전)·휴장일에는 네이버 상승/하락 랭킹이 빈 목록이라 유니버스가 0이 된다.
        #  이때 그대로 진행하면 index.html 의 카드·KPI 를 0건으로 덮어써 직전 확정치를 잃는다.
        log("유니버스 0종목 — 장전·휴장·랭킹 API 이상으로 판단해 index.html 을 쓰지 않고 종료합니다(기존 스캔 유지).")
        return 2
    # 직전 스캔 유니버스 대비 너무 적으면(개장 직후 랭킹 미충전·부분 응답) 쓰지 않는다.
    #  얇은 유니버스로 index.html 을 덮으면 카드가 1~2건으로 줄어 직전 확정 스캔을 잃는다.
    if not args.limit and os.path.exists(LATEST):
        try:
            prev = json.load(open(LATEST))
            prev_n = int(prev.get("universe") or 0)
            if prev_n >= 500 and len(uni) < prev_n * 0.6:
                log(f"유니버스 {len(uni)}종목 < 직전 {prev_n}종목의 60% — 랭킹 미충전으로 보고 index.html 을 쓰지 않고 종료합니다.")
                return 2
        except Exception:              # noqa: BLE001
            pass
    if args.limit:
        uni = uni[:args.limit]
    codes = [u["code"] for u in uni]
    log("[2/4] 테마")
    themes = build_themes()
    log("[3/4] 일봉")
    cache = load_cache()
    cache = seed_cache(args.seed, cache)
    complete = refresh_candles(cache, codes, basis, workers=args.workers, budget=args.budget)
    CANDLES_REF = cache
    if not complete:
        left = [c for c in codes if not (cache.get(c) and len(cache.get(c)) > 130)]
        if len(left) > max(40, len(codes) // 50):
            log(f"FETCH_INCOMPLETE 남은 {len(left)}종목 — 다음 실행에서 이어받습니다(종료코드 3)")
            return 3

    # ---- 지표
    log("[4/4] 지표 · 카드 생성")
    per = {}
    for u in uni:
        cs = cache.get(u["code"])
        if not cs or len(cs) < 130:
            continue
        r = day_records(u["code"], cs, days)
        if r:
            per[u["code"]] = r
    log(f"  3거래일 지표 {len(per)}종목")

    hong = build_hong(uni, per, themes, days, totals)
    bij = build_bij(uni, per, days, base_count=len(cache))
    log(f"  홍인기 카드 {len(hong['cards'])} · 탈락 {len(hong['reject'])}")
    log(f"  비중법사 기준봉 {bij['baseCount']} · 카드 {len(bij['cards'])} · 탈락 {len(bij['rejects'])}")

    payload = {
        "generatedAt": hong["generatedAt"], "basisDate": basis, "days": days,
        "basisLongLabel": hong["basisLongLabel"],
        "nextDay": next_trading_day(basis), "nextLabel": dshort(next_trading_day(basis)),
        "nextLongLabel": dlong_short(next_trading_day(basis)),
        "universe": len(uni), "scanned": len(per),
        "honginki": hong, "bijoong": bij,
    }
    wd = payload["nextLongLabel"].split("(")[-1].rstrip(")")
    payload["nextLabelKo"] = f"{payload['nextLabel']} {wd}"
    for obj in (hong, bij):
        obj["nextLabel"] = payload["nextLabel"]
        obj["nextLongLabel"] = payload["nextLongLabel"]
        obj["nextLabelKo"] = payload["nextLabelKo"]

    js_hong = json.dumps(hong, ensure_ascii=False, separators=(",", ":"))
    js_bij = json.dumps(bij, ensure_ascii=False, separators=(",", ":"))
    for path, obj in ((os.path.join(DATA_DIR, "honginki-latest.json"), hong),
                      (os.path.join(DATA_DIR, "bijoong-latest.json"), bij)):
        open(path, "w", encoding="utf-8").write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    open(LATEST, "w", encoding="utf-8").write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

    # ---- HTML 반영
    patched = {"hong": 0, "bij": 0}
    if not args.dry:
        html = open(HTML, encoding="utf-8").read()
        html, patched = patch_inline_data(html, js_hong, js_bij)
        if patched["hong"] != 1 or patched["bij"] != 1:
            log(f"! DATA 블록을 정확히 찾지 못했습니다 {patched} — index.html을 쓰지 않습니다")
            return 1
        html, nlab = patch_labels(html, hong, bij)
        open(HTML, "w", encoding="utf-8").write(html)
        rep = validate_html()
        log(f"  HTML 반영 — DATA {patched} · 라벨 {nlab}곳 · 구문오류 {len(rep['syntax_errors'])} · div차이 {rep['div_delta']}")
        if not rep["ok"]:
            log(json.dumps(rep, ensure_ascii=False)[:1200])
            return 1

    os.makedirs(CACHE_DIR, exist_ok=True)
    json.dump({"lastRunAt": now_kst().strftime("%Y-%m-%d %H:%M:%S"), "basisDate": basis,
               "tookSec": round(time.time() - t_start, 1), "patched": patched,
               "counts": {"hong": len(hong["cards"]), "bij": len(bij["cards"])}},
              open(STATE_PATH, "w"), ensure_ascii=False)

    print(json.dumps({
        "ok": True, "basisDate": basis, "basisLong": hong["basisLongLabel"],
        "nextLabel": payload["nextLongLabel"], "universe": len(uni), "scanned": len(per),
        "hong": {"cards": len(hong["cards"]), "d0": hong["kpi"]["d0"], "d0chart": hong["kpi"]["d0chart"],
                 "d1": hong["kpi"]["d1real"], "d2": hong["kpi"]["d2real"], "near": hong["kpi"]["near"],
                 "picks": [f"{c['kind']} {c['name']}({c['code']}) {c['pct']:+.2f}%" for c in hong["cards"]]},
        "bij": {"base": bij["baseCount"], "cards": [f"{c['grade']} {c['name']}({c['code']}) {c['chg']:+.2f}%" for c in bij["cards"]]},
        "patched": patched, "tookSec": round(time.time() - t_start, 1),
    }, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
