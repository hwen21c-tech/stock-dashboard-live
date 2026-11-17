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
const MAX_BODY_BYTES = 300 * 1024;
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
  let target;
  try {
    target = new URL(String(u.searchParams.get('u') || ''));
  } catch (_) {
    return send(res, 400, { ok: false, reason: 'bad_url', message: '이미지 주소(u)가 올바르지 않습니다.' });
  }
  if (!/^https?:$/.test(target.protocol)) {
    return send(res, 400, { ok: false, reason: 'bad_protocol', message: 'http(s) 주소만 받습니다.' });
  }
  const host = target.hostname.toLowerCase();
  if (PHOTO_DL_HOSTS.indexOf(host) < 0) {
    return send(res, 403, { ok: false, reason: 'host_not_allowed', message: '허용되지 않은 이미지 호스트입니다: ' + host });
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
const arr = (v, max) => (Array.isArray(v) ? v : []).slice(0, max || 12);
const num = (v, fb) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};
const round1 = (n) => Math.round(n * 10) / 10;

/* ---------------------------------------------------------------- 스키마 */

const SCHEMA_BLOG = {
  type: 'object',
  properties: {
    titles: {
      type: 'array',
      description: '제목 3종 — 궁금증형 / 숫자비교형 / 솔직후기형 순서, 각 32자 이내',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['궁금증형', '숫자비교형', '솔직후기형'] },
          text: { type: 'string' },
        },
        required: ['type', 'text'],
      },
    },
    gaps: {
      type: 'array',
      description: '경쟁 인기 글이 비워 둔 빈틈 2개 — 각 1~2문장',
      items: { type: 'string' },
    },
    body: { type: 'string', description: '완성된 마크다운 본문 (표·도입 3줄 훅·[📸 사진: 묘사 | search: 영문검색어] 2~3곳·솔직한 단점 포함)' },
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

