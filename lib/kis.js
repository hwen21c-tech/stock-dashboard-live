'use strict';

/**
 * 한국투자증권(KIS) 공식 오픈API 공용 모듈
 * ----------------------------------------------------------------------------
 *  · 실전 도메인: https://openapi.koreainvestment.com:9443 (모의: openapivts:29443)
 *  · 접근토큰: POST /oauth2/tokenP {grant_type:'client_credentials', appkey, appsecret}
 *      - 유효 24시간, **발급 자체가 1분 1회 제한(EGW00133)**
 *      - 6시간 안에 다시 요청하면 같은 토큰이 그대로 온다(발급 알림도 다시 감)
 *      - 새로 발급하면 돌아가던 쪽 토큰이 죽는 사례가 있어 재사용이 원칙
 *    → 3중 캐시로 재발급을 최소화한다.
 *        ① 인스턴스 메모리 (웜 상태, TTL 22시간)
 *        ② Supabase family_sync[kis_token_cache_v1] — 콜드스타트 공용 캐시
 *           (테이블이 anon 키로 읽히므로 토큰은 **AES-256-GCM 암호화**해서만 저장)
 *        ③ 발급 1분 락(lastAttemptAt) — 여러 인스턴스가 동시에 찔러 EGW00133 나는 것 방지
 *
 *  · 시세: /uapi/domestic-stock/v1/quotations/inquire-price  (tr_id FHKST01010100)
 *  · 수급: /uapi/domestic-stock/v1/quotations/inquire-investor (tr_id FHKST01010900)
 *  · 장중 기관·외국인 가집계: /uapi/domestic-stock/v1/quotations/foreign-institution-total (tr_id FHPTJ04400000)
 *
 *  ⚠️ 이 모듈은 KIS_APP_KEY / KIS_APP_SECRET / 토큰 원문을 응답·로그·에러 메시지에
 *     절대 담지 않는다. 진단용으로는 앱키의 SHA-256 앞 12자리(kid)만 쓴다.
 */

const crypto = require('crypto');

const BASE_URL = (process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443').replace(/\/+$/, '');
// 이 모듈의 판올림 표시 — 배포 후 /api/stock-live?kis_test=1 의 libVersion 으로 어느 버전이 돌고 있는지 확인한다
const LIB_VERSION = '2026-11-24.3';
const APP_KEY = (process.env.KIS_APP_KEY || '').trim();
const APP_SECRET = (process.env.KIS_APP_SECRET || '').trim();
const CUSTTYPE = (process.env.KIS_CUSTTYPE || 'P').trim();

const TOKEN_TTL_MS = 24 * 3600 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 2 * 3600 * 1000; // 만료 2시간 전부터 갱신
const TOKEN_MIN_GAP_MS = 62 * 1000; // KIS 토큰 발급 제한: 1분 1회
const TOKEN_RETRY_SLEEP_MS = 1200;
const TOKEN_RETRY_READS = 2;

const CACHE_CODE = process.env.KIS_CACHE_CODE || 'kis_token_cache_v1';
const CACHE_VERSION = 1;
const SB_TIMEOUT_MS = 2500;

const REQ_TIMEOUT_MS = 6000;
// 실전 초당 호출 제한(20건/초)을 넘지 않도록 호출 시작 간격을 띄운다.
// 여러 화면이 동시에 stock-live 를 때려도 한 인스턴스 안에서는 14건/초를 넘지 않는다.
const MIN_GAP_BETWEEN_CALLS_MS = 70;
const RATE_RETRY_WAIT_MS = 400;

// Supabase anon(공개) 키 — 테이블은 공개 읽기/쓰기, 토큰은 암호화 저장이라 키 자체는 비밀이 아니다.
const SB = {
  url: (process.env.SUPABASE_URL || 'https://hiruybkapzuhjrzjoyik.supabase.co').replace(/\/+$/, ''),
  key: process.env.SUPABASE_ANON_KEY || 'sb_publishable_e5JJbvCPDhY91uXaUEVNVA_8Byv_gI8',
};

const isConfigured = () => Boolean(APP_KEY && APP_SECRET);

/* ------------------------------------------------------------------ */
/* 오류 타입                                                            */
/* ------------------------------------------------------------------ */
class KisError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'KisError';
    this.code = extra.code || 'KIS_ERROR';
    this.msgCd = extra.msgCd || null;
    this.msg1 = extra.msg1 || null;
    this.httpStatus = extra.httpStatus || null;
    this.stage = extra.stage || null;
  }
}

/* ------------------------------------------------------------------ */
/* 공용 유틸                                                            */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,\s]/g, '');
  if (!s || s === '-' || s === 'N/A') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = toNum(v);
  return n === null ? null : Math.round(n);
}

/** 앱키 자체는 감추고, 바뀌었는지만 판별할 수 있는 짧은 지문 */
function appKeyKid() {
  if (!APP_KEY) return null;
  return crypto.createHash('sha256').update('kis-appkey:' + APP_KEY).digest('hex').slice(0, 12);
}

function secretFingerprint() {
  if (!APP_SECRET) return null;
  return crypto.createHash('sha256').update('kis-appsecret:' + APP_SECRET).digest('hex').slice(0, 12);
}

/** 공유 캐시용 대칭키 — APP_SECRET에서 HKDF로 유도(비밀값은 저장하지 않는다) */
function cacheKey() {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(APP_SECRET, 'utf8'), Buffer.from('kis-token-cache-v1'), Buffer.from('aes-256-gcm'), 32),
  );
}

function encryptToken(plain, kid) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cacheKey(), iv);
  cipher.setAAD(Buffer.from(String(kid || '') + '|' + CACHE_VERSION, 'utf8'));
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return { enc: enc.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptToken(doc) {
  if (!doc || !doc.enc || !doc.iv || !doc.tag) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', cacheKey(), Buffer.from(doc.iv, 'base64'));
    decipher.setAAD(Buffer.from(String(doc.kid || '') + '|' + CACHE_VERSION, 'utf8'));
    decipher.setAuthTag(Buffer.from(doc.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(doc.enc, 'base64')), decipher.final()]).toString('utf8');
    return plain || null;
  } catch (_) {
    return null; // 키가 바뀌었거나 손상 → 새로 발급
  }
}

