#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""★ 관심종목 장중 타점 알리미 — 판정 엔진

  python3 scripts/check_watchlist_alerts.py              # 실서버 판정(장중에만 의미 있음)
  python3 scripts/check_watchlist_alerts.py --selftest   # 네트워크 없이 터치 판정 시뮬레이션(회귀 검사)
  python3 scripts/check_watchlist_alerts.py --json       # JSON 만 출력
  python3 scripts/check_watchlist_alerts.py --no-window  # 장 시간 판정 무시(검사·수동 실행용)

무엇을 하나
  1) Supabase family_sync 의 'stock_0623' 네임스페이스(= 관제탑 ★ 관심종목)를 읽는다.
     구조: { items: { key: {code,name,market,buy,stop,memo,at,del} }, at, clearedAt }
  2) ★ 종목마다 아래 기준선을 만든다.
     · 사용자가 적어 둔 '매수 희망가' / '손절가'
     · 비중법사 4분할선 (public/data/bijoong-latest.json 의 기준봉)
         - 당일(1일차) 고가 > 기준봉 종가 → 기준봉 종가 + (1일차 고가−종가)×k/4  (k=1..4)
         - 아직 1일차 고가가 기준봉 종가 이하 → 기준봉 몸통 p1~p3 = 종가 − (종가−시가)×k/4
         - 손절 기준선 = 기준봉 종가 (화면의 '4분할 손절선'과 같은 값)
     · 홍인기 전일 종가 (public/data/honginki-latest.json 의 기준봉 종가) 와 그 −3% 손절선
  3) 네이버 polling 실시간 시세(현재가·당일 고가·저가)로 '터치'를 판정한다.
     터치 = 당일 고가~저가 범위가 기준선을 지나갔거나, 현재가가 기준선 ±1.5% 안.
     (시세의 체결일이 오늘이 아니면 — 주말·장 시작 전 — 범위 판정은 쓰지 않고 '현재가 근접'만 본다)
  4) 한 종목에서 여러 선이 겹쳐 걸려도 **종목당 알림 1건**으로 묶는다.
     · 기준선 종류(매수희망가/손절가/비중법사 4분할/홍인기)마다 현재가에 가장 가까운 선 하나만,
       같은 가격의 선(기준봉 종가 = 홍인기 전일 종가 등)은 라벨만 합쳐 한 줄로.
  5) 같은 날·같은 종목·같은 기준선은 1회만 보고한다(scripts/.cache/watchlist-alerts-state.json).
     → 5분 주기로 계속 돌아도 채팅이 반복되지 않는다.

종료 코드
  0  정상(알림 0건 포함) · 2  selftest 실패 · 3  관심종목 읽기 실패(네트워크 등)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "public", "data")
STATE_DIR = os.path.join(HERE, ".cache")
STATE_FILE = os.path.join(STATE_DIR, "watchlist-alerts-state.json")

SUPABASE = {
    "url": "https://hiruybkapzuhjrzjoyik.supabase.co",
    "key": "sb_publishable_e5JJbvCPDhY91uXaUEVNVA_8Byv_gI8",
    "table": "family_sync",
    "code": "stock_0623",
}
NAVER_QUOTE = "https://polling.finance.naver.com/api/realtime/domestic/stock/{codes}"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

DEFAULT_TOL = 0.015          # ±1.5%
KST = dt.timezone(dt.timedelta(hours=9))


# ────────────────────────────── 공통 유틸 ──────────────────────────────
def kst_now() -> dt.datetime:
    return dt.datetime.now(KST)


def http_json(url: str, headers: dict | None = None, timeout: int = 12):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else None


