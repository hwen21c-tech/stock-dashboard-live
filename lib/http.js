'use strict';

/**
 * 공용 HTTP / 파싱 유틸.
 * Vercel Node 런타임(18+)과 로컬 Node 18+ 모두에서 동작하도록 전역 fetch만 사용한다.
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAVER_HEADERS = {
  'User-Agent': DEFAULT_UA,
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
  'Referer': 'https://m.stock.naver.com/',
};

/** timeout(ms)이 걸린 fetch. 응답 본문을 Buffer로 돌려준다. */
async function fetchBuffer(url, opts = {}) {
  const { timeout = 7000, headers = {}, ...rest } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      ...rest,
      headers: { 'User-Agent': DEFAULT_UA, ...headers },
      signal: ctrl.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${url}`);
      err.status = res.status;
      err.body = buf.toString('utf8').slice(0, 300);
      throw err;
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts = {}) {
  const buf = await fetchBuffer(url, opts);
  return JSON.parse(buf.toString('utf8'));
}

/** EUC-KR 응답(네이버 차트 XML) 디코딩 */
function decodeEucKr(buf) {
  try {
    return new TextDecoder('euc-kr').decode(buf);
  } catch (_) {
    return buf.toString('latin1');
  }
}

/** "1,234" / "1,234.5" / "12.3" 같은 문자열 → number (실패 시 null) */
function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[,\s원%]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === 'N/A') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "2조 6,869억" / "2,304억" / "1,234" → 원 단위 number */
function parseKoreanMoney(text) {
  if (!text) return null;
  const s = String(text).replace(/,/g, '');
  let total = 0;
  let matched = false;
  const jo = s.match(/([\d.]+)\s*조/);
  if (jo) {
    total += Number(jo[1]) * 1e12;
    matched = true;
  }
  const eok = s.match(/([\d.]+)\s*억/);
  if (eok) {
    total += Number(eok[1]) * 1e8;
    matched = true;
  }
  if (!matched) {
    const n = parseNum(s);
    return n === null ? null : n;
  }
  return Math.round(total);
}

/** 거래대금 표기: 4조 4,406억 / 2,304억 / 5,120만 */
function formatKoreanMoney(won) {
  if (won === null || won === undefined || !Number.isFinite(won)) return null;
  const abs = Math.abs(won);
  if (abs >= 1e12) {
    const jo = Math.floor(won / 1e12);
    const eok = Math.round((won % 1e12) / 1e8);
    return eok > 0 ? `${jo}조 ${eok.toLocaleString('ko-KR')}억` : `${jo}조`;
  }
  if (abs >= 1e8) return `${Math.round(won / 1e8).toLocaleString('ko-KR')}억`;
  if (abs >= 1e4) return `${Math.round(won / 1e4).toLocaleString('ko-KR')}만`;
  return won.toLocaleString('ko-KR');
}

/* Intl.DateTimeFormat 생성은 한 번만 — 요청마다 새로 만들면 CPU 가 그대로 쌓인다 */
const FMT_KO_KST = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const FMT_EN_KST_HM = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});

/** KST 기준 표시용 문자열 (예: 11-13 20:00) */
function kstLabel(input) {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const parts = FMT_KO_KST.formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ============================================================================
 * 🕒 세션 인식 CDN 캐시 — Vercel Fluid Active CPU 절감 (2026-11-26)
 * ----------------------------------------------------------------------------
 *  문제: 모든 API 가 하루 종일 같은 s-maxage(10~15초)로 캐시돼서, 장 마감·야간·
 *        주말에도 폰이 켜져 있으면 15초마다 함수가 다시 돌았다
 *        (07:24 'Fluid Active CPU 75%' 경고).
 *  해결: 시장이 쉬는 시간에는 s-maxage 를 늘려 함수 호출 자체를 줄인다.
 *        · 평일 08:00~20:00 (프리마켓~애프터마켓) : 원래 값 그대로 — 실시간성 유지
 *        · 평일 20:00~24:00 : 최소 60초
 *        · 평일 00:00~08:00 : 최소 90초 (미장 선물·환율은 계속 움직이므로 너무 길게 두지 않는다)
 *        · 주말 : 최소 180초 (값이 바뀌지 않는 휴장일)
 *  사용자가 '🔄 즉시 새로고침'을 누르면 ?fresh=1 로 다른 URL 이 되어 CDN 캐시를
 *  건너뛰고(그 응답은 자체적으로 짧은 s-maxage) 바로 실측값을 받는다 — 기능 손해 없음.
 * ========================================================================== */
function kstSession(date) {
  const d = date instanceof Date ? date : new Date();
  const parts = FMT_EN_KST_HM.formatToParts(d);
  const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  const hh = Number(g('hour')) % 24;
  const mi = Number(g('minute'));
  const wd = g('weekday');
  const weekend = wd === 'Sat' || wd === 'Sun';
  const minutes = hh * 60 + mi;
  return { weekend, minutes, session: !weekend && minutes >= 8 * 60 && minutes < 20 * 60 };
}

/** 캐시 정책 문자열의 s-maxage/stale-while-revalidate 를 세션에 맞춰 늘린다(줄이지는 않는다). */
function stretchCacheControl(policy, date) {
  if (!policy || typeof policy !== 'string') return policy;
  if (/no-store/i.test(policy)) return policy;
  const m = policy.match(/s-maxage=(\d+)/);
  if (!m) return policy;
  const base = Number(m[1]);
  const swrM = policy.match(/stale-while-revalidate=(\d+)/);
  const swr = swrM ? Number(swrM[1]) : base * 2;
  const s = kstSession(date);
  let minSmax = 0;
  let minSwr = 0;
  if (s.session) {
    minSmax = 0;
  } else if (s.weekend) {
    minSmax = 180;
    minSwr = 600;
  } else if (s.minutes >= 20 * 60) {
    minSmax = 60;
    minSwr = 300;
  } else {
    minSmax = 90;
    minSwr = 300;
  }
  const smax = Math.max(base, minSmax);
  const nswr = Math.max(swr, minSwr, smax * 2);
  if (smax === base && nswr === swr) return policy;
  return `public, s-maxage=${smax}, stale-while-revalidate=${nswr}`;
}

/** 응답 공통 헤더 (Vercel: s-maxage 로 CDN 캐시) */
function sendJson(res, status, body, cacheControl) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cacheControl) {
    const policy = stretchCacheControl(cacheControl);
    res.setHeader('Cache-Control', policy);
    /* Vercel Node 함수는 Cache-Control 만으로는 CDN 정책을 잡지 못하는 경우가 있어
       CDN-Cache-Control 도 같이 내린다(값이 다르면 CDN-Cache-Control 이 이긴다). */
    res.setHeader('CDN-Cache-Control', policy);
    res.setHeader('Vercel-CDN-Cache-Control', policy);
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.end(text);
}

function getQuery(req) {
  // Vercel은 req.query를 채워주지만 로컬 미니서버에서도 동작하도록 URL에서 직접 파싱한다.
  try {
    const host = req.headers.host || 'localhost';
    const u = new URL(req.url, `http://${host}`);
    const out = {};
    u.searchParams.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  } catch (_) {
    return {};
  }
}