/** KIS 만료 표기("2026-08-10 09:14:22", KST) 파싱 */
function parseTokenExpiry(raw, fallbackMs) {
  if (raw && typeof raw === 'string') {
    const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`);
      if (Number.isFinite(t)) return t;
    }
  }
  return fallbackMs;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                 */
/* ------------------------------------------------------------------ */
async function rawRequest(url, { method = 'GET', headers = {}, body = null, timeout = REQ_TIMEOUT_MS } = {}) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Supabase 공용 캐시                                                   */
/* ------------------------------------------------------------------ */
async function readSharedCache() {
  if (!SB.url || !SB.key) return null;
  const url = `${SB.url}/rest/v1/family_sync?code=eq.${encodeURIComponent(CACHE_CODE)}&select=data,updated_at`;
  try {
    const r = await rawRequest(url, {
      headers: { apikey: SB.key, Authorization: 'Bearer ' + SB.key, Accept: 'application/json' },
      timeout: SB_TIMEOUT_MS,
    });
    if (!r.ok || !Array.isArray(r.json) || !r.json.length) return null;
    const data = r.json[0] && r.json[0].data;
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

async function writeSharedCache(data) {
  if (!SB.url || !SB.key) return false;
  const url = `${SB.url}/rest/v1/family_sync?on_conflict=code`;
  const row = [{ code: CACHE_CODE, data, updated_at: new Date().toISOString() }];
  try {
    const r = await rawRequest(url, {
      method: 'POST',
      headers: {
        apikey: SB.key,
        Authorization: 'Bearer ' + SB.key,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
      timeout: SB_TIMEOUT_MS,
    });
    return r.ok;
  } catch (_) {
    return false;
  }
}

/** 공유 캐시 문서 → {token, issuedAt, expiresAt} (없거나 우리 앱키 것이 아니면 null) */
function tokenFromDoc(doc) {
  if (!doc || !doc.enc || doc.kid !== appKeyKid()) return null;
  const token = decryptToken(doc);
  if (!token) return null;
  const expiresAt = Number(doc.expiresAt);
  if (!Number.isFinite(expiresAt)) return null;
  return {
    token,
    issuedAt: Number.isFinite(Number(doc.issuedAt)) ? Number(doc.issuedAt) : null,
    expiresAt,
  };
}

/* ------------------------------------------------------------------ */
/* 토큰                                                                 */
/* ------------------------------------------------------------------ */
let memToken = null; // { token, issuedAt, expiresAt }
let memTokenOfKid = null;
let lastCallAt = 0;
let lastTokenError = null; // 진단용(비밀값 없음)
let rateTail = Promise.resolve();   // 호출 간격 보장용 순서표(2026-11-27)

/* 호출 간격(MIN_GAP_BETWEEN_CALLS_MS)을 **줄을 세워** 지킨다.
 *  · 예전에는 동시에 들어온 호출이 모두 같은 시각을 계산해 한꺼번에 나갔다 →
 *    KIS 초당 한도를 넘겨 EGW00201 이 나고, 부른 쪽은 400ms 재시도로 응답이 몇 초씩 늘었다
 *    (2026-11-27 관제탑 콜드 응답 10~15초의 한 원인).
 *  · 이제는 앞 호출이 나간 시각을 기준으로 다음 호출을 예약하므로 동시 호출도 70ms 간격을 지킨다
 *    (초당 약 14건 — 계정 한도 20건 안). 요청 자체는 겹쳐서 나가므로 대기는 짧다. */
async function throttle() {
  const next = rateTail.then(async () => {
    const wait = lastCallAt + MIN_GAP_BETWEEN_CALLS_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
  });
  rateTail = next.catch(() => {});
  await next;
}

async function issueToken(reason) {
  const startedAt = Date.now();
  await throttle();
  let r;
  try {
    r = await rawRequest(`${BASE_URL}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', Accept: 'text/plain' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: APP_KEY, appsecret: APP_SECRET }),
      timeout: 10000,
    });
  } catch (e) {
    lastTokenError = { at: new Date().toISOString(), stage: 'network', message: String((e && e.message) || e) };
    throw new KisError('KIS 토큰 발급 요청이 네트워크에서 실패했습니다.', {
      code: 'KIS_TOKEN_NETWORK',
      stage: 'token',
    });
  }

  const j = r.json || {};
  if (!r.ok || !j.access_token) {
    const msgCd = j.msg_cd || null;
    const msg1 = j.msg1 || j.error_description || null;
    lastTokenError = { at: new Date().toISOString(), stage: 'token', status: r.status, msgCd, msg1 };
    const isRate = msgCd === 'EGW00133' || /1분|1 minute|발급\s*제한|rate/i.test(String(msg1 || ''));
    throw new KisError(
      isRate
        ? 'KIS 접근토큰 발급 제한(1분 1회)에 걸렸습니다. 잠시 뒤 재사용 캐시로 재시도합니다.'
        : `KIS 토큰 발급 실패 (HTTP ${r.status}${msgCd ? ' · ' + msgCd : ''})`,
      { code: isRate ? 'KIS_TOKEN_RATE' : 'KIS_TOKEN_HTTP', msgCd, msg1, httpStatus: r.status, stage: 'token' },
    );
  }

  const issuedAt = Date.now();
  const fallbackExpiry = issuedAt + (Number(j.expires_in) > 0 ? Number(j.expires_in) * 1000 : TOKEN_TTL_MS);
  const expiresAt = parseTokenExpiry(j.access_token_token_expired, fallbackExpiry);
  lastTokenError = null;

  const rec = { token: j.access_token, issuedAt, expiresAt };
  memToken = rec;
  memTokenOfKid = appKeyKid();

  const prev = (await readSharedCache()) || {};
  await writeSharedCache({
    v: CACHE_VERSION,
    kid: appKeyKid(),
    ...encryptToken(rec.token, appKeyKid()),
    issuedAt,
    expiresAt,
    tokenExpiredRaw: j.access_token_token_expired || null,
    lastAttemptAt: issuedAt,
    lastIssuedAt: issuedAt,
    lastIssueElapsedMs: Date.now() - startedAt,
    lastIssueReason: reason || null,
  });

  return { ...rec, via: 'issued' };
}

/**
 * 접근토큰 (재사용 우선)
 * @returns {Promise<{token:string, issuedAt:number|null, expiresAt:number, via:string}>}
 */
async function getKisToken(opts = {}) {
  if (!isConfigured()) {
    throw new KisError('KIS_APP_KEY / KIS_APP_SECRET 환경변수가 없습니다.', {
      code: 'KIS_NOT_CONFIGURED',
      stage: 'config',
    });
  }

  const now = Date.now();
  if (!opts.force && memToken && memTokenOfKid === appKeyKid() && memToken.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
    return { ...memToken, via: 'memory' };
  }

  // ② 공용 캐시 (force=true 는 '이 토큰이 거부됐다'는 뜻이므로 재사용하지 않는다)
  let doc = await readSharedCache();
  let cached = tokenFromDoc(doc);
  if (!opts.force && cached && cached.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
    memToken = cached;
    memTokenOfKid = appKeyKid();
    return { ...cached, via: 'supabase' };
  }

  // ③ 다른 인스턴스가 방금 발급을 시도했다면 잠깐 기다렸다가 그 결과를 재사용한다
  const lastAttemptAt = doc && Number(doc.lastAttemptAt);
  if (!opts.force && Number.isFinite(lastAttemptAt) && now - lastAttemptAt < TOKEN_MIN_GAP_MS) {
    const waitMs = Math.max(TOKEN_RETRY_SLEEP_MS, TOKEN_MIN_GAP_MS - (now - lastAttemptAt));
    await sleep(Math.min(waitMs, 3000));
    doc = await readSharedCache();
    cached = tokenFromDoc(doc);
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      memToken = cached;
      memTokenOfKid = appKeyKid();
      return { ...cached, via: 'supabase-wait' };
    }
  }

  // ④ 발급 — 1분 락을 먼저 남겨 다른 인스턴스가 곧바로 겹쳐 찌르지 않게 한다
  await writeSharedCache({
    v: CACHE_VERSION,
    kid: appKeyKid(),
    ...(doc && doc.enc && doc.kid === appKeyKid()
      ? { enc: doc.enc, iv: doc.iv, tag: doc.tag, issuedAt: doc.issuedAt, expiresAt: doc.expiresAt, tokenExpiredRaw: doc.tokenExpiredRaw }
      : {}),
    lastAttemptAt: Date.now(),
    lastIssuedAt: doc && Number.isFinite(Number(doc.lastIssuedAt)) ? Number(doc.lastIssuedAt) : null,
  });

  try {
    return await issueToken(opts.reason || 'miss');
  } catch (e) {
    if (e && e.code === 'KIS_TOKEN_RATE') {
      // 다른 인스턴스가 방금 발급했을 수 있다 → 잠깐 기다려 재사용
      for (let i = 0; i < TOKEN_RETRY_READS; i++) {
        await sleep(TOKEN_RETRY_SLEEP_MS);
        cached = tokenFromDoc(await readSharedCache());
        if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
          memToken = cached;
          memTokenOfKid = appKeyKid();
          return { ...cached, via: 'supabase-after-rate' };
        }
      }
    }
    // 발급이 막혀도 아직 살아 있는 토큰이 캐시에 있으면 그걸 쓴다(만료 임박이어도 시도는 해 본다)
    const stale = tokenFromDoc(doc) || cached;
    if (stale && stale.expiresAt > Date.now()) {
      memToken = stale;
      memTokenOfKid = appKeyKid();
      return { ...stale, via: 'supabase-near-expiry' };
    }
    throw e;
  }
}

