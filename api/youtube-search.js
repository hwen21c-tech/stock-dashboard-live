'use strict';

/**
 * GET  /api/youtube-search?q=<검색어>[&limit=5][&type=all|shorts]
 * POST /api/youtube-search        body: { "q": "...", "limit": 5, "type": "all" }
 *
 * 수익화 스튜디오(content-v2.html) 유튜브 검색 실연동.
 *  - YouTube Data API 키 없이 youtube.com 검색 결과 페이지의 ytInitialData JSON을 파싱한다.
 *  - 1차: https://www.youtube.com/results?search_query=... (HTML → ytInitialData)
 *  - 2차: 실패 시 youtubei/v1/search (InnerTube, 웹 클라이언트와 같은 공개 클라이언트 키)
 *  - 반환: { ok:true, query, type, limit, items:[{ videoId, title, channel, durationText,
 *           viewCountText, publishedText, thumbnail, url, isShorts }], source, fetchedAt, cached }
 *  - 원칙: 파싱이 막히면 가짜 데이터를 만들지 않고 { ok:false, error } 로 솔직하게 알린다.
 *  - 서버 인메모리 캐시 5분(인스턴스 재사용 시) — Vercel CPU·YouTube 호출 절약.
 */

const { DEFAULT_UA, sendJson, getQuery, safeHandler } = require('../lib/http');

const CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 80;

const MAX_LIMIT = 12;
const DEFAULT_LIMIT = 5;

const YT_HEADERS = {
  'User-Agent': DEFAULT_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  // EU 동의 인터스티셜을 건너뛰기 위한 공개 쿠키(로그인 정보 아님)
  'Cookie': 'CONSENT=YES+1; SOCS=CAI',
};

/** InnerTube(웹 클라이언트) 공개 클라이언트 키 — youtube.com 페이지에 실려 있는 값과 같다. */
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_CLIENT_VERSION = '2.20241126.00.00';

/* ---------------- 캐시 ---------------- */
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

