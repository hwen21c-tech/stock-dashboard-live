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
  fetchBuffer,
  decodeEucKr,
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

/* -------------------- 종목명 → 종목코드 (네이버 자동완성) --------------------
 *  네이버 polling API 는 6자리 코드만 받는다. 이름으로 물으면 조용히 '기본 종목'을
 *  돌려주기 때문에, 이름 입력은 여기서 코드로 먼저 바꾼 뒤 시세를 조회한다.
 *  · 정확히 같은 이름만 인정한다(부분 일치로 다른 종목을 보여주지 않는다).
 *  · 실패는 null 로 남기고 화면은 '종목을 찾지 못했습니다'로 안내한다. */
const nameCodeCache = new Map();
async function resolveStockCode(name) {
  const key = String(name || '').replace(/\s+/g, ' ').trim();
  if (!key) return null;
  if (/^\d{6}$/.test(key)) return key;
  if (nameCodeCache.has(key)) return nameCodeCache.get(key);
  let code = null;
  try {
    const d = await fetchJson(
      'https://m.stock.naver.com/front-api/search/autoComplete?query=' +
        encodeURIComponent(key) +
        '&target=stock',
      { headers: NAVER_HEADERS, timeout: 5000 },
    );
    const items = (d && d.result && d.result.items) || [];
    const norm = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();
    const hit = items.find(
      (it) =>
        it &&
        it.category === 'stock' &&
        /^\d{6}$/.test(String(it.code || '')) &&
        norm(it.name) === norm(key),
    );
    code = hit ? String(hit.code) : null;
  } catch (e) {
    code = null;
  }
  nameCodeCache.set(key, code);
  if (nameCodeCache.size > 500) {
    const oldest = nameCodeCache.keys().next();
    if (!oldest.done) nameCodeCache.delete(oldest.value);
  }
  return code;
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
/**
 * 통합 거래대금 표기 — `589억(NXT 445억)` / NXT 체결이 없으면 `589억`.
 *  (2026-11-20 09:20 마녀공장 실측: KRX 144억 + NXT 445억 = 통합 589억)
 */
function valueLabelText(total, nxt) {
  const t = formatKoreanMoney(total);
  if (!t) return null;
  if (typeof nxt === 'number' && nxt > 0) {
    const n = formatKoreanMoney(nxt);
    if (n) return t + '(NXT ' + n + ')';
  }
  return t;
}

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
  /* 통합 = integratedPriceInfo · KRX 정규장 = 최상위 · NXT = overMarketPriceInfo (실측 3분할)
   *  · KRX 단독이 통합보다 큰 순간 응답(체결 시차)이 오면 통합을 KRX 로 올리고 NXT 는 0으로 둔다 */
  const valueTotal =
    valueInteg !== null && valueRaw !== null ? Math.max(valueInteg, valueRaw) : valueInteg !== null ? valueInteg : valueRaw;
  let valueNxt =
    valueAfter !== null ? valueAfter : valueInteg !== null && valueRaw !== null ? valueInteg - valueRaw : null;
  if (typeof valueNxt !== 'number' || !(valueNxt > 0)) valueNxt = 0;
  if (valueTotal !== null && valueNxt >= valueTotal) valueNxt = 0;
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
    valueTotal,
    valueTotalText: formatKoreanMoney(valueTotal),
    valueNxt: valueNxt || null,
    valueNxtText: valueNxt > 0 ? formatKoreanMoney(valueNxt) : null,
    /* 화면 표기용 — '589억(NXT 445억)' / NXT 없으면 '589억' (통합 기준) */
    valueDispText: valueLabelText(valueTotal, valueNxt),
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

async function handleAlerts(res, fresh, q) {
  /* ?code=6자리 — 체커용: 같은 공식 목록에서 이 종목 한 줄만 돌려준다(응답 71KB → 수백 B).
     목록 자체는 그대로 실측 전체이고, 화면에는 '이 종목이 지정돼 있는지'만 쓰인다. */
  const only = /^\d{6}$/.test(String((q && q.code) || '').trim()) ? String(q.code).trim() : null;
  const shape = (body) => {
    if (!only) return body;
    const row = (body.byCode && body.byCode[only]) || null;
    return {
      ...body,
      total: row ? 1 : 0,
      stocks: row ? [row] : [],
      byCode: row ? { [only]: row } : {},
      stock: row,
      filteredCode: only,
    };
  };
  if (!fresh && alertCache.body && Date.now() - alertCache.at < ALERT_MEM_TTL_MS) {
    res.setHeader('X-Cache', 'HIT-memory');
    return sendJson(res, 200, shape(alertCache.body), ALERT_CACHE_CONTROL);
  }
  try {
    const body = await buildAlertsBody();
    alertCache.at = Date.now();
    alertCache.body = body;
    res.setHeader('X-Cache', 'MISS');
    return sendJson(res, 200, shape(body), ALERT_CACHE_CONTROL);
  } catch (e) {
    if (alertCache.body) {
      res.setHeader('X-Cache', 'STALE');
      return sendJson(res, 200, { ...shape(alertCache.body), stale: true, error: String(e.message) }, 'no-store');
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
const KIS_PER_CALL_MS = 2200;
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
    out.valueTotal = kq.tradeAmount;
    out.valueTotalText = formatKoreanMoney(kq.tradeAmount);
    out.valueNxt = 0;
    out.valueNxtText = null;
    out.valueDispText = valueLabelText(kq.tradeAmount, 0);
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
    fetched = await kis.fetchKisQuotes(targets, {
      concurrency: KIS_CONCURRENCY,
      timeout: KIS_PER_CALL_MS,
      deadline: started + KIS_BUDGET_MS,
      waveMinMs: 900,
    });
  } catch (e) {
    summary.errors.push({ stage: 'quote', code: (e && e.code) || null, message: String((e && e.message) || e) });
    summary.elapsedMs = Date.now() - started;
    summary.timeout = true;
    return { stocks, summary };
  }

  summary.quoted = Object.keys(fetched.quotes || {}).length;
  summary.rateLimited = Boolean(fetched.rateLimited);
  summary.truncated = Boolean(fetched.truncated);
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
        valueTotal: kq.tradeAmount,
        valueTotalText: formatKoreanMoney(kq.tradeAmount),
        valueNxt: 0,
        valueNxtText: null,
        valueDispText: valueLabelText(kq.tradeAmount, 0),
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

/* ------------------- 종목별 최신 뉴스 (?code=005930&news=1) ------------------- */
/**
 * 관제탑 종목 모달 하단의 '📰 관련 최신 뉴스' 전용 라우트.
 *  · Vercel Hobby 함수 12개 한도가 꽉 차 있어 새 api/*.js 를 만들지 않고 여기에 news=1 로 붙인다.
 *  · 소스: 네이버 증권 모바일 종목 뉴스 API (m.stock.naver.com/api/news/stock/{code})
 *    → 기사마다 {total, items:[…]} 그룹으로 내려오므로 items 를 펼쳐 최신순으로 정렬한다.
 *  · 제목·시각·언론사·링크만 그대로 옮긴다. 없는 뉴스는 만들지 않는다(news: [] + message).
 */
const NEWS_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=120';
const NEWS_TTL_MS = 60000;
const NEWS_MAX = 5;
const newsCache = new Map();

function decodeNewsEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 'YYYYMMDDHHMM' → { date:'YYYY-MM-DD', time:'HH:MM', isToday } (KST 기준) */
function parseNewsStamp(raw) {
  const m = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return { date: null, time: null, isToday: false };
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const time = `${m[4]}:${m[5]}`;
  const now = new Date(Date.now() + 9 * 3600 * 1000); // KST
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  return { date, time, isToday: date === today };
}

async function fetchStockNews(code, limit) {
  const url = `https://m.stock.naver.com/api/news/stock/${code}?pageSize=20&page=1`;
  const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: 6000 });
  const groups = Array.isArray(data) ? data : data && data.items ? [data] : [];
  const flat = [];
  for (const g of groups) {
    for (const it of (g && g.items) || []) {
      if (it && it.title) flat.push(it);
    }
  }
  const seen = new Set();
  const rows = [];
  for (const it of flat) {
    const key = String(it.id || `${it.officeId}-${it.articleId}` || it.title);
    if (seen.has(key)) continue;
    seen.add(key);
    const stamp = parseNewsStamp(it.datetime);
    rows.push({
      title: decodeNewsEntities(it.titleFull || it.title),
      press: it.officeName || null,
      datetime: String(it.datetime || ''),
      date: stamp.date,
      time: stamp.time,
      isToday: stamp.isToday,
      url:
        it.mobileNewsUrl ||
        (it.officeId && it.articleId ? `https://n.news.naver.com/mnews/article/${it.officeId}/${it.articleId}` : null),
      source: 'naver-stock-news',
    });
  }
  rows.sort((a, b) => String(b.datetime).localeCompare(String(a.datetime)));
  const todayRows = rows.filter((r) => r.isToday);
  return {
    code,
    news: (todayRows.length ? todayRows : rows).slice(0, limit || NEWS_MAX),
    todayCount: todayRows.length,
    total: rows.length,
    basis: todayRows.length ? '당일 뉴스' : '최근 뉴스(당일 없음)',
    source: 'naver-stock-news',
  };
}

async function handleStockNews(res, q, fresh) {
  const code = String(q.code || '').trim();
  const generatedAtKst = kstLabel(new Date());
  if (!/^\d{6}$/.test(code)) {
    return sendJson(
      res,
      400,
      { ok: false, reason: 'bad_code', message: 'code=6자리 종목코드가 필요합니다.', news: [], generatedAtKst },
      'no-store',
    );
  }
  const key = `news:${code}`;
  if (!fresh) {
    const hit = newsCache.get(key);
    if (hit && Date.now() - hit.at < NEWS_TTL_MS) {
      res.setHeader('X-Cache', 'HIT-memory');
      return sendJson(res, 200, { ...hit.value, cached: true }, NEWS_CACHE_CONTROL);
    }
  }
  try {
    const out = await fetchStockNews(code);
    const body = {
      ok: true,
      mode: 'stock-news',
      ...out,
      message: out.news.length ? null : '최근 관련 속보 없음',
      generatedAt: new Date().toISOString(),
      generatedAtKst,
    };
    newsCache.set(key, { at: Date.now(), value: body });
    if (newsCache.size > 200) {
      const oldest = newsCache.keys().next();
      if (!oldest.done) newsCache.delete(oldest.value);
    }
    res.setHeader('X-Cache', 'MISS');
    return sendJson(res, 200, body, NEWS_CACHE_CONTROL);
  } catch (e) {
    return sendJson(
      res,
      200,
      {
        ok: false,
        mode: 'stock-news',
        code,
        news: [],
        message: '뉴스 조회 실패',
        error: String((e && e.message) || e),
        generatedAtKst,
      },
      'no-store',
    );
  }
}

/* ==========================================================================
 * 종목 소속 테마 · 오늘 테마 신호등 · 최근/과거 재료  (?mode=theme&code=005930)
 * --------------------------------------------------------------------------
 *  · 종목→테마 역색인은 public/data/theme-membership.json (scripts/build_theme_membership.py 가 생성).
 *    네이버는 '테마→구성종목'만 주므로, 전체 테마를 한 번 훑어 역색인을 만들어 둔다(구성은 자주 안 바뀜).
 *  · 오늘의 테마 순위·등락률은 네이버 테마 랭킹 실측(전체 N개)을 그대로 읽어 계산한다(값을 만들지 않음).
 *  · 신호등 규칙(화면에도 같은 문구를 적는다)
 *      · 관제탑 직전 거래일 주도 테마 Top8 에 든 테마면 그 순위로 판정(관제탑 데이터와 대조).
 *      🟢 주요 주도테마 : 순위 10위 이내이면서 (테마 평균 +1% 이상 또는 테마 상위4 평균 +3% 이상)
 *      🟡 순환·관심 테마 : 순위 30위 이내이거나 테마 평균 +1% 이상 또는 상위4 평균 0% 이상
 *      ⚪ 비주류·개별주 : 그 밖
 *  · 테마 점수(0~100) = 순위 백분위 40% + 테마 강도(상위4 평균 등락률) 60% — 구성값도 함께 내려준다.
 *  · 장전(PREOPEN)·주말처럼 랭킹이 전부 0.00% 면 직전 거래일 주도 테마 파일로 판정하고 basis 에 밝힌다.
 *  · 재료는 네이버 종목뉴스 실측만 쓴다(제목·언론사·시각·링크). 지어낸 해석은 넣지 않는다.
 *  · 캐시: 인스턴스 메모리 90초 + CDN public, s-maxage=120, stale-while-revalidate=300
 * ========================================================================== */
const THEME_CACHE_CONTROL = 'public, s-maxage=120, stale-while-revalidate=300';
const THEME_LIST_URL = 'https://m.stock.naver.com/api/stocks/theme';
const THEME_DETAIL_URL = 'https://m.stock.naver.com/api/stocks/theme/';
const THEME_EXCLUDE_RE = /(스팩|SPAC|우선주|ETF|ETN|리츠|인버스|레버리지)/i;
const THEME_RANK_TTL_MS = 180000;
const themeCache = new Map();

/* 종목→테마 색인 (배포 산출물 public/data 에 포함) */
let THEME_MEMBER = null;
try {
  THEME_MEMBER = require('../public/data/theme-membership.json');
} catch (e) {
  THEME_MEMBER = null;
}
/* 직전 거래일 장마감 기준 주도 테마 Top 8 (장전·주말 폴백) */
let THEME_PREV = null;
try {
  THEME_PREV = require('../public/data/last-dynamic-themes.json');
} catch (e) {
  THEME_PREV = null;
}

let THEME_RANK_MEM = { at: 0, rows: null, total: 0, marketStatus: null };

/** 네이버 테마 랭킹 전체(약 265개) — 100개씩 3페이지. 3분 메모리 캐시. */
async function fetchThemeRanking(fresh) {
  if (!fresh && THEME_RANK_MEM.rows && Date.now() - THEME_RANK_MEM.at < THEME_RANK_TTL_MS) {
    return { ...THEME_RANK_MEM, cached: true };
  }
  const groups = [];
  let total = 0;
  let marketStatus = null;
  for (let page = 1; page <= 3; page += 1) {
    const d = await fetchJson(`${THEME_LIST_URL}?page=${page}&pageSize=100`, {
      headers: NAVER_HEADERS,
      timeout: 6000,
    });
    const g = (d && d.groups) || [];
    if (d && d.marketStatus) marketStatus = d.marketStatus;
    const t = parseNum(d && d.totalCount);
    if (t) total = t;
    groups.push(...g);
    if (!g.length || groups.length >= total) break;
  }
  const rows = groups
    .map((g) => {
      const cnt = parseNum(g.totalCount) || 0;
      const rise = parseNum(g.riseCount) || 0;
      return {
        no: parseNum(g.no),
        name: String(g.name || '').replace(/\s+/g, ' ').trim(),
        changeRate: parseNum(g.changeRate),
        riseCount: rise,
        fallCount: parseNum(g.fallCount) || 0,
        totalCount: cnt,
        riseRatio: cnt ? Number(((rise / cnt) * 100).toFixed(1)) : null,
      };
    })
    .filter((g) => g.no && g.name && !THEME_EXCLUDE_RE.test(g.name) && typeof g.changeRate === 'number')
    .sort((a, b) => b.changeRate - a.changeRate || (b.riseRatio || 0) - (a.riseRatio || 0));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  THEME_RANK_MEM = { at: Date.now(), rows, total: rows.length, marketStatus };
  return { ...THEME_RANK_MEM, cached: false };
}

function themeKey(name) {
  return String(name || '')
    .replace(/\([^)]*\)/g, '')
    .replace(/(테마|관련|수혜|급등|신규)/g, '')
    .replace(/[\s·\-_/]/g, '')
    .toLowerCase();
}

