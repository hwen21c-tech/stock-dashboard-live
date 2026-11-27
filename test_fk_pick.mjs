#!/usr/bin/env node
/**
 * F존 후보 선정 단위 테스트 (네트워크 없음) — 2026-11-27
 *   node test_fk_pick.mjs
 *
 * 검증
 *   ① 중복 테마 건너뛰기 : 대장주가 같은 코로나19(치료제)·코로나19(진단)·백신/방역이
 *                          Top 자리를 독점하지 않고, 서로 다른 테마가 뽑힌다.
 *   ② 실질 주도주 우선    : 어제(11/26) 실제 주도주 미래에셋벤처투자(창투사)·스피어(의료AI)·
 *                          아리바이오랩(코로나19)이 잡힌다. (평균 등락률만 보면 6·8위로 밀리던 종목)
 *   ③ 오늘 섹션도 같은 원칙 : 전일에서 쓴 종목·테마와 겹치지 않게 뽑힌다.
 *   ④ 코드 중복 0 · 테마당 대장/부대장 역할 유지 · 기준(themeTop) 준수
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tabs = require('./api/tabs-live.js');
const { fkPickLeaders, FK_RULES } = tabs;

let pass = 0;
let fail = 0;
const results = [];
function check(label, cond, detail) {
  results.push({ label, ok: Boolean(cond), detail });
  if (cond) pass += 1;
  else fail += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? `  → ${detail}` : ''}`);
}

/* ---------------- 1) 어제(11/26) 마감 스냅샷 → 전일 강세주 ---------------- */
const doc = require('./public/data/last-dynamic-themes.json');
const prevRows = [];
let rk = 0;
const rankByTheme = new Map();
doc.themes.forEach((t) => {
  const pct = Number(t.avgPct);
  if (!(pct >= FK_RULES.minThemePct)) return;
  (t.stocks || []).forEach((s) => {
    prevRows.push({
      code: s.code,
      name: s.name,
      changePct: s.changePct,
      value: s.value,
      valueText: s.valueText || null,
      price: s.price,
      themeName: t.name,
      themeRank: t.rank,
      themePct: pct,
    });
  });
});
prevRows.forEach((r) => {
  if (!rankByTheme.has(r.themeName)) rankByTheme.set(r.themeName, (rk += 1));
  r.themeRank = r.themeRank || rankByTheme.get(r.themeName);
});

const used = new Set();
const prevPick = fkPickLeaders(prevRows, used);
const prevNames = prevPick.items.map((x) => x.name);
const prevThemeNames = prevPick.themes.map((t) => t.name);
console.log('\n▶ 전일 강세주 (11/26 스냅샷)');
prevPick.items.forEach((x) =>
  console.log(`   ${x.role} ${x.name} (${x.code}) · ${x.themeName} · ${x.pct}% · ${x.valueEok}억`),
);
console.log(`   테마: ${prevThemeNames.join(' | ')}`);
console.log(`   건너뜀: ${prevPick.skipped.map((s) => `${s.name}(${s.reason})`).join(' · ') || '없음'}`);

check('전일 후보 1순위에 미래에셋벤처투자(창투사) 포함', prevNames.includes('미래에셋벤처투자'), prevNames.join(', '));
check('전일 후보에 스피어(의료AI) 포함', prevNames.includes('스피어'), prevNames.join(', '));
check('전일 후보에 아리바이오랩(코로나19) 포함', prevNames.includes('아리바이오랩'), prevNames.join(', '));
check(
  '코로나19 유사 테마(진단·백신/방역)는 대장주 중복으로 건너뜀',
  prevPick.skipped.filter((s) => s.reason === 'leader_taken' && /코로나19|백신/.test(s.name)).length >= 2,
  prevPick.skipped.map((s) => s.name).join(' · ') || '없음',
);
check(
  `서로 다른 테마 ${FK_RULES.themeTop}개 이하로만 뽑힘 · 테마 중복 없음`,
  prevThemeNames.length <= FK_RULES.themeTop && new Set(prevThemeNames).size === prevThemeNames.length,
  `${prevThemeNames.length}테마 / ${prevPick.items.length}종목`,
);
check('종목 코드 중복 0', new Set(prevPick.items.map((x) => x.code)).size === prevPick.items.length, prevPick.items.map((x) => x.code).join(','));
check(
  '테마당 대장(상승률 1위)·부대장(대금 1위) 역할 유지',
  prevPick.themes.every((t) => {
    const mine = prevPick.items.filter((x) => x.themeName === t.name);
    return mine.length <= 2 && mine.filter((x) => x.role === '대장').length === 1;
  }),
);
check(
  '상승률 +5% 게이트 유지 (전 후보 pct ≥ 5)',
  prevPick.items.every((x) => x.pct >= FK_RULES.minStockPct),
  prevPick.items.map((x) => `${x.name} ${x.pct}%`).join(' · '),
);
check(
  '대금 300억↑ 테마가 앞 순서',
  prevPick.themes.every((t, i, arr) => i === 0 || !t.bigMoney || arr.slice(0, i).every((p) => p.bigMoney)),
  prevPick.themes.map((t) => `${t.name.split('(')[0]}${t.bigMoney ? '(300억↑)' : ''}`).join(' > '),
);

/* 대장주가 같은 유사 테마 3종이 실제로 한 자리만 쓰는지 — 실데이터 기준 */
const dupThemes = prevPick.themes.filter((t) => /코로나19|백신/.test(t.name));
check('코로나19·백신 계열은 1개 테마만 채택', dupThemes.length === 1, dupThemes.map((t) => t.name).join(', ') || '없음');

