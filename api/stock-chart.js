'use strict';

/**
 * GET /api/stock-chart?q=삼성전자   또는   ?code=005930
 *  - 종목명 → 네이버 자동완성(ac.finance.naver.com)으로 종목코드 조회, 실패 시 네이버 증권 검색 API → 내장 별칭 순으로 대체
 *  - fchart.stock.naver.com 일봉(기본 60거래일) OHLCV 파싱
 *  - 현재가 기준 Round Number(RN) 지지/저항선 계산
 */

const {
  NAVER_HEADERS,
  fetchJson,
  fetchBuffer,
  decodeEucKr,
  parseNum,
  kstLabel,
  sendJson,
  getQuery,
} = require('../lib/http');

const CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';

// 자동완성/검색 API가 모두 막혔을 때를 위한 최소 별칭표 (관제탑 단골 종목)
const ALIAS = {
  삼성전자: '005930',
  'sk하이닉스': '000660',
  하이닉스: '000660',
  코리아써키트: '007810',
  지니언스: '263860',
  삼성전기: '009150',
  심텍: '222800',
  티엘비: '356860',
  네이버: '035420',
  naver: '035420',
  두산에너빌리티: '034020',
  hlb: '028300',
  사람인: '143240',
  펨트론: '168360',
  리노공업: '058470',
  삼성sdi: '006400',
  에코프로비엠: '247540',
  에코프로: '086520',
  알테오젠: '196170',
  셀트리온: '068270',
  현대차: '005380',
  기아: '000270',
  카카오: '035720',
  lg에너지솔루션: '373220',
  한미반도체: '042700',
  이수페타시스: '007660',
  삼양식품: '003230',
  컴투스: '078340',
  nhn: '181710',
  삼현: '437730',
  레인보우로보틱스: '277810',
  주성엔지니어링: '036930',
  피에스케이홀딩스: '031980',
  하나마이크론: '067310',
  jyp: '035900',
  에스엠: '041510',
  하이브: '352820',
};

/* KRX 종목코드 — 기존 6자리 숫자 + 신규상장 6자리 영숫자(예: 0147B0 · 0162D0).
 *  (11/23) 🆕 신규상장주 카드에서 누른 새 코드 종목의 일봉·차트가 열리도록 넓혔다. */
const CODE_RE = /^(?:\d{6}|\d{4}[A-Z]\d)$/;

/* ---------------------- 1) 종목명 → 종목코드 ---------------------- */

