'use strict';

/**
 * GET /api/picks-search?q=<검색어>[&limit=8]
 *
 * 추천샵(picks.html) 관리자용 실시간 최저가 검색.
 *  - 실측 소스: 에누리 가격비교(price.enuri.com) 검색 결과 + 상품 상세의 "최저가 판매처".
 *  - 반환: 상품명 · 최저가(원) · 판매처 · 썸네일 · 상세 URL · 구매(리다이렉트) URL + 쿠팡/테무/알리/네이버 검색 URL.
 *  - 원칙: 더미/가짜 데이터 0건. 소스가 막히면 ok:false 로 솔직하게 알린다.
 *
 * 실측 확인(2026-11-20, 로컬/Vercel 공통 헤더):
 *  - 네이버 쇼핑 API·웹검색 → 418/403 봇차단, 쿠팡 → 403, G마켓/옥션 → 403,
 *    11번가 → 520, SSG/롯데온/올리브영 → 403. 에누리만 HTTP 200 + 실상품 JSON 파싱 성공.
 */

const { DEFAULT_UA, sendJson, getQuery } = require('../lib/http');

const CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 60;

const SEARCH_HEADERS = {
  'User-Agent': DEFAULT_UA,
  Accept: 'text/x-component, text/html, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
  RSC: '1',
};

const SEARCH_URL = (q) => `https://price.enuri.com/search?keyword=${encodeURIComponent(q)}&_rsc=1`;
const CATALOG_URL = (id) => `https://price.enuri.com/catalog/${encodeURIComponent(id)}?_rsc=1`;

const EXCLUDE_CONDI = /(중고|렌탈|임대|반납|해외구매|전시|리퍼)/;

