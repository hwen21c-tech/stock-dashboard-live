#!/usr/bin/env node
/**
 * 침착해 시장 판별 배너 — 장전 한정 야간선물 한 줄 규칙 검증 (#62644)
 *   node test_chim_night_futures.mjs
 *
 *  - 장전·주말·야간장(18:00~06:00)에만 줄이 생긴다.
 *  - 정규장(09:00~15:30)에는 줄이 없다.
 *  - 값을 못 받으면(미수신·KIS 미설정) 줄을 만들지 않는다(0%·추정 금지).
 *  - 원본 배너 캐시 객체를 건드리지 않는다.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const tl = require('./api/tabs-live.js');

const MOON = '\u{1F319}';
const { chimNightFutures, attachChimNightFutures } = tl;
let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  OK  ' + label); }
  else { fail += 1; console.log('  FAIL ' + label); }
};

const nightQuote = (over) => Object.assign({
  ok: true, marketDiv: 'CM', price: 742.6, change: -35.5, changePct: -4.56,
  live: false, badge: '06:00 마감', asOfKst: '07:46:23',
}, over || {});

const banner = () => ({
  kind: 'strong', icon: '\u{1F7E2}', title: '강세장 (직전 거래일 기준)',
  line: '강세장 (직전 거래일 기준) - 주도주 중심 종베',
  reasons: ['지수 코스피 +6.32% / 코스닥 +4.79%'], hits: [], asOf: '직전 거래일(2026-11-24) 확정', stale: true,
});

console.log('\n[1] 장전 - 야간선물 -4.56%');
{
  const n = chimNightFutures(nightQuote(), { preopen: true, weekend: false });
  ok(Boolean(n), '줄이 생성된다');
  const want = MOON + ' 간밤 야간선물 742.60 (-4.56%) \u2014 시초 갭 변동 주의 \u00b7 06:00 마감';
  ok(n && n.line === want, '문구: ' + (n && n.line));
  ok(n && n.changePct === -4.56 && n.price === 742.6, '수치 그대로');
}

console.log('\n[2] 정규장(10:00) - 줄 없음');
{
  const n = chimNightFutures(nightQuote(), { preopen: false, weekend: false });
  ok(n === null, '정규장에는 야간선물 줄을 넣지 않는다');
}

console.log('\n[3] 미수신·미설정 - 줄 없음(추정 금지)');
{
  ok(chimNightFutures(null, { preopen: true }) === null, 'quote 없음 -> null');
  ok(chimNightFutures({ ok: false, error: 'KIS 미설정' }, { preopen: true }) === null, 'ok:false -> null');
  ok(chimNightFutures(nightQuote({ changePct: null }), { preopen: true }) === null, '등락률 없음 -> null');
}

console.log('\n[4] 야간장 실시간(20:30) - 장전이 아니어도 실시간이면 표시');
{
  const n = chimNightFutures(
    nightQuote({ price: 751.8, changePct: -3.38, live: true, badge: '18:00~06:00 실시간' }),
    { preopen: false, weekend: false },
  );
  const want = MOON + ' 야간선물 751.80 (-3.38%) \u2014 야간 흐름 \u00b7 18:00~06:00 실시간';
  ok(n && n.line === want, '문구: ' + (n && n.line));
}

console.log('\n[5] 보합권(+-0.5% 미만) - 문구가 과하지 않다');
{
  const n = chimNightFutures(nightQuote({ price: 777.95, changePct: 0.12 }), { preopen: true });
  const want = MOON + ' 간밤 야간선물 777.95 (+0.12%) \u2014 시초 갭 영향 제한적 \u00b7 06:00 마감';
  ok(n && n.line === want, '문구: ' + (n && n.line));
}

console.log('\n[6] 배너에 붙이기 - 원본 캐시 불변');
{
  const base = banner();
  const chim = { ok: true, marketBanner: base, rows: [] };
  const out = attachChimNightFutures(chim, { night: nightQuote() }, { preopen: true, weekend: false });
  ok(out !== chim, '새 객체를 돌려준다');
  ok(out.marketBanner !== base, '배너도 새 객체');
  ok(!base.nightLine && !base.nightFutures, '원본 배너에는 흔적 없음');
  ok(String(out.marketBanner.nightLine).startsWith(MOON + ' 간밤 야간선물 742.60'), 'nightLine 실림');
  ok(out.marketBanner.line === base.line, '원래 판정 문구는 그대로');
  ok(out.rows === chim.rows, '나머지 필드는 그대로');

  const miss = attachChimNightFutures(chim, { ok: false, night: null }, { preopen: true });
  ok(miss.marketBanner.nightFutures === null && !miss.marketBanner.nightLine, '미수신이면 줄 없음');

  const midday = attachChimNightFutures(chim, { night: nightQuote() }, { preopen: false, weekend: false });
  ok(!midday.marketBanner.nightLine, '정규장 응답에는 줄 없음');

  const weekend = attachChimNightFutures(chim, { night: nightQuote() }, { preopen: false, weekend: true });
  ok(Boolean(weekend.marketBanner.nightLine), '주말(개장 대기)에는 표시');

  ok(attachChimNightFutures({ ok: true }, { night: nightQuote() }, { preopen: true }) !== null, '배너 없는 응답은 그대로 통과');
  ok(attachChimNightFutures(null, { night: nightQuote() }, { preopen: true }) === null, 'null 안전');
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED ' + fail) + ' - ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