/* 테마 상위 4종목 평균 등락률 — 네이버 테마 상세의 종목별 등락률(fluctuationsRatio) 실측.
 *  관제탑 주도테마맵이 쓰는 '노출 상위 4종목 평균'과 같은 재료를, 이 종목의 테마에 대해서만 계산한다. */
function themeTop4Avg(detail) {
  const stocks = (detail && detail.stocks) || [];
  const pcts = stocks
    .map((s) => parseNum(s && s.fluctuationsRatio))
    .filter((v) => typeof v === 'number')
    .sort((a, b) => b - a)
    .slice(0, 4);
  if (!pcts.length) return null;
  return Number((pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2));
}

/**
 * 테마 신호등 — 화면에 같은 규칙 문구를 적는다.
 *  · 관제탑 직전 거래일 주도 테마 Top8에 든 테마면 그 순위로 판정(관제탑 데이터와 대조).
 *  · 아니면 네이버 테마 랭킹 실측(전체 N개) 순위 + 테마 상위4 평균으로 판정.
 *      🟢 주요 주도테마 : 순위 10위 이내이면서 (테마 평균 +1% 이상 또는 상위4 평균 +3% 이상)
 *      🟡 순환·관심 테마 : 순위 30위 이내이거나 테마 평균 +1% 이상 또는 상위4 평균 0% 이상
 *      ⚪ 비주류·개별주 : 그 밖
 */
