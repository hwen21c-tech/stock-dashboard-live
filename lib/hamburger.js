'use strict';

/**
 * 🍔 불개미 '햄버거' 장중매매 — 기준 대금 계산 (2026-11-27 신설)
 * ----------------------------------------------------------------------------
 *  원전: 부자회사원 채널 「불개미님 햄버거 기법」 2편 (AHSUB-eAxxA · 9EVBKc25TTI)
 *
 *  ① 과거 그 종목이 **윗꼬리가 짧은 장대양봉**을 냈던 날, **3분봉에서 시세를 시작시킨
 *     거래대금**을 '햄버거 기준 대금'으로 기억해 둔다.
 *  ② 오늘 그 종목이 속한 섹터가 주도 섹터로 살아 있고, **장초반 3분봉 대금이
 *     그 기준을 압도**하면 햄버거가 완성된 것으로 본다.
 *  ③ 대금이 터져도 **긴 위꼬리 · 도지 · 음봉 · 역배열** 자리는 상승 확률이 낮아 거른다.
 *  ④ 낮은 자리(+10% 미만)면 돌파, 높은 자리(+10% 이상)면 3분봉 20선 눌림으로 본다.
 *
 *  2026-11-27 사용자 확정 기준 2차(v2) — 세 가지를 못 박았다.
 *   (a) 기준봉은 '윗꼬리가 짧은 장대양봉': +10%↑ · 대금 300억↑ 에 더해
 *       **양봉(종가>시가) · 몸통/전체봉 55%↑ · 윗꼬리/전체봉 25%↓**.
 *       예) 레인보우로보틱스 11/24는 정규장 기준 윗꼬리 43.5% · 등락률 +9.6%로 탈락,
 *           11/18(윗꼬리 9.1% · 몸통 87.1% · +19.8%)이 기준봉 후보가 된다.
 *   (b) 기준 3분봉(09:00~09:02) 대금이 **20억 미만이면 기준봉으로 인정하지 않는다**
 *       (`minBase3mEok: 20` — 코스모로보틱스 11/23 1억 같은 날을 거르기 위한 것).
 *       한 날이 걸러지면 그보다 앞선 유효 장대양봉을 이어서 본다.
 *   (c) 성립하지 않은 종목은 화면 목록에서 아예 빼고 숫자만 남긴다(js 화면 담당).
 *
 *  ⚠️ 시/고/저/종은 **네이버 일봉(fchart) 정규장 값**을 1순위로 쓴다 — KIS 일봉
 *     (FHKST03010100)의 종가에는 NXT 시간외 체결이 섞여 11/24 레인보우를 472,000원
 *     (정규 종가 451,500원)으로 내려주는 착시가 있어 윗꼬리 판정이 뒤집힌다.
 *     거래대금은 KIS 일봉(acml_tr_pbmn)을 쓴다(네이버 일봉에는 대금이 없다).
 *
 *  값은 실측만 쓴다 — 봉이 없으면 null 을 돌려주고 화면은 '미계산/미수신'으로 적는다.
 *    · 일봉 OHLC      : 네이버 fchart 일봉(정규장) ↔ KIS FHKST03010100 교차
 *    · 그날 거래대금   : KIS FHKST03010100 (acml_tr_pbmn)
 *    · 그날 시동 3분봉 : 주식일별분봉조회 FHKST03010230 (09:00~09:02 1분봉 3개)
 */

const kis = require('./kis');

const HAM = {
  /* 과거 장대양봉 판정 — 사용자 확정 기준(2026-11-27): +10%↑ & 거래대금 300억↑ */
  yangPct: 10,
  yangValueEok: 300,
  baseUpperWickMax: 0.25,   // 기준봉 윗꼬리/전체봉 25% 이하 (짧은 윗꼬리)
  baseBodyMin: 0.55,        // 기준봉 몸통/전체봉 55% 이상 (꽉 찬 양봉)
  lookbackDays: 100,        // 최근 100거래일(KIS 기간별시세 일봉 상한 100봉)
  maxBigYang: 3,            // 팝업에 함께 적는 과거 장대양봉 날 수(최근 3일)
  maxBaseTries: 3,          // 기준봉 후보 날 분봉 조회 상한(20억 미달이면 그 앞 날로 넘어간다)
  openFrom: '0900',         // 장초반 3분봉 = 09:00~09:02
  openTo: '0902',
  nxtFrom: '0800',          // 장전에는 NXT 첫 3분봉 08:00~08:02
  nxtTo: '0802',
  bigMultiple: 2.0,         // 기준의 2배↑ = 강한 시동
  pctLow: 10,               // +10% 미만 = 돌파 / 이상 = 눌림
  upperWickRatio: 0.4,      // 3분봉 전체 범위의 40%↑가 위꼬리면 '긴 위꼬리'
  dojiBodyRatio: 0.1,       // 몸통이 전체 범위의 10% 이하면 도지
  min3mValueEok: 1,         // 대금이 1억 미만이면 '대금 없음'으로 본다
  minBase3mEok: 20,         // 기준 3분봉(09:00~09:02) 대금 20억 미만이면 기준봉으로 인정하지 않는다
  rulesVersion: 2,          // 기준 규칙 버전 — v1(11/24·1억 기준) 캐시를 읽지 않기 위한 표식
  todayTtlMs: 30 * 1000,    // 오늘 장초반 값은 30초 캐시(09:02 이후 값은 변하지 않는다)
  baseTtlMs: 6 * 3600 * 1000,
  naverDailyTtlMs: 15 * 60 * 1000,
  supabase: {
    url: process.env.SUPABASE_URL || 'https://hiruybkapzuhjrzjoyik.supabase.co',
    key: process.env.SUPABASE_ANON_KEY || 'sb_publishable_e5JJbvCPDhY91uXaUEVNVA_8Byv_gI8',
    table: 'family_sync',
    code: 'hamburger_base_v2',      // v1 → v2 (2026-11-27 기준 재정의 — 옛 캐시 무효화)
  },
};

