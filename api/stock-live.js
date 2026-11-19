'use strict';

/**
 * GET /api/stock-live
 *  - 코스피/코스닥 지수, 원/달러 환율, 나스닥100·S&P500 선물, 주요 종목 현재가를 한 번에 반환.
 *  - WTI 유가(CL=F) · 필라델피아 반도체(^SOX)는 macro 키로 함께 내려준다.
 *      · 값과 함께 '지금이 정규장 중인지(실시간) / 직전 마감 확정값인지'를 basis·basisLabel·updateCycle 로 명시한다.
 *  - 소스: 네이버 금융 polling API (지수·국내종목), 네이버 증권 marketIndex (환율), Yahoo Finance (해외선물·유가·SOX)
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

// 한국투자증권(KIS) 공식 오픈API — 실패하면 조용히 네이버 단독으로 돌아가야 하므로 절대 throw 하지 않는다.
const kis = require('../lib/kis');

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
  { code: '143240', name: '사람인' },
  { code: '168360', name: '펨트론' },
  { code: '058470', name: '리노공업' },
];

const FUTURES = [
  { symbol: 'NQ=F', name: '나스닥100 선물' },
  { symbol: 'ES=F', name: 'S&P500 선물' },
];

// 상단 티커의 WTI 유가 · 필라델피아 반도체(SOX) — 둘 다 Yahoo 무료 시세
const MACRO = [
  { symbol: 'CL=F', key: 'WTI', name: 'WTI 유가' },
  { symbol: '^SOX', key: 'SOX', name: '필라델피아 반도체' },
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
  // 통합(KRX+NXT·시간외 포함) 대금 — 화면 표시(테마·상한가·만쥬·RN존)는 이 값을 쓴다
  const integ = d.integratedPriceInfo || null;
  const over = d.overMarketPriceInfo || null;
  const valueInteg = integ ? parseNum(integ.accumulatedTradingValueRaw) : null;
  const valueAfter = over ? parseNum(over.accumulatedTradingValueRaw) : null;
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
    valueRegular: valueRaw,
    valueRegularText: formatKoreanMoney(valueRaw) || d.accumulatedTradingValue || null,
    valueInteg,
    valueIntegText: valueInteg !== null ? formatKoreanMoney(valueInteg) : null,
    valueAfter,
    valueAfterText: valueAfter !== null ? formatKoreanMoney(valueAfter) : null,
    valueBasis: valueInteg !== null ? '통합(KRX+NXT)' : '정규장',
    marketStatus: d.marketStatus || null,
    // 거래정지·거래가능 상태 (네이버 원본 필드 그대로 — 추측 없이 전달)
    tradeStop: (d.tradeStopType && (d.tradeStopType.text || d.tradeStopType.name)) || null,
    tradableStatus: d.tradableStatus || null,
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
  // 지금이 그 시장의 정규장 안인지 (일 1회 확정값인지 실시간인지 가르는 근거)
  const regular = m.currentTradingPeriod && m.currentTradingPeriod.regular;
  const nowSec = Math.floor(Date.now() / 1000);
  const sessionOpen =
    regular && Number.isFinite(regular.start) && Number.isFinite(regular.end)
      ? nowSec >= regular.start && nowSec < regular.end
      : null;
  return {
    symbol: m.symbol || symbol,
    price: Number(price.toFixed(2)),
    change: change === null ? null : Number(change.toFixed(2)),
    changePct: changePct === null ? null : Number(changePct.toFixed(2)),
    previousClose: change === null ? null : Number((price - change).toFixed(2)),
    dayHigh: typeof m.regularMarketDayHigh === 'number' ? Number(m.regularMarketDayHigh.toFixed(2)) : null,
    dayLow: typeof m.regularMarketDayLow === 'number' ? Number(m.regularMarketDayLow.toFixed(2)) : null,
    currency: m.currency || null,
    sessionOpen,
    asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    asOfKst: m.regularMarketTime ? kstLabel(m.regularMarketTime * 1000) : null,
    source: 'yahoo',
  };
}

/* --------------------- WTI 유가 · 필라델피아 반도체(SOX) --------------------- */
async function fetchMacro() {
  const settled = await Promise.allSettled(MACRO.map((m) => fetchYahooQuote(m.symbol)));
  const macro = {};
  const errors = [];
  settled.forEach((s, i) => {
    const def = MACRO[i];
    if (s.status !== 'fulfilled') {
      errors.push(`${def.symbol}: ${s.reason && s.reason.message}`);
      return;
    }
    const q = s.value;
    const inSession = q.sessionOpen === true;
    macro[def.key] = {
      key: def.key,
      name: def.name,
      symbol: q.symbol,
      price: q.price,
      change: q.change,
      changePct: q.changePct,
      previousClose: q.previousClose,
      dayHigh: q.dayHigh,
      dayLow: q.dayLow,
      currency: q.currency,
      asOf: q.asOf,
      asOfKst: q.asOfKst,
      sessionOpen: q.sessionOpen,
      // 이 값이 '지금 체결'인지 '직전 마감 확정'인지 화면에서 구분해 쓸 수 있게 내려준다
      basis: inSession ? '정규장 진행 중 실시간' : '직전 정규장 마감값',
      basisLabel: inSession
        ? '실시간 (정규장 진행 중)'
        : `마감 확정값 (${q.asOfKst || '—'} KST)`,
      updateCycle:
        def.key === 'SOX'
          ? '미국 정규장 중에는 실시간 · 마감 후 다음 장 시작 전까지 1일 1회 확정값'
          : 'NYMEX 정규장 중에는 실시간 · 주말·휴장에는 직전 마감값',
      source: 'yahoo',
    };
  });
  return { macro, errors };
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

/* --------------------- 공식 시장경보 (관리·거래정지·경보) --------------------- */
/**
 * 네이버 Npay 증권 '관리·거래정지·경보' 화면이 실제로 호출하는 목록 API.
 *   ?alertType=01 → 투자주의 / 02 → 투자경고 / 03 → 투자위험
 *   &orderType=tradeStopYn → 거래정지 종목
 * 응답 필드: itemcode, itemname, marketAlertType, tradeStopYn, manageStatusGb,
 *            tradingHaltDate, tradableStatusUpdatedAt, nowPrice, prevChangeRate …
 * ※ 이 목록은 KRX 지정 현황을 네이버가 정리해 내려주는 "공식 지정" 데이터다.
 *   (추측·계산값이 아니므로 화면에서 일봉 계산 배지와 구분해 표기한다)
 */
const ALERT_BASE = 'https://stock.naver.com/api/domestic/market/stock/default';
const ALERT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  Referer: 'https://stock.naver.com/',
  Origin: 'https://stock.naver.com',
};
const ALERT_TYPES = [
  { code: '01', label: '투자주의', grade: 1 },
  { code: '02', label: '투자경고', grade: 2 },
  { code: '03', label: '투자위험', grade: 3 },
];
const ALERT_PAGE_SIZE = 100;
const ALERT_MAX_PAGES = 3;
const ALERT_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=1800';

