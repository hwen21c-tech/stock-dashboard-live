'use strict';

/**
 * Edge TTS DRM 토큰 (Sec-MS-GEC, v2 형식) — JavaScript 포팅
 *
 * 마이크로소프트 Read Aloud WebSocket 은 `Sec-MS-GEC-Version: 2-...` 부터
 * "<CS64 16hex>-<SHA256 64hex>" 형태의 토큰을 요구한다.
 * 토큰 입력값은 (5분 단위로 내림한 Windows 파일시간 틱) + (신뢰 클라이언트 토큰) 이다.
 * 여기서는 그 계산을 순수 정수 연산(Math.imul + >>> 0)으로 옮겼다.
 * 파이썬 edge-tts 7.3.1 의 drm.generate_sec_ms_gec_v2() 와 같은 값을 낸다.
 */

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WIN_EPOCH = 11644473600;

const M = 0xffffffff;

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
];
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2
];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564
];
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_CONSTANTS = SHA256_ROUND_CONSTANTS.slice(0, 14).concat([SHA256_ADJUSTMENT], SHA256_ROUND_CONSTANTS.slice(15));
const SIGMA0_ADJUSTMENT = 0x059c0b80;
const SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf], [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb], [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167]
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

function rol16(v) {
  v = v >>> 0;
  return ((v << 16) | (v >>> 16)) >>> 0;
}
function mul(a, b) { return Math.imul(a >>> 0, b >>> 0) >>> 0; }
function add() {
  let s = 0;
  for (let i = 0; i < arguments.length; i++) s = (s + (arguments[i] >>> 0)) >>> 0;
  return s >>> 0;
}
function sigma0(v) {
  v = v >>> 0;
  return ((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0;
}
function sigma1(v) {
  v = v >>> 0;
  return ((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0;
}

function sha256Rounds(state, words, firstRound) {
  firstRound = firstRound || 0;
  let a = state[0], b = state[1], c = state[2], d = state[3];
  let e = state[4], f = state[5], g = state[6], h = state[7];
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);

  for (let i = firstRound; i < aligned; i++) {
    const t1 = add(h,
      rotR(e, 6) ^ rotR(e, 11) ^ rotR(e, 25),
      g ^ (e & (f ^ g)),
      constants[i], words[i]);
    const t2 = add(rotR(a, 2) ^ rotR(a, 13) ^ rotR(a, 22), (a & b) | (c & (a | b)));
    h = g; g = f; f = e; e = add(d, t1); d = c; c = b; b = a; a = add(t1, t2);
  }
  /* 8 라운드마다 이름이 제자리로 돌아오므로 한 번에 8개씩 처리 */
  for (let i = aligned; i < 64; i += 8) {
    let t1 = add(h, rotR(e, 6) ^ rotR(e, 11) ^ rotR(e, 25), g ^ (e & (f ^ g)), constants[i], words[i]);
    d = add(d, t1);
    h = add(t1, rotR(a, 2) ^ rotR(a, 13) ^ rotR(a, 22), (a & b) | (c & (a | b)));

    t1 = add(g, rotR(d, 6) ^ rotR(d, 11) ^ rotR(d, 25), f ^ (d & (e ^ f)), constants[i + 1], words[i + 1]);
    c = add(c, t1);
    g = add(t1, rotR(h, 2) ^ rotR(h, 13) ^ rotR(h, 22), (h & a) | (b & (h | a)));

    t1 = add(f, rotR(c, 6) ^ rotR(c, 11) ^ rotR(c, 25), e ^ (c & (d ^ e)), constants[i + 2], words[i + 2]);
    b = add(b, t1);
    f = add(t1, rotR(g, 2) ^ rotR(g, 13) ^ rotR(g, 22), (g & h) | (a & (g | h)));

    t1 = add(e, rotR(b, 6) ^ rotR(b, 11) ^ rotR(b, 25), d ^ (b & (c ^ d)), constants[i + 3], words[i + 3]);
    a = add(a, t1);
    e = add(t1, rotR(f, 2) ^ rotR(f, 13) ^ rotR(f, 22), (f & g) | (h & (f | g)));

    t1 = add(d, rotR(a, 6) ^ rotR(a, 11) ^ rotR(a, 25), c ^ (a & (b ^ c)), constants[i + 4], words[i + 4]);
    h = add(h, t1);
    d = add(t1, rotR(e, 2) ^ rotR(e, 13) ^ rotR(e, 22), (e & f) | (g & (e | f)));

    t1 = add(c, rotR(h, 6) ^ rotR(h, 11) ^ rotR(h, 25), b ^ (h & (a ^ b)), constants[i + 5], words[i + 5]);
    g = add(g, t1);
    c = add(t1, rotR(d, 2) ^ rotR(d, 13) ^ rotR(d, 22), (d & e) | (f & (d | e)));

    t1 = add(b, rotR(g, 6) ^ rotR(g, 11) ^ rotR(g, 25), a ^ (g & (h ^ a)), constants[i + 6], words[i + 6]);
    f = add(f, t1);
    b = add(t1, rotR(c, 2) ^ rotR(c, 13) ^ rotR(c, 22), (c & d) | (e & (c | d)));

    t1 = add(a, rotR(f, 6) ^ rotR(f, 11) ^ rotR(f, 25), h ^ (f & (g ^ h)), constants[i + 7], words[i + 7]);
    e = add(e, t1);
    a = add(t1, rotR(b, 2) ^ rotR(b, 13) ^ rotR(b, 22), (b & c) | (d & (b | c)));
  }
  return [a, b, c, d, e, f, g, h];
}

function rotR(v, n) {
  v = v >>> 0;
  return ((v >>> n) ^ (v << (32 - n))) >>> 0;
}

function expandSchedule(words, firstWord) {
  firstWord = firstWord || 16;
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2] >>> 0;
    const y = words[i - 15] >>> 0;
    const s1 = ((x >>> 17) ^ (x << 15) ^ (x >>> 19) ^ (x << 13) ^ (x >>> 10)) >>> 0;
    const s0 = ((y >>> 7) ^ (y << 25) ^ (y >>> 18) ^ (y << 14) ^ (y >>> 3)) >>> 0;
    words.push(add(s1, words[i - 7], s0, words[i - 16]));
  }
}

function sha256Init(data) {
  const words = [];
  for (let i = 0; i < 14; i++) words.push(0);
  words.push(((data[0] << 16) | (data[1] << 8) | data[2]) >>> 0);
  words.push(((data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6]) >>> 0);
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) value = add(value, i === 16 ? (sigma1(words[i - 2]) ^ SIGMA1_ADJUSTMENT) >>> 0 : sigma1(words[i - 2]));
    if (i - 7 >= 14) value = add(value, words[i - 7]);
    if (i - 15 >= 14) value = add(value, i === 29 ? (sigma0(words[i - 15]) ^ SIGMA0_ADJUSTMENT) >>> 0 : sigma0(words[i - 15]));
    words.push(value >>> 0);
  }
  words.push(add(
    sigma1(words[28]), words[23], sigma0(words[15]), words[14],
    SHA256_ADJUSTMENT, (M + 1 - SHA256_ROUND_CONSTANTS[14]) >>> 0
  ));
  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  const out = [];
  for (let i = 0; i < 8; i++) out.push(add(SHA256_INITIAL[i], working[i]));
  return out;
}

