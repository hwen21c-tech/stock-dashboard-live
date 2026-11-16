#!/usr/bin/env node
/**
 * 🧪 포켓몬 ☁️ 가족 클라우드 — ⏪ 이전 백업 불러오기 (3슬롯) 로컬 E2E
 *   node test_pokemon_backup_restore.mjs
 *
 * - Supabase 응답은 전부 모의(intercept) — 실제 family_sync 행(0623)은 절대 쓰지 않는다.
 * - 검증: 모달 열기 · 3슬롯 저장 시각 표시(있음/저장 없음) · 빈 슬롯 토스트 ·
 *         PIN 오답 차단 · 정상 복원(로컬 + 클라우드 POST) · 콘솔 에러 0 · 가로 넘침 0
 * - 스크린샷: screenshots/pk_backup_*.png
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (_) {
  puppeteer = createRequire('/workspace/_tools/e2e/run.mjs')('puppeteer');
}

const APP_DIR = '/workspace/sd_live';
const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = `${APP_DIR}/screenshots`;
mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok: !!ok, detail: detail === undefined ? null : detail });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail !== undefined && detail !== null ? `  → ${detail}` : ''}`);
  return !!ok;
};

/* ---------- 모의 클라우드 ---------- */
const dexKey = (ids) => JSON.stringify({ ids, counts: {}, v: 2 });
const MAIN_KEYS = {
  'pkm.shared.dex.v1.p1': dexKey([1, 2, 3, 4, 5]),
  'pkm.shared.dex.v1.p2': dexKey([1, 2]),
  'pkm.village.v2.p1': JSON.stringify({ day: { poke: [{ id: 25, x: 60, y: 70 }], items: [] } }),
  'pkm.village.theme.v1.p1': 'day'
};
const AM_KEYS = {
  'pkm.shared.dex.v1.p1': dexKey([1, 2, 3]),
  'pkm.shared.dex.v1.p2': dexKey([1]),
  'pkm.village.v2.p1': JSON.stringify({ night: { poke: [{ id: 6, x: 30, y: 40 }], items: [] } }),
  'pkm.village.theme.v1.p1': 'night'
};
const PM_KEYS = JSON.parse(JSON.stringify(MAIN_KEYS));

function makeState() {
  return {
    rows: {
      '0623': { code: '0623', data: { v: 1, keys: JSON.parse(JSON.stringify(MAIN_KEYS)), pushedAt: '2026-11-16T07:10:00.000Z', device: 'phone' }, updated_at: '2026-11-16T07:10:00.000Z' },
      '0623_am': { code: '0623_am', data: { v: 1, keys: JSON.parse(JSON.stringify(AM_KEYS)), backupSlot: 'morning_10', backedUpAt: '2026-11-16T01:02:00.000+00:00' }, updated_at: '2026-11-16T01:02:00.000+00:00' },
      '0623_pm': { code: '0623_pm', data: { v: 1, keys: JSON.parse(JSON.stringify(PM_KEYS)), backupSlot: 'afternoon_16', backedUpAt: '2026-11-16T07:02:00.000+00:00' }, updated_at: '2026-11-16T07:02:00.000+00:00' }
    },
    posts: [],
    deletes: []
  };
}

function rowsFor(state, codeParam, select) {
  const wantsData = /data/.test(select || '');
  const out = [];
  if (codeParam && codeParam.startsWith('eq.')) {
    const c = decodeURIComponent(codeParam.slice(3));
    if (state.rows[c]) out.push(state.rows[c]);
  } else if (codeParam && codeParam.startsWith('in.(')) {
    const list = codeParam.slice(4, -1).split(',').map((s) => decodeURIComponent(s.trim()));
    list.forEach((c) => { if (state.rows[c]) out.push(state.rows[c]); });
  }
  return out.map((r) => {
    const o = { code: r.code, updated_at: r.updated_at };
    if (wantsData) o.data = r.data;
    if (r.data && r.data.backedUpAt) o.backedUpAt = r.data.backedUpAt;
    return o;
  });
}