/* ---------------- 텍스트/JSON 파싱 ---------------- */
function textOf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (typeof node.content === 'string') return node.content;
  if (Array.isArray(node.runs)) {
    return node.runs.map((r) => (r && (r.text || '')).toString()).join('');
  }
  return '';
}

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** 문자열 안에서 '{' 위치부터 짝이 맞는 '}' 까지 (문자열 리터럴 내부 중괄호 무시) */
function sliceObject(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** HTML에서 ytInitialData 객체를 뽑아 JSON으로 */
function parseYtInitialData(html) {
  const anchors = ['var ytInitialData = ', 'ytInitialData = ', 'window["ytInitialData"] = '];
  for (const a of anchors) {
    const i = html.indexOf(a);
    if (i < 0) continue;
    const j = html.indexOf('{', i + a.length);
    if (j < 0) continue;
    const blob = sliceObject(html, j);
    if (!blob) continue;
    try {
      return JSON.parse(blob);
    } catch (_) {
      /* 다음 앵커 시도 */
    }
  }
  return null;
}

/* ---------------- 결과 매핑 ---------------- */
function bestThumb(thumbs, fallbackId) {
  const list = Array.isArray(thumbs) ? thumbs.filter((t) => t && t.url) : [];
  if (!list.length) return fallbackId ? `https://i.ytimg.com/vi/${fallbackId}/mqdefault.jpg` : '';
  // 세로 쇼츠(oar2)는 405×720 이 최적, 가로 영상은 640~1280 중 큰 쪽
  let best = list[0];
  for (const t of list) {
    const w = Number(t.width) || 0;
    if (w >= (Number(best.width) || 0)) best = t;
  }
  return best.url;
}

function mapVideoRenderer(v) {
  const id = clean(v.videoId);
  if (!id) return null;
  let durationText = '';
  let isShorts = false;
  const overlays = Array.isArray(v.thumbnailOverlays) ? v.thumbnailOverlays : [];
  for (const o of overlays) {
    const t = o && o.thumbnailOverlayTimeStatusRenderer;
    if (!t) continue;
    if (t.text && !durationText) durationText = clean(textOf(t.text));
    if (String(t.style || '').toUpperCase() === 'SHORTS') isShorts = true;
  }
  if (!durationText) durationText = clean(textOf(v.lengthText));
  const title = clean(textOf(v.title));
  if (!title) return null;
  return {
    videoId: id,
    title,
    channel: clean(textOf(v.ownerText) || textOf(v.longBylineText) || textOf(v.shortBylineText)),
    durationText,
    viewCountText: clean(textOf(v.viewCountText) || textOf(v.shortViewCountText)),
    publishedText: clean(textOf(v.publishedTimeText)),
    thumbnail: bestThumb(v.thumbnail && v.thumbnail.thumbnails, id),
    url: isShorts ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
    isShorts,
  };
}

function mapShortsLockup(s) {
  const endpoint = s && s.onTap && s.onTap.innertubeCommand;
  const reel = endpoint && endpoint.reelWatchEndpoint;
  let id = clean(reel && reel.videoId);
  if (!id && typeof s.entityId === 'string') {
    const m = s.entityId.match(/([A-Za-z0-9_-]{11})$/);
    if (m) id = m[1];
  }
  if (!id) return null;
  const meta = s.overlayMetadata || {};
  let title = clean(textOf(meta.primaryText));
  const viewCountText = clean(textOf(meta.secondaryText));
  if (!title) {
    // accessibilityText: "<제목>, 조회수 N회 - Shorts 동영상 재생"
    title = clean(String(s.accessibilityText || '').split(',')[0]);
  }
  if (!title) return null;
  const srcs = s.thumbnailViewModel && s.thumbnailViewModel.thumbnailViewModel &&
    s.thumbnailViewModel.thumbnailViewModel.image &&
    s.thumbnailViewModel.thumbnailViewModel.image.sources;
  const reelThumbs = reel && reel.thumbnail && reel.thumbnail.thumbnails;
  return {
    videoId: id,
    title,
    channel: '',
    durationText: 'Shorts',
    viewCountText,
    publishedText: '',
    thumbnail: bestThumb(srcs, id) || bestThumb(reelThumbs, id),
    url: `https://www.youtube.com/shorts/${id}`,
    isShorts: true,
  };
}

/** ytInitialData 트리를 순서대로 훑어 videoRenderer / shortsLockupViewModel 을 모은다. */
function collectItems(node, out, depth) {
  if (!node || typeof node !== 'object' || depth > 60) return;
  if (Array.isArray(node)) {
    for (const x of node) collectItems(x, out, depth + 1);
    return;
  }
  if (node.videoRenderer) {
    const it = mapVideoRenderer(node.videoRenderer);
    if (it) out.push(it);
  }
  if (node.shortsLockupViewModel) {
    const it = mapShortsLockup(node.shortsLockupViewModel);
    if (it) out.push(it);
  }
  for (const k of Object.keys(node)) {
    const child = node[k];
    if (child && typeof child === 'object') collectItems(child, out, depth + 1);
  }
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || !it.videoId || seen.has(it.videoId)) continue;
    seen.add(it.videoId);
    out.push(it);
  }
  return out;
}

