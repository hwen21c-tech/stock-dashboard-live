'use strict';

/**
 * /api/tts — 성우 엔진 (무료 Edge TTS + 기존 Google TTS 하위 호환)
 *
 *  1) GET  /api/tts?voices=1
 *       → { ok:true, updated, voices:[{id,name,gender,locale,engine,tags}], presets:[...] }
 *       키 없이 쓸 수 있는 한국어(ko-KR) 무료 성우 전체 목록.
 *
 *  2) GET  /api/tts?text=안녕&voice=ko-KR-SunHiNeural&rate=+12%25&pitch=+2Hz
 *     POST /api/tts  { text, voice, rate, pitch }        (Content-Type: application/json)
 *       → audio/mpeg (MP3 바이너리)
 *
 *  3) GET  /api/tts?lang=ko|en&text=...&speed=0.5~1     ← eBook 이 쓰던 예전 방식 그대로
 *       → Google 번역 TTS 로 MP3 (하위 호환, voice 파라미터가 없을 때만 동작)
 *
 *  Edge TTS 는 마이크로소프트의 무료 신경망 성우(Read Aloud) 프로토콜을 직접 말한다.
 *  npm 의존성 없이 TLS 위에서 WebSocket 프레임을 직접 주고받으므로 Vercel 빌드가 가볍다.
 *  실패하면 JSON({ ok:false, reason }) 을 돌려주고, 클라이언트는 기기 음성으로 폴백한다.
 */

const https = require('https');
const crypto = require('crypto');
const { secMsGec } = require('../lib/edge-drm');

const MAX_LEN = 2000;

/* ------------------------------------------------------------------ */
/* 성우 목록                                                            */
/* ------------------------------------------------------------------ */

/* Edge TTS 가 실제로 소리를 내는 한국어 성우 — 2026-11-20 실측 검증 완료.
   (ko-KR-BongJin·GookMin·JiMin·SeoHyeon·SoonBok·YuJin 등은 목록에서 이미 빠져 있어 넣지 않는다) */
const KO_VOICES = [
  {
    id: 'ko-KR-SunHiNeural', name: '선히 (SunHi)', gender: 'Female', locale: 'ko-KR',
    desc: '맑고 밝은 여성 · 쇼핑·릴스에 잘 맞음', tags: ['여성', '밝은 톤']
  },
  {
    id: 'ko-KR-InJoonNeural', name: '인준 (InJoon)', gender: 'Male', locale: 'ko-KR',
    desc: '차분하고 안정적인 남성 · 시황·정보 전달', tags: ['남성', '차분']
  },
  {
    id: 'ko-KR-HyunsuMultilingualNeural', name: '현수 (Hyunsu Multilingual)', gender: 'Male', locale: 'ko-KR',
    desc: '또렷한 남성 · 다국어 지원', tags: ['남성', '또렷']
  }
];

/* 어제 쇼핑 쇼츠 v2 와 같은 톤 — SunHi + 속도 +12% + 피치 +2Hz */
const PRESETS = [
  {
    id: 'sunhi-bright', voice: 'ko-KR-SunHiNeural', rate: '+12%', pitch: '+2Hz',
    name: '선히 · 릴스·쇼핑 밝은 톤 (속도 +12% · 피치 +2Hz)',
    desc: '어제 쇼핑 쇼츠 v2 와 같은 목소리 톤'
  }
];

/* ------------------------------------------------------------------ */
/* Edge TTS 프로토콜 상수                                               */
/* ------------------------------------------------------------------ */

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WS_HOST = 'speech.platform.bing.com';
const WS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const SEC_MS_GEC_VERSION = '2-143.0.3650.75';
const CHROMIUM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

function nowStamp() {
  const d = new Date();
  const p = (n) => ('0' + n).slice(-2);
  return (
    d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + 'T' +
    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + 'Z'
  );
}

/* ------------------------------------------------------------------ */
/* 최소 WebSocket 클라이언트 (텍스트/바이너리 프레임 · 핑 · 조각)          */
/* ------------------------------------------------------------------ */

