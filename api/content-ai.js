'use strict';

/**
 * 🎬✍️ AI 콘텐츠 스튜디오 v2 — Gemini 서버리스 함수
 *
 * POST /api/content-ai
 *   { action: 'blog' | 'video_plan' | 'youtube_analyze' | 'blog_to_shorts', ... }
 * GET  /api/content-ai?ping=1   → { ok, keyConfigured, model, fallbacks }
 *
 * 원칙
 *  - 키는 process.env.GEMINI_API_KEY 하나만 읽는다. (코드·저장소에 키 문자열 없음)
 *  - 키가 없으면 503 + 친절한 안내 JSON (UI가 '키 미설정' 카드를 띄운다).
 *  - 모델이 503(UNAVAILABLE)/429(quota)로 밀리면 다음 모델로 자동 재시도하고,
 *    실제로 답한 모델을 응답의 model 필드에 정직하게 적는다.
 *  - 응답은 responseMimeType=application/json. 파싱이 깨지면 원문을 버리지 않고
 *    __raw 로 돌려주고 parsed=false 로 알린다(성공한 척하지 않는다).
 *  - 확인되지 않은 가격·수치·고유명사를 만들지 않도록 프롬프트에서 강하게 막고,
 *    결과에 [확인 필요] 자리와 함께 warnings 로 남긴다.
 */

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models/';
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// 429/타임아웃/오류 시 자동 폴백 — 1순위 lite-latest(3초대 응답) → 3 Flash(더 좋은 문장)
const FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-3-flash-preview'];
// thinkingConfig 를 400 INVALID_ARGUMENT 로 거절하는 모델 (실측 2026-11-17)
const THINKING_UNSUPPORTED = ['gemini-flash-lite-latest'];
// 응답 속도를 3~5초대로 낮추기 위한 thinking 예산 (3.8 Flash 는 기본 thinking 때문에 첫 토큰이 10초+ 걸린다)
const THINKING_OFF = { thinkingBudget: 0 };
const DEADLINE_MS = 50000; // Vercel maxDuration 60s 안에서 안전하게(직렬화·네트워크 여유 10초)
// 내 사진 4장(base64) 이 본문에 실려 온다 → 여유 있게. (Vercel 요청 본문 한도 4.5MB)
const MAX_BODY_BYTES = 4200 * 1024;
const MAX_INLINE_IMAGES = 4;
const MAX_INLINE_ONE = 2000 * 1024;
const MAX_INLINE_TOTAL = 3600 * 1024;
const FIRST_TOKEN_MS = 16000; // 첫 토큰이 이 시간 안에 안 오면 그 모델은 죽은 것으로 보고 다음 모델로
//                     (실측: 3 Flash 는 schema 응답에서 첫 토큰이 13.6초까지 걸렸다 → 16초로 잡는다)
const PRIMARY_COOLDOWN_MS = 90000; // 3.8 Flash 가 밀린 걸 확인한 뒤 90초는 대체 모델 우선

// warm 인스턴스에서만 유지되는 메모리 (콜드 스타트면 초기값으로 돌아간다)
let primaryDownUntil = 0;

const BAN_DEFAULT = [
  '알아보겠습니다',
  '결론적으로',
  '무엇보다도',
  '이번 포스팅에서는',
  '살펴보도록 하겠습니다',
  '~하는 것이 중요합니다',
  '그렇기 때문에',
  '정리해 보겠습니다',
];

/* ---------------------------------------------------------------- 응답 유틸 */

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(text);
}

function noKeyBody() {
  return {
    ok: false,
    reason: 'missing_gemini_key',
    message:
      'GEMINI_API_KEY가 설정되지 않았습니다. Vercel 프로젝트(sd_live) → Settings → Environment Variables 에 ' +
      'GEMINI_API_KEY 를 추가하고 Production 을 체크한 뒤 Redeploy 하면 생성 버튼이 켜집니다.',
    setup: [
      'aistudio.google.com → Get API key 에서 키 발급',
      'Vercel → sd_live → Settings → Environment Variables → GEMINI_API_KEY (Production)',
      'Redeploy 후 이 페이지에서 [연동 확인] 을 누르면 상태가 바뀝니다',
    ],
    keyConfigured: false,
    model: PRIMARY_MODEL,
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('body_too_large');
      err.code = 'body_too_large';
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    const err = new Error('invalid_json');
    err.code = 'invalid_json';
    throw err;
  }
}

const s = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max || 4000);

/* ---------------------------------------------------------------- 📸 무료 사진 (Pixabay → Wikimedia Commons) */

// Wikimedia 는 식별 가능한 User-Agent 를 요구한다(없으면 403).
const PHOTO_UA = 'yeonolang-content-studio/1.0 (personal blog helper; +https://github.com/hwen21c-tech)';
const PHOTO_MAX_N = 12;
const PHOTO_TIMEOUT_MS = 12000;
const PHOTO_DL_MAX_BYTES = 15 * 1024 * 1024;
// 사진 다운로드 프록시가 받아도 되는 호스트만 (열린 프록시·SSRF 방지)
const PHOTO_DL_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org', 'commons.wikimedia.org', 'cdn.pixabay.com', 'pixabay.com'];

