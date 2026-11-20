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

const SUPPLY = {"generatedAt":"2026-11-20 18:56:15","basisDate":"20261119","basisLabel":"2026-11-19(목)","confirmed":true,"candidates":236,"source":"네이버 종목별 투자자별 매매동향(거래소 확정)","groups":{"foreignBuy":[{"code":"010170","name":"대한광통신","market":"코스닥","price":14450,"pct":7.92,"foreignEok":251.4,"organEok":19.8,"individualEok":-261.8,"streakForeign":2,"streakOrgan":2,"valueText":"821억","capText":"2.1조","desc":"외국인 +251억 · 기관 +20억 · 개인 -262억 (확정 11/19 종가 기준)"},{"code":"005380","name":"현대차","market":"코스피","price":267500,"pct":-0.19,"foreignEok":172.7,"organEok":-141.0,"individualEok":-32.1,"streakForeign":3,"streakOrgan":1,"valueText":"823억","capText":"51.6조","desc":"외국인 +173억 · 기관 -141억 · 개인 -32억 (확정 11/19 종가 기준)"},{"code":"068270","name":"셀트리온","market":"코스피","price":214500,"pct":3.37,"foreignEok":160.2,"organEok":153.1,"individualEok":-315.2,"streakForeign":2,"streakOrgan":1,"valueText":"1,242억","capText":"49.2조","desc":"외국인 +160억 · 기관 +153억 · 개인 -315억 (확정 11/19 종가 기준)"},{"code":"352820","name":"하이브","market":"코스피","price":187200,"pct":4.82,"foreignEok":133.8,"organEok":252.2,"individualEok":-377.3,"streakForeign":2,"streakOrgan":7,"valueText":"941억","capText":"7.8조","desc":"외국인 +134억 · 기관 +252억 · 개인 -377억 (확정 11/19 종가 기준)"},{"code":"003490","name":"대한항공","market":"코스피","price":32650,"pct":3.49,"foreignEok":131.6,"organEok":128.1,"individualEok":-259.4,"streakForeign":8,"streakOrgan":1,"valueText":"651억","capText":"11.6조","desc":"외국인 +132억 · 기관 +128억 · 개인 -259억 (확정 11/19 종가 기준)"},{"code":"298040","name":"효성중공업","market":"코스피","price":1785000,"pct":5.25,"foreignEok":131.4,"organEok":93.4,"individualEok":-223.9,"streakForeign":2,"streakOrgan":2,"valueText":"511억","capText":"15.4조","desc":"외국인 +131억 · 기관 +93억 · 개인 -224억 (확정 11/19 종가 기준)"}],"organBuy":[{"code":"009150","name":"삼성전기","market":"코스피","price":883000,"pct":7.68,"foreignEok":-168.7,"organEok":1131.8,"individualEok":-944.3,"streakForeign":6,"streakOrgan":2,"valueText":"7,994억","capText":"57.1조","desc":"외국인 -169억 · 기관 +1,132억 · 개인 -944억 (확정 11/19 종가 기준)"},{"code":"402340","name":"SK스퀘어","market":"코스피","price":743000,"pct":3.77,"foreignEok":-72.2,"organEok":561.2,"individualEok":-488.5,"streakForeign":3,"streakOrgan":3,"valueText":"2,844억","capText":"88.5조","desc":"외국인 -72억 · 기관 +561억 · 개인 -488억 (확정 11/19 종가 기준)"},{"code":"277810","name":"레인보우로보틱스","market":"코스닥","price":422500,"pct":3.55,"foreignEok":-183.9,"organEok":253.9,"individualEok":-64.7,"streakForeign":1,"streakOrgan":5,"valueText":"495억","capText":"7.8조","desc":"외국인 -184억 · 기관 +254억 · 개인 -65억 (확정 11/19 종가 기준)"},{"code":"352820","name":"하이브","market":"코스피","price":187200,"pct":4.82,"foreignEok":133.8,"organEok":252.2,"individualEok":-377.3,"streakForeign":2,"streakOrgan":7,"valueText":"941억","capText":"7.8조","desc":"외국인 +134억 · 기관 +252억 · 개인 -377억 (확정 11/19 종가 기준)"},{"code":"032830","name":"삼성생명","market":"코스피","price":256500,"pct":0.79,"foreignEok":-198.8,"organEok":198.7,"individualEok":0.2,"streakForeign":2,"streakOrgan":2,"valueText":"620억","capText":"47.4조","desc":"외국인 -199억 · 기관 +199억 · 개인 +0억 (확정 11/19 종가 기준)"},{"code":"403870","name":"HPSP","market":"코스닥","price":42400,"pct":9.56,"foreignEok":-222.8,"organEok":197.5,"individualEok":13.6,"streakForeign":10,"streakOrgan":2,"valueText":"716억","capText":"3.1조","desc":"외국인 -223억 · 기관 +198억 · 개인 +14억 (확정 11/19 종가 기준)"}],"foreignSell":[{"code":"005930","name":"삼성전자","market":"코스피","price":197400,"pct":0.51,"foreignEok":-1108.1,"organEok":-367.8,"individualEok":1452.3,"streakForeign":4,"streakOrgan":1,"valueText":"31,961억","capText":"1,054.1조","desc":"외국인 -1,108억 · 기관 -368억 · 개인 +1,452억 (확정 11/19 종가 기준)"},{"code":"000660","name":"SK하이닉스","market":"코스피","price":1190000,"pct":2.23,"foreignEok":-592.8,"organEok":-1494.9,"individualEok":-2060.0,"streakForeign":6,"streakOrgan":1,"valueText":"35,603억","capText":"773.2조","desc":"외국인 -593억 · 기관 -1,495억 · 개인 -2,060억 (확정 11/19 종가 기준)"},{"code":"012330","name":"현대모비스","market":"코스피","price":343000,"pct":-4.06,"foreignEok":-321.4,"organEok":136.5,"individualEok":182.5,"streakForeign":4,"streakOrgan":5,"valueText":"713억","capText":"28.9조","desc":"외국인 -321억 · 기관 +136억 · 개인 +182억 (확정 11/19 종가 기준)"},{"code":"035900","name":"JYP Ent.","market":"코스닥","price":47100,"pct":-10.29,"foreignEok":-235.0,"organEok":-9.1,"individualEok":247.6,"streakForeign":2,"streakOrgan":1,"valueText":"486억","capText":"1.6조","desc":"외국인 -235억 · 기관 -9억 · 개인 +248억 (확정 11/19 종가 기준)"},{"code":"403870","name":"HPSP","market":"코스닥","price":42400,"pct":9.56,"foreignEok":-222.8,"organEok":197.5,"individualEok":13.6,"streakForeign":10,"streakOrgan":2,"valueText":"716억","capText":"3.1조","desc":"외국인 -223억 · 기관 +198억 · 개인 +14억 (확정 11/19 종가 기준)"}],"dualBuy":[{"code":"352820","name":"하이브","market":"코스피","price":187200,"pct":4.82,"foreignEok":133.8,"organEok":252.2,"individualEok":-377.3,"streakForeign":2,"streakOrgan":7,"valueText":"941억","capText":"7.8조","desc":"외국인 +134억 · 기관 +252억 · 개인 -377억 (확정 11/19 종가 기준)"},{"code":"068270","name":"셀트리온","market":"코스피","price":214500,"pct":3.37,"foreignEok":160.2,"organEok":153.1,"individualEok":-315.2,"streakForeign":2,"streakOrgan":1,"valueText":"1,242억","capText":"49.2조","desc":"외국인 +160억 · 기관 +153억 · 개인 -315억 (확정 11/19 종가 기준)"},{"code":"010170","name":"대한광통신","market":"코스닥","price":14450,"pct":7.92,"foreignEok":251.4,"organEok":19.8,"individualEok":-261.8,"streakForeign":2,"streakOrgan":2,"valueText":"821억","capText":"2.1조","desc":"외국인 +251억 · 기관 +20억 · 개인 -262억 (확정 11/19 종가 기준)"},{"code":"003490","name":"대한항공","market":"코스피","price":32650,"pct":3.49,"foreignEok":131.6,"organEok":128.1,"individualEok":-259.4,"streakForeign":8,"streakOrgan":1,"valueText":"651억","capText":"11.6조","desc":"외국인 +132억 · 기관 +128억 · 개인 -259억 (확정 11/19 종가 기준)"},{"code":"298040","name":"효성중공업","market":"코스피","price":1785000,"pct":5.25,"foreignEok":131.4,"organEok":93.4,"individualEok":-223.9,"streakForeign":2,"streakOrgan":2,"valueText":"511억","capText":"15.4조","desc":"외국인 +131억 · 기관 +93억 · 개인 -224억 (확정 11/19 종가 기준)"},{"code":"089590","name":"제주항공","market":"코스피","price":8500,"pct":11.11,"foreignEok":63.4,"organEok":53.9,"individualEok":-118.1,"streakForeign":1,"streakOrgan":4,"valueText":"201억","capText":"6,782억","desc":"외국인 +63억 · 기관 +54억 · 개인 -118억 (확정 11/19 종가 기준)"}]}};
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

function boot() {
  if (S.booted) return;
  S.booted = true;
  injectCss();
  render();
  applyLive();
  S.timer = setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    applyLive();
  }, 30000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

window.SupplyTab = {
  version: '1.0.0',
  reload: function () { render(); applyLive(); },
  data: function () { return SUPPLY; },
  state: function () { return window.__SUPPLY || { rendered: 0 }; }
};
})();