/* ---------------------------------------------------------------- */
/* 작은 도구                                                          */
/* ---------------------------------------------------------------- */
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}
function round2(v) {
  return num(v) === null ? null : Math.round(v * 100) / 100;
}
function eok(v) {
  return num(v) === null ? null : Math.round(v / 1e8);
}
function kstNow() {
  const t = Date.now() + 9 * 3600 * 1000;
  const d = new Date(t);
  return {
    ymd: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    wd: d.getUTCDay(),
  };
}
function mmdd(ymd) {
  const s = String(ymd || '');
  return s.length === 8 ? `${Number(s.slice(4, 6))}/${Number(s.slice(6, 8))}` : s;
}

/* ---------------------------------------------------------------- */
/* 3분봉 묶음 — 시동 3분봉의 대금·모양                                 */
/* ---------------------------------------------------------------- */
/**
 * 1분봉 배열에서 [from, to] 구간을 3분봉 하나로 묶는다.
 *  대금은 KIS 누적 거래대금(acml_tr_pbmn)의 차분을 1순위로 쓴다(그 분의 정확한 체결 대금).
 *  누적값이 없거나 0/음수로 깨지면 거래량×종가 합으로 대체하고 basis 에 그 사실을 적는다.
 * @param {Array} bars [{t:'HHMM', o,h,l,c,v,cumValue}]
 */
function threeMinute(bars, from, to) {
  const list = (Array.isArray(bars) ? bars : []).filter((b) => b && b.t >= from && b.t <= to);
  if (!list.length) return null;
  list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const first = list[0];
  const last = list[list.length - 1];
  let high = -Infinity;
  let low = Infinity;
  let vol = 0;
  let volCloseValue = 0;
  list.forEach((b) => {
    if (num(b.h) !== null && b.h > high) high = b.h;
    if (num(b.l) !== null && b.l < low) low = b.l;
    const v = num(b.v) || 0;
    vol += v;
    volCloseValue += v * (num(b.c) || 0);
  });
  /* 누적 대금 차분 — 구간 첫 봉 직전 봉의 누적값을 빼면 그 3분의 대금이 된다 */
  let cumDiff = null;
  const allSorted = (Array.isArray(bars) ? bars : []).slice().sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const iFirst = allSorted.indexOf(first);
  const prevBar = iFirst > 0 ? allSorted[iFirst - 1] : null;
  if (num(last.cumValue) !== null) {
    if (prevBar && num(prevBar.cumValue) !== null) cumDiff = last.cumValue - prevBar.cumValue;
    else cumDiff = last.cumValue;      // 그날 첫 봉부터 시작 — 누적값이 곧 그 구간 대금
  }
  const value = num(cumDiff) !== null && cumDiff >= 0 ? cumDiff : volCloseValue;
  const basis = num(cumDiff) !== null && cumDiff >= 0 ? 'cum' : 'volclose';

  const open = num(first.o) !== null ? first.o : first.c;
  const close = num(last.c) !== null ? last.c : open;
  const range = high > low ? high - low : 0;
  const body = Math.abs(close - open);
  const upper = range > 0 ? high - Math.max(open, close) : 0;
  const lower = range > 0 ? Math.min(open, close) - low : 0;
  const kind = body === 0 || (range > 0 && body / range <= HAM.dojiBodyRatio)
    ? 'doji'
    : close > open ? 'yang' : close < open ? 'eum' : 'flat';

  return {
    from,
    to,
    label: `${from.slice(0, 2)}:${from.slice(2)}~${to.slice(0, 2)}:${to.slice(2, 4)}`,
    minutes: list.length,
    open: round2(open),
    close: round2(close),
    high: round2(high),
    low: round2(low),
    vol,
    value,
    valueEok: eok(value),
    basis,
    kind,
    bodyPct: range > 0 ? round2((body / range) * 100) : 0,
    upperPct: range > 0 ? round2((upper / range) * 100) : 0,
    lowerPct: range > 0 ? round2((lower / range) * 100) : 0,
    pct: open > 0 ? round2(((close - open) / open) * 100) : null,
    bars: list.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
  };
}

/* ---------------------------------------------------------------- */
/* 네이버 일봉 — 정규장 시/고/저/종 (KIS 종가의 NXT 착시 교정)           */
/* ---------------------------------------------------------------- */
const NAVER_DAY_URL = 'https://fchart.stock.naver.com/sise.nhn?symbol=';
const NAVER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const NAVER_MEM = new Map();       // code → {at, value}
const NAVER_MEM_MAX = 120;

/**
 * 네이버 차트 일봉 — fchart XML 의 item data="YYYYMMDD|시|고|저|종|거래량"
 *  · 정규장(KRX) 시/고/저/종이다. 장중에는 마지막 봉이 몇 분 늦게 갱신될 수 있다.
 *  · 대금은 없다 → 대금은 KIS 일봉(acml_tr_pbmn)을 쓴다.
 * @returns {Promise<{ok:boolean, code:string, bars:Array, count:number, reason?:string}>}
 */
