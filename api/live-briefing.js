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
  parseKoreanMoney,
  formatKoreanMoney,
  sendJson,
  getQuery,
  stretchCacheControl,
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

const FMT_KST_FULL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

function kstParts(date) {
  const d = date instanceof Date ? date : new Date();
  const parts = FMT_KST_FULL.formatToParts(d);
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
  /* 장 마감·야간·주말에는 s-maxage 를 늘려 함수 호출(=Fluid Active CPU)을 줄인다 */
  const p = stretchCacheControl(policy);
  res.setHeader('Cache-Control', p);
  res.setHeader('CDN-Cache-Control', p);
  res.setHeader('Vercel-CDN-Cache-Control', p);
}

/* --------------------------- 실시간 팩트 수집 본체 ---------------------------
 *  (핸들러에서 분리) GET /api/live-briefing 의 응답 몸통과, ?ai=1 이 Gemini 에
 *  넘길 팩트를 같은 코드로 만든다 — 두 경로의 숫자가 갈라지지 않게 하기 위해서다.
 */
async function collectLiveBody() {
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
  };

  return body;
}

/* -------------------------------- handler -------------------------------- */
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.end();
  }

  const q = getQuery(req);
  const fresh = q.fresh === '1' || q.fresh === 'true';
  const wantAi = q.ai === '1' || q.ai === 'true';

  /* ---- 🤖 Gemini AI 브리핑 (?ai=1) ----
   *  GET  : 서버가 직접 팩트를 모아(테마는 /api/tabs-live, 수급은 /data/supply-latest.json)
   *         Gemini 에게 우리 양식 4블록을 쓰게 한다.
   *  POST : 프론트가 방금 받아 둔 실측 팩트({facts:{live,tabs,stocks,supply}})를 그대로 넘긴다
   *         → 브라우저가 이미 모은 숫자를 다시 긁지 않아 빠르고, 화면과 브리핑 숫자가 같다.
   */
  if (wantAi) {
    let posted = null;
    if (req.method === 'POST') {
      try {
        const raw = await readJsonBody(req, AI_MAX_BODY);
        posted = raw && raw.facts && typeof raw.facts === 'object' ? raw : null;
      } catch (e) {
        applyCacheHeaders(res, 'no-store');
        return sendJson(
          res,
          400,
          {
            ok: false,
            reason: (e && e.code) || 'bad_body',
            message:
              (e && e.code) === 'body_too_large'
                ? '실측 팩트가 너무 커서 받지 못했습니다.'
                : '실측 팩트 본문을 읽지 못했습니다(JSON 형식 확인).',
          },
          'no-store',
        );
      }
    }
    return handleAiBriefing(req, res, { posted, fresh });
  }

  const cacheKey = 'briefing:live';

  if (!fresh) {
    const hit = memCache.get(cacheKey);
    if (hit && Date.now() - hit.at < MEM_TTL_MS) {
      res.setHeader('X-Cache', 'HIT-memory');
      applyCacheHeaders(res, CACHE_CONTROL);
      return sendJson(res, 200, hit.value, CACHE_CONTROL);
    }
  }

  const body = await collectLiveBody();
  const ok = body.ok;

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

  body.cacheControl = fresh ? REFRESH_CACHE_CONTROL : CACHE_CONTROL;
  body.fresh = fresh;
  if (!fresh) memCache.set(cacheKey, { at: Date.now(), value: body });
  res.setHeader('X-Cache', fresh ? 'BYPASS-fresh' : 'MISS');
  applyCacheHeaders(res, fresh ? REFRESH_CACHE_CONTROL : CACHE_CONTROL);
  return sendJson(res, 200, body, fresh ? REFRESH_CACHE_CONTROL : CACHE_CONTROL);
};

/* ============================================================================
 * 🤖 Gemini AI 브리핑 (?ai=1) — '⚡ 실시간 브리핑' 모달 안의 Gemini 버전
 * ----------------------------------------------------------------------------
 *  정규 정시 브리핑 14회(피클이 직접 작성)는 그대로 두고, 장중에 버튼을 눌러
 *  '지금 이 시각 실측값'으로 우리 양식 4블록을 즉석에서 받는 기능이다.
 *
 *    [📌 한줄 요약 & 지금 행동] → [📊 지수 & 수급] → [🔥 주도 테마 & 특징 종목(300억↑)]
 *    → [💡 대응 기준선 & 체크포인트]
 *
 *  원칙
 *   - FACTS(방금 수집한 실측 JSON)에 있는 수치만 쓴다. Gemini 문장에 FACTS 에 없는
 *     숫자가 있으면 그 문장은 버린다(droppedLines 로 정직하게 보고).
 *   - 값이 없으면 지어내지 않고 '미집계'로 남긴다. 300억 미만 종목은 특징 종목에 올리지 않는다.
 *   - 키 미설정·호출 실패·지연이어도 500 으로 뻗지 않는다. 실측값으로 조립한 규칙 브리핑과
 *     정직한 안내 문구를 200 으로 돌려준다.
 *   - 캐시하지 않는다(누른 시각의 브리핑이어야 하므로 no-store).
 * ==========================================================================*/

const GEMINI_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models/';
const AI_PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// 3.8 Flash 가 503(과부하)이면 0.4초 만에 실패하고 바로 다음 모델로 넘어간다.
// 실측(2026-11-26 04:00) 3.8 503 · 3 Flash 1.0초 · Lite 0.6초 → 품질 우선으로 3 Flash 를 2순위에 둔다.
const AI_FALLBACK_MODELS = ['gemini-3-flash-preview', 'gemini-flash-lite-latest'];
const AI_THINKING_UNSUPPORTED = ['gemini-flash-lite-latest'];
const AI_DEADLINE_MS = 22000; // Vercel maxDuration 60s 안에서 넉넉히
const AI_RESULT_CACHE_MS = 45000; // 같은 실측값으로 연달아 누르면 Gemini 할당량을 두 번 쓰지 않는다
const AI_EXTRAS_TIMEOUT = 13000; // /api/tabs-live (테마·상한가) 자체 호출
const AI_MAX_BODY = 1200 * 1024;
const AI_LEADER_MIN = 3e10; // 300억 — 이 아래 종목은 '특징 종목'에 올리지 않는다
const AI_MAX_LINES = 5;

const AI_WEEKDAY_KO = WEEKDAY_KO;

