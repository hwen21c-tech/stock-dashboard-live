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
 *  · 캐시: 인스턴스 메모리 90초 + CDN public, s-maxage=120, stale-while-revalidate=300
 *    (?fresh=1 → 메모리 캐시 무시)
 *    - 공시는 하루에 몇 건 단위라 2분 캐시로도 '지금 공시'를 놓치지 않고, 체커의 두 번째 조회부터는
 *      DART 왕복(첫 조회 3~6초) 없이 CDN 이 즉시 답한다.
 *
 * 응답 규칙
 *   - 확인된 공시만 담는다. 접수일·공시명·종목코드는 DART 응답 그대로.
 *   - 공시 유형은 이름 키워드로만 분류한다(위험 / 주목 / 일반).
 *   - 관심 종목은 8번 종베 10종목 + 6번 RN존 11종목 + 1번 테마 32종목(중복 제거).
 */

const { fetchJson, fetchBuffer, sendJson, getQuery, kstLabel } = require('../lib/http');

const CACHE_CONTROL = 'public, s-maxage=120, stale-while-revalidate=300';
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

/**
 * list.json 은 한 번에 100건까지만 준다(하루 공시가 수천 건).
 * 그래서 한 장만 받고 '전수'라고 말하지 않는다.
 *  · 최신 공시 1페이지: 키워드(위험/주목) 스캔용
 *  · 주요사항보고(B) 2페이지 · 지분공시(D) 1페이지: 위험 공시가 몰리는 유형은 넓게 본다
 *  · 스캔한 건수와 그 유형의 전체 건수를 같이 내려 화면에서 범위를 밝힌다.
 */
const SCANS = [
  { key: 'recent', label: '최신 공시', pageNo: 1, pblntfTy: null, pageCount: 100 },
  { key: 'major1', label: '주요사항보고(B)', pageNo: 1, pblntfTy: 'B', pageCount: 100 },
  { key: 'major2', label: '주요사항보고(B)', pageNo: 2, pblntfTy: 'B', pageCount: 100 },
  { key: 'major3', label: '주요사항보고(B)', pageNo: 3, pblntfTy: 'B', pageCount: 100 },
  { key: 'equity1', label: '지분공시(D)', pageNo: 1, pblntfTy: 'D', pageCount: 100 },
];

async function fetchDartPage(apiKey, bgnDe, endDe, scan) {
  let url =
    'https://opendart.fss.or.kr/api/list.json' +
    `?crtfc_key=${encodeURIComponent(apiKey)}` +
    `&bgn_de=${bgnDe}&end_de=${endDe}` +
    `&page_count=${scan.pageCount || 100}&page_no=${scan.pageNo || 1}` +
    '&sort=date&sort_mth=desc';
  if (scan.pblntfTy) url += `&pblntf_ty=${scan.pblntfTy}`;
  if (scan.corpCode && /^\d{8}$/.test(String(scan.corpCode))) url += `&corp_code=${scan.corpCode}`;
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
  // 유형별 상한을 두어 위험 공시가 많아도 주목(수주·지분) 목록이 잘리지 않게 한다
  const caps = { risk: 12, watch: 10, info: 5 };
  const used = { risk: 0, watch: 0, info: 0 };
  const out = [];
  items.forEach((it) => {
    if (out.length >= MAX_ITEMS) return;
    if (used[it.kind] >= caps[it.kind]) return;
    used[it.kind] += 1;
    out.push(it);
  });
  return out;
}

/* ======================================================================
   🔍 종목별 공시 조회 (?code=6자리&name=종목명)
   ----------------------------------------------------------------------
   체커가 한 종목을 조회할 때 그 종목의 최근 공시를 '그 회사만' 조회한다.
   · 위의 list.json 전체 스캔은 하루 수천 건 중 100건 × 5장만 보므로,
     특정 종목의 공시를 '전수'로 말할 수 없다(그래서 관심종목·위험키워드만 표시).
   · DART list.json 은 종목코드로 검색해 주지 않고 corp_code 만 받는다. 그래서
     ① DART 공시검색에 6자리 종목코드를 넣어 그 회사의 고유번호(corp_code)를 찾고
        (실측: 005380→현대자동차 00164742, 053800→안랩 00298270. 회사명이 아니라 종목코드로도 찾힌다),
     ② OpenDART company.json 으로 '주식종목코드(stock_code)'가 요청한 종목코드와 같은지 확인한 뒤
     ③ list.json?corp_code=… 로 그 회사만 조회한다(엉뚱한 회사 공시를 붙이지 않는다).
   · 고유번호 전체 파일(corpCode.xml)은 약 8MB 라 서버리스 20초 예산에 걸려 쓰지 않는다.
   · 키·회사·응답을 확인하지 못하면 ok:false + reason 그대로 → 화면은 '미확인'.
   ====================================================================== */

