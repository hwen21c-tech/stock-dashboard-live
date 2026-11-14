'use strict';

/**
 * GET /api/macro-live
 * ---------------------------------------------------------------------------
 *  9번 탭 '거시·매크로 8종' 실시간 값. 전부 무료·공개 소스(키 불필요).
 *
 *   1) VIX            ^VIX        Yahoo chart
 *   2) 미 10년물 금리  ^TNX        Yahoo chart (값 = % 그대로)
 *   3) 달러 인덱스     DX-Y.NYB    Yahoo chart
 *   4) 금             GC=F        Yahoo chart
 *   5) 구리           HG=F        Yahoo chart
 *   6) 비트코인        BTC-USD     Yahoo chart
 *   7) 국고 3년        KR3YT=RR    네이버 marketIndex (bond)
 *   8) 국고 10년       KR10YT=RR   네이버 marketIndex (bond)
 *
 *  원칙
 *   - 확인된 값만 담는다. 실패한 지표는 ok:false 로 남기고 가짜 값으로 채우지 않는다.
 *   - 각 지표에 '지금이 장중 실시간인지 / 직전 마감 확정값인지'(basis)를 함께 내려준다.
 *   - 캐시: public, s-maxage=60, stale-while-revalidate=120
 */

const { NAVER_HEADERS, fetchJson, parseNum, kstLabel, sendJson, getQuery } = require('../lib/http');

const CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=120';
const YAHOO_TIMEOUT = 7000;
const NAVER_TIMEOUT = 6000;

const YAHOO_MACRO = [
  { key: 'vix', symbol: '^VIX', name: 'VIX 변동성', unit: 'pt', digits: 2, hint: '공포지수' },
  { key: 'us10y', symbol: '^TNX', name: '미 10년물 금리', unit: '%', digits: 3, hint: '글로벌 할인율' },
  { key: 'dxy', symbol: 'DX-Y.NYB', name: '달러 인덱스', unit: 'pt', digits: 3, hint: '달러 강도' },
  { key: 'gold', symbol: 'GC=F', name: '금 (COMEX)', unit: '$', digits: 1, hint: '안전자산' },
  { key: 'copper', symbol: 'HG=F', name: '구리 (COMEX)', unit: '$', digits: 3, hint: '경기 선행' },
  { key: 'btc', symbol: 'BTC-USD', name: '비트코인', unit: '$', digits: 0, hint: '위험자산' },
];

const BONDS = [
  { key: 'kr3y', reutersCode: 'KR3YT=RR', name: '국고 3년', unit: '%', digits: 3, hint: '한국 단기금리' },
  { key: 'kr10y', reutersCode: 'KR10YT=RR', name: '국고 10년', unit: '%', digits: 3, hint: '한국 장기금리' },
];

/** 표시 순서 (8종) */
const ORDER = ['vix', 'us10y', 'dxy', 'gold', 'copper', 'btc', 'kr3y', 'kr10y'];

function round(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

async function fetchYahoo(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    '?interval=1d&range=5d';
  const data = await fetchJson(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    timeout: YAHOO_TIMEOUT,
  });
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  if (!r || !r.meta) throw new Error(`yahoo empty ${symbol}`);
  const m = r.meta;
  const price =
    typeof m.regularMarketPrice === 'number'
      ? m.regularMarketPrice
      : typeof m.fulldayPrice === 'number'
        ? m.fulldayPrice
        : null;
  if (price === null) throw new Error(`yahoo no price ${symbol}`);
  const change =
    typeof m.fulldayChange === 'number'
      ? m.fulldayChange
      : typeof m.regularMarketChange === 'number'
        ? m.regularMarketChange
        : null;
  const changePct =
    typeof m.fulldayChangePercent === 'number'
      ? m.fulldayChangePercent
      : typeof m.regularMarketChangePercent === 'number'
        ? m.regularMarketChangePercent
        : null;
  const regular = m.currentTradingPeriod && m.currentTradingPeriod.regular;
  const nowSec = Math.floor(Date.now() / 1000);
  const sessionOpen =
    regular && Number.isFinite(regular.start) && Number.isFinite(regular.end)
      ? nowSec >= regular.start && nowSec < regular.end
      : null;
  return {
    price,
    change,
    changePct,
    previousClose: change === null ? null : price - change,
    asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    asOfKst: m.regularMarketTime ? kstLabel(m.regularMarketTime * 1000) : null,
    sessionOpen,
    symbol: m.symbol || symbol,
  };
}

