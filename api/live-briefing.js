'use strict';

/**
 * GET /api/live-briefing
 * ---------------------------------------------------------------------------
 *  "⚡ 실시간 브리핑" 버튼을 누른 그 순간의 시장 팩트만 모아 구조화 JSON 으로 돌려준다.
 *
 *  수집 소스 (전부 공개 엔드포인트 · 병렬 호출 · 소스별 타임아웃 4.5~5초)
 *   1) 코스피·코스닥 지수/등락률/거래대금 : polling.finance.naver.com  (SERVICE_INDEX)
 *   2) 원/달러 환율                        : m.stock.naver.com marketIndex (실패 시 Yahoo KRW=X)
 *   3) 나스닥100 선물(NQ=F)·S&P500 선물(ES=F): query1.finance.yahoo.com
 *   4) 실시간 급등·거래대금 상위 종목       : stock.naver.com /api/domestic/market/stock/default
 *   5) 최신 증시 뉴스 5건                   : stock.naver.com /api/domestic/news/list
 *
 *  원칙
 *   - 확인된 수치만 담는다. 없는 값은 null 로 두고, 코멘트·전망·추정은 만들지 않는다.
 *   - 일부 소스가 죽어도 나머지는 정상 반환(부분 실패는 sources/errors 에 기록).
 *   - 캐시: public, s-maxage=15, stale-while-revalidate=30
 *     (프론트의 "🔄 방금 시점으로 다시 브리핑" 은 ?fresh=1 로 메모리 캐시를 건너뛴다)
 */

const {
  NAVER_HEADERS,
  fetchJson,
  parseNum,
  formatKoreanMoney,
  sendJson,
  getQuery,
} = require('../lib/http');

const CACHE_CONTROL = 'public, s-maxage=15, stale-while-revalidate=30';
const REFRESH_CACHE_CONTROL = 'public, s-maxage=5, stale-while-revalidate=10';

const NAVER_TIMEOUT = 4500;
const YAHOO_TIMEOUT = 5000;

const INDEX_NAME = { KOSPI: '코스피', KOSDAQ: '코스닥' };
const FUTURES = [
  { symbol: 'NQ=F', name: '나스닥100 선물' },
  { symbol: 'ES=F', name: 'S&P500 선물' },
];

/* --------------------------- 인스턴스 메모리 캐시 --------------------------- */
const memCache = new Map();
const MEM_TTL_MS = 4000;