function promptBlog(b) {
  const form = b.form || {};
  const sections = arr(form.sections, 8).map((x, i) => `${i + 1}) ${s(x, 80)}`).join('\n');
  const sample = s(b.toneSample, 4000);
  const note = s(b.experienceNote, 2000);
  const gaps = arr(b.gaps, 6).map((x) => `- ${s(x, 120)}`).join('\n');
  const user = [
    `주제: ${s(b.topic, 200)}`,
    form.name ? `양식: ${s(form.name, 40)} / 말투: ${s(form.tone, 40)}` : `말투: ${s(form.tone, 40) || '친근한 리뷰형'}`,
    sections ? `\n[반드시 이 순서로 섹션을 구성]\n${sections}` : '',
    form.highlight ? `\n[강조 포인트 — 이걸 지켜야 통과]\n${s(form.highlight, 400)}` : '',
    sample ? `\n[내 문체 샘플 — 문장 길이·어미·말버릇을 이 사람처럼]\n"""${sample}"""` : '',
    note ? `\n[내 경험 메모 — 사용자가 직접 적은 사실. 1인칭 경험은 여기 있는 내용만 쓴다]\n"""${note}"""` : '',
    gaps ? `\n[경쟁 글 빈틈 메모 — 본문에서 실제로 메꿔라]\n${gaps}` : '',
    b.theme ? `\n참고 카테고리: ${s(b.theme, 40)}` : '',
    banLine(b.banPhrases),
    `
[경험·사실 규칙 — 이걸 어기면 실패다]
- 위 [내 경험 메모]에 없는 1인칭 경험(다녀왔다·가보니·먹어봤다·내돈내산·써봤다)을 절대 쓰지 않는다. 실제로 방문·구매한 적이 없다.
- 경험 메모가 비어 있으면 '담백한 큐레이터' 어조로 쓴다. 확인된 조건·핵심 포인트·주의사항 중심으로. ("조건을 보면", "확인해야 할 것은", "~로 알려져 있다")
- 경험 메모가 있으면 그 내용만 1인칭으로 살린다. 메모에 없는 디테일을 덧붙이지 않는다.
- 사용자가 준 정보에 없는 업체·장소·상품·브랜드 이름을 지어내지 않는다. 예시가 필요하면 "A 업체", "B 숙소" 같은 자리표시자를 쓴다.
- "내돈내산", "협찬 없음", "직접 써본" 표현은 경험 메모가 있을 때만 쓴다.

[본문 작성 규칙]
1) 첫 3줄이 훅이다. 인사말("안녕하세요") 없이 결론·숫자·상황으로 바로 시작한다.
2) 위 섹션 순서를 그대로 쓰고 각 섹션 제목은 "## " 마크다운 소제목으로 단다.
3) 조건 비교용 마크다운 표를 최소 1개 넣는다. ( | 구분 | A | B | 형식, 헤더 구분선 포함)
4) 사진이 들어가면 글이 자연스러워지는 지점 2~3곳에 정확히 "[📸 사진: 구체적 묘사 | search: 영문검색어]" 형식으로 넣는다.
   - 묘사는 한국어 20자 내외(무엇이 보여야 하는지), search 는 무료 사진 DB에서 실제로 검색될 영어 명사 2~4단어.
   - search 에 브랜드·상호·사람 이름·연도·한글을 넣지 않는다(그런 사진은 무료 DB에 없다). "street food", "autumn park", "hotel lobby" 처럼 보편 명사만.
   - 사진 태그는 그 줄 하나로 끝낸다(같은 줄에 다른 문장을 붙이지 않는다). 표 안에는 넣지 않는다.
5) 솔직한 단점을 최소 1줄 쓴다. ("아쉬운 점:" 으로 시작)
6) 분량 900~1300자. 이 길이를 넘기면 출력이 잘려 실패한다 — 짧고 밀도 있게.
7) 확인 못 한 값은 "[확인 필요]"로 남긴다. (지어내면 안 된다)
8) 제목 3종은 각각 32자 이내 — 네이버 모바일 검색 결과에서 잘리지 않게.
9) gaps 에는 "같은 주제 인기 글들이 비워 둔 지점" 2개를, 각각 왜 비었는지 + 내가 무엇으로 채울지 1~2문장으로.
[출력] titles(3개) · gaps(2개) · body(마크다운) · warnings(확인 필요 목록) 만 JSON 으로.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: `너는 한국어 블로그를 직접 운영하는 사람이다. 검색 상위 글을 베끼지 않고, 내 경험과 실측값으로 쓴다. ${VOICE} ${HONESTY}`,
    user,
    schema: SCHEMA_BLOG,
    maxTokens: 3600,
    temperature: 0.95,
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
  const body = {
    systemInstruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
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
  const body = s(data.body, 20000);
  const warnings = arr(data.warnings, 10).map((w) => s(w, 200)).filter(Boolean);
  const banHits = scanBans(body, banPhrases);
  if (!body) warnings.push('본문이 비어 있습니다. 다시 생성해 주세요.');
  const photoSlots = (body.match(/\[(?:📸|📷)\s*사진[^\]]*\]/g) || []).length;
  return { titles, gaps, body, warnings, banHits, needsCheck: (body.match(/\[확인 필요\]/g) || []).length, photoSlots };
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

/* ---------------------------------------------------------------- 핸들러 */

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
    const act = s(u.searchParams.get('action'), 20);
    // 📸 사진 검색 — 블로그 생성과 별개로 GET 으로 쓴다(키 없이도 Wikimedia Commons 로 동작).
    if (act === 'photos') return handlePhotos(res, u);
    if (act === 'photo-dl') return handlePhotoDownload(res, u);
    return send(res, 200, {
      ok: true,
      keyConfigured,
      model: PRIMARY_MODEL,
      fallbacks: FALLBACK_MODELS,
      actions: ['blog', 'video_plan', 'youtube_analyze', 'blog_to_shorts'],
      photos: {
        pixabay: !!(process.env.PIXABAY_API_KEY && String(process.env.PIXABAY_API_KEY).trim()),
        commons: true,
        how: 'GET ?action=photos&q=검색어&n=6 → { ok, source, photos[] } / ?action=photo-dl&u=이미지주소&name=파일명.jpg',
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
    return send(res, 400, { ok: false, reason: err.code || 'bad_body', message: '요청 본문을 읽지 못했습니다.' });
  }

  const action = s(body.action, 30);
  if (!['blog', 'video_plan', 'youtube_analyze', 'blog_to_shorts'].includes(action)) {
    return send(res, 400, {
      ok: false,
      reason: 'unknown_action',
      message: 'action 은 blog / video_plan / youtube_analyze / blog_to_shorts 중 하나여야 합니다.',
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
  else result = normShorts(data);

  if (result.banHits && result.banHits.length) {
    notes.push(`금지 표현이 본문에 남아 있습니다: ${result.banHits.join(', ')}`);
  }

  const truncated = !parsed && out.finish === 'MAX_TOKENS';
  const emptyMain =
    (action === 'blog' && !s(result.body, 10)) ||
    (action === 'video_plan' && !(result.cuts || []).length) ||
    (action === 'blog_to_shorts' && !(result.scenes || []).length) ||
    (action === 'youtube_analyze' && !((result.shorts || {}).scenes || []).length);
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
    __raw: parsed ? undefined : out.text.slice(0, 20000),
  });
};
