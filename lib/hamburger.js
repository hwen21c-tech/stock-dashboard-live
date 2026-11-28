'use strict';

/**
 * 🍔 불개미 '햄버거' 장중매매 — 기준 대금 계산
 * ----------------------------------------------------------------------------
 *  원전: 부자회사원 채널 「불개미님 햄버거 기법」 2편 (AHSUB-eAxxA · 9EVBKc25TTI)
 *
 *  ① 과거 그 종목이 **윗꼬리가 짧은 장대양봉**을 냈던 날, **3분봉에서 시세를 시작시킨
 *     거래대금**을 '햄버거 기준 대금'으로 기억해 둔다.
 *  ② 오늘 그 종목이 속한 섹터가 주도 섹터로 살아 있고, **3분봉 대금이
 *     그 기준을 압도**하면 햄버거가 완성된 것으로 본다.
 *  ③ 대금이 터져도 **긴 위꼬리 · 도지 · 음봉 · 역배열** 자리는 상승 확률이 낮아 거른다.
 *  ④ 낮은 자리면 돌파(🚀), 높은 자리면 3분봉 5선 눌림(🧲)으로 본다.
 *
 *  2026-11-28 사용자 확정 기준 4차(v4) — **09:15 이후 최대 3분봉**이 기준이다.
 *   · 기준봉(과거 장대양봉 날)은 **장 초반 혼란 구간(09:00~09:14)을 빼고**
 *     09:15~15:20 에 그날 형성된 3분봉 중 **가장 크게 터진 최대 거래대금**을 '기준 햄버거
 *     대금(연료통)'으로 쓴다(`maxFrom 0915` · `maxTo 1520`). 그 최대 봉의 시각도 함께 남긴다.
 *   · 오늘도 같은 방식 — 09:15 이후(장중이면 현재까지) 형성된 3분봉 중 최대 거래대금이
 *     과거 기준 최대 3분봉 이상이면 성립(`todayMax3m >= baseMax3m`, 기준은 20억↑).
 *   · 09:00~09:29 에는 후보를 미리 보여 주되 `⏳ 09:30 이전 관망` 배지를 붙인다
 *     (홍인기 D+0 과 같은 감각 — 원전은 30분을 지켜본 뒤 매매).
 *   · 타점 — 오늘 위치가 낮은 구간(+10% 미만 또는 과거 장대양봉 등락률의 절반 이하)이면
 *     `🚀 낮은 구간 · 돌파 타점`, 높은 구간이면 `🧲 높은 구간 · 눌림 타점(3분봉 5선)`.
 *
 *  2026-11-27 사용자 확정 기준 3차(v3) — 유지되는 규칙
 *   · 기준봉은 '가장 최근 윗꼬리 짧은 장대양봉 1일'만 본다(`maxBaseTries: 1`).
 *   · 그날 기준 3분봉 대금이 20억 미만이면 **과거 날로 거슬러 올라가지 않고** 그 종목을
 *     바로 `base_below_min`(기준 미달)로 제외한다(소급 없음).
 *   · 예) 레인보우로보틱스 11/18 9.89억 · 로보티즈 11/18 9억 · 에코프로 11/11 16억 → 기준 미달.
 *
 *  v2 규칙(유지) — 기준봉은 +10%↑ · 대금 300억↑ 에 더해 양봉(종가>시가) · 몸통/전체봉 55%↑ ·
 *   윗꼬리/전체봉 25%↓. 봉의 시/고/저/종은 **네이버 일봉(fchart) 정규장 값**을 1순위로 쓴다
 *   (KIS 일봉 종가에 NXT 시간외가 섞여 윗꼬리 판정이 뒤집히는 착시 방지). 거래대금은 KIS 일봉.
 *
 *  값은 실측만 쓴다 — 봉이 없으면 null 을 돌려주고 화면은 '미계산/미수신'으로 적는다.
 *    · 일봉 OHLC      : 네이버 fchart 일봉(정규장) ↔ KIS FHKST03010100 교차
 *    · 그날 거래대금   : KIS FHKST03010100 (acml_tr_pbmn)
 *    · 3분봉 원자료    : 주식일별분봉조회 FHKST03010230 — 한 번에 120봉씩이므로
 *                        `fetchMinuteWindow` 가 09:15 이후 전 구간을 페이지로 이어 붙인다
 *                        (호출 수는 1분봉 120개 단위 — 하루 4~5회, 메모리 12시간 캐시).
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
  maxBaseTries: 1,          // v3 — 가장 최근 장대양봉 1일만 본다(20억 미달이면 앞 날로 넘어가지 않고 기준 미달로 제외)
  openFrom: '0900',         // (레거시) 장초반 3분봉 = 09:00~09:02 — 진단·비교용으로만 남긴다
  openTo: '0902',
  maxFrom: '0915',          // v4 기준 구간 — 장 초반 혼란(09:00~09:14) 제외
  maxTo: '1520',            // v4 기준 구간 끝(15:20 봉까지)
  nxtFrom: '0800',          // 장전에는 NXT 첫 3분봉 08:00~08:02
  nxtTo: '0802',
  bigMultiple: 2.0,         // 기준의 2배↑ = 강한 시동
  pctLow: 10,               // +10% 미만 = 돌파 / 이상 = 눌림
  maFast: 5,                // 눌림 타점 기준선 = 3분봉 5선
  maSlow: 20,               // 참고 = 3분봉 20선
  watchFrom: 9 * 60,        // 09:00
  watchTo: 9 * 60 + 30,     // 09:30 — 이전이면 '⏳ 09:30 이전 관망'
  upperWickRatio: 0.4,      // 3분봉 전체 범위의 40%↑가 위꼬리면 '긴 위꼬리'
  dojiBodyRatio: 0.1,       // 몸통이 전체 범위의 10% 이하면 도지
  min3mValueEok: 1,         // 대금이 1억 미만이면 '대금 없음'으로 본다
  minBase3mEok: 20,         // 기준 3분봉(09:15 이후 최대) 대금 20억 미만이면 기준봉으로 인정하지 않는다
  rulesVersion: 4,          // 기준 규칙 버전 — v3(09:00~09:02 첫 3분봉) 캐시를 읽지 않기 위한 표식(2026-11-28 사용자 확정)
  todayTtlMs: 90 * 1000,    // 오늘 3분봉 최대값 캐시(장 마감 뒤에는 길게)
  baseTtlMs: 6 * 3600 * 1000,
  naverDailyTtlMs: 15 * 60 * 1000,
  minutePages: 7,           // 09:15 이전까지 거슬러 올라가는 최대 페이지 수(120봉/페이지)
  supabase: {
    url: process.env.SUPABASE_URL || 'https://hiruybkapzuhjrzjoyik.supabase.co',
    key: process.env.SUPABASE_ANON_KEY || 'sb_publishable_e5JJbvCPDhY91uXaUEVNVA_8Byv_gI8',
    table: 'family_sync',
    code: 'hamburger_base_v3',      // v2 → v3 (2026-11-28 09:15 이후 최대 3분봉 기준 — 옛 캐시 무효화)
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
/** 분(minute of day) → 'HHMM' */
function hhmm(minutes) {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
}
/** 'HHMM' → 분 */
function toMin(t) {
  const s = String(t || '');
  if (!/^\d{4}$/.test(s)) return null;
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * 3분 격자 버킷 — 구간 [from,to] 안의 1분봉을 3분 단위(09:15~09:17, 09:18~09:20 …)로 묶는다.
 *  · 대금은 버킷 첫 봉 **직전 봉**의 누적 거래대금과의 차분 — 값이 하루 중간에서 잘려도 정확하다.
 *  · bars 는 하루 전체(09:00~)가 이어 붙은 배열이어야 한다(직전 봉을 찾기 위해).
 * @returns {Array} [{key:'0915', label:'09:15~09:17', minutes:3, value, valueEok, kind, bodyPct, upperPct, pct, open, close, high, low}]
 */
function bucket3m(bars, from, to) {
  const list = (Array.isArray(bars) ? bars : []).filter((b) => b && /^\d{4}$/.test(String(b.t)));
  if (!list.length) return [];
  const sorted = list.slice().sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const idxByT = new Map();
  sorted.forEach((b, i) => { if (!idxByT.has(b.t)) idxByT.set(b.t, i); });
  const fromMin = toMin(from);
  const toWindowMin = toMin(to);
  if (fromMin === null || toWindowMin === null) return [];

  const groups = new Map();
  sorted.forEach((b) => {
    const m = toMin(b.t);
    if (m === null) return;
    const start = Math.floor(m / 3) * 3;
    if (start < fromMin || start > toWindowMin) return;
    const key = hhmm(start);
    const cur = groups.get(key);
    if (cur) cur.push(b);
    else groups.set(key, [b]);
  });

  const out = [];
  groups.forEach((g, key) => {
    const arr = g.slice().sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    const first = arr[0];
    const last = arr[arr.length - 1];
    let high = -Infinity;
    let low = Infinity;
    let vol = 0;
    let volCloseValue = 0;
    arr.forEach((b) => {
      if (num(b.h) !== null && b.h > high) high = b.h;
      if (num(b.l) !== null && b.l < low) low = b.l;
      const v = num(b.v) || 0;
      vol += v;
      volCloseValue += v * (num(b.c) || 0);
    });
    let cumDiff = null;
    const iFirst = idxByT.get(first.t);
    const prevBar = typeof iFirst === 'number' && iFirst > 0 ? sorted[iFirst - 1] : null;
    if (num(last.cumValue) !== null && prevBar && num(prevBar.cumValue) !== null) {
      cumDiff = last.cumValue - prevBar.cumValue;
    }
    const value = num(cumDiff) !== null && cumDiff >= 0 ? cumDiff : volCloseValue;
    const basis = num(cumDiff) !== null && cumDiff >= 0 ? 'cum' : 'volclose';
    const open = num(first.o) !== null ? first.o : (num(first.c) || 0);
    const close = num(last.c) !== null ? last.c : open;
    const range = high > low ? high - low : 0;
    const body = Math.abs(close - open);
    const upper = range > 0 ? high - Math.max(open, close) : 0;
    const lower = range > 0 ? Math.min(open, close) - low : 0;
    const kind = body === 0 || (range > 0 && body / range <= HAM.dojiBodyRatio)
      ? 'doji'
      : close > open ? 'yang' : close < open ? 'eum' : 'flat';
    const startMin = toMin(key);
    const endMin = startMin + 2;
    out.push({
      key,
      from: key,
      to: hhmm(endMin),
      label: `${key.slice(0, 2)}:${key.slice(2)}~${hhmm(endMin).slice(0, 2)}:${hhmm(endMin).slice(2)}`,
      minutes: arr.length,
      complete: arr.length >= 3,
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
    });
  });
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * 구간 안에서 **가장 크게 터진 3분봉** — 햄버거의 연료통(기준/오늘).
 * @param {Array} bars 하루 1분봉(09:00~) — 직전 봉 차분을 위해 앞 구간도 함께 있어야 한다
 * @param {string} from 'HHMM'
 * @param {string} to 'HHMM'
 * @returns {{ok:boolean, bar:Object|null, valueEok:number|null, count:number, top3:Array, reason:string|null}}
 */
function maxThreeMinute(bars, from, to) {
  const list = bucket3m(bars, from, to).filter((b) => num(b.value) !== null && b.minutes > 0);
  if (!list.length) return { ok: false, bar: null, valueEok: null, count: 0, top3: [], reason: 'no_3m' };
  const ranked = list.slice().sort((a, b) => (b.value - a.value));
  const top = ranked[0];
  const sum = list.reduce((s, b) => s + (num(b.value) || 0), 0);
  return {
    ok: true,
    bar: top,
    label: top.label,
    from: top.from,
    value: top.value,
    valueEok: top.valueEok,
    minutes: top.minutes,
    count: list.length,             // 그 구간의 3분봉 개수
    sumValueEok: eok(sum),          // 구간 3분봉 대금 합(참고)
    firstLabel: list[0].label,
    lastLabel: list[list.length - 1].label,
    top3: ranked.slice(0, 3).map((b) => ({ label: b.label, valueEok: b.valueEok, minutes: b.minutes })),
    reason: null,
  };
}

/**
 * 그날 1분봉을 09:15 이전까지 페이지로 이어 붙인다.
 *  · KIS FHKST03010230 은 FID_INPUT_HOUR_1 **직전** 1분봉 120개를 준다 → 첫 봉 시각으로 계속 거슬러 올라간다.
 *  · from(기본 09:14)에 닿으면 멈춘다 — 09:15 버킷의 직전 봉(09:14)이 있어야 대금 차분이 맞는다.
 * @param {string} code 6자리
 * @param {string} ymd YYYYMMDD
 * @param {{from?:string,to?:string,hour?:string,marketDiv?:string,noCache?:boolean,maxPages?:number}} [opts]
 */
async function fetchMinuteWindow(code, ymd, opts = {}) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return { ok: false, code: c, bars: [], reason: 'bad_code' };
  const date = String(ymd || '').trim();
  if (!/^\d{8}$/.test(date)) return { ok: false, code: c, bars: [], reason: 'bad_date' };
  const from = /^\d{4}$/.test(String(opts.from || '')) ? String(opts.from) : '0914';
  const to = /^\d{4}$/.test(String(opts.to || '')) ? String(opts.to) : HAM.maxTo;
  const marketDiv = opts.marketDiv || 'J';
  const maxPages = Math.max(1, Math.min(12, Number(opts.maxPages) || HAM.minutePages));
  const map = new Map();
  /* hour 는 그 시각 **직전** 봉까지 돌려주므로, 구간 끝(to)을 포함하려면 1분 뒤를 넘긴다 */
  const toMinute = toMin(to);
  const startHour = /^\d{6}$/.test(String(opts.hour || '')) ? String(opts.hour) : (toMinute === null ? to : hhmm(toMinute + 1)) ;
  let hour = startHour + '00';
  let pages = 0;
  let retries = 0;
  let complete = false;
  let reason = null;
  while (pages < maxPages) {
    pages += 1;
    let r = null;
    /* 한 페이지가 초당 제한(EGW00201)·빈 응답으로 비면 **그 페이지를 다시 찌른다**.
       재시도까지 실패하면 부분 구간으로 최대값을 만들지 않는다(틀린 숫자보다 '미수신'이 낫다). */
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        r = await kis.fetchMinuteBarsForDate(c, date, { hour, marketDiv, noCache: opts.noCache || attempt > 1 });
      } catch (e) {
        r = { ok: false, bars: [], reason: String((e && e.message) || e) };
      }
      if (r && r.ok && Array.isArray(r.bars) && r.bars.length) break;
      reason = (r && (r.reason || r.message)) || 'empty';
      if (attempt === 1) { retries += 1; await sleep(240); }
    }
    if (!r || !r.ok || !Array.isArray(r.bars) || !r.bars.length) break;
    const rawLen = r.bars.length;
    let earliest = null;
    let added = 0;
    r.bars.forEach((b) => {
      if (!b || !/^\d{4}$/.test(String(b.t))) return;
      if (!earliest || b.t < earliest) earliest = b.t;
      if (!map.has(b.t)) { map.set(b.t, b); added += 1; }
    });
    if (!earliest) break;
    /* 완전한 구간의 증거 — ① from(기본 09:14)까지 닿았거나 ② 한 페이지가 120봉 미만(=그날 첫 봉까지 왔다) */
    if (earliest <= from || rawLen < 120) { complete = true; break; }
    if (!added) break;
    hour = earliest + '00';
  }
  const bars = Array.from(map.values()).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return {
    ok: bars.length > 0 && complete,
    code: c,
    date,
    marketDiv,
    bars,
    count: bars.length,
    pages,
    retries,
    complete,
    partial: bars.length > 0 && !complete,
    first: bars.length ? bars[0].t : null,
    last: bars.length ? bars[bars.length - 1].t : null,
    from,
    to,
    reason: bars.length && complete ? null : (reason || (complete ? null : 'incomplete')),
    at: new Date().toISOString(),
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 4500) : null;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': NAVER_UA, Accept: 'text/xml,*/*' }, cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      if (!r.ok) throw new Error('HTTP ' + r.status);
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
      if (!bars.length) throw new Error('empty');
      const value = { ok: true, code: c, bars, count: bars.length, source: 'naver-fchart-day(정규장)', at: new Date().toISOString() };
      if (NAVER_MEM.size >= NAVER_MEM_MAX) NAVER_MEM.delete(NAVER_MEM.keys().next().value);
      NAVER_MEM.set(c, { at: Date.now(), value });
      return value;
    } catch (e) {
      if (attempt === 1) return { ok: false, code: c, bars: [], reason: String((e && e.message) || e) };
      await new Promise((resolve) => setTimeout(resolve, 220));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { ok: false, code: c, bars: [], reason: 'fetch_failed' };
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
/* 과거 장대양봉 날 — 윗꼬리가 짧은 꽉 찬 양봉만                        */
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
const todayMem = new Map();         // `${code}:${date}:v4` → {at, value}
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
    /* 2026-11-28 v4 — 옛 규칙(v3: 09:00~09:02 첫 3분봉)으로 만든 번들은 읽지 않는다 */
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
/* 기준(과거 장대양봉 + 그날 09:15 이후 최대 3분봉 대금)                */
/* ---------------------------------------------------------------- */
/** 기준봉 한 날의 최대 3분봉 — 실패하면 사유를 남긴다 */
async function baseMaxOfDay(code, day) {
  let win = null;
  try {
    win = await fetchMinuteWindow(code, day.date, {});
  } catch (e) {
    win = { ok: false, bars: [], reason: String((e && e.message) || e) };
  }
  /* 초당 제한·일시 빈 응답이면 한 번은 다시 찌른다 — 못 받은 날을 '기준 없음'으로 잘못 단정하지 않게 */
  if (!win || !win.ok) {
    await sleep(260);
    try {
      win = await fetchMinuteWindow(code, day.date, { noCache: true });
    } catch (e) {
      win = { ok: false, bars: [], reason: String((e && e.message) || e) };
    }
  }
  if (!win || !win.ok) {
    return { ok: false, why: '분봉 미수신' + (win && win.reason ? '(' + String(win.reason).slice(0, 60) + ')' : ''), win };
  }
  const mx = maxThreeMinute(win.bars, HAM.maxFrom, HAM.maxTo);
  if (!mx.ok) return { ok: false, why: '3분봉 없음', win, max: mx };
  return { ok: true, max: mx, win };
}

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

  /* noCache = '지금 다시 계산' — 메모리·번들·공용 행을 모두 건너뛰고 실측으로 다시 만든다(진단용) */
  if (!opts.noCache) {
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
  }
  /* 화면 폴링은 캐시만 본다 — 즉석 계산은 요청당 정해진 종목 수만(API 레이어가 정한다) */
  if (opts.cacheOnly) {
    return { ok: false, code: c, reason: 'not_computed', message: '기준 대금 미계산 (일봉·과거 분봉 조회 전)' };
  }

  /* 계산 — ① 일봉(네이버 정규장 + KIS 대금) ② 윗꼬리 짧은 장대양봉 날 ③ 그날 09:15 이후 최대 3분봉 */
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
    ohlcSrc: (naverDaily && naverDaily.ok) ? 'naver-fchart(정규장)+KIS대금' : 'KIS 일봉(교차 실패 — NXT 시간외가 섞일 수 있음)',
    naverFailed: !(naverDaily && naverDaily.ok),
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
    /* '장대양봉 없음'도 결과다 — 매 폴링마다 일봉을 다시 받지 않게 6시간 캐싱한다.
       단 네이버 교차에 실패한 판단은 공용 캐시에 올리지 않는다(다음 요청에서 다시 본다) */
    baseMem.set(c, { at: Date.now(), value });
    if (!value.naverFailed) sbWriteRow(c, value);
    return value;
  }

  /* 기준봉 후보 = 가장 최근 윗꼬리 짧은 장대양봉 1일(v3). 그날 09:15 이후 **최대 3분봉** 대금이
     20억 미만이면 과거 날로 거슬러 올라가지 않고 기준 미달로 끝낸다(maxBaseTries: 1). */
  const skippedBases = [];
  let chosen = null;
  let baseMax = null;
  let minuteCount = 0;
  let minutePages = 0;
  const tries = scan.days.slice(0, HAM.maxBaseTries);
  for (let i = 0; i < tries.length; i += 1) {
    const day = tries[i];
    // eslint-disable-next-line no-await-in-loop
    const got = await baseMaxOfDay(c, day);
    minuteCount = (got && got.win && got.win.count) || 0;
    minutePages = (got && got.win && got.win.pages) || 0;
    if (!got || !got.ok) {
      skippedBases.push({ date: day.date, dateLabel: day.dateLabel, why: got ? got.why : '분봉 미수신' });
      continue;
    }
    const mx = got.max;
    if (num(mx.value) === null || mx.value < HAM.minBase3mEok * 1e8) {
      skippedBases.push({
        date: day.date,
        dateLabel: day.dateLabel,
        why: `기준 최대 3분봉 ${mx.label} ${mx.valueEok}억 < ${HAM.minBase3mEok}억`,
        open3mEok: mx.valueEok,
        max3mEok: mx.valueEok,
        max3mLabel: mx.label,
      });
      continue;
    }
    chosen = day;
    baseMax = mx;
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
      message: skippedBases.some((s) => s.open3mEok !== undefined)
        ? `가장 최근 윗꼬리 짧은 장대양봉 ${skippedBases[0].dateLabel}의 09:15 이후 최대 3분봉(${skippedBases[0].max3mLabel || ''}) 대금이 ${skippedBases[0].open3mEok}억으로 ${HAM.minBase3mEok}억에 못 미칩니다 — 과거 날로 거슬러 올라가지 않고 기준 미달로 제외합니다`
        : `가장 최근 윗꼬리 짧은 장대양봉 ${tries.length ? tries[0].dateLabel : ''}의 09:15 이후 분봉을 받지 못했습니다`,
      skippedBases,
      daily: merged.slice(-3).map((b) => ({ d: b.d, c: b.c, value: b.value })),
      source: '네이버 일봉(정규장) + KIS FHKST03010100(대금) + FHKST03010230(과거 분봉)',
    }, scanMeta);
    baseMem.set(c, { at: Date.now(), value });
    if (!value.naverFailed) sbWriteRow(c, value);
    return value;
  }

  const value = Object.assign({
    ok: true,
    code: c,
    asOfDate: today,
    rulesV: HAM.rulesVersion,
    computedAt: new Date().toISOString(),
    bigYang: Object.assign({}, chosen, {
      open3m: baseMax.bar,      // 하위호환 이름 — 실제 값은 '09:15 이후 최대 3분봉'
      base3m: baseMax.bar,
      max3m: {
        window: `${HAM.maxFrom.slice(0, 2)}:${HAM.maxFrom.slice(2)}~${HAM.maxTo.slice(0, 2)}:${HAM.maxTo.slice(2)}`,
        label: baseMax.label,
        valueEok: baseMax.valueEok,
        count: baseMax.count,
        top3: baseMax.top3,
        sumValueEok: baseMax.sumValueEok,
        minutes: baseMax.minutes,
      },
    }),
    others: scan.days.filter((d) => d.date !== chosen.date).slice(0, HAM.maxBigYang - 1),
    skippedBases,
    reversal: reversalOf(merged),
    minuteBars: minuteCount,
    minutePages,
    reason: null,
    message: null,
    daily: merged.slice(-3).map((b) => ({ d: b.d, c: b.c, value: b.value })),
    source: '네이버 일봉(정규장) + KIS FHKST03010100(대금) + FHKST03010230(과거 분봉 09:15~15:20)',
  }, scanMeta);
  baseMem.set(c, { at: Date.now(), value });
  if (!value.naverFailed) sbWriteRow(c, value);
  return value;
}

