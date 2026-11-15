#!/usr/bin/env node
/**
 * 🛡️ 포켓몬 통합 도감 — 아빠 PIN 삭제가 다른 기기·낡은 탭에서 되살아나지 않는지 검증
 *
 *   node test_pokemon_dex_guard.mjs
 *
 * · 실제 네트워크는 쓰지 않는다(Supabase HTTP 는 전부 모킹 — 운영 코드 0623 에 절대 쓰지 않음)
 * · 페이지 쪽 함수(setDexMon / readSlot / writeSlot / markCaught)는 **HTML 에서 원문을 그대로 떼어내**
 *   실행한다(테스트용 복사본이 아니라 배포될 코드 그대로).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => readFileSync(here(p), 'utf8');
const SYNC_SRC = read('./public/pokemon-sync.js');
const BATTLE_HTML = read('./public/pokemon-battle.html');
const MATH_HTML = read('./public/math-pokemon.html');
const VILLAGE_HTML = read('./public/village-pokemon.html');

const DEX_KEY = 'pkm.shared.dex.v1.p1';

let pass = 0;
const fails = [];
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push({ name, e }); console.log('  ✗ ' + name + ' — ' + e.message); }
}
function section(t) { console.log('\n' + t); }

/* ============================================================
   원문 발췌 도우미 — 중괄호 짝을 세어 함수 하나를 통째로 떼어낸다
   ============================================================ */
function sliceBraces(src, start) {
  let i = src.indexOf('{', start);
  if (i < 0) throw new Error('중괄호 시작을 못 찾음');
  let depth = 0, inStr = null, esc = false, inLine = false, inBlock = false, inTpl = 0;
  for (let j = i; j < src.length; j += 1) {
    const c = src[j], n = src[j + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; j += 1; } continue; }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; j += 1; continue; }
    if (c === '/' && n === '*') { inBlock = true; j += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('함수 끝을 못 찾음');
}
function fnSrc(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('function ' + name + ' 없음');
  return sliceBraces(src, at);
}
function blockFrom(src, fromMarker, toMarker) {
  const a = src.indexOf(fromMarker);
  const b = src.indexOf(toMarker, a + 1);
  if (a < 0 || b < 0) throw new Error('구간 없음: ' + fromMarker);
  return src.slice(a, b);
}

/* ============================================================
   가짜 저장소 · 가짜 서버 · 기기 하나(브라우저 흉내)
   ============================================================ */
function fakeStorage() {
  const m = new Map();
  return {
    _map: m,
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(String(k)); },
    key: (i) => (Array.from(m.keys())[i] ?? null),
    get length() { return m.size; },
    clear: () => m.clear(),
    dump: () => Object.fromEntries(m)
  };
}

function makeServer() {
  const rows = new Map();      /* code → {code, data, updated_at} */
  const log = [];
  let posts = 0;
  const reply = (json, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => (json == null ? '' : JSON.stringify(json))
  });
  async function fetchMock(url, opts = {}) {
    const u = new URL(String(url));
    /* ⚠️ 실제 서버로 나가는 요청은 한 건도 없어야 한다 — 이 게이트가 그 증거 */
    if (u.hostname !== 'hiruybkapzuhjrzjoyik.supabase.co') throw new Error('예상 밖 호스트: ' + u.hostname);
    if (!/\/rest\/v1\/family_sync$/.test(u.pathname)) throw new Error('예상 밖 경로: ' + u.pathname);
    const method = (opts.method || 'GET').toUpperCase();
    const rawCode = u.searchParams.get('code');
    const code = rawCode == null ? null : String(rawCode).replace(/^eq\./, '');   /* Supabase 필터 표기 eq.0623 */
    log.push({ method, code });
    if (method === 'GET') {
      const row = rows.get(code);
      return reply(row ? [JSON.parse(JSON.stringify(row))] : []);
    }
    if (method === 'POST') {
      posts += 1;
      const body = JSON.parse(opts.body);
      const row = body[0];
      /* updated_at 은 반드시 앞으로만 가게(클라이언트 시계가 같아도 순서가 뒤집히지 않게) */
      const prev = rows.get(row.code);
      let t = Date.parse(row.updated_at);
      if (prev) t = Math.max(t, Date.parse(prev.updated_at) + 2000);
      rows.set(row.code, {
        code: row.code,
        data: JSON.parse(JSON.stringify(row.data)),
        updated_at: new Date(t).toISOString()
      });
      return reply(null, 201);
    }
    if (method === 'DELETE') { rows.delete(code); return reply(null, 204); }
    throw new Error('예상 밖 메서드: ' + method);
  }
  return { rows, log, fetchMock, posts: () => posts, dex: (code = '0623') => JSON.parse(((rows.get(code) || {}).data || {}).keys?.[DEX_KEY] || 'null') };
}

