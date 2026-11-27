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
  fetchBuffer,
  decodeEucKr,
  parseNum,
  formatKoreanMoney,
  sendJson,
  getQuery,
  stretchCacheControl,
  /* 🛡️ 2026-11-27 수치 가드 — 등락률·금액의 NaN/Infinity/±30% 초과를 API 단에서 한 번 더 막는다 */
  pctGuard,
  safePct,
  finiteOrNull,
  sanitizePctTree,
} = require('../lib/http');
const { analyzeNewsItem } = require('../lib/news-impact');
const { pickMaterialNews, isRealTheme, materialLine, materialTag } = require('../lib/chim-material');
const { assignThemeRoles, themeRoleMap, liquidAvgPct, liquidBasisLabel } = require('../lib/theme-roles');
/* 🔬 단계 프로파일 — TABS_PROFILE=1 일 때만 stderr 로 남긴다(응답·동작에는 영향 없음) */
const PROF_ON = process.env.TABS_PROFILE === '1';
const prof = (name, t0) => {
  if (PROF_ON) {
    try {
      console.error('[prof] ' + name + ' ' + (Date.now() - t0) + 'ms');
    } catch (e) { /* noop */ }
  }
};
/* 📐 F존·K존 — 1분봉 조회와 파동 계산을 모달(stock-live)과 같은 함수로 쓴다(2026-11-26). */
const fkzone = require('../lib/fkzone');
/* 🍔 불개미 햄버거 — 과거 장대양봉 날의 시동 3분봉 대금과 오늘 장초반 3분봉을 대조한다(2026-11-27). */
const hamburger = require('../lib/hamburger');
/* KIS 공식 API — ?mode=supply_live(장중 기관·외국인 가집계) 에서만 쓴다. 없으면 null 로 두고 503 안내. */
let kisLib = null;
try {
  kisLib = require('../lib/kis');
} catch (e) {
  kisLib = null;
}

/* 전략 실시간 판정(비중법사 · 홍인기)이 보는 종목은 재스캔 결과 파일과 같은 기준을 쓴다.
 *  public/data/*.json 은 배포 산출물에 그대로 포함되므로 require 로 읽어 기준봉 종가를 가져온다.
 *  (파일이 없거나 읽지 못하면 null → 0일차 신규 포착만 계산하고 기존 카드 판정은 생략) */
let BIJ_DATA = null;
let HONG_DATA = null;
try {
  BIJ_DATA = require('../public/data/bijoong-latest.json');
} catch (e) {
  BIJ_DATA = null;
}
try {
  HONG_DATA = require('../public/data/honginki-latest.json');
} catch (e) {
  HONG_DATA = null;
}
/* 깡토 · 종가베팅 · RN존 — 같은 재스캔 산출물(public/data)을 읽어 장중 현재가와 대조한다.
 *  파일은 매일 15:35 재스캔이 갈아끼우고 배포본에 함께 들어간다(없으면 null → 카드 판정 생략). */
let KKANGTO_DATA = null;
let JONGBE_DATA = null;
let RNZONE_DATA = null;
try {
  KKANGTO_DATA = require('../public/data/kkangto-latest.json');
} catch (e) {
  KKANGTO_DATA = null;
}
try {
  JONGBE_DATA = require('../public/data/jongbe-latest.json');
} catch (e) {
  JONGBE_DATA = null;
}
try {
  RNZONE_DATA = require('../public/data/rnzone-latest.json');
} catch (e) {
  RNZONE_DATA = null;
}

/* 직전 거래일 장마감 기준 강세 Top 8 테마 스냅샷(scripts/save_last_dynamic_themes.py 가 정규장 마감 뒤 저장).
 *  프리마켓(08:00~08:50)에는 네이버 테마 랭킹이 전 종목 0.00%(PREOPEN)로 내려오므로,
 *  고정 8대 테마(과거 기준) 대신 이 파일의 테마 구성에 오늘 아침 프리마켓 체결가를 덧씌운다. */
let LAST_DYNAMIC = null;
try {
  LAST_DYNAMIC = require('../public/data/last-dynamic-themes.json');
} catch (e) {
  LAST_DYNAMIC = null;
}

/* 🛡️ 캐시 소스 이중 가드 (2026-11-27)
 *  last-dynamic-themes.json 은 일봉 캐시로 계산한 '직전 거래일 등락률'을 담는다. 일봉 캐시는
 *  KRX 정규장 종가 기준인데 화면·네이버는 전일 NXT 최종 종가 기준이라, 기준가가 어긋나면
 *  +36.87% 같은 존재할 수 없는 값이 화면에 올라온다(11/26 실사례).
 *  → 파일을 읽는 순간 하루 ±30%(가격제한)를 넘는 값은 신뢰하지 않고 null 로 두고 원값을
 *    changePctRaw 에 남긴다. 화면에는 '—' 로 나가고, 평균·순위에서는 자동으로 빠진다. */
const LAST_DYNAMIC_GUARD = { dropped: 0, suspect: 0 };
if (LAST_DYNAMIC && Array.isArray(LAST_DYNAMIC.themes)) {
  LAST_DYNAMIC.themes.forEach((t) => {
    (t && Array.isArray(t.stocks) ? t.stocks : []).forEach((s) => {
      if (!s || !('changePct' in s)) return;
      const g = pctGuard(s.changePct);
      /* 캐시(유도 계산값)는 ±30% 초과 자체를 믿지 않는다 — 값은 버리고 원값만 남긴다 */
      if (g.suspect || (g.value === null && g.raw !== null)) {
        s.changePctRaw = g.raw;
        s.changePct = null;
        s.pctSuspect = true;
        LAST_DYNAMIC_GUARD.dropped += 1;
      }
    });
    if (t && typeof t.leaderPct === 'number' && Math.abs(t.leaderPct) > 30) {
      t.leaderPctRaw = t.leaderPct;
      t.leaderPct = null;
      t.pctSuspect = true;
      LAST_DYNAMIC_GUARD.dropped += 1;
    }
  });
}

/* 장중 실시간성은 s-maxage=15 로 유지하고, stale-while-revalidate 는 90초로 넓힌다(2026-11-27).
 *  · 30초 폴링 중에는 CDN 이 15초마다 배경에서 새 값을 받아 오므로 화면 값은 예전과 같은 15초 이내다.
 *  · 폰을 한동안 닫았다가 열 때(콜드)에는 CDN 이 **가장 최근 값을 즉시** 돌려주고 뒤에서 갱신하므로
 *    첫 화면이 0.1초대에 뜼다 — 계산이 길어지는 요청을 기다리지 않는다.
 *  · ?fresh=1(사용자가 누르는 즉시 새로고침)은 그대로 짧게 둔다(5/10). */
const CACHE_CONTROL = 'public, s-maxage=15, stale-while-revalidate=90';
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
const NXT_SESSION_KO = {
  PRE_MARKET: '프리마켓',
  AFTER_MARKET: '애프터마켓',
  REGULAR: '정규장',
  REGULAR_MARKET: '정규장',
  CLOSE: '장마감',
};
const PCT_MIN = 25; // +25%
const WATCH_PCT_MIN = 18; // 관찰 후보 시작 상승률
const NEWS_COUNT = 12;
const HIGH52_LIMIT = 5;
const UPPER_LIMIT_MAX = 6;
const NEAR_LIMIT_MAX = 6;
const WATCH_MAX = 6;
/* 네이버 polling 한 번에 넣을 종목 수. 2026-11-27 실측: 138종목을 한 요청으로 보내도
 *  0.2~0.3초에 전부 돌아온다(응답 226KB). 60 으로 자를면 3번 나눠 나가는데,
 *  서버리스 콜드에서는 새 TLS 연결을 그만큼 더 맺어 왕복이 1.8초까지 늘었다.
 *  → 한 번에 다 넣고(최대 160), 그 이상일 때만 나눈다. */
const POLL_MAX_CODES = 160;

/* ---------------- 네이버 실시간 테마 랭킹 (동적 주도 테마) ---------------- */
const THEME_RANK_URL = 'https://m.stock.naver.com/api/stocks/theme';
const THEME_DETAIL_URL = 'https://m.stock.naver.com/api/stocks/theme/';
const THEME_RANK_PAGE = 60; // 랭킹 후보로 받아 오는 테마 수(이 중 상위 8개를 화면에 쓴다)
const THEME_TOP = 8; // 화면에 그릴 테마 수
// 테마 순위는 '노출 상위 4종목' 기준으로 매긴다 → 전체 평균으로 줄 세우면 4종목짜리 테마가
//  14종목 중 대장 4개가 폭등한 테마보다 위로 올라오는 착시가 생긴다. 후보를 넉넉히 받아 상세를 본다.
const THEME_CANDIDATES = 20;
const THEME_STOCK_TOP = 4; // 테마당 그릴 종목 수
// 구성종목은 **테마 전체**를 받는다(최대 100종목 · 네이버 테마 구성 상한 100).
//  (2026-11-24) 30종목만 받으면 '테마 내 실질 거래대금 1위'가 목록 밖에 있을 때
//  카드가 1위가 아닌 종목에 💰 대금 대장 딱지를 달 수 있다 — 등락률 정렬 30개 안에
//  +3% 종목이 30개 넘게 들어오는 날이 실제로 있다. 100개 응답은 20테마 합쳐 1초 안쪽(실측 1.02s).
const THEME_STOCK_PAGE = 100;
const THEME_TIMEOUT = 4500;
// 테마 이름에 이런 말이 들어가면 주도 테마 랭킹에서 뺀다(스팩·우선주·ETF 계열)
const THEME_EXCLUDE_RE = /(스팩|SPAC|우선주|ETF|ETN|리츠|인버스|레버리지)/i;
const SPAC_RE = /(스팩|SPAC)/i;

/* ------------- 장중 실시간 후보 (비중법사 기준봉 · 홍인기 D+0) ------------- */
const KRX_RANK_URL = 'https://stock.naver.com/api/domestic/market/stock/default';
const KRX_RANK_TIMEOUT = 4500;
const KRX_PCT_TOP = 60; // 등락률 상위
const KRX_VALUE_TOP = 40; // 거래대금 상위
const FCHART_URL = 'https://fchart.stock.naver.com/sise.nhn?symbol=';
const FCHART_TIMEOUT = 3200;
const CANDLE_COUNT = 125; // 120일 전고점 + 60일 전고점 + 20일 평균거래량
const CANDLE_TTL_MS = 10 * 60 * 1000; // 일봉(과거 봉)은 장중에 변하지 않는다 — 10분 캐시
const STRAT_MAX_CANDLES = 36; // 일봉을 실제로 조회할 최대 후보 수(10초 함수 예산)
const BIJ_LIVE = { bodyRate: 10, valueEok: 300, breakDays: 60, upperMax: 12, chg: 5 };
const HONG_LIVE = { pct: 10, breakDays: 120, valueEok: 300 };

/* ⚡ 1번 탭 '오늘 장중매매 후보 — 홍인기 D+0 · 하락장 역발상' (2026-11-25 신설)
 *  원전: 홍인기 데이트레이딩 D+0/D+1 매뉴얼 — 09:30 이전 매매 자제 · 거래대금 상위 15위 이내
 *        · +5%↑ · 같은 테마 3종목 이상 동반 · 120일(6개월) 전고점 돌파/근접 · '끼' 이력
 *        · 1분봉 당일 고점 대비 절반 이상 밀리면 주도주 탈락(손절)
 *  2026-11-27 사용자 승인(#69095): 급등장 대응 위해 거래대금 15위 → 30위 확장
 *        (원전 수치는 15위 그대로 두고, 이 화면의 탐색 상한만 30위로 넓힌다) */
const HONG_D0 = {
  openMinute: 9 * 60 + 30,   // 09:30 이후부터 D+0 탐색
  valueRankMax: 30,          // 2026-11-27 사용자 승인(#69095): 15위 → 30위(급등장 대응)
  valueEok: 500,
  pct: 5,
  themeStocks: 3,
  nearHighPct: 5,
  kkDays: 90,
};
const HONG_DOWN = {
  indexPct: -1.5,      // 지수 급락장 판정
  minValueEok: 100,
  minRelPct: 0.5,      // 지수 대비 초과 성과(%p)
};
const HONG_SUPPLY_TTL_MS = 60000;

/** 직전 거래일 강세 테마 Top 8 — 재스캔이 남긴 스냅샷(public/data/last-dynamic-themes.json).
 *  하락장 역발상 트랙에서 '직전까지 강했던 섹터'를 가려내는 데만 쓴다(없으면 빈 배열). */
function lastStrongThemes() {
  try {
    const d = require('../public/data/last-dynamic-themes.json');
    const list = (d && d.themes) || [];
    return list.slice(0, 8).map((t) => String(t.name || '')).filter(Boolean);
  } catch (e) {
    return [];
  }
}
// ETF·ETN·스팩류(지수 추종 상품)는 전략 후보에서 뺀다
const FUND_NAME_RE = /(KODEX|TIGER|ARIRANG|KBSTAR|HANARO|TIMEFOLIO|히어로즈|ETN|레버리지|인버스|스팩|SPAC|리츠)/i;

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
const AFTER_TOP = 6; // 시간외 대금 상위 (기존 6건 유지 — 10억↑ 필터는 이 안에서 걸러낸다)
const AFTER_PCT_TOP = 5; // 시간외 등락 상위
const AFTER_PCT_BOTTOM = 3; // 시간외 등락 하위

/* ------------------------------- 캐시/시간 ------------------------------- */
const memCache = new Map();
const MEM_TTL_MS = 5000;
/* ?mode=supply_live 전용 — KIS 초당 20건 제한 보호용 60초 캐시 */
const supplyCache = new Map();
const SUPPLY_TTL_MS = 60000;

/* ============================================================================
 * 🌙 오늘 종가베팅 공략 후보 (2트랙) — 2026-11-24 신설 (사용자 승인)
 * ----------------------------------------------------------------------------
 *  1번 메인 탭 「🌅 오늘 시초가 공략 후보」 바로 아래 카드가 이 값을 그린다.
 *
 *  · 새 api 파일을 만들지 않는다(Vercel Hobby 12함수 한도) — 이 응답에서 이미 받아 둔
 *    테마·유니버스 종목 풀(knownMap)과 KIS 장중 가집계(60초 캐시)를 그대로 쓴다.
 *  · 트랙 ①  🔥 테마주도주 (신정재·만쥬 결)
 *      당일 거래대금 300억↑ · 등락률 +3%↑ · 윗꼬리 5% 이내(상한가 포함) · ETF·ETN·스팩·우선주 제외
 *      정렬: 테마 강도 ↓(테마 1위 > 2~3위 > 그 외, 상한가는 한 단계 가점) → 상한가·등락률 ↓ → 거래대금 ↓
 *      후보 풀: 상위 주도 테마 10개의 **전체 구성종목**(네이버 테마 상세, 5분 캐시) + 52주 신고가·상한가·NXT 랭킹
 *  · 트랙 ②  💰 수급주도주 (침착해·홍인기 결)
 *      KIS 가집계 외인·기관 양매수, 또는 한쪽 300억↑ & 반대쪽 매도 20% 이내
 *      + 거래대금 500억↑ (또는 등락률 -1% 이상 방어 + 거래대금 100억↑)
 *      정렬: 외인+기관 순매수 합산 ↓
 *      표시: 외인·기관 **양쪽 금액**을 모두 적는다 — 반대쪽은 KIS 순매도 상위 목록에서 교차 조회해
 *            매도 금액까지 채우고, 어느 목록에도 없어 확인할 수 없을 때만 '미확인'으로 남긴다(임의 숫자 금지).
 *  · 기준을 채우려 임의로 완화하지 않는다(사용자 철칙) — 충족 종목이 없으면 빈 배열과 사유를 남긴다.
 *  · 임계값 중 '한쪽 강한 매수(300억)·반대쪽 매도 20%·방어 100억'은 이 카드가 처음 만들 때
 *    정한 값이다. 바꿀 때는 사용자 확인을 받고 여기와 CP_RULES 를 함께 고친다.
 * ========================================================================== */
const CP_MAX_ROWS = 4;
const CP_THEME_MIN_VALUE_EOK = 300;
const CP_THEME_MIN_PCT = 3.0;
const CP_THEME_MAX_UPPER_PCT = 5.0;
const CP_SUPPLY_MIN_VALUE_EOK = 500;
const CP_SUPPLY_DEFENSE_PCT = -1.0;
const CP_SUPPLY_DEFENSE_MIN_VALUE_EOK = 100;
const CP_SUPPLY_STRONG_EOK = 300;
const CP_SUPPLY_WEAK_SELL_RATIO = 0.2;
const CP_SUPPLY_CACHE_KEY = 'closing_supply:v1';
/* 테마 후보 풀 확장 — 상위 주도 테마 10개의 전체 구성종목을 본다.
 *  테마 랭킹·상세는 자주 바뀌지 않으니 5분 캐시한다(Vercel 콜드스타트에서도 캐시가 없으면 한 번만 받는다). */
const CP_POOL_THEMES = 10;
const CP_POOL_CACHE_KEY = 'closing_theme_pool:v1';
const CP_POOL_TTL_MS = 5 * 60 * 1000;
const CP_POOL_MAX_POLL = 60; // 풀에서 조건을 통과한 종목의 시고저 보강 조회 상한(네이버 polling 1회)
const CP_THEME_HINT = '15:18~20 저점지지 확인 · 갭상승 시 분할익절';
const CP_SUPPLY_HINT = '오후 수급·프로그램 방어 확인 · 익일 10시 기관 대응';

const CP_RULES = {
  theme:
    '당일 거래대금 ' + CP_THEME_MIN_VALUE_EOK + '억↑ · 등락률 +' + CP_THEME_MIN_PCT +
    '%↑ · 윗꼬리 ' + CP_THEME_MAX_UPPER_PCT + '% 이내(상한가 포함) · ETF·ETN·스팩·우선주 제외',
  supply:
    'KIS 가집계 외인·기관 양매수(또는 한쪽 ' + CP_SUPPLY_STRONG_EOK + '억↑ + 반대쪽 매도 ' +
    Math.round(CP_SUPPLY_WEAK_SELL_RATIO * 100) + '% 이내) · 거래대금 ' + CP_SUPPLY_MIN_VALUE_EOK +
    '억↑(또는 ' + CP_SUPPLY_DEFENSE_PCT + '% 이상 방어 + ' + CP_SUPPLY_DEFENSE_MIN_VALUE_EOK + '억↑)',
  themeSort: '테마 강도 ↓(테마 1위 > 2~3위 > 그 외 · 상한가 가점) → 상한가·등락률 ↓ → 거래대금 ↓',
  supplySort: '외인+기관 순매수 합산 ↓',
  maxRows: CP_MAX_ROWS,
};


const pad2 = (n) => (n < 10 ? '0' : '') + n;
const WEEKDAY_KO = { Sun: '일', Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토' };

/* Intl.DateTimeFormat 은 모듈 로드 때 한 번만 만든다 — 요청마다 새로 만들면 CPU 가 그대로 쌓인다 */
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

/**
 * 통합 거래대금 표기 — `589억(NXT 445억)` / NXT 체결이 없으면 `589억`.
 *  · 앞 숫자 = 통합(KRX+NXT) 전체, 괄호 = 그중 NXT(넥스트레이드) 체결분.
 *  · 폴드8 400px 카드에서도 줄이 깨지지 않도록 괄호·라벨만 붙인 간결 표기다.
 *  · 마녀공장 2026-11-20 09:20 실측: KRX 144억 + NXT 445억 = 통합 589억.
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

/**
 * 통합·NXT·정규장 대금 3종을 한 곳에서 계산한다(모순 방지 포함).
 *  · kind='regular' : 최상위 accumulatedTradingValueRaw = KRX 정규장 대금
 *  · integratedPriceInfo.accumulatedTradingValueRaw = 통합(KRX+NXT)
 *  · overMarketPriceInfo.accumulatedTradingValueRaw = NXT 체결 대금
 *  · KRX 단독이 통합보다 큰 순간 응답(체결 시차)이 오면 통합을 KRX 로 올리고 NXT 는 0으로 둔다.
 */
function tradingValues(regular, nxtRaw, integ) {
  const valueRegular = typeof regular === 'number' ? regular : null;
  const valueInteg = typeof integ === 'number' ? integ : null;
  const valueTotal =
    valueInteg !== null && valueRegular !== null
      ? Math.max(valueInteg, valueRegular)
      : valueInteg !== null
        ? valueInteg
        : valueRegular;
  let valueNxt =
    typeof nxtRaw === 'number'
      ? nxtRaw
      : valueInteg !== null && valueRegular !== null
        ? valueInteg - valueRegular
        : null;
  if (typeof valueNxt !== 'number' || !(valueNxt > 0)) valueNxt = 0;
  if (valueTotal !== null && valueNxt >= valueTotal) valueNxt = 0; // 통합보다 큰 NXT = 응답 모순
  return { valueRegular, valueTotal, valueNxt, valueInteg };
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
  /* 🛡️ 등락률 가드 — 숫자가 아니면 null, ±30% 초과면 값은 두되 pctSuspect 로 표시한다.
   *  hard 300: 신규상장 첫날처럼 실제로 큰 값은 통과시키고, 사람이 만든 깨진 값만 버린다. */
  const changePctGuard = pctGuard(signedValue(d.fluctuationsRatioRaw ?? d.fluctuationsRatio, negative), { hard: 300 });
  const changePct = changePctGuard.value;

  const valueRegular = parseNum(d.accumulatedTradingValueRaw);
  const valueAfter = over ? parseNum(over.accumulatedTradingValueRaw) : null;
  const valueInteg = integ ? parseNum(integ.accumulatedTradingValueRaw) : null;
  /* 표시·판정 기준은 통합(KRX+NXT) — NXT 체결분까지 포함해야 마녀공장처럼 NXT 로 돈이 몬 종목이
   *  KRX 단독 대금 때문에 아래 순위로 밀리지 않는다. */
  const tv = tradingValues(valueRegular, valueAfter, valueInteg);
  const value = tv.valueTotal;
  const valueNxt = tv.valueNxt;

  // 시간외(NXT 애프터마켓 · 시간외 단일가) 체결가·등락률 — 전일 종가 대비
  const overSign = (over && over.compareToPreviousPrice && over.compareToPreviousPrice.name) || null;
  const overNegative = overSign === 'FALLING' || overSign === 'LOWER_LIMIT';
  const overPrice = over ? parseNum(over.overPrice) : null;
  const overPctGuard = over ? pctGuard(signedValue(over.fluctuationsRatio, overNegative), { hard: 300 }) : { value: null, suspect: false };
  const overPct = overPctGuard.value;
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
    valueText: formatKoreanMoney(value),           // 통합 대금 숫자만 (기존 계약 유지)
    valueTotal: tv.valueTotal,
    valueTotalText: formatKoreanMoney(tv.valueTotal),
    valueNxt: valueNxt || null,
    valueNxtText: valueNxt > 0 ? formatKoreanMoney(valueNxt) : null,
    valueDispText: valueLabelText(tv.valueTotal, valueNxt),  // '589억(NXT 445억)'
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
    /* 이상 등락률이면 화면·평균이 참고할 수 있게 플래그만 남긴다(값 자체는 위에서 보정·보존) */
    ...(changePctGuard.suspect || overPctGuard.suspect
      ? {
          pctSuspect: true,
          ...(changePctGuard.suspect ? { changePctRaw: changePctGuard.raw } : {}),
          ...(overPctGuard.suspect ? { overPctRaw: overPctGuard.raw } : {}),
        }
      : {}),
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

/**
 * NXT 시간외(프리마켓·애프터마켓)에 '실제 체결'이 있었는지.
 *  · 장전(PREOPEN)에는 체결이 0건인데도 네이버가 overMarketPriceInfo 를
 *    overPrice=종가 · overVolume="-" · fluctuationsRatio=0.00 으로 채워 내려준다.
 *    (2026-11-19 08:20 실측: 삼성전자 overVolume="-" · overPct=0.00)
 *  · 이걸 프리마켓 체결로 읽으면 화면의 전일 확정 등락률이 0.00% 로 덮인다.
 *  → 거래량이 있거나 등락률이 0이 아닐 때만 '체결 있음'으로 본다.
 */
function overTraded(q) {
  if (!q || typeof q.overPct !== 'number' || q.overPct === null) return false;
  if (typeof q.overVolume === 'number' && q.overVolume > 0) return true;
  return q.overPct !== 0;
}

/** polling 결과를 목록 항목에 덮어쓴다 (통합 대금·NXT 대금·시고저) */
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
    // NXT 병기 표기용 3종 — 화면은 valueDispText 를 쓴다
    item.valueTotal = q.valueTotal !== null && q.valueTotal !== undefined ? q.valueTotal : q.value;
    item.valueTotalText = q.valueTotalText || q.valueText;
    item.valueNxt = q.valueNxt || 0;
    item.valueNxtText = q.valueNxtText || null;
    if (q.valueDispText) item.valueDispText = q.valueDispText;
    if (q.valueRegular !== null && q.valueRegular !== undefined) item.valueRegularKrx = q.valueRegular;
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
  const tPoll = Date.now();
  /* ⚡ 청크(최대 160종목)는 병렬로 받는다 — 순차 대기하면 3번의 왕복이 그대로 응답 시간에 붙는다
   *    (2026-11-27 콜드 응답 단축). 네이버 polling 은 여러 요청을 동시에 받는다.
   *  한 청크가 실패해도 나머지 청크의 시세는 살린다(전부 실패했을 때만 오류로 올린다) —
   *  한 번의 타임아웃으로 테마 탭 전체가 비는 것을 막는다. */
  const chunkErrors = [];
  await Promise.all(
    chunks.map(async (chunk) => {
      const url =
        'https://polling.finance.naver.com/api/realtime/domestic/stock/' + chunk.join(',') + '?_=' + Date.now();
      try {
        const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: NAVER_TIMEOUT });
        const rows = (data && data.datas) || [];
        rows.forEach((d) => {
          const q = normalizeQuote(d);
          if (q && q.code) map[q.code] = q;
        });
      } catch (e) {
        chunkErrors.push(String((e && e.message) || e));
      }
    }),
  );
  prof('pollQuotes(' + unique.length + ' codes / ' + chunks.length + ' chunks)', tPoll);
  if (!Object.keys(map).length && chunkErrors.length) throw new Error(chunkErrors[0]);
  return map;
}

/* ---- 고정 THEMES → 화면용 테마(동적 테마 API 가 실패했을 때만 쓰는 폴백) ---- */
function mapStaticThemes(map, premarket) {
  return THEMES.map((t) => {
    const stocks = t.stocks.map((s) => {
      const q = map[s.code] || {};
      // 프리마켓(08:00~08:50)에는 정규장 등락률이 0.00%로 내려온다.
      //  실제 체결은 overMarketPriceInfo(NXT 프리마켓)에 있으므로 그 값을 live* 로 함께 내린다.
      //  단, 체결 0건인 장전 응답(0.00%)은 프리마켓 값으로 쓰지 않는다 — 전일 확정 등락률이 지워진다.
      const hasOver = overTraded(q);
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
}

/* ---------------- 네이버 테마 랭킹 · 구성종목 (동적 주도 테마) ---------------- */

/** 테마 구성종목 1건 → 표준 시세 (open/high/low 는 이 API 에 없어 polling 으로 보강) */
/* 🔁 같은 순간의 '테마 랭킹'·'테마 구성종목' 요청은 한 번만 나간다 (2026-11-27 콜드 응답 단축)
 *  · 한 요청 안에서 1번 탭 테마맵(buildDynamicThemes)과 종가베팅 테마 풀(fetchClosingThemeMembers)이
 *    같은 랭킹· 같은 구성종목을 각각 불러 30번 넘는 요청이 동시에 네이버로 몰렸다 —
 *    그 탑으로 응답이 느려지고 구성종목이 일부 실패했다.
 *  · 15초 안에 같은 키를 다시 찾으면 그 약속(Promise)을 그대로 돌려준다 — 실패한 약속은 재시도가
 *    가능하도록 캐시에서 지운다(실패를 15초 동안 굳히지 않는다). */
const THEME_SHARED_TTL_MS = 15000;
const themeSharedMemo = new Map();
function themeSharedFetch(key, fn) {
  const hit = themeSharedMemo.get(key);
  if (hit && Date.now() - hit.at < THEME_SHARED_TTL_MS) return hit.promise;
  const promise = fn();
  themeSharedMemo.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    const cur = themeSharedMemo.get(key);
    if (cur && cur.promise === promise) themeSharedMemo.delete(key);
  });
  if (themeSharedMemo.size > 80) themeSharedMemo.clear();  // 메모리 보호(오래된 키 정리)
  return promise;
}

function normalizeThemeStock(d) {
  if (!d) return null;
  const sign = (d.compareToPreviousPrice && d.compareToPreviousPrice.name) || null;
  const negative = sign === 'FALLING' || sign === 'LOWER_LIMIT';
  const price = parseNum(d.closePriceRaw) ?? parseNum(d.closePrice);
  const value = parseNum(d.accumulatedTradingValueRaw);
  return {
    code: d.itemCode || null,
    name: d.stockName || null,
    kind: d.stockEndType || null,
    market: d.sosok === '1' ? 'KOSDAQ' : d.sosok === '0' ? 'KOSPI' : null,
    price,
    change: signedValue(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice, negative),
    changePct: signedValue(d.fluctuationsRatio, negative),
    volume: parseNum(d.accumulatedTradingVolumeRaw),
    open: null,
    high: null,
    low: null,
    value,
    valueText: formatKoreanMoney(value),
    valueBasis: '정규장',
    upperLimit: sign === 'UPPER_LIMIT',
    tradedAt: d.localTradedAt || null,
  };
}

/** 테마 번호 → 구성종목(주식만 · 우선주·스팩 제외) */
async function fetchThemeStocks(no) {
  const url = THEME_DETAIL_URL + String(no) + '?page=1&pageSize=' + String(THEME_STOCK_PAGE);
  const data = await themeSharedFetch('stocks:' + String(no), () =>
    fetchJson(url, { headers: NAVER_HEADERS, timeout: THEME_TIMEOUT }),
  );
  const rows = (data && data.stocks) || [];
  if (!rows.length) throw new Error('구성종목이 비었습니다');
  return rows
    .map(normalizeThemeStock)
    .filter((s) => s && s.code && s.kind === 'stock' && !isPreferredStock(s))
    .filter((s) => !SPAC_RE.test(String(s.name || '')));
}

/**
 * 테마 안에서 카드에 올릴 4종목 — 상승률 대장 · 실질 거래대금 대장을 먼저 세우고
 * 남은 자리는 상승률·대금 순으로 채운다(같은 종목은 한 번만).
 */
function pickThemeStocks(stocks) {
  /* 역할 규칙(상승률 대장 · +3%↑ 실질 거래대금 대장 · 이상치 ±100% 제외 · 같은 종목이면 '상승률 대장'만)은
     lib/theme-roles.js 한 곳에 있다 — 정적 렌더·프리마켓 스냅샷·저장 스크립트와 같은 규칙을 쓰기 위해 옮겼다(2026-11-24).
     ※ 30종목만 넘기면 '테마 내 1위'가 목록 밖일 수 있으니 호출부는 테마 전체를 넘긴다. */
  return assignThemeRoles(stocks, THEME_STOCK_TOP);
}

/**
 * 오늘 장중 실제 강세 테마 Top 8 (네이버 테마 랭킹 실측).
 *  · 랭킹: /api/stocks/theme?page=1&pageSize=60 → no · name · changeRate · riseCount · fallCount · totalCount
 *  · 구성종목: /api/stocks/theme/{no}?page=1&pageSize=30
 *  · 스팩·우선주·ETF 계열 테마는 제외하고, 등락률 내림차순(동률이면 상승종목 비율)으로 자른다.
 *  · 값을 만들지 않는다 — 실패한 테마는 목록에서 빼고 errors 에 남긴다.
 */
async function buildDynamicThemes(mark) {
  const tDyn = Date.now();
  const mm = typeof mark === 'function' ? mark : () => {};
  const errors = [];
  let groups = [];
  let marketStatus = null;
  try {
    const data = await themeSharedFetch('rank:' + String(THEME_RANK_PAGE), () =>
      fetchJson(THEME_RANK_URL + '?page=1&pageSize=' + String(THEME_RANK_PAGE), {
        headers: NAVER_HEADERS,
        timeout: THEME_TIMEOUT,
      }),
    );
    groups = (data && data.groups) || [];
    marketStatus = (data && data.marketStatus) || null;
    if (!groups.length) throw new Error('테마 랭킹 목록이 비었습니다');
  } catch (e) {
    return {
      ok: false,
      themes: [],
      codes: [],
      errors: ['테마 랭킹: ' + String((e && e.message) || e)],
      total: 0,
      marketStatus: null,
    };
  }

  const rows = groups
    .map((g) => {
      const total = parseNum(g.totalCount) || 0;
      const rise = parseNum(g.riseCount) || 0;
      return {
        no: parseNum(g.no),
        name: String(g.name || '').replace(/\s+/g, ' ').trim(),
        changeRate: parseNum(g.changeRate),
        riseCount: rise,
        fallCount: parseNum(g.fallCount) || 0,
        steadyCount: parseNum(g.steadyCount) || 0,
        totalCount: total,
        riseRatio: total ? Number(((rise / total) * 100).toFixed(1)) : null,
      };
    })
    .filter((g) => g.no && g.name && !THEME_EXCLUDE_RE.test(g.name))
    .filter((g) => typeof g.changeRate === 'number' && g.totalCount >= 3)
    .sort(
      (a, b) =>
        b.changeRate - a.changeRate || (b.riseRatio || 0) - (a.riseRatio || 0) || b.totalCount - a.totalCount,
    );

  const top = rows.slice(0, THEME_CANDIDATES);
  prof('dyn.rank', tDyn);
  mm('theme.rank');
  const settled = await Promise.allSettled(top.map((g) => fetchThemeStocks(g.no)));
  prof('dyn.details(' + top.length + ')', tDyn);
  mm('theme.details');
  const themes = [];
  const codes = [];
  top.forEach((g, i) => {
    const r = settled[i];
    if (r.status !== 'fulfilled' || !r.value.length) {
      errors.push(
        '테마 ' + g.name + ': ' + String((r.reason && r.reason.message) || (r.reason || '구성종목 없음')),
      );
      return;
    }
    const picked = pickThemeStocks(r.value);
    if (!picked.length) return;
    picked.forEach((s) => {
      if (!codes.includes(s.code)) codes.push(s.code);
    });
    /* 📊 테마 순위·막대 기준 = **거래대금 300억↑ 종목들(최대 4) 평균 등락률** (2026-11-24 사용자 확정).
     *  예전엔 '화면 노출 4종목 평균'이라, 20억짜리 소형 1개가 +90% 튀면 다른 테마보다 위로 올라왔다.
     *  300억↑만 모아 평균을 내면 '큰 돈이 여러 종목에 함께 들어온 테마'가 위로 온다.
     *  장 초반(09:00~09:30)에 300억↑가 없으면 100억↑ 평균으로 폴백하고 저유동성으로 표시한다.
     *  ※ 테마 **전체 구성종목**(r.value)으로 계산한다 — 노출 4종목만 넘기면 '테마 내'가 아니라 '카드 안' 평균이 된다. */
    const basis = liquidAvgPct(r.value);
    /* 노출 상위 4종목 평균 — 순위에는 쓰지 않고 참고값으로만 남긴다 */
    const shown = picked.slice(0, THEME_STOCK_TOP);
    const shownPcts = shown.map((x) => x.changePct).filter((v) => typeof v === 'number');
    const top4Avg = shownPcts.length
      ? Number((shownPcts.reduce((a, b) => a + b, 0) / shownPcts.length).toFixed(2))
      : null;
    const top4Sum = shown.reduce((acc, x) => acc + (typeof x.value === 'number' ? x.value : 0), 0);
    themes.push({
      rank: themes.length + 1,
      name: g.name,
      keyword: g.name,
      themeNo: g.no,
      avgPct: g.changeRate,       // 네이버 공식 테마 평균(전체 종목) — 참고용
      avgPctLive: null,
      top4Avg,                    // 노출 상위 4종목 평균 — 참고값
      top4Sum,
      /* 순위·막대 = 대금 300억↑ 평균(없으면 100억↑ 저유동성) */
      basisPct: basis.pct,
      basisCount: basis.count,
      basisSampleCodes: basis.codes,
      lowLiquidity: basis.lowLiquidity,
      avgPctCalc: basis.pct,
      avgPctBasisLabel: liquidBasisLabel(basis),
      riseCount: g.riseCount,
      fallCount: g.fallCount,
      steadyCount: g.steadyCount,
      riseRatio: g.riseRatio,
      stockCount: g.totalCount,
      membersShown: picked.length,
      stocks: picked,
    });
  });
  /* 순위 = 대금 300억↑ 종목 평균 등락률 → 동률이면 노출 4종목 합산 대금.
   * 100억↑도 없는 테마(소형주만 있는 테마)는 맨 뒤로 밀린다. */
  themes.sort(
    (a, b) =>
      (b.basisPct ?? -999) - (a.basisPct ?? -999) || (b.top4Sum ?? 0) - (a.top4Sum ?? 0),
  );
  const limited = themes.slice(0, THEME_TOP);
  limited.forEach((t, i) => {
    t.rank = i + 1;
  });
  return { ok: limited.length > 0, themes: limited, codes, errors, total: rows.length, marketStatus };
}

/** 테마 카드 종목에 polling 시세(시·고·저·통합 거래대금)를 덮는다 */
function mergeThemeQuotes(themes, map, premarket) {
  return (themes || []).map((t) => {
    const merged = (t.stocks || []).map((s) => {
      const q = map[s.code] || null;
      if (!q) return { ...s, tileName: s.name, missing: true };
      const hasOver = overTraded(q);
      const livePct = premarket && hasOver ? q.overPct : null;
      const livePrice = premarket && hasOver && typeof q.overPrice === 'number' ? q.overPrice : null;
      return {
        ...s,
        ...q,
        tileName: s.name,
        role: s.role || null,
        livePct,
        livePrice,
        livePhase: livePct === null ? null : '프리마켓',
        missing: false,
      };
    });
    /* 🔁 노출 4종목 재선정 — 테마 구성종목 목록에는 KRX 정규장 대금만 실려 오므로,
     *  통합(KRX+NXT) 시세가 붙은 뒤 다시 고른다. 이걸 빼면 마녀공장(NXT 445억, 통합 589억)이
     *  한국화장품(KRX 236억) 아래로 밀려 '대금 대장'을 놓친다(2026-11-20 00:13 실사례). */
    const stocks = merged.length ? pickThemeStocks(merged) : merged;
    const priced = stocks.filter((s) => !s.missing && s.price !== null);
    const pcts = priced.map((s) => s.changePct).filter((v) => typeof v === 'number');
    const sumValue = stocks.reduce((acc, s) => acc + (typeof s.value === 'number' ? s.value : 0), 0);
    const top4Pcts = stocks.slice(0, THEME_STOCK_TOP).map((x) => x.changePct).filter((v) => typeof v === 'number');
    /* 순위 기준도 바뀬 통합(KRX+NXT) 대금으로 다시 섬다 — 테마 **전체** 종목으로 계산(노출 4종목만이 아니다).
     *  (2026-11-24 사용자 확정: 대금 300억↑ 종목 평균 → 없으면 100억↑ 저유동성) */
    const basis = liquidAvgPct(merged.length ? merged : t.stocks || []);
    return {
      ...t,
      stocks,
      pricedCount: priced.length,
      avgPctCalc: basis.pct,
      basisPct: basis.pct,
      basisCount: basis.count,
      basisSampleCodes: basis.codes,
      lowLiquidity: basis.lowLiquidity,
      avgPctBasisLabel: liquidBasisLabel(basis),
      top4Avg: top4Pcts.length
        ? Number((top4Pcts.reduce((a, b) => a + b, 0) / top4Pcts.length).toFixed(2))
        : t.top4Avg,
      top4Sum: sumValue,
      sumValue,
      sumValueText: formatKoreanMoney(sumValue),
    };
  });
}

/* ============================================================================
 * 🔗 스탁이지(StockEasy) 실시간 강세 테마 — Supabase 경유 편입
 * ----------------------------------------------------------------------------
 *  · 테마보드 화면은 로그인 전용(세션 없으면 401)이라 이 함수는 화면을 긁지 않는다.
 *    15분 자동 동기화(scripts/fetch_stockeasy_themes.py)가 익명 공개 응답
 *    `landing-data.themeBoardPreview`(테마명·6자리 코드·등락률·대금)를 읽어
 *    family_sync(code='stockeasy_themes_live') 에 넣어 두면 여기서 읽기만 한다.
 *  · 이 함수가 느리거나 실패해도 테마맵은 네이버 랭킹만으로 그대로 돌아간다(1.5초 타임아웃).
 *  · 오래된 값(45분 초과)은 편입하지 않는다 — 어제 테마가 오늘처럼 보이는 고착 방지.
 * ========================================================================== */
const SE_SUPABASE = {
  url: process.env.SUPABASE_URL || 'https://hiruybkapzuhjrzjoyik.supabase.co',
  key: process.env.SUPABASE_ANON_KEY || 'sb_publishable_e5JJbvCPDhY91uXaUEVNVA_8Byv_gI8',
  code: 'stockeasy_themes_live',
};
const SE_TIMEOUT = 1500; // 브리프: Supabase 응답 1.5초 타임아웃
const SE_MAX_AGE_MIN = 45; // 이보다 오래된 수집값이면 편입하지 않는다

/* 번들 폐백 — Supabase 가 잡힐 때 쓸 수 있는 마지막 카드.
 *  배포 시점에 구워진 값이라 빌드 후 45분이 지나면 스스로 쓰지 않는다(고착 방지). */
let SE_BUNDLED = null;
try {
  SE_BUNDLED = require('../public/data/stockeasy_live_themes.json');
} catch (e) {
  SE_BUNDLED = null;
}

function seAgeMinutes(updatedAt) {
  if (!updatedAt) return null;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return null;
  return Math.round(((Date.now() - t) / 60000) * 10) / 10;
}

function seAcceptable(doc, sourceLabel) {
  if (!doc || !Array.isArray(doc.themes) || !doc.themes.length) return { ok: false, themes: [], error: sourceLabel + ' 테마 없음' };
  const ageMin = seAgeMinutes(doc.updatedAt);
  if (ageMin !== null && ageMin > SE_MAX_AGE_MIN) {
    return { ok: false, themes: [], ageMin, updatedAt: doc.updatedAt || null, error: sourceLabel + ` 오래된 값(${ageMin}분 전)` };
  }
  return { ok: true, themes: doc.themes, updatedAt: doc.updatedAt || null, ageMin };
}

async function fetchStockEasyThemes() {
  const url =
    `${SE_SUPABASE.url}/rest/v1/family_sync?code=eq.${encodeURIComponent(SE_SUPABASE.code)}` +
    '&select=code,data,updated_at';
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), SE_TIMEOUT) : null;
  try {
    const r = await fetch(url, {
      headers: {
        apikey: SE_SUPABASE.key,
        Authorization: 'Bearer ' + SE_SUPABASE.key,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    return seAcceptable(row && row.data, '스탁이지(Supabase)');
  } catch (e) {
    /* Supabase 가 느리거나 막혔을 때 — 배포 번들에 들어 있는 같은 파일로 한 번 더 시도한다. */
    const fallback = seAcceptable(SE_BUNDLED, '스탁이지(번들)');
    if (fallback.ok) return { ...fallback, via: 'bundled', supabaseError: String((e && e.message) || e) };
    return { ok: false, themes: [], error: fallback.error || String((e && e.message) || e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 스탁이지 테마 구성종목에 실시간 시세를 붙여 화면용 테마 객체로 만든다(Naver 테마와 같은 필드)
 *  · premarket=true(08:00~09:00)에는 정규장 등락률이 0.00%로 내려오므로
 *    NXT 프리마켓 체결값(q.overPct)만 등락률로 센다 — 체결 0건 종목은 0.00%로 채우지 않고 뺀다.
 *  · 체결 종목이 2개 미만인 테마는 '오늘 강세'라 부를 근거가 없어 세우지 않는다(값을 만들지 않는다).
 */
function buildStockEasyThemes(se, map, premarket) {
  const out = [];
  (se && se.themes ? se.themes : []).forEach((t) => {
    if (!t || !t.name) return;
    const stocks = [];
    (t.stocks || []).forEach((s) => {
      if (!s || !/^\d{6}$/.test(String(s.code || ''))) return;
      const q = map[s.code];
      if (!q || typeof q.price !== 'number') return;
      const hasOver = overTraded(q);
      const livePct = premarket && hasOver ? q.overPct : null;
      const livePrice = premarket && hasOver && typeof q.overPrice === 'number' ? q.overPrice : null;
      stocks.push({
        code: s.code,
        name: s.name || (q && q.name) || s.code,
        tileName: s.name || (q && q.name) || s.code,
        price: livePrice !== null ? livePrice : q.price,
        changePct: typeof q.changePct === 'number' ? q.changePct : null,
        open: q.open ?? null,
        high: q.high ?? null,
        low: q.low ?? null,
        volume: q.volume ?? null,
        value: typeof q.value === 'number' ? q.value : null,
        valueText: q.valueText || formatKoreanMoney(q.value),
        valueBasis: q.valueBasis || '통합',
        upperLimit: Boolean(q.upperLimit),
        livePct,
        livePrice,
        livePhase: livePct === null ? null : '프리마켓',
        priceBasis: livePct === null ? '직전 종가' : '프리마켓',
        /* 스탁이지가 자기 화면에 띄운 값(프리마켓 체결이 없을 때의 참고값) — 섞지 않고 따로 남긴다 */
        seChg: typeof s.chg === 'number' ? s.chg : null,
        seValueEok: typeof s.value_eok === 'number' ? s.value_eok : null,
        missing: false,
      });
    });
    if (stocks.length < 2) return;
    const picked = pickThemeStocks(stocks);
    if (!picked.length) return;
    const shown = picked.slice(0, THEME_STOCK_TOP);
    /* 프리마켓에는 '오늘 체결된' 종목만 등락률로 센다 — 정규장 0.00%가 평균에 섞이면 테마 등락률이 왜곡된다 */
    const pctOf = (x) =>
      premarket
        ? typeof x.livePct === 'number'
          ? x.livePct
          : null
        : typeof x.changePct === 'number'
          ? x.changePct
          : null;
    const pcts = shown.map(pctOf).filter((v) => typeof v === 'number');
    if (premarket && pcts.length < 2) return;
    if (!pcts.length) return;
    const top4Avg = Number((pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2));
    const top4Sum = shown.reduce((acc, x) => acc + (typeof x.value === 'number' ? x.value : 0), 0);
    /* 순위 기준은 네이버 테마와 같다 — 대금 300억↑ 종목(최대 4) 평균 → 없으면 100억↑ 저유동성.
     *  프리마켓에는 정규장 0.00%가 섞이지 않게 '오늘 체결값(livePct)'으로만 샌다. */
    const basis = liquidAvgPct(
      stocks.map((s) =>
        premarket ? { ...s, changePct: typeof s.livePct === 'number' ? s.livePct : null } : s,
      ),
    );
    out.push({
      rank: 0,
      name: String(t.name).trim(),
      keyword: String(t.name).trim(),
      themeNo: null,
      source: 'stockeasy',
      seRank: t.rank || null,
      seUpdatedAt: (se && se.updatedAt) || null,
      avgPct: null,
      avgPctLive: null,
      top4Avg,
      top4Sum,
      basisPct: basis.pct,
      basisCount: basis.count,
      basisSampleCodes: basis.codes,
      lowLiquidity: basis.lowLiquidity,
      avgPctCalc: basis.pct,
      avgPctBasisLabel: premarket ? '프리마켓 ' + liquidBasisLabel(basis) : liquidBasisLabel(basis),
      sumValue: top4Sum,
      sumValueText: formatKoreanMoney(top4Sum),
      riseCount: shown.filter((x) => typeof pctOf(x) === 'number' && pctOf(x) > 0).length,
      fallCount: shown.filter((x) => typeof pctOf(x) === 'number' && pctOf(x) < 0).length,
      steadyCount: 0,
      riseRatio: Math.round((shown.filter((x) => typeof pctOf(x) === 'number' && pctOf(x) > 0).length / shown.length) * 1000) / 10,
      stockCount: stocks.length,
      membersShown: picked.length,
      stocks: picked,
    });
  });
  return out;
}

function themeNameKey(s) {
  return String(s || '')
    .replace(/[^0-9A-Za-z가-힣]+/g, '')
    .toLowerCase();
}

/** 같은 묶음이면 그 상대 테마를 돌려준다(중복 카드 대신 '합류'에 쓴다) */
function stockEasyMatch(seTheme, others) {
  const seKey = themeNameKey(seTheme.name).replace(/(테마|관련|수혜|급등|신규)/g, '');
  const seCodes = (seTheme.stocks || []).map((s) => s.code);
  for (const o of others || []) {
    const oKey = themeNameKey(o.name).replace(/(테마|관련|수혜|급등|신규)/g, '');
    if (seKey && oKey && seKey === oKey) return o;
    if (seKey && oKey && Math.min(seKey.length, oKey.length) >= 3 && (seKey.includes(oKey) || oKey.includes(seKey))) {
      return o;
    }
    const oCodes = (o.stocks || []).map((s) => s.code);
    if (seCodes.length && oCodes.length) {
      const shared = seCodes.filter((c) => oCodes.includes(c)).length;
      if (shared / Math.min(seCodes.length, oCodes.length) >= 0.8) return o;
    }
  }
  return null;
}

function stockEasyDuplicates(seTheme, others) {
  return Boolean(stockEasyMatch(seTheme, others));
}



/* ------------- 직전 거래일 장마감 강세 Top 8 테마 스냅샷 → 장전 테마맵 ------------- */

/** 스냅샷 파일에 그릴 만한 테마가 있는지 */
function lastDynamicSnapshotThemes() {
  if (!LAST_DYNAMIC || !Array.isArray(LAST_DYNAMIC.themes)) return null;
  const list = LAST_DYNAMIC.themes.filter((t) => t && t.name && Array.isArray(t.stocks) && t.stocks.length);
  return list.length ? list : null;
}

/** 테마 랭킹이 '오늘 값'을 내지 못했는지 — 비었거나 전 테마 0.00%(프리마켓 PREOPEN 응답) */
function dynamicThemesFlat(dyn) {
  if (!dyn || !dyn.ok || !Array.isArray(dyn.themes) || !dyn.themes.length) return true;
  return dyn.themes.every((t) => {
    const v = typeof t.basisPct === 'number'
      ? t.basisPct
      : typeof t.top4Avg === 'number'
        ? t.top4Avg
        : typeof t.avgPct === 'number'
          ? t.avgPct
          : null;
    return v === null || Math.abs(v) < 0.005;
  });
}

/**
 * 직전 거래일 스냅샷 테마에 오늘 아침 polling 시세를 덧씌운다.
 *  · 테마 구성·순위는 직전 거래일 마감 기준을 유지하되, **막대·정렬 값은 '실질 대장주' 등락률**이다.
 *    (2026-11-23 수리) 예전엔 노출 4종목 평균(top4Avg)으로 줄을 세워, 타임X AI +182.71% 1종목이
 *    낀 '탈모 치료 +50.48%'가 1위로 남았다. 실제 테마 평균은 +4.66%였다.
 *    → 스튜디오·성적표와 같은 잣대: ±100% 이상 이상치 제외 · 실질 대장(대금 300억↑ → 100억↑ 저유동성) 기준.
 *  · 테마 평균(avgPct)은 구성종목 평균 그대로 함께 내려 화면이 옆에 작게 병기한다(두 기준을 섞지 않는다).
 *  · 종목 등락률: 프리마켓 체결이 있으면 그 값(livePct), 없으면 직전 거래일 마감 등락률
 *  · 종목 거래대금·시고저: 직전 거래일 마감 값(프리마켓에는 정규장 대금이 아직 없다)
 */
function mapPrevDayThemes(snapshot, themes, map, premarket) {
  const label = (snapshot && snapshot.shortLabel) || '직전 거래일';
  const labelPct = (v) => (typeof v === 'number' ? Number(v.toFixed(2)) : null);
  const OUTLIER = 100;      // ±100% 이상은 이상치(신규상장·상한가 첫날) — 평균·타일에서 뺀다
  const MIN_LEADER_EOK = 300;   // 실질 대장 하한(억)
  const MIN_FILL_EOK = 100;     // 대장이 없을 때 쓰는 저유동성 하한(억)
  return (themes || []).map((t, i) => {
    const rawStocks = (t.stocks || []).filter(
      (s) => s && s.code && !(typeof s.changePct === 'number' && Math.abs(s.changePct) >= OUTLIER),
    );
    const stocks = rawStocks.map((s) => {
      const q = map[s.code] || null;
      const hasOver = overTraded(q);
      const livePct = premarket && hasOver ? q.overPct : null;
      const livePrice = premarket && hasOver && typeof q.overPrice === 'number' ? q.overPrice : null;
      const prevClose = typeof s.price === 'number' ? s.price : null;
      return {
        code: s.code,
        name: s.name,
        tileName: s.name,
        role: s.role || null,
        price: livePrice !== null ? livePrice : prevClose,
        changePct: typeof s.changePct === 'number' ? s.changePct : null, // 직전 거래일 마감 등락률
        prevDayPct: typeof s.changePct === 'number' ? s.changePct : null,
        prevDayClose: prevClose,
        open: s.open ?? null,
        high: s.high ?? null,
        low: s.low ?? null,
        volume: s.volume ?? null,
        value: typeof s.value === 'number' ? s.value : null,
        valueText: s.valueText || formatKoreanMoney(s.value),
        valueBasis: label + ' 정규장 마감',
        livePct,
        livePrice,
        livePhase: livePct === null ? null : '프리마켓',
        priceBasis: livePct === null ? '직전 종가' : '프리마켓',
        prevDayLabel: label,
        missing: !q,
      };
    });
    /* 역할(👑 상승률 대장 · 💰 실질 거래대금 대장)은 파일에 적힌 값을 그대로 믿지 않고
     *  화면에 실린 종목으로 다시 계산한다(lib/theme-roles.js).
     *  → 11/23 이전 스냅샷처럼 '등락률 1위'에 '실질 거래대금 대장'이 적힌 파일이 남아 있어도
     *    화면에는 바른 역할이 나간다(2026-11-24 전수 점검). */
    const roleMap = themeRoleMap(stocks);
    stocks.forEach((s) => { s.role = roleMap[s.code] || s.role || null; });
    const livePcts = stocks.map((s) => s.livePct).filter((v) => typeof v === 'number');
    const prevPcts = stocks.map((s) => s.prevDayPct).filter((v) => typeof v === 'number');
    const needLive = Math.max(2, Math.ceil(stocks.length / 2));
    const avgLive =
      livePcts.length >= needLive
        ? Number((livePcts.reduce((a, b) => a + b, 0) / livePcts.length).toFixed(2))
        : null;
    const avgPrev = prevPcts.length
      ? Number((prevPcts.reduce((a, b) => a + b, 0) / prevPcts.length).toFixed(2))
      : null;
    const sumValue = stocks.reduce((acc, s) => acc + (typeof s.value === 'number' ? s.value : 0), 0);

    /* ── 기준선: 스냅샷이 실측 대장을 실어 왔으면 그 값을, 아니면(옛 파일) 종목에서 같은 규칙으로 고른다 ── */
    let baselinePct = labelPct(typeof t.baselinePct === 'number' ? t.baselinePct : t.leaderPct);
    let leaderCode = t.leaderCode || null;
    let leaderName = t.leaderName || null;
    let lowLiquidity = Boolean(t.lowLiquidity);
    if (baselinePct === null) {
      const cands = stocks
        .filter((s) => typeof s.prevDayPct === 'number' && s.prevDayPct > 0)
        .map((s) => ({ s, eok: (typeof s.value === 'number' ? s.value : 0) / 1e8 }))
        .filter((x) => x.eok >= MIN_FILL_EOK)
        .sort((a, b) => (a.eok >= MIN_LEADER_EOK ? 0 : 1) - (b.eok >= MIN_LEADER_EOK ? 0 : 1) || b.s.prevDayPct - a.s.prevDayPct);
      if (cands.length) {
        const pick = cands[0];
        baselinePct = labelPct(pick.s.prevDayPct);
        leaderCode = pick.s.code;
        leaderName = pick.s.name;
        lowLiquidity = pick.eok < MIN_LEADER_EOK;
      }
    }
    return {
      ...t,
      rank: i + 1,
      stocks,
      /* 이상치 종목은 타일에서도 뺐다 — 목록이 3개로 줄 수 있으므로 실제 개수를 함께 내린다 */
      pricedCount: stocks.length,
      avgPct: typeof t.avgPct === 'number' ? t.avgPct : avgPrev,
      themeAvgPct: typeof t.avgPct === 'number' ? t.avgPct : avgPrev,
      top4Avg: typeof t.top4Avg === 'number' ? t.top4Avg : null,
      /* 헤더 등락률·정렬 = 실질 대장 등락률(스튜디오와 같은 잣대).
       *  테마 평균은 themeAvgPct 로 함께 내려 화면이 옆에 병기한다. */
      avgPctCalc: baselinePct === null ? avgPrev : baselinePct,
      avgPctBasisLabel: baselinePct === null ? label + ' 종가 평균' : label + ' 기준주 ' + (leaderName || '등락'),
      baselinePct: baselinePct === null ? null : baselinePct,
      baselineRule: t.baselineRule || '실질 대장(대금 300억↑ → 100억↑ 저유동성) 등락률 · ±100% 이상 제외',
      sortPct: baselinePct === null ? avgPrev : baselinePct,
      leaderCode,
      leaderName,
      lowLiquidity,
      avgPctLive: avgLive,
      livePricedCount: livePcts.length,
      liveCoverage: `${livePcts.length}/${stocks.length}`,
      livePhase: livePcts.length ? '프리마켓' : null,
      prevDayTop4Avg: typeof t.top4Avg === 'number' ? t.top4Avg : null,
      prevDayLabel: label,
      sumValue,
      sumValueText: formatKoreanMoney(sumValue),
    };
  });
}

async function fetchThemeQuotes(extraCodes, premarket, alsoPoll, marks) {
  const tTQ = Date.now();
  const mm = typeof marks === 'function' ? marks : () => {};
  // 1) 오늘 장중 실제 강세 테마 Top 8 을 네이버 테마 랭킹에서 먼저 받아 온다.
  //    동시에 스탁이지 실시간 테마(Supabase 경유·1.5초 타임아웃)도 따로 받아 둔다 —
  //    이쪽이 실패해도 네이버 테마맵은 그대로 그린다.
  const [dyn, se] = await Promise.all([
    buildDynamicThemes(marks),
    fetchStockEasyThemes().catch((e) => ({ ok: false, themes: [], error: String((e && e.message) || e) })),
  ]);
  prof('theme.dynThemes+stockEasy', tTQ);
  mm('theme.dyn+se');
  /* 장전(프리마켓)에는 랭킹이 비었거나 전 테마가 0.00%로 내려온다 → '오늘 강세'라 부를 근거가 없다.
   *  이때는 직전 거래일 장마감 Top 8 테마 스냅샷을 그대로 세우고 프리마켓 체결가만 덧씌운다. */
  const dynFlat = dynamicThemesFlat(dyn);
  const prevDayList = premarket && dynFlat ? lastDynamicSnapshotThemes() : null;
  /* 2) 고정 테마 32 + 감시군(RN존·종베) + NXT 랭킹 동적 + 신규 동적 테마 종목을 한 번에 polling
   *  ⚡ extraCodes 는 배열 또는 '배열을 돌려주는 Promise' 둘 다 받는다 — NXT 랭킹(0.5~0.9초)을
   *     테마 랭킹·구성종목 수집과 동시에 출발시키기 위해서다(2026-11-27 콜드 응답 단축).
   *     await 는 아래 테마 랭킹·구성종목이 끝난 뒤에 일어나므로 실제 대기는 거의 없다. */
  const extra = Array.isArray(extraCodes) ? extraCodes : (await extraCodes) || [];
  const prevDayCodes = prevDayList
    ? prevDayList.reduce((acc, t) => acc.concat((t.stocks || []).map((s) => s.code)), [])
    : [];
  const seCodes = se.ok
    ? se.themes.reduce((acc, t) => acc.concat((t.stocks || []).map((s) => s.code)), [])
    : [];
  const pollCodes = ALL_CODES.concat(WATCH_CODES, extra, STRAT_CARD_CODES, dyn.codes, prevDayCodes, seCodes);
  /* ⚡ 다른 단계가 곧 필요로 할 종목코드(52주·상한가 후보, 뉴스 수혜주)를 이 polling 에 같이 넣는다 —
   *   그 단계가 따로 polling 왕복(0.4~0.6초)을 하지 않게 된다(2026-11-27).
   *   Promise 가 실패해도 그 코드만 빼고 원래 목록으로 그대로 진행한다. */
  for (const p of Array.isArray(alsoPoll) ? alsoPoll : []) {
    try {
      const codes = await p;
      if (Array.isArray(codes)) codes.forEach((c) => pollCodes.push(c));
    } catch (e) { /* 이 코드 묶음은 건너뛴다 — 해당 단계가 필요할 때 직접 조회한다 */ }
  }
  const map = await pollQuotes(pollCodes);
  prof('theme.poll', tTQ);
  mm('theme.poll');
  if (!Object.keys(map).length) throw new Error('네이버 polling 응답에 종목이 없습니다');

  // 3) 동적 테마가 있으면 고정 THEMES 로 덮어쓰지 않는다(폴백은 랭킹 자체가 죽었을 때만).
  let themes;
  let themeSource;
  let seIn = 0;
  let seJoined = 0;      // 기존 테마 카드에 구성종목이 합류한 수
  let seCards = 0;       // 새로 카드로 선 스탁이지 테마 수
  if (prevDayList) {
    themes = mapPrevDayThemes(LAST_DYNAMIC, prevDayList, map, premarket);
    themeSource = 'prev-day-dynamic';
    /* 🔗 프리마켓에도 스탁이지 실시간 테마를 합류시킨다 (2026-11-23).
     *  08:00~09:00 에는 네이버 랭킹이 오늘 값을 내지 않아 직전 마감 스냅샷만 섰고,
     *  그 사이 스탁이지가 이미 '지금 강한 테마'(예: 11/23 08:40 화장품·밸류업)를 내려주는데도
     *  이 분기에는 합류 코드가 없어 화면에 오르지 못했다.
     *  · 같은 테마(이름·구성 80% 이상 겹침)면 카드를 새로 만들지 않고 그 카드에 구성종목만 합친다
     *    — '화장품' 카드가 두 개 생기거나, 오늘 +15% 종목이 화면에서 빠지는 것을 막는다.
     *  · 정렬은 각 카드의 막대값(직전 실질 대장 등락률 / 스탁이지 프리마켓 평균) 내림차순. */
    if (se.ok && se.themes.length) {
      const seBuilt = buildStockEasyThemes(se, map, premarket);
      const merged = [];
      seBuilt.forEach((t) => {
        const dup = stockEasyMatch(t, themes);
        if (dup) {
          const have = new Set((dup.stocks || []).map((s) => s.code));
          const add = (t.stocks || []).filter((s) => !have.has(s.code));
          if (add.length) {
            dup.stocks = (dup.stocks || []).concat(add).slice(0, 6);
            dup.seJoined = true;
            dup.seJoinedName = t.name;
            dup.seJoinedCodes = add.map((s) => s.code);
            /* 구성이 늘었으니 프리마켓 평균·커버리지를 다시 센다(값을 꾸미지 않고 다시 계산만) */
            const livePcts = dup.stocks.map((s) => s.livePct).filter((v) => typeof v === 'number');
            const needLive = Math.max(2, Math.ceil(dup.stocks.length / 2));
            dup.avgPctLive =
              livePcts.length >= needLive
                ? Number((livePcts.reduce((a, b) => a + b, 0) / livePcts.length).toFixed(2))
                : null;
            dup.livePricedCount = livePcts.length;
            dup.liveCoverage = `${livePcts.length}/${dup.stocks.length}`;
            merged.push(t.name);
          } else {
            dup.seJoined = true;
            dup.seJoinedName = t.name;
            merged.push(t.name);
          }
        } else {
          themes.push(t);
          seCards += 1;
        }
      });
      if (merged.length) seJoined = merged.length;
      themes = themes
        .slice()
        .sort(
          (a, b) =>
            (b.sortPct ?? b.avgPctCalc ?? b.top4Avg ?? -999) - (a.sortPct ?? a.avgPctCalc ?? a.top4Avg ?? -999) ||
            (b.sumValue ?? b.top4Sum ?? 0) - (a.sumValue ?? a.top4Sum ?? 0),
        )
        .slice(0, THEME_TOP);
      themes.forEach((t, i) => {
        t.rank = i + 1;
      });
      seIn = themes.filter((t) => t.source === 'stockeasy').length;
    }
  } else if (dyn.ok) {
    themes = mergeThemeQuotes(dyn.themes, map, premarket);
    /* 시세가 붙은 뒤 한 번 더 — 대금 300억↑ 종목 평균 등락률(동률이면 노출 4종목 합산 대금)로 순위를 확정한다 */
    themes = themes
      .slice()
      .sort(
        (a, b) =>
          ((b.basisPct ?? b.avgPctCalc ?? -999) - (a.basisPct ?? a.avgPctCalc ?? -999)) ||
          (b.sumValue ?? b.top4Sum ?? 0) - (a.sumValue ?? a.top4Sum ?? 0),
      );
    /* 🔗 스탁이지 테마도 같은 잣대(대금 300억↑ 종목 평균 등락률 → 합산 대금)로 Top 8 경쟁에 넣는다.
     *   네이버 테마와 이름·구성종목이 80% 이상 겹치면 중복 노출하지 않는다. */
    if (se.ok && se.themes.length) {
      const seBuilt = buildStockEasyThemes(se, map, premarket).filter((t) => !stockEasyDuplicates(t, themes));
      if (seBuilt.length) {
        themes = themes.concat(seBuilt).sort(
          (a, b) =>
            ((b.basisPct ?? b.avgPctCalc ?? -999) - (a.basisPct ?? a.avgPctCalc ?? -999)) ||
            (b.sumValue ?? b.top4Sum ?? 0) - (a.sumValue ?? a.top4Sum ?? 0),
        );
        themes = themes.slice(0, THEME_TOP);
        seIn = themes.filter((t) => t.source === 'stockeasy').length;
      }
    }
    themes.forEach((t, i) => {
      t.rank = i + 1;
    });
    themeSource = 'naver-theme';
  } else {
    themes = mapStaticThemes(map, premarket);
    themeSource = 'static-fallback';
  }

  const first = Object.values(map)[0];
  return {
    themes,
    map,
    marketStatus: (first && first.marketStatus) || dyn.marketStatus || null,
    themeSource,
    themeRankTotal: dyn.ok ? dyn.total || 0 : prevDayList ? (LAST_DYNAMIC && LAST_DYNAMIC.rankTotal) || 0 : 0,
    themeErrors: dyn.errors || [],
    themePrevLabel: prevDayList ? (LAST_DYNAMIC && LAST_DYNAMIC.shortLabel) || null : null,
    themePrevAsOf: prevDayList ? (LAST_DYNAMIC && LAST_DYNAMIC.asOfDate) || null : null,
    themeSeIn: seIn,
    themeSeJoined: seJoined,
    themeSeCards: seCards,
    themeSeUpdatedAt: se.ok ? se.updatedAt || null : null,
    themeSeError: se.ok ? null : se.error || null,
    themeBaselineRule: prevDayList
      ? '기준주(대금 300억↑ → 100억↑ 저유동성 최고 상승) 등락률 · ±100% 이상 제외'
      : '테마 순위 = 대금 300억↑ 종목(최대 4) 평균 등락률 → 없으면 100억↑ 저유동성 · ±100% 이상 제외',
  };
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

/**
 * 네이버 랭킹(stock.naver.com market/stock/default) 1건 → 표준 시세.
 *  tradeType=NXT(프리마켓·애프터마켓) · tradeType=KRX(정규장) 둘 다 같은 필드를 준다.
 */
function normalizeRankItem(d, basisText) {
  if (!d || !d.itemcode) return null;
  const value = parseNum(d.tradeAmount);
  const price = parseNum(d.nowPrice);
  const change = nxtSigned(d.prevChangePrice, d.upDownGb);
  return {
    code: d.itemcode,
    name: d.itemname || null,
    market: d.sosok === '1' ? 'KOSDAQ' : d.sosok === '0' ? 'KOSPI' : null,
    kind: d.type || null,
    price,
    change,
    changePct: nxtSigned(d.prevChangeRate, d.upDownGb),
    prevClose: price !== null && change !== null ? price - change : null,
    open: parseNum(d.openPrice),
    high: parseNum(d.highPrice),
    low: parseNum(d.lowPrice),
    volume: parseNum(d.tradeVolume),
    value,
    valueText: formatKoreanMoney(value),
    valueBasis: basisText || 'NXT 체결',
    upperLimit: String(d.upDownGb) === '1',
    halted: String(d.tradeStopYn || '').toUpperCase() === 'Y',
    manageStatusGb: d.manageStatusGb || null,
    sessionType: d.tradingSessionType || null,
    marketStatus: d.marketStatus || null,
    source: 'naver-rank',
  };
}

function normalizeNxtRankItem(d) {
  return normalizeRankItem(d, 'NXT 체결');
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

/* ------------------- 네이버 실시간 검색순위 (KRX · searchTop) -------------------
 *  · stock.naver.com 의 통합(정규장) 랭킹을 orderType=searchTop 으로 받아 Top 30 을 쓴다.
 *  · 장전(PREOPEN)·응답 실패에는 빈 배열을 돌려준다 — 어제 순위를 오늘 검색순위로 추정하지 않는다.
 *  · 순위는 원본 응답의 자리(index+1)를 그대로 쓴다(필터로 빠진 종목이 있어도 순위가 밀리지 않게).
 */
const SEARCH_TOP_URL =
  'https://stock.naver.com/api/domestic/market/stock/default' +
  '?tradeType=KRX&marketType=ALL&orderType=searchTop&startIdx=0&pageSize=30';
const SEARCH_TOP_MAX = 30;

/* 신형 목록 폴백 (2026-11-19)
 *  통합 랭킹(stock.naver.com/api/domestic/market/stock/default)은 **모바일 UA 에 404** 를 돌려준다.
 *  (실측: iPhone UA 404 / 데스크톱 Chrome UA 200 — API 폐쇄가 아니라 UA 문제)
 *  이 파일은 lib/http.js 의 데스크톱 UA 를 쓰므로 정상 동작하지만, 통합 랭킹이 404·빈 목록으로
 *  죽는 날에도 탭이 비지 않도록 m.stock 신형 목록을 KOSPI·KOSDAQ 합쳐 폴백으로 쓴다.
 *  신형 목록에는 type(ST)/NXT 세션/open·high·low 가 없어 1차 경로를 대체하지는 않는다.
 */
const LIST_RANK_URL = 'https://m.stock.naver.com/api/stocks/';

function normalizeListRankItem(d, market) {
  const it = normalizeListItem(d, market);
  if (!it || !it.code) return null;
  it.kind = String((d && d.stockEndType) || '').toLowerCase() === 'stock' ? 'ST' : 'ETF';
  it.source = 'naver-list';
  return it;
}

async function fetchListRank(kind, size) {
  const out = [];
  for (const market of ['KOSPI', 'KOSDAQ']) {
    try {
      const data = await fetchJson(
        LIST_RANK_URL + kind + '/' + market + '?page=1&pageSize=' + String(size),
        { headers: NAVER_HEADERS, timeout: NAVER_TIMEOUT },
      );
      ((data && data.stocks) || []).forEach((d) => {
        const it = normalizeListRankItem(d, market);
        if (it) out.push(it);
      });
    } catch (e) {
      /* 한 시장이 죽어도 나머지로 계속한다 */
    }
  }
  if (!out.length) throw new Error(`신형 목록 ${kind} 비었습니다`);
  /* 신형 목록에는 시·고·저가 없다 — 비중법사 몸통·위꼬리 판정이 빈 값으로 무너지지 않게
   * polling 통합시세로 실제 OHLC 를 덮어쓴다(추정값 생성 금지). */
  try {
    const quotes = await pollQuotes(out.map((x) => x.code));
    out.forEach((it) => {
      const q = quotes[it.code];
      if (q) mergeQuote(it, q);
    });
  } catch (e) {
    /* OHLC 보강 실패는 치명적이지 않다 — 등락률·대금만으로도 후보를 만든다 */
  }
  return out;
}

async function fetchSearchTopKRX(preOpen) {
  if (preOpen) return [];
  try {
    const data = await fetchJson(SEARCH_TOP_URL, { headers: NXT_RANK_HEADERS, timeout: NXT_RANK_TIMEOUT });
    if (!Array.isArray(data) || !data.length) throw new Error('검색순위 목록이 비었습니다');
    const out = [];
    data.forEach((d, i) => {
      if (!d || !d.itemcode) return;
      if (String(d.type || '') !== 'ST') return;
      if (isPreferredStock({ name: d.itemname, code: d.itemcode })) return;
      if (out.some((x) => x.code === d.itemcode)) return;
      out.push({
        rank: i + 1,
        code: d.itemcode,
        name: d.itemname || null,
        changePct: nxtSigned(d.prevChangeRate, d.upDownGb),
        value: parseNum(d.tradeAmount),
        market: d.sosok === '1' ? 'KOSDAQ' : d.sosok === '0' ? 'KOSPI' : null,
      });
    });
    return out.slice(0, SEARCH_TOP_MAX);
  } catch (e) {
    return fetchSearchTopNewList();
  }
}

/** 통합 검색순위가 죽었을 때 — 시장별 신형 검색순위를 순위 교차로 합친다. */
async function fetchSearchTopNewList() {
  let rows = [];
  try {
    rows = await fetchListRank('searchTop', SEARCH_TOP_MAX);
  } catch (e) {
    return [];
  }
  const kospi = rows.filter((x) => x.market === 'KOSPI');
  const kosdaq = rows.filter((x) => x.market === 'KOSDAQ');
  const merged = [];
  for (let i = 0; i < Math.max(kospi.length, kosdaq.length); i += 1) {
    if (kospi[i]) merged.push(kospi[i]);
    if (kosdaq[i]) merged.push(kosdaq[i]);
  }
  return merged
    .filter((x) => x && x.code && !isPreferredStock(x))
    .slice(0, SEARCH_TOP_MAX)
    .map((x, i) => ({
      rank: i + 1,
      code: x.code,
      name: x.name || null,
      changePct: x.changePct,
      value: x.value,
      market: x.market || null,
    }));
}

/**
 * 테마 카드 제목 옆 검색 뱃지 — 테마 카드에 노출된 종목 중 검색 Top 30 진입분만 센다.
 *  bestRank = 진입 종목 중 가장 높은(작은 숫자) 순위, count = 진입 종목 수.
 *  한 종목도 없으면 searchBadge = null (화면에서 생략).
 */
function attachSearchBadges(themes, searchTop) {
  const list = Array.isArray(themes) ? themes : [];
  if (!list.length) return list;
  const rankOf = new Map();
  (searchTop || []).forEach((x) => {
    if (x && x.code && typeof x.rank === 'number') rankOf.set(x.code, x.rank);
  });
  list.forEach((t) => {
    let best = null;
    let count = 0;
    (t.stocks || []).forEach((s) => {
      if (!s || !s.code) return;
      const r = rankOf.get(s.code);
      if (typeof r !== 'number') return;
      count += 1;
      if (best === null || r < best) best = r;
    });
    t.searchBadge = best === null ? null : { bestRank: best, count };
  });
  return list;
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
      /* 장전(PREOPEN) 응답 — '오늘 신고가'가 아직 없는 시간대
       *  (11/19 08:24·09:24 실측: '유진 챔피언중단기크레딧 X클래스' 10,035원 · 대금 0 · 0.00%)
       *  체결 근거(대금·등락)가 없는 행은 신고가 후보로 쓰지 않는다. */
      if (String(it.marketStatus || '').toUpperCase() === 'PREOPEN') return;
      if (!((it.value || 0) > 0) && !(it.changePct || 0)) return;
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
  const { base, preferred } = cand;
  const excludedPreferred = preferred || [];
  /* 정렬 기준은 '통합(KRX+NXT) 거래대금' — 시세가 붙은 뒤(mergeQuote) 다시 자른다 */
  const byValue = base
    .slice()
    .filter((it) => typeof it.value === 'number' && it.value > 0)
    .sort((a, b) => (b.value || 0) - (a.value || 0) || (b.changePct || 0) - (a.changePct || 0))
    .slice(0, HIGH52_LIMIT);
  const byPct = base
    .slice()
    .sort((a, b) => (b.changePct || 0) - (a.changePct || 0) || (b.value || 0) - (a.value || 0))
    .slice(0, HIGH52_LIMIT);
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
  const parts = FMT_KST_FULL.formatToParts(d);
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
    // 정규장 종가(장중이면 현재가, 장마감 후면 그날 정규장 종가) — 시간외 체결가와 '따로' 비교하기 위한 기준
    const regularClose = typeof q.price === 'number' && q.price > 0 ? q.price : null;
    const divergencePct =
      regularClose !== null && typeof q.overPrice === 'number' && q.overPrice > 0
        ? Number((((q.overPrice - regularClose) / regularClose) * 100).toFixed(2))
        : null;
    rows.push({
      code: w.code,
      name: q.name || w.name,
      market: q.market || null,
      groups: w.groups,
      price: q.price,
      changePct: q.changePct,
      regularClose,
      overPrice: q.overPrice,
      overPct: q.overPct,
      divergencePct,
      overValue: q.overValue,
      overValueText: q.valueAfterText,
      overValueDispText: q.valueAfterText ? 'NXT ' + q.valueAfterText : null,
      overVolume: q.overVolume,
      overTradedAt: q.overTradedAt,
      overSessionType: q.overSessionType || null,
      value: q.value,
      valueText: q.valueText,
      valueTotalText: q.valueTotalText || q.valueText,
      valueNxt: q.valueNxt || 0,
      valueNxtText: q.valueNxtText || null,
      valueDispText: q.valueDispText || q.valueText,
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
      divergence: '정규장 대비 괴리율 = (세션 체결가 ÷ 정규장 종가 − 1) × 100',
      missing: '해당 세션 체결 데이터가 없는 종목은 0으로 채우지 않고 순위에서 제외',
      dynamic: 'NXT 랭킹(상승률·거래대금)에서 찾은 종목만 추가 — 없는 종목은 만들지 않음',
    },
  };
}

/* ============================================================================
 * 전략 장중 실시간 판정 — 비중법사(기준봉·1일차·4분할) · 홍인기(D+0·D+1·D+2)
 * ----------------------------------------------------------------------------
 *  1) 신규 0일차 포착 : 네이버 KRX 실시간 랭킹(거래대금 40 · 등락률 60) → 일봉(fchart 125) 실측
 *     · 비중법사 : 몸통 상승률 +10%↑ & 당일 거래대금 300억↑ & 60일 전고점 돌파
 *     · 홍인기   : 등락률 +10%↑ & 120일 전고점 돌파(첫 돌파 여부) & 대금 상위
 *  2) 기존 카드 실시간 판정 : 재스캔 JSON(bijoong/honginki-latest)의 기준봉 + 현재가
 *     · 비중법사 : 1일차 패턴(뜬봉/중봉/음봉눌림) · 4분할선 도달/터치 · 기준봉 종가 손절선
 *     · 홍인기   : 기준선(전일 종가) 대비 위치 · 5단 타점 · −3% 손절선
 *  · 일봉 과거 봉은 장중에 변하지 않는다 → CANDLE_TTL_MS 캐시. 당일 봉은 랭킹/polling 실시간 값을 쓴다.
 *  · 확인되지 않은 값은 만들지 않는다(종목 누락은 missing 으로 남긴다).
 * ========================================================================== */

const candleCache = new Map();

/** KST 오늘 날짜 YYYYMMDD */
function kstTodayYmd() {
  const p = kstParts(new Date());
  return `${p.y}${pad2(p.m)}${pad2(p.d)}`;
}

/** 영업일(주말 제외) 경과일 — 기준일 다음 평일부터 오늘까지 */
function tradingDaysAfter(fromYmd, toYmd) {
  if (!/^\d{8}$/.test(String(fromYmd || '')) || !/^\d{8}$/.test(String(toYmd || ''))) return null;
  const a = Date.UTC(Number(fromYmd.slice(0, 4)), Number(fromYmd.slice(4, 6)) - 1, Number(fromYmd.slice(6, 8)));
  const b = Date.UTC(Number(toYmd.slice(0, 4)), Number(toYmd.slice(4, 6)) - 1, Number(toYmd.slice(6, 8)));
  if (b < a) return null;
  let n = 0;
  for (let t = a + 86400000; t <= b; t += 86400000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n += 1;
  }
  return n;
}

/** 네이버 일봉(fchart XML) — ["20261113|시|고|저|종|거래량", ...] */
async function fetchDailyBars(code) {
  const hit = candleCache.get(code);
  if (hit && Date.now() - hit.at < CANDLE_TTL_MS) return hit.bars;
  const url =
    FCHART_URL + encodeURIComponent(code) + '&timeframe=day&count=' + String(CANDLE_COUNT) + '&requestType=0';
  const buf = await fetchBuffer(url, { headers: NAVER_HEADERS, timeout: FCHART_TIMEOUT });
  const text = decodeEucKr(buf);
  const bars = [];
  const re = /<item\s+data="([^"]+)"\s*\/>/g;
  let m;
  while ((m = re.exec(text))) {
    const parts = m[1].split('|');
    if (parts.length < 6 || !/^\d{8}$/.test(parts[0])) continue;
    const o = parseNum(parts[1]);
    const h = parseNum(parts[2]);
    const l = parseNum(parts[3]);
    const c = parseNum(parts[4]);
    const v = parseNum(parts[5]);
    if (o === null || h === null || l === null || c === null) continue;
    bars.push({ d: parts[0], o, h, l, c, v: v === null ? 0 : v });
  }
  if (!bars.length) throw new Error('일봉 응답에 봉이 없습니다');
  bars.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  candleCache.set(code, { at: Date.now(), bars });
  return bars;
}

/** KRX 정규장 실시간 랭킹(상승률 · 거래대금) — 스팩·우선주·ETF 제외 */
async function fetchKrxRank(orderType, pageSize) {
  let rows;
  try {
    rows = await fetchKrxRankLegacy(orderType, pageSize);
  } catch (e) {
    rows = await fetchListRank(orderType, pageSize);   // 통합 랭킹 404·빈 목록 → 신형 목록 폴백
  }
  return rows
    .filter((x) => x && x.kind === 'ST' && x.price !== null && x.price !== undefined)
    .filter((x) => !x.halted && !isPreferredStock(x))
    .filter((x) => !FUND_NAME_RE.test(String(x.name || '')));
}

async function fetchKrxRankLegacy(orderType, pageSize) {
  const url =
    KRX_RANK_URL +
    '?tradeType=KRX&marketType=ALL&orderType=' +
    encodeURIComponent(orderType) +
    '&startIdx=0&pageSize=' +
    String(pageSize);
  const data = await fetchJson(url, { headers: NXT_RANK_HEADERS, timeout: KRX_RANK_TIMEOUT });
  if (!Array.isArray(data) || !data.length) throw new Error(`KRX ${orderType} 목록이 비었습니다`);
  return data.map((d) => normalizeRankItem(d, '정규장'));
}

/** 오늘 봉 기준 60일·120일 전고점과 첫 돌파 여부 계산 */
function judgeMover(q, bars, valueRank) {
  if (!q || !bars || bars.length < 25) return null;
  const today = kstTodayYmd();
  // 당일 봉은 아직 진행 중이라 전고점 계산에서 뺀다(장중에 고가가 늘어나는 봉을 넣으면 전고점이 함께 올라간다)
  const hist = bars.filter((b) => b.d < today);
  if (hist.length < 25) return null;
  const tail = (n) => hist.slice(-n);
  const hiOf = (n) => {
    const arr = tail(n);
    const top = arr.reduce((a, b) => (b.h > a.h ? b : a), arr[0]);
    return { hi: top.h, d: top.d };
  };
  const h60 = hiOf(BIJ_LIVE.breakDays);
  const h120 = hiOf(HONG_LIVE.breakDays);
  const v20arr = tail(20);
  const vol20 = v20arr.length ? v20arr.reduce((a, b) => a + b.v, 0) / v20arr.length : null;

  const price = q.price;
  const open = q.open;
  const high = q.high;
  const pct = q.changePct;
  const bodyRate = open ? (price / open - 1) * 100 : null;
  const upper = price && high ? ((high - price) / price) * 100 : null;
  const valueEok = typeof q.value === 'number' ? q.value / 1e8 : null;
  const volX = vol20 ? (q.volume || 0) / vol20 : null;
  const break60 = price > h60.hi;
  const break120 = price >= h120.hi;

  // 첫 돌파 : 최근 120봉 각각이 그 이전 120봉 전고점을 종가로 넘은 적이 있는지
  let priorBreakCount = 0;
  const startIdx = Math.max(120, hist.length - 120);
  for (let i = startIdx; i < hist.length; i += 1) {
    const win = hist.slice(Math.max(0, i - 120), i);
    if (!win.length) continue;
    let hi = -Infinity;
    for (let k = 0; k < win.length; k += 1) if (win[k].h > hi) hi = win[k].h;
    if (hist[i].c >= hi) priorBreakCount += 1;
  }
  const firstBreak120 = break120 && priorBreakCount === 0;

  const bijChecks = {
    body: typeof bodyRate === 'number' && bodyRate >= BIJ_LIVE.bodyRate,
    value: valueEok !== null && valueEok >= BIJ_LIVE.valueEok,
    break60,
    chg: typeof pct === 'number' && pct >= BIJ_LIVE.chg,
    upper: typeof upper === 'number' && upper <= BIJ_LIVE.upperMax,
  };
  const bijReasons = [];
  if (!bijChecks.body) {
    bijReasons.push(`몸통 ${bodyRate === null ? '—' : bodyRate.toFixed(2) + '%'} — +${BIJ_LIVE.bodyRate}% 미달`);
  }
  if (!bijChecks.value) {
    bijReasons.push(`대금 ${valueEok === null ? '—' : valueEok.toFixed(1) + '억'} — ${BIJ_LIVE.valueEok}억 미달`);
  }
  if (!bijChecks.break60) {
    bijReasons.push(
      `60일 전고점 ${h60.hi.toLocaleString('ko-KR')}원(${h60.d.slice(4, 6)}/${h60.d.slice(6, 8)}) — 현재가가 전고점 ${((price / h60.hi - 1) * 100).toFixed(2)}%`,
    );
  }
  if (!bijChecks.upper) bijReasons.push(`위꼬리 ${upper === null ? '—' : upper.toFixed(1) + '%'} — ${BIJ_LIVE.upperMax}% 초과`);

  /* '끼' — 최근 90거래일 상한가(+29%↑) · +20%↑ · +5%↑ 2일 연속(연속 양봉) 이력.
   *  홍인기 원전: 끼 있는 종목은 09:30 확인 즉시 지지·저항 매매 + 전고점 돌파 양봉이면 오버나잇까지 간다. */
  const kkWin = hist.slice(-HONG_D0.kkDays);
  let kkLimit = 0;
  let kkUp20 = 0;
  let kkChain = 0;
  for (let i = 1; i < kkWin.length; i += 1) {
    const prevC = kkWin[i - 1].c;
    if (!prevC) continue;
    const d = ((kkWin[i].c - prevC) / prevC) * 100;
    if (d >= 29) kkLimit += 1;
    else if (d >= 20) kkUp20 += 1;
    if (i >= 2) {
      const prevPrevC = kkWin[i - 2].c;
      if (prevPrevC) {
        const dPrev = ((prevC - prevPrevC) / prevPrevC) * 100;
        if (d >= 5 && dPrev >= 5) kkChain += 1;
      }
    }
  }

  const hongChecks = {
    pct: typeof pct === 'number' && pct >= HONG_LIVE.pct,
    break120,
    firstBreak: firstBreak120,
    valueTop: valueRank !== null && valueRank !== undefined,
  };
  const hongReasons = [];
  if (!hongChecks.pct) {
    hongReasons.push(`등락률 ${typeof pct === 'number' ? pct.toFixed(2) + '%' : '—'} — +${HONG_LIVE.pct}% 미달`);
  }
  if (!hongChecks.break120) hongReasons.push(`120일 전고점 ${h120.hi.toLocaleString('ko-KR')}원 미달`);
  if (hongChecks.break120 && !firstBreak120) {
    hongReasons.push(`최근 120봉 안에 이미 돌파한 적 있음(재돌파 ${priorBreakCount}회) — 첫 장대양봉 아님`);
  }
  if (!hongChecks.valueTop) hongReasons.push('거래대금 상위(40) 밖');

  return {
    code: q.code,
    name: q.name,
    market: q.market,
    price,
    pct,
    open,
    high,
    low: q.low,
    prevClose: q.prevClose,
    bodyRate,
    upper,
    volX,
    valueEok,
    valueText: q.valueText || null,
    valueDispText: q.valueDispText || q.valueText || null,
    valueNxtText: q.valueNxtText || null,
    valueBasis: q.valueBasis || null,
    valueRank: valueRank || null,
    hi60: h60.hi,
    hi60Date: h60.d,
    hi120: h120.hi,
    hi120Date: h120.d,
    break60,
    break120,
    firstBreak120,
    priorBreakCount,
    kk: { limitUp: kkLimit, up20: kkUp20, chain: kkChain, count: kkLimit + kkUp20 + kkChain, days: HONG_D0.kkDays },
    tradedAt: q.tradedAt || null,
    bij: {
      checks: bijChecks,
      passCount: Object.values(bijChecks).filter(Boolean).length,
      isBase0: bijChecks.body && bijChecks.value && bijChecks.break60,
      reasons: bijReasons,
    },
    hong: {
      checks: hongChecks,
      isD0: hongChecks.pct && hongChecks.break120,
      reasons: hongReasons,
    },
  };
}

/** 비중법사 1일차(기준봉 다음 거래일) 실시간 판정 — 패턴 · 4분할선 · 손절선 */
/* ============================================================================
 * ⚡ 오늘 장중매매 후보 — 홍인기 D+0 · 하락장 역발상 (2026-11-25 신설)
 * ----------------------------------------------------------------------------
 *  트랙 ① 홍인기 D+0 주도주 (09:30 이후)
 *    · 거래대금 상위 30위 이내 · 500억↑ · +5%↑
 *      (2026-11-27 사용자 승인(#69095): 급등장 대응 위해 거래대금 15위 → 30위 확장)
 *    · 같은 테마 +5%↑ 3종목 이상 동반
 *    · 120일(6개월) 전고점은 탈락 조건이 아니라 뱃지·정렬 조건 + 90거래일 '끼' 이력 표시
 *      (2026-11-26: 반등장에서 전고점 미달로 후보가 0종목이 되던 것을 뱃지 + 화면 🎯 ON/OFF 토글로 바꿈)
 *    · 당일 고점 상승폭의 절반을 밀면 '탈락' — 원전 손절 기준
 *  트랙 ② 하락장 역발상 (지수 -1.5% 이하 급락장)
 *    · 직전/최근 강세 테마 안에서 지수보다 덜 빠지거나 역행 상승 중인 종목
 *    · 화면에는 항상 함께 계산해 두고, 급락장이 아니면 '대기'로 표시한다
 *  수급: KIS 장중 가집계(외국인·기관계) — 없으면 '미집계'로 정직 표기(가짜 수치 금지).
 * ========================================================================== */
function hongHalfDrop(q, prevClose) {
  const high = numOrNull(q && q.high);
  const price = numOrNull(q && q.price);
  const prev = numOrNull(prevClose);
  if (high === null || price === null || prev === null || high <= prev) {
    return { level: null, state: 'unknown', dropPct: null, label: '당일 고가·전일 종가 미확인' };
  }
  const rise = high - prev;
  const level = high - rise * 0.5;
  const dropPct = round2(((high - price) / high) * 100);
  let state = 'hold';
  let label = `고점 ${Math.round(high).toLocaleString('ko-KR')}원 → 지금 ${Math.round(price).toLocaleString('ko-KR')}원(-${dropPct.toFixed(2)}%) · 절반선 위`;
  if (price <= level * 0.995) {
    state = 'drop';
    label = `주도주 탈락 — 고점 상승폭 절반(${Math.round(level).toLocaleString('ko-KR')}원) 이탈`;
  } else if (price <= level * 1.02) {
    state = 'warn';
    label = `고점 절반 이탈 주의 — 절반선 ${Math.round(level).toLocaleString('ko-KR')}원`;
  }
  return { level: Math.round(level), state, dropPct, label };
}

/** KIS 장중 기관·외국인 가집계(60초 캐시) — 종목코드 → 외인·기관계 순매수(억) */
const hongSupplyCache = new Map();
async function hongSupplyMap() {
  const hit = hongSupplyCache.get('kis');
  if (hit && Date.now() - hit.at < HONG_SUPPLY_TTL_MS) return hit.value;
  const value = { ok: false, map: {}, asOfLabel: '', note: '', errors: [] };
  const finish = () => { hongSupplyCache.set('kis', { at: Date.now(), value }); return value; };
  if (!kisLib || !kisLib.isConfigured || !kisLib.isConfigured()) {
    value.note = 'KIS 미설정 — 수급 미집계';
    return finish();
  }
  const p0 = kstParts(new Date());
  if (p0.wd === 'Sat' || p0.wd === 'Sun' || p0.minutes < 9 * 60) {
    value.note = '장외(휴장·개장 전) — 장중 가집계 없음';
    return finish();
  }
  try {
    const settled = await Promise.allSettled([
      kisLib.fetchForeignInstitutionTotal({ etcClsCode: '1', divCode: '1', sortCode: '0' }),
      kisLib.fetchForeignInstitutionTotal({ etcClsCode: '2', divCode: '1', sortCode: '0' }),
    ]);
    const put = (r, side) => {
      if (!r || !r.rows) return;
      r.rows.forEach((x) => {
        if (!x || !x.code) return;
        const cur = value.map[x.code] || { foreignEok: null, organEok: null };
        cur[side] = x.netValueRaw == null ? null : Math.round((x.netValueRaw / 100) * 10) / 10;
        value.map[x.code] = cur;
      });
    };
    if (settled[0].status === 'fulfilled') put(settled[0].value, 'foreignEok');
    else value.errors.push('외국인: ' + String((settled[0].reason && settled[0].reason.message) || settled[0].reason));
    if (settled[1].status === 'fulfilled') put(settled[1].value, 'organEok');
    else value.errors.push('기관계: ' + String((settled[1].reason && settled[1].reason.message) || settled[1].reason));
    value.ok = Object.keys(value.map).length > 0;
    value.asOfLabel = `${pad2(p0.hh)}:${pad2(p0.mi)} 가집계`;
    if (!value.ok) value.note = '가집계 응답이 비었습니다(장 마감 후·휴장일에는 비는 것이 정상)';
  } catch (e) {
    value.note = 'KIS 가집계 실패: ' + String((e && e.message) || e);
  }
  return finish();
}

function hongSupplyBadge(supply, code) {
  const row = supply && supply.map ? supply.map[code] : null;
  if (!row || (row.foreignEok == null && row.organEok == null)) {
    return { kind: 'none', label: '미집계', note: (supply && supply.note) || 'KIS 장중 가집계에 없는 종목' };
  }
  const f = numOrNull(row.foreignEok);
  const o = numOrNull(row.organEok);
  const both = f !== null && o !== null && f > 0 && o > 0;
  const label = `외인 ${f === null ? '—' : (f > 0 ? '+' : '') + f.toFixed(0) + '억'} · 기관 ${o === null ? '—' : (o > 0 ? '+' : '') + o.toFixed(0) + '억'}`;
  return { kind: both ? 'both' : 'one', label, note: (supply && supply.asOfLabel) || '' };
}

/* ⚡ 1번 탭 '장중매매 후보 (F존·K존)' — 2026-11-26 신설
 *
 *  원전: 「3강 F존, 38스윙」 — 당일 고가(H0) 대비 -8/-10/-12%가 F존(B1/B2/B3),
 *        F존 진입 뒤 실제 저점(L) 대비 +4% 반등 → 새 고점(H1) 대비 -8/-10/-12%가 K존.
 *  고가 기준은 사용자 확정: 전일 강세주·오늘 강세주 모두 '오늘 당일 고가'로 통일한다.
 *
 *  후보
 *   ① 전일 강세주 : 직전 거래일 관제탑 강세 테마 스냅샷(public/data/last-dynamic-themes.json)
 *                   의 볼만했던 테마(평균 등락률 +1%↑) 중 서로 다른 실질 테마 상위 4개 → 테마당 대장·부대장
 *   ② 오늘 강세주 : 오늘 실시간 테마 구성종목(fetchClosingThemeMembers · 상위 10테마 전체 구성)
 *                   중 상승률 +5%↑ 종목 → 테마당 대장(상승률 1위)·부대장(대금 1위)
 *  같은 종목이 여러 테마에 있으면 가장 강한 테마 카드에만 한 번 싣는다(중복 카드 금지).
 *
 *  ⚡ 2026-11-27 사용자 승인(#68248) — '전일강세주가 안 맞다(미래에셋벤처투자·스피어가 없다)' 수정
 *   ① 중복 테마 건너뛰기 : 테마 1순위 대장주(상승률 1위)가 앞 테마에서 이미 뽑혔으면 그 테마는
 *                          유사 중복 테마로 보고 건너뛴다(자리도 쓰지 않고 다음 테마로 넘어간다).
 *                          → 코로나19(치료제/진단)·백신/방역이 대장 아리바이오랩 하나로 3자리를 독식하지 않는다.
 *   ② 실질 주도 테마 우선 : 테마 평균 등락률만으로 자르면 소형 테마가 상위를 차지한다.
 *                          대금 300억↑ 종목이 있는 테마 먼저 → 테마 거래대금 합 → 평균 등락률 순으로 정렬해
 *                          어제 실제 주도주(미래에셋벤처투자 1,863억·스피어 1,129억)가 앞 순위에 잡히게 한다.
 *  기준은 아래 FK_RULES 하나로 고정하고 화면 각주에도 같은 숫자를 적는다 — 조용히 완화하지 않는다.
 */
const FK_RULES = {
  themeTop: 4,        // 서로 다른 실질 테마 상위 4개 (대장주가 겹치는 유사 테마는 건너뛴다)
  minThemePct: 1.0,   // 테마 평균 등락률 +1%↑만 '강했던 테마'(전일 섹션)
  minStockPct: 5.0,   // 대장·부대장 최소 상승률 +5% (홍인기 D+0와 같은 '강세' 기준)
  maxPct: 100,        // ±100% 이상 이상치(신규상장 첫날 등) 제외
  bigValueEok: 300,   // 실질 주도주 기준 — 이만큼 거래된 종목이 있는 테마를 먼저 본다
  /* 전일 강세주 부대장 하한 — 2026-11-27 사용자 지시
     "전일강세주에 상한가가 아닌 이상은 300억 이하인 종목은 제외해줘 대장이 아닌 이상"
     → 대장(상승률 1위)과 상한가는 대금과 무관하게 유지, 그 밖의 부대장은 대금 300억↑만.
     전일 스냅샷의 등락률은 종가 확정값이라 상한가가 29.5~30% 사이로 반올림돼 들어온다. */
  prevDeputyMinEok: 300,
  limitUpPct: 29.5,
  maxCodes: 14,       // 두 섹션 합계 최대 종목(분봉 조회 예산 · 14종목 병렬 실측 ≈0.6초)
  minuteBudgetMs: 5000,
  ttlMs: 60000,
};
let FK_CACHE = null;
let FK_PREV_DOC = null;

/** 직전 거래일 강세 테마 스냅샷 — 5분 캐시(파일은 하루 1회만 바뀐다) */
function readPrevThemeDoc() {
  if (FK_PREV_DOC && Date.now() - FK_PREV_DOC.at < 5 * 60 * 1000) return FK_PREV_DOC.value;
  let value = null;
  try {
    value = require('../public/data/last-dynamic-themes.json');
  } catch (e) {
    value = null;
  }
  FK_PREV_DOC = { at: Date.now(), value };
  return value;
}

/** 건너뛴 유사 중복 테마를 화면 각주용 한 문장으로 — 없으면 빈 문자열 */
function fkSkippedLine(skipped, sectionLabel) {
  const list = (skipped || []).filter((s) => s && s.reason === 'leader_taken');
  if (!list.length) return '';
  const brief = (n) => String(n || '').split('(')[0].trim();
  return (
    sectionLabel + ' ' + list.length + '개 테마(' +
    list.map((s) => brief(s.name) + ' — 대장 ' + s.leader + ' 중복').join(' · ') +
    ')는 대장주가 겹치는 유사 테마라 건너뛰었습니다. '
  );
}

/** 전일 강세주에서 대금 미달·비상한가로 뺀 부대장 후보 — 화면 각주용 한 문장 */
function fkDroppedDeputyLine(list) {
  const arr = (list || []).filter((x) => x && x.name);
  if (!arr.length) return '';
  return (
    '전일 부대장 후보 ' + arr.length + '종목(' +
    arr.map((x) => x.name + ' ' + (x.valueEok === null || x.valueEok === undefined ? '대금 미확인' : x.valueEok + '억')).join(' · ') +
    ')은 비상한가·대금 ' + FK_RULES.prevDeputyMinEok + '억 미만이라 뺐습니다. '
  );
}

/**
 * 테마 주도력 정렬 — 2026-11-27 사용자 승인
 *   ① 대금 FK_RULES.bigValueEok(300억)↑ 종목이 있는 테마를 먼저 (실질 주도 테마)
 *   ② 테마 거래대금 합이 큰 테마
 *   ③ 테마 평균 등락률이 높은 테마
 *   ④ 스냅샷 순위(원래 순서)
 * 단순 등락률 순이면 소형 테마가 상위를 차지해 거래대금이 큰 진짜 주도주가 밀린다.
 */
function fkThemeStrength(a, b) {
  const ab = a.bigMoney ? 1 : 0;
  const bb = b.bigMoney ? 1 : 0;
  if (ab !== bb) return bb - ab;
  if (b.valueSumEok !== a.valueSumEok) return b.valueSumEok - a.valueSumEok;
  if (b.themePct !== a.themePct) return b.themePct - a.themePct;
  return (a.rank || 99) - (b.rank || 99);
}

/** 상한가(가격제한폭 +30%) 판정 — 반올림 오차를 감안해 29.5%↑를 상한가로 본다 */
function fkIsLimitUp(pct) {
  const v = numOrNull(pct);
  return v !== null && v >= FK_RULES.limitUpPct;
}

/** 전일 강세주 부대장 자격 — 대장은 대상 아님, 상한가는 대금 무관, 나머지는 대금 하한 이상만 */
function fkDeputyEligible(r, minEok) {
  if (!r) return false;
  if (fkIsLimitUp(r.changePct)) return true;
  const value = numOrNull(r.value);
  const eok = value === null ? null : Math.round(value / 1e8);
  return eok !== null && eok >= minEok;
}

/** 테마 구성종목 rows → 테마당 대장(상승률)·부대장(대금) — used 로 중복 종목을 막는다
 *  opts.deputyMinEok 를 주면 부대장은 '상한가이거나 대금 deputyMinEok억↑'만 남긴다(전일 강세주 전용). */
function fkPickLeaders(rows, used, opts) {
  const o = opts || {};
  const taken = used || new Set();
  const themeLimit = Math.max(1, Math.min(FK_RULES.themeTop, numOrNull(o.themeLimit) || FK_RULES.themeTop));
  const deputyMinEok = numOrNull(o.deputyMinEok);
  const byTheme = new Map();
  (rows || []).forEach((r) => {
    if (!r || !r.code || !r.themeName) return;
    if (FUND_NAME_RE.test(String(r.name || ''))) return;
    const pct = numOrNull(r.changePct);
    if (pct === null || pct < FK_RULES.minStockPct || pct > FK_RULES.maxPct) return;
    const arr = byTheme.get(r.themeName) || [];
    arr.push(r);
    byTheme.set(r.themeName, arr);
  });

  const themes = Array.from(byTheme.entries())
    .map(([name, list]) => {
      const items = list.slice().sort((a, b) => (numOrNull(b.changePct) || 0) - (numOrNull(a.changePct) || 0));
      /* 테마 등락률은 테마 자체 값(스냅샷 avgPct 등)이 있으면 그것을, 없으면 노출 종목 최고 상승률을 쓴다 */
      const ownPct = items.map((x) => numOrNull(x.themePct)).filter((v) => v !== null)[0];
      const themePct = ownPct !== undefined ? ownPct : (numOrNull(items[0].changePct) || 0);
      const valueSumEok = Math.round(items.reduce((s, x) => s + (numOrNull(x.value) || 0), 0) / 1e8);
      const maxValueEok = items.reduce((m, x) => Math.max(m, Math.round((numOrNull(x.value) || 0) / 1e8)), 0);
      return {
        name,
        rank: numOrNull(items[0].themeRank),
        themePct,
        valueSumEok,
        maxValueEok,
        /* 대장(상승률 1위) 또는 부대장(대금 1위)이 300억↑ — 실질 주도 테마 판별 */
        bigMoney: maxValueEok >= FK_RULES.bigValueEok,
        themePctRaw: ownPct !== undefined ? ownPct : null,
        items,
      };
    })
    .filter((t) => t.items.length >= 1)
    .sort(fkThemeStrength);

  const picked = [];
  const pickedThemes = [];
  const skipped = [];
  const deputyDropped = [];
  for (let i = 0; i < themes.length && pickedThemes.length < themeLimit; i += 1) {
    const t = themes[i];
    const headline = t.items[0];   // 테마 1순위 대장주(상승률 1위)
    if (!headline) continue;
    /* ① 유사 중복 테마 — 1순위 대장주가 이미 앞 테마에서 뽑혔으면 이 테마는 자리도 쓰지 않고 건너뛴다.
       코로나19(치료제)·코로나19(진단)·백신/방역이 대장 아리바이오랩 하나로 3자리를 독식하던 문제(2026-11-27). */
    if (taken.has(headline.code)) {
      skipped.push({ name: t.name, leader: headline.name, leaderCode: headline.code, reason: 'leader_taken' });
      continue;
    }
    const pool = t.items.filter((x) => !taken.has(x.code));
    if (!pool.length) {
      skipped.push({ name: t.name, leader: headline.name, leaderCode: headline.code, reason: 'no_stock_left' });
      continue;
    }
    const leader = pool[0];
    const rest = pool.slice(1);
    let deputy = null;
    if (deputyMinEok !== null) {
      const byValue = (a, b) => (numOrNull(b.value) || 0) - (numOrNull(a.value) || 0);
      /* 부대장은 '대금 1위' 후보 하나만 본다 — 그 후보가 기준 미달이면 뺀 종목으로 남기고,
         같은 테마에서 기준을 넘는 다른 후보가 있으면 그 종목을 부대장으로 올린다. */
      const top = rest.slice().sort(byValue)[0] || null;
      if (top && !fkDeputyEligible(top, deputyMinEok)) {
        deputyDropped.push({
          code: top.code,
          name: top.name,
          themeName: t.name,
          pct: round2(numOrNull(top.changePct)),
          valueEok: top.value ? Math.round(top.value / 1e8) : null,
        });
        deputy = rest.filter((r) => fkDeputyEligible(r, deputyMinEok)).sort(byValue)[0] || null;
      } else {
        deputy = top;
      }
    } else {
      deputy = rest.slice().sort((a, b) => (numOrNull(b.value) || 0) - (numOrNull(a.value) || 0))[0] || null;
    }
    const add = (r, role) => {
      taken.add(r.code);
      picked.push({
        code: r.code,
        name: r.name,
        role,
        themeName: t.name,
        themeRank: t.rank,
        themePct: round2(t.themePct),
        themeValueSumEok: t.valueSumEok,
        themeBigMoney: t.bigMoney,
        pct: round2(numOrNull(r.changePct)),
        valueEok: r.value ? Math.round(r.value / 1e8) : null,
        valueText: r.valueText || null,
        quotePrice: numOrNull(r.price),
      });
    };
    add(leader, '대장');
    if (deputy) add(deputy, '부대장');
    pickedThemes.push(t);
  }
  return {
    themes: pickedThemes.map((t) => ({
      name: t.name,
      rank: t.rank,
      themePct: round2(t.themePct),
      valueSumEok: t.valueSumEok,
      maxValueEok: t.maxValueEok,
      bigMoney: t.bigMoney,
    })),
    items: picked,
    skipped,
    deputyDropped,
    themeLimit,
  };
}

/** 1분봉 → F/K존 계산 (실패는 null 로 남기고 사유만 적는다) */
async function fkItemWithZone(base) {
  let got = null;
  try {
    got = await fkzone.fetchMinuteBars(base.code);
  } catch (e) {
    got = { ok: false, reason: String((e && e.message) || e) };
  }
  const zone = got && got.ok ? fkzone.computeFkZone(got.bars) : null;
  const last = zone && typeof zone.last === 'number' ? zone.last : null;
  const prevClose = base.prevClose;
  const pctNow = last !== null && prevClose ? round2(((last - prevClose) / prevClose) * 100) : null;
  return Object.assign({}, base, {
    minuteOk: Boolean(zone),
    minuteReason: zone ? null : String((got && (got.reason || got.message)) || 'no_candles'),
    price: last !== null ? last : base.quotePrice,
    pctNow,
    zone,
  });
}

async function buildFkZone(ctx) {
  const c = ctx || {};
  const p0 = kstParts(new Date());
  const todayKey = `${p0.y}${pad2(p0.m)}${pad2(p0.d)}`;
  const out = {
    ok: true,
    generatedAtKst: `${pad2(p0.hh)}:${pad2(p0.mi)}`,
    rules: {
      b1: '-8%', b2: '-10%', b3: '-12%', rebound: '+4%',
      themeTop: FK_RULES.themeTop, minStockPct: FK_RULES.minStockPct, maxPct: FK_RULES.maxPct,
      bigValueEok: FK_RULES.bigValueEok,
      prevDeputyMinEok: FK_RULES.prevDeputyMinEok,
      limitUpPct: FK_RULES.limitUpPct,
      basis: '오늘(당일) 고가 기준',
      themeRule: '대금 ' + FK_RULES.bigValueEok + '억↑ 주도 테마 우선 · 대장주가 겹치는 유사 테마는 건너뜀',
      prevDeputyRule: '전일 강세주 부대장은 상한가이거나 대금 ' + FK_RULES.prevDeputyMinEok + '억↑만 (대장은 대금 무관)',
    },
    prev: { label: '전일 강세주', asOf: null, asOfLabel: null, isToday: false, themes: [], count: 0 },
    today: { label: '오늘 강세주', asOf: todayKey, themes: [], count: 0 },
    items: [],
    errors: [],
    note: '',
    sourceLabel: '/api/tabs-live fkZone (테마 구성종목 + 네이버 1분봉 파동 계산)',
  };

  const cacheKey = `${todayKey}:${p0.minutes}`;
  if (FK_CACHE && Date.now() - FK_CACHE.at < FK_RULES.ttlMs) {
    return Object.assign({}, FK_CACHE.value, { cached: true });
  }

  /* ---------- ① 전일 강세주 ---------- */
  const used = new Set();
  let prevItems = [];
  const doc = readPrevThemeDoc();
  if (doc && Array.isArray(doc.themes) && doc.themes.length) {
    out.prev.asOf = doc.asOfDate || null;
    out.prev.asOfLabel = doc.basisLong || doc.shortLabel || null;
    out.prev.isToday = String(doc.asOfDate || '') === todayKey;
    if (out.prev.isToday) out.prev.label = '최근 마감 강세주';
    const rows = [];
    doc.themes.forEach((t) => {
      const pct = numOrNull(t.avgPct);
      if (pct === null || pct < FK_RULES.minThemePct) return;
      (t.stocks || []).forEach((s) => {
        rows.push({
          code: s.code,
          name: s.name,
          changePct: numOrNull(s.changePct),
          value: numOrNull(s.value),
          valueText: s.valueText || null,
          price: numOrNull(s.price),   // 직전 거래일 종가 = 오늘 기준가
          themeName: t.name,
          themeRank: t.rank,
          themePct: pct,
        });
      });
    });
    /* 스냅샷 themes 는 이미 강한 순서 — fkPickLeaders 가 rank 없는 rows 도 순서대로 쓴다 */
    let rk = 0;
    const rankByTheme = new Map();
    rows.forEach((r) => {
      if (!rankByTheme.has(r.themeName)) rankByTheme.set(r.themeName, ++rk);
      r.themeRank = r.themeRank || rankByTheme.get(r.themeName);
    });
    const prevPick = fkPickLeaders(rows, used, { deputyMinEok: FK_RULES.prevDeputyMinEok });
    out.prev.themes = prevPick.themes;
    out.prev.skippedThemes = prevPick.skipped;
    out.prev.droppedDeputies = prevPick.deputyDropped || [];
    prevItems = prevPick.items.map((x) => Object.assign({}, x, { section: 'prev', prevClose: x.quotePrice }));
  } else {
    out.errors.push('prev: 직전 거래일 강세 테마 스냅샷을 읽지 못했습니다');
  }

  /* ---------- ② 오늘 강세주 ---------- */
  let todayItems = [];
  let memberRowsRaw = [];
  try {
    memberRowsRaw = c.memberRows ? await c.memberRows : [];
  } catch (e) {
    out.errors.push('today: 테마 구성종목 조회 실패');
  }
  const memberRows = (memberRowsRaw && memberRowsRaw.rows) || memberRowsRaw || [];
  if (memberRows.length) {
    const rows = memberRows.map((r) => ({
      code: r.code,
      name: r.name,
      changePct: numOrNull(r.changePct),
      value: numOrNull(r.value),
      valueText: null,
      price: numOrNull(r.price),
      themeName: r.themeName,
      themeRank: numOrNull(r.themeRank),
    }));
    /* 오늘 섹션은 전일 후보가 쓴 종목·테마를 피하고, 남은 분봉 조회 예산 안에서만 테마를 잡는다 */
    const todayThemeLimit = Math.max(1, Math.min(FK_RULES.themeTop, Math.floor(Math.max(2, FK_RULES.maxCodes - prevItems.length) / 2)));
    const todayPick = fkPickLeaders(rows, used, { themeLimit: todayThemeLimit });
    out.today.themes = todayPick.themes;
    out.today.skippedThemes = todayPick.skipped;
    todayItems = todayPick.items.map((x) => {
      const q = x.quotePrice;
      const pc = q !== null && x.pct !== null && x.pct > -100 ? round2(q / (1 + x.pct / 100)) : null;
      return Object.assign({}, x, { section: 'today', prevClose: pc });
    });
  } else {
    out.errors.push('today: 테마 구성종목이 비어 있습니다');
  }

  const all = prevItems.concat(todayItems).slice(0, FK_RULES.maxCodes);
  out.prev.count = all.filter((x) => x.section === 'prev').length;
  out.today.count = all.filter((x) => x.section === 'today').length;

  /* ---------- ③ 1분봉 파동 계산 (예산 5초, 초과분은 상태 없이 카드만) ---------- */
  if (all.length) {
    const withZone = await Promise.race([
      Promise.all(all.map((x) => fkItemWithZone(x))),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), FK_RULES.minuteBudgetMs)),
    ]);
    if (withZone === 'TIMEOUT') {
      out.items = all;
      out.errors.push('minute: 5초 예산 초과 — F/K존 상태 없이 카드만 표시');
    } else {
      out.items = withZone;
    }
  }

  /* 오늘 강세주는 '지금' 강한 종목이어야 한다 — 테마 구성종목 행은 몇 분 늦게 갱신될 수 있어,
     1분봉 실측 등락률이 +5% 아래로 내려온 종목은 강세주가 아니므로 뺀다(임의 완화가 아니라 강화).
     전일 강세주는 오늘 조정 중인 것이 정상이라 이 필터를 적용하지 않는다. */
  if (out.items.length) {
    const dropped = [];
    out.items = out.items.filter((x) => {
      if (x.section !== 'today') return true;
      if (!x.minuteOk || numOrNull(x.pctNow) === null) return true;
      if (x.pctNow >= FK_RULES.minStockPct) return true;
      dropped.push({ code: x.code, name: x.name, pctNow: x.pctNow });
      return false;
    });
    if (dropped.length) {
      out.droppedToday = dropped;
      out.today.count = out.items.filter((x) => x.section === 'today').length;
      const aliveThemes = new Set(out.items.filter((x) => x.section === 'today').map((x) => x.themeName));
      out.today.themes = (out.today.themes || []).filter((t) => aliveThemes.has(t.name));
    }
  }

  out.note =
    '고가 기준은 전일·오늘 모두 <b>오늘(당일) 고가</b>입니다 — B1 -8% · B2 -10% · B3 -12%. ' +
    'F존 진입(1분봉 저가 ≤ B1) 뒤 실제 저점(L) 대비 +4% 반등이 나오면 반등 파동으로 보고, 그 뒤 새 고점(H1) 대비 같은 -8/-10/-12%를 K존으로 표시합니다. ' +
    '후보는 강세 테마(평균 +1%↑) 중 <b>대금 ' + FK_RULES.bigValueEok + '억↑ 실질 주도주가 있는 테마를 먼저</b>, 그 다음 테마 거래대금 합·평균 등락률 순으로 서로 다른 테마 ' + FK_RULES.themeTop + '개의 대장(상승률)·부대장(대금)이고, 종목은 상승률 +' + FK_RULES.minStockPct + '%↑만 넣습니다. ' +
    '대장주가 이미 뽑힌 테마(코로나19 진단·백신/방역 등)는 유사 중복 테마로 보고 자리를 양보합니다. ' +
    '<b>전일 강세주는 대장이 아니면 상한가이거나 대금 ' + FK_RULES.prevDeputyMinEok + '억↑인 종목만</b> 싣습니다. ' +
    fkDroppedDeputyLine(out.prev.droppedDeputies) +
    fkSkippedLine(out.prev.skippedThemes, '전일') + fkSkippedLine(out.today.skippedThemes, '오늘') +
    (out.droppedToday && out.droppedToday.length
      ? '오늘 강세주 중 1분봉 실측 등락률이 +' + FK_RULES.minStockPct + '% 아래로 내려온 ' + out.droppedToday.length + '종목(' + out.droppedToday.map((d) => d.name).join('·') + ')은 뺐습니다.'
      : '');

  const body = Object.assign({}, out, { cacheKey });
  if (!out.errors.length) FK_CACHE = { at: Date.now(), value: out };
  return body;
}

/* 🍔 1번 탭 '장중매매 후보 (불개미 · 햄버거)' — 2026-11-27 신설
 *
 *  원전: 부자회사원 채널 「불개미님 햄버거 기법」 2편
 *   · 과거 그 종목이 장대양봉을 냈던 날의 **시동 3분봉 대금**을 기준으로 기억하고,
 *     오늘 그 종목이 속한 테마가 주도 섹터로 살아 있을 때 **장초반 3분봉 대금이
 *     기준을 압도**하면 햄버거 완성으로 본다.
 *   · 대금이 터져도 **긴 위꼬리 · 도지 · 음봉 · 역배열** 자리는 상승 확률이 낮아 뺀다.
 *
 *  후보 — '오늘 강한 테마의 대장주·부대장주'(사용자 확정 #70211)
 *   오늘 실시간 테마 구성종목(fetchClosingThemeMembers 상위 10테마 전체)에서
 *   테마당 대장(상승률 1위)·부대장(대금 1위)을 뽑고, 조건(테마 +1%↑ · 종목 +5%↑)은
 *   F존·K존과 같은 잣대를 쓴다. 대장주가 겹치는 유사 테마는 건너뛴다.
 *
 *  계산 예산
 *   · 기준(과거 3분봉): 저장소 JSON → Supabase 공용 행 → 없으면 이번 요청에서 계산.
 *     계산은 일봉 1회 + 그날 분봉 1회라 비싸므로 **요청당 3종목까지만** 즉석 계산한다.
 *     계산한 값은 Supabase 에 합쳐 둔다(다른 인스턴스·다음 날도 재사용).
 *   · 오늘 장초반 3분봉: 종목당 1회, 30초(장마감 뒤엔 값이 변하지 않는다) 캐시.
 */
const HAM_RULES = {
  themeTop: 4,
  minThemePct: 1.0,
  minStockPct: 5.0,
  maxCodes: 8,          // 기준·오늘 분봉 조회 예산(8종목 ≈ 1~2초)
  lazyBaseCodes: 8,     // 요청당 즉석 계산할 기준 수 — 계산값은 Supabase·메모리에 남아 다음부터는 즉시
  budgetMs: 6500,
  ttlMs: 60000,
};
let HAM_CACHE = null;

/** 오늘 강한 테마의 대장·부대장 — F존과 같은 fkPickLeaders 를 그대로 쓴다(잣대 통일) */
function hamCandidates(memberRows) {
  const rows = (memberRows || []).map((r) => ({
    code: r.code,
    name: r.name,
    changePct: numOrNull(r.changePct),
    value: numOrNull(r.value),
    valueText: null,
    price: numOrNull(r.price),
    themeName: r.themeName,
    themeRank: numOrNull(r.themeRank),
  }));
  const picked = fkPickLeaders(rows, new Set(), { themeLimit: HAM_RULES.themeTop });
  return {
    items: picked.items.slice(0, HAM_RULES.maxCodes).map((x) => Object.assign({}, x, {
      pctNow: x.pct,
      quotePrice: numOrNull(x.quotePrice),
    })),
    themes: picked.themes,
    skipped: picked.skipped,
  };
}

/** 한 후보의 기준·오늘 3분봉·판정 — 실패는 사유만 남기고 카드는 유지 */
async function hamItem(cand, opts) {
  const o = opts || {};
  const [base, today] = await Promise.all([
    o.allowCompute
      ? hamburger.getBase(cand.code).catch((e) => ({ ok: false, code: cand.code, reason: 'base_error', message: String((e && e.message) || e) }))
      : hamburger.getBase(cand.code, { cacheOnly: true }).catch(() => ({ ok: false, code: cand.code, reason: 'base_missing', message: '기준 미계산' })),
    hamburger.getTodayOpen(cand.code).catch((e) => ({ ok: false, code: cand.code, reason: 'today_error', message: String((e && e.message) || e) })),
  ]);
  const verdict = hamburger.judge(base, today, { pctNow: cand.pctNow });
  return Object.assign({}, cand, {
    price: numOrNull(cand.quotePrice),
    base: base && base.ok
      ? {
        ok: true,
        date: base.bigYang.date,
        dateLabel: base.bigYang.dateLabel,
        pct: base.bigYang.pct,
        dayValueEok: base.bigYang.valueEok,
        upperWickPct: base.bigYang.upperWickPct,
        bodyPct: base.bigYang.bodyPct,
        ohlcSrc: base.bigYang.ohlcSrc || null,
        open3mEok: base.bigYang.open3m ? base.bigYang.open3m.valueEok : null,
        open3m: base.bigYang.open3m || null,
        others: base.others || [],
        skippedBases: base.skippedBases || [],
        reversal: base.reversal || null,
      }
      : {
        ok: false,
        reason: (base && base.reason) || 'not_ready',
        message: (base && base.message) || '기준 대금 미계산',
        skippedBases: (base && base.skippedBases) || [],
        rejectedDays: (base && base.rejectedDays) || [],
      },
    today: today && today.ok
      ? {
        ok: true,
        date: today.date,
        dateLabel: today.dateLabel,
        market: today.market,
        marketLabel: today.marketLabel,
        open3mEok: today.open3m.valueEok,
        open3m: today.open3m,
      }
      : { ok: false, reason: (today && today.reason) || 'not_ready', message: (today && today.message) || '오늘 장초반 3분봉 미수신', market: today && today.market },
    verdict,
  });
}

async function buildHamburger(ctx) {
  const c = ctx || {};
  const p0 = kstParts(new Date());
  const out = {
    ok: true,
    generatedAtKst: `${pad2(p0.hh)}:${pad2(p0.mi)}`,
    rules: Object.assign({}, hamburger.publicRules(), {
      themeTop: HAM_RULES.themeTop,
      minThemePct: HAM_RULES.minThemePct,
      minStockPct: HAM_RULES.minStockPct,
      maxCodes: HAM_RULES.maxCodes,
      candidateRule: '오늘 강한 테마(평균 +' + HAM_RULES.minThemePct + '%↑)의 대장(상승률)·부대장(대금) · 종목 +' + HAM_RULES.minStockPct + '%↑',
      showRule: '성립 종목만 카드로 — 기준 미달·실패 패턴은 숫자로만 남깁니다',
    }),
    themes: [],
    items: [],
    counts: { candidates: 0, pass: 0, blocked: 0, wait: 0, noBase: 0, valueShort: 0, excluded: 0, shown: 0 },
    errors: [],
    note: '',
    sourceLabel: '/api/tabs-live hamburger (테마 대장·부대장 + KIS 일봉·과거 분봉·오늘 분봉 실측)',
  };

  if (HAM_CACHE && Date.now() - HAM_CACHE.at < HAM_RULES.ttlMs) {
    return Object.assign({}, HAM_CACHE.value, { cached: true });
  }

  let members = [];
  try {
    const raw = c.memberRows ? await c.memberRows : [];
    members = (raw && raw.rows) || raw || [];
  } catch (e) {
    out.errors.push('테마 구성종목 조회 실패');
  }
  if (!members.length) {
    out.errors.push('테마 구성종목이 비어 있습니다');
    out.note = '오늘 테마 구성종목을 받지 못해 후보를 만들지 않았습니다 — 값을 지어내지 않습니다.';
    return out;
  }

  const pick = hamCandidates(members);
  out.themes = pick.themes;
  if (!pick.items.length) {
    out.note = '오늘 테마에서 조건(테마 +' + HAM_RULES.minThemePct + '%↑ · 종목 +' + HAM_RULES.minStockPct + '%↑)을 채운 대장·부대장이 없습니다 — 기준을 임의로 완화하지 않습니다.';
    return out;
  }

  const work = pick.items.map((cand, i) => hamItem(cand, { allowCompute: i < HAM_RULES.lazyBaseCodes }));
  const raced = await Promise.race([
    Promise.all(work),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), HAM_RULES.budgetMs)),
  ]);
  if (raced === 'TIMEOUT') {
    out.errors.push('분봉·기준 조회가 ' + Math.round(HAM_RULES.budgetMs / 1000) + '초 예산을 넘었습니다 — 다음 폴링에서 이어집니다');
    out.items = pick.items.map((x) => Object.assign({}, x, {
      base: { ok: false, reason: 'timeout', message: '기준 조회 예산 초과' },
      today: { ok: false, reason: 'timeout', message: '오늘 분봉 조회 예산 초과' },
      verdict: { pass: false, tag: '조회 지연', tagKind: 'wait', reasons: ['다음 폴링에서 다시 계산합니다'], blocks: [] },
    }));
  } else {
    out.items = raced;
  }

  out.items.forEach((x) => {
    const v = x.verdict || {};
    if (v.pass) out.counts.pass += 1;
    else if (v.baseMissing) out.counts.noBase += 1;
    else if (v.tagKind === 'dn') out.counts.blocked += 1;
    else if (v.tagKind === 'mute') out.counts.valueShort += 1;
    else out.counts.wait += 1;
  });
  out.counts.candidates = out.items.length;
  out.counts.excluded = out.items.length - out.counts.pass;
  out.counts.shown = out.counts.pass;
  out.note =
    '후보 ' + out.counts.candidates + '종목 중 <b>' + out.counts.pass + '종목 성립</b>' +
    (out.counts.excluded
      ? ' (나머지 ' + out.counts.excluded + '종목 제외: 대금 미달 ' + out.counts.valueShort +
        ' · 실패 패턴 ' + out.counts.blocked + ' · 기준 없음/미달 ' + out.counts.noBase +
        (out.counts.wait ? ' · 오늘 분봉 대기 ' + out.counts.wait : '') + ')'
      : '') + '. ' +
    '기준은 <b>가장 최근 윗꼬리 짧은 장대양봉(+' + hamburger.HAM.yangPct + '%↑ · 대금 ' + hamburger.HAM.yangValueEok + '억↑ · 몸통 ' +
    Math.round(hamburger.HAM.baseBodyMin * 100) + '%↑ · 윗꼬리 ' + Math.round(hamburger.HAM.baseUpperWickMax * 100) + '%↓) 1일만 보고 그날 09:00~09:02 3분봉 대금 ' +
    hamburger.HAM.minBase3mEok + '억↑</b>일 때만 기준으로 인정하며(20억 미만이면 과거 날로 거슬러 올라가지 않고 제외), 오늘 장초반 3분봉 대금이 그 기준을 넘고 긴 위꼬리·도지·음봉·일봉 역배열이 없을 때만 성립입니다 — 자세한 기준은 📖 매매원칙 보기.';

  if (!out.errors.length) HAM_CACHE = { at: Date.now(), value: out };
  return out;
}

async function buildIntradayHong(ctx) {
  const c = ctx || {};
  const p0 = kstParts(new Date());
  const weekend = p0.wd === 'Sat' || p0.wd === 'Sun';
  const minutes = p0.minutes;
  const beforeOpen = !weekend && minutes < 9 * 60;
  const beforeD0 = !weekend && minutes < HONG_D0.openMinute;
  /* 09:00~09:29 — 장은 열렸고 D+0 판정 시각(09:30)만 안 된 구간.
     2026-11-26 사용자 확정: 이 구간에도 기준을 채운 후보는 '미리보기'로 내려보낸다.
     (매매 권장은 원전대로 09:30 이후. 09:00 이전 장전·프리마켓은 값이 굳어 있어 제외)
     장전·프리마켓에는 당일 등락률·거래대금이 아니라 직전 값이므로 후보를 만들지 않는다. */
  const previewD0 = !weekend && minutes >= 9 * 60 && minutes < HONG_D0.openMinute;
  const afterClose = !weekend && minutes >= 15 * 60 + 30;
  const supply = (c.supply ? await c.supply : null) || (await hongSupplyMap());
  const indexGate = (c.indexGate ? await c.indexGate : null) || null;
  const memberRowsRaw = c.memberRows ? await c.memberRows : [];
  const memberRows = (memberRowsRaw && memberRowsRaw.rows) || memberRowsRaw || [];
  const kospi = numOrNull(indexGate && indexGate.kospiPct);
  const kosdaq = numOrNull(indexGate && indexGate.kosdaqPct);
  const indexMin = [kospi, kosdaq].filter((v) => v !== null).length
    ? Math.min(...[kospi, kosdaq].filter((v) => v !== null))
    : null;

  const out = {
    ok: true,
    generatedAt: new Date().toISOString(),
    generatedAtKst: `${pad2(p0.hh)}:${pad2(p0.mi)}`,
    sessionPhase: c.phase || null,
    gate: {
      ready: !weekend && !beforeD0 && !afterClose,
      beforeD0: !weekend && beforeD0,
      previewD0: !weekend && previewD0,
      afterClose: !weekend && afterClose,
      weekend,
      minute: minutes,
      text: weekend
        ? '휴장일 — 다음 거래일 09:30 이후 D+0 탐색'
        : previewD0
          ? '⏳ 09:30 이전 관망 구간 — 후보는 미리 확인, 실전 매매는 09:30 이후 권장'
          : beforeD0
            ? '09:30 이후 D+0 탐색 대기 (원전: 9시 30분 이전 매매 자제)'
            : afterClose
              ? '정규장 마감(15:30) — 오늘 D+0 판정 종료'
              : '09:30 이후 D+0 탐색 구간',
    },
    thresholds: {
      valueRank: HONG_D0.valueRankMax,
      valueEok: HONG_D0.valueEok,
      pct: HONG_D0.pct,
      themeStocks: HONG_D0.themeStocks,
      nearHighPct: HONG_D0.nearHighPct,
      halfDrop: '당일 고점 상승폭의 50%',
    },
    leader: [],
    leaderStats: { judged: (c.pool || []).length, rank: 0, value: 0, pct: 0, theme: 0, near120: 0, picked: 0, pickedNear: 0, candleMissing: 0 },
    downside: { active: false, index: { kospiPct: kospi, kosdaqPct: kosdaq, asOf: (indexGate && indexGate.asOf) || null }, items: [], note: '' },
    supply: {
      ok: Boolean(supply && supply.ok),
      asOfLabel: (supply && supply.asOfLabel) || '',
      note: (supply && supply.note) || '',
      errors: (supply && supply.errors) || [],
    },
    notes: [],
    sourceLabel: '/api/tabs-live intradayHong (KRX 거래대금·등락률 상위 + 네이버 테마 구성종목 + KIS 장중 가집계)',
  };

  /* ---- 테마 동반 상승 — 코드 → 같은 테마에서 +5%↑ 종목 수 */
  const themeCount = new Map();     // themeName → +5%↑ 종목 수
  const themeTotal = new Map();     // themeName → 구성종목 수
  const themesOf = new Map();       // code → [{theme, rank}]
  memberRows.forEach((r) => {
    if (!r || !r.code) return;
    const th = r.themeName || '';
    if (!th) return;
    themeTotal.set(th, (themeTotal.get(th) || 0) + 1);
    if (typeof r.changePct === 'number' && r.changePct >= HONG_D0.pct) {
      themeCount.set(th, (themeCount.get(th) || 0) + 1);
    }
    const arr = themesOf.get(r.code) || [];
    arr.push({ theme: th, rank: r.themeRank || null });
    themesOf.set(r.code, arr);
  });

  const prevStrong = new Set((c.prevStrongThemes || []).map((t) => String(t).replace(/\s+/g, '')));

  /* 장전·프리마켓(09:00 이전)·휴장에는 당일 등락률·대금이 갱신되지 않는다 — 후보를 만들지 않는다 */
  const poolRows = beforeOpen || weekend ? [] : (c.pool || []);
  out.leaderStats.judged = poolRows.length;   // 판정에 실제로 넣은 후보 수(장전·휴장은 0)  
  poolRows.forEach((j) => {
    const st = out.leaderStats;
    const rank = j.valueRank === null || j.valueRank === undefined ? null : j.valueRank;
    if (rank !== null && rank <= HONG_D0.valueRankMax) st.rank += 1;
    if (j.valueEok !== null && j.valueEok >= HONG_D0.valueEok) st.value += 1;
    if (typeof j.pct === 'number' && j.pct >= HONG_D0.pct) st.pct += 1;

    if (rank === null || rank > HONG_D0.valueRankMax) return;
    if (j.valueEok === null || j.valueEok < HONG_D0.valueEok) return;
    if (typeof j.pct !== 'number' || j.pct < HONG_D0.pct) return;
    if (j.hi120 === null || j.hi120 === undefined) { st.candleMissing += 1; return; }

    const gap120 = round2(((j.hi120 - j.price) / j.price) * 100);
    const break120 = Boolean(j.break120);
    const near120 = break120 || (gap120 !== null && gap120 <= HONG_D0.nearHighPct);
    /* 120일 전고점 돌파/근접은 탈락 조건이 아니라 뱃지·정렬 조건으로 내려보낸다.
       2026-11-26 사용자 확정: 반등장에서 전고점 미달이면 후보가 통째로 사라지던 하드 탈락을 걷어내고,
       화면의 `🎯 120일 전고점만 보기` 토글이 걸러 보게 한다(기본 OFF = 전체 후보). */
    if (near120) st.near120 += 1;

    const th = themesOf.get(j.code) || [];
    let best = null;
    th.forEach((t) => {
      const n = themeCount.get(t.theme) || 0;
      if (!best || n > best.up5) best = { theme: t.theme, up5: n, total: themeTotal.get(t.theme) || 0 };
    });
    const themeOk = Boolean(best && best.up5 >= HONG_D0.themeStocks);
    if (themeOk) st.theme += 1;

    const half = hongHalfDrop(j, j.prevClose);
    const sup = hongSupplyBadge(supply, j.code);
    out.leader.push({
      code: j.code,
      name: j.name,
      market: j.market || null,
      price: j.price,
      pct: j.pct,
      open: j.open,
      high: j.high,
      low: j.low,
      prevClose: j.prevClose,
      valueEok: j.valueEok,
      valueText: j.valueDispText || j.valueText || null,
      valueRank: rank,
      upper: j.upper,
      bodyRate: j.bodyRate,
      volX: j.volX,
      hi120: j.hi120,
      hi120Date: j.hi120Date,
      gap120,
      near120,
      break120,
      firstBreak120: Boolean(j.firstBreak120),
      theme: best ? best.theme : null,
      themeUp5: best ? best.up5 : 0,
      themeMembers: best ? best.total : 0,
      themeOk,
      half,
      supply: sup,
      kk: j.kk || { limitUp: null, up20: null, chain: null, count: null },
      badges: [],
    });
  });

  /* 정렬: ① 120일 전고점 돌파/근접 먼저 ② 테마 3종목 동반 ③ 고점 절반선 유지 ④ 등락률·거래대금 */
  out.leader.sort((a, b) => {
    if (a.near120 !== b.near120) return a.near120 ? -1 : 1;
    if (a.themeOk !== b.themeOk) return a.themeOk ? -1 : 1;
    if (a.half.state !== b.half.state) {
      const w = { hold: 0, warn: 1, drop: 2, unknown: 3 };
      return (w[a.half.state] || 9) - (w[b.half.state] || 9);
    }
    return (b.pct || 0) - (a.pct || 0) || (b.valueEok || 0) - (a.valueEok || 0);
  });
  /* 위에서 거래대금 30위 밖은 이미 걸러졌으므로 후보는 최대 30종목.
     2026-11-27 사용자 승인(#69095): 순위 상한을 30위로 넓힌 만큼 표시 상한도 15 → 30으로 함께 넓혀
     '기준을 통과했는데 화면에서 잘려 안 보이는' 종목이 생기지 않게 한다(토글 OFF는 후보 전체). */
  out.leader = out.leader.slice(0, HONG_D0.valueRankMax);
  out.leaderStats.picked = out.leader.length;
  out.leaderStats.pickedNear = out.leader.filter((x) => x.near120).length;
  if (out.leader.length && !out.leaderStats.pickedNear) {
    out.notes.push(
      `오늘은 120일 전고점 돌파/근접 종목이 없습니다 — 전고점 이격 반등형 ${out.leader.length}종목만 후보로 남겼습니다(🎯 토글 ON이면 0종목).`,
    );
  }

  if (!out.leader.length) {
    if (beforeOpen || weekend) {
      out.notes.push(
        `장전·휴장에는 당일 등락률·거래대금이 갱신되지 않아 D+0 후보를 판정하지 않습니다 — 09:30 이후 다시 계산합니다(원전: 9시 30분 이전 매매 자제).`,
      );
    } else if (previewD0) {
      out.notes.push(
        `09:30 이전 관망 구간입니다 — 기준(거래대금 ${HONG_D0.valueRankMax}위 이내 · ${HONG_D0.valueEok}억↑ · +${HONG_D0.pct}%↑)을 채운 종목이 아직 없습니다. 09:30 이후 다시 계산합니다(미리보기 구간).`,
      );
    } else if (afterClose) {
      out.notes.push(
        `정규장이 끝나(15:30 이후) 오늘 D+0 판정은 종료됐습니다 — 남은 시간외 흐름은 위 '하락장 역발상'과 🌙 종가베팅 후보에서 보십시오.`,
      );
    } else {
      out.notes.push(
        `조건(거래대금 ${HONG_D0.valueRankMax}위 이내 · ${HONG_D0.valueEok}억↑ · +${HONG_D0.pct}%↑)을 모두 채운 종목이 없습니다 — 기준을 임의로 완화하지 않았습니다.`,
      );
    }
  }
  if (out.leaderStats.judged === 0) {
    out.notes.push('등락 +5%↑ 후보 일봉 판정이 0건입니다 — 장전·휴장일이거나 KRX 순위 응답이 비었습니다.');
  }

  /* ---- 트랙 ② 하락장 역발상 — 직전/최근 강세 테마 안에서 지수보다 강한 종목 */
  const down = out.downside;
  down.active = indexMin !== null && indexMin <= HONG_DOWN.indexPct;
  const seen = new Set();
  memberRows.forEach((r) => {
    if (!r || !r.code || seen.has(r.code)) return;
    const pct = numOrNull(r.changePct);
    const valueEok = numOrNull(r.value) !== null ? r.value / 1e8 : null;
    if (pct === null || valueEok === null || valueEok < HONG_DOWN.minValueEok) return;
    if (indexMin !== null && pct - indexMin < HONG_DOWN.minRelPct) return;
    if (pct < -1.0) return;                                  // 지수보다 덜 빠지는 것까지는 인정, -1% 아래는 제외
    const thKey = String(r.themeName || '').replace(/\s+/g, '');
    const isPrev = prevStrong.has(thKey);
    if (!isPrev && (r.themeRank || 99) > 5) return;           // 직전 강세 테마가 아니면 '오늘 강세 Top 5'만
    seen.add(r.code);
    down.items.push({
      code: r.code,
      name: r.name,
      theme: r.themeName,
      themeRank: r.themeRank || null,
      prevStrong: isPrev,
      price: r.price,
      pct,
      valueEok: round2(valueEok),
      relPct: indexMin === null ? null : round2(pct - indexMin),
      supply: hongSupplyBadge(supply, r.code),
    });
  });
  down.items.sort((a, b) => (b.relPct || 0) - (a.relPct || 0));
  down.items = down.items.slice(0, 6);
  down.note = down.active
    ? `지수 급락(${kospi === null ? '—' : (kospi > 0 ? '+' : '') + kospi.toFixed(2)}% / ${kosdaq === null ? '—' : (kosdaq > 0 ? '+' : '') + kosdaq.toFixed(2)}%) — D+0 확인 → 익일 D+1 반등장 집중 공략 후보`
    : `지수 급락장 아님(코스피 ${kospi === null ? '—' : kospi.toFixed(2)}% · 코스닥 ${kosdaq === null ? '—' : kosdaq.toFixed(2)}%) — 오늘은 참고용 대기. 급락장(-1.5% 이하)이 되면 같은 목록이 공략 후보로 바뀝니다`;
  if (!down.items.length) {
    down.note += ' · 조건(강세 테마 소속 · 대금 100억↑ · 지수 대비 +0.5%p 이상)을 채운 종목 없음';
  }
  if (!prevStrong.size) {
    out.notes.push('직전 거래일 강세 테마 스냅샷이 없어 오늘 강세 Top 5 테마로만 비교했습니다.');
  }
  return out;
}

function judgeBijDay1(card, q) {
  const base = card && card.c;
  if (!base || !q || q.price === null || q.price === undefined) return null;
  const price = q.price;
  const open = q.open;
  const high = q.high;
  const low = q.low;
  const vsBasePct = (price / base - 1) * 100;
  const gapPct = open ? (open / base - 1) * 100 : null;
  const bodyPct = open ? (price / open - 1) * 100 : null;
  let patternKey;
  let patternLabel;
  let stopLine;
  if (typeof bodyPct === 'number' && bodyPct > 0 && typeof gapPct === 'number' && gapPct > 0) {
    patternKey = 'ddeun';
    patternLabel = '양봉 뜬봉(상승 출발)';
    stopLine = base;
  } else if (typeof bodyPct === 'number' && bodyPct > 0) {
    patternKey = 'jungbong';
    patternLabel = '양봉 중봉(기준봉 종가 부근 출발)';
    stopLine = typeof low === 'number' ? low : base;
  } else if (price >= base * 0.97) {
    patternKey = 'eumbbong';
    patternLabel = '음봉 눌림(기준봉 종가 지지)';
    stopLine = base;
  } else {
    patternKey = 'breakdown';
    patternLabel = '음봉 이탈(−3% 이상)';
    stopLine = base;
  }
  // 1일차 고가가 확정되기 전에는 장중 고가로 4분할선을 잡는다(고가가 늘면 선도 같이 올라간다)
  const H = Math.max(typeof high === 'number' ? high : 0, base);
  const lines = [0.25, 0.5, 0.75, 1].map((r) => Math.round(base + (H - base) * r));
  const zoneIdx = price <= lines[0] ? 0 : price <= lines[1] ? 1 : price <= lines[2] ? 2 : 3;
  const zoneLabel = ['하단 1/4 매수존', '2/4 구간', '3/4 구간', '상단 1/4(추격 금지)'][zoneIdx];
  return {
    base,
    price,
    open,
    high,
    low,
    vsBasePct: Number(vsBasePct.toFixed(2)),
    gapPct: gapPct === null ? null : Number(gapPct.toFixed(2)),
    bodyPct: bodyPct === null ? null : Number(bodyPct.toFixed(2)),
    patternKey,
    patternLabel,
    stopLine,
    stopBreach: price < stopLine,
    split4: {
      high: H,
      lines,
      inBuyZone: price <= lines[0],
      zone: zoneLabel,
      quarter: `1일차 고가 ${H.toLocaleString('ko-KR')} · 기준봉 종가 ${base.toLocaleString('ko-KR')}`,
      touched: lines.map((v) => typeof low === 'number' && low <= v),
    },
  };
}

/** 홍인기 D+1·D+2 실시간 판정 — 기준선(전일 종가) 대비 위치 · 5단 타점 · −3% 손절선 */
function judgeHongCard(card, q) {
  const base = (card && card.plan && card.plan.base) || (card && card.close);
  if (!base || !q || q.price === null || q.price === undefined) return null;
  const price = q.price;
  const open = q.open;
  const low = q.low;
  const vsBasePct = (price / base - 1) * 100;
  const gapPct = open ? (open / base - 1) * 100 : null;
  let stateKey;
  let stateLabel;
  if (price >= base * 1.1) {
    stateKey = 'tp10';
    stateLabel = '+10% 익절권';
  } else if (price >= base * 1.05) {
    stateKey = 'tp5';
    stateLabel = '+5% 익절권';
  } else if (price >= base) {
    stateKey = 'above';
    stateLabel = '기준선 위';
  } else if (price > base * 0.97) {
    stateKey = 'dip';
    stateLabel = '눌림 매수 구간';
  } else {
    stateKey = 'stop';
    stateLabel = '−3% 손절선 이탈';
  }
  const touchedBase = typeof low === 'number' && low <= base;
  const ladder = [
    {
      step: '1차',
      label: '시초가 대응',
      price: open === null || open === undefined ? null : open,
      note:
        gapPct === null
          ? '시초가 미확인'
          : gapPct > 0.05
            ? `갭상 +${gapPct.toFixed(2)}%`
            : gapPct < -0.05
              ? `갭하 ${gapPct.toFixed(2)}%`
              : '보합 출발',
      hit: null,
    },
    {
      step: '2차',
      label: '전일 종가 눌림(기본 자리)',
      price: base,
      note: touchedBase ? '오늘 저가가 기준선 터치' : '아직 기준선 미터치',
      hit: touchedBase,
    },
    {
      step: '3차',
      label: '전일 종가 이하 매수',
      price: base,
      note: price < base ? '지금 기준선 아래에서 거래 중' : '기준선 위 — 3차 자리 아님',
      hit: price < base,
    },
    {
      step: '4~5차',
      label: '지지선 매수·매도 반복',
      price: card && card.m5 ? card.m5 : null,
      note:
        card && card.m20
          ? `5일선 ${Number(card.m5).toLocaleString('ko-KR')} · 20일선 ${Number(card.m20).toLocaleString('ko-KR')}`
          : '지지선 미제공',
      hit: card && card.m5 ? price <= card.m5 : null,
    },
  ];
  return {
    base,
    price,
    open,
    high: q.high,
    low,
    vsBasePct: Number(vsBasePct.toFixed(2)),
    gapPct: gapPct === null ? null : Number(gapPct.toFixed(2)),
    stateKey,
    stateLabel,
    stopLine: Number((base * 0.97).toFixed(0)),
    stopBreach: price < base * 0.97,
    tp5: Number((base * 1.05).toFixed(0)),
    tp10: Number((base * 1.1).toFixed(0)),
    ladder,
  };
}

/* ============================================================================
 * 📈 깡토 추세추종 · 💪 종가베팅 마스터 · 🎯 RN존 — 장중 실시간 판정
 * ----------------------------------------------------------------------------
 *  재스캔이 매일 장마감 확정치로 뽑아 둔 카드(stocks)의 기준선과 오늘 장중 현재가를
 *  그대로 대조한다. 값을 만들어 내지 않고, 시세가 없으면 missing 으로 남긴다.
 *   · 깡토   : 매수타점(전고점) · −8% 손절 · +24% 1차 익절 · 60일선
 *   · 종베   : 신정재(기준가 ±0.5% 진입 · +3%/+5% 익절 · −0.8% 손절)
 *              강창권(5일선 지지 매수 · +15% 목표 · 20일선 이탈 매도)
 *   · RN존   : 하단 RN / 매수 1·2차 / 상단 RN 사이에서 지금 어디인지(구간 위치 %)
 * ========================================================================== */

function numOrNull(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function round2(v) {
  return typeof v === 'number' && isFinite(v) ? Number(v.toFixed(2)) : null;
}

/** 장중 현재가 vs 기준일 종가 — 공통 필드 */
function stratQuoteFields(q, base) {
  const price = numOrNull(q && q.price);
  return {
    price,
    pct: numOrNull(q && q.changePct),
    open: numOrNull(q && q.open),
    high: numOrNull(q && q.high),
    low: numOrNull(q && q.low),
    prevClose: numOrNull(q && q.prevClose),
    vsBasePct: price && base ? round2((price / base - 1) * 100) : null,
    valueEok: numOrNull(q && q.value) !== null ? round2((q.value / 1e8)) : null,
    valueText: (q && (q.valueDispText || q.valueText)) || null,
    valueBasis: (q && q.valueBasis) || null,
    tradedAt: (q && q.tradedAt) || null,
  };
}

/** 깡토 — 전고점(매수타점) 돌파 유지/접근, 손절선·익절선 도달 여부 */
function judgeKkangtoCard(card, q) {
  const base = numOrNull(card && card.close);
  const f = stratQuoteFields(q, base);
  if (!f.price) return null;
  const pivot = numOrNull(card.basis);
  const stop = numOrNull(card.stop);
  const tp = numOrNull(card.tp);
  const ma60 = numOrNull(card.ma60);
  const hi60 = numOrNull(card.hi60);
  const toPivotPct = pivot ? round2((pivot / f.price - 1) * 100) : null;
  const stopBreach = stop !== null && f.price <= stop;
  const tpReached = tp !== null && f.price >= tp;
  const abovePivot = pivot !== null && f.price >= pivot;
  const aboveMa60 = ma60 !== null && f.price >= ma60;
  let stateKey;
  let stateLabel;
  if (stopBreach) {
    stateKey = 'stop';
    stateLabel = '−8% 손절선 이탈';
  } else if (tpReached) {
    stateKey = 'tp';
    stateLabel = '+24% 1차 익절 도달';
  } else if (abovePivot) {
    stateKey = 'break';
    stateLabel = '전고점 돌파 유지';
  } else if (toPivotPct !== null && toPivotPct <= 5) {
    stateKey = 'near';
    stateLabel = '전고점 5% 이내 접근';
  } else {
    stateKey = 'below';
    stateLabel = '전고점 아래';
  }
  return {
    ...f,
    section: (card && card.section) || null,
    base,
    pivot,
    hi60,
    toPivotPct,
    stop,
    tp,
    ma60,
    abovePivot,
    aboveMa60,
    stopBreach,
    tpReached,
    stateKey,
    stateLabel,
  };
}

/** 종가베팅 — 신정재·강창권 트랙별 익절·손절선 대비 오늘 위치 */
function judgeJongbeStock(stock, q) {
  /* 신정재 4대 패턴(2026-11-25 개편) — 트랙별 목표·손절선 대비 오늘 위치만 판정한다.
   *  p1·p2·p3 : 15:18~15:20 종가매수 → 익일 09:05 전 청산 (초단기)
   *  p4        : 5일선을 깬 자리 — 종베가 아니라 엔벨로프 중심선 스윙 타점
   *  값이 없는 카드는 null 을 그대로 남긴다(추정 금지). */
  const base = numOrNull(stock && (stock.basePrice || stock.price));
  const f = stratQuoteFields(q, base);
  if (!f.price) return null;
  const track = String((stock && stock.track) || '');
  const ma5 = numOrNull(stock && stock.ma5);
  const ma20 = numOrNull(stock && stock.ma20);
  const target1 = numOrNull(stock && stock.target1);
  const target2 = numOrNull(stock && stock.target2);
  const stopPrice = numOrNull(stock && stock.stopPrice);
  const stopBreach = stopPrice !== null && f.price <= stopPrice;
  const tp1 = target1 !== null && f.price >= target1;
  const tp2 = target2 !== null && f.price >= target2;
  let stateKey;
  let stateLabel;
  if (stopBreach) {
    stateKey = 'stop';
    stateLabel = track === 'p4' ? '20일선 이탈(스윙 손절)' : '손절선 이탈';
  } else if (tp2) {
    stateKey = 'tp2';
    stateLabel = track === 'p4' ? '엔벨로프 상한 도달' : '2차 목표 도달';
  } else if (tp1) {
    stateKey = 'tp1';
    stateLabel = '1차 목표 도달';
  } else if (f.vsBasePct !== null && Math.abs(f.vsBasePct) <= 0.5) {
    stateKey = 'entry';
    stateLabel = '진입존(기준가 ±0.5%)';
  } else {
    stateKey = f.vsBasePct !== null && f.vsBasePct > 0 ? 'above' : 'below';
    stateLabel = f.vsBasePct !== null && f.vsBasePct > 0 ? '기준가 위' : '기준가 아래';
  }
  return {
    ...f,
    track: track || null,
    patternLabel: (stock && stock.patternLabel) || null,
    tipScore: numOrNull(stock && stock.tipScore),
    tipTotal: numOrNull(stock && stock.tipTotal),
    base,
    ma5,
    ma20,
    target1,
    target2,
    stopPrice,
    stopBreach,
    tp1,
    tp2,
    stateKey,
    stateLabel,
  };
}

function judgeRnzoneStock(s, q) {
  const basis = numOrNull(s && s.price);
  const f = stratQuoteFields(q, basis);
  if (!f.price) return null;
  const lower = numOrNull(s.lowerRN);
  const upper = numOrNull(s.upperRN);
  const buy1 = numOrNull(s.buy1);
  const buy2 = numOrNull(s.buy2);
  const targetMin = numOrNull(s.targetMin);
  const targetMax = numOrNull(s.targetMax);
  const span = lower !== null && upper !== null && upper > lower ? upper - lower : null;
  const zonePct = span ? round2(((f.price - lower) / span) * 100) : null;
  const atLower = lower !== null && f.price <= lower;
  const atUpper = upper !== null && f.price >= upper;
  const nearLower = lower !== null && !atLower && f.price <= lower * 1.05;
  const inBuy1 = buy1 !== null && f.price <= buy1;
  const inBuy2 = buy2 !== null && f.price <= buy2;
  const atTarget = targetMax !== null && f.price >= targetMax;
  const toLowerPct = lower !== null ? round2((f.price / lower - 1) * 100) : null;
  const toUpperPct = upper !== null ? round2((upper / f.price - 1) * 100) : null;
  let stateKey;
  let stateLabel;
  if (atLower) {
    stateKey = 'lower';
    stateLabel = '하단 RN 도달(매수 1차)';
  } else if (nearLower) {
    stateKey = 'near_lower';
    stateLabel = '하단 RN 5% 이내';
  } else if (atTarget) {
    stateKey = 'target';
    stateLabel = '목표 상단 도달(익절)';
  } else if (atUpper) {
    stateKey = 'upper';
    stateLabel = '상단 RN 도달';
  } else {
    stateKey = 'between';
    stateLabel = '구간 중간';
  }
  return {
    ...f,
    category: (s && s.category) || null,
    basis,
    lowerRN: lower,
    upperRN: upper,
    buy1,
    buy2,
    targetMin,
    targetMax,
    zonePct,
    atLower,
    atUpper,
    nearLower,
    inBuy1,
    inBuy2,
    atTarget,
    toLowerPct,
    toUpperPct,
    stateKey,
    stateLabel,
  };
}

/** 카드·종목 배열 → 실시간 판정 묶음(공통) */
function packStrat(data, listKey, judgeFn) {
  const list = (data && data[listKey]) || [];
  const cards = list.map((c) => {
    const q = STRAT_QUOTE_MAP ? STRAT_QUOTE_MAP[c.code] || null : null;
    return {
      code: c.code,
      name: c.name,
      market: c.market || null,
      track: c.track || null,
      category: c.category || null,
      section: c.section || null,
      base: numOrNull(c.close) !== null ? c.close : c.price,
      missing: !q,
      live: q ? judgeFn(c, q) : null,
    };
  });
  return { cards, live: cards.filter((c) => c.live).length, total: cards.length };
}

/** 재스캔 JSON 의 기존 카드 코드(감시군 polling 에 함께 넣어 장중 시세를 받는다) */
function strategyCardCodes() {
  const out = [];
  const push = (c) => {
    if (c && /^[0-9A-Z]{6}$/.test(String(c)) && !out.includes(c)) out.push(c);
  };
  ((BIJ_DATA && BIJ_DATA.cards) || []).forEach((c) => push(c.code));
  ((HONG_DATA && HONG_DATA.cards) || []).forEach((c) => push(c.code));
  // 깡토 카드 · 종가베팅 픽 · RN존 목록도 같은 polling 에 넣어 장중 시세를 받는다(11/24)
  ((KKANGTO_DATA && KKANGTO_DATA.cards) || []).forEach((c) => push(c.code));
  ((JONGBE_DATA && JONGBE_DATA.stocks) || []).forEach((c) => push(c.code));
  ((RNZONE_DATA && RNZONE_DATA.stocks) || []).forEach((c) => push(c.code));
  return out;
}

const STRAT_CARD_CODES = strategyCardCodes();

/* packStrat 이 참조하는 '이번 호출의 시세 map' — buildStrategyLive 진입 때 채우고 끝나면 비운다 */
let STRAT_QUOTE_MAP = null;

/** ⚡ ① 전략 '유니버스' 계산 — KRX 등락률·거래대금 상위 → 후보 축소 → 통합 시세·일봉 판정.
 *  테마맵(knownMap) 없이 끝나므로 핸들러가 **요청 시작과 동시에** 띄워 둔다(2026-11-27 콜드 응답 단축).
 *  판정 규칙(judgeMover)·한도(STRAT_MAX_CANDLES)는 하나도 바꾸지 않는다. */
async function buildStrategyUniverse(ctx) {
  const tStrat = Date.now();
  const errors = [];
  /* ⚡ KRX 등락률·거래대금 상위는 핸들러가 미리 띄워 둔 Promise 로 받는다(없으면 여기서 조회) */
  const [upR, valR] = ctx && ctx.krxRank
    ? await ctx.krxRank
    : await Promise.allSettled([
        fetchKrxRank('up', KRX_PCT_TOP),
        fetchKrxRank('quantTop', KRX_VALUE_TOP),
      ]);
  prof('strategy.krxRank', tStrat);
  const byPct = upR.status === 'fulfilled' ? upR.value : [];
  const byVal = valR.status === 'fulfilled' ? valR.value : [];
  if (upR.status !== 'fulfilled') errors.push('등락률 상위: ' + String((upR.reason && upR.reason.message) || upR.reason));
  if (valR.status !== 'fulfilled') errors.push('거래대금 상위: ' + String((valR.reason && valR.reason.message) || valR.reason));

  const valueRank = {};
  byVal.forEach((it, i) => {
    valueRank[it.code] = i + 1;
  });

  const pool = [];
  const seen = new Set();
  byVal.concat(byPct).forEach((it) => {
    if (it && it.code && !seen.has(it.code)) {
      seen.add(it.code);
      pool.push(it);
    }
  });

  // 일봉 조회 전에 조건으로 후보를 줄인다(함수 시간 예산). 게이트보다 느슨하게 잡아 '아슬아슬한' 후보까지 실측한다.
  const PRE_MIN_VALUE = 30 * 1e8; // 후보로 올리는 최소 거래대금(정규장 기준) — 실제 판정은 통합 대금으로 다시 한다
  const cands = [];
  pool.forEach((it) => {
    const price = it.price;
    const open = it.open;
    const value = typeof it.value === 'number' ? it.value : 0;
    const bodyRate = open && price ? (price / open - 1) * 100 : null;
    const pct = it.changePct;
    const bijLike = typeof bodyRate === 'number' && bodyRate >= 8 && value >= PRE_MIN_VALUE;
    const hongLike = typeof pct === 'number' && pct >= 8 && value >= PRE_MIN_VALUE;
    if (bijLike || hongLike) cands.push({ q: it, bijLike, hongLike, bodyRate, pct });
  });
  cands.sort(
    (a, b) =>
      Math.max(b.pct || -99, b.bodyRate || -99) - Math.max(a.pct || -99, a.bodyRate || -99) ||
      (b.q.value || 0) - (a.q.value || 0),
  );
  const need = cands.slice(0, STRAT_MAX_CANDLES);

  // 후보는 개별 polling 으로 다시 받아 통합(KRX+NXT) 거래대금·시고저를 판정에 쓴다.
  //  (KRX 랭킹의 tradeAmount 는 정규장 단독이라 300억 문턱에서 과소 계상된다)
  let candQuotes = {};
  try {
    candQuotes = await pollQuotes(need.map((c) => c.q.code));
  } catch (e) {
    errors.push('후보 시세 polling: ' + String((e && e.message) || e));
  }

  const tBars = Date.now();
  const settledBars = await Promise.allSettled(need.map((c) => fetchDailyBars(c.q.code)));
  prof('strategy.dailyBars(' + need.length + ')', tBars);
  const bijFresh = [];
  const bijNear = [];
  const hongFresh = [];
  const hongNear = [];
  const d0Pool = [];        // ⚡ D+0 박스 후보 — 등락 +5%↑ 후보 전부(대금·순위·테마로 다시 거른다)
  let scanned = 0;
  need.forEach((c, i) => {
    const r = settledBars[i];
    if (r.status !== 'fulfilled') {
      errors.push(`일봉 ${c.q.name || c.q.code}: ` + String((r.reason && r.reason.message) || r.reason));
      return;
    }
    const pq = candQuotes[c.q.code] || null;
    const q = pq
      ? {
          ...c.q,
          price: pq.price !== null && pq.price !== undefined ? pq.price : c.q.price,
          changePct: typeof pq.changePct === 'number' ? pq.changePct : c.q.changePct,
          open: pq.open !== null && pq.open !== undefined ? pq.open : c.q.open,
          high: pq.high !== null && pq.high !== undefined ? pq.high : c.q.high,
          low: pq.low !== null && pq.low !== undefined ? pq.low : c.q.low,
          volume: pq.volume !== null && pq.volume !== undefined ? pq.volume : c.q.volume,
          value: typeof pq.value === 'number' ? pq.value : c.q.value,
          valueText: pq.valueText || c.q.valueText,
          valueDispText: pq.valueDispText || pq.valueText || c.q.valueText,
          valueNxtText: pq.valueNxtText || null,
          valueBasis: pq.valueBasis || c.q.valueBasis,
          prevClose:
            pq.price !== null && pq.change !== null && pq.price !== undefined && pq.change !== undefined
              ? pq.price - pq.change
              : c.q.prevClose,
          tradedAt: pq.tradedAt || c.q.tradedAt,
        }
      : c.q;
    const j = judgeMover(q, r.value, valueRank[c.q.code] || null);
    if (!j) return;
    scanned += 1;
    if (c.bijLike) {
      if (j.bij.isBase0) bijFresh.push(j);
      else if (j.bij.passCount >= 3) bijNear.push(j);
    }
    if (c.hongLike) {
      if (j.hong.isD0) hongFresh.push(j);
      else if (j.hong.checks.break120) hongNear.push(j);
    }
    if (typeof j.pct === 'number' && j.pct >= HONG_D0.pct) d0Pool.push(j);
  });
  bijFresh.sort((a, b) => (b.valueEok || 0) - (a.valueEok || 0));
  hongFresh.sort((a, b) => (b.pct || 0) - (a.pct || 0));
  prof('strategy.universe', tStrat);
  return {
    ok: byPct.length + byVal.length > 0,
    byPct, byVal, pool, need, valueRank,
    bijFresh, bijNear, hongFresh, hongNear, d0Pool, scanned,
    errors,
  };
}

/** 장중 실시간 전략 판정을 통으로 만든다.
 *  phase: sessionOf() 의 phase — '장마감'이면 현재가가 NXT 시간외 체결가라
 *  기준선(정규장 종가) 대비 손절/익절 '판정'을 켜면 안 된다(11/24 실측: 삼현 63,000 기준선 vs 60,300 시간외 → 전 카드 이탈로 오인).
 *  유니버스(후보·일봉 판정)는 ctx.universePromise 로 미리 계산된 것을 받는다.
 */
async function buildStrategyLive(map, phase, ctx) {
  const tStrat = Date.now();
  const U = ctx && ctx.universePromise ? await ctx.universePromise : await buildStrategyUniverse(ctx || {});
  const errors = U.errors;
  const { byPct, byVal, valueRank, bijFresh, bijNear, hongFresh, hongNear, d0Pool, scanned, need, pool } = U;
  const today = kstTodayYmd();
  const pack = (data, judgeFn, key) => {
    const basisDate = (data && data.basisDate) || null;
    const dayNo = basisDate ? tradingDaysAfter(basisDate, today) : null;
    const cards = ((data && data.cards) || []).map((c) => {
      const q = map[c.code] || null;
      const live = q ? judgeFn(c, q) : null;
      // D0·D1·D2 는 '기준일 대비로 몇 일째 기준봉인지'다 — 오늘이 그 기준봉의 D+며칠인지로 다시 계산한다.
      const anchorOffset = key === 'hong' ? (c.kind === 'D1' ? 1 : c.kind === 'D2' ? 2 : 0) : 0;
      const dayLabel =
        dayNo === null
          ? null
          : key === 'hong'
            ? 'D+' + (dayNo + anchorOffset)
            : dayNo === 0
              ? '0일차(기준봉 당일)'
              : `${dayNo}일차`;
      return {
        code: c.code,
        name: c.name,
        market: c.market || null,
        basisDate,
        base: key === 'bij' ? c.c : (c.plan && c.plan.base) || c.close,
        kind: c.kind || null,
        anchorDateOffset: anchorOffset,
        dayLabel,
        missing: !q,
        live,
      };
    });
    return {
      basisDate,
      basisLabel: (data && data.basisLabel) || null,
      dayNo,
      /* 기준일이 '전일'보다 더 과거일 때만 기준선이 실제 전일 종가와 어긋난다.
       *  dayNo 0 = 기준일이 오늘(정규장 마감 후 재스캔) · 1 = 어제(정상).
       *  예전엔 dayNo!==1 이라 0(오늘 마감 종가로 갱신된 정상 상태)까지 '재스캔 필요'로 경고했다(11/24). */
      basisStale: dayNo !== null && dayNo > 1,
      dayLabel:
        dayNo === null
          ? null
          : dayNo === 0
            ? key === 'bij'
              ? '0일차(기준봉 당일)'
              : 'D+0'
            : key === 'bij'
              ? `${dayNo}일차`
              : `D+${dayNo}`,
      cards,
    };
  };

  const bij = pack(BIJ_DATA, judgeBijDay1, 'bij');
  const hong = pack(HONG_DATA, judgeHongCard, 'hong');

  /* 깡토 · 종가베팅 · RN존 — 같은 기준일 파일 + 오늘 장중 시세 */
  STRAT_QUOTE_MAP = map;
  const dayNoOf = (d) => {
    const bd = (d && d.basisDate) || null;
    return bd ? tradingDaysAfter(bd, today) : null;
  };
  const stratSection = (data, listKey, judgeFn, labels) => {
    if (!data) return null;
    const dayNo = dayNoOf(data);
    const packed = packStrat(data, listKey, judgeFn);
    const states = {};
    packed.cards.forEach((c) => {
      if (c.live) states[c.live.stateKey] = (states[c.live.stateKey] || 0) + 1;
    });
    return {
      basisDate: data.basisDate || null,
      basisLabel: data.basisLabel || null,
      dayNo,
      dayLabel:
        dayNo === null ? null : dayNo === 0 ? labels.zero : labels.nth(dayNo),
      basisStale: dayNo !== null && dayNo > 1,
      live: packed.live,
      total: packed.total,
      states,
      cards: packed.cards,
    };
  };
  const kkangto = stratSection(KKANGTO_DATA, 'cards', judgeKkangtoCard, {
    zero: '0일차(기준봉 당일)',
    nth: (n) => `${n}일차`,
  });
  const jongbe = stratSection(JONGBE_DATA, 'stocks', judgeJongbeStock, {
    zero: 'D+0(기준일 당일)',
    nth: (n) => `D+${n}`,
  });
  /* 장 마감 뒤의 현재가는 NXT 시간외 체결가다 — 기준선(정규장 종가) 대비 손절/익절 판정을
     그대로 '확정'처럼 보여 주면 오해가 된다. 값은 그대로 두고 라벨에 '· 시간외'만 붙인다(11/25). */
  if (jongbe && phase === '장마감') {
    jongbe.afterHours = true;
    jongbe.cards.forEach((c) => {
      if (c.live && c.live.stateLabel) c.live.stateLabel = c.live.stateLabel + ' · 시간외';
    });
  }
  const rnzone = stratSection(RNZONE_DATA, 'stocks', judgeRnzoneStock, {
    zero: 'D+0(기준일 당일)',
    nth: (n) => `D+${n}`,
  });
  const tInt = Date.now();
  const intraday = await buildIntradayHong({
    pool: d0Pool,
    valueRank,
    memberRows: (ctx && ctx.memberRows) || [],
    indexGate: (ctx && ctx.indexGate) || null,
    supply: (ctx && ctx.supply) || null,
    phase,
    prevStrongThemes: (ctx && ctx.prevStrongThemes) || [],
  });
  prof('strategy.intradayHong', tInt);
  prof('strategy.total', tStrat);

  return {
    ok: byPct.length + byVal.length > 0,
    today,
    sessionPhase: phase || null,
    afterHours: phase === '장마감',
    universe: {
      pctTop: byPct.length,
      valueTop: byVal.length,
      pool: pool.length,
      candleChecks: need.length,
      judged: scanned,
    },
    thresholds: {
      bij: {
        bodyRate: BIJ_LIVE.bodyRate,
        valueEok: BIJ_LIVE.valueEok,
        breakDays: BIJ_LIVE.breakDays,
        upperMax: BIJ_LIVE.upperMax,
      },
      hong: { pct: HONG_LIVE.pct, breakDays: HONG_LIVE.breakDays, valueEok: HONG_LIVE.valueEok },
    },
    bij: { ...bij, fresh: bijFresh.slice(0, 6), near: bijNear.slice(0, 5) },
    hong: { ...hong, fresh: hongFresh.slice(0, 6), near: hongNear.slice(0, 5) },
    kkangto,
    jongbe,
    rnzone,
    intradayHong: intraday,
    errors,
  };
}
/* ============================================================================
 * 💸 5분 거래대금 버킷 — Supabase family_sync[stock_tv_5m_v1]
 * ----------------------------------------------------------------------------
 *  1번 탭 종목 타일의 `300억 (25/5/6)` 순증은 '최근 15분을 5분 간격 3구간'으로 본다.
 *    d1 = 최근 5분(현재 − 5분 전) · d2 = 5~10분 전 · d3 = 10~15분 전
 *  그 3구간을 계산하려면 5분 전·10분 전·15분 전의 대금이 어딘가 남아 있어야 하는데,
 *  브라우저 localStorage 에만 쌓으면 폰을 잠깐 열었을 때 기록이 비어 아무것도 안 보인다.
 *  → 5분 칸(epoch 분을 5로 내림)마다 종목별 누적 대금(억)을 이 행에 함께 쌓는다.
 *
 *  · 한 칸에는 **그 칸에서 처음 본 값**만 남긴다(덮어쓰지 않는다) — 칸 시작 시점의
 *    대금과 비교해야 '5분 구간'이 맞는다. 이미 있는 종목 값은 건드리지 않는다.
 *  · 장전·주말·야간 등 장외 시간에는 쓰지 않는다 — 굳은 값을 새 기록처럼 덮어쓰지 않는다.
 *  · 읽기·쓰기 실패는 조용히 넘어간다(화면은 클라이언트 기록만으로도 동작한다).
 * ========================================================================== */
const TV_SUPABASE = {
  url: process.env.SUPABASE_URL || 'https://hiruybkapzuhjrzjoyik.supabase.co',
  key: process.env.SUPABASE_ANON_KEY || 'sb_publishable_e5JJbvCPDhY91uXaUEVNVA_8Byv_gI8',
  table: 'family_sync',
  code: 'stock_tv_5m_v1',
};
const TV_BUCKET_MIN = 5;   // 5분 간격
const TV_BUCKET_MAX = 6;   // 최근 30분(5분 칸 6개)까지 보관
const TV_KEEP_MIN = 30;    // 이보다 오래된 칸은 버린다
const TV_TIMEOUT = 1000;        // Supabase 쓰기 한도(ms) — 응답 지연을 만들지 않는다
const TV_READ_TIMEOUT = 2500;   // 읽기 한도(ms) — 네이버 수집과 병렬이라 기다려도 응답이 느려지지 않는다

function tvBucketOfMinute(min) {
  return Math.floor(min / TV_BUCKET_MIN) * TV_BUCKET_MIN;
}

function tvKstDate(now) {
  const p = kstParts(now);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** KST 하루가 시작하는 epoch 분(오늘 00:00 KST) — 다른 날 버킷을 섞지 않는다. */
function tvDayStartMinute(now) {
  const p = kstParts(now);
  const t = Date.parse(`${p.y}-${pad2(p.m)}-${pad2(p.d)}T00:00:00+09:00`);
  return Number.isFinite(t) ? Math.floor(t / 60000) : Math.floor(now.getTime() / 60000) - 900;
}

/** epoch 분 → KST 'HH:MM'(툴팁·디버그용 표기) */
function tvHHMM(bucketMin) {
  const d = new Date((bucketMin + 540) * 60000); // UTC+9
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

function tvHeader() {
  return {
    apikey: TV_SUPABASE.key,
    Authorization: 'Bearer ' + TV_SUPABASE.key,
    Accept: 'application/json',
  };
}

/**
 * 공용 5분 버킷 행 읽기.
 *  · status='ok'      : 행이 있고 data 를 읽었다
 *  · status='missing' : 행이 없다(HTTP 200 + 빈 배열) → 새로 만들어도 된다
 *  · status='error'   : 읽지 못했다(타임아웃·HTTP 오류) → **덮어쓰면 안 된다**
 *    (읽기 실패를 '기록 없음'으로 오해하고 현재 칸 하나만 쓰면 지난 5분 칸이 사라진다)
 */
async function tvReadDocOnce() {
  const url =
    `${TV_SUPABASE.url}/rest/v1/${TV_SUPABASE.table}?code=eq.${encodeURIComponent(TV_SUPABASE.code)}` +
    '&select=code,data';
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TV_READ_TIMEOUT) : null;
  try {
    const r = await fetch(url, { headers: tvHeader(), cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    if (!r.ok) return { status: 'error', doc: null };
    const rows = await r.json();
    const doc = Array.isArray(rows) && rows[0] ? rows[0].data : null;
    if (!rows || !rows.length) return { status: 'missing', doc: null };
    return doc && typeof doc === 'object' ? { status: 'ok', doc } : { status: 'missing', doc: null };
  } catch (e) {
    return { status: 'error', doc: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* 읽기는 응답 조립 전(네이버 수집과 병렬)에 끝나므로 넉넉히 기다려도 화면이 느려지지 않는다.
 *  한 번 실패하면 150ms 뒤 한 번 더 — 일시적인 네트워크 끊김으로 이번 응답이 빈손이 되지 않게. */
async function tvReadDoc() {
  let r = await tvReadDocOnce();
  if (r.status === 'error') {
    await new Promise((resolve) => setTimeout(resolve, 150));
    r = await tvReadDocOnce();
  }
  return r;
}

/** 공용 5분 버킷 행 쓰기(코드 기준 upsert). 실패는 조용히 false. */
async function tvWriteDoc(doc) {
  const url = `${TV_SUPABASE.url}/rest/v1/${TV_SUPABASE.table}?on_conflict=code`;
  const headers = { ...tvHeader(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TV_TIMEOUT) : null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ code: TV_SUPABASE.code, data: doc, updated_at: new Date().toISOString() }]),
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined,
    });
    return r.ok;
  } catch (e) {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 오늘 것만, 최근 6칸만 — 남의 날·지난 칸이 섞여 들어오지 않게 다듬는다. */
function tvSanitizeBuckets(doc, dayStartMin, nowMin) {
  const list = Array.isArray(doc && doc.buckets) ? doc.buckets : [];
  const keep = [];
  list.forEach((b) => {
    if (!b || typeof b.t !== 'number' || !b.s || typeof b.s !== 'object') return;
    if (b.t < dayStartMin) return;
    if (b.t < nowMin - TV_KEEP_MIN) return;
    const s = {};
    Object.keys(b.s).forEach((c) => {
      if (typeof b.s[c] === 'number' && b.s[c] > 0) s[c] = b.s[c];
    });
    keep.push({ t: b.t, hhmm: b.hhmm || tvHHMM(b.t), s });
  });
  keep.sort((a, b) => a.t - b.t);
  return keep.slice(-TV_BUCKET_MAX);
}

/** 현재 5분 칸에 이번 값들을 '처음' 남긴다(이미 있는 종목은 그대로). */
function tvMergeSamples(buckets, bucketMin, samples) {
  let bucket = buckets.find((b) => b && b.t === bucketMin);
  if (!bucket) {
    bucket = { t: bucketMin, hhmm: tvHHMM(bucketMin), s: {} };
    buckets.push(bucket);
  }
  let added = 0;
  Object.keys(samples).forEach((code) => {
    if (typeof bucket.s[code] === 'number') return;
    bucket.s[code] = samples[code];
    added += 1;
  });
  return added;
}

/** 응답에 실을 5분 버킷 — 테마가 바뀌어도 새 종목이 바로 이어 쓸 수 있게 칸에 남은 종목을 모두 싣는다. */
function tvResponse(doc, nowBucket) {
  const buckets = [];
  ((doc && doc.buckets) || []).forEach((b) => {
    if (!b || typeof b.t !== 'number' || !b.s) return;
    const s = {};
    let n = 0;
    Object.keys(b.s).forEach((c) => {
      if (typeof b.s[c] !== 'number' || !(b.s[c] > 0)) return;
      s[c] = b.s[c];
      n += 1;
    });
    if (n) buckets.push({ t: b.t, hhmm: b.hhmm || tvHHMM(b.t), s });
  });
  return { v: 1, date: (doc && doc.date) || null, now: nowBucket, buckets };
}

/**
 * 이번 응답의 5분 버킷을 읽어 (장중이면) 현재 칸을 기록하고, 화면에 실을 버킷을 돌려준다.
 *  · marketLive: 정규장·프리마켓·애프터마켓 안에서만 기록한다(장외에는 기존 기록 그대로).
 */
async function tvSyncBuckets({ themes, session, overSession, now, docPromise }) {
  const tTv = Date.now();
  const nowMin = Math.floor(now.getTime() / 60000);
  const nowBucket = tvBucketOfMinute(nowMin);
  const marketLive = session.phase === '정규장' || (overSession && overSession.inSession);
  /* 읽기는 핸들러가 네이버 수집과 동시에 먼저 시작해 둔다(응답 지연을 만들지 않게). */
  const read = (await (docPromise || tvReadDoc())) || { status: 'error', doc: null };
  const buckets = tvSanitizeBuckets(read.doc, tvDayStartMinute(now), nowMin);

  /* 읽기 실패면 기존 행을 덮어쓰지 않는다 — 지난 5분 칸을 잃는 것보다 이번 칸을 못 남기는 편이 낫다. */
  if (!marketLive || read.status === 'error') {
    return tvResponse({ date: tvKstDate(now), buckets }, nowBucket);
  }

  const samples = {};
  (themes || []).forEach((t) =>
    (t && t.stocks ? t.stocks : []).forEach((s) => {
      if (!s || !s.code || typeof s.value !== 'number' || !(s.value > 0)) return;
      samples[s.code] = Math.round((s.value / 1e8) * 10) / 10;
    }),
  );
  if (!Object.keys(samples).length) {
    return tvResponse({ date: tvKstDate(now), buckets }, nowBucket);
  }

  const added = tvMergeSamples(buckets, nowBucket, samples);
  if (!added) {
    return tvResponse({ date: tvKstDate(now), buckets }, nowBucket);
  }
  buckets.sort((a, b) => a.t - b.t);
  const next = {
    v: 1,
    date: tvKstDate(now),
    buckets: buckets.slice(-TV_BUCKET_MAX),
    updatedAt: now.toISOString(),
    src: 'tabs-live',
  };
  await tvWriteDoc(next);
  prof('tv.write', tTv);
  return tvResponse(next, nowBucket);
}

/* ============================================================================
 * 🌙 종가베팅 2트랙 계산기
 * ========================================================================== */

/** 확정 수급 폴백 — public/data/supply-latest.json (재스캔이 매일 갱신).
 *  supply_live 모드 핸들러 안의 같은 취지 함수와 데이터 규칙은 같지만, 이미 검증·배포된
 *  모드 응답을 건드리지 않으려고 별도로 둔다(코드로 병합 → (외+기) 합산 순).
 */
function cpConfirmedSupplyRows(n) {
  let d = null;
  try {
    d = require('../public/data/supply-latest.json');
  } catch (e) {
    return null;
  }
  const groups = (d && d.groups) || {};
  const m = new Map();
  ['foreignBuy', 'organBuy', 'dualBuy'].forEach((gk) => {
    (groups[gk] || []).forEach((x) => {
      if (!x || !x.code) return;
      const cur = m.get(x.code) || {
        code: x.code, name: x.name, price: x.price, changePct: x.pct,
        foreignEok: null, organEok: null,
      };
      if (x.foreignEok != null) cur.foreignEok = x.foreignEok;
      if (x.organEok != null) cur.organEok = x.organEok;
      if (cur.name == null) cur.name = x.name;
      if (cur.price == null) cur.price = x.price;
      if (cur.changePct == null) cur.changePct = x.pct;
      m.set(x.code, cur);
    });
  });
  const rows = [...m.values()]
    .map((x) => ({ ...x, totalEok: Math.round(((x.foreignEok || 0) + (x.organEok || 0)) * 10) / 10 }))
    .sort((a, b) => b.totalEok - a.totalEok);
  if (!rows.length) return null;
  const bd = String(d.basisDate || '');
  const md = bd.length === 8 ? Number(bd.slice(4, 6)) + '/' + Number(bd.slice(6, 8)) : '';
  return {
    rows: rows.slice(0, n),
    basisDate: bd,
    asOfLabel: md ? '확정 ' + md + ' 기준' : '확정 ' + String(d.basisLabel || '').trim() + ' 기준',
  };
}

/** KIS 장중 외인·기관 가집계 — 종가베팅 수급 트랙용. 60초 캐시(초당 20건 제한 보호).
 *  · 장전·주말·KIS 미설정·오류·0건이면 supply-latest.json 확정치로 폴백하고 confirmed=true.
 *  · 가집계를 확정치처럼, 확정치를 가집계처럼 적지 않는다(asOfLabel 로 구분). */
async function fetchClosingSupplyRank(limit) {
  const tSup = Date.now();
  const hit = supplyCache.get(CP_SUPPLY_CACHE_KEY);
  if (hit && Date.now() - hit.at < (hit.ttl || SUPPLY_TTL_MS)) return hit.value;

  const p0 = kstParts(new Date());
  const out = {
    ok: false, confirmed: false, source: 'kis', rows: [], asOfLabel: '',
    basisDate: null, errors: [], fallbackReason: null, sides: {},
  };
  const put = (v, ttl) => { supplyCache.set(CP_SUPPLY_CACHE_KEY, { at: Date.now(), ttl, value: v }); return v; };
  const toEok = (raw) => (raw == null ? null : Math.round((raw / 100) * 10) / 10);
  const round1 = (x) => Math.round(x * 10) / 10;
  const fallback = (why) => {
    const fb = cpConfirmedSupplyRows(limit);
    out.source = 'confirmed';
    out.confirmed = true;
    out.fallbackReason = why;
    if (!fb) {
      out.ok = false;
      out.asOfLabel = '확정 수급 없음';
      out.rows = [];
      return out;
    }
    out.ok = true;
    out.rows = fb.rows;
    out.asOfLabel = fb.asOfLabel;
    out.basisDate = fb.basisDate;
    return out;
  };

  if (p0.wd === 'Sat' || p0.wd === 'Sun') return put(fallback('weekend_use_confirmed'));
  if (p0.minutes < 9 * 60) return put(fallback('preopen_use_confirmed'));
  if (!kisLib || !kisLib.isConfigured || !kisLib.isConfigured()) return put(fallback('kis_not_configured'));

  /* 장중(09:00~15:30)에는 KIS 가집계가 비면 전일 확정치로 대체하지 않는다 —
   * '오늘 종가베팅' 후보에 어제 수급을 앉히면 사실과 다른 카드가 된다(사용자 철칙: 임의 대체 금지).
   * 마감 후·장전·휴장에는 브리프대로 supply-latest.json 확정치 폴백을 쓴다. */
  const inSession = p0.minutes >= 9 * 60 && p0.minutes < AFTER_START;
  const onFail = (why) => {
    if (!inSession) return put(fallback(why));
    out.ok = false;
    out.confirmed = false;
    out.source = 'kis';
    out.fallbackReason = why + '_live_no_confirmed';
    out.rows = [];
    out.asOfLabel = '';
    return put(out);
  };

  /* 외국인·기관계 각각 **순매수 상위와 순매도 상위를 모두** 받는다(4회) —
   *  한쪽 매수 상위에만 잡힌 종목의 반대쪽(매도) 금액을 다른 목록에서 교차 조회해 채우기 위해서다.
   *  (예: 기관 +1,184억 매수지만 외국인은 순매도 상위 → 외국인 매도액을 그대로 적는다. 임의 0 금지) */
  const LIST_CALLS = [
    { key: 'foreignBuy', side: 'foreign', sortCode: '0' },
    { key: 'foreignSell', side: 'foreign', sortCode: '1' },
    { key: 'organBuy', side: 'organ', sortCode: '0' },
    { key: 'organSell', side: 'organ', sortCode: '1' },
  ];
  const settled = await Promise.allSettled(
    LIST_CALLS.map((c) =>
      /* 초당 제한(EGW00201)은 다른 화면·스케줄 호출과 겹칠 때 난다 — lib 이 한 번 더 시도한 뒤에도
       * 막히면 0.6초 쉬었다 한 번 더 시도한다(한쪽 매도 목록이 비면 카드가 '미확인'으로 남기 때문). */
      (async () => {
        const call = () =>
          kisLib.fetchForeignInstitutionTotal({
            etcClsCode: c.side === 'foreign' ? '1' : '2',
            divCode: '1',
            sortCode: c.sortCode,
          });
        try {
          return await call();
        } catch (e) {
          if (e && (e.code === 'KIS_RATE_LIMIT' || String(e.msgCd || '') === 'EGW00201')) {
            await new Promise((r) => setTimeout(r, 600));
            return await call();
          }
          throw e;
        }
      })(),
    ),
  );
  const got = {};
  const sideCounts = {};
  settled.forEach((s, i) => {
    const c = LIST_CALLS[i];
    if (s.status === 'fulfilled') {
      got[c.key] = s.value;
      sideCounts[c.key] = (s.value.rows || []).length;
      return;
    }
    got[c.key] = null;
    sideCounts[c.key] = 0;
    out.errors.push(
      (c.key === 'foreignBuy' ? '외국인 순매수' : c.key === 'foreignSell' ? '외국인 순매도' : c.key === 'organBuy' ? '기관 순매수' : '기관 순매도') +
        ': ' + String((s.reason && s.reason.message) || s.reason),
    );
  });

  const merged = new Map();
  const mergeRows = (r, side, negate) => {
    if (!r || !r.rows || !r.rows.length) return;
    r.rows.forEach((x) => {
      if (!x || !x.code) return;
      const cur = merged.get(x.code) || {
        code: x.code, name: x.name, price: x.price, changePct: x.changePct,
        foreignEok: null, organEok: null,
      };
      let eok = toEok(x.netValueRaw);
      /* 순매도 상위 목록은 매도액이므로 부호를 음수로 맞춘다(응답이 이미 음수면 그대로). */
      if (eok !== null && negate && eok > 0) eok = -eok;
      if (side === 'foreign') {
        /* 같은 쪽 값이 이미 있으면 순매수 목록 값을 우선한다(한 종목은 둘 중 한 목록에만 잡힌다) */
        if (cur.foreignEok === null) cur.foreignEok = eok;
      } else if (cur.organEok === null) cur.organEok = eok;
      if (cur.name == null) cur.name = x.name;
      if (cur.price == null) cur.price = x.price;
      if (cur.changePct == null) cur.changePct = x.changePct;
      merged.set(x.code, cur);
    });
  };
  mergeRows(got.foreignBuy, 'foreign', false);
  mergeRows(got.foreignSell, 'foreign', true);
  mergeRows(got.organBuy, 'organ', false);
  mergeRows(got.organSell, 'organ', true);

  const rows = [...merged.values()]
    .map((x) => ({ ...x, totalEok: round1((x.foreignEok || 0) + (x.organEok || 0)) }))
    .sort((a, b) => b.totalEok - a.totalEok);
  /* 진단용(?cp_debug=1)으로만 응답에 실린다 — 양쪽 값이 어떻게 채워졌는지 확인할 때 쓴다. */
  out._all = rows;

  const anyNonZero = rows.some((x) => (x.foreignEok || 0) !== 0 || (x.organEok || 0) !== 0);
  const bothOk = !!(got.foreignBuy && got.foreignBuy.ok && got.organBuy && got.organBuy.ok);
  if (!bothOk || !rows.length || !anyNonZero) {
    return onFail(!bothOk ? 'kis_api_error' : 'kis_empty_or_zero');
  }

  out.ok = true;
  out.confirmed = false;
  out.rows = rows;
  out.sides = sideCounts;
  /* 15:30 이 지나면 KIS 가집계는 그 시점 값으로 멈춘다 → 요청 시각이 아니라 마감 시각으로 적는다 */
  out.asOfLabel = p0.minutes >= AFTER_START
    ? '15:30 마감 기준'
    : '실시간 ' + pad2(p0.hh) + ':' + pad2(p0.mi) + ' 기준';
  /* 한쪽(특히 반대쪽 매도) 목록을 못 받았으면 60초씩 캐시해 두지 않는다 — 15초 뒤 다시 시도해
   *  다음 폴링에서 매도 금액을 채운다(실패를 1분간 '미확인'으로 고정하지 않기 위해서). */
  const complete = LIST_CALLS.every((c) => got[c.key] && got[c.key].ok);
  prof('cp.supplyRank', tSup);
  return put(out, complete ? undefined : 15000);
}

/** 상위 주도 테마(최대 CP_POOL_THEMES개)의 **전체 구성종목** — 종가베팅 테마 후보 풀(5분 캐시).
 *  · 1번 탭 테마맵과 같은 랭킹 규칙(등락률 ↓ → 상승종목 비율 ↓ → 구성종목 수 ↓)으로 상위 테마를 고르고,
 *    테마 상세(구성종목 최대 100)를 통째로 받는다 — 카드에 그리는 4종목만 보면 5번째 이하 대장주
 *    (11/24 유진로봇 +20.38% · 375억)이 후보에서 빠졌다.
 *  · 값은 네이버가 준 그대로만 쓴다. 실패한 테마는 빼고 errors 에 남긴다(추정 금지).
 *  · 랭킹·상세는 5분 캐시 — 30초 폴링마다 네이버를 10번씩 때리지 않는다.
 */
async function fetchClosingThemeMembers() {
  const tMem = Date.now();
  const hit = supplyCache.get(CP_POOL_CACHE_KEY);
  if (hit && Date.now() - hit.at < CP_POOL_TTL_MS) return hit.value;

  const out = {
    ok: false, rows: [], themeCount: 0, errors: [], fetchedAt: new Date().toISOString(),
  };
  const put = (v) => { supplyCache.set(CP_POOL_CACHE_KEY, { at: Date.now(), value: v }); return v; };

  let groups = [];
  try {
    const data = await themeSharedFetch('rank:' + String(THEME_RANK_PAGE), () =>
      fetchJson(THEME_RANK_URL + '?page=1&pageSize=' + String(THEME_RANK_PAGE), {
        headers: NAVER_HEADERS,
        timeout: THEME_TIMEOUT,
      }),
    );
    groups = (data && data.groups) || [];
    if (!groups.length) throw new Error('테마 랭킹 목록이 비었습니다');
  } catch (e) {
    out.errors.push('테마 풀 랭킹: ' + String((e && e.message) || e));
    return put(out);
  }

  const ranks = groups
    .map((g) => {
      const total = parseNum(g.totalCount) || 0;
      const rise = parseNum(g.riseCount) || 0;
      return {
        no: parseNum(g.no),
        name: String(g.name || '').replace(/\s+/g, ' ').trim(),
        changeRate: parseNum(g.changeRate),
        totalCount: total,
        riseRatio: total ? (rise / total) * 100 : 0,
      };
    })
    .filter((g) => g.no && g.name && !THEME_EXCLUDE_RE.test(g.name))
    .filter((g) => typeof g.changeRate === 'number' && g.totalCount >= 3)
    .sort((a, b) => b.changeRate - a.changeRate || b.riseRatio - a.riseRatio || b.totalCount - a.totalCount)
    .slice(0, CP_POOL_THEMES);

  const settled = await Promise.allSettled(ranks.map((g) => fetchThemeStocks(g.no)));
  prof('cp.members.details(' + ranks.length + ')', tMem);
  ranks.forEach((g, i) => {
    const r = settled[i];
    if (r.status !== 'fulfilled' || !r.value.length) {
      out.errors.push('테마 풀 ' + g.name + ': ' + String((r.reason && r.reason.message) || '구성종목 없음'));
      return;
    }
    out.themeCount += 1;
    r.value.forEach((s) => {
      out.rows.push({
        code: s.code,
        name: s.name,
        price: s.price,
        changePct: s.changePct,
        value: s.value,
        upperLimit: Boolean(s.upperLimit),
        valueBasis: s.valueBasis || null,
        themeName: g.name,
        themeRank: i + 1,
      });
    });
  });
  out.ok = out.rows.length > 0;
  prof('cp.themeMembers', tMem);
  return put(out);
}

/** 🔥 테마주도주 후보 풀 — 이 응답에서 이미 받아 둔 테마·유니버스 종목 + 상위 주도 테마 전체 구성종목.
 *  같은 종목이 여러 테마에 있으면 **더 강한 테마(랭킹 작은 쪽)** 를 남기고, 거래대금은 큰 값을 쓴다. */
function cpThemePool({ themes, knownMap, nxt, high52: h52, upperLimit: up, members }) {
  const pool = new Map();
  const push = (code, name, themeName, themeRank, base) => {
    const c = String(code || '');
    if (!c) return;
    const q = knownMap[c] || {};
    const b = base || {};
    const rec = {
      code: c,
      name: q.name || name || b.name || null,
      themeName: themeName || null,
      themeRank: themeRank || null,
      price: numOrNull(q.price) !== null ? numOrNull(q.price) : numOrNull(b.price),
      changePct: numOrNull(q.changePct) !== null ? numOrNull(q.changePct) : numOrNull(b.changePct),
      high: numOrNull(q.high) !== null ? numOrNull(q.high) : numOrNull(b.high),
      value: numOrNull(q.value) !== null ? numOrNull(q.value) : numOrNull(b.value),
      upperLimit: Boolean(q.upperLimit || b.upperLimit),
      valueBasis: q.valueBasis || b.valueBasis || null,
    };
    const prev = pool.get(c);
    if (!prev) {
      pool.set(c, rec);
      return;
    }
    /* 테마 이름·순위는 더 강한(작은 순위) 테마로 바꾸되, 테마가 없던 자리(신고가·상한가)는 채워만 준다 */
    if (rec.themeName && (prev.themeRank === null || (rec.themeRank !== null && rec.themeRank < prev.themeRank))) {
      prev.themeName = rec.themeName;
      prev.themeRank = rec.themeRank;
    }
    if ((rec.value || 0) > (prev.value || 0)) {
      prev.value = rec.value;
      if (rec.price !== null) prev.price = rec.price;
      if (rec.changePct !== null) prev.changePct = rec.changePct;
      if (rec.high !== null) prev.high = rec.high;
      if (rec.valueBasis) prev.valueBasis = rec.valueBasis;
    }
    if (rec.upperLimit) prev.upperLimit = true;
    if (prev.name === null && rec.name) prev.name = rec.name;
  };

  (themes || []).forEach((t) => {
    (t.stocks || []).forEach((s) => push(s.code, s.name, t.name, t.rank, s));
  });
  /* 확장 풀 — 상위 주도 테마 10개의 전체 구성종목(카드 노출 4종목 밖 포함) */
  (members || []).forEach((m) => push(m.code, m.name, m.themeName, m.themeRank, m));
  const h = h52 || {};
  [].concat(h.byPct || [], h.byValue || []).forEach((x) => push(x.code, x.name, '52주 신고가', null, x));
  const u = up || {};
  [].concat(u.confirmed || [], u.near || [], u.watch || []).forEach((x) => push(x.code, x.name, '상한가·임박', null, x));
  const nx = nxt && nxt.ok ? nxt : {};
  [].concat(nx.byPct || [], nx.byValue || []).forEach((x) => push(x.code, x.name, 'NXT 상승률 상위', null, x));
  return pool;
}

/* ============================================================================
 * 📘 침착해 종가베팅 (프로그램 수급 · 오후장 방어) — 2026-11-24 신설
 * ----------------------------------------------------------------------------
 *  「🌙 오늘 종가베팅 공략 후보」 박스의 3번째 탭(🔥 테마 · 💰 수급 · 📘 침착해). 사용자 확정(11/24).
 *
 *  근거: 침착해 「실전매매일지」 4·5·6강(2024-01-30~05-02, 60일 471p) 정밀 분석
 *   → 1순위 신호는 외인·기관이 아니라 **프로그램 수급**이다(프로그램 관련 문장 365개).
 *     판독 5축: ① 방향 ② 지속성(종일/오후 전환) ③ 규모(주식 수, 아침·전일 대비)
 *                ④ 가격과의 관계(밀릴 때 받아주는가) ⑤ 외인·기관과 같은 방향인가
 *   → 진입은 13시 이후~종가, 청산은 '당일 고점 부근 프로그램 매도 전환',
 *     손절은 '프로그램 매도세로 당일 저점 이탈'.
 *
 *  ⚠️ 원전에는 '거래대금 500억↑' 같은 수치 임계값이 없다. 여기서 쓰는 수치(소폭 순매도
 *     20% 이내 등)는 **관제탑 자체 기준**이며 카드·응답에 그 사실을 함께 적는다(원전 왜곡 금지).
 *
 *  · 프로그램 값은 KIS 종목별 프로그램매매추이(0465 · FHPPG04650100) 실시간 — 60초 캐시.
 *  · 후보는 상위 14종목(수급 트랙 통과분 + 테마 트랙 상위)만 조회한다(초당 20건 제한 보호).
 *  · 응답이 비면 추정치를 만들지 않고 programStatus '미수신'으로 내린다.
 * ========================================================================== */
const CP_CHIM_MAX_ROWS = 6;
/* 후보 조회 상한 — 종목별 0465 호출은 비싸다(초당 20건 제한·왕복 수백ms).
 *  탭 응답 예산(클라이언트 14초)을 지키려면 8종목·경보 3종목으로 충분하다.
 *  (11/24 실측: 14종목+경보 8건이면 콜드에서 14초를 넘겨 '응답 시간 초과'가 났다) */
const CP_CHIM_POOL_MAX = 8;
const CP_CHIM_WARN_MAX = 3;
const CP_CHIM_DEADLINE_MS = 6000;
const CP_CHIM_CACHE_TTL_MS = 60000;
const CP_CHIM_SMALL_SELL_RATIO = 0.2; // 프로그램 순매도가 (외+기) 순매수의 20% 이내면 '소폭'(관제탑 자체 기준)
const CP_CHIM_HINT = '13시 이후 프로그램 방어 확인 후 분할 · 매도 전환 시 청산 · 저점 이탈 즉시 손절';
const CP_CHIM_INDEX_TTL_MS = 60000;
const cpIndexCache = new Map();
const cpChimCache = new Map(); // { at, value } — 60초 결과 캐시(같은 분의 반복 호출이 KIS를 다시 때리지 않게)
/* 2026-11-25 — 침착해 종가베팅 3대 업그레이드(사용자 승인)
 *  ① 3단 시간대 분할 비중(3강 Ch.2) · ② 시장 판별 배너(3강 Ch.1) · ③ 예고·DART 악재 경고 */
const CP_CHIM_SPLIT = '14:30 부근 30% → 14:40~15:00 40~50% → 15:00~마감 20~30%';
const CP_CHIM_FLOW_TTL_MS = 60000;
const cpChimFlowCache = new Map();
const CP_CHIM_DART_TTL_MS = 5 * 60 * 1000;
let cpChimDartCache = { at: 0, value: null };
const CP_CHIM_WARN_SOURCE =
  '지정·단기과열 = KIS 시세 실시간(FHKST01010100) · 경고 예고·관리종목·거래정지 = KIS 종목마스터 일 스냅샷(data/krx-warn-latest.json) · DART 악재 = 오픈DART 공시(최근 3일)';
/* DART 호재 공시(재료) 키워드 — 수주·잠정실적·자사주처럼 종베 재료가 되는 유형만 담는다.
 *  ('실적' 단독은 사업보고서류와 섞이므로 '잠정'만 인정한다) */
const CP_CHIM_DART_GOOD = [
  { kw: '단일판매', label: '수주·공급계약' },
  { kw: '공급계약', label: '수주·공급계약' },
  { kw: '수주', label: '수주' },
  { kw: '잠정', label: '잠정실적' },
  { kw: '자기주식취득', label: '자사주 취득' },
  { kw: '무상증자', label: '무상증자' },
  { kw: '주식분할', label: '액면분할' },
  { kw: '특허권취득', label: '특허 취득' },
  { kw: '기술이전', label: '기술이전' },
  { kw: '타법인주식', label: '타법인 지분 취득' },
];

/* DART 악재(희석·악재) 키워드 — 공시명 기준. 원전(침착해)이 정리 대상으로 적은 유형만 담는다. */
const CP_CHIM_DART_RISK = [
  { kw: '유상증자', label: '유상증자(지분 희석)' },
  { kw: '전환사채', label: '전환사채(CB)' },
  { kw: '신주인수권부사채', label: '신주인수권부사채(BW)' },
  { kw: '감자', label: '감자' },
  { kw: '횡령', label: '횡령·배임' },
  { kw: '배임', label: '횡령·배임' },
  { kw: '채무불이행', label: '채무불이행' },
  { kw: '불성실공시', label: '불성실공시' },
  { kw: '소송', label: '소송' },
  { kw: '블록딜', label: '블록딜' },
  { kw: '대량보유', label: '대량보유(블록딜 영향)' },
  { kw: '주식병합', label: '주식병합' },
];

/* 0465 응답은 최근 30행만 준다 → 추세 라벨도 '오후(13시)' 또는 '최근 N분' 창을 그대로 적는다. */
function chimHourText(h) {
  /* HHMMSS('181227' = 18:12:27) → '18:12' */
  const s = String(h === null || h === undefined ? '' : h).replace(/\D/g, '');
  if (s.length < 3) return null;
  const hh = Number(s.length >= 5 ? s.slice(0, s.length - 4) : s.slice(0, s.length - 2));
  const mm = Number(s.length >= 5 ? s.slice(s.length - 4, s.length - 2) : s.slice(-2));
  if (!isFinite(hh) || !isFinite(mm)) return null;
  return pad2(hh) + ':' + pad2(mm);
}

function chimTrendLabel(trend) {
  if (!trend || !trend.kind || trend.kind === 'unknown') return '추세 미확인';
  const span = trend.baseLabel || '';
  const when = span.indexOf('오후') === 0 ? '오후 ' : span ? span + ' ' : '';
  if (trend.kind === 'up') return when + '순매수 증가';
  if (trend.kind === 'flat') return '순매수 유지(증가 둔화)';
  if (trend.kind === 'flip') {
    return trend.baseLabel === '오후(13시)' ? '오전 매도 → 오후 순매수 전환' : when + '순매수 전환';
  }
  if (trend.kind === 'down') return '순매도 지속';
  return '추세 미확인';
}

const CP_CHIM_RULES = {
  material:
    '재료(주도 테마 구성종목 또는 당일 특징·수주·실적·지분 뉴스·호재 공시)가 확인된 종목만 후보 — 재료 미확인 종목은 수급이 좋아도 넣지 않는다(기준 임의 완화 금지)',
  select:
    '재료 확인 종목 안에서 프로그램 순매수(당일 누적 · KIS 0465) 최우선 · 프로그램이 소폭 순매도여도 외인·기관 양매수면 방어 종목으로 포함(뱃지) · ETF·ETN·스팩·우선주 제외',
  sort: '재료 확인 → 프로그램 순매수 ↓ · 오후(13시 이후) 순증 → 추세 → 외인+기관 합산 ↓',
  entry: '13시 이후 지수 대비 눌림에서 프로그램 방어 확인 후 분할매수 · 돌파·불타기는 당일 고점 돌파 확인 후에만(눌림과 돌파를 같은 비중으로 넣지 않는다)',
  split: '3단 분할 — ' + CP_CHIM_SPLIT + ' (14:30 전에는 관찰, 비중 0%)',
  exit: '당일 고점 부근 프로그램 매도 전환 시 분할 청산 · 시간외 3~5% 상승 시 분할 익절',
  stop: '프로그램 매도세로 당일 저점 이탈 시 즉시 손절 · 블록딜·유증·자사주 처분 등 악재 공시 시 즉시 정리',
  caveat:
    '침착해 원전에는 거래대금·억원 임계값이 없다 — 수치 기준(소폭 순매도 20% 등)은 관제탑 자체 기준이고, 판정은 프로그램 방향·지속성·가격과의 관계로 한다.',
};

/** 코스피·코스닥 지수 등락 — 시장 게이트용(60초 캐시, 네이버 폴링) */
async function fetchIndexGate() {
  const key = 'index:gate';
  const hit = cpIndexCache.get(key);
  if (hit && Date.now() - hit.at < CP_CHIM_INDEX_TTL_MS) return hit.value;
  const value = { ok: false, kospiPct: null, kosdaqPct: null, asOf: null, note: '' };
  try {
    const url =
      'https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ?_=' + Date.now();
    const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: NAVER_TIMEOUT });
    const rows = (data && data.datas) || [];
    rows.forEach((d) => {
      const rawPct = String(
        d.fluctuationsRatio === undefined || d.fluctuationsRatio === null ? '' : d.fluctuationsRatio,
      )
        .replace(/[%,\s]/g, '');
      const parsed = rawPct === '' ? NaN : Number(rawPct);
      const pct = isFinite(parsed) ? parsed : null;
      if (d.itemCode === 'KOSPI' || d.symbolCode === 'KOSPI') value.kospiPct = pct;
      if (d.itemCode === 'KOSDAQ' || d.symbolCode === 'KOSDAQ') value.kosdaqPct = pct;
      if (d.localTradedAt) value.asOf = d.localTradedAt;
    });
    value.ok = value.kospiPct !== null || value.kosdaqPct !== null;
    if (!value.ok) value.note = '지수 응답에 등락률이 없습니다.';
  } catch (e) {
    value.note = '지수 조회 실패: ' + String((e && e.message) || e);
  }
  cpIndexCache.set(key, { at: Date.now(), value });
  return value;
}

/** 지수 방향 → 시장 게이트. 외인 선물은 공개 실시간 소스가 없어 미수신으로 남긴다. */
function chimMarketGate(idx) {
  const k = numOrNull(idx && idx.kospiPct);
  const q = numOrNull(idx && idx.kosdaqPct);
  const vals = [k, q].filter((v) => v !== null);
  const min = vals.length ? Math.min.apply(null, vals) : null;
  let advice = 'normal';
  let label = '정상';
  let reason = '지수 방향 양호 — 기본 비중으로 진행 가능';
  if (min !== null && min <= -3) {
    advice = 'hedge';
    label = '비중 축소 권고';
    reason = '지수 급락 — 종베 자리 아님(헷지·관망 검토)';
  } else if (min !== null && min <= -1) {
    advice = 'reduce';
    label = '비중 축소 권고';
    reason = '지수 약세 — 비중 축소·1~2종목';
  } else if (min === null) {
    label = '지수 미수신';
    reason = '지수 응답이 없어 시장 게이트를 판정하지 못했습니다.';
  }
  return {
    ok: Boolean(idx && idx.ok),
    kospiPct: k,
    kosdaqPct: q,
    advice,
    label,
    reason,
    asOf: (idx && idx.asOf) || null,
    foreignFut: null,
    foreignFutNote: '외인 선물 실시간 수급은 공개 API가 없어 미수신 — 지수 방향으로만 게이트를 판정합니다.',
  };
}

/** 시장 전체 외인·기관 현물(억원) + 코스피200 선물(계약) — 네이버 증권 trend · 60초 캐시
 *  · 3강 Ch.1 '시장 판별' 배너용. 값이 없으면 null 로 두고 판정에 쓰지 않는다(추정 금지).
 *  · bizdate 가 오늘이 아니면(장전·휴장) 배너가 '직전 거래일 확정'으로 표기한다. */
async function fetchChimMarketFlow() {
  const hit = cpChimFlowCache.get('flow');
  if (hit && Date.now() - hit.at < CP_CHIM_FLOW_TTL_MS) return hit.value;
  const value = { ok: false, asOfLabel: '', bizdate: null, kospi: null, kosdaq: null, fut: null, note: '' };
  const n = (s) => {
    const t = String(s === null || s === undefined ? '' : s).replace(/[^0-9+-]/g, '');
    if (!t || t === '+' || t === '-') return null;
    const v = Number(t);
    return isFinite(v) ? v : null;
  };
  const one = async (market) => {
    const d = await fetchJson('https://m.stock.naver.com/api/index/' + market + '/trend', {
      headers: NAVER_HEADERS,
      timeout: NAVER_TIMEOUT,
    });
    return {
      foreign: n(d && d.foreignValue),
      organ: n(d && d.institutionalValue),
      personal: n(d && d.personalValue),
      bizdate: (d && d.bizdate) || null,
    };
  };
  try {
    const [kospi, kosdaq, fut] = await Promise.all([one('KOSPI'), one('KOSDAQ'), one('FUT')]);
    value.kospi = kospi;
    value.kosdaq = kosdaq;
    value.fut = fut;
    value.bizdate = kospi.bizdate || kosdaq.bizdate || fut.bizdate || null;
    value.ok = [kospi.foreign, kosdaq.foreign, fut.foreign].some((x) => typeof x === 'number');
    if (value.bizdate) value.asOfLabel = String(value.bizdate).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    if (!value.ok) value.note = '투자자별 수급 응답에 값이 없습니다(장전·휴장 가능).';
  } catch (e) {
    value.note = '시장 수급 조회 실패: ' + String((e && e.message) || e);
  }
  cpChimFlowCache.set('flow', { at: Date.now(), value });
  return value;
}

/** 선물 계약 수 표기 */
function chimContracts(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '미수신';
  return (v > 0 ? '+' : v < 0 ? '-' : '') + Math.abs(Math.round(v)).toLocaleString('en-US') + '계약';
}

/** 3강 Ch.1 — 시장 판별 배너: 지수 + 외인·기관 현물 + 외인 선물
 *  · 경고: 지수 급락(최저 -1% 이하) / 디커플링(1%p↑ 벌어지고 한쪽 하락) /
 *          외인·기관 현물 쌍매도 / 외인 현·선물 쌍매도 / 외인 현물 -3,000억 이하
 *  · 강세: 양시장 상승 + 외인·기관 현물 양매수 + 외인 선물 순매수(미수신이면 무시)
 *  · 그 밖은 혼조·방향성 약함으로 내려 '확인된 자리만 소액'을 권한다.
 *  · 임계값(-1%, 1%p, -3,000억)은 관제탑 자체 기준이며 응답에 함께 적는다(원전 왜곡 금지). */
function chimMarketBanner(gate, flow, meta) {
  const m = meta || {};
  const k = numOrNull(gate && gate.kospiPct);
  const q = numOrNull(gate && gate.kosdaqPct);
  const idxVals = [k, q].filter((v) => v !== null);
  const minIdx = idxVals.length ? Math.min.apply(null, idxVals) : null;
  const f = flow && flow.ok ? flow : null;
  const numAt = (o, key) => (o && typeof o[key] === 'number' ? o[key] : null);
  const fSpotK = f ? numAt(f.kospi, 'foreign') : null;
  const fSpotQ = f ? numAt(f.kosdaq, 'foreign') : null;
  const oSpotK = f ? numAt(f.kospi, 'organ') : null;
  const oSpotQ = f ? numAt(f.kosdaq, 'organ') : null;
  const spotF = fSpotK !== null && fSpotQ !== null ? fSpotK + fSpotQ : null;
  const spotO = oSpotK !== null && oSpotQ !== null ? oSpotK + oSpotQ : null;
  const futF = f ? numAt(f.fut, 'foreign') : null;
  const futO = f ? numAt(f.fut, 'organ') : null;
  const stale = Boolean(m.weekend || m.preopen || m.afterClose);
  const asOf = f
    ? stale
      ? '직전 거래일' + (f.asOfLabel ? '(' + f.asOfLabel + ')' : '') + ' 확정'
      : '실시간' + (f.asOfLabel ? ' · ' + f.asOfLabel : '')
    : '수급 미수신';

  const reasons = [];
  if (k !== null || q !== null) {
    const parts = [];
    if (k !== null) parts.push('코스피 ' + (k > 0 ? '+' : '') + k.toFixed(2) + '%');
    if (q !== null) parts.push('코스닥 ' + (q > 0 ? '+' : '') + q.toFixed(2) + '%');
    reasons.push('지수 ' + parts.join(' · '));
  }
  if (spotF !== null && spotO !== null) {
    reasons.push('현물 외인 ' + chimSignedEok(spotF) + ' · 기관 ' + chimSignedEok(spotO));
  }
  if (futF !== null) reasons.push('선물 외인 ' + chimContracts(futF) + (futO !== null ? ' · 기관 ' + chimContracts(futO) : ''));

  let kind = 'neutral';
  let icon = '⚪';
  let title = '방향성 약함';
  let action = '주도주 확인 전까지 관망 우선 · 비중은 기본의 절반 이하';
  const hits = [];

  if (minIdx === null && spotF === null) {
    kind = 'unknown';
    icon = '⛔';
    title = '장세 판별 불가';
    action = '지수·수급 응답 없음 — 판정하지 않습니다(기준을 만들지 않음)';
  } else {
    if (minIdx !== null && minIdx <= -1) hits.push('지수 급락(최저 ' + minIdx.toFixed(2) + '%)');
    if (k !== null && q !== null && Math.abs(k - q) >= 1 && minIdx < 0) {
      hits.push('디커플링(코스피 ' + (k > 0 ? '+' : '') + k.toFixed(2) + '% vs 코스닥 ' + (q > 0 ? '+' : '') + q.toFixed(2) + '%)');
    }
    if (spotF !== null && spotO !== null && spotF < 0 && spotO < 0) hits.push('외인·기관 현물 쌍매도');
    if (spotF !== null && futF !== null && spotF < 0 && futF < 0) hits.push('외인 현·선물 쌍매도');
    if (spotF !== null && spotF <= -3000) hits.push('외인 현물 대량 순매도(' + chimSignedEok(spotF) + ')');

    const strong =
      k !== null && q !== null && k > 0 && q > 0 &&
      spotF !== null && spotO !== null && spotF > 0 && spotO > 0 &&
      (futF === null || futF >= 0);

    if (hits.length) {
      kind = 'warn';
      icon = '⚠️';
      title = '하락/디커플링 장세';
      action = '종베 비중 축소 · 눌림만 · 소액 대응(또는 관망)';
    } else if (strong) {
      kind = 'strong';
      icon = '🟢';
      title = '강세장';
      action = '주도주 중심 종베 · 익일 갭상승 노림';
    } else if (
      (k !== null && k < 0) || (q !== null && q < 0) ||
      (spotF !== null && spotF < 0) || (spotO !== null && spotO < 0) ||
      (futF !== null && futF < 0)
    ) {
      kind = 'caution';
      icon = '🟡';
      title = '혼조 장세';
      action = '확인된 자리만 소액 · 비중 절반 이하';
    }
  }
  if (stale && kind !== 'unknown') title += ' (직전 거래일 기준)';

  return {
    kind,
    icon,
    title,
    action,
    line: icon + ' ' + title + ' — ' + action,
    reasons,
    hits,
    asOf,
    stale,
    numbers: {
      kospiPct: k,
      kosdaqPct: q,
      minPct: minIdx,
      foreignSpotEok: spotF,
      organSpotEok: spotO,
      foreignFutContracts: futF,
      organFutContracts: futO,
    },
    src: '네이버 증권 지수·투자자별 trend(KOSPI·KOSDAQ·FUT) · 임계값은 관제탑 자체 기준',
  };
}

/** 🌙 배너용 야간선물 한 줄 — KIS 코스피200 야간선물(CM) 등락을 문장 하나로 만든다.
 *  · 장전(개장 전)·주말·야간장(18:00~06:00)에만 보여준다. 정규장(09:00~15:30)에는
 *    지수·수급만으로 판별하므로 야간선물 줄을 넣지 않는다(요청 #62644).
 *  · 값이 없으면(미수신·KIS 미설정) null 로 두고 줄 자체를 생략한다 — 0%·추정으로 채우지 않는다.
 *  · 판정(kind)에는 넣지 않는다. 판정 임계값은 관제탑 자체 기준 그대로다.
 *  · 예: 🌙 간밤 야간선물 742.60 (-4.56%) — 시초 갭 변동 주의 · 06:00 마감 */
function chimNightFutures(quote, meta) {
  const m = meta || {};
  if (!quote || !quote.ok) return null;
  const price = numOrNull(quote.price);
  const pct = numOrNull(quote.changePct);
  if (price === null || pct === null) return null;
  const live = Boolean(quote.live);
  if (!m.preopen && !m.weekend && !live) return null;
  const priceTxt = price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctTxt = (pct > 0 ? '+' : '') + pct.toFixed(2) + '%';
  const gapWarn = Math.abs(pct) >= 0.5;
  const tone = live ? '야간 흐름' : gapWarn ? '시초 갭 변동 주의' : '시초 갭 영향 제한적';
  const badge = quote.badge || quote.asOfKst || null;
  const head = live ? '🌙 야간선물' : '🌙 간밤 야간선물';
  return {
    ok: true,
    price,
    changePct: pct,
    change: numOrNull(quote.change),
    live,
    badge,
    asOfLabel: badge,
    line: head + ' ' + priceTxt + ' (' + pctTxt + ') — ' + tone + (badge ? ' · ' + badge : ''),
  };
}

/** 배너 사본에 야간선물 한 줄을 붙인다(원본 캐시는 건드리지 않는다). */
function attachChimNightFutures(chim, futuresKis, meta) {
  const banner = chim && chim.marketBanner;
  if (!banner) return chim;
  const night = chimNightFutures(futuresKis && futuresKis.night, meta);
  const next = Object.assign({}, banner, { nightFutures: night });
  if (night) {
    next.nightLine = night.line;
    next.nightAsOf = night.asOfLabel || null;
  }
  return Object.assign({}, chim, { marketBanner: next });
}

/** 시장경보 스냅샷(경고 예고·지정·관리종목·거래정지) — scripts/fetch_krx_warn.py 가 하루 1회 생성 */
let _cpKrxWarnSnap = null;
function loadKrxWarnSnapshot() {
  if (_cpKrxWarnSnap && Date.now() - _cpKrxWarnSnap.at < 10 * 60 * 1000) return _cpKrxWarnSnap.value;
  const value = { ok: false, generatedAt: null, map: new Map(), note: null, noticeCount: 0 };
  try {
    const d = require('../public/data/krx-warn-latest.json');
    (d && d.rows ? d.rows : []).forEach((r) => {
      if (r && r.code) value.map.set(String(r.code), r);
    });
    value.ok = true;
    value.generatedAt = (d && (d.generatedAt || d.basisDate)) || null;
    value.noticeCount = d && d.rows ? d.rows.filter((r) => r.notice).length : 0;
  } catch (e) {
    value.note = '시장경보 스냅샷 없음 — 예고 단계 미반영';
  }
  _cpKrxWarnSnap = { at: Date.now(), value };
  return value;
}

/** 오픈DART 최근 3일 공시에서 후보 종목의 희석·악재 공시만 골라 Map 으로 만든다(5분 캐시).
 *  · 주요사항보고(B) 2장 + 발행공시(C) 1장 + 거래소공시(I) 1장 — 유증·CB/BW·감자·최대주주변경 등이 몰리는 유형.
 *  · 같은 스캔에서 **호재 공시**(단일판매·공급계약/잠정실적/자사주 취득)도 함께 골라 favMap 에 담는다
 *    → 재료(공시) 근거로 카드에 붙이기 위해 호출을 늘리지 않고 같은 응답에서 뽑는다.
 *  · DART_API_KEY 가 없거나 응답이 실패하면 map 을 비우고 note 만 남긴다(악재 없음으로 단정하지 않는다). */
async function fetchChimDartRisks(codes) {
  const want = new Set((codes || []).map((c) => String(c)));
  if (cpChimDartCache.value && Date.now() - cpChimDartCache.at < CP_CHIM_DART_TTL_MS) {
    return cpChimDartCache.value;
  }
  const value = { ok: false, map: new Map(), favMap: new Map(), asOf: null, note: null, requested: want.size, found: 0, favFound: 0 };
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    value.note = 'DART_API_KEY 없음 — 악재 공시 확인 불가';
    cpChimDartCache = { at: Date.now(), value };
    return value;
  }
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const ymdOf = (offsetDay) => {
    const p = kstParts(new Date(Date.now() + offsetDay * 86400000));
    return String(p.y) + pad(p.m) + pad(p.d);
  };
  const end = ymdOf(0);
  const bgn = ymdOf(-2);
  const cls = (nm) => {
    const s = String(nm || '');
    for (const r of CP_CHIM_DART_RISK) if (s.indexOf(r.kw) >= 0) return r.label;
    return null;
  };
  const clsGood = (nm) => {
    const s = String(nm || '');
    for (const r of CP_CHIM_DART_GOOD) if (s.indexOf(r.kw) >= 0) return r.label;
    return null;
  };
  const scans = [
    { ty: 'B', page: 1 },
    { ty: 'B', page: 2 },
    { ty: 'C', page: 1 },
    /* 거래소공시(수시) — 단일판매·공급계약(수주) 이 여기에 실린다 */
    { ty: 'I', page: 1 },
  ];
  try {
    const settled = await Promise.allSettled(
      scans.map((s) => {
        const url =
          'https://opendart.fss.or.kr/api/list.json?crtfc_key=' + encodeURIComponent(apiKey) +
          '&bgn_de=' + bgn + '&end_de=' + end + '&page_count=100&page_no=' + s.page +
          '&pblntf_ty=' + s.ty + '&sort=date&sort_mth=desc';
        return fetchJson(url, { timeout: 7000 });
      }),
    );
    let rows = 0;
    let apiErr = null;
    settled.forEach((s) => {
      if (s.status !== 'fulfilled') return;
      const d = s.value || {};
      const status = String(d.status || '');
      if (status !== '000' && status !== '013') {
        apiErr = apiErr || 'DART status ' + status;
        return;
      }
      (d.list || []).forEach((it) => {
        rows += 1;
        const code = String(it.stock_code || '').trim();
        if (!/^\d{6}$/.test(code) || !want.has(code)) return;
        const date = String(it.rcept_dt || '');
        const rceptDate = /^\d{8}$/.test(date) ? date.slice(4, 6) + '/' + date.slice(6, 8) : null;
        const label = cls(it.report_nm);
        if (label) {
          const cur = value.map.get(code);
          const item = {
            label,
            reportNm: String(it.report_nm || '').trim(),
            rceptDate,
            rceptDt: date,
            rceptNo: it.rcept_no || null,
            url: /^\d{14}$/.test(String(it.rcept_no || ''))
              ? 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + it.rcept_no
              : null,
          };
          /* 같은 종목에 여러 건이면 가장 최근 접수분만 카드에 쓴다 */
          if (!cur || date >= String(cur.rceptDt || '')) value.map.set(code, item);
          return;
        }
        /* 악재가 아니면 호재 공시(수주·잠정실적·자사주)인지 한 번 더 본다 */
        const good = clsGood(it.report_nm);
        if (!good) return;
        const curFav = value.favMap.get(code);
        const favItem = {
          label: good,
          reportNm: String(it.report_nm || '').trim(),
          rceptDate,
          rceptDt: date,
          url: /^\d{14}$/.test(String(it.rcept_no || ''))
            ? 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + it.rcept_no
            : null,
        };
        if (!curFav || date >= String(curFav.rceptDt || '')) value.favMap.set(code, favItem);
      });
    });
    value.ok = rows > 0;
    value.found = value.map.size;
    value.favFound = value.favMap.size;
    value.asOf = end.slice(0, 4) + '-' + end.slice(4, 6) + '-' + end.slice(6, 8) + ' 기준 최근 3일';
    if (!rows) value.note = apiErr || 'DART 응답에 공시가 없습니다.';
  } catch (e) {
    value.note = 'DART 조회 실패: ' + String((e && e.message) || e);
  }
  cpChimDartCache = { at: Date.now(), value };
  return value;
}

/* ----------------------------------------------------------------------------
 * 📰 재료(테마·뉴스·공시) 확인 — 2026-11-25 사용자 확정
 *  "침착해는 재료가 있는 거에서 참고로 다른 걸 보는 거야"
 *  → 재료가 확인된 종목만 후보로 올리고, 프로그램·외인/기관 수급은 그 안에서 참고로 쓴다.
 *  · ① 테마 : 이미 받아 둔 주도 테마 구성종목(가짜 라벨 제외) — 추가 호출 없음
 *  · ② 뉴스 : 네이버 종목 뉴스(당일) — 종목별 병렬 1회(≈0.6초), 5분 메모리 캐시
 *  · ③ 공시 : 오픈DART 스캔에서 같이 건진 호재 공시(단일판매·공급계약·잠정실적 등)
 *  · 뉴스 응답이 없으면 테마·공시만으로 판정하고, 아무 근거도 없으면 '재료 미확인'으로 뺀다.
 * -------------------------------------------------------------------------- */
const CP_CHIM_NEWS_MAX = 16; // 후보 풀에서 뉴스를 확인할 상한(대금 상위)
const CP_CHIM_NEWS_WAIT_MS = 3500; // 뉴스 단계 최대 대기(넘으면 테마·공시만으로 판정)
const CP_CHIM_NEWS_TTL_MS = 5 * 60 * 1000;
const CP_CHIM_NEWS_FAIL_TTL_MS = 60 * 1000;
const cpChimNewsCache = new Map(); // code → { at, ttl, value }
const CP_CHIM_MATERIAL_SOURCE =
  '재료 확인 = ① 네이버·스탁이지 주도 테마 구성종목 ② 당일 네이버 종목 뉴스(회사명 + 수주·계약·실적·승인·지분·특징주·급등 등, 악재 우세 기사 제외) ③ 오픈DART 호재 공시(단일판매·공급계약·잠정실적 등)';

/** 네이버 종목 뉴스 1종목 — 실패는 1분만 캐시해 다음 주기에 다시 시도한다 */
async function fetchChimStockNews(code) {
  const hit = cpChimNewsCache.get(code);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  try {
    const data = await fetchJson(
      'https://m.stock.naver.com/api/news/stock/' + code + '?pageSize=20&page=1',
      { headers: NAVER_HEADERS, timeout: 3000 },
    );
    const groups = Array.isArray(data) ? data : data && data.items ? [data] : [];
    const items = [];
    groups.forEach((g) => {
      ((g && g.items) || []).forEach((it) => {
        if (!it || !(it.title || it.titleFull)) return;
        items.push({
          title: decodeNewsText(it.titleFull || it.title),
          press: it.officeName || null,
          datetime: String(it.datetime || ''),
          url: it.mobileNewsUrl || null,
        });
      });
    });
    cpChimNewsCache.set(code, { at: Date.now(), ttl: CP_CHIM_NEWS_TTL_MS, value: items });
    return items;
  } catch (e) {
    cpChimNewsCache.set(code, { at: Date.now(), ttl: CP_CHIM_NEWS_FAIL_TTL_MS, value: [] });
    return [];
  }
}

/** 후보 코드들의 종목 뉴스를 병렬로 — deadline 을 넘기면 그 주기는 건너뛴다 */
async function fetchChimNewsBatch(codes, deadline) {
  const map = new Map();
  const list = (codes || []).map((c) => String(c));
  await Promise.all(
    list.map(async (code) => {
      if (Date.now() > deadline) return;
      const items = await fetchChimStockNews(code);
      map.set(code, items);
    }),
  );
  return map;
}

function decodeNewsText(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 재료 뉴스를 인정하는 날짜(YYYY-MM-DD)
 *  · 장중·장후 → 오늘  · 장전 → 직전 거래일  · 주말 → 금요일
 *  (장전에 어제 저녁 기사를 오늘의 재료로 쓰는 것은 실제로 맞지만,
 *   '당일 재료'라는 표기가 흔들리지 않도록 직전 거래일까지만 인정한다) */
function chimMaterialDateYmd(p0) {
  const ymd = (d) =>
    String(d.getUTCFullYear()) +
    '-' +
    pad2(d.getUTCMonth() + 1) +
    '-' +
    pad2(d.getUTCDate());
  /* p0 는 KST 기준 값 → 같은 날 12시(KST)를 UTC 로 옮겨 날짜 계산을 한다 */
  const base = new Date(Date.UTC(p0.y, p0.m - 1, p0.d, 3, 0, 0));
  const weekday = !(p0.wd === 'Sat' || p0.wd === 'Sun');
  if (weekday && p0.minutes >= 9 * 60) return ymd(base);
  let d = new Date(base.getTime());
  for (let i = 0; i < 4; i += 1) {
    d = new Date(d.getTime() - 86400000);
    const wd = new Date(d.getTime() + 9 * 3600 * 1000).getUTCDay();
    if (wd !== 0 && wd !== 6) break;
  }
  return ymd(d);
}

/** 진입 구분 — 눌림 / 돌파·불타기 (3강 Ch.2). 당일 고가·현재가·등락률만으로 판정한다(추정 금지). */
function chimEntryKind(c) {
  const pctv = numOrNull(c && c.changePct);
  const price = numOrNull(c && c.price);
  const high = numOrNull(c && c.high);
  const fromHigh = price !== null && high !== null && high > 0 ? ((high - price) / high) * 100 : null;
  let kind = '눌림';
  if (pctv !== null && pctv >= 5 && fromHigh === null) kind = '판정 보류';
  else if (pctv !== null && pctv >= 5 && fromHigh !== null && fromHigh <= 0.5) kind = '돌파·불타기';
  let rule;
  if (kind === '돌파·불타기') {
    rule = '당일 고점 돌파·윗꼬리 먹기 확인 후에만 불타기 — 확인 전 30%는 넣지 않는다 · 3단: ' + CP_CHIM_SPLIT;
  } else if (kind === '판정 보류') {
    rule = '당일 고가 미수신 — 눌림 자리에서만 분할하고 돌파·불타기는 고점 돌파 확인 후 · 3단: ' + CP_CHIM_SPLIT;
  } else {
    rule = '지수 대비 눌림(당일 고점에서 밀린 자리)에서 프로그램이 받아주는 것을 확인 후 분할 · 3단: ' + CP_CHIM_SPLIT;
  }
  return { kind, rule, fromHighPct: fromHigh === null ? null : Math.round(fromHigh * 100) / 100 };
}

/** 전략 객체 → 한 줄 문장(카드·모달이 그대로 읽는다) */
function chimStrategyLine(s) {
  if (!s) return '';
  return (
    '진입: ' + (s.entryKind ? s.entryKind + ' — ' : '') + (s.entry || '') +
    ' · 3단 분할: ' + (s.split3 || CP_CHIM_SPLIT) +
    ' · 비중: ' + (s.sizing || '') +
    ' · 시간외·익일: ' + (s.afterHours || '') +
    ' · 손절: ' + (s.stop || '')
  );
}

/** 후보 코드별 프로그램 추이 병렬 조회(8개씩 · 마감시각 보호)
 *  · 예전에는 6개 청크로 나눠 **두 번 왕복**했다(8종목이면 6+2). KIS 호출 간격은 lib/kis 의 큐가
 *    이미 보장하므로 한 번에 8개를 보내면 왕복이 한 번 줄어 0.4~0.5초가 줄어든다(2026-11-27). */
async function fetchProgramBatch(codes, deadline) {
  const out = new Map();
  for (let i = 0; i < codes.length; i += 8) {
    if (Date.now() > deadline) break;
    const slice = codes.slice(i, i + 8);
    const settled = await Promise.allSettled(slice.map((c) => kisLib.fetchProgramTradeByStock(c)));
    settled.forEach((s, idx) => {
      const code = slice[idx];
      if (s.status === 'fulfilled' && s.value) out.set(code, { ok: true, data: s.value });
      else {
        out.set(code, {
          ok: false,
          code: (s.reason && s.reason.code) || null,
          msgCd: (s.reason && s.reason.msgCd) || null,
          error: String((s.reason && (s.reason.message || s.reason)) || 'KIS 응답 없음'),
        });
      }
    });
  }
  return out;
}

function chimSignedEok(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '미확인';
  const a = Math.abs(v);
  const abs = a >= 1000 ? Math.round(a).toLocaleString('en-US') : String(Math.round(a * 10) / 10);
  return (v > 0 ? '+' : v < 0 ? '-' : '') + abs + '억';
}

/** 📘 침착해 종가베팅 트랙 — buildClosingPicks 안에서 호출한다. */
async function buildChimchakhae(ctx) {
  const started = Date.now();
  /* ⏱️ 이 단계(침착해) 안에서 어느 조회가 시간을 쓰는지 남긴다(진단용) */
  const stageMs = [];
  const tm = (name) => {
    try {
      stageMs.push({ stage: name, ms: Date.now() - started });
    } catch (e) { /* noop */ }
  };
  const { supplyPassed, themePassed, themeMembership, session, marketFlowPromise } = ctx || {};
  const cached = cpChimCache.get('chim');
  if (cached && !(ctx && ctx.debug) && Date.now() - cached.at < CP_CHIM_CACHE_TTL_MS) return cached.value;
  const p0 = kstParts(new Date());
  const weekend = p0.wd === 'Sat' || p0.wd === 'Sun';
  const preopen = !weekend && p0.minutes < 9 * 60;
  const afterClose = !weekend && p0.minutes >= AFTER_START;

  const out = {
    ok: true,
    generatedAtKst: pad2(p0.hh) + ':' + pad2(p0.mi),
    programSource: 'KIS 종목별 프로그램매매추이(0465 · FHPPG04650100) 실시간',
    programAsOfLabel: '',
    asOfLabel: '',
    marketGate: null,
    rows: [],
    rules: CP_CHIM_RULES,
    notes: [],
    errors: [],
  };

  /* ① 시장 게이트 + ② 시장 판별 배너(3강 Ch.1) — 지수·외인 현물·외인 선물 */
  let flow = null;
  try {
    /* 시장 수급(외인 현물·선물)은 핸들러가 미리 띄워 둔 Promise 가 있으면 그것을 기다린다 —
     *  60초 캐시라 대부분 즉시 끝나고, 콜드에서도 테마 수집과 겹쳐 놓쳐진 시간이 없다(2026-11-27). */
    const flowP = marketFlowPromise || fetchChimMarketFlow();
    const [idxGate, marketFlow] = await Promise.all([fetchIndexGate(), flowP]);
    out.marketGate = chimMarketGate(idxGate);
    flow = marketFlow;
  } catch (e) {
    out.errors.push('시장 게이트: ' + String((e && e.message) || e));
    out.marketGate = chimMarketGate(null);
  }
  out.marketBanner = chimMarketBanner(out.marketGate, flow, { preopen, weekend, afterClose });
  tm('gate');
  if (flow && flow.ok) {
    if (flow.fut && typeof flow.fut.foreign === 'number') out.marketGate.foreignFut = flow.fut.foreign;
    out.marketGate.foreignFutNote =
      '외인 선물 = 네이버 코스피200 선물 투자자별(계약) · 판정 기준: ' + out.marketBanner.asOf;
    out.marketFlow = { ok: true, asOf: flow.asOfLabel, kospi: flow.kospi, kosdaq: flow.kosdaq, fut: flow.fut };
  } else {
    out.marketFlow = { ok: false, note: (flow && flow.note) || '시장 수급 미수신' };
  }
  out.split3 = CP_CHIM_SPLIT;
  out.warnSource = CP_CHIM_WARN_SOURCE;
  out.materialSource = CP_CHIM_MATERIAL_SOURCE;

  if (!kisLib || !kisLib.isConfigured || !kisLib.isConfigured()) {
    out.ok = false;
    out.notes.push('KIS API 키가 없어 프로그램 수급을 조회하지 못했습니다(programStatus 미수신).');
    return out;
  }

  /* ② 후보 풀 — 수급 트랙 통과분(외인·기관) + 테마 트랙 상위(거래대금)
   *  · 같은 종목이 수급·테마 양쪽에 있으면 테마명(주도 테마)을 반드시 합친다 — 재료 판정의 1차 근거다.
   *  · '52주 신고가'·'상한가·임박'·'NXT 상승률 상위'는 테마가 아니라 풀 확장용 라벨이므로 제외한다. */
  const cands = new Map();
  const pushCand = (r, src) => {
    if (!r || !/^\d{6}$/.test(String(r.code || ''))) return;
    const cur = cands.get(r.code);
    if (cur) {
      cur.sources.push(src);
      if (cur.price === null) cur.price = numOrNull(r.price);
      if (cur.high === null) cur.high = numOrNull(r.high);
      if (typeof cur.foreignEok !== 'number' && typeof r.foreignEok === 'number') cur.foreignEok = r.foreignEok;
      if (typeof cur.organEok !== 'number' && typeof r.organEok === 'number') cur.organEok = r.organEok;
      const thName = r.themeName && isRealTheme(r.themeName) ? r.themeName : null;
      if (thName) {
        const betterRank =
          r.themeRank && (!cur.themeRank || r.themeRank < cur.themeRank);
        if (!cur.themeName || !isRealTheme(cur.themeName) || betterRank) {
          cur.themeName = thName;
          cur.themeRank = r.themeRank || cur.themeRank || null;
        }
      }
      const member = themeMembership && themeMembership.get(r.code);
      if (member && member.name && isRealTheme(member.name) && (!cur.themeName || !isRealTheme(cur.themeName))) {
        cur.themeName = member.name;
        cur.themeRank = member.rank || cur.themeRank || null;
      }
      if (!cur.name && r.name) cur.name = r.name;
      return;
    }
    const mem = themeMembership && themeMembership.get(String(r.code));
    cands.set(r.code, {
      code: String(r.code),
      name: r.name || null,
      price: numOrNull(r.price),
      changePct: numOrNull(r.changePct),
      high: numOrNull(r.high),
      valueEok: numOrNull(r.valueEok),
      foreignEok: numOrNull(r.foreignEok),
      organEok: numOrNull(r.organEok),
      supplyKind: r.supplyKind || null,
      themeName: r.themeName && isRealTheme(r.themeName) ? r.themeName : mem && mem.name ? mem.name : null,
      themeRank:
        r.themeName && isRealTheme(r.themeName)
          ? r.themeRank || null
          : mem && mem.name
            ? mem.rank || null
            : null,
      sources: [src],
    });
  };
  (supplyPassed || []).forEach((r) => pushCand(r, 'supply'));
  (themePassed || []).slice(0, 12).forEach((r) => pushCand(r, 'theme'));
  const pool = Array.from(cands.values())
    .filter((r) => r.price !== null && r.changePct !== null)
    .sort((a, b) => (b.valueEok || 0) - (a.valueEok || 0));
  out.poolSize = pool.length;

  /* ②-b 재료 확인 — ① 테마(이미 받음) ② 당일 종목 뉴스(병렬, 최대 3.5초 대기) ③ DART 호재 공시(스캔은 아래에서 동시에)
   *  · 뉴스만 대금 상위 CP_CHIM_NEWS_MAX 종목까지 본다(응답 예산). 테마는 풀 전체에 붙는다.
   *  · 뉴스는 1종목≈0.6초 병렬(12종목 동시 0.6초 실측) · 5분 캐시 → 보통 단계 비용 1초 미만.
   *  · DART 스캔은 풀 전체 코드로 미리 띄운다 — 요청 수는 그대로(4장)이고 필터만 넓힌다. */
  const materialDate = chimMaterialDateYmd(p0);
  const newsTargets = pool.slice(0, CP_CHIM_NEWS_MAX).map((r) => r.code);
  const newsPromise = fetchChimNewsBatch(newsTargets, started + CP_CHIM_NEWS_WAIT_MS).catch(() => new Map());
  const dartPromise = fetchChimDartRisks(pool.map((r) => r.code));
  const newsMap = await Promise.race([
    newsPromise,
    new Promise((resolve) => setTimeout(() => resolve(new Map()), CP_CHIM_NEWS_WAIT_MS)),
  ]);
  tm('news');

  /* ②-c 재료 게이트 — 재료가 확인된 종목만 후보로 남긴다 */
  const materialGate = { theme: 0, news: 0, dart: 0, none: 0, adverse: 0, newsChecked: newsMap.size };
  const materialPool = [];
  pool.forEach((c) => {
    const hedge = newsMap.get(c.code);
    const picked = Array.isArray(hedge) && hedge.length
      ? pickMaterialNews(c.name, hedge, materialDate)
      : { material: null, adverse: null };
    /* 테마 재료는 테마맵 카드 종목(themeMembership)만 인정 — 확장 풀의 업종 걸치기는 재료가 아니다 */
    const mem = themeMembership ? themeMembership.get(c.code) : null;
    const themeMat = mem && mem.name && isRealTheme(mem.name) ? mem : null;
    const m = {
      themeName: themeMat ? themeMat.name : null,
      themeRank: themeMat ? themeMat.rank || null : null,
      news: picked.material || null,
      adverse: picked.adverse || null,
      dart: null,
    };
    m.ok = Boolean(m.themeName || m.news);
    if (m.themeName) materialGate.theme += 1;
    if (m.news) materialGate.news += 1;
    if (!m.ok) {
      materialGate.none += 1;
      if (m.adverse) materialGate.adverse += 1;
      return;
    }
    materialPool.push({ ...c, material: m });
  });
  out.materialDate = materialDate;
  out.materialGate = materialGate;
  if (!materialPool.length) {
    out.notes.push(
      '재료(주도 테마·당일 특징/호재 뉴스·호재 공시)가 확인된 종목이 없습니다 — 재료 없는 종목으로 채우지 않았습니다.',
    );
  }
  /* ②-d 프로그램 조회 대상 — 재료 확인 종목 중 거래대금 상위 */
  const targets = materialPool.slice(0, CP_CHIM_POOL_MAX);
  /* ③ 프로그램 수급 조회 — DART는 풀 전체 코드로 이미 띄워 두었다(동시에 기다린다) */
  const progMap = await fetchProgramBatch(
    targets.map((t) => t.code),
    started + CP_CHIM_DEADLINE_MS,
  );
  tm('program');
  /* 한 번 실패한 종목은 한 번만 더 시도한다 — 다른 탭의 동시 호출로 초당 제한(EGW00201)이
   *  걸려 '미수신'이 한 주기(60초) 동안 굳는 것을 줄인다. */
  /* 다시 시도는 **초당 한도(EGW00201)로 막힌 종목만** 한다 — 응답 자체가 없는 장애나 권한 오류까지
   *  한 번 더 돌면 0.8초를 그냥 버리게 된다(2026-11-27). */
  const retryCodes = Array.from(progMap.entries())
    .filter(([, v]) => {
      if (!v || v.ok) return false;
      const s = String(v.error || '');
      return /EGW00201|초당|rate|제한|KIS_RATE_LIMIT/i.test(s) || /KIS_RATE_LIMIT/.test(String(v.code || ''));
    })
    .map(([k]) => k);
  if (retryCodes.length && Date.now() < started + CP_CHIM_DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 350));
    const again = await fetchProgramBatch(retryCodes, started + CP_CHIM_DEADLINE_MS + 2500);
    again.forEach((v, k) => { if (v && v.ok) progMap.set(k, v); });
  }
  tm('programRetry');
  out.programStats = {
    requested: targets.length,
    received: Array.from(progMap.values()).filter((x) => x.ok).length,
    failed: Array.from(progMap.values()).filter((x) => !x.ok).length,
  };

  /* DART 악재 — 프로그램 조회와 동시에 띄웠다. 6초를 넘기면 이번 주기는 '확인 생략'으로 남긴다. */
  const dartRisks = await Promise.race([
    dartPromise.catch((e) => ({ ok: false, map: new Map(), asOf: null, note: 'DART 조회 실패: ' + String((e && e.message) || e) })),
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ ok: false, map: new Map(), asOf: null, note: 'DART 응답 지연 — 이번 주기 악재 확인 생략' }),
        6000,
      ),
    ),
  ]);
  out.dartStats = {
    ok: Boolean(dartRisks && dartRisks.ok),
    found: (dartRisks && dartRisks.found) || 0,
    favFound: (dartRisks && dartRisks.favFound) || 0,
    asOf: (dartRisks && dartRisks.asOf) || null,
    note: (dartRisks && dartRisks.note) || null,
  };
  /* DART 호재 공시를 재료에 합친다 — 게이트는 이미 테마·뉴스로 끝났지만,
   *  수주·잠정실적 공시가 있으면 카드 근거로 같이 적는다(없으면 그대로). */
  if (dartRisks && dartRisks.favMap && dartRisks.favMap.size) {
    targets.forEach((c) => {
      const fav = dartRisks.favMap.get(c.code);
      if (!fav || !c.material) return;
      c.material.dart = fav;
      if (!c.material.ok) c.material.ok = true;
      materialGate.dart += 1;
    });
  }

  const gate = out.marketGate || {};
  const idxPct = (() => {
    const v = [gate.kospiPct, gate.kosdaqPct].filter((x) => typeof x === 'number');
    return v.length ? Math.min.apply(null, v) : null;
  })();

  /* ④ 분류 — 재료 확인 종목 안에서 프로그램 순매수 최우선, 소폭 순매도 + 외인·기관 방어는 뱃지로 포함 */
  const drop = { noProg: 0, programSell: 0, noQuote: 0, fund: 0, noMaterial: materialGate.none };
  const prelim = [];
  targets.forEach((c) => {
    const nm = String(c.name || '');
    if (FUND_NAME_RE.test(nm) || isPreferredStock({ code: c.code, name: nm })) {
      drop.fund += 1;
      return;
    }
    const pr = progMap.get(c.code);
    const prog = pr && pr.ok ? pr.data : null;
    const hasProg = Boolean(prog && prog.ok && prog.latest);
    const netQty = hasProg ? prog.latest.netQty : null;
    const netValue = hasProg ? prog.latest.netValue : null;
    const programEok =
      typeof netValue === 'number' && isFinite(netValue) ? Math.round((netValue / 1e8) * 10) / 10 : null;
    const f = numOrNull(c.foreignEok);
    const o = numOrNull(c.organEok);
    const fPos = f !== null && f > 0;
    const oPos = o !== null && o > 0;
    const support = (f === null ? 0 : f) + (o === null ? 0 : o);

    let state;
    if (!hasProg) state = '미수신';
    else if (typeof netQty === 'number' && netQty > 0) state = '순매수';
    else if (
      programEok !== null &&
      programEok < 0 &&
      fPos &&
      oPos &&
      support > 0 &&
      Math.abs(programEok) <= support * CP_CHIM_SMALL_SELL_RATIO
    )
      state = '소폭매도(방어)';
    else state = '매도';

    if (state === '매도') {
      drop.programSell += 1;
      return;
    }
    if (!hasProg) drop.noProg += 1;

    const trend = hasProg ? prog.trend || { kind: 'unknown' } : { kind: 'unknown' };
    const trendLabel = hasProg ? chimTrendLabel(trend) : '—';
    const programStatus = hasProg ? state : '미수신';
    const tag =
      state === '순매수'
        ? trend.kind === 'flip'
          ? '프로그램 순매수(오후 전환)'
          : '프로그램 순매수'
        : state === '소폭매도(방어)'
          ? '프로그램 소폭매도(기관·외인 방어)'
          : '프로그램 미수신';

    /* 선정 사유 — 프로그램 방향·지속성·규모 → 외인·기관 → 지수 대비 → 경고 */
    const why = [];
    const deltaEok =
      hasProg && typeof trend.deltaValue === 'number' ? Math.round((trend.deltaValue / 1e8) * 10) / 10 : null;
    const span = trend.baseLabel || '최근';
    if (state === '순매수') {
      if (trend.kind === 'flip') {
        why.push('오전 매도 → ' + span + ' ' + chimSignedEok(deltaEok) + ' 순매수 전환(당일 누적 ' + chimSignedEok(programEok) + ')');
      } else {
        why.push('당일 프로그램 ' + chimSignedEok(programEok) + ' 순매수 · ' + span + ' ' + chimSignedEok(deltaEok) +
          (trend.kind === 'up' ? ' 유입' : ' (증가 둔화)'));
      }
    } else if (state === '소폭매도(방어)') {
      why.push('프로그램 ' + chimSignedEok(programEok) + ' 소폭 순매도 · 기관·외인 방어');
    } else {
      why.push('프로그램 수급 미수신(KIS 0465 응답 없음) — 외인·기관으로만 판정');
    }
    if (fPos && oPos) why.push('외인 ' + chimSignedEok(f) + '·기관 ' + chimSignedEok(o) + ' 양매수');
    else if (fPos) why.push('외인 ' + chimSignedEok(f) + ' 매수 · 기관 ' + chimSignedEok(o));
    else if (oPos) why.push('기관 ' + chimSignedEok(o) + ' 매수 · 외인 ' + chimSignedEok(f));
    else why.push('외인·기관 수급 ' + (f === null && o === null ? '미확인' : '약함'));
    if (idxPct !== null && c.changePct !== null && c.changePct > idxPct) why.push('지수 대비 강세(밀림 방어)');

    const gateReduce = gate.advice === 'reduce' || gate.advice === 'hedge';
    const bannerWarn = Boolean(out.marketBanner && out.marketBanner.kind === 'warn');
    const entryInfo = chimEntryKind(c);
    const strategy = {
      entryKind: entryInfo.kind,
      entryRule: entryInfo.rule,
      split3: CP_CHIM_SPLIT,
      entry:
        state === '순매수'
          ? trend.kind === 'flip'
            ? '오전 매도 → 오후 순매수 전환 확인된 자리에서 13시 이후 분할매수'
            : '13시 이후 지수 대비 눌림 구간에서 프로그램이 받아주는 것을 확인 후 분할매수'
          : '프로그램 방향이 확인될 때까지 관망 · 오후 순매수 전환 확인 후 소량 진입',
      sizing: bannerWarn
        ? '시장 판별 경고(하락·디커플링) — 기본 비중의 절반 이하 · 눌림만 · 1종목'
        : gateReduce
          ? '시장 게이트 ' + (gate.label || '비중 축소') + ' — 기본 비중의 절반, 1~2종목'
          : '기본 비중 유지 · 3단 분할(30/40~50/20~30%)',
      afterHours:
        '시간외 단일가 3~5% 상승 시 분할 익절 · 익일 08:50 갭상승이면 절반 익절, 갭 실패(시가 이탈)면 잔량 정리',
      stop:
        '프로그램 매도 전환으로 당일 저점 이탈 시 즉시 손절 · 블록딜·유증·자사주 처분 공시 확인 시 즉시 정리',
    };

    prelim.push({
      code: c.code,
      name: c.name,
      price: Math.round(c.price),
      changePct: round2(c.changePct),
      valueEok: Math.round((c.valueEok || 0) * 10) / 10,
      programState: state,
      programStatus,
      tag,
      programEok,
      programQty: typeof netQty === 'number' ? netQty : null,
      programNetValue: typeof netValue === 'number' ? netValue : null,
      programTrend: trend.kind,
      programTrendLabel: hasProg ? trendLabel : '—',
      programAfterDeltaQty: hasProg ? trend.deltaQty : null,
      programAfterDeltaEok:
        hasProg && typeof trend.deltaValue === 'number' ? Math.round((trend.deltaValue / 1e8) * 10) / 10 : null,
      programTrendBase: hasProg ? trend.baseLabel || null : null,
      programWindowMin: hasProg ? trend.windowMin : null,
      programAsOfHour: hasProg && prog.latest ? chimHourText(prog.latest.hour) : null,
      programNote: hasProg ? null : pr && pr.error ? pr.error : 'KIS 응답 없음',
      foreignEok: f,
      organEok: o,
      totalEok: f !== null && o !== null ? round2(f + o) : null,
      supplyKind: c.supplyKind || null,
      themeName: c.themeName || null,
      themeRank: c.themeRank || null,
      material: c.material || null,
      materialLine: c.material && c.material.ok ? materialLine(c.material) : '',
      materialTag: c.material && c.material.ok ? materialTag(c.material) : null,
      materialNews: c.material && c.material.news ? c.material.news : null,
      materialDart: c.material && c.material.dart ? c.material.dart : null,
      materialAdverse: c.material && c.material.adverse ? c.material.adverse : null,
      sources: c.sources,
      marketWarn: null,
      warnLabel: null,
      shortOver: false,
      chimchakhaeReason: why.join(' · '),
      strategy,
      chimchakhaeStrategy: chimStrategyLine(strategy),
      nextDayGuide: strategy.afterHours,
      ruleHint: CP_CHIM_HINT,
      _stateScore: state === '순매수' ? 3 : state === '미수신' ? 2 : 1,
      _trendScore: trend.kind === 'flip' ? 3 : trend.kind === 'up' ? 2 : trend.kind === 'flat' ? 1 : 0,
      _materialScore: c.material
        ? (c.material.themeName ? 2 : 0) +
          (c.material.news ? (c.material.news.score >= 3 ? 2 : 1) : 0) +
          (c.material.dart ? 1 : 0)
        : 0,
    });
  });

  /* ⑤ 정렬 — 재료 확인 종목 안에서: ① 프로그램 순매수(+오후 순증) ② 규모 ③ 재료 강도
   *  (재료는 '자격'이고, 그 안의 순서는 침착해 원전대로 프로그램 수급이 정한다) */
  prelim.sort(
    (a, b) =>
      b._stateScore - a._stateScore ||
      b._trendScore - a._trendScore ||
      (b.programEok === null ? -Infinity : b.programEok) - (a.programEok === null ? -Infinity : a.programEok) ||
      (b.totalEok || 0) - (a.totalEok || 0) ||
      (b._materialScore || 0) - (a._materialScore || 0),
  );

  /* ⑥ 경보·악재 — ① 종목마스터 스냅샷(지정·경고 예고·관리종목·거래정지)
   *   ② 오픈DART 희석·악재 공시 ③ 상위 카드 KIS 시세(실시간 지정·단기과열·투자유의)
   *  ※ '경고 예고'는 KIS 시세 응답에 필드가 없다(종목마스터에만 존재) → 스냅샷이 그 역할을 맡는다. */
  const WARN_LABEL = { '00': null, '01': '투자주의', '02': '투자경고', '03': '투자위험' };
  const STAT_LABEL = {
    '51': '관리종목', '52': '투자위험', '53': '투자경고', '54': '투자주의', '58': '거래정지', '59': '단기과열',
  };
  const krxWarn = loadKrxWarnSnapshot();
  out.krxWarnAsOf = krxWarn.generatedAt || null;
  if (krxWarn.note) out.krxWarnNote = krxWarn.note;
  const riskLevel = (badges) =>
    (badges || []).reduce((m, b) => Math.max(m, b.level === 'block' ? 3 : 2), 0);

  /* ⑥-a 스냅샷·DART 반영 — 후보 전원, 추가 호출 없음 */
  prelim.forEach((r) => {
    const kRow = krxWarn.map.get(r.code) || null;
    const dart = dartRisks && dartRisks.map ? dartRisks.map.get(r.code) || null : null;
    r.krxWarn = kRow ? kRow.warn || null : null;
    r.krxWarnLabel = kRow ? kRow.warnLabel || null : null;
    r.warnNotice = Boolean(kRow && kRow.notice);
    r.krxWarnAsOf = krxWarn.generatedAt || null;
    r.dartRisk = dart
      ? { label: dart.label, reportNm: dart.reportNm, rceptDate: dart.rceptDate, url: dart.url || null }
      : null;
    const badges = [];
    if (kRow) {
      if (kRow.halt) badges.push({ level: 'block', text: '⛔ 거래정지' });
      if (kRow.liquid) badges.push({ level: 'block', text: '⛔ 정리매매' });
      if (kRow.managed) badges.push({ level: 'block', text: '⛔ 관리종목' });
      if (kRow.warn === '03') badges.push({ level: 'block', text: '⛔ 투자위험' });
      else if (kRow.warn === '02') badges.push({ level: 'warn', text: '⚠️ 투자경고' });
      else if (kRow.warn === '01') badges.push({ level: 'warn', text: '⚠️ 투자주의' });
      if (kRow.notice) badges.push({ level: 'warn', text: '⚠️ 경고 예고' });
      if (kRow.unfaith) badges.push({ level: 'warn', text: '⚠️ 불성실공시' });
    }
    if (dart) badges.push({ level: 'warn', text: '⛔ DART 악재' });
    r.riskBadges = badges;
    r._riskScore = riskLevel(badges);
  });

  /* ⑥-b 상위 카드 KIS 시세로 실시간 지정·단기과열·투자유의 확인(호출 3건 — 초당 제한 보호)
   *  후보를 8개까지 넓게 잡은 뒤 경보로 후순위를 만들고 최종 6개를 고른다. */
  const top = prelim.slice(0, Math.max(CP_CHIM_MAX_ROWS, CP_CHIM_WARN_MAX) + 2);
  const warnTargets = top.slice(0, CP_CHIM_WARN_MAX);
  try {
    const settled = await Promise.allSettled(warnTargets.map((r) => kisLib.fetchKisQuote(r.code)));
    settled.forEach((s, i) => {
      if (s.status !== 'fulfilled' || !s.value) return;
      const q = s.value;
      const r = warnTargets[i];
      const codeWarn = q.marketWarn ? String(q.marketWarn) : null;
      r.marketWarn = codeWarn && codeWarn !== '00' ? codeWarn : null;
      r.warnLabel = codeWarn && codeWarn !== '00' ? WARN_LABEL[codeWarn] || null : null;
      r.shortOver = Boolean(q.shortOver);
      r.statLabel = q.statCls && STAT_LABEL[q.statCls] ? STAT_LABEL[q.statCls] : null;
      r.caution = Boolean(q.caution);
      r.kisQuoteAsOf = q.asOfDate || null;
      const live = [];
      if (r.shortOver) live.push({ level: 'warn', text: '⛔ 단기과열 지정' });
      if (r.warnLabel) live.push({ level: r.warnLabel === '투자위험' ? 'block' : 'warn', text: '⚠️ ' + r.warnLabel + ' 지정' });
      if (r.statLabel && !r.warnLabel) live.push({ level: r.statLabel === '관리종목' ? 'block' : 'warn', text: '⚠️ ' + r.statLabel });
      if (r.caution) live.push({ level: 'warn', text: '⚠️ 투자유의' });
      if (q.liquidation) live.push({ level: 'block', text: '⛔ 정리매매' });
      if (q.managed) live.push({ level: 'block', text: '⛔ 관리종목' });
      live.forEach((b) => {
        if (!r.riskBadges.some((x) => x.text === b.text)) r.riskBadges.push(b);
      });
      r._riskScore = riskLevel(r.riskBadges);
      /* 고가를 실시간으로 받았으니 진입 구분(눌림/돌파)을 다시 판정한다 */
      if (r.strategy) {
        const entry = chimEntryKind({ price: q.price, high: q.high, changePct: q.changePct });
        r.strategy.entryKind = entry.kind;
        r.strategy.entryRule = entry.rule;
      }
    });
  } catch (e) {
    out.errors.push('경보 확인: ' + String((e && e.message) || e));
  }

  /* ⑥-c 최종 정렬 — 프로그램 판정이 같으면 경고·악재 종목을 후순위로 내린다 */
  top.sort(
    (a, b) =>
      b._stateScore - a._stateScore ||
      (a._riskScore || 0) - (b._riskScore || 0) ||
      b._trendScore - a._trendScore ||
      (b.programEok === null ? -Infinity : b.programEok) - (a.programEok === null ? -Infinity : a.programEok) ||
      (b._materialScore || 0) - (a._materialScore || 0),
  );
  out.riskStats = {
    flagged: prelim.filter((r) => (r._riskScore || 0) > 0).length,
    notice: prelim.filter((r) => r.warnNotice).length,
    dart: prelim.filter((r) => r.dartRisk).length,
  };

  out.rows = top.slice(0, CP_CHIM_MAX_ROWS).map((r, i) => {
    const copy = Object.assign({}, r);
    delete copy._stateScore;
    delete copy._trendScore;
    delete copy._riskScore;
    delete copy._materialScore;
    /* 경보·악재·전략 문구는 KIS 실시간 값이 붙은 뒤 한 곳에서 조립한다 */
    const badgeText = (copy.riskBadges || []).map((b) => b.text).join(' · ');
    if (badgeText) {
      copy.chimchakhaeReason += ' · ' + badgeText;
      copy.strategy.sizing += ' · 경고·악재 종목은 비중 최소화(원전은 패스)';
    }
    if (copy.dartRisk) {
      copy.chimchakhaeReason += ' · ' + copy.dartRisk.label +
        (copy.dartRisk.rceptDate ? ' ' + copy.dartRisk.rceptDate : '') + ' 공시';
    }
    copy.riskBadgeText = badgeText;
    copy.chimchakhaeStrategy = chimStrategyLine(copy.strategy);
    copy.rank = i + 1;
    return copy;
  });
  out.drop = drop;
  out.candidates = prelim.length;
  if (out.dartStats && out.dartStats.note) out.notes.push('DART 악재 확인: ' + out.dartStats.note);
  if (krxWarn.note) out.notes.push('시장경보(예고): ' + krxWarn.note);

  const progHours = out.rows.map((r) => r.programAsOfHour).filter(Boolean).sort();
  const lastHour = progHours.length ? progHours[progHours.length - 1] : null;
  out.programAsOfLabel = lastHour ? 'KIS 0465 · ' + lastHour + ' 기준' : 'KIS 0465 · 미수신';
  out.afterHoursGuide =
    '15:30 이후 시간외 단일가 +3~5%면 분할 익절 · 익일 08:50 프리마켓 갭 방향 확인 → 갭상승은 절반 익절, 갭 실패는 잔량 정리';
  out.asOfLabel = weekend
    ? '직전 거래일 마감 기준'
    : preopen
      ? '장전 — 직전 거래일 마감 기준'
      : afterClose
        ? '15:30 마감 기준'
        : '실시간 ' + pad2(p0.hh) + ':' + pad2(p0.mi);
  /* 진단용(?cp_debug=1) — 후보 전원의 상태·경보·프로그램 값을 그대로 내린다(기본 응답에는 없음) */
  if (ctx && ctx.debug) {
    out.chimAll = prelim.map((r) => ({
      code: r.code,
      name: r.name,
      state: r.programState,
      progEok: r.programEok,
      qty: r.programQty,
      trend: r.programTrend,
      base: r.programTrendBase,
      warn: r.warnLabel || r.marketWarn,
      shortOver: r.shortOver,
      krxWarn: r.krxWarn,
      krxNotice: r.warnNotice,
      dart: r.dartRisk ? r.dartRisk.label : null,
      badges: (r.riskBadges || []).map((b) => b.text),
      note: r.programNote,
      f: r.foreignEok,
      o: r.organEok,
      valueEok: r.valueEok,
      materialLine: r.materialLine,
    }));
    out.progTargets = targets.map((c) => {
      const p = progMap.get(c.code);
      return {
        code: c.code,
        name: c.name,
        theme: c.material ? c.material.themeName : null,
        material: c.material ? c.material.ok : false,
        ok: Boolean(p && p.ok),
        err: p && !p.ok ? p.error : null,
        rows: p && p.ok && p.data ? p.data.rows.length : 0,
        hour: p && p.ok && p.data && p.data.latest ? p.data.latest.hour : null,
        qty: p && p.ok && p.data && p.data.latest ? p.data.latest.netQty : null,
      };
    });
  }

  if (!out.rows.length) {
    out.notes.push(
      '재료(테마·뉴스·공시) 확인 + 프로그램 순매수·방어 조건을 함께 통과한 종목이 없습니다(기준을 임의로 완화하지 않음).',
    );
  }
  if (materialGate.none) {
    out.notes.push(
      '재료 미확인 ' + materialGate.none + '종목 제외 — 수급만 유입된 종목은 후보로 올리지 않습니다' +
        (materialGate.newsChecked ? ' (뉴스 확인 ' + materialGate.newsChecked + '종목)' : '') + '.',
    );
  }
  if (out.programStats.failed) {
    out.notes.push(
      '프로그램 수급 미수신 ' + out.programStats.failed + '종목 — 추정치로 채우지 않았습니다.',
    );
  }
  out.elapsedMs = Date.now() - started;
  try {
    out.stageMs = stageMs;
  } catch (e) { /* noop */ }
  if (!(ctx && ctx.debug)) cpChimCache.set('chim', { at: Date.now(), value: out });
  return out;
}

/* CP_RULES 에도 같은 기준을 붙여 화면이 읽게 한다 */
CP_RULES.chimchakhae = CP_CHIM_RULES;

/** 🌙 종가베팅 2트랙 — 응답 본문에 담을 closingPicks 를 만든다.
 *  실패해도 본 응답(테마·전략·수급 등)은 그대로 내려가도록 호출부에서 try/catch 로 감싼다. */
async function buildClosingPicks(ctx) {
  const started = Date.now();
  const { themes, knownMap, nxt, high52: h52, upperLimit: up, session } = ctx || {};
  const p0 = kstParts(new Date());
  const weekend = p0.wd === 'Sat' || p0.wd === 'Sun';
  const preopen = !weekend && p0.minutes < 9 * 60;
  const afterClose = !weekend && p0.minutes >= AFTER_START;

  const out = {
    ok: true,
    generatedAt: new Date().toISOString(),
    generatedAtKst: pad2(p0.hh) + ':' + pad2(p0.mi),
    sessionPhase: session ? session.phase : null,
    themeTrack: [],
    supplyTrack: [],
    themeAsOfLabel: '',
    supplyAsOfLabel: '',
    asOfLabel: '',
    confirmed: false,
    rules: CP_RULES,
    sourceLabel: '/api/tabs-live closingPicks (네이버 통합 시세 + KIS 가집계)',
    notes: [],
    errors: [],
  };

  /* ---------------- 🔥 트랙 1: 테마주도주 ---------------- */
  /* 상위 주도 테마 10개의 전체 구성종목(5분 캐시)을 풀에 합친다.
   *  실패해도 카드 노출 4종목·52주·상한가·NXT 풀만으로 계산한다(빈 카드보다 좁은 풀이 낫다). */
  let memberPool = { rows: [], themeCount: 0, errors: [] };
  try {
    memberPool = await (ctx && ctx.membersPromise ? ctx.membersPromise : fetchClosingThemeMembers());
    if (memberPool.errors && memberPool.errors.length) out.errors.push(...memberPool.errors);
  } catch (e) {
    out.errors.push('테마 풀 확장: ' + String((e && e.message) || e));
  }
  /* 확장 풀의 테마 순위는 **1번 탭 테마맵의 순위**(사용자가 카드에서 보는 '테마 N위')를 그대로 쓴다.
   *  네이버 테마 랭킹 순서와 테마맵 순위는 기준이 달라(테마맵 = 대금 300억↑ 평균 등락률) 번호를 섞으면
   *  같은 종목이 두 목록에서 다른 순위로 계산된다 → 테마맵에 없는 테마는 순위 없음(null)으로 둔다. */
  const normThemeName = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const themeRankByName = new Map();
  (ctx && ctx.themes ? ctx.themes : []).forEach((t) => {
    const k = normThemeName(t && t.name);
    if (k && !themeRankByName.has(k)) themeRankByName.set(k, t.rank || null);
  });
  const memberRows = (memberPool.rows || []).map((m) => ({
    ...m,
    themeRank: themeRankByName.get(normThemeName(m.themeName)) || null,
  }));
  const pool = cpThemePool({ ...(ctx || {}), members: memberRows });
  out.themePool = {
    themes: memberPool.themeCount || 0,
    members: (memberPool.rows || []).length,
    source: 'naver-theme top' + CP_POOL_THEMES + ' 전체 구성종목(5분 캐시)',
  };
  /* 시세가 비어 있는 후보만 추가 조회 — knownMap 에 통합 시세가 있으면 네이버를 다시 때리지 않는다.
   *  · 대금·등락률이 이미 기준 미달인 종목은 조회하지 않는다(확장 풀이라 대상이 많다).
   *  · 윗꼬리 계산에 필요한 고가(high)를 모르는 종목은 조회한다 — 1회 polling(최대 60종목)으로 끝낸다. */
  const needQuote = [...pool.values()]
    .filter((r) => {
      if (r.changePct === null) return false;
      if (r.changePct + 1e-9 < CP_THEME_MIN_PCT) return false;
      if (r.value !== null && r.value / 1e8 + 1e-9 < CP_THEME_MIN_VALUE_EOK) return false;
      return r.price === null || r.value === null || r.high === null;
    })
    .sort((a, b) => (b.value || 0) - (a.value || 0))
    .map((r) => r.code)
    .slice(0, CP_POOL_MAX_POLL);
  if (needQuote.length) {
    try {
      const extra = await pollQuotes(needQuote);
      needQuote.forEach((c) => {
        const r = pool.get(c);
        const q = extra[c];
        if (!r || !q) return;
        if (r.price === null) r.price = numOrNull(q.price);
        if (r.changePct === null) r.changePct = numOrNull(q.changePct);
        if (r.high === null) r.high = numOrNull(q.high);
        if ((r.value === null || !r.valueBasis || r.valueBasis === 'NXT 체결') && typeof q.value === 'number') {
          r.value = q.value;
          r.valueBasis = q.valueBasis || r.valueBasis;
        }
        if (!r.name && q.name) r.name = q.name;
        if (q.upperLimit) r.upperLimit = true;
      });
    } catch (e) {
      out.errors.push('테마 후보 시세 보강: ' + String((e && e.message) || e));
    }
  }

  const themePassed = [];
  /* 탈락 사유 카운터 — "후보가 왜 비었나"를 카드 밖(응답)에서 확인할 수 있게 남긴다. */
  const drop = { noQuote: 0, fund: 0, value: 0, pct: 0, tail: 0 };
  pool.forEach((r) => {
    if (!r.code || r.price === null || r.changePct === null || r.value === null) { drop.noQuote += 1; return; }
    const nm = String(r.name || '');
    if (FUND_NAME_RE.test(nm)) { drop.fund += 1; return; }
    if (isPreferredStock({ code: r.code, name: nm })) { drop.fund += 1; return; }
    const valueEok = r.value / 1e8;
    if (valueEok + 1e-9 < CP_THEME_MIN_VALUE_EOK) { drop.value += 1; return; }
    if (r.changePct + 1e-9 < CP_THEME_MIN_PCT) { drop.pct += 1; return; }
    const tail = r.high && r.price && r.high > 0 ? ((r.high - r.price) / r.high) * 100 : null;
    if (tail !== null && tail > CP_THEME_MAX_UPPER_PCT + 1e-9 && !r.upperLimit) { drop.tail += 1; return; }
    themePassed.push({ ...r, valueEok, tail });
  });
  out.themeDrop = drop;
  out.themePoolSize = pool.size;
  /* 주도 테마 소속 지도(code → 테마명·순위) — 침착해 재료 판정이 쓴다.
   *  ⚠️ 여기는 **1번 탭 테마맵 카드에 실제로 올라온 종목**만 담는다(확장 풀의 전체 구성종목 제외).
   *  확장 풀(top10 테마 전체 구성종목)은 대형주가 업종 이름만 걸쳐 들어오므로, 그것을 재료로 인정하면
   *  '재료 없이 수급만 유입된 대형주'가 다시 후보로 올라온다(사용자 지적: NAVER·셀트리온·삼양식품).
   *  → 화면에서 보는 '주도 테마 N위'의 구성종목이 곧 재료다. */
  const themeMembership = new Map();
  (ctx && ctx.themes ? ctx.themes : []).forEach((t) => {
    if (!t || !t.name || !isRealTheme(t.name)) return;
    (t.stocks || []).forEach((s) => {
      const code = String((s && s.code) || '');
      if (!/^\d{6}$/.test(code)) return;
      const prev = themeMembership.get(code);
      if (!prev || (t.rank && (!prev.rank || t.rank < prev.rank))) {
        themeMembership.set(code, { name: t.name, rank: t.rank || null });
      }
    });
  });
  /* 테마 강도 — 테마 랭킹 1위 = +3, 2~3위 = +2, 4~10위 = +1, 테마 없음 = 0.
   *  상한가 종목은 한 단계 가점한다(상한가 자체가 가장 강한 주도 신호이므로).
   *  → 11/24처럼 테마 1위 대장주(휴림로봇)가 등락률 3위여도 맨 위로 온다. */
  const strengthOf = (r) => {
    const tr = numOrNull(r.themeRank);
    let s = tr === null ? 0 : tr === 1 ? 3 : tr <= 3 ? 2 : tr <= CP_POOL_THEMES ? 1 : 0;
    if (r.upperLimit) s += 1;
    return s;
  };
  themePassed.forEach((r) => { r.strength = strengthOf(r); });
  themePassed.sort(
    (a, b) =>
      b.strength - a.strength ||
      (b.upperLimit ? 1 : 0) - (a.upperLimit ? 1 : 0) ||
      b.changePct - a.changePct ||
      b.valueEok - a.valueEok ||
      (a.themeRank || 99) - (b.themeRank || 99),
  );
  out.themeCandidates = themePassed.length;
  out.themeSortMode = 'theme-strength';
  out.themeTrack = themePassed.slice(0, CP_MAX_ROWS).map((r, i) => ({
    rank: i + 1,
    code: r.code,
    name: r.name,
    price: Math.round(r.price),
    changePct: round2(r.changePct),
    valueEok: Math.round(r.valueEok * 10) / 10,
    upperTailPct: r.tail === null ? null : Math.round(r.tail * 100) / 100,
    upperLimit: Boolean(r.upperLimit),
    themeName: r.themeName || null,
    themeRank: r.themeRank || null,
    themeStrength: r.strength,
    valueBasis: r.valueBasis || null,
    ruleHint: CP_THEME_HINT,
  }));

  /* ---------------- 💰 트랙 2: 수급주도주 ---------------- */
  let sup = { ok: false, rows: [], asOfLabel: '', confirmed: false, source: 'kis', errors: [] };
  try {
    /* ⚡ 핸들러가 미리 띄워 둔 KIS 가집계 Promise 가 있으면 그것을 기다린다(테마 풀을 만드는
     *    동안 이미 돌고 있어 실제 대기는 거의 없다) — 2026-11-27 콜드 응답 단축. */
    sup = ctx && ctx.supplyPromise ? await ctx.supplyPromise : await fetchClosingSupplyRank(12);
    if (sup.errors && sup.errors.length) out.errors.push(...sup.errors);
  } catch (e) {
    out.errors.push('KIS 가집계: ' + String((e && e.message) || e));
  }
  const supRows = sup.rows || [];
  const needSupply = supRows
    .filter((r) => !knownMap[r.code] || typeof knownMap[r.code].value !== 'number')
    .map((r) => r.code)
    .slice(0, 12);
  let qmap = knownMap || {};
  if (needSupply.length) {
    try {
      const extra = await pollQuotes(needSupply);
      qmap = { ...qmap, ...extra };
    } catch (e) {
      out.errors.push('수급 후보 시세 보강: ' + String((e && e.message) || e));
    }
  }

  const supplyPassed = [];
  supRows.forEach((r) => {
    const q = qmap[r.code] || {};
    const price = numOrNull(q.price) !== null ? numOrNull(q.price) : numOrNull(r.price);
    const changePct = numOrNull(q.changePct) !== null ? numOrNull(q.changePct) : numOrNull(r.changePct);
    const valueEok = typeof q.value === 'number' ? Math.round((q.value / 1e8) * 10) / 10 : null;
    const f = numOrNull(r.foreignEok);
    const o = numOrNull(r.organEok);
    const fs = f === null ? 0 : f;
    const os = o === null ? 0 : o;
    const bothBuy = fs > 0 && os > 0;
    const strong = Math.max(fs, os);
    const other = Math.min(fs, os);
    const oneStrong = strong >= CP_SUPPLY_STRONG_EOK && other >= -strong * CP_SUPPLY_WEAK_SELL_RATIO;
    if (!bothBuy && !oneStrong) return;
    /* 거래대금을 확인할 수 없으면 카드를 만들지 않는다(추정 금지) */
    if (valueEok === null) return;
    const valueOK = valueEok >= CP_SUPPLY_MIN_VALUE_EOK;
    const defendOK =
      valueEok >= CP_SUPPLY_DEFENSE_MIN_VALUE_EOK && changePct !== null && changePct >= CP_SUPPLY_DEFENSE_PCT;
    if (!valueOK && !defendOK) return;
    if (price === null) return;
    const nm = String(r.name || q.name || '');
    if (FUND_NAME_RE.test(nm) || isPreferredStock({ code: r.code, name: nm })) return;
    /* 표기 — 외인·기관 양쪽을 모두 적는다. 반대쪽을 확인하지 못한 경우만 '미확인'으로 남긴다. */
    const totalKnown = f !== null && o !== null;
    const supplyKind = bothBuy
      ? '쌍끌이'
      : other < 0
        ? '한쪽 매수(반대 매도)'
        : '한쪽 매수·반대 미확인';
    supplyPassed.push({
      code: r.code,
      name: nm || null,
      price: Math.round(price),
      changePct: round2(changePct),
      high: numOrNull(q.high),
      valueEok,
      foreignEok: f,
      organEok: o,
      foreignSide: f === null ? 'unknown' : f > 0 ? 'buy' : f < 0 ? 'sell' : 'flat',
      organSide: o === null ? 'unknown' : o > 0 ? 'buy' : o < 0 ? 'sell' : 'flat',
      totalEok: round2(fs + os),
      totalKnown,
      supplyKind,
      /* 카드마다 어느 집계의 수급인지 적는다 — 전일 확정치가 오늘 시세 옆에 앉을 때
       * 기준을 카드에서 바로 알 수 있어야 한다. */
      basis: sup.confirmed ? (sup.asOfLabel || '확정 기준') : 'KIS 가집계',
      ruleHint: CP_SUPPLY_HINT,
    });
  });
  supplyPassed.sort((a, b) => (b.totalEok || 0) - (a.totalEok || 0));
  out.supplyCandidates = supplyPassed.length;
  out.supplySides = sup.sides || null;
  if (ctx && ctx.debug) out.supplyRows = sup._all || [];
  out.supplyTrack = supplyPassed.slice(0, CP_MAX_ROWS).map((r, i) => ({ rank: i + 1, ...r }));

  /* ---------------- 📘 침착해 종가베팅 (프로그램 수급·오후장 방어) — 3번째 탭 ---------------- */
  try {
    out.chimchakhae = await buildChimchakhae({
      supplyPassed,
      themePassed,
      themeMembership,
      session,
      marketFlowPromise: ctx && ctx.marketFlowPromise,
      debug: Boolean(ctx && ctx.debug),
    });
  } catch (e) {
    out.chimchakhae = { ok: false, rows: [], rules: CP_CHIM_RULES, error: String((e && e.message) || e) };
    out.errors.push('침착해 트랙: ' + String((e && e.message) || e));
  }

  /* ---------------- 기준 시각 표기 ---------------- */
  out.themeAsOfLabel = weekend
    ? '직전 거래일 마감 기준'
    : preopen
      ? '장전 — 직전 거래일 마감 기준'
      : afterClose
        ? '15:30 마감 기준'
        : '실시간 ' + pad2(p0.hh) + ':' + pad2(p0.mi);
  out.supplyAsOfLabel = sup.asOfLabel || (sup.confirmed ? '확정 기준' : '');
  out.asOfLabel =
    out.supplyAsOfLabel && out.supplyAsOfLabel !== out.themeAsOfLabel
      ? out.themeAsOfLabel + ' · 수급 ' + out.supplyAsOfLabel
      : out.themeAsOfLabel;
  out.confirmed = Boolean(sup.confirmed);
  out.supplySource = sup.source || 'kis';
  out.supplyFallbackReason = sup.fallbackReason || null;
  out.empty = { theme: out.themeTrack.length === 0, supply: out.supplyTrack.length === 0 };
  if (out.empty.theme && out.empty.supply) out.note = '조건 충족 종목 없음 — 기준을 임의로 완화하지 않습니다.';
  if (out.empty.supply && !sup.confirmed) {
    out.notes.push(
      '수급 가집계 응답이 없어 수급 트랙을 비웠습니다(전일 확정치로 대체하지 않음) — 테마 트랙은 그대로입니다.',
    );
  }
  out.elapsedMs = Date.now() - started;
  return out;
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

/* ------------------------------------------------------------------------ */
/* 🌙 국내선물옵션 — 코스피200 주간(F)·야간(CM) KIS 실시간                     */
/* ------------------------------------------------------------------------ */
/*  · KIS 국내선물옵션 현재가(FHMIF10000000)로 헤더 티커의 '주간선물'·'야간선물(코스피)'
 *    자리를 실시간 값으로 채운다. 값이 없으면 null 로 두고 화면의 기록값을 건드리지 않는다.
 *  · 세션: 주간장 09:00~15:45(지수선물 F) · 야간장 18:00~익일 06:00(CM)
 *    야간장은 월 18:00 ~ 토 06:00 에만 열린다(일요일 밤·월요일 새벽은 휴장).
 *  · 캐시: 60초 메모리 + CDN 60초 — 15초·30초 폴링이 KIS 초당 20건 한도를 건드리지 않게 한다.
 */
const FUT_TTL_MS = 60000;
const FUT_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=120';
const futMemo = new Map();

/** 지금이 어느 선물 세션인가 */
function kospiFuturesSession(p) {
  const mins = p.minutes;
  const wd = p.wd;
  const weekday = !(wd === 'Sat' || wd === 'Sun');
  const inDay = weekday && mins >= 9 * 60 && mins < 15 * 60 + 45;
  const nightActive =
    ((wd === 'Mon' || wd === 'Tue' || wd === 'Wed' || wd === 'Thu' || wd === 'Fri') && mins >= 18 * 60) ||
    ((wd === 'Tue' || wd === 'Wed' || wd === 'Thu' || wd === 'Fri' || wd === 'Sat') && mins < 6 * 60);
  if (inDay) {
    return { phase: '주간장', inSession: true, marketDiv: 'F', primary: 'F', label: '주간장 실시간 (09:00~15:45)' };
  }
  if (nightActive) {
    return { phase: '야간장', inSession: true, marketDiv: 'CM', primary: 'CM', label: '야간장 실시간 (18:00~익일 06:00)' };
  }
  // 장외 — 06:00~09:00 은 방금 끝난 야간장, 그 밖에는 주간장 마감값이 가장 최근 값이다
  return {
    phase: '장외',
    inSession: false,
    marketDiv: null,
    primary: weekday && mins >= 9 * 60 && mins < 18 * 60 ? 'F' : mins < 9 * 60 ? 'CM' : 'F',
    label: '장외 시간 — 직전 마감값(시각 표기)',
  };
}

function futQuoteLabel(q, marketDiv, live, asOfKst, inSession) {
  if (!q || q.price === null || q.price === undefined) return '—';
  if (live) return marketDiv === 'CM' ? '18:00~06:00 실시간' : '09:00~15:45 실시간';
  if (inSession) return marketDiv === 'CM' ? '18:00~06:00 · 체결 대기' : '09:00~15:45 · 체결 대기';
  if (q.lastTradeAt) {
    const d = new Date(q.lastTradeAt);
    const k = new Date(d.getTime() + 9 * 3600 * 1000);
    return `${k.getUTCMonth() + 1}/${k.getUTCDate()} ${pad2(k.getUTCHours())}:${pad2(k.getUTCMinutes())} 마감`;
  }
  /* 마지막 체결 시각을 주지 않는 응답 — 그 값을 만든 세션의 마감 시각으로만 적는다.
     (조회 시각은 툴팁·모달의 '조회 HH:MM:SS KST' 에 그대로 남는다) */
  return marketDiv === 'CM' ? '06:00 마감' : '15:45 마감';
}

async function buildFuturesKis(now, wantRaw) {
  const p = kstParts(now);
  const sess = kospiFuturesSession(p);
  const contract = kisLib && kisLib.kospi200FrontContract ? kisLib.kospi200FrontContract(now.getTime()) : null;
  const head = {
    ok: false,
    mode: 'futures-kis',
    source: 'kis',
    trId: 'FHMIF10000000',
    api: '/uapi/domestic-futureoption/v1/quotations/inquire-price',
    generatedAt: now.toISOString(),
    generatedAtKst: `${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`,
    contract,
    session: sess,
    configured: Boolean(kisLib && kisLib.isConfigured && kisLib.isConfigured()),
    libVersion: kisLib ? kisLib.LIB_VERSION : null,
    day: null,
    night: null,
    errors: [],
  };
  if (!head.configured) {
    head.errors.push('KIS_APP_KEY / KIS_APP_SECRET 환경변수가 없습니다.');
    return head;
  }
  if (!contract) {
    head.errors.push('코스피200 근월물을 계산하지 못했습니다.');
    return head;
  }

  const cacheKey = `fut:${contract.code}:${wantRaw ? 'raw' : 'std'}`;
  if (!wantRaw) {
    const hit = futMemo.get(cacheKey);
    if (hit && Date.now() - hit.at < FUT_TTL_MS) return hit.value;
  }

  const [dayR, nightR] = await (async () => {
    /* 주간(F)·야간(CM)은 순서대로 — 선물옵션 시세는 초당 제한이 박해서 동시 호출하면 EGW00201 이 난다. */
    const day = await kisLib
      .fetchFuturesQuote({ marketDiv: 'F', code: contract.code, noCache: true, raw: wantRaw, timeout: 5000 })
      .then((v) => ({ status: 'fulfilled', value: v }))
      .catch((e) => ({ status: 'rejected', reason: e }));
    await new Promise((r) => setTimeout(r, 400));
    const night = await kisLib
      .fetchFuturesQuote({ marketDiv: 'CM', code: contract.code, noCache: true, raw: wantRaw, timeout: 5000 })
      .then((v) => ({ status: 'fulfilled', value: v }))
      .catch((e) => ({ status: 'rejected', reason: e }));
    return [day, night];
  })();

  const pick = (r, marketDiv) => {
    if (r.status !== 'fulfilled') {
      const e = r.reason || {};
      const err = {
        ok: false,
        marketDiv,
        error: String((e && e.message) || e),
        msgCd: (e && e.msgCd) || null,
        msg1: (e && e.msg1) || null,
        code: contract.code,
      };
      head.errors.push(`${marketDiv}(${contract.code}): ${err.msgCd || ''} ${err.msg1 || err.error}`.trim());
      return err;
    }
    const q = r.value;
    /* '실시간' 판정 — 지금 그 세션이 열려 있고, 이번 세션에 체결이 있었을 때만.
     *  (KIS 현재가 응답은 조회 순간의 스냅샷이므로 조회 시각이 곷 asOf 다 — lastTradeAt 은 보증용) */
    const live = Boolean(
      sess.inSession && sess.marketDiv === marketDiv && q.ok && q.hasTrade && (q.price !== null),
    );
    return Object.assign({}, q, {
      live,
      badge: futQuoteLabel(q, marketDiv, live, head.generatedAtKst, Boolean(sess.inSession && sess.marketDiv === marketDiv)),
      asOfKst: head.generatedAtKst,
    });
  };

  head.day = pick(dayR, 'F');
  head.night = pick(nightR, 'CM');
  head.ok = Boolean((head.day && head.day.ok) || (head.night && head.night.ok));
  head.primary = sess.primary;
  head.primaryQuote = sess.primary === 'CM' ? head.night : head.day;
  head.note =
    'KIS 실전 국내선물옵션 시세(FHMIF10000000) · 주간 F / 야간 CM · 근월물 자동 롤오버(만기 둘째 목요일 15:45) · 60초 캐시';

  if (!wantRaw && head.ok) futMemo.set(cacheKey, { at: Date.now(), value: head });
  return head;
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

  /* ------------------------------------------------------------------
   * ?mode=ham_test — 🍔 햄버거 기준·오늘 3분봉 실측 진단 (2026-11-27)
   *   · Vercel 실전 서버에서만 KIS 분봉을 부를 수 있어(로컬은 9443 차단) 여기서 확인한다.
   *   · ?code=000660&date=20261127 — 그 종목의 일봉 장대양봉 날·그날 3분봉·오늘 3분봉·판정
   *   · ?codes=000660,005930&build=1 — 여러 종목의 기준을 계산해 rows 로 돌려준다(번들 캐시 생성용)
   *   · 비밀값은 담지 않는다(종목·수치·사유만).
   */
  if (q.mode === 'ham_test') {
    const head = { mode: 'ham_test', ok: false, generatedAtKst: kstParts(new Date()) && `${pad2(kstParts(new Date()).hh)}:${pad2(kstParts(new Date()).mi)}` };
    if (!kisLib || !kisLib.isConfigured || !kisLib.isConfigured()) {
      return sendJson(res, 200, Object.assign(head, { ok: false, reason: 'kis_not_configured' }), 'no-store');
    }
    const codes = String(q.codes || q.code || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{6}$/.test(s));
    if (!codes.length) {
      return sendJson(res, 200, Object.assign(head, { ok: false, reason: 'code_required', message: '?code=6자리(또는 ?codes=a,b,c)' }), 'no-store');
    }
    try {
      if (q.build === '1') {
        const rows = {};
        for (const code of codes) {
          // eslint-disable-next-line no-await-in-loop
          rows[code] = await hamburger.getBase(code, { noCache: true });
        }
        return sendJson(res, 200, Object.assign(head, { ok: true, rows }), 'no-store');
      }
      if (q.date && /^\d{8}$/.test(String(q.date))) {
        const code = codes[0];
        const b = await hamburger.getBase(code, { noCache: true });
        const m = await kisLib.fetchMinuteBarsForDate(code, String(q.date), {
          hour: String(q.hour || '090300'),
          marketDiv: String(q.mk || 'J').toUpperCase(),
        });
        /* ?prev=1 — 주말·휴장일·장초반 대체값(직전 거래일 09:00~09:02) 검증 */
        const prev = q.prev === '1' ? await hamburger.prevSessionOpen(code, String(q.date)) : null;
        return sendJson(res, 200, Object.assign(head, {
          ok: true,
          base: b,
          minute: { ok: m.ok, count: m.count, date: m.date, bars: m.bars.slice(0, 8) },
          open3m: m.ok
            ? hamburger.threeMinute(m.bars,
              String(q.mk || 'J').toUpperCase() === 'NX' ? '0800' : '0900',
              String(q.mk || 'J').toUpperCase() === 'NX' ? '0802' : '0902')
            : null,
          prevSession: prev,
        }), 'no-store');
      }
      const inspected = {};
      for (const code of codes) {
        // eslint-disable-next-line no-await-in-loop
        inspected[code] = await hamburger.inspect(code, { noCache: true });
      }
      return sendJson(res, 200, Object.assign(head, { ok: true, items: inspected }), 'no-store');
    } catch (e) {
      return sendJson(res, 200, Object.assign(head, {
        ok: false, reason: 'ham_test_failed', message: String((e && e.message) || e), code: e && e.code, msgCd: e && e.msgCd, msg1: e && e.msg1,
      }), 'no-store');
    }
  }

  /* ------------------------------------------------------------------
   * ?mode=futures_test — KIS 국내선물옵션(주간 F · 야간 CM) 실측 진단
   * ------------------------------------------------------------------
   *  · 로컬에 KIS 키가 없으므로 실제 코드 표기(5자리/6자리/8자리)와 F·CM 조합이
   *    rt_cd '0' 으로 응답하는지 Vercel 실전 서버에서 직접 확인한다(추정 금지).
   *  · ?div=F,CM  ?codes=A016C,A01612,A016C000  ?raw=1
   */
  if (q.mode === 'futures_test') {
    const p0 = kstParts(new Date());
    const contract = kisLib && kisLib.kospi200FrontContract ? kisLib.kospi200FrontContract(Date.now()) : null;
    const divs = String(q.div || 'F,CM')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s === 'F' || s === 'CM');
    const codes = String(q.codes || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const list = [];
    const targets = codes.length ? codes : contract ? [contract.code, contract.code5, contract.code8] : [];
    divs.forEach((div) => targets.forEach((code) => list.push({ marketDiv: div, code })));

    const head = {
      mode: 'futures-test',
      at: new Date().toISOString(),
      atKst: `${pad2(p0.hh)}:${pad2(p0.mi)}:${pad2(p0.ss)}`,
      configured: Boolean(kisLib && kisLib.isConfigured && kisLib.isConfigured()),
      libVersion: kisLib ? kisLib.LIB_VERSION : null,
      contract,
      session: kospiFuturesSession(p0),
      candidates: list,
      ok: false,
      results: [],
      errors: [],
    };
    if (!head.configured) {
      return sendJson(res, 200, Object.assign(head, { ok: false, error: 'KIS 미설정' }), 'no-store');
    }

    let results = [];
    if (q.div || q.codes) {
      results = await kisLib.probeFuturesCandidates(list);
    } else if (q.fast === '1') {
      // 기본 진단 —대표 표기(5자리)만 먼저 찍고, 실패할 때만 다른 표기를 시도한다
      results = await kisLib.probeFuturesCandidates([
        { marketDiv: 'CM', code: contract.code },
        { marketDiv: 'F', code: contract.code },
      ]);
      if (!results.some((r) => r.ok)) results = await kisLib.probeFuturesCandidates(list);
    } else {
      results = await kisLib.probeFuturesCandidates(list);
    }
    head.results = results;
    head.ok = results.some((r) => r.ok);
    if (!head.ok) {
      head.errors = results.map((r) => `${r.marketDiv}(${r.code}): ${r.msgCd || ''} ${r.msg1 || r.error || ''}`.trim());
    }
    // 성공한 조합이 있으면 정규화 결과까지 같이 내려 준다(등락률·시각·누적거래량 검증)
    if (head.ok) {
      try {
        head.futures = await buildFuturesKis(new Date(), q.raw === '1');
      } catch (e) {
        head.futuresError = String((e && e.message) || e);
      }
    }
    return sendJson(res, 200, head, 'no-store');
  }

  /* ------------------------------------------------------------------
   * ?mode=program_test — KIS 종목별 프로그램매매추이(0465) 단독 확인용
   * ------------------------------------------------------------------
   *  · 침착해 트랙의 원천 값(시간별 순매수 수량·대금·증감)을 그대로 내려 검증한다.
   *  · 응답이 없으면 ok:false 와 msg_cd 를 그대로 적는다(추정 금지).
   */
  if (q.mode === 'program_test') {
    const p0 = kstParts(new Date());
    const code = String(q.code || '005930');
    const head = { mode: 'program-test', code, at: new Date().toISOString(), atKst: pad2(p0.hh) + ':' + pad2(p0.mi) };
    if (!kisLib || !kisLib.isConfigured || !kisLib.isConfigured()) {
      return sendJson(res, 200, Object.assign({}, head, { ok: false, error: 'KIS 미설정' }));
    }
    try {
      const prog = await kisLib.fetchProgramTradeByStock(code, { noCache: q.fresh === '1', raw: q.raw === '1' });
      return sendJson(res, 200, Object.assign({}, head, { ok: prog.ok, libVersion: kisLib.LIB_VERSION }, prog, { rows: prog.rows.slice(-4) }));
    } catch (e) {
      return sendJson(res, 200, Object.assign({}, head, { ok: false, error: String((e && e.message) || e), msgCd: (e && e.msgCd) || null, msg1: (e && e.msg1) || null }));
    }
  }

  /* ------------------------------------------------------------------
   * ?mode=supply_live — KIS 장중 기관·외국인 순매수 상위(가집계) 단독 확인용
   * ------------------------------------------------------------------
   *  · 기본 tabs-live 응답(네이버 테마 수집, 수 초)과 완전히 분리한다 — 여기서 바로
   *    반환하고 아래 수집은 타지 않는다(기본 응답 속도에 영향 없음).
   *  · KIS 국내기관_외국인 매매종목 가집계(FHPTJ04400000)를 외국인(1)·기관계(2) 두 번 호출.
   *  · raw=1 이면 응답 필드 원본과 rawKeys 를 함께 내려준다(단위 확인용).
   */
  /* ------------------------------------------------------------------
   * ?mode=supply_live — KIS 장중 외국인·기관 순매수 상위(가집계)
   * ------------------------------------------------------------------
   *  · 외국인(1)·기관계(2) 30행씩 받아 종목코드로 병합 → (외+기) 합산 순매수 상위 4.
   *  · KIS 초당 20건 제한 보호: 60초 메모리 캐시 + CDN 캐시(60초, 120초 stale 허용).
   *  · 15:30 이후·휴장일·KIS 오류로 가집계가 비거나 0이면 supply-latest.json 확정치로 폴백.
   *  · raw=1 이면 응답 필드 원본과 rawKeys 를 함께 내려준다(단위 확인용, 캐시 없음).
   */
  if (q.mode === 'supply_live') {
    const started = Date.now();
    const p0 = kstParts(new Date());
    const stamp = `${p0.y}-${pad2(p0.m)}-${pad2(p0.d)}(${WEEKDAY_KO[p0.wd] || ''}) ${pad2(p0.hh)}:${pad2(p0.mi)}:${pad2(p0.ss)} KST`;
    const wantRaw = q.raw === '1';
    const topN = Math.max(1, Math.min(10, Number(q.top) || 4));
    const divCode = String(q.div || '1');
    const SUPPLY_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=120';
    const cKey = `supply_live:${topN}:${divCode}:${wantRaw ? 'raw' : 'std'}`;

    if (!wantRaw) {
      const hit = supplyCache.get(cKey);
      if (hit && Date.now() - hit.at < SUPPLY_TTL_MS) {
        res.setHeader('X-Cache', 'HIT-memory');
        applyCacheHeaders(res, SUPPLY_CACHE_CONTROL);
        return sendJson(res, 200, hit.value, SUPPLY_CACHE_CONTROL);
      }
    }

    /* 순매수 금액 단위 — 11/24 14:56 실측으로 확정: frgn_ntby_tr_pbmn 218,885 ↔ 삼성전자
       1,143,000주 × 191,500원 = 218,884,500,000원 → 응답 값의 단위는 **백만원**.
       그래서 억 환산은 raw / 100 이다. */
    const SUPPLY_VALUE_UNIT = '백만원';
    const toEok = (raw) => (raw == null ? null : Math.round((raw / 100) * 10) / 10);
    const round1 = (x) => Math.round(x * 10) / 10;

    const body = {
      ok: true,
      mode: 'supply_live',
      source: 'kis',
      trId: 'FHPTJ04400000',
      api: '/uapi/domestic-stock/v1/quotations/foreign-institution-total',
      generatedAt: new Date().toISOString(),
      generatedAtKst: `${pad2(p0.hh)}:${pad2(p0.mi)}:${pad2(p0.ss)}`,
      generatedAtLabel: stamp,
      sessionPhase: overSessionOf(p0).inSession ? overSessionOf(p0).phase : sessionOf(p0, null).phase,
      marketStatus: null,
      params: {
        FID_COND_MRKT_DIV_CODE: 'V', FID_COND_SCR_DIV_CODE: '16449', FID_INPUT_ISCD: '0000',
        FID_DIV_CLS_CODE: divCode, FID_RANK_SORT_CLS_CODE: '0',
        FID_ETC_CLS_CODE: { foreign: '1', organ: '2' },
      },
      basis: 'KIS 장중 가집계(15:30 이후·휴장일에는 비거나 0) · 확정 수급은 supply-latest.json',
      valueUnit: SUPPLY_VALUE_UNIT,
      netValueEokRule: 'netValueEok = netValueRaw / 100 (응답 단위 백만원)',
      usingKis: (() => { try { return kisLib ? kisLib.isConfigured() : false; } catch (e) { return false; } })(),
      libVersion: (() => { try { return kisLib ? kisLib.LIB_VERSION : null; } catch (e) { return null; } })(),
      groups: {},
      top4: [],
      empty: false,
      confirmed: false,
      asOfLabel: '',
      errors: [],
    };

    /* 확정치 폴백 — supply-latest.json(재스캔이 매일 갱신, public/data 에 함께 배포)에서
       외국인 매수 상위·기관 매수 상위·동반 매수 목록을 코드로 합쳐 (외+기) 상위 N 을 만든다. */
    function confirmedSupplyTop(n) {
      let d = null;
      try {
        d = require('../public/data/supply-latest.json');
      } catch (e) {
        return null;
      }
      const groups = (d && d.groups) || {};
      const m = new Map();
      ['foreignBuy', 'organBuy', 'dualBuy'].forEach((gk) => {
        (groups[gk] || []).forEach((x) => {
          if (!x || !x.code) return;
          const cur = m.get(x.code) || { code: x.code, name: x.name, price: x.price, changePct: x.pct, foreignEok: null, organEok: null };
          if (x.foreignEok != null) cur.foreignEok = x.foreignEok;
          if (x.organEok != null) cur.organEok = x.organEok;
          if (cur.name == null) cur.name = x.name;
          if (cur.price == null) cur.price = x.price;
          if (cur.changePct == null) cur.changePct = x.pct;
          m.set(x.code, cur);
        });
      });
      const list = [...m.values()]
        .map((x) => ({ ...x, totalEok: round1((x.foreignEok || 0) + (x.organEok || 0)) }))
        .sort((a, b) => b.totalEok - a.totalEok)
        .slice(0, n);
      if (!list.length) return null;
      const bd = String(d.basisDate || '');
      const md = bd.length === 8 ? `${Number(bd.slice(4, 6))}/${Number(bd.slice(6, 8))}` : '';
      return {
        top: list,
        asOfLabel: md ? `확정 ${md} 기준` : `확정 ${String(d.basisLabel || '').trim()} 기준`,
        basisDate: bd,
        basisLabel: d.basisLabel || '',
        generatedAt: d.generatedAt || '',
        source: d.source || 'supply-latest.json',
      };
    }

    function sendSupplyFallback(why) {
      const fb = confirmedSupplyTop(topN);
      body.empty = !fb;
      body.fallback = true;
      body.fallbackReason = why;
      body.elapsedMs = Date.now() - started;
      if (!fb) {
        body.ok = false;
        body.reason = why;
        body.top4 = [];
        applyCacheHeaders(res, 'no-store');
        return sendJson(res, 502, body, 'no-store');
      }
      body.ok = true;
      body.confirmed = true;
      body.source = 'confirmed';
      body.confirmedSource = fb.source;
      body.basisDate = fb.basisDate;
      body.basisLabel = fb.basisLabel;
      body.confirmedGeneratedAt = fb.generatedAt;
      body.asOfLabel = fb.asOfLabel;
      body.top4 = fb.top.slice(0, 4);
      body.top = fb.top;
      applyCacheHeaders(res, SUPPLY_CACHE_CONTROL);
      if (!wantRaw) supplyCache.set(cKey, { at: Date.now(), value: body });
      return sendJson(res, 200, body, SUPPLY_CACHE_CONTROL);
    }

    /* 주말 휴장 — KIS 가집계는 직전 거래일 값을 그대로 줄 수 있어 오늘 시각으로 표기하면
       틀린다. 처음부터 확정치(직전 거래일)로 내려준다.
       개장 전(09:00 이전)도 같은 이유로 확정치를 쓴다 — 직전 거래일 집계가 오늘 시각으로
       둔갑하는 것을 막는다. */
    if (p0.wd === 'Sat' || p0.wd === 'Sun') return sendSupplyFallback('weekend_use_confirmed');
    if (p0.minutes < 9 * 60) return sendSupplyFallback('preopen_use_confirmed');

    if (!kisLib || !kisLib.isConfigured || !kisLib.isConfigured()) {
      return sendSupplyFallback('kis_not_configured');
    }

    const settled = await Promise.allSettled([
      kisLib.fetchForeignInstitutionTotal({ etcClsCode: '1', divCode, sortCode: '0' }),
      kisLib.fetchForeignInstitutionTotal({ etcClsCode: '2', divCode, sortCode: '0' }),
    ]);
    const roles = [['foreign', '외국인'], ['organ', '기관계']];
    const got = {};
    settled.forEach((s, i) => {
      const [key, label] = roles[i];
      if (s.status === 'fulfilled') {
        const r = s.value;
        got[key] = r;
        const trimmed = {
          ok: r.ok, role: r.role, count: r.count, valueUnit: SUPPLY_VALUE_UNIT,
          rawKeys: wantRaw ? r.rawKeys : undefined,
          rawFirstRow: wantRaw ? r.rawFirstRow : undefined,
          top: r.rows.slice(0, Math.max(topN, 4)).map((x) => ({
            rank: x.rank, code: x.code, name: x.name, price: x.price, changePct: x.changePct,
            netQty: x.netQty, netValueRaw: x.netValueRaw, netValueEok: toEok(x.netValueRaw),
          })),
          rows: wantRaw ? r.rows.map((x) => ({ ...x, netValueEok: toEok(x.netValueRaw) })) : undefined,
          fetchedAt: r.fetchedAt,
        };
        body.groups[key] = { label, ...trimmed };
      } else {
        const e = s.reason || {};
        got[key] = null;
        body.groups[key] = { label, ok: false, error: String(e.message || e), code: e.code || null, msgCd: e.msgCd || null, msg1: e.msg1 || null };
        body.errors.push(`${label}: ${String(e.message || e)}`);
      }
    });

    /* 외국인·기관 두 목록을 종목코드로 병합 — 한쪽 목록에만 있으면 그쪽 값만 채우고
       반대쪽은 null 로 둔다(없는 값을 0으로 단정하지 않는다 · 표기에서도 한쪽만 보인다). */
    const merged = new Map();
    const mergeRows = (r, side) => {
      if (!r || !r.rows || !r.rows.length) return;
      r.rows.forEach((x) => {
        if (!x || !x.code) return;
        const cur = merged.get(x.code) || {
          code: x.code, name: x.name, price: x.price, changePct: x.changePct,
          foreignEok: null, organEok: null,
        };
        const eok = toEok(x.netValueRaw);
        if (side === 'foreign') cur.foreignEok = eok; else cur.organEok = eok;
        if (cur.name == null) cur.name = x.name;
        if (cur.price == null) cur.price = x.price;
        if (cur.changePct == null) cur.changePct = x.changePct;
        merged.set(x.code, cur);
      });
    };
    mergeRows(got.foreign, 'foreign');
    mergeRows(got.organ, 'organ');
    const rows = [...merged.values()]
      .map((x) => ({
        ...x,
        totalEok: round1((x.foreignEok || 0) + (x.organEok || 0)),
        foreignOnly: x.organEok == null,
        organOnly: x.foreignEok == null,
      }))
      .sort((a, b) => b.totalEok - a.totalEok || (b.foreignEok || 0) - (a.foreignEok || 0));

    const anyNonZero = rows.some((x) => (x.foreignEok || 0) !== 0 || (x.organEok || 0) !== 0);
    const bothOk = !!(got.foreign && got.foreign.ok && got.organ && got.organ.ok);
    if (!bothOk || !rows.length || !anyNonZero) {
      return sendSupplyFallback(!bothOk ? 'kis_api_error' : 'kis_empty_or_zero');
    }

    body.empty = false;
    body.confirmed = false;
    /* 15:30 이 지나면 KIS 가집계는 그 시점 값으로 멈춘다 → 요청 시각이 아니라 마감 시각으로 적는다 */
    body.asOfLabel = p0.minutes >= AFTER_START ? '가집계 15:30 마감 기준' : `가집계 ${pad2(p0.hh)}:${pad2(p0.mi)} 기준`;
    body.top4 = rows.slice(0, 4);
    body.top = rows.slice(0, topN);
    body.count = rows.length;
    body.elapsedMs = Date.now() - started;

    applyCacheHeaders(res, SUPPLY_CACHE_CONTROL);
    if (!wantRaw) supplyCache.set(cKey, { at: Date.now(), value: body });
    return sendJson(res, 200, body, SUPPLY_CACHE_CONTROL);
  }

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
  /* ⏱️ 단계별 소요 시간 — 응답의 timings[] 로 그대로 내려 콜드 응답이 어디서 느린지 실측한다.
   *   (화면 렌더에는 쓰지 않는 진단용 · 값은 '요청 시작부터 그 단계가 끝난 시각'의 누적 ms) */
  const timings = [];
  const mark = (name) => {
    try {
      timings.push({ stage: name, ms: Date.now() - started });
    } catch (e) { /* noop */ }
  };
  /* 비동기 작업이 끝난 순간에 그 이름을 남긴다(동시 실행 단계의 실제 종료 시각) */
  const markWhen = (promise, name) => promise.then((v) => {
    mark(name);
    return v;
  });
  const now = new Date();
  const p = kstParts(now);
  const overSession = overSessionOf(p);
  /* 💸 5분 거래대금 버킷 읽기는 여기서 먼저 띄워 둔다 — 아래 네이버 수집(수 초)과 병렬로 끝나
   *    응답 시간에 거의 보태지 않는다. 실패하면 null(기록 없음과 같은 취급). */
  const tvDocPromise = tvReadDoc();
  /* 🌙 종가베팅 테마 후보 풀(상위 주도 테마 10개 전체 구성종목)도 미리 띄워 둔다 —
   *  아래 네이버 수집(수 초)과 병렬로 끝나 10초 함수 예산에 보태지 않는다(5분 캐시). */
  const cpMembersPromise = fetchClosingThemeMembers().catch((e) => ({
    ok: false, rows: [], themeCount: 0, errors: ['테마 풀 확장: ' + String((e && e.message) || e)],
  }));
  /* 🌙 코스피200 주간·야간선물(KIS · FHMIF10000000)도 미리 띄워 둔다 — 60초 캐시라 대부분 즉시 끝나고,
   *    콜드 스타트에서만 KIS 왕복이 붙는다. 함수 예산(10초)을 넘기지 않도록 2.5초만 기다리고,
   *    늦으면 이번 응답은 비우고(null) 다음 30초 폴링에서 캐시된 값을 받는다. */
  const futuresPromise = buildFuturesKis(now, false).catch((e) => ({
    ok: false,
    mode: 'futures-kis',
    day: null,
    night: null,
    errors: [String((e && e.message) || e)],
  }));
  const premarket = overSession.phase === '프리마켓';
  /* 08:50~09:00(정규장 개장 전)에도 네이버 테마 랭킹은 아직 오늘 값을 내지 않는다 →
   *  프리마켓과 같은 기준(직전 거래일 강세 Top 8 유지 + 오늘 체결 덧씌우기)으로 그린다. */
  const preOpenTheme =
    premarket || (p.wd !== 'Sat' && p.wd !== 'Sun' && p.minutes >= PRE_START && p.minutes < 9 * 60);

  /* ==========================================================================
   * ⚡ 콜드 응답 단축 (2026-11-27) — 서로 의존하지 않는 조회는 전부 여기서 동시에 출발시킨다.
   *   예전 순서: NXT(0.6초) → 네이버 수집(2~3초) → 뉴스·보강 polling → 전략(1초) →
   *               종가베팅(1.5초) → F존(0.6초) → 5분버킷(0.7초)  = 10~15초 직렬
   *   지금 순서: NXT · 테마 · 목록 · 뉴스 · 검색순위 · KRX 랭킹 · KIS 가집계 · 지수 · 테마 풀 ·
   *               F존이 한꺼번에 출발 → 끝난 것부터 이어 붙인다(값·규칙은 그대로).
   * ========================================================================== */
  // 1) NXT 랭킹 — '지금 실제로 움직이는 종목'을 감시군에 합친다(프리마켓에는 이 경로만 유효).
  const nxtPromise = fetchNxtLeaders().catch((e) => ({
    byPct: [], byValue: [], searchTop: [], sessionType: null,
    errors: [String((e && e.message) || e)], ok: false,
  }));
  /* NXT 종목코드는 테마 polling 의 '추가 코드'로만 쓰인다 — 배열 대신 Promise 를 넘겨
     테마 랭킹·구성종목·목록 수집과 동시에 출발시킨다(fetchThemeQuotes 가 끝난 뒤 await). */
  const dynCodesPromise = nxtPromise.then((n) => (n && n.ok ? pickDynamicCodes(n, WATCH_CODES) : []));

  /* 전략 탭이 쓰는 KRX 등락률·거래대금 상위 */
  const krxRankPromise = Promise.allSettled([
    fetchKrxRank('up', KRX_PCT_TOP),
    fetchKrxRank('quantTop', KRX_VALUE_TOP),
  ]).catch((e) => [
    { status: 'rejected', reason: e },
    { status: 'rejected', reason: e },
  ]);
  /* ⚡ 전략 유니버스(KRX 랭킹 → 후보 → 통합 시세·일봉 판정)는 테마맵이 필요 없다 — 여기서 출발.
   *    예전에는 테마 수집(3초)이 끝난 뒤에야 시작해서 응답 뒤미가 그만큼 늘어났다. */
  const strategyUniversePromise = buildStrategyUniverse({
    krxRank: krxRankPromise,
  }).catch((e) => ({
    ok: false, byPct: [], byVal: [], pool: [], need: [], valueRank: {},
    bijFresh: [], bijNear: [], hongFresh: [], hongNear: [], d0Pool: [], scanned: 0,
    errors: ['전략 유니버스: ' + String((e && e.message) || e)],
  }));
  /* 지수 게이트·장중 가집계·종가베팅 수급(한투) — 모두 60초 캐시라 대부분 즉시 끝난다 */
  const indexGatePromise = fetchIndexGate().catch(() => null);
  const supplyMapPromise = hongSupplyMap().catch(() => null);
  const closingSupplyPromise = fetchClosingSupplyRank(12).catch((e) => ({
    ok: false, confirmed: false, source: 'kis', rows: [], asOfLabel: '',
    basisDate: null, sides: {}, fallbackReason: 'exception',
    errors: ['KIS 가집계: ' + String((e && e.message) || e)],
  }));
  /* F존·K존 — 테마 풀(cpMembers)만 있으면 테마맵·시세와 무관하게 계산된다 */
  const fkZonePromise = markWhen(buildFkZone({ memberRows: cpMembersPromise }).catch((e) => ({
    ok: false, items: [], generatedAtKst: `${pad2(p.hh)}:${pad2(p.mi)}`,
    prev: { label: '전일 강세주', themes: [], count: 0 },
    today: { label: '오늘 강세주', themes: [], count: 0 },
    errors: [String((e && e.message) || e)], note: 'F존 후보를 만들지 못했습니다.',
  })), 'fkZone');
  /* 🍔 불개미 햄버거 — 같은 테마 풀에서 대장·부대장을 뽑고 기준 대금과 오늘 장초반 3분봉을 대조한다.
   *   F존과 같은 테마 풀 Promise 를 공유해 네이버 요청은 늘리지 않는다. */
  const hamPromise = markWhen(buildHamburger({ memberRows: cpMembersPromise }).catch((e) => ({
    ok: false, items: [], generatedAtKst: `${pad2(p.hh)}:${pad2(p.mi)}`, themes: [],
    counts: { candidates: 0, pass: 0, blocked: 0, wait: 0, noBase: 0, valueShort: 0, excluded: 0, shown: 0 },
    errors: [String((e && e.message) || e)], note: '햄버거 후보를 만들지 못했습니다.',
  })), 'hamburger');

  /* 목록·뉴스 요청을 '변수'로 먼저 받아 둔다 — 배치와 ‘미리 polling 할 코드’ 계산이 같은 Promise 를
     두 번 때리지 않게 쓰기 위해서다(중복 네이버 요청 0). */
  const listHighK = fetchList('high52week', 'KOSPI');
  const listHighQ = fetchList('high52week', 'KOSDAQ');
  const listUpK = fetchList('up', 'KOSPI');
  const listUpQ = fetchList('up', 'KOSDAQ');
  const newsPromise = fetchNews();
  const searchPromise = fetchSearchTopKRX(preOpenTheme);

  /* 52주·상한가 후보 코드 — 지금은 테마 polling 에 같이 넣어 그 왕복(0.4~0.6초)을 없앨 수 있도록
     목록이 오는 대로 코드만 뽑아 넘긴다(병합·순위 로직은 아래에서 그대로 수행). */
  const enrichCodesPromise = Promise.all([listHighK, listHighQ, listUpK, listUpQ])
    .then(([hk, hq, uk, uq]) => {
      const highLists = [hk, hq].filter(Boolean);
      const upLs = [uk, uq].filter(Boolean);
      const hc = highLists.length ? collectHigh52Candidates(highLists) : null;
      const uc = upLs.length ? collectUpperCandidates(upLs) : null;
      return []
        .concat(hc ? hc.base : [], hc ? hc.byValue : [], hc ? hc.byPct : [])
        .concat(uc ? uc.c25 : [], uc ? uc.cWatch : [])
        .map((t) => t && t.code)
        .filter(Boolean);
    })
    .catch(() => []);
  /* 뉴스 수혜주 코드 — 같은 이유로 테마 polling 에 합류 */
  const newsCodesPromise = newsPromise
    .then((r) => {
      const codes = [];
      ((r && r.items) || []).forEach((n) => {
        (n.beneficiaryStocks || []).forEach((bs) => {
          if (bs && /^\d{6}$/.test(String(bs.code || '')) && codes.indexOf(bs.code) < 0) codes.push(bs.code);
        });
      });
      return codes;
    })
    .catch(() => []);

  /* 종가베팅이 추가로 polling 하던 종목코드도 테마 polling 에 미리 넣는다(왕복 제거) —
   *  · 수급 트랙 후보(외인·기관 상위 12) : KIS 가집계가 오는 대로 코드만 뽑는다.
   *  · 확장 풀(상위 테마 구성종목) 중 이미 +3%·300억↑ 조건을 넘은 종목 : 윗꼬리(고가)만 없어서
   *    따로 조회하던 무리다. 실패해도 빈 배열로 두면 기존처럼 그때 직접 조회한다. */
  const supplyPollCodesPromise = closingSupplyPromise
    .then((s) => ((s && s.rows) || []).slice(0, 12).map((r) => r && r.code).filter(Boolean))
    .catch(() => []);
  const memberPollCodesPromise = cpMembersPromise
    .then((m) => ((m && m.rows) || [])
      .filter((r) => {
        const pct = r && typeof r.changePct === 'number' ? r.changePct : null;
        const val = r && typeof r.value === 'number' ? r.value : null;
        return pct !== null && pct >= CP_THEME_MIN_PCT && val !== null && val / 1e8 >= CP_THEME_MIN_VALUE_EOK;
      })
      .map((r) => r.code))
    .catch(() => []);
  /* 침착해 시장 배너(지수·선물 수급)도 미리 띄워 둔다 — 종가베팅 끝부분에서 처음 부르지 않게 */
  const chimFlowPromise = fetchChimMarketFlow().catch(() => null);

  const [themeR, highKospiR, highKosdaqR, upKospiR, upKosdaqR, newsR, searchR] = await Promise.allSettled([
    fetchThemeQuotes(dynCodesPromise, preOpenTheme, [enrichCodesPromise, newsCodesPromise, supplyPollCodesPromise, memberPollCodesPromise], mark),
    listHighK,
    listHighQ,
    listUpK,
    listUpQ,
    newsPromise,
    searchPromise,
  ]);
  const nxt = await nxtPromise;   /* 위 allSettled 와 동시에 출발해 이미 끝나 있다 */
  mark('nxt');
  mark('naverBatch');
  const dynCodes = nxt.ok ? pickDynamicCodes(nxt, WATCH_CODES) : [];

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
  const searchTop = searchR.status === 'fulfilled' && Array.isArray(searchR.value) ? searchR.value : [];
  sources.push({
    name: 'naver-search-top',
    ok: searchTop.length > 0,
    detail: searchTop.length
      ? `KRX searchTop ${searchTop.length}종목 (1위 ${searchTop[0].name || searchTop[0].code})`
      : preOpenTheme
        ? '장전 — 검색순위 비움(어제 순위로 추정하지 않음)'
        : '응답 없음/빈 목록 — 뱃지 생략',
  });
  sources.push({
    name: 'naver-nxt-rank',
    ok: nxt.ok,
    detail: nxt.ok
      ? `up ${nxt.byPct.length} · quantTop ${nxt.byValue.length} · searchTop ${nxt.searchTop.length} · session ${nxt.sessionType || '—'}`
      : undefined,
    error: nxt.ok ? undefined : nxt.errors.join(' / ') || 'NXT 랭킹 실패',
  });
  if (!nxt.ok) errors.push(`NXT 랭킹: ${nxt.errors.join(' / ') || '응답 없음'}`);

  const themeData = okTheme
    ? themeR.value
    : {
        themes: [],
        map: {},
        marketStatus: null,
        themeSource: null,
        themeErrors: [],
        themeRankTotal: 0,
        themeSeIn: 0,
        themeSeUpdatedAt: null,
        themeSeError: null,
      };
  const themes = attachSearchBadges(themeData.themes, searchTop);
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

  /* ---- 뉴스 수혜주 실시간 등락률·거래대금 부착 (선반영/후행 판정 근거) ----
   *  키워드로 매칭된 수혜주만 polling 으로 실제 시세를 붙인다(없으면 live:null — 값을 만들지 않는다).
   *  +15% 이상 이미 오른 뒤 나온 기사는 preRun=true 로 표시해 '선반영/후행' 경고를 띄운다. */
  const newsCodes = [];
  news.forEach((n) => {
    (n.beneficiaryStocks || []).forEach((bs) => {
      if (bs && /^\d{6}$/.test(String(bs.code || '')) && newsCodes.indexOf(bs.code) < 0) newsCodes.push(bs.code);
    });
  });
  let newsLiveMap = {};
  if (newsCodes.length) {
    const need = newsCodes.filter((c) => !knownMap[c] || typeof knownMap[c].value !== 'number');
    try {
      if (need.length) newsLiveMap = await pollQuotes(need);
      sources.push({ name: 'naver-polling-news-beneficiaries', ok: true, detail: `${newsCodes.length}종목 (추가 조회 ${need.length})` });
    } catch (e) {
      sources.push({ name: 'naver-polling-news-beneficiaries', ok: false, error: String((e && e.message) || e) });
      errors.push('뉴스 수혜주 시세: ' + String((e && e.message) || e));
    }
    news.forEach((n) => {
      (n.beneficiaryStocks || []).forEach((bs) => {
        if (!bs || !bs.code) return;
        const q = knownMap[bs.code] || newsLiveMap[bs.code] || null;
        if (!q || typeof q.price !== 'number') {
          bs.live = null;
          bs.preRun = false;
          return;
        }
        const pct = typeof q.changePct === 'number' ? q.changePct : null;
        bs.live = {
          price: q.price,
          changePct: pct,
          value: typeof q.value === 'number' ? q.value : null,
          valueText: q.valueText || null,
          valueDispText: q.valueDispText || q.valueText || null,   // '1조 4,159억(NXT 8,227억)'
          valueNxtText: q.valueNxtText || null,
          valueBasis: q.valueBasis || null,
          upperLimit: Boolean(q.upperLimit),
          tradedAt: q.overTradedAt || q.tradedAt || null,
          asOf: 'polling',
        };
        bs.preRun = pct !== null && pct >= 15;
      });
    });
  }

  /* ---- 목록 항목의 통합 거래대금·시고저를 polling 으로 보강 ----
   *  · 52주 신고가 목록은 KRX 정규장 대금만 실려 오므로, 순위를 정하기 전에 전 후보에 시세를 붙인다
   *    (상위 5개만 먼저 자르면 NXT 로 대금이 몬 종목이 대금주 순위에서 빠진다). */
  let enriched = 0;
  const targets = []
    .concat(high52Cand ? high52Cand.base : [])
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

  mark('enrich');
  /* 장전(평일 09:00 이전)에는 정규장이 아직 열리지 않아 '당일 52주 신고가'가 존재하지 않는다.
   *  그래도 네이버 high52week 목록은 장전 잔여 응답(대금 0 · 0.00%)을 돌려주어
   *  엉뚱한 종목(11/19 08:24 실측: '유진 챔피언중단기크레딧 X클래스' · 대금 0)이 카드에 올라왔다.
   *  → 장전에는 값을 만들지 않고 null 로 내려 화면이 07:30 동기화 스냅샷을 그대로 유지하게 한다. */
  const beforeOpen = !(p.wd === 'Sat' || p.wd === 'Sun') && p.minutes < 9 * 60;
  const high52 = (!beforeOpen && high52Cand)
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

  /* ==========================================================================
   * ⚡ 전략·종가베팅·F존·5분버킷은 서로 독립 — 동시에 돌리고 끝난 것부터 이어 붙인다.
   *   (예전: 전략(1초) → 종가베팅(1.5초) → F존(0.6초) → 5분버킷(0.7초) 순차 = 3.8초)
   * ========================================================================== */
  let strategyLive = null;
  const strategyPromise = markWhen(buildStrategyLive(knownMap, session && session.phase, {
    /* ⚡ D+0 박스용 — 테마 구성종목·지수·KIS 가집계·KRX 랭킹을 미리 띄워 둔 Promise 그대로 넘긴다 */
    memberRows: cpMembersPromise,
    indexGate: indexGatePromise,
    supply: supplyMapPromise,
    prevStrongThemes: lastStrongThemes(),
    krxRank: krxRankPromise,
    universePromise: strategyUniversePromise,
  })
    .then((v) => {
      sources.push({
        name: 'strategy-live',
        ok: Boolean(v && v.ok),
        detail: v
          ? `비중법사 0일차 ${v.bij.fresh.length} · 홍인기 D+0 ${v.hong.fresh.length} · 일봉 판정 ${v.universe.judged}/${v.universe.candleChecks}`
          : undefined,
      });
      if (v && v.errors.length) errors.push(...v.errors);
      return v;
    })
    .catch((e) => {
      sources.push({ name: 'strategy-live', ok: false, error: String((e && e.message) || e) });
      errors.push('strategy-live: ' + String((e && e.message) || e));
      return null;
    }), 'strategyLive');

  /* 🌙 종가베팅 2트랙 — 이미 받은 종목 풀 + KIS 가집계(60초 캐시)로 계산한다.
   *   여기서 실패해도 본 응답(테마·전략·수급·시간외)은 그대로 내려간다. */
  let closingPicks = null;
  const closingPicksPromise = markWhen(buildClosingPicks({
    themes, knownMap, nxt, high52, upperLimit, session,
    membersPromise: cpMembersPromise, supplyPromise: closingSupplyPromise,
    marketFlowPromise: chimFlowPromise,
    debug: q.cp_debug === '1',
  }).catch((e) => {
    errors.push('closingPicks: ' + String((e && e.message) || e));
    return {
      ok: false, themeTrack: [], supplyTrack: [],
      error: String((e && e.message) || e), rules: CP_RULES,
    };
  }), 'closingPicks');

  /* 💸 5분 거래대금 버킷 — 테마 시세만 있으면 되므로 여기서 동시에 출발 */
  const tvBucketsPromise = markWhen(tvSyncBuckets({ themes, session, overSession, now, docPromise: tvDocPromise })
    .catch(() => null), 'tvBuckets');

  // 3번 탭 — 감시군(고정 41 + NXT 랭킹 동적) 세션 체결 대금·등락 순위
  //  NXT 랭킹에서 찾은 종목은 같은 polling 응답(knownMap)에서 시세·체결 대금을 가져온다.
  const dynamicUniverse = dynCodes.map((code) => {
    const hit = nxt.byPct.find((x) => x.code === code) || nxt.byValue.find((x) => x.code === code) || {};
    const q = knownMap[code] || {};
    return { code, name: hit.name || q.name || null, groups: ['NXT'] };
  });
  const liveUniverse = WATCH.concat(dynamicUniverse);
  const aftermarket = buildAftermarket(knownMap, overSession, liveUniverse);

  /* 세 개를 기다리는 동안 위의 독립 작업도 같이 돌아간다 */
  const [strategyRes, closingRes, fkZoneRes, hamRes] = await Promise.all([
    strategyPromise,
    closingPicksPromise.catch((e) => {
      errors.push('closingPicks: ' + String((e && e.message) || e));
      return { ok: false, themeTrack: [], supplyTrack: [], error: String((e && e.message) || e), rules: CP_RULES };
    }),
    fkZonePromise,
    Promise.race([
      hamPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), HAM_RULES.budgetMs + 1500)),
    ]),
  ]);
  strategyLive = strategyRes;
  closingPicks = closingRes;
  if (closingPicks && closingPicks.error && closingPicks.ok === false && !closingPicks.themeTrack) {
    closingPicks = { ok: false, themeTrack: [], supplyTrack: [], error: closingPicks.error, rules: CP_RULES };
  }

  /* ⚡ 장중매매 후보 (F존·K존) — 위에서 이미 출발시켰다(테마 대장·부대장 + 1분봉 파동, 60초 캐시) */
  const fkZone = fkZoneRes;
  /* 🍔 장중매매 후보 (불개미·햄버거) — 예산을 넘기면 null 로 두고 다음 폴링에서 받는다 */
  const hamburgerSec = hamRes || {
    ok: false, items: [], themes: [], generatedAtKst: `${pad2(p.hh)}:${pad2(p.mi)}`,
    counts: { candidates: 0, pass: 0, blocked: 0, wait: 0, noBase: 0, valueShort: 0, excluded: 0, shown: 0 },
    errors: ['hamburger: 조회 예산 초과'],
    note: '기준·분봉 조회가 늦어 이번 응답에서 비웠습니다 — 다음 폴링에서 받습니다(값을 지어내지 않습니다).',
  };

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
  notes.push(
    themeData.themeSource === 'prev-day-dynamic'
      ? `1번 주도 테마맵은 직전 거래일(${themeData.themePrevLabel || '직전'} 마감) 관제탑 실측 주도 테마에 오늘 아침 프리마켓 체결가를 덧씌운 상태입니다(오늘 랭킹은 09:00 이후 실시간 반영).`
      : '1번 주도 테마맵은 네이버 실시간 테마 랭킹에서 오늘 장중 등락률 상위 테마를 그대로 받아 그립니다(고정 8대 테마 아님).',
  );
  notes.push('상한가·임박은 상승률 +25% 이상 & 거래대금 100억 이상에만 부여하고, 100억 미만 소형주는 제외 목록으로 분리합니다.');
  if (searchTop.length) {
    notes.push(
      `테마 제목 옆 🔍 뱃지는 네이버 실시간 검색순위 Top 30 안에 든 테마 카드 노출 종목의 최고 순위·종목 수입니다(1위 ${searchTop[0].name || searchTop[0].code}).`,
    );
  } else {
    notes.push('실시간 검색순위(네이버 searchTop)는 장전·응답 실패로 비어 있어 🔍 뱃지·검색 가점을 생략합니다.');
  }
  if (themeData.themeSource === 'naver-theme' || themeData.themeSource === 'prev-day-dynamic') {
    if (themeData.themeSeIn > 0) {
      const seAt = themeData.themeSeUpdatedAt ? String(themeData.themeSeUpdatedAt).slice(11, 16) : '—';
      notes.push(
        `1번 테마맵의 🔗 표시 ${themeData.themeSeIn}개는 스탁이지(stockeasy.intellio.kr)가 분류한 실시간 강세 테마입니다. 테마 구성은 15분마다 갱신(${seAt} 기준)되고, 등락률·거래대금은 네이버 시세로 매 20초 실시간 계산합니다.`,
      );
      if (themeData.themeSeJoined > 0) {
        notes.push(
          `스탁이지 테마 ${themeData.themeSeJoined}개(구성종목)는 이름·구성이 겹치는 기존 카드에 합쳐 넣었습니다 — 같은 테마 카드가 두 번 서지 않게 하면서, 오늘 프리마켓에 실제로 움직인 구성종목을 그 카드 안에 보여주기 위해서입니다.`,
        );
      }
    } else if (themeData.themeSeError) {
      notes.push(
        `스탁이지 테마는 이번 응답에서 편입하지 않았습니다(${themeData.themeSeError}) — 네이버 테마·직전 마감 기준만으로 표시합니다.`,
      );
    }
  }
  if (premarket || themeData.themeSource === 'prev-day-dynamic') {
    if (themeData.themeSource === 'prev-day-dynamic') {
      notes.push(
        `프리마켓(08:00~09:00)에는 네이버 테마 랭킹이 아직 오늘 값을 내지 않아, 1번 테마맵은 직전 거래일(${themeData.themePrevLabel || '직전'} 마감) 관제탑 실측 주도 테마를 세우고 각 종목 위에 오늘 아침 NXT 프리마켓 실시간 체결가(전일 종가 대비)를 덧씌워 표시합니다.`,
      );
      notes.push(
        '테마 순위·막대는 노출 4종목 평균이 아니라 실질 대장주(거래대금 300억↑ 상승 종목, 없으면 100억↑는 저유동성 표기)의 등락률이고, ±100% 이상 이상치(신규상장·상한가 첫날)는 평균·타일에서 뺍니다 — 스튜디오·성적표와 같은 잣대입니다.',
      );
    } else {
      notes.push(
        '프리마켓(08:00~08:50)에는 정규장 시세가 아직 없어 8대 테마 카드의 등락률은 NXT 프리마켓 체결가(전일 종가 대비)를 쓰고, \'프리마켓\' 기준임을 표시합니다.',
      );
    }
  }
  if (!overSession.inSession) {
    notes.push(
      `${overSession.label}${aftermarket.basisLabel ? ` (기준 ${aftermarket.basisLabel})` : ''} — 장중·주말에는 시간외 대금이 늘지 않습니다.`,
    );
  }

  /* 💸 5분 거래대금 버킷 — 위에서 이미 출발시켰다(테마 시세만 있으면 되므로 전략·종가베팅과 동시).
   *    이번 응답 종목의 대금을 공용 기록(Supabase)에 남기고, 이미 쌓인 5분 칸을 tvBuckets 로 함께 내려준다.
   *  · Supabase 가 느릴 때 응답이 끝까지 끌려가지 않도록 1.2초만 기다린다 — 늦으면 이번에는 비우고
   *    화면은 자기 localStorage 기록으로 그린다(예전과 같은 동작). */
  const tvBuckets = await Promise.race([
    tvBucketsPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
  ]);

  /* 🌙 선물 실시간 — 위에서 띄운 KIS 호출을 최대 2.5초만 기다린다. */
  let futuresKis = null;
  let futuresKisTimedOut = false;
  try {
    futuresKis = await Promise.race([
      futuresPromise,
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 2500)),
    ]);
    if (futuresKis === 'TIMEOUT') {
      futuresKisTimedOut = true;
      futuresKis = null;
    }
  } catch (e) {
    futuresKis = null;
  }
  mark('futuresKis');

  /* 🌙 침착해 시장 판별 배너에 야간선물 한 줄 — 이미 받은 KIS 야간선물(CM) 값을 그대로 붙인다
   *  (추가 조회 없음). 장전·주말에만 보이고 정규장·야간장 밖에서는 줄이 사라지며,
   *  미수신이면 억지로 채우지 않고 생략한다. */
  const chimPreopen = p.wd !== 'Sat' && p.wd !== 'Sun' && p.minutes < 9 * 60;
  const chimWeekend = p.wd === 'Sat' || p.wd === 'Sun';
  if (closingPicks && closingPicks.chimchakhae) {
    closingPicks.chimchakhae = attachChimNightFutures(closingPicks.chimchakhae, futuresKis, {
      preopen: chimPreopen,
      weekend: chimWeekend,
    });
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
    tvBuckets,
    futuresKis,
    futuresKisNote: futuresKisTimedOut
      ? 'KIS 선물 시세 응답 지연으로 이번 응답에서 생략 — 다음 폴링에서 60초 캐시값을 받습니다.'
      : futuresKis
        ? futuresKis.note || null
        : null,
    themes,
    searchTop,
    searchTopBasis: 'naver stock.naver.com KRX searchTop Top 30 (실시간 검색순위)',
    themeSource: themeData.themeSource || null,
    themeRankTotal: themeData.themeRankTotal || 0,
    themeSeIn: themeData.themeSeIn || 0,
    themeSeJoined: themeData.themeSeJoined || 0,
    themeSeCards: themeData.themeSeCards || 0,
    themeBaselineRule: themeData.themeBaselineRule || null,
    themeSeUpdatedAt: themeData.themeSeUpdatedAt || null,
    themeSeError: themeData.themeSeError || null,
    themePrevLabel: themeData.themePrevLabel || null,
    themePrevAsOf: themeData.themePrevAsOf || null,
    themeErrors: themeData.themeErrors || [],
    strategyLive,
    closingPicks,
    intradayHong: (strategyLive && strategyLive.intradayHong) || null,
    fkZone,
    hamburger: hamburgerSec,
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
    timings,
    partial: errors.length > 0,
    elapsedMs: Date.now() - started,
    cacheControl: fresh ? REFRESH_CACHE_CONTROL : CACHE_CONTROL,
    fresh,
  };

  /* 🛡️ 응답 전체 마지막 수치 가드 (2026-11-27)
   *  · NaN/Infinity/문자 등락률 → null (화면에 'NaN'이 나가지 않게)
   *  · ±30% 초과 일일 등락률 → pctSuspect 플래그만(값은 보존) → 평균·순위·역할에서 제외
   *  · 캐시(last-dynamic-themes)에서 걸러낸 건수도 같이 남겨 추적할 수 있게 한다 */
  body.pctGuard = { ...sanitizePctTree(body), prevDayCache: LAST_DYNAMIC_GUARD };

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

// 테스트(test_local.mjs · test_theme_snapshot.js)에서 규칙을 직접 검증할 수 있게 내보낸다.
module.exports.isPreferredStock = isPreferredStock;
module.exports.PREFERRED_NAME_RE = PREFERRED_NAME_RE;
module.exports.fetchSearchTopKRX = fetchSearchTopKRX;
module.exports.attachSearchBadges = attachSearchBadges;
module.exports.pickThemeStocks = pickThemeStocks;
module.exports.mapPrevDayThemes = mapPrevDayThemes;
// 🌙 종가베팅 2트랙(테마·수급) 규칙을 테스트에서 직접 검증할 수 있게 내보낸다.
module.exports.buildClosingPicks = buildClosingPicks;
module.exports.buildFkZone = buildFkZone;
module.exports.FK_RULES = FK_RULES;
/* 🍔 불개미 햄버거 — 테마 대장·부대장 추출과 규칙을 테스트에서 직접 검증한다. */
module.exports.buildHamburger = buildHamburger;
module.exports.hamCandidates = hamCandidates;
module.exports.HAM_RULES = HAM_RULES;
/* 2026-11-27 — 중복 테마 건너뛰기·실질 주도 테마 정렬 단위 검증용(오프라인 테스트) */
module.exports.fkPickLeaders = fkPickLeaders;
module.exports.fkThemeStrength = fkThemeStrength;
module.exports.CP_RULES = CP_RULES;
// 🌙 배너 야간선물 한 줄(장전·주말 전용) — 문구·생략 규칙을 테스트에서 검증한다.
module.exports.chimNightFutures = chimNightFutures;
module.exports.attachChimNightFutures = attachChimNightFutures;

/* 🛡️ 2026-11-27: 예기치 못한 예외가 500(빈 응답)으로 나가지 않도록 핸들러를 감싼다.
 *    · 프론트는 ok:false + reason:'internal_error' 를 받고 직전 값을 유지한다.
 *    · 테스트용으로 붙인 module.exports 속성은 그대로 보존한다. */
(function () {
  const __http = require('../lib/http');
  const __h = module.exports;
  if (typeof __h === 'function' && !__h.__guarded) {
    const __wrapped = __http.safeHandler(__h, { label: 'tabs-live' });
    Object.assign(__wrapped, __h);
    __wrapped.__guarded = true;
    module.exports = __wrapped;
  }
})();