const alertCache = { at: 0, body: null };
const ALERT_MEM_TTL_MS = 10 * 60 * 1000;

async function fetchAlertPage(params) {
  const qs = Object.keys(params)
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');
  const rows = await fetchJson(`${ALERT_BASE}?${qs}`, {
    headers: ALERT_HEADERS,
    timeout: 9000,
  });
  if (!Array.isArray(rows)) throw new Error('alert list shape');
  return rows;
}

/** 페이지네이션(최대 ALERT_MAX_PAGES)까지 모아서 한 목록으로 만든다. */
async function fetchAlertAll(extra) {
  const out = [];
  for (let page = 0; page < ALERT_MAX_PAGES; page++) {
    const rows = await fetchAlertPage({
      tradeType: 'KRX',
      marketType: 'ALL',
      ...extra,
      startIdx: page * ALERT_PAGE_SIZE,
      pageSize: ALERT_PAGE_SIZE,
    });
    out.push(...rows);
    if (rows.length < ALERT_PAGE_SIZE) break;
  }
  return out;
}

function alertRecord(row, fallback) {
  // 거래정지 목록에는 marketAlertType 이 '00'(지정 없음)으로 오므로 경보 등급은 경보 목록에서만 읽는다
  const haltList = fallback.kind === 'halt';
  const type = haltList ? null : row.marketAlertType || fallback.code || null;
  const def = ALERT_TYPES.find((t) => t.code === type) || null;
  const isHalt = String(row.tradeStopYn || '').toUpperCase() === 'Y' || haltList;
  return {
    code: row.itemcode || null,
    name: row.itemname || null,
    market: row.sosok === '1' ? '코스닥' : row.sosok === '0' ? '코스피' : null,
    alertType: def ? def.code : null,
    alertLabel: def ? def.label : null,
    grade: def ? def.grade : 0,
    tradeStop: isHalt,
    manageStatus: row.manageStatusGb != null ? String(row.manageStatusGb) : null,
    tradedAt: row.tradableStatusUpdatedAt || null,
    haltDate: row.tradingHaltDate || null,
    haltReasonCode: row.tradingHaltReasonCode ? String(row.tradingHaltReasonCode) : null,
    price: parseNum(row.nowPrice),
    changePct: parseNum(row.prevChangeRate),
  };
}