async function fetchNaverDaily(code, count) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return { ok: false, code: c, bars: [], reason: 'bad_code' };
  const hit = NAVER_MEM.get(c);
  if (hit && Date.now() - hit.at < HAM.naverDailyTtlMs) return hit.value;
  const n = Math.max(60, Math.min(200, Number(count) || 130));
  const url = NAVER_DAY_URL + encodeURIComponent(c) + '&timeframe=day&count=' + n + '&requestType=0';
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 4500) : null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': NAVER_UA, Accept: 'text/xml,*/*' }, cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    if (!r.ok) return { ok: false, code: c, bars: [], reason: 'HTTP ' + r.status };
    const txt = await r.text();
    const bars = [];
    const re = /data="(\d{8})\|([-\d.]+)\|([-\d.]+)\|([-\d.]+)\|([-\d.]+)\|([-\d.]+)"/g;
    let m = re.exec(txt);
    while (m) {
      const o = Number(m[2]);
      const h = Number(m[3]);
      const l = Number(m[4]);
      const cl = Number(m[5]);
      const v = Number(m[6]);
      if ([o, h, l, cl].every((x) => isFinite(x) && x > 0)) {
        bars.push({ d: m[1], o, h, l, c: cl, v: isFinite(v) ? v : null });
      }
      m = re.exec(txt);
    }
    const value = { ok: bars.length > 0, code: c, bars, count: bars.length, source: 'naver-fchart-day(정규장)', at: new Date().toISOString() };
    if (value.ok) {
      if (NAVER_MEM.size >= NAVER_MEM_MAX) NAVER_MEM.delete(NAVER_MEM.keys().next().value);
      NAVER_MEM.set(c, { at: Date.now(), value });
    }
    return value;
  } catch (e) {
    return { ok: false, code: c, bars: [], reason: String((e && e.message) || e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 일봉 두 벌 합치기 — 날짜별로 OHLC 는 네이버(정규장), 대금(value)은 KIS.
 * 네이버에 없는 날은 KIS OHLC 를 그대로 쓰고 src 에 'kis' 로 남긴다(추정 금지).
 */
function mergeDaily(kisBars, naverBars) {
  const map = new Map();
  (Array.isArray(kisBars) ? kisBars : []).forEach((b) => {
    if (!b || !/^\d{8}$/.test(String(b.d || ''))) return;
    map.set(b.d, {
      d: b.d,
      o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c),
      v: num(b.v), value: num(b.value), src: 'kis',
    });
  });
  (Array.isArray(naverBars) ? naverBars : []).forEach((b) => {
    if (!b || !/^\d{8}$/.test(String(b.d || ''))) return;
    const cur = map.get(b.d) || { d: b.d };
    map.set(b.d, Object.assign({}, cur, {
      d: b.d,
      o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c),
      v: num(b.v) !== null ? num(b.v) : cur.v,
      value: num(cur.value),
      src: 'naver',
    }));
  });
  return Array.from(map.values())
    .filter((b) => num(b.c) !== null)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

/* ---------------------------------------------------------------- */
/* 과거 장대양봉 날 — 윗꼬리가 짧은 꽉 찬 양봉만 (2026-11-27 v2)           */
/* ---------------------------------------------------------------- */
/**
 * @param {Array} dailyBars mergeDaily() 결과(또는 KIS 일봉)
 * @param {string} todayYmd
 * @returns {{days:Array, rejected:Array}} days = 조건 성립(최근 → 과거)
 */
function bigYangScan(dailyBars, todayYmd) {
  const bars = (Array.isArray(dailyBars) ? dailyBars : [])
    .filter((b) => b && b.d && num(b.c) !== null)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const days = [];
  const rejected = [];
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i];
    if (todayYmd && b.d >= todayYmd) continue;                    // 오늘 봉은 '이전'이 아니다
    if (bars.length - 1 - i > HAM.lookbackDays) continue;          // 최근 100거래일
    const prev = bars[i - 1];
    const pc = num(prev.c);
    if (pc === null || pc <= 0) continue;
    const pct = ((b.c - pc) / pc) * 100;
    const valueEok = eok(b.value);
    if (pct < HAM.yangPct) continue;                                // 장대양봉 후보가 아니다
    if (valueEok === null || valueEok < HAM.yangValueEok) continue;  // 대금 300억 미만

    const o = num(b.o);
    const h = num(b.h);
    const l = num(b.l);
    const c = num(b.c);
    const range = h !== null && l !== null && h > l ? h - l : 0;
    const body = o !== null && c > o ? c - o : 0;
    const upper = h !== null && o !== null && c !== null ? h - Math.max(o, c) : null;
    const wickRatio = range > 0 && upper !== null ? upper / range : null;
    const bodyRatio = range > 0 ? body / range : null;
    const why = [];
    if (!(o !== null && c > o)) why.push('음봉/보합');
    if (bodyRatio === null || bodyRatio < HAM.baseBodyMin) why.push('몸통 ' + (bodyRatio === null ? '—' : round2(bodyRatio * 100) + '%'));
    if (wickRatio === null || wickRatio > HAM.baseUpperWickMax) why.push('긴 윗꼬리 ' + (wickRatio === null ? '—' : round2(wickRatio * 100) + '%'));
    const base = {
      date: b.d,
      dateLabel: mmdd(b.d),
      pct: round2(pct),
      open: round2(o),
      high: round2(h),
      low: round2(l),
      close: round2(c),
      valueEok,
      bodyPct: bodyRatio === null ? null : round2(bodyRatio * 100),   // 몸통/전체봉
      upperWickPct: wickRatio === null ? null : round2(wickRatio * 100), // 윗꼬리/전체봉
      ohlcSrc: b.src || 'kis',
    };
    if (why.length) rejected.push(Object.assign({}, base, { why }));
    else days.push(base);
  }
  return { days: days.reverse(), rejected: rejected.reverse() };   // 최근 → 과거
}