function sha256Digest(data) {
  if (data.length < 7) throw new Error('token_salt_too_short');
  const length = 57 + data.length;
  const body = [];
  for (let i = 7; i < data.length; i++) body.push(data[i]);
  body.push(0x80);
  const zeros = ((55 - length) % 64 + 64) % 64;
  for (let i = 0; i < zeros; i++) body.push(0);
  const bitLen = length * 8;
  /* >Q : 64비트 빅엔디언 */
  const hi = Math.floor(bitLen / 4294967296);
  const lo = bitLen % 4294967296;
  body.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
  body.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

  let state = sha256Init(data.slice(0, 7));
  for (let off = 0; off < body.length; off += 64) {
    const words = [];
    for (let i = 0; i < 16; i++) {
      const p = off + i * 4;
      words.push(((body[p] << 24) | (body[p + 1] << 16) | (body[p + 2] << 8) | body[p + 3]) >>> 0);
    }
    expandSchedule(words);
    const working = sha256Rounds(state, words, 0);
    const next = [];
    for (let i = 0; i < 8; i++) next.push(add(state[i], working[i]));
    state = next;
  }
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push((state[i] >>> 24) & 255, (state[i] >>> 16) & 255, (state[i] >>> 8) & 255, state[i] & 255);
  }
  return out; /* 32 bytes */
}

