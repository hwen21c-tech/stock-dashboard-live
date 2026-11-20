'use strict';

/**
 * GET /api/deals-shopping?q=돼지고기 국내산 1kg
 *  - 네이버 쇼핑 검색 API(최저가순)로 Top 5(상품명·가격·판매처·이미지·직통 링크) 반환.
 *  - NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 미설정 시 503이 아니라 200 + { ok:false, reason:"missing_naver_api_key" }
 *    → UI가 "키 연동 안내 카드"를 띄울 수 있게 한다.
 */

const { NAVER_HEADERS, fetchJson, parseNum, sendJson, getQuery } = require('./http');

const OK_CACHE = 'public, s-maxage=300, stale-while-revalidate=600';

const EXCLUDE_TITLE = /(중고|리퍼|리퍼비시|렌탈|임대|반납|전시품|당근|해외구매대행)/;

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function searchUrlFor(query) {
  return `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(query)}`;
}

function normalizeTitle(t) {
  return t.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/\s+/g, '').toLowerCase();
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end();
  }

  const q = getQuery(req);
  const query = String(q.q || q.query || '').trim();

  if (!query) {
    return sendJson(
      res,
      400,
      {
        ok: false,
        reason: 'missing_query',
        message: '?q=검색어 를 지정하세요. 예) /api/deals-shopping?q=돼지고기 국내산 1kg',
      },
      'no-store',
    );
  }

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return sendJson(
      res,
      200,
      {
        ok: false,
        reason: 'missing_naver_api_key',
        message:
          '네이버 쇼핑 검색 API 키가 아직 연결되지 않았습니다. Vercel 환경변수에 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET을 넣으면 실시간 최저가 Top 5가 바로 표시됩니다.',
        query,
        searchUrl: searchUrlFor(query),
        setup: {
          where: 'https://developers.naver.com/apps/#/register',
          envKeys: ['NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET'],
          note: '사용 API: 검색(쇼핑). 무료 일 25,000회.',
        },
      },
      'no-store',
    );
  }

  const displayParam = parseInt(q.display, 10);
  const display = Number.isFinite(displayParam) ? Math.min(Math.max(displayParam, 5), 50) : 20;
  const sort = ['asc', 'sim', 'date', 'dsc'].includes(q.sort) ? q.sort : 'asc';

  const url =
    'https://openapi.naver.com/v1/search/shop.json?query=' +
    encodeURIComponent(query) +
    `&display=${display}&start=1&sort=${sort}`;

  let payload;
  try {
    payload = await fetchJson(url, {
      headers: {
        ...NAVER_HEADERS,
        'X-naver-Client-Id': clientId,
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
      timeout: 8000,
    });
  } catch (e) {
    const status = e.status;
    return sendJson(
      res,
      status === 401 || status === 403 ? 502 : 502,
      {
        ok: false,
        reason:
          status === 401
            ? 'naver_api_auth_failed'
            : status === 403
              ? 'naver_api_forbidden'
              : 'naver_api_error',
        message:
          status === 401
            ? '네이버 API 인증에 실패했습니다. NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 값을 확인하세요.'
            : status === 403
              ? '네이버 API가 이 앱의 쇼핑 검색 권한을 허용하지 않았습니다. 개발자센터에서 "검색" API 사용 설정을 확인하세요.'
              : `네이버 쇼핑 API 호출 실패: ${e.message}`,
        query,
        searchUrl: searchUrlFor(query),
      },
      'no-store',
    );
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const cleaned = items
    .map((it) => {
      const title = stripTags(it.title);
      const price = parseNum(it.lprice);
      return {
        title,
        price,
        highPrice: parseNum(it.hprice),
        mall: it.mallName || null,
        brand: it.brand || it.maker || null,
        link: it.link || null,
        image: it.image || null,
        category: [it.category1, it.category2, it.category3, it.category4].filter(Boolean).join(' > ') || null,
        productType: it.productType || null,
      };
    })
    .filter((it) => it.title && it.price !== null && it.price > 0)
    .filter((it) => !EXCLUDE_TITLE.test(it.title))
    .filter((it) => !it.productType || it.productType === '1') // 1: 일반상품
    .sort((a, b) => a.price - b.price);

  const seen = new Set();
  const top = [];
  for (const it of cleaned) {
    const key = `${normalizeTitle(it.title).slice(0, 40)}|${it.price}|${it.mall || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    top.push(it);
    if (top.length >= 5) break;
  }

  return sendJson(
    res,
    200,
    {
      ok: true,
      query,
      sort,
      fetchedAt: new Date().toISOString(),
      total: payload.total || cleaned.length,
      count: top.length,
      lowest: top.length ? top[0].price : null,
      items: top.map((it, i) => ({ rank: i + 1, ...it })),
      searchUrl: searchUrlFor(query),
      source: 'naver-shopping-search-api',
    },
    OK_CACHE,
  );
};