/** 네이버 자동완성 응답에서 (code, name) 후보를 최대한 관대하게 뽑아낸다. */
function parseAutocomplete(payload) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    const six = node.find((v) => typeof v === 'string' && CODE_RE.test(v));
    if (six) {
      const name = node.find((v, i) => i > 0 && typeof v === 'string' && !CODE_RE.test(v) && /[가-힣A-Za-z]/.test(v));
      const key = `${six}:${name || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ code: six, name: name || six, market: null });
      }
      return;
    }
    for (const child of node) walk(child);
  };
  walk(payload && payload.items);
  return out;
}

async function resolveByAutocomplete(name) {
  const url =
    'https://ac.finance.naver.com/ac?q=' +
    encodeURIComponent(name) +
    '&q_enc=utf-8&t_koreng=1&st=111&r_lt=111&r_format=json';
  const payload = await fetchJson(url, {
    headers: { ...NAVER_HEADERS, Referer: 'https://finance.naver.com/' },
    timeout: 2500,
  });
  return parseAutocomplete(payload);
}

async function resolveBySearchApi(name) {
  const url =
    'https://m.stock.naver.com/front-api/search?q=' +
    encodeURIComponent(name) +
    '&target=stock&size=20&page=1';
  const payload = await fetchJson(url, { headers: NAVER_HEADERS, timeout: 4000 });
  const items = (payload && payload.result && payload.result.items) || [];
  return items
    .filter((it) => it && CODE_RE.test(String(it.code)))
    .map((it) => ({ code: String(it.code), name: it.name || String(it.code), market: it.typeName || null }));
}

function pickBest(candidates, query) {
  if (!candidates.length) return null;
  const q = query.replace(/\s+/g, '').toLowerCase();
  const exact = candidates.find((c) => String(c.name).replace(/\s+/g, '').toLowerCase() === q);
  if (exact) return exact;
  const prefix = candidates.find((c) => String(c.name).replace(/\s+/g, '').toLowerCase().startsWith(q));
  return prefix || candidates[0];
}

async function resolveStock(query) {
  const trimmed = String(query || '').trim();
  if (CODE_RE.test(trimmed)) {
    return { code: trimmed, name: null, market: null, resolvedBy: 'code' };
  }
  const errors = [];

  // 자동완성과 검색 API를 동시에 시도한다(합계 지연시간 단축). 자동완성이 되면 그 결과를 우선.
  const [acR, searchR] = await Promise.allSettled([
    resolveByAutocomplete(trimmed),
    resolveBySearchApi(trimmed),
  ]);

  if (acR.status === 'fulfilled') {
    const best = pickBest(acR.value, trimmed);
    if (best) return { ...best, resolvedBy: 'naver-autocomplete' };
    errors.push('autocomplete: no match');
  } else {
    errors.push(`autocomplete: ${acR.reason && acR.reason.message}`);
  }

  if (searchR.status === 'fulfilled') {
    const best = pickBest(searchR.value, trimmed);
    if (best) return { ...best, resolvedBy: 'naver-search' };
    errors.push('search: no match');
  } else {
    errors.push(`search: ${searchR.reason && searchR.reason.message}`);
  }

  const alias = ALIAS[trimmed.toLowerCase()] || ALIAS[trimmed];
  if (alias) return { code: alias, name: trimmed, market: null, resolvedBy: 'alias-table' };

  return { code: null, name: trimmed, resolvedBy: null, errors };
}

/* ------------------------- 2) 일봉 OHLCV ------------------------- */
async function fetchCandles(code, count) {
  const url =
    `https://fchart.stock.naver.com/sise.nhn?symbol=${code}` +
    `&timeframe=day&count=${count}&requestType=0`;
  const buf = await fetchBuffer(url, {
    headers: { ...NAVER_HEADERS, Referer: 'https://finance.naver.com/' },
    timeout: 6000,
  });
  const xml = decodeEucKr(buf);
  const nameMatch = xml.match(/name="([^"]*)"/);
  const candles = [];
  const re = /<item data="([^"]+)"\s*\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const parts = m[1].split('|');
    if (parts.length < 6) continue;
    const [date, open, high, low, close, volume] = parts;
    candles.push({
      date,
      o: Number(open),
      h: Number(high),
      l: Number(low),
      c: Number(close),
      v: Number(volume),
    });
  }
  candles.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    name: nameMatch ? nameMatch[1] : null,
    candles,
    count: candles.length,
  };
}

