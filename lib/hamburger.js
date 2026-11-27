'use strict';

/**
 * 🍔 불개미 '햄버거' 장중매매 — 기준 대금 계산 (2026-11-27 신설)
 * ----------------------------------------------------------------------------
 *  원전: 부자회사원 채널 「불개미님 햄버거 기법」 2편 (AHSUB-eAxxA · 9EVBKc25TTI)
 *
 *  ① 과거 그 종목이 장대양봉을 냈던 날, **3분봉에서 시세를 시작시킨 거래대금**을
 *     '햄버거 기준 대금'으로 기억해 둔다.
 *  ② 오늘 그 종목이 속한 섹터가 주도 섹터로 살아 있고, **장초반 3분봉 대금이
 *     그 기준을 압도**하면 햄버거가 완성된 것으로 본다.
 *  ③ 대금이 터져도 **긴 위꼬리 · 도지 · 음봉 · 역배열** 자리는 상승 확률이 낮아 거른다.
 *  ④ 낮은 자리(+10% 미만)면 돌파, 높은 자리(+10% 이상)면 3분봉 20선 눌림으로 본다.
 *
 *  값은 실측만 쓴다 — 봉이 없으면 null 을 돌려주고 화면은 '미계산/미수신'으로 적는다.
 *  기준 대금 계산은 KIS 공식 API 두 개로만 한다.
 *    · 장대양봉 날 찾기  : 기간별시세 FHKST03010100 (일봉 100개 · 그날 거래대금 포함)
 *    · 그날 시동 3분봉   : 주식일별분봉조회 FHKST03010230 (09:00~09:02 1분봉 3개)
 */

const kis = require('./kis');

const HAM = {
  /* 과거 장대양봉 판정 — 사용자 확정 기준(2026-11-27): +10%↑ & 거래대금 300억↑ */
  yangPct: 10,
  yangValueEok: 300,
  lookbackDays: 120,        // 최근 120거래일(약 6개월)
  maxBigYang: 3,            // 팝업에 함께 적는 과거 장대양봉 날 수(최근 3일)
  openFrom: '0900',         // 장초반 3분봉 = 09:00~09:02
  openTo: '0902',
  nxtFrom: '0800',          // 장전에는 NXT 첫 3분봉 08:00~08:02
  nxtTo: '0802',
  bigMultiple: 2.0,         // 기준의 2배↑ = 강한 시동
  pctLow: 10,               // +10% 미만 = 돌파 / 이상 = 눌림
  upperWickRatio: 0.4,      // 3분봉 전체 범위의 40%↑가 위꼬리면 '긴 위꼬리'
  dojiBodyRatio: 0.1,       // 몸통이 전체 범위의 10% 이하면 도지
  min3mValueEok: 1,         // 대금이 1억 미만이면 '대금 없음'으로 본다
  tinyBaseEok: 5,           // 기준 3분봉이 5억 미만이면 '그날 장초반 체결이 적었다' — 배수 해석 주의(거르지 않는다)
  todayTtlMs: 30 * 1000,    // 오늘 장초반 값은 30초 캐시(09:02 이후 값은 변하지 않는다)
  baseTtlMs: 6 * 3600 * 1000,
  supabase: {
    url: process.env.SUPABASE_URL || 'https://hiruybkapzuhjrzjoyik.supabase.co',
    key: process.env.SUPABASE_ANON_KEY || 'sb_publishable_e5JJbvCPDhY91uXaUEVNVA_8Byv_gI8',
    table: 'family_sync',
    code: 'hamburger_base_v1',
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
/* 과거 장대양봉 날                                                   */
/* ---------------------------------------------------------------- */
function findBigYangDays(dailyBars, todayYmd) {
  const bars = (Array.isArray(dailyBars) ? dailyBars : []).filter((b) => b && b.d && num(b.c) !== null);
  const out = [];
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i];
    if (todayYmd && b.d >= todayYmd) continue;                    // 오늘 봉은 '이전'이 아니다
    if (bars.length - 1 - i > HAM.lookbackDays) continue;          // 최근 120거래일
    const prev = bars[i - 1];
    const pc = num(prev.c);
    if (pc === null || pc <= 0) continue;
    const pct = ((b.c - pc) / pc) * 100;
    const valueEok = eok(b.value);
    if (pct < HAM.yangPct) continue;
    if (valueEok === null || valueEok < HAM.yangValueEok) continue;
    out.push({
      date: b.d,
      dateLabel: mmdd(b.d),
      pct: round2(pct),
      close: round2(b.c),
      valueEok,
      bodyPct: num(b.o) !== null && b.c > b.o ? round2(((b.c - b.o) / b.o) * 100) : null,
    });
  }
  return out.reverse();   // 최근 → 과거
}

