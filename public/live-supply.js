/* ============================================================
   💰 2번 수급주도주 탭 — 매일 장마감 확정 수급으로 자동 교체 (live-supply.js)
   ─ 데이터: scripts/rescan_strategies.py 가 네이버 종목별 투자자별 매매동향
            (거래소 확정치: bizdate · 외국인/기관 순매수 주수 × 그날 종가)으로 매일 새로 만든다.
   ─ 아래 const SUPPLY 한 줄을 재스캔이 교체한다(public/data/supply-latest.json 과 같은 값).
   ─ 카드에는 data-code / data-name 을 달아 📌 핀 고정(strategy-pins.js)이 그대로 동작한다.
   ─ 핀 고정 종목은 다음 날 목록에서 빠져도 이 탭에 남는다(고정 카드 영역).
   ============================================================ */
(function () {
'use strict';
if (window.SupplyTab) return;
/* 5번 탭의 「장중 가집계 상위(KIS)」 패널은 live-kis-supply.js 가 그린다 — 이 파일은 확정 수급 카드만 담당. */
function hasMarkup() { return !!document.getElementById('supForeignBuy'); }

const SUPPLY = {"generatedAt":"2026-11-27 16:28:55","basisDate":"20261126","basisLabel":"2026-11-26(목)","confirmed":true,"candidates":240,"source":"네이버 종목별 투자자별 매매동향(거래소 확정)","groups":{"foreignBuy":[{"code":"000660","name":"SK하이닉스","market":"코스피","price":1055000,"pct":4.04,"foreignEok":3126.5,"organEok":-715.3,"individualEok":-5990.7,"streakForeign":1,"streakOrgan":6,"valueText":"31,310억","capText":"777.5조","desc":"외국인 +3,126억 · 기관 -715억 · 개인 -5,991억 (확정 11/26 종가 기준)"},{"code":"009150","name":"삼성전기","market":"코스피","price":785000,"pct":4.95,"foreignEok":655.2,"organEok":583.7,"individualEok":-1225.5,"streakForeign":1,"streakOrgan":1,"valueText":"6,954억","capText":"60.7조","desc":"외국인 +655억 · 기관 +584억 · 개인 -1,226억 (확정 11/26 종가 기준)"},{"code":"036930","name":"주성엔지니어링","market":"코스닥","price":138500,"pct":7.95,"foreignEok":152.0,"organEok":66.9,"individualEok":-215.4,"streakForeign":1,"streakOrgan":1,"valueText":"3,112억","capText":"7.2조","desc":"외국인 +152억 · 기관 +67억 · 개인 -215억 (확정 11/26 종가 기준)"},{"code":"353200","name":"대덕전자","market":"코스피","price":69700,"pct":5.29,"foreignEok":132.2,"organEok":-32.3,"individualEok":-99.0,"streakForeign":5,"streakOrgan":3,"valueText":"733억","capText":"3.6조","desc":"외국인 +132억 · 기관 -32억 · 개인 -99억 (확정 11/26 종가 기준)"},{"code":"402340","name":"SK스퀘어","market":"코스피","price":649000,"pct":4.34,"foreignEok":123.0,"organEok":353.2,"individualEok":-471.4,"streakForeign":2,"streakOrgan":1,"valueText":"2,679억","capText":"89.6조","desc":"외국인 +123억 · 기관 +353억 · 개인 -471억 (확정 11/26 종가 기준)"},{"code":"034020","name":"두산에너빌리티","market":"코스피","price":40600,"pct":4.1,"foreignEok":122.1,"organEok":8.6,"individualEok":-130.3,"streakForeign":1,"streakOrgan":4,"valueText":"840억","capText":"28.0조","desc":"외국인 +122억 · 기관 +9억 · 개인 -130억 (확정 11/26 종가 기준)"}],"organBuy":[{"code":"005930","name":"삼성전자","market":"코스피","price":171500,"pct":2.76,"foreignEok":-922.3,"organEok":3193.8,"individualEok":-2251.3,"streakForeign":2,"streakOrgan":1,"valueText":"24,169억","capText":"1,040.1조","desc":"외국인 -922억 · 기관 +3,194억 · 개인 -2,251억 (확정 11/26 종가 기준)"},{"code":"009150","name":"삼성전기","market":"코스피","price":785000,"pct":4.95,"foreignEok":655.2,"organEok":583.7,"individualEok":-1225.5,"streakForeign":1,"streakOrgan":1,"valueText":"6,954억","capText":"60.7조","desc":"외국인 +655억 · 기관 +584억 · 개인 -1,226억 (확정 11/26 종가 기준)"},{"code":"402340","name":"SK스퀘어","market":"코스피","price":649000,"pct":4.34,"foreignEok":123.0,"organEok":353.2,"individualEok":-471.4,"streakForeign":2,"streakOrgan":1,"valueText":"2,679억","capText":"89.6조","desc":"외국인 +123억 · 기관 +353억 · 개인 -471억 (확정 11/26 종가 기준)"},{"code":"105560","name":"KB금융","market":"코스피","price":145500,"pct":-2.09,"foreignEok":-444.7,"organEok":315.0,"individualEok":130.2,"streakForeign":2,"streakOrgan":5,"valueText":"904억","capText":"51.5조","desc":"외국인 -445억 · 기관 +315억 · 개인 +130억 (확정 11/26 종가 기준)"},{"code":"035420","name":"NAVER","market":"코스피","price":160400,"pct":2.82,"foreignEok":-113.6,"organEok":295.8,"individualEok":-169.5,"streakForeign":1,"streakOrgan":3,"valueText":"660억","capText":"25.9조","desc":"외국인 -114억 · 기관 +296억 · 개인 -170억 (확정 11/26 종가 기준)"},{"code":"352820","name":"하이브","market":"코스피","price":187900,"pct":8.3,"foreignEok":-121.0,"organEok":254.8,"individualEok":-137.6,"streakForeign":2,"streakOrgan":2,"valueText":"404억","capText":"8.1조","desc":"외국인 -121억 · 기관 +255억 · 개인 -138억 (확정 11/26 종가 기준)"}],"foreignSell":[{"code":"005930","name":"삼성전자","market":"코스피","price":171500,"pct":2.76,"foreignEok":-922.3,"organEok":3193.8,"individualEok":-2251.3,"streakForeign":2,"streakOrgan":1,"valueText":"24,169억","capText":"1,040.1조","desc":"외국인 -922억 · 기관 +3,194억 · 개인 -2,251억 (확정 11/26 종가 기준)"},{"code":"105560","name":"KB금융","market":"코스피","price":145500,"pct":-2.09,"foreignEok":-444.7,"organEok":315.0,"individualEok":130.2,"streakForeign":2,"streakOrgan":5,"valueText":"904억","capText":"51.5조","desc":"외국인 -445억 · 기관 +315억 · 개인 +130억 (확정 11/26 종가 기준)"},{"code":"003490","name":"대한항공","market":"코스피","price":29750,"pct":-4.34,"foreignEok":-288.7,"organEok":142.2,"individualEok":147.8,"streakForeign":1,"streakOrgan":6,"valueText":"506억","capText":"11.1조","desc":"외국인 -289억 · 기관 +142억 · 개인 +148억 (확정 11/26 종가 기준)"},{"code":"033780","name":"KT&G","market":"코스피","price":179700,"pct":-2.44,"foreignEok":-248.0,"organEok":76.2,"individualEok":28.4,"streakForeign":10,"streakOrgan":3,"valueText":"616억","capText":"18.3조","desc":"외국인 -248억 · 기관 +76억 · 개인 +28억 (확정 11/26 종가 기준)"},{"code":"005380","name":"현대차","market":"코스피","price":259500,"pct":-2.08,"foreignEok":-216.2,"organEok":49.5,"individualEok":164.6,"streakForeign":2,"streakOrgan":4,"valueText":"998억","capText":"54.4조","desc":"외국인 -216억 · 기관 +50억 · 개인 +165억 (확정 11/26 종가 기준)"}],"dualBuy":[{"code":"009150","name":"삼성전기","market":"코스피","price":785000,"pct":4.95,"foreignEok":655.2,"organEok":583.7,"individualEok":-1225.5,"streakForeign":1,"streakOrgan":1,"valueText":"6,954억","capText":"60.7조","desc":"외국인 +655억 · 기관 +584억 · 개인 -1,226억 (확정 11/26 종가 기준)"},{"code":"402340","name":"SK스퀘어","market":"코스피","price":649000,"pct":4.34,"foreignEok":123.0,"organEok":353.2,"individualEok":-471.4,"streakForeign":2,"streakOrgan":1,"valueText":"2,679억","capText":"89.6조","desc":"외국인 +123억 · 기관 +353억 · 개인 -471억 (확정 11/26 종가 기준)"},{"code":"036930","name":"주성엔지니어링","market":"코스닥","price":138500,"pct":7.95,"foreignEok":152.0,"organEok":66.9,"individualEok":-215.4,"streakForeign":1,"streakOrgan":1,"valueText":"3,112억","capText":"7.2조","desc":"외국인 +152억 · 기관 +67억 · 개인 -215억 (확정 11/26 종가 기준)"},{"code":"034020","name":"두산에너빌리티","market":"코스피","price":40600,"pct":4.1,"foreignEok":122.1,"organEok":8.6,"individualEok":-130.3,"streakForeign":1,"streakOrgan":4,"valueText":"840억","capText":"28.0조","desc":"외국인 +122억 · 기관 +9억 · 개인 -130억 (확정 11/26 종가 기준)"},{"code":"347700","name":"스피어","market":"코스닥","price":23300,"pct":25.95,"foreignEok":64.9,"organEok":45.2,"individualEok":-117.4,"streakForeign":1,"streakOrgan":10,"valueText":"799억","capText":"1.2조","desc":"외국인 +65억 · 기관 +45억 · 개인 -117억 (확정 11/26 종가 기준)"},{"code":"437730","name":"삼현","market":"코스닥","price":61500,"pct":5.31,"foreignEok":50.9,"organEok":43.9,"individualEok":-92.3,"streakForeign":1,"streakOrgan":1,"valueText":"529억","capText":"1.9조","desc":"외국인 +51억 · 기관 +44억 · 개인 -92억 (확정 11/26 종가 기준)"}]}};
/* ▲ 이 한 줄(`const SUPPLY = {`)은 scripts/rescan_strategies.py 가 새 스캔으로 교체한다. */

var HAS_API = (function () {
  try { return !!document.querySelector('script[src*="live-api.js"]'); } catch (e) { return false; }
})();

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function nf(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Math.round(Number(n)).toLocaleString('ko-KR');
}
function eok(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  var n = Number(v);
  return (n > 0 ? '+' : '') + Math.round(n).toLocaleString('ko-KR') + '억';
}
function signPct(v, d) {
  var n = Number(v);
  if (!isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(d == null ? 2 : d) + '%';
}
function colOf(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }

var S = { live: {}, liveAt: null, timer: null, booted: false };

function injectCss() {
  if (document.getElementById('sup-css')) return;
  var el = document.createElement('style');
  el.id = 'sup-css';
  el.textContent = [
    '#tabSupply .ssc-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:nowrap}',
    '#tabSupply .ssc-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#tabSupply .ssc-price{flex:0 0 auto;white-space:nowrap}',
    '#tabSupply .supply-stock-card{width:100%}',
    '#tabSupply #supPinnedWrap:empty{display:none}'
  ].join('\n');
  document.head.appendChild(el);
}

function stamp() {
  var txt = SUPPLY.confirmed
    ? ('거래소 확정 수급 기준일 ' + SUPPLY.basisLabel + ' — 외인·기관 순매수 금액은 그날 종가 × 순매수 주수입니다(장중 실시간 아님).')
    : '확정 수급 데이터 없음 — 재스캔(scripts/rescan_strategies.py) 후 자동으로 채워집니다.';
  var el = $('supBasisLine');
  if (!el) {
    var host = $('supplyLiveStamp');
    if (host && host.parentNode) {
      el = document.createElement('div');
      el.id = 'supBasisLine';
      el.style.cssText = 'font-size:10.5px;font-weight:800;color:#fbbf24;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:6px;padding:6px 10px;margin-bottom:10px;line-height:1.5';
      host.parentNode.insertBefore(el, host.nextSibling);
    }
  }
  if (el) el.innerHTML = '📋 ' + esc(txt) + (SUPPLY.generatedAt ? ' · 생성 ' + esc(SUPPLY.generatedAt) : '');
}

function cardHtml(g, it, kindLabel, idx) {
  var badge = '';
  if (kindLabel === 'foreign') badge = '외인 ' + eok(it.foreignEok);
  else if (kindLabel === 'organ') badge = '기관 ' + eok(it.organEok);
  else if (kindLabel === 'sell') badge = '외인 ' + eok(it.foreignEok);
  else badge = '외인 ' + eok(it.foreignEok) + ' · 기관 ' + eok(it.organEok);
  var sub = [];
  if (it.streakForeign && it.streakForeign >= 2) sub.push('외인 ' + it.streakForeign + '일 연속');
  if (it.streakOrgan && it.streakOrgan >= 2) sub.push('기관 ' + it.streakOrgan + '일 연속');
  var reason = '【거래소 확정 ' + esc(SUPPLY.basisLabel || '') + '】 외국인 ' + eok(it.foreignEok) +
    ' · 기관 ' + eok(it.organEok) + ' · 개인 ' + eok(it.individualEok) +
    '<br>【종가】 ' + nf(it.price) + '원 (' + signPct(it.pct, 2) + ') · 당일 거래대금 ' + esc(it.valueText || '—') +
    '<br>【계산】 순매수 주수 × 그날 종가 ÷ 1억 = 억원 (네이버 종목별 투자자별 매매동향)';
  var oc = "openDetail('" + esc(it.name) + " [" + esc(kindLabel === 'sell' ? '외인 순매도' : (kindLabel === 'organ' ? '기관 순매수' : '수급')) + " " + (idx + 1) + "위]', '" +
    esc(signPct(it.pct, 2)) + "', '" + esc(badge) + "', '" + reason.replace(/'/g, "\\'") + "', '" +
    esc('확정 종가 등락률(' + (SUPPLY.basisLabel || '기준일') + ')') + "', '" + esc('당일 순매수(확정)') + "')";
  return '<div class="supply-stock-card" data-code="' + esc(it.code) + '" data-name="' + esc(it.name) + '" onclick="' + oc + '">' +
    '<div class="ssc-top"><span class="ssc-name">' + esc(it.name) + '</span>' +
      '<span class="ssc-price ' + colOf(it.pct) + '" data-sup-px="' + esc(it.code) + '">' + nf(it.price) + '원 (' + signPct(it.pct, 2) + ')</span></div>' +
    '<div class="ssc-badges">' +
      '<span class="s-badge net" style="background:' + (kindLabel === 'sell' ? '#7f1d1d' : '#065f46') + ';color:' + (kindLabel === 'sell' ? '#fecaca' : '#6ee7b7') + ';">' + esc(badge) + '</span>' +
      (it.market ? '<span class="s-badge streak">' + esc(it.market) + '</span>' : '') +
      (it.capText ? '<span class="s-badge gold">' + esc(it.capText) + '</span>' : '') +
      sub.map(function (t) { return '<span class="s-badge streak">' + esc(t) + '</span>'; }).join('') +
    '</div>' +
    '<div class="ssc-desc">' + esc(it.desc || '') + '</div>' +
    '</div>';
}

function renderGroup(id, list, kindLabel) {
  var el = $(id);
  if (!el) return 0;
  if (!list || !list.length) {
    el.innerHTML = '<div style="font-size:10.5px;color:#94a3b8;border:1px dashed #334155;border-radius:6px;padding:8px;line-height:1.5">' +
      '확정 수급 상위 종목이 없습니다 — 다음 장마감 재스캔에서 채워집니다.</div>';
    return 0;
  }
  el.innerHTML = list.map(function (it, i) { return cardHtml(id, it, kindLabel, i); }).join('');
  return list.length;
}

function render() {
  /* 동적 본체는 카드 그룹을 스크립트로 채우고, 정적 미러는 확정 카드가 HTML 에 박혀 있다
     (supForeignBuy 등 id 가 없으면 이 파일은 확정 카드에 손대지 않는다). */
  if (!hasMarkup()) return;
  var g = SUPPLY.groups || {};
  var n1 = renderGroup('supForeignBuy', g.foreignBuy, 'foreign');
  var n2 = renderGroup('supOrganBuy', g.organBuy, 'organ');
  var n3 = renderGroup('supForeignSell', g.foreignSell, 'sell');
  var n4 = renderGroup('supDualBuy', g.dualBuy, 'dual');
  var set = function (id, t) { var e = $(id); if (e) e.textContent = t; };
  set('supForeignCount', n1 + '종목');
  set('supOrganCount', n2 + '종목');
  set('supSellCount', n3 + '종목');
  set('supDualCount', n4 + '종목');
  var head = function (id, pat, rep) {
    var e = $(id);
    if (!e) return;
    e.innerHTML = e.innerHTML.replace(pat, rep);
  };
  head('supForeignHead', /\(\d{1,2}\/\d{1,2}[^)]*\)/, '(' + (SUPPLY.basisLabel || '—') + ' 확정)');
  head('supOrganHead', /\(\d{1,2}\/\d{1,2}[^)]*\)/, '(' + (SUPPLY.basisLabel || '—') + ' 확정)');
  head('supSellHead', /\(\d{1,2}\/\d{1,2}[^)]*\)/, '(' + (SUPPLY.basisLabel || '—') + ' 확정)');
  head('supDualHead', /\(\d{1,2}\/\d{1,2}[^)]*\)/, '(' + (SUPPLY.basisLabel || '—') + ' 확정)');
  stamp();
  try { if (window.StrategyPins) window.StrategyPins.annotate('sup'); } catch (e) { /* */ }
  window.__SUPPLY = { rendered: n1 + n2 + n3 + n4, basis: SUPPLY.basisLabel, groups: { foreignBuy: n1, organBuy: n2, foreignSell: n3, dualBuy: n4 } };
}