/* ------------------- 3) 실시간 현재가 (polling) ------------------- */
async function fetchLivePrice(code) {
  const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`;
  const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: 3000 });
  const d = (data.datas || [])[0];
  if (!d) throw new Error('no realtime data');
  const sign = d.compareToPreviousPrice && d.compareToPreviousPrice.name;
  const change = parseNum(d.compareToPreviousClosePriceRaw) ?? parseNum(d.compareToPreviousClosePrice);
  const pct = parseNum(d.fluctuationsRatioRaw) ?? parseNum(d.fluctuationsRatio);
  return {
    name: d.stockName,
    market: (d.stockExchangeType && d.stockExchangeType.name) || null,
    price: parseNum(d.closePriceRaw) ?? parseNum(d.closePrice),
    open: parseNum(d.openPriceRaw) ?? parseNum(d.openPrice),
    high: parseNum(d.highPriceRaw) ?? parseNum(d.highPrice),
    low: parseNum(d.lowPriceRaw) ?? parseNum(d.lowPrice),
    change: sign === 'FALLING' ? -Math.abs(change) : change,
    changePct: sign === 'FALLING' ? -Math.abs(pct) : pct,
    volume: parseNum(d.accumulatedTradingVolumeRaw),
    marketStatus: d.marketStatus || null,
    tradedAt: d.localTradedAt || null,
    tradedAtKst: kstLabel(d.localTradedAt),
  };
}

/* --------------------------- 4) RN 존 계산 --------------------------- */
/*
 * 차트박사 공식 21개 라운드넘버(RN)선 — scripts/rescan_strategies.py 의 RN_LINES 와 같은 배열.
 *   붉은색(핵심): 500 · 1,000 · 5,000 · 10,000 · 50,000 · 100,000 · 500,000 · 1,000,000
 *   파란색(중간): 2,000 · 20,000 · 200,000
 *   옥색(보조)  : 1,500 · 3,000 · 7,500 · 15,000 · 30,000 · 75,000 · 150,000 · 300,000 · 750,000 · 1,500,000
 *  예전에는 가격대별 임의 라운딩(rn_step)으로 선을 만들어 공식선과 달랐다
 *  (예: 779,000원 → 700,000/800,000 으로 계산되어 실제 75만/100만선이 아니었다).
 */
const RN_LINES = [
  [500, 'red'], [1000, 'red'], [1500, 'teal'], [2000, 'blue'], [3000, 'teal'],
  [5000, 'red'], [7500, 'teal'], [10000, 'red'], [15000, 'teal'], [20000, 'blue'],
  [30000, 'teal'], [50000, 'red'], [75000, 'teal'], [100000, 'red'], [150000, 'teal'],
  [200000, 'blue'], [300000, 'teal'], [500000, 'red'], [750000, 'teal'],
  [1000000, 'red'], [1500000, 'teal'],
];
const RN_COLOR = { red: '#ef4444', blue: '#3b82f6', teal: '#14b8a6' };
const RN_COLOR_KO = { red: '붉은색', blue: '파란색', teal: '옥색' };

function rnStep(price) {
  // 참고용 구간 폭(밴드 계산에만 사용). 선 자체는 RN_LINES 공식 배열을 쓴다.
  const p = Math.abs(price);
  if (p >= 500000) return 100000;
  if (p >= 100000) return 50000;
  if (p >= 50000) return 10000;
  if (p >= 10000) return 5000;
  if (p >= 1000) return 1000;
  return 100;
}

function touchCount(candles, low, high) {
  let n = 0;
  for (const c of candles) {
    if (c.h >= low && c.l <= high) n += 1;
  }
  return n;
}

function rnTickRound(v) {
  const p = Math.abs(Number(v) || 0);
  let t = 1;
  if (p >= 2000) t = 5;
  if (p >= 5000) t = 10;
  if (p >= 20000) t = 50;
  if (p >= 50000) t = 100;
  if (p >= 200000) t = 500;
  if (p >= 500000) t = 1000;
  return Math.round(Number(v) / t) * t;
}

/* 공식 21선 사이가 너무 넓을 때(3→5 = +66.7%) 그 중간값을 '중간 보조' 눈금으로 준다.
   현대모비스 344,500원 → 300,000 / (중간 보조 400,000) / 500,000. 공식선이 아니므로
   타점 계산에는 쓰지 않고 표기·차트 보조선에만 쓴다(rescan_strategies.py rn_aux_level 과 동일 규칙). */
const AUX_MIN_GAP_PCT = 40.0;
function rnAuxLevel(lo, hi) {
  const lv = Number(lo) || 0;
  const uv = Number(hi) || 0;
  if (lv <= 0 || uv <= lv) return null;
  if ((uv / lv - 1) * 100 < AUX_MIN_GAP_PCT) return null;
  const v = rnTickRound((lv + uv) / 2);
  return v > lv && v < uv ? v : null;
}

function buildRnZones(price, candles, depth = 5) {
  const step = rnStep(price);
  const band = step * 0.1; // RN선 접촉 판정 폭(±10% of step) — 선 자체는 공식 배열
  const p = Number(price);
  let lowerIdx = 0;
  let upperIdx = RN_LINES.length - 1;
  for (let i = 0; i < RN_LINES.length; i += 1) {
    if (RN_LINES[i][0] <= p) lowerIdx = i;
    if (RN_LINES[i][0] >= p) { upperIdx = i; break; }
  }
  const pack = (i) => {
    const [level, col] = RN_LINES[i];
    return {
      level,
      color: RN_COLOR[col],
      colorKo: RN_COLOR_KO[col],
      zoneLow: level - band,
      zoneHigh: level + band,
      distancePct: Number((((level - p) / p) * 100).toFixed(2)),
      touches: touchCount(candles, level - band, level + band),
    };
  };
  // 아래로 depth개(현재가 이하), 위로 depth개(현재가 초과) 공식선
  const supports = [];
  for (let i = lowerIdx; i >= 0 && supports.length <= depth; i -= 1) supports.push(pack(i));
  const resistances = [];
  for (let i = (RN_LINES[upperIdx][0] > p ? upperIdx : upperIdx + 1); i < RN_LINES.length && resistances.length < depth; i += 1) {
    resistances.push(pack(i));
  }
  const nS = supports[0] || null;
  const nR = resistances[0] || null;
  const dLow = nS ? Math.abs(p - nS.level) / p * 100 : null;
  const dUp = nR ? Math.abs(nR.level - p) / p * 100 : null;
  let category = 'upper';
  if (nS && nR) {
    if (dUp !== null && dUp <= 0.5) category = 'touch_upper';
    else if (dLow !== null && dLow <= 1.0) category = 'touch_lower';
    else category = (dLow <= dUp) ? 'near_lower' : 'upper';
  }

  return {
    method: 'official-21-lines',
    step,
    band,
    pivot: nS ? nS.level : null,
    lowerRN: nS ? nS.level : null,
    upperRN: nR ? nR.level : null,
    auxRN: nS && nR ? rnAuxLevel(nS.level, nR.level) : null,
    lowerColor: nS ? nS.color : null,
    upperColor: nR ? nR.color : null,
    lowerColorKo: nS ? nS.colorKo : null,
    upperColorKo: nR ? nR.colorKo : null,
    category,
    supports,
    resistances,
    nearestSupport: nS,
    nearestResistance: nR,
  };
}

/* ------------------------------ handler ------------------------------ */
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end();
  }

  const q = getQuery(req);
  const query = (q.q || q.code || q.name || '').trim();
  const countParam = parseInt(q.count, 10);
  /* 20~260 — 260거래일이면 52주 위치 바(1초 체커)까지 한 번에 계산된다 */
  const count = Number.isFinite(countParam) ? Math.min(Math.max(countParam, 20), 260) : 60;

  if (!query) {
    return sendJson(
      res,
      400,
      { ok: false, reason: 'missing_query', message: '?q=종목명 또는 ?code=종목코드를 지정하세요.' },
      'no-store',
    );
  }

  const errors = [];
  let resolved;
  try {
    resolved = await resolveStock(query);
  } catch (e) {
    return sendJson(res, 500, { ok: false, reason: 'resolve_failed', message: e.message }, 'no-store');
  }
  if (!resolved.code && resolved.errors) errors.push(...resolved.errors);
  if (!resolved.code) {
    return sendJson(
      res,
      404,
      {
        ok: false,
        reason: 'not_found',
        message: `'${query}' 종목을 찾지 못했습니다. 종목명 또는 6자리 코드로 다시 시도하세요.`,
        errors,
      },
      'no-store',
    );
  }

  // 일봉과 실시간 현재가를 동시에 요청(함수 실행시간을 Vercel 10초 한도 안으로)
  const [chartR, liveR] = await Promise.allSettled([
    fetchCandles(resolved.code, count),
    fetchLivePrice(resolved.code),
  ]);

  let live = null;
  if (liveR.status === 'fulfilled') live = liveR.value;
  else errors.push(`live: ${liveR.reason && liveR.reason.message}`);

  if (chartR.status !== 'fulfilled') {
    const e = chartR.reason || {};
    return sendJson(
      res,
      502,
      {
        ok: false,
        reason: 'chart_fetch_failed',
        message: `차트 데이터를 받지 못했습니다 (${e.message})`,
        code: resolved.code,
      },
      'no-store',
    );
  }
  const chart = chartR.value;

  if (!chart.candles.length) {
    return sendJson(
      res,
      404,
      { ok: false, reason: 'no_candles', message: '일봉 데이터가 비어 있습니다.', code: resolved.code },
      'no-store',
    );
  }

  const candles = chart.candles;
  const last = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2] : null;
  const currentPrice = live && live.price ? live.price : last.c;

  /* ── 오늘 봉 = 실시간 봉 ──────────────────────────────────────────────
     fchart 일봉은 장중에 몇 분씩 늦게 갱신된다. 마지막 봉이 오늘(KST)이면
     네이버 실시간 체결(시·고·저·현재가·누적거래량)로 덮어써서, 5개 전략 탭의
     카드 차트·팝업 차트에 '지금 이 순간의 봉'이 그려지게 한다. */
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const todayKst = kstNow.toISOString().slice(0, 10).replace(/-/g, '');
  let liveBar = false;
  if (live && live.price && last && String(last.date) === todayKst) {
    const o = live.open && live.open > 0 ? live.open : last.o;
    last.o = o;
    last.h = Math.max(last.h || 0, live.high || 0, live.price);
    last.l = Math.min(last.l || live.price, live.low || live.price, live.price);
    last.c = live.price;
    last.v = Math.max(last.v || 0, live.volume || 0);
    last.live = true;
    liveBar = true;
  }

  // 등락률 기준이 두 가지다.
  //  · headline(change/changePct): 네이버 증권 화면과 동일한 표기(전일 종가 = 정규장+시간외 최종 종가 기준)
  //  · closeChange: 일봉 정규장 종가끼리의 비교(차트 마지막 두 봉). 값이 다를 수 있어 함께 내려준다.
  const closeChange = prev ? Number((last.c - prev.c).toFixed(2)) : null;
  const closeChangePct = prev ? Number((((last.c - prev.c) / prev.c) * 100).toFixed(2)) : null;
  const headlineChange = live && live.change !== null && live.change !== undefined ? live.change : closeChange;
  const headlinePct = live && live.changePct !== null && live.changePct !== undefined ? live.changePct : closeChangePct;

  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const volumes = candles.map((c) => c.v);

  const body = {
    ok: true,
    query,
    code: resolved.code,
    name: live && live.name ? live.name : chart.name || resolved.name || resolved.code,
    market: (live && live.market) || resolved.market || null,
    resolvedBy: resolved.resolvedBy,
    current: {
      price: currentPrice,
      lastClose: last.c,
      change: headlineChange,
      changePct: headlinePct,
      changeBasis: live ? 'naver-polling(전일 종가·시간외 반영)' : 'daily-close',
      liveBar,
      marketStatus: live ? live.marketStatus : null,
      tradedAt: live ? live.tradedAt : null,
      tradedAtKst: live ? live.tradedAtKst : null,
      source: live ? 'naver-polling' : 'daily-close',
    },
    closeChange: {
      change: closeChange,
      changePct: closeChangePct,
      fromDate: prev ? prev.date : null,
      toDate: last.date,
      basis: '정규장 종가(일봉) 기준',
    },
    candles,
    candleCount: candles.length,
    liveBar,                       /* 마지막 봉에 실시간 체결을 반영했는지 */
    range: {
      from: candles[0].date,
      to: last.date,
      high60: Math.max(...highs),
      low60: Math.min(...lows),
      avgVolume20: Math.round(volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length)),
    },
    rn: buildRnZones(currentPrice, candles),
    sources: [
      { name: `resolve:${resolved.resolvedBy || 'none'}`, ok: Boolean(resolved.resolvedBy) },
      { name: 'naver-fchart', ok: true },
      { name: 'naver-polling', ok: Boolean(live) },
    ],
    errors,
  };

  return sendJson(res, 200, body, CACHE_CONTROL);
};
