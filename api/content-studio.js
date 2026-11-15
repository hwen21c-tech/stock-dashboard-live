'use strict';

/**
 * ✍️ 콘텐츠 스튜디오 API (Vercel Hobby 서버리스 함수 12개 제한 때문에 한 파일로 통합)
 *
 * 1) 유튜브 요약   GET  /api/content-studio?url=<유튜브 URL>
 *                  POST /api/content-studio  { url, transcript }
 *    - URL → videoId 추출 (watch / youtu.be / shorts / embed / live)
 *    - 메타(제목·채널·썸네일·길이) = oEmbed(항상) + Piped · 워치페이지(가능하면)
 *    - 자막 = Piped 자막 / 워치페이지 captionTracks (한국어 우선)
 *    - 자막이 있으면 ① 5줄 요약 ② 블로그 정리글 ③ 쇼츠 리액션 대본 생성
 *    - 자막을 못 얻으면 요약을 지어내지 않고 이유 + 붙여넣기 안내만 돌려준다
 *
 * 2) 원고 생성     GET  /api/content-studio?mode=stock|deals|topic&keyword=..
 *    - 서버에서 바로 원고를 만들어 주는 통로 (평일 15:45 자동 스케줄 등 무인 호출용)
 *    - format=md 이면 블로그 markdown 전문도 포함
 */

const ENGINE = require('../public/content-engine.js');

'use strict';

/**
 * GET  /api/youtube-summary?url=<유튜브 URL>&lang=ko
 * POST /api/youtube-summary  { url, transcript }   ← 자막을 직접 붙여넣은 경우
 *
 * 하는 일
 *  1) URL → videoId 추출 (watch / youtu.be / shorts / embed / live)
 *  2) 메타(제목·채널·썸네일·길이) 수집 — oEmbed(항상) + Piped(가능하면) + 워치페이지(가능하면)
 *  3) 자막 수집 — Piped 자막 / 워치페이지 captionTracks (한국어 우선)
 *  4) 자막이 있으면 content-engine 으로 ① 5줄 요약 ② 블로그 정리글 ③ 쇼츠 리액션 대본 생성
 *
 * 정직성 규칙
 *  - 자막을 못 얻으면 요약을 지어내지 않는다. captions.available=false + 이유 + 안내만 돌려준다.
 *  - YouTube 는 데이터센터 IP(서버)에 "봇 확인" 차단을 자주 걸기 때문에 자막 추출은 실패할 수 있고,
 *    그때는 클라이언트가 '자막 붙여넣기'로 같은 결과를 만든다(같은 엔진).
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PIPED_HOSTS = [
  'pipedapi.ducks.party',
  'api.piped.private.coffee',
  'pipedapi.orangenet.cc',
  'pipedapi.reallyaweso.me'
];

function sendJson(res, code, body, cache) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.end(JSON.stringify(body));
}

function extractVideoId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

async function fetchText(url, ms, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, ms || 5000);
  try {
    const r = await fetch(url, {
      headers: Object.assign({ 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' }, headers || {}),
      signal: ctl.signal,
      redirect: 'follow'
    });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, ms, headers) {
  const r = await fetchText(url, ms, Object.assign({ Accept: 'application/json' }, headers || {}));
  if (!r.ok) return { ok: false, status: r.status, data: null, error: r.error };
  try { return { ok: true, status: r.status, data: JSON.parse(r.text) }; }
  catch (e) { return { ok: false, status: r.status, data: null, error: 'invalid_json' }; }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** timedtext XML(VTT/TTML 계열) → [{t, text}] */
function parseTimedTextXml(xml) {
  const out = [];
  if (!xml) return out;
  const re = /<(?:text|p)\b([^>]*)>([\s\S]*?)<\/(?:text|p)>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || '';
    const body = decodeEntities(m[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!body) continue;
    let t = null;
    const st = attrs.match(/\bstart="([\d.]+)"/) || attrs.match(/\bbegin="([\d:.]+)"/);
    if (st) {
      if (st[1].indexOf(':') !== -1) {
        const parts = st[1].split(':').map(Number);
        t = parts.length === 3
          ? parts[0] * 3600 + parts[1] * 60 + parts[2]
          : parts[0] * 60 + (parts[1] || 0);
      } else {
        t = Number(st[1]);
      }
      if (!isFinite(t)) t = null;
    }
    out.push({ t: t, text: body });
  }
  return out;
}

