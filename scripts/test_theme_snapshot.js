'use strict';

/**
 * 프리마켓(08:00~08:50) 테마맵 경로 검증 — node scripts/test_theme_snapshot.js
 *
 *  08:00~08:50 에는 네이버 테마 랭킹이 전 종목 0.00%로 내려와
 *  public/data/last-dynamic-themes.json 스냅샷으로 카드를 그린다(mapPrevDayThemes).
 *  이 경로가 스냅샷 파일의 역할을 그대로 실어 보내면, 11/23 처럼 잘못 적힌 파일이
 *  아침 화면에 그대로 나간다 → 화면 직전에 역할을 다시 계산하는지 파일로 검증한다.
 */
const assert = require('assert');
const path = require('path');
const { mapPrevDayThemes } = require('../api/tabs-live');
const SNAP = require('../public/data/last-dynamic-themes.json');

let pass = 0;
function check(label, fn) {
  fn();
  pass += 1;
  console.log('  ✓ ' + label);
}

const map = {};
SNAP.themes.forEach((t) => (t.stocks || []).forEach((s) => {
  map[s.code] = {
    price: s.price, ratio: s.changePct, open: s.open, high: s.high, low: s.low,
    val_num: (s.value || 0) / 1e8, val: s.valueText,
  };
}));

const out = mapPrevDayThemes(SNAP, SNAP.themes, map, false);

check('스냅샷 테마 수·순서 유지', () => {
  assert.strictEqual(out.length, SNAP.themes.length);
  out.forEach((t, i) => assert.strictEqual(t.name, SNAP.themes[i].name));
});

check('로봇: 👑=휴림로봇 · 💰=원익홀딩스 (휴림로봇에 💰 없음)', () => {
  const t = out.find((x) => x.name.indexOf('로봇(산업용') === 0);
  const byRole = (r) => t.stocks.filter((s) => s.role === r).map((s) => s.name);
  assert.deepStrictEqual(byRole('상승률 대장'), ['휴림로봇']);
  assert.deepStrictEqual(byRole('실질 거래대금 대장'), ['원익홀딩스']);
});

check('지능형로봇: 👑=휴림로봇 · 💰=로보티즈', () => {
  const t = out.find((x) => x.name.indexOf('지능형로봇') === 0);
  assert.strictEqual(t.stocks.find((s) => s.role === '상승률 대장').name, '휴림로봇');
  assert.strictEqual(t.stocks.find((s) => s.role === '실질 거래대금 대장').name, '로보티즈');
});

check('모든 테마: 💰 는 카드 안 +3%↑ 거래대금 1위이고 👑 와 다른 종목', () => {
  out.forEach((t) => {
    const rise = t.stocks.filter((s) => typeof s.prevDayPct === 'number' && s.prevDayPct > 0);
    const strong = rise.filter((s) => s.prevDayPct >= 3).sort((a, b) => (b.value || 0) - (a.value || 0));
    const pctTop = rise.slice().sort((a, b) => b.prevDayPct - a.prevDayPct)[0] || null;
    const labelled = t.stocks.filter((s) => s.role === '실질 거래대금 대장');
    assert.ok(labelled.length <= 1, `${t.name}: 💰 가 2개 이상`);
    if (!labelled.length) return;
    const v = labelled[0];
    assert.ok(v.prevDayPct >= 3, `${t.name}: ${v.name} 는 +3% 미만인데 대금 대장`);
    assert.ok(strong[0] && strong[0].code === v.code, `${t.name}: ${v.name} 가 카드 안 대금 1위가 아님`);
    assert.ok(!pctTop || pctTop.code !== v.code, `${t.name}: 👑 와 💰 가 같은 종목`);
  });
});

check('하락 종목은 상승률 대장이 되지 않는다', () => {
  out.forEach((t) => {
    const lead = t.stocks.find((s) => s.role === '상승률 대장');
    if (!lead) return;
    assert.ok(lead.prevDayPct > 0, `${t.name}: ${lead.name} ${lead.prevDayPct}%`);
  });
});

check('기준 문구는 "기준주"(대장) — 👑 와 말이 겹치지 않게', () => {
  out.forEach((t) => assert.ok(String(t.avgPctBasisLabel || '').indexOf('기준주') >= 0, String(t.avgPctBasisLabel)));
});

console.log(`\n프리마켓 스냅샷 경로 ${pass}건 통과 — ${SNAP.asOfDate}`);