function wsFrame(payload, opcode) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
    crypto.randomBytes(4).copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    crypto.randomBytes(4).copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    crypto.randomBytes(4).copy(header, 10);
  }
  const mask = header.slice(header.length - 4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, body]);
}

/* Edge TTS WebSocket 세션 */
function edgeSession({ voice, text, rate, pitch, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const url =
      'wss://' + WS_HOST + WS_PATH +
      '?TrustedClientToken=' + TRUSTED_TOKEN +
      '&Sec-MS-GEC=' + secMsGec() +
      '&Sec-MS-GEC-Version=' + encodeURIComponent(SEC_MS_GEC_VERSION) +
      '&ConnectionId=' + crypto.randomUUID().replace(/-/g, '');

    const req = https.request({
      host: WS_HOST,
      path: WS_PATH + url.slice(url.indexOf('?')),
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'User-Agent': CHROMIUM_UA,
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-CH-UA': '"Not;A Brand";v="99", "Microsoft Edge";v="143", "Chromium";v="143"',
        'Sec-CH-UA-Mobile': '?0',
        Cookie: 'muid=' + crypto.randomBytes(16).toString('hex').toUpperCase() + ';'
      }
    });

    let settled = false;
    const done = (err, buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.destroy(); } catch (e) {}
      if (err) reject(err); else resolve(buf);
    };
    const timer = setTimeout(() => done(new Error('edge_timeout')), timeoutMs || 20000);

    req.on('error', (e) => done(new Error('edge_socket:' + (e && e.message))));
    req.on('response', (res) => done(new Error('edge_handshake_' + res.statusCode)));

    req.on('upgrade', (res, socket, head) => {
      let chunkBuf = Buffer.alloc(0);
      const audio = [];
      let pending = null;      /* 조각(fragment) 이어붙이기 */
      let pendingOp = 0;

      const send = (payload, opcode) => {
        try { socket.write(wsFrame(payload, opcode)); } catch (e) { done(new Error('edge_write:' + e.message)); }
      };

      const onMessage = (data, opcode) => {
        if (opcode === 0x1) {
          const txt = data.toString('utf8');
          if (/Path:\s*turn\.end/i.test(txt)) {
            done(null, Buffer.concat(audio));
          }
          return;
        }
        if (opcode === 0x2) {
          if (data.length < 2) return;
          const headerLen = data.readUInt16BE(0);
          if (data.length < 2 + headerLen) return;
          const header = data.slice(2, 2 + headerLen).toString('utf8');
          if (/Path:\s*audio/i.test(header)) audio.push(data.slice(2 + headerLen));
        }
      };

      const parse = () => {
        while (chunkBuf.length >= 2) {
          const b0 = chunkBuf[0], b1 = chunkBuf[1];
          const fin = (b0 & 0x80) !== 0;
          const opcode = b0 & 0x0f;
          const masked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let off = 2;
          if (len === 126) {
            if (chunkBuf.length < 4) return;
            len = chunkBuf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (chunkBuf.length < 10) return;
            len = Number(chunkBuf.readBigUInt64BE(2));
            off = 10;
          }
          let maskKey = null;
          if (masked) {
            if (chunkBuf.length < off + 4) return;
            maskKey = chunkBuf.slice(off, off + 4);
            off += 4;
          }
          if (chunkBuf.length < off + len) return;
          let payload = chunkBuf.slice(off, off + len);
          if (maskKey) {
            const un = Buffer.alloc(len);
            for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i & 3];
            payload = un;
          }
          chunkBuf = chunkBuf.slice(off + len);
          if (opcode === 0x8) { done(new Error('edge_closed')); return; }
          if (opcode === 0x9) { send(payload, 0xa); continue; }   /* ping → pong */
          if (opcode === 0xa) continue;
          if (opcode === 0x0) {                                   /* continuation */
            if (pending) pending.push(payload);
            if (fin && pending) {
              const full = Buffer.concat(pending);
              const op = pendingOp;
              pending = null; pendingOp = 0;
              onMessage(full, op);
            }
            continue;
          }
          if (!fin) { pending = [payload]; pendingOp = opcode; continue; }
          onMessage(payload, opcode);
        }
      };

      socket.on('data', (d) => {
        chunkBuf = Buffer.concat([chunkBuf, d]);
        try { parse(); } catch (e) { done(new Error('edge_parse:' + e.message)); }
      });
      socket.on('error', (e) => done(new Error('edge_stream:' + (e && e.message))));
      socket.on('close', () => done(new Error('edge_stream_closed')));
      if (head && head.length) { chunkBuf = Buffer.concat([chunkBuf, head]); try { parse(); } catch (e) {} }

      /* 1) speech.config */
      const cfg =
        'X-Timestamp:' + nowStamp() + '\r\n' +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
              }
            }
          }
        });
      send(cfg, 0x1);

      /* 2) ssml */
      const safe = String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
      const ssml =
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ko-KR'>" +
        "<voice name='" + voice + "'><prosody pitch='" + (pitch || '+0Hz') +
        "' rate='" + (rate || '+0%') + "' volume='+0%'>" + safe + '</prosody></voice></speak>';
      const msg =
        'X-RequestId:' + crypto.randomUUID().replace(/-/g, '') + '\r\n' +
        'Content-Type:application/ssml+xml\r\n' +
        'X-Timestamp:' + nowStamp() + '\r\n' +
        'Path:ssml\r\n\r\n' + ssml;
      send(msg, 0x1);
    });
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* Google TTS (하위 호환 — eBook 등 기존 호출)                          */
/* ------------------------------------------------------------------ */

