#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""깡토 탭 · 수급 탭 자동교체 · 브리핑 점프 · RN존 % 검증 (동적 본체 · Playwright)

  python3 scripts/verify_kkangto_1116.py [base_url]

검증 항목
  1) 400×860 / 884×960 / 1100×800 — 가로 넘침 0 · 콘솔 오류 0
  2) 📈 깡토 탭이 홍인기 탭 바로 옆에 있고, 카드마다 📌 핀 고정 + 미니 차트(전고점·−8%·+24%·60일선)
  3) 2% 룰 · 5유닛 계산기 — 시드 1,000만 → 손실 20만 / 종목최대 250만 / 1유닛 50만 / 진입 3유닛 150만
  4) 전고점 대비 −5% 밖으로 밀린 카드 = 실시간 자동 제외, 📌 핀 고정 카드만 유지
  5) 종목 직접 조회(005930) → 깡토 기준선 차트 팝업
  6) 2번 수급 탭 — 4개 그룹이 확정 수급으로 렌더 + 핀 고정 유지
  7) 4번 브리핑 탭 시간대 칩 14개 + 15:00 점프(스크롤·팝업)
  8) RN존 카드 지지 −X% / 저항 +Y% 한 줄
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

NODE = "/workspace/.local/nodejs/node-v20.18.0-linux-x64/bin/node"
CHROME = "/workspace/.cache/puppeteer/chrome-headless-shell/linux-131.0.6778.204/chrome-headless-shell-linux64/chrome-headless-shell"
PORT = int(os.environ.get("VERIFY_PORT", "8842"))
BASE = sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{PORT}/"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "screenshots", "kkangto_1116")
VIEWPORTS = [(400, 860), (884, 960), (1100, 800)]


