/**
 * ⚡ 실시간 브리핑 모달 — 🤖 Gemini AI 브리핑 탭 E2E (폴드8 400×884)
 *
 *   node e2e/lb_ai_verify.mjs [baseUrl]
 *   기대: baseUrl 기본값 http://127.0.0.1:8788 (sd_live dev_server)
 *
 *  ① 모달 열기 → 🧮 실측 팩트 탭 렌더 확인 (스크린샷)
 *  ② 🤖 Gemini AI 브리핑 탭 클릭 → 4블록 렌더 확인 (스크린샷)
 *  ③ 🔄 지금 다시 생성 → AI 탭 유지 확인
 *  ④ 콘솔 에러 0건
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer';

const require = createRequire('file:///workspace/sd_live/x.mjs');
const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const OUT = '/workspace/sd_live/screenshots/lb_ai';
mkdirSync(OUT, { recursive: true });
const label = BASE.includes('127.0.0.1') || BASE.includes('localhost') ? 'local' : BASE.includes('vercel') ? 'vercel' : 'pages';

/* 로컬은 dev_server 대신 테스트용 미니 서버(public/ + 필요한 API)를 띄운다 — dev_server 는
   이미 지워진 api/content-studio.js 를 require 해서 뜨지 않는다(이번 기능과 무관한 기존 문제). */
let server = null;
if (label === 'local') {
  if (!process.env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = readFileSync('/workspace/.env.gemini.local', 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith('GEMINI_API_KEY='))
      .split('=')
      .slice(1)
      .join('=')
      .trim();
  }
  const roo = '/workspace/sd_live';
  const handlers = {};
  for (const f of readdirSync(roo + '/api')) {
    if (!f.endsWith('.js')) continue;
    handlers['/api/' + f.replace(/\.js$/, '')] = require(roo + '/api/' + f);
  }
  handlers['/api/deals-shopping'] = require(roo + '/lib/deals-shopping-legacy.js');
  handlers['/api/breadth'] = handlers['/api/macro-live'];
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json' };
  const port = Number(new URL(BASE).port || 8788);
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const h = handlers[u.pathname];
    if (h) {
      try {
        await h(req, res);
      } catch (e) {
        console.error('[api 500]', u.pathname, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, message: e.message }));
        }
      }
      return;
    }
    const rel = u.pathname === '/' ? '/index.html' : u.pathname;
    try {
      const buf = readFileSync(path.join(roo, 'public', path.normalize(rel)));
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[path.extname(rel)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.end(buf);
    } catch (e) {
      res.statusCode = 404;
      res.end('404');
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  console.log(`[srv] http://127.0.0.1:${port}`);
}

const browser = await puppeteer.launch({
  headless: 'shell',
  env: { ...process.env, LD_LIBRARY_PATH: '/workspace/.libs:/workspace/_tools/libs/usr/lib/x86_64-linux-gnu' },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=ko-KR'],
});
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 884, deviceScaleFactor: 2 });
// PIN 0623 화면 잠금(화면 가림 전용) 해제 상태로 시작 — 잠금 화면이 모달 위를 덮으면 클릭이 막힌다
await page.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem('stock_dashboard_pin_auth', '0623_verified');
  } catch (e) {}
});
const errs = [];
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 200)));

const results = [];
const notFound = [];
page.on('response', (r) => {
  if (r.status() === 404) notFound.push(new URL(r.url()).pathname);
});
const check = (labelText, ok, detail) => {
  results.push({ labelText, ok: Boolean(ok) });
  console.log(`${ok ? '✅' : '❌'} ${labelText}${detail ? `  → ${detail}` : ''}`);
};

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await sleep(2500);

/* ① 모달 열기 + 팩트 탭 */
await page.evaluate(() => window.openLiveBriefingModal());
await page.waitForFunction(
  () => document.querySelectorAll('#liveModalBody .lb-card').length >= 2 || !!document.querySelector('#liveModalBody .lb-fail'),
  { timeout: 70000 },
);
await sleep(1200);
const factsState = await page.evaluate(() => ({
  tab: window.LIVE_BRIEF ? window.LIVE_BRIEF.tab : null,
  title: document.getElementById('liveModalTitle')?.textContent,
  time: document.getElementById('liveBriefingTime')?.textContent,
  cards: document.querySelectorAll('#liveModalBody .lb-card').length,
  rows: document.querySelectorAll('#liveModalBody .lb-row').length,
  aiBtn: !!document.getElementById('lbTabAiBtn'),
  factsBtn: !!document.getElementById('lbTabFactsBtn'),
  aiCalled: window.LIVE_BRIEF ? !!window.LIVE_BRIEF.ai : null,
}));
check('모달 열림 · 기본 탭 = 실측 팩트', factsState.tab === 'facts', JSON.stringify(factsState));
check('팩트 카드 렌더', factsState.cards >= 2, `cards=${factsState.cards} · rows=${factsState.rows}`);
check('모달 열기만으로 Gemini 호출 안 함', factsState.aiCalled === false);
await page.screenshot({ path: `${OUT}/${label}_facts_400.png` });