function stripTags(v) {
  return String(v == null ? '' : v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJsonTimed(url, headers, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || PHOTO_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
      e.status = res.status;
      throw e;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Pixabay — PIXABAY_API_KEY 가 있을 때만. 없으면 null */
async function searchPixabay(q, n) {
  const key = String(process.env.PIXABAY_API_KEY || '').trim();
  if (!key) return null;
  const url =
    'https://pixabay.com/api/?key=' + encodeURIComponent(key) +
    '&q=' + encodeURIComponent(q) +
    '&image_type=photo&safesearch=true&order=popular&lang=en' +
    '&per_page=' + Math.max(3, Math.min(20, n));
  const j = await fetchJsonTimed(url, { 'User-Agent': PHOTO_UA, Accept: 'application/json' });
  const hits = Array.isArray(j.hits) ? j.hits : [];
  return hits
    .map((h) => ({
      id: 'px' + h.id,
      source: 'pixabay',
      title: s(h.tags, 90) || 'pixabay ' + h.id,
      thumb: h.previewURL || h.webformatURL || '',
      preview: h.webformatURL || h.previewURL || '',
      full: h.largeImageURL || h.webformatURL || h.previewURL || '',
      // 저장용 = 블로그에 쓰기 좋은 1280px (원본 대용량을 그대로 받지 않게)
      save: h.largeImageURL || h.webformatURL || h.previewURL || '',
      width: num(h.imageWidth, 0),
      height: num(h.imageHeight, 0),
      page: h.pageURL || '',
      author: s(h.user, 40),
      license: 'Pixabay License',
    }))
    .filter((p) => p.thumb && p.full);
}

/** Wikimedia Commons — 키 없이 동작하는 2순위 */
async function searchCommons(q, n) {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*' +
    '&generator=search&gsrnamespace=6&gsrlimit=' + Math.max(3, Math.min(20, n)) +
    '&gsrsearch=' + encodeURIComponent('filetype:bitmap ' + q) +
    '&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=960';
  const j = await fetchJsonTimed(url, { 'User-Agent': PHOTO_UA, Accept: 'application/json' });
  const pages = (j && j.query && j.query.pages) || [];
  const out = [];
  (Array.isArray(pages) ? pages : []).forEach((p) => {
    const ii = (p.imageinfo && p.imageinfo[0]) || null;
    if (!ii || !ii.url) return;
    const mime = String(ii.mime || '');
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return;
    if (num(ii.width, 0) < 600 || num(ii.height, 0) < 380) return;
    const meta = ii.extmetadata || {};
    const title = String(p.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]{3,4}$/i, '');
    out.push({
      id: 'wc' + p.pageid,
      source: 'wikimedia',
      title: s(title, 120),
      thumb: ii.thumburl || ii.url,
      preview: ii.thumburl || ii.url,
      full: ii.url,
      // 저장용 = 960px 썸네일(원본이 15MB를 넘는 사진이 흔하다)
      save: ii.thumburl || ii.url,
      width: num(ii.width, 0),
      height: num(ii.height, 0),
      page: ii.descriptionurl || ('https://commons.wikimedia.org/wiki/' + encodeURIComponent(String(p.title || ''))),
      author: s(stripTags(meta.Artist && meta.Artist.value), 60),
      license: s(stripTags(meta.LicenseShortName && meta.LicenseShortName.value), 40) || 'Wikimedia Commons',
    });
  });
  return out;
}

async function handlePhotos(res, u) {
  const q = s(u.searchParams.get('q'), 120).replace(/[<>"\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const n = Math.min(PHOTO_MAX_N, Math.max(3, parseInt(u.searchParams.get('n'), 10) || 6));
  if (!q) {
    return send(res, 400, { ok: false, reason: 'missing_query', message: '검색어(q)가 필요합니다. 예: ?action=photos&q=hanok village' });
  }
  const out = { ok: true, query: q, n, source: '', photos: [], tried: [] };
  const pixabayReady = !!(process.env.PIXABAY_API_KEY && String(process.env.PIXABAY_API_KEY).trim());

  if (pixabayReady) {
    try {
      const px = await searchPixabay(q, n);
      out.tried.push({ source: 'pixabay', ok: !!(px && px.length), count: px ? px.length : 0 });
      if (px && px.length) {
        out.source = 'pixabay';
        out.photos = px;
        return send(res, 200, out);
      }
    } catch (e) {
      out.tried.push({ source: 'pixabay', ok: false, error: String((e && e.message) || '').slice(0, 120) });
    }
  } else {
    out.tried.push({ source: 'pixabay', ok: false, error: 'PIXABAY_API_KEY 없음 → Wikimedia Commons 로 대체' });
  }

  const queries = [q];
  const shortQ = q.split(/\s+/).slice(0, 2).join(' ');
  if (shortQ && shortQ !== q) queries.push(shortQ);

  for (const query of queries) {
    try {
      const wm = await searchCommons(query, n);
      out.tried.push({ source: 'wikimedia', query, ok: !!(wm && wm.length), count: wm ? wm.length : 0 });
      if (wm && wm.length) {
        out.source = 'wikimedia';
        out.query = query;
        out.photos = wm;
        out.note = '사진마다 라이선스가 다릅니다 — 표기된 라이선스를 확인하세요.';
        return send(res, 200, out);
      }
    } catch (e) {
      out.tried.push({ source: 'wikimedia', query, ok: false, error: String((e && e.message) || '').slice(0, 120) });
    }
  }

  out.message = '이 검색어로 무료 사진을 찾지 못했습니다. 영어 명사 위주(예: hanok village, autumn park)로 바꿔 다시 찾아보세요.';
  return send(res, 200, out);
}

function safePhotoName(raw) {
  const base = String(raw == null ? '' : raw)
    .replace(/[\\/:*?"<>|\r\n]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80);
  if (!base) return 'photo.jpg';
  return /\.(jpe?g|png|webp|gif)$/i.test(base) ? base : base + '.jpg';
}

/** 원클릭 저장 — 이미지 바이트를 그대로 받아 파일명을 붙여 내려준다(브라우저 CORS 무관). */
async function handlePhotoDownload(res, u) {
  const rawTarget = String(u.searchParams.get('u') || u.searchParams.get('img_proxy') || '').trim();
  let target;
  try {
    target = new URL(rawTarget);
  } catch (_) {
    return send(res, 400, { ok: false, reason: 'bad_url', message: '이미지 주소(u 또는 img_proxy)가 올바르지 않습니다.' });
  }
  if (!/^https?:$/.test(target.protocol)) {
    return send(res, 400, { ok: false, reason: 'bad_protocol', message: 'http(s) 주소만 받습니다.' });
  }
  const host = target.hostname.toLowerCase();
  const known = PHOTO_DL_HOSTS.indexOf(host) > -1;
  if (!known) {
    // 무료 사진 DB 외 공식 홈페이지 이미지도 원클릭 저장할 수 있게 한다.
    // 단 사설·내부망·메타데이터 주소는 절대 열어 주지 않는다(SSRF 차단).
    try {
      target = await inspectPublicUrl(target.toString());
    } catch (e) {
      return send(res, 403, { ok: false, reason: 'host_not_allowed', message: String((e && e.message) || '허용되지 않은 주소입니다.').slice(0, 160) });
    }
  }
  const name = safePhotoName(u.searchParams.get('name'));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(target.toString(), { headers: { 'User-Agent': PHOTO_UA, Accept: 'image/*' }, signal: ctrl.signal });
    if (!r.ok) {
      return send(res, 502, { ok: false, reason: 'upstream_error', message: '원본 서버가 이미지를 주지 않았습니다(HTTP ' + r.status + ').' });
    }
    const declared = Number(r.headers.get('content-length') || 0);
    if (declared && declared > PHOTO_DL_MAX_BYTES) {
      return send(res, 413, { ok: false, reason: 'too_large', message: '이미지가 너무 큽니다(15MB 초과). 미리보기 이미지를 저장하세요.' });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return send(res, 502, { ok: false, reason: 'empty_image', message: '이미지가 비어 있습니다.' });
    if (buf.length > PHOTO_DL_MAX_BYTES) {
      return send(res, 413, { ok: false, reason: 'too_large', message: '이미지가 너무 큽니다(15MB 초과). 미리보기 이미지를 저장하세요.' });
    }
    const ct = String(r.headers.get('content-type') || '');
    res.statusCode = 200;
    res.setHeader('Content-Type', /^image\//.test(ct) ? ct : 'image/jpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(buf);
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return send(res, 504, {
      ok: false,
      reason: aborted ? 'timeout' : 'download_failed',
      message: aborted ? '이미지를 20초 안에 받지 못했습니다.' : '이미지를 받지 못했습니다: ' + String((e && e.message) || '').slice(0, 120),
    });
  } finally {
    clearTimeout(timer);
  }
}
/* ---------------------------------------------------------------- 🌐 공식 페이지 사진 (og:image · 본문 <img>) */

const PAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const OFFICIAL_TIMEOUT_MS = 13000;
const OFFICIAL_MAX_HTML = 1500 * 1024;
const OFFICIAL_MAX_IMAGES = 12;

function badUrl(message) {
  const e = new Error(message);
  e.code = 'blocked_url';
  return e;
}

/** 사설·루프백·링크로컬·메타데이터 주소인지 (SSRF 차단의 핵심) */
function ipIsPrivate(ip) {
  const s = String(ip || '').trim();
  if (!s) return true;
  if (s.indexOf(':') > -1) {
    const low = s.toLowerCase();
    if (low === '::1' || low === '::' || low === '0:0:0:0:0:0:0:1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(low)) return true; // fc00::/7 고유 로컬
    if (/^fe[89ab][0-9a-f]:/.test(low)) return true; // fe80::/10 링크 로컬
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (m) return ipIsPrivate(m[1]);
    return false;
  }
  const p = s.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 169 && p[1] === 254) return true; // 링크 로컬·클라우드 메타데이터
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
  if (p[0] >= 224) return true; // 멀티캐스트·예약
  return false;
}

/** 주소 검증: http(s) + 공인 호스트(DNS까지 확인). 통과하면 URL 객체, 아니면 blocked_url 오류. */
async function inspectPublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw == null ? '' : raw).trim());
  } catch (_) {
    throw badUrl('주소 형식이 올바르지 않습니다. https://… 로 시작하는 전체 주소를 넣어 주세요.');
  }
  if (!/^https?:$/.test(u.protocol)) throw badUrl('http·https 주소만 열 수 있습니다.');
  if (u.username || u.password) throw badUrl('아이디·비밀번호가 들어간 주소는 열지 않습니다.');
  const host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw badUrl('주소에 호스트가 없습니다.');
  if (host === 'localhost' || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host)) {
    throw badUrl('내부 주소(localhost·사설망)는 열지 않습니다.');
  }
  if (/^[\d.]+$/.test(host) || host.indexOf(':') > -1) {
    if (ipIsPrivate(host)) throw badUrl('사설 IP 주소는 열지 않습니다.');
    return u;
  }
  let addrs = [];
  try {
    addrs = await require('dns').promises.lookup(host, { all: true });
  } catch (_) {
    throw badUrl('주소를 찾지 못했습니다: ' + host);
  }
  if (!Array.isArray(addrs) || !addrs.length) throw badUrl('주소를 찾지 못했습니다: ' + host);
  if (addrs.some((a) => ipIsPrivate(a && a.address))) throw badUrl('사설망으로 연결되는 주소는 열지 않습니다.');
  return u;
}

function htmlUnesc(v) {
  return String(v == null ? '' : v)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

function metaTags(html) {
  const out = [];
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 80) {
    const tag = m[0];
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    const content = /content\s*=\s*["']([\s\S]*?)["']/i.exec(tag);
    if (key && content) out.push({ key: String(key[1]).toLowerCase(), value: htmlUnesc(content[1]) });
  }
  return out;
}

function metaGet(tags, keys) {
  for (const k of keys) {
    const hit = tags.filter((t) => t.key === k && t.value).map((t) => t.value)[0];
    if (hit) return hit;
  }
  return '';
}

function attrOf(tag, name) {
  const r = new RegExp(name + '\\s*=\\s*(["\'])([\\s\\S]*?)\\1', 'i').exec(tag);
  return r ? htmlUnesc(r[2]) : '';
}

/** 본문 <img>·CSS 배경 후보 — 1x1·로고·아이콘·팝업 같은 쓰레기 이미지는 거르고 크기로 정렬한다. */
const BAD_IMG_NAME = /(logo|icon|favicon|sprite|spacer|blank|pixel|1x1|loading|placeholder|btn|bullet|arrow|popup|notice|close|event_banner|sns|(^|[_\-/])pop([_\-./]|\d))/i;

function bodyImageCandidates(html, baseUrl) {
  const out = [];
  const push = (raw, alt, area) => {
    if (!raw || /^data:/i.test(raw) || /^blob:/i.test(raw)) return;
    if (/\.svg(\?|$)/i.test(raw)) return;
    if (/\{\{|%7B%7B/i.test(raw)) return;
    if (BAD_IMG_NAME.test(raw)) return;
    let abs;
    try {
      abs = new URL(raw, baseUrl).toString();
    } catch (_) {
      return;
    }
    if (/^https?:/i.test(abs) === false) return;
    // https 페이지에서 http 이미지는 브라우저가 막는다(혼합 콘텐츠) → https 로 올려 본다.
    if (/^http:\/\//i.test(abs) && /^https:\/\//i.test(finalUrl || '')) abs = 'https://' + abs.slice(7);
    out.push({ url: abs, alt: alt || '', area: area || 0 });
  };
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 80) {
    const tag = m[0];
    let src = attrOf(tag, 'data-src') || attrOf(tag, 'data-original') || attrOf(tag, 'data-lazy-src') || attrOf(tag, 'src');
    if (!src) {
      const ss = attrOf(tag, 'srcset');
      if (ss) src = ss.split(',')[0].trim().split(/\s+/)[0];
    }
    const w = Number(attrOf(tag, 'width') || 0);
    const h = Number(attrOf(tag, 'height') || 0);
    if ((w && w < 240) || (h && h < 160)) continue;
    push(src, attrOf(tag, 'alt'), w && h ? w * h : 0);
  }
  // CSS 배경 이미지(리조트 사이트는 대표 사진을 배경으로 까는 경우가 많다)
  const reBg = /background(?:-image)?\s*:\s*url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
  let b;
  while ((b = reBg.exec(html)) && out.length < 110) push(b[2], '', 0);
  // 중복 제거 + 큰 이미지 우선
  const seen = {};
  return out
    .filter((c) => {
      if (seen[c.url]) return false;
      seen[c.url] = 1;
      return true;
    })
    .sort((a, z) => z.area - a.area)
    .slice(0, 40);
}

/** 리다이렉트를 직접 따라가며 매 홉마다 공인 주소인지 다시 확인한다. */
async function fetchHtmlSafe(startUrl) {
  let current = startUrl;
  for (let hop = 0; hop < 5; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OFFICIAL_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(current.toString(), {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': PAGE_UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.6' },
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e && e.name === 'AbortError';
      const err = new Error(aborted ? '페이지가 13초 안에 응답하지 않았습니다.' : '페이지를 열지 못했습니다: ' + String((e && e.message) || '').slice(0, 120));
      err.code = aborted ? 'timeout' : 'fetch_failed';
      throw err;
    }
    if (r.status >= 300 && r.status < 400) {
      clearTimeout(timer);
      const loc = r.headers.get('location');
      if (!loc) {
        const err = new Error('리다이렉트 주소가 비어 있습니다(HTTP ' + r.status + ').');
        err.code = 'fetch_failed';
        throw err;
      }
      let next;
      try {
        next = new URL(loc, current);
      } catch (_) {
        throw badUrl('리다이렉트 주소가 올바르지 않습니다.');
      }
      current = await inspectPublicUrl(next.toString());
      continue;
    }
    if (!r.ok) {
      clearTimeout(timer);
      const err = new Error('페이지가 HTTP ' + r.status + ' 로 응답했습니다(차단·로그인 필요일 수 있습니다).');
      err.code = 'fetch_failed';
      throw err;
    }
    const ct = String(r.headers.get('content-type') || '').toLowerCase();
    if (ct && ct.indexOf('html') < 0 && ct.indexOf('text/plain') < 0) {
      clearTimeout(timer);
      const err = new Error('HTML 페이지가 아닙니다(' + ct.slice(0, 40) + ').');
      err.code = 'not_html';
      throw err;
    }
    let text = '';
    try {
      const buf = Buffer.from(await r.arrayBuffer());
      let charset = (/charset\s*=\s*([\w-]+)/i.exec(ct) || [])[1] || '';
      if (!charset){
        const head = buf.slice(0, 2048).toString('latin1');
        const m = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
        if (m) charset = m[1];
      }
      charset = String(charset || 'utf-8').toLowerCase();
      try {
        text = new TextDecoder(charset).decode(buf);
      } catch (_) {
        text = buf.toString('utf8');
      }
      text = text.slice(0, OFFICIAL_MAX_HTML);
    } catch (e) {
      clearTimeout(timer);
      const err = new Error('페이지 본문을 읽지 못했습니다.');
      err.code = 'fetch_failed';
      throw err;
    }
    clearTimeout(timer);
    // 자바스크립트·meta 로 다른 주소로 넘기는 짧은 껍데기 페이지면 한 번 더 따라간다.
    if (text.length < 4000 && hop < 3) {
      const rf =
        /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*url\s*=\s*([^"'>\s]+)/i.exec(text) ||
        /(?:window\.|document\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i.exec(text);
      if (rf && rf[1]) {
        let nextUrl = null;
        try {
          nextUrl = new URL(htmlUnesc(rf[1]), current);
        } catch (_) {
          nextUrl = null;
        }
        if (nextUrl && /^https?:$/.test(nextUrl.protocol)) {
          current = await inspectPublicUrl(nextUrl.toString());
          continue;
        }
      }
    }
    return { html: text, finalUrl: current.toString() };
  }
  const err = new Error('리다이렉트가 너무 많습니다(4회 초과).');
  err.code = 'too_many_redirects';
  throw err;
}

function officialPagePhotos(html, finalUrl) {
  const tags = metaTags(html);
  const title = metaGet(tags, ['og:title', 'twitter:title']) || htmlUnesc((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
  const description = metaGet(tags, ['og:description', 'twitter:description', 'description']);
  const siteName = metaGet(tags, ['og:site_name']);
  const host = (() => {
    try {
      return new URL(finalUrl).hostname.replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  })();
  const found = [];
  const push = (url, via, label, area, alt) => {
    if (!url || !/^https?:/i.test(url)) return;
    if (BAD_IMG_NAME.test(url)) return;
    let abs = url;
    try {
      abs = new URL(url, finalUrl).toString();
    } catch (_) {
      return;
    }
    if (/^http:\/\//i.test(abs) && /^https:\/\//i.test(finalUrl || '')) abs = 'https://' + abs.slice(7);
    if (/\.svg(\?|$)/i.test(abs)) return;
    if (found.some((f) => f.url === abs)) return;
    found.push({ url: abs, via, label, area: area || 0, alt: String(alt || '').trim() });
  };
  push(metaGet(tags, ['og:image:secure_url', 'og:image:url', 'og:image']), 'og:image', '대표 이미지(og:image)', 999999);
  push(metaGet(tags, ['twitter:image', 'twitter:image:src']), 'twitter:image', '대표 이미지(twitter:image)', 900000);
  bodyImageCandidates(html, finalUrl).forEach((c) => push(c.url, 'body', '본문 사진', c.area, c.alt));
  found.sort((a, z) => z.area - a.area);
  const photos = found.slice(0, OFFICIAL_MAX_IMAGES).map((f, i) => ({
    id: 'of' + (i + 1),
    source: 'official',
    title: (f.alt && f.alt.length > 2 ? f.alt.slice(0, 90) : (title || host || '공식 페이지') +
      (f.via === 'body' ? ' · 본문 사진 ' + (i + 1) : (f.via === 'og:image' || f.via === 'twitter:image' ? ' · 대표 이미지' : ''))),
    thumb: f.url,
    preview: f.url,
    full: f.url,
    save: f.url,
    page: finalUrl,
    author: host,
    license: '출처: ' + (host || '공식 페이지') + (f.via === 'body' ? ' (본문 사진)' : ' (' + f.label + ')'),
    via: f.via,
  }));
  return { title, description, siteName, host, photos };
}

/* ------------------------------------------------ 🔗 내 블로거 글 → 양식 DNA 추출 (4번 양식)
   - 네이버 블로그는 PC 주소가 iframe 껍데기라 본문이 안 잡힌다 → 모바일 PostView 로 바꿔 받는다.
   - 사설 IP·DNS·리다이렉트·용량·시간 제한은 위의 fetchHtmlSafe 를 그대로 쓴다(SSRF 차단 동일).
   - 저작권: 본문 ‘문장’을 결과에 담지 않는다. 구조·호흡·기호·말투 특징만 남기고 최대 4,500자만 모델에 넘긴다. */
const BLOGGER_MAX_TEXT = 4500;

function naverBlogIds(raw) {
  const s0 = String(raw == null ? '' : raw).trim();
  const out = { blogId: '', logNo: '' };
  let m = /blog\.naver\.com\/([A-Za-z0-9_\-]+)\/(\d+)/.exec(s0);
  if (m) {
    out.blogId = m[1];
    out.logNo = m[2];
    return out;
  }
  try {
    const u = new URL(s0);
    const qBlog = (u.searchParams.get('blogId') || '').trim();
    const qLog = (u.searchParams.get('logNo') || '').trim();
    if (qBlog && qLog && /^\d+$/.test(qLog)) {
      out.blogId = qBlog;
      out.logNo = qLog;
      return out;
    }
    m = /\/PostView\.naver\/([A-Za-z0-9_\-]+)\/(\d+)/.exec(u.pathname);
    if (m) {
      out.blogId = m[1];
      out.logNo = m[2];
    }
  } catch (_) {}
  return out;
}

/** 받아야 할 주소를 정한다. 네이버 글은 모바일 PostView 로 바꿔 본문을 실제로 받아온다. */
function bloggerFetchTarget(raw) {
  const src = String(raw == null ? '' : raw).trim();
  const ids = naverBlogIds(src);
  if (ids.blogId && ids.logNo) {
    return {
      url: 'https://m.blog.naver.com/PostView.naver?blogId=' + encodeURIComponent(ids.blogId) + '&logNo=' + encodeURIComponent(ids.logNo),
      converted: /^https?:\/\/blog\.naver\.com\//i.test(src),
      blogId: ids.blogId,
      logNo: ids.logNo,
    };
  }
  return { url: src, converted: false, blogId: '', logNo: '' };
}

function stripBlock(html) {
  return String(html == null ? '' : html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

/** 네이버 스마트에디터 본문(se-main-container)만 골라 문단·인용구·소제목 흔적을 살린다. */
function extractNaverBody(html) {
  const lower = html.toLowerCase();
  const at = lower.indexOf('class="se-main-container"');
  if (at < 0) return '';
  let seg = html.slice(html.indexOf('>', at));
  for (const mark of ['id="post_footer"', 'class="post_footer', 'id="comment"']) {
    const k = seg.indexOf(mark);
    if (k > 2000) seg = seg.slice(0, k);
  }
  seg = seg.replace(/<div class="se-component se-image[\s\S]*?<\/div>\s*<\/div>/gi, '\n[사진]\n');
  seg = seg.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, (m) => '\n> ' + stripBlock(m).replace(/\s+/g, ' ').trim() + '\n');
  seg = seg.replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, _l, t) => '\n\n## ' + stripBlock(t).trim() + '\n');
  let text = stripBlock(seg)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\u200b/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  return text.split('\n').map((l) => l.trim()).filter((l, i, a) => l || (i && a[i - 1])).join('\n').trim();
}

/** 그 밖의 블로그·티스토리 등 — article/main/#content 후보에서 문단을 긁는다. */
function extractGenericBody(html) {
  const pick = (re) => {
    const m = re.exec(html);
    return m ? m[1] : '';
  };
  const cand =
    pick(/<article\b[^>]*>([\s\S]{200,})<\/article>/i) ||
    pick(/<div[^>]+(?:id|class)="(?:content|post|entry|article)[^"]*"[^>]*>([\s\S]{200,}?)<\/(?:div|section)>/i) ||
    pick(/<main\b[^>]*>([\s\S]{200,})<\/main>/i) ||
    '';
  let text = stripBlock(cand || html)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  return text.split('\n').map((l) => l.trim()).filter((l, i, a) => l || (i && a[i - 1])).join('\n').trim();
}

/** URL → { text, title, finalUrl, converted } / 본문을 못 읽으면 code:'body_not_found' */
async function readBloggerSource(rawUrl) {
  const target = bloggerFetchTarget(rawUrl);
  if (!target.url) throw badUrl('블로그 글 주소를 넣어 주세요.');
  /* 첫 홉도 반드시 검사한다(사설 IP·localhost·비http는 여기서 막힌다). fetchHtmlSafe 는 리다이렉트 홉만 재검사한다. */
  const safe = await inspectPublicUrl(target.url);
  const page = await fetchHtmlSafe(safe.toString());
  const html = page.html || '';
  const tags = metaTags(html);
  const title = metaGet(tags, ['og:title', 'twitter:title']) || htmlUnesc((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
  const author = metaGet(tags, ['naverblog:nickname']);
  let text = target.blogId ? extractNaverBody(html) : '';
  if (text.length < 300) text = extractGenericBody(html);
  if (text.length < 200) {
    const e = new Error('이 페이지에서는 글 본문을 읽지 못했습니다(로그인 필요·스크립트 렌더·차단).');
    e.code = 'body_not_found';
    throw e;
  }
  return {
    text: text.slice(0, BLOGGER_MAX_TEXT),
    chars: text.length,
    title: s(title.replace(/\s*:\s*네이버\s*블로그\s*$/, ''), 120),
    author: s(author, 40),
    finalUrl: page.finalUrl || target.url,
    converted: target.converted,
  };
}

/** 한국관광공사 TourAPI — 키가 설정된 환경에서만. 없으면 정직하게 건너뛴다. */
async function searchTourApi(q, n) {
  const key = String(process.env.KTO_API_KEY || process.env.TOUR_API_KEY || '').trim();
  if (!key) return { ok: false, reason: 'no_key' };
  const base = 'https://apis.data.go.kr/B551011/KorService1/';
  const common = '&MobileOS=ETC&MobileApp=yeonolang&_type=json';
  const listUrl =
    base + 'searchKeyword1?serviceKey=' + encodeURIComponent(key) +
    '&numOfRows=' + Math.max(3, Math.min(10, n || 6)) + '&pageNo=1' + common +
    '&keyword=' + encodeURIComponent(q);
  const j = await fetchJsonTimed(listUrl, { Accept: 'application/json' });
  const body = ((j || {}).response || {}).body || {};
  const items = body.items || {};
  const list = Array.isArray(items.item) ? items.item : (items.item ? [items.item] : []);
  const photos = [];
  list.forEach((it) => {
    const img = String(it.firstimage || it.firstimage2 || '').trim();
    if (!/^https?:/i.test(img)) return;
    photos.push({
      id: 'kto' + String(it.contentid || photos.length),
      source: 'kto',
      title: s(it.title, 80) + (it.addr1 ? ' · ' + s(it.addr1, 60) : ''),
      thumb: img,
      preview: img,
      full: img,
      save: img,
      page: 'https://korean.visitkorea.or.kr/detail/ms_detail.do?cotid=' + encodeURIComponent(String(it.contentid || '')),
      author: '한국관광공사',
      license: '출처: 한국관광공사 TourAPI',
    });
  });
  return { ok: photos.length > 0, photos, count: photos.length };
}

async function handleOfficialPhotos(res, u) {
  const rawUrl = s(u.searchParams.get('url'), 600);
  const place = s(u.searchParams.get('place') || u.searchParams.get('q'), 80).replace(/[<>"\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const n = Math.min(OFFICIAL_MAX_IMAGES, Math.max(3, parseInt(u.searchParams.get('n'), 10) || 8));
  const out = { ok: true, action: 'fetch_official_photos', url: rawUrl, place, sources: [], photos: [], notes: [] };

  if (!rawUrl && !place) {
    return send(res, 400, {
      ok: false,
      reason: 'missing_url',
      message: '리조트·장소의 공식 홈페이지 주소(url)나 장소명(place) 중 하나가 필요합니다.',
    });
  }

  /* ① 공식 URL 이 있으면 그 페이지의 대표 이미지·본문 사진을 뽑는다. */
  if (rawUrl) {
    try {
      const start = await inspectPublicUrl(rawUrl);
      const page = await fetchHtmlSafe(start);
      const got = officialPagePhotos(page.html, page.finalUrl);
      out.finalUrl = page.finalUrl;
      out.title = got.title;
      out.description = got.description;
      out.siteName = got.siteName;
      out.photos = got.photos;
      if (got.photos.length) out.sources.push({ key: 'official', label: '공식 홈페이지', count: got.photos.length, host: got.host });
      out.notes.push('출처: 공식 홈페이지(' + (got.host || '') + ') — 사진 사용 권한·출처 표기는 그 사이트 정책을 확인하세요.');
      if (!got.photos.length) {
        out.notes.push('이 페이지에서 대표 이미지(og:image)·본문 사진을 찾지 못했습니다. 페이지가 자바스크립트로 사진을 그리는 경우가 있습니다.');
        // 2차: 페이지가 알려 준 이름으로 공개 소스(위키미디어)를 한 번 더 본다 — 단 '공식 사진 아님'을 분명히 표시.
        const guess = (got.siteName || got.title || '').replace(/[|\-–—].*$/, '').replace(/[<>"\\]/g, ' ').trim();
        if (guess && guess.length >= 2 && guess.length <= 40) {
          try {
            const wm = await searchCommons(guess, Math.min(6, n));
            if (wm && wm.length) {
              wm.slice(0, Math.min(6, n)).forEach((p) => out.photos.push(Object.assign({}, p, { source: 'wikimedia', license: (p.license || 'Wikimedia Commons') + ' · 공식 사진 아님' })));
              out.sources.push({ key: 'wikimedia', label: '위키미디어 커먼즈(참고)', count: out.photos.length });
              out.notes.push('공식 페이지에서 사진을 못 찾아 「' + guess + '」로 위키미디어 커먼즈를 참고한 결과입니다 — 공식 홍보 사진이 아닐 수 있습니다.');
            }
          } catch (_) {}
        }
      }
    } catch (e) {
      out.ok = false;
      out.reason = e.code || 'fetch_failed';
      out.message = String((e && e.message) || '공식 페이지를 읽지 못했습니다.').slice(0, 200);
      out.notes.push('주소를 열지 못해 사진을 만들지 않았습니다. 값을 지어내지 않습니다.');
      if (e.code === 'blocked_url') return send(res, 400, out);
      return send(res, 200, out);
    }
  }

  /* ② 장소명만 있으면 공개 소스(관광공사 → 위키미디어)를 차례로 본다. */
  if (place) {
    try {
      const kto = await searchTourApi(place, n);
      if (kto.ok) {
        out.sources.push({ key: 'kto', label: '한국관광공사 TourAPI', count: kto.photos.length });
        kto.photos.slice(0, n).forEach((p) => out.photos.push(p));
      } else {
        out.notes.push(
          kto.reason === 'no_key'
            ? 'TourAPI 키가 설정되지 않아 관광공사 사진은 건너뛰었습니다(공개 소스만 사용).'
            : '관광공사 검색에서 사진을 찾지 못했습니다.'
        );
      }
    } catch (e) {
      out.notes.push('관광공사 검색 실패: ' + String((e && e.message) || '').slice(0, 80));
    }
    if (out.photos.length < n) {
      try {
        const wm = await searchCommons(place, n - out.photos.length);
        if (wm && wm.length) {
          out.sources.push({ key: 'wikimedia', label: '위키미디어 커먼즈', count: wm.length });
          wm.slice(0, n - out.photos.length).forEach((p) => out.photos.push(Object.assign({}, p, { source: 'wikimedia' })));
        }
      } catch (e) {
        out.notes.push('위키미디어 검색 실패: ' + String((e && e.message) || '').slice(0, 80));
      }
    }
    out.notes.push('위키미디어 사진은 사진마다 라이선스가 다릅니다 — 카드의 라이선스를 확인하고 출처를 남기세요.');
  }

  if (!out.photos.length && out.ok) {
    out.ok = false;
    out.reason = 'no_photo';
    out.message = '이 주소·장소에서 쓸 만한 사진을 찾지 못했습니다. 공식 홈페이지의 객실·전경 페이지 주소를 넣어 보세요.';
  }
  return send(res, 200, out);
}

const arr = (v, max) => (Array.isArray(v) ? v : []).slice(0, max || 12); 
const num = (v, fb) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};
const round1 = (n) => Math.round(n * 10) / 10;

/* ---------------------------------------------------------------- 🎬 유튜브 자막 추출 */

/**
 * 유튜브 링크 → 자막(스크립트) 텍스트.
 *  - 링크: youtube.com/watch?v= / youtu.be/ / /shorts/ / /embed/ / /live/ / 11자리 ID
 *  - 경로 3단: ① 유튜브 innertube(player) → captionTracks → timedtext
 *              ② 시청 페이지 HTML(ytInitialPlayerResponse) → captionTracks → timedtext
 *              ③ 공개 Invidious 계열 미러(/api/v1/captions) — 서버 IP가 봇으로 막힐 때
 *  - 자막이 없으면 oEmbed/플레이어 메타(제목·채널·길이·설명)만 돌려주고 '자막 없음'을 사실대로 알린다.
 *  - 실패를 감추지 않는다: 어느 경로에서 무엇이 막혔는지 errors[] 에 남긴다.
 */

const YT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const YT_SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const YT_ACCEPT_LANG = 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6';
const YT_TEXT_MAX = 16000;
const YT_ROUTE_BUDGET_MS = 22000; // 자막 경로 전체 예산(서버리스 60초 안에서 여유를 남긴다)
const YT_CACHE_MS = 10 * 60 * 1000;
const ytCache = new Map();

// 자막을 대신 받아 주는 공개 미러(순서대로 시도). 2026-11-18 실측: chocolatemoo53 은 한국어 자막 본문까지 정상.
const YT_MIRRORS = [
  'https://yt.chocolatemoo53.com',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://iv.melmac.space',
  'https://yewtu.be',
];

// innertube 클라이언트 — VISIONOS 는 자막 baseUrl 이 실제로 살아 있는 경로(실측)
const YT_CLIENTS = [
  {
    key: 'visionos',
    cid: '101',
    client: {
      clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1',
      osName: 'visionOS', osVersion: '26.5.23O471', hl: 'ko', gl: 'KR', userAgent: YT_SAFARI_UA,
    },
  },
  {
    key: 'web',
    cid: '1',
    client: { clientName: 'WEB', clientVersion: '2.20240814.00.00', hl: 'ko', gl: 'KR', userAgent: YT_UA },
  },
];

function ytVideoId(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
  let u = null;
  try {
    u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t);
  } catch (_) {
    return '';
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = (u.pathname.split('/').filter(Boolean)[0] || '').slice(0, 11);
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
  }
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return '';
  const v = String(u.searchParams.get('v') || '');
  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  const m = /\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
  return m ? m[1] : '';
}

async function ytFetch(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 10000);
  try {
    return await fetch(url, Object.assign({ redirect: 'follow' }, init || {}, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/** 문자열 안의 JSON 객체를 중괄호 균형으로 정확히 잘라낸다(정규식은 긴 HTML 에서 깨진다) */
function ytGrabObject(src, fromIdx) {
  const start = String(src).indexOf('{', fromIdx);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function ytPlayerOf(html) {
  const src = String(html || '');
  const idx = src.indexOf('ytInitialPlayerResponse');
  if (idx < 0) return null;
  const raw = ytGrabObject(src, idx);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function ytMetaFromPlayer(p) {
  const v = (p && p.videoDetails) || {};
  const len = Number(v.lengthSeconds);
  return {
    title: s(v.title, 200),
    author: s(v.author, 100),
    lengthSec: Number.isFinite(len) && len > 0 ? Math.round(len) : null,
    description: s(v.shortDescription, 4000),
  };
}

function ytTracksOf(p) {
  const t = p && p.captions && p.captions.playerCaptionsTracklistRenderer && p.captions.playerCaptionsTracklistRenderer.captionTracks;
  return Array.isArray(t) ? t : [];
}

function ytLangScore(t) {
  const lang = String((t && t.languageCode) || '').toLowerCase();
  const asr = String((t && t.kind) || '') === 'asr' ? 1 : 0;
  const rank = lang.indexOf('ko') === 0 ? 0 : lang.indexOf('en') === 0 ? 2 : 3;
  return rank * 2 + asr;
}

function ytPickTrack(tracks) {
  const list = (tracks || []).slice().sort((a, b) => ytLangScore(a) - ytLangScore(b));
  return list[0] || null;
}

function ytDecode(t) {
  return String(t == null ? '' : t)
    .replace(/&#(\d+);/g, (_, d) => {
      const n = parseInt(d, 10);
      return Number.isFinite(n) ? String.fromCodePoint(Math.min(0x10ffff, n)) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) ? String.fromCodePoint(Math.min(0x10ffff, n)) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function ytCleanLine(t) {
  return ytDecode(String(t == null ? '' : t).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function ytCuesFromJson3(text) {
  let j = null;
  try {
    j = JSON.parse(text);
  } catch (_) {
    return [];
  }
  const events = (j && Array.isArray(j.events) && j.events) || [];
  const out = [];
  events.forEach((e) => {
    const segs = (e && e.segs) || [];
    const line = ytCleanLine(segs.map((x) => (x && x.utf8) || '').join(''));
    if (line) out.push({ at: num(e.tStartMs, 0) / 1000, text: line });
  });
  return out;
}

function ytCuesFromVtt(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let cur = null;
  lines.forEach((raw) => {
    const t = raw.trim();
    if (!t) { cur = null; return; }
    if (/^WEBVTT/i.test(t) || /^Kind:/i.test(t) || /^Language:/i.test(t) || /^NOTE\b/i.test(t)) return;
    const tm = /^(\d{1,2}:\d{2}:\d{2}\.\d{1,3}|\d{2}:\d{2}\.\d{1,3})\s*-->/.exec(t);
    if (tm) {
      const parts = tm[1].split(':').map(Number);
      const at = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      cur = { at: at, text: '' };
      out.push(cur);
      return;
    }
    if (!cur) return;
    cur.text = ((cur.text ? cur.text + ' ' : '') + t).trim();
  });
  return out.map((c) => ({ at: c.at, text: ytCleanLine(c.text) })).filter((c) => c.text);
}

function ytCuesFromXml(text) {
  const out = [];
  const re = /<text[^>]*start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const line = ytCleanLine(m[2]);
    if (line) out.push({ at: num(m[1], 0), text: line });
  }
  return out;
}

/** 자동 자막의 롤링 중복을 걷어내고 읽기 좋은 줄로 잇는다 */
function ytJoinCues(cues) {
  const parts = [];
  let tail = '';
  (cues || []).forEach((c) => {
    const t = ytCleanLine(c && c.text).replace(/\s+/g, ' ').trim();
    if (!t) return;
    // 자동 자막은 앞 조각의 꼬리를 다시 겹처 준다. 겹치는 만큼만 잘라 새 부분만 붙인다.
    const max = Math.min(90, tail.length, t.length);
    let cut = 0;
    for (let k = max; k >= 8; k--) {
      if (tail.slice(-k).toLowerCase() === t.slice(0, k).toLowerCase()) {
        cut = k;
        break;
      }
    }
    const add = t.slice(cut).trim();
    if (!add) return;
    if (parts.length && parts[parts.length - 1] === add) return;
    parts.push(add);
    tail = (tail + ' ' + add).slice(-140);
  });
  let out = '';
  let line = '';
  parts.forEach((p) => {
    if (!line) line = p;
    else if (line.length + p.length + 1 <= 220) line += ' ' + p;
    else {
      out += (out ? '\n' : '') + line;
      line = p;
    }
  });
  if (line) out += (out ? '\n' : '') + line;
  return out;
}

/** timedtext — json3 → vtt → xml 순서로 시도. 빈 응답(자막 차단)이면 빈 배열 */
async function ytTimedText(baseUrl) {
  if (!baseUrl) return [];
  const tries = [
    { url: baseUrl + '&fmt=json3', kind: 'json3' },
    { url: baseUrl + '&fmt=vtt', kind: 'vtt' },
    { url: baseUrl, kind: 'xml' },
  ];
  for (const t of tries) {
    try {
      const r = await ytFetch(t.url, { headers: { 'User-Agent': YT_UA, 'Accept-Language': YT_ACCEPT_LANG } }, 9000);
      if (!r.ok) continue;
      const body = await r.text();
      if (!body || body.length < 20) continue;
      let cues = t.kind === 'json3' ? ytCuesFromJson3(body) : t.kind === 'vtt' ? ytCuesFromVtt(body) : ytCuesFromXml(body);
      if (!cues.length) {
        const vtt = ytCuesFromVtt(body);
        cues = vtt.length ? vtt : ytCuesFromXml(body);
      }
      if (cues.length) return cues;
    } catch (_) {}
  }
  return [];
}

async function ytRouteInnertube(id, errors) {
  for (const c of YT_CLIENTS) {
    try {
      const r = await ytFetch(
        'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': c.client.userAgent,
            'X-Youtube-Client-Name': c.cid,
            'X-Youtube-Client-Version': c.client.clientVersion,
            'Accept-Language': YT_ACCEPT_LANG,
          },
          body: JSON.stringify({ context: { client: c.client }, videoId: id, contentCheckOk: true, racyCheckOk: true }),
        },
        11000,
      );
      if (!r.ok) {
        errors.push('innertube/' + c.key + ': HTTP ' + r.status);
        continue;
      }
      const p = await r.json().catch(() => null);
      const status = (p && p.playabilityStatus && p.playabilityStatus.status) || '';
      const reason = (p && p.playabilityStatus && p.playabilityStatus.reason) || '';
      const meta = ytMetaFromPlayer(p);
      const tracks = ytTracksOf(p);
      if (!tracks.length) {
        errors.push('innertube/' + c.key + ': 자막 목록 없음' + (status ? ' (' + status + (reason ? ' · ' + String(reason).slice(0, 60) : '') + ')' : ''));
        continue;
      }
      const track = ytPickTrack(tracks);
      const cues = await ytTimedText(track && track.baseUrl);
      if (!cues.length) {
        errors.push('innertube/' + c.key + ': 자막 본문 비어 있음(차단)');
        continue;
      }
      return { route: 'innertube/' + c.key, meta, tracks, track, cues, errors };
    } catch (e) {
      errors.push('innertube/' + c.key + ': ' + String((e && e.message) || e).slice(0, 80));
    }
  }
  return null;
}

async function ytRouteWatch(id, errors) {
  try {
    const r = await ytFetch(
      'https://www.youtube.com/watch?v=' + encodeURIComponent(id) + '&hl=ko&gl=KR&has_verified=1&bpctr=9999999999',
      { headers: { 'User-Agent': YT_UA, 'Accept-Language': YT_ACCEPT_LANG } },
      12000,
    );
    if (!r.ok) {
      errors.push('watch: HTTP ' + r.status);
      return null;
    }
    const html = await r.text();
    const p = ytPlayerOf(html);
    if (!p) {
      errors.push('watch: 플레이어 정보를 찾지 못했습니다');
      return null;
    }
    const meta = ytMetaFromPlayer(p);
    const tracks = ytTracksOf(p);
    if (!tracks.length) {
      const st = (p.playabilityStatus && p.playabilityStatus.status) || '';
      const rs = (p.playabilityStatus && p.playabilityStatus.reason) || '';
      errors.push('watch: 자막 목록 없음' + (st ? ' (' + st + (rs ? ' · ' + String(rs).slice(0, 60) : '') + ')' : ''));
      return { route: 'watch', meta, tracks: [], track: null, cues: [], errors };
    }
    const track = ytPickTrack(tracks);
    const cues = await ytTimedText(track && track.baseUrl);
    if (!cues.length) {
      errors.push('watch: 자막 본문 비어 있음(차단)');
      return { route: 'watch', meta, tracks, track, cues: [], errors };
    }
    return { route: 'watch', meta, tracks, track, cues, errors };
  } catch (e) {
    errors.push('watch: ' + String((e && e.message) || e).slice(0, 80));
    return null;
  }
}

async function ytRouteMirror(id, started, errors) {
  for (const host of YT_MIRRORS) {
    if (Date.now() - started > YT_ROUTE_BUDGET_MS) {
      errors.push('mirror: 시간 예산 초과로 남은 미러 생략');
      break;
    }
    const name = host.replace(/^https:\/\//, '');
    try {
      let meta = { title: '', author: '', lengthSec: null, description: '' };
      let caps = [];
      try {
        const vr = await ytFetch(
          host + '/api/v1/videos/' + encodeURIComponent(id) + '?fields=title,author,lengthSeconds,description',
          { headers: { 'User-Agent': YT_UA, Accept: 'application/json' } },
          9000,
        );
        if (vr.ok) {
          const vj = await vr.json().catch(() => null);
          if (vj && !vj.error) {
            const len = Number(vj.lengthSeconds);
            meta = {
              title: s(vj.title, 200),
              author: s(vj.author, 100),
              lengthSec: Number.isFinite(len) && len > 0 ? Math.round(len) : null,
              description: s(vj.description, 4000),
            };
            caps = Array.isArray(vj.captions) ? vj.captions : [];
          }
        }
      } catch (_) {}
      if (!caps.length) {
        const cr = await ytFetch(host + '/api/v1/captions/' + encodeURIComponent(id), { headers: { 'User-Agent': YT_UA, Accept: 'application/json' } }, 9000);
        if (cr.ok) {
          const cj = await cr.json().catch(() => null);
          caps = (cj && Array.isArray(cj.captions) && cj.captions) || [];
        }
      }
      if (!caps.length) {
        errors.push('mirror/' + name + ': 자막 목록 없음');
        continue;
      }
      // 미러마다 필드명이 다르다(languageCode / language_code). 자동 생성 여부는 라벨로도 판별한다.
      const normCaps = caps
        .map((c) => ({
          languageCode: String((c && (c.languageCode || c.language_code)) || ''),
          kind: String((c && c.kind) || '') || (/\(auto-generated\)/i.test(String((c && c.label) || '')) ? 'asr' : ''),
          label: String((c && c.label) || ''),
          url: String((c && c.url) || ''),
        }))
        .filter((c) => c.url);
      if (!normCaps.length) {
        errors.push('mirror/' + name + ': 자막 URL 없음');
        continue;
      }
      const cap = normCaps.slice().sort((a, b) => ytLangScore(a) - ytLangScore(b))[0];
      const tr = await ytFetch(host + cap.url, { headers: { 'User-Agent': YT_UA, 'Accept-Language': YT_ACCEPT_LANG } }, 12000);
      const body = tr.ok ? await tr.text() : '';
      const cues = body ? (ytCuesFromVtt(body).length ? ytCuesFromVtt(body) : ytCuesFromXml(body)) : [];
      if (!cues.length) {
        errors.push('mirror/' + name + ': 자막 본문 비어 있음');
        continue;
      }
      return { route: 'mirror/' + name, meta, caps: normCaps, cap, cues, errors };
    } catch (e) {
      errors.push('mirror/' + name + ': ' + String((e && e.message) || e).slice(0, 80));
    }
  }
  return null;
}

async function ytOembed(id) {
  try {
    const r = await ytFetch(
      'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id),
      { headers: { 'User-Agent': YT_UA, Accept: 'application/json' } },
      8000,
    );
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j) return null;
    return { title: s(j.title, 200), author: s(j.author_name, 100), lengthSec: null, description: '' };
  } catch (_) {
    return null;
  }
}

const YT_LANG_LABEL = { ko: '한국어', en: '영어', ja: '일본어', 'zh-hans': '중국어(간체)', 'zh-hant': '중국어(번체)', de: '독일어', es: '스페인어', fr: '프랑스어', 'pt-br': '포르투갈어', ru: '러시아어' };

async function ytTranscript(id) {
  const started = Date.now();
  const errors = [];
  const out = {
    ok: false,
    action: 'youtube_transcript',
    videoId: id,
    url: 'https://www.youtube.com/watch?v=' + id,
    title: '',
    author: '',
    lengthSec: null,
    description: '',
    langCode: '',
    langLabel: '',
    auto: false,
    source: '',
    route: '',
    cuesNum: 0,
    chars: 0,
    truncated: false,
    text: '',
    notes: [],
    errors,
  };

  let hit = null;
  hit = await ytRouteInnertube(id, errors);
  if (!hit || !hit.cues.length) {
    const w = await ytRouteWatch(id, errors);
    if (w && w.cues.length) hit = w;
    else if (w && w.meta && !hit) hit = w;
  }
  if (!hit || !hit.cues.length) {
    const m = await ytRouteMirror(id, started, errors);
    if (m) hit = m;
  }

  const meta = (hit && hit.meta) || {};
  out.title = s(meta.title, 200);
  out.author = s(meta.author, 100);
  out.lengthSec = meta.lengthSec == null ? null : meta.lengthSec;
  out.description = s(meta.description, 4000);

  if (hit && hit.cues && hit.cues.length) {
    const text = ytJoinCues(hit.cues);
    const track = hit.track || hit.cap || null;
    out.ok = true;
    out.route = hit.route;
    out.source = hit.route.indexOf('mirror/') === 0 ? 'invidious-mirror' : hit.route.indexOf('innertube/') === 0 ? 'youtube-innertube' : 'youtube-watch';
    out.langCode = s(track && track.languageCode, 12) || '';
    out.langLabel = YT_LANG_LABEL[out.langCode.toLowerCase()] || out.langCode || '';
    out.auto =
      String((track && track.kind) || '') === 'asr' ||
      /auto-generated/i.test(String((track && track.label) || '')) ||
      /auto-generated/i.test(String((track && track.name && track.name.simpleText) || ''));
    out.cuesNum = hit.cues.length;
    out.chars = text.length;
    out.truncated = text.length >= YT_TEXT_MAX;
    out.text = text;
    out.notes.push('경로: ' + out.route + (out.auto ? ' · 자동 생성 자막(오탈자·오인식이 있을 수 있습니다)' : ''));
    if (out.truncated) out.notes.push('자막이 ' + YT_TEXT_MAX.toLocaleString('en-US') + '자를 넘어 앞부분만 담았습니다.');
    return out;
  }

  if (!out.title) {
    const oe = await ytOembed(id);
    if (oe) {
      out.title = oe.title;
      out.author = oe.author;
    }
  }

  if (!out.title) {
    out.reason = 'not_found';
    out.message = '이 영상의 정보를 가져오지 못했습니다. 링크가 비공개·삭제·연령 제한 영상이거나, 유튜브가 이 서버 IP를 막은 경우입니다.';
    return out;
  }

  out.reason = 'no_captions';
  out.message =
    '자막을 받지 못했습니다. 유튜브가 이 영상의 자막을 주지 않았거나(자막 없음), 서버 IP를 봇으로 막았습니다. ' +
    '제목·채널·설명만 가져왔으니 그 내용으로 진행하거나, 유튜브 화면에서 자막을 복사해 [참고 자료]에 붙여넣어 주세요.';
  return out;
}

async function handleYoutubeTranscript(res, body) {
  const raw = s(body.url || body.link || body.query || body.video, 300);
  const id = ytVideoId(raw);
  if (!id) {
    return send(res, 400, {
      ok: false,
      action: 'youtube_transcript',
      reason: 'bad_youtube_url',
      message: '유튜브 링크가 아닙니다. youtube.com/watch?v=… / youtu.be/… / /shorts/… 형식이나 11자리 영상 ID를 넣어 주세요.',
    });
  }
  const hit = ytCache.get(id);
  if (hit && Date.now() - hit.at < YT_CACHE_MS) {
    return send(res, 200, Object.assign({}, hit.value, { cached: true }));
  }
  let out;
  try {
    out = await ytTranscript(id);
  } catch (e) {
    return send(res, 200, {
      ok: false,
      action: 'youtube_transcript',
      videoId: id,
      reason: 'extract_failed',
      message: '자막 추출 중 오류가 났습니다: ' + String((e && e.message) || e).slice(0, 160),
    });
  }
  if (out.ok) ytCache.set(id, { at: Date.now(), value: out });
  return send(res, 200, out);
}

/* ---------------------------------------------------------------- 스키마 */

const SCHEMA_BLOG = {
  type: 'object',
  properties: {
    titles: {
      type: 'array',
      description: '제목 3종 — 호기심형 / 숫자 직격형 / 비교형 순서, 각 32자 이내',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['호기심형', '숫자 직격형', '비교형'] },
          text: { type: 'string' },
        },
        required: ['type', 'text'],
      },
    },
    seoKeywords: {
      type: 'array',
      description: '네이버 검색으로 실제 유입될 검색어 5~7개 (띄어쓰기 포함 한국어 명사구, # 없이) — 본문에 실제로 배치한 표현 그대로',
      items: { type: 'string' },
    },
    gaps: {
      type: 'array',
      description: '경쟁 인기 글이 비워 둔 빈틈 2개 — 각 1~2문장',
      items: { type: 'string' },
    },
    body: { type: 'string', description: '완성된 마크다운 본문 (표·도입 3줄 훅·[📸 사진: 묘사 | search: 영문검색어] 2~3곳·솔직한 단점·검색어 5~7개 자연 배치·끝에 해시태그 한 줄 포함)' },
    warnings: {
      type: 'array',
      description: '내가 확인하지 못해 [확인 필요]로 남긴 값·사실 목록',
      items: { type: 'string' },
    },
  },
  required: ['titles', 'gaps', 'body'],
};

const SCHEMA_VIDEO = {
  type: 'object',
  properties: {
    hooks: {
      type: 'array',
      description: '첫 2초 후킹 멘트 3종',
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: '질문형 · 숫자형 · 반전형 같은 짧은 유형명' },
          text: { type: 'string', description: '실제로 말할 문장 (25자 내외)' },
        },
        required: ['tag', 'text'],
      },
    },
    cuts: {
      type: 'array',
      description: '컷 설계도 — 편집 순서대로',
      items: {
        type: 'object',
        properties: {
          clipIndex: { type: 'integer', description: 'clips 배열의 0부터 시작하는 인덱스' },
          startSec: { type: 'number', description: '해당 클립의 in~out 안에서 잘라 쓸 시작 초' },
          endSec: { type: 'number', description: '해당 클립의 in~out 안에서 잘라 쓸 끝 초' },
          caption: { type: 'string', description: '이 컷에 깔 자막 한 줄' },
          transition: { type: 'string', enum: ['cut', 'fade', 'slide', 'zoom'] },
        },
        required: ['clipIndex', 'startSec', 'endSec', 'caption', 'transition'],
      },
    },
    bgm: {
      type: 'object',
      properties: {
        ducking: { type: 'string', description: '덕링 타이밍·세기 한 줄 지시' },
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['ducking'],
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['hooks', 'cuts', 'bgm'],
};

const SCHEMA_YT = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      description: '경쟁 영상이 비워 둔 빈틈 2가지',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '빈틈 한 줄 제목 (20자 내외)' },
          why: { type: 'string', description: '왜 비어 있는지 (1문장)' },
          how: { type: 'string', description: '내가 채우는 방법 (1문장)' },
        },
        required: ['title', 'why', 'how'],
      },
    },
    shorts: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '쇼츠 제목 (32자 이내)' },
        hook: { type: 'string', description: '첫 2초 후킹 멘트' },
        scenes: {
          type: 'array',
          description: '0~2초 후킹 → 3~40초 핵심 3컷 → 41~50초 엔딩',
          items: {
            type: 'object',
            properties: {
              time: { type: 'string', description: '예: 0-2초' },
              line: { type: 'string', description: '말할 문장 + 화면 지시' },
            },
            required: ['time', 'line'],
          },
        },
        cta: { type: 'string' },
      },
      required: ['title', 'hook', 'scenes'],
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['gaps', 'shorts'],
};

const SCHEMA_SHORTS = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '쇼츠 제목 (32자 이내)' },
    hook: { type: 'string', description: '0~2초 후킹 멘트' },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          time: { type: 'string', description: '예: 3-13초' },
          line: { type: 'string', description: '대사 + 자막/화면 지시' },
        },
        required: ['time', 'line'],
      },
    },
    ending: { type: 'string', description: '41~50초 엔딩 한 줄' },
    captionGuide: { type: 'string', description: '자막 스타일 권장 1줄' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'hook', 'scenes', 'ending'],
};

/* ---------------- 톤 변환 · AI 티 빼기 · 1타 3피 · SEO 태그 · 마무리 박스 스키마 */

const SCHEMA_REWRITE = {
  type: 'object',
  properties: {
    body: { type: 'string', description: '톤을 바꾼 완성 본문 (마크다운)' },
    changed: { type: 'array', description: '실제로 바꾼 점 2~4개 — 한 줄씩', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['body'],
};

const SCHEMA_NAVER = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '네이버 블로그용 제목 — 28자 이내, 검색어를 앞쪽에' },
    body: { type: 'string', description: '네이버 블로그용으로 다시 쓴 완성 본문 (마크다운 · 링크·사진 태그 없이)' },
    tags: { type: 'array', description: '네이버 검색 유입용 해시태그 10개 (# 없이)', items: { type: 'string' } },
    changed: { type: 'array', description: '원문과 실제로 다르게 쓴 점 2~4개', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'body'],
};

const SCHEMA_HUMANIZE = {
  type: 'object',
  properties: {
    body: { type: 'string', description: '사람 말투로 다듬은 완성 본문 (마크다운)' },
    removed: {
      type: 'array',
      description: '본문에서 실제로 걷어낸 기계적 상투어·수식어 (지운 것만, 없으면 빈 배열)',
      items: { type: 'string' },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['body'],
};

const SCHEMA_MULTI = {
  type: 'object',
  properties: {
    insta: {
      type: 'object',
      properties: {
        lines: { type: 'array', description: '인스타·스레드용 3줄 요약 — 각 45자 이내, 첫 줄이 훅', items: { type: 'string' } },
        hashtags: { type: 'array', description: '본문 소재 해시태그 10개 (# 없이)', items: { type: 'string' } },
      },
      required: ['lines', 'hashtags'],
    },
    shorts: SCHEMA_SHORTS,
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['insta', 'shorts'],
};

const SCHEMA_SEO = {
  type: 'object',
  properties: {
    keywords: {
      type: 'array',
      description: '네이버 검색 유입 키워드 10개 — 실제로 검색될 법한 한국어 명사 조합(띄어쓰기 포함, # 없이)',
      items: { type: 'string' },
    },
    hashtags: { type: 'array', description: '본문 기반 해시태그 10개 (# 없이, 공백 없는 형태)', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['keywords', 'hashtags'],
};

const SCHEMA_CLOSING = {
  type: 'object',
  properties: {
    question: { type: 'string', description: '본문 말미에 붙일 댓글 유도 질문 한 문장 (상투적인 "어떠셨나요?" 금지)' },
    boxTitle: { type: 'string', description: '링크 안내 박스 제목 (예: 🔗 이 글에서 나온 링크)' },
    items: {
      type: 'array',
      description: '박스에 넣을 안내 항목 2~3개 — label 은 무엇을 넣을지, hint 는 독자에게 필요한 이유',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '예: 예약·특가 링크' },
          hint: { type: 'string', description: '예: 요금은 날짜마다 다르니 예약 화면에서 확인' },
        },
        required: ['label', 'hint'],
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['question', 'items'],
};

/* 내 블로거(4번) 양식 자동 분석 — 구조·호흡·기호·말투 DNA만 뽑는다 */
const SCHEMA_STYLE = {
  type: 'object',
  properties: {
    styleName: { type: 'string', description: '블로그에서 확인되는 필명·블로그 이름 (모르면 "내 블로그")' },
    structure: {
      type: 'array',
      description: '이 글의 구성 뼈대 5~7단계 — 위에서부터 실제 순서대로, 각 20자 내외',
      items: { type: 'string' },
    },
    rhythm: { type: 'string', description: '문단 호흡 — 몇 문장씩 끊는지, 사진·표·인용구를 어디에 두는지 1~2문장' },
    symbols: {
      type: 'array',
      description: '실제로 쓰는 기호·박스 습관 3~5개 (예: > 소제목 인용구, 1️⃣ 단계 번호, | 표 |)',
      items: { type: 'string' },
    },
    tone: { type: 'string', description: '말투 DNA — 어미(해요체/반말/보도체), 1인칭 정도, 문장 길이를 1~2문장으로' },
    avoid: {
      type: 'array',
      description: '이 글에서 확인되는 금기·주의 2~4개 (예: 결말 스포 금지, 가격은 날짜와 함께)',
      items: { type: 'string' },
    },
  },
  required: ['styleName', 'structure', 'rhythm', 'symbols', 'tone'],
};

/* ✨ 2차 검수·다듬기 — 원문 구조는 유지하고 문장만 교정한다 */
const SCHEMA_PROOF = {
  type: 'object',
  properties: {
    body: { type: 'string', description: '교정을 마친 완성 본문 (원문의 소제목·표·[📸 사진] 자리·[확인 필요]를 그대로 유지)' },
    fixes: {
      type: 'array',
      description: '무엇을 고쳤는지 2~3줄 (각 40자 내외, 사실대로)',
      items: { type: 'string' },
    },
    warnings: { type: 'array', description: '발행 전에 사람이 확인해야 할 값·사실', items: { type: 'string' } },
  },
  required: ['body', 'fixes'],
};

/* 🎬 4번 내 유튜버/쇼츠 양식 자동 분석 — 훅·템포·자막·말투 DNA만 뽑는다 */
const SCHEMA_SHORTS_STYLE = {
  type: 'object',
  properties: {
    styleName: { type: 'string', description: '채널·영상에서 확인되는 이름 (모르면 "내 쇼츠")' },
    hook: { type: 'string', description: '첫 3초 훅 패턴 — 어떤 문장으로 시작하는지, 예시 패턴과 길이를 1~2문장' },
    pacing: { type: 'string', description: '컷·템포 리듬 — 몇 초마다 전환하는지, 한 컷의 문장 길이를 1~2문장' },
    captionRule: { type: 'string', description: '자막·기호 습관 — 한 줄 길이, 강조 방식, 이모지·숫자 표기 1~2문장' },
    tone: { type: 'string', description: '말투/성우 톤 — 어미, 속도, 감정 높낮이를 1~2문장' },
    avoid: {
      type: 'array',
      description: '이 채널이 지키는 금기·주의 2~4개 (예: 결말 스포 금지, 가격은 날짜와 함께)',
      items: { type: 'string' },
    },
  },
  required: ['styleName', 'hook', 'pacing', 'captionRule', 'tone'],
};

/* 🎬 쇼츠 대본 생성 — 3초 훅 · 컷별 대사·자막·화면 지시 */
const SCHEMA_SHORT_SCRIPT = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '쇼츠 제목 (32자 이내, 클릭하고 싶은 한 줄)' },
    titleOptions: {
      type: 'array',
      description: '쇼츠 제목 3안 — 호기심형 / 숫자 직격형 / 비교형 순서, 각 32자 이내',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['호기심형', '숫자 직격형', '비교형'] },
          text: { type: 'string' },
        },
        required: ['type', 'text'],
      },
    },
    hook: { type: 'string', description: '첫 3초에 실제로 말할 문장 (인사 없이 바로, 20자 내외)' },
    hookCaption: { type: 'string', description: '첫 3초 화면에 띄울 자막 (공백 포함 15~20자)' },
    beats: {
      type: 'array',
      description: '3초 훅 뒤 본문 컷 4~7개 — 시간 오름차순',
      items: {
        type: 'object',
        properties: {
          at: { type: 'string', description: '"0:03–0:09" 같은 초 구간 (겹치지 않게)' },
          spoken: { type: 'string', description: '이 컷에서 실제로 말할 문장 (한 컷에 1~2문장)' },
          caption: { type: 'string', description: '화면에 띄울 자막 (공백 포함 15~20자)' },
          shot: { type: 'string', description: '화면 지시 — 무엇을 찍거나 보여줄지 한 줄' },
        },
        required: ['at', 'spoken', 'caption', 'shot'],
      },
    },
    ending: {
      type: 'object',
      properties: {
        spoken: { type: 'string', description: '마지막 3~5초에 말할 문장 (여운 + 저장 유도)' },
        caption: { type: 'string', description: '마지막 자막 (15~20자)' },
      },
      required: ['spoken'],
    },
    captionGuide: { type: 'string', description: '자막 스타일 권장 1줄 — 어떤 폰트·위치·강조가 맞는지와 이유' },
    seriesBadge: { type: 'string', description: 'MP4 상단 칩용 시리즈 뱃지 (12자 이내 · 영문 2~3단어 대문자 또는 한글 8자)' },
    ttsVoice: { type: 'string', description: '나레이션 톤 지시 1줄 (예: "차분한 남성 · 또박또박 · 숫자는 또렷하게")' },
    hookTitle: { type: 'string', description: '첫 1.5초 화면 절반을 채우는 대형 훅 타이틀 (12자 이내 — 숫자·질문·반전 중 하나)' },
    highlightWords: { type: 'array', description: '카라오케 자막에서 노랗게 강조할 핵심 단어 3~6개 (숫자·고유명사 위주, 조사 없이)', items: { type: 'string' } },
    bgmMood: { type: 'string', description: 'BGM 분위기 한 단어 — news | calm | tension | upbeat 중 하나' },
    hookAB: {
      type: 'object',
      description: '첫 3초 훅 A/B 2버전 — 같은 사실을 경고형·기회형 두 심리 축으로',
      properties: {
        warning: { type: 'string', description: 'A 경고형: 손해·실수·위험을 먼저 던지는 첫 문장 (20자 내외)' },
        warningCaption: { type: 'string', description: 'A 경고형 화면 자막 (15~20자)' },
        opportunity: { type: 'string', description: 'B 기회형: 이득·숫자·반전을 먼저 던지는 첫 문장 (20자 내외)' },
        opportunityCaption: { type: 'string', description: 'B 기회형 화면 자막 (15~20자)' },
      },
      required: ['warning', 'opportunity'],
    },
    loopEnding: { type: 'string', description: '무한 루프 엔딩 문구 — 마지막 문장이 첫 훅으로 자연스럽게 이어지는 한 문장 (30자 내외)' },
    commentQuestion: { type: 'string', description: '댓글 유도 질문 1개 — 이지선다/경험형으로 답하기 쉽게' },
    pinnedComment: { type: 'string', description: '고정 댓글 문구 — 질문 재확인 + 추가 정보 1줄 + 저장 유도 (광고·링크 금지)' },
    reelsCaption: { type: 'string', description: '인스타 릴스 캡션 2~3줄 (첫 줄이 후킹, 마지막에 저장 유도)' },
    reelsHashtags: { type: 'array', description: '인스타 릴스 해시태그 8~12개 (# 없이)', items: { type: 'string' } },
    clipCaption: { type: 'string', description: '네이버 클립용 캡션 한 줄 (40자 내외)' },
    clipHashtags: { type: 'array', description: '네이버 클립 해시태그 5~8개 (# 없이)', items: { type: 'string' } },
    warnings: { type: 'array', description: '확인하지 못해 [확인 필요]로 남긴 값·사실', items: { type: 'string' } },
  },
  required: ['title', 'titleOptions', 'hook', 'hookCaption', 'hookTitle', 'beats', 'ending'],
};

/* ---------------------------------------------------------------- 📋 요약 (유튜브 · 문서 · 짧은 영상/음성) */

const SUMMARY_TEXT_MAX = 40000;                     // 요약에 넘기는 본문 상한(자)
const SUMMARY_MEDIA_MAX_BYTES = 4 * 1024 * 1024;    // 원본 파일 기준 4MB (사용자 지정 한도)
const SUMMARY_MEDIA_MIMES = [
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac',
  'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg',
];
const SUMMARY_MODES = ['three', 'timeline', 'table', 'handoff'];

const SCHEMA_SUMMARY = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '자료의 제목 — 원문·영상에 실제로 있는 제목만. 없으면 빈 문자열' },
    headline: { type: 'string', description: '한 줄 결론 (30자 내외, 이 자료가 말하는 바)' },
    three: {
      type: 'array',
      description: '3줄 핵심 결론 — 각 45자 내외, 결론→근거→그래서 무엇을 할지 순서',
      items: { type: 'string' },
    },
    timeline: {
      type: 'array',
      description: '시간·섹션 순서 정리 — 처음부터 끝까지 6~10구간',
      items: {
        type: 'object',
        properties: {
          at: { type: 'string', description: '시각·위치 — "0:42" · "1부" · "서론" 처럼. 없으면 빈 문자열' },
          label: { type: 'string', description: '이 구간의 이름 (12자 내외)' },
          point: { type: 'string', description: '이 구간에서 실제로 말한·나온 내용 한 줄 (60자 내외)' },
        },
        required: ['at', 'label', 'point'],
      },
    },
    facts: {
      type: 'array',
      description: '표로 정리할 수치·조건·고유명사 — 자료에 실제로 나온 값만, 단위와 기준을 붙인다',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '항목 (예: 셀 에너지밀도)' },
          value: { type: 'string', description: '값 (예: 350 Wh/kg — 자료 3:12)' },
          where: { type: 'string', description: '자료 안 위치 (시각·페이지·섹션). 모르면 빈 문자열' },
        },
        required: ['label', 'value'],
      },
    },
    actions: {
      type: 'array',
      description: '듣고/읽고 바로 할 일 — 실행 가능한 동작만 3~6개',
      items: { type: 'string' },
    },
    blog: {
      type: 'object',
      description: '블로그 글감으로 넘길 재료',
      properties: {
        title: { type: 'string', description: '블로그 제목 후보 (네이버 모바일 30자 이내)' },
        angle: { type: 'string', description: '이 자료로 쓸 때의 각도 — 무엇을 검증·비교·정리할지 2문장' },
        outline: { type: 'array', description: '본문 뼈대 4~6개 소제목', items: { type: 'string' } },
      },
      required: ['title', 'outline'],
    },
    shorts: {
      type: 'object',
      description: '쇼츠 1편으로 넘길 재료',
      properties: {
        hook: { type: 'string', description: '첫 3초에 말할 문장 (20자 내외, 인사 금지)' },
        beats: { type: 'array', description: '3~5개 컷의 말할 문장', items: { type: 'string' } },
        ending: { type: 'string', description: '마지막 한 줄 (여운·저장 유도)' },
      },
      required: ['hook'],
    },
    warnings: { type: 'array', description: '확인하지 못한 값·사실 (지어내지 말고 여기에)', items: { type: 'string' } },
    needsCheck: { type: 'array', description: '자료에서 [확인 필요]로 남긴 항목', items: { type: 'string' } },
  },
  required: ['headline', 'three'],
};

