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

const SUPPLY = {"generatedAt":"2026-11-25 06:47:49","basisDate":"20261124","basisLabel":"2026-11-24(화)","confirmed":true,"candidates":236,"source":"네이버 종목별 투자자별 매매동향(거래소 확정)","groups":{"foreignBuy":[{"code":"005930","name":"삼성전자","market":"코스피","price":182900,"pct":1.27,"foreignEok":4294.6,"organEok":2151.8,"individualEok":-6219.8,"streakForeign":1,"streakOrgan":2,"valueText":"32,509억","capText":"1,069.3조","desc":"외국인 +4,295억 · 기관 +2,152억 · 개인 -6,220억 (확정 11/24 종가 기준)"},{"code":"009150","name":"삼성전기","market":"코스피","price":820000,"pct":2.89,"foreignEok":741.6,"organEok":884.8,"individualEok":-1646.1,"streakForeign":2,"streakOrgan":2,"valueText":"7,451억","capText":"61.2조","desc":"외국인 +742억 · 기관 +885억 · 개인 -1,646억 (확정 11/24 종가 기준)"},{"code":"006400","name":"삼성SDI","market":"코스피","price":431000,"pct":7.35,"foreignEok":397.4,"organEok":999.6,"individualEok":-1386.4,"streakForeign":3,"streakOrgan":2,"valueText":"3,425억","capText":"34.7조","desc":"외국인 +397억 · 기관 +1,000억 · 개인 -1,386억 (확정 11/24 종가 기준)"},{"code":"010170","name":"대한광통신","market":"코스닥","price":14270,"pct":0.71,"foreignEok":259.6,"organEok":7.6,"individualEok":-265.0,"streakForeign":2,"streakOrgan":5,"valueText":"1,238억","capText":"2.2조","desc":"외국인 +260억 · 기관 +8억 · 개인 -265억 (확정 11/24 종가 기준)"},{"code":"000270","name":"기아","market":"코스피","price":92600,"pct":6.93,"foreignEok":251.6,"organEok":-3.9,"individualEok":-245.2,"streakForeign":1,"streakOrgan":1,"valueText":"1,165억","capText":"36.2조","desc":"외국인 +252억 · 기관 -4억 · 개인 -245억 (확정 11/24 종가 기준)"},{"code":"005380","name":"현대차","market":"코스피","price":264500,"pct":6.44,"foreignEok":197.1,"organEok":533.8,"individualEok":-737.4,"streakForeign":6,"streakOrgan":2,"valueText":"1,934억","capText":"53.8조","desc":"외국인 +197억 · 기관 +534억 · 개인 -737억 (확정 11/24 종가 기준)"}],"organBuy":[{"code":"005930","name":"삼성전자","market":"코스피","price":182900,"pct":1.27,"foreignEok":4294.6,"organEok":2151.8,"individualEok":-6219.8,"streakForeign":1,"streakOrgan":2,"valueText":"32,509억","capText":"1,069.3조","desc":"외국인 +4,295억 · 기관 +2,152억 · 개인 -6,220억 (확정 11/24 종가 기준)"},{"code":"006400","name":"삼성SDI","market":"코스피","price":431000,"pct":7.35,"foreignEok":397.4,"organEok":999.6,"individualEok":-1386.4,"streakForeign":3,"streakOrgan":2,"valueText":"3,425억","capText":"34.7조","desc":"외국인 +397억 · 기관 +1,000억 · 개인 -1,386억 (확정 11/24 종가 기준)"},{"code":"009150","name":"삼성전기","market":"코스피","price":820000,"pct":2.89,"foreignEok":741.6,"organEok":884.8,"individualEok":-1646.1,"streakForeign":2,"streakOrgan":2,"valueText":"7,451억","capText":"61.2조","desc":"외국인 +742억 · 기관 +885억 · 개인 -1,646억 (확정 11/24 종가 기준)"},{"code":"005380","name":"현대차","market":"코스피","price":264500,"pct":6.44,"foreignEok":197.1,"organEok":533.8,"individualEok":-737.4,"streakForeign":6,"streakOrgan":2,"valueText":"1,934억","capText":"53.8조","desc":"외국인 +197억 · 기관 +534억 · 개인 -737억 (확정 11/24 종가 기준)"},{"code":"066570","name":"LG전자","market":"코스피","price":137400,"pct":9.83,"foreignEok":-8.9,"organEok":522.9,"individualEok":-496.6,"streakForeign":4,"streakOrgan":3,"valueText":"1,901억","capText":"22.4조","desc":"외국인 -9억 · 기관 +523억 · 개인 -497억 (확정 11/24 종가 기준)"},{"code":"108490","name":"로보티즈","market":"코스닥","price":281500,"pct":12.83,"foreignEok":150.4,"organEok":502.6,"individualEok":-655.1,"streakForeign":1,"streakOrgan":2,"valueText":"2,232억","capText":"4.1조","desc":"외국인 +150억 · 기관 +503억 · 개인 -655억 (확정 11/24 종가 기준)"}],"foreignSell":[{"code":"000660","name":"SK하이닉스","market":"코스피","price":1113000,"pct":1.09,"foreignEok":-1324.4,"organEok":-9.4,"individualEok":-2599.1,"streakForeign":9,"streakOrgan":4,"valueText":"42,277억","capText":"786.7조","desc":"외국인 -1,324억 · 기관 -9억 · 개인 -2,599억 (확정 11/24 종가 기준)"},{"code":"402340","name":"SK스퀘어","market":"코스피","price":688000,"pct":-0.43,"foreignEok":-466.7,"organEok":336.4,"individualEok":135.3,"streakForeign":1,"streakOrgan":2,"valueText":"4,344억","capText":"90.8조","desc":"외국인 -467억 · 기관 +336억 · 개인 +135억 (확정 11/24 종가 기준)"},{"code":"278470","name":"에이피알","market":"코스피","price":261000,"pct":1.95,"foreignEok":-153.8,"organEok":165.2,"individualEok":-15.8,"streakForeign":2,"streakOrgan":2,"valueText":"628억","capText":"9.8조","desc":"외국인 -154억 · 기관 +165억 · 개인 -16억 (확정 11/24 종가 기준)"},{"code":"222800","name":"심텍","market":"코스닥","price":105000,"pct":0.0,"foreignEok":-107.1,"organEok":49.1,"individualEok":58.8,"streakForeign":2,"streakOrgan":1,"valueText":"1,108억","capText":"4.2조","desc":"외국인 -107억 · 기관 +49억 · 개인 +59억 (확정 11/24 종가 기준)"},{"code":"007660","name":"이수페타시스","market":"코스피","price":70300,"pct":-3.43,"foreignEok":-106.8,"organEok":-86.7,"individualEok":193.5,"streakForeign":1,"streakOrgan":3,"valueText":"1,038억","capText":"5.2조","desc":"외국인 -107억 · 기관 -87억 · 개인 +194억 (확정 11/24 종가 기준)"}],"dualBuy":[{"code":"005930","name":"삼성전자","market":"코스피","price":182900,"pct":1.27,"foreignEok":4294.6,"organEok":2151.8,"individualEok":-6219.8,"streakForeign":1,"streakOrgan":2,"valueText":"32,509억","capText":"1,069.3조","desc":"외국인 +4,295억 · 기관 +2,152억 · 개인 -6,220억 (확정 11/24 종가 기준)"},{"code":"009150","name":"삼성전기","market":"코스피","price":820000,"pct":2.89,"foreignEok":741.6,"organEok":884.8,"individualEok":-1646.1,"streakForeign":2,"streakOrgan":2,"valueText":"7,451억","capText":"61.2조","desc":"외국인 +742억 · 기관 +885억 · 개인 -1,646억 (확정 11/24 종가 기준)"},{"code":"006400","name":"삼성SDI","market":"코스피","price":431000,"pct":7.35,"foreignEok":397.4,"organEok":999.6,"individualEok":-1386.4,"streakForeign":3,"streakOrgan":2,"valueText":"3,425억","capText":"34.7조","desc":"외국인 +397억 · 기관 +1,000억 · 개인 -1,386억 (확정 11/24 종가 기준)"},{"code":"005380","name":"현대차","market":"코스피","price":264500,"pct":6.44,"foreignEok":197.1,"organEok":533.8,"individualEok":-737.4,"streakForeign":6,"streakOrgan":2,"valueText":"1,934억","capText":"53.8조","desc":"외국인 +197억 · 기관 +534억 · 개인 -737억 (확정 11/24 종가 기준)"},{"code":"108490","name":"로보티즈","market":"코스닥","price":281500,"pct":12.83,"foreignEok":150.4,"organEok":502.6,"individualEok":-655.1,"streakForeign":1,"streakOrgan":2,"valueText":"2,232억","capText":"4.1조","desc":"외국인 +150억 · 기관 +503억 · 개인 -655억 (확정 11/24 종가 기준)"},{"code":"277810","name":"레인보우로보틱스","market":"코스닥","price":451500,"pct":9.59,"foreignEok":137.7,"organEok":408.6,"individualEok":-532.0,"streakForeign":1,"streakOrgan":8,"valueText":"1,513억","capText":"8.8조","desc":"외국인 +138억 · 기관 +409억 · 개인 -532억 (확정 11/24 종가 기준)"}]}};
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
  reload: function () { render(); applyLive(); try { if (window.KisSupplyPanel) window.KisSupplyPanel.refresh(); } catch (e) { /* */ } },
  data: function () { return SUPPLY; },
  state: function () { return window.__SUPPLY || { rendered: 0 }; }
};
})();
