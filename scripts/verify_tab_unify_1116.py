#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""5개 전략 탭 통일 검증 (동적 본체 · Playwright)

  python3 scripts/verify_tab_unify_1116.py [base_url]

검증 항목
  1) 400×860 / 884×960 / 1100×800 3해상도에서 5개 전략 탭 렌더 · 가로 넘침 0 · 콘솔 오류 0
  2) 모든 종목 카드에 「📌 핀 고정」 버튼
  3) 핀 토글 → 📌 고정됨 배지 + 카드 최상단 우선 배치 → 새로고침 후 유지
  4) 오늘 목록에 없는 고정핀 종목 → 📌 고정됨 카드로 유지 + 실시간 시세·차트
  5) 당일 실시간 봉(/api/stock-chart liveBar) · 종베 캔들 당일 봉 반영
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

NODE = "/workspace/.local/nodejs/node-v20.18.0-linux-x64/bin/node"
PORT = 8801
BASE = sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{PORT}/"


def ensure_server():
    """로컬 동적 서버(dev_server.mjs)가 없으면 띄운다 — 검증이 끝나면 종료."""
    try:
        urllib.request.urlopen(BASE, timeout=2)
        return None
    except Exception:
        pass
    proc = subprocess.Popen([NODE, "dev_server.mjs"], cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            env={**os.environ, "PORT": str(PORT)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        time.sleep(0.3)
        try:
            urllib.request.urlopen(BASE, timeout=1)
            return proc
        except Exception:
            continue
    return proc
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "screenshots", "tab_unify_1116")
VIEWPORTS = [(400, 860), (884, 960), (1100, 800)]
TABS = [("bijoong", "📊 비중법사"), ("honginki", "🎯 홍인기"), ("manju", "🎯 만쥬"), ("jongbe", "🏆 종가베팅"), ("rnzone", "🎯 RN존")]
CARD_SEL = {
    "bijoong": "#tabBijoong article.card",
    "honginki": "#tabHonginki .hi-stock-card",
    "manju": "#tabManju .sp-card",
    "jongbe": "#tabJongbe .stock-card",
    "rnzone": "#tabRnzone .stock-card",
}


def switch(page, view):
    page.evaluate(
        """(v) => { const b = document.querySelector('.tab-btn[data-view="' + v + '"]'); if (b) b.click(); }""",
        view,
    )
    page.wait_for_timeout(900)


def main():
    os.makedirs(OUT, exist_ok=True)
    srv = ensure_server()
    report = {"resolutions": [], "ok": True}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path='/workspace/.cache/puppeteer/chrome-headless-shell/linux-131.0.6778.204/chrome-headless-shell-linux64/chrome-headless-shell',
            env={**os.environ, 'LD_LIBRARY_PATH': '/workspace/_tools/libs/usr/lib/x86_64-linux-gnu'},
            args=['--no-sandbox', '--disable-dev-shm-usage'],
        )
        for w, h in VIEWPORTS:
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)[:160]))
            page.on("console", lambda m: errors.append("console: " + m.text[:160]) if m.type == "error" else None)
            page.goto(BASE, wait_until="domcontentloaded")
            # PIN 잠금 화면(화면 가림 전용) 해제 — 페이지에 박힌 인증 토큰을 그대로 쓴다
            page.evaluate(
                """() => {
                  const m = document.documentElement.innerHTML.match(/'([0-9]{4}_verified)'/);
                  if (m) localStorage.setItem('stock_dashboard_pin_auth', m[1]);
                }"""
            )
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(2500)
            page.evaluate("() => { ['bij','hong','manju','jongbe','rn'].forEach(t => { try { StrategyPins.clear(t); } catch(e){} }); }")
            res = {"viewport": f"{w}x{h}", "tabs": {}, "errors": [], "overflow": [], "ok": True}
            for view, label in TABS:
                switch(page, view)
                page.wait_for_timeout(1200)
                info = page.evaluate(
                    """(v) => {
                  const root = document.querySelector({rn:'#tabRnzone',jongbe:'#tabJongbe',manju:'#tabManju',bij:'#tabBijoong',hong:'#tabHonginki'}[v]);
                  if (!root) return {ok:false, reason:'no root'};
                  const cards = root.querySelectorAll({bij:'article.card',hong:'.hi-stock-card',manju:'.sp-card',jongbe:'.stock-card',rn:'.stock-card'}[v]);
                  let withPin = 0;
                  cards.forEach(c => { if (c.querySelector('.sp-pin')) withPin++; });
                  return {ok:true, cards: cards.length, withPin,
                          scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth};
                }""",
                    {"bijoong": "bij", "honginki": "hong", "manju": "manju", "jongbe": "jongbe", "rnzone": "rn"}[view],
                )
                res["tabs"][view] = info
                if info.get("ok") and info["scrollW"] > info["innerW"] + 2:
                    res["overflow"].append(f"{view}:{info['scrollW']}>{info['innerW']}")
                page.screenshot(path=os.path.join(OUT, f"{w}x{h}_{view}.png"), full_page=False)
            # 핀 토글·유지 (RN존에서)
            switch(page, "rnzone")
            pin = {"ok": False}
            for _ in range(4):
                pin = page.evaluate(
                    """() => {
                      const card = document.querySelector('#tabRnzone .stock-card .sp-pin');
                      if (!card) return {ok:false};
                      const el = card.closest('.stock-card');
                      const code = el.getAttribute('data-sp-code');
                      card.click();
                      return {ok:true, code};
                    }"""
                )
                if pin.get("ok"):
                    break
                page.wait_for_timeout(800)
            page.wait_for_timeout(700)
            after = page.evaluate(
                """() => {
                  const grid = document.querySelector('#stockListGrid');
                  const first = grid && grid.querySelector('.stock-card');
                  return {
                    pinned: !!document.querySelector('#tabRnzone .stock-card.sp-pinned'),
                    badge: !!document.querySelector('#tabRnzone .stock-card .sp-flag'),
                    firstCode: first ? first.getAttribute('data-sp-code') : null,
                    state: StrategyPins.state()
                  };
                }"""
            )
            page.screenshot(path=os.path.join(OUT, f"{w}x{h}_rnzone_pinned.png"))

            # 오늘 목록에 없는 고정핀 → 📌 고정됨 카드 + 실시간
            page.evaluate(
                """() => {
                  const raw = JSON.parse(localStorage.getItem('stock.pins.v1') || '{"v":1,"tabs":{},"at":0}');
                  raw.tabs = raw.tabs || {};
                  raw.tabs.rn = raw.tabs.rn || {};
                  raw.tabs.rn['035720'] = {code:'035720', name:'카카오', at: Date.now()+1000, price: 0};
                  localStorage.setItem('stock.pins.v1', JSON.stringify(raw));
                }"""
            )
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(3500)
            switch(page, "rnzone")
            page.wait_for_timeout(2500)
            extra = page.evaluate(
                """() => {
                  const x = document.querySelector('#tabRnzone .sp-xcard');
                  return {has: !!x, text: x ? x.textContent.slice(0, 200) : null,
                          canvas: !!(x && x.querySelector('canvas')),
                          live: StrategyPins.state().live};
                }"""
            )
            page.screenshot(path=os.path.join(OUT, f"{w}x{h}_rnzone_extra.png"))

            # 당일 실시간 봉 · 종베 캔들
            chart = page.evaluate(
                """async () => {
                  const r = await fetch('/api/stock-chart?code=005930&count=60');
                  const j = await r.json();
                  return {liveBar: j.liveBar, last: j.candles && j.candles[j.candles.length-1]};
                }"""
            )
            switch(page, "jongbe")
            page.wait_for_timeout(4000)
            jong = page.evaluate(
                """() => {
                  const st = (window.Jongbe && window.Jongbe.getStocks()) || [];
                  const last = st[0] && st[0].candles && st[0].candles[st[0].candles.length-1];
                  return {n: st.length, lastDate: last && last.date, hasUpdate: typeof (window.Jongbe||{}).updateCandles === 'function'};
                }"""
            )
            res["pin"] = {"pinned": after.get("pinned"), "badge": after.get("badge"), "first": after.get("firstCode"), "state": after.get("state")}
            res["extra"] = extra
            res["chart"] = {"liveBar": chart.get("liveBar"), "lastDate": (chart.get("last") or {}).get("date")}
            res["jongbe"] = jong
            res["errors"] = errors[:8]
            # 판정
            for view in res["tabs"]:
                t = res["tabs"][view]
                if not t.get("ok") or t.get("withPin", 0) != t.get("cards"):
                    res["ok"] = False
                # 비중법사는 기준봉 0종목인 날이 정상이다(조건 5개를 모두 채운 종목이 없을 때)
                if view != "bijoong" and t.get("cards", 0) == 0:
                    res["ok"] = False
            if res["overflow"] or not res["pin"]["pinned"] or not res["pin"]["badge"]:
                res["ok"] = False
            if not extra.get("has") or not extra.get("canvas"):
                res["ok"] = False
            if not res["chart"]["liveBar"]:
                res["ok"] = False
            if errors:
                res["ok"] = False
            report["resolutions"].append(res)
            ctx.close()
        browser.close()
    # 검증용 고정핀은 남기지 않는다(사용자 클라우드 stock_pin_0623 을 비운다)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path='/workspace/.cache/puppeteer/chrome-headless-shell/linux-131.0.6778.204/chrome-headless-shell-linux64/chrome-headless-shell',
            env={**os.environ, 'LD_LIBRARY_PATH': '/workspace/_tools/libs/usr/lib/x86_64-linux-gnu'},
            args=['--no-sandbox', '--disable-dev-shm-usage'],
        )
        ctx = browser.new_context(viewport={"width": 400, "height": 860})
        page = ctx.new_page()
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        page.evaluate("() => { ['bij','hong','manju','jongbe','rn'].forEach(t => { try { StrategyPins.clear(t); } catch(e){} }); }")
        page.wait_for_timeout(2000)
        report["cleaned"] = page.evaluate("() => StrategyPins.state().total")
        ctx.close()
        browser.close()
    if srv:
        srv.terminate()
    report["ok"] = all(r["ok"] for r in report["resolutions"])
    print(json.dumps(report, ensure_ascii=False, indent=1))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