function promptSummary(b) {
  const mode = SUMMARY_MODES.indexOf(b.mode) >= 0 ? b.mode : 'three';
  const kind = b.kind === 'media' ? 'media' : b.kind === 'youtube' ? 'youtube' : 'doc';
  const focus = s(b.focus, 160);
  const title = s(b.title, 200);
  const text = s(b.text, SUMMARY_TEXT_MAX);
  const modeLine = {
    three: '3줄 핵심 결론(three)이 가장 중요하다 — 결론 → 근거 → 그래서 무엇을 할지 순서. 각 줄은 한 문장.',
    timeline: '흐름(timeline)이 가장 중요하다 — 처음부터 끝까지 끊김 없이 6~10구간, 각 구간에 시각(at)과 내용 한 줄(point).',
    table: '숫자·조건(facts)이 가장 중요하다 — 금액·수치·기간·조건을 6~12개, 단위와 기준을 붙여서. actions 도 3~6개 채운다.',
    handoff: '글감(blog·shorts)이 가장 중요하다 — 이 자료로 블로그 1편·쇼츠 1편을 바로 쓸 수 있게 제목·각도·뼈대·훅을 구체적으로.',
  }[mode];

  const srcLine =
    kind === 'media'
      ? '자료: 이 메시지에 실제로 첨부된 영상/음성 파일 1개' + (title ? ' (' + title + ')' : '') + '. 넌 이 파일을 직접 보고 들었다.'
      : kind === 'youtube'
        ? '자료: 유튜브 영상의 자막(스크립트)' + (title ? ' — 제목: ' + title : '')
        : '자료: 문서 텍스트' + (title ? ' — 파일: ' + title : '');

  const body =
    kind === 'media'
      ? `[첨부 파일 규칙 — 어기면 실패다]
- 위 파일을 실제로 보고 들은 것만 쓴다. 보이지 않은 장면·들리지 않은 말을 지어내지 않는다.
- 화면에 크게 뜬 글자(자막·자료 화면·제품명·숫자)는 본 대로 옮긴다. 흐릿해서 못 읽었으면 읽지 못했다고 쓴다.
- 소리만 있는 파일이면 목소리·말버릇·핵심 주장 위주로 쓰고, 보이지 않는 화면을 상상해 쓰지 않는다.
- 타임라인의 at 은 파일에서 실제로 그 내용이 나온 시각(mm:ss).`
      : `[본문 — 이 안에 있는 내용만 근거로 쓴다. 이 밖의 지식으로 내용을 덧붙이지 않는다]
"""
${text}
"""`;

  const user = [
    srcLine,
    b.chars ? `본문 길이: ${b.chars}자` + (b.truncated ? ' (앞부분만 넣었음 — 뒤는 없음)' : '') : '',
    b.author ? `채널·저자: ${s(b.author, 100)}` : '',
    b.durationSec ? `영상 길이: ${Math.round(num(b.durationSec, 0) / 6) / 10}분` : '',
    b.auto === true ? '자동 생성 자막이다 — 고유명사·숫자는 오인식이 있을 수 있으니 의심되면 warnings 에 적는다.' : '',
    focus ? `\n[사용자가 특히 뽑고 싶은 것 — 이걸 우선]\n${focus}` : '',
    `\n[이번에 가장 중요한 양식]\n${modeLine}`,
    body,
    '\n[요약 규칙]\n' +
      '1) 이 자료가 말하지 않은 사실·수치·업체명·날짜를 만들지 않는다. 자료에 없으면 쓰지 않는다.\n' +
      '2) 숫자는 자료에 나온 값 그대로, 단위와 기준을 붙인다. 계산이 필요하면 계산식도 함께 적는다.\n' +
      '3) 자막·발화를 그대로 옮길 때는 인용으로 표시한다. 요약과 발화를 섞지 않는다.\n' +
      '4) 확인이 필요한 값은 needsCheck 에 넣고 본문에서는 뒤에 "[확인 필요]"를 붙인다.\n' +
      '5) three 는 정확히 3줄. 각 줄은 서로 다른 내용이어야 한다(같은 말 반복 금지).\n' +
      '6) 자료가 짧아 타임라인·수치가 없으면 그 항목은 빈 배열로 두고 warnings 에 이유를 한 줄 적는다. 억지로 채우지 않는다.\n' +
      banLine(b.banPhrases) +
      '\n[출력] headline · three(3) · timeline · facts · actions · blog · shorts · warnings · needsCheck 만 JSON 으로.',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    system:
      '너는 자료를 정확히 요약하는 편집자다. 원문에 있는 것만 남기고, 없는 것은 만들지 않는다. ' +
      '요약은 짧고 정보 밀도가 높아야 한다. ' +
      HONESTY +
      ' ' +
      VOICE,
    user,
    schema: SCHEMA_SUMMARY,
    maxTokens: 3600,
    temperature: 0.3,
    media: arr(b.media, 1),
  };
}