function themeSignal(ctx) {
  const rank = Number(ctx.rank) || null;
  const total = Number(ctx.total) || null;
  const c = Number(ctx.changeRate);
  const t4 = Number(ctx.top4Avg);
  const prev = Number(ctx.prevTopRank) || null;
  if (ctx.prevExposed && prev) {
    return {
      key: 'green',
      label: '🟢 주요 주도테마',
      note: '직전 거래일 주도 테마 Top8 ' + prev + '위 · 노출 종목',
      basis: 'prev-day-top8',
    };
  }
  if (rank && rank <= 10 && ((isFinite(c) && c >= 1) || (isFinite(t4) && t4 >= 3))) {
    return { key: 'green', label: '🟢 주요 주도테마', note: '테마 순위 ' + rank + '/' + total + '위', basis: 'live-rank' };
  }
  if ((rank && rank <= 30) || (isFinite(c) && c >= 1) || (isFinite(t4) && t4 >= 0)) {
    return {
      key: 'yellow',
      label: '🟡 순환·관심 테마',
      note: rank ? '테마 순위 ' + rank + '/' + total + '위' : '테마 상위4 평균 기준',
      basis: 'live-rank',
    };
  }
  if (rank) return { key: 'gray', label: '⚪ 비주류·개별주', note: '테마 순위 ' + rank + '/' + total + '위', basis: 'live-rank' };
  return { key: 'none', label: '⚪ 확인 불가', note: '테마 순위를 받지 못했습니다', basis: 'none' };
}

/** 테마 점수(0~100) = 순위 백분위 40% + 테마 강도(상위4 평균 등락률) 60% */
function themeScore(ctx) {
  const rank = Number(ctx.rank) || null;
  const total = Number(ctx.total) || null;
  const prev = Number(ctx.prevTopRank) || null;
  let rankScore = null;
  if (rank && total > 1) rankScore = Math.round((1 - (rank - 1) / (total - 1)) * 100);
  else if (prev) rankScore = Math.round((1 - (prev - 1) / 7) * 100);
  const useTop4 = isFinite(Number(ctx.top4Avg));
  const strength = useTop4 ? Number(ctx.top4Avg) : Number(ctx.changeRate);
  const strengthScore = isFinite(strength) ? Math.round(Math.max(0, Math.min(100, 50 + strength * 5))) : null;
  if (rankScore == null || strengthScore == null) return null;
  return {
    score: Math.round(rankScore * 0.4 + strengthScore * 0.6),
    rankScore,
    strengthScore,
    strengthBasis: useTop4 ? 'top4Avg' : 'changeRate',
  };
}

async function handleStockTheme(res, q, fresh) {
  const code = String(q.code || '').trim();
  const generatedAtKst = kstLabel(new Date());
  if (!/^\d{6}$/.test(code)) {
    return sendJson(
      res,
      400,
      { ok: false, reason: 'bad_code', mode: 'stock-theme', message: 'code=6자리 종목코드가 필요합니다.', generatedAtKst },
      'no-store',
    );
  }
  const key = `theme:${code}`;
  if (!fresh) {
    const hit = themeCache.get(key);
    if (hit && Date.now() - hit.at < 90000) {
      res.setHeader('X-Cache', 'HIT-memory');
      return sendJson(res, 200, { ...hit.value, cached: true }, THEME_CACHE_CONTROL);
    }
  }
  if (!THEME_MEMBER || !THEME_MEMBER.byCode) {
    return sendJson(
      res,
      200,
      {
        ok: false,
        reason: 'no_membership',
        mode: 'stock-theme',
        code,
        message: '테마 색인(data/theme-membership.json)이 없어 소속 테마를 확인할 수 없습니다.',
        generatedAtKst,
      },
      'no-store',
    );
  }

  const errors = [];
  const owned = Array.isArray(THEME_MEMBER.byCode[code]) ? THEME_MEMBER.byCode[code] : [];

  let ranking = null;
  try {
    ranking = await fetchThemeRanking(fresh);
  } catch (e) {
    errors.push('테마 랭킹: ' + String((e && e.message) || e));
  }

  /* 장전·주말처럼 오늘 랭킹이 전부 0.00% 인지 — 그때는 직전 거래일 주도 테마로 판정 */
  const allZero = !ranking || !ranking.rows.length || ranking.rows.every((r) => !r.changeRate);
  const prevTop =
    THEME_PREV && Array.isArray(THEME_PREV.themes)
      ? THEME_PREV.themes
          .filter((t) => t && t.name)
          .map((t, i) => ({
            rank: t.rank || i + 1,
            name: t.name,
            top4Avg: t.top4Avg == null ? null : t.top4Avg,
            stocks: (t.stocks || []).map((x) => ({ code: String(x.code || ''), name: x.name || null })),
          }))
      : [];

  const byNo = new Map();
  if (ranking) ranking.rows.forEach((r) => byNo.set(String(r.no), r));

  const themes = owned.map((t) => {
    const live = byNo.get(String(t.no)) || null;
    const prev = prevTop.find((p) => themeKey(p.name) === themeKey(t.name)) || null;
    const prevExposed = Boolean(prev && (prev.stocks || []).some((x) => String(x.code) === code));
    return {
      no: t.no,
      name: t.name,
      rank: live ? live.rank : null,
      total: ranking ? ranking.rows.length : null,
      changeRate: live ? live.changeRate : null,
      riseCount: live ? live.riseCount : null,
      fallCount: live ? live.fallCount : null,
      stockCount: live ? live.totalCount : null,
      riseRatio: live ? live.riseRatio : null,
      prevTopRank: prev ? prev.rank : null,
      prevTopAvg: prev ? prev.top4Avg : null,
      prevExposed,
    };
  });
  /* 대표 테마 후보: 관제탑 직전 거래일 Top8 에 든 테마 → 그다음 오늘 순위가 높은 테마 */
  const order = (t) => [t.prevExposed ? 0 : t.prevTopRank ? 1 : 2, t.prevTopRank || 99, t.rank || 9999];
  const ranked = themes.slice().sort((a, b) => {
    const A = order(a);
    const B = order(b);
    for (let i = 0; i < A.length; i += 1) {
      if (A[i] !== B[i]) return A[i] - B[i];
    }
    return 0;
  });
  const shown = ranked.slice(0, 6);
  const primary = shown[0] || null;

  /* 대표 테마 상세 — 테마 설명 · 이 종목이 그 테마에 들어온 이유 · 상위4 평균 등락률(실측) */
  let description = null;
  let stockNote = null;
  let top4Avg = null;
  let top4 = [];
  if (primary) {
    try {
      const d = await fetchJson(`${THEME_DETAIL_URL}${primary.no}?page=1&pageSize=100`, {
        headers: NAVER_HEADERS,
        timeout: 6000,
      });
      description = (d && d.themeDescription) || null;
      const map = (d && d.themeItemInfoMap) || {};
      stockNote = map[code] || null;
      top4Avg = themeTop4Avg(d);
      top4 = ((d && d.stocks) || [])
        .map((s) => ({
          code: s.itemCode || null,
          name: s.stockName || null,
          changePct: parseNum(s.fluctuationsRatio),
          value: parseNum(s.accumulatedTradingValue),
        }))
        .filter((s) => s.code && typeof s.changePct === 'number')
        .sort((a, b) => b.changePct - a.changePct)
        .slice(0, 4);
    } catch (e) {
      errors.push('테마 상세: ' + String((e && e.message) || e));
    }
    if (top4Avg == null) top4Avg = primary.prevTopAvg;
    primary.top4Avg = top4Avg == null ? null : top4Avg;
  }

  const signal = primary
    ? themeSignal({
        rank: primary.rank,
        total: primary.total,
        changeRate: primary.changeRate == null ? null : primary.changeRate,
        top4Avg,
        prevTopRank: primary.prevTopRank,
        prevExposed: primary.prevExposed,
      })
    : { key: 'gray', label: '⚪ 비주류·개별주', note: '등록된 테마 구성종목에 없음', basis: 'none' };
  const score = primary
    ? themeScore({
        rank: primary.rank,
        total: primary.total,
        changeRate: primary.changeRate,
        top4Avg,
        prevTopRank: primary.prevTopRank,
      })
    : null;

  /* 이 종목의 오늘 등락률(체커가 시세 카드에서 받은 값)과 테마 방향을 비교 — 판정이 아니라 사실 표시 */
  const stockPct = parseNum(q.pct);
  let align = null;
  if (stockPct != null && primary) {
    const pctTxt = (stockPct > 0 ? '+' : '') + stockPct.toFixed(2) + '%';
    const themeStrong = signal.key === 'green' || (isFinite(Number(top4Avg)) && Number(top4Avg) >= 0.5);
    const themeTxt = isFinite(Number(top4Avg)) ? '테마 상위4 평균 ' + (Number(top4Avg) > 0 ? '+' : '') + Number(top4Avg).toFixed(2) + '%' : null;
    if (themeStrong && stockPct < -1) {
      align = {
        key: 'against',
        text: (themeTxt ? themeTxt + '인데 ' : '테마는 강세인데 ') + '이 종목은 ' + pctTxt + ' 역행 — 테마를 따라가지 못했습니다',
      };
    } else if (signal.key === 'gray' && stockPct > 3) {
      align = { key: 'solo', text: '테마는 비주류인데 이 종목만 ' + pctTxt + ' — 개별 재료·수급으로 봐야 합니다' };
    } else if (themeStrong && stockPct > 1) {
      align = { key: 'with', text: (themeTxt || '테마 강세') + ' · 이 종목 ' + pctTxt + ' — 같은 방향' };
    }
  }

  /* 재료 — 네이버 종목뉴스 실측 20건에서 최근/과거를 나눈다(해석·추정 없음) */
  let recent = [];
  let past = [];
  let newsMeta = null;
  try {
    const out = await fetchStockNews(code, 20);
    const all = out.news || [];
    const ageDays = (n) => {
      const raw = String((n && n.datetime) || '');
      const iso = raw.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:00+09:00');
      const t = Date.parse(iso);
      return isFinite(t) ? (Date.now() - t) / 86400000 : null;
    };
    recent = all.slice(0, 3);
    past = all
      .slice(3)
      .filter((n) => {
        const d = ageDays(n);
        return d == null || d >= 1.5;
      })
      .slice(0, 3);
    newsMeta = {
      total: out.total || all.length,
      todayCount: out.todayCount || 0,
      basis: out.basis || null,
      source: 'naver-stock-news',
    };
  } catch (e) {
    errors.push('종목 뉴스: ' + String((e && e.message) || e));
  }

  const body = {
    ok: true,
    mode: 'stock-theme',
    code,
    marketStatus: ranking ? ranking.marketStatus : null,
    basisLabel:
      allZero && prevTop.length
        ? `직전 거래일(${THEME_PREV.shortLabel || THEME_PREV.basisLong || '직전'}) 주도 테마 기준`
        : `네이버 테마 랭킹 실측 · 전체 ${ranking ? ranking.rows.length : 0}개 테마`,
    basis: allZero && prevTop.length ? 'prev-day-dynamic' : 'naver-theme-rank',
    themeTotal: ranking ? ranking.rows.length : null,
    themeCountOwned: owned.length,
    primary,
    themes: shown,
    signal,
    score,
    stockPct: stockPct == null ? null : stockPct,
    align,
    top4,
    description,
    stockNote,
    prevDayTop: prevTop.slice(0, 8),
    prevDayLabel: THEME_PREV ? THEME_PREV.shortLabel || null : null,
    leading: ranking
      ? ranking.rows.slice(0, 5).map((r) => ({ rank: r.rank, name: r.name, changeRate: r.changeRate }))
      : prevTop.slice(0, 5),
    news: { recent, past, ...(newsMeta || {}) },
    membershipAsOf: THEME_MEMBER.updatedAt || null,
    errors,
    generatedAt: new Date().toISOString(),
    generatedAtKst,
  };

  themeCache.set(key, { at: Date.now(), value: body });
  if (themeCache.size > 200) {
    const oldest = themeCache.keys().next();
    if (!oldest.done) themeCache.delete(oldest.value);
  }
  res.setHeader('X-Cache', 'MISS');
  return sendJson(res, 200, body, THEME_CACHE_CONTROL);
}

