#!/usr/bin/env node
/**
 * 🐛➕ 포켓몬 도감 — 지안(p2) 분리 + 아빠 권한 '➕ 포켓몬 추가' E2E
 *
 *   node test_pokemon_dex_fix.mjs              (로컬 dev_server 자동 기동)
 *   BASE=https://pokemon-battle-world.vercel.app node test_pokemon_dex_fix.mjs
 *
 *  검증
 *   1) 한글 게임에서 지안(hpb p2)으로 5문제 맞히고 잡으면 pkm.shared.dex.v1.p2 에만 쌓이는지
 *      (아린 p1 은 그대로인지)
 *   2) 아빠 PIN 을 통과했을 때만 ➕ 포켓몬 추가 버튼이 보이고, 추가·삭제가 즉시 반영되는지
 *   3) 400×860 · 884×960 두 화면에서 콘솔 오류 0건
 *
 *  · Supabase(가족 클라우드) 요청은 전부 가로채 가짜 응답을 준다 — 운영 코드 0623 에 절대 쓰지 않는다.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let puppeteer;
try { puppeteer = createRequire(import.meta.url)('puppeteer'); }
catch (_) { puppeteer = createRequire('/workspace/_tools/e2e/run.mjs')('puppeteer'); }

const EXTERNAL = process.env.BASE || null;
const PORT = Number(process.env.PORT || 8798);
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/screenshots/pkdexfix_1116';
mkdirSync(SHOT_DIR, { recursive: true });
const SHOT = (n) => path.join(SHOT_DIR, `${n}.png`);

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok: !!ok, detail: detail === undefined ? null : detail });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail !== undefined && detail !== null ? `  → ${detail}` : ''}`);
  return !!ok;
};

/* ---------------- 서버 ---------------- */
let srv = null;
async function startServer() {
  if (EXTERNAL) return;
  srv = spawn(process.execPath, [path.join(__dirname, 'dev_server.mjs')], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(BASE + '/pokemon-battle.html');
      if (r.ok) return;
    } catch (_) { /* */ }
    await sleep(250);
  }
  throw new Error('dev_server 기동 실패');
}

/* ---------------- 화면 시드 ---------------- */
const TODAY = (() => {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
})();

const SEED = `
try {
  sessionStorage.setItem('pkm.family.unlocked.v1', '1');
  var hpb = { active: 'p2', list: [
    { id: 'p1', name: '아린', emoji: '👧', diff: 'mid', level: 'mid', range: 'all' },
    { id: 'p2', name: '지안', emoji: '🧒', diff: 'easy', level: 'easy', range: 'all' },
    { id: 'p3', name: '게스트', emoji: '🧪', diff: 'easy', level: 'easy', range: 'all' }
  ] };
  var mpb = { active: 'p1', list: [
    { id: 'p1', name: '아린', emoji: '👧', diff: 'mid', op: 'mix', mix: 'all', ops: ['add', 'sub', 'mul'], range: 'all' },
    { id: 'p2', name: '지안', emoji: '🧒', diff: 'easy', op: 'mix', mix: 'all', ops: ['add'], range: 'all' },
    { id: 'p3', name: '게스트', emoji: '🧪', diff: 'easy', op: 'mix', mix: 'all', ops: ['add'], range: 'all' }
  ] };
  var epb = { active: 'p1', list: [
    { id: 'p1', name: '아린', emoji: '👧', diff: 'mid', level: 'mid', range: 'all' },
    { id: 'p2', name: '지안', emoji: '🧒', diff: 'easy', level: 'easy', range: 'all' },
    { id: 'p3', name: '게스트', emoji: '🧪', diff: 'easy', level: 'easy', range: 'all' }
  ] };
  localStorage.setItem('hpb.profiles.v1', JSON.stringify(hpb));
  localStorage.setItem('mpb.profiles.v1', JSON.stringify(mpb));
  localStorage.setItem('epb.profiles.v1', JSON.stringify(epb));
  /* 아린(p1) — 산수에서 잡은 두 마리만 */
  localStorage.setItem('pkm.shared.dex.v1.p1', JSON.stringify({
    ids: [265, 366], counts: { '265': 1, '366': 1 },
    dates: { '265': '${TODAY}', '366': '${TODAY}' },
    subjects: { '265': ['math'], '366': ['math'] }, v: 1
  }));
  /* 지안(p2) — 비어 있음 */
  localStorage.setItem('pkm.shared.dex.v1.p2', JSON.stringify({ ids: [], counts: {}, dates: {}, subjects: {}, v: 1 }));
  localStorage.setItem('pkm.shared.dex.v1.guest', JSON.stringify({ ids: [], counts: {}, v: 1 }));
  localStorage.setItem('pkm.shared.dex.v1.migrated', JSON.stringify([
    'mpb.dex.v2.p1','mpb.dex.v2.p2','mpb.dex.v1','hpb.dex.v1.p1','hpb.dex.v1.p2','epb.dex.v1.p1','epb.dex.v1.p2'
  ]));
  localStorage.setItem('pkm.quota.v1', JSON.stringify({ v: 1, date: '${TODAY}', limit: 0, plays: {} }));
} catch (e) {}
`;

