'use strict';

/**
 * GET /api/dart-live
 * ---------------------------------------------------------------------------
 * 오픈DART(OpenDART) 무료 공시 API 를 조회해 '관심 종목 공시'와 '주요 키워드 공시'를
 * 실시간으로 내려준다. 8번 탭(DART 레이더 배너) · 상단 DART 레이더 모달이 이 응답으로 갱신된다.
 *
 *  · 키는 오직 환경변수 DART_API_KEY 로만 읽는다. 코드·깃허브에 절대 넣지 않는다.
 *  · 키가 없으면 { ok:false, reason:'DART_API_KEY_NOT_SET' } 를 그대로 돌려주고,
 *    화면은 기존 정적 스캔 결과를 그대로 유지한다(없는 값을 지어내지 않는다).
 *  · 키가 있으면 https://opendart.fss.or.kr/api/list.json 을 최근 N일 범위로 조회한다.
 *  · 캐시: 인스턴스 메모리 90초 + CDN public, s-maxage=60, stale-while-revalidate=120
 *    (?fresh=1 → 메모리 캐시 무시)
 *
 * 응답 규칙
 *   - 확인된 공시만 담는다. 접수일·공시명·종목코드는 DART 응답 그대로.
 *   - 공시 유형은 이름 키워드로만 분류한다(위험 / 주목 / 일반).
 *   - 관심 종목은 8번 종베 10종목 + 6번 RN존 11종목 + 1번 테마 32종목(중복 제거).
 */

const { fetchJson, sendJson, getQuery, kstLabel } = require('../lib/http');

const CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=120';
const NO_STORE = 'no-store';
const MEM_TTL_MS = 90 * 1000; // 1.5분 (요구: 1~5분 캐시)
const LOOKBACK_DAYS = 7; // 조회 범위(오늘 포함 7일)
const DAY_MS = 86400000;
const MAX_ITEMS = 30;