function mergeAlert(list, rec) {
  if (!rec || !rec.code) return;
  const prev = list.get(rec.code);
  if (!prev) {
    list.set(rec.code, rec);
    return;
  }
  // 상위 등급(투자위험 > 투자경고 > 투자주의 > 거래정지)과 거래정지 여부를 합쳐 남긴다
  const pick = rec.grade > prev.grade ? rec : prev;
  list.set(rec.code, {
    ...pick,
    tradeStop: !!(prev.tradeStop || rec.tradeStop),
    haltDate: pick.haltDate || prev.haltDate || rec.haltDate || null,
    haltReasonCode: pick.haltReasonCode || prev.haltReasonCode || rec.haltReasonCode || null,
  });
}

async function buildAlertsBody() {
  const started = Date.now();
  const sources = [];
  const errors = [];
  const map = new Map();

  const settled = await Promise.allSettled(
    ALERT_TYPES.map((t) => fetchAlertAll({ orderType: 'marketAlertType', alertType: t.code })),
  );
  settled.forEach((s, i) => {
    const t = ALERT_TYPES[i];
    if (s.status !== 'fulfilled') {
      sources.push({ name: `naver-alert-${t.code}`, ok: false, error: String(s.reason && s.reason.message) });
      errors.push(`${t.label}: ${s.reason && s.reason.message}`);
      return;
    }
    sources.push({ name: `naver-alert-${t.code}`, ok: true, count: s.value.length });
    s.value.forEach((row) => mergeAlert(map, alertRecord(row, { code: t.code })));
  });

  // 거래정지 목록은 별도 정렬 키로만 내려온다
  try {
    const halted = await fetchAlertAll({ orderType: 'tradeStopYn' });
    sources.push({ name: 'naver-alert-halt', ok: true, count: halted.length });
    halted.forEach((row) => mergeAlert(map, alertRecord(row, { kind: 'halt' })));
  } catch (e) {
    sources.push({ name: 'naver-alert-halt', ok: false, error: String(e.message) });
    errors.push(`거래정지: ${e.message}`);
  }

  const stocks = Array.from(map.values()).sort((a, b) => b.grade - a.grade || String(a.name).localeCompare(String(b.name)));
  const counts = { 투자주의: 0, 투자경고: 0, 투자위험: 0, 거래정지: 0 };
  stocks.forEach((s) => {
    if (s.alertLabel && counts[s.alertLabel] != null) counts[s.alertLabel] += 1;
    if (s.tradeStop) counts['거래정지'] += 1;
  });
  return {
    ok: stocks.length > 0 || errors.length < ALERT_TYPES.length + 1,
    mode: 'alerts',
    generatedAt: new Date().toISOString(),
    generatedAtKst: kstLabel(new Date()),
    elapsedMs: Date.now() - started,
    asOfLabel: '네이버 금융 관리·거래정지·경보 목록 (KRX 지정 현황)',
    counts,
    total: stocks.length,
    stocks,
    byCode: stocks.reduce((acc, s) => {
      acc[s.code] = s;
      return acc;
    }, {}),
    sources,
    errors,
    note:
      '투자주의·투자경고·투자위험·거래정지는 네이버 금융이 KRX 지정 현황을 정리해 내려주는 공식 목록입니다. ' +
      '일봉 5일/20일 누적 등락률로 계산한 단기과열 배지는 이 목록과 별개(계산값)입니다.',
  };
}