const GOOGLE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function googleTts(lang, text, speed) {
  const speedQ = speed < 0.999 ? '&ttsspeed=' + speed.toFixed(2) : '';
  const target =
    'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' + lang +
    '&q=' + encodeURIComponent(text) + speedQ;
  return new Promise((resolve, reject) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const https2 = require('https');
    const req = https2.get(target, {
      headers: {
        'User-Agent': GOOGLE_UA,
        Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
        'Accept-Language': lang === 'en' ? 'en-US,en;q=0.9' : 'ko-KR,ko;q=0.9',
        Referer: 'https://translate.google.com/'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        res.resume();
        return reject(new Error('upstream_' + res.statusCode));
      }
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(parts)); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    ctl.signal.addEventListener('abort', () => { try { req.destroy(); } catch (e) {} });
  });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function cors(res, methods) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods || 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  cors(res);
  res.end(JSON.stringify(body));
}

function sendMp3(res, buf) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'public, max-age=86400');
  cors(res);
  res.end(buf);
}

function normRate(v, legacySpeed) {
  if (v == null || v === '') {
    if (legacySpeed == null) return '+0%';
    const pct = Math.round((legacySpeed - 1) * 100);
    return (pct >= 0 ? '+' : '') + pct + '%';
  }
  const s = String(v).trim();
  if (/%$/.test(s)) return s;
  const n = Number(s);
  if (isFinite(n)) {
    const pct = Math.round((n - 1) * 100);
    return (pct >= 0 ? '+' : '') + pct + '%';
  }
  return '+0%';
}

function normPitch(v) {
  if (v == null || v === '') return '+0Hz';
  const s = String(v).trim();
  if (/hz$/i.test(s)) return s;
  const n = Number(s);
  if (isFinite(n)) return (n >= 0 ? '+' : '') + n + 'Hz';
  return '+0Hz';
}

