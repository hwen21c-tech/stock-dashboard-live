#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""관제탑 11개 전 탭 클릭 경로·오류 전수 점검 (동적 본체 · Playwright)

  python3 scripts/audit_tabs_1116.py [base_url] [--quick]

점검 항목
  1) 400×860 / 884×960 / 1100×800 3해상도 · 11개 탭 렌더
  2) 탭별 가로 넘침(scrollWidth > clientWidth) 0
  3) 콘솔 오류 · 페이지 오류 0
  4) 탭 안의 클릭 요소(카드·신호등 칩·실시간 박스·뉴스 수혜주 칩)를 하나씩 눌러
     ㉠ 엉뚱한 탭으로 튀지 않는지(현재 탭 유지) ㉡ 아무 반응 없는 버튼(dead click) ㉢ JS 오류
결과: stdout 요약 + screenshots/audit_1116/*.png (탭별 상단 캡처)
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

NODE = "/workspace/.local/nodejs/node-v20.18.0-linux-x64/bin/node"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("AUDIT_PORT", "8803"))
BASE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].startswith("http") else f"http://127.0.0.1:{PORT}/"
QUICK = "--quick" in sys.argv
MAX_CLICKS = int(os.environ.get("AUDIT_MAX_CLICKS", "18"))
CLICK_WAIT = int(os.environ.get("AUDIT_CLICK_WAIT", "180"))
# 클릭 경로 점검은 실제 사용 화면(외부 세로 400 · 내부 가로 884)에서만 돌린다(11번 탭은 해상도와 무관)
CLICK_VIEWPORTS = {"400x860", "884x960"}
OUT = os.path.join(ROOT, "screenshots", "audit_1116")
CHROME = "/workspace/.cache/puppeteer/chrome-headless-shell/linux-131.0.6778.204/chrome-headless-shell-linux64/chrome-headless-shell"
VIEWPORTS = [(400, 860), (884, 960), (1100, 800)]
_VPS = os.environ.get("AUDIT_VIEWPORTS")
if _VPS:
    VIEWPORTS = [(int(p.split("x")[0]), int(p.split("x")[1])) for p in _VPS.split(",") if "x" in p]
TABS = [
    ("overview", "1 메인"),
    ("bijoong", "2 비중법사"),
    ("honginki", "3 홍인기"),
    ("supply", "4 수급"),
    ("aftermarket", "5 애프터마켓"),
    ("analysis", "6 심층분석"),
    ("news", "7 뉴스"),
    ("rnzone", "8 RN존"),
    ("manju", "9 만쥬"),
    ("jongbe", "10 종베"),
    ("calendar", "11 증시일정"),
]

CLICK_SEL = ",".join([
    ".stock-tile",
    "article.card",
    ".hi-stock-card",
    ".supply-stock-card",
    ".reason-item",
    ".news-timeline-card",
    ".af-card",
    ".signal-chip",
    ".sp-card",
    ".stock-card",
    ".manju-item",
    ".cal-cell",
    "[data-live='1'][onclick]",
])

MODAL_CLOSERS = [
    "#modalClose", "#cmClose", "#rjClose", "#hiChartClose", ".modal .x", ".modal-close",
    "#hiChartModal .x", "#chartModal .x", ".m-close",
]


def ensure_server():
    try:
        urllib.request.urlopen(BASE, timeout=2)
        return None
    except Exception:
        pass
    proc = subprocess.Popen(
        [NODE, "dev_server.mjs"], cwd=ROOT,
        env={**os.environ, "PORT": str(PORT)},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(80):
        time.sleep(0.3)
        try:
            urllib.request.urlopen(BASE, timeout=1)
            return proc
        except Exception:
            continue
    return proc


JS_CLOSE_MODALS = """
() => {
  const out = [];
  document.querySelectorAll('.modal, .modal-overlay, [class*="modal"]').forEach((m) => {
    const st = getComputedStyle(m);
    const open = m.classList.contains('on') || m.classList.contains('open') || st.display === 'flex';
    if (!open) return;
    m.classList.remove('on'); m.classList.remove('open');
    if (st.display === 'flex' && !m.id.includes('Overlay')) m.style.display = 'none';
    const x = m.querySelector('.x, .close, [onclick*="close"], [onclick*="Close"]');
    if (x) { try { x.click(); } catch (e) {} }
    out.push(m.id || m.className);
  });
  document.querySelectorAll('#pinLockOverlay, [id^="pinLockOverlay"]').forEach((e) => e.remove());
  document.documentElement.classList.remove('pin-locked');
  return out;
}
"""

JS_ACTIVE_VIEW = "() => { const b = document.querySelector('.tab-btn.active'); return b ? (b.dataset.view || b.textContent.trim()) : null; }"

JS_OVERFLOW = """
() => {
  const de = document.documentElement;
  const body = document.body;
  const wide = [];
  const lim = window.innerWidth + 1;
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > lim) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') return;
      wide.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + (el.className || '').toString().slice(0, 40)) + ' right=' + Math.round(r.right));
    }
  });
  return {
    docScroll: de.scrollWidth, docClient: de.clientWidth,
    bodyScroll: body.scrollWidth, bodyClient: body.clientWidth,
    inner: window.innerWidth, wide: wide.slice(0, 8)
  };
}
"""

JS_CANDIDATES = """
([sel, rootId]) => {
  const root = (rootId && document.getElementById(rootId)) || document.body;
  const nodes = Array.from(root.querySelectorAll(sel));
  return nodes.filter((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && cs.display !== 'none' && cs.visibility !== 'hidden' &&
      el.getAttribute('onclick') && !el.closest('[data-audit-skip]');
  }).map((el, i) => {
    el.setAttribute('data-audit-idx', String(i));
    return {
      i,
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().slice(0, 60),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 46),
      onclick: (el.getAttribute('onclick') || '').slice(0, 70),
    };
  });
}
"""

JS_ARM_MUT = """
() => {
  window.__auditMut = 0;
  if (window.__auditObs) { window.__auditObs.disconnect(); }
  window.__auditObs = new MutationObserver((m) => { window.__auditMut += m.length; });
  window.__auditObs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  return true;
}
"""

JS_MUT = "() => window.__auditMut || 0"

JS_CLICK_BY_IDX = """
(i) => {
  const el = document.querySelector('[data-audit-idx="' + i + '"]');
  if (!el) return { ok: false };
  el.scrollIntoView({ block: 'center' });
  try { el.click(); } catch (e) { return { ok: false, err: String(e && e.message) }; }
  return { ok: true };
}
"""


def modal_open(page):
    return page.evaluate(
        """() => {
          const ms = Array.from(document.querySelectorAll('.modal, .modal-overlay, #chartModal, #hiChartModal, #rejModal, #cmWrap, #dartModalOverlay'));
          return ms.some((m) => {
            const st = getComputedStyle(m);
            return m.classList.contains('on') || m.classList.contains('open') || st.display === 'flex';
          });
        }"""
    )


def tab_margin_ok(page):
    return page.evaluate(
        """() => {
          const t = document.querySelector('.tab-btn.active');
          if (!t) return { ok: false, why: 'no active tab' };
          const r = t.getBoundingClientRect();
          return { ok: r.width > 0 && r.height > 0, w: Math.round(r.width), h: Math.round(r.height) };
        }"""
    )


def main():
    proc = ensure_server()
    os.makedirs(OUT, exist_ok=True)
    report = {"base": BASE, "viewports": {}, "console": [], "summary": {}}
    errors_total = 0
    overflow_total = 0
    dead_clicks = []
    wrong_tab = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                executable_path=CHROME,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            for (w, h) in VIEWPORTS:
                ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1,
                                          user_agent="Mozilla/5.0 (Linux; Android 14; SM-F966N) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36")
                page = ctx.new_page()
                logs = []
                page.on("console", lambda m, L=logs: L.append({"type": m.type, "text": m.text[:400]}) if m.type in ("error",) else None)
                page.on("pageerror", lambda e, L=logs: L.append({"type": "pageerror", "text": str(e)[:400]}))
                page.on("response", lambda r, L=logs: L.append({"type": "http", "text": f"{r.status} {r.url[:160]}"}) if r.status >= 400 else None)
                vp_key = f"{w}x{h}"
                report["viewports"][vp_key] = {}
                page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(2500)
                page.evaluate(JS_CLOSE_MODALS)
                for view, label in TABS:
                    page.evaluate("(v) => { if (typeof switchView === 'function') switchView(v, null); }", view)
                    page.wait_for_timeout(900)
                    page.evaluate(JS_CLOSE_MODALS)
                    of = page.evaluate(JS_OVERFLOW)
                    over = of["docScroll"] > of["docClient"] + 1
                    if over:
                        overflow_total += 1
                    try:
                        page.screenshot(path=os.path.join(OUT, f"{vp_key}_{view}.png"))
                    except Exception:
                        pass
                    entry = {"overflow": over, "overflowDetail": of if over else None,
                             "clicks": 0, "dead": [], "wrongTab": [], "errors": []}
                    if not QUICK and vp_key in CLICK_VIEWPORTS:
                        root_id = "tab" + view[:1].upper() + view[1:]
                        cands = page.evaluate(JS_CANDIDATES, [CLICK_SEL, root_id])
                        if len(cands) > MAX_CLICKS:
                            cands = cands[:MAX_CLICKS]
                        entry["clicks"] = len(cands)
                        for c in cands:
                            before = page.evaluate(JS_ACTIVE_VIEW)
                            nlog = len(logs)
                            page.evaluate(JS_ARM_MUT)
                            page.evaluate(JS_CLICK_BY_IDX, c["i"])
                            page.wait_for_timeout(CLICK_WAIT)
                            opened = modal_open(page)
                            after = page.evaluate(JS_ACTIVE_VIEW)
                            mutated = page.evaluate(JS_MUT)
                            if opened:
                                page.evaluate(JS_CLOSE_MODALS)
                                page.wait_for_timeout(120)
                            # 같은 탭 안에서 여는 클릭(카드·칩)인데 탭이 바뀌면 잘못된 이동으로 기록
                            if after != before and view not in ("overview",):
                                wrong_tab.append({"vp": vp_key, "tab": view, "before": before, "after": after,
                                                  "el": c["text"], "onclick": c["onclick"]})
                                entry["wrongTab"].append({"el": c["text"], "after": after})
                                page.evaluate("(v) => { if (typeof switchView === 'function') switchView(v, null); }", view)
                                page.wait_for_timeout(150)
                            new_logs = logs[nlog:]
                            if new_logs:
                                errors_total += len(new_logs)
                                entry["errors"].extend(new_logs)
                            elif not opened and after == before and mutated < 2 and c["onclick"] and "switchView" not in c["onclick"]:
                                dead_clicks.append({"vp": vp_key, "tab": view, "el": c["text"], "onclick": c["onclick"]})
                                entry["dead"].append(c["text"])
                    # 시간 예산: quick 아님이라도 탭당 클릭은 40개까지만
                    report["viewports"][vp_key][view] = entry
                    page.evaluate("(v) => { if (typeof switchView === 'function') switchView(v, null); }", "overview")
                errs = [l for l in logs if l["type"] in ("error", "pageerror", "http")]
                if errs:
                    report["console"].append({"vp": vp_key, "logs": errs[:20]})
                ctx.close()
            browser.close()
    finally:
        if proc is not None:
            proc.terminate()

    report["httpErrors"] = sorted({l["text"] for c in report["console"] for l in c["logs"] if l["type"] == "http"})
    report["summary"] = {
        "overflowCount": overflow_total,
        "deadClicks": len(dead_clicks),
        "wrongTab": len(wrong_tab),
        "consoleErrors": sum(len([l for l in c["logs"] if l["type"] in ("error", "pageerror")]) for c in report["console"]),
        "httpErrors": len(report["httpErrors"]),
    }
    report["deadClicks"] = dead_clicks[:40]
    report["wrongTabs"] = wrong_tab[:40]
    with open(os.path.join(ROOT, "screenshots", "audit_1116", "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(json.dumps(report["summary"], ensure_ascii=False))
    if wrong_tab:
        print("WRONG-TAB:", json.dumps(wrong_tab[:8], ensure_ascii=False))
    if dead_clicks:
        print("DEAD:", json.dumps(dead_clicks[:8], ensure_ascii=False))
    if report["httpErrors"]:
        print("HTTP-ERR:", json.dumps(report["httpErrors"][:6], ensure_ascii=False))
    if report["console"]:
        print("CONSOLE:", json.dumps([c for c in report["console"]][:2], ensure_ascii=False)[:800])
    for vp, tabs in report["viewports"].items():
        for v, e in tabs.items():
            if e["overflow"]:
                print("OVERFLOW", vp, v, json.dumps(e["overflowDetail"], ensure_ascii=False)[:300])


if __name__ == "__main__":
    main()