async function handleAlerts(res, fresh) {
  if (!fresh && alertCache.body && Date.now() - alertCache.at < ALERT_MEM_TTL_MS) {
    res.setHeader('X-Cache', 'HIT-memory');
    return sendJson(res, 200, alertCache.body, ALERT_CACHE_CONTROL);
  }
  try {
    const body = await buildAlertsBody();
    alertCache.at = Date.now();
    alertCache.body = body;
    res.setHeader('X-Cache', 'MISS');
    return sendJson(res, 200, body, ALERT_CACHE_CONTROL);
  } catch (e) {
    if (alertCache.body) {
      res.setHeader('X-Cache', 'STALE');
      return sendJson(res, 200, { ...alertCache.body, stale: true, error: String(e.message) }, 'no-store');
    }
    return sendJson(
      res,
      502,
      { ok: false, mode: 'alerts', reason: 'upstream_failed', message: String(e.message) },
      'no-store',
    );
  }
}

/* ------------------------- 한국투자증권(KIS) 공식 시세 ------------------------- */
/**
 * 네이버 시세에 KIS 공식 시세(FHKST01010100)를 교차 보강한다.
 *  · 표시값 판단 규칙(브리프: "KIS 우선, 실패 시 네이버 폴백, 장전 0% 가드 유지")
 *      ① 네이버에 시세가 없으면 → KIS 값 사용
 *      ② KIS에 당일 체결 근거(거래량·대금 > 0)가 없으면 → 네이버 값 유지(장전 0.00% 덮어쓰기 금지)
 *      ③ 둘 다 있으면 → KIS 우선. 단 괴리가 3%를 넘으면 네이버 유지(이상치 방어)
 *  · 통합(KRX+NXT)·시간외 대금은 KIS 'J'(KRX)로는 나오지 않으므로 네이버 값을 그대로 둔다.
 */
