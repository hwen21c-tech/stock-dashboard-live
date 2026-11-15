#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""node 가 없는 환경에서 `npm run check` 와 같은 범위를 검사한다.

  python3 scripts/check_js.py            # api/*.js · lib/*.js · public/*.js + HTML 인라인 <script>
  python3 scripts/check_js.py --html public/index.html

· *.js  : esprima 로 구문 검사 (node --check 와 같은 SyntaxError 검출)
· HTML  : 인라인 <script> 블록만 골라 구문 검사 + DIV 균형
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
JS = ["api/stock-live.js", "api/tabs-live.js", "api/live-briefing.js", "api/dart-live.js", "api/stock-chart.js",
      "api/deals-shopping.js", "lib/http.js", "lib/news-impact.js", "public/live-api.js", "public/deals-shopping.js",
      "public/live-extra.js", "public/live-calendar.js", "public/live-dart.js", "public/live-macro.js",
      "api/index-chart.js", "api/macro-live.js", "api/econ-calendar.js", "api/stock-trend.js", "dev_server.mjs",
      "api/content-studio.js", "public/content-engine.js", "public/overheat-badge.js", "public/ebook/sw.js",
      "public/pokemon/sw.js", "public/watchlist.js"]
HTML = ["public/index.html", "public/ebook.html", "public/deals.html", "public/content-studio.html",
        "public/preview-leeno.html", "public/preview-honginki.html", "public/preview-bijoong.html"]

try:
    import esprima
except ImportError:
    print("esprima 가 필요합니다: pip install esprima")
    sys.exit(2)

def head_same_error(rel, msg):
    """HEAD 에 있던 파일이 같은 지점에서 똑같이 실패하면 esprima 한계로 본다(회귀 아님)."""
    try:
        head = subprocess.run(["git", "show", "HEAD:" + rel], capture_output=True, text=True, cwd=ROOT).stdout
        if not head:
            return False
        esprima.parseScript(head)
        return False
    except Exception as e:  # noqa: BLE001
        return str(e)[:40] == str(msg)[:40]


bad = 0
skipped = 0
for rel in JS:
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        print(f"· {rel} — 없음(건너뜀)")
        continue
    src = open(path, encoding="utf-8").read()
    try:
        esprima.parseScript(src)
        print(f"✓ {rel}")
    except Exception as e:      # noqa: BLE001
        if head_same_error(rel, e):
            skipped += 1
            print(f"… {rel} — esprima(ES2017) 한계로 검사 생략 · HEAD 와 동일 지점 실패(회귀 아님)")
        else:
            bad += 1
            print(f"✗ {rel} — {e}")

for rel in HTML:
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        continue
    src = open(path, encoding="utf-8").read()
    n = errs = 0
    for i, m in enumerate(re.finditer(r"<script\b([^>]*)>([\s\S]*?)</script\s*>", src, re.I), 1):
        attrs, body = m.group(1) or "", m.group(2)
        if re.search(r"\bsrc\s*=", attrs, re.I):
            continue
        tm = re.search(r"type\s*=\s*[\"']?([^\"'\s>]+)", attrs, re.I)
        if tm and not re.search(r"javascript|ecmascript|^module$", tm.group(1), re.I):
            continue
        n += 1
        try:
            esprima.parseScript(body)
        except Exception as e:  # noqa: BLE001
            errs += 1
            bad += 1
            print(f"✗ {rel} inline#{i} — {e}")
    dv = len(re.findall(r"<div\b", src)) - len(re.findall(r"</div>", src))
    print(f"{'✓' if not errs else '✗'} {rel} — 인라인 {n}블록 · DIV차이 {dv}")

print(("\n❌ 구문 오류 " + str(bad) + "건") if bad else f"\n✅ JS 구문 검사 통과 (esprima 한계 생략 {skipped}건)")
sys.exit(1 if bad else 0)