const DART_SEARCH_URL = 'https://dart.fss.or.kr/dsab007/detailSearch.ax';
const DART_COMPANY_URL = 'https://opendart.fss.or.kr/api/company.json';
const STOCK_LOOKBACK_DAYS = 30;
const STOCK_MAX_ITEMS = 12;
const CORP_SEARCH_MAX = 5;

const corpCodeCache = new Map(); // stockCode → { corpCode, corpName, stockCode } | null

/** DART 공시검색(회사) HTML 에서 { corpCode, name } 후보를 뽑는다. */
function parseCorpCandidates(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\s+href="javascript:openCorpInfoNew\('(\d{8})'[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const corpCode = m[1];
    if (seen.has(corpCode)) continue;
    const text = String(m[3] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const title = String(m[2] || '').replace(/\s*기업개황.*$/, '').trim();
    const name = text || title || null;
    if (!name) continue;
    seen.add(corpCode);
    out.push({ corpCode, name });
  }
  return out;
}

async function searchCorpCandidates(name) {
  const url =
    DART_SEARCH_URL +
    '?textCrpNm=' + encodeURIComponent(name) +
    '&option=corp&pageGrouping=1&currentPage=1&maxResults=15&sort=date&series=desc';
  const buf = await fetchBuffer(url, {
    timeout: 8000,
    headers: { Accept: 'text/html,application/xhtml+xml', Referer: 'https://dart.fss.or.kr/' },
  });
  let html = buf.toString('utf8');
  if (/ã|ë|ì|í/.test(html.slice(0, 4000))) {
    try { html = new TextDecoder('euc-kr').decode(buf); } catch (_) {}
  }
  return parseCorpCandidates(html);
}

/** OpenDART company.json — 고유번호가 정말 이 종목코드의 회사인지 확인한다. */
async function fetchCompanyInfo(apiKey, corpCode) {
  const d = await fetchJson(
    DART_COMPANY_URL + '?crtfc_key=' + encodeURIComponent(apiKey) + '&corp_code=' + encodeURIComponent(corpCode),
    { timeout: 7000 },
  );
  if (!d || String(d.status) !== '000') return null;
  const stockCode = String(d.stock_code || '').trim();
  return {
    corpCode,
    corpName: d.corp_name || d.stock_name || null,
    stockCode: /^\d{6}$/.test(stockCode) ? stockCode : null,
    corpCls: d.corp_cls || null,
  };
}

async function resolveCorpCode(apiKey, stockCode, name, fresh) {
  if (!fresh && corpCodeCache.has(stockCode)) return corpCodeCache.get(stockCode);
  let hit = null;
  /* ① 종목코드로 회사 찾기 — DART 공시검색은 6자리 코드도 받는다 */
  const queries = [stockCode];
  const nm = String(name || '').replace(/\s+/g, ' ').trim();
  if (nm) queries.push(nm);
  for (const q of queries) {
    let cands = [];
    try {
      cands = await searchCorpCandidates(q);
    } catch (e) {
      cands = [];
    }
    if (nm) cands.sort((a, b) => (a.name === nm ? 0 : 1) - (b.name === nm ? 0 : 1));
    /* 후보 회사 확인은 병렬로 — 예전에는 최대 5번을 차례로 불러 첫 조회가 3~6초 걸렸다.
       같은 결과(‘stock_code 가 요청 코드와 같은 회사’)를 먼저 얻으면 즉시 끝낸다. */
    const checks = await Promise.allSettled(
      cands.slice(0, CORP_SEARCH_MAX).map((c) => fetchCompanyInfo(apiKey, c.corpCode)),
    );
    for (const r of checks) {
      if (r.status === 'fulfilled' && r.value && r.value.stockCode === stockCode) {
        hit = r.value;
        break;
      }
    }
    if (hit) break;
  }
  corpCodeCache.set(stockCode, hit);
  if (corpCodeCache.size > 800) {
    const oldest = corpCodeCache.keys().next();
    if (!oldest.done) corpCodeCache.delete(oldest.value);
  }
  return hit;
}