const KIS_BUDGET_MS = 3500;
const KIS_CONCURRENCY = 3;
const KIS_DIFF_GUARD_PCT = 3;
// 한 번에 KIS로 묻는 종목 수 상한 — 전략핀·수급 화면은 40종목까지 보내는데,
// 전부 KIS로 찌르면 초당 제한(EGW00201)에 걸리고 응답도 느려진다. 초과분은 네이버 값 유지.
const KIS_MAX_CODES = 24;

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function mergeKisQuote(st, kq, opts) {
  const out = { ...st };
  out.kis = {
    price: kq.price,
    change: kq.change,
    changePct: kq.changePct,
    prevClose: kq.prevClose,
    open: kq.open,
    high: kq.high,
    low: kq.low,
    volume: kq.volume,
    tradeAmount: kq.tradeAmount,
    tradeAmountText: formatKoreanMoney(kq.tradeAmount),
    hasTrade: kq.hasTrade,
    marketDiv: kq.marketDiv || 'J',
    tempStop: kq.tempStop,
    vi: kq.vi,
    marketWarn: kq.marketWarn,
    w52High: kq.w52High,
    w52Low: kq.w52Low,
    asOf: kq.fetchedAt || null,
    source: 'kis',
  };

  const naverOk = typeof st.price === 'number' && st.price > 0;
  const kisOk = typeof kq.price === 'number' && kq.price > 0;
  const naverTraded = typeof st.volume === 'number' && st.volume > 0;
  let use = false;
  let reason = null;

  if (!kisOk) {
    reason = 'kis-no-price';
  } else if (opts && opts.force) {
    use = true;
    reason = 'forced';
  } else if (!naverOk) {
    use = true;
    reason = 'naver-missing';
  } else if (!kq.hasTrade && !naverTraded) {
    use = false;
    reason = 'preopen-no-trade-both';
  } else if (!kq.hasTrade) {
    use = false;
    reason = 'preopen-guard'; // 장전·휴장: KIS 0.00%로 확정값을 덮지 않는다
  } else if (naverOk && Math.abs(kq.price - st.price) / st.price * 100 > KIS_DIFF_GUARD_PCT) {
    use = false;
    reason = `diff>${KIS_DIFF_GUARD_PCT}%`;
  } else {
    use = true;
    reason = 'kis-primary';
  }

  out.kisDecision = reason;
  out.priceSource = use ? 'kis' : 'naver-polling';
  if (naverOk) {
    out.kisDiffPct = kq.price ? Number((((st.price - kq.price) / kq.price) * 100).toFixed(2)) : null;
  }

  if (!use) return out;

  // 수치만 KIS 공식값으로 교체하고, NXT 통합 대금·시장상태 같은 네이버 전용 필드는 보존
  out.price = kq.price;
  out.change = kq.change;
  out.changePct = kq.changePct;
  out.prevClose = kq.prevClose;
  out.open = kq.open;
  out.high = kq.high;
  out.low = kq.low;
  out.volume = kq.volume;
  out.source = 'kis';
  out.changeBasis = 'kis-official(FHKST01010100) · 전일 종가 기준';
  if (!out.name && kq.name) out.name = kq.name;
  if (typeof st.value !== 'number' && typeof kq.tradeAmount === 'number') {
    out.value = kq.tradeAmount;
    out.valueText = formatKoreanMoney(kq.tradeAmount);
    out.valueRegular = kq.tradeAmount;
    out.valueRegularText = formatKoreanMoney(kq.tradeAmount);
    out.valueBasis = '정규장(KIS)';
  }
  return out;
}

async function enrichWithKis(stocks, codes, opts = {}) {
  const started = Date.now();
  const targets = codes.slice(0, KIS_MAX_CODES);
  const summary = {
    enabled: true,
    configured: kis.isConfigured(),
    tokenVia: null,
    attempted: targets.length,
    skipped: Math.max(0, codes.length - targets.length),
    quoted: 0,
    applied: 0,
    rateLimited: false,
    elapsedMs: 0,
    errors: [],
    quotes: {},
  };

  if (!summary.configured) {
    summary.enabled = false;
    summary.error = 'KIS_APP_KEY/KIS_APP_SECRET 미설정 — 네이버 단독 모드';
    return { stocks, summary };
  }

  try {
    const token = await withTimeout(kis.getKisToken(), KIS_BUDGET_MS, 'kis-token');
    summary.tokenVia = token.via;
  } catch (e) {
    summary.enabled = false;
    summary.error = `토큰 실패: ${e && e.message}`;
    summary.errors.push({ stage: 'token', code: (e && e.code) || null, message: String((e && e.message) || e) });
    summary.elapsedMs = Date.now() - started;
    return { stocks, summary };
  }

  let fetched;
  try {
    fetched = await withTimeout(
      kis.fetchKisQuotes(targets, { concurrency: KIS_CONCURRENCY }),
      KIS_BUDGET_MS,
      'kis-quotes',
    );
  } catch (e) {
    summary.errors.push({ stage: 'quote', code: (e && e.code) || null, message: String((e && e.message) || e) });
    summary.elapsedMs = Date.now() - started;
    summary.timeout = true;
    return { stocks, summary };
  }

  summary.quoted = Object.keys(fetched.quotes || {}).length;
  summary.rateLimited = Boolean(fetched.rateLimited);
  summary.errors.push(...(fetched.errors || []));
  summary.quotes = fetched.quotes || {};

  // 네이버가 통째로 실패했을 때는 KIS 공식 시세만으로 명부를 세운다(빈 화면 방지)
  if (!stocks.length && summary.quoted > 0) {
    const synth = targets
      .map((c) => summary.quotes[c])
      .filter(Boolean)
      .map((kq) => ({
        code: kq.code,
        name: kq.name,
        market: null,
        price: kq.price,
        change: kq.change,
        changePct: kq.changePct,
        open: kq.open,
        high: kq.high,
        low: kq.low,
        prevClose: kq.prevClose,
        volume: kq.volume,
        value: kq.tradeAmount,
        valueText: formatKoreanMoney(kq.tradeAmount),
        valueRegular: kq.tradeAmount,
        valueInteg: null,
        valueBasis: '정규장(KIS)',
        tradedAt: null,
        changeBasis: 'kis-official(FHKST01010100)',
        kisDecision: 'kis-only-fallback',
        priceSource: 'kis',
        source: 'kis',
        kis: {
          price: kq.price,
          changePct: kq.changePct,
          tradeAmount: kq.tradeAmount,
          hasTrade: kq.hasTrade,
          marketDiv: kq.marketDiv || 'J',
          asOf: kq.fetchedAt || null,
          source: 'kis',
        },
      }));
    summary.applied = synth.length;
    summary.fallback = 'kis-only';
    summary.elapsedMs = Date.now() - started;
    return { stocks: synth, summary };
  }

  const merged = stocks.map((st) => {
    const kq = summary.quotes[st.code];
    if (!kq) return st;
    const next = mergeKisQuote(st, kq, opts);
    if (next.source === 'kis') summary.applied += 1;
    return next;
  });

  summary.elapsedMs = Date.now() - started;
  return { stocks: merged, summary };
}