/* ------------------------------- 시간 유틸 ------------------------------- */
const WEEKDAY_KO = { Sun: '일', Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토' };

function kstParts(date) {
  const d = date instanceof Date ? date : new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(d);
  const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  const hh = Number(g('hour')) % 24;
  return {
    y: Number(g('year')),
    m: Number(g('month')),
    d: Number(g('day')),
    hh,
    mi: Number(g('minute')),
    ss: Number(g('second')),
    wd: g('weekday'),
    minutes: hh * 60 + Number(g('minute')),
  };
}

const pad2 = (n) => (n < 10 ? '0' : '') + n;

function hms(p) {
  return `${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`;
}

function mdKst(p) {
  return `${pad2(p.m)}/${pad2(p.d)}`;
}

/* ------------------------------ 시장 국면 판정 ------------------------------ */
function basePhase(p) {
  if (p.wd === 'Sat' || p.wd === 'Sun') {
    return { phase: '주말', label: `주말 휴장 (${WEEKDAY_KO[p.wd] || '주말'}요일)` };
  }
  if (p.minutes < 9 * 60) return { phase: '장전', label: '장전 (09:00 정규장 시작 전)' };
  if (p.minutes < 15 * 60 + 30) return { phase: '정규장', label: '정규장 진행 중 (09:00~15:30)' };
  return { phase: '애프터·장마감', label: '애프터·장마감 (15:30 정규장 종료 이후)' };
}

/* ------------------------------- 지수 수집 ------------------------------- */
async function fetchIndices() {
  const url =
    'https://polling.finance.naver.com/api/realtime?query=' +
    encodeURIComponent('SERVICE_INDEX:KOSPI,KOSDAQ') +
    '&_=' +
    Date.now();
  const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: NAVER_TIMEOUT });
  const areas = (data && data.result && data.result.areas) || [];
  const flat = [];
  for (const area of areas) for (const d of area.datas || []) flat.push(d);

  const list = flat
    .filter((d) => INDEX_NAME[d.cd])
    .map((d) => {
      const value = Number.isFinite(d.aa) ? d.aa * 1e6 : null; // aa 단위: 백만원
      return {
        key: d.cd,
        name: INDEX_NAME[d.cd],
        price: Number.isFinite(d.nv) ? Number((d.nv / 100).toFixed(2)) : null,
        change: Number.isFinite(d.cv) ? Number((d.cv / 100).toFixed(2)) : null,
        changePct: Number.isFinite(d.cr) ? Number(Number(d.cr).toFixed(2)) : null,
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

  if (!list.length) throw new Error('naver index 응답에 지수가 없습니다');
  return list;
}

/* -------------------------------- 환율 수집 -------------------------------- */
async function fetchFxNaver() {
  const url =
    'https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&reutersCode=FX_USDKRW';
  const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: NAVER_TIMEOUT });
  const rows = (data && data.result) || [];
  if (!rows.length) throw new Error('naver fx 응답이 비었습니다');
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

async function fetchFxYahoo() {
  const q = await yahooQuote('KRW=X');
  return {
    key: 'USDKRW',
    name: '원/달러',
    price: q.price,
    change: q.change,
    changePct: q.changePct,
    tradedDate: null,
    asOfKst: q.asOfKst,
    direction: q.change === null ? null : q.change > 0 ? 'RISING' : q.change < 0 ? 'FALLING' : 'UNCHANGED',
    source: 'yahoo',
  };
}

/* ------------------------------ 해외 선물 수집 ------------------------------ */
function kstLabelFromMs(ms) {
  if (!ms) return null;
  const p = kstParts(new Date(ms));
  return `${pad2(p.m)}-${pad2(p.d)} ${pad2(p.hh)}:${pad2(p.mi)}`;
}

async function yahooQuote(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    '?interval=1d&range=5d';
  const data = await fetchJson(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    timeout: YAHOO_TIMEOUT,
  });
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.meta) throw new Error(`yahoo 응답 없음 ${symbol}`);
  const m = result.meta;
  const price = typeof m.regularMarketPrice === 'number' ? m.regularMarketPrice : null;
  if (price === null) throw new Error(`yahoo 가격 없음 ${symbol}`);
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
  return {
    symbol: m.symbol || symbol,
    price: Number(price.toFixed(2)),
    change: change === null ? null : Number(change.toFixed(2)),
    changePct: changePct === null ? null : Number(changePct.toFixed(2)),
    marketState: m.marketState || null,
    asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    asOfKst: m.regularMarketTime ? kstLabelFromMs(m.regularMarketTime * 1000) : null,
    source: 'yahoo',
  };
}

async function fetchFutures() {
  const settled = await Promise.allSettled(FUTURES.map((f) => yahooQuote(f.symbol)));
  const list = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') list.push({ name: FUTURES[i].name, ...s.value });
    else errors.push(`${FUTURES[i].symbol}: ${s.reason && s.reason.message}`);
  });
  return { list, errors };
}

/* --------------------------- 급등 / 거래대금 상위 --------------------------- */
async function fetchRank(orderType, pageSize) {
  const url =
    'https://stock.naver.com/api/domestic/market/stock/default' +
    '?tradeType=KRX&marketType=ALL&orderType=' +
    encodeURIComponent(orderType) +
    '&startIdx=0&pageSize=' +
    String(pageSize || 10);
  const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: NAVER_TIMEOUT });
  if (!Array.isArray(data) || !data.length) throw new Error(`naver rank 비었습니다 (${orderType})`);
  return data.map(parseRankItem);
}

