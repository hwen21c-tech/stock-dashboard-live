#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RN존·신정재 카드 클릭 확대차트 모달 + 상단 퀵 2줄 검증 (400×884 · 폴드8 가로/세로)

· 동적(sd_live/public)은 로컬 서버 + /api 프록시로, 정적(deploy_repo)은 그대로 서빙해 확인한다.
· 스크린샷: sd_live/screenshots/strat_modal/
사용: python3 sd_live/scripts/verify_strat_modal_1126.py [dyn|static]
"""
import json
import os
import sys
import threading
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))       # sd_live
WS = os.path.dirname(ROOT)
SHOTS = os.path.join(ROOT, "screenshots", "strat_modal")
UPSTREAM = "https://stock-dashboard-live-bice.vercel.app"

ROW1 = ["⚡ 실시간 브리핑", "🎯 홍인기", "📊 비중법사", "📈 깡토", "🎯 만쥬",
        "🏆 신정재", "🎯 RN", "💾 오늘 저장", "📁 보관함"]
ROW2 = ["💰 수급주도주", "🌙 애프터마켓", "📊 시장&수급심층분석", "📰 시간별 뉴스",
        "📅 증시일정", "🆕 신규상장", "🚫 과열제외"]


def serve(directory, port, proxy):
    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=directory, **kw)

        def log_message(self, *a):
            pass

        def do_GET(self):
            if proxy and self.path.startswith("/api/"):
                return self._proxy()
            return super().do_GET()

        def _proxy(self):
            req = urllib.request.Request(UPSTREAM + self.path, headers={"User-Agent": "verify"})
            try:
                with urllib.request.urlopen(req, timeout=25) as r:
                    data = r.read()
                    self.send_response(r.status)
                    self.send_header("Content-Type", r.headers.get("Content-Type", "application/json"))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:  # noqa
                body = json.dumps({"ok": False, "message": str(e)}).encode()
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def texts(page, sel):
    return [t.strip() for t in page.eval_on_selector_all(sel, "els => els.map(e => e.textContent.trim())")]


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "dyn"
    if mode == "dyn":
        directory = os.path.join(ROOT, "public")
        port, proxy = 8791, True
    else:
        directory = os.path.join(WS, "deploy_repo")
        port, proxy = 8792, False
    srv = serve(directory, port, proxy)
    base = f"http://127.0.0.1:{port}/index.html"
    os.makedirs(SHOTS, exist_ok=True)
    report = {"mode": mode, "checks": [], "console": [], "pageerrors": []}

    def ok(name, cond, extra=""):
        report["checks"].append({"name": name, "ok": bool(cond), "extra": extra})
        print(("✅ " if cond else "❌ ") + name + ((" — " + str(extra)) if extra else ""))

    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 400, "height": 884}, device_scale_factor=1,
                            is_mobile=True, has_touch=True)
        # 화면 가림용 PIN(0623) 잠금은 검증에서 미리 통과시킨다 — 잠금 자체는 이번 작업 대상이 아니다
        ctx.add_init_script("""try{localStorage.setItem('stock_dashboard_pin_auth','0623_verified');
            sessionStorage.setItem('stock_dashboard_pin_auth','0623_verified');}catch(e){}""")
        page = ctx.new_page()
        page.on("console", lambda m: report["console"].append({"type": m.type, "text": m.text[:300]})
                if m.type in ("error",) else None)
        page.on("pageerror", lambda e: report["pageerrors"].append(str(e)[:300]))
        page.goto(base, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4500)

        # ---------------- 1) 상단 퀵 버튼 두 줄 ----------------
        r1 = texts(page, "#sdQuickRow1 .btn-action, #sdQuickRow1 a.btn-action")
        r1_sd = r1[-9:]
        ok("퀵 1줄 순서(마지막 9개)", r1_sd == ROW1, r1_sd)
        r2 = texts(page, "#sdQuickRow2 .btn-action")
        ok("퀵 2줄 순서(7개)", r2 == ROW2, r2)

        vis_tabs = page.eval_on_selector_all(".view-tabs .tab-btn",
                                             "els => els.filter(e => e.offsetParent !== null).map(e => e.textContent.trim())")
        ok("가로 탭 바에는 메인만 노출", len(vis_tabs) == 1 and "메인" in vis_tabs[0], vis_tabs)

        # 줄바꿈: 400px 에서 두 줄 모두 버튼이 2줄 이상으로 접히는지(가로 넘침 없음)
        overflow = page.eval_on_selector_all("#sdQuickRow1, #sdQuickRow2",
                                             "els => els.map(e => ({sw: e.scrollWidth, cw: e.clientWidth, rows: Math.round(e.getBoundingClientRect().height)}))")
        ok("퀵 줄 가로 넘침 없음(400px)", all(o["sw"] <= o["cw"] + 2 for o in overflow), overflow)
        page.screenshot(path=os.path.join(SHOTS, f"{mode}_quick_rows_400.png"), full_page=False)

        # ---------------- 2) 퀵 버튼 이동 + active ----------------
        nav = [("🎯 RN", "tabRnzone", "rnzone"), ("🏆 신정재", "tabJongbe", "jongbe"),
               ("🎯 홍인기", "tabHonginki", "honginki"), ("📊 비중법사", "tabBijoong", "bijoong"),
               ("📈 깡토", "tabKkangto", "kkangto"), ("🎯 만쥬", "tabManju", "manju"),
               ("💰 수급주도주", "tabSupply", "supply"), ("🌙 애프터마켓", "tabAftermarket", "aftermarket"),
               ("📊 시장&수급심층분석", "tabAnalysis", "analysis"), ("📰 시간별 뉴스", "tabNews", "news"),
               ("📅 증시일정", "tabCalendar", "calendar"), ("🆕 신규상장", "tabIpo", "ipo")]
        nav_fail = []
        for label, tabid, view in nav:
            try:
                page.click(f'[data-quick="{view}"]')
            except Exception as e:
                nav_fail.append(f"{label}: click {e}")
                continue
            page.wait_for_timeout(320)
            shown = page.eval_on_selector(f"#{tabid}", "e => e.style.display !== 'none'")
            act = page.eval_on_selector(f'[data-quick="{view}"]', "e => e.classList.contains('qt-active')")
            if not (shown and act):
                nav_fail.append(f"{label}: shown={shown} active={act}")
        ok("퀵 버튼 12개 모두 해당 화면 이동 + active", not nav_fail, nav_fail)

        # 과열제외 토글
        if mode == "dyn":
            before = page.evaluate("() => document.body.classList.contains('oh-exclude')")
            page.click("#sdOhQuick")
            page.wait_for_timeout(350)
            after = page.evaluate("() => document.body.classList.contains('oh-exclude')")
            ok("🚫 과열제외 토글 동작", before != after, {"before": before, "after": after})
            page.screenshot(path=os.path.join(SHOTS, f"{mode}_overheat_on_400.png"))
            page.click("#sdOhQuick")
            page.wait_for_timeout(250)
        else:
            has_oh = page.evaluate("() => !!(window.OhBadge && window.OhBadge.toggleExclude)")
            before = page.evaluate("() => document.body.classList.contains('oh-exclude')")
            if has_oh:
                page.click("#sdOhQuick")
                page.wait_for_timeout(350)
            after = page.evaluate("() => document.body.classList.contains('oh-exclude')")
            ok("🚫 과열제외 토글 동작(정적 포함)", has_oh and before != after, {"engine": has_oh, "before": before, "after": after})
            if has_oh:
                page.click("#sdOhQuick")
                page.wait_for_timeout(200)

        # ---------------- 3) RN존 카드 → 확대 차트 모달 ----------------
        page.click('[data-quick="rnzone"]')
        page.wait_for_timeout(700)
        ok("RN존 메인 화면: 큰 차트가 탭에서 빠짐",
           page.eval_on_selector_all("#tabRnzone .dashboard-grid > .chart-section", "e => e.length") == 0)
        ok("RN존 메인 화면: 카드 리스트 유지",
           page.eval_on_selector_all("#tabRnzone .stock-card[data-code]", "e => e.length") > 0)
        page.eval_on_selector('#tabRnzone .stocks-section', "e => e.scrollIntoView({block:'start'})")
        page.wait_for_timeout(250)
        page.screenshot(path=os.path.join(SHOTS, f"{mode}_rn_main_400.png"))

        first = page.eval_on_selector("#tabRnzone .stock-card[data-code]", "e => ({code: e.getAttribute('data-code'), name: e.textContent.slice(0,20)})")
        page.click("#tabRnzone .stock-card[data-code]")
        page.wait_for_timeout(900)
        mod = page.evaluate("""() => {
            const b = document.getElementById('stratDetailModal');
            const cv = document.getElementById('candlestickCanvas');
            return {
              open: !!b && b.style.display === 'block',
              title: (document.getElementById('sdmTitle')||{}).textContent || '',
              chartInModal: !!document.querySelector('#stratDetailModal #chartWrapper'),
              cw: cv ? cv.width : 0, ch: cv ? cv.height : 0,
              news: ((document.getElementById('sdmNews')||{}).textContent || '').slice(0, 80),
              rule: ((document.getElementById('sdmRule')||{}).textContent || '').slice(0, 40),
              calcBtn: !!document.getElementById('sdmCalc')
            };
        }""")
        ok("RN존 카드 클릭 → 확대 차트 모달", mod["open"] and mod["chartInModal"] and mod["cw"] > 50 and mod["ch"] > 50, mod)
        ok("RN존 모달 제목에 종목코드", first["code"] in mod["title"], mod["title"][:60])
        ok("RN존 모달에 재료·뉴스 섹션", "재료" in mod["news"], mod["news"])
        ok("RN존 모달에 RN존 원칙 섹션", "RN" in mod["rule"], mod["rule"])
        page.screenshot(path=os.path.join(SHOTS, f"{mode}_rn_modal_top_400.png"))
        page.eval_on_selector('#stratDetailModal #chartWrapper', "e => e.scrollIntoView({block:'center'})")
        page.wait_for_timeout(350)
        page.screenshot(path=os.path.join(SHOTS, f"{mode}_rn_modal_chart_400.png"))
        # 계산기 토글
        if mod["calcBtn"]:
            page.click("#sdmCalc")
            page.wait_for_timeout(400)
            calc_open = page.eval_on_selector("#calcBox", "e => getComputedStyle(e).display !== 'none'")
            ok("RN존 모달 분할매수 계산기 열림", calc_open)
            page.screenshot(path=os.path.join(SHOTS, f"{mode}_rn_modal_calc_400.png"))
        # X 닫기
        page.click("#sdmClose")
        page.wait_for_timeout(300)
        closed = page.eval_on_selector("#stratDetailModal", "e => e.style.display === 'none'")
        ok("RN존 모달 X 닫기", closed)
        # 바깥 클릭 닫기
        page.click("#tabRnzone .stock-card[data-code]")
        page.wait_for_timeout(600)
        page.mouse.click(4, 500)
        page.wait_for_timeout(300)
        closed2 = page.eval_on_selector("#stratDetailModal", "e => e.style.display === 'none'")
        ok("RN존 모달 바깥 클릭 닫기", closed2)

        # ---------------- 4) 신정재 카드 → 확대 차트 모달 ----------------
        page.click('[data-quick="jongbe"]')
        page.wait_for_timeout(700)
        ok("신정재 메인 화면: 차트 패널이 탭에서 빠짐",
           page.eval_on_selector_all("#tabJongbe .main-layout > .chart-panel", "e => e.length") == 0)
        ok("신정재 메인 화면: 4패턴 원칙·도해 유지",
           page.eval_on_selector_all("#tabJongbe #jbPatternGrid .strategy-card", "e => e.length") >= 4)
        page.eval_on_selector('#jbTrackTabs', "e => e.scrollIntoView({block:'start'})")
        page.wait_for_timeout(250)
        page.screenshot(path=os.path.join(SHOTS, f"{mode}_jb_main_400.png"))

        jcode = page.eval_on_selector("#tabJongbe .stock-card[data-code]", "e => e.getAttribute('data-code')")
        page.click("#tabJongbe .stock-card[data-code]")
        page.wait_for_timeout(900)
        jmod = page.evaluate("""() => {
            const b = document.getElementById('stratDetailModal');
            const cv = document.getElementById('candleChart');
            return {
              open: !!b && b.style.display === 'block',
              title: (document.getElementById('sdmTitle')||{}).textContent || '',
              chartInModal: !!document.querySelector('#stratDetailModal #canvasContainer'),
              cw: cv ? cv.width : 0, ch: cv ? cv.height : 0,
              tips: ((document.getElementById('tacTips')||{}).textContent || '').slice(0, 60),
              tipScore: (document.getElementById('tacTipScore')||{}).textContent || '',
              rule: ((document.getElementById('sdmRule')||{}).textContent || '').slice(0, 40),
              facts: ((document.getElementById('sdmFacts')||{}).textContent || '').slice(0, 60),
              factsAll: ((document.getElementById('sdmFacts')||{}).textContent || ''),
              news: ((document.getElementById('sdmNews')||{}).textContent || '').slice(0, 60)
            };
        }""")
        ok("신정재 카드 클릭 → 확대 차트 모달", jmod["open"] and jmod["chartInModal"] and jmod["cw"] > 50 and jmod["ch"] > 50, jmod)
        ok("신정재 모달 제목에 종목코드", jcode in jmod["title"], jmod["title"][:60])
        ok("신정재 모달 6대 팁 X/6 상세", "/6" in jmod["tipScore"] and len(jmod["tips"]) > 10, {"score": jmod["tipScore"], "tips": jmod["tips"]})
        ok("신정재 모달 ② 캔들 지표(시/고/저/종)", "시 / 고 / 저 / 종" in jmod.get("factsAll", ""), jmod.get("factsAll", "")[:120])
        ok("신정재 모달 ① 재료 근거", "재료" in jmod["news"] and "②" in jmod["facts"], jmod["news"][:70])
        ok("신정재 모달 뉴스 섹션", "재료" in jmod["news"], jmod["news"])
        page.screenshot(path=os.path.join(SHOTS, f"{mode}_jb_modal_top_400.png"))
        page.eval_on_selector('#stratDetailModal #canvasContainer', "e => e.scrollIntoView({block:'center'})")
        page.wait_for_timeout(350)
        page.screenshot(path=os.path.join(SHOTS, f"{mode}_jb_modal_chart_400.png"))
        page.eval_on_selector("#stratDetailModal", "e => e.scrollTop = 700")
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SHOTS, f"{mode}_jb_modal_tips_400.png"))
        # 계산기 모달이 이 모달 위로
        try:
            page.click("#sdmCalc")
            page.wait_for_timeout(400)
            z = page.eval_on_selector("#calcModal", "e => ({disp: getComputedStyle(e).display, z: getComputedStyle(e).zIndex})")
            ok("신정재 계산기 모달이 확대차트 모달 위에 열림", z["disp"] != "none" and int(z["z"] or 0) > 22000, z)
            page.click("#calcModal .close-btn")
            page.wait_for_timeout(250)
        except Exception as e:
            ok("신정재 계산기 모달이 확대차트 모달 위에 열림", False, str(e))
        page.click("#sdmClose")
        page.wait_for_timeout(300)

        # ---------------- 5) 폴드8 가로(892×412) 줄바꿈 ----------------
        page.set_viewport_size({"width": 892, "height": 412})
        page.evaluate("window.scrollTo(0,0)")
        page.wait_for_timeout(900)
        page.screenshot(path=os.path.join(SHOTS, f"{mode}_quick_rows_fold8_landscape.png"))
        rows_land = page.eval_on_selector_all("#sdQuickRow1, #sdQuickRow2",
                                              "els => els.map(e => ({sw: e.scrollWidth, cw: e.clientWidth}))")
        ok("폴드8 가로에서도 퀵 줄 넘침 없음", all(o["sw"] <= o["cw"] + 2 for o in rows_land), rows_land)
        page.evaluate("() => { const b=document.getElementById('stratDetailModal'); if(b) b.style.display='none'; document.body.style.overflow=''; }")
        page.click('[data-quick="rnzone"]')
        page.wait_for_timeout(600)
        page.click("#tabRnzone .stock-card[data-code]")
        page.wait_for_timeout(900)
        page.screenshot(path=os.path.join(SHOTS, f"{mode}_rn_modal_fold8_landscape.png"))

        # ---------------- 6) 동적: 실시간 조회 → 모달 즉시 오픈 ----------------
        if mode == "dyn":
            page.click("#sdmClose")
            page.set_viewport_size({"width": 400, "height": 884})
            page.wait_for_timeout(500)
            page.fill("#liveStockQuery", "005930")
            page.click("#liveSearchBar button")
            page.wait_for_timeout(6000)
            s_modal = page.evaluate("""() => {
                const b = document.getElementById('stratDetailModal');
                return { open: !!b && b.style.display === 'block',
                         title: (document.getElementById('sdmTitle')||{}).textContent || '' };
            }""")
            ok("RN존 실시간 조회 → 확대 차트 모달 즉시 오픈", s_modal["open"] and "005930" in s_modal["title"], s_modal)
            page.screenshot(path=os.path.join(SHOTS, f"{mode}_rn_search_modal_400.png"))

        ctx.close()
        b.close()

    report["errors"] = [c for c in report["console"] if c["type"] == "error"]
    print("\n--- 콘솔 error %d건 / pageerror %d건 ---" % (len(report["errors"]), len(report["pageerrors"])))
    for e in report["errors"][:12]:
        print("  ·", e["text"][:160])
    for e in report["pageerrors"][:8]:
        print("  ‼", e[:160])
    with open(os.path.join(SHOTS, f"{mode}_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    srv.shutdown()
    fails = [c for c in report["checks"] if not c["ok"]]
    print("실패 체크: %d / %d" % (len(fails), len(report["checks"])))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
