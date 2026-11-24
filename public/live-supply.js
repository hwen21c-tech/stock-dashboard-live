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

const SUPPLY = {"generatedAt":"2026-11-24 15:56:29","basisDate":"20261123","basisLabel":"2026-11-23(월)","confirmed":true,"candidates":233,"source":"네이버 종목별 투자자별 매매동향(거래소 확정)","groups":{"foreignBuy":[{"code":"078930","name":"GS","market":"코스피","price":70000,"pct":-6.79,"foreignEok":304.3,"organEok":-95.3,"individualEok":-225.1,"streakForeign":3,"streakOrgan":3,"valueText":"228억","capText":"6.4조","desc":"외국인 +304억 · 기관 -95억 · 개인 -225억 (확정 11/23 종가 기준)"},{"code":"402340","name":"SK스퀘어","market":"코스피","price":691000,"pct":2.83,"foreignEok":230.7,"organEok":59.1,"individualEok":-270.3,"streakForeign":1,"streakOrgan":1,"valueText":"4,165억","capText":"94.3조","desc":"외국인 +231억 · 기관 +59억 · 개인 -270억 (확정 11/23 종가 기준)"},{"code":"007660","name":"이수페타시스","market":"코스피","price":72800,"pct":6.28,"foreignEok":218.6,"organEok":-108.8,"individualEok":-109.9,"streakForeign":1,"streakOrgan":2,"valueText":"957억","capText":"5.4조","desc":"외국인 +219억 · 기관 -109억 · 개인 -110억 (확정 11/23 종가 기준)"},{"code":"006400","name":"삼성SDI","market":"코스피","price":401500,"pct":0.75,"foreignEok":167.3,"organEok":28.7,"individualEok":-186.3,"streakForeign":2,"streakOrgan":1,"valueText":"3,193억","capText":"36.3조","desc":"외국인 +167억 · 기관 +29억 · 개인 -186억 (확정 11/23 종가 기준)"},{"code":"011070","name":"LG이노텍","market":"코스피","price":261500,"pct":-1.51,"foreignEok":144.0,"organEok":-46.0,"individualEok":-70.0,"streakForeign":1,"streakOrgan":2,"valueText":"435억","capText":"6.7조","desc":"외국인 +144억 · 기관 -46억 · 개인 -70억 (확정 11/23 종가 기준)"},{"code":"042700","name":"한미반도체","market":"코스피","price":154100,"pct":1.65,"foreignEok":127.9,"organEok":-61.3,"individualEok":-67.7,"streakForeign":2,"streakOrgan":2,"valueText":"1,024억","capText":"15.6조","desc":"외국인 +128억 · 기관 -61억 · 개인 -68억 (확정 11/23 종가 기준)"}],"organBuy":[{"code":"005930","name":"삼성전자","market":"코스피","price":180600,"pct":-0.17,"foreignEok":-81.6,"organEok":1194.3,"individualEok":-1217.0,"streakForeign":6,"streakOrgan":1,"valueText":"29,943억","capText":"1,107.3조","desc":"외국인 -82억 · 기관 +1,194억 · 개인 -1,217억 (확정 11/23 종가 기준)"},{"code":"278470","name":"에이피알","market":"코스피","price":256000,"pct":10.11,"foreignEok":-145.4,"organEok":400.0,"individualEok":-249.6,"streakForeign":1,"streakOrgan":1,"valueText":"614억","capText":"9.9조","desc":"외국인 -145억 · 기관 +400억 · 개인 -250억 (확정 11/23 종가 기준)"},{"code":"009150","name":"삼성전기","market":"코스피","price":797000,"pct":3.91,"foreignEok":34.2,"organEok":388.9,"individualEok":-418.0,"streakForeign":1,"streakOrgan":1,"valueText":"6,675억","capText":"64.1조","desc":"외국인 +34억 · 기관 +389억 · 개인 -418억 (확정 11/23 종가 기준)"},{"code":"108490","name":"로보티즈","market":"코스닥","price":249500,"pct":6.85,"foreignEok":-46.0,"organEok":223.7,"individualEok":-166.7,"streakForeign":3,"streakOrgan":1,"valueText":"2,090억","capText":"4.3조","desc":"외국인 -46억 · 기관 +224억 · 개인 -167억 (확정 11/23 종가 기준)"},{"code":"000150","name":"두산","market":"코스피","price":552000,"pct":6.56,"foreignEok":-82.4,"organEok":195.2,"individualEok":-124.9,"streakForeign":4,"streakOrgan":1,"valueText":"995억","capText":"8.8조","desc":"외국인 -82억 · 기관 +195억 · 개인 -125억 (확정 11/23 종가 기준)"},{"code":"068270","name":"셀트리온","market":"코스피","price":202500,"pct":-4.71,"foreignEok":-55.4,"organEok":193.4,"individualEok":-129.0,"streakForeign":1,"streakOrgan":3,"valueText":"784억","capText":"48.5조","desc":"외국인 -55억 · 기관 +193억 · 개인 -129억 (확정 11/23 종가 기준)"}],"foreignSell":[{"code":"000660","name":"SK하이닉스","market":"코스피","price":1101000,"pct":0.09,"foreignEok":-1851.7,"organEok":-300.8,"individualEok":-1725.2,"streakForeign":8,"streakOrgan":3,"valueText":"38,841억","capText":"818.5조","desc":"외국인 -1,852억 · 기관 -301억 · 개인 -1,725억 (확정 11/23 종가 기준)"},{"code":"086790","name":"하나금융지주","market":"코스피","price":118000,"pct":-4.99,"foreignEok":-243.4,"organEok":187.0,"individualEok":56.8,"streakForeign":2,"streakOrgan":2,"valueText":"773억","capText":"33.1조","desc":"외국인 -243억 · 기관 +187억 · 개인 +57억 (확정 11/23 종가 기준)"},{"code":"277810","name":"레인보우로보틱스","market":"코스닥","price":412000,"pct":2.23,"foreignEok":-236.5,"organEok":129.2,"individualEok":106.3,"streakForeign":3,"streakOrgan":7,"valueText":"1,406억","capText":"9.2조","desc":"외국인 -236억 · 기관 +129억 · 개인 +106억 (확정 11/23 종가 기준)"},{"code":"035420","name":"NAVER","market":"코스피","price":150800,"pct":-6.22,"foreignEok":-195.3,"organEok":-496.0,"individualEok":688.1,"streakForeign":3,"streakOrgan":8,"valueText":"1,051억","capText":"23.7조","desc":"외국인 -195억 · 기관 -496억 · 개인 +688억 (확정 11/23 종가 기준)"},{"code":"105560","name":"KB금융","market":"코스피","price":145000,"pct":-5.29,"foreignEok":-182.2,"organEok":57.7,"individualEok":122.2,"streakForeign":6,"streakOrgan":2,"valueText":"1,049억","capText":"53.7조","desc":"외국인 -182억 · 기관 +58억 · 개인 +122억 (확정 11/23 종가 기준)"}],"dualBuy":[{"code":"009150","name":"삼성전기","market":"코스피","price":797000,"pct":3.91,"foreignEok":34.2,"organEok":388.9,"individualEok":-418.0,"streakForeign":1,"streakOrgan":1,"valueText":"6,675억","capText":"64.1조","desc":"외국인 +34억 · 기관 +389억 · 개인 -418억 (확정 11/23 종가 기준)"},{"code":"402340","name":"SK스퀘어","market":"코스피","price":691000,"pct":2.83,"foreignEok":230.7,"organEok":59.1,"individualEok":-270.3,"streakForeign":1,"streakOrgan":1,"valueText":"4,165억","capText":"94.3조","desc":"외국인 +231억 · 기관 +59억 · 개인 -270억 (확정 11/23 종가 기준)"},{"code":"006400","name":"삼성SDI","market":"코스피","price":401500,"pct":0.75,"foreignEok":167.3,"organEok":28.7,"individualEok":-186.3,"streakForeign":2,"streakOrgan":1,"valueText":"3,193억","capText":"36.3조","desc":"외국인 +167억 · 기관 +29억 · 개인 -186억 (확정 11/23 종가 기준)"},{"code":"005380","name":"현대차","market":"코스피","price":248500,"pct":-1.78,"foreignEok":35.1,"organEok":119.8,"individualEok":-153.7,"streakForeign":5,"streakOrgan":1,"valueText":"1,842억","capText":"56.0조","desc":"외국인 +35억 · 기관 +120억 · 개인 -154억 (확정 11/23 종가 기준)"},{"code":"010120","name":"LS ELECTRIC","market":"코스피","price":112000,"pct":3.32,"foreignEok":67.6,"organEok":24.2,"individualEok":-90.9,"streakForeign":1,"streakOrgan":1,"valueText":"784억","capText":"18.3조","desc":"외국인 +68억 · 기관 +24억 · 개인 -91억 (확정 11/23 종가 기준)"},{"code":"053800","name":"안랩","market":"코스닥","price":114500,"pct":4.38,"foreignEok":58.5,"organEok":24.8,"individualEok":-85.0,"streakForeign":1,"streakOrgan":3,"valueText":"560억","capText":"1.4조","desc":"외국인 +58억 · 기관 +25억 · 개인 -85억 (확정 11/23 종가 기준)"}]}};
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