/* --------------------------- ?kis_test=1 진단 --------------------------- */
const kisTestCache = { at: 0, body: null };
const KIS_TEST_TTL_MS = 15000;

async function buildKisTestBody(q) {
  const started = Date.now();
  const body = {
    ok: false,
    mode: 'kis-test',
    generatedAt: new Date().toISOString(),
    generatedAtKst: kstLabel(new Date()),
    configured: kis.isConfigured(),
    tokenOk: false,
    token: null,
    price: null,
    changePct: null,
    tradeAmount: null,
    source: null,
    quote: null,
    investor: null,
    naverCrossCheck: null,
    errors: [],
    elapsedMs: 0,
  };

  const health = kis.kisHealth();
  body.libVersion = kis.LIB_VERSION;
  body.baseUrlHost = health.baseUrlHost;
  body.appKeyKid = health.appKeyKid;
  body.elapsedBase = health.lastTokenError || null;

  if (!body.configured) {
    body.errors.push({ stage: 'config', message: 'KIS_APP_KEY / KIS_APP_SECRET 환경변수가 없습니다.' });
    body.elapsedMs = Date.now() - started;
    return body;
  }

  // ① 토큰
  try {
    const t = await withTimeout(kis.getKisToken(), 9000, 'kis-token');
    body.tokenOk = true;
    body.token = {
      ok: true,
      via: t.via, // memory | supabase | issued ...
      issuedAt: t.issuedAt ? new Date(t.issuedAt).toISOString() : null,
      issuedAtKst: t.issuedAt ? kstLabel(t.issuedAt) : null,
      expiresAt: new Date(t.expiresAt).toISOString(),
      expiresAtKst: kstLabel(t.expiresAt),
      minutesLeft: Math.round((t.expiresAt - Date.now()) / 60000),
    };
  } catch (e) {
    body.token = { ok: false, code: (e && e.code) || null, message: String((e && e.message) || e) };
    body.errors.push({ stage: 'token', code: (e && e.code) || null, message: String((e && e.message) || e) });
    body.elapsedMs = Date.now() - started;
    return body;
  }

  // ② 삼성전자 공식 시세 (요청 종목이 있으면 그 종목 우선)
  const code = /^\d{6}$/.test(String(q.code || '')) ? String(q.code) : '005930';
  body.code = code;
  try {
    const kq = await withTimeout(kis.fetchKisQuote(code, { raw: q.raw === '1' }), 9000, 'kis-quote');
    body.quote = {
      code: kq.code,
      name: kq.name,
      sector: kq.sector,
      price: kq.price,
      change: kq.change,
      changePct: kq.changePct,
      prevClose: kq.prevClose,
      open: kq.open,
      high: kq.high,
      low: kq.low,
      volume: kq.volume,
      tradeAmount: kq.tradeAmount,
      tradeAmountText: formatKoreanMoney(kq.tradeAmount),
      hasTrade: kq.hasTrade,
      marketDiv: kq.marketDiv,
      tempStop: kq.tempStop,
      vi: kq.vi,
      asOf: kq.fetchedAt,
      source: 'kis',
    };
    if (q.raw === '1') body.rawQuote = kq.raw || null;
    body.price = kq.price;
    body.changePct = kq.changePct;
    body.tradeAmount = kq.tradeAmount;
    body.source = 'kis';
  } catch (e) {
    body.errors.push({ stage: 'quote', code: (e && e.code) || null, msgCd: (e && e.msgCd) || null, message: String((e && e.message) || e) });
  }

  // ③ 네이버 교차 확인 (같은 종목)
  try {
    const rows = await fetchStocks([code]);
    const nv = rows && rows[0] ? rows[0] : null;
    if (nv) {
      const diffPct =
        body.price && nv.price ? Number((((nv.price - body.price) / body.price) * 100).toFixed(2)) : null;
      body.naverCrossCheck = {
        price: nv.price,
        changePct: nv.changePct,
        volume: nv.volume,
        diffPctVsKis: diffPct,
        agreeWithin1Pct: diffPct === null ? null : Math.abs(diffPct) <= 1,
        source: nv.source,
      };
    }
  } catch (e) {
    body.naverCrossCheck = { ok: false, message: String((e && e.message) || e) };
  }

  // ④ 수급(FHKST01010900) — 당일치는 장 종료 후 확정
  if (q.investor !== '0') {
    try {
      const inv = await withTimeout(kis.fetchKisInvestor(code, {}), 9000, 'kis-investor');
      body.investor = {
        ok: true,
        confirmedDate: inv.confirmedDate,
        isTodayConfirmed: inv.isTodayConfirmed,
        latest: inv.latestConfirmed || inv.latest,
        todayRow: inv.latest,
        recent: inv.recent,
        source: 'kis',
      };
    } catch (e) {
      body.investor = { ok: false, code: (e && e.code) || null, message: String((e && e.message) || e) };
      body.errors.push({ stage: 'investor', code: (e && e.code) || null, message: String((e && e.message) || e) });
    }
  }

  body.ok = Boolean(body.tokenOk && body.quote && body.quote.price);
  body.hint =
    'KIS 공식 API 진단입니다. 토큰은 재사용 캐시(메모리→Supabase 공용)를 먼저 보고, 없을 때만 1분 1회 제한 안에서 발급합니다. ' +
    '당일 수급 확정치는 장 종료 후에만 나오므로 confirmedDate 를 반드시 함께 보세요.';
  body.elapsedMs = Date.now() - started;
  return body;
}

