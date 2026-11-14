'use strict';

/**
 * GET /api/content-generate?mode=stock|deals|topic&keyword=...&memo=...
 *
 * 콘텐츠 스튜디오가 쓰는 것과 **같은 엔진**으로 서버에서 원고를 만들어 JSON 으로 돌려준다.
 * (평일 15:45 자동 생성·전송 같은 무인 스케줄이 브라우저 없이 호출할 수 있게 해 두는 통로)
 *
 *  - mode=stock  : /api/stock-live + /api/tabs-live 실측 → 시황 블로그·쇼츠
 *  - mode=deals  : 공개된 /deals.html 의 실측 스캔 → 동탄 가족 나들이 원고·쇼츠
 *  - mode=topic  : keyword/memo 만으로 초안
 *  - format=md   : 본문 markdown 문자열도 함께
 */

const ENGINE = require('../public/content-engine.js');

function sendJson(res, code, body, cache) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
  if (cache) res.setHeader('Cache-Control', cache);
}

/** 같은 프로젝트의 서버리스 핸들러를 그대로 호출해 JSON 을 받아온다 */
function callHandler(handler, req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    const fakeRes = {
      statusCode: 200,
      headers: {},
      setHeader: function (k, v) { this.headers[k] = v; },
      write: function (c) { chunks.push(Buffer.from(c)); },
      end: function (c) {
        if (c) chunks.push(Buffer.from(c));
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch (e) { resolve(null); }
      }
    };
    const fakeReq = { method: 'GET', url: req.url || '/api', headers: {} };
    Promise.resolve(handler(fakeReq, fakeRes)).catch(reject);
  });
}

function parseDealsHtml(html) {
  const grabVar = function (name) {
    const re = new RegExp('var\\s+' + name + '\\s*=\\s*(\\[[\\s\\S]*?\\]);');
    const m = html.match(re);
    if (!m) return [];
    try { return JSON.parse(m[1]); } catch (e) { return []; }
  };
  const grabMeta = function () {
    const re = new RegExp('var\\s+DEALS_SCAN_META\\s*=\\s*(\\{[\\s\\S]*?\\});');
    const m = html.match(re);
    if (!m) return {};
    try { return JSON.parse(m[1]); } catch (e) { return {}; }
  };
  return { travelDeals: grabVar('travelDeals'), kidsDeals: grabVar('kidsDeals'), meta: grabMeta() };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    return res.end();
  }
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });

  const url = new URL(req.url, 'http://localhost');
  const mode = String(url.searchParams.get('mode') || 'stock').toLowerCase();
  const withMd = url.searchParams.get('format') === 'md';

  try {
    let content = null;
    if (mode === 'stock') {
      const [live, tabs] = await Promise.all([
        callHandler(require('./stock-live.js'), { url: '/api/stock-live' }),
        callHandler(require('./tabs-live.js'), { url: '/api/tabs-live' })
      ]);
      if (!live || !tabs || !live.ok || !tabs.ok) {
        return sendJson(res, 502, { ok: false, reason: 'upstream_failed', message: 'stock-live 또는 tabs-live 응답 실패' });
      }
      content = ENGINE.buildFromStocks({ live: live, tabs: tabs });
    } else if (mode === 'deals') {
      const host = req.headers.host || process.env.VERCEL_URL || 'stock-dashboard-live-6frm.vercel.app';
      const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(String(host));
      const proto = isLocal ? 'http' : (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
      const r = await fetch(`${proto}://${host}/deals.html`, { headers: { 'Cache-Control': 'no-cache' } });
      const html = await r.text();
      const deals = parseDealsHtml(html);
      if (!deals.travelDeals.length && !deals.kidsDeals.length) {
        return sendJson(res, 502, { ok: false, reason: 'no_deals_data' });
      }
      content = ENGINE.buildFromDeals({ deals: deals });
    } else if (mode === 'topic') {
      content = ENGINE.buildFromTopic({
        keyword: url.searchParams.get('keyword') || '',
        memo: url.searchParams.get('memo') || '',
        template: url.searchParams.get('template') || 'info'
      });
      if (!content) return sendJson(res, 400, { ok: false, reason: 'missing_keyword' });
    } else {
      return sendJson(res, 400, { ok: false, reason: 'unknown_mode', modes: ['stock', 'deals', 'topic'] });
    }

    const body = {
      ok: true,
      mode: mode,
      generatedAt: content.generatedAt,
      headline: content.headline,
      subline: content.subline,
      source: content.source,
      summary: content.summary,
      facts: content.facts,
      notices: content.notices,
      blog: {
        titles: content.blog.titles,
        metaDesc: content.blog.metaDesc,
        sections: content.blog.sections,
        cta: content.blog.cta,
        tags: content.blog.tags,
        markdown: withMd ? content.blog.markdown : undefined,
        markdownLength: content.blog.markdown.length
      },
      shorts: content.shorts
    };
    return sendJson(res, 200, body, 'public, s-maxage=60, stale-while-revalidate=120');
  } catch (e) {
    return sendJson(res, 500, { ok: false, reason: 'server_error', message: String((e && e.message) || e) });
  }
};