/* ---------------- 페이지 도우미 ---------------- */
const consoleErrors = [];
function watch(page, tag) {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push({ tag, text: String(m.text()).slice(0, 300) });
  });
  page.on('pageerror', (e) => consoleErrors.push({ tag, text: 'pageerror: ' + String(e.message).slice(0, 300) }));
}
async function newPage(browser, w, h) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: w < 600, hasTouch: w < 600 });
  /* 가족 클라우드는 전부 가짜 — 운영 0623 행에는 절대 쓰지 않는다 */
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('supabase.co')) {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS'
      };
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors, body: '' });
      if (req.method() === 'GET') return req.respond({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: '[]' });
      return req.respond({ status: 201, headers: { ...cors, 'content-type': 'application/json' }, body: '{}' });
    }
    return req.continue();
  });
  await page.evaluateOnNewDocument(SEED);
  return page;
}
async function dex(page, slot) {
  return page.evaluate((s) => JSON.parse(localStorage.getItem('pkm.shared.dex.v1.' + s) || '{}'), slot);
}
async function longPress(page, selector, ms = 780) {
  const box = await page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 40) };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await sleep(ms);
  await page.mouse.up();
}
async function enterPin(page, padSelector = '#dPinPad') {
  for (const d of ['0', '6', '2', '3']) {
    await page.click(`${padSelector} button[data-pk="${d}"], ${padSelector} button[data-dd="${d}"], ${padSelector} button[data-d="${d}"]`);
    await sleep(90);
  }
  await sleep(260);
}

/* ---------------- 1) 한글 게임 — 지안(p2) 도감 분리 ---------------- */
async function testHangul(browser, w, h) {
  const page = await newPage(browser, w, h);
  watch(page, `hangul-${w}`);
  await page.goto(BASE + '/hangul-pokemon.html', { waitUntil: 'domcontentloaded' });
  await sleep(2600);

  /* 슬롯 매핑 단위 확인 — 이름으로 갈리는지 */
  const map = await page.evaluate(() => ({
    p1: slotFor('hangul', 'p1'), p2: slotFor('hangul', 'p2'), guest: slotFor('hangul', 'p3'),
    fromJian: slotFromName('지안'), fromArin: slotFromName('아린')
  }));
  check(`[한글 ${w}] 프로필 매핑 아린(p1)=p1 · 지안(p2)=p2`, map.p1 === 'p1' && map.p2 === 'p2', JSON.stringify(map));

  /* 지안(p2)으로 출전 → 문제 5개 맞히고 잡기 */
  await page.evaluate(() => {
    const card = document.querySelector('#startList .pfl[data-id="p2"]');
    if (card) card.click();
  });
  await sleep(400);
  const prepWho = await page.evaluate(() => (document.getElementById('prepWho') || {}).textContent || '');
  await page.evaluate(() => { const b = document.getElementById('prepGo'); if (b) b.click(); });
  await sleep(1400);
  check(`[한글 ${w}] 지안으로 출전`, prepWho.includes('지안'), prepWho);

  let caughtId = null;
  for (let i = 0; i < 8; i += 1) {
    const st = await page.evaluate(() => ({ screen: S.screen, wild: S.wild && S.wild.id, hp: S.foeHP }));
    if (st.screen === 'caught') { caughtId = st.wild; break; }
    if (st.screen === 'capturing') { await sleep(1200); continue; }
    const ok = await page.$('#choices .choice[data-ok="1"]');
    if (!ok) { await sleep(400); continue; }
    await ok.click();
    await sleep(900);
    const after = await page.evaluate(() => ({ screen: S.screen, wild: S.wild && S.wild.id }));
    if (after.screen === 'caught' || after.screen === 'capturing') { caughtId = after.wild; }
  }
  await sleep(1500);
  const caughtModal = await page.evaluate(() => !document.getElementById('catchModal').hidden);
  check(`[한글 ${w}] 지안 차례로 문제를 맞혀 포획까지 진행`, caughtModal && caughtId != null, `wild=${caughtId} modal=${caughtModal}`);

  const p2 = await dex(page, 'p2');
  const p1 = await dex(page, 'p1');
  const inP2 = Array.isArray(p2.ids) && p2.ids.map(Number).includes(Number(caughtId));
  const p1Same = Array.isArray(p1.ids) && p1.ids.length === 2 && !p1.ids.map(Number).includes(Number(caughtId));
  check(`[한글 ${w}] 포획분이 지안(p2) 도감에만 저장`, inP2, `p2.ids=${JSON.stringify(p2.ids)}`);
  check(`[한글 ${w}] 아린(p1) 도감은 그대로(2마리)`, p1Same, `p1.ids=${JSON.stringify(p1.ids)}`);
  const subs = (p2.subjects && p2.subjects[String(caughtId)]) || [];
  check(`[한글 ${w}] 과목 기록이 hangul`, subs.includes('hangul'), JSON.stringify(subs));

  await page.screenshot({ path: SHOT(`hangul_catch_${w}`) });
  await page.close();
}