/** 하위호환 — 조건을 통과한 장대양봉 날만 배열로(최근 → 과거) */
function findBigYangDays(dailyBars, todayYmd) {
  return bigYangScan(dailyBars, todayYmd).days;
}

/* ---------------------------------------------------------------- */
/* 캐시 — ① 인스턴스 메모리 ② 저장소 JSON ③ Supabase 공용 행            */
/* ---------------------------------------------------------------- */
const baseMem = new Map();          // code → {at, value}
const todayMem = new Map();         // `${code}:${date}:${market}` → {at, value}
const todayLastGood = new Map();    // 마지막 성공값 — 재조회가 흔들려도 직전 실측을 버리지 않는다
let BUNDLED = null;
let SB_CACHE = null;                // {at, rows}
const SB_TIMEOUT = 2200;
const SB_WRITE_TIMEOUT = 1200;
const sbHeader = () => ({
  apikey: HAM.supabase.key,
  Authorization: 'Bearer ' + HAM.supabase.key,
  Accept: 'application/json',
});

function bundledRows() {
  if (BUNDLED) return BUNDLED;
  try {
    const doc = require('../public/data/hamburger_base_cache.json');
    /* 2026-11-27 v2 — 옛 규칙(v1: 120일·윗꼬리 무시·11/24·1억)으로 만든 번들은 읽지 않는다 */
    const okV = doc && Number(doc.v) >= HAM.rulesVersion;
    BUNDLED = okV && doc.rows ? doc.rows : {};
  } catch (e) {
    BUNDLED = {};
  }
  return BUNDLED;
}

/** 캐시 행이 지금 기준(규칙 버전·당일)에 맞는지 — 옛 기준·먼 날 값은 다시 계산한다 */
function rowUsable(row, todayYmd) {
  if (!row || typeof row !== 'object') return false;
  if (row.rulesV !== HAM.rulesVersion) return false;
  if (todayYmd && row.asOfDate && row.asOfDate !== todayYmd) return false;
  return true;
}