function makeDevice(server, tag) {
  const localStorage = fakeStorage();
  const listeners = {};
  const doc = {
    readyState: 'loading',       /* boot() 가 자동으로 돌지 않게 — 테스트가 직접 push/pull 을 부른다 */
    hidden: true,
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {} }, remove() {} }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    body: { appendChild() {} },
    currentScript: null,
    dispatchEvent: () => true
  };
  const ctx = {
    console, JSON, Math, Date, Number, String, Object, Array, Boolean, Promise, Error, URL,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    localStorage,
    fetch: server.fetchMock,
    navigator: { userAgent: tag },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    Event: class { constructor(t) { this.type = t; } },
    document: doc,
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: () => {},
    listeners
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SYNC_SRC, ctx, { filename: 'pokemon-sync.js' });
  const sync = ctx.window.PkmSync;
  if (!sync || !sync.mergeDex) throw new Error('PkmSync.mergeDex 를 못 찾음');
  return {
    tag,
    localStorage,
    sync,
    dex: () => JSON.parse(localStorage.getItem(DEX_KEY) || 'null'),
    setDex: (raw) => localStorage.setItem(DEX_KEY, typeof raw === 'string' ? raw : JSON.stringify(raw)),
    seen: () => (sync.debug().meta.seen || {})[DEX_KEY] || []
  };
}

const dexObj = (ids, extra = {}) => JSON.stringify(Object.assign({
  ids, counts: Object.fromEntries(ids.map((i) => [i, 1])), dates: {}, subjects: {}, v: 1
}, extra));

/* ============================================================
   페이지 쪽 함수(배포 코드 원문)를 실행 가능한 형태로 만든다
   ============================================================ */
function pageDexFns(html, storage) {
  const src = blockFrom(html, 'const SHARED_PREFIX', 'function migrateLegacyDex');
  const make = new Function('localStorage', src + '\nreturn { SHARED_PREFIX, emptyDex, readSlot, writeSlot, markCaught, stampMax };');
  return make(storage);
}

