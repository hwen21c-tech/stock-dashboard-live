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
    format: {
      type: 'string',
      description: '고른 7가지 적응형 포맷 1개 — 예: 💸 머니무브형 / 📊 수치·쏠림형',
    },
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
          caption: { type: 'string', description: '이 컷의 화면 자막 한 줄 — 실측 수치 중심, 20자 이내' },
          narration: { type: 'string', description: '이 컷의 나레이션 — 숫자 낭독 없이 의미만, 공백 포함 45~60자' },
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
    pinnedComment: { type: 'string', description: '고정 댓글 — 1초 체커 링크 · 티스토리 링크 · 시청자 질문 1개' },
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
    format: {
      type: 'string',
      description: '고른 7가지 적응형 포맷 1개 — 예: 💸 머니무브형 / 🎯 조건·시초가 시나리오형',
    },
    title: { type: 'string', description: '쇼츠 제목 (32자 이내)' },
    hook: { type: 'string', description: '0~2초 후킹 멘트 — 인사 없이 질문·숫자·반전' },
    scenes: {
      type: 'array',
      description: '5~8컷 맞춤형(컷1 훅, 마지막 컷 확인 기준 1·2·3) — 컷당 8~9초, 총 45~60초',
      items: {
        type: 'object',
        properties: {
          time: { type: 'string', description: '예: 3-13초' },
          caption: { type: 'string', description: '화면 자막 — 실측 수치 그대로, 공백 포함 15~20자' },
          narration: { type: 'string', description: '말할 문장 — 숫자 낭독 없이 의미만, 공백 포함 45~60자(두 문장)' },
          line: { type: 'string', description: 'narration 과 같은 말(호환용)' },
        },
        required: ['time', 'line'],
      },
    },
    ending: { type: 'string', description: '마지막 컷 마무리 — 1초 체커 멘트 포함' },
    captionGuide: { type: 'string', description: '자막 스타일 권장 1줄' },
    pinnedComment: { type: 'string', description: '고정 댓글 — 1초 체커 링크 · 티스토리 링크 · 시청자 질문 1개' },
    hashtags: { type: 'array', description: '해시태그 8~12개(# 없이, #shorts 포함)', items: { type: 'string' } },
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
/* 🦊 폭스시그널 펀치력 — 쇼츠(첫 3초 훅·수급 깊이·시초가 대응) */
const FOX_SHORTS_PUNCH = [
  '[폭스시그널 펀치력 규칙 — 어기면 실패다]',
  '1) 첫 3초가 시황 리포트 오프닝이면 실패다. 아래 둘 중 하나로만 연다.',
  '   ⓐ 실전 경고·함정 찌르기: 자료에 있는 오늘 숫자로 "개인이 제일 많이 물리는 자리"를 만든다.',
  '      (예: "오늘 -5% 폭락장, 개인이 제일 많이 물리는 자리는 반등처럼 보이는 이 자리입니다")',
  '   ⓑ 어제 시그널 성적표 복기: 자료의 [어제 시그널 성적표]에 있는 종목·기준선의 실제 결과(등락률·지지/이탈)를 첫 문장에 숫자로 던진다.',
  '      (예: "어제 300억 통과라던 3종목, 오늘 하나는 -13%로 무너졌습니다")',
  '   금지: "오늘 시장은 ~", "코스피가 ~로 마감했습니다" 같은 밋밋한 시작, 인사, 인트로, 배경 설명.',
  '2) 수급은 섹터 이동 나열로 끝내지 않는다. 한 컷을 반드시 트레이더 시선으로 쓴다 —',
  '   외국인·기관이 어느 가격대(고가·시가·종가)에서 물량을 넘겼는지, 개인을 털고 종가를 왜 그 가격에서 지켰는지.',
  '   자료에 있는 숫자만 쓰고, 주체의 의도는 "추정"이라고 밝힌다.',
  '3) 마지막 컷은 "내일 09:00 내 행동"으로 닫는다 — 갭상승 시 / 갭하락 시 조건과 가격 기준선(숫자 1개 이상).',
].join('\n');

/* 🦊 폭스시그널 펀치력 — 블로그(결론 선제시·질문형 소제목·3단 도미노·300억 대장주·이분 처방·시초가 대응) */
const FOX_BLOG_PUNCH = [
  '[폭스시그널 에디토리얼 양식 — 어기면 실패다]',
  '0) 결론 선제시(답 숨기기 금지): 첫 3줄 안에 오늘 장의 결론과 핵심 답을 먼저 준다.',
  '   첫 줄 = 결론 한 문장(자료의 숫자 포함), 둘째·셋째 줄 = 그 결론의 근거 2개(수급·미장·야간선물).',
  '   인사·정의·배경 설명·"오늘 시장은 ~" 같은 리포트식 도입으로 시작하면 실패다.',
  '1) 훅: ⓐ 실전 경고·함정(확인된 숫자로 개인이 물리는 자리) 또는 ⓑ 어제 시그널 성적표 복기(자료의 종목·기준선 실제 결과) 중 하나를 첫 줄에 둔다.',
  '2) 소제목은 질문형(왜?): "## 왜 외국인은 반도체를 팔았을까?"처럼 질문으로 단다. "② 수급" 같은 명사 소제목 금지.',
  '3) 모든 팩트는 3단 도미노로 쓴다: ① 사건(무슨 일이 있었나) → ② 사람·시장 심리(누가 어떻게 반응했나) → ③ 내 계좌 행동(그래서 무엇을 어떻게 하나).',
  '   셋 중 하나가 빠지면 실패다. 펀더멘털(실적·업황)과 수급이 어긋나면 그 괴리를 한 문단으로 해석한다.',
  '4) 대장주는 300억 이상 실대금만: 자료의 당일 거래대금 300억 이상 상승 대장주만 표에 올린다.',
  '   - 300억 미만·단발 급등주는 표에 넣지 않고 "거래대금 미달 · 추격 주의"로만 한 줄 짚는다.',
  '   - 투자주의·경고·과열은 종목 옆 괄호로 사실대로 구분한다: (투자주의 지정) · (단기 급등·과열 주의).',
  '   - 표의 종목마다 내일 볼 관찰 기준선 숫자 1개(지지·저항 가격)를 붙인다. "지켜보자·상황에 따라" 같은 애매한 양비론 금지.',
  '5) 이분 처방: 대응 섹션에서 ① 신규 대기자(현금)와 ② 기보유자(물렸거나 비중이 높음)를 각각 2줄 이상 따로 쓴다. 같은 문장을 복사하지 않는다.',
  '6) 호흡: 한 문단 1~2문장, 문단 사이는 빈 줄 하나. 긴 문단·불릿 줄줄이 나열 금지.',
  '7) 3색 절제 강조(빠지면 실패): 본문에서 가장 중요한 결론·핵심 판단 문장 4~5곳을 ==문장== 으로 감싼다(==는 형광펜 표기다).',
  '   형식 예: ==외국인은 반도체를 팔고도 야간선물을 사자로 돌아섰습니다.== / ==4,711 이탈이면 오늘 대응은 관망으로 바뀝니다.==',
  '   == 표시가 0곳이면 실패다. 수치는 부호를 붙인다(+12.31%, -980억). HTML 태그·색상 코드는 쓰지 않는다(== 외의 서식 금지).',
  '8) 표는 1~2개 넣는다(빠지면 실패):',
  '   - 앞부분에 자료에 있는 값만으로 3열 표를 만든다. 열 이름은 [구분 | 밤사이/전일 | 오늘 기준] 으로 고정하고, 행은 코스피·반도체(SOX)·야간선물·원/달러 중 자료에 있는 것만 넣는다.',
  '     예) | 구분 | 밤사이·전일 | 오늘 기준 | / |---|---|---| / | 코스피 | 4,711.21 (+0.29%) | 야간선물 728.00 (+0.17%) |',
  '   - 대장주는 [종목 | 등락률 | 거래대금 | 오늘 관찰 기준선] 4열 표로 3~4종목만(300억 이상만). 자료에 대장주가 없으면 이 표만 생략하고 [확인 필요]로 적지 말고 표 자체를 만들지 않는다.',
  '9) 글 하단에 아래 블록을 반드시 넣는다(독립된 소제목 + 2줄 이상, 표 안에 넣지 않는다).',
  '   "## 📌 내일 09:00 시초가 대응 — 내 계좌 기준선"',
  '   - 갭상승일 때: 무엇을 하고 비중을 어떻게 두는지 + 무효가 되는 가격 기준선',
  '   - 갭하락일 때: 무엇을 하고 관찰을 끝내는 가격 기준선',
  '   기준선 숫자는 자료의 실측값으로만 채우고, 없으면 [확인 필요]로 둔다.',
  '10) 자료에 [어제 시그널 성적표](종목·등락률·판정, 지수 기준선 유지/이탈)가 있으면 글 중간에 표 1개로 넣고 맞은 것과 빗나간 것을 구분해 적는다(자랑·변명 없이).',
  '11) 마무리 순서 고정: ① 핵심 정리 1~2문장 ② "한줄 코멘트." 로 시작하는 한 문단(내일 무엇을 볼지 한 줄) ③ 독자 판단이 갈리는 구체적 질문 1개.',
  '    질문 예: "내일 시초 갭하락이면 현금 대기 vs 분할 접근, 어느 쪽을 보시나요?"',
  '12) 1초 체커·유튜브·네이버·특가 링크는 시스템이 붙인다 — 본문에 링크를 새로 만들지 않는다(단독 1초 체커 언급은 가능).',
  '13) 분량 1,400~1,900자. 잘리면 실패이므로 문장을 늘리지 말고 숫자와 판단을 밀도 있게 쓴다.',
  '14) 자료에 없는 수치·종목·공시·테마를 만들지 않는다. 모르면 [확인 필요].',
].join('\n');


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
    b.foxPunch ? FOX_BLOG_PUNCH : '',
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
2) 위 섹션 순서를 그대로 쓰고 각 섹션 제목은 "## " 마크다운 소제목으로 단다.${b.foxPunch ? ' 소제목은 질문형(\'왜?\')으로 쓴다.' : ''}
3) 조건 비교용 마크다운 표를 최소 1개 넣는다. ( | 구분 | A | B | 형식, 헤더 구분선 포함)
4) 사진이 들어가면 글이 자연스러워지는 지점에 정확히 "[📸 사진: 구체적 묘사 | search: 영문검색어]" 형식으로 넣는다.
   단 [내 사진]이 첨부된 경우에는 내 사진 태그를 우선하고, 남은 자리에만 0~2곳 넣는다.
   - 묘사는 한국어 20자 내외(무엇이 보여야 하는지), search 는 무료 사진 DB에서 실제로 검색될 영어 명사 2~4단어.
   - search 에 브랜드·상호·사람 이름·연도·한글을 넣지 않는다(그런 사진은 무료 DB에 없다). "street food", "autumn park", "hotel lobby" 처럼 보편 명사만.
   - 사진 태그는 그 줄 하나로 끝낸다(같은 줄에 다른 문장을 붙이지 않는다). 표 안에는 넣지 않는다.
5) 솔직한 단점을 최소 1줄 쓴다. ("아쉬운 점:" 으로 시작)${b.foxPunch ? ' 시황 글에서는 "아쉬웠던 점:"(놓친 신호·빗나간 예상)으로 바꿔 쓴다.' : ''}
6) 분량 ${b.foxPunch ? '1,400~1,900자' : '900~1300자'}. 이 길이를 넘기면 출력이 잘려 실패한다 — 짧고 밀도 있게.
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
3) 총 길이 45~60초(자료가 짧으면 30초 이상), 컷은 5~8개 맞춤형. 2초짜리 자투리 컷을 남발하지 말고 한 컷을 6~12초로 잡는다.
   (쓸 구간이 짧은 클립은 짧게, 긴 클립은 여러 컷으로 나눠 쓴다 — 쓸 구간을 최대한 활용한다)
4) 첫 컷은 2초 이내 후킹 — 훅 멘트가 실제로 들리는 구간이어야 하고, 인사·자기소개 없이 바로 시작한다. 마지막 컷은 확인할 기준 1·2·3으로 닫는다.
5) 화면 = 숫자, 나레이션 = 의미(11/25 확정):
   - caption(화면 자막)은 실측 수치 그대로·20자 이내(숫자는 아라비아 숫자로).
   - narration(말할 문장)은 억·조·%·소수점·포인트·계약·원을 하나씩 낭독하지 않고, "무슨 일이 있었고 → 어떤 의미인지"를 공백 포함 45~60자 안에 완결한다.
   - 스토리 방향에서 사용자가 말한 것(교차편집·손인사 엔딩 등)은 반영한다. 곡명·멤버 이름처럼 모르는 고유명사만 "[확인 필요]"로 남긴다.
   - 시각 표기: 순우리말 분(마흔·넉)·24시간제(15시) 금지, '세 시 반'처럼 아나운서식으로.
   - 구체적 순절선 수치(-2~3%)·계좌 비중 숫자는 쓰지 않고 "관망·비중 축소·전환 신호 확인"으로 쓴다.
6) 파일명·길이만 보고 장면 내용을 단정하지 않는다. 근거가 없으면 caption 을 장면 중립적으로 쓰고 warnings 에 적는다.
7) hooks 3종은 실제로 입으로 말할 문장. 질문형 / 숫자형 / 반전형. 숫자는 아라비아 숫자로 적는다(한글 발음 '삼점구일퍼센트' 금지).
8) bgm.ducking 은 "말 시작 0.1초 전 -12dB, 문장 끝 0.4초 뒤 복귀" 처럼 구체적으로.
9) format: 이 브리핑 성격에 맞는 7가지 적응형 포맷 1개(📊 수치·쏠림 / 💸 머니무브 / ⚖️ 호재 vs 악재 / 🔍 통념 깨기 / 📅 일정·D-day / 🎯 조건·시초가 / 🚨 실전 함장).
10) 마지막 컷 narration 끝에 "내 종목은 안전한지 고정댓글 1초 체커로 바로 찍어보세요"를 자연스럽게 넣고, pinnedComment 엔 🔍 1초 체커(https://hwen21c-tech.github.io/foxsignal-checker/) · 🟠 티스토리(https://foxsignal.tistory.com) · 시청자 질문 1개를 넣는다.
[출력] format · hooks(3) · cuts(배열) · bgm · pinnedComment · warnings JSON.`,
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
    b.foxPunch ? FOX_SHORTS_PUNCH : '',
    `
[해야 할 일 — 이 글을 45~60초 쇼츠 대본으로]
1) 포맷 선택(7가지 적응형 · 고정 6칸 틀 금지): 아래 중 이 글의 성격에 가장 맞는 1개를 골라 format 에 적고 그 구조로 전개한다.
   ①📊 수치·쏠림형 — 숫자가 주인공인 날(외인 매도 규모·대금 폭증): 비교 수치·순위·기록 대비 중심
   ②💸 머니무브형 — 돈이 대놓고 이사 간 날: OUT → IN 비교 + 300억↑ 상승 주도주 중심(화살표는 이 컷에만)
   ③⚖️ 호재 vs 악재 대립형 — 재료 혼재일: 버팀목 2개 ↔ 악재 2개 맞대결 후 균형점
   ④🔍 통념 깨기·팩트체크형 — 과거 패턴·시장 착각 반박: 흔한 기준 반박 → 이번엔 다른 점
   ⑤📅 일정·D-day형 — FOMC·금통위·만기·실적 몰린 날: 시간순 이벤트 + 가장 중요한 하루 1개
   ⑥🎯 조건·시초가 시나리오형 — 야간선물 급변·변곡점 앞: if → then 대응 기준선
   ⑦🚨 실전 함장 경고형 — 급락장 추격·대금 미달 급등주 주의: 개인이 물리는 함장 1개 + 안전 기준선
2) 컷 수는 5~8컷 맞춤형(7컷 고정 아님). 컷 1 = 질문+결론 훅, 마지막 컷 = 확인할 기준 1·2·3. 컷당 8~9초, 총 45~60초.
   scenes 의 time 은 "0-4초"처럼 실제 초 구간으로 쓴다.
3) 화면 = 숫자, 나레이션 = 의미(11/25 확정):
   - caption(화면 자막) = 실측 수치 그대로(-10.41%, 4,697.51, +7,041계약). 공백 포함 15~20자.
     숫자는 아라비아 숫자로 적는다(한글 발음 '영점일칠퍼센트' 금지). 숫자가 없는 컷은 전체의 2컷까지만 허용한다.
   - narration(말할 문장) = 억·조·%·소수점·포인트·계약·원을 하나씩 낭독하지 않는다. "무슨 일이 있었고 → 그래서 시장·투자자에게 어떤 의미인지"를 공백 포함 45~60자(두 문장) 안에 완결한다.
     예) ✗ "외인 현물 마이너스 1조8,982억, 선물 플러스 7,041계약" → ✓ "외국인은 현물을 팔고도 막판에 선물을 사자로 돌아섰습니다. 하방 방어 신호입니다."
   - line 에는 narration 과 같은 말을 넣는다(자막과 겹쳐도 된다).
4) 시각 표기: 순우리말 분(마흔·넉·스무) 금지, 24시간제(15시) 금지. '세 시 반'·'오후 네 시'·'두 시 사십이 분'처럼 아나운서식으로 적는다.
5) 구체적 순절선 수치(-2~3%)·계좌 비중 숫자(0~20%)는 자막·나레이션에 쓰지 않는다. "관망·비중 축소·전환 신호 확인" 같은 조심 뉘앙스로 쓴다. (300억·지수 기준선 같은 시장 팩트 숫자는 하용)
6) 첫 인사("안녕하세요 폭스시그널입니다") 금지 — 바로 훅으로 시작. 중간 1컷에 "어디서 빠져 어디로 가는지" 업종 대비 프레임을 넣는다.
7) 마지막 컷 narration 끝에 "내 종목은 안전한지 고정댓글 1초 체커로 바로 찍어보세요"를 자연스럽게 넣는다.
8) pinnedComment: ⓐ 🔍 내 종목 수급·테마 1초 체커(https://hwen21c-tech.github.io/foxsignal-checker/) ⓑ 🟠 티스토리 상세 해설(https://foxsignal.tistory.com) ⓒ 시청자 판단이 갈리는 질문 1개 — 세 가지를 모두 넣는다(링크 주소는 위 글자를 그대로 복사).
9) hashtags: 8~12개(# 없이, #shorts 포함). 본문에 없는 브랜드·테마명을 만들지 않는다.
10) 본문에 없는 수치·사실·종목을 새로 만들지 않는다. 모르면 [확인 필요]로 두고 warnings 에 적는다.
11) captionGuide: 자막 스타일 권장 1줄(정보형/예능형/레터박스 중) + 이유.
[출력] format · title · hook · scenes · ending · captionGuide · pinnedComment · hashtags · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 블로그 글을 쇼츠 대본으로 바꾸는 작가다. 원문에 있는 내용만 쓰고, 화면은 숫자·나레이션은 의미로 분업한다. 첫 인사 없이 바로 훅으로 연다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_SHORTS,
    maxTokens: 2600,
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
[해야 할 일 — 🟢 네이버용 톤 변환 · 메르 스타일]
같은 소재를 네이버 블로그에 올릴 '결이 다른 요약본'으로 다시 쓴다. 원문을 그대로 옮기면 두 채널 모두 노출이 떨어질 수 있으니 문장·도입부·소제목 구성을 실제로 바꾼다.
1) 첫 문단: 반드시 "안녕하세요, 폭스시그널입니다."로 시작하고, 이어서 왜 이 글을 쓰는지 1~2문장. "오늘은 ~를 짧게 정리해 볼게요"처럼 말하듯 쓴다. 원문 첫 문단을 그대로 쓰지 않는다.
   그 다음 1~2줄 안에 오늘 장의 결론과 핵심 답을 실측 숫자 1개와 함께 먼저 제시한다(답을 뒤로 숟기지 않는다).