function summaryMarkdown(r) {
  const L = [];
  const h = (t) => {
    L.push('');
    L.push(t);
  };
  if (r.title) L.push('# ' + r.title);
  if (r.headline) L.push('> ' + r.headline);
  if ((r.three || []).length) {
    h('## ⚡ 3줄 핵심');
    r.three.forEach((t, i) => L.push(i + 1 + '. ' + t));
  }
  if ((r.timeline || []).length) {
    h('## ⏱️ 타임라인');
    r.timeline.forEach((x) => L.push('- ' + (x.at ? x.at + ' · ' : '') + (x.label ? x.label + ' — ' : '') + x.point));
  }
  if ((r.facts || []).length) {
    h('## 📊 수치·조건');
    L.push('| 항목 | 값 | 위치 |');
    L.push('| --- | --- | --- |');
    r.facts.forEach((f) => L.push('| ' + f.label + ' | ' + f.value + ' | ' + (f.where || '—') + ' |'));
  }
  if ((r.actions || []).length) {
    h('## ✅ 할 일');
    r.actions.forEach((a) => L.push('- ' + a));
  }
  if (r.blog && (r.blog.title || (r.blog.outline || []).length)) {
    h('## ✍️ 블로그 글감');
    if (r.blog.title) L.push('제목: ' + r.blog.title);
    if (r.blog.angle) L.push('각도: ' + r.blog.angle);
    (r.blog.outline || []).forEach((o) => L.push('- ' + o));
  }
  if (r.shorts && (r.shorts.hook || (r.shorts.beats || []).length)) {
    h('## 🎬 쇼츠 글감');
    if (r.shorts.hook) L.push('훅: ' + r.shorts.hook);
    (r.shorts.beats || []).forEach((x) => L.push('- ' + x));
    if (r.shorts.ending) L.push('엔딩: ' + r.shorts.ending);
  }
  if ((r.needsCheck || []).length) {
    h('## ⚠️ 확인 필요');
    r.needsCheck.forEach((x) => L.push('- ' + x));
  }
  if ((r.warnings || []).length) {
    h('## 메모');
    r.warnings.forEach((x) => L.push('- ' + x));
  }
  return L.join('\n').trim();
}

function normSummary(data, meta) {
  const d = data || {};
  const m = meta || {};
  const timeline = arr(d.timeline, 16)
    .map((x) => ({ at: s(x && x.at, 24), label: s(x && x.label, 60), point: s(x && x.point, 400) }))
    .filter((x) => x.point);
  const facts = arr(d.facts, 16)
    .map((x) => ({ label: s(x && x.label, 60), value: s(x && x.value, 200), where: s(x && x.where, 80) }))
    .filter((x) => x.label && x.value);
  const blog = {
    title: s(d.blog && d.blog.title, 90),
    angle: s(d.blog && d.blog.angle, 300),
    outline: arr(d.blog && d.blog.outline, 8).map((x) => s(typeof x === 'string' ? x : x && x.text, 120)).filter(Boolean),
  };
  const shorts = {
    hook: s(d.shorts && d.shorts.hook, 200),
    beats: arr(d.shorts && d.shorts.beats, 6).map((x) => s(typeof x === 'string' ? x : x && x.text, 200)).filter(Boolean),
    ending: s(d.shorts && d.shorts.ending, 200),
  };
  const out = {
    title: s(m.title, 200) || s(d.title, 200),
    headline: s(d.headline, 160),
    three: arr(d.three, 5).map((x) => s(typeof x === 'string' ? x : x && x.text, 240)).filter(Boolean),
    timeline,
    facts,
    actions: arr(d.actions, 8).map((x) => s(typeof x === 'string' ? x : x && x.text, 240)).filter(Boolean),
    blog,
    shorts,
    warnings: arr(d.warnings, 10).map((x) => s(x, 240)).filter(Boolean),
    needsCheck: arr(d.needsCheck, 10).map((x) => s(x, 160)).filter(Boolean),
  };
  if (out.title && !out.headline) out.headline = s(m.headline, 160);
  if (!out.three.length) out.warnings.push('3줄 핵심이 비어 왔습니다. 다시 눌러 주세요.');
  if (!timeline.length) out.warnings.push('타임라인·섹션 구간이 없습니다(자료가 짧거나 흐름이 없는 자료일 수 있습니다).');
  if (!facts.length) out.warnings.push('수치·조건 항목이 없습니다 — 자료에 숫자가 없을 수 있습니다.');
  out.markdown = summaryMarkdown(out);
  return out;
}

/* ---------------------------------------------------------------- 공통 규칙 */

const HONESTY = [
  '확인하지 못한 가격·수치·통계·영업시간·고유 업체명을 절대 지어내지 않는다.',
  '사용자가 준 정보에 없는 고유명사·금액·날짜는 "[확인 필요]"로 남기고 warnings 에 적는다.',
  '실제로 방문·구매하지 않은 대상을 "다녀왔다·먹어봤다·내돈내산·써봤다" 같은 1인칭 경험담으로 쓰지 않는다.',
  '추측과 사실을 섞지 않는다. 추측이면 "내 추정"이라고 밝힌다.',
  '과장·보장 표현("무조건", "100%", "역대급")을 쓰지 않는다.',
].join(' ');

const VOICE = [
  '사람이 직접 쓴 글처럼 쓴다. 짧은 문장과 구어체 어미를 섞고, 접속사·수식어를 남발하지 않는다.',
  'AI 상투어를 쓰지 않는다. 예: 알아보겠습니다 / 결론적으로 / 무엇보다도 / 이번 포스팅에서는 / 살펴보도록 하겠습니다 / ~하는 것이 중요합니다 / 그렇기 때문에 / 정리해 보겠습니다.',
  '같은 문장 구조를 반복하지 않는다. "~하시죠?" 같은 상투적 공감 질문을 붙이지 않는다.',
].join(' ');

function banLine(banPhrases) {
  const list = (banPhrases && banPhrases.length ? banPhrases : BAN_DEFAULT).slice(0, 30);
  if (!list.length) return '';
  return `\n[금지 표현 — 이 문자열이 결과에 그대로 나오면 실패다]\n- ${list.join('\n- ')}`;
}

/* ---------------------------------------------------------------- 프롬프트 */

function styleBlock(st) {
  if (!st || typeof st !== 'object') return '';
  const name = s(st.name, 60);
  if (!name) return '';
  const struct = arr(st.structure, 12).map((x) => `- ${s(x, 90)}`).join('\n');
  const symbols = arr(st.symbols, 10).map((x) => `- ${s(x, 130)}`).join('\n');
  const rules = arr(st.rules, 8).map((x) => `- ${s(x, 160)}`).join('\n');
  const blocks = arr(st.blocks, 12).map((x) => `- ${s(x, 240)}`).join('\n');
  return [
    `\n[블로그 양식 — 「${name}」 스타일 · 구조·호흡·기호·말투만 따른다]`,
    st.who ? `- 이 글이 왜 읽히는가: ${s(st.who, 200)}` : '',
    struct ? `- 구성 뼈대(위에서부터 이 순서대로 "## " 소제목을 만든다. 번호는 붙이지 않는다):\n${struct}` : '',
    st.rhythm ? `- 문단 호흡: ${s(st.rhythm, 320)}` : '',
    symbols ? `- 쓰는 기호·박스(본문에 실제로 넣는다):\n${symbols}` : '',
    st.voice ? `- 말투 DNA: ${s(st.voice, 320)}` : '',
    rules ? `- 지킬 규칙:\n${rules}` : '',
    blocks ? `- 반드시 넣는 블록(아래 문구로 시작하는 '독립된 한 줄'로 쓴다 — 그 줄이 서식 박스로 바뀐다):\n${blocks}` : '',
    '- 저작권: 이 사람의 실제 문장을 옮기지 않는다. 뼈대·호흡·기호·말투만 내 글로 다시 쓴다. 글에 이 사람 이름·블로그 이름을 쓰지 않는다.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 내 사진 — 실제로 첨부된 사진만 번호를 매기고, Gemini 에 inlineData 로 함께 보낸다. */
function blogPhotos(b) {
  const out = [];
  let total = 0;
  arr(b.photos, MAX_INLINE_IMAGES).forEach((p) => {
    if (!p || typeof p !== 'object') return;
    const mime = s(p.mime, 40).toLowerCase();
    const data = String(p.data == null ? '' : p.data).replace(/^data:[^,]*,/, '').trim();
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return;
    if (!data || data.length > MAX_INLINE_ONE) return;
    if (total + data.length > MAX_INLINE_TOTAL) return;
    total += data.length;
    out.push({ n: out.length + 1, mime, data, name: s(p.name, 80) || 'photo' + (out.length + 1) + '.jpg', memo: s(p.memo, 200) });
  });
  return out;
}

function promptBlog(b) {
  const form = b.form || {};
  const sections = arr(form.sections, 8).map((x, i) => `${i + 1}) ${s(x, 80)}`).join('\n');
  const sample = s(b.toneSample, 4000);
  const note = s(b.experienceNote, 2000);
  const src = s(b.sourceMaterial, 8000);
  const gaps = arr(b.gaps, 6).map((x) => `- ${s(x, 120)}`).join('\n');
  const style = styleBlock(b.stylePreset);
  const photos = blogPhotos(b);
  const photoList = photos.map((p) => `${p.n}) ${p.name}${p.memo ? ' — 메모: ' + p.memo : ''}`).join('\n');
  const photoRule = photos.length
    ? `
[내 사진 배치 규칙 — 어기면 실패다]
- 너는 위 사진을 실제로 보고 쓴다. 사진에 실제로 보이는 것만 쓴다. 없는 사람·간판·브랜드·음식·날씨를 지어내지 않는다.
- 사진을 넣을 자리에 정확히 "[📸 내 사진 1: 사진에서 실제로 보이는 모습 20자 내외]" 형식으로 넣는다. 번호는 위 사진 번호다.
- 그 태그 바로 앞 문단에서 그 사진을 자연스럽게 언급한다(캡션과 같은 문장을 반복하지 않는다).
- 사진이 ${photos.length}장이면 태그도 ${photos.length}개다. 한 사진을 두 번 넣지 않는다.
- 사진과 맞지 않는 자리에 억지로 넣지 않는다. 사진에 맞는 섹션으로 옮긴다.
- 사진으로 채우지 못한 곳이 필요하면 "[📸 사진: 묘사 | search: 영문검색어]"를 최대 2곳만 쓴다. (사진이 있는 주제에 없는 사진을 지어내지 않는다)`
    : '';
  const user = [
    `주제: ${s(b.topic, 200)}`,
    form.name ? `양식: ${s(form.name, 40)} / 말투: ${s(form.tone, 40)}` : `말투: ${s(form.tone, 40) || '친근한 리뷰형'}`,
    sections ? `\n[반드시 이 순서로 섹션을 구성 — 소제목에 1) 같은 번호를 붙이지 않는다]\n${sections}` : '',
    form.highlight ? `\n[강조 포인트 — 이걸 지켜야 통과]\n${s(form.highlight, 400)}` : '',
    style,
    sample ? `\n[내 문체 샘플 — 문장 길이·어미·말버릇을 이 사람처럼]\n"""${sample}"""` : '',
    note ? `\n[내 경험 메모 — 사용자가 직접 적은 사실. 1인칭 경험은 여기 있는 내용만 쓴다]\n"""${note}"""` : '',
    src ? `\n[참고 자료 — 남이 말한 내용(유튜브 자막·기사·시황 요약). 사실 근거로만 인용하고 내 경험으로 쓰지 않는다]\n"""${src}"""` : '',
    gaps ? `\n[경쟁 글 빈틈 메모 — 본문에서 실제로 메꿔라]\n${gaps}` : '',
    photos.length ? `\n[내 사진 — 이 메시지에 실제로 첨부된 사진 ${photos.length}장. 위에서부터 1번]\n${photoList}` : '',
    b.theme ? `\n참고 카테고리: ${s(b.theme, 40)}` : '',
    banLine(b.banPhrases),
    `${photoRule}
[경험·사실 규칙 — 이걸 어기면 실패다]
- 위 [내 경험 메모]에 없는 1인칭 경험(다녀왔다·가보니·먹어봤다·내돈내산·써봤다)을 절대 쓰지 않는다. 실제로 방문·구매한 적이 없다.
- [참고 자료]는 남의 영상·기사다. 그 내용을 내가 직접 겪은 일처럼 쓰지 않는다.
- [참고 자료]를 인용할 때는 "영상에서 말한 ~", "자료에 따르면 ~" 처럼 근거를 밝힌다. 자료에 없는 수치·사례를 덧붙이지 않는다.
- 경험 메모가 비어 있으면 '담백한 큐레이터' 어조로 쓴다. 확인된 조건·핵심 포인트·주의사항 중심으로. ("조건을 보면", "확인해야 할 것은", "~로 알려져 있다")
- 경험 메모가 있으면 그 내용만 1인칭으로 살린다. 메모에 없는 디테일을 덧붙이지 않는다.
- 사용자가 준 정보에 없는 업체·장소·상품·브랜드 이름을 지어내지 않는다. 예시가 필요하면 "A 업체", "B 숙소" 같은 자리표시자를 쓴다.
- "내돈내산", "협찬 없음", "직접 써본" 표현은 경험 메모가 있을 때만 쓴다.

[본문 작성 규칙]
1) 첫 3줄이 훅이다. 인사말("안녕하세요") 없이 결론·숫자·상황으로 바로 시작한다.
2) 위 섹션 순서를 그대로 쓰고 각 섹션 제목은 "## " 마크다운 소제목으로 단다.
3) 조건 비교용 마크다운 표를 최소 1개 넣는다. ( | 구분 | A | B | 형식, 헤더 구분선 포함)
4) 사진이 들어가면 글이 자연스러워지는 지점에 정확히 "[📸 사진: 구체적 묘사 | search: 영문검색어]" 형식으로 넣는다.
   단 [내 사진]이 첨부된 경우에는 내 사진 태그를 우선하고, 남은 자리에만 0~2곳 넣는다.
   - 묘사는 한국어 20자 내외(무엇이 보여야 하는지), search 는 무료 사진 DB에서 실제로 검색될 영어 명사 2~4단어.
   - search 에 브랜드·상호·사람 이름·연도·한글을 넣지 않는다(그런 사진은 무료 DB에 없다). "street food", "autumn park", "hotel lobby" 처럼 보편 명사만.
   - 사진 태그는 그 줄 하나로 끝낸다(같은 줄에 다른 문장을 붙이지 않는다). 표 안에는 넣지 않는다.
5) 솔직한 단점을 최소 1줄 쓴다. ("아쉬운 점:" 으로 시작)
6) 분량 900~1300자. 이 길이를 넘기면 출력이 잘려 실패한다 — 짧고 밀도 있게.
7) 확인 못 한 값은 "[확인 필요]"로 남긴다. (지어내면 안 된다)
8) 제목 3종은 각각 32자 이내 — 네이버 모바일 검색 결과에서 잘리지 않게. 세 유형을 반드시 서로 다른 각도로 쓴다.
   - 호기심형: 궁금증을 남기는 질문·반전 (예: "왜 이 시간엔 아무도 안 알려줄까")
   - 숫자 직격형: 가장 센 숫자 1개를 앞세운다 (예: "3곳 비교 12,000원 차이")
   - 비교형: A vs B 구도를 제목에 드러낸다 (예: "주말 vs 평일, 2만원 차이")
9) gaps 에는 "같은 주제 인기 글들이 비워 둔 지점" 2개를, 각각 왜 비었는지 + 내가 무엇으로 채울지 1~2문장으로.
10) 네이버 검색 유입(SEO): seoKeywords 5~7개를 먼저 정하고, 그 표현을 본문에 자연스럽게 배치한다.
   - 도입 첫 3줄 안에 1개, 소제목 2~3개에 각 1개(가능하면 그대로), 마지막 문단에 1개.
   - 태그를 나열하듯 끼워 넣지 않는다. 문장이 어색해지면 그 검색어는 버리고 다른 표현을 쓴다.
   - 본문 맨 끝에 "#검색어1 #검색어2 …" 형태로 5~7개 해시태그 줄을 한 줄 넣는다(공백 없는 형태).
   - 그날 급등 테마·종목이 [참고 자료]에 있으면 그 이름을 검색어로 먼저 쓴다. 자료에 없는 테마·종목명을 만들지 않는다.
[출력] titles(3개) · seoKeywords(5~7개) · gaps(2개) · body(마크다운) · warnings(확인 필요 목록) 만 JSON 으로.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 한국어 블로그를 직접 운영하는 사람이다. 검색 상위 글을 베끼지 않고, 내 경험과 실측값으로 쓴다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_BLOG,
    maxTokens: 3600,
    temperature: 0.95,
    images: photos.map((p) => ({ mimeType: p.mime, data: p.data })),
  };
}

function promptVideo(b) {
  const clips = arr(b.clips, 6).map((c, i) => {
    const dur = round1(num(c.dur, 0));
    const cin = round1(num(c.in, 0));
    const cout = round1(num(c.out, dur || cin + 1));
    return `${i}) ${s(c.name, 80)} — 길이 ${dur}s / 해상도 ${num(c.w, 0)}x${num(c.h, 0)} / 쓸 구간 ${cin}s~${round1(Math.min(cout, dur || cout))}s`;
  }).join('\n');
  const presetMap = {
    info: '① 깔끔 정보형 — 흰 반투명 하단 카드, 자막 20자 이내, 정보 전달 톤',
    variety: '② 예능 노랑 강조 — 화면 중앙 큰 자막, 핵심 단어만 노랑, 자막 14자 이내',
    letter: '③ 3단 블랙 레터박스 — 위: 제목(16자), 가운데: 클립, 아래: 포인트·출처, 자막 18자 이내',
  };
  const user = [
    clips ? `[업로드한 클립]\n${clips}` : '[업로드한 클립 없음 — 스토리 방향만으로 설계]',
    b.story ? `\n[스토리 · 편집 방향]\n${s(b.story, 600)}` : '',
    `\n출력 비율: ${b.ratio === '16:9' ? '16:9 가로(1920×1080)' : '9:16 세로 쇼츠(1080×1920)'}`,
    `자막 프리셋: ${presetMap[b.preset] || presetMap.info}`,
    `BGM 덕킹: 목소리 ${num(b.voice, 100)}% / BGM ${num(b.bgm, 15)}%`,
    banLine(b.banPhrases),
    `
[컷 설계 규칙]
1) clipIndex 는 클립 목록의 0부터 시작하는 번호. 목록에 없는 번호를 쓰지 않는다.
2) startSec/endSec 는 반드시 그 클립의 "쓸 구간" 안에서 고른다. (초 단위, 소수 1자리)
3) 총 길이 20~45초, 컷은 최소 4개. 2초짜리 자투리 컷을 남발하지 말고 한 컷을 5~12초로 잡는다.
   (쓸 구간이 짧은 클립은 짧게, 긴 클립은 여러 컷으로 나눠 쓴다 — 쓸 구간을 최대한 활용한다)
