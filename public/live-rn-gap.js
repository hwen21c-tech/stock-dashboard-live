/* ============================================================
   🎯 RN존 카드 — 현재가 기준 가장 가까운 지지/저항선 % 한 줄 (live-rn-gap.js)
   ─ RN존은 라운드넘버(RN) 밴드로 매매한다. 카드마다 현재가가 속한 밴드의
     아래 라운드넘버선(지지)과 위 라운드넘버선(저항)까지의 거리를 % 로 보여 준다.
   ─ 카드가 다시 그려질 때마다(MutationObserver) 한 줄만 끼워 넣는다 — 중복 없음.
   ─ index.html 의 RnZone 엔진·live-api.js 를 건드리지 않는 독립 모듈.
   ============================================================ */
(function () {
'use strict';
if (window.RnGap) return;

/* scripts/rescan_strategies.py 의 rn_step() · kr_tick() 과 같은 셈법 */
function stepOf(price) {
  var p = Math.abs(Number(price) || 0);
  if (p >= 500000) return 100000;
  if (p >= 100000) return 50000;
  if (p >= 50000) return 10000;
  if (p >= 10000) return 5000;
  if (p >= 1000) return 1000;
  return 100;
}
function nf(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Math.round(Number(n)).toLocaleString('ko-KR');
}
function pct(v) { return (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }

function bandOf(price) {
  var p = Number(price);
  if (!isFinite(p) || p <= 0) return null;
  var step = stepOf(p);
  var lower = Math.floor(p / step) * step;
  var upper = lower + step;
  return {
    lower: lower, upper: upper, step: step,
    toLower: (lower - p) / p * 100,
    toUpper: (upper - p) / p * 100
  };
}

function ensureCss() {
  if (document.getElementById('rng-css')) return;
  var el = document.createElement('style');
  el.id = 'rng-css';
  el.textContent = [
    '#tabRnzone .stock-card .rn-gap{margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;',
    '  font-size:10px;font-weight:800;background:rgba(56,189,248,0.07);border:1px dashed rgba(56,189,248,0.32);',
    '  border-radius:5px;padding:3px 6px;line-height:1.45}',
    '#tabRnzone .stock-card .rn-gap .g-s{color:#7dd3fc}',
    '#tabRnzone .stock-card .rn-gap .g-r{color:#fbbf24}',
    '#tabRnzone .stock-card .rn-gap .g-m{color:#94a3b8;font-weight:700}',
    '#tabRnzone .stock-card.active .rn-gap{background:rgba(56,189,248,0.13)}'
  ].join('\n');
  document.head.appendChild(el);
}

function priceOf(card) {
  var row = card.querySelector('.card-price-row span');
  var t = row ? row.textContent : (card.textContent || '');
  var m = String(t).replace(/,/g, '').match(/(\d{3,})/);
  return m ? Number(m[1]) : null;
}

function decorate(card) {
  if (!card || !card.querySelector) return;
  var price = priceOf(card);
  if (!price) return;
  var b = bandOf(price);
  if (!b) return;
  ensureCss();
  var el = card.querySelector(':scope > .rn-gap');
  if (!el) {
    el = document.createElement('div');
    el.className = 'rn-gap';
    var metrics = card.querySelector('.card-metrics');
    if (metrics && metrics.parentNode === card) card.insertBefore(el, metrics.nextSibling);
    else card.appendChild(el);
  }
  el.innerHTML =
    '<span class="g-s">지지 ' + nf(b.lower) + ' (' + pct(b.toLower) + ')</span>' +
    '<span class="g-m">·</span>' +
    '<span class="g-r">저항 ' + nf(b.upper) + ' (' + pct(b.toUpper) + ')</span>' +
    '<span class="g-m" style="margin-left:auto">RN ' + nf(b.step) + '단위</span>';
  el.setAttribute('data-price', String(price));
}

function sweep() {
  var grid = document.getElementById('stockListGrid');
  if (!grid) return 0;
  var n = 0;
  Array.prototype.forEach.call(grid.querySelectorAll('.stock-card[data-code]'), function (card) {
    try { decorate(card); n += 1; } catch (e) { /* */ }
  });
  window.__RNGAP = { cards: n };
  return n;
}

function boot() {
  ensureCss();
  sweep();
  var grid = document.getElementById('stockListGrid');
  if (grid) {
    var t = null;
    var obs = new MutationObserver(function () {
      if (t) clearTimeout(t);
      t = setTimeout(sweep, 120);
    });
    obs.observe(grid, { childList: true, subtree: false });
  }
  /* RN존 탭에 들어올 때 · 화면 갱신 후 한 번 더 (동적 시세 갱신은 카드 텍스트만 바꾼다) */
  setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    var tab = document.getElementById('tabRnzone');
    if (tab && tab.style.display !== 'none') sweep();
  }, 15000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
window.addEventListener('load', function () { setTimeout(sweep, 1200); });

window.RnGap = {
  version: '1.0.0',
  band: bandOf,
  sweep: sweep,
  state: function () { return window.__RNGAP || { cards: 0 }; }
};
})();