/* ---------------------------------------------------------------- */
/* 오늘 09:15 이후 최대 3분봉                                          */
/* ---------------------------------------------------------------- */
/** 오늘 비교 창의 끝 — 마지막으로 **완성된** 3분봉의 끝 분(장중 흔들림·캐시 낭비를 줄인다) */
function lastCompleteBucketEnd(nowMinutes) {
  const start = HAM.maxFrom ? (Number(HAM.maxFrom.slice(0, 2)) * 60 + Number(HAM.maxFrom.slice(2))) : 9 * 60 + 15;
  if (nowMinutes < start) return null;
  const end = Math.floor((nowMinutes - start) / 3) * 3 + start - 1;
  return end < start ? null : end;
}

/**
 * @param {string} code
 * @param {{noCache?:boolean, noFallback?:boolean, noRetry?:boolean}} [opts]
 * @returns {Promise<Object>} {ok, date, market, open3m(최대 3분봉), max3m, window, reason, message}
 */
async function getTodayOpen(code, opts = {}) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return { ok: false, code: c, reason: 'bad_code' };
  const now = kstNow();
  const date = now.ymd;
  const key = `${c}:${date}:v4`;
  const weekend = now.wd === 0 || now.wd === 6;
  const closeMin = Number(HAM.maxTo.slice(0, 2)) * 60 + Number(HAM.maxTo.slice(2));   // 15:20
  const openMin = Number(HAM.maxFrom.slice(0, 2)) * 60 + Number(HAM.maxFrom.slice(2)); // 09:15
  const windowDone = weekend || now.minutes > closeMin + 1;
  const hit = todayMem.get(key);
  const ttl = windowDone ? 6 * 3600 * 1000 : HAM.todayTtlMs;
  if (!opts.noCache && hit && Date.now() - hit.at < ttl) return hit.value;

  /* 09:15 이전·휴장일 — 오늘 비교 창이 아직/아예 없다. 직전 거래일의 같은 창(09:15 이후 최대 3분봉)을
     '직전 거래일' 라벨로 보여 준다(값을 지어내지 않는다). */
  const hasWindow = !weekend && now.minutes >= openMin;
  if (!hasWindow) {
    if (!opts.noFallback) {
      const fb = await prevSessionMax(c, date);
      if (fb) {
        todayLastGood.set(key, fb);
        return fb;
      }
    }
    const value = {
      ok: false,
      code: c,
      date,
      dateLabel: mmdd(date),
      market: 'J',
      marketLabel: '정규장',
      open3m: null,
      max3m: null,
      window: { from: `${HAM.maxFrom.slice(0, 2)}:${HAM.maxFrom.slice(2)}` },
      bars: 0,
      watch: !weekend && now.minutes >= HAM.watchFrom && now.minutes < HAM.watchTo,
      reason: weekend ? 'holiday' : 'before_window',
      message: weekend ? '휴장일 — 09:15 이후 3분봉이 없습니다' : '09:15 이전 — 비교 창(09:15~)이 아직 열리지 않았습니다',
      at: new Date().toISOString(),
    };
    return value;
  }

  const completeEnd = lastCompleteBucketEnd(Math.min(now.minutes, closeMin));
  const endMin = Math.max(openMin, Math.min(completeEnd === null ? now.minutes : completeEnd, closeMin));
  const toHour = hhmm(Math.min(endMin + 1, closeMin + 1));
  let win = null;
  try {
    win = await fetchMinuteWindow(c, date, { to: toHour, from: '0914' });
  } catch (e) {
    win = { ok: false, bars: [], reason: String((e && e.message) || e) };
  }
  let mx = win && win.ok ? maxThreeMinute(win.bars, HAM.maxFrom, hhmm(endMin)) : null;
  if ((!mx || !mx.ok) && !opts.noRetry && now.minutes >= openMin + 3) {
    const again = await getTodayOpen(c, { noCache: true, noRetry: true });
    if (again && again.ok) return again;
  }
  const value = {
    ok: Boolean(mx && mx.ok),
    code: c,
    date,
    dateLabel: mmdd(date),
    market: 'J',
    marketLabel: '정규장',
    open3m: mx && mx.ok ? mx.bar : null,
    max3m: mx && mx.ok ? {
      window: `${HAM.maxFrom.slice(0, 2)}:${HAM.maxFrom.slice(2)}~${hhmm(endMin).slice(0, 2)}:${hhmm(endMin).slice(2)}`,
      label: mx.label,
      valueEok: mx.valueEok,
      count: mx.count,
      top3: mx.top3,
      minutes: mx.minutes,
    } : null,
    window: { from: `${HAM.maxFrom.slice(0, 2)}:${HAM.maxFrom.slice(2)}`, to: hhmm(endMin) },
    bars: win ? win.count : 0,
    pages: win ? win.pages : 0,
    watch: now.minutes >= HAM.watchFrom && now.minutes < HAM.watchTo,
    fallback: false,
    reason: mx && mx.ok ? null : ((win && win.reason) || 'no_3m'),
    message: mx && mx.ok ? null : '오늘 09:15 이후 3분봉이 아직 없습니다',
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

/**
 * 직전 거래일의 09:15 이후 최대 3분봉 — 휴장일·장초반(09:15 이전) 대체값(최대 3거래일 거슬러).
 *  marketLabel 이 '직전 거래일'이므로 화면은 오늘 값과 구분해 적는다(추정 금지).
 */
async function prevSessionMax(code, fromYmd) {
  let ymd = prevWeekdayYmd(fromYmd);
  for (let i = 0; i < 3 && ymd; i += 1) {
    let win = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      win = await fetchMinuteWindow(code, ymd, {});
    } catch (e) {
      win = null;
    }
    const mx = win && win.ok ? maxThreeMinute(win.bars, HAM.maxFrom, HAM.maxTo) : null;
    if (mx && mx.ok) {
      return {
        ok: true,
        code,
        date: ymd,
        dateLabel: mmdd(ymd),
        market: 'J',
        marketLabel: '직전 거래일',
        fallback: true,
        open3m: mx.bar,
        max3m: {
          window: `${HAM.maxFrom.slice(0, 2)}:${HAM.maxFrom.slice(2)}~${HAM.maxTo.slice(0, 2)}:${HAM.maxTo.slice(2)}`,
          label: mx.label,
          valueEok: mx.valueEok,
          count: mx.count,
          top3: mx.top3,
          minutes: mx.minutes,
        },
        window: { from: `${HAM.maxFrom.slice(0, 2)}:${HAM.maxFrom.slice(2)}`, to: `${HAM.maxTo.slice(0, 2)}:${HAM.maxTo.slice(2)}` },
        bars: win.count,
        pages: win.pages,
        watch: false,
        reason: null,
        message: null,
        at: new Date().toISOString(),
      };
    }
    ymd = prevWeekdayYmd(ymd);
  }
  return null;
}

