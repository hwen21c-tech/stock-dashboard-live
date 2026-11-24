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
import html as html_lib
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
# 정적 미러(GitHub Pages) — 5개 전략 탭 목록을 같은 값으로 맞춘다
STATIC_HTML = os.path.join(os.path.dirname(ROOT), "deploy_repo", "index.html")

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
        # 시가총액(억원) — API 의 marketValue 는 '억원' 단위 문자열(예: 11,447,014 = 1,144조)
        cap = num(r.get("marketValue"))
        uni.append({"code": code, "name": name, "market": r["_market"], "pct": p,
                    "value_eok": round(val / 100, 1), "status": r.get("marketStatus"),
                    "cap": round(cap, 1) if cap is not None else 0.0,
                    "close": num(r.get("closePrice")) or 0.0})
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


# ------------------------------------------------------------------ 4b) KRX 오픈API 확정치 교차검증
#   네이버 일봉(fchart)은 수정주가·가집계라 장마감 직후 값이 KRX 공식 확정치와 몇 틱~수 % 어긋난다.
#   /workspace/.krx_api_key 가 있으면 KRX 일별매매정보(코스피 stk_bydd_trd · 코스닥 ksq_bydd_trd)로
#   당일 종가·등락률·거래대금을 교차검증해 보정한다. 실패하면 조용히 네이버 값으로 폴백한다.
KRX_KEY_PATH = os.path.join(os.path.dirname(ROOT), ".krx_api_key")
KRX_ENDPOINTS = ("stk_bydd_trd", "ksq_bydd_trd")


def load_krx_key():
    try:
        key = open(KRX_KEY_PATH, encoding="utf-8").read().strip()
        return key or None
    except Exception:                     # noqa: BLE001
        return None


