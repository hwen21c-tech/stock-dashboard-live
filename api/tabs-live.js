'use strict';

/**
 * GET /api/tabs-live
 * ---------------------------------------------------------------------------
 * 관제탑 1번(메인) · 3번(애프터마켓) · 5번(시간별 뉴스) 탭이 쓰는 실시간 데이터를
 * 한 번에 모아 구조화 JSON 으로 돌려준다.
 *
 *  1) 8대 테마 32종목 실시간 시세        : polling.finance.naver.com (domestic/stock)
 *  2) 52주 신고가 돌파 종목              : m.stock.naver.com/api/stocks/high52week/{KOSPI,KOSDAQ}
 *  3) 거래대금 100억+ 진성 상한가 & 임박  : m.stock.naver.com/api/stocks/up/{KOSPI,KOSDAQ}
 *  4) 최신 증시 속보 뉴스 12건            : stock.naver.com/api/domestic/news/list
 *
 *  원칙
 *   - 확인된 응답값만 담는다. 없는 값은 null 로 두고 사유·전망 문장을 만들지 않는다.
 *   - 거래대금은 기존 패널과 같은 기준을 쓴다.
 *       value        = 통합(KRX+NXT, 시간외 포함) — 통합 값이 없는 종목은 정규장 값
 *       valueRegular = 정규장 단독 (참고용으로 함께 내려줌)
 *   - 상한가/임박은 반드시 "거래대금 100억 이상 & 상승률 +25% 이상"만 인정하고,
 *     100억 미만 소형주는 excluded 로 따로 분리한다. 판정과 표시는 같은 기준(통합)을 쓴다.
 *   - 일부 소스가 죽어도 나머지는 정상 반환(sources/errors 에 기록, 부분 실패 허용).
 *   - 캐시: public, s-maxage=15, stale-while-revalidate=30  (?fresh=1 → 5/10)
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
const NAVER_TIMEOUT = 5000;

const VALUE_MIN = 100 * 1e8; // 100억 원
const PCT_MIN = 25; // +25%
const WATCH_PCT_MIN = 18; // 관찰 후보 시작 상승률
const NEWS_COUNT = 12;
const HIGH52_LIMIT = 5;
const UPPER_LIMIT_MAX = 6;
const NEAR_LIMIT_MAX = 6;
const WATCH_MAX = 6;
const POLL_MAX_CODES = 60;

/* --------------------------- 8대 테마 32종목 --------------------------- */
const THEMES = [
  {
    rank: 1,
    name: '시스템반도체 · 디자인하우스',
    keyword: '시스템반도체',
    stocks: [
      { code: '399720', name: '가온칩스' },
      { code: '200710', name: '에이디테크놀로지' },
      { code: '319660', name: '피에스케이' },
      { code: '432720', name: '퀄리타스반도체' },
    ],
  },
  {
    rank: 2,
    name: '창투사 · 벤처캐피탈',
    keyword: '창투사',
    stocks: [
      { code: '241520', name: 'DSC인베스트먼트' },
      { code: '246690', name: 'TS인베스트먼트' },
      { code: '100790', name: '미래에셋벤처투자' },
      { code: '307930', name: '컴퍼니케이' },
    ],
  },
  {
    rank: 3,
    name: '건설 중소형 · 인프라 재건',
    keyword: '건설',
    stocks: [
      { code: '002990', name: '금호건설' },
      { code: '091590', name: '남화토건' },
      { code: '013580', name: '계룡건설' },
      { code: '005960', name: '동부건설' },
    ],
  },
  {
    rank: 4,
    name: '전선 · 전력 인프라',
    keyword: '전선',
    stocks: [
      { code: '024840', name: 'KBI메탈' },
      { code: '103590', name: '일진전기' },
      { code: '000500', name: '가온전선' },
      { code: '001440', name: '대한전선' },
    ],
  },
  {
    rank: 5,
    name: '지능형 로봇 · AI 제조',
    keyword: '로봇',
    stocks: [
      { code: '277810', name: '레인보우로보틱스' },
      { code: '056080', name: '유진로봇' },
      { code: '455900', name: '엔젤로보틱스' },
      { code: '454910', name: '두산로보틱스' },
    ],
  },
  {
    rank: 6,
    name: '온디바이스 AI · 뉴로모픽',
    keyword: '온디바이스',
    stocks: [
      { code: '389020', name: '자람테크놀로지' },
      { code: '077500', name: '유니퀘스트' },
      { code: '033640', name: '네패스' },
      { code: '330860', name: '네패스아크' },
    ],
  },
  {
    rank: 7,
    name: 'CXL · 차세대 메모리 & 기판',
    keyword: 'CXL',
    stocks: [
      { code: '007810', name: '코리아써키트' },
      { code: '007660', name: '이수페타시스' },
      { code: '356860', name: '티엘비' },
      { code: '222800', name: '심텍' },
    ],
  },
  {
    rank: 8,
    name: 'AI 보안 · EDR 제로트러스트',
    keyword: '보안',
    stocks: [
      { code: '263860', name: '지니언스' },
      { code: '411080', name: '샌즈랩' },
      { code: '434480', name: '모니터랩' },
      { code: '150900', name: '파수' },
    ],
  },
];

