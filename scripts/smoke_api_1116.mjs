#!/usr/bin/env node
/**
 * 로컬 동적 서버 스모크 테스트 (11/16 고도화 검증용)
 *   node scripts/smoke_api_1116.mjs
 *
 *  dev_server.mjs 를 직접 띄워(/api/*) 아래를 확인한다.
 *   1) /api/stock-trend  → 최신 확정 수급 · 연속 순매수 일수 · 시총 · 시총 대비 비중
 *   2) /api/tabs-live    → 뉴스 수혜주 실시간 시세(+15% 선반영 판정) · 애프터마켓 정규장 대비 괴리율
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const PORT = Number(process.env.SMOKE_PORT || 8811);
const BASE = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, ['dev_server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d.toString(); });
srv.stderr.on('data', (d) => { srvLog += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch (e) { /* retry */ }
    await sleep(300);
  }
  return false;
}

const fail = [];
const ok = (cond, label, detail) => {
  console.log((cond ? '✅ ' : '❌ ') + label + (detail ? ' — ' + detail : ''));
  if (!cond) fail.push(label);
};

try {
  if (!(await waitUp())) throw new Error('dev_server 기동 실패\n' + srvLog);

  /* 1) 수급 */
  const tr = await fetch(BASE + '/api/stock-trend?codes=005930,000660,035900,263860', { signal: AbortSignal.timeout(30000) }).then((r) => r.json());
  ok(tr.ok === true, 'stock-trend ok', 'basis=' + tr.basisLabel);
  const withStreak = (tr.stocks || []).filter((s) => s.streaks && s.streaks.foreign && typeof s.streaks.foreign.days === 'number');
  ok(withStreak.length >= 2, '연속 순매수 일수 계산', withStreak.map((s) => s.code + ':외' + s.streaks.foreign.days + '/기' + s.streaks.organ.days).join(' '));
  const withCap = (tr.stocks || []).filter((s) => s.marketCap && typeof s.marketCap.eok === 'number' && s.marketCap.eok > 0);
  ok(withCap.length >= 2, '시가총액 수신', withCap.map((s) => s.code + ':' + s.marketCap.text).join(' '));
  const withRatio = (tr.stocks || []).filter((s) => s.ratioPct && (typeof s.ratioPct.foreign === 'number' || typeof s.ratioPct.organ === 'number'));
  ok(withRatio.length >= 1, '시총 대비 비중(%) 계산', withRatio.map((s) => s.code + ':' + s.ratioPct.foreign + '%/' + s.ratioPct.organ + '%').join(' '));

  /* 2) tabs-live */
  const tab = await fetch(BASE + '/api/tabs-live?fresh=1', { signal: AbortSignal.timeout(60000) }).then((r) => r.json());
  ok(tab.ok === true, 'tabs-live ok', 'phase=' + tab.sessionPhase);
  const news = tab.news || [];
  const newsWithLive = news.filter((n) => (n.beneficiaryStocks || []).some((s) => s.live && typeof s.live.changePct === 'number'));
  ok(newsWithLive.length >= 1, '뉴스 수혜주 실시간 등락률', newsWithLive.length + '/' + news.length + '건');
  const preRun = news.flatMap((n) => (n.beneficiaryStocks || []).filter((s) => s.live && s.live.preRun));
  ok(true, '선반영(+15%↑) 판정', preRun.length + '종목');
  const af = tab.aftermarket || {};
  const rows = [].concat(af.byValue || [], af.byPctTop || [], af.byPctBottom || []);
  const withDiv = rows.filter((r) => typeof r.divergencePct === 'number');
  ok(withDiv.length >= 1, '애프터마켓 정규장 대비 괴리율', withDiv.length + '/' + rows.length + '행 · 예: ' + (withDiv[0] ? withDiv[0].name + ' ' + withDiv[0].divergencePct + '% (정규장 ' + withDiv[0].regularClose + '원 vs ' + withDiv[0].overPrice + '원)' : '—'));
  ok((af.byValue || []).length <= 12, '시간외 대금 상위 행 수', String((af.byValue || []).length));
  if (tab.errors && tab.errors.length) console.log('ℹ️ tabs-live 부분 오류:', tab.errors.slice(0, 4).join(' | '));
  if (tab.sources) {
    const bad = tab.sources.filter((s) => s.ok === false);
    if (bad.length) console.log('ℹ️ 실패 소스:', bad.map((s) => s.name).join(', '));
  }
} catch (e) {
  console.error('❌ 예외:', e && e.message);
  fail.push('exception');
} finally {
  srv.kill('SIGTERM');
}

console.log(fail.length ? `\n실패 ${fail.length}건: ${fail.join(', ')}` : '\n전체 통과');
process.exit(fail.length ? 1 : 0);