function codes() {
  var g = SUPPLY.groups || {};
  var out = [];
  ['foreignBuy', 'organBuy', 'foreignSell', 'dualBuy'].forEach(function (k) {
    (g[k] || []).forEach(function (it) { if (it.code && out.indexOf(it.code) === -1) out.push(it.code); });
  });
  return out.slice(0, 40);
}

/* 장전(PREOPEN) 미체결 가드 — 0.00%로 전일 확정 등락률을 덮지 않는다 */
function preopenHeld(d, s) {
  if (String((d && d.marketStatus) || '').toUpperCase() !== 'PREOPEN') return false;
  var vol = typeof s.volume === 'number' && isFinite(s.volume) ? s.volume : null;
  if (vol !== null && vol > 0) return false;
  if (typeof s.change === 'number' && s.change !== 0) return false;
  if (typeof s.changePct === 'number' && s.changePct !== 0) return false;
  return true;
}

function applyLive() {
  var list = codes();
  if (!list.length || !HAS_API) return Promise.resolve(false);
  return fetch('/api/stock-live?codes=' + list.join(','), { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || d.ok !== true) return false;
      S.liveAt = new Date().toLocaleTimeString('ko-KR', { hour12: false });
      (d.stocks || []).forEach(function (s) {
        if (!s || !s.code) return;
        if (preopenHeld(d, s)) return;   // 장전 미체결 → 카드의 11/18 확정 종가·등락률 유지
        var el = document.querySelector('[data-sup-px="' + s.code + '"]');
        if (!el) return;
        el.textContent = nf(s.price) + '원 (' + signPct(s.changePct, 2) + ')';
        el.className = 'ssc-price ' + colOf(s.changePct);
      });
      var st = $('supplyLiveStamp');
      if (st) {
        st.innerHTML = '⚡ 현재가·등락률 실시간 ' + S.liveAt + ' (/api/stock-live) — 바깥 외인·기관 순매수 금액은 <b>' +
          esc(SUPPLY.basisLabel || '—') + '</b> 거래소 확정치이며 실시간이 아닙니다.';
      }
      return true;
    })
    .catch(function () { return false; });
}