/** 하위호환 이름 — v3 의 prevSessionOpen(09:00~09:02)을 대신해 같은 창(09:15 이후 최대)을 돌려준다 */
async function prevSessionOpen(code, fromYmd) {
  return prevSessionMax(code, fromYmd);
}

/* ---------------------------------------------------------------- */
/* 3분봉 5선 · 20선 (오늘 1분봉 → 3분봉 평균)                          */
/* ---------------------------------------------------------------- */
/**
 * 3분봉 5선(눌림 타점 기준)과 20선(참고) — 오늘 1분봉으로 계산한다.
 * @returns {{ok:boolean, ok5:boolean, ma5:number|null, ma20:number|null, bars:number, at:string|null}}
 */
function threeMinMA20(minuteBars) {
  const bars = (Array.isArray(minuteBars) ? minuteBars : []).filter((b) => b && /^\d{4}$/.test(String(b.t)));
  if (bars.length < 15) return { ok: false, ok5: false, ma5: null, ma20: null, bars: 0, reason: '3분봉이 5개 미만' };
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
  const avg = (n) => {
    if (list.length < n) return null;
    const tail = list.slice(-n);
    return Math.round(tail.reduce((s, x) => s + x.c, 0) / tail.length);
  };
  const ma5 = avg(HAM.maFast);
  const ma20 = avg(HAM.maSlow);
  return {
    ok: ma20 !== null,
    ok5: ma5 !== null,
    ok20: ma20 !== null,
    ma5,
    ma20,
    bars: list.length,
    at: list.length ? list[list.length - 1].k : null,
    fast: HAM.maFast,
    slow: HAM.maSlow,
  };
}