/* ============================================================================
 * 🛡️ 수치 가드 (2026-11-27 전 탭·API 전수 감사)
 * ----------------------------------------------------------------------------
 *  왜: 11/26 테마 기준선에 +36.87% 같은 '국내 주식에 존재할 수 없는' 일일 등락률이
 *      섞여 사용자가 잡았다. 원인은 ①일봉 캐시(KRX 정규장 종가)와 ②화면·네이버가 쓰는
 *      기준(전일 NXT 최종 종가)의 기준가 차이다. 같은 뿌리에서 비중법사·홍인기 탈락
 *      리스트에도 +30% 초과 값이 남아 있었다.
 *  원칙: 값을 '만들어' 고치지 않는다. 숫자가 아니면 null, 하루 ±30%(가격제한)를 넘는
 *      일일 등락률은 suspect 로 표시해 평균·순위에서 빼고, 표시 단계에서는 원값을 따로
 *      남긴다. 진짜 예외(신규상장 첫날 등)는 호출부가 allow 로 상한을 올려 통과시킨다.
 * ========================================================================== */
const PCT_LIMIT = 30.0; // KRX/KOSDAQ 일일 가격제한 ±30%
const PCT_HARD_LIMIT = 100.0; // 이 이상은 신규상장 첫날로도 설명되지 않는 깨진 값

/** 숫자로 읽히면 유한한 number, 아니면 null (NaN·Infinity·''·'-' 차단) */
function finiteOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return parseNum(v);
  return null;
}

/**
 * 등락률 가드.
 *  → { value, suspect, raw }
 *   · 숫자가 아니면 value=null
 *   · |v| > hard(기본 100%) 이면 value=null (깨진 값 — raw 로만 남긴다)
 *   · |v| > limit(기본 30%) 이면 value 는 그대로 두고 suspect=true
 *     (표시는 하되 평균·순위·타일에서 빼고, 화면은 원값을 신뢰하지 않는다)
 */
function pctGuard(v, opts = {}) {
  const n = finiteOrNull(v);
  if (n === null) return { value: null, suspect: false, raw: null };
  const limit = finiteOrNull(opts.limit);
  const hard = finiteOrNull(opts.hard);
  const lim = limit === null ? PCT_LIMIT : limit;
  const hd = hard === null ? PCT_HARD_LIMIT : hard;
  if (Math.abs(n) > hd) return { value: null, suspect: true, raw: n };
  return { value: n, suspect: Math.abs(n) > lim, raw: n };
}

/** 등락률 → number|null (숫자가 아니거나 하드리밋 초과면 null) */
function safePct(v, opts) {
  return pctGuard(v, opts).value;
}