4) 첫 컷은 2초 이내 후킹 — 훅 멘트가 실제로 들리는 구간이어야 한다.
5) caption 은 화면에 실제로 띄울 말이다(설명문·지시문 금지). 자막 프리셋 글자수 제한을 지키고,
   스토리 방향에서 사용자가 말한 것(교차편집·손인사 엔딩 등)을 반영한다.
   곡명·멤버 이름처럼 모르는 고유명사만 "[확인 필요]"로 남긴다.
6) 파일명·길이만 보고 장면 내용을 단정하지 않는다. 근거가 없으면 caption 을 장면 중립적으로 쓰고 warnings 에 적는다.
7) hooks 3종은 실제로 입으로 말할 문장. 질문형 / 숫자형 / 반전형.
8) bgm.ducking 은 "말 시작 0.1초 전 -12dB, 문장 끝 0.4초 뒤 복귀" 처럼 구체적으로.
[출력] hooks(3) · cuts(배열) · bgm · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 50초 세로 쇼츠를 만드는 편집 감독이다. 컷 설계도는 실제 클립 구간 안에서 떨어져야 하고, 없는 장면을 상상해서 쓰지 않는다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_VIDEO,
    maxTokens: 2600,
    temperature: 0.8,
  };
}

function promptYt(b) {
  const vids = arr(b.videos, 5).map((v, i) => `${i + 1}) ${s(v.title, 120)} / ${s(v.channel || v.ch, 60)} / ${s(v.dur, 20)}`).join('\n');
  const user = [
    `검색어(주제): ${s(b.query || b.topic, 120)}`,
    vids ? `\n[내가 고른/참고한 영상]\n${vids}` : '\n[참고 영상 없음 — 검색어만으로 판단]',
    b.source === 'demo'
      ? '\n주의: 위 영상은 실제 검색 결과가 아니라 UI 예시(데모) 목록이다. 제목 문구만 근거로 쓰고, 조회수·댓글 내용은 절대 지어내지 않는다.'
      : '',
    arr(b.notes, 6).length ? `\n[내 메모]\n${arr(b.notes, 6).map((x) => '- ' + s(x, 100)).join('\n')}` : '',
    banLine(b.banPhrases),
    `
[해야 할 일]
1) 이 주제에서 경쟁 영상들이 비워 둔 빈틈(Gap) 2가지를 찾는다. 각각 title(20자 내외) / why(왜 비었나 1문장) / how(내가 채우는 법 1문장).
2) 같은 주제로 50초 쇼츠 대본을 만든다. 0~2초 후킹 → 3~40초 핵심 3컷 → 41~50초 엔딩.
3) scenes 의 time 은 "0-2초", "3-13초" 처럼 실제 초 구간. line 은 말할 문장 + (화면 지시).
4) 영상 제목 32자 이내, 실제로 검색될 만한 단어 조합.
5) 모르는 사실은 [확인 필요]로 남기고 warnings 에 적는다.
[출력] gaps(2) · shorts{title, hook, scenes, cta} · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 유튜브 쇼츠 기획자다. 남의 영상을 베끼지 않고, 빈틈을 찾아 내 각도로 다시 만든다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_YT,
    maxTokens: 2400,
    temperature: 0.9,
  };
}

function promptShorts(b) {
  const body = s(b.body, 9000);
  const user = [
    b.topic ? `블로그 주제: ${s(b.topic, 160)}` : '',
    `\n[완성된 블로그 본문]\n"""${body}"""`,
    banLine(b.banPhrases),
    `
[해야 할 일]
위 글을 50초 쇼츠 대본으로 바꾼다.
1) 0~2초 후킹: 본문에서 가장 강한 숫자·결론 하나만. 인사 없이 바로.
2) 3~40초: 핵심 3컷. 한 컷당 10~13초, 말하는 문장 2줄 이내 + (화면 지시).
3) 41~50초: 엔딩 — 여운 한 줄 + 저장/구독 유도(노골적이지 않게).
4) 본문에 없는 수치·사실을 새로 만들지 않는다.
5) 자막 스타일 권장 1줄(captionGuide) — 정보형/예능형/레터박스 중 어느 쪽이 맞는지 이유와 함께.
[출력] title · hook · scenes · ending · captionGuide · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 블로그 글을 쇼츠 대본으로 바꾸는 작가다. 원문에 있는 내용만 쓴다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_SHORTS,
    maxTokens: 2200,
    temperature: 0.9,
  };
}

/* ---------------------------------------------------------------- 다듬기 프롬프트 */

const TONES = {
  honest: {
    label: '솔직 후기형',
    guide:
      '짧게 끊어 말하고, 좋았던 점과 아쉬웠던 점을 같이 말한다. "~더라고요", "~긴 하더라", "솔직히" 같은 구어체를 쓰되 과장·보장은 쓰지 않는다. 이미 있는 판단만 솔직하게 말한다.',
  },
  expert: {
    label: '전문가 분석형',
    guide:
      '근거·조건·수치 중심으로 쓴다. "~로 판단된다", "조건을 보면", "확인해야 할 것은" 같은 표현을 쓰고, 단정 대신 근거를 먼저 둔다. 형용사보다 비교와 기준을 세운다.',
  },
  warm: {
    label: '따뜻한 에세이형',
    guide:
      '부드러운 서술로 상대를 배려한다. 사실은 그대로 두고 문장만 느리게 풀어 쓴다. 감정 표현은 원문에 있는 범위 안에서만 쓰고, 새로운 일화·기억을 만들지 않는다.',
  },
};

const KEEP_STRUCTURE = [
  '섹션 구조를 유지한다 — "## " 소제목의 개수·순서·의미를 그대로 둔다.',
  '표는 같은 행·열 구조로 두고 셀 값만 다듬는다. 수치·날짜·업체명·고유명사는 절대 바꾸거나 새로 만들지 않는다.',
  '"[📸 사진: ... | search: ...]" 태그는 글자 그대로 복사한다(위치·검색어 변경 금지).',
  '"[확인 필요]" 표시를 지우지 않는다.',
  '1인칭 경험(다녀왔다·먹어봤다·써봤다·내돈내산)은 원문에 있을 때만 유지하고 새로 만들지 않는다.',
  '마크다운 본문만 출력한다. 머리말·설명·인사 없이.',
].join(' ');

function promptRewrite(b) {
  const tone = TONES[b.tone] || TONES.honest;
  const user = [
    b.topic ? `글 주제: ${s(b.topic, 200)}` : '',
    `\n[바꿀 어조] ${tone.label} — ${tone.guide}`,
    `\n[현재 초안 — 이 글의 내용과 사실은 그대로 두고 어조만 바꾼다]\n"""${s(b.body, 14000)}"""`,
    banLine(b.banPhrases),
    `
[규칙]
1) ${KEEP_STRUCTURE}
2) 분량은 원문의 85~115%로 맞춘다. 잘라서 끝내지 않는다.
3) 어조만 바꾼다. 원문에 없는 사실·사례·수치를 추가하면 실패다.
4) changed 에는 실제로 바꾼 점을 2~4개 적는다(예: "문장 길이를 8~15자로 끊음").
[출력] body · changed · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 한국어 블로그 편집자다. 같은 글을 다른 어조로 다시 쓴다. 내용·사실은 손대지 않고 문장만 바꾼다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_REWRITE,
    maxTokens: 3600,
    temperature: 0.75,
  };
}

/* 네이버 블로그용 요약본 — 티스토리 원고를 '결이 다른 글'로 다시 쓴다.
   같은 글을 두 채널에 그대로 올리면 중복 문서로 노출이 떨어질 수 있어
   도입부·소제목 구성·문장 길이를 실제로 바꾸고, 분량은 55~75%로 줄인다. */
function promptNaverNote(b) {
  const user = [
    b.topic ? `글 주제: ${s(b.topic, 200)}` : '',
    `\n[티스토리 원고 — 이 글을 네이버용 요약본으로 다시 쓴다]\n"""${s(b.body, 14000)}"""`,
    banLine(b.banPhrases),
    `
[해야 할 일 — 🟢 네이버용 톤 변환]
같은 소재를 네이버 블로그에 올릴 '결이 다른 요약본'으로 다시 쓴다. 원문을 그대로 옮기면 두 채널 모두 노출이 떨어질 수 있으니 문장·도입부·소제목 구성을 실제로 바꾼다.
1) 첫 문단: 인사 + 왜 이 글을 쓰는지 1~2문장. "오늘은 ~를 짧게 정리해 볼게요"처럼 말하듯 시작한다. 원문 첫 문단을 그대로 쓰지 않는다.
2) 소제목: 원문 소제목을 복사하지 말고 4~6개로 새로 묶는다. 질문형이나 말하듯("그래서 얼마나 빠졌는데?")으로 달고, 순서도 읽기 좋게 다시 짠다.
3) 분량: 원문의 55~75%. 한 문단은 2~4문장, 한 문장은 40자 안팎으로 끊는다. "~습니다"와 "~요/~더라고요"를 섞는다.
4) 숫자·날짜·업체명·종목명·[확인 필요]는 절대 바꾸거나 새로 만들지 않는다. 원문에 없는 사실·사례·수치를 추가하면 실패다.
5) 1인칭 경험(가봤다·써봤다·내돈내산)은 원문에 있을 때만 남기고 새로 만들지 않는다.
6) "[📸 사진: ...]" 태그와 링크·제휴 고지 줄은 넣지 않는다(네이버에는 사진을 직접 올리고, 링크는 앱이 따로 붙인다).
7) 맨 끝에 "한 줄 요약" 한 문장을 둔다.
8) tags 에는 네이버 검색 유입용 해시태그 10개를 # 없이 넣는다(지역·대상·상황 키워드 포함).
9) 마크다운 본문만 출력한다. 머리말·설명·인사 없이.
[출력] title · body · tags · changed · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 같은 소재를 채널에 맞게 다시 쓰는 한국어 블로그 작가다. 네이버 블로그 독자에게 말 걸듯 친근한 구어체로, 원문의 사실은 그대로 두고 구성과 문장만 새로 짠다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_NAVER,
    maxTokens: 3600,
    temperature: 0.8,
  };
}

const AI_TICS = [
  '~에 대해 알아보겠습니다', '알아보겠습니다', '결론적으로', '다양한 측면에서', '여러 측면에서',
  '살펴보겠습니다', '살펴보도록 하겠습니다', '정리해 보겠습니다', '정리해보자면', '무엇보다도',
  '이번 포스팅에서는', '이번 글에서는', '~하는 것이 중요합니다', '매우 중요합니다', '그렇기 때문에',
  '이와 같이', '위와 같이', '다음과 같습니다', '도움이 되셨길 바랍니다', '참고하시기 바랍니다',
  '시사하는 바가 큽니다', '긍정적인 영향을 미칩니다', '중요한 역할을 합니다', '다양한 방법이 있습니다',
];

function promptHumanize(b) {
  const user = [
    b.topic ? `글 주제: ${s(b.topic, 200)}` : '',
    `\n[현재 초안]\n"""${s(b.body, 14000)}"""`,
    banLine(b.banPhrases),
    `
[해야 할 일 — AI 티 빼기]
위 초안에서 기계적인 상투어를 걷어내고 사람이 쓴 것처럼 다시 쓴다.
1) 다음 같은 표현은 반드시 지운다: ${AI_TICS.join(' / ')}
2) 문장을 8~22자 단위로 끊고, 한 문단은 2~4문장으로 줄인다. 접속사("또한", "따라서", "즉")를 줄인다.
3) "~습니다"와 "~요/~더라고요"를 섞어 리듬을 만든다. 같은 어미를 연속 3번 쓰지 않는다.
4) 수식어 남발(매우·정말·굉장히·다양한·효과적인)을 덜어낸다. 구체적인 숫자·상황으로 대신한다.
5) ${KEEP_STRUCTURE}
6) 분량은 원문의 90~110%. 사실을 새로 만들지 않는다.
7) removed 에는 실제로 지운 표현만 적는다(최대 10개).
[출력] body · removed · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 사람이 쓴 글을 고치는 교정자다. AI가 쓴 티가 나는 문장을 걷어내고 짧고 담백한 한국어로 다시 쓴다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_HUMANIZE,
    maxTokens: 3600,
    temperature: 0.7,
  };
}

function promptMulti(b) {
  const user = [
    b.topic ? `글 주제: ${s(b.topic, 200)}` : '',
    `\n[완성된 블로그 본문]\n"""${s(b.body, 12000)}"""`,
    banLine(b.banPhrases),
    `
[해야 할 일 — 1타 3피]
A) insta: 인스타그램·스레드에 바로 붙여넣을 3줄 요약. 각 45자 이내, 첫 줄이 훅(숫자·결론·반전). 줄바꿈은 lines 배열로. 이모지는 1~2개만.
   hashtags: 본문에 실제로 나온 소재로 10개(# 없이, 공백 없이, 12자 이내). 없는 브랜드·지역을 만들지 않는다.
B) shorts: 같은 글을 50초 쇼츠 대본으로. 0~2초 후킹 → 3~40초 핵심 3컷(각 10~13초) → 41~50초 엔딩.
   scenes[].line 은 실제로 말할 문장 + (화면 지시). title 은 32자 이내. captionGuide 는 자막 스타일 권장 1줄.
C) 본문에 없는 수치·사실을 새로 만들지 않는다. 확인 못 한 값은 "[확인 필요]"로 남긴다.
[출력] insta{lines, hashtags} · shorts{title, hook, scenes, ending, captionGuide, warnings} · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 한 편의 글을 여러 채널로 나눠 쓰는 콘텐츠 편집자다. 원문에 있는 내용만 쓴다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_MULTI,
    maxTokens: 3000,
    temperature: 0.9,
  };
}

function promptSeo(b) {
  const user = [
    b.title ? `제목: ${s(b.title, 120)}` : '',
    b.topic ? `주제: ${s(b.topic, 160)}` : '',
    `\n[본문]\n"""${s(b.body, 9000)}"""`,
    `
[해야 할 일 — 검색 유입 태그]
1) keywords: 이 글을 찾을 사람이 네이버에 실제로 칩 것 같은 검색어 10개. 2~4단어 한국어 명사 조합.
   - 본문에 있는 지역·대상·상황만 쓴다. 본문에 없는 브랜드·지역·연도를 만들지 않는다.
   - 너무 넓은 단어("여행", "주식")만 쓰지 말고 글의 각도를 살린다("동탄 실내 키즈카페", "코스피 마감 정리").
   - 10개는 서로 겹치지 않게. 중복 단어만 다른 검색어는 빼고 다른 각도로 채운다.
2) hashtags: 같은 기준으로 10개. # 없이, 공백 없이, 12자 이내.
3) 확신이 없는 고유명사는 넣지 않는다.
[출력] keywords(10) · hashtags(10) · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 한국 블로그 검색 유입(SEO)을 다루는 편집자다. 본문에 실제로 있는 내용에서만 키워드를 뽑는다. ${HONESTY}`,
    user,
    schema: SCHEMA_SEO,
    maxTokens: 900,
    temperature: 0.6,
  };
}

function promptClosing(b) {
  const user = [
    b.topic ? `글 주제: ${s(b.topic, 160)}` : '',
    `\n[본문 마지막 부분]\n"""${s(b.body, 6000)}"""`,
    banLine(b.banPhrases),
    `
[해야 할 일 — 마무리]
1) question: 이 글을 읽은 사람이 댓글을 달고 싶어지는 질문 한 문장. 본문의 갈림길(선택·경험·판단)을 묻는다.
   - 상투적인 "어떠셨나요?", "여러분의 생각은?" 금지. 본문에 나온 구체적인 대상·조건을 언급한다.
   - 광고성 유도("구독 부탁") 금지. 60자 이내.
2) boxTitle: 링크 안내 박스 제목. 본문 성격에 맞게(특가·예약 / 지도·경로 / 도서·자료). 20자 이내.
3) items: 박스에 넣을 안내 2~3개. label 은 무엇을 넣을 자리인지(예: "예약·최저가 링크"), hint 는 왜 필요한지 한 줄.
   - 실제 URL·가격을 만들지 않는다. 사용자가 직접 넣을 자리만 안내한다.
[출력] question · boxTitle · items · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 블로그 글 끝을 정리하는 편집자다. 독자가 댓글을 달 자연스러운 질문 하나와, 링크를 넣을 안내 박스를 만든다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_CLOSING,
    maxTokens: 800,
    temperature: 0.9,
  };
}

/* ---------------------------------------------------------------- 🔗 4번 내 블로거 양식 분석 · ✨ 2차 검수 */

function promptAnalyzeStyle(b) {
  const text = s(b.sourceText, 4500);
  const pick = Number(b.bloggerNo) >= 1 && Number(b.bloggerNo) <= 4 ? Number(b.bloggerNo) : 4;
  const user = [
    b.title ? `글 제목: ${s(b.title, 120)}` : '',
    b.author ? `블로그 주인 이름(페이지에서 확인된 값): ${s(b.author, 40)}` : '',
    b.theme ? `테마: ${s(b.theme, 40)}` : '',
    `\n[분석할 글 본문 — 이 사람이 실제로 쓴 글. 문장을 베끼지 않고 ‘쓰는 방식’만 뽑는다]\n"""${text}"""`,
    `
[해야 할 일 — 이 글의 양식 DNA 추출]
1) styleName: 위에 블로그 주인 이름이 있으면 그 이름을 그대로. 없으면 글에서 확인되는 필명, 그것도 없으면 정확히 "내 블로그". 글 제목·첫 줄을 블로그 이름으로 쓰지 않는다.
2) structure: 이 글이 실제로 진행된 순서를 5~7단계로. (예: 한 줄 결론 → 위치·이동 → 표 → 아쉬운 점 → 정리) 내용이 아니라 ‘틀’만.
3) rhythm: 문단 호흡 — 몇 문장씩 끊는지, 한 줄씩 끊는지, 사진·표·인용구를 어디에 두는지 1~2문장.
4) symbols: 실제로 쓰는 기호 습관 3~5개 (예: > 소제목 인용구, 1️⃣ 단계 번호, | 표 |, 📌 팁 박스, 마지막 문장 반복).
5) tone: 말투 DNA — 어미 종류(해요체/반말/보도체/따뜻한 존댓말), 1인칭 노출 정도, 문장 길이를 1~2문장으로.
6) avoid: 이 글에서 지키는 금기·주의 2~4개 (예: 결말 스포 없이, 가격은 날짜와 함께, 과장 금지).