function parseRankItem(d) {
  const value = parseNum(d.tradeAmount);
  const pct = parseNum(d.prevChangeRate);
  const changeRaw = parseNum(d.prevChangePrice);
  const down = d.upDownGb === '5' || d.upDownGb === '4'; // 4·5 = 하락 계열
  const signed = (v) => (v === null ? null : v < 0 ? v : down ? -Math.abs(v) : v);
  return {
    code: d.itemcode || null,
    name: d.itemname || null,
    market: d.sosok === '1' ? 'KOSDAQ' : d.sosok === '0' ? 'KOSPI' : null,
    kind: d.type || null, // ST(주식) / ETF 등
    price: parseNum(d.nowPrice),
    change: signed(changeRaw),
    changePct: signed(pct),
    upperLimit: d.upDownGb === '1',
    value,
    valueText: formatKoreanMoney(value),
    volume: parseNum(d.tradeVolume),
    marketStatus: d.marketStatus || null,
    session: d.tradingSessionType || null,
    source: 'naver-rank',
  };
}

function pickMovers(upList, valueList) {
  const seen = new Set();
  const out = [];
  const push = (s, tag) => {
    if (!s || !s.code || seen.has(s.code)) return;
    if (s.price === null) return;
    seen.add(s.code);
    out.push({ ...s, tag });
  };
  upList.filter((s) => s.kind === 'ST').slice(0, 3).forEach((s) => push(s, '급등'));
  valueList.filter((s) => s.kind === 'ST').slice(0, 3).forEach((s) => push(s, '거래대금'));
  return out.slice(0, 6);
}

/* -------------------------------- 뉴스 수집 -------------------------------- */
function normalizeNews(items) {
  return (items || [])
    .filter((n) => n && n.title)
    .slice(0, 5)
    .map((n) => {
      const dt = String(n.datetime || '');
      const timeMatch = dt.match(/(\d{2}):(\d{2})/);
      return {
        title: String(n.title).trim(),
        press: n.officeHname || n.officeName || null,
        datetime: dt || null,
        time: timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : null,
        url:
          n.officeId && n.articleId
            ? `https://n.news.naver.com/article/${n.officeId}/${n.articleId}`
            : null,
        source: 'naver-news',
      };
    });
}

async function fetchNews() {
  const listUrl = 'https://stock.naver.com/api/domestic/news/list?pageSize=10';
  try {
    const data = await fetchJson(listUrl, { headers: NAVER_HEADERS, timeout: NAVER_TIMEOUT });
    const items = normalizeNews((data && data.articles) || []);
    if (items.length) return { items, errors: [] };
    throw new Error('news list 비었습니다');
  } catch (e1) {
    const searchUrl =
      'https://stock.naver.com/api/domestic/news/search?query=' +
      encodeURIComponent('증시') +
      '&page=1&pageSize=10';
    const data = await fetchJson(searchUrl, { headers: NAVER_HEADERS, timeout: NAVER_TIMEOUT });
    const items = normalizeNews((data && data.items) || []);
    if (!items.length) throw new Error(`news 비었습니다 (list: ${e1.message})`);
    return { items, errors: [`news list 실패 → search 대체: ${e1.message}`] };
  }
}

/* --------------------------------- 헤드라인 --------------------------------- */
const numFmt = (n, d = 2, min = 0) =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: min })
    : null;

const pctFmt = (p) =>
  typeof p === 'number' && Number.isFinite(p) ? (p > 0 ? '+' : '') + p.toFixed(2) + '%' : null;

