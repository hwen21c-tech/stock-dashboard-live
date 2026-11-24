'use strict';

/**
 * 테마 카드 역할(👑 상승률 대장 · 💰 실질 거래대금 대장 …)을 한 곳에서 정한다.
 *
 * (2026-11-24 전수 점검 · 사용자 지시 "#60065")
 *   같은 카드를 그리는 5곳(동적 tabs-live · 프리마켓 스냅샷 · 저장 스크립트 · 정적 렌더 · 1번탭 클라이언트)이
 *   역할 규칙을 각자 들고 있어, '등락률 1위' 종목에 '실질 거래대금 대장' 딱지가 붙는 사고가 났다.
 *   (2026-11-23 로봇 테마: 휴림로봇 +30.00% 564억 = 상승률 1위인데 '대금 대장'으로 표기,
 *    실제 대금 1위는 원익홀딩스 1,514.9억 / 빅웨이브로보틱스 1,412.3억)
 *   → 규칙은 이 파일 하나만 두고, 화면을 그리는 쪽은 모두 이 함수를 쓴다.
 *
 * 규칙 (사용자 확정)
 *   ① 이상치 제외 — |등락률| ≥ 100% 종목은 역할·타일에서 뺀다(신규상장·상한가 첫날 왜곡).
 *   ② 상승률 대장  = 상승(>0%) 종목 중 등락률 1위. 동률이면 거래대금이 큰 쪽.
 *   ③ 실질 거래대금 대장 = **+3% 이상 오른 종목 중** 거래대금 1위.
 *      +3% 미만 종목은 '대장' 딱지를 달지 않는다('거래대금 상위'로만).
 *   ④ ②와 ③이 같은 종목이면 '상승률 대장'만 단다 — '대금 대장' 자리는 비운다.
 *      두 번째로 큰 종목에 '대금 대장'을 옮겨 붙이지 않는다(테마 대금 1위가 아니므로 거짓 표기가 된다).
 *   ⑤ 하락 종목은 '하락 대금 상위'로만 마지막에 붙인다.
 */

const OUTLIER_ABS_PCT = 100;   // ±100% 이상은 이상치
const VALUE_LEADER_MIN_PCT = 3; // '실질 거래대금 대장' 최소 상승률

const ROLE_PCT_LEADER = '상승률 대장';
const ROLE_VALUE_LEADER = '실질 거래대금 대장';
const ROLE_MATE = '동반 상승';
const ROLE_VALUE_TOP = '거래대금 상위';
const ROLE_VALUE_FALL = '하락 대금 상위';

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** 등락률 — changePct(현재) → prevDayPct(직전 거래일 스냅샷) → chg(파이썬 산출물) */
function chgOf(s) {
  if (!s) return null;
  return num(s.changePct) ?? num(s.prevDayPct) ?? num(s.chg);
}

/** 거래대금(원) — value(원) 우선. 없으면 null(0으로 만들지 않는다) */
function valueOf(s) {
  if (!s) return null;
  return num(s.value) ?? num(s.tradeValue);
}

function isOutlier(s) {
  const c = chgOf(s);
  return c !== null && Math.abs(c) >= OUTLIER_ABS_PCT;
}

function byPctDesc(a, b) {
  return (chgOf(b) ?? -999) - (chgOf(a) ?? -999) || (valueOf(b) ?? 0) - (valueOf(a) ?? 0);
}

function byValueDesc(a, b) {
  return (valueOf(b) ?? 0) - (valueOf(a) ?? 0) || (chgOf(b) ?? -999) - (chgOf(a) ?? -999);
}

/**
 * 상승률 대장 / 실질 거래대금 대장을 고른다.
 * @returns {{pctLeader: object|null, valueLeader: object|null}}
 *   valueLeader 는 상승률 대장과 다른 종목일 때만 채워진다(규칙 ④).
 */