/* ---------------------------------------------------------------- */
/* 타점 위치 — 낮은 구간 돌파 / 높은 구간 눌림                          */
/* ---------------------------------------------------------------- */
/**
 * 오늘 햄버거가 터진 위치가 과거 장대양봉 날('끼')에 비해 낮은지 높은지.
 *  · 낮은 구간 = 오늘 등락률 +10% 미만 **또는** 그날 장대양봉 등락률의 절반 이하 → 🚀 돌파 타점
 *  · 높은 구간 = 그 밖 → 🧲 눌림 타점(3분봉 5선)
 */
function positionOf(pctNow, basePct) {
  const p = num(pctNow);
  const b = num(basePct);
  const halfKki = b !== null && b > 0 ? round2(b / 2) : null;
  if (p === null) {
    return {
      kind: 'unknown',
      label: '등락률 미수신',
      low: null,
      pctNow: null,
      basePct: b,
      halfKkiPct: halfKki,
      why: '오늘 등락률을 받지 못해 자리를 판정하지 않습니다',
    };
  }
  const low = p < HAM.pctLow || (halfKki !== null && p <= halfKki);
  return {
    kind: low ? 'low' : 'high',
    label: low ? '🚀 낮은 구간 · 돌파 타점' : `🧲 높은 구간 · 눌림 타점(${HAM.maFast}선)`,
    short: low ? '🚀 낮은 구간 돌파' : '🧲 높은 구간 눌림',
    low,
    pctNow: p,
    basePct: b,
    halfKkiPct: halfKki,
    why: low
      ? `오늘 ${p}% — +${HAM.pctLow}% 미만이거나 그날 끼(${b === null ? '—' : b + '%'})의 절반(${halfKki === null ? '—' : halfKki + '%'}) 이하라 낮은 구간입니다`
      : `오늘 ${p}% — +${HAM.pctLow}% 이상이고 그날 끼(${b === null ? '—' : b + '%'})의 절반(${halfKki === null ? '—' : halfKki + '%'})을 넘어 높은 구간입니다`,
  };
}

