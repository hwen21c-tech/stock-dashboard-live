#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""정적 미러(deploy_repo/index.html · GitHub Pages) 검증 — RN존 21선 · 만쥬 시장분위기/상세팝업

  python3 scripts/verify_static_tabs_1116b.py
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

CHROME = "/workspace/.cache/puppeteer/chrome-headless-shell/linux-131.0.6778.204/chrome-headless-shell-linux64/chrome-headless-shell"
DEPLOY = "/workspace/deploy_repo"
PORT = int(os.environ.get("VERIFY_PORT", "8837"))
BASE = f"http://127.0.0.1:{PORT}/index.html"
OUT = os.path.join(DEPLOY, "screenshots", "tabs_1116b")

fails, oks = [], []


def check(cond, label, detail=""):
    (oks if cond else fails).append(label)
    print(("OK   " if cond else "FAIL ") + label + ((" — " + str(detail)) if detail else ""))


def main():
    os.makedirs(OUT, exist_ok=True)
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
                           cwd=DEPLOY, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
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
            for w, h, tag in ((400, 860, "400"), (884, 960, "884")):
                ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
                page = ctx.new_page()
                page.on("console", lambda m: logs.append(tag + " console." + m.type + ": " + m.text[:160]) if m.type == "error" else None)
                page.on("pageerror", lambda e: logs.append(tag + " pageerror: " + str(e)[:160]))
                page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(6000)
                page.evaluate("() => { document.querySelectorAll('#pinLockOverlay,[id^=pinLockOverlay]').forEach(e=>e.remove()); }")

                page.evaluate("() => switchView('rnzone', null)")
                page.wait_for_timeout(1200)
                cards = page.eval_on_selector_all("#stockListGrid .stock-card", "els => els.length")
                sample = page.evaluate("""() => { const c=document.querySelector('#stockListGrid .stock-card[data-code="009150"]');
                    return c ? c.innerText.replace(/\\n/g,' | ') : null; }""")
                try:
                    page.eval_on_selector("#stockListGrid", "el => el.scrollIntoView({block:'start'})")
                except Exception:
                    pass
                page.wait_for_timeout(400)
                page.screenshot(path=os.path.join(OUT, f"static_rn_{tag}.png"))
                if tag == "400":
                    check(cards == 12, "[정적] RN 카드 12종목", cards)
                    check(bool(sample) and "750,000" in sample and "1,000,000" in sample,
                          "[정적] 삼성전기 750,000/1,000,000 공식 RN선", (sample or "")[:140])

                page.evaluate("() => switchView('manju', null)")
                page.wait_for_timeout(800)
                has_mood = page.evaluate("() => document.body.innerText.indexOf('지수 종가베팅 점수') !== -1")
                n_data = page.evaluate("() => Object.keys((window.MANJU_DATA||{}).stocks||{}).length")
                page.screenshot(path=os.path.join(OUT, f"static_manju_{tag}.png"))
                if tag == "400":
                    check(has_mood, "[정적] 만쥬 시장분위기 점수 카드")
                    check(n_data >= 5, "[정적] MANJU_DATA 내장", n_data)
                clicked = page.evaluate("""() => { const c=document.querySelector('#tabManju .mj-screener-card[data-manju-code]');
                    if(!c) return null; c.click(); return c.getAttribute('data-manju-code'); }""")
                page.wait_for_timeout(900)
                shown = page.evaluate("() => { const m=document.getElementById('manjuDetailModal'); return m? getComputedStyle(m).display : 'none'; }")
                txt = page.evaluate("() => { const b=document.getElementById('mjdBody'); return b? b.innerText.replace(/\\n+/g,' | ') : ''; }")
                page.screenshot(path=os.path.join(OUT, f"static_manju_modal_{tag}.png"))
                if tag == "400":
                    check(shown == "block", "[정적] 만쥬 상세 팝업 열림", clicked)
                    check("오늘 상승 이유" in txt and "20일" in txt, "[정적] 팝업 5항목", txt[:60])
                ctx.close()
            b.close()
    finally:
        srv.terminate()

    errs = [l for l in logs if "console.error" in l or "pageerror" in l]
    check(len(errs) == 0, "[정적] 콘솔 오류 0", errs[:3])
    print("\n--- 정적 결과:", len(oks), "통과 /", len(fails), "실패")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