/* ==========================================================================
 * 🗺️ 테마 히트맵 (?mode=theme_map) · 테마 구성종목 주요순 (?mode=theme_members)
 * 🔎 테마 이름 찾기 (?mode=theme_search)
 * --------------------------------------------------------------------------
 *  · 구성종목·테마 평균은 네이버 증권 테마 상세 실측(/api/stocks/theme/{no})을 그대로 쓴다.
 *    - groupInfo.changeRate = 테마 전체 구성 평균 등락률(네이버 계산값)
 *    - stocks[].accumulatedTradingValue = 그 종목 거래대금(단위 백만원) → /100 하면 '억'
 *  · 값을 만들지 않는다 — 실패한 테마는 목록에서 빼고 errors 에 남긴다.
 *  · Vercel Hobby 함수 12개 한도 때문에 새 api/*.js 를 만들지 않고 이 파일의 mode 로 붙인다.
 * ========================================================================== */
const THEME_MAP_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=180';
const THEME_MAP_TTL_MS = 60000;
const themeMapCache = new Map();

/* 오늘의 테마맵에 세울 대표 테마 — 네이버 테마 번호는 scripts/build_theme_membership.py 산출물 기준.
 *  (화면에 보이는 이름표는 label, 실제 테마명은 네이버 groupInfo.name 을 그대로 쓴다) */
const THEME_MAP_PICK = [
  { no: 155, label: '반도체 대표' },
  { no: 12, label: '반도체 장비' },
  { no: 14, label: '반도체 재료' },
  { no: 307, label: '시스템반도체' },
  { no: 64, label: '2차전지' },
  { no: 446, label: '2차전지 소재' },
  { no: 241, label: '바이오시밀러' },
  { no: 172, label: '제약' },
  { no: 175, label: '의료기기' },
  { no: 110, label: '화장품' },
  { no: 144, label: '방산' },
  { no: 30, label: '조선' },
  { no: 123, label: '전력설비' },
  { no: 205, label: '원전' },
  { no: 505, label: '로봇' },
  { no: 587, label: '피지컬AI' },
  { no: 42, label: '게임' },
  { no: 128, label: '엔터' },
  { no: 571, label: '밸류업' },
  { no: 159, label: '자동차' },
  { no: 200, label: '우주항공' },
  { no: 165, label: '은행' },
  { no: 151, label: '증권' },
  { no: 136, label: '유통' },
  { no: 191, label: '태양광' },
];

/** 동시 실행 수를 제한한 map — 네이버 응답을 한꺼번에 수십 개 때리지 않는다 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = { __error: String((e && e.message) || e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** 테마 상세 → { no, name, changeRate, riseCount, fallCount, stockCount, description, stocks[] } */
async function fetchThemeDetail(no) {
  const d = await fetchJson(`${THEME_DETAIL_URL}${no}?page=1&pageSize=100`, {
    headers: NAVER_HEADERS,
    timeout: 7000,
  });
  const g = (d && d.groupInfo) || {};
  const stocks = ((d && d.stocks) || [])
    .map((s) => {
      const valueMil = parseNum(s.accumulatedTradingValue); // 백만원 단위
      return {
        code: s.itemCode || null,
        name: s.stockName || null,
        price: parseNum(s.closePrice),
        changePct: parseNum(s.fluctuationsRatio),
        valueEok: valueMil == null ? null : Math.round(valueMil) / 100, // 백만원 → 억
        market: (s.stockExchangeType && s.stockExchangeType.name) || null,
        tradedAt: s.localTradedAt || null,
      };
    })
    .filter((s) => s.code && s.name);
  return {
    no: parseNum(g.no) || Number(no),
    name: String(g.name || '').trim() || null,
    changeRate: parseNum(g.changeRate),
    riseCount: parseNum(g.riseCount),
    fallCount: parseNum(g.fallCount),
    stockCount: parseNum(g.totalCount) || stocks.length,
    description: (d && d.themeDescription) || null,
    marketStatus: (d && d.marketStatus) || null,
    stocks,
  };
}