function aiS(v, max) {
  const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max || 120) : null;
}
function aiFmt(n, d) {
  return typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('ko-KR', { maximumFractionDigits: d == null ? 2 : d, minimumFractionDigits: 0 })
    : null;
}
function aiPct(n) {
  return typeof n === 'number' && Number.isFinite(n) ? (n > 0 ? '+' : '') + n.toFixed(2) + '%' : null;
}
function aiTone(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'flat';
  return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}
function aiEokSigned(v) {
  const n = parseNum(v);
  if (n === null) return null;
  return (n > 0 ? '+' : '') + Math.round(n).toLocaleString('ko-KR') + '억';
}
function aiTake(v, n) {
  return Array.isArray(v) ? v.slice(0, n) : [];
}
function aiObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
function aiMoney(v, text) {
  const direct = parseNum(v);
  if (direct !== null) return direct;
  return parseKoreanMoney(text || '');
}

/* --------------------------------- 본문 읽기 --------------------------------- */
async function readJsonBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > (limit || AI_MAX_BODY)) {
      const e = new Error('body_too_large');
      e.code = 'body_too_large';
      throw e;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    const e = new Error('invalid_json');
    e.code = 'invalid_json';
    throw e;
  }
}

/* --------------------------- GET 경로용 자체 보조 수집 --------------------------- */
function aiSelfOrigin(req) {
  const h = req && req.headers ? String(req.headers['x-forwarded-host'] || req.headers.host || '') : '';
  const host = h.split(',')[0].trim();
  if (!host) return null;
  const fproto = req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : '';
  const proto = fproto || (/^(localhost|127\.0\.0\.1|\[::1\])/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

async function aiFetchExtras(req) {
  const base = aiSelfOrigin(req);
  if (!base) return { tabs: null, supply: null, errors: ['자체 호출 주소(self-origin)를 확인할 수 없습니다'] };
  const errors = [];
  const [tabsR, supplyR] = await Promise.allSettled([
    fetchJson(`${base}/api/tabs-live`, { headers: { Accept: 'application/json' }, timeout: AI_EXTRAS_TIMEOUT }),
    fetchJson(`${base}/data/supply-latest.json`, { timeout: 6000 }),
  ]);
  let tabs = null;
  if (tabsR.status === 'fulfilled' && tabsR.value && typeof tabsR.value === 'object') tabs = tabsR.value;
  else errors.push(`tabs-live(테마·상한가): ${String((tabsR.reason && tabsR.reason.message) || tabsR.reason)}`);
  let supply = null;
  if (supplyR.status === 'fulfilled' && supplyR.value && typeof supplyR.value === 'object') supply = supplyR.value;
  else errors.push(`supply-latest: ${String((supplyR.reason && supplyR.reason.message) || supplyR.reason)}`);
  return { tabs, supply, errors };
}

/* --------------------------------- 팩트 정규화 --------------------------------- */
function aiNormalize(raw) {
  const posted = raw.postedFacts && typeof raw.postedFacts === 'object' ? raw.postedFacts : null;
  const live = posted ? aiObj(posted.live) : aiObj(raw.liveBody);
  const tabs = posted ? aiObj(posted.tabs) : aiObj(raw.extras && raw.extras.tabs);
  const stocksSrc = posted ? aiObj(posted.stocks) : {};
  const supplySrc = posted ? aiObj(posted.supply) : aiObj(raw.extras && raw.extras.supply);

  const idxRaw = aiTake(live.indices, 4).length ? aiTake(live.indices, 4) : aiTake(stocksSrc.indices, 4);
  const indices = idxRaw
    .map((i) => ({
      key: aiS(i && i.key, 12),
      name: aiS(i && i.name, 20),
      price: parseNum(i && i.price),
      change: parseNum(i && i.change),
      changePct: parseNum(i && i.changePct),
      value: parseNum(i && i.value),
      valueText: aiS(i && i.valueText, 24),
    }))
    .filter((i) => i.name && i.price !== null);

  const futRaw = aiTake(live.futures, 4).length ? aiTake(live.futures, 4) : aiTake(stocksSrc.futures, 4);
  const futures = futRaw
    .map((f) => ({
      name: aiS(f && f.name, 24),
      price: parseNum(f && f.price),
      changePct: parseNum(f && f.changePct),
      asOfKst: aiS(f && f.asOfKst, 20),
    }))
    .filter((f) => f.name && f.price !== null);

  const fxRaw =
    live.fx && parseNum(live.fx.price) !== null
      ? live.fx
      : stocksSrc.fx && parseNum(stocksSrc.fx.price) !== null
        ? stocksSrc.fx
        : null;
  const fx = fxRaw
    ? {
        name: aiS(fxRaw.name, 16) || '원/달러',
        price: parseNum(fxRaw.price),
        changePct: parseNum(fxRaw.changePct),
        tradedDate: aiS(fxRaw.tradedDate, 20),
      }
    : null;

  const themes = aiTake(tabs.themes, 6)
    .map((t, i) => ({
      rank: parseNum(t && t.rank) !== null ? parseNum(t && t.rank) : i + 1,
      name: aiS(t && t.name, 40),
      avgPct: parseNum(t && t.avgPct),
      riseCount: parseNum(t && t.riseCount),
      fallCount: parseNum(t && t.fallCount),
      top4Sum: parseNum(t && t.top4Sum),
      stocks: aiTake(t && t.stocks, 4)
        .map((x) => ({
          name: aiS(x && x.name, 24),
          changePct: parseNum(x && x.changePct),
          valueText: aiS(x && (x.valueDispText || x.valueText), 24),
          upperLimit: !!(x && x.upperLimit),
        }))
        .filter((x) => x.name),
    }))
    .filter((t) => t.name);

  /* 종목 후보: 화면의 거래대금 상위(stocks) + 실시간 급등/대금 상위(movers) */
  const leaderMap = new Map();
  const addLeader = (x, tag) => {
    if (!x) return;
    const name = aiS(x.name, 24);
    if (!name) return;
    const value = aiMoney(x.value, x.valueDispText || x.valueText);
    const code = aiS(x.code, 10);
    const key = code || name;
    const price = parseNum(x.price);
    if (price === null) return;
    const prev = leaderMap.get(key);
    const row = {
      name,
      code,
      market: aiS(x.market, 10),
      price,
      changePct: parseNum(x.changePct),
      value,
      valueText: aiS(x.valueDispText || x.valueText, 24) || (value !== null ? formatKoreanMoney(value) : null),
      upperLimit: !!(x && x.upperLimit),
      tag: tag || null,
    };
    if (!prev || (row.value || 0) > (prev.value || 0)) leaderMap.set(key, row);
  };
  aiTake(stocksSrc.stocks, 14).forEach((x) => addLeader(x, '거래대금'));
  aiTake(live.topMovers, 8).forEach((x) => addLeader(x, x && x.tag));

  const allLeaders = Array.from(leaderMap.values()).sort((a, b) => (b.value || 0) - (a.value || 0));
  const leaders = allLeaders.filter((x) => (x.value || 0) >= AI_LEADER_MIN).slice(0, 6);
  const belowMin = allLeaders.filter((x) => (x.value || 0) < AI_LEADER_MIN).length;

  const upper = aiObj(tabs.upperLimit);
  const upperLimit = aiTake(upper.confirmed, 4)
    .concat(aiTake(upper.watch, 4))
    .map((x) => ({
      name: aiS(x && x.name, 24),
      changePct: parseNum(x && x.changePct),
      valueText: aiS(x && (x.valueIntegText || x.valueDispText || x.valueText), 24),
      confirmed: !!(x && x.upperLimit),
    }))
    .filter((x) => x.name)
    .slice(0, 4);

  const newsSrc = aiTake(tabs.news, 6).length ? aiTake(tabs.news, 6) : aiTake(live.news, 6);
  const news = newsSrc
    .map((n) => ({ title: aiS(n && n.title, 110), press: aiS(n && n.press, 20), time: aiS(n && n.time, 10) }))
    .filter((n) => n.title)
    .slice(0, 3);

  const grab = (arr, n) =>
    aiTake(arr, n)
      .map((x) => ({
        name: aiS(x && x.name, 24),
        foreignEok: parseNum(x && x.foreignEok),
        organEok: parseNum(x && x.organEok),
        individualEok: parseNum(x && x.individualEok),
      }))
      .filter((x) => x.name);
  const groups = aiObj(supplySrc.groups);
  const hasSupply = !!(groups.foreignBuy && groups.foreignBuy.length) || !!(groups.organBuy && groups.organBuy.length);
  const supply = hasSupply
    ? {
        basisLabel: aiS(supplySrc.basisLabel, 30),
        confirmed: !!supplySrc.confirmed,
        foreignBuy: grab(groups.foreignBuy, 3),
        organBuy: grab(groups.organBuy, 3),
        foreignSell: grab(groups.foreignSell, 3),
        dualBuy: grab(groups.dualBuy, 2),
      }
    : null;

  const dataBasis = aiObj(live.dataBasis);
  let tradingDateLabel = aiS(dataBasis.tradingDateLabel, 30) || null;
  // '2026-11-25(수)' → '11/25(수)' (모바일에서 헤더·본문이 길어지지 않게)
  if (tradingDateLabel) {
    const m = tradingDateLabel.match(/^\d{4}-(\d{2})-(\d{2})(\([^)]*\))?$/);
    if (m) tradingDateLabel = `${m[1]}/${m[2]}${m[3] || ''}`;
  }
  const notes = aiTake(live.notes, 4)
    .concat(aiTake(tabs.notes, 4))
    .map((n) => aiS(n, 200))
    .filter(Boolean)
    .slice(0, 4);

  return {
    indices,
    futures,
    fx,
    themes,
    leaders,
    belowMin,
    upperLimit,
    news,
    supply,
    notes,
    tradingDateLabel,
    marketPhase: aiS(live.marketPhase, 12),
    marketPhaseLabel: aiS(live.marketPhaseLabel, 60),
    headline: aiS(live.headline, 260),
    selfCollectedErrors: aiTake(raw.extras && raw.extras.errors, 4),
  };
}

/* ------------------------------ 수치 검증(할루시네이션 차단) ------------------------------ */
function aiAllowedNumbers(f) {
  const set = new Set();
  const add = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      set.add(Number(v.toFixed(4)));
      set.add(Math.round(v));
      set.add(Number(Math.abs(v).toFixed(4)));
      set.add(Math.round(Math.abs(v)));
    }
  };
  const walk = (v, depth) => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'number') return add(v);
    if (typeof v === 'string') {
      const m = v.match(/-?\d[\d,]*(?:\.\d+)?/g) || [];
      m.forEach((t) => add(Number(t.replace(/,/g, ''))));
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v === 'object') return Object.keys(v).forEach((k) => walk(v[k], depth + 1));
  };
  walk(f, 0);
  // 문장에 자연스럽게 섞이는 번호·연도는 가격·수치 주장이 아니므로 허용한다.
  // (시각 09:00 · 15:30 은 아래 aiNumbersInLine 이 '시각'으로 보고 검사에서 빼기 때문에 여기 넣지 않는다)
  for (let i = 0; i <= 12; i++) set.add(i);
  [2024, 2025, 2026, 2027].forEach((y) => set.add(y));
  return set;
}