2) 문단 호흡(가장 중요): 한 문단은 1~2문장. 문단과 문단 사이는 반드시 빈 줄 하나. 한 문장은 40자 안팎으로 끊는다. 모바일에서 스크롤하며 숨 쉬듯 읽히게 한다.
3) 구성: 보고서 목차(서론·본론·결론)를 세우지 않는다. "1. … 2. … 3. …" 번호로 인과를 따라 전개한다 — 결론 → 이유 → 숫자 → 다음 관전 순서. 소제목은 원문을 복사하지 말고 3~5개로 새로 묶어 "1. 외국인이 왜 샀을까?"처럼 질문형·말하듯 단다.
4) 3단 도미노(팩트 나열 금지): "금리가 올랐습니다"처럼 사실만 던지고 끝내지 않는다. 각 이야기는 ① 사건 → ② 사람·시장 심리 변화 → ③ 그래서 시장과 내 계좌에 어떤 결과로 이어지나, 3단으로 풀어 쓴다. 예: "금리가 올랐습니다(사건) → 빚으로 산 사람과 예금한 사람의 마음이 갈립니다(심리) → 성장주보다 배당주로 돈이 옮겨 갑니다(결과)". 숫자는 ①에만 두지 말고 ③의 결과까지 따라가게 쓴다.
5) 표·수치 보존(절대 규칙): 원고에 마크다운 표(| … |)가 있으면 핵심 지수·주도주 요약 표 1개는 표 그대로 살린다 — 헤더·행·칸 값을 유지하고, 행이 많으면 주요 행만 남겨 6행 이내로 줄여도 되지만 남긴 칸의 숫자는 그대로 쓴다. 표 안팎의 실측 수치(지수·등락률·거래대금·수급 금액·계약 수·비율)는 지우거나 반올림·어림수("약 4천억")로 바꾸지 않는다. 표는 1개만, 개념 설명은 줄글로 풀고 표를 여러 개로 늘리지 않는다.
6) 💡 예를 들면 이런 상황이에요(폭스시그널 시그니처): 번호 전개 중간(표 바로 뒤나 2번째 이야기 뒤)에 "## 💡 예를 들면 이런 상황이에요" 소제목을 한 번 넣고, 오늘 장 종목 비교나 투자자 계좌에 그대로 대입되는 실전 예시 1개를 2~3문장으로 쓴다. 예시에는 원문에 있는 실측값(종목명·등락률·금액)만 쓰고, 새 숫자·가정 수익률·없는 종목을 만들지 않는다. 예시는 딱 1번만, 다른 소제목에서 반복하지 않는다.
7) 쉬운 비유: 어려운 경제·수급 용어에는 일상 비유를 한 번만 곁들인다(예: 외국인 수급 — "장바구니 큰손이 먼저 들어오는 날", 거래대금 — "오늘 시장에 오간 돈의 총액", 프로그램 매매 — "기계가 정해 둔 자동 주문"). 비유는 1문단에 하나까지, 원문에 없는 사례를 만들지 않는다.
8) 숫자·날짜·업체명·종목명·[확인 필요]는 절대 바꾸거나 새로 만들지 않는다. 원문에 있는 실측 수치(금액·계약 수·비율·등락률)는 하나도 빠뜨리지 말고 요약본 어딘가에 최소 한 번씩 그대로 남긴다 — 빠뜨리면 실패다. 문장을 줄일 때도 숫자가 든 문장을 먼저 살린다. 원문에 없는 사실·사례·수치를 추가해도 실패다.
9) 1인칭 경험(가봤다·써봤다·내돈내산)은 원문에 있을 때만 남기고 새로 만들지 않는다.
10) "[📸 사진: ...]" 태그와 링크·제휴 고지 줄은 넣지 않는다(네이버에는 사진을 직접 올리고, 링크·면책은 앱이 따로 붙인다).
11) 마무리: 본문 맨 끝 문단은 "한줄 코멘트." 로 시작하는 핵심 통찰 1단락(1~3문장)으로 끝낸다. 독자가 내일 무엇을 보면 되는지 한 줄로 남긴다. 그 아래에 앱이 링크·면책을 붙이므로 링크·해시태그·"읽어 주셔서 고맙습니다" 같은 인사말은 쓰지 않는다.
12) tags 에는 네이버 검색 유입용 해시태그 10개를 # 없이 넣는다(지역·대상·상황 키워드 포함).
13) 마크다운 본문만 출력한다. 머리말·설명·인사 없이.
14) 서식은 네이버 에디터에서 깨지지 않는 것만 쓴다: ==형광펜==·HTML 색 태그·이모지 남발 금지(강조는 ** ** 만), 수치는 +·- 부호를 붙인다.
[출력] title · body · tags · changed · warnings JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 같은 소재를 채널에 맞게 다시 쓰는 한국어 블로그 작가다. 네이버 블로그 독자에게 말 걸듯 친근한 구어체로, 원문의 사실은 그대로 두고 구성과 문장만 새로 짠다. 문단은 1~2문장으로 짧게 끊고, 딱딱한 목차 대신 번호로 결론→이유→숫자→다음 관전을 잇고, 어려운 용어엔 일상 비유를 하나 곁들이고, 마지막은 "한줄 코멘트." 한 단락으로 닫는다. 원고의 핵심 표 1개와 실측 수치는 줄이거나 지우지 않고 그대로 살린다. 사실을 그냥 나열하지 않고 사건 → 사람·시장 심리 변화 → 시장·내 계좌의 결과로 3단 도미노처럼 이어 쓴다. 중간에 "💡 예를 들면 이런 상황이에요" 소제목으로 독자 계좌·오늘 장 종목에 대입되는 실전 예시를 원문 실측값만으로 딱 한 번 넣는다. ${VOICE} ${HONESTY}`,
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
    b.foxPunch ? FOX_SHORTS_PUNCH : '',
    `
[해야 할 일 — ${duration}초 세로 쇼츠 대본]
1) 첫 3초 훅: 인사·자기소개 없이 결론·숫자·반전 중 하나로 바로 시작한다. 위 양식의 훅 패턴을 그대로 따른다. hook 은 말할 문장, hookCaption 은 화면 자막(공백 포함 15~20자)이다.
2) 본문은 4~7컷. 한 컷은 4~10초, 입으로 말하는 1~2문장만. 위 양식의 컷 리듬을 따른다.
   spoken 은 반드시 ‘입으로 말하는 대사’다. "영상을 켠다·확인한다·관찰한다" 같은 지시문·설명문을 쓰지 않는다. 화면 설명은 shot 에만 쓴다.
   말투는 뉴스 보도체가 아니라 시청자에게 말을 거는 구어체다("~해보세요", "이거 모르면", "3초만 보세요").
   단 화면=숫자, 나레이션=의미(11/25 확정): 그래프·KPI가 수치를 이미 보여 주므로 spoken 에서 억·계약·퍼센트를 하나씩 낭독하지 않고,
   컷마다 '무슨 일이 있었고 → 그래서 시장·투자자에게 어떤 의미인지'를 45~60자 두 문장 안에 완결한다.
   예) "외국인은 현물을 팔고도 막판에 선물을 사자로 돌아섰습니다. 급락 베팅을 접은 숏커버, 하방 방어 신호입니다."
   시각은 순우리말 분('두 시 마흔'·'세 시 넉 분')을 쓰지 않고 '두 시 사십이 분'·'세 시 사 분'·'세 시 반'처럼 적는다(24시간제 '열다섯 시' 금지).
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
  // 프롬프트별 이미지 상한 — 쇼츠 키프레임(최대 15장)은 기본값(4장)보다 더 보낸다.
  const imgCap = Math.max(1, Math.min(16, Number(prompt.maxImages) || MAX_INLINE_IMAGES));
  const imgParts = (Array.isArray(prompt.images) ? prompt.images : [])
    .filter((im) => im && im.data && /^image\/(jpeg|png|webp)$/.test(String(im.mimeType || '')))
    .slice(0, imgCap)
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
  let order = modelOrder().filter((m, i, a) => m && a.indexOf(m) === i);
  // 짧은 작업(2~3줄 해석 등)은 빠른 경량 모델을 먼저 부른다 — 체커가 1~2초 안에 결과를 봐야 하기 때문.
  if (prompt && prompt.fastFirst) {
    const fast = FALLBACK_MODELS.filter((m) => m && m !== PRIMARY_MODEL && order.indexOf(m) >= 0);
    if (fast.length) order = fast.concat(order.filter((m) => fast.indexOf(m) < 0));
  }
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
      narration: s(c && c.narration, 240),
      transition: trans,
    });
  });
  const total = round1(cuts.reduce((a, c) => a + c.durSec, 0));
  if (cuts.length && total < 15) {
    warnings.push(`컷 총 길이가 ${total}초로 짧습니다(권장 45~60초, 자료가 짧으면 30초 이상). [편집 실행]을 한 번 더 누르면 다르게 설계됩니다.`);
  }
  const bgm = data.bgm || {};
  return {
    format: s(data.format, 60),
    hooks,
    cuts,
    totalSec: total,
    bgm: {
      ducking: s(bgm.ducking, 200) || '말 시작 전 -12dB, 문장 끝 0.4초 뒤 복귀',
      notes: arr(bgm.notes, 6).map((x) => s(x, 160)).filter(Boolean),
    },
    pinnedComment: s(data.pinnedComment, 600),
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
  const scenes = arr(data.scenes, 10).map((x) => {
    const narration = s(x && x.narration, 240);
    const line = s(x && x.line, 240) || narration;
    return { time: s(x && x.time, 20), line, caption: s(x && x.caption, 80), narration: narration || line };
  }).filter((x) => x.line || x.caption);
  return {
    format: s(data.format, 60),
    title: s(data.title, 80),
    hook: s(data.hook, 120),
    scenes,
    ending: s(data.ending, 200),
    captionGuide: s(data.captionGuide, 160),
    pinnedComment: s(data.pinnedComment, 600),
    hashtags: arr(data.hashtags, 14).map((x) => s(x, 40).replace(/^#/, '')).filter(Boolean),
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

/* ---------------------------------------------------------------- 📋 업무 대시보드 (work-dashboard.html)
 *  POST /api/content-ai  { action:'work_polish' | 'work_parse' | 'work_meeting', ... }
 *   · work_polish  { kind:'iss'|'wk', text }            → { data:{ text } }   보고서 문구 정리
 *   · work_parse   { text, mode?:'meeting' }            → { data:{ kind, type, title, date, ... , todos[], decisions[], actions[] } }
 *   · work_meeting { text } 또는 { mime, data(base64) } → { data:{ transcript, title, summary, decisions[], actions[] } }
 *  키가 없으면 다른 액션과 같은 503 안내를 그대로 돌려준다(UI가 '키 미설정'을 표시).
 *  Gemini 호출이 실패하면 200 + ok:false 로 사실대로 알린다 — 대시보드는 그때 전사문만이라도 저장한다.
 */
const SCHEMA_WORK_POLISH = {
  type: 'object',
  properties: { text: { type: 'string', description: '정리된 본문만 (머리말·설명 없이)' } },
  required: ['text'],
};

const SCHEMA_WORK_PARSE = {
  type: 'object',
  properties: {
    kind: { type: 'string', description: 'schedule(일정) | todo(할 일) | meeting(회의 기록) | run(런 현황) 중 하나' },
    type: { type: 'string', description: 'kind=schedule 일 때 구분: meeting | work | run | etc (아니면 빈 문자열)' },
    title: { type: 'string', description: '제목 (짧게, 없으면 빈 문자열)' },
    date: { type: 'string', description: '시작일 YYYY-MM-DD (없으면 빈 문자열)' },
    date2: { type: 'string', description: '종료일 YYYY-MM-DD (기간일 때만)' },
    time: { type: 'string', description: '시작 시각 HH:MM 24시간제 (없으면 빈 문자열)' },
    time2: { type: 'string', description: '종료 시각 HH:MM' },
    loc: { type: 'string', description: '장소' },
    who: { type: 'string', description: '만나는 사람' },
    group: { type: 'string', description: '런 이름 (예: VT04차 런)' },
    part: { type: 'string', description: '런 파트 (양극 / 음극)' },
    status: { type: 'string', description: '런 현황: 대기 | 진행중 | 평가대기 | 평가중 | 완료 | 보류' },
    memo: { type: 'string', description: '회의 내용·메모 (원문에 있는 내용만)' },
    summary: { type: 'string', description: '한두 줄 요약' },
    decisions: { type: 'array', items: { type: 'string' }, description: '결정사항' },
    actions: { type: 'array', items: { type: 'string' }, description: '액션아이템' },
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DD 또는 빈 문자열' } },
      },
      description: 'kind=todo 일 때 넣을 할 일들',
    },
    run: {
      type: 'object',
      properties: {
        doe: { type: 'string' },
        mixst: { type: 'string', description: '진행중 | 완료 | 빈 문자열' },
        mixi: { type: 'string' },
        coatst: { type: 'string' },
        coati: { type: 'string' },
        pressst: { type: 'string' },
        pressi: { type: 'string' },
        silst: { type: 'string' },
        silr: { type: 'string' },
        semist: { type: 'string' },
        semir: { type: 'string' },
        etc: { type: 'string' },
      },
      description: 'kind=run 일 때 채울 공정·평가 값',
    },
  },
  required: ['kind'],
};

const SCHEMA_WORK_MEETING = {
  type: 'object',
  properties: {
    transcript: { type: 'string', description: '음성/전사문을 실제 발언 순서대로 정리한 전사 (원문에 없으면 빈 문자열)' },
    title: { type: 'string', description: '회의 제목 (전사로 알 수 있을 때만, 아니면 빈 문자열)' },
    summary: { type: 'string', description: '3줄 이내 요약' },
    decisions: { type: 'array', items: { type: 'string' }, description: '결정사항 (각 1문장)' },
    actions: { type: 'array', items: { type: 'string' }, description: '액션아이템 (담당자가 나오면 “홍길동: …” 형태)' },
    attendees: { type: 'array', items: { type: 'string' }, description: '등장한 사람 이름 (없으면 빈 배열)' },
  },
  required: ['summary'],
};

const WORK_DATE = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
const WORK_TIME = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : '');
function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
const WORK_WD = ['일', '월', '화', '수', '목', '금', '토'];

function workPolishPrompt(kind, text) {
  const iss =
    kind === 'iss'
      ? '이차전지 극판 제작 공정(믹싱·코팅·프레스)의 “공정중 이슈” 메모입니다. 보고서에 그대로 붙여넣을 수 있게 정리하세요.\n' +
        '- 공정별로 한 줄(같은 공정 내용은 합치기), 형식: "· 공정명 (상태, 날짜): 내용"\n' +
        '- 개조식 명사형 종결(예: ~함, ~필요, ~확인 중), 불필요한 조사·중복 표현·구어체 제거\n' +
        '- 숫자, 날짜, 상태, 고유명사는 그대로 유지하고 없는 내용은 절대 추가하지 마세요\n'
      : '주간업무 보고 초안입니다. 보고용으로 다듬으세요.\n' +
        '- 섹션 제목(▶, ■), 날짜, 숫자, 상태, 고유명사는 그대로 유지\n' +
        '- 중복되는 표현과 군더더기를 줄이고 간결한 개조식 문장으로 정리\n' +
        '- 없는 내용은 절대 추가하지 마세요\n';
  return {
    system:
      '너는 이차전지 전극 공정 실무자의 한국어 업무 문구를 다듬는 편집자다. ' +
      '주어진 글의 사실만 남기고 새로운 사실·수치·이름을 만들지 않는다. 출력은 JSON 하나뿐이다.',
    user: iss + '\n아래 메모를 정리해 JSON {"text":"..."} 로만 답하세요. 설명·머리말 없이 정리된 본문만 넣으세요.\n\n---\n' + text,
    schema: SCHEMA_WORK_POLISH,
    temperature: 0.2,
    maxTokens: 2000,
  };
}

function workParsePrompt(text, mode) {
  const today = kstToday();
  const base = new Date(today + 'T00:00:00Z');
  const wd = WORK_WD[base.getUTCDay()];
  const table = [];
  for (let i = 0; i < 15; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    table.push(d.toISOString().slice(0, 10) + ' ' + WORK_WD[d.getUTCDay()] + (i === 0 ? '(오늘)' : ''));
  }
  const focus =
    mode === 'meeting'
      ? '이 글은 회의 메모입니다. kind="meeting" 으로 두고 memo(원문 취지)·summary·decisions·actions 를 채우세요.'
      : '문장의 의도를 kind 로 고르세요: 일정이면 schedule, 해야 할 일이면 todo, 회의 결과/메모면 meeting, 런(전지 시험 런) 현황이면 run.';
  return {
    system:
      '너는 한국어 업무 문장을 업무 대시보드 항목으로 나누는 도우미다. ' +
      '오늘은 ' + today + ' (' + wd + '요일, 한국 시간)이다. ' +
      '원문에 없는 정보는 절대 만들지 말고 빈 문자열/빈 배열로 둔다. 출력은 JSON 하나뿐이다.',
    user:
      focus +
      '\n\n[날짜표 — 오늘부터 15일, 이 표의 날짜만 고른다]\n' + table.join('  |  ') +
      '\n- “내일/모레/이번 주 X요일/다음 주 X요일/N일 뒤”는 위 표에서 그 날짜를 골라 date에 YYYY-MM-DD로 넣는다. “다음 주 X요일”은 오늘 요일에서 7일 뒤 같은 요일이다.\n' +
      '- “오후 2시”→time "14:00", “오전 9시 반”→"09:30". 시각은 24시간 HH:MM.\n' +
      '- title 은 “일정 넣어줘/추가/등록” 같은 요청 표현을 뺀 알맹이만 (예: "VT07차 음극 런 평가 미팅")\n' +
      '- 런이면 group(“VT07차 런”)·part(양극/음극)·status 를 채우고, 공정·평가 언급이 있으면 run 객체에 넣는다.\n' +
      '- 할 일이 여러 개면 todos 배열로.\n' +
      '- ⚠️ 모든 칸에는 결과 값만 넣는다. 계산 과정·괄호 설명·추론 메모·문장 부연은 어느 칸에도 쓰지 않는다. who 에는 사람 이름만.\n' +
      '- 모르는 값은 빈 문자열("")로 둔다.\n\n문장:\n' + text + '\n\nJSON 으로만 답하세요.',
    schema: SCHEMA_WORK_PARSE,
    temperature: 0.2,
    maxTokens: 2000,
  };
}

function workMeetingPrompt(text, hint) {
  const head =
    '아래는 회의 녹음' + (text ? '의 전사문' : ' 파일') + '입니다. ' +
    (hint ? '회의 제목 힌트: “' + hint + '”. ' : '') +
    '다음 규칙으로 정리하세요.\n' +
    '- summary: 3줄 이내 한국어 요약 (무슨 회의였고 무엇이 정해졌는지)\n' +
    '- decisions: 실제로 확정·합의된 것만 각 1문장\n' +
    '- actions: 다음에 해야 할 일만 각 1문장 (담당자가 들리면 “이름: 할 일”)\n' +
    '- transcript: 들린 발언을 순서대로 정리(없으면 빈 문자열). 숫자·일정·고유명사는 들린 그대로\n' +
    '- 추측하거나 없는 내용을 만들지 마세요. 잡음만 있고 내용이 없으면 summary 를 “들리는 내용이 없습니다”로.\n';
  return {
    system:
      '너는 한국어 회의 녹음을 정리하는 속기·요약 도우미다. 들린 내용만 쓴다. 출력은 JSON 하나뿐이다.',
    user: head + (text ? '\n전사문:\n' + text : '\n(첨부한 음성을 듣고 위 형식으로 정리하세요.)') + '\n\nJSON 으로만 답하세요.',
    schema: SCHEMA_WORK_MEETING,
    temperature: 0.2,
    maxTokens: 4000,
    media: null,
  };
}

async function handleWork(res, body, keyConfigured) {
  const action = s(body.action, 30);
  if (!keyConfigured) return send(res, 503, noKeyBody());
  if (process.env.DISABLE_GEMINI === '1') {
    return send(res, 503, { ok: false, reason: 'disabled', message: '이 환경에서는 Gemini 호출이 꺼져 있습니다(DISABLE_GEMINI=1).', keyConfigured: true });
  }

  let prompt = null;
  let media = null;
  if (action === 'work_polish') {
    const text = s(body.text, 20000);
    const kind = s(body.kind, 10) === 'iss' ? 'iss' : 'wk';
    if (text.length < 2) return send(res, 400, { ok: false, reason: 'missing_text', message: '정리할 내용이 없습니다.' });
    prompt = workPolishPrompt(kind, text);
  } else if (action === 'work_parse') {
    const text = s(body.text, 2000);
    if (text.length < 2) return send(res, 400, { ok: false, reason: 'missing_text', message: '해석할 문장이 없습니다.' });
    prompt = workParsePrompt(text, s(body.mode, 20));
  } else {
    const text = s(body.text, 60000);
    const hint = s(body.hint, 120);
    const mime = s(body.mime, 60).toLowerCase().split(';')[0].trim();
    const b64 = String(body.data || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!text && !b64) {
      return send(res, 400, {
        ok: false,
        reason: 'missing_input',
        message: '받아쓴 글(text) 또는 녹음 파일(mime·data) 중 하나가 필요합니다.',
      });
    }
    if (!text && b64) {
      if (SUMMARY_MEDIA_MIMES.indexOf(mime) < 0) {
        return send(res, 400, {
          ok: false,
          reason: 'unsupported_media_type',
          message: 'M4A · MP3 · WAV · WEBM · OGG · MP4 만 전사할 수 있습니다(받은 형식: ' + (mime || '알 수 없음') + ').',
        });
      }
      const bytes = Math.floor((b64.length * 3) / 4);
      if (bytes > SUMMARY_MEDIA_MAX_BYTES + 8192) {
        return send(res, 413, {
          ok: false,
          reason: 'media_too_large',
          message: '녹음 파일은 4MB까지입니다(지금 ' + (bytes / 1048576).toFixed(1) + 'MB). 녹음기에서 필요한 구간만 잘라 다시 올려 주세요.',
        });
      }
      media = [{ mimeType: mime, data: b64 }];
    }
    prompt = workMeetingPrompt(text, hint);
    if (media) prompt.media = media;
  }

  const started = Date.now();
  const deadline = started + (media ? 52000 : 45000);
  let out;
  try {
    out = await generate(prompt, deadline);
  } catch (err) {
    const status = err.status === 400 ? 400 : 200;
    const message =
      err.code === 'quota_exceeded'
        ? 'Gemini 무료 티어의 모델별 하루 요청 한도를 다 썼습니다. 잠시 뒤 다시 눌러 주세요.'
        : err.status === 504
          ? 'Gemini 응답이 시간 안에 오지 않았습니다. 조금 짧게 다시 눌러 주세요.'
          : err.code === 'all_models_busy'
            ? 'Gemini 모델이 지금 몰려서 응답하지 않았습니다. 1~2분 뒤 다시 눌러 주세요.'
            : `Gemini 호출 실패: ${String(err.message || '').slice(0, 180)}`;
    return send(res, status, { ok: false, action, reason: err.code || 'gemini_unavailable', message, keyConfigured: true, tries: err.tries || [] });
  }

  const parsed = extractJson(out.text) || {};
  let data = null;
  if (action === 'work_polish') {
    const text = s(parsed.text, 20000);
    if (!text) {
      return send(res, 200, { ok: false, action, reason: 'empty_result', message: '정리된 문장이 비어 왔습니다. 한 번 더 눌러 주세요.', model: out.model, __raw: out.text.slice(0, 4000) });
    }
    data = { text };
  } else if (action === 'work_parse') {
    const kindRaw = s(parsed.kind, 20).toLowerCase();
    const kind = ['schedule', 'todo', 'meeting', 'run'].indexOf(kindRaw) >= 0 ? kindRaw : 'schedule';
    const typeRaw = s(parsed.type, 20).toLowerCase();
    const type = ['meeting', 'work', 'run', 'etc'].indexOf(typeRaw) >= 0 ? typeRaw : (kind === 'meeting' ? 'meeting' : kind === 'run' ? 'run' : 'work');
    const run = parsed.run && typeof parsed.run === 'object' ? parsed.run : {};
    data = {
      kind,
      type,
      title: s(parsed.title, 120),
      date: WORK_DATE(parsed.date),
      date2: WORK_DATE(parsed.date2),
      time: WORK_TIME(parsed.time),
      time2: WORK_TIME(parsed.time2),
      loc: s(parsed.loc, 80),
      who: s(parsed.who, 80),
      group: s(parsed.group, 60),
      part: s(parsed.part, 20),
      status: ['대기', '진행중', '평가대기', '평가중', '완료', '보류'].indexOf(s(parsed.status, 10)) >= 0 ? s(parsed.status, 10) : '',
      memo: s(parsed.memo, 8000),
      summary: s(parsed.summary, 400),
      decisions: arr(parsed.decisions, 20).map((x) => s(x, 300)).filter(Boolean),
      actions: arr(parsed.actions, 20).map((x) => s(x, 300)).filter(Boolean),
      todos: arr(parsed.todos, 20)
        .map((x) => ({ text: s(x && x.text, 200), due: WORK_DATE(x && (x.due || x.date)) }))
        .filter((x) => x.text),
      run: {
        doe: s(run.doe, 80),
        mixst: s(run.mixst, 10), mixi: s(run.mixi, 200),
        coatst: s(run.coatst, 10), coati: s(run.coati, 200),
        pressst: s(run.pressst, 10), pressi: s(run.pressi, 200),
        silst: s(run.silst, 10), silr: s(run.silr, 200),
        semist: s(run.semist, 10), semir: s(run.semir, 200),
        etc: s(run.etc, 200),
      },
    };
  } else {
    const transcript = s(parsed.transcript, 60000);
    const summary = s(parsed.summary, 800);
    const decisions = arr(parsed.decisions, 30).map((x) => s(x, 300)).filter(Boolean);
    const actions = arr(parsed.actions, 30).map((x) => s(x, 300)).filter(Boolean);
    if (!summary && !transcript && !decisions.length && !actions.length) {
      return send(res, 200, {
        ok: false,
        action,
        reason: 'empty_result',
        message: '녹음에서 알아들을 내용을 찾지 못했습니다. 다시 녹음하거나 직접 메모해 주세요.',
        model: out.model,
        __raw: out.text.slice(0, 4000),
      });
    }
    data = {
      transcript,
      title: s(parsed.title, 120),
      summary,
      decisions,
      actions,
      attendees: arr(parsed.attendees, 20).map((x) => s(x, 40)).filter(Boolean),
    };
  }

  return send(res, 200, {
    ok: true,
    action,
    parsed: !!extractJson(out.text),
    model: out.model,
    primaryModel: PRIMARY_MODEL,
    fellBack: !!out.fellBack,
    elapsedMs: Date.now() - started,
    data,
  });
}

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
  'cut_rewrite',
  'live_briefing',
];

