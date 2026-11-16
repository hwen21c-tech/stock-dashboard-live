#!/usr/bin/env node
/**
 * 🔎 라이브 확인(읽기 전용) — https://pokemon-battle-world.vercel.app
 *   실제 Supabase 는 GET 만 통과시키고 POST·DELETE 는 가로채 차단한다(본체 0623 행 보호).
 *   확인: 모달 열림 · 3슬롯 저장 시각(실데이터) · 콘솔 에러 0 · 가로 넘침 0
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
let puppeteer;
try { puppeteer = require('puppeteer'); } catch (_) { puppeteer = createRequire('/workspace/_tools/e2e/run.mjs')('puppeteer'); }

const BASE = process.env.BASE || 'https://pokemon-battle-world.vercel.app';
const out = [];
const check = (label, ok, detail) => {
  out.push({ label, ok: !!ok, detail: detail ?? null });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail !== undefined && detail !== null ? `  → ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  headless: 'new',
  env: { ...process.env, LD_LIBRARY_PATH: '/workspace/_tools/libs/usr/lib/x86_64-linux-gnu' },
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 860, deviceScaleFactor: 2 });
const errors = [];
const blocked = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  if (/supabase\.co/.test(u)) {
    if (req.method() === 'GET' || req.method() === 'OPTIONS') { req.continue().catch(() => {}); return; }
    blocked.push(req.method() + ' ' + u);
    req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }).catch(() => {});
    return;
  }
  req.continue().catch(() => {});
});
await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem('pkm.family.unlocked.v1', '1'); } catch (e) {} });

await page.goto(`${BASE}/pokemon-battle.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(3500);
await page.waitForSelector('.pkms-badge', { timeout: 25000 });
const ver = await page.evaluate(() => (window.PkmSync && window.PkmSync.version) || null);
check('라이브 pokemon-sync 버전 1.2.0', ver === '1.2.0', ver);

await page.evaluate(() => document.querySelector('.pkms-badge').click());
await page.waitForSelector('.pkms-sheet', { visible: true, timeout: 10000 });
await page.waitForFunction(() => {
  const el = document.querySelector('[data-slot-at="am"]');
  return el && el.textContent !== '확인 중…';
}, { timeout: 15000 });
const slots = await page.evaluate(() => {
  const o = {};
  ['am', 'pm', 'night'].forEach((s) => { const el = document.querySelector('[data-slot-at="' + s + '"]'); o[s] = el ? el.textContent.trim() : null; });
  return o;
});
check('라이브 3슬롯 상태 표시', !!(slots.am && slots.pm && slots.night), JSON.stringify(slots));
await page.screenshot({ path: '/workspace/sd_live/screenshots/pk_backup_live_400.png' });

// 빈 슬롯(백업 없음) → 토스트 확인 (쓰기 없음)
const emptyKey = Object.keys(slots).find((k) => slots[k] === '저장 없음');
if (emptyKey) {
  await page.evaluate((k) => document.querySelector('[data-slot-btn="' + k + '"]').click(), emptyKey);
  await sleep(400);
  const t = await page.evaluate(() => { const el = document.getElementById('pkmsToast'); return el ? { on: el.getAttribute('data-on'), text: el.textContent } : null; });
  check(`라이브 빈 슬롯(${emptyKey}) → 토스트`, t && t.on === '1' && /아직 백업이 없어요/.test(t.text || ''), t && t.text);
} else {
  check('라이브 빈 슬롯 없음(3슬롯 모두 저장됨)', false, '모두 저장됨');
}

const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
check('라이브 가로 넘침 0', ov.sw <= ov.iw + 1, `scrollWidth=${ov.sw} innerWidth=${ov.iw}`);
const real = errors.filter((e) => !/net::ERR_|Failed to load resource|favicon|cdn|sprite|jsdelivr|githubusercontent/i.test(e));
check('라이브 콘솔·페이지 에러 0', real.length === 0, real.slice(0, 3).join(' | ') || 'none');
check('실제 0623 행 쓰기 0 (POST/DELETE 차단)', blocked.length === 0, blocked.join(' | ') || 'none');

await browser.close();
writeFileSync('/workspace/sd_live/test_results_backup_live.json', JSON.stringify({ ok: out.every((r) => r.ok), results: out }, null, 2));
console.log(out.every((r) => r.ok) ? '\n🎉 LIVE PASS' : '\n⚠️ LIVE FAIL');
process.exit(out.every((r) => r.ok) ? 0 : 1);