/* 정기보고서·IR 안내처럼 모든 상장사가 내는 '절차 공시' — 신호로 삼지 않는다 */
const ROUTINE_RULES = ['분기보고서', '반기보고서', '사업보고서', '감사보고서', '기업설명회', 'IR개최', '소유상황보고서', '소유주식변동'];

/* '최대주주등소유주식변동신고서'는 최대주주가 바뀐 공시가 아니라 주주 지분 변동 신고다.
   공시명 키워드('최대주주')만 보고 '최대주주 변경'으로 읽지 않도록 종목 조회에서만 먼저 걸러 낸다. */
function classifyStockReport(reportNm) {
  const nm = String(reportNm || '');
  if (nm.indexOf('소유주식변동') >= 0 || nm.indexOf('소유상황보고서') >= 0) {
    return { kind: 'info', label: '주식 소유 변동 신고', keyword: null };
  }
  return classifyReport(nm);
}

function isRoutineReport(reportNm) {
  const nm = String(reportNm || '');
  return ROUTINE_RULES.some((kw) => nm.indexOf(kw) >= 0);
}

/**
 * 종목 공시 신호
 *  · red   = 위험 키워드(유증·CB·감자·횡령·소송 등)
 *  · yellow= 주목(수주·최대주주·실적 등) 또는 절차 공시가 아닌 일반 공시
 *  · green = 위험이 없고, 있다면 정기보고서·IR 같은 절차 공시뿐
 */
function stockSignalOf(items) {
  const risk = items.filter((i) => i.kind === 'risk');
  if (risk.length) {
    return {
      key: 'red',
      label: '🔴 투자주의·희석성 공시 주의',
      note: `${risk[0].kindLabel} 등 위험 키워드 공시 ${risk.length}건`,
    };
  }
  const notable = items.filter((i) => i.kind === 'watch' || !isRoutineReport(i.reportNm));
  if (notable.length) {
    return {
      key: 'yellow',
      label: '🟡 최근 공시 확인 필요',
      note: `${notable[0].kindLabel} 등 공시 ${notable.length}건 — 위험 키워드는 없음`,
    };
  }
  if (items.length) {
    return {
      key: 'green',
      label: '🟢 공시·경보 이상 없음',
      note: `정기보고서·IR 안내 ${items.length}건뿐 — 위험·주목 키워드 없음`,
    };
  }
  return { key: 'green', label: '🟢 공시·경보 이상 없음', note: '조회 기간 안에 이 회사 공시가 없습니다' };
}

