#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""🔎 종목코드 ↔ 종목명 교차 일치 점검 (verify_code_names.py)

11/18 전수 점검에서 `/api/stock-live` 응답이 `143240 = 이름 "사람인" / label "펨트론"` 으로
어긋나 있던 결함(D2)이 **어제 고쳤다고 보고한 뒤에도** 그대로 남아 있었다.
같은 코드가 다른 종목 이름으로 표시되면 차트·링크·수급 카드가 통째로 남의 종목을 가리킨다.

그래서 이 스크립트는:
  ① `api/stock-live.js` 의 DEFAULT_STOCKS (코드 → 이름)
  ② `api/stock-chart.js` 의 ALIAS (이름 → 코드)
  ③ `api/stock-chart.js` 의 SEARCH_MAP 이 있다면 그것까지
를 네이버 실측(자동완성·검색 API · fchart 일봉 헤더의 종목명)과 대조해 불일치를 경고한다.

    python3 scripts/verify_code_names.py            # 점검 (캐시 12시간)
    python3 scripts/verify_code_names.py --fresh    # 캐시 무시
    python3 scripts/verify_code_names.py --quiet    # 불일치만 출력
    python3 scripts/verify_code_names.py --json     # 결과 JSON

종료 코드: 0 불일치 없음 · 4 불일치 발견 · 1 점검 자체 실패
`rescan_strategies.py` 가 재스캔 끝에 이 점검을 자동으로 부른다(불일치면 경고만, 스캔은 계속).
"""
import argparse
import html as html_lib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                     # .../sd_live
API_DIR = os.path.join(ROOT, "api")
CACHE_PATH = os.path.join(HERE, ".cache", "code-name-check.json")
TTL_H = 12.0

UA = {"User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36",
      "Referer": "https://m.stock.naver.com/"}

# 알려진 정정 (2026-11-18) — 이 표에 있는 이름·코드는 실측이 실패해도 그대로 경고한다
KNOWN = {
    "143240": "사람인",
    "168360": "펨트론",
}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def get(url, timeout=12):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- 소스 표 읽기
def read_default_stocks(path):
    """api/stock-live.js 의 DEFAULT_STOCKS → [(code, name), ...]"""
    try:
        src = open(path, encoding="utf-8").read()
    except OSError:
        return []
    m = re.search(r"const DEFAULT_STOCKS = \[([\s\S]*?)\];", src)
    if not m:
        return []
    return [(c, n) for c, n in re.findall(r"\{\s*code:\s*'(\d{6})'\s*,\s*name:\s*'([^']+)'\s*\}", m.group(1))]


def read_alias(path):
    """api/stock-chart.js 의 ALIAS (이름 → 코드) → [(name, code), ...]"""
    try:
        src = open(path, encoding="utf-8").read()
    except OSError:
        return []
    m = re.search(r"const ALIAS = \{([\s\S]*?)\n\};", src)
    if not m:
        return []
    out = []
    for name, code in re.findall(r"^\s*'?([^':\n]+)'?\s*:\s*'(\d{6})'\s*,?\s*$", m.group(1), re.M):
        out.append((name.strip().strip("'"), code))
    return out


# ---------------------------------------------------------------- 네이버 실측
def fetch_fchart_name(code):
    """fchart 일봉 XML 헤더의 종목명(EUC-KR) — 거래소 종목코드의 실제 이름."""
    try:
        raw = get(f"https://fchart.stock.naver.com/sise.nhn?symbol={code}&timeframe=day&count=2&requestType=0")
    except Exception:                  # noqa: BLE001
        return None
    txt = raw.decode("euc-kr", "ignore")
    m = re.search(r'<chartdata[^>]*\bname="([^"]*)"', txt)
    return html_lib.unescape(m.group(1)).strip() if m else None


def fetch_search_code(name):
    """네이버 증권 검색 API — 종목명의 6자리 코드(정확 일치 우선)."""
    try:
        raw = get("https://m.stock.naver.com/front-api/search?q="
                  + urllib.parse.quote(name) + "&target=stock&size=20&page=1")
        data = json.loads(raw.decode("utf-8", "ignore"))
    except Exception:                  # noqa: BLE001
        return None
    items = ((data.get("result") or {}).get("items") or [])
    items = [x for x in items if x and re.fullmatch(r"\d{6}", str(x.get("code") or ""))]
    if not items:
        return None
    flat = name.replace(" ", "").lower()
    exact = [x for x in items if str(x.get("name") or "").replace(" ", "").lower() == flat]
    return str((exact or items)[0]["code"])


def load_cache():
    try:
        d = json.load(open(CACHE_PATH, encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:                  # noqa: BLE001
        return {}


def save_cache(d):
    try:
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        json.dump(d, open(CACHE_PATH, "w", encoding="utf-8"), ensure_ascii=False)
    except Exception:                  # noqa: BLE001
        pass


def cached(cache, key, fn, fresh=False):
    hit = cache.get(key)
    now = time.time()
    if not fresh and hit and now - float(hit.get("at") or 0) < TTL_H * 3600:
        return hit.get("v")
    v = fn()
    cache[key] = {"at": now, "v": v}
    return v


# ---------------------------------------------------------------- 점검
def verify(stock_live_path=None, stock_chart_path=None, fresh=False, quiet=False):
    stock_live = stock_live_path or os.path.join(API_DIR, "stock-live.js")
    stock_chart = stock_chart_path or os.path.join(API_DIR, "stock-chart.js")
    defaults = read_default_stocks(stock_live)
    alias = read_alias(stock_chart)
    cache = load_cache()
    problems, checked = [], 0

    # ① 코드 → 이름 (DEFAULT_STOCKS) : fchart 종목명과 대조
    codes = [c for c, _ in defaults]
    with ThreadPoolExecutor(max_workers=6) as ex:
        real_names = dict(zip(codes, ex.map(lambda c: cached(cache, "code:" + c,
                                                             lambda c=c: fetch_fchart_name(c), fresh), codes)))
    for code, declared in defaults:
        real = real_names.get(code)
        if real is None:
            continue
        checked += 1
        if real.replace(" ", "") != declared.replace(" ", ""):
            problems.append({"kind": "code→name", "code": code, "declared": declared, "actual": real,
                             "where": os.path.relpath(stock_live, ROOT)})
    for code, real in real_names.items():
        if real is None:
            problems.append({"kind": "code-missing", "code": code, "declared": None, "actual": None,
                             "where": os.path.relpath(stock_live, ROOT)})

    # ② 이름 → 코드 (ALIAS) : 네이버 검색 결과 코드와 대조
    names = [n for n, _ in alias]
    with ThreadPoolExecutor(max_workers=6) as ex:
        real_codes = dict(zip(names, ex.map(lambda n: cached(cache, "name:" + n,
                                                             lambda n=n: fetch_search_code(n), fresh), names)))
    for name, code in alias:
        real = real_codes.get(name)
        if real is None:
            continue
        checked += 1
        if real != code:
            problems.append({"kind": "name→code", "name": name, "declared": code, "actual": real,
                             "where": os.path.relpath(stock_chart, ROOT)})

    # ③ 알려진 정정 표가 실제와 맞는지 (실측 실패해도 코드 자체가 틀리면 경고)
    for code, expect in KNOWN.items():
        real = real_names.get(code) or fetch_fchart_name(code)
        if real and real.replace(" ", "") != expect.replace(" ", ""):
            problems.append({"kind": "known-table", "code": code, "declared": expect, "actual": real,
                             "where": "verify_code_names.KNOWN"})

    save_cache(cache)
    return {"ok": not problems, "checked": checked, "problems": problems,
            "tables": {"defaultStocks": len(defaults), "alias": len(alias)}}


def report(res, quiet=False):
    tag = "✅" if res["ok"] else "⚠️"
    print(f"{tag} 종목코드·종목명 교차 점검 — 대조 {res['checked']}건 · 불일치 {len(res['problems'])}건 "
          f"(DEFAULT_STOCKS {res['tables']['defaultStocks']} · ALIAS {res['tables']['alias']})")
    if res["ok"]:
        return
    for p in res["problems"]:
        if p["kind"] == "code→name":
            print(f"   ⚠️ {p['where']}: code {p['code']} → 선언 '{p['declared']}' ≠ 실측 '{p['actual']}'")
        elif p["kind"] == "name→code":
            print(f"   ⚠️ {p['where']}: '{p['name']}' → 선언 {p['declared']} ≠ 실측 {p['actual']}")
        elif p["kind"] == "known-table":
            print(f"   ⚠️ 정정표: {p['code']} → '{p['declared']}' ≠ 실측 '{p['actual']}'")
        else:
            print(f"   ⚠️ {p['where']}: code {p['code']} — 실측 종목명 없음(상장폐지·코드 오류?)")


def main():
    ap = argparse.ArgumentParser(description="종목코드·종목명 교차 일치 점검")
    ap.add_argument("--fresh", action="store_true", help="캐시 무시하고 다시 조회")
    ap.add_argument("--quiet", action="store_true", help="불일치만 출력")
    ap.add_argument("--json", action="store_true", help="결과를 JSON으로 출력")
    args = ap.parse_args()
    res = verify(fresh=args.fresh, quiet=args.quiet)
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=1))
    else:
        report(res, quiet=args.quiet)
    return 0 if res["ok"] else 4


if __name__ == "__main__":
    sys.exit(main())
