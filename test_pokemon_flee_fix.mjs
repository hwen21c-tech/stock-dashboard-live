#!/usr/bin/env node
/**
 * 🏃 포켓몬 3게임 — '도망간다' = 야생 포켓몬 유지 + 문제(보기)만 교체 회귀 테스트
 *
 *   node test_pokemon_flee_fix.mjs                       (로컬 dev_server 자동 기동)
 *   BASE=https://pokemon-battle-world.vercel.app node test_pokemon_flee_fix.mjs   (라이브)
 *
 *  검증 항목
 *   1) 도망 클릭 → 야생 포켓몬 id/이름·foeHP·myHP·solved·hints 그대로
 *   2) 도망 클릭 → 문제 지문·보기가 새로 바뀌고, 이전 문제의 오답표시/비활성/힌트/타이머/TTS 가 남지 않음
 *   3) 연속 2회 도망 → 정답·오답 풀이 → 포획까지 회귀
 *   4) 오답 직후(처리중) 도망 → 늦게 도착한 이전 콜백이 새 문제를 덮지 않음(HP 1회만 감소)
 *   5) 도망 0회 → 더 이상 바꿀 수 없음
 *   6) 콘솔 오류 0건
 *  · Supabase(가족 클라우드) 요청은 전부 가로채 가짜 응답 — 운영 0623 에 쓰지 않는다.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let puppeteer;
try { puppeteer = createRequire(import.meta.url)('puppeteer'); }
catch (_) { puppeteer = createRequire('/workspace/_tools/e2e/run.mjs')('puppeteer'); }

const EXTERNAL = process.env.BASE || null;
const PORT = Number(process.env.PORT || 8796);
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/screenshots/pkflee_1117';
mkdirSync(SHOT_DIR, { recursive: true });
const SHOT = (n) => path.join(SHOT_DIR, `${n}.png`);

const FLAT = process.env.FLAT === '1';   /* 정적 사본(deploy_repo/preview-pokemon)은 루트 경로 */
const URL_FOR = (f) => BASE + (EXTERNAL && !FLAT ? '/pokemon/' : '/') + f;

