# -*- coding: utf-8 -*-
"""🌙·⚡ 관제탑 실측 검증 — 폴드8 외부액정(400×884)에서
   ① 1번 탭 '⚡ 오늘 장중매매 후보' 박스 ② 8번 탭 '신정재 4대 패턴·도해·엔벨로프·6대 팁'을 열어
   콘솔 에러 0건과 스크린샷을 남긴다.
"""
import sys
import json
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8788/'
TAG = sys.argv[2] if len(sys.argv) > 2 else 'local'
OUT = '/workspace/sd_live/screenshots/jb4'

errors = []
console = []


def run():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctxb = browser.new_context(viewport={'width': 400, 'height': 884}, device_scale_factor=2)
        page = ctxb.new_page()
        # PIN 9035 잠금은 화면만 가린다 — 검증용으로 통과 상태를 심는다(데이터·탭 동작은 그대로).
        page.add_init_script("try { localStorage.setItem('stock_dashboard_pin_auth', '0623_verified'); } catch(e) {}")
        page.on('console', lambda m: (console.append(f'{m.type}: {m.text}'), errors.append(m.text) if m.type == 'error' else None))
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        failed = []
        page.on('response', lambda r: failed.append(f'{r.status} {r.url}') if r.status >= 400 else None)
        page.goto(BASE, wait_until='domcontentloaded', timeout=60000)
        page.wait_for_timeout(2500)

        # 1번 탭 — 장중매매 박스
        box = page.query_selector('#intradayHongBox')
        print('intradayHongBox?', bool(box))
        if box:
            page.evaluate("document.getElementById('intradayHongBox').scrollIntoView({block:'start'})")
            # /api/tabs-live 응답(≈6초)을 기다린다 — 로딩 배지가 바뀔 때까지
            for _ in range(40):
                page.wait_for_timeout(500)
                txt = page.evaluate("(document.getElementById('ihGateBadge')||{}).textContent || ''")
                if '로딩' not in txt:
                    break
            page.wait_for_timeout(600)
            info = page.evaluate("""() => {
              const b = document.getElementById('intradayHongBox');
              return {
                gate: (document.getElementById('ihGateLine')||{}).textContent,
                badge: (document.getElementById('ihGateBadge')||{}).textContent,
                time: (document.getElementById('ihTimeBadge')||{}).textContent,
                cards: b.querySelectorAll('.op-card').length,
                chips: b.querySelectorAll('.op-chip').length,
                note: (document.getElementById('ihNote')||{}).textContent.slice(0, 160),
                principle: (document.getElementById('ihPrinciple')||{}).textContent.slice(0, 200),
              };
            }""")
            print('BOX:', json.dumps(info, ensure_ascii=False))
            page.screenshot(path=f'{OUT}/{TAG}_ih_leader_400.png')
            # 하락장 역발상 트랙
            page.click('#ihTabDown')
            page.wait_for_timeout(900)
            down = page.evaluate("""() => ({
              cards: document.querySelectorAll('#ihBody .op-card').length,
              note: (document.getElementById('ihNote')||{}).textContent.slice(0,200),
              chips: Array.from(document.querySelectorAll('#ihBody .op-chip')).slice(0,10).map(x=>x.textContent)
            })""")
            print('DOWN:', json.dumps(down, ensure_ascii=False))
            page.screenshot(path=f'{OUT}/{TAG}_ih_down_400.png')
            page.click('#ihTabLeader')
            page.wait_for_timeout(400)

        # 8번 탭
        page.evaluate("switchView('jongbe', null)")
        page.wait_for_timeout(2200)
        page.evaluate("document.querySelector('#tabJongbe .sec-head').scrollIntoView({block:'start'})")
        page.wait_for_timeout(500)
        jb = page.evaluate("""() => {
          const t = document.getElementById('tabJongbe');
          const vis = t && getComputedStyle(t).display !== 'none';
          const st = window.Jongbe ? window.Jongbe.getStocks() : [];
          return {
            visible: vis,
            stocks: st.length,
            tracks: st.map(s => s.track),
            tabs: Array.from(document.querySelectorAll('#jbTrackTabs .tab-btn')).map(b => b.textContent.trim()),
            badge: (document.getElementById('dispBadge')||{}).textContent,
            price: (document.getElementById('dispPrice')||{}).textContent,
            tipScore: (document.getElementById('tacTipScore')||{}).textContent,
            tipsRows: document.querySelectorAll('#tacTips > div').length,
            diagram: !!document.getElementById('jbDiagram'),
            svgs: document.querySelectorAll('#jbDiagram svg').length,
            cards: document.querySelectorAll('#stockListContainer .stock-card').length,
            legend: Array.from(document.querySelectorAll('#tabJongbe .legend-item')).map(x=>x.textContent.trim()),
            canvas: (() => { const c = document.getElementById('candleChart'); return c ? c.width + 'x' + c.height : null; })(),
          };
        }""")
        print('JONGBE:', json.dumps(jb, ensure_ascii=False))
        page.evaluate("window.Jongbe && window.Jongbe.resetChart && window.Jongbe.resetChart()")
        page.wait_for_timeout(600)
        page.evaluate("document.querySelector('#tabJongbe .sec-head').scrollIntoView({block:'start'})")
        page.wait_for_timeout(400)
        page.screenshot(path=f'{OUT}/{TAG}_jb_top_400.png')
        el = page.query_selector('#canvasContainer')
        if el:
            el.scroll_into_view_if_needed()
            page.wait_for_timeout(500)
            page.screenshot(path=f'{OUT}/{TAG}_jb_chart_400.png')
        # 도해 펼치기
        page.evaluate("""() => { const d = document.getElementById('jbDiagram'); if (d) { d.open = true; d.scrollIntoView({block:'start'}); } }""")
        page.wait_for_timeout(700)
        page.screenshot(path=f'{OUT}/{TAG}_jb_diagram_400.png')
        # 트랙 필터 — 4패턴 버튼
        for key in ('p1', 'p2', 'p3', 'p4'):
            page.evaluate("""(k) => {
              const b = Array.from(document.querySelectorAll('#jbTrackTabs .tab-btn')).find(x => (x.getAttribute('onclick')||'').includes("'" + k + "'"));
              if (b) b.click();
            }""", key)
            page.wait_for_timeout(450)
            cnt = page.evaluate("document.querySelectorAll('#stockListContainer .stock-card').length")
            print(f'filter {key}: cards {cnt}')
        page.evaluate("""() => { const b = document.querySelector('#jbTrackTabs .tab-btn'); if (b) b.click(); }""")
        page.wait_for_timeout(400)
        page.screenshot(path=f'{OUT}/{TAG}_jb_list_400.png')
        # 6대 팁 박스 위치 확인
        tips = page.evaluate("""() => {
          const el = document.getElementById('tacTips');
          if (!el) return null;
          el.scrollIntoView({block:'center'});
          return el.textContent.replace(/\\s+/g,' ').slice(0, 320);
        }""")
        print('TIPS:', tips)
        page.wait_for_timeout(400)
        page.screenshot(path=f'{OUT}/{TAG}_jb_tips_400.png')

        # 콘솔 에러
        print('FAILED RESOURCES:', len(failed))
        uq = []
        for f_ in failed:
            u = f_.split(' ')[-1].split('?')[0]
            if u not in uq: uq.append(u)
        for u in uq[:15]:
            print('FAIL>', u)
        print('CONSOLE ERRORS:', len(errors))
        seen = set()
        for e in errors:
            k = e[:60]
            if k in seen: continue
            seen.add(k)
            print('ERR>', e[:240])
            if len(seen) >= 12: break
        browser.close()


if __name__ == '__main__':
    import os
    os.makedirs(OUT, exist_ok=True)
    run()