/* ✨ 컷 1개 다시 쓰기 — 전체 대본을 다시 뽑지 않고, 그 컷의 자막·나레이션만 다듬는다. */
const SCHEMA_CUT_REWRITE = {
  type: 'object',
  properties: {
    subtitle: { type: 'string', description: '화면 자막 — 공백 포함 14~22자. 숫자는 원문 그대로 둔다' },
    narration: { type: 'string', description: '성우가 3~5초에 읽는 한국어 구어체 1~2문장 (45~80자)' },
    why: { type: 'string', description: '무엇을 왜 바꿨는지 한 줄 (20자 내외, 없으면 빈 문자열)' },
  },
  required: ['subtitle', 'narration'],
};

function promptCutRewrite(b) {
  const nar = s(b.narration, 600);
  const sub = s(b.subtitle, 300);
  const prev = s(b.prevText, 300);
  const next = s(b.nextText, 300);
  const title = s(b.title, 120);
  const tone = s(b.tone, 40) || '정보 전달 · 담백한 구어체';
  const facts = (String(nar + ' ' + sub).match(/\d[\d,.]*\s*(?:%|퍼센트|억|조|계약|pt|원|배|개)?/g) || []).slice(0, 12);
  const user = [
    title ? `영상 제목: ${title}` : '',
    `지금 컷: ${Number(b.index || 0) + 1} / ${Number(b.total || 1) || 1}`,
    `현재 자막: "${sub}"`,
    `현재 나레이션: "${nar}"`,
    prev ? `앞 컷 자막(참고): "${prev}"` : '',
    next ? `뒤 컷 자막(참고): "${next}"` : '',
    facts.length
      ? `이 컷에 이미 있는 수치(그대로 둔다): ${facts.join(' · ')}`
      : '이 컷에는 수치가 없다 — 수치를 새로 만들지 않는다.',
    `
[해야 할 일 — 이 한 컷만 다시 쓰기]
1) subtitle: 화면에서 1초에 읽히는 임팩트 자막. 공백 포함 14~22자, 앞 컷과 같은 말을 반복하지 않는다.
2) narration: 성우가 3~5초에 읽는 자연스러운 한국어 구어체 1~2문장(45~80자). "~했죠 / ~인데요"처럼 말을 거는 톤.
3) 톤: ${tone}
4) 위 수치·고유명사 밖의 새 숫자·가격·날짜·이름을 만들지 않는다. 확인한 내용만 쓴다.
5) why: 무엇을 왜 바꿨는지 한 줄. 없으면 빈 문자열.
[출력] subtitle · narration · why JSON.`,
  ].filter(Boolean).join('\n');
  return {
    system: `너는 한국어 유튜브 쇼츠 대본 작가다. 한 컷의 자막과 나레이션만 다시 쓴다. 확인한 내용만 쓴다. ${HONESTY}`,
    user,
    schema: SCHEMA_CUT_REWRITE,
    maxTokens: 500,
    temperature: 0.85,
  };
}

function normCutRewrite(data) {
  return {
    subtitle: s(data && data.subtitle, 60),
    narration: s(data && data.narration, 220),
    why: s(data && data.why, 60),
  };
}

/* ====================== ⚡ 실시간 즉석 브리핑 (live_briefing) ======================
 * POST /api/content-ai  { mode:'live_briefing' | action:'live_briefing', facts:{...} }
 *
 *   버튼을 누른 그 순간 프론트가 받아 온 실측 JSON
 *   (/api/live-briefing · /api/tabs-live · /api/stock-live?mode=index|top · /data/supply-latest.json)을
 *   facts 로 넘겨받아, 서버 KST 시각과 함께 '지금 이 시각' 브리핑을 만든다.
 *
 *   원칙
 *    - 수치는 facts 에 있는 값만 쓴다. Gemini 문장에 facts 에 없는 숫자가 있으면 그 문장은 버린다.
 *    - Gemini 가 죽든·느리든 실측 수치만으로 조립한 요약을 항상 200 으로 돌려준다(빈 화면·에러 금지).
 *    - 휴장이면 '직전 거래일(11/20) 마감 실측 기준'임을 헤더·본문에 정확히 적는다.
 */

const LB_DEADLINE_MS = 24000;
const LB_WEEKDAY_KO = { Sun: '일', Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토' };

function lbKst(now) {
  const d = now instanceof Date ? now : new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(d);
  const g = (t) => (parts.find((x) => x.type === t) || {}).value || '';
  const hh = Number(g('hour')) % 24;
  return {
    y: Number(g('year')),
    m: Number(g('month')),
    d: Number(g('day')),
    hh,
    mi: Number(g('minute')),
    ss: Number(g('second')),
    wd: g('weekday'),
    minutes: hh * 60 + Number(g('minute')),
  };
}

const lbPad = (n) => (n < 10 ? '0' : '') + n;

function lbShortDate(v) {
  const t = s(v, 30);
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})\(([^)]*)\)$/);
  if (m) return `${m[2]}/${m[3]}(${m[4]})`;
  const m2 = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return `${m2[2]}/${m2[3]}`;
  return t;
}

function lbNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.replace(/,/g, '').replace(/[^0-9.\-+]/g, '');
  if (!t || !/[0-9]/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function lbFmt(n, d) {
  const v = lbNum(n);
  if (v === null) return null;
  return v.toLocaleString('ko-KR', { maximumFractionDigits: d == null ? 2 : d });
}

function lbPct(p) {
  const n = lbNum(p);
  if (n === null) return null;
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function lbTone(p) {
  const n = lbNum(p);
  if (n === null) return 'flat';
  return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}

function lbEokSigned(v) {
  const n = lbNum(v);
  if (n === null) return null;
  return (n > 0 ? '+' : '') + Math.round(n).toLocaleString('ko-KR') + '억';
}

function lbEokPlainFromKrw(v) {
  const n = lbNum(v);
  if (n === null) return null;
  const eok = n / 1e8;
  const txt = eok >= 100 ? Math.round(eok).toLocaleString('ko-KR') : eok.toFixed(eok >= 10 ? 0 : 1);
  return txt + '억';
}

function lbSanitizeFacts(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const take = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const live = obj(r.live);
  const tabs = obj(r.tabs);
  const stocks = obj(r.stocks);
  const supply = obj(r.supply);

  const indices = take(live.indices, 4)
    .map((i) => ({
      key: s(i && i.key, 10),
      name: s(i && i.name, 20),
      price: lbNum(i && i.price),
      change: lbNum(i && i.change),
      changePct: lbNum(i && i.changePct),
      value: lbNum(i && i.value),
      valueText: s(i && i.valueText, 24),
    }))
    .filter((i) => i.name && i.price !== null);
  const indices2 = indices.length
    ? indices
    : take(stocks.indices, 4)
        .map((i) => ({
          key: s(i && i.key, 10),
          name: s(i && i.name, 20),
          price: lbNum(i && i.price),
          change: lbNum(i && i.change),
          changePct: lbNum(i && i.changePct),
          value: lbNum(i && i.value),
          valueText: s(i && i.valueText, 24),
        }))
        .filter((i) => i.name && i.price !== null);

  const futuresRaw = take(live.futures, 4).length ? take(live.futures, 4) : take(stocks.futures, 4);
  const futures = futuresRaw
    .map((f) => ({
      name: s(f && f.name, 24),
      price: lbNum(f && f.price),
      changePct: lbNum(f && f.changePct),
      asOfKst: s(f && f.asOfKst, 20),
    }))
    .filter((f) => f.name && f.price !== null);

  const fxRaw = live.fx && live.fx.price != null ? live.fx : stocks.fx && stocks.fx.price != null ? stocks.fx : null;
  const fx = fxRaw
    ? {
        name: s(fxRaw.name, 16) || '원/달러',
        price: lbNum(fxRaw.price),
        changePct: lbNum(fxRaw.changePct),
        tradedDate: s(fxRaw.tradedDate, 12),
      }
    : null;

  const topMovers = take(live.topMovers, 10)
    .map((t) => ({
      name: s(t && t.name, 24),
      code: s(t && t.code, 8),
      price: lbNum(t && t.price),
      changePct: lbNum(t && t.changePct),
      valueText: s(t && t.valueText, 20),
      tag: s(t && t.tag, 8),
      upperLimit: !!(t && t.upperLimit),
    }))
    .filter((t) => t.name && t.price !== null);

  const leadersRaw = take(stocks.stocks, 14).filter((x) => x && x.name && lbNum(x.value) !== null);
  const leaders = (leadersRaw.length ? leadersRaw : take(stocks.stocks, 14))
    .map((t) => ({
      name: s(t && t.name, 24),
      code: s(t && t.code, 8),
      market: s(t && t.market, 8),
      price: lbNum(t && t.price),
      changePct: lbNum(t && t.changePct),
      value: lbNum(t && t.value),
      valueText: s(t && t.valueText, 24),
      valueDispText: s((t && (t.valueDispText || t.valueText)) || '', 40),
    }))
    .filter((t) => t.name && t.price !== null)
    .sort((a, b) => (b.value || 0) - (a.value || 0))
    .slice(0, 8);

  const themes = take(tabs.themes, 8)
    .map((t, idx) => ({
      rank: lbNum(t && t.rank) || idx + 1,
      name: s(t && t.name, 40),
      avgPct: lbNum(t && t.avgPct),
      riseCount: lbNum(t && t.riseCount),
      fallCount: lbNum(t && t.fallCount),
      top4Sum: lbNum(t && t.top4Sum),
      stocks: take(t && t.stocks, 4)
        .map((x) => ({
          name: s(x && x.name, 24),
          changePct: lbNum(x && x.changePct),
          valueText: s(x && (x.valueDispText || x.valueText), 24),
          upperLimit: !!(x && x.upperLimit),
        }))
        .filter((x) => x.name),
    }))
    .filter((t) => t.name);

  const searchTop = take(tabs.searchTop, 6)
    .map((t) => ({
      rank: lbNum(t && t.rank),
      name: s(t && t.name, 24),
      changePct: lbNum(t && t.changePct),
      valueText: lbNum(t && t.value) !== null ? lbEokPlainFromKrw(t.value) : '',
      market: s(t && t.market, 8),
    }))
    .filter((t) => t.name);

  const after = obj(tabs.aftermarket);
  const aftermarket = {
    basisLabel: s(after.basisLabel, 40),
    sessionLabel: s(after.sessionLabel, 60),
    inSession: !!after.inSession,
    byValue: take(after.byValue, 4)
      .map((x) => ({
        name: s(x && x.name, 24),
        changePct: lbNum(x && x.changePct),
        overPct: lbNum(x && x.overPct),
        valueText: s(x && (x.overValueDispText || x.overValueText), 24),
      }))
      .filter((x) => x.name),
  };

  const upper = obj(tabs.upperLimit);
  const upperLimit = take(upper.confirmed, 3)
    .concat(take(upper.watch, 3))
    .map((x) => ({
      name: s(x && x.name, 24),
      changePct: lbNum(x && x.changePct),
      valueText: s(x && (x.valueIntegText || x.valueDispText || x.valueText), 24),
      confirmed: !!(x && x.upperLimit),
    }))
    .filter((x) => x.name);

  const newsRaw = take(tabs.news, 6).length ? take(tabs.news, 6) : take(live.news, 6);
  const news = newsRaw
    .map((n) => ({ title: s(n && n.title, 120), press: s(n && n.press, 20), time: s(n && n.time, 10) }))
    .filter((n) => n.title);

  const dataBasis = obj(live.dataBasis);
  const tradingDate = s(dataBasis.tradingDate, 12);
  let tradingDateLabel = s(dataBasis.tradingDateLabel, 30);
  if (!tradingDateLabel && tradingDate) {
    const p = lbKst(new Date(tradingDate + 'T00:00:00+09:00'));
    tradingDateLabel = `${lbPad(p.m)}/${lbPad(p.d)}(${LB_WEEKDAY_KO[p.wd] || ''})`;
  }
  // '2026-11-20(금)' → '11/20(금)' (헤더·본문이 길어지지 않게)
  tradingDateLabel = lbShortDate(tradingDateLabel);

  const notes = take(live.notes, 6)
    .concat(take(tabs.notes, 6))
    .map((n) => s(n, 220))
    .filter(Boolean)
    .slice(0, 8);

  const grab = (arr, n) =>
    take(arr, n)
      .map((x) => ({
        name: s(x && x.name, 24),
        foreignEok: lbNum(x && x.foreignEok),
        organEok: lbNum(x && x.organEok),
        individualEok: lbNum(x && x.individualEok),
      }))
      .filter((x) => x.name);
  const groups = obj(supply.groups);
  const supplyFacts = {
    basisLabel: lbShortDate(supply.basisLabel),
    confirmed: !!supply.confirmed,
    foreignBuy: grab(groups.foreignBuy, 3),
    organBuy: grab(groups.organBuy, 3),
    foreignSell: grab(groups.foreignSell, 3),
    dualBuy: grab(groups.dualBuy, 2),
  };

  return {
    marketPhase: s(live.marketPhase, 12),
    marketPhaseLabel: s(live.marketPhaseLabel, 60),
    sessionLabel: s(tabs.sessionLabel, 60),
    marketStatus: s(tabs.marketStatus || live.dataBasis && live.dataBasis.naverMarketStatus, 12),
    headline: s(live.headline, 260),
    generatedAtLabel: s(live.generatedAtLabel, 40),
    tradingDate,
    tradingDateLabel,
    indices: indices2,
    futures,
    fx,
    topMovers,
    leaders,
    themes,
    searchTop,
    aftermarket,
    upperLimit,
    news,
    supply: supplyFacts,
    notes,
  };
}

function lbPhaseOf(f, p) {
  const weekend = p.wd === 'Sat' || p.wd === 'Sun';
  const KNOWN = ['장전', '정규장', '장마감', '애프터·장마감', '주말', '휴장'];
  let phase = KNOWN.indexOf(f.marketPhase) >= 0 ? f.marketPhase : null;
  if (weekend) phase = '주말';
  if (!phase) {
    if (p.minutes < 9 * 60) phase = '장전';
    else if (p.minutes < 15 * 60 + 30) phase = '정규장';
    else phase = '장마감';
  }
  const label =
    phase === '주말'
      ? `주말 휴장 (${LB_WEEKDAY_KO[p.wd] || ''}요일 · 직전 거래일 종가 기준)`
      : phase === '휴장'
        ? '휴장일 (직전 거래일 종가 기준)'
        : phase === '장전'
          ? '장전 (09:00 정규장 시작 전)'
          : phase === '정규장'
            ? '정규장 진행 중 (09:00~15:30)'
            : '애프터·장마감 (15:30 정규장 종료 이후)';
  return { phase, label };
}

function lbBasisLine(f, phase) {
  const day = f.tradingDateLabel || (f.tradingDate ? f.tradingDate : null);
  if (phase === '주말' || phase === '휴장' || phase === '장마감' || phase === '애프터·장마감') {
    return day
      ? `데이터 기준: 직전 거래일 ${day} 마감 실측값 — 지금 움직이는 값이 아닙니다.`
      : '데이터 기준: 마지막 체결 실측값 — 지금 움직이는 값이 아닙니다.';
  }
  return day
    ? `데이터 기준: ${LB_WEEKDAY_KO[lbKst(new Date()).wd] || ''}요일 ${phase} 실측값(직전 거래일 ${day} 기준 포함).`
    : `데이터 기준: ${phase} 실측값.`;
}

function lbNextOpenLabel(p) {
  // 오늘(휴장) 다음 정규장 요일 — 주말이면 월요일, 평일이면 다음 평일
  const add = p.wd === 'Sat' ? 2 : p.wd === 'Sun' ? 1 : 1;
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  d.setUTCDate(d.getUTCDate() + add);
  const wd = LB_WEEKDAY_KO[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]] || '';
  return `${lbPad(d.getUTCMonth() + 1)}/${lbPad(d.getUTCDate())}(${wd})`;
}

/* facts 의 모든 숫자(문자열 안 숫자 포함)를 '허용 수치'로 모은다 — AI 문장 검증용 */
function lbAllowedNumbers(f) {
  const set = new Set();
  const add = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      set.add(Number(v.toFixed(4)));
      set.add(Math.round(v));
      set.add(Number(Math.abs(v).toFixed(4)));
      set.add(Math.round(Math.abs(v)));
    }
  };
  const walk = (v, depth) => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'number') return add(v);
    if (typeof v === 'string') {
      const m = v.match(/-?\d[\d,]*(?:\.\d+)?/g) || [];
      m.forEach((t) => add(Number(t.replace(/,/g, ''))));
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v === 'object') return Object.keys(v).forEach((k) => walk(v[k], depth + 1));
  };
  walk(f, 0);
  // 문장에 자연스럽게 섞이는 작은 수·연도·시각은 가격·수치 주장이 아니므로 허용한다.
  for (let i = 0; i <= 12; i++) set.add(i);
  [2024, 2025, 2026, 2027].forEach((y) => set.add(y));
  [9, 15, 30, 60, 100].forEach((n) => set.add(n));
  return set;
}