function invalidateToken() {
  memToken = null;
  memTokenOfKid = null;
}

/* ------------------------------------------------------------------ */
/* 시세·수급                                                            */
/* ------------------------------------------------------------------ */
function baseHeaders(trId, token) {
  return {
    'content-type': 'application/json; charset=utf-8',
    Accept: 'application/json',
    authorization: 'Bearer ' + token,
    appkey: APP_KEY,
    appsecret: APP_SECRET,
    tr_id: trId,
    custtype: CUSTTYPE,
  };
}

async function kisGet(path, trId, params, { retryOnAuth = true, timeout = REQ_TIMEOUT_MS } = {}) {
  const tokenRec = await getKisToken();
  const qs = new URLSearchParams(params).toString();
  await throttle();

  let r;
  try {
    r = await rawRequest(`${BASE_URL}${path}?${qs}`, { headers: baseHeaders(trId, tokenRec.token), timeout });
  } catch (e) {
    throw new KisError('KIS 서버에 연결하지 못했습니다.', { code: 'KIS_NETWORK', stage: 'quote' });
  }

  // 초당 호출 제한(EGW00201) — 짧게 쉬었다 한 번만 다시 시도한다
  if ((r.json || {}).msg_cd === 'EGW00201') {
    await sleep(RATE_RETRY_WAIT_MS + Math.floor(Math.random() * 150));
    await throttle();
    try {
      r = await rawRequest(`${BASE_URL}${path}?${qs}`, { headers: baseHeaders(trId, tokenRec.token), timeout });
    } catch (e) {
      throw new KisError('KIS 서버에 연결하지 못했습니다.', { code: 'KIS_NETWORK', stage: 'quote' });
    }
  }

  const j = r.json || {};
  const msgCd = j.msg_cd || null;
  const rtCd = j.rt_cd != null ? String(j.rt_cd) : null;
  const authFailed =
    r.status === 401 ||
    msgCd === 'EGW00121' || // 유효하지 않은 토큰
    msgCd === 'EGW00123' || // 기간이 만료된 토큰
    /token|토큰/i.test(String(j.msg1 || '')) && rtCd !== '0';

  if (authFailed && retryOnAuth) {
    invalidateToken();
    const fresh = await getKisToken({ force: true, reason: 'auth-retry' });
    await throttle();
    const r2 = await rawRequest(`${BASE_URL}${path}?${qs}`, { headers: baseHeaders(trId, fresh.token) });
    const j2 = r2.json || {};
    if (String(j2.rt_cd) !== '0') {
      throw new KisError(`KIS 응답 오류 (${j2.msg_cd || r2.status})`, {
        code: 'KIS_API_ERROR',
        msgCd: j2.msg_cd || null,
        msg1: j2.msg1 || null,
        httpStatus: r2.status,
        stage: 'quote',
      });
    }
    return j2;
  }

  if (!r.ok || rtCd !== '0') {
    const rate = msgCd === 'EGW00201';
    throw new KisError(
      rate ? 'KIS 초당 호출 제한(EGW00201)에 걸렸습니다.' : `KIS 응답 오류 (${msgCd || r.status})`,
      { code: rate ? 'KIS_RATE_LIMIT' : 'KIS_API_ERROR', msgCd, msg1: j.msg1 || null, httpStatus: r.status, stage: 'quote' },
    );
  }

  return j;
}

const SIGN_NEGATIVE = new Set(['4', '5']); // 4: 하한, 5: 하락
const SIGN_POSITIVE = new Set(['1', '2']); // 1: 상한, 2: 상승

/** 여부 계열 필드 방어 판정 — 'Y'/'1' 외에는 모두 false(표기가 달라도 필터가 조용히 꺼지지 않게). */
function ynFlag(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return s === 'Y' || s === '1';
}

/** 주식현재가 시세(FHKST01010100) 출력 → 관제탑 공통 필드 */
function normalizeQuote(out, code) {
  const o = out || {};
  const price = toNum(o.stck_prpr);
  const changeAbs = toNum(o.prdy_vrss);
  const sign = o.prdy_vrss_sign ? String(o.prdy_vrss_sign) : null;
  const changePct = toNum(o.prdy_ctrt);

  let change = changeAbs;
  if (change !== null) {
    if (SIGN_NEGATIVE.has(sign)) change = -Math.abs(change);
    else if (SIGN_POSITIVE.has(sign)) change = Math.abs(change);
    else if (sign === '3') change = 0;
    else if (changePct !== null) change = Math.abs(change) * (changePct < 0 ? -1 : 1);
  }

  const volume = toInt(o.acml_vol);
  const tradeAmount = toInt(o.acml_tr_pbmn);

  return {
    code: /^\d{6}$/.test(String(o.stck_shrn_iscd || '')) ? String(o.stck_shrn_iscd) : code,
    // hts_kor_isnm 은 응답에 따라 비어 있다. bstp_kor_isnm 은 업종명이므로 종목명으로 쓰지 않는다.
    name: o.hts_kor_isnm || null,
    sector: o.bstp_kor_isnm || null,
    price,
    change,
    changePct,
    prevClose: toNum(o.stck_sdpr),
    open: toNum(o.stck_oprc),
    high: toNum(o.stck_hgpr),
    low: toNum(o.stck_lwpr),
    upperLimit: toNum(o.stck_mxpr),
    lowerLimit: toNum(o.stck_llam),
    volume,
    tradeAmount,
    // 체결이 있었는지 — 장전/휴장에 KIS가 0.00%를 줄 때 화면 값을 덮지 않기 위한 근거
    hasTrade: Boolean((volume && volume > 0) || (tradeAmount && tradeAmount > 0)),
    tempStop: String(o.temp_stop_yn || '') === 'Y',
    vi: o.vi_cls_code ? String(o.vi_cls_code) !== 'N' : null,
    marketWarn: o.mrkt_warn_cls_code != null ? String(o.mrkt_warn_cls_code) : null,
    // 단기과열 지정 여부 — 침착해 원전은 단기과열·투자주의 가격대에서 종베를 패스한다
    shortOver: String(o.short_over_yn || '') === 'Y',
    /* 종목 상태 플래그 — 2026-11-25 추가(침착해 3대 업그레이드 ③).
     *  iscd_stat_cls_code: 00 그외 · 51 관리종목 · 52 투자위험 · 53 투자경고 · 54 투자주의 ·
     *                      55 신용가능 · 57 증거금100% · 58 거래정지 · 59 단기과열
     *  invt_caful_yn: 투자유의(코스닥 환기) · mang_issu_cls_code: 관리종목 · sltr_yn: 정리매매
     *  ※ '경고 예고'는 이 응답에 필드가 없다 → 종목마스터 스냅샷(data/krx-warn-latest.json)이 보완. */
    statCls: o.iscd_stat_cls_code != null ? String(o.iscd_stat_cls_code).trim() : null,
    caution: ynFlag(o.invt_caful_yn),
    managed: ynFlag(o.mang_issu_cls_code),
    liquidation: ynFlag(o.sltr_yn),
    foreignHeldRate: toNum(o.hts_frgn_ehrt),
    per: toNum(o.per),
    pbr: toNum(o.pbr),
    eps: toNum(o.eps),
    bps: toNum(o.bps),
    marketCapEok: toNum(o.hts_avls),
    w52High: toNum(o.w52_hgpr),
    w52Low: toNum(o.w52_lwpr),
    w52HighDate: o.w52_hgpr_date || null,
    w52LowDate: o.w52_lwpr_date || null,
    asOfDate: o.stck_bsop_date || null,
    source: 'kis',
  };
}

