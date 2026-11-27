#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""🧭 수급 이동 고도화 — 라이브(Vercel 6frm · GitHub Pages) 검증.

  python3 sd_live/scripts/verify_flow_live_1117.py [url ...]
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

CHROME = "/workspace/.cache/puppeteer/chrome-headless-shell/linux-131.0.6778.204/chrome-headless-shell-linux64/chrome-headless-shell"
OUT = "/workspace/screenshots/flow_1117"
URLS = sys.argv[1:] or ["https://stock-dashboard-live-bice.vercel.app/",
                        "https://hwen21c-tech.github.io/stock-dashboard/"]

fails, oks = [], []


def check(cond, label, detail=""):
    (oks if cond else fails).append(label)
    print(("O " if cond else "X ") + label + ((" - " + str(detail)) if detail else ""))


def tag(url):
    return 'vercel' if 'vercel' in url else 'pages'


def main():
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=CHROME, args=["--no-sandbox", "--disable-dev-shm-usage"])
        for url in URLS:
            for w, h in ((400, 860), (884, 960), (1100, 800)):
                logs = []
                ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
                page = ctx.new_page()
                page.on("console", lambda m: logs.append("console." + m.type + ": " + m.text[:200]) if m.type == "error" else None)
                page.on("pageerror", lambda e: logs.append("pageerror: " + str(e)[:200]))
                page.goto(url, wait_until="domcontentloaded", timeout=90000)
                page.wait_for_timeout(11000)
                page.evaluate("""() => {
                  document.querySelectorAll('#pinLockOverlay,[id^=pinLockOverlay]').forEach(e=>e.remove());
                  document.documentElement.classList.remove('pin-locked');
                }""")
                T = f'[{tag(url)} {w}px]'
                ov = page.evaluate("() => ({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})")
                check(ov["sw"] - ov["cw"] <= 0, f"{T} 가로 오버플로 0px", ov)
                tl = page.evaluate("""() => {
                  const chips=[...document.querySelectorAll('#tlScroll .tl-chip')];
                  const done=chips.filter(c=>c.classList.contains('done'));
                  const flows=[...document.querySelectorAll('#tlScroll .tl-flow')];
                  const money=[...document.querySelectorAll('#tlScroll .tl-money')];
                  const last=done[done.length-1];
                  return {chips:chips.length, done:done.length, flows:flows.length, money:money.length,
                          clip:chips.filter(c=>c.scrollHeight>c.clientHeight+1).length,
                          sample:last?last.innerText.replace(/\\n/g,' | ').slice(0,200):''};
                }""")
                check(tl["done"] >= 6, f"{T} 완료 슬롯 카드", tl["done"])
                check(tl["flows"] >= tl["done"], f"{T} 수급 1줄 전 카드 표시", f'flows={tl["flows"]}/{tl["done"]}')
                check(tl["money"] >= tl["done"] - 1, f"{T} 대금 1줄 표시", tl["money"])
                check(tl["clip"] == 0, f"{T} 카드 잘림 0", tl["clip"])
                check("외인" in tl["sample"], f"{T} 외인 수급 문구", tl["sample"][:120])

                page.evaluate("""() => {
                  document.querySelectorAll('#pinLockOverlay,[id^=pinLockOverlay]').forEach(e=>e.remove());
                  document.documentElement.classList.remove('pin-locked');
                  const done=[...document.querySelectorAll('#tlScroll .tl-chip.done')];
                  if(done.length) done[done.length-1].click();
                }""")
                page.wait_for_timeout(900)
                pop = page.evaluate("""() => {
                  const ovl=document.querySelector('.pmflow-ovl.on');
                  if(!ovl) return {open:false};
                  const txt=(ovl.querySelector('.pmflow-b').textContent||'').replace(/\\s+/g,' ');
                  return {open:true, sup:ovl.querySelectorAll('.sup-box').length,
                          rows:ovl.querySelectorAll('.tl-detail-row').length,
                          badge:ovl.querySelectorAll('.buy-badge').length, txt:txt.slice(0,900)};
                }""")
                check(pop.get("open"), f"{T} 슬롯 팝업 열림")
                check(pop.get("sup", 0) >= 1, f"{T} 팝업 수급 박스", pop.get("sup"))
                check("선물" in (pop.get("txt") or ""), f"{T} 팝업 선물 수급")
                check("대금 합산" in (pop.get("txt") or ""), f"{T} 팝업 테마 대금 합산")
                check("잠정 수급" in (pop.get("txt") or "") or "순매수" in (pop.get("txt") or ""), f"{T} 팝업 잠정 수급")
                check(pop.get("badge", 0) >= 1, f"{T} 테마 잠정 수급 배지", pop.get("badge"))
                page.screenshot(path=f"{OUT}/live_{tag(url)}_popup_{w}.png")
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)

                se = page.evaluate("""() => ({
                  seCards: document.querySelectorAll('#seBody [class*="se-"]').length,
                  pm: !!document.getElementById('premarketRadarBox')})""")
                check(se["pm"], f"{T} 프리마켓 레이더")
                check(se["seCards"] > 0, f"{T} 스탁이지 편입", se["seCards"])
                taberr = []
                for v in ("bijoong", "honginki", "manju", "aftermarket", "supply", "overview"):
                    try:
                        page.evaluate(f"() => switchView('{v}', null)")
                        page.wait_for_timeout(380)
                    except Exception as e:
                        taberr.append(f"{v}:{e}")
                check(not taberr, f"{T} 탭 전환", taberr)
                real = [x for x in logs if not any(k in x for k in ("favicon", "net::ERR_", "Failed to load resource", "ERR_FAILED"))]
                check(len(real) == 0, f"{T} 콘솔·페이지 에러 0", real[:3])
                page.evaluate("() => { const e=document.getElementById('tlBox'); if(e) e.scrollIntoView({block:'center'}); }")
                page.wait_for_timeout(500)
                page.screenshot(path=f"{OUT}/live_{tag(url)}_tl_{w}.png")
                ctx.close()
        b.close()
    print(f"\n=== PASS {len(oks)} / FAIL {len(fails)} ===")
    if fails:
        for f in fails:
            print('  x', f)
        sys.exit(1)


if __name__ == "__main__":
    main()
