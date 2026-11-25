#!/usr/bin/env node
/**
 * 🤖 Gemini AI 브리핑(?ai=1) 로컬 실동작 테스트
 *   node test_ai_briefing.mjs
 *
 *  · 실제 네이버/Yahoo + Gemini 를 호출한다(네트워크 필요).
 *  · GEMINI_API_KEY 가 환경에 없으면 /workspace/.env.gemini.local 에서 읽는다.
 *  · 테스트용 미니 서버를 띄워 GET ?ai=1 의 자체 보조 수집(/api/tabs-live)까지 실제 경로로 검증한다.
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.GEMINI_API_KEY) {
  const envPath = '/workspace/.env.gemini.local';
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith('GEMINI_API_KEY='));
    if (line) process.env.GEMINI_API_KEY = line.split('=').slice(1).join('=').trim();
  }
}

const liveBriefing = require('./api/live-briefing.js');
const tabsLive = require('./api/tabs-live.js');

const results = [];
function check(label, cond, detail) {
  results.push({ label, ok: Boolean(cond) });
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? `  → ${detail}` : ''}`);
  return Boolean(cond);
}

function makeRes() {
  const state = { statusCode: 200, headers: {}, body: null };
  return {
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(v) {
      state.statusCode = v;
    },
    setHeader(k, v) {
      state.headers[String(k).toLowerCase()] = v;
    },
    end(chunk) {
      state.body = chunk === undefined ? '' : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
    _state: state,
  };
}

function streamReq(urlPath, method, jsonBody) {
  const payload = jsonBody ? Buffer.from(JSON.stringify(jsonBody)) : null;
  const req = {
    url: urlPath,
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload;
    },
  };
  return req;
}

async function invoke(req) {
  const res = makeRes();
  const t0 = Date.now();
  await liveBriefing(req, res);
  let json = null;
  try {
    json = JSON.parse(res._state.body);
  } catch (_) {
    /* noop */
  }
  return { status: res._state.statusCode, headers: res._state.headers, json, raw: res._state.body, ms: Date.now() - t0 };
}

/* ---------- 테스트용 미니 서버: /api/tabs-live · /data/supply-latest.json ---------- */
const tiny = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/api/tabs-live') return tabsLive(req, res);
  if (u.pathname === '/data/supply-latest.json') {
    try {
      const buf = readFileSync(path.join(__dirname, 'public', 'data', 'supply-latest.json'));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(buf);
    } catch (e) {
      res.statusCode = 404;
      return res.end('{}');
    }
  }
  res.statusCode = 404;
  res.end('not found');
});
const PORT = 8791;
await new Promise((r) => tiny.listen(PORT, '127.0.0.1', r));
const HOST = `127.0.0.1:${PORT}`;
console.log(`[test] 미니 서버 http://${HOST}`);

/* ============================ 1) GET /api/live-briefing?ai=1 ============================ */
console.log('\n▶ [1] GET /api/live-briefing?ai=1 (서버가 직접 팩트 수집 → Gemini)');
const getReq = streamReq('/api/live-briefing?ai=1', 'GET', null);
getReq.headers = { host: HOST };
const getRes = await invoke(getReq);
check('HTTP 200', getRes.status === 200, `status=${getRes.status} · ${getRes.ms}ms`);
check('Cache-Control no-store', String(getRes.headers['cache-control'] || '').includes('no-store'), getRes.headers['cache-control']);
const g = getRes.json || {};
check('ok=true', g.ok === true, g.message || '');
check('blocks 4개', Array.isArray(g.blocks) && g.blocks.length === 4, (g.blocks || []).map((b) => b.key).join(','));
check(
  '블록 순서 summary→market→themes→checkpoints',
  (g.blocks || []).map((b) => b.key).join(',') === 'summary,market,themes,checkpoints',
);
check('한줄 요약 2줄(요약+행동)', ((g.blocks || [])[0] || {}).lines?.length >= 1, JSON.stringify(((g.blocks || [])[0] || {}).lines));
check('ai.used', g.ai && g.ai.used === true, JSON.stringify(g.ai && { model: g.ai.model, reason: g.ai.reason, note: g.ai.note }));
check('ai.model 기록', !!(g.ai && g.ai.model), g.ai && g.ai.model);
check('지수 rows 존재', (((g.blocks || [])[1] || {}).rows || []).length >= 1, (((g.blocks || [])[1] || {}).rows || []).map((r) => r.label).join(' / '));
check('300억 미만 제외(digest)', !g.digest || g.digest.leadersBelow300 >= 0, JSON.stringify(g.digest && { leaders: g.digest.leadersCount, below: g.digest.leadersBelow300 }));