function pickThemeLeaders(stocks) {
  const list = (Array.isArray(stocks) ? stocks : []).filter((s) => s && (s.code || s.name) && !isOutlier(s));
  const rising = list.filter((s) => (chgOf(s) ?? -1) > 0);
  if (!rising.length) return { pctLeader: null, valueLeader: null };
  const pctLeader = rising.slice().sort(byPctDesc)[0];
  const strongByValue = rising
    .filter((s) => (chgOf(s) ?? -999) >= VALUE_LEADER_MIN_PCT)
    .sort(byValueDesc);
  const top = strongByValue[0] || null;
  /* 규칙 ④ — 테마 대금 1위가 이미 상승률 대장이면 '대금 대장' 자리는 비운다.
     2순위 종목에 딱지를 옮겨 붙이면 '테마 대금 1위'가 아닌 종목이 대장이 된다(거짓 표기). */
  const valueLeader = top && top !== pctLeader && top.code !== pctLeader.code ? top : null;
  return { pctLeader, valueLeader };
}

/**
 * 카드에 그릴 4종목 + 역할 — 상승률 대장 → 실질 거래대금 대장 → 동반 상승 → 거래대금 상위 → 하락 대금 상위.
 * @param {Array} stocks 테마 구성종목(전체) — 일부만 넘기면 '테마 내 1위'가 아니라 '넘긴 목록 내 1위'가 된다.
 * @param {number} top 카드에 그릴 종목 수
 */
function assignThemeRoles(stocks, top = 4) {
  const kept = (Array.isArray(stocks) ? stocks : []).filter(
    (s) => s && s.code && !isOutlier(s),
  );
  const rising = kept.filter((s) => (chgOf(s) ?? -1) > 0);
  const falling = kept.filter((s) => (chgOf(s) ?? -1) <= 0);
  const { pctLeader, valueLeader } = pickThemeLeaders(kept);
  const out = [];

  const push = (s, role) => {
    if (!s || out.length >= top) return;
    if (out.some((x) => x.code === s.code)) return;
    out.push({ ...s, role, tileName: s.name });
  };

  push(pctLeader, ROLE_PCT_LEADER);
  push(valueLeader, ROLE_VALUE_LEADER);
  rising.slice().sort(byPctDesc).forEach((s) => push(s, ROLE_MATE));
  rising.slice().sort(byValueDesc).forEach((s) => push(s, ROLE_VALUE_TOP));
  falling.slice().sort(byValueDesc).forEach((s) => push(s, ROLE_VALUE_FALL));
  return out;
}

/**
 * 이미 정해진 4종목(스냅샷 파일 등)의 역할만 다시 계산한다 — 순서·구성은 그대로 둔다.
 *  옛 파일·다른 경로가 쓴 잘못된 역할이 화면에 그대로 나가지 않게 하는 안전망.
 * @returns {{[code: string]: string}}
 */
function themeRoleMap(stocks) {
  const list = (Array.isArray(stocks) ? stocks : []).filter((s) => s && s.code);
  const { pctLeader, valueLeader } = pickThemeLeaders(list);
  const map = {};
  list.forEach((s) => {
    const chg = chgOf(s);
    let role;
    if (pctLeader && s.code === pctLeader.code) role = ROLE_PCT_LEADER;
    else if (valueLeader && s.code === valueLeader.code) role = ROLE_VALUE_LEADER;
    else if (chg === null) role = ROLE_MATE;
    else if (chg > 0) role = ROLE_MATE;
    else role = ROLE_VALUE_FALL;
    map[s.code] = role;
  });
  return map;
}

module.exports = {
  OUTLIER_ABS_PCT,
  VALUE_LEADER_MIN_PCT,
  ROLE_PCT_LEADER,
  ROLE_VALUE_LEADER,
  ROLE_MATE,
  ROLE_VALUE_TOP,
  ROLE_VALUE_FALL,
  chgOf,
  valueOf,
  isOutlier,
  pickThemeLeaders,
  assignThemeRoles,
  themeRoleMap,
};