function lbNumbersInLine(line) {
  const out = [];
  const re = /-?\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(line))) {
    const raw = m[0].replace(/,/g, '');
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function lbNumberAllowed(n, set) {
  if (set.has(n)) return true;
  const abs = Math.abs(n);
  if (set.has(Math.round(n)) || set.has(Math.round(abs))) return true;
  for (const a of set) {
    if (a === 0) continue;
    if (Math.abs(a - n) <= Math.max(0.05, Math.abs(a) * 0.0006)) return true;
  }
  return false;
}

/** Gemini 문장 중 facts 에 없는 숫자를 담은 문장은 버린다. */
function lbFilterLines(lines, allowed) {
  const kept = [];
  let dropped = 0;
  (Array.isArray(lines) ? lines : []).forEach((ln) => {
    const text = s(ln, 400);
    if (text.length < 4) return;
    const bad = lbNumbersInLine(text).filter((n) => !lbNumberAllowed(n, allowed));
    if (bad.length) {
      dropped += 1;
      return;
    }
    const fixed = text
      .replace(/(\d(?:\.\d+)?)\s*퍼센트/g, '$1%') // '0.82퍼센트' → '0.82%'
      .replace(/선감/g, '선물')
      .replace(/나스닥100\s*선물\s*선물/g, '나스닥100 선물');
    kept.push(fixed);
  });
  return { kept: kept.slice(0, 5), dropped };
}

function lbBuildRows(f) {
  const rows = [];
  f.indices.forEach((i) => {
    rows.push({
      label: i.name,
      value: lbFmt(i.price, 2),
      delta: [lbFmt(i.change, 2), lbPct(i.changePct)].filter(Boolean).join(' / '),
      extra: i.valueText ? '거래대금 ' + i.valueText : null,
      tone: lbTone(i.changePct),
    });
  });
  f.futures.forEach((x) => {
    rows.push({
      label: x.name,
      value: lbFmt(x.price, 2),
      delta: lbPct(x.changePct),
      extra: x.asOfKst ? '기준 ' + x.asOfKst : null,
      tone: lbTone(x.changePct),
    });
  });
  if (f.fx && f.fx.price !== null) {
    rows.push({
      label: f.fx.name + ' 환율',
      value: lbFmt(f.fx.price, 2) + '원',
      delta: lbPct(f.fx.changePct),
      extra: f.fx.tradedDate ? '기준 ' + f.fx.tradedDate : null,
      tone: lbTone(f.fx.changePct),
    });
  }
  return rows;
}

function lbSupplyLines(f, max) {
  const sp = f.supply || {};
  const cap = max == null ? 4 : max;
  const out = [];
  const basis = sp.basisLabel ? ` — ${sp.basisLabel} 거래소 확정` : ' — 거래소 확정치';
  const line = (label, arr, key) =>
    arr && arr.length
      ? `${label}: ` +
        arr
          .slice(0, 3)
          .map((x) => `${x.name} ${lbEokSigned(x[key])}`)
          .filter((x) => x.indexOf('null') < 0)
          .join(' · ') +
        basis
      : null;
  const fb = line('외국인 순매수 상위', sp.foreignBuy, 'foreignEok');
  const ob = line('기관 순매수 상위', sp.organBuy, 'organEok');
  const fs = line('외국인 순매도 상위', sp.foreignSell, 'foreignEok');
  const db = line('외인·기관 동반 매수', sp.dualBuy, 'foreignEok');
  [fb, ob, fs, db].forEach((x) => x && out.push(x));
  if (!out.length) out.push('투자자별 수급: 이번 응답에 확정 수급 자료가 없습니다 — 💰 수급 탭에서 확인하세요.');
  return out.slice(0, cap);
}

function lbThemeLines(f) {
  const out = [];
  if (!f.themes.length) {
    out.push('주도 테마: 이번 응답에 테마 랭킹이 없습니다 — 📈 테마 탭에서 확인하세요.');
  } else {
    const top = f.themes.slice(0, 3);
    out.push(
      '주도 테마(테마 내 노출 종목 평균 등락률): ' +
        top
          .map((t) => `${t.rank}위 ${t.name} ${lbPct(t.avgPct) || '등락률 없음'}`)
          .join(' · ') +
        (f.tradingDateLabel ? ` — ${f.tradingDateLabel} 마감 기준.` : '.'),
    );
    const best = f.themes
      .slice()
      .sort((a, b) => (b.avgPct == null ? -999 : b.avgPct) - (a.avgPct == null ? -999 : a.avgPct))[0];
    if (best && best.stocks && best.stocks.length) {
      out.push(
        `${best.name} 노출 종목 중 상승률 상위: ` +
          best.stocks
            .slice(0, 3)
            .map((x) => `${x.name} ${lbPct(x.changePct) || ''}${x.valueText ? '(' + x.valueText + ')' : ''}`)
            .join(' · ') +
          '.',
      );
    }
  }
  return out;
}

function lbLeaderRows(f) {
  const src = f.leaders.length ? f.leaders : f.topMovers.map((t) => ({ ...t, value: null }));
  return src.slice(0, 5).map((t) => ({
    name: t.name,
    code: t.code || null,
    market: t.market || null,
    price: lbFmt(t.price, 0),
    changePct: lbPct(t.changePct),
    tone: lbTone(t.changePct),
    valueText: t.valueDispText || t.valueText || null,
    upperLimit: !!t.upperLimit,
  }));
}

function lbCheckpointPhase(f, phase, phaseLabel, p) {
  const out = [];
  const day = f.tradingDateLabel || '직전 거래일';
  if (phase === '주말' || phase === '휴장') {
    out.push(`${phaseLabel} — 국내 정규장이 열리지 않습니다. 다음 정규장은 ${lbNextOpenLabel(p)} 09:00 개장입니다.`);
    out.push(`지수·선물·환율·종목 수치는 ${day} 마감(또는 마지막 체결) 실측값이고, 지금 움직이는 값이 아닙니다.`);
  } else if (phase === '장전') {
    out.push(`장전 — 09:00 정규장 개장 전입니다. 아래 수치는 ${day} 마감 실측값과 개장 전 마지막 체결값입니다.`);
    out.push('동시호가(08:30~09:00) 전 예상 체결가는 호가 왜곡이 생기므로 시초가 확인 뒤 대응하세요.');
  } else if (phase === '정규장') {
    out.push('정규장 진행 중 — 아래 지수·종목 수치는 이번 응답의 체결 시각 기준이고, 15:30 종료 전까지 계속 바뀝니다.');
    out.push('장중 수급은 확정치가 아니라 잠정치입니다 — 종가 확정 수급과 다를 수 있습니다.');
  } else {
    out.push(`장마감 — 아래 수치는 ${day} 종가와 시간외 마지막 체결값입니다.`);
    out.push('다음 정규장 시초가 전까지는 시간외 단일가·해외 선물 흐름만 갱신됩니다.');
  }
  return out;
}

function lbCheckpointFacts(f, phase, phaseLabel, p) {
  const out = [];
  const day = f.tradingDateLabel || '직전 거래일';
  const k = f.indices.find((i) => i.key === 'KOSPI') || f.indices[0] || null;
  const q = f.indices.find((i) => i.key === 'KOSDAQ') || null;
  if (k && k.changePct !== null && k.changePct <= -3) {
    out.push(
      `코스피 ${lbPct(k.changePct)}(${lbFmt(k.price, 2)}) 급락 마감 — 급락 다음 거래일은 갭·변동성 확대 구간이라 시초가 추격보다 체결 확인이 우선입니다.`,
    );
  } else if (k && k.changePct !== null && k.changePct >= 3) {
    out.push(`코스피 ${lbPct(k.changePct)}(${lbFmt(k.price, 2)}) 급등 마감 — 갭 상승 출발 뒤 되돌림 여부를 시초가 5분봉으로 확인하세요.`);
  }
  if (q && q.changePct !== null && k && k.changePct !== null && Math.abs(q.changePct - k.changePct) >= 2) {
    out.push(`코스피 ${lbPct(k.changePct)} vs 코스닥 ${lbPct(q.changePct)} — 두 시장 온도차가 2%p 이상입니다(순환매·자금 이동 구간).`);
  }
  const fut = f.futures.filter((x) => x.changePct !== null);
  if (fut.length && fut.every((x) => x.changePct < 0)) {
    out.push(`해외 선물 동반 약세(${fut.map((x) => `${x.name} ${lbPct(x.changePct)}`).join(' · ')}) — 다음 국내장 시초가 방향의 참고값입니다.`);
  } else if (fut.length && fut.every((x) => x.changePct > 0)) {
    out.push(`해외 선물 동반 강세(${fut.map((x) => `${x.name} ${lbPct(x.changePct)}`).join(' · ')}) — 다음 국내장 갭 방향의 참고값입니다.`);
  }
  if (f.fx && f.fx.price !== null) {
    out.push(`원/달러 ${lbFmt(f.fx.price, 2)}원(${lbPct(f.fx.changePct) || '등락률 없음'}) — 환율 레벨이 외국인 수급의 변수입니다.`);
  }
  if (k && k.value && f.leaders.length >= 3) {
    const top3 = f.leaders.slice(0, 3).reduce((a, x) => a + (x.value || 0), 0);
    const ratio = (top3 / k.value) * 100;
    if (Number.isFinite(ratio) && ratio >= 20) {
      out.push(`거래대금 상위 3종목(${f.leaders.slice(0, 3).map((x) => x.name).join('·')})이 코스피 거래대금의 ${ratio.toFixed(1)}% — 자금이 소수 종목에 몰린 상태입니다.`);
    }
  }
  if (f.upperLimit.length) {
    out.push(
      `상한가 근접/관찰: ${f.upperLimit
        .slice(0, 3)
        .map((x) => `${x.name} ${lbPct(x.changePct) || ''}${x.valueText ? '(' + x.valueText + ')' : ''}`)
        .join(' · ')} — 확정 상한가가 아닌 관찰 목록입니다.`,
    );
  }
  if (f.aftermarket.basisLabel) {
    out.push(
      `시간외: ${f.aftermarket.basisLabel}${f.aftermarket.inSession ? ' (세션 진행 중)' : ' (세션 아님 · 마감값)'} 기준입니다.`,
    );
  }
  out.push('DART 공시·기관 리포트·뉴스 원문은 이 브리핑에 포함되지 않습니다 — 🚨 DART 레이더와 뉴스 탭에서 확인하세요.');
  return out;
}

function lbPrompt(f, phaseLabel, p, nowLabel) {
  const day = f.tradingDateLabel || f.tradingDate || '직전 거래일';
  const factsForPrompt = {
    지금시각: nowLabel,
    시장상태: phaseLabel,
    데이터기준일: day,
    지수: f.indices,
    해외선물: f.futures,
    환율: f.fx,
    수급: f.supply,
    주도테마: f.themes.map((t) => ({ 순위: t.rank, 테마: t.name, 평균등락률: t.avgPct, 상승: t.riseCount, 하락: t.fallCount, 대금합: t.top4Sum, 종목: t.stocks })),
    거래대금상위: f.leaders,
    검색상위: f.searchTop,
    상한가관찰: f.upperLimit,
    시간외: f.aftermarket,
    뉴스: f.news,
  };
  return {
    system:
      '너는 한국 주식시장 시황 브리핑을 쓰는 애널리스트다. 규칙: (1) 제공된 FACTS JSON에 있는 수치만 쓴다. ' +
      '(2) FACTS에 없는 숫자·종목명·뉴스·공시·목표가를 절대 만들지 않는다. (3) 확인된 사실과 해석을 구분하고, 해석은 "가능성/참고"로만 표현한다. ' +
      '(4) 휴장·장마감이면 "직전 거래일 마감 실측 기준"임을 분명히 밝힌다. (5) 숫자는 콤마·소수점을 FACTS와 똑같이 쓴다(등락률은 % 기호로 쓰고 "퍼센트"라는 단어를 쓰지 않는다). (6) 모든 문장은 "~습니다/~입니다" 정중한 서술로 끝낸다(반말·"~한다"체 금지). (7) 수치가 없는 막연한 문장(참고해야 합니다·유의할 필요가 있습니다)은 쓰지 않는다.',
    user:
      `지금 시각: ${nowLabel} / 시장 상태: ${phaseLabel} / 데이터 기준일: ${day}\n\n` +
      'FACTS:\n' +
      JSON.stringify(factsForPrompt) +
      '\n\n위 FACTS만 근거로 세 묶음을 써라.\n' +
      '- market: 1) 시장 지수 & 수급 요약 — 지수·선물·환율·확정 수급을 2~4문장.\n' +
      '- themes: 2) 현재 주도 테마 & 거래대금 상위 핵심 종목 — 테마와 종목 흐름을 2~4문장(FACTS의 테마명·종목명만).\n' +
      '- checkpoints: 3) 지금 시간대 체크포인트 / 대응 유의사항 — 지금 이 시간대에 확인할 것과 대응 원칙 2~4문장.\n' +
      `- ${phaseLabel}이면 첫 문장에서 "${day} 마감 실측 기준"임을 밝혀라.\n` +
      '- FACTS에 없는 것은 쓰지 말고, 모르면 그 문장을 빼라.',
    temperature: 0.25,
    maxTokens: 1500,
    schema: {
      type: 'object',
      properties: {
        headline: { type: 'string' },
        market: { type: 'array', items: { type: 'string' } },
        themes: { type: 'array', items: { type: 'string' } },
        checkpoints: { type: 'array', items: { type: 'string' } },
      },
      required: ['market', 'themes', 'checkpoints'],
    },
  };
}

/* ======================================================================
   🧠 종목 1초 해석 — 체커가 보낸 '실측 사실만' 으로 왜 오르고/빠졌는지 2~3줄
   ----------------------------------------------------------------------
   · POST { action:'stock_insight', facts:{ 종목, 테마, 뉴스, 미장, 공시, 경보, 상태 } }
   · Gemini 가 죽거나 키가 없어도 200 + source:'rule' 로 실측 조립 요약을 돌려준다.
   · FACTS 에 없는 숫자를 담은 AI 문장은 버린다(lbAllowedNumbers/lbFilterLines 재사용).
     → 없는 공시·뉴스·수치를 지어내지 않는다.
   ====================================================================== */

const SI_DEADLINE_MS = 22000;
const SI_MAX_LINES = 4;

function siStr(v, max) {
  const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max || 120) : null;
}

function siNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,\s%원]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function siSanitizeFacts(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const st = f['종목'] && typeof f['종목'] === 'object' ? f['종목'] : {};
  const th = f['테마'] && typeof f['테마'] === 'object' ? f['테마'] : {};
  const mk = f['미장'] && typeof f['미장'] === 'object' ? f['미장'] : {};
  const dc = f['공시'] && typeof f['공시'] === 'object' ? f['공시'] : {};
  const al = f['경보'] && typeof f['경보'] === 'object' ? f['경보'] : {};
  const list = (v, n) => (Array.isArray(v) ? v : []).slice(0, n || 4);
  return {
    종목: {
      이름: siStr(st['이름'], 30),
      코드: siStr(st['코드'], 10),
      현재가: siNum(st['현재가']),
      등락률: siNum(st['등락률']),
      시가: siNum(st['시가']),
      고가: siNum(st['고가']),
      저가: siNum(st['저가']),
      시가대비: siNum(st['시가대비']),
      고가대비: siNum(st['고가대비']),
      거래대금억: siNum(st['거래대금억']),
      거래대금체급: siStr(st['거래대금체급'], 12),
      위치52주: siNum(st['위치52주']),
      최고52주: siNum(st['최고52주']),
      최저52주: siNum(st['최저52주']),
      시장상태: siStr(st['시장상태'], 12),
      기준일: siStr(st['기준일'], 20),
    },
    테마: {
      대표: siStr(th['대표'], 40),
      순위: siNum(th['순위']),
      전체: siNum(th['전체']),
      평균등락률: siNum(th['평균등락률']),
      상위4평균: siNum(th['상위4평균']),
      신호: siStr(th['신호'], 30),
      상위4: list(th['상위4'], 4)
        .map((x) => ({ 이름: siStr(x && x['이름'], 24), 등락률: siNum(x && x['등락률']) }))
        .filter((x) => x['이름']),
    },
    뉴스: list(f['뉴스'], 3)
      .map((x) => ({ 제목: siStr(x && x['제목'], 60), 언론사: siStr(x && x['언론사'], 20), 시각: siStr(x && x['시각'], 16) }))
      .filter((x) => x['제목']),
    미장: {
      지수: list(mk['지수'], 4).map((x) => ({ 이름: siStr(x && x['이름'], 20), 등락률: siNum(x && x['등락률']) })).filter((x) => x['이름']),
      선물: list(mk['선물'], 4).map((x) => ({ 이름: siStr(x && x['이름'], 20), 등락률: siNum(x && x['등락률']) })).filter((x) => x['이름']),
      매크로: list(mk['매크로'], 4).map((x) => ({ 이름: siStr(x && x['이름'], 20), 등락률: siNum(x && x['등락률']) })).filter((x) => x['이름']),
      환율: mk['환율'] && typeof mk['환율'] === 'object'
        ? { 이름: siStr(mk['환율']['이름'], 16), 등락률: siNum(mk['환율']['등락률']) }
        : null,
    },
    공시: {
      신호: siStr(dc['신호'], 30),
      위험건수: siNum(dc['위험건수']),
      최근: list(dc['최근'], 3).map((x) => ({ 공시명: siStr(x && x['공시명'], 60), 접수일: siStr(x && x['접수일'], 12) })).filter((x) => x['공시명']),
      조회기간일: siNum(dc['조회기간일']),
    },
    경보: {
      지정: siStr(al['지정'], 16),
      거래정지: al['거래정지'] === true ? true : al['거래정지'] === false ? false : null,
    },
    특징주: list(f['특징주'], 4)
      .map((x) => ({
        날짜: siStr(x && x['날짜'], 10),
        제목: siStr(x && x['제목'], 70),
        등락률: siNum(x && x['등락률']),
        거래대금억: siNum(x && x['거래대금억']),
        현재대비: siNum(x && x['현재대비']),
      }))
      .filter((x) => x['제목']),
    과거파동: list(f['과거파동'], 2)
      .map((x) => ({
        시작: siStr(x && x['시작'], 10),
        고점: siStr(x && x['고점'], 10),
        상승률: siNum(x && x['상승률']),
        최대거래대금억: siNum(x && x['최대거래대금억']),
        고점대비현재: siNum(x && x['고점대비현재']),
      }))
      .filter((x) => x['고점']),
    상태: siStr(f['상태'], 30),
  };
}

/** FACTS 만으로 만드는 규칙 요약 — AI 가 없거나 실패해도 빈 화면을 두지 않는다. */
function siRuleLines(f) {
  const s = f['종목'];
  const name = s['이름'] || '이 종목';
  const lines = [];
  const pct = s['등락률'];
  const parts = [];
  if (s['현재가'] != null) parts.push(lbFmt(s['현재가'], 0) + '원');
  if (pct != null) parts.push(lbPct(pct));
  if (s['시가대비'] != null) parts.push('시가 대비 ' + lbPct(s['시가대비']));
  if (s['거래대금억'] != null) parts.push('거래대금 ' + lbFmt(s['거래대금억'], 0) + '억');
  lines.push(name + ' ' + (parts.length ? parts.join(' · ') : '실측 시세를 받지 못했습니다'));

  /* 왜 — 미장·테마 방향을 '같은 방향/반대' 로만 사실 표기(인과 단정 없음) */
  const why = [];
  const sox = (f['미장']['매크로'] || []).find((x) => /SOX|반도체/.test(x['이름'] || ''));
  const nq = (f['미장']['선물'] || []).find((x) => /나스닥/.test(x['이름'] || ''));
  if (sox && sox['등락률'] != null && Math.abs(sox['등락률']) >= 1) why.push(sox['이름'] + ' ' + lbPct(sox['등락률']));
  if (nq && nq['등락률'] != null && Math.abs(nq['등락률']) >= 1) why.push(nq['이름'] + ' ' + lbPct(nq['등락률']));
  if (!why.length) {
    (f['미장']['지수'] || []).forEach((x) => {
      if (x['등락률'] != null) why.push(x['이름'] + ' ' + lbPct(x['등락률']));
    });
  }
  const th = f['테마'];
  const themeBits = [];
  if (th['대표']) themeBits.push(th['대표'] + (th['상위4평균'] != null ? ' 상위4 평균 ' + lbPct(th['상위4평균']) : th['평균등락률'] != null ? ' 평균 ' + lbPct(th['평균등락률']) : ''));
  const same = pct != null && th['상위4평균'] != null ? (pct >= 0) === (th['상위4평균'] >= 0) : null;
  const whyLine = [why.length ? '미장 ' + why.slice(0, 2).join(' · ') : null, themeBits.length ? '소속 테마 ' + themeBits.join('') : null]
    .filter(Boolean)
    .join(' / ');
  if (whyLine) lines.push(whyLine + (same === true ? ' — 같은 방향' : same === false ? ' — 이 종목만 반대 방향' : '') + ' (사실 대조)' );

  /* 과거 이력 — [특징주] 재료일과 큰 파동을 '그때 대비 지금'으로만 사실 표기 */
  const pastBits = [];
  const cat = (f['특징주'] || [])[0];
  if (cat && cat['제목']) {
    pastBits.push(
      '과거 [특징주] ' + (cat['날짜'] || '') + ' “' + cat['제목'] + '”' +
        (cat['등락률'] != null ? ' (그날 ' + lbPct(cat['등락률']) + ')' : ''),
    );
  }
  const wave = (f['과거파동'] || [])[0];
  if (wave && wave['고점대비현재'] != null) {
    pastBits.push(
      (wave['시작'] || '') + '~' + (wave['고점'] || '') + ' ' +
        (wave['상승률'] != null ? lbPct(wave['상승률']) + ' ' : '') +
        '파동 고점 대비 지금 ' + lbPct(wave['고점대비현재']),
    );
  }
  if (pastBits.length) lines.push(pastBits.join(' · ') + ' (과거 실측 대비)');

  const news = (f['뉴스'] || [])[0];
  const tail = [];
  if (news) tail.push('최근 재료: ' + news['제목']);
  const dc = f['공시'];
  if (dc['신호']) tail.push('공시 ' + dc['신호']);
  const al = f['경보'];
  if (al['거래정지'] === true) tail.push('거래정지 종목');
  else if (al['지정']) tail.push('KRX ' + al['지정'] + ' 지정');
  if (tail.length) lines.push(tail.join(' · '));
  return lines.slice(0, SI_MAX_LINES);
}