const ALL_CODES = THEMES.reduce((acc, t) => acc.concat(t.stocks.map((s) => s.code)), []);

/* ------------------------------- 캐시/시간 ------------------------------- */
const memCache = new Map();
const MEM_TTL_MS = 5000;

const pad2 = (n) => (n < 10 ? '0' : '') + n;
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
  const mi = Number(g('minute'));
  return {
    y: Number(g('year')),
    m: Number(g('month')),
    d: Number(g('day')),
    hh,
    mi,
    ss: Number(g('second')),
    wd: g('weekday'),
    minutes: hh * 60 + mi,
  };
}

function sessionOf(p, naverStatus) {
  if (p.wd === 'Sat' || p.wd === 'Sun') {
    return { phase: '주말휴장', label: `주말 휴장 (${WEEKDAY_KO[p.wd]}요일 · 직전 거래일 종가 기준)` };
  }
  if (p.minutes < 9 * 60) return { phase: '장전', label: '장전 (09:00 정규장 시작 전)' };
  if (p.minutes < 15 * 60 + 30) {
    if (naverStatus && naverStatus !== 'OPEN') {
      return { phase: '장마감', label: '장마감 (네이버 장 상태 기준)' };
    }
    return { phase: '정규장', label: '정규장 진행 중 (09:00~15:30)' };
  }
  return { phase: '장마감', label: '정규장 마감 (15:30 이후 · 시간외 반영)' };
}

/* ------------------------------ 시세 정규화 ------------------------------ */
function signedValue(v, negative) {
  const n = parseNum(v);
  if (n === null) return null;
  return negative ? -Math.abs(n) : n;
}

/** polling(개별 종목) 응답 1건 → 표준 시세 */
function normalizeQuote(d) {
  if (!d) return null;
  const integ = d.integratedPriceInfo || null;
  const over = d.overMarketPriceInfo || null;
  const sign = (d.compareToPreviousPrice && d.compareToPreviousPrice.name) || null;
  const negative = sign === 'FALLING' || sign === 'LOWER_LIMIT';

  const price = parseNum(d.closePriceRaw) ?? parseNum(d.closePrice);
  const change = signedValue(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice, negative);
  const changePct = signedValue(d.fluctuationsRatioRaw ?? d.fluctuationsRatio, negative);

  const valueRegular = parseNum(d.accumulatedTradingValueRaw);
  const valueAfter = over ? parseNum(over.accumulatedTradingValueRaw) : null;
  const valueInteg = integ ? parseNum(integ.accumulatedTradingValueRaw) : null;
  const value = valueInteg !== null ? valueInteg : valueRegular;

  const open = (integ ? parseNum(integ.openPrice) : null) ?? parseNum(d.openPriceRaw) ?? parseNum(d.openPrice);
  const high = (integ ? parseNum(integ.highPrice) : null) ?? parseNum(d.highPriceRaw) ?? parseNum(d.highPrice);
  const low = (integ ? parseNum(integ.lowPrice) : null) ?? parseNum(d.lowPriceRaw) ?? parseNum(d.lowPrice);
  const volume =
    (integ ? parseNum(integ.accumulatedTradingVolumeRaw) : null) ??
    parseNum(d.accumulatedTradingVolumeRaw) ??
    parseNum(d.accumulatedTradingVolume);

  return {
    code: d.itemCode || null,
    name: d.stockName || null,
    market: (d.stockExchangeType && d.stockExchangeType.name) || null,
    price,
    change,
    changePct,
    open,
    high,
    low,
    volume,
    value,
    valueText: formatKoreanMoney(value),
    valueRegular,
    valueRegularText: formatKoreanMoney(valueRegular),
    valueAfter,
    valueAfterText: formatKoreanMoney(valueAfter),
    valueBasis: valueInteg !== null ? '통합(KRX+NXT)' : '정규장',
    upperLimit: sign === 'UPPER_LIMIT',
    marketStatus: d.marketStatus || null,
    tradedAt: d.localTradedAt || null,
  };
}