/** youtube json3 자막 → [{t, text}] */
function parseJson3(json) {
  const out = [];
  try {
    const d = JSON.parse(json);
    (d.events || []).forEach(function (ev) {
      const text = (ev.segs || []).map(function (s) { return s.utf8 || ''; }).join('').replace(/\s+/g, ' ').trim();
      if (!text) return;
      out.push({ t: Math.round((ev.tStartMs || 0) / 1000), text: text });
    });
  } catch (e) { /* noop */ }
  return out;
}

/** 자막 후보 중 한국어 수동 → 한국어 자동 → 영어 순으로 고른다 */
function pickTrack(tracks) {
  if (!tracks || !tracks.length) return null;
  const ko = tracks.filter(function (t) { return /^ko/.test(t.lang); });
  const koManual = ko.find(function (t) { return !t.auto; });
  if (koManual) return koManual;
  if (ko.length) return ko[0];
  const en = tracks.filter(function (t) { return /^en/.test(t.lang); });
  const enManual = en.find(function (t) { return !t.auto; });
  return enManual || en[0] || tracks[0];
}

async function getOembed(videoId) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`;
  const r = await fetchJson(url, 4000);
  if (!r.ok || !r.data) return null;
  return {
    title: r.data.title || '',
    channel: r.data.author_name || '',
    channelUrl: r.data.author_url || '',
    thumbnail: r.data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  };
}

async function getPiped(videoId) {
  const results = await Promise.all(PIPED_HOSTS.map(function (host) {
    return fetchJson(`https://${host}/streams/${videoId}`, 5000, { Origin: 'https://piped.video', Referer: 'https://piped.video/' })
      .then(function (r) { return r.ok && r.data && !r.data.error ? { host: host, data: r.data } : null; })
      .catch(function () { return null; });
  }));
  const hit = results.find(Boolean);
  return hit || null;
}