function siPrompt(f) {
  return {
    system:
      '너는 한국 주식시장을 짧게 해설하는 애널리스트다. 규칙: (1) 제공된 FACTS JSON 안의 수치·테마·뉴스·공시만 쓴다. ' +
      '(2) FACTS 에 없는 숫자·종목명·뉴스·공시·목표가·수급 주체를 절대 만들지 않는다. ' +
      '(3) 확인된 사실과 해석을 구분하고, 해석은 "~로 보입니다/~배경으로 볼 수 있습니다" 로만 쓴다. ' +
      '(4) 매수·매도 권유, 목표가, 수익 보장 표현을 쓰지 않는다. (5) 숫자는 FACTS 와 똑같이 쓰고(콤마·소수점 그대로, 등락률은 % 기호), ' +
      '"퍼센트"라는 단어는 쓰지 않는다. (6) 각 줄은 70자 이내의 짧은 한국어 문장으로 쓴다. (7) FACTS 가 비었거나 모르면 그 줄을 빼라. (8) FACTS 의 시장상태가 CLOSE 이거나 기준일이 오늘이 아니면 \'마감 기준\' 임을 밝히고, 진행 중인 것처럼 쓰지 않는다. (9) 뉴스는 \'~보도가 있었습니다\' 로만 적고, 그 기사가 주가 원인이라고 단정하지 않는다.',
    user:
      'FACTS:\n' +
      JSON.stringify(f) +
      '\n\n위 FACTS 만 근거로 아래 3줄을 써라(쓸 수 없는 줄은 빼고 2줄만 써도 된다).\n' +
      '· 1줄: 지금 이 종목이 어디에 있는지 — 가격·등락률·시가 위/아래·거래대금 중 FACTS 에 있는 값.\n' +
      '· 2줄: 왜 그렇게 움직였는지 — FACTS 의 미장(선물·SOX 등)·소속 테마 방향·최근 뉴스·공시 중에서 골라 연결. 인과를 단정하지 말고 "~여파로 보입니다/~와 같은 방향입니다" 로.\n' +
      '· 3줄: 지금 확인할 것 한 가지 — "확인:" 으로 시작해 FACTS 의 공시·경보·52주 위치·거래대금 중에서 하나만.\n' +
      '· 4줄(FACTS 의 특징주·과거파동이 있을 때만): 과거 어떤 재료([특징주] 제목)로 움직였고 그 뒤 파동이 어느 정도였는지, 그때 고점·재료일 대비 지금 주가 자리가 높은지 낮은지를 FACTS 수치로 비교하고, 지금 소속 테마·미장 방향에서 그 재료가 다시 먹힐 자리인지 관심도를 "~로 보입니다" 로만 적어라. 과거 재료를 지금 재료인 것처럼 쓰지 마라.',
    temperature: 0.3,
    maxTokens: 500,
    fastFirst: true,
    schema: {
      type: 'object',
      properties: {
        lines: { type: 'array', items: { type: 'string' } },
        tone: { type: 'string' },
      },
      required: ['lines'],
    },
  };
}

async function handleStockInsight(res, body, keyConfigured) {
  const p = lbKst(new Date());
  const nowLabel = `${p.y}-${lbPad(p.m)}-${lbPad(p.d)}(${LB_WEEKDAY_KO[p.wd] || ''}) ${lbPad(p.hh)}:${lbPad(p.mi)} KST`;
  const facts = siSanitizeFacts(body && body.facts);
  const ruleLines = siRuleLines(facts);
  const hasAny = !!(facts['종목']['이름'] || facts['종목']['현재가']);
  if (!hasAny) {
    return send(res, 200, {
      ok: false,
      action: 'stock_insight',
      reason: 'missing_facts',
      message: '실측 값이 비어 있어 해석을 만들지 않았습니다.',
      lines: [],
      keyConfigured,
      generatedAtKst: nowLabel,
    });
  }

  const base = {
    ok: true,
    action: 'stock_insight',
    code: facts['종목']['코드'] || null,
    name: facts['종목']['이름'] || null,
    generatedAtKst: nowLabel,
    keyConfigured,
    factsCoerced: facts,
  };

  if (!keyConfigured) {
    return send(res, 200, { ...base, source: 'rule', lines: ruleLines, note: 'Gemini 키가 없어 실측 값만으로 정리했습니다.' });
  }
  if (process.env.DISABLE_GEMINI === '1') {
    return send(res, 200, { ...base, source: 'rule', lines: ruleLines, note: 'Gemini 호출이 꺼져 있어 실측 값만으로 정리했습니다.' });
  }

  try {
    const out = await generate(siPrompt(facts), Date.now() + SI_DEADLINE_MS);
    const parsed = extractJson(out && out.text);
    const allowed = lbAllowedNumbers(facts);
    const filtered = parsed ? lbFilterLines(parsed.lines, allowed) : { kept: [], dropped: 0 };
    if (filtered.kept.length) {
      return send(res, 200, {
        ...base,
        source: 'ai',
        lines: filtered.kept.slice(0, SI_MAX_LINES),
        model: out.model || null,
        droppedLines: filtered.dropped,
        note: filtered.dropped ? `실측에 없는 수치를 담은 AI 문장 ${filtered.dropped}개는 제외했습니다.` : null,
        ruleLines,
      });
    }
    return send(res, 200, {
      ...base,
      source: 'rule',
      lines: ruleLines,
      model: out && out.model ? out.model : null,
      droppedLines: filtered.dropped,
      note: parsed ? 'AI 문장이 실측 수치와 맞지 않아 실측 값으로 정리했습니다.' : 'AI 응답 형식이 깨져 실측 값으로 정리했습니다.',
    });
  } catch (err) {
    const code = err && err.code;
    return send(res, 200, {
      ...base,
      source: 'rule',
      lines: ruleLines,
      note:
        code === 'quota_exceeded'
          ? 'Gemini 하루 한도를 다 써서 실측 값으로 정리했습니다.'
          : 'Gemini 응답이 지연·실패해 실측 값으로 정리했습니다(수치는 실측값).',
      aiError: { code: code || null, message: String((err && err.message) || err).slice(0, 200) },
    });
  }
}

async function handleLiveBriefing(res, body, keyConfigured) {
  const now = new Date();
  const p = lbKst(now);
  const nowLabel = `${p.y}-${lbPad(p.m)}-${lbPad(p.d)}(${LB_WEEKDAY_KO[p.wd] || ''}) ${lbPad(p.hh)}:${lbPad(p.mi)} KST`;
  const f = lbSanitizeFacts(body && body.facts);
  const { phase, label: phaseLabel } = lbPhaseOf(f, p);

  const haveAny = f.indices.length || f.futures.length || f.leaders.length || f.themes.length;
  if (!haveAny) {
    return send(res, 200, {
      ok: false,
      action: 'live_briefing',
      reason: 'missing_facts',
      message: '실측 데이터가 비어 있어 브리핑을 만들지 못했습니다. 잠시 뒤 🔄 지금 다시 생성 을 눌러 주세요.',
      generatedAtKst: nowLabel,
      keyConfigured,
    });
  }

  const header = `⚡ ${p.y}-${lbPad(p.m)}-${lbPad(p.d)} ${lbPad(p.hh)}:${lbPad(p.mi)} 기준 실시간 시황 브리핑`;
  const basisLine = lbBasisLine(f, phase);
  const marketRows = lbBuildRows(f);
  const themeLines = lbThemeLines(f);
  const leaderRows = lbLeaderRows(f);
  const phaseLines = lbCheckpointPhase(f, phase, phaseLabel, p);
  const factLines = lbCheckpointFacts(f, phase, phaseLabel, p);

  const sources = [];
  if (f.indices.length) sources.push('네이버 금융 지수·종목');
  if (f.futures.length) sources.push('Yahoo 해외선물');
  if (f.fx) sources.push('원/달러');
  if (f.themes.length) sources.push('네이버 테마 랭킹');
  if (f.supply && (f.supply.foreignBuy.length || f.supply.organBuy.length)) sources.push('거래소 확정 수급');
  const sourcesLine = sources.length ? '실측 출처: ' + sources.join(' · ') : null;

  let aiLines = null;
  let aiMeta = { used: false, model: null, note: null, droppedLines: 0 };
  if (!keyConfigured) {
    aiMeta.note = 'Gemini 키가 없어 실측 수치만으로 조립한 요약입니다.';
  } else if (process.env.DISABLE_GEMINI === '1') {
    aiMeta.note = '이 환경에서 Gemini 호출이 꺼져 있어 실측 조립 요약으로 답했습니다.';
  } else {
    try {
      const out = await generate(lbPrompt(f, phaseLabel, p, nowLabel), Date.now() + LB_DEADLINE_MS);
      const parsed = extractJson(out && out.text);
      if (parsed) {
        const allowed = lbAllowedNumbers(f);
        const m = lbFilterLines(parsed.market, allowed);
        const t = lbFilterLines(parsed.themes, allowed);
        const cpRaw = (Array.isArray(parsed.checkpoints) ? parsed.checkpoints : []).filter((x) => lbNumbersInLine(s(x, 400)).length > 0);
        const c = lbFilterLines(cpRaw, allowed);
        const dropped = m.dropped + t.dropped + c.dropped;
        if (m.kept.length || t.kept.length || c.kept.length) {
          aiLines = { market: m.kept, themes: t.kept, checkpoints: c.kept };
          aiMeta = {
            used: true,
            model: out.model,
            note: dropped ? `실측에 없는 수치를 담은 AI 문장 ${dropped}개는 제외했습니다.` : null,
            droppedLines: dropped,
          };
        } else {
          aiMeta.note = 'AI 문장이 실측 수치와 맞지 않아 실측 조립 요약으로 답했습니다.';
        }
      } else {
        aiMeta.note = 'AI 응답 형식이 깨져 실측 조립 요약으로 답했습니다.';
      }
    } catch (err) {
      aiMeta.note =
        (err && err.code) === 'quota_exceeded'
          ? 'Gemini 하루 한도를 다 써서 실측 조립 요약으로 답했습니다.'
          : 'Gemini 응답이 지연·실패해 실측 조립 요약으로 답했습니다(수치는 실측값).';
    }
  }

  const aiHasMarket = !!(aiLines && aiLines.market.length);
  const aiHasThemes = !!(aiLines && aiLines.themes.length);
  const aiHasCheck = !!(aiLines && aiLines.checkpoints.length);
  const supplyLines = lbSupplyLines(f, aiHasMarket ? 3 : 4);
  const secMarket = {
    key: 'market',
    title: '1) 시장 지수 & 수급 요약',
    rows: marketRows,
    lines: aiHasMarket ? aiLines.market.concat(supplyLines) : supplyLines,
  };
  const secThemes = {
    key: 'themes',
    title: '2) 현재 주도 테마 & 거래대금 상위 핵심 종목',
    themes: f.themes.slice(0, 4).map((t) => ({
      rank: t.rank,
      name: t.name,
      avgPct: lbPct(t.avgPct),
      rise: t.riseCount,
      fall: t.fallCount,
      top4Text: t.top4Sum !== null ? lbEokPlainFromKrw(t.top4Sum) : null,
      tone: lbTone(t.avgPct),
    })),
    leaders: leaderRows,
    lines: aiHasThemes ? aiLines.themes.concat(themeLines.slice(0, 1)) : themeLines,
  };
  const secCheck = {
    key: 'checkpoints',
    title: '3) 지금 시간대 체크포인트 / 대응 유의사항',
    lines: aiHasCheck ? aiLines.checkpoints.slice(0, 3).concat(factLines.slice(0, 6)) : phaseLines.concat(factLines),
  };

  return send(res, 200, {
    ok: true,
    action: 'live_briefing',
    header,
    generatedAtKst: nowLabel,
    phase,
    phaseLabel,
    basisLine,
    headline: f.headline || null,
    tradingDate: f.tradingDate || null,
    tradingDateLabel: f.tradingDateLabel || null,
    sections: [secMarket, secThemes, secCheck],
    notes: f.notes.slice(0, 4),
    news: f.news.slice(0, 4),
    sourcesLine,
    ai: aiMeta,
    keyConfigured,
    elapsedMs: Date.now() - now.getTime(),
  });
}

/* ====================== 🔋 이차전지 논문 리서치 (battery_research) ======================
 * POST /api/content-ai  { action:'battery_research', q:'질문', notes?:'대백과 발췌', lite?:true }
 *
 *   사용자(이차전지 셀 개발·음극/극판 R&D)의 질문에 대해
 *     1) OpenAlex(실패 시 CrossRef)에서 **실제로 존재하는 논문 메타데이터**(제목·저자·저널·연도·DOI·초록)를 받아오고
 *     2) 그 논문들과 사용자의 「이차전지 실무 대백과」 발췌(notes) 안에서만 Gemini 가 해석을 쓴다.
 *   원칙
 *     - 논문·DOI·수치는 받아온 메타데이터에 있는 것만 쓴다. 없으면 '찾지 못함'으로 남긴다(지어내지 않는다).
 *     - Gemini 키가 없거나 실패해도 논문 목록은 200 으로 돌려준다(빈 화면 금지).
 *     - lite:true 는 Gemini 없이 논문 목록만(카드 첫 화면용).
 */

const BR_MAX_PAPERS = 5;
const BR_HTTP_TIMEOUT_MS = 9000;
const BR_AI_DEADLINE_MS = 32000;
const BR_UA = 'yeonolang-office/1.0 (battery research helper; +https://github.com/hwen21c-tech)';
const BR_MAILTO = 'hwen21c@gmail.com';

/* 한국어 질문 → OpenAlex/CrossRef 검색어(영문). 사전에 없는 말은 영문 낱말만 그대로 쓴다. */
const BR_TERMS = [
  [['dq/dv', 'dqdv', '디큐디브이', '미분용량', '미분 용량', 'ica', 'dva'], 'differential capacity dQ/dV'],
  [['sei', '에스이아이', '고체전해질계면', '계면막', 'cei'], 'solid electrolyte interphase SEI'],
  [['실리콘', 'siox', '규소'], 'silicon anode'],
  [['음극'], 'anode'],
  [['양극'], 'cathode'],
  [['팽창', '부피팽창'], 'volume expansion'],
  [['열화', '퇴화', '수명저하', '노화'], 'capacity fading degradation'],
  [['석출', '리튬석출', '덴드라이트', '플레이팅'], 'lithium plating'],
  [['전고체', '고체전해질'], 'solid-state electrolyte'],
  [['전해액', '액체전해질', '첨가제'], 'electrolyte additive'],
  [['극판', '전극판', '합제'], 'electrode'],
  [['압연', '캘린더', '합제밀도'], 'calendering electrode density'],
  [['바인더', '접착력', '필테스트'], 'binder adhesion'],
  [['도전재', 'cnt', '탄소나노튜브'], 'conductive carbon additive'],
  [['니켈', '하이니켈', 'ncm', 'ncma', '양극재'], 'Ni-rich NCM cathode'],
  [['lfp', '인산철'], 'LFP cathode'],
  [['흑연'], 'graphite anode'],
  [['코인셀', '코인 셀', '하프셀'], 'coin cell half cell'],
  [['파우치'], 'pouch cell'],
  [['충방전', '사이클', '수명'], 'cycling performance'],
  [['에너지밀도'], 'energy density'],
  [['급속충전', '고속충전'], 'fast charging'],
  [['열폭주'], 'thermal runaway'],
  [['n/p', 'n/p비', '로딩'], 'N/P ratio electrode loading'],
  [['집전체', '구리박', '포일'], 'current collector'],
  [['슬러리', '분산', '점도'], 'electrode slurry dispersion'],
  [['수분', 'kf'], 'moisture'],
  [['공극', '기공', 'porosity'], 'electrode porosity'],
  [['eis', '임피던스', '저항'], 'electrochemical impedance spectroscopy'],
  [['저온'], 'low temperature performance'],
  [['열안정', 'dsc', 'arc'], 'thermal stability'],
];

const BR_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: '한 줄 결론 (40자 내외)' },
    principle: { type: 'array', description: '핵심 원리 2~4줄 — 전기화학·소재 원리', items: { type: 'string' } },
    practice: { type: 'array', description: '실무 해석·확인 포인트 2~4줄 (셀 개발·극판 공정 관점)', items: { type: 'string' } },
    paperNotes: {
      type: 'array',
      description: '받아온 논문별 한 줄 요약 — DOI 는 목록에 있는 값 그대로',
      items: {
        type: 'object',
        properties: {
          doi: { type: 'string', description: '논문 목록의 DOI (https://doi.org/…)' },
          line: { type: 'string', description: '이 논문이 말하는 바 한 줄 (60자 내외)' },
        },
        required: ['doi', 'line'],
      },
    },
    cautions: { type: 'array', description: '확인하지 못한 것·주의 (없으면 빈 배열)', items: { type: 'string' } },
  },
  required: ['headline'],
};

function brQueryEn(q) {
  const low = String(q || '').toLowerCase();
  const out = [];
  BR_TERMS.forEach((row) => {
    const keys = row[0];
    const en = row[1];
    let hit = false;
    for (let i = 0; i < keys.length; i++) if (low.indexOf(keys[i]) >= 0) { hit = true; break; }
    if (hit && out.indexOf(en) < 0) out.push(en);
  });
  const core = out.slice(0, 5).join(' ').trim();
  // 사전에 이미 들어 있는 영문 낱말(dqdv·sei 같은 표기)은 빼고, 질문에만 있는 고유명사·약어만 보탠다.
  const wordOut = [];
  (String(q || '').match(/[A-Za-z][A-Za-z0-9\-\/]{2,}/g) || []).slice(0, 4).forEach((w) => {
    const lw = w.toLowerCase();
    if (out.join(' ').toLowerCase().indexOf(lw) >= 0) return;
    if (BR_TERMS.some((row) => row[0].indexOf(lw) >= 0)) return;
    if (wordOut.indexOf(w) >= 0) return;
    wordOut.push(w);
  });
  const all = (core + ' ' + wordOut.join(' ')).trim();
  return {
    core: core || 'lithium-ion battery electrode',
    all: all || 'lithium-ion battery electrode',
  };
}

async function brFetchJson(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, BR_HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': BR_UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

function brAbstract(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const arr = [];
  Object.keys(inv).forEach((w) => {
    const ps = inv[w] || [];
    for (let i = 0; i < ps.length; i++) if (ps[i] >= 0 && ps[i] < 4000) arr[ps[i]] = w;
  });
  return arr.filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 900);
}

function brCleanPaper(p) {
  const title = s(p && p.title, 300).replace(/\s+/g, ' ');
  if (!title) return null;
  const doi = s(p.doi, 300);
  return {
    title,
    year: Number(p.year) || null,
    journal: s(p.journal, 140) || null,
    authors: (Array.isArray(p.authors) ? p.authors : []).map((a) => s(a, 60)).filter(Boolean).slice(0, 3),
    doi: /^https?:\/\/doi\.org\//.test(doi) ? doi : doi ? 'https://doi.org/' + doi.replace(/^doi:\s*/i, '') : null,
    cited: Number(p.cited) || 0,
    abstract: s(p.abstract, 900) || null,
  };
}

