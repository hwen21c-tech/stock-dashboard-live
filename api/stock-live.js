'use strict';

/**
 * GET /api/stock-live
 *  - 코스피/코스닥 지수, 원/달러 환율, 나스닥100·S&P500 선물, 주요 종목 현재가를 한 번에 반환.
 *  - 소스: 네이버 금융 polling API (지수·국내종목), 네이버 증권 marketIndex (환율), Yahoo Finance (해외선물)
 *  - 쿼리: ?codes=005930,000660 (선택) / ?fresh=1 (서버 메모리 캐시 무시)
 *  - 캐시: s-maxage=10, stale-while-revalidate=20
 */

const {
  NAVER_HEADERS,
  fetchJson,
  parseNum,
  parseKoreanMoney,
  formatKoreanMoney,
  kstLabel,
  sendJson,
  getQuery,
} = require('../lib/http');

const CACHE_CONTROL = 'public, s-maxage=10, stale-while-revalidate=20';

// 기본 관제탑 종목 (사용자가 자주 보는 축)
const DEFAULT_STOCKS = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '007810', name: '코리아써키트' },
  { code: '263860', name: '지니언스' },
  { code: '009150', name: '삼성전기' },
  { code: '222800', name: '심텍' },
  { code: '356860', name: '티엘비' },
  { code: '035420', name: 'NAVER' },
  { code: '034020', name: '두산에너빌리티' },
  { code: '028300', name: 'HLB' },
  { code: '143240', name: '펨트론' },
  { code: '058470', name: '리노공업' },
];

const FUTURES = [
  { symbol: 'NQ=F', name: '나스닥100 선물' },
  { symbol: 'ES=F', name: 'S&P500 선물' },
];

// 인스턴스 메모리 캐시 (Vercel CDN 캐시와 별개로 같은 인스턴스의 연속 호출을 묶어준다)
const memCache = new Map();
const MEM_TTL_MS = 5000;

function cached(key) {
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.at < MEM_TTL_MS) return hit.value;
  return null;
}
function store(key, value) {
  memCache.set(key, { at: Date.now(), value });
  return value;
}

/* ---------------------------- 네이버 지수 ---------------------------- */
async function fetchIndices() {
  const url =
    'https://polling.finance.naver.com/api/realtime?query=' +
    encodeURIComponent('SERVICE_INDEX:KOSPI,KOSDAQ') +
    '&_=' +
    Date.now();
  const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: 6000 });
  const areas = (data && data.result && data.result.areas) || [];
  const flat = [];
  for (const area of areas) {
    for (const d of area.datas || []) flat.push(d);
  }
  const NAME = { KOSPI: '코스피', KOSDAQ: '코스닥' };
  return flat
    .filter((d) => NAME[d.cd])
    .map((d) => {
      const value = Number.isFinite(d.aa) ? d.aa * 1e6 : null; // aa 단위: 백만원
      return {
        key: d.cd,
        name: NAME[d.cd],
        price: Number((d.nv / 100).toFixed(2)),
        change: Number((d.cv / 100).toFixed(2)),
        changePct: Number((d.cr || 0).toFixed(2)),
        open: d.ov ? Number((d.ov / 100).toFixed(2)) : null,
        high: d.hv ? Number((d.hv / 100).toFixed(2)) : null,
        low: d.lv ? Number((d.lv / 100).toFixed(2)) : null,
        volume: Number.isFinite(d.aq) ? d.aq : null,
        value,
        valueText: formatKoreanMoney(value),
        status: d.ms || null,
        source: 'naver-polling',
      };
    });
}

/* --------------------------- 국내 종목 현재가 --------------------------- */
function parseStock(d) {
  const price = parseNum(d.closePriceRaw) ?? parseNum(d.closePrice);
  const change = parseNum(d.compareToPreviousClosePriceRaw) ?? parseNum(d.compareToPreviousClosePrice);
  const changePct = parseNum(d.fluctuationsRatioRaw) ?? parseNum(d.fluctuationsRatio);
  const valueRaw = parseNum(d.accumulatedTradingValueRaw) ?? parseKoreanMoney(d.accumulatedTradingValue);
  const sign = d.compareToPreviousPrice && d.compareToPreviousPrice.name; // RISING / FALLING / UNCHANGED
  return {
    code: d.itemCode,
    name: d.stockName,
    market: (d.stockExchangeType && d.stockExchangeType.name) || null,
    price,
    change: sign === 'FALLING' && change !== null ? -Math.abs(change) : change,
    changePct: sign === 'FALLING' && changePct !== null ? -Math.abs(changePct) : changePct,
    open: parseNum(d.openPriceRaw) ?? parseNum(d.openPrice),
    high: parseNum(d.highPriceRaw) ?? parseNum(d.highPrice),
    low: parseNum(d.lowPriceRaw) ?? parseNum(d.lowPrice),
    prevClose: price !== null && change !== null ? price - change : null,
    volume: parseNum(d.accumulatedTradingVolumeRaw) ?? parseNum(d.accumulatedTradingVolume),
    value: valueRaw,
    valueText: formatKoreanMoney(valueRaw) || d.accumulatedTradingValue || null,
    marketStatus: d.marketStatus || null,
    tradedAt: d.localTradedAt || null,
    tradedAtKst: kstLabel(d.localTradedAt),
    changeBasis: 'naver-polling(전일 종가·시간외 반영)',
    source: 'naver-polling',
  };
}