function buildHeadline(phase, indices, futures, fx, tradingDate) {
  const bits = [];
  const md = tradingDate ? tradingDate.slice(5).replace('-', '/') : null;

  for (const i of indices) {
    const p = numFmt(i.price, 2, 2);
    if (p === null) continue;
    bits.push(`${i.name} ${p} (${pctFmt(i.changePct) || '등락률 없음'})`);
  }
  for (const f of futures) {
    const p = numFmt(f.price, 2, 2);
    if (p === null) continue;
    bits.push(`${f.name} ${p} (${pctFmt(f.changePct) || '등락률 없음'})`);
  }
  if (fx && numFmt(fx.price) !== null) {
    bits.push(`원/달러 ${numFmt(fx.price, 2, 2)}원 (${pctFmt(fx.changePct) || '등락률 없음'})`);
  }
  if (!bits.length) return null;

  const prefix =
    phase.phase === '주말'
      ? `주말 휴장${md ? ` · ${md} 종가 기준` : ''}`
      : phase.phase === '장전'
        ? '장전'
        : phase.phase === '정규장'
          ? '정규장 진행'
          : '정규장 마감';
  return `${prefix} | ${bits.join(' · ')}`;
}

/** Vercel CDN 캐시 헤더까지 같이 내려준다.
 *  (Vercel Node 함수는 Cache-Control 의 s-maxage 를 CDN 정책으로 쓰지 않고 정규화하므로,
 *   CDN-Cache-Control / Vercel-CDN-Cache-Control 을 함께 지정한다) */
function applyCacheHeaders(res, policy) {
  res.setHeader('Cache-Control', policy);
  res.setHeader('CDN-Cache-Control', policy);
  res.setHeader('Vercel-CDN-Cache-Control', policy);
}