/**
 * 현재가 조회 (1종목)
 * @param {string} code 6자리 종목코드
 * @param {{marketDiv?:'J'|'NX'|'UN', raw?:boolean, noCache?:boolean}} [opts] 기본 J(KRX)
 */
const quoteMem = new Map(); // 같은 인스턴스 안에서 코드셋이 다른 호출들이 겹쳐도 KIS는 5초에 1번만 찌른다
const QUOTE_MEM_TTL_MS = 10000;
const QUOTE_MEM_MAX = 300;

async function fetchKisQuote(code, opts = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) {
    throw new KisError('종목코드가 6자리가 아닙니다.', { code: 'KIS_BAD_CODE', stage: 'quote' });
  }
  const marketDiv = opts.marketDiv || 'J';
  const memKey = `${code}:${marketDiv}`;
  const hit = quoteMem.get(memKey);
  if (!opts.noCache && !opts.raw && hit && Date.now() - hit.at < QUOTE_MEM_TTL_MS) return hit.value;

  const j = await kisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-price',
    'FHKST01010100',
    { FID_COND_MRKT_DIV_CODE: marketDiv, FID_INPUT_ISCD: String(code) },
    { timeout: opts.timeout },
  );
  const q = normalizeQuote(j.output, String(code));
  q.marketDiv = marketDiv;
  q.fetchedAt = new Date().toISOString();
  if (opts.raw) q.raw = j.output || null; // 진단용(?kis_test=1&raw=1) — 시세 데이터뿐, 비밀값 없음

  if (quoteMem.size >= QUOTE_MEM_MAX) {
    const oldest = quoteMem.keys().next().value;
    quoteMem.delete(oldest);
  }
  quoteMem.set(memKey, { at: Date.now(), value: q });
  return q;
}

/**
 * 여러 종목 조회 — 실패는 개별 흡수.
 *  · deadline(ms epoch)이 있으면 그 시각 전에 시작할 수 있는 물결까지만 돌리고, 받은 것만 돌려준다
 *    (타임아웃으로 전체를 버리면 이미 받은 시세까지 잃는다)
 *  · 초당 제한(EGW00201)에 걸리면 남은 종목은 건너뛴다
 */
async function fetchKisQuotes(codes, opts = {}) {
  const list = Array.from(new Set((codes || []).filter((c) => /^\d{6}$/.test(String(c)))));
  const out = { quotes: {}, errors: [], rateLimited: false, truncated: false };
  const limit = Math.max(1, Math.min(5, Number(opts.concurrency) || 3));
  const waveMinMs = Number(opts.waveMinMs) || 900;

  for (let i = 0; i < list.length; i += limit) {
    if (opts.deadline && Date.now() + waveMinMs > opts.deadline) {
      out.truncated = true;
      break;
    }
    const slice = list.slice(i, i + limit);
    const settled = await Promise.allSettled(slice.map((c) => fetchKisQuote(c, opts)));
    let hitRateLimit = false;
    settled.forEach((s, idx) => {
      const code = slice[idx];
      if (s.status === 'fulfilled') {
        out.quotes[code] = s.value;
      } else {
        const e = s.reason || {};
        if (e.code === 'KIS_RATE_LIMIT') hitRateLimit = true;
        out.errors.push({
          code,
          code_id: e.code || 'KIS_ERROR',
          message: String(e.message || e),
          msgCd: e.msgCd || null,
        });
      }
    });
    // 더 찌르면 EGW00201 만 늘어난다 — 이번 응답은 네이버 값으로 마무리하고 다음 폴링에 맡긴다
    if (hitRateLimit) {
      out.rateLimited = true;
      break;
    }
  }
  return out;
}

/** 주식현재가 투자자(FHKST01010900) — 일자별 확정 수급 */
async function fetchKisInvestor(code, opts = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) {
    throw new KisError('종목코드가 6자리가 아닙니다.', { code: 'KIS_BAD_CODE', stage: 'investor' });
  }
  const marketDiv = opts.marketDiv || 'J';
  const j = await kisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-investor',
    'FHKST01010900',
    { FID_COND_MRKT_DIV_CODE: marketDiv, FID_INPUT_ISCD: String(code) },
  );
  // 이 TR은 output 이 리스트(일자별)로 온다. 혹시 객체로 와도 1행으로 감싼다.
  const rows = Array.isArray(j.output) ? j.output : j.output ? [j.output] : [];
  const mapped = rows
    .map((r) => ({
      date: r.stck_bsop_date || null,
      close: toNum(r.stck_clpr),
      personalQty: toInt(r.prsn_ntby_qty),
      foreignQty: toInt(r.frgn_ntby_qty),
      organQty: toInt(r.orgn_ntby_qty),
      personalValue: toInt(r.prsn_ntby_tr_pbmn),
      foreignValue: toInt(r.frgn_ntby_tr_pbmn),
      organValue: toInt(r.orgn_ntby_tr_pbmn),
    }))
    .filter((r) => r.date);

  mapped.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const latest = mapped[0] || null;
  // 수급 값이 실제로 채워진 마지막 일자 — 당일 행은 장 시작 전·장중에 수량이 비어 있을 수 있다
  const filled = mapped.filter(
    (r) => typeof r.foreignQty === 'number' || typeof r.organQty === 'number' || typeof r.personalQty === 'number',
  );
  const latestConfirmed = filled[0] || null;
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');

  return {
    code: String(code),
    marketDiv,
    // 당일 값은 장 종료 후에만 확정된다 — 화면에서 '확정일'을 반드시 함께 보여줄 것
    confirmedDate: latestConfirmed ? latestConfirmed.date : latest ? latest.date : null,
    isTodayConfirmed: Boolean(latestConfirmed && latestConfirmed.date === today),
    latest,
    latestConfirmed,
    recent: mapped.slice(0, 5),
    rowCount: mapped.length,
    fetchedAt: new Date().toISOString(),
    source: 'kis',
  };
}

/* ------------------------------------------------------------------ */
/* 장중 기관·외국인 수급 상위(가집계)                                    */
/* ------------------------------------------------------------------ */
/**
 * 국내기관_외국인 매매종목 가집계 (FHPTJ04400000)
 * ------------------------------------------------------------------
 *  GET /uapi/domestic-stock/v1/quotations/foreign-institution-total
 *  · 장중 가집계다. 15:30 이후·휴장일에는 값이 비거나 0 으로 온다(확정 수급은 FHKST01010900).
 *  · 파라미터
 *      FID_COND_MRKT_DIV_CODE  V(업종)
 *      FID_COND_SCR_DIV_CODE   16449 (화면 구분 고정)
 *      FID_INPUT_ISCD          0000 (전체)
 *      FID_DIV_CLS_CODE        0:수량 / 1:금액
 *      FID_RANK_SORT_CLS_CODE  0:순매수상위 / 1:순매도상위
 *      FID_ETC_CLS_CODE        0:전체 / 1:외국인 / 2:기관계
 *  · 금액 필드(*_tr_pbmn)의 단위는 응답 그대로 raw 로 남기고, 원/억 환산은
 *    단위를 확인한 뒤 valueUnit 으로 표시한다(추측해서 만들지 않는다).
 */

/* 응답 필드 후보 — KIS 문서·실측 이름이 조금씩 달라도 같은 값을 찾아 쓰기 위한 목록 */
const SUPPLY_FIELDS = {
  code: ['stck_shrn_iscd', 'mksc_shrn_iscd', 'tsym', 'stck_code', 'iscd'],
  name: ['hts_kor_isnm', 'prdt_name', 'stck_kor_isnm', 'itms_nm', 'name'],
  price: ['stck_prpr', 'prpr', 'stck_clpr'],
  changePct: ['prdy_ctrt', 'prdy_ctrt_sign_pct'],
  volume: ['acml_vol'],
  tradeValue: ['acml_tr_pbmn'],
};

