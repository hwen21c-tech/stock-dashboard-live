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

const SUPPLY = {"generatedAt":"2026-11-16 21:55:56","basisDate":"20261116","basisLabel":"2026-11-16(월)","confirmed":true,"candidates":237,"source":"네이버 종목별 투자자별 매매동향(거래소 확정)","groups":{"foreignBuy":[{"code":"402340","name":"SK스퀘어","market":"코스피","price":682000,"pct":-11.31,"foreignEok":282.7,"organEok":-1223.3,"individualEok":923.1,"streakForeign":7,"streakOrgan":5,"valueText":"5,610억","capText":"90.0조","desc":"외국인 +283억 · 기관 -1,223억 · 개인 +923억 (확정 11/16 종가 기준)"},{"code":"003230","name":"삼양식품","market":"코스피","price":1277000,"pct":5.1,"foreignEok":161.5,"organEok":140.4,"individualEok":-274.4,"streakForeign":1,"streakOrgan":1,"valueText":"784억","capText":"9.6조","desc":"외국인 +162억 · 기관 +140억 · 개인 -274억 (확정 11/16 종가 기준)"},{"code":"278470","name":"에이피알","market":"코스피","price":238500,"pct":1.27,"foreignEok":149.3,"organEok":-77.7,"individualEok":-72.3,"streakForeign":6,"streakOrgan":6,"valueText":"747억","capText":"8.9조","desc":"외국인 +149억 · 기관 -78억 · 개인 -72억 (확정 11/16 종가 기준)"},{"code":"353200","name":"대덕전자","market":"코스피","price":81400,"pct":-12.57,"foreignEok":141.0,"organEok":-63.3,"individualEok":-75.9,"streakForeign":1,"streakOrgan":1,"valueText":"999억","capText":"4.0조","desc":"외국인 +141억 · 기관 -63억 · 개인 -76억 (확정 11/16 종가 기준)"},{"code":"039030","name":"이오테크닉스","market":"코스닥","price":323500,"pct":-9.64,"foreignEok":79.1,"organEok":-89.3,"individualEok":10.7,"streakForeign":1,"streakOrgan":2,"valueText":"418억","capText":"4.0조","desc":"외국인 +79억 · 기관 -89억 · 개인 +11억 (확정 11/16 종가 기준)"},{"code":"128940","name":"한미약품","market":"코스피","price":443500,"pct":-5.13,"foreignEok":74.8,"organEok":-40.0,"individualEok":-28.1,"streakForeign":5,"streakOrgan":1,"valueText":"320억","capText":"5.7조","desc":"외국인 +75억 · 기관 -40억 · 개인 -28억 (확정 11/16 종가 기준)"}],"organBuy":[{"code":"005930","name":"삼성전자","market":"코스피","price":195000,"pct":-6.7,"foreignEok":-6055.9,"organEok":1662.6,"individualEok":4285.3,"streakForeign":1,"streakOrgan":1,"valueText":"32,197억","capText":"1,140.0조","desc":"외국인 -6,056억 · 기관 +1,663억 · 개인 +4,285억 (확정 11/16 종가 기준)"},{"code":"068270","name":"셀트리온","market":"코스피","price":214000,"pct":0.23,"foreignEok":-47.3,"organEok":262.9,"individualEok":-220.9,"streakForeign":2,"streakOrgan":2,"valueText":"756억","capText":"49.7조","desc":"외국인 -47억 · 기관 +263억 · 개인 -221억 (확정 11/16 종가 기준)"},{"code":"316140","name":"우리금융지주","market":"코스피","price":33100,"pct":2.16,"foreignEok":-209.1,"organEok":257.6,"individualEok":-50.7,"streakForeign":1,"streakOrgan":2,"valueText":"674억","capText":"24.4조","desc":"외국인 -209억 · 기관 +258억 · 개인 -51억 (확정 11/16 종가 기준)"},{"code":"017670","name":"SK텔레콤","market":"코스피","price":84300,"pct":-0.35,"foreignEok":-136.0,"organEok":233.5,"individualEok":-103.9,"streakForeign":1,"streakOrgan":2,"valueText":"916억","capText":"18.1조","desc":"외국인 -136억 · 기관 +234억 · 개인 -104억 (확정 11/16 종가 기준)"},{"code":"000810","name":"삼성화재","market":"코스피","price":543000,"pct":2.84,"foreignEok":-194.8,"organEok":232.4,"individualEok":-37.4,"streakForeign":3,"streakOrgan":2,"valueText":"925억","capText":"24.2조","desc":"외국인 -195억 · 기관 +232억 · 개인 -37억 (확정 11/16 종가 기준)"},{"code":"005380","name":"현대차","market":"코스피","price":264000,"pct":-2.4,"foreignEok":-96.8,"organEok":178.4,"individualEok":-79.2,"streakForeign":1,"streakOrgan":2,"valueText":"860억","capText":"53.7조","desc":"외국인 -97억 · 기관 +178억 · 개인 -79억 (확정 11/16 종가 기준)"}],"foreignSell":[{"code":"005930","name":"삼성전자","market":"코스피","price":195000,"pct":-6.7,"foreignEok":-6055.9,"organEok":1662.6,"individualEok":4285.3,"streakForeign":1,"streakOrgan":1,"valueText":"32,197억","capText":"1,140.0조","desc":"외국인 -6,056억 · 기관 +1,663억 · 개인 +4,285억 (확정 11/16 종가 기준)"},{"code":"000660","name":"SK하이닉스","market":"코스피","price":1118000,"pct":-9.33,"foreignEok":-1785.5,"organEok":-7760.4,"individualEok":5630.6,"streakForeign":3,"streakOrgan":1,"valueText":"47,980억","capText":"816.7조","desc":"외국인 -1,786억 · 기관 -7,760억 · 개인 +5,631억 (확정 11/16 종가 기준)"},{"code":"009150","name":"삼성전기","market":"코스피","price":779000,"pct":-9.84,"foreignEok":-960.3,"organEok":-796.9,"individualEok":1732.5,"streakForeign":3,"streakOrgan":3,"valueText":"7,535억","capText":"58.2조","desc":"외국인 -960억 · 기관 -797억 · 개인 +1,732억 (확정 11/16 종가 기준)"},{"code":"006400","name":"삼성SDI","market":"코스피","price":463500,"pct":-3.44,"foreignEok":-508.5,"organEok":-278.7,"individualEok":788.8,"streakForeign":1,"streakOrgan":1,"valueText":"3,186억","capText":"37.4조","desc":"외국인 -508억 · 기관 -279억 · 개인 +789억 (확정 11/16 종가 기준)"},{"code":"028050","name":"삼성E&A","market":"코스피","price":68900,"pct":-0.72,"foreignEok":-287.4,"organEok":17.2,"individualEok":96.1,"streakForeign":10,"streakOrgan":10,"valueText":"1,407억","capText":"13.5조","desc":"외국인 -287억 · 기관 +17억 · 개인 +96억 (확정 11/16 종가 기준)"}],"dualBuy":[{"code":"003230","name":"삼양식품","market":"코스피","price":1277000,"pct":5.1,"foreignEok":161.5,"organEok":140.4,"individualEok":-274.4,"streakForeign":1,"streakOrgan":1,"valueText":"784억","capText":"9.6조","desc":"외국인 +162억 · 기관 +140억 · 개인 -274억 (확정 11/16 종가 기준)"},{"code":"180640","name":"한진칼","market":"코스피","price":219000,"pct":9.5,"foreignEok":72.0,"organEok":133.7,"individualEok":-202.5,"streakForeign":2,"streakOrgan":4,"valueText":"933억","capText":"14.6조","desc":"외국인 +72억 · 기관 +134억 · 개인 -202억 (확정 11/16 종가 기준)"},{"code":"011200","name":"HMM","market":"코스피","price":22000,"pct":3.29,"foreignEok":55.8,"organEok":59.3,"individualEok":-114.9,"streakForeign":3,"streakOrgan":2,"valueText":"298억","capText":"20.8조","desc":"외국인 +56억 · 기관 +59억 · 개인 -115억 (확정 11/16 종가 기준)"},{"code":"003490","name":"대한항공","market":"코스피","price":31700,"pct":0.32,"foreignEok":74.5,"organEok":39.7,"individualEok":-112.2,"streakForeign":5,"streakOrgan":2,"valueText":"571억","capText":"11.7조","desc":"외국인 +74억 · 기관 +40억 · 개인 -112억 (확정 11/16 종가 기준)"},{"code":"010140","name":"삼성중공업","market":"코스피","price":16610,"pct":0.12,"foreignEok":13.1,"organEok":68.1,"individualEok":-81.2,"streakForeign":3,"streakOrgan":1,"valueText":"432억","capText":"14.6조","desc":"외국인 +13억 · 기관 +68억 · 개인 -81억 (확정 11/16 종가 기준)"},{"code":"086280","name":"현대글로비스","market":"코스피","price":205000,"pct":0.99,"foreignEok":13.4,"organEok":50.8,"individualEok":-63.1,"streakForeign":3,"streakOrgan":1,"valueText":"232억","capText":"15.4조","desc":"외국인 +13억 · 기관 +51억 · 개인 -63억 (확정 11/16 종가 기준)"}]}};
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
    esc(signPct(it.pct, 2)) + "', '" + esc(badge) + "', '" + reason.replace(/'/g, "\\'") + "')";
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