async function handleStockDart(res, q, fresh) {
  const code = String(q.code || '').trim();
  const generatedAtKst = kstLabel(new Date());
  const days = Math.min(Math.max(Number(q.days) || STOCK_LOOKBACK_DAYS, 1), 120);
  const apiKey = process.env.DART_API_KEY;
  const base = {
    mode: 'stock',
    code,
    lookbackDays: days,
    generatedAt: new Date().toISOString(),
    generatedAtKst,
  };

  if (!apiKey || !String(apiKey).trim()) {
    return sendJson(
      res,
      200,
      {
        ok: false,
        ...base,
        keySet: false,
        reason: 'DART_API_KEY_NOT_SET',
        message: 'DART_API_KEY 가 없어 이 종목의 공시를 확인하지 못했습니다.',
        signal: { key: 'unknown', label: '⚪ 공시 미확인', note: 'DART 키 미설정' },
        items: [],
      },
      NO_STORE,
    );
  }

  const now = new Date();
  const endDe = ymd(now);
  const bgnDe = ymd(new Date(now.getTime() - (days - 1) * DAY_MS));
  const cacheKey = `stock:${code}|${bgnDe}|${endDe}`;
  if (!fresh) {
    const hit = memCache.get(cacheKey);
    if (hit && Date.now() - hit.at < MEM_TTL_MS) {
      res.setHeader('X-Cache', 'HIT-memory');
      return sendJson(res, 200, hit.value, CACHE_CONTROL);
    }
  }

  const started = Date.now();
  try {
    const corp = await resolveCorpCode(apiKey, code, q.name, fresh);
    if (!corp) {
      return sendJson(
        res,
        200,
        {
          ok: false,
          ...base,
          keySet: true,
          reason: 'corp_not_found',
          message: 'DART 에서 이 종목코드의 회사를 확인하지 못했습니다(상장 전·합병·코드 변경 등) — 개별주 공시를 확인할 수 없습니다.',
          signal: { key: 'unknown', label: '⚪ 공시 미확인', note: '회사 확인 실패' },
          items: [],
        },
        NO_STORE,
      );
    }
    const page = await fetchDartPage(apiKey, bgnDe, endDe, {
      key: 'stock',
      label: '종목 공시',
      pageNo: 1,
      pblntfTy: null,
      pageCount: 100,
      corpCode: corp.corpCode,
    });
    const items = [];
    const seen = new Set();
    (page.rows || []).forEach((d) => {
      const it = normalizeRow(d);
      if (!it.reportNm || !it.rceptNo || seen.has(it.rceptNo)) return;
      seen.add(it.rceptNo);
      const cls = classifyStockReport(it.reportNm);
      it.kind = cls.kind;
      it.kindLabel = cls.label;
      it.keyword = cls.keyword || null;
      items.push(it);
    });
    const rank = { risk: 0, watch: 1, info: 2 };
    items.sort((a, b) => (rank[a.kind] - rank[b.kind]) || String(b.rceptDate || '').localeCompare(String(a.rceptDate || '')));
    const counts = {
      total: items.length,
      risk: items.filter((i) => i.kind === 'risk').length,
      watch: items.filter((i) => i.kind === 'watch').length,
      info: items.filter((i) => i.kind === 'info').length,
    };
    const body = {
      ok: true,
      ...base,
      keySet: true,
      corpCode: corp.corpCode,
      corpName: corp.corpName,
      period: { bgnDe, endDe, days },
      counts,
      signal: stockSignalOf(items),
      items: items.slice(0, STOCK_MAX_ITEMS),
      totalCount: page.totalCount,
      fetched: page.rows.length,
      complete: page.totalCount !== null && page.rows.length >= page.totalCount,
      basis: 'DART OpenAPI · corp_code 기준 이 회사만 조회',
      sources: [{ name: 'opendart-list', ok: true }],
      errors: [],
      elapsedMs: Date.now() - started,
    };
    memCache.set(cacheKey, { at: Date.now(), value: body });
    res.setHeader('X-Cache', fresh ? 'BYPASS-fresh' : 'MISS');
    return sendJson(res, 200, body, CACHE_CONTROL);
  } catch (e) {
    const status = String(e.status || '');
    const keyInvalid = status === '010' || status === '011' || status === '012' || status === '020';
    return sendJson(
      res,
      200,
      {
        ok: false,
        ...base,
        keySet: true,
        reason: keyInvalid ? 'DART_KEY_INVALID' : status === '013' ? 'no_filings' : 'DART_UPSTREAM_FAILED',
        status: status || null,
        message: `이 종목의 공시를 조회하지 못했습니다: ${e.message}`,
        signal: { key: 'unknown', label: '⚪ 공시 미확인', note: 'DART 응답 실패' },
        items: [],
        errors: [String(e.message || e)],
        elapsedMs: Date.now() - started,
      },
      NO_STORE,
    );
  }
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

  // ?code=6자리 — 체커용 '이 종목 하나'의 최근 공시 (corp_code 기준 전수 조회)
  if (/^\d{6}$/.test(String(q.code || '').trim())) return handleStockDart(res, q, fresh);

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
    const settled = await Promise.allSettled(SCANS.map((s) => fetchDartPage(apiKey, bgnDe, endDe, s)));
    const rows = [];
    const byType = new Map(); // 'all' | 'B' | 'D' → { label, fetched, totalCount, pages, errors }
    const scanErrors = [];
    settled.forEach((s, i) => {
      const scan = SCANS[i];
      const type = scan.pblntfTy || 'all';
      if (!byType.has(type)) {
        byType.set(type, { label: scan.label, fetched: 0, totalCount: null, pages: 0, errors: 0 });
      }
      const acc = byType.get(type);
      acc.pages += 1;
      if (s.status === 'fulfilled') {
        rows.push(...s.value.rows);
        acc.fetched += s.value.rows.length;
        if (s.value.totalCount !== null) acc.totalCount = s.value.totalCount;
      } else {
        const msg = String((s.reason && s.reason.message) || s.reason);
        acc.errors += 1;
        scanErrors.push(`${scan.label}: ${msg}`);
      }
    });
    const coverage = Array.from(byType.entries()).map(([type, acc]) => ({
      type,
      label: acc.label,
      pages: acc.pages,
      fetched: acc.fetched,
      totalCount: acc.totalCount,
      // 같은 유형의 페이지를 모두 더해 그 유형 전체를 봤는지 판단한다
      complete: acc.errors === 0 && acc.totalCount !== null && acc.fetched >= acc.totalCount,
    }));
    if (!rows.length && scanErrors.length === SCANS.length) {
      throw new Error(scanErrors[0] || 'DART 응답 없음');
    }
    const items = pickItems(rows);
    const counts = {
      fetched: rows.length,
      matched: items.length,
      risk: items.filter((i) => i.kind === 'risk').length,
      watch: items.filter((i) => i.kind === 'watch').length,
      info: items.filter((i) => i.kind === 'info').length,
      interest: items.filter((i) => i.inInterest).length,
      interestRisk: items.filter((i) => i.inInterest && i.kind === 'risk').length,
    };
    const majorClass = coverage.find((c) => c.type === 'B') || null;
    const riskClassesComplete = Boolean(majorClass && majorClass.complete);
    const body = {
      ok: true,
      keySet: true,
      ...base,
      generatedAtKst: kstLabel(now),
      period: { bgnDe, endDe, days },
      counts,
      coverage,
      // 관심종목을 corp_code 로 직접 조회하진 않으므로 '전수'라고 단정하지 않는다
      interestComplete: false,
      riskClassesComplete,
      cleanInterest: counts.interestRisk === 0,
      items,
      notes: [
        'DART OpenAPI list.json 결과 중 관심 종목 공시와 위험·주목 키워드 공시만 표시합니다.',
        '공시 유형(위험/주목)은 공시명 키워드로 자동 분류한 것이며, 본문 해석·판단은 아닙니다.',
        'DART 는 한 번에 100건까지만 주므로 주요사항보고(B: 유상증자·CB·감자 등)는 3페이지까지 받아 전수 확인하고,',
        '지분공시(D)·전체 최신 공시는 첫 페이지만 스캔합니다(일부). 스캔 범위는 coverage 에 그대로 담습니다.',
        '관심 종목: 8번 종베 10 + 6번 RN존 11 (중복 제거 ' + INTEREST.length + '종목). corp_code 직접 조회는 하지 않습니다.',
      ],
      sources: [{ name: 'opendart-list', ok: true }],
      errors: scanErrors,
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
// 테스트용: 회사 후보 파싱·신호 판정은 실데이터로 검증할 수 있게 내보낸다.
module.exports._parseCorpCandidates = parseCorpCandidates;
module.exports._stockSignalOf = stockSignalOf;
module.exports._isRoutineReport = isRoutineReport;
module.exports._classifyStockReport = classifyStockReport;
module.exports.normalizeRow = normalizeRow;
module.exports.pickItems = pickItems;
module.exports.INTEREST = INTEREST;
module.exports.INTEREST_CODES = INTEREST_CODES;

/* 🛡️ 2026-11-27: 예기치 못한 예외가 500(빈 응답)으로 나가지 않도록 핸들러를 감싼다.
 *    · 프론트는 ok:false + reason:'internal_error' 를 받고 직전 값을 유지한다.
 *    · 테스트용으로 붙인 module.exports 속성은 그대로 보존한다. */
(function () {
  const __http = require('../lib/http');
  const __h = module.exports;
  if (typeof __h === 'function' && !__h.__guarded) {
    const __wrapped = __http.safeHandler(__h, { label: 'dart-live' });
    Object.assign(__wrapped, __h);
    __wrapped.__guarded = true;
    module.exports = __wrapped;
  }
})();
