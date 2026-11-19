#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""🧭 시간별 수급 이동 고도화 — 로컬(동적 본체) Playwright 검증.

  · 400×860 / 884×960 / 1100×800 에서 콘솔·페이지 에러 0건, 가로 오버플로 0px
  · 타임라인 카드 앞면의 수급·대금 2줄이 잘리지 않는지(스크롤 클리핑) 확인
  · 완료 슬롯 클릭 → 수급 박스·테마 대금 순증·잠정 수급 배지 팝업 확인
  · 스탁이지 편입 카드·프리마켓 접기·전략 탭 전환·모달 동작 확인
"""
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

NODE = "/workspace/.local/nodejs/node-v20.18.0-linux-x64/bin/node"
CHROME = "/workspace/.cache/puppeteer/chrome-headless-shell/linux-131.0.6778.204/chrome-headless-shell-linux64/chrome-headless-shell"
ROOT = "/workspace/sd_live"
PORT = int(os.environ.get("VERIFY_PORT", "8841"))
BASE = f"http://127.0.0.1:{PORT}/"
OUT = "/workspace/screenshots/flow_1117"

fails, oks = [], []


def check(cond, label, detail=""):
    (oks if cond else fails).append(label)
    print(("O " if cond else "X ") + label + ((" - " + str(detail)) if detail else ""))


def main():
    os.makedirs(OUT, exist_ok=True)
    srv = subprocess.Popen([NODE, "dev_server.mjs"], cwd=ROOT,
                           env={**os.environ, "PORT": str(PORT)},
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        time.sleep(0.3)
        try:
            urllib.request.urlopen(BASE, timeout=1)
            break
        except Exception:
            continue
    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch(executable_path=CHROME, args=["--no-sandbox", "--disable-dev-shm-usage"])
            for w, h in ((400, 860), (884, 960), (1100, 800)):
                logs = []
                ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
                page = ctx.new_page()
                page.on("console", lambda m: logs.append("console." + m.type + ": " + m.text[:220]) if m.type == "error" else None)
                page.on("pageerror", lambda e: logs.append("pageerror: " + str(e)[:220]))
                page.goto(BASE, wait_until="domcontentloaded", timeout=90000)
                page.wait_for_timeout(12000)
                page.evaluate("""() => {
                  document.querySelectorAll('#pinLockOverlay,[id^=pinLockOverlay]').forEach(e=>e.remove());
                  document.documentElement.classList.remove('pin-locked');
                }""")

                ov = page.evaluate("() => ({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})")
                check(ov["sw"] - ov["cw"] <= 0, f"[{w}px] 페이지 가로 오버플로 0px", ov)

                tl = page.evaluate("""() => {
                  const box=document.getElementById('tlBox');
                  const chips=[...document.querySelectorAll('#tlScroll .tl-chip')];
                  const done=chips.filter(c=>c.classList.contains('done'));
                  const last=done[done.length-1];
                  const flows=[...document.querySelectorAll('#tlScroll .tl-flow')];
                  const money=[...document.querySelectorAll('#tlScroll .tl-money')];
                  const clip=chips.filter(c=>c.scrollHeight>c.clientHeight+1).length;
                  return {
                    boxVisible: box?getComputedStyle(box).display!=='none':false,
                    chips: chips.length, done: done.length,
                    flows: flows.length, money: money.length,
                    clip: clip,
                    sample: last?last.innerText.replace(/\\n/g,' | ').slice(0,240):''
                  };
                }""")
                check(tl["boxVisible"], f"[{w}px] 타임라인 박스 표시")
                check(tl["done"] >= 6, f"[{w}px] 완료 슬롯 카드 6개 이상", tl["done"])
                check(tl["flows"] >= tl["done"], f"[{w}px] 수급 1줄이 모든 완료 카드에 있음", f'flows={tl["flows"]} done={tl["done"]}')
                check(tl["money"] >= tl["done"] - 1, f"[{w}px] 대금 순증/대금 1줄 표시", tl["money"])
                check(tl["clip"] == 0, f"[{w}px] 카드 텍스트 잘림 0건", tl["clip"])
                check("외인" in tl["sample"], f"[{w}px] 카드에 외인 수급 문구", tl["sample"][:140])
                try:
                    page.locator('#tlBox').screenshot(path=f"{OUT}/tlbox_{w}x{h}.png")
                except Exception as e:
                    print('  (tlbox screenshot skip)', e)

                page.evaluate("""() => {
                  const done=[...document.querySelectorAll('#tlScroll .tl-chip.done')];
                  done[done.length-1].click();
                }""")
                page.wait_for_timeout(700)
                pop = page.evaluate("""() => {
                  const ovl=document.querySelector('.pmflow-ovl.on');
                  if(!ovl) return {open:false};
                  const sup=ovl.querySelectorAll('.sup-box').length;
                  const rows=ovl.querySelectorAll('.tl-detail-row').length;
                  const badge=ovl.querySelectorAll('.buy-badge').length;
                  const txt=ovl.querySelector('.pmflow-b').innerText.replace(/\\n/g,' | ');
                  return {open:true, sup:sup, rows:rows, badge:badge, txt:txt.slice(0,1200)};
                }""")
                check(pop.get("open"), f"[{w}px] 슬롯 클릭 팝업 열림")
                check(pop.get("sup", 0) >= 1, f"[{w}px] 팝업에 수급 박스", pop.get("sup"))
                check(pop.get("rows", 0) >= 5, f"[{w}px] 팝업 테마 행", pop.get("rows"))
                check("선물" in (pop.get("txt") or ""), f"[{w}px] 팝업에 선물 수급", (pop.get("txt") or "")[:120])
                check("대금 합산" in (pop.get("txt") or ""), f"[{w}px] 팝업에 테마 대금 합산", "")
                check("잠정 수급" in (pop.get("txt") or "") or "순매수" in (pop.get("txt") or ""),
                      f"[{w}px] 팝업에 잠정 수급 포착 블록")
                page.screenshot(path=f"{OUT}/popup_{w}x{h}.png", full_page=False)
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)

                se = page.evaluate("""() => ({
                  seCards: document.querySelectorAll('#seBody [class*="se-"]').length,
                  pmBox: !!document.getElementById('premarketRadarBox')
                })""")
                check(se["pmBox"], f"[{w}px] 프리마켓 레이더 박스 존재")
                check(se["seCards"] > 0, f"[{w}px] 스탁이지 편입 카드", se["seCards"])

                taberr = []
                for v in ("bijoong", "honginki", "manju", "aftermarket", "supply"):
                    try:
                        page.evaluate(f"() => switchView('{v}', null)")
                        page.wait_for_timeout(400)
                    except Exception as e:
                        taberr.append(f"{v}:{e}")
                check(not taberr, f"[{w}px] 전략 탭 전환 정상", taberr)
                page.evaluate("() => switchView('overview', null)")
                page.wait_for_timeout(700)

                real = [x for x in logs if not any(k in x for k in ("favicon", "net::ERR_", "Failed to load resource"))]
                check(len(real) == 0, f"[{w}px] 콘솔·페이지 에러 0건", real[:4])
                page.screenshot(path=f"{OUT}/main_{w}x{h}.png", full_page=False)
                ctx.close()
            b.close()
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=5)
        except Exception:
            srv.kill()
    print(f"\n=== PASS {len(oks)} / FAIL {len(fails)} ===")
    if fails:
        for f in fails:
            print("  x", f)
        sys.exit(1)


if __name__ == "__main__":
    main()
