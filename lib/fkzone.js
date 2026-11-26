'use strict';

/**
 * 📐 F존 · K존 파동 계산 — 2026-11-26 신설
 *
 *  원전: 사용자 보유 자료 「3강 F존, 38스윙」 (1~8쪽)
 *   · F존 = 당일 강하게 오른 종목이 고점에서 눌릴 때 받아내는 구간.
 *       B1 = 당일 고가(H0) 대비 -8% · B2 = -10% · B3 = -12%
 *   · F존 진입(1분봉 저가 ≤ B1) 뒤 찍은 '실제 최저점(L)' 대비 +4% 반등이 나오면
 *     반등 파동 인정 → 그 뒤 새 최고점(H1) 대비 -8/-10/-12% = K존.
 *   · 손절 기준 2가지
 *       ① F존 진입 후 저점 이탈  → B3(=-12%) 아래로 밀리면 존 자체가 깨진다.
 *       ② 반등(또는 K존) 뒤 저점(L) 이탈 → 반등 파동 무효.
 *
 *  계산은 1분봉만 쓴다. 봉은 시간 오름차순이어야 한다.
 *  같은 파일에서 네이버 1분봉 조회(fetchMinuteBars)까지 맡는다 — 화면과 서버가
 *  같은 함수로 계산하도록 계산기와 데이터 소스를 한 곳에 둔다.
 *  값을 '만들지' 않는다 — 봉이 없거나 고가가 0이면 null 을 돌려주고 화면은 계산표만 보여준다.
 */

const FK = {
  b1: 0.92,   // -8%
  b2: 0.90,   // -10%
  b3: 0.88,   // -12%
  rebound: 1.04, // 저점 대비 +4%
};

function n(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** 봉 배열 정규화 — {t, open, high, low, close, vol} (네이버 분봉 응답도 그대로 받는다) */
function normBars(raw) {
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((b) => {
    if (!b) return;
    const high = n(b.high !== undefined ? b.high : b.h);
    const low = n(b.low !== undefined ? b.low : b.l);
    const close = n(b.close !== undefined ? b.close : b.c);
    const open = n(b.open !== undefined ? b.open : b.o);
    if (high === null || low === null || close === null) return;
    out.push({
      t: String(b.t || b.date || b.localDateTime || ''),
      open: open === null ? close : open,
      high,
      low,
      close,
      vol: n(b.vol !== undefined ? b.vol : b.v) || 0,
    });
  });
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out;
}

function r(v) {
  return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null;
}

/**
 * @param {Array} rawBars 당일(또는 거래일) 1분봉 — 시간 오름차순
 * @param {Object} [opts] { hhmm: (t)=>'HH:MM' }
 * @returns {null|Object}
 */
function computeFkZone(rawBars, opts) {
  const o = opts || {};
  const bars = normBars(rawBars);
  if (!bars.length) return null;

  const hhmm = typeof o.hhmm === 'function' ? o.hhmm : (t) => {
    const s = String(t);
    return s.length >= 4 ? s.slice(-4, -2) + ':' + s.slice(-2) : s;
  };

  /* 당일 고가(H0) — 봉 고가의 최댓값. 09:00 첫 봉은 장전 체결을 포함한다. */
  let h0 = -Infinity;
  let h0At = null;
  let h0Idx = -1;
  let dayLow = Infinity;
  let dayLowAt = null;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (b.high > h0) { h0 = b.high; h0At = b.t; h0Idx = i; }
    if (b.low < dayLow) { dayLow = b.low; dayLowAt = b.t; }
  }
  if (!(h0 > 0)) return null;

  const b1 = h0 * FK.b1;
  const b2 = h0 * FK.b2;
  const b3 = h0 * FK.b3;

  /* F존 진입 — 당일 고가를 찍은 봉부터 본다.
     (고가가 09:37 에 서기 전의 저가로 '존 진입'을 잡으면, 오르기 전 바닥을 눌림으로
      착각한다. 존의 기준은 '그 고가'이므로 파동 시계도 그 봉에서 시작한다.) */
  let enterIdx = -1;
  for (let i = Math.max(0, h0Idx); i < bars.length; i += 1) {
    if (bars[i].low <= b1) { enterIdx = i; break; }
  }

  const out = {
    h0: r(h0),
    h0At: h0At ? hhmm(h0At) : null,
    b1: r(b1),
    b2: r(b2),
    b3: r(b3),
    dayLow: r(dayLow),
    dayLowAt: dayLowAt ? hhmm(dayLowAt) : null,
    last: r(bars[bars.length - 1].close),
    lastAt: hhmm(bars[bars.length - 1].t),
    bars: bars.length,
    touched: enterIdx >= 0,
    enterAt: enterIdx >= 0 ? hhmm(bars[enterIdx].t) : null,
    low: null,          // F존 진입 후 실제 최저점(L)
    lowAt: null,
    reboundPrice: null, // L × 1.04
    rebound: null,      // { at, price, from }
    k: null,            // { h1, h1At, b1, b2, b3, enteredAt }
    phase: 'wait',
    stateLabel: 'B1 대기',
    stopLine: null,
    stopLabel: null,
    stopHit: null,
  };

  if (enterIdx < 0) {
    out.phase = 'wait';
    out.stateLabel = 'B1 대기';
    out.reboundPrice = r(b1 * FK.rebound);
    out.stopLine = r(b3);
    out.stopLabel = 'B3(-12%) 존 이탈';
    return out;
  }

  /* F존 진입 후 — 최저점 L 갱신 → L×1.04 이상 고가가 나오면 반등 인정 */
  let low = bars[enterIdx].low;
  let lowAt = bars[enterIdx].t;
  let reboundIdx = -1;
  for (let i = enterIdx; i < bars.length; i += 1) {
    const b = bars[i];
    if (b.low < low) { low = b.low; lowAt = b.t; }
    if (b.high >= low * FK.rebound) { reboundIdx = i; break; }
  }

  out.low = r(low);
  out.lowAt = hhmm(lowAt);
  out.reboundPrice = r(low * FK.rebound);

  if (reboundIdx < 0) {
    out.phase = 'f';
    out.stateLabel = low < b3 ? '존 이탈(B3 하회)' : 'F존 진입';
    out.stopLine = r(b3);
    out.stopLabel = 'B3(-12%) 존 이탈';
    out.stopHit = low < b3 ? { kind: 'zone', at: out.dayLowAt } : null;
    return out;
  }

  const reboundBar = bars[reboundIdx];
  out.rebound = {
    at: hhmm(reboundBar.t),
    price: r(low * FK.rebound),
    from: r(low),
    barHigh: r(reboundBar.high),
  };

  /* 반등 이후 새 고점(H1) → K존 */
  let h1 = -Infinity;
  let h1At = null;
  let kEnterIdx = -1;
  let brokeLow = null;
  const kB1 = () => h1 * FK.b1;
  for (let i = reboundIdx; i < bars.length; i += 1) {
    const b = bars[i];
    if (b.high > h1) { h1 = b.high; h1At = b.t; }
    /* 저점 이탈 — 반등의 기준이 된 L 아래로 내려가면 반등 파동 무효 */
    if (b.low < low) { brokeLow = b.t; break; }
    /* K존 진입 — 새 고점 대비 -8%까지 눌림 (고점이 먼저 서야 한다) */
    if (kEnterIdx < 0 && h1 > low && b.low <= kB1()) kEnterIdx = i;
  }

  out.k = {
    h1: r(h1),
    h1At: h1At ? hhmm(h1At) : null,
    b1: r(h1 * FK.b1),
    b2: r(h1 * FK.b2),
    b3: r(h1 * FK.b3),
    entered: kEnterIdx >= 0,
    enteredAt: kEnterIdx >= 0 ? hhmm(bars[kEnterIdx].t) : null,
    lowBroken: Boolean(brokeLow),
    lowBrokenAt: brokeLow ? hhmm(brokeLow) : null,
  };

  out.stopLine = r(low);           // 반등 이후 손절선 = 반등 기준 저점(L)
  out.stopLabel = '저점 이탈(L) · ' + (out.low ? out.low.toLocaleString('ko-KR') + '원' : '—');

  if (brokeLow) {
    out.phase = 'stop';
    out.stateLabel = '손절 이탈(저점)';
    out.stopHit = { kind: 'low', at: out.k.lowBrokenAt };
    return out;
  }
  if (out.k.entered) {
    out.phase = 'k';
    out.stateLabel = 'K존 진입';
    out.stopLine = r(low);
    return out;
  }
  out.phase = 'rebound';
  out.stateLabel = '+4% 반등';
  return out;
}