/* ---------------------------------------------------------------- */
/* 캐시 — ① 인스턴스 메모리 ② 저장소 JSON ③ Supabase 공용 행            */
/* ---------------------------------------------------------------- */
const baseMem = new Map();          // code → {at, value}
const todayMem = new Map();         // `${code}:${date}:${market}` → {at, value}
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
    BUNDLED = (doc && doc.rows) || {};
  } catch (e) {
    BUNDLED = {};
  }
  return BUNDLED;
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
  const hit = baseMem.get(c);
  if (!opts.noCache && hit && Date.now() - hit.at < HAM.baseTtlMs) return hit.value;

  const fromBundle = bundledRows()[c];
  if (fromBundle && fromBundle.code) {
    baseMem.set(c, { at: Date.now(), value: fromBundle });
    return fromBundle;
  }
  const fromSb = (await sbReadRows())[c];
  if (fromSb && fromSb.code) {
    baseMem.set(c, { at: Date.now(), value: fromSb });
    return fromSb;
  }
  /* 화면 폴링은 캐시만 본다 — 즉석 계산은 요청당 정해진 종목 수만(API 레이어가 정한다) */
  if (opts.cacheOnly) {
    return { ok: false, code: c, reason: 'not_computed', message: '기준 대금 미계산 (일봉·과거 분봉 조회 전)' };
  }

  /* 계산 — 일봉 100봉(1회) → 장대양봉 날 → 그날 09:00~09:02 3분봉(1회) */
  const today = kstNow().ymd;
  let daily = null;
  try {
    daily = await kis.fetchDailyHistory(c, { days: 100, endYmd: today });
  } catch (e) {
    return { ok: false, code: c, reason: 'daily_failed', message: String((e && e.message) || e) };
  }
  if (!daily || !daily.ok || !daily.bars.length) {
    return { ok: false, code: c, reason: 'no_daily', message: '일봉이 없습니다' };
  }
  const days = findBigYangDays(daily.bars, today);
  if (!days.length) {
    const value = {
      ok: false,
      code: c,
      reason: 'no_big_yang',
      message: `최근 ${HAM.lookbackDays}거래일 안에 +${HAM.yangPct}%↑ · 대금 ${HAM.yangValueEok}억↑ 장대양봉이 없습니다`,
      scanned: daily.bars.length,
      asOfDate: today,
      computedAt: new Date().toISOString(),
    };
    /* '장대양봉 없음'도 결과다 — 매 폴링마다 일봉을 다시 받지 않게 6시간 캐싱한다 */
    baseMem.set(c, { at: Date.now(), value });
    sbWriteRow(c, value);
    return value;
  }
  const main = days[0];
  let minute = null;
  try {
    minute = await kis.fetchMinuteBarsForDate(c, main.date, { hour: '090300' });
  } catch (e) {
    minute = { ok: false, bars: [], reason: String((e && e.message) || e) };
  }
  const open3m = minute && minute.ok ? threeMinute(minute.bars, HAM.openFrom, HAM.openTo) : null;
  const value = {
    ok: Boolean(open3m),
    code: c,
    asOfDate: today,
    computedAt: new Date().toISOString(),
    bigYang: Object.assign({}, main, { open3m }),
    others: days.slice(1, HAM.maxBigYang),
    reversal: reversalOf(daily.bars),
    tinyBase: eok(open3m ? open3m.value : 0) !== null && eok(open3m ? open3m.value : 0) < HAM.tinyBaseEok,
    minuteBars: minute ? minute.count : 0,
    reason: open3m ? null : (minute && minute.reason) || 'no_minute',
    message: open3m ? null : '그날 09:00~09:02 분봉을 받지 못했습니다',
    daily: daily.bars.slice(-3).map((b) => ({ d: b.d, c: b.c, value: b.value })),
    source: 'KIS FHKST03010100(일봉) + FHKST03010230(과거 분봉)',
  };
  if (value.ok) {
    baseMem.set(c, { at: Date.now(), value });
    sbWriteRow(c, value);
  }
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
  if (!opts.noCache && hit && Date.now() - hit.at < HAM.todayTtlMs) return hit.value;

  let got = null;
  try {
    got = await kis.fetchMinuteBarsForDate(c, date, { hour: win.hour, marketDiv: market });
  } catch (e) {
    got = { ok: false, bars: [], reason: String((e && e.message) || e) };
  }
  const open3m = got && got.ok ? threeMinute(got.bars, win.from, win.to) : null;
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
  if (value.ok) todayMem.set(key, { at: Date.now(), value });
  return value;
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
    out.tag = '기준 미계산';
    out.tagKind = 'wait';
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
  /* 기준이 5억 미만이면 '그날 장초반에 거래가 적었던 날' — 배수만 보고 넘기지 않게 경고만 붙인다(거르지 않는다) */
  if (out.tinyBase) {
    out.warn = '기준 3분봉이 ' + baseEok + '억(미미) — 그날 장초반 체결이 적었습니다. 배수 해석 주의';
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
  let daily = null;
  try {
    daily = await kis.fetchDailyHistory(c, { days: 100 });
  } catch (e) {
    daily = null;
  }
  const bars = daily && daily.ok ? daily.bars : [];
  const rev = reversalOf(bars);
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
    yangPct: HAM.yangPct,
    yangValueEok: HAM.yangValueEok,
    lookbackDays: HAM.lookbackDays,
    openWindow: '09:00~09:02',
    nxtWindow: '08:00~08:02',
    bigMultiple: HAM.bigMultiple,
    pctLow: HAM.pctLow,
    tinyBaseEok: HAM.tinyBaseEok,
    blocks: '긴 위꼬리 · 도지 · 음봉 · 역배열',
  };
}

module.exports = {
  HAM,
  threeMinute,
  findBigYangDays,
  getBase,
  getTodayOpen,
  threeMinMA20,
  reversalOf,
  judge,
  inspect,
  publicRules,
  mmdd,
};
