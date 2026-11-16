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

const SUPPLY = {"generatedAt":"2026-11-16 15:44:54","basisDate":"20261113","basisLabel":"2026-11-13(금)","confirmed":true,"candidates":235,"source":"네이버 종목별 투자자별 매매동향(거래소 확정)","groups":{"foreignBuy":[{"code":"010140","name":"삼성중공업","market":"코스피","price":16590,"pct":0.18,"foreignEok":324.5,"organEok":-434.5,"individualEok":103.3,"streakForeign":2,"streakOrgan":3,"valueText":"421억","capText":"14.7조","desc":"외국인 +324억 · 기관 -434억 · 개인 +103억 (확정 11/13 종가 기준)"},{"code":"006400","name":"삼성SDI","market":"코스피","price":480000,"pct":2.89,"foreignEok":285.2,"organEok":50.4,"individualEok":-355.6,"streakForeign":1,"streakOrgan":4,"valueText":"3,070억","capText":"37.3조","desc":"외국인 +285억 · 기관 +50억 · 개인 -356억 (확정 11/13 종가 기준)"},{"code":"180640","name":"한진칼","market":"코스피","price":200000,"pct":1.01,"foreignEok":267.3,"organEok":34.8,"individualEok":-302.2,"streakForeign":1,"streakOrgan":3,"valueText":"805억","capText":"14.4조","desc":"외국인 +267억 · 기관 +35억 · 개인 -302억 (확정 11/13 종가 기준)"},{"code":"005380","name":"현대차","market":"코스피","price":270500,"pct":1.5,"foreignEok":219.7,"organEok":98.4,"individualEok":-314.9,"streakForeign":2,"streakOrgan":1,"valueText":"833억","capText":"54.0조","desc":"외국인 +220억 · 기관 +98억 · 개인 -315억 (확정 11/13 종가 기준)"},{"code":"064400","name":"LG씨엔에스","market":"코스피","price":79300,"pct":6.02,"foreignEok":154.9,"organEok":66.1,"individualEok":-218.7,"streakForeign":3,"streakOrgan":1,"valueText":"928억","capText":"7.5조","desc":"외국인 +155억 · 기관 +66억 · 개인 -219억 (확정 11/13 종가 기준)"},{"code":"105560","name":"KB금융","market":"코스피","price":158000,"pct":3.74,"foreignEok":127.1,"organEok":26.7,"individualEok":-156.5,"streakForeign":4,"streakOrgan":1,"valueText":"1,301억","capText":"57.3조","desc":"외국인 +127억 · 기관 +27억 · 개인 -156억 (확정 11/13 종가 기준)"}],"organBuy":[{"code":"329180","name":"HD현대중공업","market":"코스피","price":272000,"pct":1.49,"foreignEok":-348.1,"organEok":418.1,"individualEok":-69.2,"streakForeign":1,"streakOrgan":1,"valueText":"337억","capText":"28.3조","desc":"외국인 -348억 · 기관 +418억 · 개인 -69억 (확정 11/13 종가 기준)"},{"code":"007660","name":"이수페타시스","market":"코스피","price":91000,"pct":7.69,"foreignEok":-342.3,"organEok":369.4,"individualEok":-34.0,"streakForeign":4,"streakOrgan":4,"valueText":"959억","capText":"6.0조","desc":"외국인 -342억 · 기관 +369억 · 개인 -34억 (확정 11/13 종가 기준)"},{"code":"068270","name":"셀트리온","market":"코스피","price":213500,"pct":1.43,"foreignEok":-19.5,"organEok":356.1,"individualEok":-334.6,"streakForeign":1,"streakOrgan":1,"valueText":"746억","capText":"49.8조","desc":"외국인 -20억 · 기관 +356억 · 개인 -335억 (확정 11/13 종가 기준)"},{"code":"042660","name":"한화오션","market":"코스피","price":48900,"pct":2.3,"foreignEok":-236.1,"organEok":309.6,"individualEok":-73.1,"streakForeign":1,"streakOrgan":1,"valueText":"299억","capText":"14.3조","desc":"외국인 -236억 · 기관 +310억 · 개인 -73억 (확정 11/13 종가 기준)"},{"code":"000660","name":"SK하이닉스","market":"코스피","price":1233000,"pct":-0.64,"foreignEok":-4566.3,"organEok":298.5,"individualEok":84.7,"streakForeign":2,"streakOrgan":2,"valueText":"46,407억","capText":"818.2조","desc":"외국인 -4,566억 · 기관 +298억 · 개인 +85억 (확정 11/13 종가 기준)"},{"code":"039490","name":"키움증권","market":"코스피","price":205500,"pct":5.76,"foreignEok":-212.0,"organEok":266.5,"individualEok":-53.5,"streakForeign":10,"streakOrgan":8,"valueText":"103억","capText":"5.2조","desc":"외국인 -212억 · 기관 +266억 · 개인 -54억 (확정 11/13 종가 기준)"}],"foreignSell":[{"code":"000660","name":"SK하이닉스","market":"코스피","price":1233000,"pct":-0.64,"foreignEok":-4566.3,"organEok":298.5,"individualEok":84.7,"streakForeign":2,"streakOrgan":2,"valueText":"46,407억","capText":"818.2조","desc":"외국인 -4,566억 · 기관 +298억 · 개인 +85억 (확정 11/13 종가 기준)"},{"code":"015760","name":"한국전력","market":"코스피","price":27600,"pct":-7.23,"foreignEok":-498.6,"organEok":-400.1,"individualEok":893.9,"streakForeign":1,"streakOrgan":2,"valueText":"451억","capText":"17.2조","desc":"외국인 -499억 · 기관 -400억 · 개인 +894억 (확정 11/13 종가 기준)"},{"code":"009150","name":"삼성전기","market":"코스피","price":864000,"pct":-1.03,"foreignEok":-484.1,"organEok":-448.0,"individualEok":889.9,"streakForeign":2,"streakOrgan":2,"valueText":"7,214억","capText":"58.6조","desc":"외국인 -484억 · 기관 -448억 · 개인 +890억 (확정 11/13 종가 기준)"},{"code":"329180","name":"HD현대중공업","market":"코스피","price":272000,"pct":1.49,"foreignEok":-348.1,"organEok":418.1,"individualEok":-69.2,"streakForeign":1,"streakOrgan":1,"valueText":"337억","capText":"28.3조","desc":"외국인 -348억 · 기관 +418억 · 개인 -69억 (확정 11/13 종가 기준)"},{"code":"007660","name":"이수페타시스","market":"코스피","price":91000,"pct":7.69,"foreignEok":-342.3,"organEok":369.4,"individualEok":-34.0,"streakForeign":4,"streakOrgan":4,"valueText":"959억","capText":"6.0조","desc":"외국인 -342억 · 기관 +369억 · 개인 -34억 (확정 11/13 종가 기준)"}],"dualBuy":[{"code":"006400","name":"삼성SDI","market":"코스피","price":480000,"pct":2.89,"foreignEok":285.2,"organEok":50.4,"individualEok":-355.6,"streakForeign":1,"streakOrgan":4,"valueText":"3,070억","capText":"37.3조","desc":"외국인 +285억 · 기관 +50억 · 개인 -356억 (확정 11/13 종가 기준)"},{"code":"005380","name":"현대차","market":"코스피","price":270500,"pct":1.5,"foreignEok":219.7,"organEok":98.4,"individualEok":-314.9,"streakForeign":2,"streakOrgan":1,"valueText":"833억","capText":"54.0조","desc":"외국인 +220억 · 기관 +98억 · 개인 -315억 (확정 11/13 종가 기준)"},{"code":"180640","name":"한진칼","market":"코스피","price":200000,"pct":1.01,"foreignEok":267.3,"organEok":34.8,"individualEok":-302.2,"streakForeign":1,"streakOrgan":3,"valueText":"805억","capText":"14.4조","desc":"외국인 +267억 · 기관 +35억 · 개인 -302억 (확정 11/13 종가 기준)"},{"code":"064400","name":"LG씨엔에스","market":"코스피","price":79300,"pct":6.02,"foreignEok":154.9,"organEok":66.1,"individualEok":-218.7,"streakForeign":3,"streakOrgan":1,"valueText":"928억","capText":"7.5조","desc":"외국인 +155억 · 기관 +66억 · 개인 -219억 (확정 11/13 종가 기준)"},{"code":"017670","name":"SK텔레콤","market":"코스피","price":84600,"pct":4.7,"foreignEok":123.0,"organEok":68.7,"individualEok":-190.8,"streakForeign":2,"streakOrgan":1,"valueText":"899억","capText":"18.0조","desc":"외국인 +123억 · 기관 +69억 · 개인 -191억 (확정 11/13 종가 기준)"},{"code":"105560","name":"KB금융","market":"코스피","price":158000,"pct":3.74,"foreignEok":127.1,"organEok":26.7,"individualEok":-156.5,"streakForeign":4,"streakOrgan":1,"valueText":"1,301억","capText":"57.3조","desc":"외국인 +127억 · 기관 +27억 · 개인 -156억 (확정 11/13 종가 기준)"}]}};
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
