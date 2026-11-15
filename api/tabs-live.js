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
 *     - 각 속보는 제목·요약 키워드 규칙(lib/news-impact.js)으로
 *       impactLevel · impactDirection · matchedThemes · beneficiaryStocks · impactNote 를 붙인다.
 *       섹터·종목 키워드가 없는 기사는 빈 배열 + '참고' + '일반 속보' 로 남긴다(가짜 매칭 금지).
 *  5) NXT(넥스트레이드) 실시간 랭킹       : stock.naver.com/api/domestic/market/stock/default
 *     - tradeType=NXT · orderType=up(상승률) / quantTop(거래대금) / searchTop(검색)
 *     - 프리마켓(08:00~08:50)·애프터마켓(15:30~20:00)에 고정 감시군 41종목 밖에서
 *       실제로 움직이는 종목을 찾아 감시군에 동적으로 합친다(없는 종목은 만들지 않는다).
 *     - 응답 items[].tradingSessionType 이 PRE_MARKET / AFTER_MARKET / REGULAR 이라
 *       세션 표기는 추측하지 않고 이 값을 그대로 쓴다.
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
const { analyzeNewsItem } = require('../lib/news-impact');

const CACHE_CONTROL = 'public, s-maxage=15, stale-while-revalidate=30';
const REFRESH_CACHE_CONTROL = 'public, s-maxage=5, stale-while-revalidate=10';
const NAVER_TIMEOUT = 5000;

const VALUE_MIN = 100 * 1e8; // 100억 원

/* --------------------------- 세션 시각(분) --------------------------- */
const PRE_START = 8 * 60; // 08:00 NXT 프리마켓 시작
const PRE_END = 8 * 60 + 50; // 08:50 NXT 프리마켓 종료
const AFTER_START = 15 * 60 + 30; // 15:30 NXT 애프터마켓 시작
const AFTER_END = 20 * 60; // 20:00 애프터마켓 종료

/* ------------------------- NXT 실시간 랭킹 API ------------------------- */
const NXT_RANK_URL = 'https://stock.naver.com/api/domestic/market/stock/default';
const NXT_RANK_HEADERS = {
  ...NAVER_HEADERS,
  Referer: 'https://stock.naver.com/',
  Origin: 'https://stock.naver.com',
};
const NXT_RANK_TIMEOUT = 3500;
const NXT_LEAD_TOP = 6; // 카드에 그리는 상위 종목 수
const NXT_DYNAMIC_MAX = 30; // 감시군에 동적으로 합칠 최대 종목 수
const NXT_SESSION_KO = { PRE_MARKET: '프리마켓', AFTER_MARKET: '애프터마켓', REGULAR: '정규장', CLOSE: '장마감' };
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

/* -------------- 감시군 확장 — RN존 11종목 · 종베 10종목 (앱 내장 목록) -------------- */
//  public/index.html 의 window.RnZone.RAW_STOCKS / window.Jongbe.STOCKS 와 같은 코드를 쓴다.
//  시간외(애프터마켓) 대금 순위는 이 감시군 안에서만 계산한다(없는 종목을 만들어 넣지 않는다).
const WATCH_RN = [
  { code: '007810', name: '코리아써키트' },
  { code: '263860', name: '지니언스' },
  { code: '002990', name: '금호건설' },
  { code: '399720', name: '가온칩스' },
  { code: '000270', name: '기아' },
  { code: '036930', name: '주성엔지니어링' },
  { code: '058470', name: '리노공업' },
  { code: '067310', name: '하나마이크론' },
  { code: '240810', name: '원익IPS' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '006400', name: '삼성SDI' },
];
const WATCH_JONGBE = [
  { code: '263860', name: '지니언스' },
  { code: '007810', name: '코리아써키트' },
  { code: '002990', name: '금호건설' },
  { code: '399720', name: '가온칩스' },
  { code: '241520', name: 'DSC인베스트먼트' },
  { code: '036930', name: '주성엔지니어링' },
  { code: '001440', name: '대한전선' },
  { code: '034020', name: '두산에너빌리티' },
  { code: '012450', name: '한화에어로스페이스' },
  { code: '000660', name: 'SK하이닉스' },
];