/* ------------------------------ 관심 종목 목록 ------------------------------ */
//  8번 종베 10종목 (window.Jongbe.STOCKS)
const JONGBE = [
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
//  6번 RN존 11종목 (window.RnZone.RAW_STOCKS)
const RN = [
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

function buildInterest() {
  const map = new Map();
  const add = (code, name, group) => {
    if (!map.has(code)) map.set(code, { code, name, groups: [] });
    const it = map.get(code);
    if (!it.groups.includes(group)) it.groups.push(group);
    if (!it.name) it.name = name;
  };
  JONGBE.forEach((s) => add(s.code, s.name, '종베'));
  RN.forEach((s) => add(s.code, s.name, 'RN존'));
  return Array.from(map.values());
}

const INTEREST = buildInterest();
const INTEREST_CODES = INTEREST.map((s) => s.code);
const INTEREST_BY_CODE = INTEREST.reduce((acc, s) => {
  acc[s.code] = s;
  return acc;
}, {});

/* ------------------------------ 공시 유형 분류 ------------------------------ */
//  DART report_nm 은 "주요사항보고서(유상증자결정)" 처럼 괄호 안에 핵심이 들어온다.
const RISK_RULES = [
  { kw: '유상증자', label: '유상증자(지분 희석)' },
  { kw: '전환사채', label: '전환사채(CB)' },
  { kw: '신주인수권부사채', label: '신주인수권부사채(BW)' },
  { kw: '감자', label: '감자' },
  { kw: '횡령', label: '횡령·배임' },
  { kw: '배임', label: '횡령·배임' },
  { kw: '불성실공시', label: '불성실공시 지정' },
  { kw: '채무불이행', label: '채무불이행' },
  { kw: '주식병합', label: '주식병합' },
  { kw: '소송', label: '소송' },
];
const WATCH_RULES = [
  { kw: '단일판매', label: '단일판매·공급계약(수주)' },
  { kw: '공급계약', label: '단일판매·공급계약(수주)' },
  { kw: '블록딜', label: '블록딜' },
  { kw: '대량보유', label: '대량보유(블록딜 영향)' },
  { kw: '최대주주', label: '최대주주 변경' },
  { kw: '자기주식', label: '자기주식 취득·처분' },
  { kw: '무상증자', label: '무상증자' },
  { kw: '합병', label: '합병' },
  { kw: '분할', label: '분할' },
  { kw: '투자판단', label: '투자판단 관련' },
  { kw: '실적', label: '실적 공시' },
];

/** 공시명 → { kind: 'risk'|'watch'|'info', label } */
function classifyReport(reportNm) {
  const nm = String(reportNm || '');
  for (const r of RISK_RULES) if (nm.indexOf(r.kw) >= 0) return { kind: 'risk', label: r.label, keyword: r.kw };
  for (const r of WATCH_RULES) if (nm.indexOf(r.kw) >= 0) return { kind: 'watch', label: r.label, keyword: r.kw };
  return { kind: 'info', label: '일반 공시', keyword: null };
}

/* --------------------------------- 유틸 --------------------------------- */

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/** KST 기준 오늘/과거 날짜 → YYYYMMDD */
function ymd(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${g('year')}${g('month')}${g('day')}`;
}

function dashYmd(v) {
  const s = String(v || '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s || null;
}

function dartUrl(rceptNo) {
  const s = String(rceptNo || '');
  if (!/^\d{14}$/.test(s)) return null;
  return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${s}`;
}

/* -------------------------------- 조회기 -------------------------------- */

const memCache = new Map(); // `${bgn}|${end}` → { at, value }

async function fetchDartList(apiKey, bgnDe, endDe) {
  const url =
    'https://opendart.fss.or.kr/api/list.json' +
    `?crtfc_key=${encodeURIComponent(apiKey)}` +
    `&bgn_de=${bgnDe}&end_de=${endDe}` +
    '&page_count=100&page_no=1&sort=date&sort_mth=desc';
  const data = await fetchJson(url, { timeout: 8000 });
  const status = String((data && data.status) || '');
  // 000 = 정상, 013 = 조회된 데이터 없음
  if (status === '013') return { rows: [], totalCount: 0, status };
  if (status !== '000') {
    const err = new Error(`DART status ${status} ${(data && data.message) || ''}`.trim());
    err.status = status;
    throw err;
  }
  return { rows: (data && data.list) || [], totalCount: Number(data.total_count) || 0, status };
}

function normalizeRow(d) {
  const cls = classifyReport(d.report_nm);
  const code = String(d.stock_code || '').trim();
  const interest = INTEREST_BY_CODE[code] || null;
  return {
    corpName: d.corp_name || null,
    corpCode: d.corp_code || null,
    stockCode: /^\d{6}$/.test(code) ? code : null,
    market: d.corp_cls || null,
    reportNm: String(d.report_nm || '').trim() || null,
    rceptNo: d.rcept_no || null,
    rceptDate: dashYmd(d.rcept_dt),
    filerName: d.flr_nm || null,
    kind: cls.kind,
    kindLabel: cls.label,
    keyword: cls.keyword,
    inInterest: Boolean(interest),
    interestName: interest ? interest.name : null,
    interestGroups: interest ? interest.groups : [],
    url: dartUrl(d.rcept_no),
  };
}

function pickItems(rows) {
  const items = [];
  const seen = new Set();
  (rows || []).forEach((d) => {
    const it = normalizeRow(d);
    if (!it.reportNm) return;
    if (seen.has(it.rceptNo)) return;
    // ① 관심 종목 공시 ② 위험/주목 키워드 공시만 남긴다(일반 공시 폭주 방지)
    if (!it.inInterest && it.kind === 'info') return;
    // 비상장·기타법인(코드 없음)은 관심종목만 통과
    if (!it.stockCode && !it.inInterest) return;
    seen.add(it.rceptNo);
    items.push(it);
  });
  const rank = { risk: 0, watch: 1, info: 2 };
  items.sort((a, b) => {
    const r = rank[a.kind] - rank[b.kind];
    if (r !== 0) return r;
    return String(b.rceptDate || '').localeCompare(String(a.rceptDate || ''));
  });
  return items.slice(0, MAX_ITEMS);
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
  const days = Math.min(Math.max(Number(q.days) || LOOKBACK_DAYS, 1), 30);

  const base = {
    generatedAt: new Date().toISOString(),
    generatedAtKst: kstLabel(new Date()),
    lookbackDays: days,
    interestCount: INTEREST.length,
    interestCodes: INTEREST_CODES,
    cacheControl: NO_STORE,
  };

  const apiKey = process.env.DART_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    return sendJson(res, 200, {
      ok: false,
      reason: 'DART_API_KEY_NOT_SET',
      keySet: false,
      message:
        'DART_API_KEY 환경변수가 없습니다. 8번 탭 DART 레이더와 상단 DART 모달은 기존 정적 스캔 결과를 그대로 유지합니다. ' +
        'Vercel 프로젝트 → Settings → Environment Variables 에 DART_API_KEY 를 추가하면 자동으로 실시간 조회로 바뀝니다.',
      ...base,
    }, NO_STORE);
  }

  const now = new Date();
  const endDe = ymd(now);
  const bgnDe = ymd(new Date(now.getTime() - (days - 1) * DAY_MS));
  const cacheKey = `${bgnDe}|${endDe}`;
  const started = Date.now();

  if (!fresh) {
    const hit = memCache.get(cacheKey);
    if (hit && Date.now() - hit.at < MEM_TTL_MS) {
      res.setHeader('X-Cache', 'HIT-memory');
      return sendJson(res, 200, hit.value, CACHE_CONTROL);
    }
  }

  try {
    const data = await fetchDartList(apiKey, bgnDe, endDe);
    const items = pickItems(data.rows);
    const counts = {
      fetched: data.rows.length,
      matched: items.length,
      risk: items.filter((i) => i.kind === 'risk').length,
      watch: items.filter((i) => i.kind === 'watch').length,
      info: items.filter((i) => i.kind === 'info').length,
      interest: items.filter((i) => i.inInterest).length,
      interestRisk: items.filter((i) => i.inInterest && i.kind === 'risk').length,
    };
    const body = {
      ok: true,
      keySet: true,
      ...base,
      generatedAtKst: kstLabel(now),
      period: { bgnDe, endDe, days },
      counts,
      cleanInterest: counts.interestRisk === 0,
      items,
      notes: [
        'DART OpenAPI list.json(최근 ' + days + '일) 결과 중 관심 종목 공시와 위험·주목 키워드 공시만 표시합니다.',
        '공시 유형(위험/주목)은 공시명 키워드로 자동 분류한 것이며, 본문 해석·판단은 아닙니다.',
        '관심 종목: 8번 종베 10 + 6번 RN존 11 (중복 제거 ' + INTEREST.length + '종목)',
      ],
      sources: [{ name: 'opendart-list', ok: true }],
      cacheControl: CACHE_CONTROL,
      elapsedMs: Date.now() - started,
    };
    memCache.set(cacheKey, { at: Date.now(), value: body });
    res.setHeader('X-Cache', fresh ? 'BYPASS-fresh' : 'MISS');
    return sendJson(res, 200, body, CACHE_CONTROL);
  } catch (e) {
    const status = String(e.status || '');
    const keyInvalid = status === '010' || status === '011' || status === '012' || status === '020';
    return sendJson(res, 200, {
      ok: false,
      keySet: true,
      reason: keyInvalid ? 'DART_KEY_INVALID' : 'DART_UPSTREAM_FAILED',
      status: status || null,
      message: keyInvalid
        ? `DART 가 키를 거부했습니다(status ${status}). DART_API_KEY 값을 확인해 주세요. 기존 정적 스캔 결과를 유지합니다.`
        : `DART 조회 실패: ${e.message}. 기존 정적 스캔 결과를 유지합니다.`,
      ...base,
      errors: [String(e.message || e)],
      elapsedMs: Date.now() - started,
    }, NO_STORE);
  }
};

// 테스트(test_local.mjs)에서 분류 규칙을 직접 검증할 수 있게 내보낸다.
module.exports.classifyReport = classifyReport;
module.exports.normalizeRow = normalizeRow;
module.exports.pickItems = pickItems;
module.exports.INTEREST = INTEREST;
module.exports.INTEREST_CODES = INTEREST_CODES;
