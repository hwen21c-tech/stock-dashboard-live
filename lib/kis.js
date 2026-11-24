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
const LIB_VERSION = '2026-11-24.2';
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

async function throttle() {
  const now = Date.now();
  const wait = lastCallAt + MIN_GAP_BETWEEN_CALLS_MS - now;
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
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
  /* bsop_hour 는 문서상 길이 6(HHMMSS)로 오기도 하고 HHMM(4)로 오기도 한다.
     마지막 두 자리는 항상 '분', 그 앞 두 자리가 '시'다(예: 153000 → 15:30, 93000 → 09:30, 1530 → 15:30). */
  const s = String(v === null || v === undefined ? '' : v).replace(/[^0-9]/g, '');
  if (s.length < 3 || s.length > 6) return null;
  const minPart = s.slice(-4, -2);
  const m = Number(s.slice(-2));
  const h = Number(s.length >= 5 ? minPart : s.slice(0, s.length - 2));
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
  BASE_URL,
};