async function fetchStocks(codes) {
  const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(',')}`;
  const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: 6000 });
  return (data.datas || []).map(parseStock);
}

/* ------------------------------- 환율 ------------------------------- */
async function fetchFxFromNaver() {
  const url =
    'https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&reutersCode=FX_USDKRW';
  const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: 6000 });
  const rows = (data && data.result) || [];
  if (!rows.length) throw new Error('naver fx empty');
  const latest = rows[0];
  return {
    key: 'USDKRW',
    name: '원/달러',
    price: parseNum(latest.closePrice),
    change: parseNum(latest.fluctuations),
    changePct: parseNum(latest.fluctuationsRatio),
    tradedDate: latest.localTradedAt || null,
    direction: latest.fluctuationsType ? latest.fluctuationsType.name : null,
    source: 'naver-marketindex',
  };
}

async function fetchFxFromYahoo() {
  const q = await fetchYahooQuote('KRW=X');
  return {
    key: 'USDKRW',
    name: '원/달러',
    price: q.price,
    change: q.change,
    changePct: q.changePct,
    tradedDate: q.asOf,
    direction: q.change > 0 ? 'RISING' : q.change < 0 ? 'FALLING' : 'UNCHANGED',
    source: 'yahoo',
  };
}

/* ----------------------------- 해외 선물 ----------------------------- */
async function fetchYahooQuote(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    '?interval=1d&range=5d';
  const data = await fetchJson(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    timeout: 7000,
  });
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.meta) throw new Error(`yahoo empty ${symbol}`);
  const m = result.meta;
  const price = typeof m.regularMarketPrice === 'number' ? m.regularMarketPrice : null;
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
  if (price === null) throw new Error(`yahoo no price ${symbol}`);
  return {
    symbol: m.symbol || symbol,
    price: Number(price.toFixed(2)),
    change: change === null ? null : Number(change.toFixed(2)),
    changePct: changePct === null ? null : Number(changePct.toFixed(2)),
    currency: m.currency || null,
    asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    asOfKst: m.regularMarketTime ? kstLabel(m.regularMarketTime * 1000) : null,
    source: 'yahoo',
  };
}

async function fetchFutures() {
  const settled = await Promise.allSettled(FUTURES.map((f) => fetchYahooQuote(f.symbol)));
  const out = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') out.push({ name: FUTURES[i].name, ...s.value });
    else errors.push(`${FUTURES[i].symbol}: ${s.reason && s.reason.message}`);
  });
  return { futures: out, errors };
}

/* ------------------------------ handler ------------------------------ */
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.end();
  }

  const q = getQuery(req);
  const fresh = q.fresh === '1' || q.fresh === 'true';
  const codeList = (q.codes || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{6}$/.test(s));
  const codes = codeList.length ? codeList : DEFAULT_STOCKS.map((s) => s.code);
  const cacheKey = `live:${codes.join(',')}`;

  if (!fresh) {
    const hit = cached(cacheKey);
    if (hit) {
      res.setHeader('X-Cache', 'HIT-memory');
      return sendJson(res, 200, hit, CACHE_CONTROL);
    }
  }

  const started = Date.now();
  const tasks = {
    indices: fetchIndices(),
    stocks: fetchStocks(codes),
    fxNaver: fetchFxFromNaver(),
    futures: fetchFutures(),
  };

  // 환율은 네이버가 실패하면 Yahoo로 대체
  const [indicesR, stocksR, fxR, futuresR] = await Promise.allSettled([
    tasks.indices,
    tasks.stocks,
    tasks.fxNaver,
    tasks.futures,
  ]);

  let fx = null;
  let fxError = null;
  if (fxR.status === 'fulfilled') fx = fxR.value;
  else {
    fxError = fxR.reason && fxR.reason.message;
    try {
      fx = await fetchFxFromYahoo();
      fxError = null;
    } catch (e) {
      fxError = `${fxError} / yahoo fallback: ${e.message}`;
    }
  }

  const sources = [];
  const errors = [];
  const collect = (label, r) => {
    if (r.status === 'fulfilled') sources.push({ name: label, ok: true });
    else {
      sources.push({ name: label, ok: false, error: String(r.reason && r.reason.message) });
      errors.push(`${label}: ${r.reason && r.reason.message}`);
    }
  };
  collect('naver-index', indicesR);
  collect('naver-stock', stocksR);
  collect('naver-fx', fxR);
  collect('yahoo-futures', futuresR);
  if (futuresR.status === 'fulfilled' && futuresR.value.errors.length) {
    errors.push(...futuresR.value.errors);
  }
  if (fxError) errors.push(`fx: ${fxError}`);

  const indices = indicesR.status === 'fulfilled' ? indicesR.value : [];
  const stocks = stocksR.status === 'fulfilled' ? stocksR.value : [];
  const futures = futuresR.status === 'fulfilled' ? futuresR.value.futures : [];

  const body = {
    ok: indices.length > 0 || stocks.length > 0,
    generatedAt: new Date().toISOString(),
    generatedAtKst: kstLabel(new Date()),
    elapsedMs: Date.now() - started,
    marketStatus: stocks[0] ? stocks[0].marketStatus : null,
    indices,
    fx,
    futures,
    stocks: stocks.map((s) => {
      const known = DEFAULT_STOCKS.find((d) => d.code === s.code);
      return known ? { ...s, label: known.name } : s;
    }),
    sources,
    errors,
  };

  if (!body.ok) {
    return sendJson(
      res,
      502,
      { ...body, reason: 'upstream_failed', message: '네이버 금융 응답을 받지 못했습니다.' },
      'no-store',
    );
  }

  store(cacheKey, body);
  res.setHeader('X-Cache', 'MISS');
  return sendJson(res, 200, body, CACHE_CONTROL);
};