function buildWatchUniverse() {
  const map = new Map();
  const add = (code, name, group) => {
    if (!/^[0-9A-Z]{6}$/.test(String(code || ''))) return;
    if (!map.has(code)) map.set(code, { code, name: name || null, groups: [] });
    const it = map.get(code);
    if (!it.groups.includes(group)) it.groups.push(group);
    if (!it.name && name) it.name = name;
  };
  THEMES.forEach((t) => (t.stocks || []).forEach((s) => add(s.code, s.name, '테마')));
  WATCH_RN.forEach((s) => add(s.code, s.name, 'RN존'));
  WATCH_JONGBE.forEach((s) => add(s.code, s.name, '종베'));
  return Array.from(map.values());
}

const WATCH = buildWatchUniverse();
const WATCH_CODES = WATCH.map((w) => w.code);
const AFTER_TOP = 6; // 시간외 대금 상위
const AFTER_PCT_TOP = 5; // 시간외 등락 상위
const AFTER_PCT_BOTTOM = 3; // 시간외 등락 하위

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
  if (p.minutes >= PRE_START && p.minutes < PRE_END) {
    return {
      phase: '프리마켓',
      label: 'NXT 프리마켓 진행 중 (08:00~08:50) — 프리마켓 체결가·거래대금 기준',
    };
  }
  if (p.minutes < 9 * 60) {
    return { phase: '장전', label: '장전 (08:50 프리마켓 종료 · 09:00 정규장 시작 전)' };
  }
  if (p.minutes < 15 * 60 + 30) {
    if (naverStatus && naverStatus !== 'OPEN') {
      return { phase: '장마감', label: '장마감 (네이버 장 상태 기준)' };
    }
    return { phase: '정규장', label: '정규장 진행 중 (09:00~15:30)' };
  }
  return { phase: '장마감', label: '정규장 마감 (15:30 이후 · 시간외 반영)' };
}

/**
 * NXT 프리마켓(08:00~08:50) · 애프터마켓(15:30~20:00) 안인지.
 * 두 구간 모두 네이버 polling 의 overMarketPriceInfo(NXT 체결)가 실시간으로 갱신되므로
 * 같은 "시간외" 계열로 다루되, 표기(프리마켓/애프터마켓)는 phase 로 구분한다.
 */
