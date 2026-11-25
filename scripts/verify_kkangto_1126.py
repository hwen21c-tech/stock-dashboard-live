#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""깡토(#tabKkangto) 미니차트 · 상세 모달(#kkChartModal) 폴드8 세로/가로 점검

· 동적(sd_live/public)은 로컬 서버 + /api 프록시, 정적(deploy_repo)은 그대로 서빙.
· 스크린샷: sd_live/screenshots/kkangto_1126/
사용: python3 sd_live/scripts/verify_kkangto_1126.py [dyn|static]
"""
import json
import os
import sys
import threading
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))       # sd_live
WS = os.path.dirname(ROOT)
SHOTS = os.path.join(ROOT, "screenshots", "kkangto_1126")
UPSTREAM = "https://stock-dashboard-live-6frm.vercel.app"


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


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "dyn"
    if mode == "dyn":
        directory, port, proxy = os.path.join(ROOT, "public"), 8795, True
    else:
        directory, port, proxy = os.path.join(WS, "deploy_repo"), 8796, False
    srv = serve(directory, port, proxy)
    base = "http://127.0.0.1:%d/index.html" % port
    os.makedirs(SHOTS, exist_ok=True)
    report = {"mode": mode, "checks": [], "console": [], "pageerrors": []}

    def ok(name, cond, extra=""):
        report["checks"].append({"name": name, "ok": bool(cond), "extra": extra})
        print(("✅ " if cond else "❌ ") + name + (" — " + str(extra) if extra else ""))

    with sync_playwright() as p:
        b = p.chromium.launch()
        for vp, tag in (({"width": 400, "height": 884}, "400"), ({"width": 892, "height": 412}, "892")):
            ctx = b.new_context(viewport=vp, device_scale_factor=1,
                                is_mobile=tag == "400", has_touch=tag == "400")
            ctx.add_init_script("""try{localStorage.setItem('stock_dashboard_pin_auth','0623_verified');
                sessionStorage.setItem('stock_dashboard_pin_auth','0623_verified');}catch(e){}""")
            page = ctx.new_page()
            page.on("console", lambda m: report["console"].append({"type": m.type, "text": m.text[:260]})
                    if m.type == "error" else None)
            page.on("pageerror", lambda e: report["pageerrors"].append(str(e)[:260]))
            page.goto(base, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(4500)
            page.click('[data-quick="kkangto"]')
            page.wait_for_timeout(1500)

            n_cards = page.eval_on_selector_all("#tabKkangto .kk-card", "e => e.length")
            ok("[%s] 깡토 카드 생성" % tag, n_cards > 0, n_cards)
            overflow = page.evaluate("""() => {
                const v = document.getElementById('tabKkangto');
                return { sw: v.scrollWidth, cw: v.clientWidth,
                         mini: Array.from(document.querySelectorAll('#tabKkangto canvas.kk-mini'))
                                 .slice(0,6).map(c => ({w: Math.round(c.getBoundingClientRect().width),
                                                        h: Math.round(c.getBoundingClientRect().height),
                                                        attrW: c.getAttribute('width')})) };
            }""")
            ok("[%s] 깡토 탭 가로 넘침 없음" % tag, overflow["sw"] <= overflow["cw"] + 2, overflow)
            ok("[%s] 깡토 미니차트 크기 정상(폭>60, 높이 40~220)" % tag,
               all(60 < m["w"] <= 400 and 40 < m["h"] <= 220 for m in overflow["mini"]), overflow["mini"])

            page.eval_on_selector("#tabKkangto .kk-card", "e => e.scrollIntoView({block:'center'})")
            page.wait_for_timeout(400)
            page.screenshot(path=os.path.join(SHOTS, "kk_tab_%s.png" % tag))

            page.click("#tabKkangto .kk-card")
            page.wait_for_timeout(1200)
            st = page.evaluate("""() => {
                const m = document.getElementById('kkChartModal');
                if (!m) return {open: false};
                const back = document.body;
                const cs = getComputedStyle(m);
                const box = m.querySelector('.kk-box');
                const cv = m.querySelector('canvas');
                const r = box ? box.getBoundingClientRect() : null;
                const cr = cv ? cv.getBoundingClientRect() : null;
                return {
                  open: m.classList.contains('on') || cs.display !== 'none',
                  disp: cs.display, z: cs.zIndex,
                  boxW: r ? Math.round(r.width) : 0, boxH: r ? Math.round(r.height) : 0,
                  boxTop: r ? Math.round(r.top) : 0, boxBottom: r ? Math.round(r.bottom) : 0,
                  canvasW: cr ? Math.round(cr.width) : 0, canvasH: cr ? Math.round(cr.height) : 0,
                  vpH: window.innerHeight, vpW: window.innerWidth,
                  bodyOverflowX: back.scrollWidth - back.clientWidth,
                  title: (document.getElementById('kkModalTitle')||{}).textContent || '',
                  levels: document.querySelectorAll('#kkModalLevels .o').length,
                  legend: document.querySelectorAll('#kkModalLegend *').length
                };
            }""")
            ok("[%s] 깡토 카드 클릭 → 상세 모달 열림" % tag, st.get("open"), st)
            ok("[%s] 모달이 화면 안(위·아래 잘림 없음)" % tag,
               st.get("boxTop", -1) >= 0 and st.get("boxBottom", 9999) <= st.get("vpH", 0) + 1, st)
            ok("[%s] 모달 폭 화면 이하" % tag, 0 < st.get("boxW", 0) <= st.get("vpW", 0), st)
            ok("[%s] 모달 캔버스 높이 160~420" % tag, 160 <= st.get("canvasH", 0) <= 420,
               {"w": st.get("canvasW"), "h": st.get("canvasH")})
            ok("[%s] 모달 가로 스크롤 없음" % tag, st.get("bodyOverflowX", 1) <= 1, st.get("bodyOverflowX"))
            page.screenshot(path=os.path.join(SHOTS, "kk_modal_%s.png" % tag))
            # 모달 내부 스크롤(레벨 카드 확인)
            page.evaluate("() => { const b=document.querySelector('#kkChartModal .kk-box'); if(b) b.scrollTop = b.scrollHeight; }")
            page.wait_for_timeout(300)
            page.screenshot(path=os.path.join(SHOTS, "kk_modal_bottom_%s.png" % tag))
            page.evaluate("() => { const b=document.querySelector('#kkChartModal .kk-box'); if(b) b.scrollTop = 0; }")
            # 닫기
            try:
                page.click("#kkChartModal .kk-x")
            except Exception:
                page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            closed = page.evaluate("() => { const m=document.getElementById('kkChartModal'); return !m || getComputedStyle(m).display==='none' || !m.classList.contains('on'); }")
            ok("[%s] 모달 닫기" % tag, closed)
            ctx.close()
        b.close()

    print("\n--- 콘솔 error %d건 / pageerror %d건 ---" % (len(report["console"]), len(report["pageerrors"])))
    for e in report["console"][:10]:
        print("  ·", e["text"][:150])
    for e in report["pageerrors"][:6]:
        print("  ‼", e[:150])
    with open(os.path.join(SHOTS, "%s_report.json" % mode), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    srv.shutdown()
    fails = [c for c in report["checks"] if not c["ok"]]
    print("실패 체크: %d / %d" % (len(fails), len(report["checks"])))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
