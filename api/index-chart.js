'use strict';

/**
 * GET /api/index-chart?key=kospi        (또는 ?symbol=^KS11)
 * ---------------------------------------------------------------------------
 *  지수·선물 상세 모달용 '실제' 일봉. 합성(Math.sin) 캔들을 만들지 않는다.
 *
 *  · 값을 주는 곳: Yahoo Finance chart (range=1y, interval=1d) — 무료·키 불필요
 *      kospi ^KS11 · kosdaq ^KQ11 · sox ^SOX · wti CL=F · usdkrw KRW=X
 *      nasdaq_fut NQ=F · sp500_fut ES=F · vix ^VIX · us10y ^TNX · dxy DX-Y.NYB
 *      gold GC=F · copper HG=F · btc BTC-USD
 *  · 값을 주지 않는 곳(공개 일봉 API 없음): KRX 주간선물·야간선물, 코스닥150 야간선물,
 *    코스피/코스닥 투자자별 누적수급 시계열, NDF 환율.
 *    → ok:false, reason:'no_public_daily' 로 정직하게 알리고 차트를 그리지 않는다.
 *
 *  응답
 *   { ok, key, symbol, name, unit, quote:{price,change,changePct,previousClose,dayHigh,dayLow,
 *     asOfKst,sessionOpen,basis,basisLabel}, candles:[{date,o,h,l,c,v}], range:{from,to,high,low,count},
 *     source:'yahoo', errors:[] }
 */

const { fetchJson, kstLabel, sendJson, getQuery } = require('../lib/http');

const CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=120';
const YAHOO_TIMEOUT = 8000;

/** key → Yahoo 심볼 */
const SYMBOLS = {
  kospi: { symbol: '^KS11', name: '코스피', unit: 'pt', digits: 2, market: 'KRX' },
  kosdaq: { symbol: '^KQ11', name: '코스닥', unit: 'pt', digits: 2, market: 'KRX' },
  kospi200_spot: { symbol: '^KS200', name: '코스피200 현물', unit: 'pt', digits: 2, market: 'KRX' },
  sox: { symbol: '^SOX', name: '필라델피아 반도체', unit: 'pt', digits: 2, market: 'NASDAQ' },
  wti: { symbol: 'CL=F', name: 'WTI 원유 선물', unit: '$', digits: 2, market: 'NYMEX' },
  usdkrw: { symbol: 'KRW=X', name: '원/달러 환율', unit: '원', digits: 2, market: 'FX' },
  nasdaq_fut: { symbol: 'NQ=F', name: 'E-mini 나스닥100 선물', unit: 'pt', digits: 2, market: 'CME' },
  sp500_fut: { symbol: 'ES=F', name: 'E-mini S&P500 선물', unit: 'pt', digits: 2, market: 'CME' },
  vix: { symbol: '^VIX', name: 'VIX 변동성 지수', unit: 'pt', digits: 2, market: 'CBOE' },
  us10y: { symbol: '^TNX', name: '미 10년 국채금리', unit: '%', digits: 3, market: 'CBOE' },
  dxy: { symbol: 'DX-Y.NYB', name: '달러 인덱스', unit: 'pt', digits: 3, market: 'ICE' },
  gold: { symbol: 'GC=F', name: '금 선물', unit: '$', digits: 1, market: 'COMEX' },
  copper: { symbol: 'HG=F', name: '구리 선물', unit: '$', digits: 3, market: 'COMEX' },
  btc: { symbol: 'BTC-USD', name: '비트코인', unit: '$', digits: 0, market: 'CRYPTO' },
};

/** 공개 일봉 API 가 없는 항목 — 정직하게 안내한다(가짜 차트 금지) */
const NO_PUBLIC_DAILY = {
  kospi200_day: 'KRX 코스피200 주간선물은 공개 일봉 API가 없습니다.',
  kospi200_night: 'KRX 코스피200 야간선물은 공개 일봉 API가 없습니다.',
  kosdaq150_night: 'KRX 코스닥150 야간선물은 공개 일봉 API가 없습니다.',
  sidecar: '사이드카 발동 시점의 지수 궤적은 공개 시계열 API가 없습니다.',
  kospi_frg: '코스피 투자자별 누적 수급 시계열은 공개 API가 없습니다(KRX 로그인 필요).',
  kosdaq_inst: '코스닥 기관 누적 수급 시계열은 공개 API가 없습니다(KRX 로그인 필요).',
  frg_fut: '외국인 선물 누적 계약 시계열은 공개 API가 없습니다(KRX 로그인 필요).',
  nxt_ndf: '야간 NDF 환율은 공개 API가 없습니다.',
};

const pad2 = (n) => (n < 10 ? '0' : '') + n;