async function installMock(page, state) {
  await page.setRequestInterception(true);
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'apikey,authorization,content-type,prefer,accept-profile,content-profile',
    'access-control-expose-headers': '*'
  };
  page.on('request', async (req) => {
    const url = req.url();
    if (!/supabase\.co/.test(url)) { req.continue().catch(() => {}); return; }
    const u = new URL(url);
    const select = u.searchParams.get('select') || '';
    const codeParam = u.searchParams.get('code') || '';
    if (req.method() === 'OPTIONS') {
      req.respond({ status: 204, headers: CORS, body: '' }).catch(() => {});
      return;
    }
    if (req.method() === 'POST') {
      let body = [];
      try { body = JSON.parse(req.postData() || '[]'); } catch (_) { /* */ }
      state.posts.push({ url, body, headers: req.headers() });
      body.forEach((row) => {
        if (!row || !row.code) return;
        state.rows[row.code] = { code: row.code, data: row.data, updated_at: row.updated_at };
      });
      req.respond({ status: 201, headers: CORS, contentType: 'application/json', body: '{}' }).catch(() => {});
      return;
    }
    if (req.method() === 'DELETE') {
      state.deletes.push(url);
      req.respond({ status: 200, headers: CORS, contentType: 'application/json', body: '[]' }).catch(() => {});
      return;
    }
    const rows = rowsFor(state, codeParam, select);
    state.gets = (state.gets || 0) + 1;
    req.respond({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(rows) }).catch(() => {});
  });
}

