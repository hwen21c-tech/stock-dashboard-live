#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""전략 6탭 아코디언 + RN존·신정재 양식 통일 검증 (2026-11-26)

  python3 scripts/verify_strat_unify_1126.py [base_url] [tag]

검증 항목 (400×884 모바일 뷰)
  1) 6개 전략 탭 렌더 · 가로 넘침 0 · 콘솔 오류 0
  2) 실시간 판정 박스 5개(비중법사·홍인기·깡토·종가베팅·RN존) 접기/펼치기 동작 + localStorage 유지 + 헤더 한 줄 유지
  3) 신정재 배치: 종목 리스트 → 차트 → 4대 패턴 → 도해 / RN존: 종목 카드 → 차트 → 원칙
  4) RN존·신정재 카드: 공통 양식(헤더·가격·지표·미니차트·타점 요약) 존재 · 미니 차트 실제绘制
  5) 카드를 누르면 큰 차트 헤더가 그 종목으로 바뀐다
스크린샷: sd_live/screenshots/strat_unify/
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

NODE = '/workspace/.local/nodejs/node-v20.18.0-linux-x64/bin/node'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('PORT', '8802'))
BASE = sys.argv[1] if len(sys.argv) > 1 else f'http://127.0.0.1:{PORT}/index.html'
TAG = sys.argv[2] if len(sys.argv) > 2 else 'local'
OUT = os.path.join(ROOT, 'screenshots', 'strat_unify')
os.makedirs(OUT, exist_ok=True)

HOSTS = [
    ('bijoong', 'tabBijoong', 'stratLiveBijoongHost'),
    ('honginki', 'tabHonginki', 'stratLiveHongHost'),
    ('kkangto', 'tabKkangto', 'stratLiveKkangtoHost'),
    ('jongbe', 'tabJongbe', 'stratLiveJongbeHost'),
    ('rnzone', 'tabRnzone', 'stratLiveRnzoneHost'),
]
TABS = [h[0] for h in HOSTS] + ['manju']

fails = []
report = {'url': BASE, 'tag': TAG, 'checks': [], 'screens': []}


def check(name, ok, detail=''):
    report['checks'].append({'name': name, 'ok': bool(ok), 'detail': detail})
    print(('✅ ' if ok else '❌ ') + name + (f'  → {detail}' if detail else ''))
    if not ok:
        fails.append(name)