function wordsLe4Even(data) {
  const padded = data.slice();
  while (padded.length % 4) padded.push(0);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) {
    words.push((padded[i] | (padded[i + 1] << 8) | (padded[i + 2] << 16) | (padded[i + 3] << 24)) >>> 0);
  }
  if (words.length % 2) words.push(0);
  return words;
}

function cs64Digest(data, digest) {
  let keyA = ((digest[0] | (digest[1] << 8) | (digest[2] << 16) | (digest[3] << 24)) >>> 0);
  let keyB = ((digest[4] | (digest[5] << 8) | (digest[6] << 16) | (digest[7] << 24)) >>> 0);
  keyA = (keyA | 1) >>> 0;
  keyB = (keyB | 1) >>> 0;
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];

  const terms = [];
  const offsets = [];
  for (let i = 0; i < CS64_COEFFICIENTS.length; i++) {
    terms.push(mul(CS64_COEFFICIENTS[i][0], factors[i % 2]));
    offsets.push(CS64_COEFFICIENTS[i][1] >>> 0);
  }
  const words = wordsLe4Even([0].concat(data));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let term = mul(w, i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(w), i % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = add(term, mul(CS64_ADJUSTMENT0, factors[0]));
      offset = add(offset, CS64_ADJUSTMENT1);
    }
    terms.push(term);
    offsets.push(offset);
  }

  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16(add(offsets[i], x));
    let q = mul(t, 0x76f50f34);
    swapAcc = add(swapAcc, add(mul(rol16(q), 0xc3efea97), q));
    t = rol16(add(offsets[i + 1], y));
    q = mul(t, 0x1881ce3c);
    swapLast = add(mul(rol16(q), 0x35bd1ec9), q);
    swapAcc = add(swapAcc, swapLast);

    state = add(mul(state, keyA), x);
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc = add(acc, state);
    t = add(mul(state, keyB), y);
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = add(acc, state);
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

/* 파이썬 struct.pack("<II") 와 같은 순서 — 워드마다 리틀엔디언 바이트로 찍는다 */
function hex8(v) {
  v = v >>> 0;
  let s = '';
  for (let i = 0; i < 4; i++) s += ('0' + ((v >>> (i * 8)) & 0xff).toString(16)).slice(-2);
  return s.toUpperCase();
}

/** unix 초(생략 시 현재 시각) → "<16hex>-<64hex>" Sec-MS-GEC 토큰 */
function secMsGec(unixTimestamp) {
  let ticks = unixTimestamp == null ? Date.now() / 1000 : Number(unixTimestamp);
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7; /* S_TO_NS / 100 */
  const str = ticks.toFixed(0) + TRUSTED_CLIENT_TOKEN;
  const data = [];
  for (let i = 0; i < str.length; i++) data.push(str.charCodeAt(i) & 0xff);

  const digest = sha256Digest(data);
  const cs = cs64Digest(data, digest);
  let sha = '';
  for (let i = 0; i < digest.length; i++) sha += ('0' + digest[i].toString(16)).slice(-2);
  return hex8(cs[0]) + hex8(cs[1]) + '-' + sha.toUpperCase();
}

module.exports = { secMsGec, TRUSTED_CLIENT_TOKEN };