/** 테마 묶음 요약 — 거래대금 많은 종목부터, 타일에는 8개까지만 싣는다 */
function summarizeTheme(detail, label) {
  const stocks = detail.stocks.slice();
  const withValue = stocks.filter((s) => s.valueEok != null);
  const valueSum = withValue.reduce((a, s) => a + s.valueEok, 0);
  const quoted = stocks.filter((s) => s.changePct != null);
  const byValue = stocks
    .slice()
    .sort((a, b) => (b.valueEok || 0) - (a.valueEok || 0));
  const pcts = quoted.map((s) => s.changePct).sort((a, b) => b - a);
  const top4 = pcts.slice(0, 4);
  return {
    no: detail.no,
    name: detail.name,
    label: label || detail.name,
    avgPct: detail.changeRate != null ? detail.changeRate : quoted.length
      ? Number((pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2))
      : null,
    top4Avg: top4.length ? Number((top4.reduce((a, b) => a + b, 0) / top4.length).toFixed(2)) : null,
    valueEok: withValue.length ? Math.round(valueSum) : null,
    valueCount: withValue.length,
    riseCount: detail.riseCount,
    fallCount: detail.fallCount,
    stockCount: detail.stockCount,
    membersShown: byValue.length,
    stocks: byValue.slice(0, 8).map((s) => ({
      code: s.code,
      name: s.name,
      changePct: s.changePct,
      valueEok: s.valueEok == null ? null : Math.round(s.valueEok),
      price: s.price,
    })),
  };
}

async function handleThemeMap(res, fresh) {
  const generatedAtKst = kstLabel(new Date());
  const key = 'theme-map';
  if (!fresh) {
    const hit = themeMapCache.get(key);
    if (hit && Date.now() - hit.at < THEME_MAP_TTL_MS) {
      res.setHeader('X-Cache', 'HIT-memory');
      return sendJson(res, 200, { ...hit.value, cached: true }, THEME_MAP_CACHE_CONTROL);
    }
  }
  const errors = [];
  const settled = await mapLimit(THEME_MAP_PICK, 6, (p) => fetchThemeDetail(p.no));
  const tiles = [];
  let tradeDate = null;
  let marketStatus = null;
  settled.forEach((r, i) => {
    const pick = THEME_MAP_PICK[i];
    if (!r || r.__error) {
      errors.push(`${pick.label}(${pick.no}): ${(r && r.__error) || '빈 응답'}`);
      return;
    }
    if (!r.name || !r.stocks.length) {
      errors.push(`${pick.label}(${pick.no}): 구성종목 없음`);
      return;
    }
    if (!tradeDate) {
      const withAt = r.stocks.find((s) => s.tradedAt);
      if (withAt) tradeDate = String(withAt.tradedAt).slice(0, 10);
    }
    if (!marketStatus && r.marketStatus) marketStatus = r.marketStatus;
    tiles.push(summarizeTheme(r, pick.label));
  });
  tiles.sort((a, b) => (b.valueEok || 0) - (a.valueEok || 0));

  const body = {
    ok: tiles.length > 0,
    mode: 'theme-map',
    marketStatus,
    tradeDate,
    asOf: generatedAtKst,
    basisLabel: tradeDate
      ? `직전 거래일(${tradeDate}) 네이버 테마 실측 · 타일 크기=구성 합산 거래대금`
      : '네이버 테마 실측',
    themeTotal: THEME_MAP_PICK.length,
    tiles,
    errors,
    generatedAt: new Date().toISOString(),
    generatedAtKst,
  };
  if (tiles.length) {
    themeMapCache.set(key, { at: Date.now(), value: body });
    if (themeMapCache.size > 40) {
      const oldest = themeMapCache.keys().next();
      if (!oldest.done) themeMapCache.delete(oldest.value);
    }
  }
  res.setHeader('X-Cache', 'MISS');
  return sendJson(res, 200, body, THEME_MAP_CACHE_CONTROL);
}

/** ?mode=theme_members&no=155 — 그 테마 구성종목 전부를 거래대금 주요순으로 */
async function handleThemeMembers(res, q, fresh) {
  const generatedAtKst = kstLabel(new Date());
  const no = parseNum(q.no);
  if (!no) {
    return sendJson(
      res,
      400,
      { ok: false, mode: 'theme-members', reason: 'bad_no', message: 'no=테마번호가 필요합니다.', stocks: [], generatedAtKst },
      'no-store',
    );
  }
  const key = `theme-members:${no}`;
  if (!fresh) {
    const hit = themeMapCache.get(key);
    if (hit && Date.now() - hit.at < THEME_MAP_TTL_MS) {
      res.setHeader('X-Cache', 'HIT-memory');
      return sendJson(res, 200, { ...hit.value, cached: true }, THEME_MAP_CACHE_CONTROL);
    }
  }
  try {
    const detail = await fetchThemeDetail(no);
    const stocks = detail.stocks
      .slice()
      .sort((a, b) => (b.valueEok || 0) - (a.valueEok || 0) || (b.changePct || 0) - (a.changePct || 0));
    const body = {
      ok: true,
      mode: 'theme-members',
      theme: {
        no: detail.no,
        name: detail.name,
        changeRate: detail.changeRate,
        riseCount: detail.riseCount,
        fallCount: detail.fallCount,
        stockCount: detail.stockCount,
        description: detail.description,
      },
      stocks: stocks.map((s) => ({
        code: s.code,
        name: s.name,
        market: s.market,
        price: s.price,
        changePct: s.changePct,
        valueEok: s.valueEok == null ? null : Math.round(s.valueEok),
      })),
      basisLabel: '네이버 테마 구성종목 실측 · 거래대금 내림차순',
      marketStatus: detail.marketStatus,
      generatedAt: new Date().toISOString(),
      generatedAtKst,
    };
    themeMapCache.set(key, { at: Date.now(), value: body });
    if (themeMapCache.size > 120) {
      const oldest = themeMapCache.keys().next();
      if (!oldest.done) themeMapCache.delete(oldest.value);
    }
    res.setHeader('X-Cache', 'MISS');
    return sendJson(res, 200, body, THEME_MAP_CACHE_CONTROL);
  } catch (e) {
    return sendJson(
      res,
      200,
      {
        ok: false,
        mode: 'theme-members',
        no,
        stocks: [],
        message: '테마 구성종목을 받지 못했습니다.',
        error: String((e && e.message) || e),
        generatedAtKst,
      },
      'no-store',
    );
  }
}