def num(v):
    """'91,000원 이하' · '91000' · 91000.0 → 숫자. 못 읽으면 None."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v)
    s = s.replace(",", "")
    m = re.search(r"\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else None


def won(x) -> str:
    if x is None:
        return "—"
    return "{:,.0f}원".format(x)


# ─────────────────────────── 1) ★ 관심종목 (Supabase) ───────────────────────────
def fetch_watch_items(timeout: int = 12):
    """(items, error). items = [{code,name,market,buy,stop,memo}] (지운 항목 제외)"""
    q = "?code=eq.{}&select=code,data,updated_at".format(urllib.parse.quote(SUPABASE["code"]))
    url = SUPABASE["url"] + "/rest/v1/" + SUPABASE["table"] + q
    head = {"apikey": SUPABASE["key"], "Authorization": "Bearer " + SUPABASE["key"],
            "Content-Type": "application/json"}
    try:
        rows = http_json(url, head, timeout) or []
    except Exception as e:                                    # noqa: BLE001
        return None, "Supabase 읽기 실패: {}".format(e)
    if not rows:
        return [], None
    data = (rows[0] or {}).get("data") or {}
    raw = data.get("items") if isinstance(data, dict) else None
    if not isinstance(raw, dict):
        return [], None
    out = []
    for k, it in raw.items():
        if not isinstance(it, dict) or it.get("del"):
            continue
        code = str(it.get("code") or "").strip()
        name = str(it.get("name") or "").strip()
        if not code and not name:
            continue
        out.append({
            "key": k,
            "code": code if re.fullmatch(r"\d{6}", code) else "",
            "name": name,
            "market": str(it.get("market") or ""),
            "buy": num(it.get("buy")),
            "buy_raw": str(it.get("buy") or ""),
            "stop": num(it.get("stop")),
            "stop_raw": str(it.get("stop") or ""),
            "memo": str(it.get("memo") or "").strip(),
        })
    out.sort(key=lambda x: (x["code"], x["name"]))
    return out, None


# ─────────────────────────── 2) 실시간 시세 (네이버) ───────────────────────────
def fetch_quotes(codes, timeout: int = 12):
    """{code: {price, open, high, low, prevClose, name}} — 실패한 코드는 빠진다."""
    codes = [c for c in dict.fromkeys(codes) if c]
    if not codes:
        return {}, None
    url = NAVER_QUOTE.format(codes=",".join(codes))
    try:
        data = http_json(url, {"User-Agent": UA, "Accept": "application/json"}, timeout) or {}
    except Exception as e:                                    # noqa: BLE001
        return {}, "네이버 시세 실패: {}".format(e)
    quotes = {}
    for d in data.get("datas") or []:
        code = str(d.get("itemCode") or "")
        if not re.fullmatch(r"\d{6}", code):
            continue
        price = num(d.get("closePriceRaw") if d.get("closePriceRaw") is not None else d.get("closePrice"))
        o = num(d.get("openPriceRaw") if d.get("openPriceRaw") is not None else d.get("openPrice"))
        h = num(d.get("highPriceRaw") if d.get("highPriceRaw") is not None else d.get("highPrice"))
        lo = num(d.get("lowPriceRaw") if d.get("lowPriceRaw") is not None else d.get("lowPrice"))
        chg = num(d.get("compareToPreviousClosePriceRaw")
                  if d.get("compareToPreviousClosePriceRaw") is not None
                  else d.get("compareToPreviousClosePrice"))
        sign = ((d.get("compareToPreviousPrice") or {}).get("name") or "")
        if sign == "FALLING" and chg is not None:
            chg = -abs(chg)
        quotes[code] = {
            "code": code,
            "name": str(d.get("stockName") or ""),
            "price": price,
            "open": o, "high": h, "low": lo,
            "change": chg,
            "prevClose": (price - chg) if (price is not None and chg is not None) else None,
            "tradedAt": str(d.get("localTradedAt") or ""),
        }
    return quotes, None


# ─────────────────────────── 3) 전략 기준선 (비중법사 · 홍인기) ───────────────────────────
def load_json(path: str):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:                                         # noqa: BLE001
        return None


def load_strategies(data_dir: str = DATA):
    """(bijoong_by_code, honginki_by_code, basis_label)"""
    bj = {}
    hk = {}
    labels = {}
    j = load_json(os.path.join(data_dir, "bijoong-latest.json"))
    if isinstance(j, dict):
        labels["bijoong"] = (j.get("basisDate") or "", j.get("basisLabel") or "")
        for c in j.get("cards") or []:
            code = str(c.get("code") or "")
            if re.fullmatch(r"\d{6}", code):
                bj[code] = c
    j = load_json(os.path.join(data_dir, "honginki-latest.json"))
    if isinstance(j, dict):
        labels["honginki"] = (j.get("basisDate") or "", j.get("basisLabel") or "")
        for c in j.get("cards") or []:
            code = str(c.get("code") or "")
            if re.fullmatch(r"\d{6}", code):
                hk[code] = c
    return bj, hk, labels


def bijoong_lines(card, quote, date_ok=True):
    """비중법사 기준봉 → 4분할선·손절선. index.html 의 splitOf() 와 같은 셈법."""
    bc = num(card.get("c"))
    if bc is None:
        return []
    o = num(card.get("o"))
    d1_high = num((quote or {}).get("high")) if date_ok else None
    out = []
    hi = max(d1_high or 0, bc)
    if d1_high is not None and hi > bc:
        span = hi - bc
        for k in range(1, 5):
            out.append({
                "basis": "비중법사 4분할 {}/4".format(k) + ("(하단 1/4 = 매수존)" if k == 1 else ""),
                "kind": "bijoong-q{}".format(k),
                "family": "bijoong",
                "price": bc + span * k / 4.0,
            })
    elif o is not None:
        body = bc - o
        for k in range(1, 4):
            out.append({
                "basis": "비중법사 몸통 p{}".format(k),
                "kind": "bijoong-p{}".format(k),
                "family": "bijoong",
                "price": bc - body * k / 4.0,
            })
    out.append({"basis": "비중법사 기준봉 종가(손절선)", "kind": "bijoong-stop",
                "family": "bijoong-stop", "price": bc})
    return out


def honginki_lines(card):
    """홍인기 기준봉(전일) 종가 + 종가 −3% 손절선."""
    close = num(card.get("close"))
    if close is None:
        return []
    return [
        {"basis": "홍인기 전일 종가", "kind": "honginki-close", "family": "honginki", "price": close},
        {"basis": "홍인기 전일 종가 −3%(손절선)", "kind": "honginki-stop", "family": "honginki-stop",
         "price": close * 0.97},
    ]


def build_lines(item, quote, bj, hk, strategies_ok=True, date_ok=True):
    lines = []
    if item.get("buy"):
        lines.append({"basis": "내가 적은 매수 희망가", "kind": "user-buy", "family": "user-buy",
                      "price": float(item["buy"]), "note": item.get("buy_raw")})
    if item.get("stop"):
        lines.append({"basis": "내가 적은 손절가", "kind": "user-stop", "family": "user-stop",
                      "price": float(item["stop"]), "note": item.get("stop_raw")})
    card = bj.get(item.get("code") or "")
    if card:
        lines.extend(bijoong_lines(card, quote, date_ok))
    card = hk.get(item.get("code") or "")
    if card:
        lines.extend(honginki_lines(card))
    seen = set()
    out = []
    for ln in lines:
        p = ln.get("price")
        if not p or p <= 0:
            continue
        k = (ln["kind"], round(p, 2))
        if k in seen:
            continue
        seen.add(k)
        out.append(ln)
    return out


# ─────────────────────────── 4) 터치 판정 ───────────────────────────
def judge(item, quote, lines, tol=DEFAULT_TOL, date_ok=True):
    """터치한 기준선 목록. 당일 고·저가 기준선을 지나갔으면 '지나감', 현재가가 tol 안이면 '근접'."""
    if not quote or quote.get("price") is None:
        return []
    price = float(quote["price"])
    hi = num(quote.get("high")) if date_ok else None
    lo = num(quote.get("low")) if date_ok else None
    hits = []
    for ln in lines:
        p = float(ln["price"])
        if p <= 0:
            continue
        dist = (price - p) / p
        crossed = (hi is not None and lo is not None and lo <= p <= hi)
        near = abs(dist) <= tol
        if not (crossed or near):
            continue
        hit = dict(ln)
        hit.update({
            "code": item.get("code") or "",
            "name": item.get("name") or quote.get("name") or "",
            "price_now": price,
            "dist_pct": round(dist * 100, 2),
            "crossed": bool(crossed),
            "near": bool(near),
            "touch": "지나감" if crossed else "근접",
            "memo": item.get("memo") or "",
        })
        hits.append(hit)
    hits.sort(key=lambda h: abs(h["dist_pct"]))
    return hits


# ─────────────────────────── 5) 중복 알림 방지 ───────────────────────────
def load_state(path=STATE_FILE):
    j = load_json(path)
    return j if isinstance(j, dict) else {}


def save_state(state, path=STATE_FILE, today=None):
    """오늘 + 최근 3일치만 남긴다(자정을 넘겨도 그날 알림 기록이 살아 있게)."""
    keep = {}
    today = today or kst_now().strftime("%Y-%m-%d")
    days = [today]
    d = dt.datetime.strptime(today, "%Y-%m-%d")
    for i in range(1, 4):
        days.append((d - dt.timedelta(days=i)).strftime("%Y-%m-%d"))
    for k, v in state.items():
        if k in days or k.startswith("_"):
            keep[k] = v
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(keep, f, ensure_ascii=False, indent=0)
    os.replace(tmp, path)


def bump_fails(state_path, was_ok):
    """연속 실패 횟수 — 3회째에만 사용자에게 한 번 알리기 위한 카운터."""
    st = load_state(state_path)
    n = 0 if was_ok else int(st.get("_fails") or 0) + 1
    st["_fails"] = n
    save_state(st, state_path)
    return n


def alert_key(hit, today):
    return "{}|{}|{}|{:.0f}".format(today, hit["code"] or hit["name"], hit["kind"], hit["price"])


# ─────────────────────────── 6) 실행 ───────────────────────────
def in_market_window(now: dt.datetime):
    if now.weekday() >= 5:
        return False, "주말 휴장"
    hm = now.strftime("%H:%M")
    if hm < "08:00":
        return False, "장 시작 전(08:00 이전)"
    if hm > "20:05":
        return False, "장 종료(20:05 이후)"
    return True, "장중"


def quote_date_ok(quote, now: dt.datetime) -> bool:
    """시세의 체결일이 오늘(KST)인가 — 주말·장 시작 전에는 어제 봉이라 범위 판정을 쓰지 않는다."""
    t = str((quote or {}).get("tradedAt") or "")
    m = re.match(r"(\d{4}-\d{2}-\d{2})", t)
    if m:
        return m.group(1) == now.strftime("%Y-%m-%d")
    return True          # 체결시각이 없으면 굳이 막지 않는다(현재가 근접 판정은 그대로)


def collapse(hits):
    """한 종목의 터치들을 '기준선 종류별 가장 가까운 하나'로 줄이고, 같은 가격은 라벨을 합친다."""
    by_fam = {}
    for h in hits:                                  # hits 는 |거리| 오름차순
        by_fam.setdefault(h.get("family") or h["kind"], h)
    kept = sorted(by_fam.values(), key=lambda x: abs(x["dist_pct"]))[:3]
    merged = []
    for h in kept:
        twin = None
        for x in merged:
            if h["price"] and abs(x["price"] - h["price"]) / h["price"] <= 0.0005:
                twin = x
                break
        if twin is None:
            merged.append({
                "basis": h["basis"], "kind": h["kind"], "price": h["price"],
                "dist_pct": h["dist_pct"], "touch": h["touch"],
                "crossed": h["crossed"], "near": h["near"],
                "kinds": [h["kind"]],
            })
        else:
            if h["basis"] not in twin["basis"].split(" = "):
                twin["basis"] = twin["basis"] + " = " + h["basis"]
            twin["kinds"].append(h["kind"])
    return merged


def run(tol=DEFAULT_TOL, data_dir=DATA, state_path=STATE_FILE, save=True,
        items_override=None, quotes_override=None, now=None):
    now = now or kst_now()
    today = now.strftime("%Y-%m-%d")
    if items_override is not None:
        items = items_override
    else:
        items, items_err = fetch_watch_items()
        if items is None:
            return {"ok": False, "error": items_err, "touches": [], "skipped": [],
                    "items": 0, "today": today}

    bj, hk, labels = load_strategies(data_dir)

    if not items:
        return {"ok": True, "items": 0, "touches": [], "already": [], "skipped": [],
                "quotes": 0, "today": today, "labels": labels,
                "note": "★ 관심종목 0건 — 알릴 타점 없음"}

    if quotes_override is not None:
        quotes, qerr = quotes_override, None
    else:
        quotes, qerr = fetch_quotes([i["code"] for i in items if i["code"]])

    state = load_state(state_path)
    done = set(state.get(today) or [])
    touches, already, skipped = [], [], []

    for it in items:
        if not it.get("code"):
            skipped.append({"name": it.get("name"), "why": "종목코드 없음(이름만 담김)"})
            continue
        q = quotes.get(it["code"])
        if not q or q.get("price") is None:
            skipped.append({"name": it.get("name"), "code": it["code"], "why": "시세 없음/거래정지"})
            continue
        date_ok = quote_date_ok(q, now)
        lines = build_lines(it, q, bj, hk, date_ok=date_ok)
        if not lines:
            skipped.append({"name": it.get("name"), "code": it["code"],
                            "why": "기준선 없음(매수·손절가 미입력 · 비중법사/홍인기 카드 아님)"})
            continue
        hits = judge(it, q, lines, tol, date_ok=date_ok)
        if not hits:
            continue
        merged = collapse(hits)
        fresh = []
        for m in merged:
            keys = ["{}|{}|{}|{:.0f}".format(today, it["code"] or it.get("name"), k, m["price"])
                    for k in m["kinds"]]
            m["keys"] = keys
            if all(k in done for k in keys):
                already.extend(keys)
                continue
            done.update(keys)
            fresh.append(m)
        if not fresh:
            continue
        touches.append({
            "code": it["code"],
            "name": it.get("name") or q.get("name") or "",
            "price_now": q["price"],
            "change": q.get("change"),
            "dateOk": date_ok,
            "memo": it.get("memo") or "",
            "lines": fresh,
        })

    if save:
        state[today] = sorted(done)
        save_state(state, state_path, today)

    return {
        "ok": True,
        "today": today,
        "at": now.strftime("%Y-%m-%d %H:%M:%S"),
        "window": in_market_window(now)[1],
        "items": len(items),
        "quotes": len(quotes),
        "touches": touches,
        "already": already,
        "skipped": skipped,
        "labels": labels,
        "quoteError": qerr,
    }


def fmt_text(res):
    if not res.get("ok"):
        return "⚠️ ★ 타점 알리미 점검 실패 — " + str(res.get("error"))
    if not res.get("items"):
        return "★ 관심종목 0건 — 알릴 타점 없음 ({})".format(res.get("today"))
    out = []
    t = res.get("touches") or []
    if not t:
        out.append("★ 타점 알림 없음 — 관심종목 {}종목 감시 중 ({})".format(res["items"], res.get("at")))
    else:
        out.append("★ 타점 터치 {}종목 ({})".format(len(t), res.get("at")))
        for h in t:
            head = "· {name}({code}) {now}".format(
                name=h.get("name") or "", code=h.get("code") or "", now=won(h.get("price_now")))
            if h.get("change") is not None:
                head += " ({:+,.0f})".format(h["change"]) if h["change"] else " (보합)"
            if not h.get("dateOk", True):
                head += " *직전 체결가 기준"
            out.append(head)
            for ln in h["lines"]:
                out.append("   - {} {} · {}{:+.2f}%".format(
                    ln["basis"], won(ln["price"]),
                    "당일 고저 통과 " if ln["crossed"] else "현재가 근접 ", ln["dist_pct"]))
            if h.get("memo"):
                out.append("   메모: " + h["memo"].replace("\n", " "))
    if res.get("already"):
        out.append("(같은 날 이미 알린 기준선 {}건은 생략)".format(len(res["already"])))
    if res.get("skipped"):
        names = ", ".join((s.get("name") or s.get("code") or "?") for s in res["skipped"][:6])
        out.append("감시 제외: " + names + (" 외" if len(res["skipped"]) > 6 else ""))
    if res.get("quoteError"):
        out.append("⚠️ " + res["quoteError"])
    return "\n".join(out)


# ─────────────────────────── 7) selftest (네트워크 없이) ───────────────────────────
def selftest():
    """터치 판정 시뮬레이션 — 기대값과 다르면 종료 2."""
    fails, checks = [], [0]

    def check(name, got, want):
        checks[0] += 1
        if got != want:
            fails.append("{}: 기대 {} · 실제 {}".format(name, want, got))

    L = lambda basis, kind, fam, price: {"basis": basis, "kind": kind, "family": fam, "price": price}

    # ① 매수 희망가 터치 (현재가가 ±1.5% 안 · 당일 저가가 선을 지나감)
    item = {"code": "005930", "name": "삼성전자", "buy": 91000.0, "buy_raw": "91,000",
            "stop": 0, "stop_raw": "", "memo": "120일 전고점 돌파 · 눌림 대기"}
    quote = {"code": "005930", "name": "삼성전자", "price": 91500.0, "open": 92000.0,
             "high": 92900.0, "low": 90800.0, "prevClose": 91000.0,
             "tradedAt": "2026-11-16T10:03:00+09:00"}
    now_mon = dt.datetime(2026, 11, 16, 10, 5, tzinfo=KST)
    hits = judge(item, quote, [L("내가 적은 매수 희망가", "user-buy", "user-buy", 91000.0)],
                 date_ok=True)
    check("매수희망가 터치", len(hits), 1)
    check("매수희망가 터치 종류", hits[0]["touch"], "지나감")

    # ② 멀리 있으면 알림 없음
    quote_far = dict(quote, price=95000.0, high=95600.0, low=94700.0)
    check("멀면 알림 없음",
          len(judge(item, quote_far, [L("내가 적은 매수 희망가", "user-buy", "user-buy", 91000.0)])), 0)

    # ③ 비중법사 4분할 — 1일차 고가가 기준봉 종가보다 높으면 4등분선
    card = {"code": "425420", "name": "티에프이", "o": 88000.0, "h": 92700.0, "l": 87400.0, "c": 91900.0}
    q2 = {"code": "425420", "name": "티에프이", "price": 92000.0, "open": 92600.0,
          "high": 92600.0, "low": 91000.0}
    q_lines = {ln["basis"]: round(ln["price"]) for ln in bijoong_lines(card, q2, date_ok=True)}
    check("4분할 4/4", q_lines.get("비중법사 4분할 4/4"), 92600)          # 91900 + (92600-91900)
    check("4분할 1/4", q_lines.get("비중법사 4분할 1/4(하단 1/4 = 매수존)"), 92075)
    check("기준봉 종가 손절선", q_lines.get("비중법사 기준봉 종가(손절선)"), 91900)

    # ④ 1일차 고가가 기준봉 종가 이하이면 몸통 p1~p3
    q3 = {"code": "261780", "name": "아리바이오랩", "price": 4700.0, "open": 4800.0,
          "high": 4830.0, "low": 4650.0}
    card3 = {"code": "261780", "o": 4405.0, "h": 5260.0, "l": 4225.0, "c": 4850.0}
    p_lines = {ln["basis"]: round(ln["price"], 1) for ln in bijoong_lines(card3, q3, date_ok=True)}
    check("몸통 p1", p_lines.get("비중법사 몸통 p1"), round(4850 - (4850 - 4405) / 4, 1))
    check("몸통 p3", p_lines.get("비중법사 몸통 p3"), round(4850 - (4850 - 4405) * 3 / 4, 1))

    # ⑤ 홍인기 전일 종가 + −3% 손절선
    hk_map = {ln["basis"]: round(ln["price"]) for ln in honginki_lines({"code": "425420", "close": 91900.0})}
    check("홍인기 전일 종가", hk_map.get("홍인기 전일 종가"), 91900)
    check("홍인기 −3%", hk_map.get("홍인기 전일 종가 −3%(손절선)"), round(91900 * 0.97))

    # ⑥ 숫자 파싱 — 사용자가 '91,000원 이하'처럼 적어도 읽는다
    check("숫자 파싱", num("91,000원 이하"), 91000.0)
    check("숫자 파싱(빈값)", num(""), None)

    # ⑦ 한 종목에 여러 선이 겹칠 때 — 종목당 1건, 라벨만 합쳐진다
    hits_multi = judge(item, quote, [
        L("내가 적은 매수 희망가", "user-buy", "user-buy", 91000.0),
        L("비중법사 기준봉 종가(손절선)", "bijoong-stop", "bijoong-stop", 91000.0),
        L("비중법사 4분할 1/4", "bijoong-q1", "bijoong", 91500.0),
        L("비중법사 4분할 4/4", "bijoong-q4", "bijoong", 91800.0),
        L("홍인기 전일 종가 −3%(손절선)", "honginki-stop", "honginki-stop", 88500.0),
    ], tol=0.02, date_ok=True)
    merged = collapse(hits_multi)
    check("겹친 선 접기(같은 가격 병합 + 4분할은 가장 가까운 하나)", len(merged), 2)
    check("같은 가격 라벨 병합",
          [m["basis"] for m in merged if round(m["price"]) == 91000][0],
          "내가 적은 매수 희망가 = 비중법사 기준봉 종가(손절선)")

    # ⑧ 통합 시뮬레이션 — 같은 날 두 번 돌려도 두 번째는 중복으로 비켜 간다
    import tempfile
    tmpdir = tempfile.mkdtemp()
    st = os.path.join(tmpdir, "state.json")
    items = [item]
    quotes = {"005930": quote}
    r1 = run(items_override=items, quotes_override=quotes, state_path=st, now=now_mon)
    check("통합 1회차 알림", len(r1["touches"]), 1)
    r2 = run(items_override=items, quotes_override=quotes, state_path=st, now=now_mon)
    check("통합 2회차 중복 차단", (len(r2["touches"]), bool(r2["already"])), (0, True))
    now_tue = dt.datetime(2026, 11, 17, 10, 5, tzinfo=KST)          # 다음 날은 다시 알린다
    r3 = run(items_override=items, quotes_override=quotes, state_path=st, now=now_tue)
    check("다음 날 재알림", len(r3["touches"]), 1)

    # ⑩ Supabase 관심종목 파싱 — 지운 항목·이름만 담은 항목·'91,000원' 표기 처리
    original = globals()["http_json"]
    try:
        def fake(url, headers=None, timeout=12):
            return [{"code": "stock_0623", "data": {"items": {
                "005930": {"code": "005930", "name": "삼성전자", "buy": "91,000원 이하", "stop": "88,000",
                           "memo": "눌림", "at": 1, "del": False},
                "n:티에프이": {"code": "", "name": "티에프이", "buy": "", "stop": "", "at": 2},
                "261780": {"code": "261780", "name": "아리바이오랩", "at": 3, "del": True},
            }}}]
        globals()["http_json"] = fake
        parsed, err = fetch_watch_items()
    finally:
        globals()["http_json"] = original
    check("Supabase 파싱 오류 없음", err, None)
    check("Supabase 파싱 건수(지운 ★ 제외)", len(parsed), 2)
    byname = {x["name"]: x for x in parsed}
    check("매수희망가 문자열 파싱", (byname["삼성전자"]["buy"], byname["삼성전자"]["stop"]),
          (91000.0, 88000.0))
    check("이름만 담은 항목", (byname["티에프이"]["code"], byname["티에프이"]["name"]), ("", "티에프이"))

    # ⑨ 장외(주말·장 시작 전) — 시세 체결일이 오늘이 아니면 당일 고저 범위로는 판정하지 않는다
    #    같은 시세·같은 가격이라도 '오늘 체결'이면 터치, '직전 체결'이면 터치 아님 (현재가는 ±0.5% 밖)
    tight = dict(quote, price=92000.0, high=92900.0, low=90800.0)
    fresh = dict(tight, tradedAt="2026-11-16T10:03:00+09:00")
    stale = dict(tight, tradedAt="2026-11-13T20:00:00+09:00")
    check("체결일 불일치 → 범위 판정 제외", quote_date_ok(stale, now_mon), False)
    st2 = os.path.join(tmpdir, "state2.json")
    r4 = run(items_override=[item], quotes_override={"005930": stale}, state_path=st2,
             now=now_mon, tol=0.005)
    r5 = run(items_override=[item], quotes_override={"005930": fresh}, state_path=st2,
             now=now_mon, tol=0.005)
    check("직전 체결가 → 알림 없음", len(r4["touches"]), 0)
    check("오늘 체결가 → 알림 있음", len(r5["touches"]), 1)

    if fails:
        print("✗ selftest 실패")
        for f in fails:
            print("  -", f)
        return 2
    print("✓ selftest 통과 ({}개 판정) — 매수희망가 · 4분할(1일차/몸통) · 홍인기 · 겹친 선 접기 · "
          "중복 차단 · 장외 가드 · Supabase 파싱 · 숫자 파싱".format(checks[0]))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="★ 관심종목 장중 타점 알리미")
    ap.add_argument("--json", action="store_true", help="JSON 만 출력")
    ap.add_argument("--selftest", action="store_true", help="네트워크 없이 판정 시뮬레이션")
    ap.add_argument("--no-window", action="store_true", help="장 시간 판정을 무시하고 실행")
    ap.add_argument("--dry-run", action="store_true", help="중복 알림 상태를 저장하지 않는다")
    ap.add_argument("--tol", type=float, default=DEFAULT_TOL, help="터치 허용 폭(기본 0.015 = ±1.5%%)")
    ap.add_argument("--data-dir", default=DATA)
    ap.add_argument("--state", default=STATE_FILE)
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    now = kst_now()
    if not args.no_window:
        inside, why = in_market_window(now)
        if not inside:
            res = {"ok": True, "skippedWindow": why, "today": now.strftime("%Y-%m-%d"),
                   "touches": [], "already": [], "items": 0}
            print(json.dumps(res, ensure_ascii=False) if args.json
                  else "★ 타점 알리미 — {} (판정 생략)".format(why))
            return 0

    res = run(tol=args.tol, data_dir=args.data_dir, state_path=args.state, save=not args.dry_run, now=now)
    fails = 0 if res.get("ok") else bump_fails(args.state, False)
    if res.get("ok"):
        bump_fails(args.state, True)
    elif fails >= 3 and fails % 3 == 0:
        res["repeatedFailure"] = fails
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=1))
    else:
        print(fmt_text(res))
    if not res.get("ok"):
        if res.get("repeatedFailure"):
            print("⚠️ ★ 타점 알리미가 {}회 연속 실패했습니다 — {}".format(
                res["repeatedFailure"], res.get("error")))
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