def fetch_krx_daily(bas_dd, key):
    """{종목코드: {name, close, pct, open, high, low, vol, valueEok}} — 실패한 시장은 건너뛴다."""
    out, errors = {}, []
    for ep in KRX_ENDPOINTS:
        url = f"https://data-dbg.krx.co.kr/svc/apis/sto/{ep}?basDd={bas_dd}"
        try:
            req = urllib.request.Request(url, headers={"AUTH_KEY": key, "User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=25) as r:
                data = json.loads(r.read().decode("utf-8", "ignore"))
        except Exception as e:            # noqa: BLE001
            errors.append(f"{ep}: {e}")
            continue
        rows = data.get("OutBlock_1") or []
        for x in rows:
            code = str(x.get("ISU_CD") or "").strip()
            if not re.match(r"^\d{6}$", code):
                continue
            try:
                out[code] = {
                    "name": x.get("ISU_NM"),
                    "close": float(x.get("TDD_CLSPRC") or 0),
                    "pct": float(x.get("FLUC_RT") or 0),
                    "open": float(x.get("TDD_OPNPRC") or 0),
                    "high": float(x.get("TDD_HGPRC") or 0),
                    "low": float(x.get("TDD_LWPRC") or 0),
                    "vol": float(x.get("ACC_TRDVOL") or 0),
                    "valueEok": round(float(x.get("ACC_TRDVAL") or 0) / 1e8, 1),
                }
            except (TypeError, ValueError):
                continue
        log(f"    KRX {ep}: {len(rows)}행")
    return out, errors


ADJ_RATIOS = (2.0, 3.0, 4.0, 5.0, 10.0, 20.0, 0.5, 1 / 3, 0.25, 0.2, 0.1, 0.05)


def _is_adjust_ratio(r):
    """액면분할·병합 같은 '정수배' 가격 차이인지 — 2배·5배·1/5 처럼 딱 떨어지는 비율만."""
    if abs(r - 1) <= 0.03:
        return False
    return any(abs(r - x) / x <= 0.02 for x in ADJ_RATIOS)


def krx_adjust(per, cache, basis, krx):
    """당일 레코드를 KRX 확정치로 맞춘다.
       · 액면분할·병합 같은 정수배 차이 = 수정주가 조정 → 가격은 네이버 조정주가 유지, 거래대금만 KRX 확정
       · 그 밖의 차이(가집계·시간외 반영 등) = KRX 확정 종가·등락률·거래대금으로 교체(캐시 봉도 함께)"""
    stat = {"checked": 0, "fixed": 0, "valueOnly": 0, "missing": 0}
    for code, recs in (per or {}).items():
        rec = recs.get(basis)
        k = krx.get(code)
        if not rec:
            continue
        if not k or not k.get("close"):
            stat["missing"] += 1
            continue
        stat["checked"] += 1
        ratio = rec["c"] / k["close"] if k["close"] else 1.0
        if _is_adjust_ratio(ratio):
            rec["valueEok"] = k["valueEok"]
            rec["valueBasisKrX"] = True
            stat["valueOnly"] += 1
            continue
        if abs(rec["c"] - k["close"]) > 0.001 * k["close"] or abs(rec.get("valueEok", 0) - k["valueEok"]) > 0.5:
            stat["fixed"] += 1
        rec["c"] = k["close"]
        rec["pct"] = k["pct"]
        rec["valueEok"] = k["valueEok"]
        rec["valueBasisKrX"] = True
        for fld, kf in (("o", "open"), ("h", "high"), ("l", "low")):
            if k.get(kf):
                rec[fld] = k[kf]
        cs = (cache or {}).get(code)
        if cs:
            for bar in reversed(cs):
                if bar.get("date") == basis:
                    bar["c"] = k["close"]
                    if k.get("open"):
                        bar["o"] = k["open"]
                    if k.get("high"):
                        bar["h"] = k["high"]
                    if k.get("low"):
                        bar["l"] = k["low"]
                    if k.get("vol"):
                        bar["v"] = k["vol"]
                    break
    return stat


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
    # D+1 판정 — 기준봉(직전 거래일)의 **중심선 = (시가 + 종가) / 2** 을 당일 종가가 이탈한 종목은 제외한다.
    #   중심선 아래로 종가가 빠지면 '눌림'이 아니라 '기준봉 무효(실패 패턴)'다 (예: 오킨스전자 -28.33%).
    d1_all, d1_center_out = [], []
    for c in per:
        r1, r2 = rec(c, D1_), rec(c, D2_)
        if not (r1 and r2):
            continue
        if not (big_on(c, D1_) and r1["valueEok"] >= 200 and r2["l"] < r1["c"]):
            continue
        mid = (r1["o"] + r1["c"]) / 2.0
        if r2["c"] < mid:
            d1_center_out.append({
                "code": c, "name": names[c]["name"], "market": names[c]["market"],
                "baseOpen": r1["o"], "baseClose": r1["c"], "baseMid": round(mid),
                "close": r2["c"], "pct": r2["pct"], "valueEok": r2["valueEok"],
                "gapMid": round(pct(r2["c"], mid), 2), "gapClose": round(pct(r2["c"], r1["c"]), 2),
            })
            continue
        d1_all.append(c)
    d1_all.sort(key=lambda c: -rec(c, D2_)["valueEok"])
    d1_center_out.sort(key=lambda x: -x["valueEok"])
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
            mid1 = (p0["o"] + p0["c"]) / 2.0
            reasons.append(f"기준봉 중심선 (시가 {nf(p0['o'])} + 종가 {nf(p0['c'])}) / 2 = <b>{nf(mid1)}원</b> → "
                           f"{L2} 종가 {nf(r['c'])}원(<b>{pct(r['c'], mid1):+.2f}%</b>) "
                           + ("<b>중심선 유지</b> ✓" if r["c"] >= mid1 else "<b>중심선 이탈</b> — D+1 후보 제외 대상"))
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
                       "baseMid": (round(((rec(code, D1_) or r)["o"] + (rec(code, D1_) or r)["c"]) / 2.0)
                                   if rec(code, D1_) else None),
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
        "d1CenterOut": len(d1_center_out),
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
    # 기준봉 중심선을 종가로 이탈한 D+1 후보 — 자동 제외하고 사유를 남긴다
    for x in d1_center_out:
        rej.append({"name": x["name"], "code": x["code"], "pct": x["pct"], "valueEok": x["valueEok"],
                    "rank": rank_of(x["code"], D2_), "centerOut": True,
                    "why": [{"k": "기준봉 중심선 이탈",
                             "v": (f"{L1} 기준봉 중심선 {x['baseMid']:,}원((시가 {x['baseOpen']:,.0f} + 종가 {x['baseClose']:,.0f})/2) "
                                   f"→ {L2} 종가 {x['close']:,.0f}원({x['gapMid']:+.2f}%) — D+1 누림 후보 자동 제외")}]})
    rej.sort(key=lambda x: -x["valueEok"])

    return {
        "basisDate": D2_,
        "basisLabel": f"{dlong(D2_)} 정규장 종가 — 3거래일({dshort(D0_)}~{dshort(D2_)}) 실측",
        "basisLongLabel": dlong(D2_),
        "generatedAt": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
        "universe": len(uni), "apiTotals": totals, "scanned": len(per), "days": days, "pipe": pipe,
        "kpi": {"d0": pipe["d0"], "d0chart": len(d0_all), "d1cand": len(d0_codes), "d1real": len(d1_codes),
                "d1events": len(d1_events), "d2cand": d2_next, "d2real": len(d2_codes),
                "near": len(near_codes), "n1616": n1616, "d1CenterOut": len(d1_center_out)},
        "centerOut": [{"code": x["code"], "name": x["name"], "baseMid": x["baseMid"],
                        "close": x["close"], "gapMid": x["gapMid"], "pct": x["pct"]} for x in d1_center_out[:12]],
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

    # ── 거래대금 순위(rank) — 어느 시장·어느 기준인지 함께 명시한다.
    #    · 기준: 정규장(KRX) 종가 × 정규장 거래량. NXT 시간외 체결 대금은 포함하지 않았다.
    #    · 순위: 코스피+코스닥 전 종목 통합(rank) / 같은 시장 안에서(rankMarket)
    #    예전에는 카드에 valueEok 만 있고 rank 가 없거나, 홍인기 카드의 '전 종목 N위'와
    #    다른 기준이 섞여 있어 '어느 시장·어느 기준 순위'인지 알 수 없었다.
    for i, x in enumerate(sorted(rows, key=lambda r: -r["valueEok"]), 1):
        x["rank"] = i
    for mkt in ("코스피", "코스닥"):
        for i, x in enumerate(sorted([r for r in rows if r["market"] == mkt], key=lambda r: -r["valueEok"]), 1):
            x["rankMarket"] = i
    for x in rows:
        x.setdefault("rankMarket", None)
        x["valueBasis"] = "정규장"
        x["rankBasis"] = "코스피+코스닥 통합 정규장 거래대금 순위"
        x["rankText"] = (f"정규장 대금 {x['valueEok']:,.1f}억 · 통합 {x['rank']}위"
                          + (f" / {x['market']} {x['rankMarket']}위" if x.get("rankMarket") else ""))

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
        "valueBasis": "정규장(KRX) 종가 × 정규장 거래량",
        "rankBasis": "코스피+코스닥 통합 정규장 거래대금 순위 (통합 KRX+NXT 아님)",
        "cards": cards,
        "rejects": rejects,
        "baseAll": [{k: r[k] for k in ("code", "name", "market", "chg", "volX", "valueEok", "bodyRate",
                                       "upper", "break60", "break120", "grade", "rank", "rankMarket",
                                       "valueBasis", "rankBasis", "rankText")} for r in base],
    }


CANDLES_REF = {}


# ------------------------------------------------------------------ 7b) RN존 · 종가베팅 매일 자동 선정
#   예전에는 RN존 11종목·종가베팅 10종목이 RAW_STOCKS/STOCKS 배열에 고정값으로 박혀 있어
#   장이 아무리 바뀌어도 같은 종목만 남았다. 이제는 장마감 확정 일봉으로 매일 새로 뽑는다.
#   · RN존  — 거래대금 상위 주도주(300억↑) 중 라운드 넘버 밴드 안에서 위치를 다시 계산
#   · 종베  — 신정재(윗꼬리 없는 양봉·고가 밀착) / 강창권(장대양봉 후 5·20일선 눌림) 두 트랙
RN_MIN_VALUE = 1500.0      # RN존 후보 최소 거래대금(억) — 차트박사 검색식: 일 거래대금 1,500억 이상
RN_BIG_CAP = 100000.0      # 시총 10조 이상 우량주은 대금 조건 면제 (RN존 1번 원칙: '시총 10조+ 우량주 or 3천억~10조 중 일 대금 1,500억+')
RN_BIG_MIN_VALUE = 300.0   # 단, 시총 10조라도 하루 대금 300억 미만이면 호가가 얇아 실전 대상에서 뺍다
RN_MIN_PCT = 0.0
RN_PICK = 12
JB_MIN_VALUE = 300.0
JB_PICK_PER_TRACK = 5

# ── 차트박사 공식 21개 라운드넘버(RN)선 ────────────────────────────────────
#   붉은색(핵심 8): 500 · 1,000 · 5,000 · 10,000 · 50,000 · 100,000 · 500,000 · 1,000,000
#   파란색(중간 3): 2,000 · 20,000 · 200,000
#   옥색(보조 10): 1,500 · 3,000 · 7,500 · 15,000 · 30,000 · 75,000 · 150,000 · 300,000 · 750,000 · 1,500,000
#   예전에는 가격대별 임의 라운딩(rn_step)으로 선을 만들었는데, 공식 배열과 달라
#   (예: 779,000원 → 700,000/800,000) 매매 기준선이 틀리게 표시됐다.
RN_LINES = (
    (500, 'red'), (1000, 'red'), (1500, 'teal'), (2000, 'blue'), (3000, 'teal'),
    (5000, 'red'), (7500, 'teal'), (10000, 'red'), (15000, 'teal'), (20000, 'blue'),
    (30000, 'teal'), (50000, 'red'), (75000, 'teal'), (100000, 'red'), (150000, 'teal'),
    (200000, 'blue'), (300000, 'teal'), (500000, 'red'), (750000, 'teal'),
    (1000000, 'red'), (1500000, 'teal'),
)
RN_COLOR = {'red': '#ef4444', 'blue': '#3b82f6', 'teal': '#14b8a6'}
RN_COLOR_KO = {'red': '붉은색', 'blue': '파란색', 'teal': '옥색'}
RN_COLOR_RANK = {'red': '핵심', 'blue': '중간', 'teal': '보조'}


def rn_step(price):
    """현재가가 속한 RN 구간의 폭(참고용). 선 자체는 RN_LINES 공식 배열을 쓴다."""
    p = abs(float(price or 0))
    if p >= 500000:
        return 100000
    if p >= 100000:
        return 50000
    if p >= 50000:
        return 10000
    if p >= 10000:
        return 5000
    if p >= 1000:
        return 1000
    return 100


def kr_tick(price):
    p = abs(float(price or 0))
    if p < 2000:
        return 1
    if p < 5000:
        return 5
    if p < 20000:
        return 10
    if p < 50000:
        return 50
    if p < 200000:
        return 100
    if p < 500000:
        return 500
    return 1000


def to_tick(v):
    t = kr_tick(v)
    return int(round(float(v) / t) * t)


def rn_category(price, lower, upper):
    """현재가가 공식 RN선 사이 어디에 있는지 — 하단 근접/터치 · 상단 근접/터치 4분류.
       · 하단 RN 1% 이내 = 하단 터치(touch_lower) / 상단 RN 0.5% 이내 = 상단 터치(touch_upper)
       · 그 외에는 더 가까운 선 쪽으로 (near_lower = 하단 근접, upper = 상단 근접)"""
    p = float(price or 0)
    if not lower:
        return 'upper'
    if not upper or upper <= lower:
        return 'touch_upper' if p >= lower else 'upper'
    d_low = (p / float(lower) - 1) * 100.0
    d_up = (float(upper) / p - 1) * 100.0
    if d_up <= 0.5:
        return 'touch_upper'
    if d_low <= 1.0:
        return 'touch_lower'
    return 'near_lower' if d_low <= d_up else 'upper'


AUX_MIN_GAP_PCT = 40.0     # 공식 21선 구간폭이 이보다 넓으면 '중간 보조 눈금'을 하나 표기한다


def rn_aux_level(lv, uv):
    """공식 21선 사이가 너무 넓을 때(3→5 = +66.7%) 그 구간 중간값을 '보조 눈금'으로 만든다.
       · 예: 현대모비스 344,500원 → 하단 300,000 / (중간 보조 400,000) / 상단 500,000
             1,000,000~1,500,000 → 1,250,000 · 30,000~50,000 → 40,000
       · 공식선이 아니므로 1·2차 타점 계산에는 쓰지 않는다(표기·차트 보조선 전용).
       · 원전 RN_LINES 배열 자체는 건드리지 않는다."""
    try:
        lv, uv = float(lv), float(uv)
    except (TypeError, ValueError):
        return None
    if lv <= 0 or uv <= lv:
        return None
    if (uv / lv - 1) * 100.0 < AUX_MIN_GAP_PCT:
        return None
    v = to_tick((lv + uv) / 2.0)
    if v <= lv or v >= uv:
        return None
    return int(v)


def rn_lines(price):
    """현재가 기준 바로 아래 공식 RN선 = lowerRN, 바로 위 공식 RN선 = upperRN.
       · 현재가가 공식선과 정확히 일치하면 상단 RN은 '그 다음 선'을 쓴다(예전에는 같은 선을
         상단으로 잡아 '위쪽 공식 RN선 없음(최상단)'으로 표기되는 표기 오류가 있었다).
       · 구간폭이 40%를 넘으면(3→5 구간) '중간 보조' 눈금을 함께 표기한다."""
    p = float(price or 0)
    lower, upper = None, None
    for v, c in RN_LINES:
        if v <= p:
            lower = (v, c)
        if v > p and upper is None:
            upper = (v, c)
    below_floor = lower is None           # 공식 최저선(500원) 아래 — 하단 RN 없음
    if below_floor:
        lv, lc = RN_LINES[0]
        uv, uc = RN_LINES[0]
    elif upper is None:                   # 공식 최상단(1,500,000원) 이상 — 위쪽 선이 없다
        lv, lc = lower
        uv, uc = lv, lc
    else:
        lv, lc = lower
        uv, uc = upper
    buy1 = to_tick(lv * 1.04)
    aux = None if (below_floor or uv <= lv) else rn_aux_level(lv, uv)
    if below_floor:
        zone_text = (f"공식 최저선 {lv:,}원({RN_COLOR_KO[lc]}) 아래 {(p / lv - 1) * 100:+.2f}% "
                     f"· 하단 RN 없음")
    elif uv > lv:
        span = (uv - lv)
        aux_txt = (f"중간 보조 {aux:,}원({(aux / p - 1) * 100:+.2f}%) · " if aux else '')
        zone_text = (f"하단 {lv:,}원({RN_COLOR_KO[lc]}) {(p / lv - 1) * 100:+.2f}% · "
                     f"{aux_txt}"
                     f"상단 {uv:,}원({RN_COLOR_KO[uc]}) {(uv / p - 1) * 100:+.2f}% · "
                     f"구간폭 {span:,}원")
    else:
        zone_text = f"하단 {lv:,}원({RN_COLOR_KO[lc]}) {(p / lv - 1) * 100:+.2f}% · 위쪽 공식 RN선 없음(최상단)"
    if below_floor:
        category = 'touch_lower'
    elif uv <= lv:
        category = 'above_top'
    else:
        category = rn_category(p, lv, uv)
    return {
        'upperRN': int(uv), 'lowerRN': int(lv),
        'lowerColor': lc, 'upperColor': uc,
        'lowerColorHex': RN_COLOR[lc], 'upperColorHex': RN_COLOR[uc],
        'lowerColorKo': RN_COLOR_KO[lc], 'upperColorKo': RN_COLOR_KO[uc],
        'lowerKind': RN_COLOR_RANK[lc], 'upperKind': RN_COLOR_RANK[uc],
        'auxRN': aux,
        'auxText': (f"중간 보조 {aux:,}원 ({(aux / p - 1) * 100:+.2f}%)" if aux else ''),
        'zoneText': zone_text,
        'buy1': buy1, 'buy2': to_tick(buy1 * 0.8),
        'targetMin': to_tick(buy1 * 1.07), 'targetMax': to_tick(buy1 * 1.2),
        'category': category,
    }


RN_CANDLE_N = 250   # RN존 차트 봉 개수(1년). 60봉이면 '직전 상단 RN 터치 후 눌림' 파동이 잘린다.


def rn_candles(cs, n=RN_CANDLE_N):
    """RAW_STOCKS 카드가 그리는 일봉 형식(date/open/high/low/close/vol/ratio)으로 바꾼다."""
    out, prev = [], None
    for x in (cs or [])[-n:]:
        ratio = round((x['c'] - prev) / prev * 100, 2) if prev else 0.0
        d = x['date']
        if len(d) == 8:
            d = f"{d[0:4]}-{d[4:6]}-{d[6:8]}"
        out.append({'date': d, 'open': int(x['o']), 'high': int(x['h']), 'low': int(x['l']),
                    'close': int(x['c']), 'vol': int(x['v']), 'ratio': ratio})
        prev = x['c']
    return out


def build_rnzone(uni, per, cache, days):
    """거래대금 상위 주도주 + 당일 급등 대금주 → RN 밴드·타점을 현재가 기준으로 계산."""
    basis = days[2]
    names = {u['code']: u for u in uni}
    rows = []
    for u in uni:
        code = u['code']
        rec = (per.get(code) or {}).get(basis)
        cs = cache.get(code)
        if not rec or not cs or len(cs) < 30:
            continue
        price = rec['c']
        cap = float(u.get('cap') or 0)
        big_cap = cap >= RN_BIG_CAP
        if price < 1000:
            continue
        if rec['valueEok'] < RN_MIN_VALUE:
            if not (big_cap and rec['valueEok'] >= RN_BIG_MIN_VALUE):
                continue
        rows.append({
            'code': code, 'name': u['name'], 'market': u.get('market') or '',
            'price': int(price), 'chg': rec['pct'], 'valueEok': rec['valueEok'],
            'capEok': cap, 'bigCap': big_cap,
            'pickReason': ('대금 1,500억↑' if rec['valueEok'] >= RN_MIN_VALUE else '시총 10조↑ 우량주(대금 조건 면제)'),
            'volX': round(rec['v'] / (sum(x['v'] for x in cs[-21:-1]) / 20 or 1), 2),
        })
    if not rows:
        return [], {'all': 0, 'touch_lower': 0, 'near_lower': 0, 'upper': 0, 'touch_upper': 0}, basis

    by_value = sorted(rows, key=lambda r: -r['valueEok'])[:8]
    by_gain = sorted([r for r in rows if r['chg'] >= RN_MIN_PCT], key=lambda r: -r['chg'])[:6]
    picked, seen = [], set()
    for r in by_value + by_gain:
        if r['code'] in seen:
            continue
        seen.add(r['code'])
        picked.append(r)
        if len(picked) >= RN_PICK:
            break

    out = []
    for r in picked:
        cs = cache.get(r['code']) or []
        lines = rn_lines(r['price'])
        out.append({
            'name': r['name'], 'code': r['code'],
            'category': lines['category'],
            'price': r['price'], 'changeRatio': r['chg'],
            'upperRN': lines['upperRN'], 'lowerRN': lines['lowerRN'],
            'lowerColor': lines['lowerColor'], 'upperColor': lines['upperColor'],
            'lowerColorHex': lines['lowerColorHex'], 'upperColorHex': lines['upperColorHex'],
            'lowerColorKo': lines['lowerColorKo'], 'upperColorKo': lines['upperColorKo'],
            'lowerKind': lines['lowerKind'], 'upperKind': lines['upperKind'],
            'auxRN': lines.get('auxRN'), 'auxText': lines.get('auxText', ''),
            'zoneText': lines['zoneText'],
            'buy1': lines['buy1'], 'buy2': lines['buy2'],
            'targetMin': lines['targetMin'], 'targetMax': lines['targetMax'],
            'valueEok': r['valueEok'],
            'valueText': f"{r['valueEok']:,.0f}억",
            'valueBasis': '정규장',
            'pickReason': r['pickReason'],
            'bigCap': r['bigCap'],
            'capText': (f"{r['capEok'] / 10000:,.1f}조" if r['capEok'] >= 10000 else (f"{r['capEok']:,.0f}억" if r['capEok'] else '')),
            'candles': rn_candles(cs, RN_CANDLE_N),
        })
    ORDER = {'touch_lower': 0, 'near_lower': 1, 'upper': 2, 'touch_upper': 3}
    out.sort(key=lambda s: (ORDER.get(s['category'], 9), -s['valueEok']))
    counts = {'all': len(out), 'touch_lower': 0, 'near_lower': 0, 'upper': 0, 'touch_upper': 0}
    for s in out:
        counts[s['category']] = counts.get(s['category'], 0) + 1
    log(f"  RN존 자동선정 {len(out)}종목 ("
        f"하단터치 {counts['touch_lower']} · 하단근접 {counts['near_lower']} · 상단근접 {counts['upper']} · 상단터치 {counts['touch_upper']})")
    return out, counts, basis


def build_jongbe(uni, per, cache, days):
    """대가별 종가베팅 조건으로 매일 자동 선정.
       · shin(신정재): 윗꼬리 없는 양봉(고가 밀착) + 대금 — 15:18~15:20 매수·익일 09:05 전 청산 트랙
       · kang(강창권): 최근 장대양봉(+10%↑) 뒤 5·20일선 위 눌림 — 4음1양 5일선 지지 트랙"""
    basis = days[2]
    shin, kang = [], []
    for u in uni:
        code = u['code']
        rec = (per.get(code) or {}).get(basis)
        cs = cache.get(code)
        if not rec or not cs or len(cs) < 25:
            continue
        if rec['valueEok'] < JB_MIN_VALUE or rec['c'] < 1000:
            continue
        c, o, h = rec['c'], rec['o'], rec['h']
        body = (c - o) / o * 100 if o else 0.0
        upper = (h - c) / c * 100 if c else 99.0
        s5, s20 = rec.get('sma5'), rec.get('sma20')

        # 신정재 — 윗꼬리 없는 양봉(고가 밀착) · 당일 상승
        if rec['pct'] >= 3.0 and body > 0 and upper <= 1.2:
            shin.append({
                'name': u['name'], 'code': code, 'track': 'shin',
                'price': int(c), 'changeRatio': rec['pct'],
                'valueText': f"{rec['valueEok']:,.0f}억",
                'badge': f"⚡ 신정재 픽: 대금 {rec['valueEok']:,.0f}억 · 고가 밀착 양봉",
                'entry': f"당일 종가 {int(c):,}원 ±0.5% (15:18~15:20 분할)",
                'target': f"{to_tick(c * 1.03):,}원 (+3%) / {to_tick(c * 1.05):,}원 (+5%) · 익일 09:05 전 청산",
                'stop': f"{to_tick(c * 0.992):,}원 (-0.8%) 이탈 시 즉시",
                # 장중 실시간 판정(sd_live/api/tabs-live.js strategyLive.jongbe)이 쓰는 숫자
                'basePrice': int(c), 'target1': to_tick(c * 1.03), 'target2': to_tick(c * 1.05),
                'stopPrice': to_tick(c * 0.992), 'ma5': int(s5) if s5 else None, 'ma20': int(s20) if s20 else None,

                'reason': (f"윗꼬리 없는 양봉(고가 대비 {upper:+.2f}%) · 몸통 {body:+.2f}% · {rec['pct']:+.2f}% 마감. "
                           f"신정재 규칙은 15:18~15:20 진입·익일 09:05 전 전량 청산입니다. "
                           f"당일 고가 {int(h):,}원 / 종가 {int(c):,}원."),
                'candles': rn_candles(cs, 45), '_score': rec['valueEok'] * (1 + rec['pct'] / 100),
            })
        # 강창권(4음 1양 눌림목) — 원전 조건으로 엄격하게 (2026-11-25 사용자 지시)
        #   ① 장대양봉은 3~5번째 봉(오늘 제외 · 3~5거래일 전) · 몸통 +10%↑ — 11/25 사용자 지시로 1거래일 전 봉 제외
        #   ② 정배열 — 5일선 > 20일선 (역배열 제외: 예전 에이피알처럼 역배열 통과 결함)
        #   ③ 오늘은 눌림 — 등락률 -4%~+4%, 몸통 +3% 이하(또 장대양봉 제외), 장대양봉 고점 아래
        #   ④ 5·20일선 위 지지 + 5일선 이격 5% 이내 (이격이 크면 추격)
        #   ⑤ 눌림 구간 거래량 < 장대양봉 거래량 × 80%
        big = None
        for k in range(3, 6):              # k=1(오늘)·k=2(1거래일 전)은 제외 — 당일·전일 급등봉을 '눌림'으로 오인하지 않는다
            if len(cs) < k:
                break
            b = cs[-k]
            if b['o'] and (b['c'] - b['o']) / b['o'] * 100 >= 10.0:
                big = b
                break
        if big and s5 and s20:
            big_body = (big['c'] - big['o']) / big['o'] * 100 if big['o'] else 0.0
            big_high = max(big['h'], big['c'])
            vol_ratio = (rec['v'] / big['v']) if big.get('v') else 9.9
            today_body = (c - o) / o * 100 if o else 0.0
            ma5_gap = abs(c / s5 - 1) * 100 if s5 else 99.0
            ok_kang = (s5 > s20                                   # ② 정배열
                       and -4.0 <= rec['pct'] <= 4.0              # ③ 과도한 급등 추격 제외
                       and today_body <= 3.0                      #   오늘 또 장대양봉이면 눌림 아님
                       and c < big_high                           #   장대양봉 고점을 넘지 않은 눌림
                       and c >= s20 and c >= s5 * 0.985           # ④ 5·20일선 위 지지
                       and ma5_gap <= 5.0                         #   5일선 이격 5% 이내
                       and vol_ratio < 0.8)                       # ⑤ 눌림 구간 거래량 감소
        else:
            ok_kang = False
            big_body = vol_ratio = ma5_gap = 0.0
        if ok_kang:
            kang.append({
                'name': u['name'], 'code': code, 'track': 'kang',
                'price': int(c), 'changeRatio': rec['pct'],
                'valueText': f"{rec['valueEok']:,.0f}억",
                'badge': f"🏆 강창권 픽: 장대양봉 후 눌림 · 5일선 {int(s5):,}원 지지",
                'entry': f"5일선 {int(s5):,}원 지지 확인 후 종가 매수",
                'target': f"{to_tick(c * 1.15):,}원 (+15%)",
                'stop': f"20일선 {int(s20):,}원 이탈 시 매도",
                # 장중 실시간 판정용 숫자 — 손절은 20일선 이탈
                'basePrice': int(c), 'target1': to_tick(c * 1.15), 'target2': None,
                'stopPrice': int(s20), 'ma5': int(s5), 'ma20': int(s20),
                'bigDate': big['date'], 'bigBody': round(big_body, 2), 'volRatio': round(vol_ratio, 2),

                'reason': (f"{big['date'][4:6]}/{big['date'][6:8]} 장대양봉(몸통 +{big_body:.2f}%) 이후 "
                           f"눌림(오늘 {rec['pct']:+.2f}% · 몸통 {today_body:+.2f}%) — 장대양봉 고점 "
                           f"{int(big_high):,}원 아래에서 거래량 {vol_ratio * 100:.0f}%로 줄며 5일선 이격 "
                           f"{ma5_gap:.2f}%. 정배열(5일선 {int(s5):,}원 > 20일선 {int(s20):,}원) · "
                           f"강창권 규칙은 5일선 지지 종가 매수·20일선 이탈 매도입니다."),
                'candles': rn_candles(cs, 45), '_score': rec['valueEok'],
            })

    shin.sort(key=lambda x: -x['_score'])
    kang.sort(key=lambda x: -x['_score'])
    picks = shin[:JB_PICK_PER_TRACK] + kang[:JB_PICK_PER_TRACK]
    for p in picks:
        p.pop('_score', None)
    log(f"  종가베팅 자동선정 {len(picks)}종목 (신정재 {len(shin[:JB_PICK_PER_TRACK])} · 강창권 {len(kang[:JB_PICK_PER_TRACK])})")
    return picks, basis


# ------------------------------------------------------------------ 7c) 📈 깡토 추세추종 · 💰 수급주도주 (일일 자동 교체)
#   깡토(「깡토의 추세추종」 총정리): 전고점 돌파 추세추종.
#     · 후보 ①  전고점(60/120일 고점) 5% 이내 접근 — 시총 1조↑(또는 주도주) + 종가 > 60일선
#     · 후보 ②  당일·최근 60일 전고점 돌파 + 종가 > 60일선
#     · 기준선   매수타점 = 전고점, −8% 손절, +24% 1/3 익절, 60일선(잔량 2/3 이탈 감시)
#   수급: 네이버 종목별 투자자별 매매동향(거래소 확정 bizdate)으로 외인·기관 순매수 상위를 매일 새로 뽑는다.
#     · 금액 = 순매수 주수 × 그날 종가 ÷ 1억 (화면 표기와 같은 기준)
#     · 연기금·금융투자 등 세부 주체는 공개 API에 없어 '외인 + 기관' 두 축만 쓴다(정직 표기).
KK_CAP_EOK = 10000.0        # 시총 1조
KK_LEAD_VALUE = 500.0       # 주도주 근사: 거래대금 500억↑
KK_LEAD_RANK = 50           #            + 대금 순위 50위 내
# 깡토 스캔 전용 ETF/ETN/스팩 추가 제외 (공통 ETF_PAT 에 없는 브랜드·'액티브' 상품)
KK_ETF_PAT = re.compile(r"(1Q |KoAct|KIWOOM|히어로즈|액티브|ETF|ETN|스팩|인버스|레버리지)", re.I)
KK_NEAR_PICK = 12
KK_BREAK_PICK = 12
SUP_CAND_VALUE = 220        # 수급 랭킹 후보: 거래대금 상위 220
SUP_CAND_CAP = 130          #                 + 시총 상위 130
SUP_PICK = 6
SUP_SELL_PICK = 5
SUP_TREND = "https://m.stock.naver.com/api/stock/{code}/trend?pageSize=10&page=1"


def _highest(win):
    best = None
    for c in win:
        if best is None or c["h"] > best["h"]:
            best = c
    return best


# ── 인더스트리 액션: 종목별 뉴스·재료 요약 ────────────────────────────────
#   깡토·수급 카드에 "왜 오늘 움직였는지"(재료·실적·업종 이슈)를 붙이기 위해
#   네이버 증권 종목 뉴스(m.stock.naver.com/api/news/stock/{code})를 읽어
#   헤드라인·언론사·날짜와 재료 키워드 태그를 뽑는다. 요약 문장은 만들지 않고
#   '원문 제목 그대로'만 보여 준다(추론을 사실처럼 쓰지 않기 위해).
NEWS_CACHE = os.path.join(CACHE_DIR, "news-cache.json")
NEWS_TTL_H = 3.0
MATERIAL_PATS = (
    ("수주·계약", re.compile(r"수주|공급계약|계약 체결|납품|MOU|공급 확대|단독")),
    ("실적", re.compile(r"영업이익|실적|어닝|흥자|적자 축소|분기 최대|매출")),
    ("M&A·지분", re.compile(r"인수|합병|지분 인수|최대주주|경영권|분할")),
    ("정책·규제", re.compile(r"정부|규제|허가|승인|법안|관세|보조금|지원사업")),
    ("기술·신제품", re.compile(r"개발|출시|양산|특허|기술|HBM|AI|로봇|전고체|LFP")),
    ("증설·투자", re.compile(r"증설|투자|공장|캐파|생산능력|설비")),
)
KK_NEWS_MAX = 3


def _news_cache_load():
    try:
        d = json.load(open(NEWS_CACHE, encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:              # noqa: BLE001
        return {}


def _news_cache_save(d):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        json.dump(d, open(NEWS_CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    except Exception:              # noqa: BLE001
        pass


def fetch_stock_news(code, name=None):
    """종목 뉴스 → {headlines, newsNote, materialTags, materialScore, materialLevel}
       · 네이버 '종목 뉴스' 피드에는 시장 전체 기사(코스피 마감·환율 등)도 섮여 있어,
         종목명이 들어간 기사를 우선 쓰고 시장 기사만 있으면 재료 강도를 낮게 표기한다."""
    try:
        raw = get(f"https://m.stock.naver.com/api/news/stock/{code}?pageSize=10&page=1", timeout=12)
        groups = json.loads(raw.decode("utf-8", "ignore"))
    except Exception:              # noqa: BLE001
        return None
    rows = []
    for g in (groups or []):
        for it in (g.get("items") or []):
            title = re.sub(r"\s+", " ", html_lib.unescape(str(it.get("title") or ""))).strip()
            if not title:
                continue
            dt = str(it.get("datetime") or "")
            rows.append({"title": title, "press": it.get("officeName") or "",
                         "dt": dt, "date": (f"{dt[4:6]}/{dt[6:8]}" if len(dt) >= 8 else "")})
    # 중복 제목 제거 + 최신순
    seen, uniq = set(), []
    for r in rows:
        k = r["title"][:40]
        if k in seen:
            continue
        seen.add(k)
        uniq.append(r)
    uniq.sort(key=lambda r: r["dt"], reverse=True)
    nm = (name or "").strip()
    named = [r for r in uniq if nm and nm in r["title"]]
    base_rows = named if named else uniq
    heads = base_rows[:KK_NEWS_MAX]
    tags = []
    for tag_name, pat in MATERIAL_PATS:
        if any(pat.search(r["title"]) for r in base_rows[:6]):
            tags.append(tag_name)
    # 재료 점수: 기사 수(0~40) + 태그 다양성(0~30) + 최신성(0~30)
    today = now_kst().strftime("%Y%m%d")
    fresh = sum(1 for r in base_rows if r["dt"][:8] >= today) if base_rows else 0
    score = min(40, len(base_rows) * 8) + min(30, len(tags) * 10)
    score += 30 if fresh >= 2 else (20 if fresh == 1 else 0)
    if not named:                    # 종목명이 들어간 기사가 없으면 시장 기사뿐 → 강하다고 보지 않는다
        score = min(score, 30)
    level = "강" if score >= 70 else ("중" if score >= 45 else "약")
    note = ""
    if heads:
        h = heads[0]
        note = f"{h['title']}" + (f" ({h['press']}, {h['date']})" if h["press"] else "")
    return {"headlines": heads, "newsNote": note, "materialTags": tags,
            "materialScore": score, "materialLevel": level, "newsCount": len(base_rows),
            "nameMatched": bool(named)}


def fetch_news_many(codes, names=None):
    """여러 종목 뉴스를 병렬로(캐시 3시간). 실패한 종목은 결과에서 빠진다."""
    names = names or {}
    cache = _news_cache_load()
    now = time.time()
    out, todo = {}, []
    for code in codes:
        hit = cache.get(code)
        if hit and now - float(hit.get("at") or 0) < NEWS_TTL_H * 3600 and hit.get("nameMatched") is not None:
            out[code] = {k: v for k, v in hit.items() if k != "at"}
        else:
            todo.append(code)
    if todo:
        with ThreadPoolExecutor(max_workers=6) as ex:
            for code, res in zip(todo, ex.map(lambda c: fetch_stock_news(c, names.get(c)), todo)):
                if res:
                    out[code] = res
                    cache[code] = dict(res, at=now)
        _news_cache_save(cache)
    return out


def _material_strength(card):
    """재료·업종 동반 강세 점수 — 카드 상단 우선배치 기준(0~100)"""
    ms = float(card.get("materialScore") or 0)
    ratio = card.get("industryRatio")
    ir = float(ratio) if ratio is not None else 0.0
    return round(ms * 0.6 + ir * 0.4, 1)


def _cap_text(cap_eok):
    if not cap_eok:
        return ""
    if cap_eok >= 10000:
        return f"{cap_eok / 10000:,.1f}조"
    return f"{cap_eok:,.0f}억"


def build_kkangto(uni, per, cache, days, themes=None):
    """깡토 추세추종 — ① 전고점 5% 이내 접근 ② 전고점 돌파. 카드에 매수타점·−8%·+24%·60일선."""
    themes = themes or []
    basis = days[2]
    L2 = dshort(basis)
    MEM = {}
    for t in themes:
        for m in t["members"]:
            MEM.setdefault(m["code"], []).append(t)

    def breadth(code):
        """업종 동반상승 근사 — 네이버 테마 분류 중 동반 상승 비율이 가장 높은 테마."""
        best = None
        for t in MEM.get(code, []):
            rows = [per[m["code"]][basis] for m in t["members"]
                    if m["code"] in per and basis in per[m["code"]]]
            if len(rows) < 3:
                continue
            up = sum(1 for r in rows if r["pct"] > 0)
            rate = sum(r["pct"] for r in rows) / len(rows)
            cand = {"name": t["name"], "up": up, "total": len(rows),
                    "ratio": round(up * 100.0 / len(rows)), "rate": round(rate, 2)}
            if best is None or cand["ratio"] > best["ratio"] or (
                    cand["ratio"] == best["ratio"] and cand["rate"] > best["rate"]):
                best = cand
        return best

    def series(code):
        cs = cache.get(code) or []
        closes = [c["c"] for c in cs]
        ma60 = sum(closes[-60:]) / 60 if len(closes) >= 60 else None
        last = cs[-1] if cs else None
        avg20v = sum(c["v"] for c in cs[-21:-1]) / 20 if len(cs) >= 21 else 0
        return {
            "candles": [{"d": c["date"], "o": c["o"], "h": c["h"], "l": c["l"], "c": c["c"], "v": c["v"]} for c in cs[-130:]],
            "spark15": [[c["date"], c["c"], c["v"]] for c in cs[-15:]],
            "ma60": ma60,
            "chg5": round(pct(last["c"], closes[-6]), 2) if last and len(closes) >= 6 else None,
            "chg20": round(pct(last["c"], closes[-21]), 2) if last and len(closes) >= 21 else None,
            "volRatio": round(last["v"] / avg20v, 2) if last and avg20v else None,
        }

    near, brk = [], []
    scanned = above = 0
    for u in uni:
        code = u["code"]
        cs = cache.get(code) or []
        rec = (per.get(code) or {}).get(basis)
        if not rec or len(cs) < 70:
            continue
        prior = [c for c in cs if c["date"] < basis]
        if len(prior) < 60:
            continue
        scanned += 1
        if KK_ETF_PAT.search(u["name"] or ""):
            continue
        close = rec["c"]
        if close <= 0:
            continue
        ser = series(code)
        ma60 = ser["ma60"]
        if ma60 and close > ma60:
            above += 1
        h60, h120 = _highest(prior[-60:]), _highest(prior[-120:])
        cap = float(u.get("cap") or 0)
        rank = int(u.get("rank") or 9999)
        cap_ok = cap >= KK_CAP_EOK
        leader = rec["valueEok"] >= KK_LEAD_VALUE and rank <= KK_LEAD_RANK
        # ── 전고점 돌파 (오늘·전일·전전일 종가가 그 시점의 60일 전고점을 넘었는가)
        brk_days = None
        for ago, d in enumerate(reversed(days)):
            r = (per.get(code) or {}).get(d)
            if not r:
                continue
            pri = [c for c in cs if c["date"] < d][-60:]
            if len(pri) < 30:
                continue
            if r["c"] >= max(x["h"] for x in pri):
                brk_days = ago
                break
        up_trend = bool(ma60 and close > ma60)
        size_ok = cap_ok or leader        # 깡토 발굴 조건: 시총 1조↑(또는 주도주 근사)
        card = None
        if brk_days is not None and up_trend and size_ok:
            card = {"section": "break", "breakDaysAgo": brk_days, "basis": int(h60["h"]),
                    "hi60": int(h60["h"]), "hi60Date": h60["date"],
                    "hi120": int(h120["h"]), "hi120Date": h120["date"],
                    "dist": round((h60["h"] - close) / close * 100, 2)}
        elif size_ok and up_trend:
            ref = h60 if h60["h"] >= close else h120
            dist = (ref["h"] - close) / close * 100
            if 0 <= dist <= 5.0:
                card = {"section": "near", "breakDaysAgo": None, "basis": int(ref["h"]),
                        "hi60": int(h60["h"]), "hi60Date": h60["date"],
                        "hi120": int(h120["h"]), "hi120Date": h120["date"],
                        "dist": round(dist, 2)}
        if not card:
            continue
        bd = breadth(code)
        base = card["basis"]
        flags, note = [], ""
        if rec["upper"] >= 3.0:
            flags.append(f"윗꼬리 {rec['upper']:+.2f}% — 돌파 후 윗꼬리가 길면 진입하지 않는 규칙(깡토 03:53)")
        if rec["valueEok"] < 300:
            flags.append(f"대금 {rec['valueEok']:,.0f}억 — 얇은 종목이라 호가 충격 주의")
        if ser["chg5"] is not None and ser["chg5"] >= 20:
            flags.append(f"5일 누적 {ser['chg5']:+.1f}% — 이미 달린 자리(추격 주의)")
        if not cap_ok:
            note = "시총 1조 미만 — 주도주 근사(대금 500억↑·50위 내)로 편입"
        item = {
            "code": code, "name": u["name"], "market": u.get("market") or "",
            "close": int(close), "pct": round(rec["pct"], 2), "prevClose": int(rec["prevClose"]),
            "valueEok": rec["valueEok"], "rank": rank, "capEok": int(cap), "capText": _cap_text(cap),
            "stop": to_tick(base * 0.92), "tp": to_tick(base * 1.24),
            "ma60": int(round(ma60)) if ma60 else None,
            "theme": (bd or {}).get("name"), "themeRate": (bd or {}).get("rate"),
            "industryUp": (bd or {}).get("up"), "industryTotal": (bd or {}).get("total"),
            "industryRatio": (bd or {}).get("ratio"),
            "upper": rec["upper"], "chg5": ser["chg5"], "chg20": ser["chg20"], "volRatio": ser["volRatio"],
            "capOk": cap_ok, "leaderOk": leader,
            "candles": ser["candles"], "spark15": ser["spark15"],
            "flags": flags, "note": note,
            "upTrend": up_trend,
            "reasons": [
                f"{L2} 종가 <b>{close:,.0f}원({rec['pct']:+.2f}%)</b> · 60일선 {ma60:,.0f}원 " + ("위(추세 유지)" if up_trend else "아래"),
                f"60일 전고점 <b>{h60['h']:,.0f}원({dshort(h60['date'])})</b> · 120일 전고점 <b>{h120['h']:,.0f}원({dshort(h120['date'])})</b>",
                f"거래대금 <b>{rec['valueEok']:,.0f}억</b>({rank}위) · 시총 <b>{_cap_text(cap) or '—'}</b>",
            ],
        }
        item.update(card)
        item["gapPct"] = round((close - base) / base * 100, 2) if base else None
        # 돌파 후 −8% 손절선을 이미 이탈한 종목은 '돌파 종목'이 아니라 실패 사례다 — 목록에서 뺀다
        if item["section"] == "break" and item["gapPct"] is not None and item["gapPct"] < -8.0:
            continue
        (brk if card["section"] == "break" else near).append(item)

    near.sort(key=lambda x: (x["dist"], -x["valueEok"]))
    brk.sort(key=lambda x: (x["breakDaysAgo"], -x["valueEok"]))
    cards = near[:KK_NEAR_PICK] + brk[:KK_BREAK_PICK]

    # ── 인더스트리 액션: 선정 종목마다 네이버 종목 뉴스(재료·실적) + 테마/업종 동반 수치를 붙인다
    try:
        news_map = fetch_news_many([c["code"] for c in cards],
                                    {c["code"]: c["name"] for c in cards})
    except Exception as e:        # noqa: BLE001
        news_map = {}
        log(f"  ! 종목 뉴스 조회 실패({e}) — 재료 없이 진행")
    for c in cards:
        n = news_map.get(c["code"]) or {}
        c["newsHeadlines"] = n.get("headlines") or []
        c["newsNote"] = n.get("newsNote") or ""
        c["materialTags"] = n.get("materialTags") or []
        c["materialScore"] = n.get("materialScore") or 0
        c["materialLevel"] = n.get("materialLevel") or ""
        c["newsCount"] = n.get("newsCount") or 0
        c["nameMatched"] = bool(n.get("nameMatched"))
        c["industryNote"] = (f"{c['theme']} 테마 {c['themeRate']:+.2f}% · {c['industryUp']}/{c['industryTotal']}종목 상승({c['industryRatio']}%)"
                             if c.get("theme") and c.get("industryTotal") else "업종 분류 없음(개별 재료)")
        c["materialStrength"] = _material_strength(c)
        if c["newsNote"]:
            tags = (" · 재료 " + "/".join(c["materialTags"])) if c["materialTags"] else ""
            nm = "" if c.get("nameMatched") else "/종목명 미포함(시장 기사)"
            c["reasons"].append(f"📌 재료·이슈 — {c['newsNote']}{tags}{nm} (관련 보도 {c['newsCount']}건 · 재료 강도 {c['materialLevel']})")
        else:
            c["reasons"].append("📌 재료·이슈 — 오늘 종목 뉴스 없음(재료 미확인, 차트·수급만으로 판단)")
    # 재료·업종 동반 강세(강도 50↑) 종목을 각 섹션 상단으로 — 나머지는 종전 순서(전고점 거리·돌파시점) 유지
    cards.sort(key=lambda c: (0 if c["section"] == "near" else 1,
                              -(1 if c["materialStrength"] >= 50 else 0),
                              (c["dist"] if c["section"] == "near" else (c["breakDaysAgo"] or 0)),
                              -c["valueEok"]))
    nxt = next_trading_day(basis)
    payload = {
        "generatedAt": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
        "basisDate": basis, "basisLabel": dlong(basis),
        "nextLabel": dlong_short(nxt), "days": days,
        "universe": len(uni), "scanned": scanned,
        "kpi": {"near": len(near), "breakout": len(brk), "aboveMa60": above,
                "withNews": len([c for c in cards if c.get("newsNote")]),
                "strongMaterial": len([c for c in cards if (c.get("materialScore") or 0) >= 70])},
        "materialBasis": "재료·이슈 = 네이버 증권 종목 뉴스 헤드라인 원문(요약 생성 없음) · 업종 = 네이버 테마 분류 동반 상승 비율",
        "counts": {"near": len(near), "breakout": len(brk)},
        "rule": {"stop": -8.0, "tp": 24.0, "seedRisk": 2.0, "units": 5, "marketUnits": [2, 1], "stockUnits": [1, 2, 3]},
        "cards": cards,
    }
    log(f"  깡토 — 스캔 {scanned} · 60일선 위 {above} · 접근 후보 {len(near)} · 돌파 {len(brk)}  (카드 {len(cards)})")
    return payload


def fetch_trend_one(code):
    """종목별 투자자별 매매동향(거래소 확정) — 최신순 [{'d','close','f','o','i'}], 실패는 None."""
    try:
        data = getj(SUP_TREND.format(code=code), timeout=12)
    except Exception:                     # noqa: BLE001
        return None
    if not isinstance(data, list) or not data:
        return None
    rows = []
    for r in data:
        bd = str(r.get("bizdate") or "")
        if not re.fullmatch(r"\d{8}", bd):
            continue
        rows.append({"d": bd, "close": num(r.get("closePrice")),
                     "f": num(r.get("foreignerPureBuyQuant")),
                     "o": num(r.get("organPureBuyQuant")),
                     "i": num(r.get("individualPureBuyQuant"))})
    rows.sort(key=lambda x: -int(x["d"]))
    return rows or None


def _streak(rows, key):
    """최신일부터 같은 부호가 며칠 이어졌는지."""
    n = 0
    for r in rows:
        v = r.get(key)
        if v is None or v == 0:
            break
        if n == 0:
            sign = 1 if v > 0 else -1
            n = 1
        elif (v > 0 and sign > 0) or (v < 0 and sign < 0):
            n += 1
        else:
            break
    return n


def build_supply(uni, per, cache, days, workers=8, budget=150.0):
    """2번 수급주도주 — 거래소 확정치(외인·기관 순매수 주수 × 종가)로 매일 새 목록."""
    names = {u["code"]: u for u in uni}
    by_value = sorted(uni, key=lambda u: -(u.get("valueEok") or 0))[:SUP_CAND_VALUE]
    by_cap = sorted(uni, key=lambda u: -(u.get("cap") or 0))[:SUP_CAND_CAP]
    cands, seen = [], set()
    for u in by_value + by_cap:
        c = u["code"]
        if c in seen or not (cache.get(c) and len(cache.get(c)) > 30):
            continue
        seen.add(c)
        cands.append(c)
    log(f"  수급 후보 {len(cands)}종목 — 투자자별 매매동향 조회")
    t0 = time.time()
    rows_by = {}

    def job(code):
        return code, fetch_trend_one(code)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for code, rows in ex.map(job, cands):
            if rows:
                rows_by[code] = rows
            if time.time() - t0 > budget:
                break
    if not rows_by:
        log("  ! 투자자별 매매동향 응답 없음 — 수급 목록을 갱신하지 않습니다")
        return None
    latest = max(rows[0]["d"] for rows in rows_by.values())
    items = []
    for code, rows in rows_by.items():
        row = next((r for r in rows if r["d"] == latest), None)
        if not row or not row["close"]:
            continue
        close = row["close"]
        idx = rows.index(row)
        prev = rows[idx + 1]["close"] if idx + 1 < len(rows) else None
        u = names.get(code) or {}
        f_amt = round((row["f"] or 0) * close / 1e8, 1)
        o_amt = round((row["o"] or 0) * close / 1e8, 1)
        i_amt = round((row["i"] or 0) * close / 1e8, 1)
        cap = float(u.get("cap") or 0)
        items.append({
            "code": code, "name": u.get("name") or code, "market": u.get("market") or "",
            "price": int(close), "pct": round(pct(close, prev), 2) if prev else 0.0,
            "foreignEok": f_amt, "organEok": o_amt, "individualEok": i_amt,
            "streakForeign": _streak(rows, "f"), "streakOrgan": _streak(rows, "o"),
            "valueText": f"{u.get('value_eok', 0):,.0f}억" if u.get("value_eok") else "",
            "capText": _cap_text(cap),
            "desc": f"외국인 {f_amt:+,.0f}억 · 기관 {o_amt:+,.0f}억 · 개인 {i_amt:+,.0f}억 (확정 {dshort(latest)} 종가 기준)",
        })
    if not items:
        log("  ! 확정 수급 항목 0건 — 수급 목록을 갱신하지 않습니다")
        return None
    foreign_buy = sorted([x for x in items if x["foreignEok"] > 0], key=lambda x: -x["foreignEok"])[:SUP_PICK]
    organ_buy = sorted([x for x in items if x["organEok"] > 0], key=lambda x: -x["organEok"])[:SUP_PICK]
    foreign_sell = sorted([x for x in items if x["foreignEok"] < 0], key=lambda x: x["foreignEok"])[:SUP_SELL_PICK]
    dual = sorted([x for x in items if x["foreignEok"] > 0 and x["organEok"] > 0],
                  key=lambda x: -(x["foreignEok"] + x["organEok"]))[:SUP_PICK]
    payload = {
        "generatedAt": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
        "basisDate": latest, "basisLabel": dlong(latest), "confirmed": True,
        "candidates": len(items), "source": "네이버 종목별 투자자별 매매동향(거래소 확정)",
        "groups": {"foreignBuy": foreign_buy, "organBuy": organ_buy,
                   "foreignSell": foreign_sell, "dualBuy": dual},
    }
    log(f"  수급 확정 {dlong(latest)} — 외인매수 {len(foreign_buy)} · 기관매수 {len(organ_buy)} · "
        f"외인매도 {len(foreign_sell)} · 동반매수 {len(dual)}")
    return payload


def patch_js_const(path, name, obj):
    """live-kkangto.js / live-supply.js 안의 `const NAME = {...};` 한 줄을 새 JSON으로 교체."""
    if not os.path.exists(path):
        return False
    src = open(path, encoding="utf-8").read()
    pat = re.compile(r"^const " + name + r" = \{.*\};$", re.M)
    if not pat.search(src):
        return False
    payload = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    new = pat.sub(lambda m: "const " + name + " = " + payload + ";", src, count=1)
    if new == src:
        return False
    open(path, "w", encoding="utf-8").write(new)
    return True


def force_today_from_krx(cache, basis, key):
    """장마감 직후 캐시의 '오늘 봉'이 장중 값이면 KRX 확정치로 덮어쓴다(깡토 재계산용)."""
    if not key:
        return 0
    krx, errs = fetch_krx_daily(basis, key)
    if not krx:
        log(f"  ! KRX 확정치 없음 {errs[:1]}")
        return 0
    fixed = 0
    for code, k in krx.items():
        cs = cache.get(code)
        if not cs or not k.get("close"):
            continue
        bar = {"date": basis, "o": k["open"] or k["close"], "h": k["high"] or k["close"],
               "l": k["low"] or k["close"], "c": k["close"], "v": int(k["vol"] or 0)}
        if cs and cs[-1]["date"] == basis:
            cs[-1] = bar
            fixed += 1
        elif cs and cs[-1]["date"] < basis:
            cs.append(bar)
            fixed += 1
    save_cache(cache)
    log(f"  KRX 확정치로 오늘 봉 보정 {fixed}종목 ({dlong(basis)})")
    return fixed


def rn_chip_html(stocks):
    """1번 탭 '실전 타점 신호등'의 RN존 칩을 오늘 자동선정 종목으로 다시 만든다.
       (예전에는 피에스케이홀딩스·하나마이크론이 박혀 있어 목록에서 빠지면 눌러도 열리지 않았다)"""
    greens = [s for s in stocks if s['category'] in ('touch_lower', 'near_lower')]
    reds = [s for s in stocks if s['category'] in ('upper', 'touch_upper')]
    out = []
    for s in greens[:2]:
        zone = '하단안착' if s['category'] == 'touch_lower' else '하단근접'
        out.append(
            f'<div class="signal-chip green" onclick="navigateToSignalStock(\'rnzone\', \'{s["code"]}\')">\n'
            f'        <span>🟢 [RN존 {zone}]</span>\n'
            f'        <strong>{s["name"]}:</strong>\n'
            f'        <span>{s["buy1"]:,}원 이하 체결존 안착 (현재 {s["price"]:,}원 🎯)</span>\n'
            f'      </div>'
        )
    for s in reds[:1]:
        zone = '상단돌파' if s['category'] == 'touch_upper' else '상단근접'
        out.append(
            f'<div class="signal-chip red" onclick="navigateToSignalStock(\'rnzone\', \'{s["code"]}\')">\n'
            f'        <span>🔥 [RN존 {zone}]</span>\n'
            f'        <strong>{s["name"]}:</strong>\n'
            f'        <span>상단 RN {s["upperRN"]:,}원({s["upperColorKo"]}) 근처 (현재 {s["price"]:,}원 🎯)</span>\n'
            f'      </div>'
        )
    return out


def patch_rn_chips(html, stocks):
    chips = rn_chip_html(stocks)
    pat = re.compile(r'<div class="signal-chip[^"]*"[^>]*onclick="navigateToSignalStock\(\'rnzone\', \'\d{6}\'\)"[\s\S]*?</div>')
    i = [0]

    def repl(m):
        k = i[0]
        i[0] += 1
        return chips[k] if k < len(chips) else ""

    html = pat.sub(repl, html)
    return html, len(chips)


def patch_rn_live(html, rn_stocks, counts):
    """RAW_STOCKS 배열 + 카테고리 탭 개수 라벨을 새 자동선정 목록으로 바꾼다."""
    m = re.search(r'(const RAW_STOCKS = )(\[.*?\])(;)', html, re.DOTALL)
    if not m:
        return html, False
    payload = json.dumps(rn_stocks, ensure_ascii=False, separators=(',', ':'))
    html = html[:m.start(2)] + payload + html[m.end(2):]
    labs = [('all', '전체 ({})'.format(counts['all'])),
            ('touch_lower', '🟢 하단 터치 ({})'.format(counts.get('touch_lower', 0))),
            ('near_lower', '🟡 하단 근접 ({})'.format(counts.get('near_lower', 0))),
            ('upper', '🔥 상단 근접 ({})'.format(counts.get('upper', 0))),
            ('touch_upper', '🚀 상단 돌파 ({})'.format(counts.get('touch_upper', 0)))]
    for key, txt in labs:
        pat = r"(onclick=\"RnZone\.filterCategory\('" + key + r"', this\)\">)[^<]*(</button>)"
        html = re.subn(pat, lambda mm, t=txt: mm.group(1) + t + mm.group(2), html)[0]
    # 1번 탭 '실전 타점 신호등' RN존 칩도 오늘 목록으로 교체
    html, _nchips = patch_rn_chips(html, rn_stocks)
    return html, True


def patch_jongbe_live(html, jb_stocks):
    """Jongbe 엔진 안의 `const STOCKS = [...]` 를 새 자동선정 목록으로 바꾸고,
       탭 버튼의 트랙 개수 라벨(전체·신정재·강창권)도 실제 목록 수로 맞춘다.
       (예전에는 '전체 (10) · 강창권 (5)'가 HTML 에 박혀 있어 목록이 2종목이어도 5로 보였다)"""
    m = re.search(r'(window\.Jongbe\s*=\s*\(function\(\)\s*\{[\s\S]*?const STOCKS = )(\[.*?\])(;)', html)
    if not m:
        return html, False
    payload = json.dumps(jb_stocks, ensure_ascii=False, separators=(',', ':'))
    html = html[:m.start(2)] + payload + html[m.end(2):]
    n_all = len(jb_stocks or [])
    n_shin = len([x for x in (jb_stocks or []) if x.get('track') == 'shin'])
    n_kang = len([x for x in (jb_stocks or []) if x.get('track') == 'kang'])
    labs = [('all', '전체 ({})'.format(n_all)), ('shin', '⚡ 신정재 ({})'.format(n_shin)), ('kang', '🏆 강창권 ({})'.format(n_kang))]
    for key, txt in labs:
        pat = r"(onclick=\"Jongbe\.filterStocks\('" + key + r"', this\)\">)[^<]*(</button>)"
        html = re.subn(pat, lambda mm, t=txt: mm.group(1) + t + mm.group(2), html)[0]
    return html, True


def jongbe_badge_text(jb_stocks):
    """차트에 실제로 그려지는 캔들 수·기간 — 캡션이 차트보다 뒤처지지 않게 값을 그대로 센다."""
    best = []
    for s in jb_stocks or []:
        cd = [c for c in (s.get('candles') or []) if c.get('date')]
        if len(cd) > len(best):
            best = cd
    if len(best) < 2:
        return None
    return (f"최근 {len(best)}거래일 실제 팩트 일봉 데이터 "
            f"({best[0]['date']} ~ {best[-1]['date']} 마감 확정)")


def patch_jongbe_badge(html, jb_stocks):
    """`#jongbeDateBadge` 캡션을 실제 캔들 범위로 바꾼다.
       (11/24까지 '최근 40거래일 … 2026-11-12 마감 확정' 이 8거래일 뒤처져 있었다)"""
    txt = jongbe_badge_text(jb_stocks)
    if not txt:
        return html, False
    pat = re.compile(r'(<div id="jongbeDateBadge"[^>]*>)[^<]*(</div>)')
    new, n = pat.subn(lambda m: m.group(1) + txt + m.group(2), html, count=1)
    return new, bool(n)


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
        # 11/24 — 도해 캡션의 '최근 3거래일(11/18~11/20)' 처럼 괄호 없이 시작하는 표기와,
        #   실시간 라벨 툴팁에 박혀 있던 '11/13 종가(기준선)' 도 실제 기준일로 맞춘다.
        (r"(최근 3거래일\()\d{1,2}/\d{1,2}~\d{1,2}/\d{1,2}(\))", rf"\g<1>{span}\g<2>"),
        (r"\d{1,2}/\d{1,2} 종가\(기준선\) 대비 자체 계산", f"{basis_short} 종가(기준선) 대비 자체 계산"),
        (r"\d{1,2}/\d{1,2} 일봉 확정 등락률", f"{basis_short} 일봉 확정 등락률"),
        (r"(기준일 <b id=\"hiFootBasis\">)[^<]*(</b>)", rf"\g<1>{hong['basisLabel']}\g<2>"),
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
    ap.add_argument("--only", choices=["all", "kkangto"], default="all",
                    help="kkangto = 깡토·수급만 다시 스캔(홍인기·비중법사·RN존·종베는 그대로 둠)")
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

    # ---- 깡토·수급만 다시 스캔하는 경량 경로 (전체 4탭은 그대로 둔다)
    if args.only == "kkangto":
        log("[kkangto] 깡토 추세추종 · 수급주도주만 재스캔")
        uni, _totals = build_universe(args.pages)
        if not uni:
            log("유니버스 0종목 — 중단(기존 스캔 유지)")
            return 2
        cache = load_cache()
        key = load_krx_key()
        today = now_kst().strftime("%Y%m%d")
        fixed = 0
        if basis == today:
            fixed = force_today_from_krx(cache, basis, key)
            if not fixed:
                # KRX 확정치가 아직 없으면 시총·대금 랭킹의 최신 종가로 오늘 봉 종가를 맞춘다
                for u in uni:
                    cs = cache.get(u["code"])
                    c0 = float(u.get("close") or 0)
                    if not cs or not c0 or cs[-1]["date"] != basis:
                        continue
                    bar = cs[-1]
                    bar["c"] = c0
                    bar["h"] = max(bar["h"], c0)
                    bar["l"] = min(bar["l"], c0)
                    fixed += 1
                save_cache(cache)
                log(f"  랭킹 최신 종가로 오늘 봉 종가 보정 {fixed}종목")
        per = {}
        for u in uni:
            cs = cache.get(u["code"])
            if not cs or len(cs) < 130:
                continue
            r = day_records(u["code"], cs, days)
            if r:
                per[u["code"]] = r
        themes = build_themes()
        kk = build_kkangto(uni, per, cache, days, themes)
        sup = build_supply(uni, per, cache, days)
        open(os.path.join(DATA_DIR, "kkangto-latest.json"), "w", encoding="utf-8").write(
            json.dumps(kk, ensure_ascii=False, separators=(",", ":")))
        if sup:
            open(os.path.join(DATA_DIR, "supply-latest.json"), "w", encoding="utf-8").write(
                json.dumps(sup, ensure_ascii=False, separators=(",", ":")))
        if not args.dry:
            ok_kk = patch_js_const(os.path.join(PUB, "live-kkangto.js"), "DATA", kk)
            ok_sup = patch_js_const(os.path.join(PUB, "live-supply.js"), "SUPPLY", sup) if sup else None
            log(f"  모듈 반영 — 깡토 {ok_kk} · 수급 {ok_sup}")
            if not ok_kk:
                return 1
        print(json.dumps({"ok": True, "only": "kkangto", "basisDate": basis,
                          "kkangto": kk["kpi"], "supply": (sup or {}).get("candidates", 0),
                          "fixedToday": fixed}, ensure_ascii=False))
        return 0

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

    # ---- KRX 오픈API 확정치 교차검증 (장마감 후·확정일 스캔에서만)
    krx_stat, krx_errors = None, []
    krx_key = load_krx_key()
    settled = (basis != now_kst().strftime("%Y%m%d")) or (now_kst().hour * 60 + now_kst().minute >= 15 * 60 + 40)
    if krx_key and settled:
        log("[4b] KRX 오픈API 확정치 교차검증")
        krx_rows, krx_errors = fetch_krx_daily(basis, krx_key)
        if krx_rows:
            krx_stat = krx_adjust(per, cache, basis, krx_rows)
            log(f"  KRX 교차검증 — 확인 {krx_stat['checked']} · 보정 {krx_stat['fixed']}종목 · "
                f"대금만 보정 {krx_stat['valueOnly']} · 미포함 {krx_stat['missing']}")
            save_cache(cache)
        else:
            log(f"  ! KRX 응답 없음 — 네이버 값으로 진행 {krx_errors[:2]}")
    elif not krx_key:
        log("  KRX 키 없음(/workspace/.krx_api_key) — 네이버 값 그대로 사용")
    else:
        log("  장중 기준일 스캔 — KRX 확정치 대기(네이버 값 사용)")

    hong = build_hong(uni, per, themes, days, totals)
    bij = build_bij(uni, per, days, base_count=len(cache))
    log(f"  홍인기 카드 {len(hong['cards'])} · 탈락 {len(hong['reject'])}")
    log(f"  비중법사 기준봉 {bij['baseCount']} · 카드 {len(bij['cards'])} · 탈락 {len(bij['rejects'])}")
    # 5개 전략 탭 통일 — RN존·종가베팅도 같은 장마감 일봉으로 매일 새로 선정한다.
    rn_stocks, rn_counts, rn_basis = build_rnzone(uni, per, cache, days)
    jb_stocks, jb_basis = build_jongbe(uni, per, cache, days)
    # 📈 깡토 추세추종 · 💰 수급주도주 — 같은 장마감 일봉으로 매일 새로 뽑는다
    kk = build_kkangto(uni, per, cache, days, themes)
    sup = build_supply(uni, per, cache, days)

    payload = {
        "generatedAt": hong["generatedAt"], "basisDate": basis, "days": days,
        "basisLongLabel": hong["basisLongLabel"],
        "nextDay": next_trading_day(basis), "nextLabel": dshort(next_trading_day(basis)),
        "nextLongLabel": dlong_short(next_trading_day(basis)),
        "universe": len(uni), "scanned": len(per),
        "honginki": hong, "bijoong": bij,
        "rnzone": {"count": len(rn_stocks), "counts": rn_counts, "basisDate": rn_basis},
        "jongbe": {"count": len(jb_stocks), "basisDate": jb_basis},
        "kkangto": {"near": kk["kpi"]["near"], "breakout": kk["kpi"]["breakout"], "cards": len(kk["cards"])},
        "supply": {"count": (sup or {}).get("candidates", 0), "basisDate": (sup or {}).get("basisDate")},
        "krx": {"basisDate": basis, "stat": krx_stat, "errors": krx_errors[:3]},
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
    # 📈 깡토 · 💰 수급 (데이터 파일 + 프런트 모듈의 const 한 줄)
    open(os.path.join(DATA_DIR, "kkangto-latest.json"), "w", encoding="utf-8").write(
        json.dumps(kk, ensure_ascii=False, separators=(",", ":")))
    if sup:
        open(os.path.join(DATA_DIR, "supply-latest.json"), "w", encoding="utf-8").write(
            json.dumps(sup, ensure_ascii=False, separators=(",", ":")))
    if not args.dry:
        ok_kk = patch_js_const(os.path.join(PUB, "live-kkangto.js"), "DATA", kk)
        ok_sup = patch_js_const(os.path.join(PUB, "live-supply.js"), "SUPPLY", sup) if sup else None
        log(f"  깡토 모듈 반영 {ok_kk} · 수급 모듈 반영 {ok_sup}")
        if not ok_kk:
            log("! live-kkangto.js 의 const DATA 블록을 찾지 못했습니다 — 파일을 건드리지 않습니다")
    for path, obj in ((os.path.join(DATA_DIR, "rnzone-latest.json"),
                       {"generatedAt": payload["generatedAt"], "basisDate": rn_basis,
                        "basisLabel": dlong(rn_basis),
                        "counts": rn_counts, "stocks": rn_stocks}),
                      (os.path.join(DATA_DIR, "jongbe-latest.json"),
                       {"generatedAt": payload["generatedAt"], "basisDate": jb_basis,
                        "basisLabel": dlong(jb_basis),
                        "stocks": jb_stocks})):
        open(path, "w", encoding="utf-8").write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))

    # 📌 장전 프리마켓 테마맵용 '직전 거래일 강세 Top 8 테마' 스냅샷
    #   프리마켓에는 네이버 테마 랭킹이 전 종목 0.00%로 내려와 장전 테마맵이 고정 8대 테마로 폴백한다.
    #   장마감 확정 일봉(방금 받은 cache)으로 오늘 강세 Top 8을 다시 계산해 public/data/last-dynamic-themes.json 에 남긴다.
    try:
        import save_last_dynamic_themes as lastdyn
        snap = lastdyn.build_from_cache(basis=basis, groups=themes, cache=cache, write=not args.dry)
        if snap.get("ok"):
            log("  직전 강세 테마 스냅샷 " + snap["asOfDate"] + " — " + " / ".join(snap.get("themes", [])[:3]))
        else:
            log(f"  ! 직전 강세 테마 스냅샷 미생성: {snap.get('reason')}")
    except Exception as e:      # noqa: BLE001
        log(f"  ! 직전 강세 테마 스냅샷 실패: {e}")

    # ---- HTML 반영
    patched = {"hong": 0, "bij": 0}
    if not args.dry:
        html = open(HTML, encoding="utf-8").read()
        html, patched = patch_inline_data(html, js_hong, js_bij)
        if patched["hong"] != 1 or patched["bij"] != 1:
            log(f"! DATA 블록을 정확히 찾지 못했습니다 {patched} — index.html을 쓰지 않습니다")
            return 1
        html, nlab = patch_labels(html, hong, bij)
        html, rn_ok = patch_rn_live(html, rn_stocks, rn_counts)
        html, jb_ok = patch_jongbe_live(html, jb_stocks)
        html, jb_badge = patch_jongbe_badge(html, jb_stocks)
        if not rn_ok or not jb_ok or not jb_badge:
            log(f"! RN존·종베 목록/일봉 캡션 블록을 찾지 못했습니다 (rn={rn_ok} jb={jb_ok} badge={jb_badge}) — index.html을 쓰지 않습니다")
            return 1
        open(HTML, "w", encoding="utf-8").write(html)
        rep = validate_html()
        log(f"  HTML 반영 — DATA {patched} · 라벨 {nlab}곳 · RN {len(rn_stocks)} · 종베 {len(jb_stocks)} · 구문오류 {len(rep['syntax_errors'])} · div차이 {rep['div_delta']}")
        # 정적 미러(deploy_repo/index.html)도 같은 자동선정 목록으로 맞춘다
        if os.path.exists(STATIC_HTML):
            try:
                st = open(STATIC_HTML, encoding="utf-8").read()
                st2, a1 = patch_rn_live(st, rn_stocks, rn_counts)
                st2, b1 = patch_jongbe_live(st2, jb_stocks)
                st2, b2 = patch_jongbe_badge(st2, jb_stocks)
                b1 = b1 and b2
                # 11/18 — 정적 미러에도 비중법사·홍인기 탭이 이식됐다. 내장 DATA(엔진 블록의
                #   const DATA 한 줄)와 라벨도 같이 갈아끼우지 않으면 정적 페어지만 옛 기준봉이 남는다.
                st2, p_st = patch_inline_data(st2, js_hong, js_bij)
                st2, nlab_st = patch_labels(st2, hong, bij)
                if a1 and b1 and st2 != st:
                    open(STATIC_HTML, "w", encoding="utf-8").write(st2)
                    log(f"  정적 미러(deploy_repo/index.html) RN존·종베·비중법사·홍인기 동기화 "
                        f"(DATA {p_st} · 라벨 {nlab_st}곳)")
                elif not (a1 and b1):
                    log(f"  ! 정적 미러 블록 미발견(rn={a1} jb={b1}) — 그대로 둠")
                if p_st.get("hong") != 1 or p_st.get("bij") != 1:
                    log(f"  ! 정적 미러 DATA 블록 미발견 {p_st} — 정적 탭은 옛 스냅샷으로 남습니다")
            except Exception as e:      # noqa: BLE001
                log(f"  ! 정적 미러 동기화 실패: {e}")
            # 깡토 모듈도 정적 미러용 사본(deploy_repo/live-kkangto.js)의 const DATA 를 같이 갱신
            kk_deploy = os.path.join(os.path.dirname(ROOT), "deploy_repo", "live-kkangto.js")
            if os.path.exists(kk_deploy):
                try:
                    ok_kk2 = patch_js_const(kk_deploy, "DATA", kk)
                    if ok_kk2:
                        log("  정적 미러 깡토 모듈(live-kkangto.js) DATA 동기화")
                    else:
                        log("  ! 정적 미러 live-kkangto.js 의 const DATA 를 찾지 못했습니다 — 그대로 둠")
                except Exception as e:      # noqa: BLE001
                    log(f"  ! 정적 미러 깡토 모듈 동기화 실패: {e}")
        if not rep["ok"]:
            log(json.dumps(rep, ensure_ascii=False)[:1200])
            return 1

    # ---- 종목코드 ↔ 종목명 교차 점검 (11/18 점검 D2 재발 방지)
    #   같은 코드가 다른 이름으로 표시되면 차트·링크·수급 카드가 남의 종목을 가리킨다.
    #   (11/17에 "고쳤다"고 한 143240 = 펨트론 오기가 그대로 남아 있었다)
    try:
        import verify_code_names                 # scripts/verify_code_names.py
        _vres = verify_code_names.verify()
        verify_code_names.report(_vres)
        if not _vres["ok"]:
            log("  ! 종목코드/이름 불일치 — api/stock-live.js(DEFAULT_STOCKS)·api/stock-chart.js(ALIAS) 를 고치세요")
    except Exception as e:                        # noqa: BLE001
        log(f"  ! 종목코드 교차 점검 건너뜀({e})")

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