/** 테마 이름 정규화 — 괄호·공백·기호를 지워 비교한다 */
function themeNameKey(name) {
  return String(name || '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, '')
    .replace(/[·・,\-_/]/g, '')
    .toLowerCase();
}

/** ?mode=theme_search&q=반도체 — 테마 이름으로 테마번호 찾기 */
function handleThemeSearch(res, q) {
  const generatedAtKst = kstLabel(new Date());
  const raw = String(q.q || '').replace(/^\s+|\s+$/g, '');
  if (!raw) {
    return sendJson(
      res,
      400,
      { ok: false, mode: 'theme-search', reason: 'bad_query', message: 'q=테마 이름이 필요합니다.', themes: [], generatedAtKst },
      'no-store',
    );
  }
  const list = (THEME_MEMBER && Array.isArray(THEME_MEMBER.themes) ? THEME_MEMBER.themes : []).filter(
    (t) => t && t.no && t.name,
  );
  const key = themeNameKey(raw);
  const scored = [];
  list.forEach((t) => {
    const k = themeNameKey(t.name);
    if (!k) return;
    let score = 0;
    if (k === key) score = 100;
    else if (k.indexOf(key) === 0) score = 80;
    else if (k.indexOf(key) > -1) score = 60;
    else if (key.length >= 3 && key.indexOf(k) > -1) score = 40;
    if (!score) return;
    scored.push({
      no: t.no,
      name: t.name,
      stockCount: t.stockCount || null,
      score,
    });
  });
  scored.sort((a, b) => b.score - a.score || (b.stockCount || 0) - (a.stockCount || 0));
  const themes = scored.slice(0, 8);
  return sendJson(
    res,
    200,
    {
      ok: themes.length > 0,
      mode: 'theme-search',
      query: raw,
      themes,
      membershipAsOf: (THEME_MEMBER && THEME_MEMBER.updatedAt) || null,
      message: themes.length ? null : '그 이름과 맞는 테마를 찾지 못했습니다.',
      generatedAtKst,
    },
    'public, s-maxage=600, stale-while-revalidate=1800',
  );
}

/* ==========================================================================
 * 📰 [특징주] 기사 이력 + 🌊 260일 과거 파동 (?mode=history_catalyst&code=005930)
 * --------------------------------------------------------------------------
 *  · 일별 시세·거래대금: 다음 금융 일별 API(정규장 기준 accTradePrice) 실측.
 *      - 실패하면 네이버 일봉(fchart)으로 대체하고 거래대금은 '종가×거래량' 근사로 표시한다(근사임을 밝힌다).
 *  · [특징주] 기사: 구글뉴스 RSS 검색(제목·날짜·언론사·링크). 제목이 '특징주'로 시작하고
 *      첫 구절(주어)에 이 종목 이름이 있는 기사만 남긴다 — 다른 종목 기사를 이 종목 것으로 붙이지 않는다.
 *  · 기사 날짜는 KST 기준 날짜로 바꾼 뒤 그날(없으면 가장 가까운 거래일 ±5일) 일봉과 짝지어
 *      그날 등락률·거래대금·그날 종가 대비 현재 위치를 계산한다.
 *  · 과거 파동: 260일 안에서 '거래대금이 가장 크게 터진 상승 구간'을 계산해 최대 2개.
 *  · 없는 기사·없는 파동을 만들지 않는다. 못 받은 값은 null 로 두고 note 에 밝힌다.
 * ========================================================================== */
const HC_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=900';
const HC_TTL_MS = 300000;
const hcCache = new Map();

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** KST 기준 YYYYMMDD (offsetDays 만큼 이동) */
function kstYmd(offsetDays) {
  const now = new Date(Date.now() + 9 * 3600 * 1000 + (offsetDays || 0) * 86400000);
  return `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`;
}

function ymdDash(ymd) {
  const s = String(ymd || '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

/** 다음 금융 일별 시세 — { date, o,h,l,c, value, vol } (최근 260거래일) */
async function fetchDaumDays(code, want) {
  const n = want || 260;
  const pages = [1, 2, 3];
  const results = await mapLimit(pages, 3, async (page) => {
    const url = `https://finance.daum.net/api/quote/A${code}/days?perPage=100&page=${page}`;
    return fetchJson(url, {
      headers: {
        'User-Agent': NAVER_HEADERS['User-Agent'],
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        Referer: `https://finance.daum.net/quotes/A${code}`,
      },
      timeout: 8000,
    });
  });
  const rows = [];
  results.forEach((r) => {
    if (!r || r.__error) return;
    ((r && r.data) || []).forEach((x) => {
      const date = String(x && x.date ? x.date : '').slice(0, 10).replace(/-/g, '');
      const c = parseNum(x && x.tradePrice);
      if (!/^\d{8}$/.test(date) || c == null) return;
      rows.push({
        date,
        o: parseNum(x.openingPrice),
        h: parseNum(x.highPrice),
        l: parseNum(x.lowPrice),
        c,
        value: parseNum(x.accTradePrice), // 정규장 거래대금(원)
        vol: parseNum(x.accTradeVolume),
      });
    });
  });
  const seen = new Set();
  const uniq = [];
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  rows.forEach((r) => {
    if (seen.has(r.date)) return;
    seen.add(r.date);
    uniq.push(r);
  });
  const sliced = uniq.slice(-n);
  return {
    rows: sliced,
    source: 'daum-finance-day',
    valueBasis: '정규장 거래대금',
  };
}

/** 네이버 일별 시세 — 공식 종가·등락률·거래량 (최근 300거래일에서 want개) */
async function fetchNaverDays(code, want) {
  const n = want || 260;
  const settled = await mapLimit([1, 2, 3, 4, 5], 5, (page) =>
    fetchJson(`https://m.stock.naver.com/api/stock/${code}/price?pageSize=60&page=${page}`, {
      headers: NAVER_HEADERS,
      timeout: 7000,
    }),
  );
  const rows = [];
  const seen = new Set();
  settled.forEach((r) => {
    if (!Array.isArray(r)) return;
    r.forEach((x) => {
      const date = String((x && x.localTradedAt) || '').slice(0, 10).replace(/-/g, '');
      const c = parseNum(x && x.closePrice);
      if (!/^\d{8}$/.test(date) || c == null || seen.has(date)) return;
      seen.add(date);
      rows.push({
        date,
        o: parseNum(x.openPrice),
        h: parseNum(x.highPrice),
        l: parseNum(x.lowPrice),
        c,
        changePct: parseNum(x.fluctuationsRatio), // 네이버 공식 일별 등락률
        vol: parseNum(x.accumulatedTradingVolume),
        value: null, // 거래대금은 다음 금융 일별에서 날짜로 붙인다
      });
    });
  });
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows: rows.slice(-n), source: 'naver-mobile-day' };
}

function decodeXmlEntities(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function rssTag(body, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(body);
  return m ? decodeXmlEntities(m[1]) : null;
}

/** 구글뉴스 RSS 검색 — { items:[{title, press, link, date, time}] } */
async function fetchGoogleNews(query) {
  const url =
    'https://news.google.com/rss/search?q=' +
    encodeURIComponent(query) +
    '&hl=ko&gl=KR&ceid=KR:ko';
  const buf = await fetchBuffer(url, {
    headers: {
      'User-Agent': NAVER_HEADERS['User-Agent'],
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    timeout: 9000,
  });
  const xml = buf.toString('utf8');
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    const rawTitle = rssTag(body, 'title');
    if (!rawTitle) continue;
    const link = rssTag(body, 'link');
    const pub = rssTag(body, 'pubDate');
    const src = rssTag(body, 'source');
    const t = pub ? Date.parse(pub) : NaN;
    let date = null;
    let time = null;
    if (isFinite(t)) {
      const k = new Date(t + 9 * 3600 * 1000);
      date = `${k.getUTCFullYear()}${pad2(k.getUTCMonth() + 1)}${pad2(k.getUTCDate())}`;
      time = `${pad2(k.getUTCHours())}:${pad2(k.getUTCMinutes())}`;
    }
    /* 제목 끝 ' - 언론사' 를 떼고 언론사는 따로 둔다 */
    let title = rawTitle;
    let press = src || null;
    const cut = rawTitle.lastIndexOf(' - ');
    if (cut > 8) {
      if (!press) press = rawTitle.slice(cut + 3).trim();
      title = rawTitle.slice(0, cut).trim();
    }
    items.push({ title, press, link, date, time, raw: rawTitle });
  }
  return { items, source: 'google-news-rss', query };
}

/** '[특징주]' 기사인지 + 주어가 이 종목인지 — 다른 종목 기사는 버린다 */
function catalystIsAbout(title, name) {
  const t = String(title || '');
  if (t.indexOf('특징주') < 0) return false;
  const m = /^[\s[<(]*(?:\d{1,2}\s*일\s*)?특징주[\s\])>]*[:,\-·]?\s*/i.exec(t);
  const rest = m ? t.slice(m[0].length) : t.replace(/[\s\S]*?특징주[\s\])>]*[:,\-·]?\s*/i, '');
  const head = rest.split(/[,·∙…]|\.\.\./)[0] || '';
  const nm = String(name || '').trim();
  if (!nm || nm.length < 2) return false;
  return head.indexOf(nm) > -1;
}

/** 260일 안에서 '거래대금이 크게 터진 상승 파동' 최대 2개를 실측 계산 */
function findWaves(rows, maxWaves) {
  const limit = maxWaves || 2;
  if (!rows || rows.length < 40) return { waves: [], criteria: null };
  const n = rows.length;
  const cands = [];
  for (let i = 5; i < n - 2; i += 1) {
    const c = rows[i].c;
    if (!(c >= rows[i - 1].c && c >= rows[i - 2].c && c >= rows[i + 1].c && c >= rows[i + 2].c)) continue;
    let lo = Infinity;
    let loI = i;
    for (let j = Math.max(0, i - 20); j <= i; j += 1) {
      if (rows[j].c < lo) {
        lo = rows[j].c;
        loI = j;
      }
    }
    if (!(lo > 0)) continue;
    const gain = (c / lo - 1) * 100;
    if (gain < 8) continue;
    let vmax = 0;
    let vI = loI;
    for (let j = loI; j <= i; j += 1) {
      if ((rows[j].value || 0) > vmax) {
        vmax = rows[j].value || 0;
        vI = j;
      }
    }
    cands.push({ loI, peakI: i, gain, vmax, vI });
  }
  cands.sort((a, b) => b.vmax - a.vmax || b.gain - a.gain);
  const picked = [];
  cands.forEach((c) => {
    if (picked.length >= limit) return;
    const clash = picked.some((p) => !(c.peakI < p.loI - 5 || c.loI > p.peakI + 5));
    if (clash) return;
    picked.push(c);
  });
  picked.sort((a, b) => b.peakI - a.peakI);
  const now = rows[n - 1];
  const waves = picked.map((p) => {
    const start = rows[p.loI];
    const peak = rows[p.peakI];
    const vDay = rows[p.vI];
    return {
      startDate: ymdDash(start.date),
      peakDate: ymdDash(peak.date),
      peakYmd: peak.date,
      startYmd: start.date,
      lowClose: Math.round(start.c),
      peakClose: Math.round(peak.c),
      gainPct: Number(p.gain.toFixed(2)),
      tradingDays: p.peakI - p.loI,
      days: Math.round((p.peakI - p.loI + 1)),
      peakValueEok: Math.round((p.vmax || 0) / 1e8),
      peakValueDate: ymdDash(vDay.date),
      nowVsPeakPct: Number((((now.c / peak.c) - 1) * 100).toFixed(2)),
    };
  });
  const strong = cands.filter((c) => c.gain >= 12).length;
  return {
    waves,
    criteria: `최근 ${rows.length}거래일 일봉 실측 · 20일 저점→고점 상승 ${strong ? '12%' : '8%'} 이상 구간 중 그 안에서 하루 거래대금이 가장 컸던 순`,
  };
}

/** [특징주] 이력 + 파동 응답 만들기 */
async function handleHistoryCatalyst(res, q, fresh) {
  const generatedAtKst = kstLabel(new Date());
  const code = String(q.code || '').trim();
  if (!/^\d{6}$/.test(code)) {
    return sendJson(
      res,
      400,
      {
        ok: false,
        mode: 'history-catalyst',
        reason: 'bad_code',
        message: 'code=6자리 종목코드가 필요합니다.',
        items: [],
        waves: [],
        generatedAtKst,
      },
      'no-store',
    );
  }
  const key = `hc:${code}`;
  if (!fresh) {
    const hit = hcCache.get(key);
    if (hit && Date.now() - hit.at < HC_TTL_MS) {
      res.setHeader('X-Cache', 'HIT-memory');
      return sendJson(res, 200, { ...hit.value, cached: true }, HC_CACHE_CONTROL);
    }
  }

  const errors = [];
  const notes = [];

  /* 1) 종목 이름 — 클라이언트가 안 주면 시세에서 읽는다 */
  let name = String(q.name || '').trim() || null;
  if (!name) {
    try {
      const rows = await fetchStocks([code]);
      if (rows && rows[0] && rows[0].name) name = rows[0].name;
    } catch (e) {
      errors.push('종목명: ' + String((e && e.message) || e));
    }
  }

  /* 2) 일별 시세 + 거래대금
   *  · 종가·등락률은 네이버 일봉(체커의 52주 위치 카드와 같은 소스)을 쓴다.
   *  · 거래대금은 다음 금융 일별 API 의 정규장 accTradePrice 를 날짜로 짝지어 붙인다.
   *  · 한쪽이 막히면 남은 쪽으로만 채우고, 근사치면 근사치라고 적는다. */
  const settledSeries = await Promise.allSettled([fetchNaverDays(code, 260), fetchDaumDays(code, 260)]);
  const nvR = settledSeries[0];
  const dmR = settledSeries[1];
  let rows = [];
  let priceBasis = null;
  let valueBasis = null;
  const sourceParts = [];
  if (nvR.status === 'fulfilled' && nvR.value.rows.length) {
    rows = nvR.value.rows;
    priceBasis = '네이버 일별 종가·공식 등락률';
    sourceParts.push('naver-mobile-day');
  } else if (nvR.status === 'rejected') {
    errors.push('네이버 일봉: ' + String((nvR.reason && nvR.reason.message) || nvR.reason));
  }
  if (dmR.status === 'fulfilled' && dmR.value.rows.length) {
    const vmap = new Map(dmR.value.rows.map((r) => [r.date, r.value]));
    if (rows.length) {
      rows.forEach((r) => {
        if (r.value == null) {
          const v = vmap.get(r.date);
          if (v != null) r.value = v;
        }
      });
      valueBasis = '정규장 거래대금(다음 금융)';
    } else {
      rows = dmR.value.rows;
      priceBasis = '다음 금융 일별 종가';
      valueBasis = '정규장 거래대금(다음 금융)';
    }
    sourceParts.push('daum-finance-day');
  } else if (dmR.status === 'rejected') {
    errors.push('다음 일별: ' + String((dmR.reason && dmR.reason.message) || dmR.reason));
  }
  if (rows.length && valueBasis == null) {
    rows.forEach((r) => {
      if (r.value == null && r.c != null && r.vol != null) r.value = r.c * r.vol;
    });
    valueBasis = '종가×거래량 근사';
    notes.push('정규장 일별 거래대금을 받지 못해 종가×거래량으로 근사했습니다(정확한 거래대금 아님).');
  }
  const series = { rows, source: sourceParts.join('+') || null, priceBasis, valueBasis };
  const byDate = new Map();
  rows.forEach((r, i) => byDate.set(r.date, i));
  rows.forEach((r, i) => {
    if (r.changePct == null) {
      r.changePct = i > 0 && rows[i - 1].c > 0 ? Number((((r.c / rows[i - 1].c) - 1) * 100).toFixed(2)) : null;
    }
  });

  /* 3) [특징주] 기사 — 최근 + 1년 창 두 번 검색해서 합친다 */
  let articles = [];
  let newsSource = null;
  let newsQueries = [];
  if (name && name.length >= 2) {
    const today = kstYmd(0);
    const yearAgo = kstYmd(-365);
    const recentCut = kstYmd(-30);
    const queries = [`"특징주" ${name}`, `"특징주" ${name} after:${ymdDash(yearAgo)} before:${ymdDash(recentCut)}`];
    newsQueries = queries;
    const seen = new Set();
    const absorb = (items) => {
      let added = 0;
      (items || []).forEach((it) => {
        if (!it.date || !it.title) return;
        if (!catalystIsAbout(it.title, name)) return;
        const k = it.date + '|' + it.title.replace(/\s+/g, '');
        if (seen.has(k)) return;
        seen.add(k);
        articles.push(it);
        added += 1;
      });
      return added;
    };
    const settled = await mapLimit(queries, 2, (query) => fetchGoogleNews(query));
    settled.forEach((r) => {
      if (!r || r.__error) {
        errors.push('구글뉴스: ' + ((r && r.__error) || '빈 응답'));
        return;
      }
      newsSource = r.source;
      absorb(r.items);
    });
    /* 구글 응답은 요청마다 조각이 달라 0건이 나올 수 있다 — 같은 검색어로 한 번 더 확인한다 */
    if (newsSource && !articles.length) {
      try {
        const retry = await fetchGoogleNews(`특징주 ${name}`);
        newsQueries = newsQueries.concat(['특징주 ' + name]);
        absorb(retry.items);
      } catch (e) {
        errors.push('구글뉴스 재시도: ' + String((e && e.message) || e));
      }
    }
    /* 구글뉴스가 막힌 환경(데이터센터 IP 차단 등) — 네이버 종목뉴스 최근 20건에서 [특징주]만 골라 대신 쓴다 */
    if (!newsSource) {
      try {
        const out = await fetchStockNews(code, 20);
        let added = 0;
        (out.news || []).forEach((it) => {
          const ymd = String((it && it.datetime) || '').slice(0, 8);
          if (!/^\d{8}$/.test(ymd)) return;
          if (!catalystIsAbout(it.title, name)) return;
          articles.push({
            title: it.title,
            press: it.press || null,
            link: it.url || null,
            date: ymd,
            time: it.time || null,
          });
          added += 1;
        });
        if (added) {
          newsSource = 'naver-stock-news';
          notes.push('구글뉴스 검색이 막혀 네이버 종목뉴스 최근 20건에서 [특징주] 기사만 골랐습니다 — 과거 이력은 일부만 보입니다.');
        }
      } catch (e) {
        errors.push('네이버 종목뉴스: ' + String((e && e.message) || e));
      }
    }
    articles.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    /* 같은 날 여러 매체가 쏟아지므로 하루 2건까지만 — 최근 3건 + 과거 5건으로 시간 폭을 넓힌다 */
    const recentCutYmd = kstYmd(-30);
    const perDay = new Map();
    const recentPick = [];
    const olderPick = [];
    articles.forEach((a) => {
      const c = perDay.get(a.date) || 0;
      if (c >= 2) return;
      perDay.set(a.date, c + 1);
      if (a.date >= recentCutYmd) {
        if (recentPick.length < 3) recentPick.push(a);
      } else if (olderPick.length < 5) {
        olderPick.push(a);
      }
    });
    articles = recentPick.concat(olderPick).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  } else {
    notes.push('종목 이름을 확인하지 못해 [특징주] 기사 검색을 건너뛰었습니다.');
  }

  /* 4) 기사 ↔ 거래일 매칭 (같은 날 → 없으면 앞뒤 5일 안 가장 가까운 거래일) */
  function matchIndex(ymd) {
    if (!/^\d{8}$/.test(ymd || '')) return null;
    if (byDate.has(ymd)) return { i: byDate.get(ymd), match: 'same' };
    const target = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
    let best = null;
    for (let i = 0; i < rows.length; i += 1) {
      const d = Math.abs(
        Date.UTC(+rows[i].date.slice(0, 4), +rows[i].date.slice(4, 6) - 1, +rows[i].date.slice(6, 8)) - target,
      );
      if (best == null || d < best.d) best = { i, d };
    }
    if (!best || best.d > 5 * 86400000) return null;
    return { i: best.i, match: rows[best.i].date < ymd ? 'prev' : 'next' };
  }

  const nowPrice = parseNum(q.price);
  const lastClose = rows.length ? rows[rows.length - 1].c : null;
  const curPrice = nowPrice != null ? nowPrice : lastClose;

  const items = [];
  articles.forEach((a) => {
    if (items.length >= 8) return;
    const mt = matchIndex(a.date);
    const row = mt ? rows[mt.i] : null;
    const item = {
      date: ymdDash(a.date),
      time: a.time || null,
      title: a.title,
      press: a.press || null,
      url: a.link || null,
      tradeDate: row ? ymdDash(row.date) : null,
      match: mt ? mt.match : null,
      matchedNote:
        mt && mt.match === 'same'
          ? '기사일 그날'
          : mt && mt.match === 'prev'
            ? '기사일이 휴장 — 직전 거래일'
            : mt
              ? '기사일이 휴장 — 직후 거래일'
              : '거래일 매칭 실패',
      changePct: row ? row.changePct : null,
      valueEok: row && row.value != null ? Math.round(row.value / 1e8) : null,
      close: row ? Math.round(row.c) : null,
      nowVsClosePct:
        row && curPrice != null ? Number((((curPrice / row.c) - 1) * 100).toFixed(2)) : null,
    };
    /* 재료가 나온 뒤 5·10거래일 — '몇 주 동안 강했나'를 실측으로 */
    if (mt) {
      const i5 = mt.i + 5;
      const i10 = mt.i + 10;
      item.fwd5Pct =
        i5 < rows.length && rows[mt.i].c > 0
          ? Number((((rows[i5].c / rows[mt.i].c) - 1) * 100).toFixed(2))
          : null;
      item.fwd10Pct =
        i10 < rows.length && rows[mt.i].c > 0
          ? Number((((rows[i10].c / rows[mt.i].c) - 1) * 100).toFixed(2))
          : null;
    }
    items.push(item);
  });

  /* 5) 과거 파동 */
  const waveOut = findWaves(rows, 2);

  const body = {
    ok: true,
    mode: 'history-catalyst',
    code,
    name,
    series: {
      count: rows.length,
      from: rows.length ? ymdDash(rows[0].date) : null,
      to: rows.length ? ymdDash(rows[rows.length - 1].date) : null,
      source: series.source,
      priceBasis: series.priceBasis,
      valueBasis: series.valueBasis,
    },
    now: {
      price: curPrice == null ? null : Math.round(curPrice),
      lastClose: lastClose == null ? null : Math.round(lastClose),
      priceFrom: nowPrice != null ? 'client-live' : 'last-candle',
      valueEok:
        rows.length && rows[rows.length - 1].value != null
          ? Math.round(rows[rows.length - 1].value / 1e8)
          : null,
      date: rows.length ? ymdDash(rows[rows.length - 1].date) : null,
    },
    catalyst: {
      source: newsSource,
      queries: newsQueries,
      found: articles.length,
      items,
    },
    waves: waveOut.waves,
    waveCriteria: waveOut.criteria,
    notes,
    errors,
    message: items.length
      ? null
      : name
        ? `'${name}' 이름으로 [특징주] 기사를 찾지 못했습니다(구글뉴스 검색 기준).`
        : '종목명을 확인하지 못해 기사 이력을 만들지 않았습니다.',
    generatedAt: new Date().toISOString(),
    generatedAtKst,
  };

  var hcHasItems = !!(body.catalyst && body.catalyst.items && body.catalyst.items.length);
  if (body.ok && hcHasItems) {
    hcCache.set(key, { at: Date.now(), value: body });
    if (hcCache.size > 120) {
      const oldest = hcCache.keys().next();
      if (!oldest.done) hcCache.delete(oldest.value);
    }
  }
  res.setHeader('X-Cache', 'MISS');
  /* 기사 0건은 일시적일 수 있어 오래 캐시하지 않는다(다음 조회에서 다시 확인) */
  return sendJson(res, 200, body, hcHasItems ? HC_CACHE_CONTROL : 'public, s-maxage=20, stale-while-revalidate=60');
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
  if (q.mode === 'alerts') return handleAlerts(res, fresh, q);

  // ?kis_test=1 — KIS(한국투자증권) 공식 API 연동 진단 (토큰·시세·수급)
  if (q.kis_test === '1') return handleKisTest(res, q, fresh);

  // ?code=005930&news=1 — 종목 모달용 최신 뉴스 (새 함수 파일을 만들지 않기 위한 내부 라우트)
  if (q.news === '1' || q.news === 'true') return handleStockNews(res, q, fresh);

  // ?mode=theme&code=005930 — 체커용 소속 테마·테마 신호등·최근/과거 재료 (새 함수 파일 없이 내부 라우트)
  if (q.mode === 'theme') return handleStockTheme(res, q, fresh);

  // ?mode=theme_map — 체커 상단 테마 히트맵 (대표 테마 24개 · 구성종목 실측)
  if (q.mode === 'theme_map') return handleThemeMap(res, fresh);

  // ?mode=theme_members&no=155 — 테마 구성종목을 거래대금 주요순으로
  if (q.mode === 'theme_members') return handleThemeMembers(res, q, fresh);

  // ?mode=theme_search&q=반도체 — 테마 이름으로 테마번호 찾기
  if (q.mode === 'theme_search') return handleThemeSearch(res, q);

  // ?mode=history_catalyst&code=005930 — [특징주] 기사 이력 + 260일 과거 파동
  if (q.mode === 'history_catalyst') return handleHistoryCatalyst(res, q, fresh);

  const rawQueries = String(q.codes || q.code || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  const codeList = rawQueries.filter((s) => /^\d{6}$/.test(s));
  const nameQueries = rawQueries.filter((s) => !/^\d{6}$/.test(s));
  const nameResolved = [];
  for (const nm of nameQueries) {
    const c = await resolveStockCode(nm);
    nameResolved.push({ query: nm, code: c || null });
    if (c && !codeList.includes(c)) codeList.push(c);
  }
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
    resolved: nameResolved,
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
      truncated: Boolean(kisSummary.truncated),
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