async function fetchBond(b) {
  const url =
    'https://m.stock.naver.com/front-api/marketIndex/prices?category=bond&reutersCode=' +
    encodeURIComponent(b.reutersCode);
  const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: NAVER_TIMEOUT });
  const rows = (data && data.result) || [];
  if (!rows.length) throw new Error('naver bond empty');
  const latest = rows[0];
  const price = parseNum(latest.closePrice);
  if (price === null) throw new Error('naver bond no price');
  const change = parseNum(latest.fluctuations);
  const sign = latest.fluctuationsType && latest.fluctuationsType.name;
  const signed = sign === 'FALLING' && change !== null ? -Math.abs(change) : change;
  return {
    price,
    change: signed,
    changePct: parseNum(latest.fluctuationsRatio),
    previousClose: signed === null ? null : price - signed,
    asOf: latest.localTradedAt || null,
    asOfKst: latest.localTradedAt ? kstLabel(latest.localTradedAt) : null,
    sessionOpen: null,
    source: 'naver-marketindex',
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end();
  }
  const started = Date.now();
  const q = getQuery(req);

  const defs = YAHOO_MACRO.map((d) => ({ ...d, kind: 'yahoo' })).concat(
    BONDS.map((d) => ({ ...d, kind: 'naver-bond' })),
  );

  const settled = await Promise.allSettled(
    defs.map((d) => (d.kind === 'yahoo' ? fetchYahoo(d.symbol) : fetchBond(d))),
  );

  const items = [];
  const errors = [];
  const sources = [];

  settled.forEach((s, i) => {
    const def = defs[i];
    if (s.status !== 'fulfilled') {
      const msg = String((s.reason && s.reason.message) || s.reason);
      errors.push(`${def.key}: ${msg}`);
      sources.push({ name: def.kind, key: def.key, ok: false, error: msg });
      items.push({
        key: def.key,
        name: def.name,
        unit: def.unit,
        digits: def.digits,
        hint: def.hint,
        ok: false,
        value: null,
        change: null,
        changePct: null,
        source: def.kind,
        error: msg,
      });
      return;
    }
    const v = s.value;
    const inSession = v.sessionOpen === true;
    sources.push({ name: def.kind, key: def.key, ok: true });
    items.push({
      key: def.key,
      name: def.name,
      unit: def.unit,
      digits: def.digits,
      hint: def.hint,
      ok: true,
      value: round(v.price, def.digits),
      change: round(v.change, def.digits),
      changePct: round(v.changePct, 2),
      previousClose: round(v.previousClose, def.digits),
      symbol: v.symbol || def.reutersCode || def.symbol,
      asOf: v.asOf || null,
      asOfKst: v.asOfKst || null,
      sessionOpen: v.sessionOpen,
      basis: def.kind === 'naver-bond' ? '국고채 최종 체결값' : inSession ? '정규장 진행 중 실시간' : '직전 정규장 마감값',
      basisLabel:
        def.kind === 'naver-bond'
          ? `국고채 최종 체결 (${v.asOfKst || '—'} KST)`
          : inSession
            ? '실시간 (정규장 진행 중)'
            : `마감 확정값 (${v.asOfKst || '—'} KST)`,
      source: def.kind,
    });
  });

  // 표시 순서 고정
  const byKey = new Map(items.map((it) => [it.key, it]));
  const ordered = ORDER.map((k) => byKey.get(k)).filter(Boolean);

  const ok = ordered.some((it) => it.ok);
  const body = {
    ok,
    generatedAt: new Date().toISOString(),
    generatedAtKst: kstLabel(new Date()),
    elapsedMs: Date.now() - started,
    count: ordered.length,
    items: ordered,
    sources,
    errors,
    partial: errors.length > 0,
    fresh: q.fresh === '1',
  };

  if (!ok) {
    return sendJson(
      res,
      200,
      { ...body, reason: 'upstream_failed', message: '거시 지표 소스에서 값을 받지 못했습니다.' },
      'no-store',
    );
  }

  return sendJson(res, 200, body, CACHE_CONTROL);
};

module.exports.YAHOO_MACRO = YAHOO_MACRO;
module.exports.BONDS = BONDS;
module.exports.ORDER = ORDER;