[저작권·정직 규칙 — 어기면 실패다]
- 본문 문장을 그대로 옮기거나 인용하지 않는다. 숫자·고유명사·사건 내용은 결과에 쓰지 않는다. 오직 구성·호흡·기호·말투만.
- 글에 없는 습관을 지어내지 않는다. 비슷한 예가 여러 개 보일 때만 적는다.
- 결과는 ‘다른 사람이 자기 주제로 같은 양식대로 쓸 수 있는 규칙’이어야 한다.
[출력] styleName · structure · rhythm · symbols · tone · avoid JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 블로그 글쓰기 양식을 분석하는 편집자다. 남의 글에서 구조·호흡·기호·말투 패턴만 뽑아 재사용 가능한 규칙으로 정리한다. 남의 문장을 베끼지 않는다. ${HONESTY}`,
    user,
    schema: SCHEMA_STYLE,
    maxTokens: 1200,
    temperature: 0.5,
  };
}

function promptProofread(b) {
  if (String((b && b.mode) || '') === 'shorts') return promptProofreadShorts(b);
  const style = styleBlock(b.stylePreset);
  const note = s(b.experienceNote, 1200);
  const pick = Number(b.bloggerNo) >= 1 && Number(b.bloggerNo) <= 4 ? Number(b.bloggerNo) : 0;
  const user = [
    b.topic ? `주제: ${s(b.topic, 200)}` : '',
    pick ? `현재 선택된 양식: ${pick}번 블로거` : '',
    style,
    note ? `\n[내 경험 메모 — 1인칭 경험은 여기 있는 것만 허용]\n"""${note}"""` : '\n[내 경험 메모 — 없음. 1인칭 경험담은 모두 지운다]',
    `\n[검수할 본문]\n"""${s(b.body, 16000)}"""`,
    banLine(b.banPhrases),
    `
[해야 할 일 — 편집장 2차 검수]
① 가지 않은 곳·안 겪은 일을 1인칭 경험담(다녀왔다·먹어봤다·내돈내산·써봤다)으로 쓴 문장은 지우거나 ‘조건·정보’ 문장으로 바꾼다. 위 경험 메모에 있는 내용만 1인칭으로 남긴다.
② 과장·어색한 AI 문구를 자연스럽게 고친다. ("결론적으로" · "~할 수 있습니다" 나열 · "무엇보다도" · "살펴보겠습니다" · 같은 구조 반복 · 상투적 공감 질문)
③ 위 양식(구성 순서·문단 호흡·기호·말투)이 빠졌으면 보충한다. 소제목·표·[📸 사진] 자리는 원문 위치를 지키고, 빠진 기호 박스만 다시 넣는다.
④ 맞춤법·띄어쓰기를 정리한다. (되/돼, -데/-대, 띄어쓰기, 중복 단어)

[절대 하지 말 것]
- 분량은 원문의 90~110%를 유지한다. 통째로 요약하거나 문단을 삭제하지 않는다.
- 숫자·가격·날짜·업체명을 새로 만들지 않는다. 모르는 값은 그대로 "[확인 필요]"로 둔다.
- 글 길이를 크게 줄이거나 새 섹션을 지어내지 않는다. 원문 구조를 유지한 ‘교정본’이다.
- fixes 에는 실제로 고친 것만 쓴다. 안 고쳤으면 "고칠 곳이 없었습니다"라고 사실대로.
[출력] body(교정한 완성 본문) · fixes(2~3줄) · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 한국어 블로그 원고를 마지막으로 검수하는 편집장이다. 사실은 그대로 두고 거짓 경험담·AI 문체·양식 누락·맞춤법만 고친다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_PROOF,
    maxTokens: 4200,
    temperature: 0.55,
  };
}

/* ---------------------------------------------------------------- 🎬 쇼츠 4번 양식 분석 · 쇼츠 대본 · 쇼츠 2차 검수 */

/** 쇼츠 양식(1·2·3번 프리셋 또는 4번 분석본)을 프롬프트 블록으로 바꾼다. */
function shortsStyleBlock(st, no) {
  if (!st || typeof st !== 'object') return '';
  const name = s(st.name || st.styleName, 60);
  if (!name) return '';
  const caption = s(st.captionRule || st.caption, 320);
  const avoid = arr(st.avoid, 6).map((x) => `- ${s(x, 160)}`).join('\n');
  return [
    `\n[쇼츠 양식 — 「${name}」 스타일${no ? ' (' + no + '번)' : ''} · 훅·리듬·자막·말투만 따른다]`,
    st.who ? `- 이 채널에서 배울 점: ${s(st.who, 200)}` : '',
    st.hook ? `- 3초 훅 패턴: ${s(st.hook, 320)}` : '',
    st.pacing ? `- 컷·텀포 리듬: ${s(st.pacing, 320)}` : '',
    arr(st.plan, 6).length ? `- 구간 설계(이 시간·순서를 그대로 따른다. beats 의 at 을 이 구간에 맞춘다):\n${arr(st.plan, 6).map((x) => `  · ${s(x, 90)}`).join('\n')}` : '',
    caption ? `- 자막·기호 슬관: ${caption}` : '',
    st.tone ? `- 말투/성우 톤: ${s(st.tone, 320)}` : '',
    avoid ? `- 금지 규칙(어기면 실패):\n${avoid}` : '',
    '- 저작권: 이 채널의 실제 대사·자막을 옮기지 않는다. 리듬과 구성만 내 주제로 다시 쓴다. 영상에 이 채널 이름을 쓰지 않는다.',
  ]
    .filter(Boolean)
    .join('\n');
}

function promptShortsScript(b) {
  const themeName = s(b.themeName || b.theme, 40);
  /* v3(구어체·대형 훅·카라오케·숫자 변환) 옵션 — 사용자가 끄면 예전 대본 그대로 */
  const v3 = (b.v3 === true || b.v3 === '1' || b.casual === true);
  const v3Num = b.numNormalize !== false;
  const v3Block = v3 ? `
[V3 연출 — 이번 대본은 "진짜 유튜버" 구어체로 쓴다]
a) 말투: "~했습니다" 대신 "~했죠", "~인데요", "이거 모르면", "잠깐만요"처럼 말을 거는 구어체. 한 문장은 20자 안팎으로 끊고, 접속사는 입에 붙는 것만 쓴다(근데, 그래서, 그런데).
b) hookTitle: 첫 1.5초 화면 절반을 채우는 대형 타이틀, 12자 이내. 비우면 실패다. 질문·숫자·반전 중 하나로. hook 문장을 그대로 줄이지 말고 화면용으로 다시 쓴다.
c) highlightWords: 카라오케 자막에서 노랗게 칠할 단어 3~6개. 숫자·고유명사 위주, 조사 없이.
d) bgmMood: news | calm | tension | upbeat 중 하나.${v3Num ? `
e) 숫자: spoken 안의 숫자는 자막과 똑같이 숫자로 쓴다(예: "5,090", "3,400억"). 읽는 소리 변환은 합성 엔진이 알아서 하므로 한글로 풀어 쓰지 않는다.` : ''}` : '';
  const duration = Math.min(90, Math.max(20, Number(b.durationSec) || 50));
  const src = s(b.sourceMaterial, 6000);
  const note = s(b.experienceNote, 1500);
  const style = shortsStyleBlock(b.shortsStyle, Number(b.styleNo) || 1);
  /* 🐶🐰🐧 분야 흥행 공식 — 클라이언트가 만든 구조 지침(있을 때만) */
  const formula = s(b.formulaBlock, 1600);
  const user = [
    themeName ? `테마: ${themeName}` : '',
    `주제: ${s(b.topic, 160)}`,
    style,
    formula ? `\n${formula}` : '',
    src ? `\n[참고 자료 — 사실 근거로만 인용. 내 경험처럼 쓰지 않는다]\n"""${src}"""` : '',
    note ? `\n[내 경험 메모 — 1인칭 경험은 여기 있는 것만]\n"""${note}"""` : '\n[내 경험 메모 — 없음. 1인칭 경험담은 쓰지 않는다]',
    banLine(b.banPhrases),
    `
[해야 할 일 — ${duration}초 세로 쇼츠 대본]
1) 첫 3초 훅: 인사·자기소개 없이 결론·숫자·반전 중 하나로 바로 시작한다. 위 양식의 훅 패턴을 그대로 따른다. hook 은 말할 문장, hookCaption 은 화면 자막(공백 포함 15~20자)이다.
2) 본문은 4~7컷. 한 컷은 4~10초, 입으로 말하는 1~2문장만. 위 양식의 컷 리듬을 따른다.
   spoken 은 반드시 ‘입으로 말하는 대사’다. "영상을 켠다·확인한다·관찰한다" 같은 지시문·설명문을 쓰지 않는다. 화면 설명은 shot 에만 쓴다.
   말투는 뉴스 보도체가 아니라 시청자에게 말을 거는 구어체다("~해보세요", "이거 모르면", "3초만 보세요").
3) 자막(caption)은 공백 포함 15~20자로 끊는다. 모바일에서 한 줄로 읽혀야 한다. 말을 그대로 받아쓰지 말고 핵심만 남긴다.
4) 화면 지시(shot)는 실제로 찍을 수 있는 것으로 쓴다(예: 제품 클로즈업, 손으로 누르는 장면, 지도 한 장).
5) 엔딩은 여운 한 줄 + 저장·공유 유도(노골적인 구독 부탁 금지).
6) 마지막 자막(captionGuide)은 어떤 자막 스타일이 맞는지 이유와 함께 1줄.
7) 자료에 없는 수치·가격·고유명사·방송 시간을 새로 만들지 않는다. 모르면 "[확인 필요]"로 두고 warnings 에 적는다.
8) 양식의 금지 규칙을 어기면 실패다.
9) 첫 3초 훅 A/B 2버전(hookAB): 같은 사실을 두 심리 축으로 만든다.
   - A 경고형(warning): 손해·실수·위험·놓치면 생기는 일을 먼저 던진다. 겁주기 과장 금지, 사실 기반.
   - B 기회형(opportunity): 이득·숫자·반전·이 기회를 먼저 던진다. 낚시성 숫자 조작 금지.
   각각 말할 문장(warning/opportunity, 20자 내외)과 화면 자막(warningCaption/opportunityCaption, 15~20자). 두 버전은 첫 문장만 다르고 본문은 같은 대본을 쓴다.
10) 무한 루프 엔딩(loopEnding): 마지막 문장을 읽고 바로 첫 훅으로 돌아가도 말이 이어지게 쓴다. 억지 말장난·같은 문장 복사 금지. 엔딩의 spoken 은 이 루프 문구로 끝낸다.
11) 댓글 유도(commentQuestion): 시청자가 3초에 답할 수 있는 이지선다·경험형 질문 1개. 논쟁·정답 맞히기 유도 금지.
    고정 댓글(pinnedComment): 질문을 한 번 더 확인 + 자료에 있는 추가 정보 1줄 + 저장 유도. 링크·광고·연락처 금지.
12) 배포 문구: reelsCaption(인스타 릴스 2~3줄, 첫 줄 후킹·마지막 저장 유도) + reelsHashtags(8~12개, # 없이, #shorts 포함),
    clipCaption(네이버 클립 한 줄 40자 내외) + clipHashtags(5~8개, # 없이). 자료에 없는 브랜드·지역명을 해시태그로 만들지 않는다.
13) seriesBadge: 이 시리즈를 한눈에 알아볼 MP4 상단 칩 (영문 2~3단어 대문자 또는 한글 8자 이내, 예: MARKET CLOSE·동탄 주말 코스).
14) ttsVoice: 나레이션 톤 1줄 (예: "차분한 남성 · 또박또박 · 숫자는 또렷하게").
15) titleOptions: 클릭률(CTR) 관점의 제목 3안을 서로 다른 각도로 만든다 — 각 32자 이내. 비우면 실패다(3개 모두 채운다).
    - 호기심형: 궁금증을 남기는 질문·반전 (예: "왜 10시엔 아무도 안 사는 걸까")
    - 숫자 직격형: 가장 센 숫자 1개를 앞세운다 (예: "5,000 깨졌다, 오늘 남은 1시간")
    - 비교형: A vs B 구도를 제목에 드러낸다 (예: "엔터 vs 반도체, 오늘 돈은 어디로")
${v3Block}
[출력] title · titleOptions · hook · hookCaption · hookTitle · highlightWords · bgmMood · beats · ending · captionGuide · seriesBadge · ttsVoice · hookAB · loopEnding · commentQuestion · pinnedComment · reelsCaption · reelsHashtags · clipCaption · clipHashtags · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 한국어 유튜브 쇼츠 대본 작가다. 3초 안에 손가락을 멈추게 하고, 말과 자막을 따로 설계한다. 확인한 내용만 쓴다. ${HONESTY}`,
    user,
    schema: SCHEMA_SHORT_SCRIPT,
    maxTokens: 2600,
    temperature: 0.9,
  };
}

function promptAnalyzeShortsStyle(b) {
  const text = s(b.sourceText, 9000);
  const user = [
    b.title ? `영상 제목: ${s(b.title, 160)}` : '',
    b.author ? `채널 이름(확인된 값): ${s(b.author, 60)}` : '',
    b.themeName ? `테마: ${s(b.themeName, 40)}` : '',
    `\n[분석할 자료 — 이 영상·채널의 자막(또는 사용자가 붙여넣은 대본). 문장을 베끼지 않고 ‘만드는 방식’만 뽑는다]\n"""${text}"""`,
    `
[해야 할 일 — 이 쇼츠의 양식 DNA 추출]
1) styleName: 위에 채널 이름이 있으면 그 이름을 그대로. 없으면 자막에서 확인되는 이름, 그것도 없으면 정확히 "내 쇼츠". 영상 제목을 채널 이름으로 쓰지 않는다.
2) hook: 첫 3초 훅 패턴 — 어떤 문장으로 시작하는지(질문·숫자·반전·명령 등), 평균 길이를 1~2문장으로.
3) pacing: 컷·텀포 리듬 — 몇 초마다 전환하는지, 한 컷에 몇 문장을 말하는지 1~2문장.
4) captionRule: 자막·기호 슬관 — 한 줄 길이, 강조 방식, 숫자·이모지 사용 1~2문장.
5) tone: 말투/성우 톤 — 어미, 말 속도, 감정 높낮이 1~2문장.
6) avoid: 이 채널이 지키는 금기·주의 2~4개.

[저작권·정직 규칙 — 어기면 실패다]
- 자막 문장을 그대로 옮기거나 인용하지 않는다. 숫자·고유명사·사연 내용은 결과에 쓰지 않는다. 오직 훅 패턴·리듬·자막 슬관·말투만.
- 자료에 없는 슬관을 지어내지 않는다. 비슷한 예가 여러 번 보일 때만 적는다.
- 결과는 ‘다른 사람이 자기 주제로 같은 양식대로 쓸 수 있는 규칙’이어야 한다.
[출력] styleName · hook · pacing · captionRule · tone · avoid JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 유튜브 쇼츠의 구성·리듬을 분석하는 편집자다. 남의 대본에서 훅 패턴·컷 리듬·자막 슬관·말투만 뽑아 재사용 가능한 규칙으로 정리한다. 남의 문장을 베끼지 않는다. ${HONESTY}`,
    user,
    schema: SCHEMA_SHORTS_STYLE,
    maxTokens: 1100,
    temperature: 0.5,
  };
}