/* ---------------- 2) 런처 — 아빠 PIN 뒤 ➕ 추가 / 🗑 삭제 ---------------- */
async function testBattleLauncher(browser, w, h) {
  const page = await newPage(browser, w, h);
  watch(page, `battle-${w}`);
  await page.goto(BASE + '/pokemon-battle.html', { waitUntil: 'domcontentloaded' });
  await sleep(2400);

  const locked = await page.evaluate(() => document.getElementById('dexAddBtn').hidden);
  check(`[런처 ${w}] 아빠 잠금 전에는 ➕ 버튼 숨김`, locked, `hidden=${locked}`);

  await page.click('#kidP2');               /* 지안 도감 열기 */
  await sleep(1200);
  const owner = await page.evaluate(() => document.getElementById('dexOwner').textContent);
  check(`[런처 ${w}] 지안 도감 제목`, owner === '지안', owner);

  /* 도감 카드를 꾹 눌러 아빠 PIN → 2분 잠금 해제 */
  const hasCells = await page.evaluate(() => document.querySelectorAll('#dexGrid .dcell').length > 0);
  if (!hasCells) {
    await page.evaluate(() => { document.querySelector('#dexTabs button[data-dtab="miss"]').click(); });
    await sleep(1200);
  }
  await longPress(page, '#dexGrid .dcell');
  await sleep(600);
  const pinOpen = await page.evaluate(() => !document.getElementById('dPinModal').hidden);
  check(`[런처 ${w}] 도감 카드 꾹 → 아빠 PIN 창`, pinOpen);
  if (pinOpen) await enterPin(page);
  await sleep(900);

  const addShown = await page.waitForFunction(() => !document.getElementById('dexAddBtn').hidden, { timeout: 5000 })
    .then(() => true).catch(() => false);
  check(`[런처 ${w}] 아빠 PIN 통과 뒤 ➕ 버튼 표시`, addShown);

  /* ➕ 모달 → 이름/번호로 찾고 지안에게 추가 */
  await page.evaluate(() => document.getElementById('dexAddBtn').click());
  await sleep(700);
  const modalOpen = await page.evaluate(() => !document.getElementById('pkdaModal').hidden);
  check(`[런처 ${w}] ➕ 포켓몬 추가 창 열림`, modalOpen);
  await page.evaluate(() => {
    const q = document.getElementById('pkdaQ');
    q.value = '268';
    q.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => !!document.querySelector('#pkdaHits .pkda-hit'), { timeout: 8000 }).catch(() => {});
  const hit = await page.evaluate(() => {
    const b = document.querySelector('#pkdaHits .pkda-hit');
    return b ? b.textContent : '';
  });
  check(`[런처 ${w}] 번호 268 로 카스쿤 검색`, hit.includes('카스쿤'), hit.trim());
  await page.evaluate(() => document.querySelector('#pkdaHits .pkda-hit').click());
  await sleep(500);
  const thumbOk = await page.evaluate(() => {
    const img = document.getElementById('pkdaArt');
    return { src: img.getAttribute('src'), nm: document.getElementById('pkdaName').textContent };
  });
  check(`[런처 ${w}] 대표 썸네일 미리보기`, /official-artwork\/268\.png/.test(thumbOk.src) && thumbOk.nm.includes('카스쿤'), JSON.stringify(thumbOk));
  await page.evaluate(() => document.querySelector('.pkda-slot[data-slot="p2"]').click());
  await sleep(200);
  await page.screenshot({ path: SHOT(`battle_add_modal_${w}`) });
  await page.evaluate(() => document.getElementById('pkdaGo').click());
  await sleep(900);

  const p2 = await dex(page, 'p2');
  check(`[런처 ${w}] 지안(p2) 도감에 268 생김`, Array.isArray(p2.ids) && p2.ids.map(Number).includes(268),
    `ids=${JSON.stringify(p2.ids)} counts=${JSON.stringify(p2.counts)}`);
  check(`[런처 ${w}] caughtAt·오늘 날짜 기록`, !!(p2.caughtAt && p2.caughtAt['268']) && p2.dates['268'] === TODAY,
    JSON.stringify({ caughtAt: p2.caughtAt && p2.caughtAt['268'], date: p2.dates['268'] }));

  /* 도감 화면 즉시 갱신 */
  const shown = await page.evaluate(() => {
    document.querySelector('#dexTabs button[data-dtab="caught"]').click();
    return document.getElementById('dexCaught').textContent;
  });
  check(`[런처 ${w}] 도감 화면 숫자 즉시 갱신`, String(shown).trim() !== '0', `dexCaught=${shown}`);
  await page.screenshot({ path: SHOT(`battle_dex_after_add_${w}`) });

  /* 🗑 삭제도 그대로 동작 — 방금 넣은 268 카드를 정확히 겨냥 */
  await page.evaluate(() => document.querySelector('.pkda-x').click());   /* ➕ 창 닫기 */
  await sleep(400);
  await page.evaluate(() => document.querySelector('#dexTabs button[data-dtab="caught"]').click());
  await sleep(700);
  await longPress(page, '#dexGrid .dcell[data-dexid="268"]');
  await sleep(700);
  const dlg = await page.evaluate(() => {
    const pd = document.getElementById('dPinModal');
    if (pd && !pd.hidden) return 'pin';
    return 'toggled';
  });
  if (dlg === 'pin') { await enterPin(page); await sleep(800); }
  const p2b = await dex(page, 'p2');
  const removedOk = !(p2b.ids || []).map(Number).includes(268) && !!(p2b.removed && p2b.removed['268']);
  check(`[런처 ${w}] 🗑 아빠 삭제 — 목록에서 사라지고 removed 기록`, removedOk,
    `ids=${JSON.stringify(p2b.ids)} removed=${JSON.stringify(p2b.removed || {})}`);

  await page.screenshot({ path: SHOT(`battle_dex_after_del_${w}`) });
  await page.close();
}

/* ---------------- 3) 산수 게임 — ➕ 추가 (아빠 잠금 해제 상태) ---------------- */
async function testMath(browser, w, h) {
  const page = await newPage(browser, w, h);
  watch(page, `math-${w}`);
  await page.goto(BASE + '/math-pokemon.html', { waitUntil: 'domcontentloaded' });
  await sleep(2400);
  const unlocked = await page.evaluate(() => !!(window.PKMLock && PKMLock.isUnlocked()));
  check(`[산수 ${w}] 가족 PIN 통과 상태`, unlocked);
  await page.evaluate(() => document.getElementById('dexBtn').click());
  await sleep(900);
  const shown = await page.waitForFunction(() => !document.getElementById('dexAddBtn').hidden, { timeout: 5000 })
    .then(() => true).catch(() => false);
  check(`[산수 ${w}] ➕ 포켓몬 추가 버튼 표시`, shown);
  await page.evaluate(() => document.getElementById('dexAddBtn').click());
  await sleep(600);
  await page.evaluate(() => {
    const q = document.getElementById('pkdaQ');
    q.value = '413';
    q.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => !!document.querySelector('#pkdaHits .pkda-hit'), { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => document.querySelector('#pkdaHits .pkda-hit').click());
  await sleep(300);
  await page.evaluate(() => document.querySelector('.pkda-slot[data-slot="p1"]').click());
  await sleep(200);
  await page.screenshot({ path: SHOT(`math_add_modal_${w}`) });
  await page.evaluate(() => document.getElementById('pkdaGo').click());
  await sleep(900);
  const p1 = await dex(page, 'p1');
  check(`[산수 ${w}] 아린(p1) 도감에 413 생김`, (p1.ids || []).map(Number).includes(413),
    `ids=${JSON.stringify(p1.ids)} subjects=${JSON.stringify(p1.subjects && p1.subjects['413'])}`);
  const badge = await page.evaluate(() => document.querySelectorAll('#dexGrid .dexcell.caught').length);
  check(`[산수 ${w}] 도감 그리드 즉시 반영`, badge >= 3, `caught cells=${badge}`);
  await page.screenshot({ path: SHOT(`math_dex_after_add_${w}`) });
  await page.close();
}

/* ---------------- 4) 마을 — ➕ 추가 (아빠 PIN 뒤) ---------------- */
async function testVillage(browser, w, h) {
  const page = await newPage(browser, w, h);
  watch(page, `village-${w}`);
  await page.goto(BASE + '/village-pokemon.html', { waitUntil: 'domcontentloaded' });
  await sleep(2800);
  await page.evaluate(() => window.VLG.dex.open());
  await sleep(1200);
  const before = await page.evaluate(() => document.getElementById('dexAddBtn').hidden);
  check(`[마을 ${w}] 아빠 잠금 전에는 ➕ 버튼 숨김`, before);
  const hasCells = await page.evaluate(() => document.querySelectorAll('#dexGrid .dcell').length > 0);
  if (!hasCells) { await page.evaluate(() => document.querySelector('#dexTabs button[data-dtab="miss"]').click()); await sleep(900); }
  await longPress(page, '#dexGrid .dcell');
  await sleep(700);
  const pinOpen = await page.evaluate(() => !document.getElementById('delItemModal').hidden);
  check(`[마을 ${w}] 카드 꾹 → 아빠 PIN 창`, pinOpen);
  if (pinOpen) await enterPin(page, '#delPad');
  const shown = await page.waitForFunction(() => !document.getElementById('dexAddBtn').hidden, { timeout: 5000 })
    .then(() => true).catch(() => false);
  if (!shown) {
    const why = await page.evaluate(() => ((document.getElementById('delMsg') || {}).textContent || '') + ' / ' + ((document.getElementById('delItemModal') || {}).hidden ? 'pin closed' : 'pin open'));
    check(`[마을 ${w}] 아빠 PIN 통과 뒤 ➕ 버튼 표시`, false, why);
  } else {
    check(`[마을 ${w}] 아빠 PIN 통과 뒤 ➕ 버튼 표시`, true);
  }
  if (shown) {
    await page.evaluate(() => document.getElementById('dexAddBtn').click());
    await sleep(600);
    await page.evaluate(() => {
      const q = document.getElementById('pkdaQ');
      q.value = '피카츄';
      q.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => !!document.querySelector('#pkdaHits .pkda-hit'), { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => { const b = document.querySelector('#pkdaHits .pkda-hit'); if (b) b.click(); });
    await sleep(300);
    await page.evaluate(() => document.querySelector('.pkda-slot[data-slot="p1"]').click());
    await page.evaluate(() => document.getElementById('pkdaGo').click());
    await sleep(900);
    const p1 = await dex(page, 'p1');
    check(`[마을 ${w}] 이름(피카츄)으로 찾아 아린(p1) 도감에 추가`, (p1.ids || []).map(Number).includes(25),
      `ids=${JSON.stringify(p1.ids)}`);
    await page.screenshot({ path: SHOT(`village_dex_after_add_${w}`) });
  }
  await page.close();
}


/* ---------------- 5) 🧬 진화 해금 — 내 도감에 이전 단계 2마리 ---------------- */
async function testEvolution(browser, w, h) {
  const page = await newPage(browser, w, h);
  watch(page, `evo-${w}`);
  await page.goto(BASE + '/math-pokemon.html', { waitUntil: 'domcontentloaded' });
  await sleep(2600);
  const ready = await page.evaluate(() => ({ n: POKEMON.length, evo: (byId(268) || {}).evoFrom, base: (byId(265) || {}).evoFrom }));
  check(`[진화 ${w}] 도감에 evoFrom 실림 (268 카스쿤 ← 265 개무소)`, ready.evo === 265 && !ready.base, JSON.stringify(ready));

  const pool = (counts, owned) => page.evaluate((c, own) => {
    S.dex = { ids: new Set(own || []), counts: c || {}, dates: {}, subjects: {} };
    const list = wildPool().map((p) => p.id);
    return { has268: list.indexOf(268) >= 0, has265: list.indexOf(265) >= 0, n: list.length };
  }, counts, owned);

  const r0 = await pool({}, []);
  check(`[진화 ${w}] 0마리 — 카스쿤(진화형) 풀에서 제외`, !r0.has268 && r0.has265, JSON.stringify(r0));

  const r1 = await pool({ '265': 1 }, []);
  check(`[진화 ${w}] 개무소 1마리 — 아직 카스쿤 제외`, !r1.has268 && r1.has265, JSON.stringify(r1));

  const r2 = await pool({ '265': 2 }, []);
  check(`[진화 ${w}] 개무소 2마리 — 카스쿤 풀에 포함`, r2.has268, JSON.stringify(r2));

  const r3 = await pool({ '265': 0 }, [268]);
  check(`[진화 ${w}] 이미 카스쿤을 갖고 있으면 계속 등장`, r3.has268, JSON.stringify(r3));

  /* pickWild 로도 확인 — 잠겨 있으면 60번 뽑아도 안 나온다 */
  const draw = await page.evaluate(() => {
    S.dex = { ids: new Set(), counts: { '265': 1 }, dates: {}, subjects: {} };
    let hit = 0;
    for (let i = 0; i < 60; i += 1) { if (pickWild(-1).id === 268) hit += 1; }
    return hit;
  });
  check(`[진화 ${w}] 잠긴 동안 pickWild 가 카스쿤을 뽑지 않음`, draw === 0, `60회 중 ${draw}회`);

  /* 형제 도감 격리 — 아린(p1)에 2마리, 지안(p2)은 0마리 */
  const iso = await page.evaluate(() => {
    localStorage.setItem('pkm.shared.dex.v1.p1', JSON.stringify({ ids: [265], counts: { '265': 2 }, dates: {}, subjects: {}, v: 1 }));
    localStorage.setItem('pkm.shared.dex.v1.p2', JSON.stringify({ ids: [], counts: {}, dates: {}, subjects: {}, v: 1 }));
    const p2 = Profiles.loadDex('p2');
    S.dex = p2;
    const p2Has = wildPool().some((p) => p.id === 268);
    const p1 = Profiles.loadDex('p1');
    S.dex = p1;
    const p1Has = wildPool().some((p) => p.id === 268);
    return { p2Has, p1Has, slotP1: slotFor('math', 'p1'), slotP2: slotFor('math', 'p2') };
  });
  check(`[진화 ${w}] 형제 격리 — 아린 것은 지안에게 새지 않음`, iso.p2Has === false && iso.p1Has === true, JSON.stringify(iso));

  /* 아빠 권한 ➕ 추가 2마리로도 자연스럽게 해금 */
  const dad = await page.evaluate(() => {
    localStorage.setItem('pkm.shared.dex.v1.p2', JSON.stringify({ ids: [], counts: {}, dates: {}, subjects: {}, v: 1 }));
    window.PkmDexAdd.addMon('p2', 265, 2);
    S.dex = Profiles.loadDex('p2');
    return { counts: S.dex.counts['265'], has: wildPool().some((p) => p.id === 268) };
  });
  check(`[진화 ${w}] 아빠 ➕ 추가로 2마리 채우면 진화형 해금`, dad.counts === 2 && dad.has === true, JSON.stringify(dad));

  await page.close();
}

/* ---------------- 실행 ---------------- */
(async () => {
  await startServer();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio', '--autoplay-policy=no-user-gesture-required']
  });
  try {
    await testHangul(browser, 400, 860);
    await testBattleLauncher(browser, 400, 860);
    await testMath(browser, 400, 860);
    await testVillage(browser, 400, 860);
    await testHangul(browser, 884, 960);
    await testBattleLauncher(browser, 884, 960);
    await testMath(browser, 884, 960);
    await testVillage(browser, 884, 960);
    await testEvolution(browser, 400, 860);
    await testEvolution(browser, 884, 960);
  } catch (e) {
    check('테스트 실행', false, String(e && e.stack || e).slice(0, 500));
  } finally {
    await browser.close();
    if (srv) srv.kill('SIGTERM');
  }
  const errs = consoleErrors.filter((e) => !/favicon|ERR_FAILED|net::ERR/i.test(e.text));
  check('콘솔 오류 0건', errs.length === 0, errs.length ? JSON.stringify(errs.slice(0, 6)) : '0');

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 통과`);
  writeFileSync(path.join(__dirname, 'test_pokemon_dex_fix_results.json'), JSON.stringify({ base: BASE, results, consoleErrors }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
})();