/** 목록 API(high52week/up) 1건 → 표준 시세 (통합 대금 정보는 없음) */
function normalizeListItem(d, market) {
  if (!d) return null;
  const sign = (d.compareToPreviousPrice && d.compareToPreviousPrice.name) || null;
  const negative = sign === 'FALLING' || sign === 'LOWER_LIMIT';
  const price = parseNum(d.closePriceRaw) ?? parseNum(d.closePrice);
  const change = signedValue(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice, negative);
  const changePct = signedValue(d.fluctuationsRatio, negative);
  const value = parseNum(d.accumulatedTradingValueRaw);
  return {
    code: d.itemCode || null,
    name: d.stockName || null,
    market: market || null,
    kind: d.stockEndType || null,
    price,
    change,
    changePct,
    open: null,
    high: null,
    low: null,
    value,
    valueText: formatKoreanMoney(value),
    valueRegular: value,
    valueRegularText: formatKoreanMoney(value),
    valueBasis: '정규장',
    valueKrwHangeul: d.accumulatedTradingValueKrwHangeul || null,
    marketValueText: d.marketValueHangeul || null,
    upperLimit: sign === 'UPPER_LIMIT',
    marketStatus: d.marketStatus || null,
    tradedAt: d.localTradedAt || null,
  };
}

/** polling 결과를 목록 항목에 덮어쓴다 (통합 대금·시고저) */
function mergeQuote(item, q) {
  if (!item || !q) return item;
  if (q.high !== null && q.high !== undefined) item.high = q.high;
  if (q.low !== null && q.low !== undefined) item.low = q.low;
  if (q.open !== null && q.open !== undefined) item.open = q.open;
  if (typeof q.value === 'number') {
    item.valueInteg = q.value;
    item.valueIntegText = q.valueText;
    item.value = q.value; // 표시·판정 기준: 통합(없으면 정규장)
    item.valueText = q.valueText || item.valueText;
    item.valueBasis = q.valueBasis || item.valueBasis;
  }
  if (q.upperLimit) item.upperLimit = true;
  if (q.price !== null && q.price !== undefined) item.price = q.price;
  if (typeof q.changePct === 'number') item.changePct = q.changePct;
  return item;
}

/* -------------------------------- 수집기 -------------------------------- */

async function pollQuotes(codes) {
  const unique = Array.from(new Set(codes.filter((c) => /^[0-9A-Z]{6}$/.test(String(c)))));
  if (!unique.length) return {};
  const map = {};
  const chunks = [];
  for (let i = 0; i < unique.length; i += POLL_MAX_CODES) chunks.push(unique.slice(i, i + POLL_MAX_CODES));
  for (const chunk of chunks) {
    const url =
      'https://polling.finance.naver.com/api/realtime/domestic/stock/' + chunk.join(',') + '?_=' + Date.now();
    const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: NAVER_TIMEOUT });
    const rows = (data && data.datas) || [];
    rows.forEach((d) => {
      const q = normalizeQuote(d);
      if (q && q.code) map[q.code] = q;
    });
  }
  return map;
}