function promptProofreadShorts(b) {
  const style = shortsStyleBlock(b.shortsStyle, Number(b.styleNo) || 0);
  const user = [
    b.topic ? `주제: ${s(b.topic, 160)}` : '',
    b.themeName ? `쇼츠 테마: ${s(b.themeName, 40)}` : '',
    style,
    `\n[검수할 쇼츠 대본 — 고치면 이 형식을 그대로 유지한다]\n"""${s(b.body, 16000)}"""`,
    banLine(b.banPhrases),
    `
[해야 할 일 — 쇼츠 편집장 2차 검수. 아래 5가지만 고친다]
① 첫 3초 훅이 스크롤을 멈출 만큼 날카로운가 — 아니면 결론·숫자·반전으로 다시 쓴다.
② 자막 한 줄이 모바일 가독성(공백 포함 15~20자)인가 — 길면 끊고, 의미 없는 말은 지운다.
③ 입으로 읽기 편한 구어체인가 — 문어체·번역체·AI 상투어를 고친다.
④ 1~4번 양식의 리듬(컷 길이·문장 수·말투)이 살아 있는가 — 빠진 리듬을 되살린다.
⑤ 과장·거짓 사실을 지운다 — 확인하지 않은 수치·가격·고유명사·방송 시간은 "[확인 필요]"로 바꾼다.

[형식 유지 — 이기는 실패다]
- 첫 줄 "🎬 제목", "테마: …" 줄, "[0:00–0:03] 훅" 같은 시간 구간 줄, "말:"·"자막:"·"화면:" 라벨, "[엔딩]", "자막 가이드:" 줄을 그대로 둔다.
- 컷 수와 시간 구간을 임의로 합치거나 늘리지 않는다. 문장만 고친다.
- 분량은 원문의 90~115%를 유지한다. 통째로 요약하지 않는다.
- fixes 에는 실제로 고친 것을 2~3줄로. 안 고쳤으면 "고칠 곳이 없었습니다"라고 사실대로.
[출력] body(교정한 대본 전체) · fixes(2~3줄) · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 한국어 쇼츠 대본을 마지막으로 검수하는 편집장이다. 훅 강도·자막 길이·구어체·양식 리듬·과장만 고친다. 사실은 새로 만들지 않는다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_PROOF,
    maxTokens: 4200,
    temperature: 0.55,
  };
}

/* ---------------------------------------------------------------- Gemini 호출 */

function extractJson(text) {
  let t = String(text || '').trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  }
  try {
    return JSON.parse(t);
  } catch (_) {}
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = t.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch (_) {}
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch (_) {}
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * streamGenerateContent(SSE)로 호출한다.
 *  - 첫 토큰이 FIRST_TOKEN_MS 안에 오지 않으면 그 모델은 죽은 것으로 보고 즉시 다음 모델로 넘어간다.
 *    (모델이 완전히 멈춘 경우 30초를 버리지 않기 위한 장치)
 *  - 첫 토큰이 온 뒤에는 attemptDeadline 까지 계속 받아 긴 글도 끝까지 받는다.
 */
async function callModel(model, prompt, attemptDeadline, thinkingOff) {
  const key = process.env.GEMINI_API_KEY;
  const url = `${API_ROOT}${model}:streamGenerateContent?alt=sse&key=${key}`;
  const gen = {
    temperature: prompt.temperature,
    maxOutputTokens: prompt.maxTokens,
    responseMimeType: 'application/json',
    responseSchema: prompt.schema,
  };
  const wantThinkingOff = thinkingOff !== false && THINKING_UNSUPPORTED.indexOf(model) < 0;
  if (wantThinkingOff) gen.thinkingConfig = THINKING_OFF;
  // 📷 내 사진 — Gemini 멀티모달(inlineData). 본문 텍스트보다 앞에 두고 같이 보낸다.
  const imgParts = (Array.isArray(prompt.images) ? prompt.images : [])
    .filter((im) => im && im.data && /^image\/(jpeg|png|webp)$/.test(String(im.mimeType || '')))
    .slice(0, MAX_INLINE_IMAGES)
    .map((im) => ({ inlineData: { mimeType: im.mimeType, data: im.data } }));
  const mediaParts = (Array.isArray(prompt.media) ? prompt.media : [])
    .filter((m) => m && m.data && SUMMARY_MEDIA_MIMES.indexOf(String(m.mimeType || '').toLowerCase()) >= 0)
    .slice(0, 1)
    .map((m) => ({ inlineData: { mimeType: m.mimeType, data: m.data } }));
  const userParts = mediaParts.length
    ? imgParts.concat(mediaParts, [{ text: prompt.user }])
    : imgParts.length
      ? imgParts.concat([{ text: prompt.user }])
      : [{ text: prompt.user }];
  const body = {
    systemInstruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: gen,
  };
  const ctrl = new AbortController();
  let phase = 'first'; // first | body
  let timer = null;
  const armFirst = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      phase = 'first';
      ctrl.abort(Object.assign(new Error('첫 토큰 대기 초과'), { code: 'FIRST_TOKEN' }));
    }, Math.max(2500, Math.min(FIRST_TOKEN_MS, attemptDeadline - Date.now())));
  };
  const armBody = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      phase = 'body';
      ctrl.abort(Object.assign(new Error('응답 본문 수신 초과'), { code: 'BODY_TIMEOUT' }));
    }, Math.max(2500, attemptDeadline - Date.now()));
  };
  armFirst();
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const raw = await res.text();
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch (_) {}
      const status = res.status;
      const msg = (json && json.error && json.error.message) || raw.slice(0, 300);
      // thinkingConfig 를 지원하지 않는 모델이면 그 옵션만 빼고 한 번 더
      if (status === 400 && wantThinkingOff && /invalid argument/i.test(msg)) {
        clearTimeout(timer);
        return callModel(model, prompt, attemptDeadline, false);
      }
      const e = new Error(msg || `HTTP ${status}`);
      e.status = status;
      e.retryable = status === 503 || status === 429 || status === 500 || status === 504;
      e.geminiStatus = (json && json.error && json.error.status) || '';
      const det = (json && json.error && Array.isArray(json.error.details)) ? json.error.details : [];
      det.forEach((d) => {
        if (d && /RetryInfo/.test(String(d['@type'] || '')) && d.retryDelay) {
          const n = parseInt(String(d.retryDelay), 10);
          if (Number.isFinite(n)) e.retryDelaySec = n;
        }
        (d && Array.isArray(d.violations) ? d.violations : []).forEach((v) => {
          if (v && v.quotaId) e.quotaId = v.quotaId;
          if (v && v.quotaValue) e.quotaValue = v.quotaValue;
        });
      });
      throw e;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    let finish = '';
    let usage = null;
    let firstAt = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!firstAt) {
        firstAt = Date.now();
        armBody();
      }
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j = null;
        try {
          j = JSON.parse(payload);
        } catch (_) {
          continue;
        }
        if (j.error) {
          const e = new Error(j.error.message || 'stream error');
          e.status = j.error.code === 429 ? 429 : 503;
          e.retryable = true;
          e.geminiStatus = j.error.status || '';
          throw e;
        }
        const cand = (j.candidates && j.candidates[0]) || null;
        if (cand) {
          if (cand.finishReason) finish = cand.finishReason;
          const parts = (cand.content && cand.content.parts) || [];
          parts.forEach((p) => {
            if (p && p.text) text += p.text;
          });
        }
        if (j.usageMetadata) usage = j.usageMetadata;
      }
    }
    if (!text.trim()) {
      const e = new Error('빈 응답(토큰 없음)');
      e.status = 503;
      e.retryable = true;
      e.geminiStatus = 'EMPTY';
      throw e;
    }
    clearTimeout(timer);
    return { model, text: text.trim(), finish, usage: usage || {}, firstMs: firstAt ? firstAt - t0 : 0, elapsed: Date.now() - t0 };
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'FIRST_TOKEN' || err.code === 'BODY_TIMEOUT')) {
      const first = err.code !== 'BODY_TIMEOUT';
      const e = new Error(first ? `첫 토큰 ${FIRST_TOKEN_MS / 1000}초 안에 응답 없음` : '응답 본문 수신 시간 초과');
      e.status = 504;
      e.retryable = true;
      e.geminiStatus = first ? 'NO_FIRST_TOKEN' : 'BODY_TIMEOUT';
      e.noFirstToken = first;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function modelOrder() {
  const fb = FALLBACK_MODELS.filter((m) => m && m !== PRIMARY_MODEL);
  if (Date.now() < primaryDownUntil) return fb.concat([PRIMARY_MODEL]);
  return [PRIMARY_MODEL].concat(fb);
}

/** 순서대로 시도. 실제로 답한 모델을 model 에 정직하게 담아 돌려준다. */
async function generate(prompt, deadline) {
  const order = modelOrder().filter((m, i, a) => m && a.indexOf(m) === i);
  const tries = [];
  // 1패스: 3.8 Flash → Lite Latest → 3 Flash. 2패스: 일시 혼잡(503/타임아웃)이었으면 한 바퀴 더.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < order.length; i++) {
      const model = order[i];
      const remaining = deadline - Date.now();
      if (remaining < 6000) {
        if (pass === 0) tries.push({ model, status: 0, message: '건너뜀(남은 시간 부족)' });
        break;
      }
      const isLast = i === order.length - 1;
      // 3.8 Flash 가 완전히 멈춘 상태에서 시간을 다 쓰지 않도록 뒤 모델 몫을 남겨 둔다.
      const cap = isLast ? remaining : Math.min(model === PRIMARY_MODEL ? 30000 : 25000, Math.max(8000, remaining - 12000));
      const attemptDeadline = Date.now() + Math.max(8000, cap);
      try {
        const out = await callModel(model, prompt, attemptDeadline);
        if (model === PRIMARY_MODEL) primaryDownUntil = 0;
        return { ...out, tries, fellBack: model !== PRIMARY_MODEL };
      } catch (err) {
        const downish = err.status === 503 || err.status === 429 || err.noFirstToken;
        tries.push({
          model,
          pass: pass + 1,
          status: err.status || 0,
          message: String(err.message || '').slice(0, 200),
          quotaId: err.quotaId || undefined,
          retryDelaySec: err.retryDelaySec || undefined,
        });
        if (err.retryable === false) throw Object.assign(err, { tries });
        if (model === PRIMARY_MODEL && downish) primaryDownUntil = Date.now() + PRIMARY_COOLDOWN_MS;
        if (i < order.length - 1) await sleep(120);
      }
    }
    const transient = tries.some((t) => t.status === 503 || t.status === 504 || t.status === 0);
    const quotaOnly = tries.length > 0 && tries.every((t) => t.status === 429);
    if (pass === 0 && transient && !quotaOnly && deadline - Date.now() > 16000) {
      await sleep(700);
      continue;
    }
    break;
  }
  const quotaHit = tries.length > 0 && tries.every((t) => t.status === 429);
  const e = new Error(quotaHit ? '무료 티어 하루 요청 한도를 다 썼습니다.' : '모든 모델이 응답하지 않았습니다.');
  e.status = quotaHit ? 429 : 503;
  e.code = quotaHit ? 'quota_exceeded' : 'all_models_busy';
  e.tries = tries;
  e.retryDelaySec = tries.reduce((a, t) => (t.retryDelaySec ? Math.min(a || 1e9, t.retryDelaySec) : a), null);
  e.quotaId = (tries.find((t) => t.quotaId) || {}).quotaId || null;
  throw e;
}

/* ---------------------------------------------------------------- 결과 정규화 */

function normBlog(data, banPhrases) {
  const titles = arr(data.titles, 3)
    .map((t) => (typeof t === 'string' ? { type: '제목', text: t } : { type: s(t && t.type, 20) || '제목', text: s(t && t.text, 80) }))
    .filter((t) => t.text);
  const gaps = arr(data.gaps, 3).map((g) => (typeof g === 'string' ? g : JSON.stringify(g))).map((g) => s(g, 300)).filter(Boolean);
  const seoKeywords = arr(data.seoKeywords, 8).map((k) => s(k, 40).replace(/^#/, '').trim()).filter(Boolean);
  const body = s(data.body, 20000);
  const warnings = arr(data.warnings, 10).map((w) => s(w, 200)).filter(Boolean);
  const banHits = scanBans(body, banPhrases);
  if (!body) warnings.push('본문이 비어 있습니다. 다시 생성해 주세요.');
  const photoSlots = (body.match(/\[(?:📸|📷)\s*사진[^\]]*\]/g) || []).length;
  const myPhotoSlots = (body.match(/\[(?:📸|📷)\s*내 사진\s*\d+[^\]]*\]/g) || []).length;
  return { titles, seoKeywords, gaps, body, warnings, banHits, needsCheck: (body.match(/\[확인 필요\]/g) || []).length, photoSlots, myPhotoSlots };
}

function scanBans(text, banPhrases) {
  const list = (banPhrases && banPhrases.length ? banPhrases : BAN_DEFAULT).filter(Boolean);
  const t = String(text || '');
  return list.filter((p) => t.indexOf(p) > -1);
}

function normVideo(data, clips) {
  const hooks = arr(data.hooks, 4)
    .map((h) => (typeof h === 'string' ? { tag: '후킹', text: h } : { tag: s(h && h.tag, 20) || '후킹', text: s(h && h.text, 80) }))
    .filter((h) => h.text);
  const warnings = arr(data.warnings, 10).map((w) => s(w, 200)).filter(Boolean);
  const cuts = [];
  arr(data.cuts, 20).forEach((c) => {
    const idx = Math.trunc(num(c && c.clipIndex, -1));
    if (idx < 0) return;
    const clip = Array.isArray(clips) ? clips[idx] : null;
    let start = round1(num(c.startSec, 0));
    let end = round1(num(c.endSec, start + 2));
    if (clip) {
      const dur = round1(num(clip.dur, 0)) || end;
      const cin = Math.max(0, round1(num(clip.in, 0)));
      const cout = Math.min(round1(num(clip.out, dur)), dur) || dur;
      start = Math.min(Math.max(start, cin), cout);
      end = Math.min(Math.max(end, start + 0.5), cout);
      if (end - start < 0.4) {
        warnings.push(`컷 ${cuts.length + 1}: ${s(clip.name, 40)} 구간이 0.4초 미만이라 조정했습니다.`);
        end = Math.min(start + 1, cout);
      }
    }
    const trans = ['cut', 'fade', 'slide', 'zoom'].indexOf(s(c && c.transition, 10)) > -1 ? c.transition : 'cut';
    cuts.push({
      clipIndex: idx,
      clipName: clip ? s(clip.name, 80) : `클립 ${idx}`,
      startSec: round1(start),
      endSec: round1(end),
      durSec: round1(Math.max(0, end - start)),
      caption: s(c && c.caption, 120),
      transition: trans,
    });
  });
  const total = round1(cuts.reduce((a, c) => a + c.durSec, 0));
  if (cuts.length && total < 15) {
    warnings.push(`컷 총 길이가 ${total}초로 짧습니다(권장 20~45초). [편집 실행]을 한 번 더 누르면 다르게 설계됩니다.`);
  }
  const bgm = data.bgm || {};
  return {
    hooks,
    cuts,
    totalSec: total,
    bgm: {
      ducking: s(bgm.ducking, 200) || '말 시작 전 -12dB, 문장 끝 0.4초 뒤 복귀',
      notes: arr(bgm.notes, 6).map((x) => s(x, 160)).filter(Boolean),
    },
    warnings,
  };
}

function normYt(data) {
  const gaps = arr(data.gaps, 3)
    .map((g) => (typeof g === 'string' ? { title: g, why: '', how: '' } : { title: s(g && g.title, 80), why: s(g && g.why, 200), how: s(g && g.how, 200) }))
    .filter((g) => g.title);
  const sh = data.shorts || {};
  return {
    gaps,
    shorts: {
      title: s(sh.title, 80),
      hook: s(sh.hook, 120),
      scenes: arr(sh.scenes, 8).map((x) => ({ time: s(x && x.time, 20), line: s(x && x.line, 240) })).filter((x) => x.line),
      cta: s(sh.cta, 120),
    },
    warnings: arr(data.warnings, 10).map((w) => s(w, 200)).filter(Boolean),
  };
}

function normShorts(data) {
  return {
    title: s(data.title, 80),
    hook: s(data.hook, 120),
    scenes: arr(data.scenes, 8).map((x) => ({ time: s(x && x.time, 20), line: s(x && x.line, 240) })).filter((x) => x.line),
    ending: s(data.ending, 160),
    captionGuide: s(data.captionGuide, 160),
    warnings: arr(data.warnings, 10).map((w) => s(w, 200)).filter(Boolean),
  };
}

function normRewrite(data, banPhrases) {
  const body = s(data && data.body, 24000);
  const changed = arr(data && data.changed, 6).map((x) => s(x, 140)).filter(Boolean);
  const warnings = arr(data && data.warnings, 8).map((x) => s(x, 200)).filter(Boolean);
  const banHits = scanBans(body, banPhrases);
  if (!body) warnings.push('본문이 비어 있습니다. 다시 시도해 주세요.');
  return {
    body,
    changed,
    warnings,
    banHits,
    chars: body.length,
    needsCheck: (body.match(/\[확인 필요\]/g) || []).length,
    photoSlots: (body.match(/\[(?:📸|📷)\s*사진[^\]]*\]/g) || []).length,
    headings: (body.match(/^##\s+/gm) || []).length,
    tables: (body.match(/^\|[^\n]*\|\s*$/gm) || []).length,
  };
}

function normNaverNote(data, banPhrases) {
  const body = s(data && data.body, 24000);
  const title = s(data && data.title, 120);
  const tags = arr(data && data.tags, 14).map((x) => s(x, 30).replace(/^#/, '')).filter(Boolean);
  const changed = arr(data && data.changed, 6).map((x) => s(x, 140)).filter(Boolean);
  const warnings = arr(data && data.warnings, 8).map((x) => s(x, 200)).filter(Boolean);
  const banHits = scanBans(body, banPhrases);
  if (!body) warnings.push('본문이 비어 있습니다. 다시 시도해 주세요.');
  if (!tags.length) warnings.push('해시태그가 비어 왔습니다 — [🏷️ 태그 10개 복사]로 채울 수 있습니다.');
  return {
    title,
    body,
    tags,
    changed,
    warnings,
    banHits,
    chars: body.length,
    needsCheck: (body.match(/\[확인 필요\]/g) || []).length,
    headings: (body.match(/^##\s+/gm) || []).length,
    linkLines: (body.match(/https?:\/\//g) || []).length,
  };
}

function normHumanize(data, banPhrases) {
  const body = s(data && data.body, 24000);
  const removed = arr(data && data.removed, 12).map((x) => s(x, 80)).filter(Boolean);
  const warnings = arr(data && data.warnings, 8).map((x) => s(x, 200)).filter(Boolean);
  const banHits = scanBans(body, banPhrases);
  if (!body) warnings.push('본문이 비어 있습니다. 다시 시도해 주세요.');
  return {
    body,
    removed,
    warnings,
    banHits,
    chars: body.length,
    sentences: (body.match(/[.!?。](\s|$)/g) || []).length,
    needsCheck: (body.match(/\[확인 필요\]/g) || []).length,
    photoSlots: (body.match(/\[(?:📸|📷)\s*사진[^\]]*\]/g) || []).length,
  };
}

function normTags(list, max) {
  return arr(list, max)
    .map((x) => s(x, 40).replace(/^#+/, '').replace(/[\s#]+/g, ''))
    .filter(Boolean)
    .filter((x, i, a) => a.indexOf(x) === i);
}

function normMulti(data, banPhrases) {
  const insta = (data && data.insta) || {};
  const lines = arr(insta.lines, 5).map((x) => s(x, 120)).filter(Boolean).slice(0, 3);
  const hashtags = normTags(insta.hashtags, 12).slice(0, 10);
  const sh = normShorts((data && data.shorts) || {});
  const warnings = arr(data && data.warnings, 8).map((x) => s(x, 200)).filter(Boolean);
  if (!lines.length) warnings.push('인스타 3줄 요약이 비어 왔습니다. 한 번 더 눌러 주세요.');
  const banHits = scanBans(lines.join(' ') + ' ' + sh.hook + ' ' + sh.scenes.map((x) => x.line).join(' '), banPhrases);
  return {
    insta: {
      lines,
      hashtags,
      text: lines.join('\n') + (hashtags.length ? '\n\n' + hashtags.map((t) => '#' + t).join(' ') : ''),
    },
    shorts: sh,
    warnings,
    banHits,
  };
}

function normSeo(data) {
  const keywords = arr(data && data.keywords, 12).map((x) => s(x, 40)).filter(Boolean).slice(0, 10);
  const hashtags = normTags(data && data.hashtags, 12).slice(0, 10);
  const warnings = arr(data && data.warnings, 8).map((x) => s(x, 200)).filter(Boolean);
  if (!keywords.length) warnings.push('키워드가 비어 왔습니다. 한 번 더 눌러 주세요.');
  return { keywords, hashtags, warnings };
}

/** 마무리 박스 → 본문에 붙일 마크다운(인용구 박스 + 질문). 네이버 서식 복사에서도 박스로 살아난다. */
function closingMarkdown(d) {
  const q = s(d && d.question, 200);
  const title = s(d && d.boxTitle, 40) || '🔗 링크 안내';
  const items = arr(d && d.items, 4)
    .map((x) => ({ label: s(x && x.label, 40), hint: s(x && x.hint, 120) }))
    .filter((x) => x.label);
  const L = [];
  L.push('> **' + title + '**');
  if (items.length) {
    items.forEach((it) => {
      L.push('> · **' + it.label + '** — ' + it.hint + ' : [확인 필요]');
    });
  } else {
    L.push('> · 링크: [확인 필요]');
  }
  if (q) {
    L.push('');
    L.push(q);
  }
  return L.join('\n');
}

function normClosing(data) {
  const question = s(data && data.question, 200);
  const boxTitle = s(data && data.boxTitle, 40) || '🔗 링크 안내';
  const items = arr(data && data.items, 4)
    .map((x) => ({ label: s(x && x.label, 40), hint: s(x && x.hint, 120) }))
    .filter((x) => x.label);
  const warnings = arr(data && data.warnings, 8).map((x) => s(x, 200)).filter(Boolean);
  if (!question) warnings.push('댓글 유도 질문이 비어 왔습니다. 다시 시도해 주세요.');
  const markdown = closingMarkdown({ question, boxTitle, items });
  return { question, boxTitle, items, markdown, warnings };
}

function normStyle(data) {
  const styleName = s(data && data.styleName, 40) || '내 블로그';
  const structure = arr(data && data.structure, 8).map((x) => s(x, 90)).filter(Boolean);
  const symbols = arr(data && data.symbols, 8).map((x) => s(x, 120)).filter(Boolean);
  const avoid = arr(data && data.avoid, 6).map((x) => s(x, 120)).filter(Boolean);
  const rhythm = s(data && data.rhythm, 320);
  const tone = s(data && data.tone, 320);
  const warnings = [];
  if (structure.length < 3) warnings.push('구성 뼈대가 3단계 미만입니다 — 글 본문이 짧았을 수 있어요.');
  if (!rhythm) warnings.push('문단 호흡을 찾지 못했습니다.');
  if (!tone) warnings.push('말투 특징을 찾지 못했습니다.');
  return { styleName, structure, rhythm, symbols, tone, avoid, warnings };
}

function normProof(data, banPhrases) {
  const body = s(data && data.body, 24000);
  const fixes = arr(data && data.fixes, 5).map((x) => s(x, 140)).filter(Boolean);
  const warnings = arr(data && data.warnings, 10).map((x) => s(x, 200)).filter(Boolean);
  const banHits = scanBans(body, banPhrases);
  if (!body) warnings.push('본문이 비어 있습니다. 다시 시도해 주세요.');
  return {
    body,
    fixes,
    warnings,
    banHits,
    chars: body.length,
    needsCheck: (body.match(/\[확인 필요\]/g) || []).length,
    photoSlots: (body.match(/\[(?:📸|📷)\s*사진[^\]]*\]/g) || []).length,
    headings: (body.match(/^##\s+/gm) || []).length,
    tables: (body.match(/^\|[^\n]*\|\s*$/gm) || []).length,
  };
}

function normShortsStyle(data) {
  const styleName = s(data && data.styleName, 40) || '내 쇼츠';
  const hook = s(data && data.hook, 320);
  const pacing = s(data && data.pacing, 320);
  const captionRule = s(data && (data.captionRule || data.caption), 320);
  const tone = s(data && data.tone, 320);
  const avoid = arr(data && data.avoid, 6).map((x) => s(x, 140)).filter(Boolean);
  const warnings = [];
  if (!hook) warnings.push('3초 훅 패턴을 찾지 못했습니다.');
  if (!pacing) warnings.push('컷 리듬을 찾지 못했습니다.');
  if (!captionRule) warnings.push('자막·기호 습관을 찾지 못했습니다.');
  if (!tone) warnings.push('말투 특징을 찾지 못했습니다.');
  return { styleName, hook, pacing, captionRule, tone, avoid, warnings };
}

function normShortsScript(data) {
  const title = s(data && data.title, 80) || '쇼츠 대본';
  const hook = s(data && data.hook, 200);
  const hookCaption = s(data && data.hookCaption, 120);
  const beats = arr(data && data.beats, 9)
    .map((x) => ({
      at: s(x && x.at, 24),
      spoken: s(x && x.spoken, 400),
      caption: s(x && x.caption, 120),
      shot: s(x && x.shot, 200),
    }))
    .filter((x) => x.spoken || x.caption);
  const ending = {
    spoken: s(data && data.ending && data.ending.spoken, 300),
    caption: s(data && data.ending && data.ending.caption, 120),
  };
  const captionGuide = s(data && data.captionGuide, 300);
  const seriesBadge = s(data && data.seriesBadge, 24);
  const ttsVoice = s(data && data.ttsVoice, 80);
  const titleOptions = arr(data && data.titleOptions, 3)
    .map((t) => ({ type: s(t && t.type, 16) || '제목', text: s(t && t.text, 80) }))
    .filter((t) => t.text);
  const hookTitle = s(data && data.hookTitle, 40);
  const highlightWords = arr(data && data.highlightWords, 8).map((x) => s(x, 24).replace(/^#/, '')).filter(Boolean);
  const bgmMood = s(data && data.bgmMood, 20);
  const abRaw = (data && data.hookAB) || {};
  const hookAB = {
    warning: s(abRaw.warning, 200),
    warningCaption: s(abRaw.warningCaption, 120),
    opportunity: s(abRaw.opportunity, 200),
    opportunityCaption: s(abRaw.opportunityCaption, 120),
  };
  const loopEnding = s(data && data.loopEnding, 160);
  const commentQuestion = s(data && data.commentQuestion, 200);
  const pinnedComment = s(data && data.pinnedComment, 300);
  const reelsCaption = s(data && data.reelsCaption, 400);
  const reelsHashtags = arr(data && data.reelsHashtags, 14).map((x) => s(x, 30).replace(/^#/, '')).filter(Boolean);
  const clipCaption = s(data && data.clipCaption, 120);
  const clipHashtags = arr(data && data.clipHashtags, 10).map((x) => s(x, 30).replace(/^#/, '')).filter(Boolean);
  const warnings = arr(data && data.warnings, 10).map((x) => s(x, 200)).filter(Boolean);
  if (!hook) warnings.push('첫 3초 훅이 비어 왔습니다. 다시 눌러 주세요.');
  if (beats.length < 3) warnings.push('본문 컷이 3개 미만입니다 — 다시 생성하면 더 촘촘하게 나옵니다.');
  if (!hookAB.warning || !hookAB.opportunity) warnings.push('첫 3초 A/B 훅이 비어 왔습니다 — MP4 JSON에는 A/B 모두 필요합니다.');
  if (!loopEnding) warnings.push('무한 루프 엔딩 문구가 비어 왔습니다 — 다시 생성해 주세요.');
  if (!pinnedComment) warnings.push('고정 댓글 문구가 비어 왔습니다.');
  const longCaps = beats.concat([{ caption: ending.caption }]).filter((x) => {
    const n = Array.from(String(x.caption || '')).length;
    return n > 24;
  }).length;
  if (longCaps) warnings.push('자막 ' + longCaps + '줄이 24자를 넘습니다 — 2차 검수로 15~20자에 맞춰 주세요.');
  return { title, titleOptions, hook, hookCaption, hooks: { title: hookTitle, words: highlightWords, bgm: bgmMood }, hookTitle, highlightWords, bgmMood, beats, ending, captionGuide, seriesBadge, ttsVoice, hookAB, loopEnding, commentQuestion, pinnedComment, reelsCaption, reelsHashtags, clipCaption, clipHashtags, warnings, beatsNum: beats.length };
}

/* ---------------------------------------------------------------- 핸들러 */

const GEN_ACTIONS = [
  'blog',
  'summarize',
  'video_plan',
  'youtube_analyze',
  'blog_to_shorts',
  'rewrite_tone',
  'naver_note',
  'humanize',
  'multi_use',
  'seo_tags',
  'closing_box',
  'analyze_blogger_style',
  'proofread_draft',
  'analyze_shorts_style',
  'shorts_script',
];

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.end();
  }

  const keyConfigured = !!(process.env.GEMINI_API_KEY && String(process.env.GEMINI_API_KEY).trim());

  if (req.method === 'GET') {
    const u = new URL(req.url || '/', 'http://localhost');
    const act = s(u.searchParams.get('action'), 40);
    // 📸 사진 검색 — 블로그 생성과 별개로 GET 으로 쓴다(키 없이도 Wikimedia Commons 로 동작).
    if (act === 'photos') return handlePhotos(res, u);
    if (act === 'photo-dl') return handlePhotoDownload(res, u);
    if (act === 'fetch_official_photos' || act === 'official_photos') return handleOfficialPhotos(res, u);
    // 원클릭 다운로드 프록시 별칭: /api/content-ai?img_proxy=<이미지주소>
    if (u.searchParams.get('img_proxy')) return handlePhotoDownload(res, u);
    return send(res, 200, {
      ok: true,
      keyConfigured,
      model: PRIMARY_MODEL,
      fallbacks: FALLBACK_MODELS,
      actions: GEN_ACTIONS,
      youtube: {
        action: 'youtube_transcript',
        how: "POST { action:'youtube_transcript', url:'https://youtu.be/…' } → { ok, title, author, lengthSec, langLabel, auto, route, text, errors[] }",
        note: '자막을 못 받으면 ok:false + reason(no_captions / not_found) 과 제목·설명만 돌려준다.',
      },
      summary: {
        action: 'summarize',
        how:
          "POST { action:'summarize', kind:'youtube'|'doc'|'media', mode:'three'|'timeline'|'table'|'handoff', " +
          "url(유튜브) | text(문서·자막 붙여넣기) | media:{name,mimeType,data(base64),durationSec} (MP4·WEBM·MP3·M4A, 4MB 이하), focus } " +
          "→ { ok, data:{ title, headline, three[], timeline[], facts[], actions[], blog, shorts, markdown }, source }",
        limits: '본문 ' + SUMMARY_TEXT_MAX.toLocaleString('en-US') + '자 · 영상/음성 4MB · 요청 본문 약 4.2MB',
      },
      photos: {
        pixabay: !!(process.env.PIXABAY_API_KEY && String(process.env.PIXABAY_API_KEY).trim()),
        commons: true,
        kto: !!(process.env.KTO_API_KEY || process.env.TOUR_API_KEY),
        how: 'GET ?action=photos&q=검색어&n=6 → { ok, source, photos[] } / ?action=photo-dl&u=이미지주소&name=파일명.jpg',
        official:
          'GET ?action=fetch_official_photos&url=https://…(공식 홈페이지) 또는 &place=장소명 → { ok, title, photos[], sources[] } — 사설 IP·localhost·비http는 SSRF 차단',
        inline_images: 'POST { action:"blog", photos:[{ name, mime, data(base64), memo }] } — 최대 ' + MAX_INLINE_IMAGES + '장, Gemini 멀티모달',
      },
    });
  }

  if (req.method !== 'POST') {
    return send(res, 405, { ok: false, reason: 'method_not_allowed', message: 'POST 만 지원합니다.' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    if (err && err.code === 'body_too_large') {
      return send(res, 413, {
        ok: false,
        reason: 'body_too_large',
        message:
          '첨부가 커서 서버가 요청을 거절했습니다(요청 본문 한도 약 4.2MB). 영상·음성은 base64 로 보내져 원본의 약 1.33배로 커집니다 — ' +
          '3MB 이하로 줄이거나, 소리만 필요한 경우 음성만 짧게 잘라 다시 올려 주세요.',
      });
    }
    return send(res, 400, { ok: false, reason: err.code || 'bad_body', message: '요청 본문을 읽지 못했습니다.' });
  }

  const action = s(body.action, 30);
  // 🌐 공식 페이지 사진 — Gemini 키와 무관하게 먼저 처리한다(키 없이도 동작).
  if (action === 'fetch_official_photos' || action === 'official_photos') {
    const qp = new URLSearchParams();
    qp.set('url', s(body.url, 600));
    qp.set('place', s(body.place || body.q, 80));
    qp.set('n', String(Math.min(OFFICIAL_MAX_IMAGES, Math.max(3, Math.trunc(num(body.n, 8))))));
    return handleOfficialPhotos(res, { searchParams: qp });
  }
  // 유튜브 자막은 Gemini 호출이 아니라서 키 설정과 무관하게 먼저 처리한다.
  if (action === 'youtube_transcript') return handleYoutubeTranscript(res, body);
  if (GEN_ACTIONS.indexOf(action) < 0) {
    return send(res, 400, {
      ok: false,
      reason: 'unknown_action',
      message: 'action 은 ' + GEN_ACTIONS.join(' / ') + ' / youtube_transcript 중 하나여야 합니다.',
    });
  }

  if (!keyConfigured) return send(res, 503, noKeyBody());

  if (process.env.DISABLE_GEMINI === '1') {
    return send(res, 503, {
      ok: false,
      reason: 'disabled',
      message: '이 환경에서는 Gemini 호출이 꺼져 있습니다(DISABLE_GEMINI=1).',
      keyConfigured: true,
      model: PRIMARY_MODEL,
    });
  }

  const banPhrases = arr(body.banPhrases, 30).map((x) => s(x, 30)).filter(Boolean);

  let prompt;
  let srcMeta = null;
  if (action === 'blog') {
    if (!s(body.topic, 200)) return send(res, 400, { ok: false, reason: 'missing_topic', message: '주제(topic)가 필요합니다.' });
    prompt = promptBlog({ ...body, banPhrases, form: body.form || {} });
  } else if (action === 'video_plan') {
    const clips = arr(body.clips, 6);
    if (!clips.length && !s(body.story, 600)) {
      return send(res, 400, { ok: false, reason: 'missing_input', message: '영상 클립이나 스토리 방향 중 하나는 필요합니다.' });
    }
    prompt = promptVideo({ ...body, banPhrases, clips });
  } else if (action === 'youtube_analyze') {
    if (!s(body.query || body.topic, 120)) {
      return send(res, 400, { ok: false, reason: 'missing_query', message: '검색어(query)가 필요합니다.' });
    }
    prompt = promptYt({ ...body, banPhrases });
  } else if (action === 'rewrite_tone') {
    const draft = s(body.body, 16000);
    if (draft.length < 80) {
      return send(res, 400, { ok: false, reason: 'missing_body', message: '어조를 바꿀 초안이 필요합니다(80자 이상).' });
    }
    const tone = s(body.tone, 20) || 'honest';
    if (!TONES[tone]) {
      return send(res, 400, { ok: false, reason: 'unknown_tone', message: 'tone 은 honest / expert / warm 중 하나입니다.' });
    }
    prompt = promptRewrite({ ...body, banPhrases, body: draft, tone });
  } else if (action === 'naver_note') {
    const draft = s(body.body, 16000);
    if (draft.length < 120) {
      return send(res, 400, { ok: false, reason: 'missing_body', message: '네이버용으로 바꿀 완성 본문이 필요합니다(120자 이상).' });
    }
    prompt = promptNaverNote({ ...body, banPhrases, body: draft });
  } else if (action === 'humanize') {
    const draft = s(body.body, 16000);
    if (draft.length < 80) {
      return send(res, 400, { ok: false, reason: 'missing_body', message: '다듬을 초안이 필요합니다(80자 이상).' });
    }
    prompt = promptHumanize({ ...body, banPhrases, body: draft });
  } else if (action === 'multi_use') {
    const draft = s(body.body, 16000);
    if (draft.length < 120) {
      return send(res, 400, { ok: false, reason: 'missing_body', message: '1타 3피로 바꿀 완성 본문이 필요합니다(120자 이상).' });
    }
    prompt = promptMulti({ ...body, banPhrases, body: draft });
  } else if (action === 'seo_tags') {
    if (!s(body.body, 200) && !s(body.title, 120)) {
      return send(res, 400, { ok: false, reason: 'missing_body', message: '태그를 뽑을 본문이나 제목이 필요합니다.' });
    }
    prompt = promptSeo({ ...body, title: s(body.title, 120), body: s(body.body, 12000) });
  } else if (action === 'closing_box') {
    if (!s(body.body, 200)) {
      return send(res, 400, { ok: false, reason: 'missing_body', message: '마무리 박스를 붙일 본문이 필요합니다.' });
    }
    prompt = promptClosing({ ...body, banPhrases, body: s(body.body, 12000) });
  } else if (action === 'proofread_draft') {
    const draft = s(body.body, 16000);
    if (draft.length < 80) {
      return send(res, 400, { ok: false, reason: 'missing_body', message: '검수할 본문이 필요합니다(80자 이상).' });
    }
    prompt = promptProofread({ ...body, banPhrases, body: draft });
  } else if (action === 'analyze_blogger_style') {
    let srcText = s(body.sourceText || body.pastedText, 20000);
    let title = s(body.title, 120);
    if (srcText.trim().length < 200) {
      const u = s(body.url, 600);
      if (!u) {
        return send(res, 400, { ok: false, reason: 'missing_url', message: '블로그 글 주소(url) 또는 글 일부(sourceText)가 필요합니다.', fallback: 'paste' });
      }
      try {
        const r = await readBloggerSource(u);
        srcText = r.text;
        title = r.title || title;
        srcMeta = { url: u, finalUrl: r.finalUrl, converted: r.converted, chars: r.chars, title, author: r.author };
      } catch (err) {
        const code = s(err && err.code, 40) || 'fetch_failed';
        const message =
          code === 'blocked_url'
            ? String((err && err.message) || '이 주소는 열 수 없습니다.')
            : code === 'body_not_found'
              ? '본문을 직접 읽을 수 없는 페이지예요 — 아래에 글 일부를 붙여넣어 분석해 주세요.'
              : code === 'timeout'
                ? '페이지가 13초 안에 응답하지 않았습니다 — 아래에 글 일부를 붙여넣어 분석해 주세요.'
                : '이 페이지는 자동으로 열 수 없습니다(' + String((err && err.message) || code).slice(0, 90) + '). 아래에 글 일부를 붙여넣어 분석해 주세요.';
        const status = code === 'blocked_url' ? 400 : 200;
        return send(res, status, {
          ok: false,
          reason: code,
          message,
          url: u,
          fallback: 'paste',
          keyConfigured: true,
          model: PRIMARY_MODEL,
        });
      }
    } else {
      srcMeta = { url: s(body.url, 600), finalUrl: '', converted: false, chars: srcText.length, title, pasted: true };
    }
    prompt = promptAnalyzeStyle({ ...body, sourceText: srcText, title, author: (srcMeta && srcMeta.author) || s(body.author, 40), banPhrases });
  } else if (action === 'analyze_shorts_style') {
    /* 4번 내 유튜버/쇼츠 — 유튜브 링크면 자막을 직접·공개 미러로 추출하고, 실패하면 정진하게 알리고 붙여넣기 폴백을 준다. */
    let srcText = s(body.sourceText || body.pastedText, 9000);
    let title = s(body.title, 160);
    let author = s(body.author, 60);
    if (srcText.trim().length < 200) {
      const u = s(body.url, 300);
      const vid = ytVideoId(u);
      if (!vid) {
        return send(res, 400, {
          ok: false,
          reason: 'missing_url',
          message: '유튜브/쇼츠 링크(url) 또는 대본·자막 일부(sourceText)가 필요합니다.',
          fallback: 'paste',
        });
      }
      try {
        const r = await ytTranscript(vid);
        title = r.title || title;
        author = r.author || author;
        if (r.ok && s(r.text, 10)) {
          srcText = r.text;
          srcMeta = {
            url: u,
            videoId: vid,
            title,
            author,
            chars: srcText.length,
            auto: !!r.auto,
            route: r.route,
          };
        } else {
          return send(res, 200, {
            ok: false,
            reason: r.reason || 'no_captions',
            message:
              '이 영상의 자막을 읽지 못했습니다(' +
              (r.reason === 'no_captions' ? '자막 없음·서버 IP 차단' : r.reason || 'not_found') +
              '). 아래 [대본/자막 직접 붙여넣기]에 유튜브 화면의 자막을 복사해 붙여넣으면 같은 양식 분석을 합니다.',
            videoId: vid,
            title,
            author,
            url: 'https://www.youtube.com/watch?v=' + vid,
            fallback: 'paste',
            keyConfigured: true,
            model: PRIMARY_MODEL,
          });
        }
      } catch (err) {
        return send(res, 200, {
          ok: false,
          reason: 'extract_failed',
          message: '자막 추출 중 오류가 났습니다: ' + String((err && err.message) || err).slice(0, 140) + ' — 대본을 붙여넣어 주세요.',
          videoId: vid,
          url: 'https://www.youtube.com/watch?v=' + vid,
          fallback: 'paste',
          keyConfigured: true,
          model: PRIMARY_MODEL,
        });
      }
    } else {
      srcMeta = { url: s(body.url, 300), title, author, chars: srcText.length, pasted: true };
    }
    prompt = promptAnalyzeShortsStyle({ ...body, sourceText: srcText, title, author, banPhrases });
  } else if (action === 'shorts_script') {
    if (!s(body.topic, 200)) return send(res, 400, { ok: false, reason: 'missing_topic', message: '쇼츠 주제(topic)가 필요합니다.' });
    prompt = promptShortsScript({ ...body, banPhrases });
  } else if (action === 'summarize') {
    const kind = ['youtube', 'doc', 'media'].indexOf(s(body.kind, 12)) >= 0 ? s(body.kind, 12) : 'doc';
    const mode = SUMMARY_MODES.indexOf(s(body.mode, 12)) >= 0 ? s(body.mode, 12) : 'three';
    const meta = { kind, mode, title: '', chars: 0, truncated: false, notes: [] };
    let sourceText = s(body.text, SUMMARY_TEXT_MAX + 40000);
    let mediaParts = [];

    if (kind === 'doc') meta.title = s(body.title, 160);

    if (kind === 'youtube' && !sourceText.trim()) {
      const id = ytVideoId(s(body.url, 300));
      if (!id) {
        return send(res, 400, {
          ok: false,
          action: 'summarize',
          reason: 'bad_youtube_url',
          message: '유튜브 링크가 아닙니다. youtube.com/watch?v=… / youtu.be/… / /shorts/… 형식이나 11자리 영상 ID를 넣어 주세요.',
        });
      }
      let t = null;
      try {
        t = await ytTranscript(id);
      } catch (e) {
        t = null;
      }
      if (!t) {
        return send(res, 200, {
          ok: false,
          action: 'summarize',
          videoId: id,
          reason: 'extract_failed',
          message: '자막 추출 중 오류가 났습니다. 유튜브 화면에서 자막을 복사해 붙여넣어 주세요.',
          fallback: 'paste',
        });
      }
      meta.videoId = id;
      meta.title = s(t.title, 200);
      meta.author = s(t.author, 100);
      meta.lengthSec = t.lengthSec == null ? null : t.lengthSec;
      meta.auto = !!t.auto;
      meta.langLabel = s(t.langLabel, 20);
      meta.route = s(t.route, 80);
      (t.notes || []).slice(0, 4).forEach((n) => meta.notes.push(s(n, 200)));
      if (!meta.title) {
        // 미러 경로는 자막만 주고 제목·채널을 비워 둔다 — oEmbed 로 채운다(없으면 빈 채로 둔다).
        const oe = await ytOembed(id);
        if (oe) {
          meta.title = s(oe.title, 200);
          meta.author = meta.author || s(oe.author, 100);
        }
      }
      if (!t.ok) {
        return send(res, 200, {
          ok: false,
          action: 'summarize',
          videoId: id,
          reason: t.reason || 'no_captions',
          message:
            (meta.title ? '「' + meta.title + '」 ' : '이 영상의 ') +
            '자막을 받지 못했습니다. 유튜브가 이 영상의 자막을 주지 않았거나(자막 없음) 서버 IP를 봇으로 막았습니다. ' +
            '유튜브 화면에서 자막(스크립트)을 복사해 [자막 붙여넣기] 칸에 넣으면 같은 요약을 합니다.',
          youtube: { videoId: id, title: meta.title, author: meta.author, description: s(t.description, 600) },
          fallback: 'paste',
          hint: '유튜브 화면에서 자막(스크립트)을 복사해 [자막 붙여넣기] 칸에 넣고 다시 눌러 주세요. 붙여넣은 자막도 똑같이 요약합니다.',
        });
      }
      sourceText = s(t.text, SUMMARY_TEXT_MAX + 1);
    }

    if (kind === 'media') {
      const mime = s(body.media && body.media.mimeType, 60).toLowerCase().split(';')[0].trim();
      const b64 = String((body.media && body.media.data) || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
      if (!b64) {
        return send(res, 400, {
          ok: false,
          action: 'summarize',
          reason: 'missing_media',
          message: '첨부된 영상·음성 데이터가 비어 있습니다. 파일을 다시 골라 주세요.',
        });
      }
      if (SUMMARY_MEDIA_MIMES.indexOf(mime) < 0) {
        return send(res, 400, {
          ok: false,
          action: 'summarize',
          reason: 'unsupported_media_type',
          message: 'MP4 · WEBM · MP3 · M4A 만 요약할 수 있습니다(받은 형식: ' + (mime || '알 수 없음') + ').',
        });
      }
      const bytes = Math.floor((b64.length * 3) / 4);
      if (bytes > SUMMARY_MEDIA_MAX_BYTES + 8192) {
        return send(res, 413, {
          ok: false,
          action: 'summarize',
          reason: 'media_too_large',
          message: '영상·음성은 4MB까지입니다(지금 ' + (bytes / 1048576).toFixed(1) + 'MB). 짧게 잘라 다시 올려 주세요.',
        });
      }
      mediaParts = [{ mimeType: mime, data: b64 }];
      meta.bytes = bytes;
      meta.title = s(body.media && body.media.name, 160);
      meta.durationSec = num(body.media && body.media.durationSec, null);
    }

    if (!mediaParts.length && !sourceText.trim()) {
      return send(res, 400, {
        ok: false,
        action: 'summarize',
        reason: 'missing_source',
        message: '요약할 자료가 없습니다. 유튜브 링크 · 문서 파일 · 붙여넣은 텍스트 중 하나를 넣어 주세요.',
      });
    }
    if (sourceText.length > SUMMARY_TEXT_MAX) {
      sourceText = sourceText.slice(0, SUMMARY_TEXT_MAX);
      meta.truncated = true;
      meta.notes.push('본문이 ' + SUMMARY_TEXT_MAX.toLocaleString('en-US') + '자를 넘어 앞부분만 넣었습니다.');
    }
    meta.chars = sourceText.length;

    srcMeta = meta;
    prompt = promptSummary({
      kind,
      mode,
      text: sourceText,
      media: mediaParts,
      title: meta.title,
      author: meta.author,
      chars: meta.chars,
      truncated: meta.truncated,
      durationSec: meta.durationSec,
      auto: meta.auto,
      focus: body.focus,
      banPhrases,
    });
  } else {
    const draft = s(body.body, 20000);
    if (draft.length < 80) return send(res, 400, { ok: false, reason: 'missing_body', message: '쇼츠로 바꿀 블로그 본문이 필요합니다.' });
    prompt = promptShorts({ ...body, banPhrases, body: draft.slice(0, 9000) });
  }

  const started = Date.now();
  const deadline = started + DEADLINE_MS;

  let out;
  try {
    out = await generate(prompt, deadline);
  } catch (err) {
    // 400(잘못된 요청)만 400으로 돌려주고, 모델 혼잡·쿼터·타임아웃은 200 + ok:false 로 답한다.
    // (브라우저 콘솔에 실패한 리소스가 에러로 쌓이지 않게 하면서, JSON 안에는 사실대로 적는다)
    const status = err.status === 400 ? 400 : 200;
    const hours = err.retryDelaySec ? Math.round(err.retryDelaySec / 360) / 10 : null;
    const message =
      err.code === 'quota_exceeded'
        ? 'Gemini 무료 티어의 모델별 하루 요청 한도를 다 썼습니다(3.8 Flash 기준 20회/일). ' +
          (hours ? `약 ${hours}시간 뒤에 자동으로 풀립니다. ` : '') +
          '급하면 Google AI Studio(aistudio.google.com)에서 결제(종량제)를 켜면 바로 늘어납니다. 지금은 [오프라인 뼈대]로 틀만 만들 수 있습니다.'
        : err.status === 504
          ? 'Gemini 응답이 시간 안에 오지 않았습니다. 잠시 뒤 다시 눌러 주세요(긴 글은 한 번 더 걸릴 수 있습니다).'
          : err.code === 'all_models_busy'
            ? 'Gemini 모델이 지금 몰려서 응답하지 않았습니다(3.8 Flash → Flash Lite Latest → 3 Flash 순으로 시도). 1~2분 뒤 다시 눌러 주세요.'
            : `Gemini 호출 실패: ${String(err.message || '').slice(0, 200)}`;
    return send(res, status, {
      ok: false,
      reason: err.code || (err.status === 504 ? 'timeout' : 'gemini_unavailable'),
      message,
      keyConfigured: true,
      model: PRIMARY_MODEL,
      quota: err.code === 'quota_exceeded' ? { quotaId: err.quotaId, retryDelaySec: err.retryDelaySec } : undefined,
      tries: err.tries || [],
    });
  }

  const parsed = extractJson(out.text);
  const notes = [];
  if (!parsed) {
    notes.push('모델이 JSON 형식을 어겼습니다. 원문(__raw)을 그대로 돌려줍니다.');
  }
  if (out.finish === 'MAX_TOKENS') {
    notes.push('출력이 토큰 한도에 걸려 잘렸습니다. 다시 생성하면 더 짧게 나옵니다.');
  }
  if (out.fellBack) {
    notes.push(`${PRIMARY_MODEL} 이 응답하지 않아 ${out.model} 이 대신 작성했습니다.`);
  }

  const data = parsed || {};
  let result;
  if (action === 'blog') result = normBlog(data, banPhrases);
  else if (action === 'video_plan') result = normVideo(data, arr(body.clips, 6));
  else if (action === 'youtube_analyze') result = normYt(data);
  else if (action === 'rewrite_tone') result = normRewrite(data, banPhrases);
  else if (action === 'naver_note') result = normNaverNote(data, banPhrases);
  else if (action === 'humanize') result = normHumanize(data, banPhrases);
  else if (action === 'multi_use') result = normMulti(data, banPhrases);
  else if (action === 'seo_tags') result = normSeo(data);
  else if (action === 'closing_box') result = normClosing(data);
  else if (action === 'proofread_draft') result = normProof(data, banPhrases);
  else if (action === 'analyze_blogger_style') result = normStyle(data);
  else if (action === 'analyze_shorts_style') result = normShortsStyle(data);
  else if (action === 'shorts_script') result = normShortsScript(data);
  else if (action === 'summarize') result = normSummary(data, srcMeta || {});
  else result = normShorts(data);

  if (result.banHits && result.banHits.length) {
    notes.push(`금지 표현이 본문에 남아 있습니다: ${result.banHits.join(', ')}`);
  }

  const truncated = !parsed && out.finish === 'MAX_TOKENS';
  const emptyMain =
    (action === 'blog' && !s(result.body, 10)) ||
    (action === 'video_plan' && !(result.cuts || []).length) ||
    (action === 'blog_to_shorts' && !(result.scenes || []).length) ||
    (action === 'youtube_analyze' && !((result.shorts || {}).scenes || []).length) ||
    (action === 'rewrite_tone' && !s(result.body, 10)) ||
    (action === 'naver_note' && !s(result.body, 10)) ||
    (action === 'humanize' && !s(result.body, 10)) ||
    (action === 'multi_use' && !(((result.insta || {}).lines) || []).length) ||
    (action === 'seo_tags' && !((result.hashtags || []).length || (result.keywords || []).length)) ||
    (action === 'closing_box' && !s(result.question, 3)) ||
    (action === 'proofread_draft' && !s(result.body, 10)) ||
    (action === 'analyze_shorts_style' && !s(result.hook, 3)) ||
    (action === 'shorts_script' && !(result.beats || []).length) ||
    (action === 'analyze_blogger_style' && !(result.structure || []).length) ||
    (action === 'summarize' && !((result.three || []).length || s(result.headline, 3)));
  if (truncated || emptyMain) {
    return send(res, 200, {
      ok: false,
      reason: truncated ? 'truncated' : 'empty_result',
      message: truncated
        ? '출력이 토큰 한도에서 잘려 본문이 완성되지 않았습니다. 다시 누르면 조금 더 짧게 다시 씁니다.'
        : '답이 비어 왔습니다. 한 번 더 눌러 주세요.',
      keyConfigured: true,
      model: out.model,
      finishReason: out.finish,
      notes,
      tries: out.tries,
      partial: parsed ? result : undefined,
      __raw: parsed ? undefined : out.text.slice(0, 8000),
    });
  }

  return send(res, 200, {
    ok: true,
    action,
    parsed: !!parsed,
    model: out.model,
    primaryModel: PRIMARY_MODEL,
    fellBack: !!out.fellBack,
    elapsedMs: Date.now() - started,
    usage: out.usage,
    finishReason: out.finish,
    notes,
    tries: out.tries,
    data: result,
    source: srcMeta || undefined,
    __raw: parsed ? undefined : out.text.slice(0, 20000),
  });
};