/* ② AI 탭 */
await page.click('#lbTabAiBtn');
await page.waitForFunction(
  () => {
    const b = document.getElementById('liveModalBody');
    return b && (document.querySelectorAll('#liveModalBody .lb-card').length >= 4 || /lb-fail/.test(b.innerHTML));
  },
  { timeout: 90000 },
);
await sleep(600);
const aiState = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('#liveModalBody .lb-card')].map((c) => ({
    t: c.querySelector('.lb-card-t')?.textContent,
    lines: c.querySelectorAll('.lb-line').length,
    sum: c.querySelector('.lb-sum')?.textContent || null,
    act: c.querySelector('.lb-act')?.textContent || null,
  }));
  return {
    tab: window.LIVE_BRIEF.tab,
    title: document.getElementById('liveModalTitle')?.textContent,
    time: document.getElementById('liveBriefingTime')?.textContent,
    blocks,
    ai: window.LIVE_BRIEF.ai ? { used: window.LIVE_BRIEF.ai.ai?.used, model: window.LIVE_BRIEF.ai.ai?.model, note: window.LIVE_BRIEF.ai.ai?.note } : null,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    fails: /lb-fail/.test(document.getElementById('liveModalBody')?.innerHTML || ''),
  };
});
check('AI 탭 전환', aiState.tab === 'ai', aiState.title);
check('4블록 렌더', aiState.blocks.length >= 4, aiState.blocks.map((b) => b.t).join(' / '));
check('한줄 요약·행동 표시', !!(aiState.blocks[0]?.sum && aiState.blocks[0]?.act), (aiState.blocks[0]?.sum || '').slice(0, 60));
check('AI 사용(또는 정직한 실측 조립)', !aiState.fails, JSON.stringify(aiState.ai));
check('400px 가로 넘침 없음', !aiState.overflowX);
await page.screenshot({ path: `${OUT}/${label}_ai_400.png` });
await page.evaluate(() => {
  const el = document.getElementById('liveModalBody');
  if (el) el.scrollTop = 520;
});
await sleep(300);
await page.screenshot({ path: `${OUT}/${label}_ai_scroll_400.png` });

/* ③ 다시 생성 */
await page.evaluate(() => document.getElementById('liveBriefRefreshBtn').click());
await sleep(1500);
const refreshState = await page.evaluate(() => ({
  tab: window.LIVE_BRIEF.tab,
  title: document.getElementById('liveModalTitle')?.textContent,
  btn: document.getElementById('liveBriefRefreshBtn')?.textContent,
}));
check('🔄 다시 생성 → AI 탭 유지', refreshState.tab === 'ai', JSON.stringify(refreshState));
await sleep(6000);
const afterRefresh = await page.evaluate(() => ({
  cards: document.querySelectorAll('#liveModalBody .lb-card').length,
  btn: document.getElementById('liveBriefRefreshBtn')?.textContent,
}));
check('다시 생성 후 카드 유지', afterRefresh.cards >= 4, JSON.stringify(afterRefresh));

/* ④ 팩트 탭 복귀 */
await page.click('#lbTabFactsBtn');
await sleep(700);
const backState = await page.evaluate(() => ({ tab: window.LIVE_BRIEF.tab, title: document.getElementById('liveModalTitle')?.textContent }));
check('팩트 탭 복귀', backState.tab === 'facts', JSON.stringify(backState));

check('콘솔 에러 0건', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log('404 리소스:', notFound.slice(0, 10).join(', ') || '없음');

await browser.close();
if (server) server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n[${label}] ${results.length - failed.length}/${results.length} 통과 · 스크린샷 ${OUT}`);
if (failed.length) {
  console.log('실패:', failed.map((f) => f.labelText).join(' | '));
  process.exit(1);
}