const results = [];
const check = (label, ok, detail) => {
  const pass = !!ok;
  results.push({ label, ok: pass, detail: detail === undefined ? null : detail });
  console.log(`${pass ? '✅' : '❌'} ${label}${detail !== undefined && detail !== null ? `  → ${detail}` : ''}`);
  return pass;
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
      const r = await fetch(BASE + '/math-pokemon.html');
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
    { id: 'p1', name: '아린', emoji: '👧', diff: 'mid', level: 'easy', range: 'all' },
    { id: 'p2', name: '지안', emoji: '🧒', diff: 'easy', level: 'easy', range: 'all' },
    { id: 'p3', name: '게스트', emoji: '🧪', diff: 'easy', level: 'easy', range: 'all' }
  ] };
  var mpb = { active: 'p1', list: [
    { id: 'p1', name: '아린', emoji: '👧', diff: 'easy', op: 'mix', mix: 'all', ops: ['add','sub'], range: 'all' },
    { id: 'p2', name: '지안', emoji: '🧒', diff: 'easy', op: 'mix', mix: 'all', ops: ['add'], range: 'all' },
    { id: 'p3', name: '게스트', emoji: '🧪', diff: 'easy', op: 'mix', mix: 'all', ops: ['add'], range: 'all' }
  ] };
  var epb = { active: 'p1', list: [
    { id: 'p1', name: '아린', emoji: '👧', diff: 'easy', level: 'easy', range: 'all' },
    { id: 'p2', name: '지안', emoji: '🧒', diff: 'easy', level: 'easy', range: 'all' },
    { id: 'p3', name: '게스트', emoji: '🧪', diff: 'easy', level: 'easy', range: 'all' }
  ] };
  localStorage.setItem('hpb.profiles.v1', JSON.stringify(hpb));
  localStorage.setItem('mpb.profiles.v1', JSON.stringify(mpb));
  localStorage.setItem('epb.profiles.v1', JSON.stringify(epb));
  localStorage.setItem('pkm.shared.dex.v1.p1', JSON.stringify({ ids: [], counts: {}, dates: {}, subjects: {}, v: 1 }));
  localStorage.setItem('pkm.shared.dex.v1.p2', JSON.stringify({ ids: [], counts: {}, dates: {}, subjects: {}, v: 1 }));
  localStorage.setItem('pkm.shared.dex.v1.guest', JSON.stringify({ ids: [], counts: {}, v: 1 }));
  localStorage.setItem('pkm.shared.dex.v1.migrated', JSON.stringify([
    'mpb.dex.v2.p1','mpb.dex.v2.p2','mpb.dex.v1','hpb.dex.v1.p1','hpb.dex.v1.p2','epb.dex.v1.p1','epb.dex.v1.p2'
  ]));
  localStorage.setItem('pkm.quota.v1', JSON.stringify({ v: 1, date: '${TODAY}', limit: 0, plays: {} }));
} catch (e) {}
`;

/* 무음 WAV — /api/tts 요청을 가짜로 돌려 콘솔 네트워크 오류를 만들지 않는다 */
const SILENT_WAV = Buffer.from(
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=', 'base64'
);

const consoleErrors = [];
let cloudWrites = 0;
function watch(page, tag) {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push({ tag, text: String(m.text()).slice(0, 300) });
  });
  page.on('pageerror', (e) => consoleErrors.push({ tag, text: 'pageerror: ' + String(e.message).slice(0, 300) }));
}
async function newPage(browser, w, h) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: w < 600, hasTouch: w < 600 });
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
      if (req.method() !== 'GET') cloudWrites += 1;
      if (req.method() === 'GET') return req.respond({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: '[]' });
      return req.respond({ status: 201, headers: { ...cors, 'content-type': 'application/json' }, body: '{}' });
    }
    if (u.includes('/api/tts')) {
      return req.respond({ status: 200, headers: { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' }, body: SILENT_WAV });
    }
    return req.continue();
  });
  await page.evaluateOnNewDocument(SEED);
  return page;
}

/* ---------------- 상태 스냅숏 ---------------- */
const snap = (page) => page.evaluate(() => {
  const btns = [...document.querySelectorAll('#choices .choice')];
  const shown = btns.filter((b) => b.style.display !== 'none');
  const el = (id) => document.getElementById(id) || {};
  return {
    screen: S.screen,
    locked: S.locked,
    paused: S.paused,
    wildId: S.wild ? S.wild.id : null,
    wildName: S.wild ? S.wild.name : null,
    foeHP: S.foeHP,
    myHP: S.myHP,
    solved: S.solved,
    flee: S.flee,
    hints: S.hints,
    hintUsed: S.hintUsed,
    timeLeft: Math.round(S.timeLeft * 10) / 10,
    qSig: String((S.q && (S.q.text || S.q.qhtml || '')) + '|' + (S.q && S.q.answer)),
    qAnswer: S.q ? S.q.answer : null,
    questionDom: (el('question').textContent || '').trim(),
    hintBoxHidden: !!el('hintBox').hidden,
    hintBoxText: (el('hintBox').textContent || '').trim().slice(0, 40),
    choices: shown.map((b) => ({
      t: ((b.querySelector('.v') || {}).textContent || '').trim(),
      disabled: !!b.disabled,
      cls: b.className,
      ok: b.dataset.ok
    })),
    allChoiceDis: btns.every((b) => b.disabled),
    fleeBadge: (el('fleeBadge').textContent || '').trim(),
    timeNum: (el('timerNum').textContent || '').trim(),
    wildClass: el('wildWrap').className,
    ttsToken: (typeof TTS !== 'undefined' && TTS.token) || 0,
    toast: (el('toast').textContent || '').trim()
  };
});

const choiceTexts = (s) => s.choices.map((c) => c.t).join('/');

async function enterBattle(page, tag) {
  await page.goto(URL_FOR(tag.file), { waitUntil: 'domcontentloaded' });
  await sleep(2600);
  const pin = await page.evaluate(() => {
    const pad = document.getElementById('pinPad') || document.getElementById('dPinPad');
    return pad ? !pad.closest('[hidden]') : false;
  });
  if (pin) {
    await page.evaluate(() => {
      const d = document.querySelector('#pinPad button[data-pk="0"], #dPinPad button[data-dd="0"]');
      return d;
    });
    for (const d of ['0', '6', '2', '3']) {
      await page.evaluate((k) => {
        const btn = document.querySelector(`#pinPad button[data-pk="${k}"], #dPinPad button[data-dd="${k}"], #dPinPad button[data-d="${k}"]`);
        if (btn) btn.click();
      }, d);
      await sleep(110);
    }
    await sleep(400);
  }
  await page.evaluate(() => {
    const card = document.querySelector('#startList .pfl[data-id="p1"]');
    if (card) card.click();
  });
  await sleep(350);
  await page.evaluate(() => { const b = document.getElementById('prepGo'); if (b) b.click(); });
  await sleep(1500);
  return snap(page);
}

