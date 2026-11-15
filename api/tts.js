'use strict';

/**
 * GET /api/tts?lang=ko|en&text=사자&speed=0.9
 *  - 모바일·태블릿·인앱 브라우저에서 window.speechSynthesis 가 막히거나 소리가 나지 않는 경우를 위해
 *    서버가 MP3를 대신 받아 클라이언트가 <audio> 로 재생할 수 있게 한다.
 *  - lang: ko(기본) | en, text: 최대 120자.
 *  - speed: 0.5~1.0 (생략 시 1). eBook 이 화자 힌트(아이/여성/남성/노인)에 따라 낭독 호흡을
 *    구분할 때 쓴다 — 0.86 이면 눈에 띄게 느리고 묵직하게, 1.0 이면 보통 속도.
 *  - 실패하면 JSON({ ok:false, reason }) → 클라이언트는 기기 음성(speechSynthesis)으로 폴백한다.
 */

const MAX_LEN = 120;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const LANGS = { ko: 'ko', en: 'en' };

function sendJson(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
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
  const lang = LANGS[String(url.searchParams.get('lang') || 'ko').toLowerCase()] || 'ko';
  const text = String(url.searchParams.get('text') || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
  if (!text) return sendJson(res, 400, { ok: false, reason: 'missing_text' });

  /* 화자 힌트에 따른 낭독 속도 — 생략하면 예전과 완전히 동일하게 동작한다 */
  const rawSpeed = Number(url.searchParams.get('speed'));
  const speed = isFinite(rawSpeed) && rawSpeed > 0 ? Math.min(1, Math.max(0.5, rawSpeed)) : 1;
  const speedQ = speed < 0.999 ? `&ttsspeed=${speed.toFixed(2)}` : '';

  const target = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(text)}${speedQ}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const upstream = await fetch(target, {
      headers: {
        'User-Agent': UA,
        Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
        'Accept-Language': lang === 'en' ? 'en-US,en;q=0.9' : 'ko-KR,ko;q=0.9',
        Referer: 'https://translate.google.com/',
      },
      signal: ctl.signal,
    });
    if (!upstream.ok) {
      clearTimeout(timer);
      return sendJson(res, 502, { ok: false, reason: 'upstream_' + upstream.status });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    clearTimeout(timer);
    if (buf.length < 500) return sendJson(res, 502, { ok: false, reason: 'empty_audio' });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(buf);
  } catch (e) {
    clearTimeout(timer);
    return sendJson(res, 502, { ok: false, reason: 'upstream_error', message: String((e && e.message) || e) });
  }
};
