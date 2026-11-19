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

const SUPPLY = {"generatedAt":"2026-11-19 16:47:35","basisDate":"20261118","basisLabel":"2026-11-18(수)","confirmed":true,"candidates":237,"source":"네이버 종목별 투자자별 매매동향(거래소 확정)","groups":{"foreignBuy":[{"code":"175330","name":"JB금융지주","market":"코스피","price":26100,"pct":-4.92,"foreignEok":776.0,"organEok":-790.0,"individualEok":15.7,"streakForeign":1,"streakOrgan":1,"valueText":"108억","capText":"4.8조","desc":"외국인 +776억 · 기관 -790억 · 개인 +16억 (확정 11/18 종가 기준)"},{"code":"373220","name":"LG에너지솔루션","market":"코스피","price":307000,"pct":0.82,"foreignEok":134.0,"organEok":-142.3,"individualEok":6.6,"streakForeign":2,"streakOrgan":5,"valueText":"707억","capText":"70.7조","desc":"외국인 +134억 · 기관 -142억 · 개인 +7억 (확정 11/18 종가 기준)"},{"code":"030530","name":"원익홀딩스","market":"코스닥","price":35800,"pct":11.35,"foreignEok":124.8,"organEok":108.9,"individualEok":-238.1,"streakForeign":1,"streakOrgan":9,"valueText":"1,482억","capText":"2.7조","desc":"외국인 +125억 · 기관 +109억 · 개인 -238억 (확정 11/18 종가 기준)"},{"code":"108490","name":"로보티즈","market":"코스닥","price":242000,"pct":14.96,"foreignEok":123.9,"organEok":158.5,"individualEok":-278.3,"streakForeign":1,"streakOrgan":1,"valueText":"651억","capText":"3.7조","desc":"외국인 +124억 · 기관 +158억 · 개인 -278억 (확정 11/18 종가 기준)"},{"code":"017670","name":"SK텔레콤","market":"코스피","price":83300,"pct":0.48,"foreignEok":121.8,"organEok":-111.1,"individualEok":-15.4,"streakForeign":2,"streakOrgan":1,"valueText":"994억","capText":"17.2조","desc":"외국인 +122억 · 기관 -111억 · 개인 -15억 (확정 11/18 종가 기준)"},{"code":"005380","name":"현대차","market":"코스피","price":268000,"pct":4.28,"foreignEok":119.1,"organEok":62.6,"individualEok":-174.5,"streakForeign":2,"streakOrgan":4,"valueText":"939억","capText":"54.4조","desc":"외국인 +119억 · 기관 +63억 · 개인 -174억 (확정 11/18 종가 기준)"}],"organBuy":[{"code":"005930","name":"삼성전자","market":"코스피","price":196400,"pct":3.48,"foreignEok":-1707.5,"organEok":2169.3,"individualEok":-578.9,"streakForeign":3,"streakOrgan":3,"valueText":"23,803억","capText":"1,151.1조","desc":"외국인 -1,708억 · 기관 +2,169억 · 개인 -579억 (확정 11/18 종가 기준)"},{"code":"009150","name":"삼성전기","market":"코스피","price":820000,"pct":9.63,"foreignEok":-125.2,"organEok":695.8,"individualEok":-543.3,"streakForeign":5,"streakOrgan":1,"valueText":"7,818억","capText":"66.1조","desc":"외국인 -125억 · 기관 +696억 · 개인 -543억 (확정 11/18 종가 기준)"},{"code":"402340","name":"SK스퀘어","market":"코스피","price":716000,"pct":6.07,"foreignEok":-27.6,"organEok":465.2,"individualEok":-441.8,"streakForeign":2,"streakOrgan":2,"valueText":"2,592억","capText":"97.5조","desc":"외국인 -28억 · 기관 +465억 · 개인 -442억 (확정 11/18 종가 기준)"},{"code":"000150","name":"두산","market":"코스피","price":597000,"pct":11.59,"foreignEok":-346.0,"organEok":327.9,"individualEok":12.7,"streakForeign":1,"streakOrgan":1,"valueText":"665억","capText":"8.7조","desc":"외국인 -346억 · 기관 +328억 · 개인 +13억 (확정 11/18 종가 기준)"},{"code":"000660","name":"SK하이닉스","market":"코스피","price":1164000,"pct":5.82,"foreignEok":-495.1,"organEok":325.3,"individualEok":-3878.8,"streakForeign":5,"streakOrgan":2,"valueText":"29,426억","capText":"836.1조","desc":"외국인 -495억 · 기관 +325억 · 개인 -3,879억 (확정 11/18 종가 기준)"},{"code":"034730","name":"SK","market":"코스피","price":493500,"pct":6.47,"foreignEok":-183.3,"organEok":286.9,"individualEok":-95.3,"streakForeign":3,"streakOrgan":4,"valueText":"673억","capText":"35.8조","desc":"외국인 -183억 · 기관 +287억 · 개인 -95억 (확정 11/18 종가 기준)"}],"foreignSell":[{"code":"005930","name":"삼성전자","market":"코스피","price":196400,"pct":3.48,"foreignEok":-1707.5,"organEok":2169.3,"individualEok":-578.9,"streakForeign":3,"streakOrgan":3,"valueText":"23,803억","capText":"1,151.1조","desc":"외국인 -1,708억 · 기관 +2,169억 · 개인 -579억 (확정 11/18 종가 기준)"},{"code":"000660","name":"SK하이닉스","market":"코스피","price":1164000,"pct":5.82,"foreignEok":-495.1,"organEok":325.3,"individualEok":-3878.8,"streakForeign":5,"streakOrgan":2,"valueText":"29,426억","capText":"836.1조","desc":"외국인 -495억 · 기관 +325억 · 개인 -3,879억 (확정 11/18 종가 기준)"},{"code":"007660","name":"이수페타시스","market":"코스피","price":81800,"pct":-3.65,"foreignEok":-352.9,"organEok":20.8,"individualEok":329.7,"streakForeign":7,"streakOrgan":2,"valueText":"656억","capText":"6.1조","desc":"외국인 -353억 · 기관 +21억 · 개인 +330억 (확정 11/18 종가 기준)"},{"code":"000150","name":"두산","market":"코스피","price":597000,"pct":11.59,"foreignEok":-346.0,"organEok":327.9,"individualEok":12.7,"streakForeign":1,"streakOrgan":1,"valueText":"665억","capText":"8.7조","desc":"외국인 -346억 · 기관 +328억 · 개인 +13억 (확정 11/18 종가 기준)"},{"code":"006400","name":"삼성SDI","market":"코스피","price":440500,"pct":-0.11,"foreignEok":-339.3,"organEok":-201.5,"individualEok":543.4,"streakForeign":3,"streakOrgan":3,"valueText":"2,598억","capText":"34.5조","desc":"외국인 -339억 · 기관 -202억 · 개인 +543억 (확정 11/18 종가 기준)"}],"dualBuy":[{"code":"108490","name":"로보티즈","market":"코스닥","price":242000,"pct":14.96,"foreignEok":123.9,"organEok":158.5,"individualEok":-278.3,"streakForeign":1,"streakOrgan":1,"valueText":"651억","capText":"3.7조","desc":"외국인 +124억 · 기관 +158억 · 개인 -278억 (확정 11/18 종가 기준)"},{"code":"277810","name":"레인보우로보틱스","market":"코스닥","price":408000,"pct":19.82,"foreignEok":33.2,"organEok":219.9,"individualEok":-263.3,"streakForeign":1,"streakOrgan":4,"valueText":"830억","capText":"8.3조","desc":"외국인 +33억 · 기관 +220억 · 개인 -263억 (확정 11/18 종가 기준)"},{"code":"030530","name":"원익홀딩스","market":"코스닥","price":35800,"pct":11.35,"foreignEok":124.8,"organEok":108.9,"individualEok":-238.1,"streakForeign":1,"streakOrgan":9,"valueText":"1,482억","capText":"2.7조","desc":"외국인 +125억 · 기관 +109억 · 개인 -238억 (확정 11/18 종가 기준)"},{"code":"005380","name":"현대차","market":"코스피","price":268000,"pct":4.28,"foreignEok":119.1,"organEok":62.6,"individualEok":-174.5,"streakForeign":2,"streakOrgan":4,"valueText":"939억","capText":"54.4조","desc":"외국인 +119억 · 기관 +63억 · 개인 -174억 (확정 11/18 종가 기준)"},{"code":"437730","name":"삼현","market":"코스닥","price":53200,"pct":13.31,"foreignEok":7.4,"organEok":169.2,"individualEok":-177.4,"streakForeign":2,"streakOrgan":1,"valueText":"292억","capText":"1.7조","desc":"외국인 +7억 · 기관 +169억 · 개인 -177억 (확정 11/18 종가 기준)"},{"code":"352820","name":"하이브","market":"코스피","price":178600,"pct":16.12,"foreignEok":6.8,"organEok":142.5,"individualEok":-155.9,"streakForeign":1,"streakOrgan":6,"valueText":"2,185억","capText":"8.2조","desc":"외국인 +7억 · 기관 +142억 · 개인 -156억 (확정 11/18 종가 기준)"}]}};
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