/* ---------------------------------------------------------------- */
/* 판정 — 대금 대조 + 실패 패턴                                       */
/* ---------------------------------------------------------------- */
function judge(base, today, extra) {
  const o = extra || {};
  const now = kstNow();
  const out = {
    pass: false,
    passMultiple: null,
    tag: '기준 대기',
    tagKind: 'wait',
    reasons: [],
    blocks: [],
    shape: null,
    reversal: null,
    position: null,
    watch: null,
    windowLabel: `${HAM.maxFrom.slice(0, 2)}:${HAM.maxFrom.slice(2)} 이후 최대 3분봉`,
  };
  const by = base && base.bigYang ? base.bigYang : null;
  const baseEok = by && by.max3m ? num(by.max3m.valueEok) : (by && by.open3m ? num(by.open3m.valueEok) : null);
  const todayEok = today && today.max3m ? num(today.max3m.valueEok) : (today && today.open3m ? num(today.open3m.valueEok) : null);
  if (num(baseEok) !== null && num(todayEok) !== null && baseEok > 0) {
    out.passMultiple = round2(todayEok / baseEok);
    out.deltaEok = todayEok - baseEok;
  }
  out.baseEok = baseEok;
  out.todayEok = todayEok;
  /* 09:00~09:29 — 후보는 보여 주되 매매 판단은 09:30 이후(원전: 30분을 지켜본 뒤) */
  if (!(today && today.fallback) && now.minutes >= HAM.watchFrom && now.minutes < HAM.watchTo) {
    out.watch = '⏳ 09:30 이전 관망';
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
    out.reasons.push(today && today.message ? today.message : '오늘 09:15 이후 3분봉 미수신');
    out.tag = today && today.reason === 'before_window' ? '09:15 창 대기' : '오늘 3분봉 미수신';
    out.tagKind = 'wait';
    return out;
  }

  const shape = today.open3m;
  out.shape = shape ? {
    kind: shape.kind,
    bodyPct: shape.bodyPct,
    upperPct: shape.upperPct,
    pct: shape.pct,
    label: shape.label,
    minutes: shape.minutes,
  } : null;
  /* 실패 패턴 — 긴 위꼬리 · 도지 · 음봉 · 역배열 (오늘 최대 3분봉의 모양) */
  if (shape) {
    if (shape.kind === 'eum') out.blocks.push('음봉(3분봉 종가 < 시가)');
    if (shape.kind === 'doji') out.blocks.push('도지(몸통 없음)');
    if (num(shape.upperPct) !== null && shape.upperPct >= HAM.upperWickRatio * 100 && num(shape.bodyPct) !== null && shape.bodyPct < 50) {
      out.blocks.push('긴 위꼬리(위꼬리 ' + shape.upperPct + '%)');
    }
  }
  if (o.reversal && o.reversal.reverse) out.blocks.push('일봉 역배열(' + o.reversal.label + ')');
  else if (base && base.reversal && base.reversal.reverse) out.blocks.push('일봉 역배열(' + base.reversal.label + ')');

  const bigEnough = num(todayEok) !== null && todayEok >= baseEok;
  const overMin = num(todayEok) !== null && todayEok >= HAM.min3mValueEok;
  if (!overMin) out.blocks.push('대금 ' + HAM.min3mValueEok + '억 미만');
  if (!bigEnough) out.reasons.push('오늘 최대 ' + todayEok + '억 < 기준 최대 ' + baseEok + '억 (' + out.passMultiple + '배)');

  /* 타점 위치 — 성립/미성립과 무관하게 함께 적는다(낮은 구간 돌파 / 높은 구간 눌림) */
  const pctNow = num(o.pctNow);
  out.position = positionOf(pctNow, by ? by.pct : null);
  out.pctNow = pctNow;

  /* 휴장·09:15 이전 대체값이 '기준일과 같은 날'이면 비교 자체가 무의미하다 — 성립으로 보지 않는다 */
  const sameAsBase = Boolean(today.fallback && by && by.date && today.date === by.date);

  out.pass = bigEnough && overMin && out.blocks.length === 0 && !sameAsBase;
  if (sameAsBase) {
    out.tag = '기준일과 같은 날';
    out.tagKind = 'wait';
    out.reasons.push('직전 거래일(' + (today.dateLabel || '') + ')이 기준일과 같아 오늘과 비교할 값이 없습니다 — 휴장·장전 참고용으로만 봅니다');
    return out;
  }
  if (out.pass) {
    const head = out.passMultiple !== null && out.passMultiple >= HAM.bigMultiple
      ? '🍔 강한 시동 ' + out.passMultiple + '배'
      : '🍔 기준 돌파 ' + out.passMultiple + '배';
    out.tag = head;
    out.tagKind = out.passMultiple !== null && out.passMultiple >= HAM.bigMultiple ? 'hot' : 'ok';
    out.reasons.push(
      '오늘 최대 3분봉 ' + (today.max3m && today.max3m.label ? today.max3m.label + ' ' : '') + todayEok + '억 ≥ 기준 최대 ' +
      (by && by.max3m && by.max3m.label ? by.max3m.label + ' ' : '') + baseEok + '억 (' + out.passMultiple + '배)',
    );
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

/** 팝업 한 종목용 종합 — 기준 + 오늘 최대 3분봉 + 판정 */
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
  const windowLabel = `${HAM.maxFrom.slice(0, 2)}:${HAM.maxFrom.slice(2)}~${HAM.maxTo.slice(0, 2)}:${HAM.maxTo.slice(2)}`;
  return {
    rulesVersion: HAM.rulesVersion,
    yangPct: HAM.yangPct,
    yangValueEok: HAM.yangValueEok,
    baseUpperWickPct: Math.round(HAM.baseUpperWickMax * 100),
    baseBodyPct: Math.round(HAM.baseBodyMin * 100),
    minBase3mEok: HAM.minBase3mEok,
    baseDaysChecked: HAM.maxBaseTries,   // 기준봉 후보로 실제 분봉을 확인하는 일수(1 = 가장 최근 1일만)
    lookbackDays: HAM.lookbackDays,
    openWindow: `${windowLabel} (최대 3분봉)`,
    maxWindow: windowLabel,
    maxWindowFrom: '09:15',
    maxWindowTo: '15:20',
    open3mWindow: '09:00~09:02 (1분봉·진단용, 기준에서 제외)',
    nxtWindow: '08:00~08:02',
    bigMultiple: HAM.bigMultiple,
    pctLow: HAM.pctLow,
    maFast: HAM.maFast,
    watchLabel: '⏳ 09:30 이전 관망',
    ohlcSource: '네이버 일봉(정규장) + KIS 대금',
    blocks: '긴 위꼬리 · 도지 · 음봉 · 역배열',
    baseRule: `최근 ${HAM.lookbackDays}거래일 중 가장 최근 장대양봉(+${HAM.yangPct}%↑·대금 ${HAM.yangValueEok}억↑·양봉·몸통 ${Math.round(HAM.baseBodyMin * 100)}%↑·윗꼬리 ${Math.round(HAM.baseUpperWickMax * 100)}%↓) 1일만 보고, 그날 ${windowLabel} 3분봉 중 **최대 거래대금**이 ${HAM.minBase3mEok}억↑일 때만 기준으로 인정(미달이면 과거 날로 넘어가지 않고 제외)`,
    todayRule: `오늘 ${windowLabel}(장중이면 현재까지) 3분봉 중 최대 거래대금 ≥ 기준 최대 3분봉`,
    positionRule: `낮은 구간(+${HAM.pctLow}% 미만 또는 그날 장대양봉 등락률의 절반 이하) 🚀 돌파 타점 · 높은 구간 🧲 눌림 타점(3분봉 ${HAM.maFast}선)`,
    watchRule: '09:00~09:29 는 후보만 보여 주고 ⏳ 09:30 이전 관망 배지 — 매매 판단은 09:30 이후',
    showRule: '성립 종목만 표시 — 기준 미달·실패 패턴은 목록에서 뺀다',
  };
}

module.exports = {
  HAM,
  threeMinute,
  bucket3m,
  maxThreeMinute,
  fetchMinuteWindow,
  findBigYangDays,
  bigYangScan,
  mergeDaily,
  fetchNaverDaily,
  getBase,
  baseMaxOfDay,
  getTodayOpen,
  getTodayMax3m: getTodayOpen,
  threeMinMA20,
  positionOf,
  prevSessionMax,
  prevSessionOpen,
  prevWeekdayYmd,
  reversalOf,
  judge,
  inspect,
  publicRules,
  mmdd,
  hhmm,
};