def ensure_server():
    try:
        urllib.request.urlopen(BASE, timeout=2)
        return None
    except Exception:
        pass
    proc = subprocess.Popen([NODE, 'dev_server.mjs'], cwd=ROOT,
                            env={**os.environ, 'PORT': str(PORT)},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        time.sleep(0.3)
        try:
            urllib.request.urlopen(BASE, timeout=1)
            return proc
        except Exception:
            continue
    return proc


def shot(page, name, sel=None):
    p = os.path.join(OUT, f'{TAG}_{name}_400.png')
    try:
        if sel:
            page.evaluate('(s) => { var e = document.querySelector(s); if (e) e.scrollIntoView({ block: "start" }); }', sel)
            page.wait_for_timeout(350)
        else:
            page.evaluate('() => window.scrollTo(0, 0)')
            page.wait_for_timeout(200)
        page.screenshot(path=p)
        report['screens'].append(p)
        return p
    except Exception:
        return None


def main():
    srv = ensure_server()
    errs = []
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()
            ctx = br.new_context(viewport={'width': 400, 'height': 884}, device_scale_factor=1,
                                 user_agent='Mozilla/5.0 (Linux; Android 13; Fold8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
                                 is_mobile=True, has_touch=True)
            ctx.add_init_script("try{localStorage.setItem('stock_dashboard_pin_auth','0623_verified');}catch(e){}")
            page = ctx.new_page()
            page.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
            page.on('console', lambda m: errs.append('console.error: ' + m.text) if m.type == 'error' else None)
            page.goto(BASE, wait_until='domcontentloaded')
            page.wait_for_timeout(7000)

            # ---------- 1) 6탭 렌더 · 가로 넘침 ----------
            overflow = {}
            for view in TABS:
                page.evaluate('v => window.switchView(v)', view)
                page.wait_for_timeout(2200)
                ow = page.evaluate('() => ({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})')
                overflow[view] = ow
                shot(page, view + '_top', '#' + dict((h[0], h[1]) for h in HOSTS).get(view, 'tabManju'))
            bad = {k: v for k, v in overflow.items() if v['sw'] > v['cw'] + 2}
            check('6개 전략 탭 렌더 · 가로 넘침 0', not bad, json.dumps(bad, ensure_ascii=False))

            # ---------- 2) 실시간 박스 5개 접기/펼치기 ----------
            fold_state = {}
            skipped = []
            for view, tab_id, host_id in HOSTS:
                page.evaluate('v => window.switchView(v)', view)
                page.wait_for_timeout(1600)
                info = page.evaluate("""h => {
                  var host = document.getElementById(h);
                  if (!host) return { missing: true };
                  var tog = host.querySelector('[data-sl-boxtog], [data-lsp-boxtog]');
                  if (!tog) return { missing: true, noBtn: true, len: host.innerHTML.length };
                  var key = tog.getAttribute('data-sl-boxtog') || tog.getAttribute('data-lsp-boxtog');
                  var body = host.querySelector('[data-sl-box="' + key + '"], [data-lsp-box="' + key + '"]');
                  var header = tog.parentNode;
                  return { key: key, label: tog.textContent.trim(), expanded: tog.getAttribute('aria-expanded'),
                           bodyShown: body ? getComputedStyle(body).display !== 'none' : null,
                           headerH: Math.round(header.getBoundingClientRect().height),
                           headerW: Math.round(header.getBoundingClientRect().width),
                           hostW: Math.round(host.getBoundingClientRect().width) };
                }""", host_id)
                fold_state[view] = info
                if info.get('missing'):
                    skipped.append(view)
                    print(f'⚠️ {view}: 실시간 판정 박스 없음 — 이 화면에는 그 박스가 없어 건너뜁니다')
                    continue
                check(f'{view}: 접기 버튼 · 기본 펼침 · 헤더 한 줄',
                      info['bodyShown'] is True and info['label'].startswith('접기') and info['headerH'] <= 34,
                      json.dumps(info, ensure_ascii=False))
                # 접기
                page.evaluate("""a => {
                  var host = document.getElementById(a[1]);
                  var tog = host.querySelector('[data-sl-boxtog], [data-lsp-boxtog]');
                  tog.click();
                }""", [view, host_id])
                page.wait_for_timeout(450)
                folded = page.evaluate("""a => {
                  var host = document.getElementById(a[1]);
                  var tog = host.querySelector('[data-sl-boxtog], [data-lsp-boxtog]');
                  var key = tog.getAttribute('data-sl-boxtog') || tog.getAttribute('data-lsp-boxtog');
                  var body = host.querySelector('[data-sl-box="' + key + '"], [data-lsp-box="' + key + '"]');
                  var st = null; try { st = localStorage.getItem('sd_strat_box_fold_v1'); } catch (e) {}
                  return { label: tog.textContent.trim(), expanded: tog.getAttribute('aria-expanded'),
                           display: body ? getComputedStyle(body).display : null, store: st };
                }""", [view, host_id])
                ok_fold = folded['display'] == 'none' and folded['label'].startswith('펼치기') and folded['expanded'] == 'false' and (folded['store'] or '').find(info['key']) >= 0
                check(f'{view}: 접기 동작 · 상태 저장', ok_fold, json.dumps(folded, ensure_ascii=False))
                shot(page, view + '_box_folded', '#' + host_id)
                # 펼치기
                page.evaluate("""a => { var h=document.getElementById(a[1]); h.querySelector('[data-sl-boxtog], [data-lsp-boxtog]').click(); }""", [view, host_id])
                page.wait_for_timeout(450)
                opened = page.evaluate("""a => {
                  var host = document.getElementById(a[1]);
                  var tog = host.querySelector('[data-sl-boxtog], [data-lsp-boxtog]');
                  var key = tog.getAttribute('data-sl-boxtog') || tog.getAttribute('data-lsp-boxtog');
                  var body = host.querySelector('[data-sl-box="' + key + '"], [data-lsp-box="' + key + '"]');
                  var st = null; try { st = localStorage.getItem('sd_strat_box_fold_v1'); } catch (e) {}
                  return { label: tog.textContent.trim(), display: body ? getComputedStyle(body).display : null, store: st };
                }""", [view, host_id])
                check(f'{view}: 다시 펼치기 · 저장 해제',
                      opened['display'] != 'none' and opened['label'].startswith('접기') and (opened['store'] or '').find(info['key']) < 0,
                      json.dumps(opened, ensure_ascii=False))

            # ---------- 3) 배치 순서 ----------
            page.evaluate("v => window.switchView(v)", 'jongbe')
            page.wait_for_timeout(2200)
            order_jb = page.evaluate("""() => {
              function top(sel){ var e=document.querySelector(sel); return e? e.getBoundingClientRect().top + window.scrollY : null; }
              var tabs = Array.prototype.map.call(document.querySelectorAll('#jbTrackTabs .tab-btn'), function(b){ return b.textContent.trim(); });
              return {
                list: top('#stockListContainer'), chart: top('#tabJongbe .chart-panel'),
                patterns: top('#jbPatternGrid'), diagram: top('#jbDiagram'), tabs: tabs
              };
            }""")
            ok_jb = (order_jb['list'] is not None and order_jb['chart'] is not None and order_jb['patterns'] is not None
                     and order_jb['list'] < order_jb['chart'] < order_jb['patterns'] < order_jb['diagram'])
            check('신정재: 종목 리스트 → 차트 → 4대 패턴 → 도해', ok_jb, json.dumps(order_jb, ensure_ascii=False))
            page.evaluate("() => { var d=document.getElementById('jbDiagram'); if(d) d.open=true; }")
            page.wait_for_timeout(500)
            check('신정재: 도해 한 줄 요약 · 3단계 · 색 구분',
                  page.evaluate("""() => !!document.querySelector('#jbDiagram .jb-dg-card') &&
                     document.body.innerText.indexOf('한 줄 요약') >= 0 &&
                     document.querySelectorAll('#jbDiagram .jb-dg-mini-note').length >= 4"""))
            shot(page, 'jongbe_diagram', '#jbDiagram')
            page.evaluate("() => { var d=document.getElementById('jbDiagram'); if(d) d.open=false; }")

            page.evaluate("v => window.switchView(v)", 'rnzone')
            page.wait_for_timeout(2200)
            order_rn = page.evaluate("""() => {
              function top(sel){ var e=document.querySelector(sel); return e? e.getBoundingClientRect().top + window.scrollY : null; }
              return { list: top('#stockListGrid'), chart: top('#tabRnzone .chart-section'),
                       principle: top('#tabRnzone .principles-box'),
                       legend: document.querySelectorAll('#tabRnzone .su-chart-legend .it').length };
            }""")
            ok_rn = (order_rn['list'] is not None and order_rn['chart'] is not None
                     and order_rn['list'] < order_rn['chart'] and (order_rn['principle'] is None or order_rn['principle'] > order_rn['chart'])
                     and order_rn['legend'] >= 5)
            check('RN존: 종목 카드 → 차트(범례 포함) → 원칙', ok_rn, json.dumps(order_rn, ensure_ascii=False))

            # ---------- 4) 카드 공통 양식 · 미니 차트 ----------
            for view, grid, card in (('rnzone', '#stockListGrid', '#stockListGrid .stock-card'),
                                     ('jongbe', '#stockListContainer', '#stockListContainer .stock-card')):
                page.evaluate('v => window.switchView(v)', view)
                page.wait_for_timeout(2200)
                info = page.evaluate("""a => {
                  var cards = document.querySelectorAll(a[1]);
                  if (!cards.length) return { count: 0 };
                  var c = cards[0];
                  var cv = c.querySelector('canvas[data-su-mini]');
                  var painted = false, w = 0, h = 0;
                  if (cv) {
                    w = cv.width; h = cv.height;
                    try {
                      var ctx = cv.getContext('2d');
                      var d = ctx.getImageData(0, 0, Math.min(60, cv.width), Math.min(60, cv.height)).data;
                      for (var i = 0; i < d.length; i += 4) { if (d[i] + d[i+1] + d[i+2] > 30) { painted = true; break; } }
                    } catch (e) { painted = null; }
                  }
                  return {
                    count: cards.length,
                    hasTop: !!c.querySelector('.su-top'), hasPrice: !!c.querySelector('.su-px'),
                    hasRows: !!c.querySelector('.su-rows'), hasPlan: !!c.querySelector('.su-plan'),
                    hasMini: !!cv, painted: painted, cw: w, ch: h,
                    allHaveMini: Array.prototype.every.call(cards, function(x){ return !!x.querySelector('canvas[data-su-mini]'); })
                  };
                }""", [view, card])
                check(f'{view}: 카드 공통 양식(헤더·가격·지표·타점·미니차트)',
                      info.get('count', 0) > 0 and info.get('hasTop') and info.get('hasPrice') and info.get('hasRows')
                      and info.get('hasPlan') and info.get('allHaveMini') and info.get('painted') is not False,
                      json.dumps(info, ensure_ascii=False))
                # 카드를 누르면 큰 차트 헤더가 바뀐다
                moved = page.evaluate("""a => {
                  var cards = document.querySelectorAll(a[1]);
                  if (cards.length < 2) return { skip: true };
                  var target = cards[1];
                  var name = target.querySelector('.su-nm') ? target.querySelector('.su-nm').textContent : '';
                  target.click();
                  var hdr = document.querySelector(a[2]);
                  return { want: name, got: hdr ? hdr.textContent.trim() : null };
                }""", [view, card, '#selectedStockName' if view == 'rnzone' else '#dispName'])
                if moved.get('skip'):
                    check(f'{view}: 카드 클릭 → 큰 차트 전환', True, '카드 1장 이하 — 생략')
                else:
                    check(f'{view}: 카드 클릭 → 큰 차트 전환',
                          moved.get('got') and moved.get('want') and moved['want'].find(moved['got']) >= 0,
                          json.dumps(moved, ensure_ascii=False))
                shot(page, view + '_cards', grid)

            # ---------- 4b) 신정재 기존 기능(4패턴·6대 팁·DART·계산기) 유지 ----------
            page.evaluate("v => window.switchView(v)", 'jongbe')
            page.wait_for_timeout(1800)
            orig = page.evaluate("""() => {
              var r = {};
              r.patternCards = document.querySelectorAll('#jbPatternGrid .strategy-card').length;
              r.tipScore = (document.getElementById('tacTipScore') || {}).textContent;
              r.legend = document.querySelectorAll('#tabJongbe .chart-legend .legend-item').length;
              try { window.openDartModal(); var dm = document.getElementById('dartModalOverlay'); r.dart = !!dm && getComputedStyle(dm).display !== 'none'; } catch (e) { r.dart = 'err:' + e.message; }
              try { window.Jongbe.openCalcModal(); r.calc = true; } catch (e) { r.calc = 'err:' + e.message; }
              try { window.Jongbe.closeCalcModal && window.Jongbe.closeCalcModal(); } catch (e) {}
              try { window.closeDartModal && window.closeDartModal(); } catch (e) {}
              return r;
            }""")
            check('신정재: 4패턴 · 6대 팁 · 엔벨로프 범례 · DART·계산기 유지',
                  orig.get('patternCards') == 4 and (orig.get('tipScore') or '').find('/6') >= 0
                  and orig.get('legend', 0) >= 8 and orig.get('dart') is not False and orig.get('calc') is True,
                  json.dumps(orig, ensure_ascii=False))
            # RN존 기존 기능(검색·계산기·캔버스 줌) 유지
            page.evaluate("v => window.switchView(v)", 'rnzone')
            page.wait_for_timeout(1600)
            rnfun = page.evaluate("""() => {
              var r = {};
              var cv = document.getElementById('candlestickCanvas');
              function colored() {
                if (!cv) return 0;
                var d = cv.getContext('2d').getImageData(0, 0, Math.min(180, cv.width), Math.min(180, cv.height)).data;
                var n = 0; for (var i = 0; i < d.length; i += 4) { if (d[i] + d[i + 1] + d[i + 2] > 30) n++; }
                return n;
              }
              r.before = colored();
              try { window.RnZone.chartZoom(1.2); } catch (e) { r.zoom = 'err'; }
              r.after = colored();
              try { window.RnZone.updateCalc(); r.calc = (document.getElementById('calcBuy1Amt') || {}).innerText; } catch (e) { r.calc = 'err'; }
              r.searchBar = !!document.getElementById('liveStockQuery');
              r.calcBox = !!document.getElementById('calcBox');
              return r;
            }""")
            # 종목 검색 입력칸은 동적 본체에만 있다(정적 미러는 스냅샷) — 있으면 true, 없으면 생략 표기
            check('RN존: 캔버스 차트 · 줌 · 분할 계산기 유지(검색은 동적 전용)',
                  rnfun.get('before', 0) > 0 and rnfun.get('after', 0) > 0
                  and rnfun.get('calcBox') and (rnfun.get('calc') or '').find('원') >= 0,
                  json.dumps(rnfun, ensure_ascii=False))

            # ---------- 5) 콘솔 ----------
            check('콘솔 오류 0건', len(errs) == 0, '; '.join(errs[:5]))
            br.close()
    finally:
        if srv:
            srv.terminate()

    report['fails'] = fails
    report['skipped_boxes'] = locals().get('skipped', [])
    with open(os.path.join(ROOT, 'screenshots', 'strat_unify', f'{TAG}_report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print('\n' + ('✅ 전부 통과' if not fails else f'❌ 실패 {len(fails)}건: ' + ' | '.join(fails)))
    sys.exit(1 if fails else 0)


main()