function aiNumbersInLine(line) {
  const out = [];
  // 시각(09:00 · 15:30)은 수치 주장이 아니므로 검사에서 뺴다 — '공포지수 30 돌파' 같은
  //   FACTS 밖 지표를 만들지 않도록 30·15 를 무조건 허용하지 않는다.
  const src = String(line || '').replace(/\d{1,2}:\d{2}/g, ' ');
  const re = /-?\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(src))) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function aiNumberAllowed(n, set) {
  if (set.has(n)) return true;
  const abs = Math.abs(n);
  if (set.has(Math.round(n)) || set.has(Math.round(abs))) return true;
  for (const a of set) {
    if (a === 0) continue;
    if (Math.abs(a - n) <= Math.max(0.05, Math.abs(a) * 0.0006)) return true;
  }
  return false;
}

function aiFilterLines(lines, allowed, max) {
  const kept = [];
  let dropped = 0;
  (Array.isArray(lines) ? lines : []).forEach((ln) => {
    const text = aiS(ln, 400);
    if (!text || text.length < 4) return;
    const bad = aiNumbersInLine(text).filter((n) => !aiNumberAllowed(n, allowed));
    if (bad.length) {
      dropped += 1;
      return;
    }
    kept.push(
      text
        .replace(/(\d(?:\.\d+)?)\s*퍼센트/g, '$1%')
        .replace(/나스닥100\s*선물\s*선물/g, '나스닥100 선물')
        .replace(/코스피\s*지수\s*지수/g, '코스피'),
    );
  });
  return { kept: kept.slice(0, max || AI_MAX_LINES), dropped };
}