/* ============================ 2) POST ?ai=1 (브라우저가 모은 팩트) ============================ */
console.log('\n▶ [2] POST /api/live-briefing?ai=1 (브라우저 실측 팩트 재사용)');
const plain = await invoke(Object.assign(streamReq('/api/live-briefing?fresh=1', 'GET', null), { headers: { host: HOST } }));
const tabsRes = await new Promise((resolve) => {
  const req = { url: '/api/tabs-live', method: 'GET', headers: { host: HOST } };
  const res = makeRes();
  Promise.resolve(tabsLive(req, res)).then(() => {
    let json = null;
    try {
      json = JSON.parse(res._state.body);
    } catch (_) {}
    resolve(json || {});
  });
});
const facts = {
  live: {
    marketPhase: plain.json && plain.json.marketPhase,
    marketPhaseLabel: plain.json && plain.json.marketPhaseLabel,
    headline: plain.json && plain.json.headline,
    dataBasis: plain.json && plain.json.dataBasis,
    indices: (plain.json && plain.json.indices) || [],
    futures: (plain.json && plain.json.futures) || [],
    fx: plain.json && plain.json.fx,
    topMovers: (plain.json && plain.json.topMovers) || [],
    news: (plain.json && plain.json.news) || [],
    notes: (plain.json && plain.json.notes) || [],
  },
  tabs: {
    themes: (tabsRes.themes || []).map((t) => ({
      rank: t.rank,
      name: t.name,
      avgPct: t.avgPct,
      riseCount: t.riseCount,
      fallCount: t.fallCount,
      top4Sum: t.top4Sum,
      stocks: (t.stocks || []).slice(0, 4).map((x) => ({
        name: x.name,
        changePct: x.changePct,
        valueText: x.valueDispText || x.valueText,
        upperLimit: x.upperLimit,
      })),
    })),
    upperLimit: tabsRes.upperLimit ? { confirmed: (tabsRes.upperLimit.confirmed || []).slice(0, 3), watch: (tabsRes.upperLimit.watch || []).slice(0, 3) } : null,
  },
  supply: existsSync(path.join(__dirname, 'public', 'data', 'supply-latest.json'))
    ? JSON.parse(readFileSync(path.join(__dirname, 'public', 'data', 'supply-latest.json'), 'utf8'))
    : null,
};
console.log(`   facts: 테마 ${facts.tabs.themes.length} · 급등/대금 ${facts.live.topMovers.length} · 수급 ${facts.supply ? facts.supply.basisLabel : '없음'}`);
const postReq = streamReq('/api/live-briefing?ai=1', 'POST', { facts });
postReq.headers = { host: HOST, 'content-type': 'application/json' };
const postRes = await invoke(postReq);
check('POST 200', postRes.status === 200, `status=${postRes.status} · ${postRes.ms}ms`);
const po = postRes.json || {};
check('POST ok=true', po.ok === true, po.message || '');
check('POST blocks 4개', Array.isArray(po.blocks) && po.blocks.length === 4);
check('POST ai.used', po.ai && po.ai.used === true, JSON.stringify(po.ai && { model: po.ai.model, reason: po.ai.reason }));
check('POST 테마 칩 존재', (((po.blocks || [])[2] || {}).themes || []).length >= 1, (((po.blocks || [])[2] || {}).themes || []).map((t) => t.name).join(', '));
const leaders = ((po.blocks || [])[2] || {}).leaders || [];
check('POST 특징 종목 존재', leaders.length >= 1, leaders.map((l) => `${l.name} ${l.valueText}`).join(' · '));

/* ============================ 3) 키 없음 → 200 + 정직 안내 ============================ */
console.log('\n▶ [3] GEMINI_API_KEY 없음 → 500 이 아니라 200 + 실측 조립');
const savedKey = process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;
const noKeyReq = streamReq('/api/live-briefing?ai=1', 'POST', { facts });
noKeyReq.headers = { host: HOST, 'content-type': 'application/json' };
const noKey = await invoke(noKeyReq);
process.env.GEMINI_API_KEY = savedKey;
const nk = noKey.json || {};
check('키 없음 200', noKey.status === 200, `status=${noKey.status}`);
check('키 없음 ai.used=false', nk.ai && nk.ai.used === false, JSON.stringify(nk.ai && nk.ai.reason));
check('키 없음 안내 문구', !!(nk.ai && nk.ai.note), (nk.ai && nk.ai.note || '').slice(0, 90));
check('키 없음에도 4블록', Array.isArray(nk.blocks) && nk.blocks.length === 4);

/* ============================ 4) 잘못된 본문 ============================ */
console.log('\n▶ [4] 깨진 JSON 본문 → 400 (not 500)');
const bad = await invoke(
  Object.assign(streamReq('/api/live-briefing?ai=1', 'POST', { x: 1 }), { headers: { host: HOST } }),
);
check('본문에 facts 없음 → 200(자체 수집) 또는 400', bad.status === 200 || bad.status === 400, `status=${bad.status}`);

/* ---------------------------------- 요약 ---------------------------------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n결과: ${results.length - failed.length}/${results.length} 통과`);
if (failed.length) {
  console.log('실패:', failed.map((f) => f.label).join(' | '));
  process.exitCode = 1;
}
tiny.close();