async function sbReadRows() {
  if (SB_CACHE && Date.now() - SB_CACHE.at < 5 * 60 * 1000) return SB_CACHE.rows;
  const url = `${HAM.supabase.url}/rest/v1/${HAM.supabase.table}?code=eq.${encodeURIComponent(HAM.supabase.code)}&select=code,data`;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), SB_TIMEOUT) : null;
  try {
    const r = await fetch(url, { headers: sbHeader(), cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    if (!r.ok) return (SB_CACHE && SB_CACHE.rows) || {};
    const rows = await r.json();
    const data = Array.isArray(rows) && rows[0] ? rows[0].data : null;
    const map = (data && data.rows && typeof data.rows === 'object') ? data.rows : {};
    SB_CACHE = { at: Date.now(), rows: map };
    return map;
  } catch (e) {
    return (SB_CACHE && SB_CACHE.rows) || {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 계산한 기준을 공용 행에 합쳐 둔다(다음 인스턴스·내일도 재사용). 실패는 조용히. */
let sbWriteChain = Promise.resolve();
function sbWriteRow(code, value) {
  sbWriteChain = sbWriteChain.then(async () => {
    try {
      const rows = await sbReadRows();
      const next = Object.assign({}, rows, { [code]: value });
      const url = `${HAM.supabase.url}/rest/v1/${HAM.supabase.table}?on_conflict=code`;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), SB_WRITE_TIMEOUT) : null;
      try {
        await fetch(url, {
          method: 'POST',
          headers: { ...sbHeader(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([{ code: HAM.supabase.code, data: { rows: next, updatedAt: new Date().toISOString() }, updated_at: new Date().toISOString() }]),
          cache: 'no-store',
          signal: ctl ? ctl.signal : undefined,
        });
        SB_CACHE = { at: Date.now(), rows: next };
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (e) { /* 조용히 */ }
  }).catch(() => {});
  return sbWriteChain;
}

/* ---------------------------------------------------------------- */
/* 기준(과거 장대양봉 + 그날 시동 3분봉 대금)                          */
/* ---------------------------------------------------------------- */
/**
 * @param {string} code
 * @param {{noCache?:boolean}} [opts]
 * @returns {Promise<Object>} {ok, code, asOfDate, base, bigYang, others, daily, reason}
 */
async function getBase(code, opts = {}) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return { ok: false, code: c, reason: 'bad_code' };
  const today = kstNow().ymd;
  const hit = baseMem.get(c);
  if (!opts.noCache && hit && Date.now() - hit.at < HAM.baseTtlMs && rowUsable(hit.value, today)) return hit.value;

  const fromBundle = bundledRows()[c];
  if (rowUsable(fromBundle, today)) {
    baseMem.set(c, { at: Date.now(), value: fromBundle });
    return fromBundle;
  }
  const fromSb = (await sbReadRows())[c];
  if (rowUsable(fromSb, today)) {
    baseMem.set(c, { at: Date.now(), value: fromSb });
    return fromSb;
  }
  /* 화면 폴링은 캐시만 본다 — 즉석 계산은 요청당 정해진 종목 수만(API 레이어가 정한다) */
  if (opts.cacheOnly) {
    return { ok: false, code: c, reason: 'not_computed', message: '기준 대금 미계산 (일봉·과거 분봉 조회 전)' };
  }

  /* 계산 — ① 일봉(네이버 정규장 + KIS 대금) ② 윗꼬리 짧은 장대양봉 날 ③ 그날 09:00~09:02 3분봉 */
  const [kisDaily, naverDaily] = await Promise.all([
    kis.fetchDailyHistory(c, { days: 100, endYmd: today }).catch((e) => ({ ok: false, bars: [], reason: String((e && e.message) || e) })),
    fetchNaverDaily(c, 130).catch((e) => ({ ok: false, bars: [], reason: String((e && e.message) || e) })),
  ]);
  const merged = mergeDaily(kisDaily && kisDaily.bars, naverDaily && naverDaily.bars);
  if (!merged.length) {
    return {
      ok: false, code: c, asOfDate: today, rulesV: HAM.rulesVersion, reason: 'no_daily',
      message: '일봉이 없습니다' + (kisDaily && kisDaily.reason ? ' (' + kisDaily.reason + ')' : ''),
      sources: { daily: 'kis+naver', naver: Boolean(naverDaily && naverDaily.ok) },
    };
  }
  const scan = bigYangScan(merged, today);
  const scanMeta = {
    scanned: merged.length,
    ohlcSrc: (naverDaily && naverDaily.ok) ? 'naver-fchart(정규장)+KIS대금' : 'KIS 일봉(교차 실패)',
    reversal: reversalOf(merged),
    rejectedDays: scan.rejected.slice(0, 3).map((r) => ({
      dateLabel: r.dateLabel, pct: r.pct, valueEok: r.valueEok,
      upperWickPct: r.upperWickPct, bodyPct: r.bodyPct, why: r.why,
    })),
  };
  if (!scan.days.length) {
    const value = Object.assign({
      ok: false,
      code: c,
      asOfDate: today,
      rulesV: HAM.rulesVersion,
      computedAt: new Date().toISOString(),
      reason: 'no_big_yang',
      message: `최근 ${HAM.lookbackDays}거래일 안에 윗꼬리 짧은 장대양봉(+${HAM.yangPct}%↑ · 대금 ${HAM.yangValueEok}억↑ · 윗꼬리 ${Math.round(HAM.baseUpperWickMax * 100)}%↓)이 없습니다`,
      daily: merged.slice(-3).map((b) => ({ d: b.d, c: b.c, value: b.value })),
      source: '네이버 일봉(정규장) + KIS FHKST03010100(대금)',
    }, scanMeta);
    /* '장대양봉 없음'도 결과다 — 매 폴링마다 일봉을 다시 받지 않게 6시간 캐싱한다 */
    baseMem.set(c, { at: Date.now(), value });
    sbWriteRow(c, value);
    return value;
  }

  /* 기준봉 후보 날을 최근 → 과거로 — 3분봉 대금 20억 미만인 날은 건너뛰고 그 앞 날을 본다 */
  const skippedBases = [];
  let chosen = null;
  let open3m = null;
  let minuteCount = 0;
  const tries = scan.days.slice(0, HAM.maxBaseTries);
  for (let i = 0; i < tries.length; i += 1) {
    const day = tries[i];
    let minute = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      minute = await kis.fetchMinuteBarsForDate(c, day.date, { hour: '090300' });
    } catch (e) {
      minute = { ok: false, bars: [], reason: String((e && e.message) || e) };
    }
    /* 초당 제한·일시 빈 응답이면 한 번은 다시 찌른다 — 못 받은 날을 '기준 없음'으로 잘못 단정하지 않게 */
    if (!minute || !minute.ok) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 260));
      try {
        // eslint-disable-next-line no-await-in-loop
        minute = await kis.fetchMinuteBarsForDate(c, day.date, { hour: '090300', noCache: true });
      } catch (e) {
        minute = { ok: false, bars: [], reason: String((e && e.message) || e) };
      }
    }
    const got = minute && minute.ok ? threeMinute(minute.bars, HAM.openFrom, HAM.openTo) : null;
    minuteCount = (minute && minute.count) || 0;
    if (!got) {
      skippedBases.push({
        date: day.date, dateLabel: day.dateLabel,
        why: '분봉 미수신' + (minute && minute.reason ? '(' + String(minute.reason).slice(0, 60) + ')' : ''),
      });
      continue;
    }
    if (num(got.value) === null || got.value < HAM.minBase3mEok * 1e8) {
      skippedBases.push({
        date: day.date, dateLabel: day.dateLabel,
        why: `기준 3분봉 ${got.valueEok}억 < ${HAM.minBase3mEok}억`,
        open3mEok: got.valueEok,
      });
      continue;
    }
    chosen = day;
    open3m = got;
    break;
  }

  if (!chosen) {
    const value = Object.assign({
      ok: false,
      code: c,
      asOfDate: today,
      rulesV: HAM.rulesVersion,
      computedAt: new Date().toISOString(),
      reason: skippedBases.some((s) => s.open3mEok !== undefined) ? 'base_below_min' : 'no_minute_base',
      message: `장대양봉 후보 ${tries.length}일 중 09:00~09:02 3분봉 대금 ${HAM.minBase3mEok}억↑인 날이 없습니다`,
      skippedBases,
      daily: merged.slice(-3).map((b) => ({ d: b.d, c: b.c, value: b.value })),
      source: '네이버 일봉(정규장) + KIS FHKST03010100(대금) + FHKST03010230(과거 분봉)',
    }, scanMeta);
    baseMem.set(c, { at: Date.now(), value });
    sbWriteRow(c, value);
    return value;
  }

  const value = Object.assign({
    ok: true,
    code: c,
    asOfDate: today,
    rulesV: HAM.rulesVersion,
    computedAt: new Date().toISOString(),
    bigYang: Object.assign({}, chosen, { open3m }),
    others: scan.days.filter((d) => d.date !== chosen.date).slice(0, HAM.maxBigYang - 1),
    skippedBases,
    reversal: reversalOf(merged),
    minuteBars: minuteCount,
    reason: null,
    message: null,
    daily: merged.slice(-3).map((b) => ({ d: b.d, c: b.c, value: b.value })),
    source: '네이버 일봉(정규장) + KIS FHKST03010100(대금) + FHKST03010230(과거 분봉)',
  }, scanMeta);
  baseMem.set(c, { at: Date.now(), value });
  sbWriteRow(c, value);
  return value;
}

/* ---------------------------------------------------------------- */
/* 오늘 장초반 3분봉                                                  */
/* ---------------------------------------------------------------- */
/**
 * @param {string} code
 * @param {{noCache?:boolean, marketDiv?:'J'|'NX'}} [opts]
 * @returns {Promise<Object>} {ok, date, market, open3m, reason}
 */
async function getTodayOpen(code, opts = {}) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return { ok: false, code: c, reason: 'bad_code' };
  const now = kstNow();
  const date = now.ymd;
  /* 장전(09:00 이전)에는 정규장 봉이 없다 → NXT 첫 3분봉(08:00~08:02)을 본다 */
  const beforeOpen = now.minutes < 9 * 60;
  const market = opts.marketDiv || (beforeOpen ? 'NX' : 'J');
  const win = market === 'NX' ? { from: HAM.nxtFrom, to: HAM.nxtTo, hour: '080300' } : { from: HAM.openFrom, to: HAM.openTo, hour: '090300' };
  const key = `${c}:${date}:${market}`;
  const hit = todayMem.get(key);
  /* 장초반 3분봉은 그 구간이 지나면 값이 변하지 않는다 — 지난 뒤에는 길게 캐시해 KIS 호출을 줄인다 */
  const windowDone = market === 'NX' ? now.minutes >= 8 * 60 + 3 : now.minutes >= 9 * 60 + 3;
  const ttl = windowDone ? 6 * 3600 * 1000 : HAM.todayTtlMs;
  if (!opts.noCache && hit && Date.now() - hit.at < ttl) return hit.value;

  let got = null;
  try {
    got = await kis.fetchMinuteBarsForDate(c, date, { hour: win.hour, marketDiv: market });
  } catch (e) {
    got = { ok: false, bars: [], reason: String((e && e.message) || e) };
  }
  const open3m = got && got.ok ? threeMinute(got.bars, win.from, win.to) : null;
  /* 한 번은 다시 찌른다 — 초당 제한·일시 빈 응답이면 직전 성공값을 그대로 유지한다 */
  const due = market === 'NX' ? now.minutes >= 8 * 60 + 3 : now.minutes >= 9 * 60 + 3;
  if (!open3m && due && !opts.noRetry) {
    const again = await getTodayOpen(c, { noCache: true, noRetry: true, marketDiv: market });
    if (again && again.ok) return again;
  }
  /* 주말·휴장일·장초반(첫 3분봉 전)에는 오늘 봉이 없다 — 직전 거래일 09:00~09:02 실측으로 보여준다 */
  if (!open3m && !opts.noFallback) {
    const fb = await prevSessionOpen(c, date);
    if (fb && fb.ok) {
      todayLastGood.set(key, fb);
      return fb;
    }
  }
  const value = {
    ok: Boolean(open3m),
    code: c,
    date,
    dateLabel: mmdd(date),
    market,
    marketLabel: market === 'NX' ? 'NXT 프리마켓' : '정규장',
    open3m,
    bars: got ? got.count : 0,
    reason: open3m ? null : (got && got.reason) || 'no_minute',
    message: open3m ? null : (market === 'NX'
      ? 'NXT 첫 3분봉(08:00~08:02)이 아직 없습니다'
      : '오늘 09:00~09:02 분봉이 아직 없습니다'),
    at: new Date().toISOString(),
  };
  if (value.ok) {
    todayMem.set(key, { at: Date.now(), value });
    todayLastGood.set(key, value);
  } else if (todayLastGood.has(key)) {
    /* 이번 조회만 실패 — 방금까지 보여 주던 실측값을 '미수신'으로 바꾸지 않는다 */
    return Object.assign({}, todayLastGood.get(key), { stale: true, refreshed: false });
  }
  return value;
}