/* 💰 수급 탭이 화면에 떠 있을 때만 30초 폴링한다 — 다른 탭을 보는 동안에도
   /api/stock-live 를 계속 부르면 Vercel Fluid CPU 만 쌓인다(2026-11-26).
   탭을 누르면 즉시 한 번 새로 받아 값이 늦지 않게 한다. */
function supplyTabActive() {
  try {
    var btn = document.querySelector('.tab-btn.active');
    return !btn || btn.getAttribute('data-view') === 'supply';
  } catch (e) { return true; }
}

function boot() {
  if (S.booted) return;
  S.booted = true;
  injectCss();
  render();
  applyLive();
  S.timer = setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    if (!supplyTabActive()) return;
    applyLive();
  }, 30000);
  try {
    document.querySelectorAll('.tab-btn[data-view="supply"], [data-view="supply"]').forEach(function (b) {
      b.addEventListener('click', function () { setTimeout(applyLive, 350); });
    });
  } catch (e) { /* noop */ }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

window.SupplyTab = {
  version: '1.0.0',
  reload: function () { render(); applyLive(); try { if (window.KisSupplyPanel) window.KisSupplyPanel.refresh(); } catch (e) { /* */ } },
  data: function () { return SUPPLY; },
  state: function () { return window.__SUPPLY || { rendered: 0 }; }
};
})();