/* -------------------------------- handler -------------------------------- */
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.end();
  }

  const q = getQuery(req);
  const fresh = q.fresh === '1' || q.fresh === 'true';
  const cacheKey = 'briefing:live';

  if (!fresh) {
    const hit = memCache.get(cacheKey);
    if (hit && Date.now() - hit.at < MEM_TTL_MS) {
      res.setHeader('X-Cache', 'HIT-memory');
      applyCacheHeaders(res, CACHE_CONTROL);
      return sendJson(res, 200, hit.value, CACHE_CONTROL);
    }
  }

  const started = Date.now();
  const now = new Date();
  const p = kstParts(now);

  /* ---- 5개 소스 병렬 수집 (한 곳이 죽어도 나머지는 살린다) ---- */
  const [indicesR, fxNaverR, fxYahooR, futuresR, upR, valueR, newsR] = await Promise.allSettled([
    fetchIndices(),
    fetchFxNaver(),
    fetchFxYahoo(),
    fetchFutures(),
    fetchRank('up', 10),
    fetchRank('priceTop', 10),
    fetchNews(),
  ]);

  const sources = [];
  const errors = [];
  const note = (name, r, extra) => {
    if (r.status === 'fulfilled') {
      sources.push({ name, ok: true, ...(extra || {}) });
      return true;
    }
    const msg = String((r.reason && r.reason.message) || r.reason);
    sources.push({ name, ok: false, error: msg });
    errors.push(`${name}: ${msg}`);
    return false;
  };

  const indices = note('naver-index', indicesR) ? indicesR.value : [];

  /* 환율: 네이버 1순위, 실패 시 Yahoo */
  let fx = null;
  if (fxNaverR.status === 'fulfilled') {
    fx = fxNaverR.value;
    sources.push({ name: 'naver-fx', ok: true });
  } else {
    const msg = String((fxNaverR.reason && fxNaverR.reason.message) || fxNaverR.reason);
    sources.push({ name: 'naver-fx', ok: false, error: msg });
    if (fxYahooR.status === 'fulfilled') {
      fx = fxYahooR.value;
      sources.push({ name: 'yahoo-fx', ok: true, fallbackFor: 'naver-fx' });
      errors.push(`naver-fx 실패 → yahoo 대체: ${msg}`);
    } else {
      errors.push(`naver-fx: ${msg}`);
      errors.push(`yahoo-fx: ${String((fxYahooR.reason && fxYahooR.reason.message) || fxYahooR.reason)}`);
      sources.push({ name: 'yahoo-fx', ok: false });
    }
  }

  let futures = [];
  if (note('yahoo-futures', futuresR)) {
    futures = futuresR.value.list;
    if (futuresR.value.errors.length) errors.push(...futuresR.value.errors);
  }

  const upList = note('naver-rank-up', upR) ? upR.value : [];
  const valueList = note('naver-rank-value', valueR) ? valueR.value : [];
  const topMovers = pickMovers(upList, valueList);

  let news = [];
  if (note('naver-news', newsR)) {
    news = newsR.value.items;
    if (newsR.value.errors.length) errors.push(...newsR.value.errors);
  }

  /* ---- 국면 판정 (달력 기준 + 네이버 장 상태 교차 확인) ---- */
  const naverStatus =
    (indices[0] && indices[0].status) ||
    (topMovers[0] && topMovers[0].marketStatus) ||
    null;
  let phase = basePhase(p);
  if (phase.phase === '정규장' && naverStatus && naverStatus !== 'OPEN') {
    phase = { phase: '장마감', label: '장마감 (당일 정규장 종료 또는 휴장)' };
  }

  const sessionHint =
    (topMovers[0] && topMovers[0].session) ||
    (upList[0] && upList[0].session) ||
    null;

  /* ---- 데이터 기준일 ---- */
  const tradingDate = (fx && fx.tradedDate) || null;
  const tradingDateLabel = tradingDate
    ? `${tradingDate}(${WEEKDAY_KO[kstParts(new Date(`${tradingDate}T00:00:00+09:00`)).wd] || ''})`
    : null;
  const dataBasis = {
    tradingDate,
    tradingDateLabel,
    naverMarketStatus: naverStatus,
    naverSession: sessionHint,
    fxTradedDate: fx ? fx.tradedDate || fx.asOfKst || null : null,
    futuresAsOfKst: (futures[0] && futures[0].asOfKst) || null,
  };

  const notes = [];
  if (phase.phase === '주말') {
    notes.push(
      '주말·휴장일에는 국내 지수와 종목 시세가 직전 거래일 종가로 표시됩니다(네이버 금융 기준).',
    );
  } else if (phase.phase === '애프터·장마감' || phase.phase === '장마감') {
    notes.push('정규장 종료 후에는 시간외 단일가 체결가가 반영될 수 있습니다.');
  }

  const headline = buildHeadline(phase, indices, futures, fx, tradingDate);
  const ok = indices.length > 0 || futures.length > 0 || topMovers.length > 0;

  const body = {
    ok,
    generatedAt: now.toISOString(),
    generatedAtKst: hms(p),
    generatedAtLabel: `${p.y}-${pad2(p.m)}-${pad2(p.d)}(${WEEKDAY_KO[p.wd] || ''}) ${hms(p)} KST`,
    generatedAtDate: `${p.y}-${pad2(p.m)}-${pad2(p.d)}`,
    marketPhase: phase.phase,
    marketPhaseLabel: phase.label,
    marketSession: sessionHint,
    headline,
    indices,
    futures,
    fx,
    topMovers,
    news,
    dataBasis,
    notes,
    sources,
    errors,
    partial: errors.length > 0,
    elapsedMs: Date.now() - started,
    cacheControl: fresh ? REFRESH_CACHE_CONTROL : CACHE_CONTROL,
    fresh,
  };

  if (!ok) {
    applyCacheHeaders(res, 'no-store');
    return sendJson(
      res,
      502,
      {
        ...body,
        reason: 'upstream_failed',
        message: '실시간 소스에서 데이터를 받지 못했습니다.',
      },
      'no-store',
    );
  }

  if (!fresh) memCache.set(cacheKey, { at: Date.now(), value: body });
  res.setHeader('X-Cache', fresh ? 'BYPASS-fresh' : 'MISS');
  applyCacheHeaders(res, fresh ? REFRESH_CACHE_CONTROL : CACHE_CONTROL);
  return sendJson(res, 200, body, fresh ? REFRESH_CACHE_CONTROL : CACHE_CONTROL);
};