async function fetchThemeQuotes() {
  const map = await pollQuotes(ALL_CODES);
  if (!Object.keys(map).length) throw new Error('네이버 polling 응답에 종목이 없습니다');

  const themes = THEMES.map((t) => {
    const stocks = t.stocks.map((s) => {
      const q = map[s.code];
      return {
        code: s.code,
        name: s.name,
        tileName: s.name,
        ...(q || {}),
        missing: !q,
      };
    });
    const priced = stocks.filter((s) => !s.missing && s.price !== null);
    const pcts = priced.map((s) => s.changePct).filter((v) => typeof v === 'number');
    const sumValue = stocks.reduce((acc, s) => acc + (typeof s.value === 'number' ? s.value : 0), 0);
    const avgPct = pcts.length
      ? Number((pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2))
      : null;
    return {
      rank: t.rank,
      name: t.name,
      keyword: t.keyword,
      stockCount: stocks.length,
      pricedCount: priced.length,
      avgPct,
      sumValue,
      sumValueText: formatKoreanMoney(sumValue),
      stocks,
    };
  });

  const first = Object.values(map)[0];
  return { themes, map, marketStatus: (first && first.marketStatus) || null };
}

async function fetchList(kind, market) {
  const url = `https://m.stock.naver.com/api/stocks/${kind}/${market}?page=1&pageSize=100`;
  const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: NAVER_TIMEOUT });
  const rows = (data && data.stocks) || [];
  return {
    items: rows.map((d) => normalizeListItem(d, market)).filter((x) => x && x.code),
    totalCount: Number.isFinite(data && data.totalCount) ? data.totalCount : rows.length,
    marketStatus: (data && data.marketStatus) || null,
  };
}

async function fetchNews() {
  const parse = (items) =>
    (items || [])
      .filter((n) => n && n.title)
      .map((n) => {
        const dt = String(n.datetime || '');
        const m = dt.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
        return {
          title: String(n.title).replace(/\s+/g, ' ').trim(),
          press: n.officeHname || n.officeName || null,
          datetime: dt || null,
          date: m ? `${m[1]}-${m[2]}-${m[3]}` : null,
          time: m ? `${m[4]}:${m[5]}` : null,
          summary: n.subcontent ? String(n.subcontent).replace(/\s+/g, ' ').trim().slice(0, 160) : null,
          url:
            n.officeId && n.articleId
              ? `https://n.news.naver.com/article/${n.officeId}/${n.articleId}`
              : null,
          source: 'naver-news',
        };
      })
      .slice(0, NEWS_COUNT);

  try {
    const data = await fetchJson('https://stock.naver.com/api/domestic/news/list?pageSize=20', {
      headers: NAVER_HEADERS,
      timeout: NAVER_TIMEOUT,
    });
    const items = parse((data && data.articles) || []);
    if (!items.length) throw new Error('news list 가 비었습니다');
    return { items, via: 'news/list', errors: [] };
  } catch (e1) {
    const altUrl =
      'https://stock.naver.com/api/domestic/news/search?query=' +
      encodeURIComponent('증시') +
      '&page=1&pageSize=20';
    const data = await fetchJson(altUrl, { headers: NAVER_HEADERS, timeout: NAVER_TIMEOUT });
    const items = parse((data && data.items) || []);
    if (!items.length) throw new Error(`news 비었습니다 (list: ${e1.message})`);
    return { items, via: 'news/search', errors: [`news/list 실패 → search 대체: ${e1.message}`] };
  }
}

/* ------------------------------ 52주 신고가 ------------------------------ */
function collectHigh52Candidates(lists) {
  const uniq = new Map();
  lists.forEach((l) => {
    (l.items || []).forEach((it) => {
      if (it.kind !== 'stock') return; // ETF·ETN·리츠 등 제외
      if (!uniq.has(it.code)) uniq.set(it.code, it);
    });
  });
  const base = Array.from(uniq.values());
  const byValue = base
    .slice()
    .sort((a, b) => (b.value || 0) - (a.value || 0))
    .slice(0, HIGH52_LIMIT);
  const byPct = base
    .slice()
    .sort((a, b) => (b.changePct || 0) - (a.changePct || 0))
    .slice(0, HIGH52_LIMIT);
  return { base, byValue, byPct };
}

function finalizeHigh52(cand, counts) {
  if (!cand) return null;
  const { base, byValue, byPct } = cand;
  return {
    byValue,
    byPct,
    stockCount: base.length,
    counts: counts || { KOSPI: 0, KOSDAQ: 0 },
  };
}