async function brOpenAlex(qEn, qCore) {
  const from = new Date(Date.now() - 4 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const sel = '&per-page=14&select=doi,display_name,publication_year,primary_location,authorships,cited_by_count,abstract_inverted_index&mailto=' + encodeURIComponent(BR_MAILTO);
  const common = ',type:article|review,from_publication_date:' + from;
  const map = (list) => (list || []).map((w) => {
    const src = (w.primary_location && w.primary_location.source) || {};
    return brCleanPaper({
      title: w.display_name,
      year: w.publication_year,
      journal: src.display_name,
      authors: (w.authorships || []).map((a) => (a && a.author && a.author.display_name) || ''),
      doi: w.doi,
      cited: w.cited_by_count,
      abstract: brAbstract(w.abstract_inverted_index),
    });
  }).filter(Boolean);
  const taa = async (q) => map(((await brFetchJson(
    'https://api.openalex.org/works?filter=' +
      encodeURIComponent('title_and_abstract.search:' + q + common) + sel
  )) || {}).results);

  // 1) 제목·초록 검색(관련도가 훨씬 정확) — 질문 전체 → 핵심어 순으로 좁혀 본다.
  let out = [];
  try { out = await taa(qEn); } catch (e) { /* 아래 단계로 */ }
  if (out.length < 3 && qCore && qCore !== qEn) {
    try { out = out.concat(await taa(qCore)); } catch (e) { /* 아래 단계로 */ }
  }
  // 2) 그래도 적으면 전체 텍스트 검색으로 넓힌다(중복은 brRank 에서 제거).
  if (out.length < 3) {
    try {
      const broad = await brFetchJson(
        'https://api.openalex.org/works?search=' + encodeURIComponent(qEn) +
        '&filter=' + encodeURIComponent('type:article|review,from_publication_date:' + from) + sel
      );
      out = out.concat(map((broad || {}).results));
    } catch (e) { /* 좁은 결과만 쓴다 */ }
  }
  return out;
}
async function brCrossref(q) {
  const url =
    'https://api.crossref.org/works?query=' +
    encodeURIComponent(q) +
    '&rows=10&sort=relevance&select=DOI,title,author,container-title,issued,abstract,is-referenced-by-count,type';
  const j = await brFetchJson(url);
  const items = (j && j.message && j.message.items) || [];
  return items
    .map((it) => {
      const dp = (it.issued && it.issued['date-parts'] && it.issued['date-parts'][0]) || [];
      return brCleanPaper({
        title: (it.title || [])[0],
        year: dp[0],
        journal: (it['container-title'] || [])[0],
        authors: (it.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')),
        doi: it.DOI,
        cited: it['is-referenced-by-count'],
        abstract: String(it.abstract || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '),
      });
    })
    .filter(Boolean);
}

/* 검색 API 의 '관련도' 상위 8편 안에서 최신순으로 5편을 고른다(관련도와 최신성의 균형).
 *  중복(같은 DOI·제목)은 먼저 제거한다. */
function brRank(list) {
  const seen = {};
  const uniq = [];
  (list || []).forEach((p) => {
    const key = (p.doi || p.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen[key]) return;
    seen[key] = 1;
    uniq.push(p);
  });
  const shortlist = uniq.slice(0, 8);
  shortlist.sort((a, b) => {
    if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0);
    const aa = a.abstract ? 1 : 0;
    const ba = b.abstract ? 1 : 0;
    if (ba !== aa) return ba - aa;
    return (b.cited || 0) - (a.cited || 0);
  });
  return shortlist.slice(0, BR_MAX_PAPERS);
}

function brPrompt(q, notes, papers) {
  const meta = papers.map((p, i) => ({
    n: i + 1,
    title: p.title,
    year: p.year,
    journal: p.journal,
    authors: p.authors,
    doi: p.doi,
    cited: p.cited,
    abstract: p.abstract ? p.abstract.slice(0, 700) : null,
  }));
  const noteBlock = s(notes, 2600);
  return {
    system:
      '너는 이차전지 셀 개발·전극(음극·극판) 연구자를 돕는 배터리 리서치 어시스턴트다. 규칙: ' +
      '(1) 아래 [논문 목록]은 OpenAlex/CrossRef에서 방금 받아온 실제 논문 메타데이터다. 논문의 주장·수치는 이 목록에 적힌 것만 인용하고, ' +
      '목록에 없는 논문·저자·DOI·수치를 절대 만들지 않는다. (2) [대백과 발췌]는 사용자가 직접 정리한 사내 실무 기준이다. 충돌하면 대백과를 우선하고, ' +
      '논문이 대백과와 다르면 그 차이를 밝힌다. (3) 일반 전기화학·소재 원리 설명은 네 지식으로 보강해도 되지만, 논문 근거인 것처럼 쓰지 않는다. ' +
      '(4) 투자·주가·매매 이야기는 하지 않는다. (5) 한국어로, 현장에서 바로 쓸 수 있는 말로 쓴다. (6) 모르는 것은 cautions 에 적는다.',
    user:
      '[질문]\n' + s(q, 400) +
      '\n\n[논문 목록 — 실제 API 응답]\n' + JSON.stringify(meta) +
      (noteBlock ? '\n\n[대백과 발췌]\n' + noteBlock : '') +
      '\n\n위 자료로 답해라.\n' +
      '· headline: 질문에 대한 한 줄 결론.\n' +
      '· principle: 핵심 원리 2~4줄 (왜 그렇게 되는지).\n' +
      '· practice: 실무 해석 2~4줄 — 셀 설계·극판 공정·측정에서 무엇을 확인할지.\n' +
      '· paperNotes: 목록의 논문마다 doi 를 그대로 쓰고 한 줄 요약. 목록에 없는 doi 는 쓰지 마라.\n' +
      '· cautions: 근거가 약한 부분·추가로 확인할 것.' +
      (papers.length ? '' : '\n· 논문 목록이 비었다 — "관련 논문을 찾지 못했습니다"를 headline 이나 cautions 에 정확히 적고, 원리·실무만 답해라.'),
    temperature: 0.25,
    maxTokens: 1600,
    schema: BR_SCHEMA,
  };
}

async function handleBatteryResearch(res, body, keyConfigured) {
  const q = s(body && body.q, 400);
  if (!q) {
    return send(res, 400, { ok: false, reason: 'missing_query', message: '질문(q)이 필요합니다.' });
  }
  const lite = !!(body && body.lite);
  const qq = brQueryEn(q);
  const qEn = qq.all, qCore = qq.core;
  const now = new Date();
  const p = lbKst(now);
  const nowLabel = `${p.y}-${lbPad(p.m)}-${lbPad(p.d)}(${LB_WEEKDAY_KO[p.wd] || ''}) ${lbPad(p.hh)}:${lbPad(p.mi)} KST`;

  let papers = [];
  let source = null;
  const errors = [];
  try {
    papers = await brOpenAlex(qEn, qCore);
    if (papers.length) source = 'openalex';
  } catch (err) {
    errors.push({ source: 'openalex', message: String((err && err.message) || err).slice(0, 160) });
  }
  if (!papers.length) {
    try {
      papers = await brCrossref(qEn);
      if (papers.length) source = 'crossref';
    } catch (err) {
      errors.push({ source: 'crossref', message: String((err && err.message) || err).slice(0, 160) });
    }
  }
  papers = brRank(papers);

  const base = {
    ok: true,
    action: 'battery_research',
    query: q,
    queryEn: qEn,
    queryCore: qCore,
    source,
    papers,
    generatedAtKst: nowLabel,
    keyConfigured,
    errors,
  };

  if (lite) {
    return send(res, 200, { ...base, answer: null, ai: { used: false, model: null, note: '논문 목록만 조회(lite)' } });
  }

  if (!keyConfigured || process.env.DISABLE_GEMINI === '1' || !papers.length) {
    return send(res, 200, {
      ...base,
      answer: null,
      ai: {
        used: false,
        model: null,
        note: !keyConfigured
          ? 'Gemini 키가 없어 논문 목록만 보여 줍니다.'
          : !papers.length
            ? '관련 논문을 찾지 못해 논문 해석은 만들지 않았습니다.'
            : 'Gemini 호출이 꺼져 있어 논문 목록만 보여 줍니다.',
      },
    });
  }

  try {
    const out = await generate(brPrompt(q, body && body.notes, papers), Date.now() + BR_AI_DEADLINE_MS);
    const parsed = extractJson(out && out.text);
    if (!parsed || !s(parsed.headline, 300)) {
      return send(res, 200, {
        ...base,
        answer: null,
        model: out && out.model,
        ai: { used: false, model: out && out.model, note: 'AI 응답 형식이 깨져 논문 목록만 보여 줍니다.' },
      });
    }
    const allowDoi = {};
    papers.forEach((x) => { if (x.doi) allowDoi[x.doi.toLowerCase()] = x.doi; });
    const notes = arr(parsed.paperNotes, 8)
      .map((x) => ({ doi: s(x && x.doi, 300), line: s(x && x.line, 240) }))
      .filter((x) => x.line && allowDoi[x.doi.toLowerCase()] || (x.line && !x.doi))
      .map((x) => ({ doi: allowDoi[x.doi.toLowerCase()] || null, line: x.line }));
    const answer = {
      headline: s(parsed.headline, 300),
      principle: arr(parsed.principle, 6).map((x) => s(x, 300)).filter(Boolean),
      practice: arr(parsed.practice, 6).map((x) => s(x, 300)).filter(Boolean),
      paperNotes: notes,
      cautions: arr(parsed.cautions, 6).map((x) => s(x, 300)).filter(Boolean),
    };
    return send(res, 200, {
      ...base,
      answer,
      model: out.model || null,
      ai: { used: true, model: out.model || null, note: null },
      elapsedMs: Date.now() - now.getTime(),
    });
  } catch (err) {
    const code = err && err.code;
    return send(res, 200, {
      ...base,
      answer: null,
      ai: {
        used: false,
        model: null,
        note:
          code === 'quota_exceeded'
            ? 'Gemini 하루 한도를 다 써서 논문 목록만 보여 줍니다.'
            : 'Gemini 응답이 지연·실패해 논문 목록만 보여 줍니다.',
      },
      aiError: { code: code || null, message: String((err && err.message) || err).slice(0, 200) },
    });
  }
}

/* ---------------------------------------------------------------- 🎬 쇼츠 전용 편집기 (shorts-editor.html)
 *
 * POST /api/content-ai { action:'shorts_analyze', tone, hint, clips:[{name,duration,width,height,frames:[{tSec,data}]}] }
 *   → { ok, model, data:{ storyArc{hook,climax,outro}, youtubeTitle, youtubeDescription, bgmMood,
 *                         segments:[{clipIndex,startSec,durationSec,speed,cropFocus,narration,subtitle}] } }
 * POST /api/content-ai { action:'shorts_rewrite', narration, subtitle, tone }
 *   → { ok, data:{ narration, subtitle } }
 * POST /api/content-ai { action:'shorts_tts', text, voiceId?, key? }
 *   → { ok, audio(base64), mime, alignment{characters[],character_start_times_seconds[],character_end_times_seconds[]} }
 *      ElevenLabs 키(서버 환경변수 ELEVENLABS_API_KEY 또는 요청의 key)가 없으면 ok:false + reason:'no_eleven_key'
 *      → 클라이언트는 /api/tts(무료 Edge 성우)로 폴백한다.
 */

const SHORTS_MAX_IMAGES = 15;
const SHORTS_MAX_ONE_B64 = 900 * 1024;      // 키프레임 1장(약 640KB JPEG → base64 870KB)
const SHORTS_MAX_TOTAL_B64 = 3300 * 1024;   // 요청 본문 한도(4.2MB) 안쪽
const SHORTS_BGMS = ['upbeat', 'chill', 'tense', 'none'];
const SHORTS_TONES = {
  energetic: '유쾌한 예능·후킹 (빠른 템포, 감탄사 활용)',
  vlog: '감성 브이로그 (차분하고 따뜻한 구어체)',
  info: '빠른 정보 요약 (숫자·포인트 먼저)',
  dramatic: '반전·긴장감 (짧은 문장, 궁금증 유발)',
};

const SHORTS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    storyArc: {
      type: 'OBJECT',
      properties: {
        hook: { type: 'STRING' },
        climax: { type: 'STRING' },
        outro: { type: 'STRING' },
      },
      required: ['hook', 'climax', 'outro'],
    },
    youtubeTitle: { type: 'STRING' },
    youtubeDescription: { type: 'STRING' },
    bgmMood: { type: 'STRING', enum: SHORTS_BGMS },
    hookOptions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ['curiosity', 'direct', 'twist'] },
          text: { type: 'STRING' },
        },
        required: ['type', 'text'],
      },
    },
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          clipIndex: { type: 'INTEGER' },
          startSec: { type: 'NUMBER' },
          durationSec: { type: 'NUMBER' },
          speed: { type: 'NUMBER' },
          cropFocus: { type: 'STRING', enum: ['center', 'left', 'right'] },
          narration: { type: 'STRING' },
          subtitle: { type: 'STRING' },
        },
        required: ['clipIndex', 'startSec', 'durationSec', 'speed', 'cropFocus', 'narration', 'subtitle'],
      },
    },
  },
  required: ['storyArc', 'youtubeTitle', 'youtubeDescription', 'bgmMood', 'segments'],
};

function shortsClipLines(body) {
  const clips = arr(body.clips, 5);
  const images = [];
  const lines = [];
  let totalB64 = 0;
  let dropped = 0;
  clips.forEach((c, i) => {
    const frames = arr(c && c.frames, 6);
    lines.push(
      'Clip ' + i + ': 파일명="' + s(c && c.name, 80) + '", 길이=' + round1(num(c && c.duration, 0)) +
      '초, 해상도=' + Math.trunc(num(c && c.width, 1080)) + 'x' + Math.trunc(num(c && c.height, 1920)) +
      ', 키프레임 ' + frames.length + '장'
    );
    frames.forEach((f) => {
      const d = s(f && f.data, SHORTS_MAX_ONE_B64 + 1);
      if (!d) return;
      if (d.length > SHORTS_MAX_ONE_B64 || images.length >= SHORTS_MAX_IMAGES || totalB64 + d.length > SHORTS_MAX_TOTAL_B64) {
        dropped += 1;
        return;
      }
      totalB64 += d.length;
      images.push({ mimeType: 'image/jpeg', data: d });
      lines.push('  · 이미지 #' + images.length + ' = Clip ' + i + ' @ ' + round1(num(f && f.tSec, 0)) + '초');
    });
  });
  return { clips: clips, images: images, lines: lines, dropped: dropped };
}

/* 후킹 3안 정규화 — 모델이 타입을 한글로 주든 영어로 주든 curiosity/direct/twist 로 맞춘다. */
function normalizeHookOptions(list, fallbackHook) {
  const pick = (raw) => {
    const v = String(raw || '').toLowerCase();
    if (v.indexOf('호기심') >= 0 || v.indexOf('curio') >= 0) return 'curiosity';
    if (v.indexOf('반전') >= 0 || v.indexOf('twist') >= 0) return 'twist';
    if (v.indexOf('직설') >= 0 || v.indexOf('direct') >= 0) return 'direct';
    return '';
  };
  const out = [];
  (Array.isArray(list) ? list : []).forEach((o) => {
    const text = s(o && (o.text || o.hook || o.line || o.title), 40);
    if (!text) return;
    const type = pick(o && (o.type || o.kind || o.label)) || (out.length === 0 ? 'curiosity' : out.length === 1 ? 'direct' : 'twist');
    if (out.some((x) => x.text === text)) return;
    out.push({ type, text });
  });
  if (!out.length && fallbackHook) {
    const h = s(fallbackHook, 40);
    if (h) out.push({ type: 'direct', text: h });
  }
  return out.slice(0, 3);
}

async function handleShortsAnalyze(res, body, keyConfigured) {
  if (!keyConfigured) return send(res, 503, noKeyBody());
  const pack = shortsClipLines(body);
  if (!pack.clips.length) {
    return send(res, 400, {
      ok: false,
      reason: 'no_clips',
      message: '분석할 클립이 없습니다. 동영상을 올리거나 데모 체험을 먼저 불러와 주세요.',
    });
  }
  const toneKey = s(body.tone, 30) || 'energetic';
  const tone = SHORTS_TONES[toneKey] || SHORTS_TONES.energetic;
  const hint = s(body.hint, 400);
  const n = pack.clips.length;

  const user = [
    '아래 ' + n + '개 클립의 정보' + (pack.images.length ? '와 키프레임 이미지' : '') + '를 분석해서 15~45초 유튜브 쇼츠 편집 타임라인과 업로드 메타데이터를 만들어 주세요.',
    '',
    '[클립 목록]',
    pack.lines.join('\n'),
    '',
    '[원하는 톤] ' + tone,
    '[사용자 방향] ' + (hint || '초반 3초 후킹이 강하고 자연스럽게 이어지는 스토리'),
    '',
    '[규칙]',
    '1. clipIndex 는 0 ~ ' + (n - 1) + ' 사이의 정수. 실제로 없는 클립 번호를 쓰지 마세요.',
    '2. startSec 은 그 클립 길이 안쪽, durationSec 은 1.5~5.0초, speed 는 1.0~1.3 사이.',
    '3. cropFocus 는 화면에서 중요한 피사체 위치 — center / left / right 중 하나.',
    '4. narration 은 성우가 3~4초에 읽을 자연스러운 한국어 구어체 한 문장(20자 안팎).',
    '5. subtitle 은 14자 이내 임팩트 자막. 같은 문장을 그대로 옮기지 말고 핵심만 남기세요.',
    '6. 첫 컷은 3초 안에 멈추게 하는 후킹, 마지막 컷은 저장·팔로우를 부르는 마무리.',
    '7. youtubeTitle 은 40자 안팎의 클릭을 부르는 제목, youtubeDescription 은 2~3줄 요약 + 해시태그 5개.',
    '8. bgmMood 는 upbeat / chill / tense / none 중 하나. 영상 분위기에 맞게.',
    '9. hookOptions 는 화면 상단에 띄울 후킹 문구 3안 — type 은 curiosity(호기심형) / direct(직설형) / twist(반전형), ' +
      'text 는 24자 이내 한 줄. 서로 말투가 확실히 달라야 하고, 같은 문장을 복사하지 마세요.',
    '10. 화면에 실제로 보이는 것만 근거로 쓰세요. 확인되지 않은 가게 이름·가격·수치를 지어내지 마세요.',
    '11. 마지막에 JSON 만 돌려주세요.',
  ].join('\n');

  const deadline = Date.now() + DEADLINE_MS;
  try {
    const out = await generate(
      {
        system:
          '당신은 조회수 높은 유튜브 쇼츠 전문 PD입니다. 주어진 클립·키프레임만 근거로 편집 타임라인을 설계하고, ' +
          '보이지 않는 사실은 만들지 않습니다. 대사는 사람이 실제로 말하듯 짧고 자연스러운 한국어 구어체로 씁니다.',
        user: user,
        schema: SHORTS_SCHEMA,
        temperature: 0.75,
        maxTokens: 2600,
        images: pack.images,
        maxImages: SHORTS_MAX_IMAGES,
      },
      deadline
    );

    let parsed = null;
    try {
      parsed = JSON.parse(out.text);
    } catch (_) {
      const j = extractJson(out.text);
      parsed = j || null;
    }
    if (!parsed || typeof parsed !== 'object') {
      return send(res, 200, {
        ok: false,
        action: 'shorts_analyze',
        reason: 'parse_failed',
        message: 'Gemini 응답을 JSON으로 읽지 못했습니다. 한 번 더 눌러 주세요.',
        model: out.model,
        __raw: String(out.text || '').slice(0, 1200),
      });
    }

    const arc = parsed.storyArc || {};
    const segs = arr(parsed.segments, 12)
      .map((g) => ({
        clipIndex: Math.max(0, Math.min(n - 1, Math.trunc(num(g && g.clipIndex, 0)))),
        startSec: Math.max(0, round1(num(g && g.startSec, 0))),
        durationSec: Math.max(1.5, Math.min(6, round1(num(g && g.durationSec, 3.4)))),
        speed: Math.max(0.8, Math.min(1.4, round1(num(g && g.speed, 1.0)))),
        cropFocus: ['center', 'left', 'right'].indexOf(String((g && g.cropFocus) || 'center')) >= 0
          ? String(g.cropFocus)
          : 'center',
        narration: s(g && g.narration, 220),
        subtitle: s(g && g.subtitle, 40),
      }))
      .filter((g) => g.narration || g.subtitle);

    if (!segs.length) {
      return send(res, 200, {
        ok: false,
        action: 'shorts_analyze',
        reason: 'empty_segments',
        message: '편집안이 비어 왔습니다. 한 번 더 눌러 주세요.',
        model: out.model,
      });
    }

    const warnings = [];
    if (pack.dropped) warnings.push('용량 때문에 키프레임 ' + pack.dropped + '장은 보내지 못했습니다.');

    return send(res, 200, {
      ok: true,
      action: 'shorts_analyze',
      model: out.model,
      data: {
        storyArc: {
          hook: s(arc.hook, 120),
          climax: s(arc.climax, 120),
          outro: s(arc.outro, 120),
        },
        youtubeTitle: s(parsed.youtubeTitle, 120),
        youtubeDescription: s(parsed.youtubeDescription, 900),
        bgmMood: SHORTS_BGMS.indexOf(String(parsed.bgmMood || '')) >= 0 ? String(parsed.bgmMood) : 'upbeat',
        hookOptions: normalizeHookOptions(parsed.hookOptions, arc.hook),
        segments: segs,
      },
      imagesUsed: pack.images.length,
      warnings: warnings,
    });
  } catch (err) {
    const code = (err && err.code) || 'gemini_unavailable';
    const status = code === 'quota_exceeded' ? 429 : 503;
    return send(res, status, {
      ok: false,
      action: 'shorts_analyze',
      reason: code,
      message:
        code === 'quota_exceeded'
          ? 'Gemini 무료 하루 한도를 다 썼습니다. 잠시 뒤 다시 시도해 주세요.'
          : 'Gemini가 응답하지 않았습니다. 잠시 뒤 다시 눌러 주세요.',
      tries: (err && err.tries) || [],
    });
  }
}

