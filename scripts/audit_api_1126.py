#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""관제탑 API 12개 실측 점검 — 상태코드·JSON 유효성·응답시간·본문 요약

사용: python3 sd_live/scripts/audit_api_1126.py [base_url]
기본 base: https://stock-dashboard-live-bice.vercel.app
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://stock-dashboard-live-bice.vercel.app").rstrip("/")

CASES = [
    ("tabs-live", "/api/tabs-live", None),
    ("stock-live", "/api/stock-live?code=143240", None),
    ("stock-live(news)", "/api/stock-live?code=005930&news=1", None),
    ("stock-chart", "/api/stock-chart?code=005930", None),
    ("stock-trend", "/api/stock-trend?code=005930", None),
    ("live-briefing", "/api/live-briefing", None),
    ("live-briefing(ai)", "/api/live-briefing?ai=1", None),
    ("content-ai", "/api/content-ai?ping=1", None),
    ("dart-live", "/api/dart-live", None),
    ("picks-search", "/api/picks-search?q=%EC%83%81%ED%92%88", None),
    ("index-chart", "/api/index-chart?key=kospi", None),
    ("econ-calendar", "/api/econ-calendar", None),
    ("macro-live", "/api/macro-live", None),
    ("tts", "/api/tts?text=%ED%85%8C%EC%8A%A4%ED%8A%B8", None),
]


def probe(name, path):
    url = BASE + path
    t0 = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": "audit-1126", "Accept": "application/json,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            body = r.read()
            code = r.status
            ctype = r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        body = e.read()
        code = e.code
        ctype = e.headers.get("Content-Type", "")
    except Exception as e:  # noqa
        return {"name": name, "path": path, "code": 0, "ms": int((time.time() - t0) * 1000),
                "ok": False, "error": str(e)[:160]}
    ms = int((time.time() - t0) * 1000)
    info = {"name": name, "path": path, "code": code, "ms": ms, "bytes": len(body), "ctype": ctype}
    if "audio" in ctype or "mpeg" in ctype:
        info["json"] = True
        info["audio"] = True
        info["ok"] = code == 200 and len(body) > 1000
        return info
    try:
        j = json.loads(body.decode("utf-8", "replace"))
        info["json"] = True
        if isinstance(j, dict):
            info["keys"] = sorted(list(j.keys()))[:8]
            info["okFlag"] = j.get("ok", j.get("success"))
            for k in ("count", "total", "items", "data", "news", "candles", "bars", "events", "themes"):
                v = j.get(k)
                if isinstance(v, list):
                    info["len_" + k] = len(v)
    except Exception:
        info["json"] = False
        info["head"] = body[:120].decode("utf-8", "replace").replace("\n", " ")
    info["ok"] = code == 200 and info.get("json", False)
    return info


def main():
    rows = [probe(n, p) for n, p, _ in CASES]
    bad = [r for r in rows if not r["ok"]]
    print("%-18s %5s %6s %8s  %s" % ("endpoint", "HTTP", "ms", "bytes", "요약"))
    for r in rows:
        summ = ""
        if r.get("error"):
            summ = "ERROR " + r["error"]
        elif not r.get("json"):
            summ = "JSON 아님 → " + (r.get("head") or "")
        else:
            bits = []
            if "okFlag" in r:
                bits.append("ok=%s" % r["okFlag"])
            for k in sorted([k for k in r if k.startswith("len_")]):
                bits.append("%s:%d" % (k[4:], r[k]))
            if r.get("keys"):
                bits.append("keys=%s" % ",".join(r["keys"][:5]))
            summ = " ".join(bits)
        print("%-18s %5s %6s %8s  %s" % (r["name"], r["code"], r["ms"], r.get("bytes", 0), summ[:150]))
    print("\n합계: %d개 중 정상 %d / 이상 %d" % (len(rows), len(rows) - len(bad), len(bad)))
    for r in bad:
        print("  ⚠", r["name"], r["code"], r.get("error") or r.get("head", ""))
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
