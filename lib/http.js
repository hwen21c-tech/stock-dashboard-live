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

/** KST 기준 표시용 문자열 (예: 11-13 20:00) */
function kstLabel(input) {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 응답 공통 헤더 (Vercel: s-maxage 로 CDN 캐시) */
function sendJson(res, status, body, cacheControl) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cacheControl) res.setHeader('Cache-Control', cacheControl);
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
  getQuery,
};