function knownVoice(id) {
  for (let i = 0; i < KO_VOICES.length; i++) if (KO_VOICES[i].id === id) return KO_VOICES[i];
  return null;
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') {
      try { return resolve(JSON.parse(req.body)); } catch (e) { return resolve({}); }
    }
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 200000) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    cors(res);
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  }

  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;

  /* ---------- 1) 성우 목록 ---------- */
  if (q.get('voices') || q.get('list')) {
    return sendJson(res, 200, {
      ok: true,
      engine: 'edge',
      updated: '2026-11-20',
      note: '키 없이 무제한 · 마이크로소프트 Edge 신경망 성우(ko-KR) 실측 검증분',
      voices: KO_VOICES.map((v) => ({
        id: v.id, name: v.name, gender: v.gender, locale: v.locale,
        engine: 'edge', desc: v.desc, tags: v.tags
      })),
      presets: PRESETS.map((p) => ({
        id: p.id, voice: p.voice, rate: p.rate, pitch: p.pitch,
        name: p.name, desc: p.desc, engine: 'edge'
      }))
    });
  }

  /* ---------- 요청 파라미터 ---------- */
  let text = '';
  let voice = '';
  let rate = '';
  let pitch = '';
  let lang = '';
  let speed = null;

  if (req.method === 'POST') {
    const body = await readBody(req);
    text = String(body.text || body.q || '');
    voice = String(body.voice || body.voiceId || '');
    rate = body.rate == null ? '' : String(body.rate);
    pitch = body.pitch == null ? '' : String(body.pitch);
    lang = String(body.lang || '');
    if (body.speed != null) speed = Number(body.speed);
  } else {
    text = String(q.get('text') || q.get('q') || '');
    voice = String(q.get('voice') || '');
    rate = q.get('rate') == null ? '' : String(q.get('rate'));
    pitch = q.get('pitch') == null ? '' : String(q.get('pitch'));
    lang = String(q.get('lang') || '');
    if (q.get('speed') != null) speed = Number(q.get('speed'));
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return sendJson(res, 400, { ok: false, reason: 'missing_text' });

  /* ---------- 3) 예전 호출(voice 없음 + lang) → Google TTS 그대로 ---------- */
  if (!voice && lang) {
    const lg = String(lang).toLowerCase().indexOf('en') === 0 ? 'en' : 'ko';
    const small = text.slice(0, 120);
    const sp = isFinite(speed) && speed > 0 ? Math.min(1, Math.max(0.5, speed)) : 1;
    try {
      const buf = await googleTts(lg, small, sp);
      if (!buf || buf.length < 500) return sendJson(res, 502, { ok: false, reason: 'empty_audio' });
      return sendMp3(res, buf);
    } catch (e) {
      return sendJson(res, 502, { ok: false, reason: 'upstream_error', message: String((e && e.message) || e) });
    }
  }

  /* ---------- 2) Edge TTS ---------- */
  const vid = voice || 'ko-KR-SunHiNeural';
  if (!/^ko-KR-[A-Za-z]+Neural$/.test(vid)) {
    return sendJson(res, 400, { ok: false, reason: 'unsupported_voice', voice: vid });
  }
  const meta = knownVoice(vid);
  if (!meta && !/^ko-KR-/.test(vid)) {
    return sendJson(res, 400, { ok: false, reason: 'unsupported_voice', voice: vid });
  }

  const cut = text.slice(0, MAX_LEN);
  /* Edge TTS 는 한 번에 대략 3,000자까지 안정적이지만 응답 지연을 줄이려 2,000자로 자른다 */
  try {
    const buf = await edgeSession({
      voice: vid,
      text: cut,
      rate: normRate(rate, speed),
      pitch: normPitch(pitch),
      timeoutMs: 25000
    });
    if (!buf || buf.length < 800) {
      return sendJson(res, 502, { ok: false, reason: 'empty_audio', bytes: buf ? buf.length : 0, voice: vid });
    }
    res.setHeader('X-TTS-Voice', vid);
    res.setHeader('X-TTS-Chars', String(Array.from(cut).length));
    return sendMp3(res, buf);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (process.env.TTS_DEBUG) res.setHeader('X-TTS-Err', encodeURIComponent(msg).slice(0, 300));
    /* Edge 가 막히면 예전 Google 음성으로라도 소리를 내준다(무음보다 낫다) */
    try {
      const buf = await googleTts('ko', cut.slice(0, 120), 1);
      if (buf && buf.length >= 500) {
        res.setHeader('X-TTS-Fallback', 'google');
        return sendMp3(res, buf);
      }
    } catch (e2) { /* 무시 */ }
    return sendJson(res, 502, { ok: false, reason: 'edge_error', message: msg, voice: vid });
  }
};

module.exports.KO_VOICES = KO_VOICES;