/* 배틀 페이지의 도감 넣기/빼기(setDexMon)를 원문 그대로 실행 */
function battleSetDexMon(storage, slot = 'p1') {
  const src = fnSrc(BATTLE_HTML, 'setDexMon');
  const make = new Function(
    'byId', 'Dex', 'keyOf', 'jget', 'lsSet', 'purgeVillage', 'renderDex', 'refreshHome', 'stampDate',
    src + '\nreturn setDexMon;'
  );
  return make(
    (id) => ({ id: Number(id), name: '#' + id }),
    { slot },
    (s) => 'pkm.shared.dex.v1.' + s,
    (k, d) => { try { const v = storage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    (k, v) => storage.setItem(k, v),
    () => {},
    () => {},
    () => {},
    () => '2026-11-16'
  );
}

/* 마을 페이지의 setDexMon 도 원문 그대로 */
function villageSetDexMon(storage, slot = 'p1') {
  const srcDexKey = fnSrc(VILLAGE_HTML, 'dexKey');
  const srcSet = fnSrc(VILLAGE_HTML, 'setDexMon');
  const make = new Function(
    'byId', 'SLOT', 'lsGet', 'lsSet', 'stampDate', 'allVillages', 'THEMES', 'K_VIL', 'paintVillage', 'renderDex',
    srcDexKey + '\n' + srcSet + '\nreturn setDexMon;'
  );
  return make(
    (id) => ({ id: Number(id), name: '#' + id }),
    slot,
    (k, d) => { try { const v = storage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    (k, v) => storage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)),
    () => '2026-11-16',
    () => ({}),
    [], () => 'pkm.village.v2.',
    () => {},
    () => {}
  );
}

/* ============================================================
   1) mergeDex 규칙 단위 검증
   ============================================================ */
const srv = makeServer();
const dev = makeDevice(srv, 'unit');
const merge = (r, l, prev) => JSON.parse(dev.sync.mergeDex(JSON.stringify(r), JSON.stringify(l), prev));

section('1) mergeDex — 🗑 지운 기록(removed) · 🎁 다시 잡은 기록(caughtAt)');
ok('지운 시각 이후 다시 잡은 기록이 없으면, 클라우드에 남아 있어도 빠진다', () => {
  const t2 = 2000, out = merge(
    { ids: [1, 4, 25], counts: { 25: 1 }, v: 1 },
    { ids: [1, 4], counts: {}, removed: { 25: t2 }, v: 1 },
    [1, 4, 25]
  );
  assert.deepEqual(out.ids, [1, 4]);
  assert.equal(out.counts['25'], undefined, '지운 포켓몬의 잡은 횟수가 남으면 안 된다');
  assert.equal(out.removed['25'], t2, '지운 기록은 클라우드에 남겨 둔다');
});

ok('지운 기록이 없던 낡은 기기의 목록도 지운 포켓몬을 되살리지 못한다', () => {
  const t2 = 2000, out = merge(
    { ids: [1, 4], counts: {}, removed: { 25: t2 }, v: 1 },     /* 클라우드(A 가 지운 뒤) */
    { ids: [1, 4, 25], counts: { 25: 1 }, v: 1 },               /* 낡은 기기 B */
    [1, 4, 25]
  );
  assert.deepEqual(out.ids, [1, 4]);
  assert.equal(out.removed['25'], t2);
});

ok('지운 뒤 다시 잡으면(caughtAt > removed) 정상적으로 되살아난다', () => {
  const t2 = 2000, t3 = 3000, out = merge(
    { ids: [1, 4], counts: {}, removed: { 25: t2 }, v: 1 },
    { ids: [1, 4, 25], counts: { 25: 1 }, caughtAt: { 25: t3 }, v: 1 },
    [1, 4]
  );
  assert.deepEqual(out.ids, [1, 4, 25]);
  assert.equal(out.caughtAt['25'], t3, '다시 잡은 시각을 기억해야 다음 기기도 살린다');
  assert.equal(out.removed['25'], t2, '지운 기록은 남겨 두되 caughtAt 이 더 최신이면 살아난다');
});

ok('다시 잡은 기록이 지운 기록보다 오래되면 살아나지 않는다', () => {
  const out = merge(
    { ids: [1, 4], counts: {}, removed: { 25: 5000 }, v: 1 },
    { ids: [1, 4, 25], counts: {}, caughtAt: { 25: 3000 }, v: 1 },
    [1, 4, 25]
  );
  assert.deepEqual(out.ids, [1, 4]);
});

ok('🗑 도감 초기화(resetAt) 뒤에는 낡은 기기의 옛 목록이 되살아나지 않는다', () => {
  const t = 9000, out = merge(
    { ids: [], counts: {}, v: 1, resetAt: t },
    { ids: [1, 4, 25], counts: { 1: 1 }, v: 1 },
    [1, 4, 25]
  );
  assert.deepEqual(out.ids, []);
  assert.equal(out.resetAt, t);
});

ok('초기화 뒤에 새로 잡은 포켓몬은 살아남는다', () => {
  const t = 9000, out = merge(
    { ids: [], counts: {}, v: 1, resetAt: t },
    { ids: [1, 4, 133], counts: { 133: 1 }, caughtAt: { 133: 9500 }, v: 1 },
    [1, 4]
  );
  assert.deepEqual(out.ids, [133]);
});

ok('날짜·과목 기록도 합치면서 잃지 않는다', () => {
  const out = merge(
    { ids: [1], counts: { 1: 1 }, dates: { 1: '2026-11-10' }, subjects: { 1: ['math'] }, v: 1 },
    { ids: [1, 4], counts: { 4: 2 }, dates: { 4: '2026-11-12', 1: '2026-11-11' }, subjects: { 4: ['hangul'], 1: ['english'] }, v: 1 },
    [1]
  );
  assert.deepEqual(out.ids, [1, 4]);
  assert.equal(out.dates['1'], '2026-11-10', '가장 이른 날짜를 남긴다');
  assert.equal(out.dates['4'], '2026-11-12');
  assert.deepEqual(out.subjects['1'].sort(), ['english', 'math']);
});

/* ============================================================
   2) 페이지 저장소 — 지운/다시 잡은 기록을 저장에서 잃지 않는가
   ============================================================ */
section('2) 페이지 저장소 — writeSlot 이 지운·다시 잡은·초기화 기록을 보존하는가');
const pageStore = fakeStorage();
const mathDex = pageDexFns(MATH_HTML, pageStore);
const hgDex = pageDexFns(read('./public/hangul-pokemon.html'), pageStore);
const enDex = pageDexFns(read('./public/english-pokemon.html'), pageStore);

ok('낡은 탭이 예전 목록을 저장해도 removed 기록이 지워지지 않는다', () => {
  pageStore.clear();
  pageStore.setItem(DEX_KEY, dexObj([1, 4], { removed: { 25: 2000 } }));
  const stale = mathDex.readSlot('p1');         /* 삭제를 아직 못 받은 탭이 예전 목록을 들고 있다 */
  stale.ids.add(25);
  stale.counts[25] = 1;
  mathDex.writeSlot('p1', stale);
  const saved = JSON.parse(pageStore.getItem(DEX_KEY));
  assert.equal(saved.removed['25'], 2000, 'removed 기록이 살아 있어야 다른 기기가 되살리지 못한다');
});

ok('산수·한글·영어 세 페이지 모두 removed 를 읽고 쓴다', () => {
  [mathDex, hgDex, enDex].forEach((api, i) => {
    pageStore.clear();
    pageStore.setItem(DEX_KEY, dexObj([1], { removed: { 25: 2000 }, caughtAt: {}, resetAt: 0 }));
    const d = api.readSlot('p1');
    assert.equal(d.removed['25'], 2000, ['math', 'hangul', 'english'][i] + ' readSlot');
    assert.equal(typeof api.markCaught, 'function');
    d.ids.add(25);                    /* 🎁 실제 포획처럼 목록에도 넣고 */
    d.counts[25] = 1;
    api.markCaught(d, 25);            /*    다시 잡은 시각을 찍는다 */
    api.writeSlot('p1', d);
    const saved = JSON.parse(pageStore.getItem(DEX_KEY));
    assert.ok(saved.ids.includes(25));
    assert.ok(saved.caughtAt['25'] > saved.removed['25'], ['math', 'hangul', 'english'][i] + ' 다시 잡음 기록');
  });
});

/* ============================================================
   3) 실제 시나리오 — 기기 A 삭제 → 낡은 기기 B 가 나중에 접속
   ============================================================ */
section('3) 기기 A(PIN 삭제) → 클라우드 → 낡은 기기 B(pull+push)');
const server = makeServer();
const A = makeDevice(server, 'phone');
const B = makeDevice(server, 'tablet');

const boot = (async () => {
  A.setDex(dexObj([1, 4, 25]));
  B.setDex(dexObj([1, 4, 25]));           /* 두 기기 다 25 를 갖고 있던 상태 */
  await A.sync.push();                    /* A 가 먼저 올리고, B 는 그것을 받아 본다 */
  await B.sync.pull();
})();

let t2 = 0;
await boot;
console.log('  · A 첫 업로드: ' + A.sync.state().msg + ' / B 첫 수신: ' + B.sync.state().msg);
ok('두 기기가 같은 클라우드 상태에서 출발한다 (id 25 포함)', () => {
  const cloud = server.dex();
  assert.deepEqual(cloud.ids.sort((x, y) => x - y), [1, 4, 25]);
  assert.deepEqual(B.seen().sort((x, y) => x - y), [1, 4, 25], 'B 는 25 를 본 것으로 기억해야 한다');
});

/* 🔐 아빠 PIN 삭제 — 배틀 페이지의 setDexMon(배포 코드 원문) 그대로 실행 */
const Astore = fakeStorage();
Object.entries(A.localStorage.dump()).forEach(([k, v]) => Astore.setItem(k, v));
const aToggler = battleSetDexMon(Astore, 'p1');
const removedReturn = aToggler(25, false);
Object.entries(Astore.dump()).forEach(([k, v]) => A.localStorage.setItem(k, v));
const afterDelete = A.dex();
t2 = Number(afterDelete.removed['25']);

ok('기기 A 에서 25 를 지우면 removed["25"] 에 시각이 찍힌다', () => {
  assert.equal(removedReturn, false);
  assert.deepEqual(afterDelete.ids, [1, 4]);
  assert.ok(t2 > 0, 'removed 시각이 있어야 한다');
  assert.equal(afterDelete.caughtAt && afterDelete.caughtAt['25'], undefined);
});
ok('지운 직후 클라우드에는 아직 25 가 남아 있다 (A 가 아직 안 올림)', () => {
  assert.ok(server.dex().ids.includes(25));
});

const pushAfterDelete = await A.sync.push();
ok('A 가 올리면 클라우드에서도 25 가 빠지고 removed 기록이 남는다', () => {
  assert.equal(pushAfterDelete, 'pushed');
  const cloud = server.dex();
  assert.deepEqual(cloud.ids, [1, 4], '클라우드 ids: ' + JSON.stringify(cloud.ids));
  assert.equal(cloud.removed['25'], t2);
});

/* 낡은 기기 B — 가장 위험한 순서(pull 없이 바로 push)부터 */
const bPushFirst = await B.sync.push();
ok('B 가 pull 없이 곧바로 push 해도 25 가 되살아나지 않는다', () => {
  /* mergeDex 가 B 의 옛 목록을 그대로 걸라내면 올릴 것이 없어 same 이 된다 — 둘 다 정상 */
  assert.ok(['pushed', 'same'].includes(bPushFirst), 'push 결과: ' + bPushFirst);
  assert.deepEqual(server.dex().ids, [1, 4], '클라우드: ' + JSON.stringify(server.dex().ids));
  assert.deepEqual(B.dex().ids, [1, 4], 'B 화면: ' + JSON.stringify(B.dex().ids));
});

const bPull = await B.sync.pull();
ok('B 가 pull 해도 25 는 돌아오지 않고, 지운 기록을 받아 둔다', () => {
  assert.deepEqual(B.dex().ids, [1, 4], 'B: ' + JSON.stringify(B.dex().ids) + ' (' + bPull + ')');
  assert.equal(B.dex().removed['25'], t2);
});

const aPull = await A.sync.pull();
ok('A 로 다시 받아도 25 는 그대로 지워져 있다', () => {
  assert.deepEqual(A.dex().ids, [1, 4], 'A: ' + JSON.stringify(A.dex().ids) + ' (' + aPull + ')');
});

/* 게임 도중 저장이 끼어들어도(산수 페이지 writeSlot) 되살아나지 않는가 */
const bGame = pageDexFns(MATH_HTML, B.localStorage);
const bStale = bGame.readSlot('p1');
bStale.ids.add(25);                       /* 메모리에 남아 있던 옛 목록 */
bGame.writeSlot('p1', bStale);
ok('  └ 메모리에 남은 25 를 저장해도 removed 기록이 유지된다', () => {
  assert.equal(B.dex().removed['25'], t2);
  assert.ok(B.dex().ids.includes(25), '이 기기 메모리에는 아직 남아 있을 수 있다');
});

const bPush2 = await B.sync.push();
ok('그 상태로 다시 올려도 클라우드에는 25 가 없다', () => {
  assert.deepEqual(server.dex().ids, [1, 4], '클라우드: ' + JSON.stringify(server.dex().ids) + ' (' + bPush2 + ')');
});

/* ============================================================
   4) 다시 잡음 — 배틀/게임에서 25 를 실제로 다시 잡으면 정상 복원
   ============================================================ */
section('4) 🎁 다시 잡기 — 지운 포켓몬을 실제로 다시 잡으면 복원');
await new Promise((r) => setTimeout(r, 8));      /* caughtAt 이 removed 보다 확실히 뒤가 되게 */
const A2 = fakeStorage();
Object.entries(A.localStorage.dump()).forEach(([k, v]) => A2.setItem(k, v));
const aToggler2 = battleSetDexMon(A2, 'p1');
aToggler2(25, true);                              /* 🎁 도감에 넣기(=다시 잡음) */
Object.entries(A2.dump()).forEach(([k, v]) => A.localStorage.setItem(k, v));
const recaught = A.dex();
const t3 = Number(recaught.caughtAt['25']);

ok('A 에서 다시 잡으면 caughtAt 에 새 시각이 찍히고 removed 에서 빠진다', () => {
  assert.ok(recaught.ids.includes(25));
  assert.ok(t3 > t2, 'caughtAt(' + t3 + ') 이 removed(' + t2 + ') 보다 뒤여야 한다');
  assert.equal((recaught.removed || {})['25'], undefined);
});

const pushRecatch = await A.sync.push();
ok('클라우드에 25 가 정상 복원되고 다시 잡은 시각이 남는다', () => {
  assert.equal(pushRecatch, 'pushed');
  const cloud = server.dex();
  assert.deepEqual(cloud.ids.sort((x, y) => x - y), [1, 4, 25], '클라우드: ' + JSON.stringify(cloud.ids));
  assert.equal(cloud.caughtAt['25'], t3);
});

await B.sync.pull();
ok('B 도 pull 하면 25 를 다시 받는다', () => {
  assert.deepEqual(B.dex().ids.sort((x, y) => x - y), [1, 4, 25], 'B: ' + JSON.stringify(B.dex().ids));
});

/* 낡은 기기 C(예전 목록 + 재포획 기록 없음)가 뒤늦게 켜져도 삭제 상태는 유지 */
const C = makeDevice(server, 'pc');
await C.sync.pull();
ok('  └ 기기 C: 25 포함 상태로 맞춰진다', () => {
  assert.deepEqual(C.dex().ids.sort((x, y) => x - y), [1, 4, 25]);
});

/* ============================================================
   5) 마을 페이지(PIN 삭제)도 같은 규칙을 쓰는가
   ============================================================ */
section('5) 마을 페이지 setDexMon — 지운 기록 남기기');
ok('마을에서 25 를 지우면 removed 에 시각이 찍히고 다른 기록은 보존된다', () => {
  const st = fakeStorage();
  st.setItem(DEX_KEY, dexObj([1, 4, 25], { resetAt: 777, subjects: { 1: ['math'] } }));
  const toggle = villageSetDexMon(st, 'p1');
  toggle(25, false);
  const saved = JSON.parse(st.getItem(DEX_KEY));
  assert.deepEqual(saved.ids, [1, 4]);
  assert.ok(saved.removed['25'] > 0);
  assert.equal(saved.resetAt, 777, '초기화 표시를 지우면 안 된다');
  assert.deepEqual(saved.subjects['1'], ['math']);
});

ok('마을에서 다시 넣으면 caughtAt 이 찍혀 되살아난다', () => {
  const st = fakeStorage();
  st.setItem(DEX_KEY, dexObj([1], { removed: { 25: 1 } }));
  const toggle = villageSetDexMon(st, 'p1');
  toggle(25, true);
  const saved = JSON.parse(st.getItem(DEX_KEY));
  assert.ok(saved.ids.includes(25));
  assert.ok(saved.caughtAt && saved.caughtAt['25'] > 1, '다시 잡은 시각이 더 최신이라 살아난다');
  /* 클라우드에 남아 있는 지운 기록(1)이 있어도 mergeDex 가 살리는지까지 확인 */
  const out = JSON.parse(dev.sync.mergeDex(JSON.stringify({ ids: [1], removed: { 25: 1 }, v: 1 }), st.getItem(DEX_KEY), [1]));
  assert.ok(out.ids.includes(25), '클라우드 지운 기록보다 최신인 다시 잡음은 살아나야 한다');
});

/* ============================================================
   6) 구문·안전 점검
   ============================================================ */
section('6) 안전 점검');
ok('테스트는 실제 Supabase 로 요청을 보내지 않았다(모킹만 사용)', () => {
  assert.ok(server.log.length > 0, '모킹 서버가 쓰여야 한다');
  assert.ok(server.log.every((r) => r.code === '0623' || r.code == null));
  assert.equal(typeof globalThis.__realFetch, 'undefined');
});
ok('운영 코드 0623 은 이 테스트에서 저장/삭제된 적이 없다(가짜 서버 메모리뿐)', () => {
  assert.ok(server.posts() > 0);
});

console.log('\n' + (fails.length ? '❌ 실패 ' + fails.length + '건 / 통과 ' + pass + '건' : '✅ 전체 통과 (' + pass + '건)'));
if (fails.length) {
  fails.forEach((f) => console.log('\n[' + f.name + ']\n' + (f.e.stack || f.e.message)));
  process.exit(1);
}