function exchangeDate(tsSec, gmtOffsetSec) {
  const ms = (tsSec + (Number.isFinite(gmtOffsetSec) ? gmtOffsetSec : 0)) * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function round(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

async function fetchYahooDaily(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    '?interval=1d&range=1y&includePrePost=false';
  const data = await fetchJson(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    timeout: YAHOO_TIMEOUT,
  });
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.meta) throw new Error(`yahoo empty ${symbol}`);
  const m = result.meta;
  const stamps = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const candles = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const o = q.open ? q.open[i] : null;
    const h = q.high ? q.high[i] : null;
    const l = q.low ? q.low[i] : null;
    const c = q.close ? q.close[i] : null;
    if (![o, h, l, c].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    candles.push({
      date: exchangeDate(stamps[i], m.gmtoffset),
      o,
      h,
      l,
      c,
      v: typeof (q.volume ? q.volume[i] : null) === 'number' ? q.volume[i] : 0,
    });
  }
  return { meta: m, candles };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end();
  }

  const q = getQuery(req);
  const key = String(q.key || q.symbol || '').trim();
  if (!key) {
    return sendJson(
      res,
      400,
      { ok: false, reason: 'missing_key', message: '?key=kospi 또는 ?symbol=^KS11 을 지정하세요.' },
      'no-store',
    );
  }

  const lower = key.toLowerCase();
  const def = SYMBOLS[lower];

  if (!def) {
    const why = NO_PUBLIC_DAILY[lower];
    return sendJson(
      res,
      200,
      {
        ok: false,
        key,
        reason: why ? 'no_public_daily' : 'unknown_key',
        message:
          why ||
          `'${key}' 는 이 API가 아는 지수 키가 아닙니다. 사용 가능: ${Object.keys(SYMBOLS).join(', ')}`,
        candles: [],
        source: null,
      },
      why ? CACHE_CONTROL : 'no-store',
    );
  }

  let candles = [];
  let meta = null;
  const errors = [];
  try {
    const r = await fetchYahooDaily(def.symbol);
    candles = r.candles;
    meta = r.meta;
  } catch (e) {
    errors.push(`yahoo: ${e.message}`);
  }

  if (!candles.length) {
    return sendJson(
      res,
      200,
      {
        ok: false,
        key: lower,
        symbol: def.symbol,
        name: def.name,
        reason: 'upstream_empty',
        message: `Yahoo ${def.symbol} 일봉을 받지 못했습니다.`,
        errors,
        candles: [],
        source: 'yahoo',
      },
      'no-store',
    );
  }

  const last = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2] : null;

  // 값의 기준: Yahoo 는 지금 체결(정규장 진행 중) 또는 직전 마감값을 준다.
  const price =
    typeof meta.regularMarketPrice === 'number'
      ? meta.regularMarketPrice
      : typeof meta.fulldayPrice === 'number'
        ? meta.fulldayPrice
        : last.c;
  const change =
    typeof meta.fulldayChange === 'number'
      ? meta.fulldayChange
      : typeof meta.regularMarketChange === 'number'
        ? meta.regularMarketChange
        : prev
          ? price - prev.c
          : null;
  const changePct =
    typeof meta.fulldayChangePercent === 'number'
      ? meta.fulldayChangePercent
      : typeof meta.regularMarketChangePercent === 'number'
        ? meta.regularMarketChangePercent
        : prev && prev.c
          ? ((price - prev.c) / prev.c) * 100
          : null;

  const regular = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  const nowSec = Math.floor(Date.now() / 1000);
  const sessionOpen =
    regular && Number.isFinite(regular.start) && Number.isFinite(regular.end)
      ? nowSec >= regular.start && nowSec < regular.end
      : null;

  const dayHigh = typeof meta.regularMarketDayHigh === 'number' && meta.regularMarketDayHigh > 0 ? meta.regularMarketDayHigh : null;
  const dayLow = typeof meta.regularMarketDayLow === 'number' && meta.regularMarketDayLow > 0 ? meta.regularMarketDayLow : null;

  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);

  const body = {
    ok: true,
    key: lower,
    symbol: meta.symbol || def.symbol,
    name: def.name,
    unit: def.unit,
    digits: def.digits,
    market: def.market,
    currency: meta.currency || null,
    quote: {
      price: round(price, def.digits),
      change: round(change, def.digits),
      changePct: round(changePct, 2),
      previousClose:
        typeof change === 'number' ? round(price - change, def.digits) : prev ? round(prev.c, def.digits) : null,
      dayHigh: round(dayHigh, def.digits),
      dayLow: round(dayLow, def.digits),
      asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      asOfKst: meta.regularMarketTime ? kstLabel(meta.regularMarketTime * 1000) : null,
      sessionOpen,
      basis: sessionOpen === true ? '정규장 진행 중 실시간' : '직전 정규장 마감값',
      basisLabel:
        sessionOpen === true
          ? '실시간 (정규장 진행 중)'
          : `마감 확정값 (${meta.regularMarketTime ? kstLabel(meta.regularMarketTime * 1000) : '—'} KST)`,
    },
    candles,
    range: {
      from: candles[0].date,
      to: last.date,
      high: round(Math.max.apply(null, highs), def.digits),
      low: round(Math.min.apply(null, lows), def.digits),
      count: candles.length,
    },
    source: 'yahoo',
    sourceNote: `Yahoo Finance ${def.symbol} · 일 1회(일봉) 갱신 · 합성 캔들 아님`,
    errors,
  };

  return sendJson(res, 200, body, CACHE_CONTROL);
};

module.exports.SYMBOLS = SYMBOLS;
module.exports.NO_PUBLIC_DAILY = NO_PUBLIC_DAILY;

/* 🛡️ 2026-11-27: 예기치 못한 예외가 500(빈 응답)으로 나가지 않도록 핸들러를 감싼다.
 *    · 프론트는 ok:false + reason:'internal_error' 를 받고 직전 값을 유지한다.
 *    · 테스트용으로 붙인 module.exports 속성은 그대로 보존한다. */
(function () {
  const __http = require('../lib/http');
  const __h = module.exports;
  if (typeof __h === 'function' && !__h.__guarded) {
    const __wrapped = __http.safeHandler(__h, { label: 'index-chart' });
    Object.assign(__wrapped, __h);
    __wrapped.__guarded = true;
    module.exports = __wrapped;
  }
})();
