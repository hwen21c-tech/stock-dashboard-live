/* ============================================================
   ⏱️ 4번 브리핑 탭 — 시간대 빠른 이동 칩 (live-briefjump.js)
   ─ #tabAnalysis 상단에 07:30 ~ 23:59 정규 14회 칩을 붙인다.
   ─ 칩을 누르면 그 시간대 브리핑 카드로 부드럽게 스크롤하고 전문 팝업을 연다.
   ─ 아직 그 시간대 카드가 없는 경우(장 시작 전 등)에는 칩을 흐리게 표시하고
     팝업만 연다 — 없는 카드를 있는 것처럼 보여 주지 않는다.
   ============================================================ */
(function () {
'use strict';
if (window.BriefJump) return;

var TIMES = ['07:30', '08:50', '10:00', '11:00', '13:00', '14:00', '15:00',
             '16:00', '17:30', '19:00', '19:30', '20:00', '22:00', '23:59'];
var S = { built: false, cards: {}, last: null };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function injectCss() {
  if (document.getElementById('bj-css')) return;
  var el = document.createElement('style');
  el.id = 'bj-css';
  el.textContent = [
    '#briefJumpChips{display:flex;gap:5px;flex-wrap:wrap;align-items:center;background:rgba(15,23,42,.82);border:1px solid rgba(56,189,248,.3);border-radius:8px;padding:7px 9px;margin:0 0 10px 0}',
    '#briefJumpChips .bj-lab{font-size:10px;font-weight:900;color:#7dd3fc;white-space:nowrap;margin-right:2px}',
    '#briefJumpChips .bj-chip{background:#111827;border:1px solid #334155;border-radius:5px;padding:3px 7px;font-size:10.5px;font-weight:800;color:#cbd5e1;cursor:pointer;white-space:nowrap;line-height:1.4}',
    '#briefJumpChips .bj-chip:hover{border-color:#38bdf8;color:#bae6fd}',
    '#briefJumpChips .bj-chip.on{background:rgba(56,189,248,.2);border-color:#38bdf8;color:#e0f2fe}',
    '#briefJumpChips .bj-chip.none{opacity:.45}',
    '#briefJumpChips .bj-chip.now{box-shadow:0 0 0 1px #34d399 inset;color:#a7f3d0;border-color:#34d399}',
    '#briefJumpChips .bj-note{font-size:9.5px;color:#64748b;font-weight:700;width:100%;margin-top:2px;line-height:1.45}',
    '.bj-flash{animation:bjFlash 1.1s ease-out 1}',
    '@keyframes bjFlash{0%{box-shadow:0 0 0 2px #38bdf8,0 0 18px rgba(56,189,248,.45)}100%{box-shadow:none}}'
  ].join('\n');
  document.head.appendChild(el);
}

function collect() {
  var root = document.getElementById('tabAnalysis');
  var map = {};
  if (!root) return map;
  var cards = root.querySelectorAll('.timeline-card');
  Array.prototype.forEach.call(cards, function (c) {
    var oc = c.getAttribute('onclick') || '';
    var m = oc.match(/openBriefingModal\('([0-9:]{3,5})'\)/);
    if (!m) return;
    var t = norm(m[1]);          /* '0730' 카드도 '07:30' 으로 정규화해 칩과 연결한다 */
    if (!map[t]) map[t] = c;    /* 오늘 카드가 먼저 나오므로 첫 번째를 쓴다 */
  });
  return map;
}

function norm(v) {
  var s = String(v || '');
  if (s.indexOf(':') < 0 && s.length === 4) s = s.slice(0, 2) + ':' + s.slice(2);
  return pad(s);
}

function pad(t) {
  var p = String(t || '').split(':');
  if (p.length !== 2) return t;
  return (p[0].length === 1 ? '0' + p[0] : p[0]) + ':' + p[1];
}

function paintState() {
  S.cards = collect();
  var wrap = document.getElementById('briefJumpChips');
  if (!wrap) return;
  Array.prototype.forEach.call(wrap.querySelectorAll('.bj-chip'), function (b) {
    var t = b.getAttribute('data-t');
    b.classList.toggle('none', !S.cards[t]);
    b.title = S.cards[t] ? (t + ' 브리핑 카드로 이동 + 전문 열기') : (t + ' — 아직 이 시간대 카드가 없습니다(팝업만 열립니다)');
  });
  var cnt = Object.keys(S.cards).length;
  var note = wrap.querySelector('.bj-note');
  if (note) note.textContent = '타임라인 카드 ' + cnt + '건 · 정규 14회 양식(07:30~23:59) · 흐린 칩 = 아직 그 시간대 카드 없음';
}

function go(t) {
  t = pad(t);
  paintState();
  var card = S.cards[t];
  var wrap = document.getElementById('briefJumpChips');
  if (wrap) {
    Array.prototype.forEach.call(wrap.querySelectorAll('.bj-chip'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-t') === t);
    });
  }
  if (card) {
    try {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove('bj-flash');
      void card.offsetWidth;
      card.classList.add('bj-flash');
      setTimeout(function () { card.classList.remove('bj-flash'); }, 1300);
    } catch (e) { /* */ }
  } else {
    try { document.getElementById('tabAnalysis').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* */ }
  }
  S.last = t;
  window.__BRIEFJUMP = { last: t, hasCard: !!card, cards: Object.keys(S.cards).length };
  /* 카드로 이동한 뒤 전문 팝업을 연다(카드가 없어도 팝업은 연다 — 내용이 없으면 안내가 뜬다) */
  setTimeout(function () {
    try {
      if (typeof window.openBriefingModal === 'function') window.openBriefingModal(t);
    } catch (e) { /* */ }
  }, card ? 260 : 60);
}

function build() {
  var root = document.getElementById('tabAnalysis');
  if (!root || document.getElementById('briefJumpChips')) return;
  injectCss();
  var wrap = document.createElement('div');
  wrap.id = 'briefJumpChips';
  wrap.innerHTML = '<span class="bj-lab">⏱️ 시간대 빠른 이동</span>' +
    TIMES.map(function (t) {
      return '<button type="button" class="bj-chip" data-t="' + t + '" onclick="BriefJump.go(\'' + t + '\')">' + t + '</button>';
    }).join('') +
    '<span class="bj-note"></span>';
  var anchor = document.getElementById('nowMomentCard');
  if (anchor && anchor.parentNode === root) root.insertBefore(wrap, anchor.nextSibling);
  else root.insertBefore(wrap, root.firstChild);
  paintState();
  S.built = true;
  /* 정시 브리핑이 새로 들어오면 카드 목록이 바뀔 수 있다 — 가끔 다시 센다 */
  setInterval(function () { if (document.visibilityState === 'visible') paintState(); }, 60000);
}

function boot() {
  if (S.built) return;
  build();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
window.addEventListener('load', function () { setTimeout(build, 800); });

window.BriefJump = {
  version: '1.0.0',
  go: go,
  times: TIMES,
  state: function () { return { built: S.built, last: S.last, cards: Object.keys(collect()).length }; }
};
})();