function overSessionOf(p) {
  const weekday = !(p.wd === 'Sat' || p.wd === 'Sun');
  const pre = weekday && p.minutes >= PRE_START && p.minutes < PRE_END;
  const after = weekday && p.minutes >= AFTER_START && p.minutes < AFTER_END;
  if (pre) {
    return {
      inSession: true,
      phase: '프리마켓',
      label: 'NXT 프리마켓 진행 중 (08:00~08:50) — 프리마켓 체결 대금이 계속 늘어납니다',
    };
  }
  if (after) {
    return {
      inSession: true,
      phase: '애프터마켓',
      label: '시간외 세션 진행 중 (NXT 애프터마켓 15:30~20:00 · 시간외 단일가 16:00~18:00)',
    };
  }
  return {
    inSession: false,
    phase: null,
    label: '시간외 세션 아님 — 직전 거래일 시간외 체결 마감값',
  };
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

  // 시간외(NXT 애프터마켓 · 시간외 단일가) 체결가·등락률 — 전일 종가 대비
  const overSign = (over && over.compareToPreviousPrice && over.compareToPreviousPrice.name) || null;
  const overNegative = overSign === 'FALLING' || overSign === 'LOWER_LIMIT';
  const overPrice = over ? parseNum(over.overPrice) : null;
  const overPct = over ? signedValue(over.fluctuationsRatio, overNegative) : null;
  const overVolume = over ? parseNum(over.accumulatedTradingVolumeRaw) : null;
  const overTradedAt = over ? over.localTradedAt || null : null;

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
    overValue: valueAfter, // 시간외 체결 대금(원) — valueAfter 와 같은 값, 의미를 이름으로 구분
    overPrice,
    overPct,
    overVolume,
    overTradedAt,
    overMarketStatus: over ? over.overMarketStatus || null : null,
    // PRE_MARKET / AFTER_MARKET / REGULAR — NXT 체결이 어느 세션의 값인지 그대로 보존
    overSessionType: over ? over.tradingSessionType || null : null,
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

async function fetchThemeQuotes(extraCodes, premarket) {
  // 테마 32종목 + 시간외 순위용 감시군(RN존·종베 추가분) + NXT 랭킹 동적 종목을 한 번에 조회한다
  const extra = Array.isArray(extraCodes) ? extraCodes : [];
  const map = await pollQuotes(ALL_CODES.concat(WATCH_CODES).concat(extra));
  if (!Object.keys(map).length) throw new Error('네이버 polling 응답에 종목이 없습니다');

  const themes = THEMES.map((t) => {
    const stocks = t.stocks.map((s) => {
      const q = map[s.code] || {};
      // 프리마켓(08:00~08:50)에는 정규장 등락률이 0.00%로 내려온다.
      //  실제 체결은 overMarketPriceInfo(NXT 프리마켓)에 있으므로 그 값을 live* 로 함께 내린다.
      const hasOver = typeof q.overPct === 'number' && q.overPct !== null;
      const livePct = premarket && hasOver ? q.overPct : null;
      const livePrice = premarket && hasOver && typeof q.overPrice === 'number' ? q.overPrice : null;
      return {
        code: s.code,
        name: s.name,
        tileName: s.name,
        ...q,
        livePct,
        livePrice,
        livePhase: livePct === null ? null : '프리마켓',
        missing: !map[s.code],
      };
    });
    const priced = stocks.filter((s) => !s.missing && s.price !== null);
    const pcts = priced.map((s) => s.changePct).filter((v) => typeof v === 'number');
    const livePcts = stocks.map((s) => s.livePct).filter((v) => typeof v === 'number');
    const sumValue = stocks.reduce((acc, s) => acc + (typeof s.value === 'number' ? s.value : 0), 0);
    const avgPct = pcts.length
      ? Number((pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2))
      : null;
    // 프리마켓 평균은 "그 테마 종목 중 절반 이상이 프리마켓에서 거래됐을 때"만 낸다.
    //  1~2종목만 거래된 테마의 평균을 테마 등락률처럼 보여 주면 오해를 만든다.
    const needLive = Math.max(2, Math.ceil(stocks.length / 2));
    const avgPctLive =
      livePcts.length >= needLive
        ? Number((livePcts.reduce((a, b) => a + b, 0) / livePcts.length).toFixed(2))
        : null;
    return {
      rank: t.rank,
      name: t.name,
      keyword: t.keyword,
      stockCount: stocks.length,
      pricedCount: priced.length,
      avgPct,
      avgPctLive,
      livePricedCount: livePcts.length,
      liveCoverage: `${livePcts.length}/${stocks.length}`,
      livePhase: livePcts.length ? '프리마켓' : null,
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
        const title = String(n.title).replace(/\s+/g, ' ').trim();
        // 분석은 잘리기 전 원문 요약으로, 화면 표시는 160자로 자른다.
        const fullSummary = n.subcontent ? String(n.subcontent).replace(/\s+/g, ' ').trim() : null;
        const item = {
          title,
          press: n.officeHname || n.officeName || null,
          datetime: dt || null,
          date: m ? `${m[1]}-${m[2]}-${m[3]}` : null,
          time: m ? `${m[4]}:${m[5]}` : null,
          summary: fullSummary ? fullSummary.slice(0, 160) : null,
          url:
            n.officeId && n.articleId
              ? `https://n.news.naver.com/article/${n.officeId}/${n.articleId}`
              : null,
          source: 'naver-news',
        };
        return { ...item, ...analyzeNewsItem({ title, summary: fullSummary }) };
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

/* ------------------- NXT 실시간 랭킹 (프리마켓 · 애프터마켓) ------------------- */
// 네이버 데스탑 증권은 거래소를 tradeType(NXT=넥스트레이드)로 골라 랭킹을 준다.
// 프리마켓(08:00~08:50)에는 정규장 랭킹(up/high52week)이 빈 목록으로 내려오므로,
// 그 시간에 실제로 움직이는 종목은 이 NXT 랭킹으로만 확인된다.

/** upDownGb 4·5 = 하락 계열, 1 = 상한가 (LIVE-briefing 의 parseRankItem 과 같은 규칙) */
function nxtSigned(v, upDownGb) {
  const n = parseNum(v);
  if (n === null) return null;
  const gb = String(upDownGb || '');
  return gb === '4' || gb === '5' ? -Math.abs(n) : n;
}

function normalizeNxtRankItem(d) {
  if (!d || !d.itemcode) return null;
  const value = parseNum(d.tradeAmount);
  return {
    code: d.itemcode,
    name: d.itemname || null,
    market: d.sosok === '1' ? 'KOSDAQ' : d.sosok === '0' ? 'KOSPI' : null,
    kind: d.type || null,
    price: parseNum(d.nowPrice),
    change: nxtSigned(d.prevChangePrice, d.upDownGb),
    changePct: nxtSigned(d.prevChangeRate, d.upDownGb),
    open: parseNum(d.openPrice),
    high: parseNum(d.highPrice),
    low: parseNum(d.lowPrice),
    volume: parseNum(d.tradeVolume),
    value,
    valueText: formatKoreanMoney(value),
    valueBasis: 'NXT 체결',
    upperLimit: String(d.upDownGb) === '1',
    sessionType: d.tradingSessionType || null,
    marketStatus: d.marketStatus || null,
    source: 'naver-nxt-rank',
  };
}

async function fetchNxtRank(orderType, pageSize) {
  const url =
    NXT_RANK_URL +
    '?tradeType=NXT&marketType=ALL&orderType=' +
    encodeURIComponent(orderType) +
    '&startIdx=0&pageSize=' +
    String(pageSize);
  const data = await fetchJson(url, { headers: NXT_RANK_HEADERS, timeout: NXT_RANK_TIMEOUT });
  if (!Array.isArray(data) || !data.length) throw new Error(`NXT ${orderType} 목록이 비었습니다`);
  const items = data.map(normalizeNxtRankItem).filter((x) => x && x.kind === 'ST' && !isPreferredStock(x));
  if (!items.length) throw new Error(`NXT ${orderType} 주식이 없습니다`);
  return items;
}

/** NXT 랭킹 세 종류를 동시에 조회한다. 하나가 죽어도 나머지는 돌려준다. */
async function fetchNxtLeaders() {
  const [upR, quantR, searchR] = await Promise.allSettled([
    fetchNxtRank('up', 40),
    fetchNxtRank('quantTop', 40),
    fetchNxtRank('searchTop', 20),
  ]);
  const errors = [];
  const take = (name, r) => {
    if (r.status === 'fulfilled') return r.value;
    errors.push(`NXT ${name}: ${(r.reason && r.reason.message) || r.reason}`);
    return [];
  };
  const byPct = take('up', upR);
  const byValue = take('quantTop', quantR);
  const searchTop = take('searchTop', searchR);
  const sessionCount = {};
  byPct.concat(byValue).forEach((it) => {
    const k = it.sessionType || 'UNKNOWN';
    sessionCount[k] = (sessionCount[k] || 0) + 1;
  });
  const sessionType =
    Object.keys(sessionCount).sort((a, b) => sessionCount[b] - sessionCount[a])[0] || null;
  return { byPct, byValue, searchTop, sessionType, errors, ok: byPct.length + byValue.length > 0 };
}

/** 고정 감시군(테마32+RN11+종베10) 밖에서 지금 실제로 움직이는 종목 코드를 고른다. */
function pickDynamicCodes(nxt, excludeCodes) {
  const known = new Set(excludeCodes || []);
  const out = [];
  const push = (list) => {
    (list || []).forEach((it) => {
      if (!it || !it.code || known.has(it.code) || out.includes(it.code)) return;
      if (out.length >= NXT_DYNAMIC_MAX) return;
      out.push(it.code);
    });
  };
  push(nxt.byPct); // 상승률 상위 먼저
  push(nxt.byValue); // 그다음 거래대금 상위
  return out;
}

/* ------------------------------ 52주 신고가 ------------------------------ */

/** 우선주 이름 꼴 — 끝이 `우`, `우B`, `우C`, `우(전환)` 등 (예: 한진칼우 · 현대차2우B · CJ4우(전환)) */
const PREFERRED_NAME_RE = /^\S*\d*우([A-Z])?(\(전환\))?$/;

/**
 * 우선주 판별 — 이름 꼴과 종목코드를 함께 본다.
 *  · 보통주 코드는 끝자리가 0 이고, 우선주는 5·7·9 또는 K/L 같은 문자로 끝난다.
 *    (삼성전자 005930 ↔ 삼성전자우 005935, SK 034730 ↔ SK우 03473K, 한진칼 180640 ↔ 한진칼우 18064K)
 *  · 이름만으로 거르면 `성우`(458650)·`이오플로우`(294090) 같은 보통주를 오탐하므로 코드 조건을 반드시 함께 본다.
 */
function isPreferredStock(item) {
  if (!item) return false;
  const name = String(item.name || item.stockName || '').replace(/\s+/g, '');
  const code = String(item.code || item.itemCode || '').toUpperCase();
  if (!PREFERRED_NAME_RE.test(name)) return false;
  if (!/^[0-9A-Z]{6}$/.test(code)) return false;
  return !/0$/.test(code); // 보통주 코드(끝자리 0)는 우선주가 아니다
}

function collectHigh52Candidates(lists) {
  const uniq = new Map();
  const preferred = [];
  lists.forEach((l) => {
    (l.items || []).forEach((it) => {
      if (it.kind !== 'stock') return; // ETF·ETN·리츠 등 제외
      if (isPreferredStock(it)) {
        // 우선주(한진칼우 등)도 제외 — 이름·코드로만 판별하고 보통주는 건드리지 않는다
        if (!preferred.some((p) => p.code === it.code)) {
          preferred.push({ code: it.code, name: it.name, market: it.market });
        }
        return;
      }
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
  return { base, byValue, byPct, preferred };
}

function finalizeHigh52(cand, counts) {
  if (!cand) return null;
  const { base, byValue, byPct, preferred } = cand;
  const excludedPreferred = preferred || [];
  return {
    byValue,
    byPct,
    stockCount: base.length,
    counts: counts || { KOSPI: 0, KOSDAQ: 0 },
    // ETF·ETN 제외에 이어 우선주도 제외한다 — 무엇을 뺐는지 응답에 남겨 검증 가능하게 한다
    excludedPreferred,
    excludedPreferredCount: excludedPreferred.length,
    rules: {
      kind: 'stock only (ETF·ETN 제외)',
      preferred: '우선주(이름 끝 우/우B/우C/우(전환) + 코드 끝자리 0 아님) 제외',
    },
  };
}

/* --------------------- 상한가 / 임박 / 관찰 / 제외 분류 --------------------- */
function collectUpperCandidates(lists) {
  const seen = new Set();
  const c25 = [];
  const cWatch = [];
  const preferred = [];
  lists.forEach((l) => {
    (l.items || []).forEach((it) => {
      if (it.kind !== 'stock' || !it.code || seen.has(it.code)) return;
      seen.add(it.code);
      if (typeof it.changePct !== 'number') return;
      // 우선주(금호건설우 등)는 일반 보통주와 수급·호가 구조가 달라 상한가·임박 판정에서 제외한다
      if (isPreferredStock(it)) { preferred.push({ code: it.code, name: it.name, market: it.market, changePct: it.changePct }); return; }
      if (it.changePct >= PCT_MIN) c25.push(it);
      else if (it.changePct >= WATCH_PCT_MIN) cWatch.push(it);
    });
  });
  return { c25, cWatch, preferred };
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
    excludedPreferred: (cand.preferred || []).slice(0, 6),
    excludedPreferredCount: (cand.preferred || []).length,
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
      preferred: '우선주는 상한가·임박 판정에서 제외',
    },
  };
}

/* ------------------------ 시간외(애프터마켓) 대금·등락 순위 ------------------------ */

/** ISO 시각 → KST 날짜·표시 라벨 (예: 2026-11-13 / 11/13(금) 20:00) */
function kstDayLabel(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(d);
  const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return {
    date: `${g('year')}-${g('month')}-${g('day')}`,
    label: `${Number(g('month'))}/${Number(g('day'))}(${WEEKDAY_KO[g('weekday')] || ''}) ${g('hour')}:${g('minute')}`,
  };
}

/**
 * 감시군(테마32 + RN11 + 종베10 + NXT 랭킹 동적) 중 NXT 체결이 있는 종목만 모아
 * 세션(프리마켓·애프터마켓) 체결 대금·등락률 순위를 만든다.
 * 값이 없는 종목은 0으로 채우지 않고 따로 센다.
 */
function buildAftermarket(map, overSession, universe) {
  const list = Array.isArray(universe) && universe.length ? universe : WATCH;
  const rows = [];
  let noAfterCount = 0;
  let missingCount = 0;

  list.forEach((w) => {
    const q = map[w.code];
    if (!q) {
      missingCount += 1;
      return;
    }
    if (typeof q.overValue !== 'number' || q.overValue <= 0) {
      noAfterCount += 1;
      return;
    }
    const integ = typeof q.value === 'number' ? q.value : null;
    rows.push({
      code: w.code,
      name: q.name || w.name,
      market: q.market || null,
      groups: w.groups,
      price: q.price,
      changePct: q.changePct,
      overPrice: q.overPrice,
      overPct: q.overPct,
      overValue: q.overValue,
      overValueText: q.valueAfterText,
      overVolume: q.overVolume,
      overTradedAt: q.overTradedAt,
      overSessionType: q.overSessionType || null,
      value: q.value,
      valueText: q.valueText,
      // 통합 대금 중 시간외 비중 (%) — 통합 값이 있을 때만 계산
      afterSharePct: integ && integ > 0 ? Number(((q.overValue / integ) * 100).toFixed(1)) : null,
      upperLimit: Boolean(q.upperLimit),
    });
  });

  // 기준 시각 = 감시군 시간외 체결 중 가장 늦은 시각
  let basis = null;
  rows.forEach((r) => {
    const d = r.overTradedAt ? new Date(r.overTradedAt) : null;
    if (!d || Number.isNaN(d.getTime())) return;
    if (!basis || d > basis.at) {
      const lab = kstDayLabel(r.overTradedAt);
      basis = { at: d, date: lab.date, label: lab.label };
    }
  });

  // 실제 응답의 세션 타입을 그대로 집계한다(추측 금지) — PRE_MARKET / AFTER_MARKET
  const sessCount = {};
  rows.forEach((r) => {
    const k = r.overSessionType || 'UNKNOWN';
    sessCount[k] = (sessCount[k] || 0) + 1;
  });
  const basisSessionType = Object.keys(sessCount).sort((a, b) => sessCount[b] - sessCount[a])[0] || null;

  const withRank = (arr) => arr.map((r, i) => ({ ...r, rank: i + 1 }));
  const byValue = withRank(
    rows
      .slice()
      .sort((a, b) => b.overValue - a.overValue || (a.name || '').localeCompare(b.name || ''))
      .slice(0, AFTER_TOP),
  );
  const priced = rows.filter((r) => typeof r.overPct === 'number');
  const byPctTop = withRank(
    priced
      .slice()
      .sort((a, b) => b.overPct - a.overPct || b.overValue - a.overValue)
      .slice(0, AFTER_PCT_TOP),
  );
  const byPctBottom = priced
    .slice()
    .sort((a, b) => a.overPct - b.overPct || b.overValue - a.overValue)
    .slice(0, AFTER_PCT_BOTTOM)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  return {
    universe: list.length,
    universeGroups: {
      테마: THEMES.reduce((acc, t) => acc.concat((t.stocks || []).map((s) => s.code)), []).length,
      RN존: WATCH_RN.length,
      종베: WATCH_JONGBE.length,
      NXT동적: Math.max(0, list.length - WATCH.length),
    },
    withAfterCount: rows.length,
    noAfterCount,
    missingCount,
    inSession: Boolean(overSession && overSession.inSession),
    sessionPhase: (overSession && overSession.phase) || null,
    sessionLabel: (overSession && overSession.label) || null,
    basisDate: basis ? basis.date : null,
    basisLabel: basis ? basis.label : null,
    basisSessionType,
    byValue,
    byPctTop,
    byPctBottom,
    rules: {
      universe: '테마 32 + RN존 11 + 종베 10 + NXT 랭킹 동적(중복 제거)',
      metric:
        '체결 대금 = 네이버 overMarketPriceInfo 누적 체결 대금(프리마켓 08:00~08:50 · NXT 애프터마켓·시간외 단일가 15:30~20:00)',
      pct: '체결 등락률 = 세션 체결가 기준 전일 종가 대비',
      missing: '해당 세션 체결 데이터가 없는 종목은 0으로 채우지 않고 순위에서 제외',
      dynamic: 'NXT 랭킹(상승률·거래대금)에서 찾은 종목만 추가 — 없는 종목은 만들지 않음',
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
  const overSession = overSessionOf(p);
  const premarket = overSession.phase === '프리마켓';

  // 1) NXT 랭킹을 먼저 받아 "지금 실제로 움직이는 종목"을 감시군에 합친다.
  //    (프리마켓에는 정규장 랭킹이 빈 목록이라 이 경로만 유효하다)
  const nxt = await fetchNxtLeaders();
  const dynCodes = nxt.ok ? pickDynamicCodes(nxt, WATCH_CODES) : [];

  const [themeR, highKospiR, highKosdaqR, upKospiR, upKosdaqR, newsR] = await Promise.allSettled([
    fetchThemeQuotes(dynCodes, premarket),
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
  sources.push({
    name: 'naver-nxt-rank',
    ok: nxt.ok,
    detail: nxt.ok
      ? `up ${nxt.byPct.length} · quantTop ${nxt.byValue.length} · searchTop ${nxt.searchTop.length} · session ${nxt.sessionType || '—'}`
      : undefined,
    error: nxt.ok ? undefined : nxt.errors.join(' / ') || 'NXT 랭킹 실패',
  });
  if (!nxt.ok) errors.push(`NXT 랭킹: ${nxt.errors.join(' / ') || '응답 없음'}`);

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
          ? highKospiR.value.items.filter((i) => i.kind === 'stock' && !isPreferredStock(i)).length
          : 0),
        KOSDAQ: (highKosdaqR.status === 'fulfilled'
          ? highKosdaqR.value.items.filter((i) => i.kind === 'stock' && !isPreferredStock(i)).length
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

  // 3번 탭 — 감시군(고정 41 + NXT 랭킹 동적) 세션 체결 대금·등락 순위
  //  NXT 랭킹에서 찾은 종목은 같은 polling 응답(knownMap)에서 시세·체결 대금을 가져온다.
  const dynamicUniverse = dynCodes.map((code) => {
    const hit = nxt.byPct.find((x) => x.code === code) || nxt.byValue.find((x) => x.code === code) || {};
    const q = knownMap[code] || {};
    return { code, name: hit.name || q.name || null, groups: ['NXT'] };
  });
  const liveUniverse = WATCH.concat(dynamicUniverse);
  const aftermarket = buildAftermarket(knownMap, overSession, liveUniverse);

  const nxtLeaders = {
    ok: nxt.ok,
    source: 'naver NXT 랭킹 (stock.naver.com · tradeType=NXT)',
    sessionType: nxt.sessionType,
    sessionLabel: NXT_SESSION_KO[nxt.sessionType] || null,
    byPct: nxt.byPct.slice(0, NXT_LEAD_TOP),
    byValue: nxt.byValue.slice(0, NXT_LEAD_TOP),
    searchTop: nxt.searchTop.slice(0, NXT_LEAD_TOP),
    counts: { byPct: nxt.byPct.length, byValue: nxt.byValue.length, searchTop: nxt.searchTop.length },
    dynamicCodes: dynamicUniverse,
    dynamicCount: dynamicUniverse.length,
    errors: nxt.errors,
  };

  const notes = [];
  if (session.phase === '주말휴장') {
    notes.push('주말·휴장일에는 국내 시세가 직전 거래일(금요일) 확정 종가 기준입니다(네이버 금융).');
  }
  notes.push('거래대금은 통합(KRX+NXT·시간외 포함) 기준이며, 통합 체결이 없는 종목은 정규장 값입니다.');
  notes.push('상한가·임박은 상승률 +25% 이상 & 거래대금 100억 이상에만 부여하고, 100억 미만 소형주는 제외 목록으로 분리합니다.');
  if (premarket) {
    notes.push(
      '프리마켓(08:00~08:50)에는 정규장 시세가 아직 없어 8대 테마 카드의 등락률은 NXT 프리마켓 체결가(전일 종가 대비)를 쓰고, \'프리마켓\' 기준임을 표시합니다.',
    );
  }
  if (!overSession.inSession) {
    notes.push(
      `${overSession.label}${aftermarket.basisLabel ? ` (기준 ${aftermarket.basisLabel})` : ''} — 장중·주말에는 시간외 대금이 늘지 않습니다.`,
    );
  }

  const body = {
    ok:
      themes.length > 0 ||
      Boolean(high52) ||
      Boolean(upperLimit) ||
      aftermarket.withAfterCount > 0 ||
      news.length > 0,
    generatedAt: now.toISOString(),
    generatedAtKst: `${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`,
    generatedAtLabel: `${p.y}-${pad2(p.m)}-${pad2(p.d)}(${WEEKDAY_KO[p.wd] || ''}) ${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)} KST`,
    sessionPhase: session.phase,
    sessionLabel: session.label,
    marketStatus: naverStatus,
    themes,
    high52,
    upperLimit,
    aftermarket,
    nxtLeaders,
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

// 테스트(test_local.mjs)에서 우선주 판별 규칙을 직접 검증할 수 있게 내보낸다.
module.exports.isPreferredStock = isPreferredStock;
module.exports.PREFERRED_NAME_RE = PREFERRED_NAME_RE;
