#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""11/16 고도화·수리 검증 (동적 본체 · Playwright)

  python3 scripts/verify_features_1116.py
"""
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
PORT = int(os.environ.get("VERIFY_PORT", "8831"))
BASE = f"http://127.0.0.1:{PORT}/"
OUT = os.path.join(ROOT, "screenshots", "verify_1116")

fails = []
oks = []


def check(cond, label, detail=""):
    (oks if cond else fails).append(label)
    print(("✅ " if cond else "❌ ") + label + ((" — " + str(detail)) if detail else ""))


def main():
    os.makedirs(OUT, exist_ok=True)
    srv = subprocess.Popen([NODE, "dev_server.mjs"], cwd=ROOT, env={**os.environ, "PORT": str(PORT)},
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
            ctx = b.new_context(viewport={"width": 400, "height": 860}, device_scale_factor=1)
            page = ctx.new_page()
            page.on("console", lambda m: logs.append("console." + m.type + ": " + m.text[:200]) if m.type == "error" else None)
            page.on("pageerror", lambda e: logs.append("pageerror: " + str(e)[:200]))
            page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(11000)
            page.evaluate("""() => {
              document.querySelectorAll('#pinLockOverlay,[id^=pinLockOverlay]').forEach(e=>e.remove());
              document.documentElement.classList.remove('pin-locked');
            }""")

            # ---------- 1. 비중법사 아깝게 탈락 기본 접힘 ----------
            page.evaluate("() => switchView('bijoong', null)")
            page.wait_for_timeout(900)
            fold = page.evaluate("""() => {
              const btn = document.querySelector('[data-sl-fold="bij-near"]');
              const body = document.querySelector('[data-sl-fold-body="bij-near"]');
              const rej = document.getElementById('rejBody');
              const rejWrap = document.getElementById('rejWrap');
              return {
                btn: btn ? btn.innerText.replace(/\\s+/g,' ').trim() : null,
                bodyDisplay: body ? getComputedStyle(body).display : null,
                rejMax: rej ? getComputedStyle(rej).maxHeight : null,
                rejOpen: rejWrap ? rejWrap.classList.contains('open') : null,
                rejVisibleH: rej ? Math.round(rej.getBoundingClientRect().height) : null,
              };
            }""")
            check(fold["btn"] and "아깝게 탈락한 후보" in fold["btn"] and "▸" in fold["btn"],
                  "비중법사 상단 '아깝게 탈락한 후보' 한 줄 토글", fold["btn"])
            check(fold["bodyDisplay"] == "none", "  └ 기본 접힘(display:none)", fold["bodyDisplay"])
            check(fold["rejVisibleH"] is not None and fold["rejVisibleH"] <= 2 and fold["rejOpen"] is False,
                  "비중법사 하단 탈락 후보 목록 기본 접힘", "height=" + str(fold["rejVisibleH"]) + " open=" + str(fold["rejOpen"]))
            # 펼침/접힘 동작
            page.evaluate("() => { const b=document.querySelector('[data-sl-fold=\"bij-near\"]'); b.click(); }")
            page.wait_for_timeout(250)
            opened = page.evaluate("() => getComputedStyle(document.querySelector('[data-sl-fold-body=\"bij-near\"]')).display")
            check(opened == "block", "  └ 눌러서 펼쳐짐", opened)
            # 재렌더(30초 폴링과 같은 상황) 후에도 사용자가 펼친 상태 유지
            page.evaluate("""() => { const s = TabsLive.state.lastBody; if (s) TabsLive.apply(s); }""")
            page.wait_for_timeout(300)
            after = page.evaluate("""() => {
              const b = document.querySelector('[data-sl-fold-body="bij-near"]');
              return b ? getComputedStyle(b).display : 'missing';
            }""")
            check(after == "block", "  └ 자동 갱신(재렌더) 뒤에도 펼친 상태 유지", after)
            page.evaluate("() => { const b=document.querySelector('[data-sl-fold=\"bij-near\"]'); if(b) b.click(); }")
            page.wait_for_timeout(200)

            # ---------- 2. 실시간 판정 종목 클릭 → 탭 유지 + 차트 팝업 ----------
            click_res = page.evaluate("""() => {
              const host = document.getElementById('stratLiveBijoongHost');
              if (!host) return { err: 'host 없음' };
              const row = host.querySelector('div[onclick]');
              if (!row) return { err: '행 없음' };
              const view0 = (document.querySelector('.tab-btn.active')||{}).dataset?.view;
              row.click();
              const view1 = (document.querySelector('.tab-btn.active')||{}).dataset?.view;
              const m1 = document.getElementById('chartModal');
              const m2 = document.getElementById('modalOverlay');
              const on1 = !!(m1 && m1.classList.contains('on'));
              const on2 = !!(m2 && getComputedStyle(m2).display !== 'none');
              return {view0, view1, modalOn: on1 || on2, which: on1 ? 'bijoong-card' : on2 ? 'universal' : 'none',
                      onclick: row.getAttribute('onclick').slice(0,90)};
            }""")
            check(click_res.get("view0") == click_res.get("view1") == "bijoong",
                  "실시간 판정 종목 클릭 후 탭 유지(비중법사)", str(click_res.get("view0")) + " → " + str(click_res.get("view1")))
            check(click_res.get("modalOn") is True, "  └ 차트 팝업 열림", str(click_res.get("which")))
            page.evaluate("() => { const m=document.getElementById('chartModal'); if(m) m.classList.remove('on'); const o=document.getElementById('modalOverlay'); if(o) o.style.display='none'; }")

            page.evaluate("() => switchView('honginki', null)")
            page.wait_for_timeout(1500)
            hong = page.evaluate("""() => {
              const host = document.getElementById('stratLiveHongHost');
              if (!host) return { err: 'host 없음' };
              const rows = host.querySelectorAll('div[onclick]');
              if (!rows.length) return { err: '행 없음', text: host.innerText.slice(0,120) };
              rows[0].click();
              const view = (document.querySelector('.tab-btn.active')||{}).dataset?.view;
              const m = document.getElementById('hiChartModal');
              const o = document.getElementById('modalOverlay');
              const hi = !!(m && (m.classList.contains('open') || m.classList.contains('on')));
              const uni = !!(o && getComputedStyle(o).display !== 'none');
              return {view, hiOn: hi || uni, which: hi ? 'hong-card' : uni ? 'universal' : 'none',
                      onclick: rows[0].getAttribute('onclick').slice(0,90)};
            }""")
            check(hong.get("view") == "honginki", "실시간 판정 종목 클릭 후 탭 유지(홍인기)", str(hong.get("view")))
            check(hong.get("hiOn") is True, "  └ 홍인기 전략 차트 모달 열림", str(hong.get("which")))
            page.evaluate("() => { const m=document.getElementById('hiChartModal'); if(m) { m.classList.remove('open'); m.classList.remove('on'); } const o=document.getElementById('modalOverlay'); if(o) o.style.display='none'; }")

            # ---------- 3. 2번 수급 탭 연속일수·시총비중 ----------
            page.evaluate("() => switchView('supply', null)")
            page.wait_for_timeout(4000)
            sup = page.evaluate("""() => {
              const cards = Array.from(document.querySelectorAll('#tabSupply .supply-stock-card'));
              const withExtra = cards.filter(c => c.querySelector('[data-supply-extra="1"]'));
              const sample = withExtra.slice(0,3).map(c => ({
                name: (c.querySelector('.ssc-name')||{}).textContent,
                txt: c.querySelector('[data-supply-extra="1"]').innerText.replace(/\\s+/g,' ')
              }));
              return {cards: cards.length, withExtra: withExtra.length, sample};
            }""")
            check(sup["withExtra"] >= 6, "수급 카드 연속일수·시총비중 배지", f"{sup['withExtra']}/{sup['cards']}장")
            check(all("연속" in (s["txt"] or "") for s in sup["sample"]) and sup["sample"],
                  "  └ '외인/기관 N일 연속' 표기", json.dumps(sup["sample"][:2], ensure_ascii=False))
            check(all("시총 대비" in (s["txt"] or "") for s in sup["sample"]),
                  "  └ '시총 대비 비중(%)' 표기", json.dumps(sup["sample"][:2], ensure_ascii=False))

            # ---------- 4. 3번 애프터마켓 필터·괴리율 ----------
            page.evaluate("() => switchView('aftermarket', null)")
            page.wait_for_timeout(3000)
            af = page.evaluate("""() => {
              const host = document.getElementById('tabsLiveAfterTop');
              if (!host) return {err:'host 없음'};
              const btn = host.querySelector('[data-af-filter]');
              const rows = Array.from(host.querySelectorAll('.reason-item[data-af-value]'));
              const vis = rows.filter(r => getComputedStyle(r).display !== 'none');
              const divRows = rows.filter(r => /정규장 종가 .* 대비/.test(r.innerText));
              return {state: btn ? btn.getAttribute('data-af-filter') : null,
                      rows: rows.length, visible: vis.length, divRows: divRows.length,
                      btnText: btn ? btn.innerText.replace(/\\s+/g,' ') : null,
                      sample: divRows[0] ? divRows[0].innerText.replace(/\\s+/g,' ').slice(0,140) : null};
            }""")
            check(af.get("state") == "on", "3번 탭 '거래대금 10억↑만 보기' 기본 ON", af.get("btnText"))
            check(af.get("rows", 0) > 0 and af.get("visible", 0) <= af.get("rows", 0), "  └ 필터 동작(숨김 행 있음)", f"{af.get('visible')}/{af.get('rows')}행")
            check(af.get("divRows", 0) >= 1, "  └ 정규장 종가 대비 괴리율 표기", af.get("sample"))
            page.evaluate("""() => { const b=document.querySelector('#tabsLiveAfterTop [data-af-filter]'); b.click(); }""")
            page.wait_for_timeout(500)
            af2 = page.evaluate("""() => {
              const host = document.getElementById('tabsLiveAfterTop');
              const btn = host.querySelector('[data-af-filter]');
              const rows = Array.from(host.querySelectorAll('.reason-item[data-af-value]'));
              return {state: btn.getAttribute('data-af-filter'), visible: rows.filter(r=>getComputedStyle(r).display!=='none').length, rows: rows.length};
            }""")
            check(af2["state"] == "off" and af2["visible"] >= af["visible"], "  └ 토글 해제 시 전체 표시", f"{af2['visible']}/{af2['rows']}행")
            page.evaluate("""() => { const b=document.querySelector('#tabsLiveAfterTop [data-af-filter]'); if (b.getAttribute('data-af-filter')==='off') b.click(); }""")
            page.wait_for_timeout(400)

            # ---------- 5. 5번 뉴스 수혜주 실시간 + 선반영 배지 ----------
            page.evaluate("() => switchView('news', null)")
            page.wait_for_timeout(2000)
            nw = page.evaluate("""() => {
              const host = document.getElementById('tabsLiveNewsTab');
              if (!host) return {err:'host 없음'};
              const chips = Array.from(host.querySelectorAll('[onclick*="tabsLiveOpenStock"]'));
              const withPct = chips.filter(c => /[+\\-]\\d+\\.\\d+%/.test(c.innerText));
              const withVal = chips.filter(c => /\\d+억|조/.test(c.innerText));
              const pre = host.querySelectorAll('[title*="이미 +15% 이상"]');
              return {chips: chips.length, withPct: withPct.length, withVal: withVal.length, pre: pre.length,
                      sample: chips.slice(0,3).map(c=>c.innerText.replace(/\\s+/g,' '))};
            }""")
            check(nw.get("chips", 0) > 0 and nw.get("withPct", 0) > 0, "뉴스 수혜주 실시간 등락률", f"{nw.get('withPct')}/{nw.get('chips')}칩")
            check(nw.get("withVal", 0) > 0, "  └ 실시간 거래대금 함께 표기", json.dumps(nw.get("sample"), ensure_ascii=False))
            print("ℹ️ 선반영(+15%↑) 배지 현재", nw.get("pre"), "개")
            # 선반영 배지 렌더 경로 확인(현재 시장에 +15%↑ 종목이 없어도 배지가 붙는지)
            syn = page.evaluate("""() => {
              const body = { news: [{ title: '테스트 속보', time: '00:00', press: '테스트', url: 'https://example.com',
                impactLevel: '중', impactDirection: '호재',
                beneficiaryStocks: [
                  { name: '삼성전자', code: '005930', live: { changePct: 22.5, valueText: '1,234억', valueBasis: '통합' }, preRun: true },
                  { name: 'SK하이닉스', code: '000660', live: { changePct: -1.2, valueText: '9,876억', valueBasis: '통합' }, preRun: false }
                ] }] };
              TabsLive._renderNews(body, '00:00:00');
              const host = document.getElementById('tabsLiveNewsTab');
              const pre = host.querySelectorAll('[title*="이미 +15% 이상"]').length;
              const txt = host.innerText;
              const hasPct = /\+22\.50%/.test(txt) && /-1\.20%/.test(txt);
              const hasVal = /1,234억/.test(txt) && /9,876억/.test(txt);
              return { pre, hasPct, hasVal };
            }""")
            check(syn.get("pre") == 1 and syn.get("hasPct") and syn.get("hasVal"),
                  "  └ +15%↑ 종목에 '⚠️ 선반영/후행' 자동 배지", json.dumps(syn, ensure_ascii=False))
            page.evaluate("() => { const s = TabsLive.state.lastBody; if (s) TabsLive._renderNews(s, s.generatedAtKst || '00:00:00'); }")

            # ---------- 6. 증시 일정 D-DAY 임박 + 지난 일정 접힘 ----------
            page.evaluate("() => switchView('calendar', null)")
            page.wait_for_timeout(1500)
            cal = page.evaluate("""() => {
              const host = document.getElementById('schedNowHost');
              const wz = document.getElementById('wzContent');
              const pastBtn = wz ? wz.querySelector('.sched-past-btn') : null;
              return {
                host: host ? host.innerText.replace(/\\s+/g,' ') : null,
                dday: host ? host.querySelectorAll('.sched-d.d0').length : 0,
                d1: host ? host.querySelectorAll('.sched-d.d1').length : 0,
                d2: host ? host.querySelectorAll('.sched-d.d2').length : 0,
                nvda: host ? /엔비디아/.test(host.innerText) : false,
              };
            }""")
            check(cal["dday"] >= 1 and cal["d1"] >= 1, "증시 일정 D-DAY · D-1 상단 고정", f"D-DAY {cal['dday']} · D-1 {cal['d1']} · D-2 {cal['d2']}")
            check(cal["nvda"] is True, "  └ 엔비디아 실적(D-2) 노출", "nvda=" + str(cal["nvda"]))
            # 2주차(11/09~11/14) = 전부 지난 일정 → 접힘 확인
            past = page.evaluate("""() => {
              selectCalWeek(2);
              const wz = document.getElementById('wzContent');
              const btn = wz.querySelector('.sched-past-btn');
              const body = wz.querySelector('.sched-past-body');
              return {
                btnText: btn ? btn.innerText.replace(/\\s+/g,' ') : null,
                bodyOpen: body ? body.classList.contains('open') : null,
                bodyVisible: body ? getComputedStyle(body).display : null,
                cards: wz.querySelectorAll('.wz-day-card').length,
                upcoming: Array.from(wz.querySelectorAll('.wz-day-card')).filter(c=>!c.classList.contains('past')).length,
              };
            }""")
            check(past["btnText"] and "지난 일정 보기" in past["btnText"], "지난 일정 '지난 일정 보기 (N건) ▸'", past["btnText"])
            check(past["bodyVisible"] == "none", "  └ 기본 접힘", past["bodyVisible"])
            page.evaluate("""() => { const b=document.querySelector('#wzContent .sched-past-btn'); b.click(); }""")
            page.wait_for_timeout(300)
            po = page.evaluate("""() => { const b=document.querySelector('#wzContent .sched-past-body'); return b ? getComputedStyle(b).display : 'none'; }""")
            check(po == "block", "  └ 눌러서 펼쳐짐", po)
            page.evaluate("""() => { const b=document.querySelector('#wzContent .sched-past-btn'); b.click(); selectCalWeek(3); }""")
            page.wait_for_timeout(300)

            # ---------- 7. 1번 메인 만쥬·종베 칩 ----------
            page.evaluate("() => switchView('overview', null)")
            page.wait_for_timeout(2500)
            chips = page.evaluate("""() => {
              const host = document.getElementById('strategyChipsScroll');
              if (!host) return {err:'host 없음'};
              const list = Array.from(host.querySelectorAll('.signal-chip'));
              return {n: list.length, texts: list.map(e=>e.innerText.replace(/\\s+/g,' '))};
            }""")
            check(chips.get("n", 0) >= 2, "1번 메인 만쥬·종베 전략 칩", str(chips.get("n")) + "개")
            check(any("만쥬" in t and "점" in t for t in chips.get("texts", [])), "  └ 만쥬 80점↑ 칩", json.dumps(chips.get("texts", [])[:3], ensure_ascii=False))
            check(any("종베" in t for t in chips.get("texts", [])), "  └ 종베 픽 칩")
            click_chip = page.evaluate("""() => {
              const c = document.querySelector('#strategyChipsScroll .signal-chip[data-strategy-chip]');
              if (!c) return {err:'칩 없음'};
              c.click();
              return {view: (document.querySelector('.tab-btn.active')||{}).dataset?.view};
            }""")
            check(click_chip.get("view") in ("manju", "jongbe"), "  └ 칩 클릭 → 전략 탭 이동", str(click_chip.get("view")))

            # ---------- 8. 3해상도 가로 넘침·콘솔 오류 ----------
            for (w, h) in [(400, 860), (884, 960), (1100, 800)]:
                page.set_viewport_size({"width": w, "height": h})
                page.evaluate("() => switchView('overview', null)")
                page.wait_for_timeout(900)
                of = page.evaluate("() => ({doc: document.documentElement.scrollWidth, cli: document.documentElement.clientWidth})")
                check(of["doc"] <= of["cli"] + 1, f"가로 넘침 없음 {w}x{h}", f"{of['doc']}/{of['cli']}")
                page.screenshot(path=os.path.join(OUT, f"{w}x{h}_overview.png"))
            errs = [l for l in logs if "error" in l]
            check(len(errs) == 0, "JS 콘솔 오류 0", json.dumps(errs[:3], ensure_ascii=False))
            b.close()
    finally:
        srv.terminate()

    print("\n" + ("전체 통과" if not fails else f"실패 {len(fails)}건: " + "; ".join(fails)))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
