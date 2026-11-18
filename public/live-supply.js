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

const SUPPLY = {"generatedAt":"2026-11-18 16:20:47","basisDate":"20261117","basisLabel":"2026-11-17(화)","confirmed":true,"candidates":235,"source":"네이버 종목별 투자자별 매매동향(거래소 확정)","groups":{"foreignBuy":[{"code":"066570","name":"LG전자","market":"코스피","price":128600,"pct":-1.53,"foreignEok":134.0,"organEok":-75.4,"individualEok":-55.5,"streakForeign":1,"streakOrgan":1,"valueText":"751억","capText":"22.3조","desc":"외국인 +134억 · 기관 -75억 · 개인 -56억 (확정 11/17 종가 기준)"},{"code":"278470","name":"에이피알","market":"코스피","price":230500,"pct":-3.35,"foreignEok":107.4,"organEok":-112.3,"individualEok":10.9,"streakForeign":7,"streakOrgan":7,"valueText":"532억","capText":"8.8조","desc":"외국인 +107억 · 기관 -112억 · 개인 +11억 (확정 11/17 종가 기준)"},{"code":"017670","name":"SK텔레콤","market":"코스피","price":82900,"pct":-1.66,"foreignEok":99.3,"organEok":3.9,"individualEok":-103.3,"streakForeign":1,"streakOrgan":3,"valueText":"788억","capText":"17.8조","desc":"외국인 +99억 · 기관 +4억 · 개인 -103억 (확정 11/17 종가 기준)"},{"code":"003490","name":"대한항공","market":"코스피","price":31750,"pct":0.16,"foreignEok":75.7,"organEok":107.0,"individualEok":-179.6,"streakForeign":6,"streakOrgan":3,"valueText":"606억","capText":"11.5조","desc":"외국인 +76억 · 기관 +107억 · 개인 -180억 (확정 11/17 종가 기준)"},{"code":"079550","name":"LIG디펜스앤에어로스페이스","market":"코스피","price":356500,"pct":0.42,"foreignEok":75.1,"organEok":-60.8,"individualEok":-13.8,"streakForeign":1,"streakOrgan":1,"valueText":"519억","capText":"7.7조","desc":"외국인 +75억 · 기관 -61억 · 개인 -14억 (확정 11/17 종가 기준)"},{"code":"000990","name":"DB하이텍","market":"코스피","price":72000,"pct":-2.31,"foreignEok":67.9,"organEok":-65.7,"individualEok":-7.0,"streakForeign":3,"streakOrgan":4,"valueText":"231억","capText":"3.2조","desc":"외국인 +68억 · 기관 -66억 · 개인 -7억 (확정 11/17 종가 기준)"}],"organBuy":[{"code":"005930","name":"삼성전자","market":"코스피","price":189800,"pct":-2.67,"foreignEok":-4715.4,"organEok":1661.3,"individualEok":2970.0,"streakForeign":2,"streakOrgan":2,"valueText":"33,227억","capText":"1,138.3조","desc":"외국인 -4,715억 · 기관 +1,661억 · 개인 +2,970억 (확정 11/17 종가 기준)"},{"code":"000660","name":"SK하이닉스","market":"코스피","price":1100000,"pct":-1.61,"foreignEok":-4392.6,"organEok":1430.8,"individualEok":-830.0,"streakForeign":4,"streakOrgan":1,"valueText":"39,170억","capText":"811.4조","desc":"외국인 -4,393억 · 기관 +1,431억 · 개인 -830억 (확정 11/17 종가 기준)"},{"code":"402340","name":"SK스퀘어","market":"코스피","price":675000,"pct":-1.03,"foreignEok":-106.9,"organEok":351.7,"individualEok":-250.7,"streakForeign":1,"streakOrgan":1,"valueText":"3,828억","capText":"93.8조","desc":"외국인 -107억 · 기관 +352억 · 개인 -251억 (확정 11/17 종가 기준)"},{"code":"105560","name":"KB금융","market":"코스피","price":156100,"pct":-3.46,"foreignEok":-338.8,"organEok":285.7,"individualEok":57.7,"streakForeign":2,"streakOrgan":3,"valueText":"1,158억","capText":"55.4조","desc":"외국인 -339억 · 기관 +286억 · 개인 +58억 (확정 11/17 종가 기준)"},{"code":"007660","name":"이수페타시스","market":"코스피","price":84900,"pct":5.33,"foreignEok":-239.1,"organEok":201.6,"individualEok":36.7,"streakForeign":6,"streakOrgan":1,"valueText":"1,065억","capText":"5.9조","desc":"외국인 -239억 · 기관 +202억 · 개인 +37억 (확정 11/17 종가 기준)"},{"code":"316140","name":"우리금융지주","market":"코스피","price":32450,"pct":-1.96,"foreignEok":-190.4,"organEok":188.1,"individualEok":1.4,"streakForeign":2,"streakOrgan":3,"valueText":"467억","capText":"23.7조","desc":"외국인 -190억 · 기관 +188억 · 개인 +1억 (확정 11/17 종가 기준)"}],"foreignSell":[{"code":"005930","name":"삼성전자","market":"코스피","price":189800,"pct":-2.67,"foreignEok":-4715.4,"organEok":1661.3,"individualEok":2970.0,"streakForeign":2,"streakOrgan":2,"valueText":"33,227억","capText":"1,138.3조","desc":"외국인 -4,715억 · 기관 +1,661억 · 개인 +2,970억 (확정 11/17 종가 기준)"},{"code":"000660","name":"SK하이닉스","market":"코스피","price":1100000,"pct":-1.61,"foreignEok":-4392.6,"organEok":1430.8,"individualEok":-830.0,"streakForeign":4,"streakOrgan":1,"valueText":"39,170억","capText":"811.4조","desc":"외국인 -4,393억 · 기관 +1,431억 · 개인 -830억 (확정 11/17 종가 기준)"},{"code":"105560","name":"KB금융","market":"코스피","price":156100,"pct":-3.46,"foreignEok":-338.8,"organEok":285.7,"individualEok":57.7,"streakForeign":2,"streakOrgan":3,"valueText":"1,158억","capText":"55.4조","desc":"외국인 -339억 · 기관 +286억 · 개인 +58억 (확정 11/17 종가 기준)"},{"code":"006400","name":"삼성SDI","market":"코스피","price":441000,"pct":-4.85,"foreignEok":-268.5,"organEok":-173.8,"individualEok":443.9,"streakForeign":2,"streakOrgan":2,"valueText":"2,353억","capText":"35.1조","desc":"외국인 -268억 · 기관 -174억 · 개인 +444억 (확정 11/17 종가 기준)"},{"code":"028050","name":"삼성E&A","market":"코스피","price":67600,"pct":-1.89,"foreignEok":-266.2,"organEok":70.4,"individualEok":29.7,"streakForeign":10,"streakOrgan":10,"valueText":"2,766억","capText":"12.5조","desc":"외국인 -266억 · 기관 +70억 · 개인 +30억 (확정 11/17 종가 기준)"}],"dualBuy":[{"code":"003490","name":"대한항공","market":"코스피","price":31750,"pct":0.16,"foreignEok":75.7,"organEok":107.0,"individualEok":-179.6,"streakForeign":6,"streakOrgan":3,"valueText":"606억","capText":"11.5조","desc":"외국인 +76억 · 기관 +107억 · 개인 -180억 (확정 11/17 종가 기준)"},{"code":"000100","name":"유한양행","market":"코스피","price":83100,"pct":2.47,"foreignEok":14.6,"organEok":94.8,"individualEok":-88.4,"streakForeign":3,"streakOrgan":4,"valueText":"199억","capText":"5.9조","desc":"외국인 +15억 · 기관 +95억 · 개인 -88억 (확정 11/17 종가 기준)"},{"code":"196170","name":"알테오젠","market":"코스닥","price":172800,"pct":0.88,"foreignEok":31.9,"organEok":76.6,"individualEok":-107.9,"streakForeign":7,"streakOrgan":1,"valueText":"470억","capText":"11.9조","desc":"외국인 +32억 · 기관 +77억 · 개인 -108억 (확정 11/17 종가 기준)"},{"code":"017670","name":"SK텔레콤","market":"코스피","price":82900,"pct":-1.66,"foreignEok":99.3,"organEok":3.9,"individualEok":-103.3,"streakForeign":1,"streakOrgan":3,"valueText":"788억","capText":"17.8조","desc":"외국인 +99억 · 기관 +4억 · 개인 -103억 (확정 11/17 종가 기준)"},{"code":"328130","name":"루닛","market":"코스닥","price":15930,"pct":8.37,"foreignEok":47.4,"organEok":43.8,"individualEok":-91.8,"streakForeign":1,"streakOrgan":4,"valueText":"228억","capText":"1.2조","desc":"외국인 +47억 · 기관 +44억 · 개인 -92억 (확정 11/17 종가 기준)"},{"code":"005380","name":"현대차","market":"코스피","price":257000,"pct":-2.65,"foreignEok":33.7,"organEok":50.1,"individualEok":-76.9,"streakForeign":1,"streakOrgan":3,"valueText":"1,126억","capText":"54.3조","desc":"외국인 +34억 · 기관 +50억 · 개인 -77억 (확정 11/17 종가 기준)"}]}};
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