/* ---------- 서버 ---------- */
const server = spawn(process.execPath, ['dev_server.mjs'], {
  cwd: APP_DIR,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

async function waitServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/pokemon-battle.html`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return true;
    } catch (_) { /* 아직 */ }
    await sleep(400);
  }
  return false;
}

const SEED = `
  try {
    if (!localStorage.getItem('__t_seeded')) {
      sessionStorage.setItem('pkm.family.unlocked.v1', '1');
      localStorage.setItem('pkm.shared.dex.v1.p1', ${JSON.stringify(dexKey([1, 2, 3, 4, 5]))});
      localStorage.setItem('pkm.shared.dex.v1.p2', ${JSON.stringify(dexKey([1, 2]))});
      localStorage.setItem('pkm.village.theme.v1.p1', 'day');
      localStorage.setItem('pkm.cloud.code', '0623');
      localStorage.setItem('__t_seeded', '1');
    }
    sessionStorage.setItem('pkm.family.unlocked.v1', '1');
  } catch (e) {}
`;

const IGNORE_ERR = [
  /net::ERR_/, /Failed to load resource/, /favicon/i, /ERR_(BLOCKED|FAILED|ABORTED)/,
  /raw\.githubusercontent|cdn|jsdelivr|fonts\.googleapis|sprite/i
];

async function runViewport(browser, label, width, height) {
  const state = makeState();
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await installMock(page, state);
  await page.evaluateOnNewDocument(SEED);

  await page.goto(`${BASE}/pokemon-battle.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  /* 첫 부팅 pull 이 데이터를 반영하며 한 번 새로고침할 수 있다 — 잠잠해질 때까지 기다린다 */
  await sleep(2600);
  await page.waitForSelector('.pkms-badge', { timeout: 20000 });
  const dexBefore = await page.evaluate(() => (document.querySelector('#kidP1 [data-count]') || {}).textContent || '');
  check(`[${label}] 복원 전 홈 도감 표시 = 5마리`, /5\s*마리/.test(dexBefore), dexBefore);
  await page.evaluate(() => document.querySelector('.pkms-badge').click());
  await page.waitForSelector('.pkms-sheet', { visible: true, timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-slot-at="am"]');
    return el && el.textContent !== '확인 중…';
  }, { timeout: 10000 });

  const slots = await page.evaluate(() => {
    const out = {};
    ['am', 'pm', 'night'].forEach((s) => {
      const el = document.querySelector('[data-slot-at="' + s + '"]');
      out[s] = el ? el.textContent.trim() : null;
    });
    out.section = !!document.querySelector('.pkms-backups');
    return out;
  });
  check(`[${label}] 모달에 「⏪ 이전 백업 불러오기」 섹션 + 슬롯 3개`, slots.section && slots.am && slots.pm && slots.night, JSON.stringify(slots));
  check(`[${label}] 아침 슬롯 저장 시각 형식 (11/16 10:02)`, /^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/.test(slots.am || ''), slots.am);
  check(`[${label}] 오후 슬롯 저장 시각 형식 (11/16 16:02)`, /^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/.test(slots.pm || ''), slots.pm);
  check(`[${label}] 밤 슬롯은 '저장 없음'`, slots.night === '저장 없음', slots.night);
  await page.screenshot({ path: `${SHOT_DIR}/pk_backup_modal_${width}.png` });

  // 빈 슬롯 → 토스트만
  await page.evaluate(() => document.querySelector('[data-slot-btn="night"]').click());
  await sleep(350);
  const toastEmpty = await page.evaluate(() => {
    const t = document.getElementById('pkmsToast');
    return { on: t && t.getAttribute('data-on'), text: t && t.textContent, stillMain: !!document.querySelector('[data-a="push"]') };
  });
  check(`[${label}] 빈 밤 슬롯 클릭 → 토스트 '아직 백업이 없어요' (모달 유지)`, toastEmpty.on === '1' && /아직 백업이 없어요/.test(toastEmpty.text || '') && toastEmpty.stillMain, toastEmpty.text);
  await page.screenshot({ path: `${SHOT_DIR}/pk_backup_empty_${width}.png` });

  // 아침 슬롯 → 복원 확인 화면
  await page.evaluate(() => document.querySelector('[data-slot-btn="am"]').click());
  await page.waitForSelector('#pkmsRestorePin', { timeout: 8000 });
  const restoreTxt = await page.evaluate(() => document.querySelector('.pkms-body').textContent.replace(/\s+/g, ' '));
  check(`[${label}] 확인 문구 '이 시점의 도감·마을 기록으로 되돌릴까요?'`, /이 시점의 도감·마을 기록으로 되돌릴까요\?/.test(restoreTxt), restoreTxt.slice(0, 80));
  check(`[${label}] 아빠 PIN 입력칸`, await page.$('#pkmsRestorePin') !== null);
  await page.screenshot({ path: `${SHOT_DIR}/pk_backup_confirm_${width}.png` });

  // 틀린 PIN → 차단
  await page.type('#pkmsRestorePin', '1111');
  await page.evaluate(() => document.querySelector('[data-a="dorestore"]').click());
  await sleep(400);
  const wrong = await page.evaluate(() => ({
    msg: (document.querySelector('.pkms-msg') || {}).textContent || '',
    p1: localStorage.getItem('pkm.shared.dex.v1.p1')
  }));
  const wrongIds = JSON.parse(wrong.p1 || '{}').ids || [];
  check(`[${label}] 틀린 PIN 차단 ('아빠 PIN이 맞지 않아요')`, /아빠 PIN이 맞지 않아요/.test(wrong.msg), wrong.msg);
  check(`[${label}] 틀린 PIN 으로는 로컬이 바뀌지 않음`, wrongIds.length === 5, 'p1 ids=' + wrongIds.join(','));
  check(`[${label}] 틀린 PIN 으로는 클라우드에 쓰지 않음`, state.posts.length === 0, 'posts=' + state.posts.length);

  // 올바른 PIN → 복원
  await page.evaluate(() => { document.querySelector('#pkmsRestorePin').value = ''; });
  await page.type('#pkmsRestorePin', '0623');
  await page.evaluate(() => document.querySelector('[data-a="dorestore"]').click());
  await sleep(340);
  const after = await page.evaluate(() => {
    const g = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
    const t = document.getElementById('pkmsToast');
    return {
      p1: g('pkm.shared.dex.v1.p1'),
      theme: localStorage.getItem('pkm.village.theme.v1.p1'),
      toast: t && t.textContent,
      toastOn: t && t.getAttribute('data-on')
    };
  });
  await page.screenshot({ path: `${SHOT_DIR}/pk_backup_restored_${width}.png` });
  await page.waitForFunction(() => {
    try { return (JSON.parse(localStorage.getItem('pkm.shared.dex.v1.p1') || '{}').ids || []).length === 3; } catch (e) { return false; }
  }, { timeout: 8000 }).catch(() => {});
  check(`[${label}] 복원 후 로컬 도감 p1 = 백업 시점(3마리)`, Array.isArray(after.p1 && after.p1.ids) && after.p1.ids.length === 3, 'ids=' + ((after.p1 && after.p1.ids) || []).join(','));
  check(`[${label}] 복원 후 마을 테마도 백업 시점(night)`, after.theme === 'night', after.theme);
  check(`[${label}] 복원 완료 토스트`, after.toastOn === '1' && /되돌렸어요/.test(after.toast || ''), after.toast);

  const post = state.posts[0];
  const postRow = post && post.body && post.body[0];
  const prefer = (post && post.headers && (post.headers.prefer || post.headers.Prefer)) || '';
  check(`[${label}] 클라우드(0623) 행에 복원값 UPSERT`, !!postRow && postRow.code === '0623' && /merge-duplicates/.test(prefer), post ? `${post.url.split('?')[1]} · Prefer=${prefer}` : 'none');
  const postIds = postRow ? (JSON.parse(postRow.data.keys['pkm.shared.dex.v1.p1'] || '{}').ids || []) : [];
  check(`[${label}] 올린 data.keys 도 백업 시점(3마리)`, postIds.length === 3, 'ids=' + postIds.join(','));
  check(`[${label}] 3마리로 줄었으므로 resetAt 기록(다른 기기 되살림 방지)`, !!(postRow && JSON.parse(postRow.data.keys['pkm.shared.dex.v1.p1'] || '{}').resetAt > 0));
  check(`[${label}] 복원 이력(restoredFrom) 기록`, !!postRow && postRow.data.restoredFrom === '0623_am', postRow ? postRow.data.restoredFrom : 'none');
  check(`[${label}] 실제 0623 행 삭제·타 코드 행 쓰기 없음`, state.deletes.length === 0 && state.posts.every((p) => p.body.every((r) => r.code === '0623')), 'deletes=' + state.deletes.length + ' posted=' + state.posts.map((p) => p.body.map((r) => r.code).join('|')).join(','));

  // 새로고침해도 되돌린 상태 유지(모의 서버도 갱신됐으므로 pull 이 덮지 않아야 함)
  await sleep(1500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pkms-badge', { timeout: 20000 });
  await sleep(1200);
  const afterReload = await page.evaluate(() => {
    try { return (JSON.parse(localStorage.getItem('pkm.shared.dex.v1.p1') || '{}').ids || []).length; } catch (e) { return -1; }
  });
  check(`[${label}] 새로고침 후에도 3마리 유지(클라우드 pull 이 덮지 않음)`, afterReload === 3, 'ids=' + afterReload);

  // 가로 넘침 · 콘솔 에러
  const dexAfter = await page.evaluate(() => (document.querySelector('#kidP1 [data-count]') || {}).textContent || '');
  check(`[${label}] 복원·새로고침 후 홈 도감 표시 = 3마리`, /3\s*마리/.test(dexAfter), dexAfter);

  const ov = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, iw: window.innerWidth,
    modalOv: (() => { const s = document.querySelector('.pkms-sheet'); if (!s) return 0; return Math.max(0, s.scrollWidth - s.clientWidth); })()
  }));
  check(`[${label}] 가로 넘침 0`, ov.sw <= ov.iw + 1, `scrollWidth=${ov.sw} innerWidth=${ov.iw} (모달 내부 ${ov.modalOv})`);

  // 모달 다시 열어 3슬롯이 그대로 보이는지(재조회)
  await page.evaluate(() => document.querySelector('.pkms-badge').click());
  await page.waitForSelector('.pkms-sheet', { visible: true, timeout: 8000 });
  await sleep(700);
  await page.screenshot({ path: `${SHOT_DIR}/pk_backup_modal_after_${width}.png` });

  const real = errors.filter((e) => !IGNORE_ERR.some((re) => re.test(e)));
  check(`[${label}] 콘솔·페이지 에러 0`, real.length === 0, real.slice(0, 3).join(' | ') || 'none');

  await ctx.close();
}

const up = await waitServer();
check('dev_server 기동', up, BASE);
if (!up) {
  console.error(serverLog.slice(-800));
  server.kill('SIGTERM');
  process.exit(1);
}

const browser = await puppeteer.launch({
  headless: 'new',
  env: { ...process.env, LD_LIBRARY_PATH: '/workspace/_tools/libs/usr/lib/x86_64-linux-gnu' },
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
try {
  await runViewport(browser, '400x860', 400, 860);
  await runViewport(browser, '884x960', 884, 960);
} catch (e) {
  check('E2E 실행', false, e.message);
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

const fail = results.filter((r) => !r.ok);
writeFileSync(`${APP_DIR}/test_results_backup_restore.json`, JSON.stringify({ ok: fail.length === 0, results }, null, 2));
console.log(`\n${fail.length === 0 ? '🎉 ALL PASS' : '⚠️ FAIL ' + fail.length} — ${results.length} checks`);
process.exit(fail.length === 0 ? 0 : 1);