/** 직전 거래일(주말 건너뜀) YYYYMMDD — 최대 7일 */
function prevWeekdayYmd(ymd) {
  const s = String(ymd || '');
  if (s.length !== 8) return null;
  const t = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  for (let k = 1; k <= 7; k += 1) {
    const d = new Date(t - k * 86400000);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  return null;
}

/** 직전 거래일 정규장 09:00~09:02 3분봉 — 휴장일·장초반 대체값(최대 3거래일 거슬러) */
async function prevSessionOpen(code, fromYmd) {
  let ymd = prevWeekdayYmd(fromYmd);
  for (let i = 0; i < 3 && ymd; i += 1) {
    let got = null;
    try {
      got = await kis.fetchMinuteBarsForDate(code, ymd, { hour: '090300' });
    } catch (e) {
      got = null;
    }
    const open3m = got && got.ok ? threeMinute(got.bars, HAM.openFrom, HAM.openTo) : null;
    if (open3m) {
      return {
        ok: true,
        code,
        date: ymd,
        dateLabel: mmdd(ymd),
        market: 'J',
        marketLabel: '직전 거래일',
        fallback: true,
        open3m,
        bars: got.count,
        reason: null,
        message: null,
        at: new Date().toISOString(),
      };
    }
    ymd = prevWeekdayYmd(ymd);
  }
  return null;
}

/* ---------------------------------------------------------------- */
/* 3분봉 20선 (오늘 1분봉 → 3분봉 20개 평균)                          */
/* ---------------------------------------------------------------- */
function threeMinMA20(minuteBars) {
  const bars = (Array.isArray(minuteBars) ? minuteBars : []).filter((b) => b && /^\d{4}$/.test(String(b.t)));
  if (bars.length < 60) return null;
  const sorted = bars.slice().sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const buckets = new Map();
  sorted.forEach((b) => {
    const hh = parseInt(b.t.slice(0, 2), 10);
    const mm = parseInt(b.t.slice(2), 10);
    const idx = Math.floor((hh * 60 + mm) / 3) * 3;
    const key3 = `${String(Math.floor(idx / 60)).padStart(2, '0')}${String(idx % 60).padStart(2, '0')}`;
    const cur = buckets.get(key3);
    if (!cur) {
      buckets.set(key3, { k: key3, o: b.o, h: b.h, l: b.l, c: b.c });
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
  });
  const list = Array.from(buckets.values()).sort((a, b) => (a.k < b.k ? -1 : 1));
  if (list.length < 20) return { ok: false, reason: '3분봉이 20개 미만', bars: list.length };
  const last20 = list.slice(-20);
  const ma20 = last20.reduce((s, x) => s + x.c, 0) / last20.length;
  return { ok: true, ma20: Math.round(ma20), bars: list.length, at: list.length ? list[list.length - 1].k : null };
}

/* ---------------------------------------------------------------- */
/* 판정 — 대금 대조 + 실패 패턴                                       */
/* ---------------------------------------------------------------- */
function judge(base, today, extra) {
  const o = extra || {};
  const out = {
    pass: false,
    passMultiple: null,
    tag: '기준 대기',
    tagKind: 'wait',
    reasons: [],
    blocks: [],
    shape: null,
    reversal: null,
  };
  const baseEok = base && base.bigYang && base.bigYang.open3m ? base.bigYang.open3m.valueEok : null;
  const todayEok = today && today.open3m ? today.open3m.valueEok : null;
  if (num(baseEok) !== null && num(todayEok) !== null && baseEok > 0) {
    out.passMultiple = round2(todayEok / baseEok);
    out.deltaEok = todayEok - baseEok;
  }

  if (!base || !base.ok || num(baseEok) === null) {
    out.reasons.push(base && base.message ? base.message : '과거 장대양봉 기준 대금 미계산');
    if (base && base.reason === 'base_below_min') {
      out.tag = `기준 미달(3분봉 ${HAM.minBase3mEok}억↓)`;
      out.tagKind = 'mute';
      out.baseMissing = true;
    } else {
      out.tag = base && base.reason === 'no_big_yang' ? '기준 없음' : '기준 미계산';
      out.tagKind = 'wait';
      out.baseMissing = true;
    }
    return out;
  }
  if (!today || !today.ok || num(todayEok) === null) {
    out.reasons.push(today && today.message ? today.message : '오늘 장초반 3분봉 미수신');
    out.tag = today && today.market === 'NX' ? 'NXT 대기' : '장초반 대금 미수신';
    out.tagKind = 'wait';
    return out;
  }

  const shape = today.open3m;
  out.shape = {
    kind: shape.kind,
    bodyPct: shape.bodyPct,
    upperPct: shape.upperPct,
    pct: shape.pct,
  };
  /* 실패 패턴 — 긴 위꼬리 · 도지 · 음봉 · 역배열 */
  if (shape.kind === 'eum') out.blocks.push('음봉(3분봉 종가 < 시가)');
  if (shape.kind === 'doji') out.blocks.push('도지(몸통 없음)');
  if (num(shape.upperPct) !== null && shape.upperPct >= HAM.upperWickRatio * 100 && num(shape.bodyPct) !== null && shape.bodyPct < 50) {
    out.blocks.push('긴 위꼬리(위꼬리 ' + shape.upperPct + '%)');
  }
  if (o.reversal && o.reversal.reverse) out.blocks.push('일봉 역배열(' + o.reversal.label + ')');
  else if (base && base.reversal && base.reversal.reverse) out.blocks.push('일봉 역배열(' + base.reversal.label + ')');

  const bigEnough = num(todayEok) !== null && todayEok >= baseEok;
  const overMin = num(todayEok) !== null && todayEok >= HAM.min3mValueEok;
  if (!overMin) out.blocks.push('대금 ' + HAM.min3mValueEok + '억 미만');
  if (!bigEnough) out.reasons.push('오늘 ' + todayEok + '억 < 기준 ' + baseEok + '억 (' + out.passMultiple + '배)');

  out.pass = bigEnough && overMin && out.blocks.length === 0;
  if (out.pass) {
    const pctNow = num(o.pctNow);
    const head = out.passMultiple !== null && out.passMultiple >= HAM.bigMultiple
      ? '🍔 강한 시동 ' + out.passMultiple + '배'
      : '🍔 기준 돌파 ' + out.passMultiple + '배';
    const place = pctNow === null
      ? '등락률 미수신'
      : pctNow < HAM.pctLow ? '⚡ 돌파 자리(+10% 미만)' : '🎯 눌림 자리(+10%↑)';
    out.tag = head + ' · ' + place;
    out.tagKind = out.passMultiple !== null && out.passMultiple >= HAM.bigMultiple ? 'hot' : 'ok';
    out.reasons.push('오늘 ' + todayEok + '억 ≥ 기준 ' + baseEok + '억 (' + out.passMultiple + '배)');
  } else if (bigEnough && out.blocks.length) {
    out.tag = '⛔ 실패 패턴';
    out.tagKind = 'dn';
  } else {
    out.tag = '대금 미달 (' + (out.passMultiple === null ? '—' : out.passMultiple + '배') + ')';
    out.tagKind = 'mute';
  }
  return out;
}

/** 일봉 역배열 판정 — MA5 < MA20 < MA60 이면 완전 역배열, MA5 < MA20 이면 단기 역배열 */
function reversalOf(dailyBars) {
  const bars = (Array.isArray(dailyBars) ? dailyBars : []).filter((b) => b && num(b.c) !== null);
  if (bars.length < 60) return { reverse: false, label: '일봉 60봉 미만', ma5: null, ma20: null, ma60: null };
  const closes = bars.map((b) => b.c);
  const tail = closes.slice(-60);
  const ma = (n) => tail.slice(-n).reduce((s, v) => s + v, 0) / n;
  const ma5 = ma(5);
  const ma20 = ma(20);
  const ma60 = ma(60);
  const full = ma5 < ma20 && ma20 < ma60;
  const shortRev = ma5 < ma20;
  return {
    reverse: full,
    shortRev,
    label: full ? 'MA5<MA20<MA60' : `MA5 ${Math.round(ma5)} · MA20 ${Math.round(ma20)} · MA60 ${Math.round(ma60)}`,
    ma5: Math.round(ma5),
    ma20: Math.round(ma20),
    ma60: Math.round(ma60),
  };
}

/** 팝업 한 종목용 종합 — 기준 + 오늘 장초반 + 판정 */
async function inspect(code, opts = {}) {
  const c = String(code || '').trim();
  const [base, today] = await Promise.all([
    getBase(c, opts).catch((e) => ({ ok: false, code: c, reason: 'base_error', message: String((e && e.message) || e) })),
    getTodayOpen(c, opts).catch((e) => ({ ok: false, code: c, reason: 'today_error', message: String((e && e.message) || e) })),
  ]);
  /* 일봉 배열은 기준 계산에서 함께 구한 값을 그대로 쓴다(일봉 재조회 0회) */
  const rev = (base && base.reversal) || { reverse: false, shortRev: false, label: '일봉 배열 미계산', ma5: null, ma20: null, ma60: null };
  const pctNow = num(opts.pctNow);
  const j = judge(base, today, { reversal: rev, pctNow });
  return {
    ok: Boolean(base && base.ok),
    code: c,
    base,
    today,
    verdict: j,
    reversal: rev,
    rules: publicRules(),
  };
}

function publicRules() {
  return {
    rulesVersion: HAM.rulesVersion,
    yangPct: HAM.yangPct,
    yangValueEok: HAM.yangValueEok,
    baseUpperWickPct: Math.round(HAM.baseUpperWickMax * 100),
    baseBodyPct: Math.round(HAM.baseBodyMin * 100),
    minBase3mEok: HAM.minBase3mEok,
    lookbackDays: HAM.lookbackDays,
    openWindow: '09:00~09:02',
    nxtWindow: '08:00~08:02',
    bigMultiple: HAM.bigMultiple,
    pctLow: HAM.pctLow,
    ohlcSource: '네이버 일봉(정규장) + KIS 대금',
    blocks: '긴 위꼬리 · 도지 · 음봉 · 역배열',
    baseRule: `최근 ${HAM.lookbackDays}거래일 장대양봉(+${HAM.yangPct}%↑·대금 ${HAM.yangValueEok}억↑·양봉·몸통 ${Math.round(HAM.baseBodyMin * 100)}%↑·윗꼬리 ${Math.round(HAM.baseUpperWickMax * 100)}%↓) 날의 09:00~09:02 3분봉 대금 ${HAM.minBase3mEok}억↑`,
    showRule: '성립 종목만 표시 — 기준 미달·실패 패턴은 목록에서 뺀다',
  };
}

module.exports = {
  HAM,
  threeMinute,
  findBigYangDays,
  bigYangScan,
  mergeDaily,
  fetchNaverDaily,
  getBase,
  getTodayOpen,
  threeMinMA20,
  prevSessionOpen,
  prevWeekdayYmd,
  reversalOf,
  judge,
  inspect,
  publicRules,
  mmdd,
};