const SHORTS_REWRITE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    narration: { type: 'STRING' },
    subtitle: { type: 'STRING' },
  },
  required: ['narration', 'subtitle'],
};

async function handleShortsRewrite(res, body, keyConfigured) {
  if (!keyConfigured) return send(res, 503, noKeyBody());
  const narration = s(body.narration, 300);
  const subtitle = s(body.subtitle, 60);
  if (!narration && !subtitle) {
    return send(res, 400, {
      ok: false,
      reason: 'empty_text',
      message: '다시 쓸 대본이나 자막이 비어 있습니다.',
    });
  }
  const toneKey = s(body.tone, 30) || 'energetic';
  const tone = SHORTS_TONES[toneKey] || SHORTS_TONES.energetic;

  try {
    const out = await generate(
      {
        system:
          '당신은 유튜브 쇼츠 대본 작가입니다. 한 컷 분량의 성우 대사와 자막을 더 몰입감 있게 다듬습니다. ' +
          '없는 사실을 만들지 않고, 사람이 실제로 말하는 구어체로 씁니다.',
        user: [
          '유튜브 쇼츠의 한 컷 대본과 자막을 더 몰입감 있고 후킹하게 리라이팅해 주세요.',
          '현재 대본: "' + narration + '"',
          '현재 자막: "' + subtitle + '"',
          '원하는 톤: ' + tone,
          '규칙: narration 은 성우가 3~4초 안에 읽을 자연스러운 한국어 구어체 한 문장(20자 안팎), ' +
            'subtitle 은 14자 이내 임팩트 자막. 원래 뜻과 정보는 유지하세요.',
        ].join('\n'),
        schema: SHORTS_REWRITE_SCHEMA,
        temperature: 0.85,
        maxTokens: 400,
        fastFirst: true,
      },
      Date.now() + DEADLINE_MS
    );
    let parsed = null;
    try {
      parsed = JSON.parse(out.text);
    } catch (_) {
      const j = extractJson(out.text);
      parsed = j || null;
    }
    const nNar = s(parsed && parsed.narration, 220);
    const nSub = s(parsed && parsed.subtitle, 60);
    if (!nNar && !nSub) {
      return send(res, 200, {
        ok: false,
        action: 'shorts_rewrite',
        reason: 'parse_failed',
        message: '다시 쓴 문장이 비어 왔습니다. 한 번 더 눌러 주세요.',
        model: out.model,
      });
    }
    return send(res, 200, {
      ok: true,
      action: 'shorts_rewrite',
      model: out.model,
      data: { narration: nNar || narration, subtitle: nSub || subtitle },
    });
  } catch (err) {
    const code = (err && err.code) || 'gemini_unavailable';
    return send(res, code === 'quota_exceeded' ? 429 : 503, {
      ok: false,
      action: 'shorts_rewrite',
      reason: code,
      message:
        code === 'quota_exceeded'
          ? 'Gemini 무료 하루 한도를 다 썼습니다. 잠시 뒤 다시 시도해 주세요.'
          : 'Gemini가 응답하지 않았습니다. 잠시 뒤 다시 눌러 주세요.',
    });
  }
}

/* ElevenLabs with-timestamps — 서버 환경변수 키가 있으면 키 입력 없이 단어 타임스탬프까지.
   키가 없으면 ok:false(no_eleven_key) 로 알리고, 클라이언트는 /api/tts 무료 성우로 폴백한다. */
async function handleShortsTts(res, body) {
  const text = s(body.text, 600);
  if (!text) return send(res, 400, { ok: false, reason: 'empty_text', message: '읽을 문장이 비어 있습니다.' });
  const envKey = s(process.env.ELEVENLABS_API_KEY, 200);
  const key = s(body.key, 200) || envKey;
  if (!key) {
    return send(res, 200, {
      ok: false,
      reason: 'no_eleven_key',
      message: 'ElevenLabs 키가 없습니다. 무료 서버 성우(/api/tts)로 대신 읽습니다.',
    });
  }
  const voiceId = s(body.voiceId, 60) || s(process.env.ELEVENLABS_VOICE_ID, 60) || '21m00Tcm4TlvDq8ikWAM';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(
      'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId) + '/with-timestamps',
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.45, similarity_boost: 0.78 },
        }),
        signal: ctrl.signal,
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return send(res, r.status === 401 || r.status === 403 ? 401 : 502, {
        ok: false,
        reason: r.status === 401 || r.status === 403 ? 'eleven_key_rejected' : 'eleven_error',
        status: r.status,
        message: 'ElevenLabs 응답 오류(' + r.status + ') ' + String(t).slice(0, 140),
      });
    }
    const j = await r.json();
    if (!j || !j.audio_base64) {
      return send(res, 502, { ok: false, reason: 'eleven_empty', message: 'ElevenLabs 음성이 비어 왔습니다.' });
    }
    const al = j.alignment || j.normalized_alignment || {};
    return send(res, 200, {
      ok: true,
      engine: 'elevenlabs',
      mime: 'audio/mpeg',
      voiceId: voiceId,
      audio: j.audio_base64,
      alignment: {
        characters: arr(al.characters, 2000).map((c) => String(c)),
        character_start_times_seconds: arr(al.character_start_times_seconds, 2000).map((v) => num(v, 0)),
        character_end_times_seconds: arr(al.character_end_times_seconds, 2000).map((v) => num(v, 0)),
      },
    });
  } catch (err) {
    return send(res, 504, {
      ok: false,
      reason: 'eleven_timeout',
      message: 'ElevenLabs 응답이 늦어 실패했습니다. 무료 서버 성우로 대신 읽습니다.',
    });
  } finally {
    clearTimeout(timer);
  }
}


/* ============================================================================
 * 💡 아이디어 → AI 쇼츠 (Idea2Shorts 통합)
 *   shorts-studio-pro(다른 오리진)가 절대 URL 로 부른다. 기존 액션은 그대로 둔다.
 *   - idea_topics      : 장르·키워드 → 조회수 노리는 후킹 주제 3안
 *   - idea_story       : 아이디어/자료 → 5컷 스토리보드(대사·자막·그림 프롬프트·카드·모션)
 *   - idea_image       : Pollinations 서버 프록시 / Gemini Image → base64 (캔버스 오염 방지)
 *   - idea_url_extract : 유튜브 자막·블로그 본문 → 아이디어 입력용 텍스트
 * ========================================================================= */

const IDEA_MAX_SCENES = 6;
const IDEA_TEXT_MAX = 2600;
const IDEA_IMAGE_TIMEOUT_MS = 30000;
const IDEA_IMAGE_MAX_BYTES = 3800 * 1024;

const IDEA_GENRE_LABEL = {
  psychology: '심리·뇌과학 팩트',
  story: '썰·반전 스토리',
  history: '미스터리·역사 비화',
  finance: '재테크·생활 꿀팁',
};

const IDEA_STYLE_PROMPT = {
  webtoon: 'Korean webtoon digital illustration style, clean sharp lineart, vibrant cinematic lighting, vertical 9:16 composition, no text',
  cinematic: 'Photorealistic cinematic film still, 35mm lens, shallow depth of field, dramatic lighting, vertical 9:16 composition, no text',
  anime: 'Warm Studio Ghibli inspired anime art style, painterly background, soft sunlight, expressive mood, vertical 9:16 composition, no text',
  noir: 'Dark mystery neo-noir aesthetic, high contrast shadows, moody neon rim light, vertical 9:16 composition, no text',
};

const IDEA_CAMERA_MOTIONS = ['zoom_in', 'zoom_out', 'pan_lr', 'shake'];

const SCHEMA_IDEA_TOPICS = {
  type: 'OBJECT',
  properties: {
    topics: {
      type: 'ARRAY',
      description: '서로 각도가 다른 주제 3개',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: '쇼츠 주제 한 줄 (24자 이내)' },
          hook: { type: 'STRING', description: '첫 2초에 실제로 말할 구어체 후킹 문장 (30자 이내)' },
          angle: { type: 'STRING', description: '왜 클릭하게 되는지 한 줄 (20자 이내)' },
        },
        required: ['title', 'hook', 'angle'],
      },
    },
  },
  required: ['topics'],
};

const SCHEMA_IDEA_STORY = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: '쇼츠 제목 (32자 이내)' },
    hashtags: { type: 'ARRAY', description: '해시태그 4개 (# 포함)', items: { type: 'STRING' } },
    hookOptions: {
      type: 'ARRAY',
      description: '상단 후킹 문구 3안 (말투를 다르게)',
      items: {
        type: 'OBJECT',
        properties: {
          tag: { type: 'STRING', description: 'curiosity / direct / twist' },
          text: { type: 'STRING', description: '20자 이내 한 줄' },
        },
        required: ['tag', 'text'],
      },
    },
    arc: {
      type: 'OBJECT',
      properties: {
        hook: { type: 'STRING', description: '초반 3초 후킹 (20자 이내)' },
        climax: { type: 'STRING', description: '핵심 전개 (20자 이내)' },
        outro: { type: 'STRING', description: '마무리·루프 (20자 이내)' },
      },
      required: ['hook', 'climax', 'outro'],
    },
    scenes: {
      type: 'ARRAY',
      description: '5개 컷 (순서대로)',
      items: {
        type: 'OBJECT',
        properties: {
          narration: { type: 'STRING', description: '성우 대사 — 한국어 구어체 한 문장, 55자 이내' },
          subtitle: { type: 'STRING', description: '화면 자막 14자 이내' },
          speaker: { type: 'STRING', description: 'A(질문자) 또는 B(전문가). 1인 모드면 모두 A' },
          cameraMotion: { type: 'STRING', description: 'zoom_in / zoom_out / pan_lr / shake' },
          cardType: { type: 'STRING', description: 'image 또는 card(숫자·비교)' },
          cardData: {
            type: 'OBJECT',
            description: 'cardType=card 일 때만',
            properties: {
              kind: { type: 'STRING', description: 'numbers / compare / list' },
              title: { type: 'STRING', description: '14자 이내' },
              items: {
                type: 'ARRAY',
                description: '2~3개',
                items: {
                  type: 'OBJECT',
                  properties: {
                    label: { type: 'STRING', description: '10자 이내' },
                    value: { type: 'STRING', description: '8자 이내' },
                  },
                  required: ['label', 'value'],
                },
              },
              footnote: { type: 'STRING', description: '20자 이내 (선택)' },
            },
          },
          emphasizeWord: { type: 'STRING', description: 'subtitle 안의 단어 하나' },
        },
        required: ['narration', 'subtitle', 'speaker', 'cameraMotion', 'cardType'],
      },
    },
  },
  required: ['title', 'hashtags', 'scenes'],
};

function ideaCleanHash(list) {
  return arr(list, 8)
    .map((h) => s(h, 26).replace(/\s+/g, ''))
    .filter(Boolean)
    .map((h) => (h.charAt(0) === '#' ? h : '#' + h));
}

function normIdeaStory(data, idea) {
  const d = data && typeof data === 'object' ? data : {};
  const palettes = [
    ['#1e1b4b', '#4338ca'],
    ['#3b0764', '#9333ea'],
    ['#0f172a', '#0284c7'],
    ['#064e3b', '#10b981'],
    ['#7c2d12', '#f97316'],
  ];
  const icons = ['🔥', '🧠', '⚡', '✨', '🎯'];
  const scenes = arr(d.scenes, IDEA_MAX_SCENES)
    .map((g, idx) => {
      const sc = g && typeof g === 'object' ? g : {};
      const narration = s(sc.narration, 220);
      const subtitle = s(sc.subtitle, 40);
      if (!narration && !subtitle) return null;
      const cardType = String(sc.cardType || '').toLowerCase() === 'card' ? 'card' : 'image';
      const cd = sc.cardData && typeof sc.cardData === 'object' ? sc.cardData : null;
      const items = cd ? arr(cd.items, 4).map((it) => ({
        label: s(it && it.label, 20),
        value: s(it && it.value, 16),
      })).filter((it) => it.label || it.value) : [];
      return {
        narration,
        subtitle: subtitle || narration.slice(0, 14),
        speaker: String(sc.speaker || '').toUpperCase() === 'B' ? 'B' : 'A',
        visualPrompt: s(sc.visualPrompt, 900),
        cameraMotion: IDEA_CAMERA_MOTIONS.indexOf(String(sc.cameraMotion)) >= 0 ? String(sc.cameraMotion) : 'zoom_in',
        cardType: cardType === 'card' && items.length ? 'card' : 'image',
        cardData: cardType === 'card' && items.length
          ? {
              kind: ['numbers', 'compare', 'list'].indexOf(String(cd.kind)) >= 0 ? String(cd.kind) : 'numbers',
              title: s(cd.title, 30) || subtitle,
              items,
              footnote: s(cd.footnote, 40),
            }
          : null,
        emphasizeWord: s(sc.emphasizeWord, 20),
        palette: palettes[idx % palettes.length],
        icon: icons[idx % icons.length],
      };
    })
    .filter(Boolean);

  const arc = d.arc && typeof d.arc === 'object' ? d.arc : {};
  return {
    title: s(d.title, 120) || s(idea, 80),
    hashtags: ideaCleanHash(d.hashtags),
    hookOptions: arr(d.hookOptions, 3).map((h) => ({
      tag: s(h && h.tag, 14) || 'hook',
      text: s(h && h.text, 60),
    })).filter((h) => h.text),
    arc: {
      hook: s(arc.hook, 60) || (scenes[0] ? scenes[0].subtitle : '') || '',
      climax: s(arc.climax, 60) || (scenes[1] ? scenes[1].subtitle : '') || '',
      outro: s(arc.outro, 60) || (scenes.length ? scenes[scenes.length - 1].subtitle : '') || '',
    },
    scenes,
  };
}