def ensure_server():
    try:
        urllib.request.urlopen(BASE, timeout=2)
        return None
    except Exception:
        pass
    proc = subprocess.Popen([NODE, "dev_server.mjs"], cwd=ROOT,
                            env={**os.environ, "PORT": str(PORT)},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        time.sleep(0.3)
        try:
            urllib.request.urlopen(BASE, timeout=1)
            return proc
        except Exception:
            continue
    return proc


def switch(page, view):
    page.evaluate("(v) => { const b = document.querySelector('.tab-btn[data-view=\"' + v + '\"]'); if (b) b.click(); }", view)
    page.wait_for_timeout(900)


def main():
    os.makedirs(OUT, exist_ok=True)
    srv = ensure_server()
    report = {"ok": True, "viewports": []}
    fails = []

    def check(cond, label, extra=None):
        if not cond:
            fails.append(label if extra is None else f"{label} ({extra})")
        return bool(cond)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=CHROME,
            env={**os.environ, 'LD_LIBRARY_PATH': '/workspace/_tools/libs/usr/lib/x86_64-linux-gnu'},
            args=['--no-sandbox', '--disable-dev-shm-usage'],
        )
        for w, h in VIEWPORTS:
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)[:200]))
            page.on("console", lambda m: errors.append("console: " + m.text[:200]) if m.type == "error" else None)

            # 실시간 시세 스텁 — 첫 near 카드를 전고점 대비 −20%로 밀어 5% 이탈 제외를 검증한다
            stub = {"code": None}

            def route_live(route):
                try:
                    body = json.loads(route.request.post_data or "{}")
                except Exception:
                    body = {}
                stocks = []
                if stub["code"]:
                    stocks.append({"code": stub["code"], "price": stub["price"], "changePct": -20.0})
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"ok": True, "stocks": stocks}))

            ctx.route(re.compile(r".*/api/stock-live.*"), route_live)
            page.goto(BASE, wait_until="domcontentloaded")
            page.evaluate(
                """() => { const m = document.documentElement.innerHTML.match(/'([0-9]{4}_verified)'/);
                     if (m) localStorage.setItem('stock_dashboard_pin_auth', m[1]);
                     try { ['kk','sup'].forEach(t => StrategyPins.clear(t)); } catch(e){} }"""
            )
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(2600)
            page.evaluate(
                """() => { document.documentElement.classList.remove('pin-locked');
                     const o = document.getElementById('pinLockOverlay'); if (o) o.remove(); }"""
            )
            page.evaluate("() => { try { ['kk','sup'].forEach(t => StrategyPins.clear(t)); } catch(e){} }")

            res = {"viewport": f"{w}x{h}"}

            # ── 1) 탭 버튼 위치 (홍인기 바로 옆)
            res["tab_adjacent"] = page.evaluate(
                """() => {
                  const hong = document.querySelector('.tab-btn[data-view="honginki"]');
                  const kk = document.querySelector('.tab-btn[data-view="kkangto"]');
                  if (!hong || !kk) return false;
                  return hong.nextElementSibling === kk;
                }"""
            )
            check(res["tab_adjacent"], f"{w}: 깡토 탭이 홍인기 바로 옆이 아님")

            # ── 2) 깡토 탭 렌더
            switch(page, "kkangto")
            page.wait_for_timeout(1500)
            st = page.evaluate("() => (window.KkangtoTab ? KkangtoTab.state() : null)")
            res["kk_state"] = st
            dom = page.evaluate(
                """() => {
                  const root = document.getElementById('tabKkangto');
                  const cards = root.querySelectorAll('.kk-card');
                  let withPin = 0, canv = 0, drawn = 0;
                  cards.forEach(c => {
                    if (c.querySelector('.sp-pin')) withPin++;
                    const cv = c.querySelector('canvas.kk-mini');
                    if (cv) {
                      canv++;
                      try {
                        const ctx = cv.getContext('2d');
                        const d = ctx.getImageData(0, 0, Math.min(60, cv.width), Math.min(60, cv.height)).data;
                        let nz = 0;
                        for (let i = 3; i < d.length; i += 40) if (d[i] > 8) nz++;
                        if (nz > 3) drawn++;
                      } catch (e) {}
                    }
                  });
                  return {cards: cards.length, withPin, canv, drawn,
                          near: root.querySelectorAll('#kkNearGrid .kk-card').length,
                          brk: root.querySelectorAll('#kkBreakGrid .kk-card').length,
                          scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth};
                }"""
            )
            res["kk_dom"] = dom
            check(st and st["cards"] > 0, f"{w}: 깡토 카드 0건")
            check(dom["cards"] == dom["withPin"], f"{w}: 핀 버튼 누락", f'{dom["withPin"]}/{dom["cards"]}')
            check(dom["canv"] > 0 and dom["drawn"] == dom["canv"], f"{w}: 미니 차트 미표시", f'{dom["drawn"]}/{dom["canv"]}')
            check(dom["near"] + dom["brk"] == dom["cards"], f"{w}: 섹션 분류 불일치")
            page.evaluate("() => { const e = document.getElementById('tabKkangto'); if (e) e.scrollIntoView({block:'start'}); }")
            page.wait_for_timeout(300)
            page.screenshot(path=os.path.join(OUT, f"kkangto_{w}.png"))

            # ── 3) 계산기
            calc = page.evaluate("() => ({max: document.getElementById('kkOutMax').textContent, unit: document.getElementById('kkOutUnit').textContent, entry: document.getElementById('kkOutEntry').textContent, units: document.getElementById('kkOutUnits').textContent})")
            res["calc"] = calc
            check(calc["max"] == "2,500,000원", f"{w}: 종목당 최대 계산", calc["max"])
            check(calc["unit"] == "500,000원", f"{w}: 1유닛 계산", calc["unit"])
            check(calc["entry"] == "1,500,000원", f"{w}: 강세장 진입금액", calc["entry"])
            page.click("#kkMarketSeg button[data-v='1']")
            page.wait_for_timeout(200)
            calc2 = page.evaluate("() => ({entry: document.getElementById('kkOutEntry').textContent, units: document.getElementById('kkOutUnits').textContent})")
            res["calc_weak"] = calc2
            check(calc2["entry"] == "1,000,000원" and calc2["units"] == "2유닛", f"{w}: 약세장 2유닛 계산", json.dumps(calc2))
            page.click("#kkStockPlus")
            page.wait_for_timeout(200)
            calc3 = page.evaluate("() => ({entry: document.getElementById('kkOutEntry').textContent, units: document.getElementById('kkOutUnits').textContent})")
            res["calc_plus"] = calc3
            check(calc3["units"] == "3유닛" and calc3["entry"] == "1,500,000원", f"{w}: 종목 유닛 +1 계산", json.dumps(calc3))
            page.click("#kkMarketSeg button[data-v='2']")
            page.evaluate("() => { const b = document.getElementById('kkStockMinus'); if (b) b.click(); }")
            page.wait_for_timeout(200)

            # ── 4) 차트 팝업
            modal = page.evaluate(
                """() => {
                  const card = document.querySelector('#kkNearGrid .kk-card') || document.querySelector('#kkBreakGrid .kk-card');
                  if (!card) return null;
                  card.click();
                  return card.getAttribute('data-code');
                }"""
            )
            page.wait_for_timeout(700)
            minfo = page.evaluate(
                """() => {
                  const m = document.getElementById('kkChartModal');
                  const lg = document.getElementById('kkModalLegend');
                  return {open: !!m && m.classList.contains('on'), drawn: !!(window.__KKANGTO && __KKANGTO.modalDrawn),
                          legend: lg ? lg.textContent : '', title: (document.getElementById('kkModalTitle')||{}).textContent};
                }"""
            )
            res["modal"] = minfo
            check(minfo["open"] and minfo["drawn"], f"{w}: 차트 팝업 미표시")
            check("−8%" in minfo["legend"] and "60일선" in minfo["legend"] and "전고점" in minfo["legend"],
                  f"{w}: 팝업 핵심선 라벨 누락", minfo["legend"][:60])
            page.screenshot(path=os.path.join(OUT, f"kkangto_modal_{w}.png"))
            page.evaluate("() => { try { KkangtoTab.closeChart(); } catch(e){} }")

            # ── 5) 종목 직접 조회
            page.fill("#kkSearchInput", "005930")
            page.click("#kkSearchBtn")
            page.wait_for_timeout(4000)
            ser = page.evaluate("() => ({searched: window.__KKANGTO ? __KKANGTO.searched : null, open: (document.getElementById('kkChartModal')||{}).className || ''})")
            res["search"] = ser
            check(ser["searched"] and ser["searched"].get("code") == "005930", f"{w}: 직접 조회 실패", json.dumps(ser)[:120])
            check("on" in (ser["open"] or ""), f"{w}: 직접 조회 차트 미표시")
            page.screenshot(path=os.path.join(OUT, f"kkangto_search_{w}.png"))
            page.evaluate("() => { try { KkangtoTab.closeChart(); } catch(e){} }")

            # ── 6) 5% 이탈 자동 제외 + 핀 유지
            target = page.evaluate(
                """() => {
                  const c = document.querySelector('#kkNearGrid .kk-card');
                  if (!c) return null;
                  const b = Number(c.getAttribute('data-basis'));
                  return {code: c.getAttribute('data-code'), basis: b};
                }"""
            )
            if target:
                stub["code"], stub["price"] = target["code"], round(target["basis"] * 0.8)
                page.evaluate("() => { const b = document.getElementById('kkRefreshBtn'); if (b) b.click(); }")
                page.wait_for_timeout(1800)
                off = page.evaluate("(code) => { const c = document.querySelector('#kkNearGrid .kk-card[data-code=\"' + code + '\"]'); return c ? c.classList.contains('kk-off') : null; }", target["code"])
                res["excluded"] = off
                check(off is True, f"{w}: −5% 이탈 카드가 자동 제외되지 않음")
                page.evaluate("(code) => { try { StrategyPins.toggle('kk', document.querySelector('#tabKkangto .kk-card[data-code=\"' + code + '\"]')); } catch(e){} }", target["code"])
                page.evaluate("() => { const b = document.getElementById('kkRefreshBtn'); if (b) b.click(); }")
                page.wait_for_timeout(1600)
                kept = page.evaluate("(code) => { const c = document.querySelector('#tabKkangto .kk-card[data-code=\"' + code + '\"]'); return c ? {off: c.classList.contains('kk-off'), pin: c.classList.contains('kk-pinned-keep'), flag: !!c.querySelector('.sp-flag')} : null; }", target["code"])
                res["pinned_keep"] = kept
                check(kept and not kept["off"] and kept["flag"], f"{w}: 핀 고정 카드가 유지되지 않음", json.dumps(kept))
                page.screenshot(path=os.path.join(OUT, f"kkangto_pin_{w}.png"))
                # 핀 해제 후 자동 제외 복귀
                page.evaluate("(code) => { try { StrategyPins.toggle('kk', document.querySelector('#tabKkangto .kk-card[data-code=\"' + code + '\"]')); } catch(e){} }", target["code"])
                stub["code"] = None
                page.evaluate("() => { const b = document.getElementById('kkRefreshBtn'); if (b) b.click(); }")
                page.wait_for_timeout(900)

            # ── 7) 수급 탭
            switch(page, "supply")
            page.wait_for_timeout(1600)
            sup = page.evaluate(
                """() => {
                  const root = document.getElementById('tabSupply');
                  const cards = root.querySelectorAll('.supply-stock-card[data-code]');
                  let withPin = 0;
                  cards.forEach(c => { if (c.querySelector('.sp-pin')) withPin++; });
                  const stamp = document.getElementById('supBasisLine');
                  return {cards: cards.length, withPin,
                          groups: ['supForeignBuy','supOrganBuy','supForeignSell','supDualBuy'].map(id => (document.getElementById(id)||{}).querySelectorAll ? document.getElementById(id).querySelectorAll('.supply-stock-card').length : 0),
                          basis: stamp ? stamp.textContent.slice(0, 80) : '',
                          heads: ['supForeignHead','supOrganHead','supSellHead','supDualHead'].map(id => (document.getElementById(id)||{}).textContent || '')};
                }"""
            )
            res["supply"] = sup
            check(sup["cards"] >= 12, f"{w}: 수급 카드 부족", str(sup["cards"]))
            check(sup["withPin"] == sup["cards"], f"{w}: 수급 카드 핀 버튼 누락", f'{sup["withPin"]}/{sup["cards"]}')
            check(all(n > 0 for n in sup["groups"]), f"{w}: 수급 4개 그룹 중 빈 그룹", str(sup["groups"]))
            check("거래소 확정" in sup["basis"], f"{w}: 수급 기준일 표기 없음", sup["basis"])
            first_sup = page.evaluate(
                """() => {
                  const c = document.querySelector('#tabSupply .supply-stock-card[data-code]');
                  if (!c) return null;
                  const pin = c.querySelector('.sp-pin');
                  if (pin) pin.click();
                  return c.getAttribute('data-code');
                }"""
            )
            page.wait_for_timeout(700)
            sup_pin = page.evaluate("(code) => { const c = document.querySelector('#tabSupply .supply-stock-card[data-code=\"' + code + '\"]'); return c ? {pinned: c.classList.contains('sp-pinned'), flag: !!c.querySelector('.sp-flag'), label: (c.querySelector('.sp-tools')||{}).textContent || ''} : null; }", first_sup)
            res["supply_pin"] = sup_pin
            check(sup_pin and sup_pin["pinned"] and sup_pin["flag"], f"{w}: 수급 핀 고정 실패", json.dumps(sup_pin, ensure_ascii=False))
            page.evaluate("() => { const e = document.getElementById('tabSupply'); if (e) e.scrollIntoView({block:'start'}); }")
            page.wait_for_timeout(300)
            page.screenshot(path=os.path.join(OUT, f"supply_{w}.png"))

            # ── 8) 브리핑 점프 칩
            switch(page, "analysis")
            page.wait_for_timeout(1200)
            chips = page.evaluate(
                """() => {
                  const wrap = document.getElementById('briefJumpChips');
                  if (!wrap) return null;
                  const btns = wrap.querySelectorAll('.bj-chip');
                  const b = wrap.querySelector('.bj-chip[data-t="15:00"]');
                  if (b) b.click();
                  return {n: btns.length, times: Array.from(btns).map(x => x.getAttribute('data-t'))};
                }"""
            )
            page.wait_for_timeout(1400)
            jump = page.evaluate("() => ({jump: window.__BRIEFJUMP || null, modal: (document.getElementById('briefingModalOverlay')||{}).style ? document.getElementById('briefingModalOverlay').style.display : null})")
            res["briefjump"] = {"chips": chips, "jump": jump}
            check(chips and chips["n"] == 14, f"{w}: 브리핑 칩 14개 아님", str(chips and chips["n"]))
            check(jump["jump"] and jump["jump"].get("last") == "15:00", f"{w}: 15:00 점프 실패", json.dumps(jump)[:120])
            check(jump["jump"] and jump["jump"].get("hasCard"), f"{w}: 15:00 카드 미발견")
            check(jump["modal"] == "flex", f"{w}: 브리핑 팝업 미표시", str(jump["modal"]))
            page.screenshot(path=os.path.join(OUT, f"briefjump_{w}.png"))
            page.evaluate("() => { const m = document.getElementById('briefingModalOverlay'); if (m) m.style.display = 'none'; }")

            # ── 9) RN존 지지/저항 %
            switch(page, "rnzone")
            page.wait_for_timeout(1500)
            rn = page.evaluate(
                """() => {
                  const cards = document.querySelectorAll('#stockListGrid .stock-card[data-code]');
                  let withGap = 0; let sample = '';
                  cards.forEach(c => { const g = c.querySelector('.rn-gap'); if (g) { withGap++; if (!sample) sample = g.textContent; } });
                  return {cards: cards.length, withGap, sample};
                }"""
            )
            res["rn_gap"] = rn
            check(rn["cards"] > 0 and rn["withGap"] == rn["cards"], f"{w}: RN존 지지/저항 줄 누락", f'{rn["withGap"]}/{rn["cards"]}')
            check("지지" in rn["sample"] and "저항" in rn["sample"] and "%" in rn["sample"], f"{w}: RN존 % 표기 이상", rn["sample"][:80])
            page.evaluate("() => { const e = document.getElementById('tabRnzone'); if (e) e.scrollIntoView({block:'start'}); }")
            page.wait_for_timeout(300)
            page.screenshot(path=os.path.join(OUT, f"rnzone_{w}.png"))

            # ── 10) 가로 넘침 · 콘솔 오류
            overflow = page.evaluate("() => ({sw: document.documentElement.scrollWidth, iw: window.innerWidth})")
            res["overflow"] = overflow
            check(overflow["sw"] <= overflow["iw"] + 1, f"{w}: 가로 넘침", f'{overflow["sw"]}>{overflow["iw"]}')
            ignore = ("favicon", "manifest", "Failed to load resource: the server responded with a status of 404")
            errs = [e for e in errors if not any(k in e for k in ignore)]
            res["errors"] = errs[:6]
            check(not errs, f"{w}: 콘솔 오류", "; ".join(errs[:3]))
            res["ok"] = not [f for f in fails if f.startswith(f"{w}:")]
            report["viewports"].append(res)
            ctx.close()

        # ── 새로고침 후 수급 핀 유지 (한 번만)
        ctx = browser.new_context(viewport={"width": 400, "height": 860}, device_scale_factor=1)
        page = ctx.new_page()
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_timeout(2200)
        page.evaluate("""() => { document.documentElement.classList.remove('pin-locked');
             const o = document.getElementById('pinLockOverlay'); if (o) o.remove(); }""")
        switch(page, "supply")
        page.wait_for_timeout(1500)
        persist = page.evaluate(
            """() => {
              const pinned = document.querySelectorAll('#tabSupply .supply-stock-card.sp-pinned');
              const x = document.querySelectorAll('#tabSupply .sp-xcard');
              return {pinned: pinned.length, xcards: x.length, list: Array.from(pinned).map(c => c.getAttribute('data-code'))};
            }"""
        )
        report["supply_pin_persist"] = persist
        check(persist["pinned"] >= 1, "새로고침 후 수급 핀 유지 실패", json.dumps(persist))
        ctx.close()
        browser.close()

    report["fails"] = fails
    report["ok"] = not fails
    if srv:
        srv.terminate()
    with open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(json.dumps({"ok": report["ok"], "fails": report["fails"]}, ensure_ascii=False, indent=1))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