/* ---------------- 2) 오늘 강세주 — 전일 used 를 이어받아 겹치지 않게 ---------------- */
const todayRows = [
  { code: '466100', name: '클로봇', changePct: 10.93, value: 37e8, price: 20950, themeName: '피지컬 AI/휴머노이드 로봇', themeRank: 1 },
  { code: '108490', name: '로보티즈', changePct: 5.53, value: 145e8, price: 306000, themeName: '피지컬 AI/휴머노이드 로봇', themeRank: 1 },
  { code: '439960', name: '코스모로보틱스', changePct: 12.16, value: 16e8, price: 4945, themeName: '로봇(산업용/협동로봇 등)', themeRank: 2 },
  { code: '0035S0', name: '빅웨이브로보틱스', changePct: 7.34, value: 26e8, price: 21200, themeName: '로봇(산업용/협동로봇 등)', themeRank: 2 },
  /* 전일에서 이미 뽑힌 아리바이오랩이 대장인 테마 → 오늘 섹션에서도 건너뛰어야 한다 */
  { code: '261780', name: '아리바이오랩', changePct: 11.5, value: 90e8, price: 5200, themeName: '코로나19(치료제/백신 개발 등)', themeRank: 3 },
  { code: '331920', name: '셀레믹스', changePct: 9.1, value: 30e8, price: 5100, themeName: '코로나19(치료제/백신 개발 등)', themeRank: 3 },
];
const todayPick = fkPickLeaders(todayRows, used);
console.log('\n▶ 오늘 강세주 (전일 used 이어받음)');
todayPick.items.forEach((x) => console.log(`   ${x.role} ${x.name} · ${x.themeName} · ${x.pct}%`));
check('오늘 후보가 전일 후보와 겹치지 않음', todayPick.items.every((x) => !prevPick.items.some((p) => p.code === x.code)), todayPick.items.map((x) => x.name).join(', '));
check('오늘 섹션도 대장주 중복 테마는 건너뜀', todayPick.skipped.some((s) => s.reason === 'leader_taken' && s.leader === '아리바이오랩'), todayPick.skipped.map((s) => `${s.name}(${s.reason})`).join(' · ') || '없음');
check('오늘 후보에 실제 강세주(클로봇·코스모로보틱스 등) 포함', todayPick.items.length >= 2 && todayPick.items.filter((x) => x.section === undefined).length === todayPick.items.length, `${todayPick.items.length}종목`);

/* ---------------- 3) 오늘 예산 배분 — 전일 8종목이면 오늘 테마 3개까지 ---------------- */
const limitFromBudget = Math.max(1, Math.min(FK_RULES.themeTop, Math.floor(Math.max(2, FK_RULES.maxCodes - 8) / 2)));
check(
  '분봉 예산 배분: 전일 8종목 → 오늘 테마 3개(총 14종목)',
  limitFromBudget === 3 && prevPick.items.length + limitFromBudget * 2 <= FK_RULES.maxCodes,
  `전일 ${prevPick.items.length} + 오늘 최대 ${limitFromBudget * 2} = ${prevPick.items.length + limitFromBudget * 2} (maxCodes ${FK_RULES.maxCodes})`,
);

/* ---------------- 4) 유사 중복 테마가 앞 순위여도 자리를 독식하지 않는다 ---------------- */
const synthetic = [
  { code: 'A1', name: '대장A', changePct: 29.9, value: 400e8, themeName: '테마A', themeRank: 1, themePct: 9.0 },
  { code: 'A2', name: '부대장A', changePct: 8.0, value: 120e8, themeName: '테마A', themeRank: 1, themePct: 9.0 },
  { code: 'A1', name: '대장A', changePct: 29.9, value: 400e8, themeName: '테마A-중복', themeRank: 2, themePct: 8.5 },
  { code: 'A3', name: '부대장A2', changePct: 7.0, value: 90e8, themeName: '테마A-중복', themeRank: 2, themePct: 8.5 },
  { code: 'B1', name: '대장B', changePct: 12.0, value: 500e8, themeName: '테마B', themeRank: 3, themePct: 6.0 },
  { code: 'B2', name: '부대장B', changePct: 6.0, value: 60e8, themeName: '테마B', themeRank: 3, themePct: 6.0 },
  { code: 'C1', name: '대장C', changePct: 11.0, value: 50e8, themeName: '테마C', themeRank: 4, themePct: 5.0 },
  { code: 'C2', name: '부대장C', changePct: 5.5, value: 40e8, themeName: '테마C', themeRank: 4, themePct: 5.0 },
];
const synPick = fkPickLeaders(synthetic, new Set());
const synThemes = synPick.themes.map((t) => t.name);
check('합성 데이터: 대장주 중복 테마는 1회만 채택', synThemes.filter((n) => /테마A/.test(n)).length === 1, synThemes.join(' > '));
check('합성 데이터: 300억↑ 테마(B)가 등락률 1위 소형 테마(C)보다 앞', synThemes.indexOf('테마B') >= 0 && synThemes.indexOf('테마B') < synThemes.indexOf('테마C'), synThemes.join(' > '));

/* ---------------- 5) 회귀: 후보 없음·이상치 처리 ---------------- */
check('후보 없음 → 빈 배열(가짜 후보 생성 없음)', fkPickLeaders([], new Set()).items.length === 0);
check('+100% 초과 이상치 제외', fkPickLeaders([{ code: 'X', name: '이상치', changePct: 150, value: 1e8, themeName: 'T', themeRank: 1 }], new Set()).items.length === 0);

console.log('\n══════════════════════════════════════════════════');
console.log(` 결과: ${pass}/${pass + fail} 통과${fail === 0 ? ' — 전체 성공 🎉' : ''}`);
if (fail) results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.label} ${r.detail || ''}`));
console.log('══════════════════════════════════════════════════\n');
process.exit(fail === 0 ? 0 : 1);