async function handleIdeaTopics(res, body, keyConfigured) {
  if (!keyConfigured) return send(res, 503, noKeyBody());
  const genre = s(body.genre, 30) || 'psychology';
  const keyword = s(body.keyword, 80).replace(/[#\n]/g, ' ').trim();
  const label = IDEA_GENRE_LABEL[genre] || IDEA_GENRE_LABEL.psychology;
  const user = [
    '유튜브 쇼츠 "' + label + '" 장르에서 지금 조회수가 잘 나오는 주제 3개를 추천해 주세요.',
    keyword ? '[키워드/관심사] ' + keyword : '[키워드/관심사] 없음 — 장르에서 흔히 먹히는 소재로',
    '',
    '[규칙]',
    '1. 세 주제는 서로 완전히 다른 각도여야 합니다(예: 통념 반박 / 숫자 비교 / 실전 상황).',
    '2. title 은 24자 이내 한 줄. hook 은 첫 2초에 실제로 말할 구어체 문장(30자 이내).',
    '3. angle 은 "왜 클릭하게 되는지"를 20자 이내로.',
    '4. 확인되지 않은 수치·고유명사·연구 결과를 사실처럼 쓰지 마세요. 필요한 수치는 "대부분", "절반쯤" 같은 안전한 표현으로.',
    '5. JSON 만 돌려주세요.',
  ].filter(Boolean).join('\n');

  const deadline = Date.now() + DEADLINE_MS;
  try {
    const out = await generate({
      system:
        '당신은 유튜브 쇼츠 기획자입니다. 클릭을 부르는 주제 3개를 각도가 겹치지 않게 제안하고, ' +
        '확인되지 않은 사실은 단정하지 않습니다.',
      user,
      schema: SCHEMA_IDEA_TOPICS,
      temperature: 0.95,
      maxTokens: 900,
      fastFirst: true,
    }, deadline);
    let parsed = null;
    try { parsed = JSON.parse(out.text); } catch (_) { parsed = extractJson(out.text); }
    const topics = arr(parsed && parsed.topics, 3)
      .map((t) => ({
        title: s(t && t.title, 60),
        hook: s(t && t.hook, 80),
        angle: s(t && t.angle, 60),
      }))
      .filter((t) => t.title);
    if (!topics.length) {
      return send(res, 200, {
        ok: false, action: 'idea_topics', reason: 'empty_topics',
        message: '주제를 만들지 못했습니다. 한 번 더 눌러 주세요.', model: out.model,
      });
    }
    return send(res, 200, { ok: true, action: 'idea_topics', model: out.model, genre, keyword, topics });
  } catch (err) {
    const code = (err && err.code) || 'gemini_unavailable';
    return send(res, code === 'quota_exceeded' ? 429 : 503, {
      ok: false, action: 'idea_topics', reason: code,
      message: code === 'quota_exceeded'
        ? 'Gemini 무료 하루 한도를 다 썼습니다. 잠시 뒤 다시 눌러 주세요.'
        : 'Gemini가 응답하지 않았습니다. 잠시 후 다시 시도해 주세요.',
      tries: (err && err.tries) || [],
    });
  }
}


const SCHEMA_IDEA_VISUALS = {
  type: 'OBJECT',
  properties: {
    prompts: { type: 'ARRAY', description: '컷 순서대로 영어 그림 프롬프트', items: { type: 'STRING' } },
  },
  required: ['prompts'],
};

/* 2단계 — 컷 설명을 영어 그림 프롬프트로 (짧은 응답이라 잘리지 않는다) */
async function ideaBuildVisualPrompts(scenes, artStyle, character, deadline) {
  const style = IDEA_STYLE_PROMPT[artStyle] || IDEA_STYLE_PROMPT.webtoon;
  const lines = scenes.map((sc, i) => (i + 1) + '. ' + (sc.subtitle || '') + ' — ' + (sc.narration || ''));
  const user = [
    '아래 한국어 컷을 영어 그림 프롬프트로 바꿔 주세요. 컷 수와 순서를 그대로 유지합니다.',
    '',
    '[화풍] ' + style,
    character ? '[주인공 외형 고정] ' + character : '[주인공] 한 명을 정해 모든 컷에서 똑같이',
    '',
    '[컷]',
    lines.join('\n'),
    '',
    '[규칙]',
    '1. 각 프롬프트는 영어 18단어 이내, 그림 안 글자 금지(no text), 세로 9:16 구도.',
    '2. 인물의 얼굴·머리·옷과 화풍을 모든 컷에서 똑같이 묘사하세요.',
    '3. 프롬프트 배열 길이는 정확히 ' + scenes.length + '개.',
    '4. JSON 만 돌려주세요.',
  ].join('\n');
  try {
    const out = await generate({
      system: 'You write short, concrete English image prompts for vertical 9:16 short-form videos. No text inside images.',
      user,
      schema: SCHEMA_IDEA_VISUALS,
      temperature: 0.6,
      maxTokens: 1000,
      fastFirst: true,
    }, deadline);
    let parsed = null;
    try { parsed = JSON.parse(out.text); } catch (_) { parsed = extractJson(out.text); }
    return arr(parsed && parsed.prompts, 8).map((p) => s(p, 400));
  } catch (err) {
    return [];
  }
}


/* Lite 모델이 가끔 "ghjklasdf..." 처럼 같은 문자열을 무한 반복하며 깨진다 — 그런 응답은 버린다. */
function ideaTextBroken(text) {
  const t = String(text || '');
  if (t.length < 40) return true;
  const m = t.match(/(.{4,12})\1{5,}/);
  if (m) return true;
  const probe = t.slice(Math.floor(t.length / 2), Math.floor(t.length / 2) + 8);
  if (probe.length >= 6 && t.split(probe).length > 8) return true;
  return false;
}

async function handleIdeaStory(res, body, keyConfigured) {
  if (!keyConfigured) return send(res, 503, noKeyBody());
  const idea = s(body.idea, 1200);
  const source = s(body.sourceText, IDEA_TEXT_MAX);
  if (!idea && !source) {
    return send(res, 400, {
      ok: false, action: 'idea_story', reason: 'missing_idea',
      message: '쇼츠로 만들 아이디어나 참고 자료(링크·글)를 먼저 넣어 주세요.',
    });
  }
  const genre = s(body.genre, 30) || 'psychology';
  const artStyle = s(body.artStyle, 30) || 'webtoon';
  const character = s(body.character, 200);
  const dialogue = body.dialogue === true || body.dialogue === 'true';
  const loop = body.loop === true || body.loop === 'true';

  const base = [
    '아래 아이디어를 15~30초 유튜브 쇼츠 스토리보드(5컷)로 바꿔 주세요.',
    '',
    '[아이디어] ' + (idea || '(링크에서 가져온 자료 — 아래 참고 자료 참조)'),
    source ? '\n[참고 자료]\n' + source.slice(0, 1800) : '',
    '',
    '[장르/톤] ' + (IDEA_GENRE_LABEL[genre] || IDEA_GENRE_LABEL.psychology),
    '[화풍] ' + artStyle,
    '[주인공 외형 고정] ' + (character || '아이디어에 어울리는 인물 하나를 정해 모든 컷에서 똑같이 유지'),
    '[대화 모드] ' + (dialogue
      ? '2인 티키타카 — A는 호기심 많은 질문자, B는 핵심을 찌르는 전문가. 번갈아 말한다.'
      : '1인 내레이션 — 모든 컷 speaker 는 A.'),
    '[무한 루프] ' + (loop
      ? '마지막 컷 대사가 첫 컷 대사로 자연스럽게 이어지게 한다.'
      : '깔끔한 결론으로 마무리한다.'),
    '',
    '[규칙]',
    '1. 첫 컷은 3초 안에 손가락을 멈추게 하는 후킹. 마지막 컷은 저장·구독 유도.',
    '2. narration 은 성우가 3~4초에 읽을 한국어 구어체 한 문장(55자 이내). 숫자를 그대로 낭독하지 말고 의미로.',
    '3. subtitle 은 14자 이내 임팩트 자막. narration 을 그대로 옮기지 말 것.',
    '4. 각 컷 narration 은 서로 다른 장면이 되게 하세요(그림은 따로 만듭니다).',
    '5. cameraMotion 은 zoom_in / zoom_out / pan_lr / shake 중 다양하게.',
    '6. 숫자·비교가 핵심인 한 컷은 cardType=card 로 하고 cardData.items 2~3개를 채운다. 자막·대사에 실제로 나온 숫자만.',
    '7. emphasizeWord 는 그 컷 subtitle 안에 실제로 있는 단어 하나.',
    '8. 확인되지 않은 수치·가격·고유명사를 만들지 말 것.',
    '9. JSON 만 돌려주세요.',
  ].filter(Boolean).join('\n');

  const compactExtra = '\n\n[길이 제한] 출력이 길어 잘리지 않도록 컷 4개, narration 40자, visualPrompt 8단어 이내로 아주 짧게 쓰세요.';
  const deadline = Date.now() + DEADLINE_MS;
  let lastOut = null;
  let lastRaw = '';
  const tries = [];
  const promptOf = (variant) => ({
    system:
      '당신은 100만 조회수 유튜브 쇼츠 전문 작가·PD입니다. 주어진 아이디어와 참고 자료만 근거로 ' +
      '짧고 리듬감 있는 스토리보드를 씁니다. 보이지 않는 사실은 만들지 않고, 같은 문장을 반복하지 않습니다.',
    user: variant === 0 ? base : base + compactExtra,
    schema: SCHEMA_IDEA_STORY,
    temperature: variant === 0 ? 0.65 : 0.4,
    maxTokens: variant === 0 ? 6000 : 3400,
    fastFirst: true,
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let out = null;
      if (attempt < 2) {
        out = await generate(promptOf(attempt), deadline);
      } else {
        // 마지막 시도는 다른 모델(3 Flash)로 직접 — Lite 가 반복 문자로 깨질 때 우회
        out = await callModel('gemini-3-flash-preview', promptOf(1),
          Date.now() + Math.min(30000, Math.max(12000, deadline - Date.now())), true);
      }
      lastOut = out;
      lastRaw = String(out.text || '');
      if (out.finish === 'MAX_TOKENS') { tries.push({ attempt: attempt + 1, model: out.model, reason: 'max_tokens' }); continue; }
      if (ideaTextBroken(lastRaw)) { tries.push({ attempt: attempt + 1, model: out.model, reason: 'broken_text' }); continue; }
      let parsed = null;
      try { parsed = JSON.parse(lastRaw); } catch (_) { parsed = null; }
      if (!parsed || typeof parsed !== 'object') { tries.push({ attempt: attempt + 1, model: out.model, reason: 'parse' }); continue; }
      const story = normIdeaStory(parsed, idea || source.slice(0, 120));
      if (story.scenes.length < 3) { tries.push({ attempt: attempt + 1, model: out.model, reason: 'few_scenes' }); continue; }

      // 2단계: 영어 그림 프롬프트 (실패해도 대사로 대신 그린다)
      const needPrompts = story.scenes.some((sc2) => !sc2.visualPrompt || sc2.visualPrompt.length < 10);
      if (needPrompts) {
        const prompts = await ideaBuildVisualPrompts(story.scenes, artStyle, character, deadline - 6000);
        story.scenes.forEach((sc2, i2) => {
          if (!sc2.visualPrompt || sc2.visualPrompt.length < 10) {
            sc2.visualPrompt = prompts[i2] || (sc2.subtitle || sc2.narration || 'cinematic scene');
          }
        });
      }
      return send(res, 200, {
        ok: true, action: 'idea_story', model: out.model,
        artStyle: IDEA_STYLE_PROMPT[artStyle] ? artStyle : 'webtoon',
        story,
        attempts: attempt + 1,
        chars: lastRaw.length,
        finish: out.finish || '',
        tokens: (out.usage && out.usage.candidatesTokenCount) || null,
        warnings: source ? ['참고 자료는 링크에서 읽은 본문 일부(' + source.length + '자)만 반영했습니다.'] : [],
      });
    } catch (err) {
      const code = (err && err.code) || 'gemini_unavailable';
      if (code === 'quota_exceeded') {
        return send(res, 429, {
          ok: false, action: 'idea_story', reason: 'quota_exceeded',
          message: 'Gemini 무료 하루 한도를 다 썼습니다. 잠시 뒤 다시 눌러 주세요.',
          tries: (err && err.tries) || tries,
        });
      }
      tries.push({ attempt: attempt + 1, reason: code, message: String((err && err.message) || '').slice(0, 120) });
      lastRaw = String((err && err.message) || '').slice(0, 300);
    }
  }
  return send(res, 200, {
    ok: false, action: 'idea_story', reason: 'parse_failed',
    message: 'Gemini 응답을 읽지 못했습니다(세 번 시도). 잠시 뒤 한 번 더 눌러 주세요.',
    model: lastOut && lastOut.model,
    chars: lastRaw.length,
    tries,
    __raw: lastRaw.slice(0, 1200),
  });
}

async function ideaFetchImage(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(4000, ms));
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': PHOTO_UA, Accept: 'image/*' },
    });
    if (!r.ok) {
      const e = new Error('image_http_' + r.status);
      e.status = r.status;
      throw e;
    }
    const ab = await r.arrayBuffer();
    const mime = String(r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (ab.byteLength < 1200) throw new Error('image_too_small');
    if (ab.byteLength > IDEA_IMAGE_MAX_BYTES) throw new Error('image_too_large');
    return { mime: /^image\/(jpeg|jpg|png|webp)$/.test(mime) ? mime : 'image/jpeg', buf: Buffer.from(ab) };
  } finally {
    clearTimeout(timer);
  }
}

async function ideaGeminiImage(prompt, reference) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) return { ok: false, message: '서버 Gemini 키가 없어 Gemini Image 를 쓸 수 없습니다.' };
  const models = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image'];
  let lastMsg = '';
  for (const model of models) {
    const parts = [];
    if (reference && reference.data) {
      parts.push({ text: 'Keep the exact same art style and the same main character appearance as this reference image.' });
      parts.push({ inlineData: { mimeType: String(reference.mimeType || 'image/jpeg'), data: String(reference.data) } });
    }
    parts.push({ text: 'Create a vertical 9:16 image with no text: ' + prompt });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 24000);
    try {
      const r = await fetch(API_ROOT + model + ':generateContent?key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE'] } }),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        const em = (j && j.error && j.error.message) || ('HTTP ' + r.status);
        if (r.status === 429) {
          return {
            ok: false,
            reason: 'gemini_image_quota',
            message: 'Gemini 이미지 무료 한도를 다 썼습니다(429). 무료 Pollinations 엔진을 쓰거나 내장 모션 그래픽으로 대체해 주세요.',
          };
        }
        lastMsg = String(em).slice(0, 200);
        continue;
      }
      const cps = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      const ip = cps.find((p) => p && p.inlineData && p.inlineData.data);
      if (!ip) { lastMsg = 'Gemini 응답에 이미지가 포함되지 않았습니다.'; continue; }
      return {
        ok: true, engine: 'gemini', model,
        mime: ip.inlineData.mimeType || 'image/png',
        buf: Buffer.from(ip.inlineData.data, 'base64'),
      };
    } catch (e) {
      lastMsg = String((e && e.message) || e).slice(0, 160);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: 'gemini_image_failed', message: lastMsg || 'Gemini 이미지 생성에 실패했습니다.' };
}

async function handleIdeaImage(res, body) {
  const prompt = s(body.prompt, 1200);
  if (!prompt) return send(res, 400, { ok: false, action: 'idea_image', reason: 'empty_prompt', message: '그림 프롬프트가 비어 있습니다.' });
  const engine = s(body.engine, 20) || 'pollinations';
  const width = Math.max(360, Math.min(1080, Math.trunc(num(body.width, 540))));
  const height = Math.max(640, Math.min(1920, Math.trunc(num(body.height, 960))));
  const seed = Math.max(1, Math.min(999999, Math.trunc(num(body.seed, 4200))));

  if (engine === 'gemini') {
    const ref = body.reference && body.reference.data
      ? { data: String(body.reference.data).slice(0, 3 * 1024 * 1024), mimeType: s(body.reference.mimeType, 40) }
      : null;
    const out = await ideaGeminiImage(prompt, ref);
    if (!out.ok) {
      return send(res, 200, {
        ok: false, action: 'idea_image', engine: 'gemini',
        reason: out.reason || 'gemini_image_failed',
        message: out.message || 'Gemini 이미지 생성에 실패했습니다.',
      });
    }
    return send(res, 200, {
      ok: true, action: 'idea_image', engine: 'gemini', model: out.model,
      mime: out.mime, width, height, data: out.buf.toString('base64'),
    });
  }

  /* Pollinations — 서버에서 받아 base64 로 내려 캔버스 오염(CORS taint)을 원천 차단한다. */
  const started = Date.now();
  const style = s(body.stylePrompt, 400);
  const fullPrompt = style ? prompt + ', ' + style : prompt;
  const build = (sd) =>
    'https://image.pollinations.ai/prompt/' + encodeURIComponent(fullPrompt) +
    '?width=' + width + '&height=' + height + '&seed=' + sd + '&nologo=true&enhance=false';
  const tries = [];
  let got = null;
  for (let i = 0; i < 2 && !got; i++) {
    const left = IDEA_IMAGE_TIMEOUT_MS - (Date.now() - started);
    if (left < 6000) break;
    try {
      got = await ideaFetchImage(build(seed + i * 17), Math.min(left, 26000));
    } catch (e) {
      tries.push((e && e.message ? e.message : String(e)).slice(0, 120));
      if (i === 0) await sleep(400);
    }
  }
  if (!got) {
    return send(res, 200, {
      ok: false, action: 'idea_image', engine: 'pollinations', reason: 'pollinations_unavailable',
      message: '무료 이미지 서버(Pollinations)가 응답하지 않았습니다. 내장 모션 그래픽으로 대체합니다.',
      tries,
    });
  }
  return send(res, 200, {
    ok: true, action: 'idea_image', engine: 'pollinations',
    mime: got.mime, width, height, seed, bytes: got.buf.length,
    data: got.buf.toString('base64'),
  });
}

async function handleIdeaUrlExtract(res, body) {
  const raw = s(body.url || body.link || body.q, 600);
  if (!raw) {
    return send(res, 400, {
      ok: false, action: 'idea_url_extract', reason: 'missing_url',
      message: '뉴스·블로그·유튜브 링크를 넣어 주세요.',
    });
  }
  const ytId = ytVideoId(raw);
  if (ytId) {
    try {
      const out = await ytTranscript(ytId);
      if (out && out.ok && out.text) {
        return send(res, 200, {
          ok: true, action: 'idea_url_extract', source: 'youtube', videoId: ytId,
          title: out.title || '', author: out.author || '',
          text: String(out.text).slice(0, IDEA_TEXT_MAX),
          chars: out.chars || String(out.text).length,
          notes: out.notes || [],
        });
      }
      return send(res, 200, {
        ok: false, action: 'idea_url_extract', source: 'youtube', videoId: ytId,
        reason: (out && out.reason) || 'no_captions',
        message: (out && out.message) || '이 영상의 자막을 읽지 못했습니다. 제목·설명을 직접 붙여넣어 주세요.',
        title: (out && out.title) || '',
      });
    } catch (e) {
      return send(res, 200, {
        ok: false, action: 'idea_url_extract', source: 'youtube',
        reason: 'extract_failed',
        message: '유튜브 자막을 읽는 중 오류가 났습니다: ' + String((e && e.message) || e).slice(0, 140),
      });
    }
  }
  try {
    const src = await readBloggerSource(raw);
    return send(res, 200, {
      ok: true, action: 'idea_url_extract', source: 'web',
      title: src.title || '', author: src.author || '',
      finalUrl: src.finalUrl || raw,
      text: s(src.text, IDEA_TEXT_MAX),
      chars: src.chars || 0,
    });
  } catch (e) {
    return send(res, 200, {
      ok: false, action: 'idea_url_extract', source: 'web',
      reason: (e && e.code) || 'extract_failed',
      message: String((e && e.message) || e).slice(0, 200) || '이 페이지의 본문을 읽지 못했습니다.',
    });
  }
}


const SCHEMA_IDEA_PROMPT = {
  type: 'OBJECT',
  properties: {
    prompt: { type: 'STRING', description: '다시 쓴 영어 그림 프롬프트 (9:16, no text 유지)' },
  },
  required: ['prompt'],
};

/* 🎨 한 컷만 다시 그릴 때 — 한글 수정 요청을 영어 그림 프롬프트로 옮긴다. */
async function handleIdeaPromptEdit(res, body, keyConfigured) {
  if (!keyConfigured) return send(res, 503, noKeyBody());
  const prompt = s(body.prompt, 1200);
  const request = s(body.request, 300);
  if (!prompt && !request) {
    return send(res, 400, {
      ok: false, action: 'idea_prompt_edit', reason: 'missing_input',
      message: '고칠 그림 프롬프트나 수정 요청이 필요합니다.',
    });
  }
  const user = [
    '아래 영어 그림 프롬프트를, 사용자의 한글 수정 요청을 반영해 다시 써 주세요.',
    '',
    '[기존 프롬프트] ' + (prompt || '(없음 — 장면 설명을 새로 쓰세요)'),
    '[수정 요청] ' + (request || '(없음 — 같은 장면을 조금 다르게)'),
    '',
    '[규칙]',
    '1. 결과는 영어 한 문단(500자 이내).',
    '2. 세로 9:16 구도와 "no text"(그림 안 글자 금지)를 반드시 유지하세요.',
    '3. 인물의 외형(나이·머리·옷)과 화풍은 바꾸지 말고, 요청한 부분만 바꾸세요.',
    '4. JSON 만 돌려주세요.',
  ].join('\n');

  const deadline = Date.now() + DEADLINE_MS;
  try {
    const out = await generate({
      system: '당신은 이미지 생성 프롬프트 편집자입니다. 짧고 구체적인 영어 프롬프트 한 문단만 씁니다.',
      user,
      schema: SCHEMA_IDEA_PROMPT,
      temperature: 0.4,
      maxTokens: 500,
      fastFirst: true,
    }, deadline);
    let parsed = null;
    try { parsed = JSON.parse(out.text); } catch (_) { parsed = extractJson(out.text); }
    const outPrompt = s(parsed && parsed.prompt, 900);
    if (!outPrompt) {
      return send(res, 200, {
        ok: false, action: 'idea_prompt_edit', reason: 'empty_prompt',
        message: '프롬프트를 고치지 못했습니다. 그대로 다시 그립니다.', model: out.model,
      });
    }
    return send(res, 200, { ok: true, action: 'idea_prompt_edit', model: out.model, prompt: outPrompt });
  } catch (err) {
    const code = (err && err.code) || 'gemini_unavailable';
    return send(res, code === 'quota_exceeded' ? 429 : 503, {
      ok: false, action: 'idea_prompt_edit', reason: code,
      message: code === 'quota_exceeded'
        ? 'Gemini 무료 하루 한도를 다 썼습니다.'
        : 'Gemini가 응답하지 않았습니다.',
    });
  }
}

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
      work_dashboard: {
        actions: ['work_polish', 'work_parse', 'work_meeting'],
        polish: "POST { action:'work_polish', kind:'iss'|'wk', text:'메모' } → { ok, data:{ text } }",
        parse: "POST { action:'work_parse', text:'자연어 문장', mode:'meeting'(선택) } → { ok, data:{ kind, type, title, date, time, group, part, status, memo, summary, decisions[], actions[], todos[], run{} } }",
        meeting: "POST { action:'work_meeting', text:'전사문' } 또는 { action:'work_meeting', mime:'audio/mp4', data:'base64' } → { ok, data:{ transcript, title, summary, decisions[], actions[] } } — 음성 4MB·요청 본문 약 4.2MB 한도",
      },
      battery_research: {
        action: 'battery_research',
        how:
          "POST { action:'battery_research', q:'질문', notes:'대백과 발췌(선택)', lite:true|false } " +
          "→ { ok, queryEn, source:'openalex'|'crossref', papers:[{title,year,journal,authors,doi,cited,abstract}], answer:{headline,principle[],practice[],paperNotes[],cautions[]}, ai }",
        note: '논문은 OpenAlex → CrossRef 순으로 실제 조회한다. 논문·DOI를 지어내지 않는다.',
      },
      shorts_editor: {
        page: '/shorts-editor.html',
        actions: ['shorts_analyze', 'shorts_rewrite', 'shorts_tts'],
        analyze: "POST { action:'shorts_analyze', tone:'energetic'|'vlog'|'info'|'dramatic', hint:'방향', clips:[{name,duration,width,height,frames:[{tSec,data(base64 jpeg)}]}] } → { ok, data:{ storyArc, youtubeTitle, youtubeDescription, bgmMood, hookOptions[{type,text}], segments[] } } — 키프레임 최대 15장·후킹 3안(curiosity/direct/twist)",
        rewrite: "POST { action:'shorts_rewrite', narration, subtitle, tone } → { ok, data:{ narration, subtitle } }",
        tts: "POST { action:'shorts_tts', text, voiceId?, key? } → { ok, audio(base64), alignment } / 키 없으면 reason:'no_eleven_key' → /api/tts 무료 성우 사용",
      },
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
  const reqMode = s(body.mode, 30);
  // ⚡ 실시간 즉석 브리핑 — 프론트가 방금 받은 실측 JSON(facts)으로 그 시각 브리핑을 만든다.
  //    Gemini 가 죽어도 실측 조립 요약을 200 으로 돌려준다(빈 화면 금지).
  if (reqMode === 'live_briefing' || action === 'live_briefing') {
    return handleLiveBriefing(res, body, keyConfigured);
  }
  // 🧠 종목 1초 해석 — 체커가 보낸 실측 사실만으로 2~3줄. 키가 없어도 규칙 요약을 200 으로 돌려준다.
  if (reqMode === 'stock_insight' || action === 'stock_insight') {
    return handleStockInsight(res, body, keyConfigured);
  }
  // 🔋 이차전지 논문 리서치 — OpenAlex/CrossRef 실논문 메타데이터 + 대백과 발췌로만 해석한다.
  if (reqMode === 'battery_research' || action === 'battery_research') {
    return handleBatteryResearch(res, body, keyConfigured);
  }
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
  // 🎬 쇼츠 전용 편집기 — 키프레임 스토리 분석 · 컷 리라이팅 · (선택) ElevenLabs 성우
  if (action === 'shorts_analyze') return handleShortsAnalyze(res, body, keyConfigured);
  if (action === 'shorts_rewrite') return handleShortsRewrite(res, body, keyConfigured);
  if (action === 'shorts_tts') return handleShortsTts(res, body);
  // 💡 아이디어 → AI 쇼츠 (shorts-studio-pro 통합) — 이미지 프록시는 Gemini 키와 무관하게 먼저 처리한다.
  if (action === 'idea_topics') return handleIdeaTopics(res, body, keyConfigured);
  if (action === 'idea_story') return handleIdeaStory(res, body, keyConfigured);
  if (action === 'idea_prompt_edit') return handleIdeaPromptEdit(res, body, keyConfigured);
  if (action === 'idea_image' || action === 'idea_image_proxy') return handleIdeaImage(res, body);
  if (action === 'idea_url_extract') return handleIdeaUrlExtract(res, body);
  // 📋 업무 대시보드 — 보고서 문구 정리 · 자연어 분류 · 회의 녹음 전사/요약
  if (action === 'work_polish' || action === 'work_parse' || action === 'work_meeting') {
    return handleWork(res, body, keyConfigured);
  }
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
  } else if (action === 'cut_rewrite') {
    if (!s(body.narration, 2) && !s(body.subtitle, 2)) {
      return send(res, 400, { ok: false, reason: 'missing_cut', message: '다시 쓸 컷의 자막이나 나레이션이 필요합니다.' });
    }
    prompt = promptCutRewrite({ ...body, banPhrases });
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
  else if (action === 'cut_rewrite') result = normCutRewrite(data);
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
    (action === 'cut_rewrite' && !s(result.narration, 3)) ||
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

/* 🛡️ 2026-11-27: 예기치 못한 예외가 500(빈 응답)으로 나가지 않도록 핸들러를 감싼다.
 *    · 프론트는 ok:false + reason:'internal_error' 를 받고 직전 값을 유지한다.
 *    · 테스트용으로 붙인 module.exports 속성은 그대로 보존한다. */
(function () {
  const __http = require('../lib/http');
  const __h = module.exports;
  if (typeof __h === 'function' && !__h.__guarded) {
    const __wrapped = __http.safeHandler(__h, { label: 'content-ai' });
    Object.assign(__wrapped, __h);
    __wrapped.__guarded = true;
    module.exports = __wrapped;
  }
})();