function cleanText(s) {
  return String(s || '')
    .replace(/\\u0026/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Next.js flight payload: 이스케이프된 JSON(\"...)을 풀어준다. */
function unescapeFlight(s) {
  return String(s || '')
    .replace(/\\\\"/g, '\\"')
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, '&');
}

/** start 위치의 '{'부터 짝이 맞는 '}'까지 잘라낸다(문자열 내부 중괄호 무시). */
function extractObject(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function jsonAfterKey(text, key) {
  const i = text.indexOf(key);
  if (i < 0) return null;
  const j = text.indexOf('{', i + key.length);
  if (j < 0) return null;
  const blob = extractObject(text, j);
  if (!blob) return null;
  try {
    return JSON.parse(blob);
  } catch (_) {
    return null;
  }
}

async function fetchText(url, timeout = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 검색 결과(인기순)에서 실상품만 뽑는다. */
function parseSearchList(html, limit) {
  const text = unescapeFlight(html);
  const data = jsonAfterKey(text, '"initProductList":');
  if (!data || !Array.isArray(data.items)) return { items: [], total: 0 };

  const items = [];
  for (const it of data.items) {
    if (!it || it.type === 'ad') continue;
    const name = cleanText(it.name);
    const price = it.priceInfo && Number(it.priceInfo.price);
    const id = String(it.id || '').trim();
    if (!id || !name || !price || price <= 0) continue;
    if (it.isSoldOut) continue;
    if (it.isRental) continue;
    if (EXCLUDE_CONDI.test(String(it.condiName || ''))) continue;
    const thumb = it.thumbnail || {};
    const rt = it.rating || {};
    items.push({
      id,
      name,
      condi: cleanText(it.condiName),
      listPrice: price,
      image: thumb.imageUrl || thumb.fallbackImageUrl || '',
      url: 'https://price.enuri.com' + (it.link || `/catalog/${id}`),
      mallCount: Number(it.mallCount) || 0,
      rating: Number(rt.ratingValue) || null,
      reviewCount: Number(rt.reviewCount) || null,
    });
    if (items.length >= limit) break;
  }
  const total = data.listCount && Number(data.listCount.total);
  return { items, total: total || 0 };
}

/** 상품 상세에서 "최저가 판매처"를 읽는다. */
function parseCatalogLowest(html) {
  const text = unescapeFlight(html);
  const sticky = jsonAfterKey(text, '"initStickyTabsInfo":');
  if (!sticky) return null;
  const price = Number(sticky.price);
  const mall = cleanText(sticky.mallName);
  if (!price || price <= 0) return null;
  return {
    price,
    mall,
    delivery: cleanText(sticky.deliveryText),
    buyUrl: /^https?:\/\//.test(String(sticky.purchaseLink || '')) ? sticky.purchaseLink : '',
  };
}

function searchUrls(q) {
  const e = encodeURIComponent(q);
  return {
    coupang: `https://www.coupang.com/np/search?q=${e}`,
    temu: `https://www.temu.com/search_result.html?search_key=${e}`,
    ali: `https://ko.aliexpress.com/w/wholesale-${encodeURIComponent(q.split(/\s+/).join('-'))}.html`,
    naver: `https://search.shopping.naver.com/search/all?query=${e}`,
    enuri: `https://price.enuri.com/search?keyword=${e}`,
  };
}

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next();
    if (!oldest.done) CACHE.delete(oldest.value);
  }
  CACHE.set(key, { at: Date.now(), value });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, 'no-store');
  }

  const qs = getQuery(req);
  const q = String(qs.q || '').replace(/\s+/g, ' ').trim();
  const limitRaw = parseInt(qs.limit, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 10) : 8;

  if (!q) {
    return sendJson(res, 400, { ok: false, error: 'q_required', message: '검색어(q)를 넣어 주세요.' }, 'no-store');
  }
  if (q.length > 60) {
    return sendJson(res, 400, { ok: false, error: 'q_too_long', message: '검색어는 60자 이하로 넣어 주세요.' }, 'no-store');
  }

  const cacheKey = `${limit}|${q.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.setHeader('X-Picks-Cache', 'hit');
    return sendJson(res, 200, cached, 'public, s-maxage=600, stale-while-revalidate=1800');
  }

  const malls = searchUrls(q);
  let html;
  try {
    html = await fetchText(SEARCH_URL(q), 11000);
  } catch (err) {
    return sendJson(
      res,
      200,
      {
        ok: false,
        reason: 'source_unreachable',
        q,
        malls,
        items: [],
        message: `에누리 가격비교 응답 실패(${err.status || 'network'}). 잠시 뒤 다시 시도해 주세요.`,
        source: 'enuri',
        fetchedAt: new Date().toISOString(),
      },
      'no-store'
    );
  }

  const { items: found, total } = parseSearchList(html, limit);
  if (!found.length) {
    const out = {
      ok: true,
      q,
      malls,
      items: [],
      total: total || 0,
      reason: 'no_result',
      message: '실제 판매 중인 상품을 찾지 못했습니다. 상품명을 조금 바꿔 보세요.',
      source: 'enuri',
      fetchedAt: new Date().toISOString(),
    };
    return sendJson(res, 200, out, 'public, s-maxage=120, stale-while-revalidate=300');
  }

  // 상세 페이지에서 최저가 판매처를 병렬로 확인 (실패 시 검색 목록 가격으로 폴백)
  const details = await Promise.all(
    found.map(async (it) => {
      try {
        const cat = await fetchText(CATALOG_URL(it.id), 8000);
        return parseCatalogLowest(cat);
      } catch (_) {
        return null;
      }
    })
  );

  const items = found.map((it, idx) => {
    const d = details[idx];
    const price = d && d.price ? d.price : it.listPrice;
    const seller = (d && d.mall) || (it.mallCount ? `에누리 최저가 (${it.mallCount}개 몰)` : '에누리 최저가');
    return {
      name: it.name,
      condi: it.condi,
      price,
      listPrice: it.listPrice,
      seller,
      delivery: (d && d.delivery) || '',
      image: it.image,
      url: it.url,
      buyUrl: (d && d.buyUrl) || '',
      mallCount: it.mallCount,
      rating: it.rating,
      reviewCount: it.reviewCount,
      priceVerified: !!(d && d.price),
    };
  });

  const out = {
    ok: true,
    q,
    items,
    total,
    malls,
    source: 'enuri',
    sourceName: '에누리 가격비교',
    fetchedAt: new Date().toISOString(),
  };
  cacheSet(cacheKey, out);
  res.setHeader('X-Picks-Cache', 'miss');
  return sendJson(res, 200, out, 'public, s-maxage=600, stale-while-revalidate=1800');
};