/* --------------------- 상한가 / 임박 / 관찰 / 제외 분류 --------------------- */
function collectUpperCandidates(lists) {
  const seen = new Set();
  const c25 = [];
  const cWatch = [];
  lists.forEach((l) => {
    (l.items || []).forEach((it) => {
      if (it.kind !== 'stock' || !it.code || seen.has(it.code)) return;
      seen.add(it.code);
      if (typeof it.changePct !== 'number') return;
      if (it.changePct >= PCT_MIN) c25.push(it);
      else if (it.changePct >= WATCH_PCT_MIN) cWatch.push(it);
    });
  });
  return { c25, cWatch };
}

function buildUpperLimit(cand) {
  const confirmed = [];
  const near = [];
  const watch = [];
  const excluded = [];

  (cand.c25 || []).forEach((it) => {
    const value = typeof it.value === 'number' ? it.value : null;
    const bigEnough = value !== null && value >= VALUE_MIN;
    if (!bigEnough) {
      excluded.push({
        code: it.code,
        name: it.name,
        market: it.market,
        changePct: it.changePct,
        value,
        valueText: it.valueText || null,
        reason: '거래대금 100억 미만',
      });
      return;
    }
    const item = { ...it, gapToLimit: Number((PCT_MIN - it.changePct).toFixed(2)) };
    if (it.upperLimit) confirmed.push(item);
    else near.push(item);
  });

  (cand.cWatch || []).forEach((it) => {
    const value = typeof it.value === 'number' ? it.value : null;
    if (value === null || value < VALUE_MIN) return;
    watch.push({ ...it, gapToLimit: Number((PCT_MIN - it.changePct).toFixed(2)) });
  });

  const byValueDesc = (a, b) => (b.value || 0) - (a.value || 0);
  confirmed.sort(byValueDesc);
  near.sort(byValueDesc);
  watch.sort(byValueDesc);
  excluded.sort((a, b) => (b.changePct || 0) - (a.changePct || 0));

  return {
    confirmed: confirmed.slice(0, UPPER_LIMIT_MAX),
    near: near.slice(0, NEAR_LIMIT_MAX),
    watch: watch.slice(0, WATCH_MAX),
    excluded: excluded.slice(0, 8),
    counts: {
      confirmed: confirmed.length,
      near: near.length,
      watch: watch.length,
      excluded: excluded.length,
    },
    rules: {
      valueMin: VALUE_MIN,
      valueMinText: formatKoreanMoney(VALUE_MIN),
      pctMin: PCT_MIN,
      valueBasis: '통합(KRX+NXT) — 통합 값이 없으면 정규장',
    },
  };
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
  const cacheKey = 'tabs-live';

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

  const [themeR, highKospiR, highKosdaqR, upKospiR, upKosdaqR, newsR] = await Promise.allSettled([
    fetchThemeQuotes(),
    fetchList('high52week', 'KOSPI'),
    fetchList('high52week', 'KOSDAQ'),
    fetchList('up', 'KOSPI'),
    fetchList('up', 'KOSDAQ'),
    fetchNews(),
  ]);

  const sources = [];
  const errors = [];
  const note = (name, r) => {
    if (r.status === 'fulfilled') {
      sources.push({ name, ok: true });
      return true;
    }
    const msg = String((r.reason && r.reason.message) || r.reason);
    sources.push({ name, ok: false, error: msg });
    errors.push(`${name}: ${msg}`);
    return false;
  };

  const okTheme = note('naver-polling-themes', themeR);
  const okHighKospi = note('naver-high52week-KOSPI', highKospiR);
  const okHighKosdaq = note('naver-high52week-KOSDAQ', highKosdaqR);
  const okUpKospi = note('naver-up-KOSPI', upKospiR);
  const okUpKosdaq = note('naver-up-KOSDAQ', upKosdaqR);
  const okNews = note('naver-news', newsR);

  const themeData = okTheme ? themeR.value : { themes: [], map: {}, marketStatus: null };
  const themes = themeData.themes;
  const knownMap = themeData.map || {};

  const high52Lists = [okHighKospi ? highKospiR.value : null, okHighKosdaq ? highKosdaqR.value : null].filter(Boolean);
  const upLists = [okUpKospi ? upKospiR.value : null, okUpKosdaq ? upKosdaqR.value : null].filter(Boolean);

  const high52Cand = high52Lists.length ? collectHigh52Candidates(high52Lists) : null;
  const upperCand = upLists.length ? collectUpperCandidates(upLists) : null;

  let news = [];
  let newsVia = null;
  if (okNews) {
    news = newsR.value.items;
    newsVia = newsR.value.via;
    if (newsR.value.errors.length) errors.push(...newsR.value.errors);
  }

  /* ---- 목록 항목의 통합 거래대금·시고저를 polling 으로 보강 ---- */
  let enriched = 0;
  const targets = []
    .concat(high52Cand ? high52Cand.byValue : [])
    .concat(high52Cand ? high52Cand.byPct : [])
    .concat(upperCand ? upperCand.c25 : [])
    .concat(upperCand ? upperCand.cWatch : []);
  if (targets.length) {
    const needCodes = Array.from(new Set(targets.map((t) => t && t.code).filter(Boolean)));
    const freshCodes = needCodes.filter((c) => !knownMap[c] || !knownMap[c].value);
    try {
      const extraMap = freshCodes.length ? await pollQuotes(freshCodes) : {};
      const merged = { ...knownMap, ...extraMap };
      targets.forEach((it) => mergeQuote(it, merged[it.code]));
      enriched = freshCodes.length;
      sources.push({ name: 'naver-polling-enrich', ok: true });
    } catch (e) {
      sources.push({ name: 'naver-polling-enrich', ok: false, error: String(e.message || e) });
      errors.push(`enrich: ${e.message || e}`);
    }
  }

  const high52 = high52Cand
    ? finalizeHigh52(high52Cand, {
        KOSPI: (highKospiR.status === 'fulfilled'
          ? highKospiR.value.items.filter((i) => i.kind === 'stock').length
          : 0),
        KOSDAQ: (highKosdaqR.status === 'fulfilled'
          ? highKosdaqR.value.items.filter((i) => i.kind === 'stock').length
          : 0),
      })
    : null;

  const upperLimit = upperCand ? buildUpperLimit(upperCand) : null;

  const naverStatus =
    themeData.marketStatus ||
    (high52Lists[0] && high52Lists[0].marketStatus) ||
    (upLists[0] && upLists[0].marketStatus) ||
    null;
  const session = sessionOf(p, naverStatus);

  const notes = [];
  if (session.phase === '주말휴장') {
    notes.push('주말·휴장일에는 국내 시세가 직전 거래일(금요일) 확정 종가 기준입니다(네이버 금융).');
  }
  notes.push('거래대금은 통합(KRX+NXT·시간외 포함) 기준이며, 통합 체결이 없는 종목은 정규장 값입니다.');
  notes.push('상한가·임박은 상승률 +25% 이상 & 거래대금 100억 이상에만 부여하고, 100억 미만 소형주는 제외 목록으로 분리합니다.');

  const body = {
    ok: themes.length > 0 || Boolean(high52) || Boolean(upperLimit) || news.length > 0,
    generatedAt: now.toISOString(),
    generatedAtKst: `${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`,
    generatedAtLabel: `${p.y}-${pad2(p.m)}-${pad2(p.d)}(${WEEKDAY_KO[p.wd] || ''}) ${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)} KST`,
    sessionPhase: session.phase,
    sessionLabel: session.label,
    marketStatus: naverStatus,
    themes,
    high52,
    upperLimit,
    news,
    newsVia,
    enrichedCodes: enriched,
    notes,
    sources,
    errors,
    partial: errors.length > 0,
    elapsedMs: Date.now() - started,
    cacheControl: fresh ? REFRESH_CACHE_CONTROL : CACHE_CONTROL,
    fresh,
  };

  if (!body.ok) {
    applyCacheHeaders(res, 'no-store');
    return sendJson(
      res,
      502,
      { ...body, reason: 'upstream_failed', message: '실시간 소스에서 데이터를 받지 못했습니다.' },
      'no-store',
    );
  }

  if (!fresh) memCache.set(cacheKey, { at: Date.now(), value: body });
  res.setHeader('X-Cache', fresh ? 'BYPASS-fresh' : 'MISS');
  applyCacheHeaders(res, fresh ? REFRESH_CACHE_CONTROL : CACHE_CONTROL);
  return sendJson(res, 200, body, fresh ? REFRESH_CACHE_CONTROL : CACHE_CONTROL);
};