async function clickRight(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('#choices .choice')].filter((b) => b.style.display !== 'none');
    let idx = -1;
    if (S.q && S.q.ans !== undefined) {
      idx = btns.findIndex((b) => ((b.querySelector('.v') || {}).textContent || '').trim() === String(S.q.ans).trim());
    }
    if (idx < 0) idx = btns.findIndex((b) => b.dataset.ok === '1');
    if (idx < 0) return false;
    btns[idx].click();
    return true;
  });
}
async function clickWrong(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('#choices .choice')].filter((b) => b.style.display !== 'none');
    let idx = -1;
    if (S.q && S.q.ans !== undefined) {
      idx = btns.findIndex((b) => ((b.querySelector('.v') || {}).textContent || '').trim() !== String(S.q.ans).trim());
    }
    if (idx < 0) idx = btns.findIndex((b) => b.dataset.ok === '0');
    if (idx < 0) return false;
    btns[idx].click();
    return true;
  });
}
async function clickFlee(page) {
  await page.evaluate(() => {
    const b = document.getElementById('fleeBtn');
    if (b) b.click();
  });
}
async function clickHint(page) {
  await page.evaluate(() => {
    const b = document.getElementById('hintBtn');
    if (b) b.click();
  });
}

/* ---------------- 게임 1종 검증 ---------------- */
async function testGame(browser, game, w, h) {
  const tag = `${game.name} ${w}×${h}`;
  const page = await newPage(browser, w, h);
  watch(page, `${game.name}-${w}`);

  let s0 = await enterBattle(page, game);
  check(`[${tag}] 배틀 진입`, s0.wildId != null && s0.screen === 'battle', `wild=${s0.wildName}(${s0.wildId}) flee=${s0.flee} hp=${s0.foeHP}/${s0.myHP}`);

  /* 진행 상태 만들기: 정답 1개 → 힌트 1회 */
  await clickRight(page);
  await sleep(1100);
  let s1 = await snap(page);
  check(`[${tag}] 정답 1개 반영`, s1.foeHP === s0.foeHP - 1 && s1.solved === s0.solved + 1, `foeHP ${s0.foeHP}→${s1.foeHP} solved ${s0.solved}→${s1.solved}`);

  await clickHint(page);
  await sleep(300);
  const sH = await snap(page);
  check(`[${tag}] 힌트 표시`, sH.hintBoxHidden === false && sH.hintUsed === true, `hints=${sH.hints} box="${sH.hintBoxText}"`);

  /* ---------- 도망 1회 ---------- */
  const before1 = await snap(page);
  await clickFlee(page);
  await sleep(700);
  const a1 = await snap(page);

  check(`[${tag}] ① 도망 — 야생 포켓몬 유지`, a1.wildId === before1.wildId && a1.wildName === before1.wildName,
    `${before1.wildName}(${before1.wildId}) → ${a1.wildName}(${a1.wildId})`);
  check(`[${tag}] ① 도망 — HP·진행 상태 유지`, a1.foeHP === before1.foeHP && a1.myHP === before1.myHP && a1.solved === before1.solved && a1.hints === before1.hints,
    `foeHP ${before1.foeHP}→${a1.foeHP} · myHP ${before1.myHP}→${a1.myHP} · solved ${before1.solved}→${a1.solved} · hints ${before1.hints}→${a1.hints}`);
  check(`[${tag}] ① 도망 — 문제·보기 교체`, a1.qSig !== before1.qSig,
    `"${before1.questionDom.slice(0, 28)}" → "${a1.questionDom.slice(0, 28)}"`);
  check(`[${tag}] ① 도망 — 이전 문제 표시 잔존 없음`,
    a1.choices.length >= 2 && a1.choices.every((c) => !c.disabled && c.cls === 'choice'),
    JSON.stringify(a1.choices));
  check(`[${tag}] ① 도망 — 힌트 초기화`, a1.hintBoxHidden === true && a1.hintUsed === false, `hidden=${a1.hintBoxHidden} hintUsed=${a1.hintUsed}`);
  check(`[${tag}] ① 도망 — 타이머 리셋`, a1.timeLeft > 27, `timeLeft ${before1.timeLeft}→${a1.timeLeft} (${a1.timeNum})`);
  check(`[${tag}] ① 도망 — 이전 음성 중단`, game.tts ? a1.ttsToken > before1.ttsToken : true, `ttsToken ${before1.ttsToken}→${a1.ttsToken}`);
  check(`[${tag}] ① 도망 — 도망 횟수 감소·전투 복귀`, a1.flee === before1.flee - 1 && a1.screen === 'battle' && a1.locked === false && a1.fleeBadge === String(a1.flee),
    `flee ${before1.flee}→${a1.flee} screen=${a1.screen} badge=${a1.fleeBadge}`);
  check(`[${tag}] ① 도망 — 야생 퇴장 애니메이션 없음`, !String(a1.wildClass).includes('leave'), `wildClass="${a1.wildClass}"`);

  /* ---------- 도망 2회 연속 ---------- */
  const before2 = await snap(page);
  await clickFlee(page);
  await sleep(700);
  const a2 = await snap(page);

  check(`[${tag}] ② 연속 도망 — 포켓몬·진행 유지`, a2.wildId === before2.wildId && a2.foeHP === before2.foeHP && a2.myHP === before2.myHP && a2.solved === before2.solved,
    `wild=${a2.wildName}(${a2.wildId}) foeHP=${a2.foeHP} myHP=${a2.myHP} solved=${a2.solved}`);
  check(`[${tag}] ② 연속 도망 — 문제 교체·깔끔한 상태`, a2.qSig !== before2.qSig && a2.choices.every((c) => !c.disabled && c.cls === 'choice') && a2.hintBoxHidden === true,
    `"${before2.questionDom.slice(0, 24)}" → "${a2.questionDom.slice(0, 24)}" flee=${a2.flee}`);

  /* ---------- 오답 직후(처리중) 도망 — 이전 콜백 무효화 ---------- */
  const before3 = await snap(page);
  await clickWrong(page);
  await sleep(120);
  const afterWrong = await snap(page);   /* 오답 1회는 정상 반영된 시점 */
  await clickFlee(page);         /* 오답 처리 콜백(≈950~1150ms)이 살아 있는 사이에 도망 */
  await sleep(1800);             /* 콜백이 도착할 시간을 충분히 준다 */
  const a3 = await snap(page);

  check(`[${tag}] ③ 오답 중 도망 — 새 문제 유지(이전 콜백이 덮지 않음)`,
    a3.screen === 'battle' && a3.locked === false && a3.qSig !== before3.qSig && a3.hintBoxHidden === true,
    `screen=${a3.screen} locked=${a3.locked} q="${a3.questionDom.slice(0, 24)}" flee=${a3.flee}`);
  check(`[${tag}] ③ 오답 중 도망 — HP 중복 변동 없음`, a3.myHP === afterWrong.myHP && a3.foeHP === afterWrong.foeHP && afterWrong.myHP === before3.myHP - 1,
    `myHP ${before3.myHP}→(오답)${afterWrong.myHP}→(도망 후)${a3.myHP} foeHP ${before3.foeHP}→${a3.foeHP}`);
  check(`[${tag}] ③ 오답 중 도망 — 포켓몬 유지`, a3.wildId === before3.wildId, `${before3.wildName}(${before3.wildId}) → ${a3.wildName}(${a3.wildId})`);

  /* ---------- 도망 0회 — 더 못 바꿈 ---------- */
  const before4 = await snap(page);
  if (before4.flee === 0) {
    await clickFlee(page);
    await sleep(600);
    const a4 = await snap(page);
    check(`[${tag}] ④ 도망 소진 — 문제 유지`, a4.qSig === before4.qSig && a4.toast.includes('더 이상'), `flee=${a4.flee} toast="${a4.toast}"`);
  } else {
    check(`[${tag}] ④ 도망 소진 검증`, false, `flee=${before4.flee} — 횟수 계산이 예상과 다름`);
  }

  /* ---------- 포획까지 회귀 ---------- */
  let caught = false;
  for (let i = 0; i < 12; i += 1) {
    const st = await snap(page);
    if (st.screen === 'caught') { caught = true; break; }
    if (st.screen === 'capturing') { await sleep(1200); continue; }
    if (st.screen !== 'battle') { await sleep(600); continue; }
    await clickRight(page);
    await sleep(950);
  }
  await sleep(1600);
  const fin = await snap(page);
  const catchModal = await page.evaluate(() => {
    const m = document.getElementById('catchModal');
    return m ? !m.hidden : false;
  });
  check(`[${tag}] ⑤ 도망 후에도 포획 완료`, (caught || fin.screen === 'caught' || fin.screen === 'capturing') && (catchModal || fin.screen === 'caught'),
    `screen=${fin.screen} modal=${catchModal} wild=${fin.wildName}`);
  await page.screenshot({ path: SHOT(`${game.name}-${w}-catch.png`) });

  /* 캡처된 포켓몬이 도망 전과 같은 개체인지 */
  check(`[${tag}] ⑥ 포획 개체 = 도망 유지 개체`, fin.wildId === before1.wildId,
    `flee전 ${before1.wildName}(${before1.wildId}) → 포획 ${fin.wildName}(${fin.wildId})`);

  await page.close();
}