/* ---------------- 소스 1: 검색 결과 HTML ---------------- */
async function fetchViaHtml(q, timeout) {
  const url =
    'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&hl=ko&gl=KR';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: YT_HEADERS, signal: ctrl.signal, redirect: 'follow' });
    const html = await res.text();
    if (!res.ok) {
      const err = new Error(`youtube HTML HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = parseYtInitialData(html);
    if (!data) throw new Error('ytInitialData 파싱 실패(동의·차단 페이지 가능)');
    const items = [];
    collectItems(data, items, 0);
    return { items: dedupe(items), raw: items.length, htmlLength: html.length };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 소스 2: InnerTube search ---------------- */
async function fetchViaInnertube(q, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`,
      {
        method: 'POST',
        headers: {
          ...YT_HEADERS,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-YouTube-Client-Name': '1',
          'X-YouTube-Client-Version': INNERTUBE_CLIENT_VERSION,
          'Origin': 'https://www.youtube.com',
          'Referer': 'https://www.youtube.com/',
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: INNERTUBE_CLIENT_VERSION,
              hl: 'ko',
              gl: 'KR',
            },
          },
          query: q,
        }),
        signal: ctrl.signal,
      }
    );
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) {
      const err = new Error(`innertube HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const items = [];
    collectItems(json, items, 0);
    return { items: dedupe(items), raw: items.length };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 요청 파싱 ---------------- */
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      const sp = new URLSearchParams(req.body);
      const out = {};
      sp.forEach((v, k) => {
        out[k] = v;
      });
      return out;
    }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch (_) {
    const sp = new URLSearchParams(raw);
    const out = {};
    sp.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
}

function normType(t) {
  const s = String(t || '').toLowerCase();
  return s === 'shorts' || s === 'short' ? 'shorts' : 'all';
}

function clampLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(v)));
}

/* ---------------- 핸들러 ---------------- */
async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.end();
    return;
  }

  const isPost = req.method === 'POST';
  const qs = getQuery(req);
  const body = isPost ? await readBody(req) : {};

  const q = clean((body && body.q) || qs.q || '');
  if (!q) {
    return sendJson(res, 400, {
      ok: false,
      error: '검색어(q)가 없습니다.',
      usage: 'GET /api/youtube-search?q=성수동 카페 쇼츠&limit=5&type=all|shorts',
    }, 'no-store');
  }
  if (q.length > 80) {
    return sendJson(res, 400, { ok: false, error: '검색어가 너무 깁니다(최대 80자).' }, 'no-store');
  }

  const type = normType((body && body.type) || qs.type);
  const limit = clampLimit((body && body.limit) || qs.limit);
  const key = `${type}|${limit}|${q.toLowerCase()}`;

  const hit = cacheGet(key);
  if (hit) {
    res.setHeader('X-YT-Provider', hit.provider || 'html');
    res.setHeader('X-YT-Cache', 'hit');
    return sendJson(res, 200, { ...hit, cached: true }, 'public, s-maxage=300, stale-while-revalidate=900');
  }

  const attempts = [];
  let picked = null;

  try {
    const r = await fetchViaHtml(q, 8000);
    attempts.push({ via: 'html', ok: true, count: r.items.length });
    picked = { ...r, provider: 'html' };
  } catch (e) {
    attempts.push({ via: 'html', ok: false, error: String((e && e.message) || e) });
  }

  if (!picked || !picked.items.length) {
    try {
      const r = await fetchViaInnertube(q, 8000);
      attempts.push({ via: 'innertube', ok: true, count: r.items.length });
      if (r.items.length || !picked) picked = { ...r, provider: 'innertube' };
    } catch (e) {
      attempts.push({ via: 'innertube', ok: false, error: String((e && e.message) || e) });
    }
  }

  if (!picked) {
    return sendJson(res, 200, {
      ok: false,
      query: q,
      type,
      limit,
      items: [],
      error: '유튜브 검색 결과를 가져오지 못했습니다(HTML·InnerTube 모두 실패).',
      attempts,
      fetchedAt: new Date().toISOString(),
    }, 'no-store');
  }

  const source = picked.items.filter((it) => (type === 'shorts' ? it.isShorts : true));
  const items = source.slice(0, limit);

  if (!items.length) {
    return sendJson(res, 200, {
      ok: true,
      query: q,
      type,
      limit,
      items: [],
      note: type === 'shorts'
        ? '쇼츠 결과를 찾지 못했습니다. 다른 검색어로 시도해 보세요.'
        : '검색 결과가 비어 있습니다.',
      attempts,
      source: 'youtube',
      provider: picked.provider,
      fetchedAt: new Date().toISOString(),
    }, 'no-store');
  }

  const out = {
    ok: true,
    query: q,
    type,
    limit,
    items,
    total: picked.items.length,
    source: 'youtube',
    provider: picked.provider,
    fetchedAt: new Date().toISOString(),
  };
  cacheSet(key, out);
  res.setHeader('X-YT-Provider', picked.provider);
  res.setHeader('X-YT-Cache', 'miss');
  return sendJson(res, 200, { ...out, cached: false }, 'public, s-maxage=300, stale-while-revalidate=900');
}

const guarded = safeHandler(handler, { label: 'youtube-search' });
/* 로컬 테스트용 내부 함수 노출(응답에는 영향 없음) */
guarded.__internals = { parseYtInitialData, collectItems, dedupe, mapVideoRenderer, mapShortsLockup };

module.exports = guarded;