function pickField(row, list) {
  for (const k of list) {
    if (row && row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return row[k];
  }
  return null;
}

async function fetchForeignInstitutionTotal(opts = {}) {
  const etcClsCode = opts.etcClsCode != null ? String(opts.etcClsCode) : '1'; // 1:외국인 2:기관계
  const sortCode = opts.sortCode != null ? String(opts.sortCode) : '0'; // 0:순매수상위
  const divCode = opts.divCode != null ? String(opts.divCode) : '1'; // 1:금액
  const params = {
    FID_COND_MRKT_DIV_CODE: opts.marketDiv || 'V',
    FID_COND_SCR_DIV_CODE: '16449',
    FID_INPUT_ISCD: opts.iscd || '0000',
    FID_DIV_CLS_CODE: divCode,
    FID_RANK_SORT_CLS_CODE: sortCode,
    FID_ETC_CLS_CODE: etcClsCode,
  };
  const j = await kisGet('/uapi/domestic-stock/v1/quotations/foreign-institution-total', 'FHPTJ04400000', params);

  const role = etcClsCode === '2' ? 'organ' : 'foreign';
  const qtyKey = role === 'organ' ? ['orgn_ntby_qty', 'orgn_ntby_qty_sum'] : ['frgn_ntby_qty', 'frgn_ntby_qty_sum'];
  const valKey = role === 'organ'
    ? ['orgn_ntby_tr_pbmn', 'orgn_ntby_tr_pbmn_sum', 'orgn_ntby_value']
    : ['frgn_ntby_tr_pbmn', 'frgn_ntby_tr_pbmn_sum', 'frgn_ntby_value'];

  const listLike = (v) => Array.isArray(v) && v.length && typeof v[0] === 'object';
  const rows = Array.isArray(j.output) && j.output.length
    ? j.output
    : Array.isArray(j.output1) && Array.isArray(j.output2)
      ? j.output2
      : listLike(j.output1)
        ? j.output1
        : listLike(j.output2)
          ? j.output2
          : [];

  const mapped = rows
    .map((r, i) => {
      const code = pickField(r, SUPPLY_FIELDS.code);
      const qty = toInt(pickField(r, qtyKey));
      const val = toInt(pickField(r, valKey));
      return {
        rank: i + 1,
        code: code ? String(code) : null,
        name: pickField(r, SUPPLY_FIELDS.name),
        price: toNum(pickField(r, SUPPLY_FIELDS.price)),
        changePct: toNum(pickField(r, SUPPLY_FIELDS.changePct)),
        tradeValueRaw: toInt(pickField(r, SUPPLY_FIELDS.tradeValue)),
        netQty: qty,
        netValueRaw: val,
      };
    })
    .filter((r) => r.code || r.name);

  return {
    ok: true,
    etcClsCode,
    role,
    sortCode,
    divCode,
    params,
    count: mapped.length,
    /** 응답이 실제로 어떤 필드로 왔는지 — 단위·필드 확인용(첫 행의 키 전부) */
    rawKeys: rows[0] ? Object.keys(rows[0]) : [],
    rawFirstRow: rows[0] || null,
    rows: mapped,
    fetchedAt: new Date().toISOString(),
    source: 'kis',
    trId: 'FHPTJ04400000',
  };
}

/* ------------------------------------------------------------------ */
/* 종목별 프로그램매매 추이 (FHPPG04650100 · HTS [0465])                 */
/* ------------------------------------------------------------------ */
/*  한국투자 HTS [0465] '종목별 프로그램매매추이(체결)' 화면과 같은 값이다.
 *  침착해 종가베팅이 1순위로 보는 신호(프로그램 방향·지속성·규모·가격과의 관계)가 여기서 나온다.
 *  · 응답은 Output1(또는 output) 배열 — 30분 간격 누적값(bsop_hour, 순매수 수량·대금, 증감)
 *  · 종목별 호출이라 비싸다 → 60초 메모리 캐시(웹 인스턴스 기준)로만 쓴다.
 *  · 실패/빈 응답이면 null 을 만들지 않고 ok:false 로 돌려, 화면이 '미수신'으로 적게 한다(추정 금지).
 */
const PROGRAM_TTL_MS = 60000;
const PROGRAM_MEM_MAX = 240;
const programMem = new Map();

/** 'HHMM' → 분. 값이 없거나 이상하면 null */
function hhmmToMin(v) {
  /* bsop_hour 는 HHMMSS(6)로 온다(2026-11-24 18:11 실측: '181227' = 18:12:27). HHMM(4)·HMM(3)도 받는다.
     → 시 = 마지막 4자리 앞부분, 분 = 마지막 4자리의 앞 2자리. */
  const s = String(v === null || v === undefined ? '' : v).replace(/[^0-9]/g, '');
  if (s.length < 3 || s.length > 6) return null;
  const minDigits = 2; // 초까지 오면 HHMMSS → 분은 -4~-2
  const hh = s.length >= 5 ? s.slice(0, s.length - 4) : s.slice(0, s.length - minDigits);
  const mm = s.length >= 5 ? s.slice(s.length - 4, s.length - 2) : s.slice(-2);
  const h = Number(hh);
  const m = Number(mm);
  if (!Number.isFinite(h) || !Number.isFinite(m) || m > 59 || h > 24) return null;
  return h * 60 + m;
}

function normalizeProgramRows(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const rows = list
    .map((r) => {
      const at = hhmmToMin(r.bsop_hour);
      return {
        hour: r.bsop_hour ? String(r.bsop_hour) : null,
        at,
        price: toNum(r.stck_prpr),
        changePct: toNum(r.prdy_ctrt),
        accVolume: toInt(r.acml_vol),
        sellQty: toInt(r.whol_smtn_seln_vol),
        buyQty: toInt(r.whol_smtn_shnu_vol),
        netQty: toInt(r.whol_smtn_ntby_qty),
        sellValue: toInt(r.whol_smtn_seln_tr_pbmn),
        buyValue: toInt(r.whol_smtn_shnu_tr_pbmn),
        netValue: toInt(r.whol_smtn_ntby_tr_pbmn),
        netQtyDelta: toInt(r.whol_ntby_vol_icdc),
        netValueDelta: toInt(r.whol_ntby_tr_pbmn_icdc),
      };
    })
    .filter((r) => r.at !== null && r.netQty !== null);
  rows.sort((a, b) => a.at - b.at);
  return rows;
}

/** 누적 행들 → 최신값·오후(13시) 증감·최근 30분 증감·추세 판정 */
function buildProgramSummary(code, rows) {
  const out = {
    ok: false,
    code,
    rows: rows || [],
    latest: null,
    first: null,
    trend: {
      kind: 'unknown', // up(순매수·증가) / flat(순매수·둔화) / flip(매도→최근 순매수 전환) / down(순매도 지속)
      windowMin: null, // 응답이 담고 있는 시간 폭(분) — 0465는 최근 30행만 준다
      baseHour: null,
      baseLabel: null, // '오후(13시)' 또는 '최근 N분'
      deltaQty: null,
      deltaValue: null,
      m30DeltaQty: null,
      m30DeltaValue: null,
    },
    fetchedAt: new Date().toISOString(),
  };
  const rs = rows || [];
  if (!rs.length) return out;
  const latest = rs[rs.length - 1];
  const first = rs[0];
  out.ok = true;
  out.latest = latest;
  out.first = first;

  const dQty = (a, b) => (a && b && a.netQty !== null && b.netQty !== null ? a.netQty - b.netQty : null);
  const dVal = (a, b) => (a && b && a.netValue !== null && b.netValue !== null ? a.netValue - b.netValue : null);
  const baseAt = (limitMin) => {
    let b = null;
    for (const r of rs) {
      if (r.at <= limitMin) b = r;
      else break;
    }
    return b;
  };

  /* 0465 응답은 '최근 30행'만 준다(2026-11-24 18:11 실측: 06:04~06:11 구간이 15초 간격).
   *  → 응답 창이 13시를 걸치면 '오후(13시) 이후' 증감을, 아니면 '최근 N분' 증감을 쓴다.
   *  침착해가 보는 화면도 누적선의 기울기(최근 흐름)라, 창이 짧아도 방향 판정은 성립한다. */
  const windowMin = Math.max(0, latest.at - first.at);
  out.trend.windowMin = windowMin;
  const spansAfternoon = first.at <= 13 * 60 && latest.at > 13 * 60;
  const base = spansAfternoon ? baseAt(13 * 60) : first;
  out.trend.baseHour = base ? base.hour : null;
  out.trend.baseLabel = spansAfternoon ? '오후(13시)' : '최근 ' + windowMin + '분';
  out.trend.deltaQty = dQty(latest, base);
  out.trend.deltaValue = dVal(latest, base);
  const base30 = baseAt(latest.at - 30);
  out.trend.m30DeltaQty = dQty(latest, base30);
  out.trend.m30DeltaValue = dVal(latest, base30);

  /* 판정 기준 — 침착해 원전은 '주식 수'의 방향·지속을 본다. 억원 환산은 표기용이다. */
  const ref = out.trend.deltaQty;
  if (typeof latest.netQty === 'number' && latest.netQty > 0) out.trend.kind = ref !== null && ref > 0 ? 'up' : 'flat';
  else out.trend.kind = ref !== null && ref > 0 ? 'flip' : 'down';
  return out;
}

/**
 * 종목별 프로그램매매추이(체결) — 60초 캐시.
 * @param {string} code 6자리 종목코드
 * @param {{marketDiv?:'J'|'NX'|'UN', noCache?:boolean, timeout?:number}} [opts]
 */
async function fetchProgramTradeByStock(code, opts = {}) {
  const c = String(code || '');
  if (!/^\d{6}$/.test(c)) {
    throw new KisError('종목코드가 6자리가 아닙니다.', { code: 'KIS_BAD_CODE', stage: 'program' });
  }
  const marketDiv = opts.marketDiv || 'J';
  const memKey = `${c}:${marketDiv}`;
  const hit = programMem.get(memKey);
  if (!opts.noCache && hit && Date.now() - hit.at < PROGRAM_TTL_MS) return hit.value;

  const j = await kisGet(
    '/uapi/domestic-stock/v1/quotations/program-trade-by-stock',
    'FHPPG04650100',
    { FID_COND_MRKT_DIV_CODE: marketDiv, FID_INPUT_ISCD: c },
    { timeout: opts.timeout },
  );
  const raw = Array.isArray(j.output)
    ? j.output
    : Array.isArray(j.Output1)
      ? j.Output1
      : Array.isArray(j.output1)
        ? j.output1
        : j.output
          ? [j.output]
          : [];
  const value = buildProgramSummary(c, normalizeProgramRows(raw));
  value.marketDiv = marketDiv;
  value.trId = 'FHPPG04650100';
  value.rawRowCount = raw.length;
  if (opts.raw) {
    /* 진단용(?mode=program_test&raw=1) — 필드 이름·단위를 확인한다. 비밀값은 담지 않는다. */
    value.rawKeys = raw.length && raw[0] ? Object.keys(raw[0]) : [];
    value.rawFirst = (raw.length && raw[0]) || null;
    value.rawLast = (raw.length && raw[raw.length - 1]) || null;
  }

  if (programMem.size >= PROGRAM_MEM_MAX) {
    const oldest = programMem.keys().next().value;
    programMem.delete(oldest);
  }
  programMem.set(memKey, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ */
/* 국내선물옵션 — 코스피200 주간(F)·야간(CM) 현재가 (FHMIF10000000)        */
/* ------------------------------------------------------------------ */
/*
 *  · 엔드포인트: GET /uapi/domestic-futureoption/v1/quotations/inquire-price
 *  · tr_id     : FHMIF10000000  (주식 FHKST01010100 과 다른 TR — 응답도 output1/2/3 로 나뉜다)
 *  · 파라미터  : FID_COND_MRKT_DIV_CODE  F(지수선물·주간) / CM(야간선물)
 *               FID_INPUT_ISCD          지수선물 단축코드
 *  · 응답      : output1 = 현재가 요약(futs_prpr·futs_prdy_ctrt·acml_vol·kospi200_nmix …)
 *               output2 = 체결 시각별 봉(최신 체결 시각 확인용)
 *               output3 = 부가 정보(비어 있는 경우가 있다)
 *
 *  종목코드 규칙 (2026년 만기 종목부터 적용되는 KRX 표준코드)
 *   · 선물 = A(선물) + 01(KOSPI200) + 연도코드 + 월
 *   · 연도코드 = 1996년부터 30년 주기 문자열 '6789012345ABCDEFGHJKLMNPQRSTVW'
 *       → 2026 = '6', 2027 = '7' … 2035 = '5', 2036 = 'A'
 *   · 월 = 1~9 그대로, 10='A' 11='B' 12='C'
 *   · 코스피200 선물은 3·6·9·12월물만 상장 — 만기(둘째 목요일) 15:45 이후 근월물이 넘어간다
 *  → 2026년 12월물 단축코드는 5자리 표기 'A016C', KIS 조회에 쓰는 6자리 표기 'A01612'.
 *    ⚠️ 2026-11-24 21:31 Vercel 실전 서버 실측: F·CM 모두 **6자리 숫자월 표기(A01612)만 시세를 준다**.
 *       5자리 문자월 표기(A016C)·8자리(A016C000)는 rt_cd '0' 이지만 output1 이 비어 왔다.
 *
 *  캐시: 30초 메모리(같은 인스턴스에서 주간·야간 두 번 불러도 세션당 1회씩만 호출)
 *        API 레이어에서 CDN 60초 캐시를 함께 건다.
 */

const FUT_YEAR_CYCLE = '6789012345ABCDEFGHJKLMNPQRSTVW';
const FUT_QUARTERS = [3, 6, 9, 12];
const FUT_OPEN_PRICE_DIV = { F_DAY: 'F', F_NIGHT: 'CM' };

function futPad2(n) {
  return String(n).padStart(2, '0');
}

/** 연도코드(1996년 기준 30년 주기) */
function futYearCode(year) {
  const idx = (((Number(year) - 1996) % 30) + 30) % 30;
  return FUT_YEAR_CYCLE[idx];
}

/** 월코드 — 1~9 그대로, 10~12 → A·B·C */
function futMonthCode(month) {
  const m = Number(month);
  if (m >= 1 && m <= 9) return String(m);
  if (m === 10) return 'A';
  if (m === 11) return 'B';
  if (m === 12) return 'C';
  return null;
}

/** 만기일(그 달 둘째 목요일) 일자 */
function kospi200ExpiryDay(year, month) {
  const first = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  const dow = first.getUTCDay(); // 0=일 … 4=목
  const offset = (4 - dow + 7) % 7;
  return 1 + offset + 7; // 둘째 목요일
}

/**
 * 코스피200 선물 근월물 — 만기일 15:45(정규장 종료) 이후 다음 분기월로 자동 롤오버
 * @param {number} [nowMs] 기준 시각(ms). 없으면 지금.
 * @returns {{year:number, month:number, code:string, code5:string, code8:string, expiry:string, label:string}}
 */
function kospi200FrontContract(nowMs) {
  const base = nowMs == null ? Date.now() : nowMs;
  const t = new Date(base + 9 * 3600 * 1000); // KST 벽시계
  const y = t.getUTCFullYear();
  const m0 = t.getUTCMonth() + 1;
  const d = t.getUTCDate();
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();

  for (let off = 0; off < 15; off += 1) {
    const mm = m0 + off;
    const yy = y + Math.floor((mm - 1) / 12);
    const mo = ((mm - 1) % 12) + 1;
    if (FUT_QUARTERS.indexOf(mo) < 0) continue;
    const expiryDay = kospi200ExpiryDay(yy, mo);
    // 당월 만기일 15:45 이후에는 그 월물이 끝난 것으로 본다(야간장은 다음 월물부터)
    if (yy === y && mo === m0 && (d > expiryDay || (d === expiryDay && mins >= 15 * 60 + 45))) continue;
    const yc = futYearCode(yy);
    const mc = futMonthCode(mo);
    return {
      year: yy,
      month: mo,
      code: 'A01' + yc + futPad2(mo), // KIS 조회용 6자리 표기 — 실측으로 시세가 오는 유일한 표기
      code5: 'A01' + yc + mc, // 사람이 읽는 5자리 단축코드
      code8: 'A01' + yc + mc + '000',
      expiry: `${yy}-${futPad2(mo)}-${futPad2(expiryDay)}`,
      label: `코스피200 선물 ${yy}년 ${mo}월물`,
    };
  }
  return null;
}

/**
 * 최신 봉의 시각을 실제 달력 시각(ISO)으로 바꾼다.
 *  · 야간장(CM)의 자정 이후 봉은 stck_bsop_date 가 '거래일'이라 달력상 하루 뒤다.
 */
function futLastTradeIso(lastBar, marketDiv) {
  if (!lastBar || !lastBar.day) return null;
  const y = Number(lastBar.day.slice(0, 4));
  const m = Number(lastBar.day.slice(4, 6));
  const d = Number(lastBar.day.slice(6, 8));
  const hh = Number(lastBar.hm.slice(0, 2));
  const mi = Number(lastBar.hm.slice(2, 4));
  const ss = lastBar.hm.length >= 6 ? Number(lastBar.hm.slice(4, 6)) : 0;
  if (![y, m, d, hh, mi].every(Number.isFinite)) return null;
  const dayShift = String(marketDiv || '').toUpperCase() === 'CM' && hh < 6 ? 1 : 0;
  const t = Date.UTC(y, m - 1, d + dayShift, hh, mi, ss) - 9 * 3600 * 1000;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const FUT_MEM = new Map();
const FUT_MEM_TTL_MS = 30000;
const FUT_MEM_MAX = 40;
const FUT_SIGN_NEGATIVE = new Set(['4', '5']); // 4: 하한, 5: 하락
const FUT_SIGN_POSITIVE = new Set(['1', '2']); // 1: 상한, 2: 상승

/** 선물옵션 시세 응답(output1/2/3) → 관제탑 공통 필드 */
function normalizeFuturesQuote(raw, meta = {}) {
  const j = raw || {};
  const o = j.output1 && typeof j.output1 === 'object' ? j.output1 : {};
  const o3 = j.output3 && typeof j.output3 === 'object' ? j.output3 : {};
  const bars = Array.isArray(j.output2) ? j.output2.filter((b) => b && b.futs_prpr) : [];
  const emptyOutput = Object.keys(o).length === 0;

  const price = toNum(o.futs_prpr);
  const prevClose = toNum(o.futs_prdy_clpr);
  const sign = o.prdy_vrss_sign != null ? String(o.prdy_vrss_sign) : null;
  let change = toNum(o.futs_prdy_vrss);
  if (change !== null) {
    if (FUT_SIGN_NEGATIVE.has(sign)) change = -Math.abs(change);
    else if (FUT_SIGN_POSITIVE.has(sign)) change = Math.abs(change);
    else if (sign === '3') change = 0;
  }
  let changePct = toNum(o.futs_prdy_ctrt);
  if (changePct === null && price !== null && prevClose) {
    changePct = Math.round(((price - prevClose) / prevClose) * 10000) / 100;
  }
  if (change === null && price !== null && prevClose) {
    change = Math.round((price - prevClose) * 100) / 100;
  }

  // 최신 체결 시각 — output2 의 봉 중 가장 늦은 시각(야간장 자정 이후는 00시대로 돌아온다)
  let lastBar = null;
  let lastKey = null;
  bars.forEach((b) => {
    const day = String(b.stck_bsop_date || '').replace(/[^0-9]/g, '');
    const hm = String(b.stck_cntg_hour || '').replace(/[^0-9]/g, '');
    if (hm.length < 4) return;
    const key = (day.length === 8 ? day : '00000000') + hm.padEnd(6, '0');
    if (!lastKey || key > lastKey) {
      lastKey = key;
      lastBar = { day: day.length === 8 ? day : null, hm };
    }
  });

  const volume = toInt(o.acml_vol);
  const tradeAmount = toInt(o.acml_tr_pbmn);

  return {
    ok: price !== null,
    emptyOutput,
    marketDiv: meta.marketDiv || null,
    code: String(o.futs_shrn_iscd || meta.code || ''),
    name: o.hts_kor_isnm || null,
    price,
    change,
    changePct,
    prevClose,
    open: toNum(o.futs_oprc),
    high: toNum(o.futs_hgpr),
    low: toNum(o.futs_lwpr),
    upperLimit: toNum(o.futs_mxpr),
    lowerLimit: toNum(o.futs_llam),
    volume,
    tradeAmount,
    // 선물옵션 acml_tr_pbmn 단위는 천원(2026-11-24 실측: 13,193계약×752.4pt×25만원 = 2.48조 ≈ 응답 2,497,063,825 × 1,000)
    tradeAmountUnit: '천원',
    tradeAmountWon: tradeAmount === null ? null : tradeAmount * 1000,
    // 체결이 있었는지 — 장전·휴장에 KIS 가 기준가만 줄 때 화면 값을 덮지 않기 위한 근거
    hasTrade: Boolean((volume && volume > 0) || (tradeAmount && tradeAmount > 0)),
    // output3 = 기초자산(업종) 지수 — 선물 시세 응답의 현물 코스피200 값
    kospi200: toNum(o.kospi200_nmix) !== null ? toNum(o.kospi200_nmix) : toNum(o3.bstp_nmix_prpr),
    kospi200ChangePct: toNum(o.kospi200_prdy_ctrt) !== null ? toNum(o.kospi200_prdy_ctrt) : toNum(o3.bstp_nmix_prdy_ctrt),
    openInterest: toInt(o.hts_otst_stpl_qty),
    openInterestDelta: toInt(o.otst_stpl_qty_icdc),
    basis: toNum(o.basis),
    marketBasis: toNum(o.mrkt_basis),
    theoryPrice: toNum(o.hts_thpr),
    disparity: toNum(o.dprt),
    // futs_last_tr_date = 그 월물의 **마지막 거래일**(만기일) — 마지막 체결 시각이 아니다
    contractLastTradingDate: o.futs_last_tr_date || null,
    askPrice: toNum(o.futs_askp),
    bidPrice: toNum(o.futs_bidp),
    lastTradeTime: lastBar ? `${lastBar.hm.slice(0, 2)}:${lastBar.hm.slice(2, 4)}${lastBar.hm.length >= 6 ? ':' + lastBar.hm.slice(4, 6) : ''}` : null,
    lastTradeAt: futLastTradeIso(lastBar, meta.marketDiv),
    contract: meta.contract || null,
    source: 'kis',
    trId: 'FHMIF10000000',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 선물옵션 현재가 조회 (코스피200 주간 F · 야간 CM)
 * @param {{marketDiv?:'F'|'CM', code?:string, noCache?:boolean, raw?:boolean, timeout?:number}} [opts]
 */
/** 6자리 코드('A01612') → 같은 종목의 다른 표기(5자리 'A016C', 8자리 'A016C000') */
function futAlternateCodes(code) {
  const m = String(code || '').toUpperCase().match(/^([A-Z])(\d{2})([0-9A-Z])(\d{2})$/);
  if (!m) return [];
  const mc = futMonthCode(Number(m[4]));
  if (!mc) return [];
  return [m[1] + m[2] + m[3] + mc, m[1] + m[2] + m[3] + mc + '000'];
}

async function fetchFuturesQuote(opts = {}) {
  const marketDiv = String(opts.marketDiv || 'F').toUpperCase();
  if (marketDiv !== FUT_OPEN_PRICE_DIV.F_DAY && marketDiv !== FUT_OPEN_PRICE_DIV.F_NIGHT) {
    throw new KisError('선물옵션 시장분류코드는 F(주간)·CM(야간)만 지원합니다.', {
      code: 'KIS_BAD_MARKET',
      stage: 'futures',
    });
  }
  const contract = opts.code
    ? { code: String(opts.code), label: null, expiry: null }
    : kospi200FrontContract(opts.now);
  if (!contract || !contract.code) {
    throw new KisError('코스피200 근월물을 계산하지 못했습니다.', { code: 'KIS_BAD_CONTRACT', stage: 'futures' });
  }

  const memKey = `${marketDiv}:${contract.code}`;
  const hit = FUT_MEM.get(memKey);
  if (!opts.noCache && !opts.raw && hit && Date.now() - hit.at < FUT_MEM_TTL_MS) return hit.value;

  /* 선물옵션 시세는 초당 제한이 주식보다 박하다(2026-11-24 실측: 연속 호출에서 EGW00201).
     한 번 기다렸다 재시도하면 그대로 통과한다. */
  const callOnce = (code) =>
    kisGet(
      '/uapi/domestic-futureoption/v1/quotations/inquire-price',
      'FHMIF10000000',
      { FID_COND_MRKT_DIV_CODE: marketDiv, FID_INPUT_ISCD: code },
      { timeout: opts.timeout || 5000 },
    );

  let j;
  try {
    j = await callOnce(contract.code);
  } catch (e) {
    if (e && (e.code === 'KIS_RATE_LIMIT' || e.msgCd === 'EGW00201')) {
      await sleep(1300);
      j = await callOnce(contract.code);
    } else {
      throw e;
    }
  }
  /* 6자리 표기가 비어 오는 예외(코드 표기 변경 등) — 5자리·8자리 표기로 한 번만 더 시도한다.
     2026-11-24 실측에서는 6자리(A01612)가 정상이고 다른 표기는 output1 이 비었으므로,
     실제로는 이 폴백이 거의 쓰이지 않는다(코드 체계가 또 바뀌었을 때의 안전망). */
  if (!j.output1 || Object.keys(j.output1).length === 0) {
    const alt = Array.from(
      new Set([contract.code5, contract.code8, ...futAlternateCodes(contract.code)].filter((c) => c && c !== contract.code)),
    );
    for (const altCode of alt) {
      try {
        await sleep(250);
        const j2 = await callOnce(altCode);
        if (j2.output1 && Object.keys(j2.output1).length > 0) {
          j = j2;
          j.usedCode = altCode;
          break;
        }
      } catch (e) {
        /* 다른 표기 시도 실패는 원래 응답을 유지한다 */
      }
    }
  }
  const q = normalizeFuturesQuote(j, { marketDiv, contract, code: j.usedCode || contract.code });
  q.msgCd = j.msg_cd || null;
  if (opts.raw) {
    q.raw = { rt_cd: j.rt_cd || null, msg_cd: j.msg_cd || null, msg1: j.msg1 || null, output1: j.output1 || null, output3: j.output3 || null };
    q.rawBarCount = Array.isArray(j.output2) ? j.output2.length : 0;
    q.rawBarFirst = Array.isArray(j.output2) && j.output2.length ? j.output2[0] : null;
  }

  if (FUT_MEM.size >= FUT_MEM_MAX) FUT_MEM.delete(FUT_MEM.keys().next().value);
  FUT_MEM.set(memKey, { at: Date.now(), value: q });
  return q;
}

/*
 * 진단용 — 후보 코드 표기를 실전 서버에서 직접 찔러 어느 표기가 rt_cd '0' 인지 확인한다.
 * 로컬에 KIS 키가 없으므로 이 결과가 코드 형식의 유일한 근거다(추정 금지).
 */
async function probeFuturesCandidates(candidates) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : [];
  const out = [];
  for (const c of list) {
    const row = { marketDiv: c.marketDiv, code: c.code, ok: false };
    const started = Date.now();
    try {
      await throttle();
      /* 선물옵션 시세는 초당 제한이 주식보다 박하다 — 진단에서도 호출 사이를 넉넉히 벌린다. */
      if (out.length) await sleep(350);
      await throttle();
      const fresh = await getKisToken();
      const qs = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: c.marketDiv,
        FID_INPUT_ISCD: c.code,
      }).toString();
      const r = await rawRequest(`${BASE_URL}/uapi/domestic-futureoption/v1/quotations/inquire-price?${qs}`, {
        headers: baseHeaders('FHMIF10000000', fresh.token),
        timeout: 6000,
      });
      let j = r.json || {};
      if (j.msg_cd === 'EGW00201') {
        await sleep(1200);
        await throttle();
        const r2 = await rawRequest(`${BASE_URL}/uapi/domestic-futureoption/v1/quotations/inquire-price?${qs}`, {
          headers: baseHeaders('FHMIF10000000', fresh.token),
          timeout: 6000,
        });
        j = r2.json || {};
        row.retriedAfter = 'EGW00201';
      }
      const o = j.output1 && typeof j.output1 === 'object' ? j.output1 : {};
      row.httpStatus = r.status;
      row.rtCd = j.rt_cd != null ? String(j.rt_cd) : null;
      row.msgCd = j.msg_cd || null;
      row.msg1 = j.msg1 || null;
      row.ok = row.rtCd === '0';
      row.elapsedMs = Date.now() - started;
      if (row.ok) {
        row.name = o.hts_kor_isnm || null;
        row.price = toNum(o.futs_prpr);
        row.changePct = toNum(o.futs_prdy_ctrt);
        row.prevClose = toNum(o.futs_prdy_clpr);
        row.volume = toInt(o.acml_vol);
        row.tradeAmount = toInt(o.acml_tr_pbmn);
        row.barCount = Array.isArray(j.output2) ? j.output2.length : 0;
        row.lastBar = Array.isArray(j.output2) && j.output2.length ? j.output2[0] : null;
        row.output1Keys = Object.keys(o).slice(0, 40);
      }
    } catch (e) {
      row.ok = false;
      row.error = String((e && e.message) || e);
      row.msgCd = (e && e.msgCd) || null;
      row.msg1 = (e && e.msg1) || null;
      row.elapsedMs = Date.now() - started;
    }
    out.push(row);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 진단                                                                 */
/* ------------------------------------------------------------------ */
function kisHealth() {
  return {
    libVersion: LIB_VERSION,
    configured: isConfigured(),
    baseUrlHost: (() => {
      try {
        return new URL(BASE_URL).host;
      } catch (_) {
        return null;
      }
    })(),
    appKeyKid: appKeyKid(),
    secretKid: secretFingerprint(),
    custtype: CUSTTYPE,
    memToken: memToken
      ? { expiresAt: new Date(memToken.expiresAt).toISOString(), minutesLeft: Math.round((memToken.expiresAt - Date.now()) / 60000) }
      : null,
    lastTokenError,
  };
}

module.exports = {
  KisError,
  isConfigured,
  CACHE_CODE,
  LIB_VERSION,
  kisHealth,
  getKisToken,
  invalidateToken,
  fetchKisQuote,
  fetchKisQuotes,
  fetchKisInvestor,
  fetchForeignInstitutionTotal,
  fetchProgramTradeByStock,
  buildProgramSummary,
  normalizeQuote,
  fetchFuturesQuote,
  normalizeFuturesQuote,
  kospi200FrontContract,
  kospi200ExpiryDay,
  probeFuturesCandidates,
  BASE_URL,
};
