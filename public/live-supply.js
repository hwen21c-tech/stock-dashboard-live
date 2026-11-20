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

const SUPPLY = {"generatedAt":"2026-11-20 21:46:27","basisDate":"20261120","basisLabel":"2026-11-20(금)","confirmed":true,"candidates":236,"source":"네이버 종목별 투자자별 매매동향(거래소 확정)","groups":{"foreignBuy":[{"code":"068270","name":"셀트리온","market":"코스피","price":212500,"pct":-0.93,"foreignEok":221.4,"organEok":53.9,"individualEok":-274.1,"streakForeign":3,"streakOrgan":2,"valueText":"1,259억","capText":"49.3조","desc":"외국인 +221억 · 기관 +54억 · 개인 -274억 (확정 11/20 종가 기준)"},{"code":"010950","name":"S-Oil","market":"코스피","price":97000,"pct":-4.24,"foreignEok":169.5,"organEok":-72.8,"individualEok":-97.8,"streakForeign":2,"streakOrgan":2,"valueText":"361억","capText":"10.9조","desc":"외국인 +170억 · 기관 -73억 · 개인 -98억 (확정 11/20 종가 기준)"},{"code":"015760","name":"한국전력","market":"코스피","price":25550,"pct":0.79,"foreignEok":117.4,"organEok":57.5,"individualEok":-173.6,"streakForeign":2,"streakOrgan":1,"valueText":"507억","capText":"16.4조","desc":"외국인 +117억 · 기관 +58억 · 개인 -174억 (확정 11/20 종가 기준)"},{"code":"096770","name":"SK이노베이션","market":"코스피","price":94200,"pct":-5.14,"foreignEok":111.8,"organEok":-172.6,"individualEok":47.9,"streakForeign":3,"streakOrgan":10,"valueText":"592억","capText":"15.9조","desc":"외국인 +112억 · 기관 -173억 · 개인 +48억 (확정 11/20 종가 기준)"},{"code":"329180","name":"HD현대중공업","market":"코스피","price":247000,"pct":-5.36,"foreignEok":106.9,"organEok":-119.9,"individualEok":15.8,"streakForeign":1,"streakOrgan":1,"valueText":"490억","capText":"25.9조","desc":"외국인 +107억 · 기관 -120억 · 개인 +16억 (확정 11/20 종가 기준)"},{"code":"207940","name":"삼성바이오로직스","market":"코스피","price":1336000,"pct":-2.55,"foreignEok":95.9,"organEok":-41.8,"individualEok":-52.7,"streakForeign":2,"streakOrgan":1,"valueText":"544억","capText":"61.8조","desc":"외국인 +96억 · 기관 -42억 · 개인 -53억 (확정 11/20 종가 기준)"}],"organBuy":[{"code":"128940","name":"한미약품","market":"코스피","price":449500,"pct":5.89,"foreignEok":-239.9,"organEok":405.9,"individualEok":-163.8,"streakForeign":1,"streakOrgan":1,"valueText":"948억","capText":"5.8조","desc":"외국인 -240억 · 기관 +406억 · 개인 -164억 (확정 11/20 종가 기준)"},{"code":"012450","name":"한화에어로스페이스","market":"코스피","price":603000,"pct":-4.29,"foreignEok":-201.8,"organEok":213.4,"individualEok":-11.6,"streakForeign":1,"streakOrgan":1,"valueText":"913억","capText":"31.1조","desc":"외국인 -202억 · 기관 +213억 · 개인 -12억 (확정 11/20 종가 기준)"},{"code":"004170","name":"신세계","market":"코스피","price":290000,"pct":-2.19,"foreignEok":-173.0,"organEok":178.2,"individualEok":-5.3,"streakForeign":4,"streakOrgan":7,"valueText":"347억","capText":"2.7조","desc":"외국인 -173억 · 기관 +178억 · 개인 -5억 (확정 11/20 종가 기준)"},{"code":"105560","name":"KB금융","market":"코스피","price":153100,"pct":-0.91,"foreignEok":-141.4,"organEok":177.4,"individualEok":-36.5,"streakForeign":5,"streakOrgan":1,"valueText":"1,276억","capText":"54.3조","desc":"외국인 -141억 · 기관 +177억 · 개인 -36억 (확정 11/20 종가 기준)"},{"code":"352820","name":"하이브","market":"코스피","price":183400,"pct":-2.03,"foreignEok":35.7,"organEok":145.4,"individualEok":-178.7,"streakForeign":3,"streakOrgan":8,"valueText":"951억","capText":"7.9조","desc":"외국인 +36억 · 기관 +145억 · 개인 -179억 (확정 11/20 종가 기준)"},{"code":"041510","name":"에스엠","market":"코스닥","price":97300,"pct":4.06,"foreignEok":-6.6,"organEok":135.2,"individualEok":-132.1,"streakForeign":5,"streakOrgan":4,"valueText":"605억","capText":"2.2조","desc":"외국인 -7억 · 기관 +135억 · 개인 -132억 (확정 11/20 종가 기준)"}],"foreignSell":[{"code":"005930","name":"삼성전자","market":"코스피","price":180900,"pct":-8.36,"foreignEok":-4160.7,"organEok":-3465.0,"individualEok":7329.8,"streakForeign":5,"streakOrgan":2,"valueText":"32,673억","capText":"1,057.6조","desc":"외국인 -4,161억 · 기관 -3,465억 · 개인 +7,330억 (확정 11/20 종가 기준)"},{"code":"009150","name":"삼성전기","market":"코스피","price":767000,"pct":-13.14,"foreignEok":-2342.3,"organEok":-1325.8,"individualEok":3622.4,"streakForeign":7,"streakOrgan":1,"valueText":"8,230억","capText":"57.3조","desc":"외국인 -2,342억 · 기관 -1,326억 · 개인 +3,622억 (확정 11/20 종가 기준)"},{"code":"000660","name":"SK하이닉스","market":"코스피","price":1100000,"pct":-7.56,"foreignEok":-1847.8,"organEok":-2592.3,"individualEok":510.8,"streakForeign":7,"streakOrgan":2,"valueText":"36,186억","capText":"777.5조","desc":"외국인 -1,848억 · 기관 -2,592억 · 개인 +511억 (확정 11/20 종가 기준)"},{"code":"017670","name":"SK텔레콤","market":"코스피","price":69200,"pct":-15.82,"foreignEok":-281.5,"organEok":-278.4,"individualEok":557.6,"streakForeign":1,"streakOrgan":3,"valueText":"1,557억","capText":"14.9조","desc":"외국인 -282억 · 기관 -278억 · 개인 +558억 (확정 11/20 종가 기준)"},{"code":"128940","name":"한미약품","market":"코스피","price":449500,"pct":5.89,"foreignEok":-239.9,"organEok":405.9,"individualEok":-163.8,"streakForeign":1,"streakOrgan":1,"valueText":"948억","capText":"5.8조","desc":"외국인 -240억 · 기관 +406억 · 개인 -164억 (확정 11/20 종가 기준)"}],"dualBuy":[{"code":"068270","name":"셀트리온","market":"코스피","price":212500,"pct":-0.93,"foreignEok":221.4,"organEok":53.9,"individualEok":-274.1,"streakForeign":3,"streakOrgan":2,"valueText":"1,259억","capText":"49.3조","desc":"외국인 +221억 · 기관 +54억 · 개인 -274억 (확정 11/20 종가 기준)"},{"code":"352820","name":"하이브","market":"코스피","price":183400,"pct":-2.03,"foreignEok":35.7,"organEok":145.4,"individualEok":-178.7,"streakForeign":3,"streakOrgan":8,"valueText":"951억","capText":"7.9조","desc":"외국인 +36억 · 기관 +145억 · 개인 -179억 (확정 11/20 종가 기준)"},{"code":"015760","name":"한국전력","market":"코스피","price":25550,"pct":0.79,"foreignEok":117.4,"organEok":57.5,"individualEok":-173.6,"streakForeign":2,"streakOrgan":1,"valueText":"507억","capText":"16.4조","desc":"외국인 +117억 · 기관 +58억 · 개인 -174억 (확정 11/20 종가 기준)"},{"code":"180640","name":"한진칼","market":"코스피","price":237000,"pct":9.47,"foreignEok":43.4,"organEok":69.7,"individualEok":-115.3,"streakForeign":6,"streakOrgan":1,"valueText":"1,347억","capText":"15.8조","desc":"외국인 +43억 · 기관 +70억 · 개인 -115억 (확정 11/20 종가 기준)"},{"code":"035900","name":"JYP Ent.","market":"코스닥","price":46250,"pct":-1.8,"foreignEok":69.8,"organEok":40.2,"individualEok":-112.9,"streakForeign":1,"streakOrgan":1,"valueText":"500억","capText":"1.6조","desc":"외국인 +70억 · 기관 +40억 · 개인 -113억 (확정 11/20 종가 기준)"},{"code":"086280","name":"현대글로비스","market":"코스피","price":202500,"pct":-0.49,"foreignEok":70.1,"organEok":28.2,"individualEok":-98.0,"streakForeign":3,"streakOrgan":1,"valueText":"290억","capText":"15.2조","desc":"외국인 +70억 · 기관 +28억 · 개인 -98억 (확정 11/20 종가 기준)"}]}};
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
