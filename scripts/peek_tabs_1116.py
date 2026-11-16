#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""빠른 화면 점검 — 특정 탭만 골라 상태·스크린샷을 확인한다 (개발 반복용)."""
import json
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

NODE = "/workspace/.local/nodejs/node-v20.18.0-linux-x64/bin/node"
CHROME = "/workspace/.cache/puppeteer/chrome-headless-shell/linux-131.0.6778.204/chrome-headless-shell-linux64/chrome-headless-shell"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("PEEK_PORT", "8821"))
BASE = f"http://127.0.0.1:{PORT}/"
OUT = os.path.join(ROOT, "screenshots", "peek_1116")
VIEWS = (sys.argv[1] if len(sys.argv) > 1 else "overview,bijoong,supply,aftermarket,news,calendar").split(",")
W = int(os.environ.get("PEEK_W", "400"))
H = int(os.environ.get("PEEK_H", "860"))
WAIT = int(os.environ.get("PEEK_WAIT", "9000"))

srv = subprocess.Popen([NODE, "dev_server.mjs"], cwd=ROOT, env={**os.environ, "PORT": str(PORT)},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
os.makedirs(OUT, exist_ok=True)
for _ in range(80):
    time.sleep(0.3)
    try:
        urllib.request.urlopen(BASE, timeout=1)
        break
    except Exception:
        continue

logs = []
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=CHROME, args=["--no-sandbox", "--disable-dev-shm-usage"])
        ctx = b.new_context(viewport={"width": W, "height": H}, device_scale_factor=1)
        page = ctx.new_page()
        page.on("console", lambda m: logs.append(m.type + ": " + m.text[:300]) if m.type == "error" else None)
        page.on("pageerror", lambda e: logs.append("pageerror: " + str(e)[:300]))
        page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(WAIT)
        page.evaluate("""() => {
          document.querySelectorAll('#pinLockOverlay,[id^=pinLockOverlay]').forEach(e=>e.remove());
          document.documentElement.classList.remove('pin-locked');
        }""")
        for v in VIEWS:
            page.evaluate("(v)=>{ if(typeof switchView==='function') switchView(v,null); }", v)
            page.wait_for_timeout(1200)
            page.screenshot(path=os.path.join(OUT, f"{W}x{H}_{v}.png"))
            info = page.evaluate("""(v) => {
              const tab = document.getElementById('tab' + v.charAt(0).toUpperCase() + v.slice(1));
              const de = document.documentElement;
              const out = {view: v, overflow: de.scrollWidth > de.clientWidth + 1, docW: de.scrollWidth, cliW: de.clientWidth};
              if (!tab) { out.missing = true; return out; }
              out.text = (tab.innerText || '').replace(/\\s+/g, ' ').slice(0, 700);
              return out;
            }""", v)
            print(json.dumps(info, ensure_ascii=False)[:1200])
        # 상세 상태
        extra = page.evaluate("""() => {
          const q = (s) => document.querySelector(s);
          const chips = Array.from(document.querySelectorAll('#strategyChipsScroll .signal-chip')).map(e=>e.innerText.replace(/\\s+/g,' '));
          const folds = Array.from(document.querySelectorAll('[data-sl-fold]')).map(e=>({k:e.dataset.slFold, t:e.innerText.trim(), open:(document.querySelector('[data-sl-fold-body="'+e.dataset.slFold+'"]')||{}).style?.display}));
          const sched = q('#schedNowHost') ? q('#schedNowHost').innerText.replace(/\\s+/g,' ').slice(0,600) : null;
          const wz = q('#wzContent') ? q('#wzContent').innerText.replace(/\\s+/g,' ').slice(0,500) : null;
          const supp = Array.from(document.querySelectorAll('#tabSupply .supply-stock-card')).slice(0,3).map(c=>{
            const x = c.querySelector('[data-supply-extra="1"]');
            return {name:(c.querySelector('.ssc-name')||{}).textContent, extra: x ? x.innerText.replace(/\\s+/g,' ') : null};
          });
          const after = q('#tabsLiveAfterTop') ? q('#tabsLiveAfterTop').innerText.replace(/\\s+/g,' ').slice(0,900) : null;
          const newsChips = Array.from(document.querySelectorAll('#tabsLiveNewsTab .nt-title')).slice(0,2).map(e=>e.innerText.slice(0,60));
          const newsStock = Array.from(document.querySelectorAll('#tabsLiveNewsTab [onclick*="tabsLiveOpenStock"]')).slice(0,6).map(e=>e.innerText.replace(/\\s+/g,' '));
          return {chips, folds, sched, wz, supp, after, newsChips, newsStock,
                  afterFilter: (document.querySelector('[data-af-filter]')||{}).dataset?.afFilter || null};
        }""")
        print("EXTRA " + json.dumps(extra, ensure_ascii=False)[:4000])
        b.close()
finally:
    srv.terminate()
print("LOGS " + json.dumps(logs[:10], ensure_ascii=False))