/** 거래대금·금액 → 0 이상 유한 number, 아니면 null (음수·NaN 차단) */
function safeMoney(v) {
  const n = finiteOrNull(v);
  if (n === null || n < 0) return null;
  return n;
}

/** 0으로 나누기·NaN 이 없는 나눗셈 */
function safeDiv(a, b) {
  const x = finiteOrNull(a);
  const y = finiteOrNull(b);
  if (x === null || y === null || y === 0) return null;
  const r = x / y;
  return Number.isFinite(r) ? r : null;
}

/**
 * 객체의 등락률 필드를 제자리에서 가드한다.
 *  · target[key] 를 정리하고, suspect 면 target.pctSuspect / target[key + 'Raw'] 를 남긴다.
 */
function annotatePct(target, key, opts = {}) {
  if (!target || typeof target !== 'object') return target;
  const g = pctGuard(target[key], opts);
  target[key] = g.value;
  if (g.suspect) {
    target.pctSuspect = true;
    if (g.raw !== null) target[key + 'Raw'] = g.raw;
  }
  return target;
}

/**
 * 응답 본문 전체를 훑어 등락률 필드를 가드한다(마지막 안전망).
 *  · PCT_KEYS 필드가 NaN/Infinity/문자면 null 로 바꾼다 → 화면 NaN 차단
 *  · 실제 값이 ±30% 를 넘으면 부모 객체에 pctSuspect:true 만 붙인다(값은 바꾸지 않는다)
 *    — 신규상장 첫날처럼 진짜 큰 값은 그대로 보여주되, 평균·순위·역할에서는 빠지게 한다.
 *  · 순환 참조·과도한 깊이는 건너뛴다(응답이 커도 CPU 를 쓰지 않게).
 */
const PCT_KEYS = new Set(['changePct', 'prevDayPct', 'overPct', 'livePct']);

function sanitizePctTree(root, opts = {}) {
  const keys = opts.keys || PCT_KEYS;
  const hard = finiteOrNull(opts.hard);
  const hardLim = hard === null ? PCT_HARD_LIMIT : hard;
  const stats = { nulled: 0, suspect: 0, hard: 0 };
  const seen = new Set();
  let budget = opts.budget || 60000; // 방문 노드 상한
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 12 || budget <= 0) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) {
        budget -= 1;
        if (budget <= 0) return;
        walk(v, depth + 1);
      }
      return;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') {
        walk(v, depth + 1);
        continue;
      }
      if (!keys.has(k)) continue;
      budget -= 1;
      if (v === null || v === undefined) continue;
      const n = finiteOrNull(v);
      if (n === null) {
        node[k] = null;
        node.pctGuard = 'nan';
        stats.nulled += 1;
        continue;
      }
      if (Math.abs(n) > hardLim) {
        stats.hard += 1;
        node.pctSuspect = true;
        continue;
      }
      if (Math.abs(n) > PCT_LIMIT) {
        if (node.pctSuspect !== true) stats.suspect += 1;
        node.pctSuspect = true;
      }
    }
  };
  walk(root, 0);
  return stats;
}

/**
 * API 핸들러 최종 안전망 — 어떤 예외가 나도 500(빈 응답) 대신 사유가 담긴 JSON 을 준다.
 * 프론트는 ok=false 를 보고 '직전 값 유지 + 사유 표기' 로 폴백한다.
 */
function safeHandler(fn, opts = {}) {
  const label = opts.label || 'api';
  return async function guardedHandler(req, res) {
    try {
      return await fn(req, res);
    } catch (err) {
      try {
        // 스택은 로그로만 남기고 응답에는 넣지 않는다
        console.error('[' + label + '] unhandled: ' + ((err && err.stack) || err));
      } catch (_) { /* noop */ }
      if (res.headersSent) {
        try { res.end(); } catch (_) { /* noop */ }
        return undefined;
      }
      const body = {
        ok: false,
        reason: 'internal_error',
        partial: true,
        guard: 'safeHandler',
        message: '서버에서 응답을 만들지 못했습니다. 화면은 직전 값을 유지하고 잠시 뒤 다시 시도합니다.',
        error: String((err && err.message) || err || '').slice(0, 200),
        at: new Date().toISOString(),
      };
      try {
        sendJson(res, 200, body, 'no-store');
      } catch (_) {
        try {
          res.statusCode = 200;
          res.end(JSON.stringify(body));
        } catch (_) { /* noop */ }
      }
      return undefined;
    }
  };
}

module.exports = {
  DEFAULT_UA,
  NAVER_HEADERS,
  fetchBuffer,
  fetchJson,
  decodeEucKr,
  parseNum,
  parseKoreanMoney,
  formatKoreanMoney,
  kstLabel,
  sleep,
  sendJson,
  stretchCacheControl,
  kstSession,
  getQuery,
  PCT_LIMIT,
  PCT_HARD_LIMIT,
  finiteOrNull,
  pctGuard,
  safePct,
  safeMoney,
  safeDiv,
  annotatePct,
  sanitizePctTree,
  PCT_KEYS,
  safeHandler,
};
