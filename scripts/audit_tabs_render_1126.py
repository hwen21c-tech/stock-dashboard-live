#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""전 탭 렌더링·죽은 버튼·옛날 잔재 런타임 감사 (폴드8 세로 400 · 가로 892)

점검 항목
  ① 12개 화면(퀵 버튼) 순회 — 화면마다 콘솔 error / pageerror 증가분
  ② 화면마다 가로 넘침(scrollWidth > clientWidth+2) · 빈 화면(내용 20자 미만)
  ③ '동적 대기' 같은 옛 로딩 문구가 화면에 남아 있는지
  ④ onclick 이 부르는 전역 객체/함수가 실제로 존재하는지(죽은 버튼)
  ⑤ 화면에 보이는 옛 날짜 리터럴(2026-10-xx 이하) 개수
  ⑥ 이번 수정 계약 — #stratDetailModal 순서(①→②→③→④)·폭 780·차트 280~300

사용: python3 sd_live/scripts/audit_tabs_render_1126.py [dyn|static]
"""
import json
import os
import re
import sys
import threading
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))       # sd_live
WS = os.path.dirname(ROOT)
SHOTS = os.path.join(ROOT, "screenshots", "audit_1126")
UPSTREAM = "https://stock-dashboard-live-bice.vercel.app"

VIEWS = ["main", "honginki", "bijoong", "kkangto", "manju", "jongbe", "rnzone",
         "supply", "aftermarket", "analysis", "news", "calendar", "ipo"]

DEAD_PARSE = re.compile(r"^\s*([A-Za-z_$][\w$]*)\s*(?:\.\s*([A-Za-z_$][\w$]*))?\s*\(")


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
            req = urllib.request.Request(UPSTREAM + self.path, headers={"User-Agent": "audit"})
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


DEAD_JS = """() => {
  const bad = [];
  const seen = {};
  document.querySelectorAll('[onclick]').forEach(el => {
    const code = el.getAttribute('onclick') || '';
    const m = code.match(/^\\s*([A-Za-z_$][\\w$]*)\\s*(?:\\.\\s*([A-Za-z_$][\\w$]*))?\\s*\\(/);
    if (!m) return;
    const root = m[1], prop = m[2];
    const KW = ['if','for','while','switch','return','typeof','event','this','void','new','delete'];
    if (KW.indexOf(root) !== -1) return;
    let ok = false;
    try {
      if (prop) { const o = window[root]; ok = !!o && (typeof o[prop] === 'function' || typeof o[prop] === 'undefined' || o[prop] !== null); }
      else { ok = typeof window[root] === 'function'; }
    } catch (e) { ok = false; }
    if (!ok) {
      const key = root + (prop ? '.' + prop : '');
      if (!seen[key]) { seen[key] = 1;
        bad.push({call: key, tag: el.tagName, id: el.id || '', text: (el.textContent || '').trim().slice(0, 40)}); }
    }
  });
  return bad;
}"""

STATE_JS = """(sel) => {
  const v = document.querySelector(sel);
  if (!v) return {exists: false};
  const t = (v.innerText || '').replace(/\\s+/g, ' ').trim();
  const vis = el => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
  };
  const loading = [];
  v.querySelectorAll('*').forEach(el => {
    if (!el.children.length && vis(el)) {
      const s = (el.textContent || '').trim();
      if (s && /동적 대기|불러오는 중|로딩 중|데이터 없음 \\(대기\\)/.test(s)) loading.push(s.slice(0, 40));
    }
  });
  const oldDates = (t.match(/2026-(?:0[1-9]|10)-\\d{2}/g) || []);
  return {
    exists: true, len: t.length, head: t.slice(0, 90),
    overflowX: v.scrollWidth - v.clientWidth,
    loading: loading.slice(0, 6),
    oldDates: Array.from(new Set(oldDates)).slice(0, 8),
    cards: v.querySelectorAll('.stock-card, .kk-card, .mj-screener-card, .strategy-card').length
  };
}"""


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "dyn"
    if mode == "dyn":
        directory, port, proxy = os.path.join(ROOT, "public"), 8797, True
    else:
        directory, port, proxy = os.path.join(WS, "deploy_repo"), 8798, False
    srv = serve(directory, port, proxy)
    base = "http://127.0.0.1:%d/index.html" % port
    os.makedirs(SHOTS, exist_ok=True)
    report = {"mode": mode, "views": [], "console": [], "pageerrors": [], "dead": []}

    def put(name, cond, extra=""):
        print(("✅ " if cond else "❌ ") + name + (" — " + str(extra) if extra else ""))

    with sync_playwright() as p:
        b = p.chromium.launch()
        for vp, tag in (({"width": 400, "height": 884}, "400"), ({"width": 892, "height": 412}, "892")):
            ctx = b.new_context(viewport=vp, device_scale_factor=1,
                                is_mobile=tag == "400", has_touch=tag == "400")
            ctx.add_init_script("""try{localStorage.setItem('stock_dashboard_pin_auth','0623_verified');
                sessionStorage.setItem('stock_dashboard_pin_auth','0623_verified');}catch(e){}""")
            page = ctx.new_page()
            errs = []
            page.on("console", lambda m: (errs.append(m.text[:200]) if m.type == "error" else None))
            page.on("pageerror", lambda e: errs.append("PAGEERROR " + str(e)[:200]))
            page.goto(base, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(5000)

            for view in VIEWS:
                before = len(errs)
                sel = '[data-quick="%s"]' % view
                try:
                    page.click(sel)
                except Exception:  # 화면에 없는 버튼
                    continue
                page.wait_for_timeout(900)
                tab = {"main": "#tabOverview"}.get(view, None)
                if not tab:
                    tab = page.evaluate("""(v) => {
                        const map = {honginki:'#tabHonginki', bijoong:'#tabBijoong', kkangto:'#tabKkangto',
                          manju:'#tabManju', jongbe:'#tabJongbe', rnzone:'#tabRnzone', supply:'#tabSupply',
                          aftermarket:'#tabAftermarket', analysis:'#tabAnalysis', news:'#tabNews',
                          calendar:'#tabCalendar', ipo:'#tabIpo'};
                        return map[v] || null; }""", view) or "#tabOverview"
                st = page.evaluate(STATE_JS, tab)
                st.update({"view": view, "tag": tag, "newErrors": errs[before:]})
                report["views"].append(st)
                flags = []
                if not st.get("exists"):
                    flags.append("컨테이너 없음")
                if st.get("overflowX", 0) > 2:
                    flags.append("가로넘침 %d" % st["overflowX"])
                if st.get("len", 0) < 20:
                    flags.append("빈 화면")
                if st.get("loading"):
                    flags.append("옛 로딩문구 %s" % st["loading"])
                if st["newErrors"]:
                    flags.append("콘솔err %d" % len(st["newErrors"]))
                put("[%s] %-11s len=%5d cards=%2d" % (tag, view, st.get("len", 0), st.get("cards", 0)),
                    not flags, " · ".join(flags) if flags else st.get("oldDates") or "")

            dead = page.evaluate(DEAD_JS)
            for d in dead:
                d["tag"] = tag
            report["dead"].extend(dead)
            put("[%s] 죽은 onclick 없음" % tag, not dead, dead[:6])
            page.click('[data-quick="rnzone"]')
            page.wait_for_timeout(800)
            page.evaluate("() => window.scrollTo(0,0)")
            page.screenshot(path=os.path.join(SHOTS, "tabs_%s.png" % tag))
            report["console"].extend(errs)
            ctx.close()

        # 이번 수정 계약 — 모달 골격
        ctx = b.new_context(viewport={"width": 400, "height": 884}, is_mobile=True, has_touch=True)
        ctx.add_init_script("""try{localStorage.setItem('stock_dashboard_pin_auth','0623_verified');
            sessionStorage.setItem('stock_dashboard_pin_auth','0623_verified');}catch(e){}""")
        page = ctx.new_page()
        page.goto(base, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4500)
        page.click('[data-quick="jongbe"]')
        page.wait_for_timeout(900)
        page.click("#tabJongbe .stock-card[data-code]")
        page.wait_for_timeout(1200)
        contract = page.evaluate("""() => {
            const b = document.getElementById('stratDetailModal');
            if (!b) return {ok: false};
            const body = b.querySelector('.sdm-body');
            const order = body ? Array.from(body.children).map(e => (e.id || e.className || e.tagName)) : [];
            const panel = b.querySelector('.sdm-panel');
            const cv = b.querySelector('.canvas-container');
            const leg = b.querySelector('.chart-legend');
            const btn = b.querySelector('.cbtn');
            return {
              ok: true, order: order,
              width: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
              chartH: cv ? Math.round(cv.getBoundingClientRect().height) : 0,
              legendItems: leg ? leg.querySelectorAll('.legend-item').length : 0,
              legendDots: leg ? Array.from(leg.querySelectorAll('.dot')).filter(d => d.getBoundingClientRect().width >= 6).length : 0,
              btnBg: btn ? getComputedStyle(btn).backgroundColor : '',
              has1: !!b.querySelector('#sdmNews .sdm-h'), has4: !!b.querySelector('#sdmRule .sdm-h')
            };
        }""")
        order = contract.get("order") or []
        put("[계약] ④ 섹션 순서 ①→②→③→④",
            len(order) >= 5 and order[0] == "sdmNews" and order[1] == "sdmFacts"
            and "sdm-chart" in order[2] and order[3] == "sdmRule", order)
        put("[계약] 모달 폭 780 이하", 0 < contract.get("width", 0) <= 780, contract.get("width"))
        put("[계약] 차트 높이 280~320", 280 <= contract.get("chartH", 0) <= 320, contract.get("chartH"))
        put("[계약] 범례 가로 배치·색 점 표시",
            contract.get("legendItems", 0) >= 6 and contract.get("legendDots", 0) >= 6,
            {"items": contract.get("legendItems"), "dots": contract.get("legendDots")})
        put("[계약] 툴바 버튼 다크(#1e293b 근처)",
            contract.get("btnBg", "").startswith("rgb(30, 41, 59)") or contract.get("btnBg", "").startswith("rgba(255, 255, 255"),
            contract.get("btnBg"))
        ctx.close()
        b.close()

    srv.shutdown()
    with open(os.path.join(SHOTS, "%s_report.json" % mode), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print("\n콘솔/페이지 오류 %d건" % len(report["console"]))
    for e in report["console"][:10]:
        print("  ·", e[:140])
    return 0


if __name__ == "__main__":
    sys.exit(main())