/* ---------------------------------- 프롬프트 ---------------------------------- */
function aiPrompt(f, meta) {
  const factsForPrompt = {
    지금시각: meta.nowLabel,
    시장상태: meta.phaseLabel,
    데이터기준일: f.tradingDateLabel || '미확인',
    지수: f.indices.map((i) => ({
      이름: i.name,
      현재: aiFmt(i.price, 2),
      등락: aiFmt(i.change, 2),
      등락률: aiPct(i.changePct),
      거래대금: i.valueText,
    })),
    해외선물: f.futures.map((x) => ({ 이름: x.name, 현재: aiFmt(x.price, 2), 등락률: aiPct(x.changePct), 기준시각: x.asOfKst })),
    환율: f.fx
      ? { 이름: f.fx.name, 현재: aiFmt(f.fx.price, 2) + '원', 등락률: aiPct(f.fx.changePct), 기준일: f.fx.tradedDate }
      : '미집계',
    수급: f.supply
      ? {
          기준일: f.supply.basisLabel || '미상',
          확정: f.supply.confirmed,
          외국인순매수상위: f.supply.foreignBuy.map((x) => ({ 이름: x.name, 외국인: aiEokSigned(x.foreignEok) })),
          기관순매수상위: f.supply.organBuy.map((x) => ({ 이름: x.name, 기관: aiEokSigned(x.organEok) })),
          외국인순매도상위: f.supply.foreignSell.map((x) => ({ 이름: x.name, 외국인: aiEokSigned(x.foreignEok) })),
          외인기관동반매수: f.supply.dualBuy.map((x) => ({ 이름: x.name, 외국인: aiEokSigned(x.foreignEok), 기관: aiEokSigned(x.organEok) })),
        }
      : '미집계',
    주도테마: f.themes.map((t) => ({
      순위: t.rank,
      테마: t.name,
      평균등락률: aiPct(t.avgPct),
      상승: t.riseCount,
      하락: t.fallCount,
      종목: t.stocks.map((x) => ({ 이름: x.name, 등락률: aiPct(x.changePct), 거래대금: x.valueText, 상한가: x.upperLimit ? true : undefined })),
    })),
    대금300억이상_특징종목: f.leaders.map((x) => ({
      이름: x.name,
      시장: x.market,
      현재가: aiFmt(x.price, 0),
      등락률: aiPct(x.changePct),
      거래대금: x.valueText,
    })),
    상한가관찰: f.upperLimit.map((x) => ({ 이름: x.name, 등락률: aiPct(x.changePct), 거래대금: x.valueText, 확정: x.confirmed })),
    뉴스헤드라인: f.news.map((n) => n.title),
    메모: f.notes,
  };

  return {
    system:
      '너는 한국 주식시장 관제탑의 "실시간 즉석 브리핑"을 쓰는 애널리스트다. 아래 규칙을 반드시 지킨다. ' +
      '(1) 제공된 FACTS JSON 안의 수치·종목명·테마명·뉴스 제목만 근거로 쓴다. FACTS에 없는 숫자·종목·공시·목표가·지수를 절대 만들지 않는다. ' +
      '(2) 값이 없거나 모르면 그 문장을 빼고, 꼭 필요한 자리에는 "미집계"라고만 쓴다. 추측으로 빈칸을 채우지 않는다. ' +
      '(3) 확인된 사실과 해석을 구분한다. 해석 문장은 "[해석]"으로 시작한다. ' +
      '(4) 매수·매도 권유, 목표가, 수익 보장 표현을 쓰지 않는다. 행동은 "관망 / 비중 축소 / 진입 조건"처럼 조건부로만 적는다. ' +
      '(5) 테마에 🟢·🔵·🔴 색 이모지를 쓰지 않는다(전일 대조 근거가 이 FACTS에 없다). ' +
      '(6) 종목에 "대금 1위" 같은 순위 주장을 하지 않는다 — FACTS에 있는 금액만 쓴다. 테마 순위는 FACTS의 "순위"만 쓴다. ' +
      '(7) 거래대금 300억 미만 종목은 강세·특징 종목으로 쓰지 않는다(이미 FACTS에서 제외되어 있다). ' +
      '(8) 숫자는 FACTS와 똑같이 콤마·소수점을 살려 쓰고, 등락률은 % 기호로 쓴다("퍼센트"라는 단어 금지). ' +
      '(9) 장전·장마감·주말이면 첫 문장에서 "직전 거래일 마감 실측 기준"임을 밝히고, 지금 움직이는 값처럼 쓰지 않는다. ' +
      '(10) 모든 문장은 "~습니다/~입니다" 존댓말로 쓴다. 한 문장은 130자 이내, ①②③ 항목은 한 줄에 이어 쓰지 않는다. ' +
      '(11) FACTS에 없는 시장 지표(VIX·공포지수·미 10년물 금리·달러인덱스·프로그램 매매 등)를 새로 만들거나 인용하지 않는다. ' +
      '(12) "상한가"는 FACTS 종목에 상한가:true 표시가 있을 때만 쓰고, 등락률만 보고 상한가라고 단정하지 않는다.',
    user:
      `지금 시각: ${meta.nowLabel}\n시장 상태: ${meta.phaseLabel}\n데이터 기준일: ${f.tradingDateLabel || '미확인'}\n\n` +
      'FACTS:\n' +
      JSON.stringify(factsForPrompt) +
      '\n\n위 FACTS만 근거로 우리 브리핑 양식 4블록을 써라.\n' +
      '- summary.line: 한 줄 요약 — 지수 방향·핵심 수급·주도 테마 중 확인된 것만, 60자 내외.\n' +
      '- summary.action: 지금 취해야 할 행동 1줄 — "관망 / 비중 축소 / 진입 조건" 중 하나를 조건과 함께.\n' +
      '- market: 2~4문장. 코스피·코스닥 지수, 해외 선물, 원/달러, 그리고 수급(FACTS의 수급은 종목별 확정 순매수 상위다 — 시장 전체 투자자 합계로 쓰지 마라).\n' +
      '- themes: 2~4문장. FACTS의 주도테마와 "대금300억이상_특징종목"만 쓴다. 테마와 종목을 연결해 어디로 돈이 몰리는지 적는다.\n' +
      '- action: 3~5문장. 지금 이 시간대에 확인할 것, 조건이 붙은 대응(진입/관망/비중), 다음 기준선(확인 가능한 숫자만).\n' +
      '- FACTS에 없는 것은 쓰지 말고, 모르면 "미집계"로 남긴다.',
    temperature: 0.25,
    maxTokens: 1400,
    schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'object',
          properties: { line: { type: 'string' }, action: { type: 'string' } },
          required: ['line'],
        },
        market: { type: 'array', items: { type: 'string' } },
        themes: { type: 'array', items: { type: 'string' } },
        action: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'market', 'themes', 'action'],
    },
  };
}