/** 워치페이지에서 playerResponse/초기데이터 파싱(차단되면 null) */
async function getWatchPage(videoId) {
  const r = await fetchText(`https://www.youtube.com/watch?v=${videoId}&hl=ko&gl=KR&bpctr=9999999999`, 5000, {
    Cookie: 'CONSENT=YES+1; SOCS=CAI'
  });
  if (!r.ok || !r.text) return null;
  const html = r.text;
  const grab = function (marker) {
    const i = html.indexOf(marker);
    if (i === -1) return null;
    const start = html.indexOf('{', i);
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let j = start; j < html.length; j++) {
      const ch = html[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(html.slice(start, j + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  };
  const pr = grab('ytInitialPlayerResponse = ') || grab('"videoDetails"');
  let status = null;
  if (pr && pr.playabilityStatus) status = pr.playabilityStatus.status;

  let title = (pr && pr.videoDetails && pr.videoDetails.title) || '';
  let channel = (pr && pr.videoDetails && pr.videoDetails.author) || '';
  let duration = (pr && pr.videoDetails && Number(pr.videoDetails.lengthSeconds)) || 0;
  let description = (pr && pr.videoDetails && pr.videoDetails.shortDescription) || '';
  const tracks = [];
  const list = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
  if (list && list.length) {
    list.forEach(function (c) {
      tracks.push({
        url: c.baseUrl,
        lang: c.languageCode || '',
        auto: !!c.kind && /asr/i.test(c.kind),
        name: (c.name && (c.name.simpleText || (c.name.runs && c.name.runs[0] && c.name.runs[0].text))) || c.languageCode || ''
      });
    });
  }
  if (!title) {
    const m = html.match(/"title":"([^"]{1,200})","lengthSeconds"/);
    if (m) title = decodeEntities(m[1]);
  }
  if (!channel) {
    const m2 = html.match(/"ownerChannelName":"([^"]{1,120})"/);
    if (m2) channel = decodeEntities(m2[1]);
  }
  if (!description) {
    const m3 = html.match(/"shortDescription":"([\s\S]{1,4000}?)","/);
    if (m3) description = decodeEntities(m3[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
  }
  if (!title && !tracks.length) return null;
  return { title: title, channel: channel, duration: duration, description: description, tracks: tracks, playability: status };
}

async function fetchCaptionFromTracks(tracks) {
  const track = pickTrack(tracks);
  if (!track || !track.url) return null;
  const url = track.url + (track.url.indexOf('fmt=') === -1 ? '&fmt=json3' : '');
  const r = await fetchText(url, 6000);
  if (!r.ok || !r.text) return null;
  let segs = parseJson3(r.text);
  if (!segs.length) segs = parseTimedTextXml(r.text);
  if (!segs.length) return null;
  return { segments: segs, lang: track.lang, source: (track.auto ? '자동 생성 자막(ASR)' : '영상 자막') + ' · ' + track.lang };
}

async function fetchCaptionFromPiped(data) {
  const subs = (data && data.subtitles) || [];
  if (!subs.length) return null;
  const tracks = subs.map(function (s) {
    return { url: s.url, lang: s.code || '', auto: !!s.autoGenerated, name: s.name || s.code };
  });
  const track = pickTrack(tracks);
  if (!track || !track.url) return null;
  // Piped 는 ttml 로 내려준다
  const r = await fetchText(track.url, 6000, { Origin: 'https://piped.video' });
  if (!r.ok || !r.text) return null;
  let segs = parseTimedTextXml(r.text);
  if (!segs.length) segs = parseJson3(r.text);
  if (!segs.length) return null;
  return { segments: segs, lang: track.lang, source: (track.auto ? '자동 생성 자막(ASR)' : '영상 자막') + ' · ' + track.lang };
}

async function buildResponse(url, injectedTranscript) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    return { code: 400, body: { ok: false, reason: 'invalid_url', message: '유튜브 주소를 인식하지 못했습니다. watch / youtu.be / shorts 주소를 넣어 주세요.' } };
  }
  const canonical = 'https://www.youtube.com/watch?v=' + videoId;
  const sources = [];

  /* ---------- 1) 메타 수집(병렬) ---------- */
  const [oembed, piped, page] = await Promise.all([
    getOembed(videoId).catch(function () { return null; }),
    getPiped(videoId).catch(function () { return null; }),
    getWatchPage(videoId).catch(function () { return null; })
  ]);
  if (oembed && oembed.title) sources.push('oembed');
  if (piped) sources.push('piped:' + piped.host);
  if (page) sources.push('watch-page');

  const pdata = piped && piped.data ? piped.data : null;
  const title = (oembed && oembed.title) || (page && page.title) || (pdata && pdata.title) || '';
  const channel = (oembed && oembed.channel) || (page && page.channel) || (pdata && pdata.uploader) || '';
  const channelUrl = (oembed && oembed.channelUrl) || (pdata && pdata.uploaderUrl ? 'https://www.youtube.com' + pdata.uploaderUrl : '');
  const thumbnail = (oembed && oembed.thumbnail) || (pdata && pdata.thumbnailUrl) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const duration = Number((pdata && pdata.duration) || (page && page.duration) || 0);
  const description = (pdata && pdata.description) || (page && page.description) || '';

  const video = {
    id: videoId,
    url: canonical,
    title: title,
    channel: channel,
    channelUrl: channelUrl,
    thumbnail: thumbnail,
    duration: duration,
    description: description,
    fetchedAt: new Date().toISOString()
  };

  /* ---------- 2) 자막 ---------- */
  let caption = null;
  let captionReason = '';
  if (injectedTranscript && String(injectedTranscript).trim().length > 40) {
    caption = { segments: ENGINE.parseTranscript(injectedTranscript).segments, lang: 'input', source: '직접 입력한 자막' };
  } else {
    const fromPiped = await fetchCaptionFromPiped(pdata).catch(function () { return null; });
    if (fromPiped) caption = fromPiped;
    if (!caption && page && page.tracks && page.tracks.length) {
      caption = await fetchCaptionFromTracks(page.tracks).catch(function () { return null; });
    }
    if (!caption) {
      const play = page && page.playability;
      if (play && /LOGIN_REQUIRED|ERROR/.test(play)) captionReason = 'youtube_bot_block';
      else if (piped && pdata && !(pdata.subtitles || []).length) captionReason = 'no_captions';
      else captionReason = 'captions_unavailable';
    }
  }

  if (caption && caption.segments && caption.segments.length >= 3) {
    video.captionSource = caption.source;
    video.captionLang = caption.lang;
    const content = ENGINE.buildFromVideo({
      video: video,
      transcript: caption.segments.map(function (s) { return (s.t !== null && s.t !== undefined ? ENGINE.fmtTime(s.t) + ' ' : '') + s.text; }).join('\n')
    });
    return {
      code: 200,
      cache: 'public, s-maxage=600, stale-while-revalidate=1200',
      body: {
        ok: true,
        video: video,
        captions: {
          available: true,
          lang: caption.lang,
          source: caption.source,
          segments: caption.segments.length,
          chars: caption.segments.reduce(function (a, s) { return a + s.text.length; }, 0)
        },
        content: content,
        sources: sources
      }
    };
  }

  /* ---------- 3) 자막 없음 → 정직한 안내 (요약 지어내지 않음) ---------- */
  const reasonText = {
    youtube_bot_block: 'YouTube가 서버(데이터센터) IP의 자막 접근을 "봇 확인"으로 막았습니다.',
    no_captions: '이 영상에는 한국어/영어 자막이 없습니다(자막 비활성 영상).',
    captions_unavailable: '자막을 받아오지 못했습니다(자막 비활성 또는 일시 차단).'
  }[captionReason] || '자막을 받아오지 못했습니다.';

  return {
    code: 200,
    cache: 'no-store',
    body: {
      ok: true,
      video: video,
      captions: { available: false, reason: captionReason, message: reasonText },
      content: null,
      sources: sources,
      guide: {
        title: '자막을 붙여넣으면 같은 결과가 나옵니다',
        steps: [
          'PC·모바일 웹에서 영상 열기 → 설명란 아래 "스크립트 표시" 클릭',
          '"스크립트 표시"가 없으면 영상에 자막이 없는 경우입니다(이때는 요약을 만들 수 없습니다)',
          '스크립트 전체를 선택해 복사 → 이 페이지의 "자막 붙여넣기"에 그대로 붙여넣기',
          '자막 파일(.srt/.vtt)이 있으면 파일 선택으로 올려도 됩니다'
        ]
      }
    }
  };
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
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.end();
  }

  const parsedUrl = new URL(req.url || '/api/content-studio', 'http://localhost');
  const wantsGenerate = parsedUrl.searchParams.has('mode') &&
    !parsedUrl.searchParams.has('url') && !parsedUrl.searchParams.has('v');

  try {
    if (wantsGenerate) return await handleGenerate(req, res, parsedUrl);
    return await handleYoutube(req, res);
  } catch (e) {
    return sendJson(res, 500, { ok: false, reason: 'server_error', message: String((e && e.message) || e) });
  }
};

/* ============================================================
 * 2) 원고 생성 (mode=stock|deals|topic)
 * ============================================================ */
async function handleGenerate(req, res, parsedUrl) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  const mode = String(parsedUrl.searchParams.get('mode') || 'stock').toLowerCase();
  const withMd = parsedUrl.searchParams.get('format') === 'md';

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
      keyword: parsedUrl.searchParams.get('keyword') || '',
      memo: parsedUrl.searchParams.get('memo') || '',
      template: parsedUrl.searchParams.get('template') || 'info'
    });
    if (!content) return sendJson(res, 400, { ok: false, reason: 'missing_keyword' });
  } else {
    return sendJson(res, 400, {
      ok: false, reason: 'unknown_mode', modes: ['stock', 'deals', 'topic'],
      hint: '유튜브 요약은 ?url=<유튜브 주소> 로 호출하세요.'
    });
  }

  const body = {
    ok: true,
    mode: mode,
    generatedAt: content.generatedAt,
    engine: content.engine,
    headline: content.headline,
    subline: content.subline,
    source: content.source,
    summary: content.summary,
    facts: content.facts,
    notices: content.notices,
    titleSet: content.blog.titleSet,
    blog: {
      titles: content.blog.titles,
      hook: content.blog.hook,
      sections: content.blog.sections,
      points: content.blog.points,
      closing: content.blog.closing,
      cta: content.blog.cta,
      metaDesc: content.blog.metaDesc,
      tags: content.blog.tags,
      markdown: withMd ? content.blog.markdown : undefined,
      markdownLength: content.blog.markdown.length,
      html: parsedUrl.searchParams.get('format') === 'html' ? ENGINE.contentToHtml(content, {}) : undefined
    },
    shorts: content.shorts,
    shortsJson: content.shorts.json
  };
  return sendJson(res, 200, body, 'public, s-maxage=60, stale-while-revalidate=120');
}

/* ============================================================
 * 1) 유튜브 요약 — 원래 핸들러 본문
 * ============================================================ */
async function handleYoutube(req, res) {
  let url = '';
  let transcript = '';
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
    url = body.url || body.videoUrl || '';
    transcript = body.transcript || '';
  } else if (req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    url = u.searchParams.get('url') || u.searchParams.get('v') || '';
    transcript = u.searchParams.get('transcript') || '';
  } else {
    return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  }
  if (!url) return sendJson(res, 400, { ok: false, reason: 'missing_url', message: 'url 파라미터가 필요합니다.' });

  const out = await buildResponse(url, transcript);
  return sendJson(res, out.code, out.body, out.cache);
}