/* ------------------------------------------------------------------
 * 분봉 조회 — 네이버 증권 1분봉 (한 번의 요청으로 당일 전장을 통째로 준다)
 *  · 한투(KIS) 분봉은 30봉씩 끊어 주고 호출 제한이 있어 차트용으로 쓰지 않는다.
 *  · 20초 메모리 캐시 — 모달을 여닫아도 같은 분봉을 다시 받지 않는다.
 * ------------------------------------------------------------------ */
const http = require('./http');
const MIN_URL = 'https://api.stock.naver.com/chart/domestic/item/';
const MIN_TTL_MS = 20 * 1000;
const minCache = new Map();

function num2(v) {
  const x = Number(v);
  return isFinite(x) ? x : null;
}

/** 당일 09:00~15:30 1분봉 — { ok, date, bars:[{t,o,h,l,c,v}], at } */
async function fetchMinuteBars(code, opts) {
  const o = opts || {};
  const key = String(code || '').trim();
  if (!/^(?:\d{6}|\d{4}[A-Z]\d)$/.test(key)) return { ok: false, reason: 'bad_code', bars: [] };
  const hit = minCache.get(key);
  if (!o.fresh && hit && Date.now() - hit.at < MIN_TTL_MS) return Object.assign({ cached: true }, hit.value);

  const d = await http.fetchJson(MIN_URL + encodeURIComponent(key) + '/minute', {
    headers: http.NAVER_HEADERS,
    timeout: 5000,
  });
  const arr = Array.isArray(d) ? d : [];
  const bars = [];
  let date = null;
  arr.forEach((b) => {
    if (!b) return;
    const dt = String(b.localDateTime || '');
    if (dt.length < 12) return;
    const hhmm = dt.slice(8, 12);
    if (hhmm < '0900' || hhmm > '1530') return;          // 정규장만 (시간외 제외)
    const high = num2(b.highPrice);
    const low = num2(b.lowPrice);
    const close = num2(b.currentPrice);
    const open = num2(b.openPrice);
    if (high === null || low === null || close === null) return;
    if (date === null) date = dt.slice(0, 8);
    bars.push({ t: hhmm, o: open === null ? close : open, h: high, l: low, c: close, v: num2(b.accumulatedTradingVolume) || 0 });
  });

  const value = { ok: bars.length > 0, date, bars, count: bars.length, at: new Date().toISOString() };
  if (bars.length) {
    minCache.set(key, { at: Date.now(), value });
    if (minCache.size > 60) {
      const oldest = minCache.keys().next();
      if (!oldest.done) minCache.delete(oldest.value);
    }
  }
  return value;
}

module.exports = { computeFkZone, normBars, fetchMinuteBars, FK };