async function handleKisTest(res, q, fresh) {
  const bypass = q.raw === '1'; // raw 진단은 항상 새로 받는다
  if (!fresh && !bypass && kisTestCache.body && Date.now() - kisTestCache.at < KIS_TEST_TTL_MS) {
    res.setHeader('X-Cache', 'HIT-memory');
    return sendJson(res, 200, { ...kisTestCache.body, cached: true }, 'no-store');
  }
  try {
    const body = await buildKisTestBody(q || {});
    kisTestCache.at = Date.now();
    kisTestCache.body = body;
    res.setHeader('X-Cache', 'MISS');
    return sendJson(res, 200, body, 'no-store');
  } catch (e) {
    return sendJson(
      res,
      200,
      {
        ok: false,
        mode: 'kis-test',
        configured: kis.isConfigured(),
        tokenOk: false,
        errors: [{ stage: 'unexpected', message: String((e && e.message) || e) }],
        generatedAt: new Date().toISOString(),
      },
      'no-store',
    );
  }
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

  // ?mode=alerts — 공식 시장경보 목록 (서버리스 함수 수를 늘리지 않기 위한 내부 라우트)
  if (q.mode === 'alerts') return handleAlerts(res, fresh);

  // ?kis_test=1 — KIS(한국투자증권) 공식 API 연동 진단 (토큰·시세·수급)
  if (q.kis_test === '1') return handleKisTest(res, q, fresh);

  const codeList = (q.codes || q.code || '')
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
    macro: fetchMacro(),
  };

  // 환율은 네이버가 실패하면 Yahoo로 대체
  const [indicesR, stocksR, fxR, futuresR, macroR] = await Promise.allSettled([
    tasks.indices,
    tasks.stocks,
    tasks.fxNaver,
    tasks.futures,
    tasks.macro,
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
  collect('yahoo-macro', macroR);
  if (futuresR.status === 'fulfilled' && futuresR.value.errors.length) {
    errors.push(...futuresR.value.errors);
  }
  if (macroR.status === 'fulfilled' && macroR.value.errors.length) {
    errors.push(...macroR.value.errors);
  }
  if (fxError) errors.push(`fx: ${fxError}`);

  const indices = indicesR.status === 'fulfilled' ? indicesR.value : [];
  let stocks = stocksR.status === 'fulfilled' ? stocksR.value : [];
  const futures = futuresR.status === 'fulfilled' ? futuresR.value.futures : [];
  const macro = macroR.status === 'fulfilled' ? macroR.value.macro : {};

  // KIS 공식 시세 — 기본은 요청 종목 1개(?code=)에서만 쓴다.
  //  · 실측(Vercel→KIS 왕복 ~700ms, 초당 20건 제한) 결과 13~40종목 배치에 기본 적용하면
  //    시세 응답이 3초 이상 느려지고 EGW00201 이 잦아진다 → 배치는 ?kis=1 로 명시할 때만.
  //  · ?kis=0 끄기 · ?kis=1 배치 교차보강 · ?kis=force 장전 가드 무시
  const singleCode = /^\d{6}$/.test(String(q.code || ''));
  const kisOptIn = q.kis === '1' || q.kis === 'force';
  let kisSummary = null;
  if (q.kis !== '0' && (singleCode || kisOptIn)) {
    const enriched = await enrichWithKis(stocks, codes, { force: q.kis === 'force' });
    stocks = enriched.stocks;
    kisSummary = enriched.summary;
    if (kisSummary && kisSummary.applied > 0) {
      sources.push({ name: 'kis-official', ok: true, count: kisSummary.applied });
    }
  }

  const stockRows = stocks.map((s) => {
    const known = DEFAULT_STOCKS.find((d) => d.code === s.code);
    return known ? { ...s, label: known.name } : s;
  });

  const body = {
    ok: indices.length > 0 || stocks.length > 0,
    generatedAt: new Date().toISOString(),
    generatedAtKst: kstLabel(new Date()),
    elapsedMs: Date.now() - started,
    marketStatus: stocks[0] ? stocks[0].marketStatus : null,
    indices,
    fx,
    futures,
    macro,
    stocks: stockRows,
    sources,
    errors,
  };

  if (kisSummary) {
    body.kis = {
      enabled: kisSummary.enabled,
      configured: kisSummary.configured,
      tokenVia: kisSummary.tokenVia,
      attempted: kisSummary.attempted,
      skipped: kisSummary.skipped,
      quoted: kisSummary.quoted,
      applied: kisSummary.applied,
      rateLimited: Boolean(kisSummary.rateLimited),
      timeout: Boolean(kisSummary.timeout),
      elapsedMs: kisSummary.elapsedMs,
      error: kisSummary.error || null,
      errors: (kisSummary.errors || []).slice(0, 5),
      errorCount: (kisSummary.errors || []).length,
    };
  }

  // ?code=005930 처럼 단일 종목을 직접 물을 때 그 종목을 최상위에 그대로 꺼내 준다
  if (/^\d{6}$/.test(String(q.code || ''))) {
    const one = stockRows.find((s) => s.code === q.code) || null;
    body.stock = one;
    body.kisQuote = (kisSummary && kisSummary.quotes && kisSummary.quotes[q.code]) || null;
    body.source = one ? one.source : null;
  }

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