function aiExtractJson(text) {
  let t = String(text || '').trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch (_) {
    /* 아래에서 범위 추출 */
  }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = t.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch (_) {}
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch (_) {}
  }
  return null;
}

/* -------------------------------- Gemini 호출 -------------------------------- */
async function aiCallGemini(prompt, deadline) {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    const e = new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
    e.code = 'missing_gemini_key';
    throw e;
  }
  const models = [AI_PRIMARY_MODEL].concat(AI_FALLBACK_MODELS).filter((m, i, a) => m && a.indexOf(m) === i);
  const tries = [];
  let sawQuota = true;
  for (let idx = 0; idx < models.length; idx++) {
    const model = models[idx];
    const isLast = idx === models.length - 1;
    const remaining = deadline - Date.now();
    if (remaining < 5000) {
      tries.push({ model, status: 0, message: '건너뜀(남은 시간 부족)' });
      sawQuota = false;
      continue;
    }
    // 3.8 Flash 가 과부하로 '응답 없이 매달리는' 경우가 있어(실측) 첫 시도에 시간을 다 쓰지 않는다.
    //   마지막 모델이 아니면 다음 모델 몫을 남기도록 8초 안쪽으로 제한한다.
    const attemptMs = isLast ? remaining : Math.max(5000, Math.min(9000, remaining - 6000));
    const gen = {
      temperature: prompt.temperature,
      maxOutputTokens: prompt.maxTokens,
      responseMimeType: 'application/json',
      responseSchema: prompt.schema,
    };
    if (AI_THINKING_UNSUPPORTED.indexOf(model) < 0) gen.thinkingConfig = { thinkingBudget: 0 };
    const body = {
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
      generationConfig: gen,
    };
    try {
      const data = await fetchJson(`${GEMINI_ROOT}${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: attemptMs,
      });
      const cand = ((data && data.candidates) || [])[0] || {};
      const parts = (cand.content && cand.content.parts) || [];
      const text = parts.map((x) => (x && x.text ? x.text : '')).join('').trim();
      if (!text) throw Object.assign(new Error('빈 응답(토큰 없음)'), { status: 503 });
      return { model, text, tries };
    } catch (err) {
      const status = (err && err.status) || 0;
      if (status !== 429) sawQuota = false;
      tries.push({ model, status, message: String((err && err.message) || err).slice(0, 160) });
    }
  }
  const e = new Error(sawQuota ? 'Gemini 무료 티어 요청 한도를 다 썼습니다.' : 'Gemini가 응답하지 않았습니다.');
  e.code = sawQuota ? 'quota_exceeded' : 'all_models_busy';
  e.tries = tries;
  throw e;
}

/* ------------------------------ 규칙 기반 조립(폴백) ------------------------------ */
function aiBasisLine(f, phase) {
  const day = f.tradingDateLabel;
  if (phase === '주말' || phase === '휴장' || phase === '장마감' || phase === '애프터·장마감') {
    return day
      ? `데이터 기준: 직전 거래일 ${day} 마감 실측값 — 지금 움직이는 값이 아닙니다.`
      : '데이터 기준: 마지막 체결 실측값 — 지금 움직이는 값이 아닙니다.';
  }
  return day ? `데이터 기준: ${phase} 실측값(직전 거래일 ${day} 기준 포함).` : `데이터 기준: ${phase} 실측값.`;
}

function aiMarketRows(f) {
  const rows = [];
  f.indices.forEach((i) => {
    rows.push({
      label: i.name,
      value: aiFmt(i.price, 2),
      delta: [aiFmt(i.change, 2), aiPct(i.changePct)].filter(Boolean).join(' / '),
      extra: i.valueText ? '거래대금 ' + i.valueText : null,
      tone: aiTone(i.changePct),
    });
  });
  f.futures.forEach((x) => {
    rows.push({
      label: x.name,
      value: aiFmt(x.price, 2),
      delta: aiPct(x.changePct),
      extra: x.asOfKst ? '기준 ' + x.asOfKst : null,
      tone: aiTone(x.changePct),
    });
  });
  if (f.fx && f.fx.price !== null) {
    rows.push({
      label: f.fx.name + ' 환율',
      value: aiFmt(f.fx.price, 2) + '원',
      delta: aiPct(f.fx.changePct),
      extra: f.fx.tradedDate ? '기준 ' + f.fx.tradedDate : null,
      tone: aiTone(f.fx.changePct),
    });
  }
  return rows;
}

function aiSupplyLines(f) {
  const sp = f.supply;
  if (!sp) return ['투자자별 수급: 이번 응답에 확정 수급 자료가 없습니다(미집계) — 💰 수급 탭에서 확인하세요.'];
  const basis = sp.basisLabel ? ` — ${sp.basisLabel} 거래소 확정` : ' — 거래소 확정치';
  const line = (label, arr, key) =>
    arr && arr.length
      ? `${label}: ` +
        arr
          .slice(0, 3)
          .map((x) => `${x.name} ${aiEokSigned(x[key])}`)
          .filter((x) => x.indexOf('null') < 0)
          .join(' · ') +
        basis
      : null;
  const out = [
    line('외국인 순매수 상위', sp.foreignBuy, 'foreignEok'),
    line('기관 순매수 상위', sp.organBuy, 'organEok'),
    line('외국인 순매도 상위', sp.foreignSell, 'foreignEok'),
    line('외인·기관 동반 매수', sp.dualBuy, 'foreignEok'),
  ].filter(Boolean);
  return out.length ? out : ['투자자별 수급: 확정 순매수 상위 종목이 이번 응답에 없습니다(미집계).'];
}

function aiThemeChips(f) {
  return f.themes.slice(0, 4).map((t) => ({
    rank: t.rank,
    name: t.name,
    avgPct: aiPct(t.avgPct),
    rise: t.riseCount,
    fall: t.fallCount,
    tone: aiTone(t.avgPct),
  }));
}

function aiLeaderRows(f) {
  return f.leaders.slice(0, 5).map((t) => ({
    name: t.name,
    code: t.code || null,
    market: t.market || null,
    price: aiFmt(t.price, 0),
    changePct: aiPct(t.changePct),
    tone: aiTone(t.changePct),
    valueText: t.valueText || null,
    upperLimit: !!t.upperLimit,
  }));
}

function aiThemeFactLine(f) {
  if (!f.themes.length) return '주도 테마: 이번 응답에 테마 랭킹이 없습니다(미집계) — 📈 테마 탭에서 확인하세요.';
  const top = f.themes.slice(0, 3);
  return (
    '주도 테마(테마 내 노출 종목 평균 등락률): ' +
    top.map((t) => `${t.rank}위 ${t.name} ${aiPct(t.avgPct) || '등락률 없음'}`).join(' · ') +
    (f.tradingDateLabel ? ` — ${f.tradingDateLabel} 기준.` : '.')
  );
}

function aiLeaderFactLine(f) {
  if (f.leaders.length) {
    return (
      '거래대금 300억↑ 특징 종목: ' +
      f.leaders
        .slice(0, 5)
        .map((x) => `${x.name} ${aiPct(x.changePct) || ''}${x.valueText ? '(' + x.valueText + ')' : ''}`.trim())
        .join(' · ') +
      '.'
    );
  }
  if (f.belowMin > 0) {
    return `거래대금 300억↑ 조건을 넘은 종목이 이번 응답에 없습니다(200~300억 미만 ${f.belowMin}종목 제외) — 추격 대신 관망하세요.`;
  }
  return '거래대금 300억↑ 특징 종목: 이번 응답에 종목 대금 자료가 없습니다(미집계).';
}

function aiRuleSummary(f, phaseLabel) {
  const k = f.indices.find((i) => i.key === 'KOSPI') || f.indices[0] || null;
  const q = f.indices.find((i) => i.key === 'KOSDAQ') || null;
  const bits = [];
  if (k) bits.push(`코스피 ${aiFmt(k.price, 2)}(${aiPct(k.changePct) || '등락률 미집계'})`);
  if (q) bits.push(`코스닥 ${aiFmt(q.price, 2)}(${aiPct(q.changePct) || '등락률 미집계'})`);
  const pct = k && typeof k.changePct === 'number' ? k.changePct : null;
  const trend =
    pct === null ? '방향 미확인' : pct <= -1 ? '하락 우위' : pct >= 1 ? '상승 우위' : '혼조';
  const line = bits.length ? `${bits.join(' · ')} — ${trend}.` : '지수 실측값을 받지 못했습니다 — 미집계.';
  const action =
    pct === null
      ? '지수 확인 전 관망 — 실측값이 들어오면 다시 생성하세요.'
      : pct <= -3
        ? '추격 매수 금지 · 보유 비중 점검 · 신규 진입은 지수 반등 확인 뒤로 미루세요.'
        : pct <= -1
          ? '관망 우위 · 신규 진입은 거래대금 300억↑ + 테마 동반 상승이 겹칠 때만 소액으로.'
          : pct >= 1
            ? '주도 테마 중 거래대금 300억↑ 종목의 눌림·돌파만 대응하고 추격은 피하세요.'
            : '방향 확인 전 관망 · 확인되면 주도 테마 1~2종목만 대응하세요.';
  return { line: `${line} (${phaseLabel})`, action };
}

function aiCheckpointLines(f, phase, p) {
  const out = [];
  const day = f.tradingDateLabel || '직전 거래일';
  if (phase === '주말' || phase === '휴장') {
    out.push(`${phase} — 국내 정규장이 열리지 않습니다. 지수·종목 수치는 ${day} 마감 실측값입니다.`);
  } else if (phase === '장전') {
    out.push('장전 — 09:00 정규장 개장 전입니다. 아래 수치는 직전 거래일 마감값과 개장 전 마지막 체결값입니다.');
    out.push('동시호가(08:30~09:00) 전 예상 체결가는 호가 왜곡이 있으니 시초가 확인 뒤 대응하세요.');
  } else if (phase === '정규장') {
    out.push('정규장 진행 중 — 수치는 이번 응답의 체결 시각 기준이고 15:30까지 계속 바뀝니다.');
    out.push('장중 수급은 잠정치입니다 — 종가 확정 수급과 다를 수 있습니다.');
  } else {
    out.push(`장마감 — 수치는 ${day} 종가와 시간외 마지막 체결값입니다.`);
    out.push('다음 정규장 시초가 전까지는 시간외 단일가·해외 선물 흐름만 갱신됩니다.');
  }
  const k = f.indices.find((i) => i.key === 'KOSPI') || f.indices[0] || null;
  const q = f.indices.find((i) => i.key === 'KOSDAQ') || null;
  if (k && k.changePct !== null && k.changePct <= -3) {
    out.push(`코스피 ${aiPct(k.changePct)}(${aiFmt(k.price, 2)}) 급락 — 다음 거래일 갭·변동성 확대 구간이라 시초가 추격보다 체결 확인이 먼저입니다.`);
  } else if (k && k.changePct !== null && k.changePct >= 3) {
    out.push(`코스피 ${aiPct(k.changePct)}(${aiFmt(k.price, 2)}) 급등 — 갭 상승 출발 뒤 되돌림을 시초가 5분봉으로 확인하세요.`);
  }
  if (k && q && k.changePct !== null && q.changePct !== null && Math.abs(q.changePct - k.changePct) >= 2) {
    out.push(`코스피 ${aiPct(k.changePct)} vs 코스닥 ${aiPct(q.changePct)} — 두 시장 온도차가 2%p 이상입니다(순환매·자금 이동 구간).`);
  }
  const fut = f.futures.filter((x) => x.changePct !== null);
  if (fut.length && fut.every((x) => x.changePct < 0)) {
    out.push(`해외 선물 동반 약세(${fut.map((x) => `${x.name} ${aiPct(x.changePct)}`).join(' · ')}) — 다음 국내장 시초가 방향의 참고값입니다.`);
  } else if (fut.length && fut.every((x) => x.changePct > 0)) {
    out.push(`해외 선물 동반 강세(${fut.map((x) => `${x.name} ${aiPct(x.changePct)}`).join(' · ')}) — 다음 국내장 갭 방향의 참고값입니다.`);
  }
  if (k && k.value && f.leaders.length >= 3) {
    const top3 = f.leaders.slice(0, 3).reduce((a, x) => a + (x.value || 0), 0);
    const ratio = (top3 / k.value) * 100;
    if (Number.isFinite(ratio) && ratio >= 20) {
      out.push(`거래대금 300억↑ 상위 3종목(${f.leaders.slice(0, 3).map((x) => x.name).join('·')})이 코스피 거래대금의 ${ratio.toFixed(1)}% — 자금이 소수 종목에 몰린 상태입니다.`);
    }
  }
  if (f.upperLimit.length) {
    out.push(
      `상한가 관찰: ${f.upperLimit
        .slice(0, 3)
        .map((x) => `${x.name} ${aiPct(x.changePct) || ''}${x.valueText ? '(' + x.valueText + ')' : ''}`.trim())
        .join(' · ')} — 확정 상한가가 아닌 관찰 목록입니다.`,
    );
  }
  out.push('DART 공시·기관 리포트 원문은 이 브리핑에 포함되지 않습니다 — 🚨 DART 레이더에서 확인하세요.');
  return out;
}

/* -------------------------------- 블록 조립 -------------------------------- */
function aiBuildPayload(f, opts) {
  const p = opts.p;
  const phase = opts.phase;
  const phaseLabel = opts.phaseLabel;
  const ai = opts.ai || null;
  const nowLabel = `${p.y}-${pad2(p.m)}-${pad2(p.d)}(${AI_WEEKDAY_KO[p.wd] || ''}) ${pad2(p.hh)}:${pad2(p.mi)} KST`;

  const aiSummary = ai && ai.summary ? ai.summary : null;
  const summaryLines = aiSummary
    ? [aiSummary.line, aiSummary.action].filter(Boolean)
    : [aiRuleSummary(f, phaseLabel).line, aiRuleSummary(f, phaseLabel).action];

  const marketLines = (ai && ai.market && ai.market.length ? ai.market : []).concat(aiSupplyLines(f)).slice(0, 6);
  const themeLines = (ai && ai.themes && ai.themes.length ? ai.themes : [aiThemeFactLine(f)])
    .concat([aiLeaderFactLine(f)])
    .slice(0, 5);
  const checkLines = (ai && ai.action && ai.action.length ? ai.action : []).concat(aiCheckpointLines(f, phase, p)).slice(0, 9);

  return {
    ok: true,
    mode: 'ai_briefing',
    header: `🤖 Gemini AI 실시간 브리핑`,
    generatedAt: new Date().toISOString(),
    generatedAtKst: nowLabel,
    phase,
    phaseLabel,
    marketPhase: phase,
    marketPhaseLabel: phaseLabel,
    basisLine: aiBasisLine(f, phase),
    tradingDateLabel: f.tradingDateLabel,
    blocks: [
      { key: 'summary', title: '📌 한줄 요약 & 지금 행동', lines: summaryLines, ai: !!(ai && aiSummary) },
      { key: 'market', title: '📊 지수 & 수급 (코스피·코스닥·환율·미 선물)', rows: aiMarketRows(f), lines: marketLines, ai: !!(ai && ai.market && ai.market.length) },
      {
        key: 'themes',
        title: '🔥 주도 테마 & 특징 종목 (300억↑ 대금 기준)',
        themes: aiThemeChips(f),
        leaders: aiLeaderRows(f),
        lines: themeLines,
        ai: !!(ai && ai.themes && ai.themes.length),
      },
      { key: 'checkpoints', title: '💡 대응 기준선 & 체크포인트', lines: checkLines, ai: !!(ai && ai.action && ai.action.length) },
    ],
    digest: {
      indices: f.indices.map((i) => ({ name: i.name, price: i.price, changePct: i.changePct, valueText: i.valueText })),
      futures: f.futures.map((x) => ({ name: x.name, price: x.price, changePct: x.changePct })),
      fx: f.fx ? { name: f.fx.name, price: f.fx.price, changePct: f.fx.changePct } : null,
      themesCount: f.themes.length,
      leadersCount: f.leaders.length,
      leadersBelow300: f.belowMin,
      supplyBasis: f.supply ? f.supply.basisLabel || '거래소 확정' : null,
    },
    notes: f.notes.slice(0, 3),
    news: f.news.slice(0, 3),
  };
}

/* ------------------------------- ?ai=1 핸들러 ------------------------------- */
const aiCache = new Map();

/** 같은 실측값인지 판단하는 지문 — 시장상태·지수·테마·특징종목·수급 기준일 */
function aiDigestKey(f, phase) {
  return JSON.stringify([
    phase,
    f.indices.map((i) => [i.name, i.price, i.changePct]),
    f.themes.map((t) => [t.name, t.avgPct, t.rank]),
    f.leaders.map((x) => [x.name, x.value]),
    f.supply ? f.supply.basisLabel : null,
  ]);
}

async function handleAiBriefing(req, res, opts) {
  const started = Date.now();
  const p = kstParts(new Date());
  const posted = opts && opts.posted && opts.posted.facts && typeof opts.posted.facts === 'object' ? opts.posted : null;

  let liveBody = null;
  let extras = { tabs: null, supply: null, errors: [] };
  const postedThemes = posted && posted.facts.tabs && Array.isArray(posted.facts.tabs.themes);
  const needExtras = !postedThemes || !posted.facts.tabs.themes.length;

  const jobs = [];
  const postedHasLive = !!(posted && posted.facts.live && Array.isArray(posted.facts.live.indices) && posted.facts.live.indices.length);
  if (!postedHasLive) jobs.push((async () => { liveBody = await collectLiveBody(); })());
  if (needExtras) jobs.push((async () => { extras = await aiFetchExtras(req); })());
  await Promise.allSettled(jobs);

  const f = aiNormalize({ postedFacts: posted ? posted.facts : null, liveBody, extras });

  /* 시장 국면: 실측 응답의 값을 우선하고, 없으면 서버 시각으로 판정 */
  let phase = f.marketPhase || null;
  let phaseLabel = f.marketPhaseLabel || null;
  const bp = basePhase(p);
  if (!phase) phase = bp.phase;
  if (!phaseLabel) phaseLabel = bp.label;
  if (phase === '정규장' && !f.indices.length && !posted) {
    // 아무 실측도 없으면 국면을 단정하지 않는다
    phase = bp.phase;
    phaseLabel = bp.label;
  }

  const haveFacts = !!(f.indices.length || f.futures.length || f.leaders.length || f.themes.length);
  const keyConfigured = !!(process.env.GEMINI_API_KEY && String(process.env.GEMINI_API_KEY).trim());
  const nowLabel = `${p.y}-${pad2(p.m)}-${pad2(p.d)}(${AI_WEEKDAY_KO[p.wd] || ''}) ${pad2(p.hh)}:${pad2(p.mi)} KST`;

  if (!haveFacts) {
    applyCacheHeaders(res, 'no-store');
    return sendJson(
      res,
      200,
      {
        ok: false,
        mode: 'ai_briefing',
        reason: 'no_facts',
        message:
          '지금 시각 실측값(지수·테마·종목)을 받지 못해 AI 브리핑을 만들지 않았습니다. 잠시 뒤 🔄 지금 다시 생성 을 눌러 주세요. (없는 숫자를 지어내지 않습니다.)',
        generatedAtKst: nowLabel,
        ai: { used: false, model: null, keyConfigured, reason: 'no_facts', note: null, droppedLines: 0 },
        errors: (f.selfCollectedErrors || []).slice(0, 4),
        elapsedMs: Date.now() - started,
      },
      'no-store',
    );
  }

  let aiLines = null;
  let aiMeta = { used: false, model: null, note: null, reason: null, droppedLines: 0, keyConfigured };

  /* 같은 실측값(같은 분·같은 숫자)이면 45초 안에 다시 눌러도 같은 결과를 쓰고 Gemini 를 두 번 부르지 않는다. */
  const cacheKey = aiDigestKey(f, phase);
  const cached = aiCache.get('ai');
  if (keyConfigured && cached && cached.key === cacheKey && Date.now() - cached.at < AI_RESULT_CACHE_MS) {
    aiLines = cached.value;
    aiMeta = {
      used: true,
      model: cached.model,
      note: '방금 같은 실측값으로 만든 AI 브리핑을 그대로 보여 줍니다(45초 캐시) — 45초 뒤 다시 누르면 새로 씁니다.',
      reason: null,
      droppedLines: cached.dropped || 0,
      keyConfigured,
      cached: true,
    };
    applyCacheHeaders(res, 'no-store');
    const cachedPayload = aiBuildPayload(f, { p, phase, phaseLabel, ai: aiLines });
    cachedPayload.ai = aiMeta;
    cachedPayload.errors = (f.selfCollectedErrors || []).slice(0, 4);
    cachedPayload.elapsedMs = Date.now() - started;
    cachedPayload.cacheControl = 'no-store';
    res.setHeader('X-AI-Briefing', 'ai-cached');
    return sendJson(res, 200, cachedPayload, 'no-store');
  }

  if (!keyConfigured) {
    aiMeta.reason = 'missing_gemini_key';
    aiMeta.note = 'GEMINI_API_KEY가 설정되지 않아 실측값만으로 조립했습니다 — Vercel → sd_live → Settings → Environment Variables 에 키를 넣고 Redeploy 하면 AI 브리핑이 켜집니다.';
  } else if (process.env.DISABLE_GEMINI === '1') {
    aiMeta.reason = 'gemini_disabled';
    aiMeta.note = '이 환경에서 Gemini 호출이 꺼져 있어 실측값으로 조립했습니다.';
  } else {
    try {
      const out = await aiCallGemini(aiPrompt(f, { nowLabel, phaseLabel }), Date.now() + AI_DEADLINE_MS);
      const parsed = aiExtractJson(out && out.text);
      if (!parsed) {
        aiMeta.reason = 'bad_json';
        aiMeta.note = 'Gemini 응답 형식이 깨져 실측값으로 조립했습니다(수치는 실측값).';
      } else {
        const allowed = aiAllowedNumbers(f);
        const m = aiFilterLines(parsed.market, allowed);
        const t = aiFilterLines(parsed.themes, allowed);
        const c = aiFilterLines(parsed.action, allowed);
        const sumRaw = parsed.summary && typeof parsed.summary === 'object' ? parsed.summary : {};
        const sumLine = aiFilterLines([sumRaw.line], allowed, 1);
        const sumAct = aiFilterLines([sumRaw.action], allowed, 1);
        const dropped = m.dropped + t.dropped + c.dropped + sumLine.dropped + sumAct.dropped;
        const summary = sumLine.kept.length
          ? { line: sumLine.kept[0], action: sumAct.kept[0] || null }
          : null;
        if (summary || m.kept.length || t.kept.length || c.kept.length) {
          aiLines = { summary, market: m.kept, themes: t.kept, action: c.kept };
          aiMeta = {
            used: true,
            model: out.model,
            note: dropped ? `실측에 없는 수치를 담은 AI 문장 ${dropped}개는 버리고 실측 팩트로 대신했습니다.` : null,
            reason: null,
            droppedLines: dropped,
            keyConfigured,
          };
          aiCache.set('ai', { key: cacheKey, at: Date.now(), value: aiLines, model: out.model, dropped });
        } else {
          aiMeta.reason = 'filtered_out';
          aiMeta.note = 'AI 문장이 실측 수치와 맞지 않아 실측값으로 조립했습니다(수치는 실측값).';
          aiMeta.droppedLines = dropped;
        }
      }
    } catch (err) {
      aiMeta.reason = (err && err.code) || 'ai_error';
      aiMeta.note =
        (err && err.code) === 'quota_exceeded'
          ? 'Gemini 요청 한도를 다 써서 실측값으로 조립했습니다(수치는 실측값).'
          : 'Gemini 응답이 지연·실패해 실측값으로 조립했습니다(수치는 실측값).';
      aiMeta.error = String((err && err.message) || err).slice(0, 160);
      if (err && Array.isArray(err.tries)) {
        aiMeta.tries = err.tries.map((t) => ({ model: t.model, status: t.status, message: String(t.message || '').slice(0, 80) }));
      }
    }
  }

  const payload = aiBuildPayload(f, { p, phase, phaseLabel, ai: aiLines });
  payload.ai = aiMeta;
  payload.errors = (f.selfCollectedErrors || []).slice(0, 4);
  payload.elapsedMs = Date.now() - started;
  payload.cacheControl = 'no-store';

  applyCacheHeaders(res, 'no-store');
  res.setHeader('X-AI-Briefing', aiMeta.used ? 'ai' : 'rule');
  return sendJson(res, 200, payload, 'no-store');
}