/* ---------------- 실행 ---------------- */
const ALL_GAMES = [
  { name: 'math', file: 'math-pokemon.html', tts: false },
  { name: 'english', file: 'english-pokemon.html', tts: true },
  { name: 'hangul', file: 'hangul-pokemon.html', tts: true }
];
const ONLY = process.env.ONLY || '';
const GAMES = ONLY ? ALL_GAMES.filter((g) => ONLY.split(',').includes(g.name)) : ALL_GAMES;

const main = async () => {
  console.log(`▶ 대상: ${BASE}${EXTERNAL ? ' (라이브)' : ' (로컬 dev_server)'}`);
  await startServer();
  const launchArgs = ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio'];
  const browser = await puppeteer.launch({
    headless: 'new',
    args: launchArgs,
    executablePath: process.env.CHROME_PATH || undefined
  });

  for (const game of GAMES) {
    await testGame(browser, game, 400, 860);
  }
  /* 폴드8 내부 가로 화면에서도 한 게임 더 */
  if (GAMES.includes(ALL_GAMES[0])) await testGame(browser, ALL_GAMES[0], 884, 960);

  await browser.close();
  if (srv) srv.kill();

  check('콘솔 오류 0건', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 4)));
  check('가족 클라우드 실쓰기 없음(가짜 응답으로 차단)', true, `fake writes=${cloudWrites}`);

  const bad = results.filter((r) => !r.ok);
  console.log(`\n=== 결과: ${results.length - bad.length}/${results.length} 통과 ===`);
  if (bad.length) {
    console.log('실패:');
    bad.forEach((b) => console.log(' -', b.label, '→', b.detail));
    process.exitCode = 1;
  }
};

main().catch((e) => {
  console.error('테스트 실행 오류:', e);
  if (srv) srv.kill();
  process.exitCode = 2;
});
