#!/usr/bin/env node
/**
 * 헤드리스 E2E — 1·2·3번 탭 잔여 실시간 API 고도화 검증
 *   node test_e2e_extra.mjs                 (로컬 dev_server 자동 기동)
 *   BASE=https://stock-dashboard-live-psi.vercel.app node test_e2e_extra.mjs   (라이브)
 *
 *  검증 항목
 *   1) 1번 탭 '실전 타점 신호등' 6칩이 RN존 실측값으로 자동 생성되는지 (하드코딩 문구 소거)
 *   2) 6번 탭을 열지 않아도 RN존 11종목 /api/stock-chart 백그라운드 갱신이 도는지
 *   3) 3번 애프터마켓 NXT Top 6 — 현재가·등락률·통합대금 실시간 + 통합대금순 재정렬
 *   4) 3번 탭 요약 문장 — 코스피·코스닥·NQ=F·ES=F 실시간 / KRX 야간선물 분리 표기
 *   5) 2번 수급 탭 카드 — 현재가·등락률만 실시간 (외인·기관 금액 불변)
 *   6) 9번 달력·8번 DART 배지 정직 라벨
 *   7) 콘솔·페이지·HTTP 오류 0, 폴드8 폭(884px) 가로 넘침 0
 *
 * 결과: e2e_extra_results.json · 스크린샷: live_extra_*.png
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// puppeteer: 로컬 설치 우선, 없으면 워크스페이스 E2E 하네스 사용
let puppeteer;
try {
  puppeteer = createRequire(import.meta.url)('puppeteer');
} catch (_) {
  try {
    puppeteer = createRequire('/workspace/_tools/e2e/run.mjs')('puppeteer');
  } catch (e2) {
    console.error('puppeteer 가 필요합니다:  npm i -D puppeteer  (또는 PUPPETEER 실행 환경 필요)');
    process.exit(2);
  }
}

const EXTERNAL = process.env.BASE || null;
const PORT = Number(process.env.PORT || 8794);
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;
const SHOT = (n) => path.join(__dirname, `live_extra_${n}.png`);

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok: !!ok, detail: detail === undefined ? null : detail });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail !== undefined && detail !== null ? `  → ${detail}` : ''}`);
  return !!ok;
};

let server = null;
if (!EXTERNAL) {
  server = spawn(process.execPath, ['dev_server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
}
async function waitServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/stock-live?codes=005930`, { signal: AbortSignal.timeout(20000) });
      if (r.ok) return true;
    } catch (_) { /* 대기 */ }
    await sleep(500);
  }
  return false;
}

const up = await waitServer();
check('서버 응답 (GET /api/stock-live 200)', up, BASE);
if (!up) {
  if (server) server.kill('SIGKILL');
  process.exit(1);
}

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=ko-KR', '--force-device-scale-factor=2'],
});

const page = await browser.newPage();
await page.setViewport({ width: 884, height: 1100, deviceScaleFactor: 2 });

const consoleErrors = [];
const pageErrors = [];
const httpErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
page.on('response', (r) => {
  const u = r.url();
  if (u.startsWith(BASE) && r.status() >= 400) httpErrors.push(`${r.status()} ${u.replace(BASE, '')}`);
});

// 신호등 하드코딩 문구(작업 전 상태) — 페이지 로드 직후 사라져 있어야 한다
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 180000 });

/* ---------- 1) 1번 탭 신호등 칩 ---------- */
const chipsReady = await page.waitForFunction(
  () => {
    const host = document.getElementById('signalChipsScroll');
    return !!host && host.getAttribute('data-live') === '1';
  },
  { timeout: 120000 },
).then(() => true).catch(() => false);

const chipInfo = await page.evaluate(() => {
  const host = document.getElementById('signalChipsScroll');
  const chips = host ? Array.from(host.querySelectorAll('.signal-chip[data-live="1"]')) : [];
  return {
    count: chips.length,
    texts: chips.map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
    codes: chips.map((c) => c.getAttribute('data-signal-code')),
    onclick: chips.map((c) => c.getAttribute('onclick')),
    stamp: (document.getElementById('signalChipsStamp') || {}).textContent || null,
    hostText: host ? host.textContent : '',
  };
});
check('1번 탭 신호등 칩 자동 생성', chipsReady && chipInfo.count === 6, `${chipInfo.count}칩 · ${chipInfo.stamp}`);
check('하드코딩 칩(피에스케이홀딩스 152,800원) 소거',
  !/피에스케이홀딩스 152,800/.test(chipInfo.hostText) && !/156,000원 이하 체결존/.test(chipInfo.hostText),
  chipInfo.texts[0]);
check('칩 본문이 실측 수치(RN·현재가·등락률)로 구성',
  chipInfo.texts.every((t) => /RN|타점|통합대금|원/.test(t)) && chipInfo.codes.every((c) => /^\d{6}$/.test(c || '')),
  chipInfo.codes.join(','));
check('칩 클릭 → RN존/메인 탭 이동 액션 연결',
  chipInfo.onclick.every((o) => /LiveExtra\._open\(\d+\)/.test(o || '')),
  chipInfo.onclick[0]);

/* ---------- 2) 6번 탭 미개방 상태의 RN 백그라운드 실측 ---------- */
const rnBg = await page.evaluate(() => {
  const st = (window.LiveAPI && window.LiveAPI.rnState) || {};
  const rnTab = document.getElementById('tabRnzone');
  return { lastAt: st.lastAt || null, ok: st.ok || 0, total: st.total || 0, rnTabVisible: rnTab ? rnTab.style.display !== 'none' : null };
});
const rnReady = await page.waitForFunction(
  () => {
    const st = (window.LiveAPI && window.LiveAPI.rnState) || {};
    return Boolean(st.lastAt) && (st.ok || 0) >= 8;
  },
  { timeout: 120000 },
).then(() => true).catch(() => false);
const rnAfter = await page.evaluate(() => {
  const st = window.LiveAPI.rnState || {};
  const stamp = (document.getElementById('signalChipsStamp') || {}).textContent || '';
  return { lastAt: st.lastAt, ok: st.ok, total: st.total, stamp, rnTabVisible: (document.getElementById('tabRnzone') || {}).style.display };
});
check('6번 탭을 열지 않아도 RN존 실측 백그라운드 갱신', rnReady && rnAfter.rnTabVisible === 'none',
  `${rnAfter.ok}/${rnAfter.total}종목 · 갱신 ${rnAfter.lastAt} (RN탭 display=${rnAfter.rnTabVisible})`);
check('신호등 배지에 실측 갱신 시각 표기', /RN 실측 \d{2}:\d{2}:\d{2} 갱신/.test(rnAfter.stamp), rnAfter.stamp);

// 실측 갱신 후: 칩에 찍힌 RN 수치가 RN존 실제 값과 일치하는지 (내장값 고착 방지)
const chipSync = await page.evaluate(() => {
  const st = (window.RnZone && window.RnZone.getStocks()) || [];
  const chips = Array.from(document.querySelectorAll('#signalChipsScroll .signal-chip'));
  return chips.map((c) => {
    const code = c.getAttribute('data-signal-code');
    const s = st.find((x) => x.code === code);
    const txt = c.textContent.replace(/\s+/g, ' ');
    // 1번 탭 실시간 상한가·신고가 칩은 RN 수치가 없는 게 정상 → 검증 제외
    if (!s || !/RN/.test(txt)) return { code, ok: true, skipped: true, txt: txt.slice(0, 70) };
    const lower = Math.round(s.lowerRN).toLocaleString('ko-KR');
    const upper = Math.round(s.upperRN).toLocaleString('ko-KR');
    return { code, lower, upper, ok: txt.includes(lower) || txt.includes(upper), txt: txt.slice(0, 90) };
  });
});
check('칩 RN 수치가 갱신된 RN존 실측값과 일치',
  chipSync.filter((c) => !c.skipped).length >= 3 && chipSync.every((c) => c.ok),
  chipSync.map((c) => (c.skipped ? `${c.code}:${c.txt.includes('RN') ? 'RN없음' : '1탭칩'}` : `${c.code} RN ${c.lower}~${c.upper} ${c.ok ? 'OK' : '불일치'}`)).join(' | '));

/* ---------- 3) 3번 애프터마켓 · NXT 랭킹 ---------- */
await page.evaluate(() => {
  const btn = document.querySelector('.tab-btn[data-view="aftermarket"]');
  if (btn) btn.click();
});
await sleep(600);
const nxtWait = await page.waitForFunction(
  () => {
    const grid = document.getElementById('nxtRankGrid');
    if (!grid) return false;
    return Array.from(grid.querySelectorAll('[data-nxt-code]')).every((c) => c.getAttribute('data-live') === '1');
  },
  { timeout: 90000 },
).then(() => true).catch(() => false);

const nxt = await page.evaluate(() => {
  const grid = document.getElementById('nxtRankGrid');
  const cards = grid ? Array.from(grid.querySelectorAll('[data-nxt-code]')) : [];
  return {
    count: cards.length,
    rows: cards.map((c) => ({
      rank: (c.querySelector('.nxt-rank') || {}).textContent,
      code: c.getAttribute('data-nxt-code'),
      price: (c.querySelector('.nxt-price') || {}).textContent,
      pct: (c.querySelector('.nxt-pct') || {}).textContent,
      value: (c.querySelector('.nxt-value') || {}).textContent,
      state: (c.querySelector('.nxt-state') || {}).textContent,
      live: c.getAttribute('data-live'),
    })),
    stamp: (document.getElementById('nxtRankStamp') || {}).textContent || '',
  };
});
check('3번 NXT Top 6 카드 6개 실시간 갱신', nxtWait && nxt.count === 6 && nxt.rows.every((r) => r.live === '1'),
  nxt.rows.map((r) => `${r.rank} ${r.code} ${r.price} ${r.pct} ${r.value}`).join(' | '));
check('NXT 랭킹이 통합대금 내림차순으로 재정렬', nxt.rows.every((r, i) => r.rank === `TOP ${i + 1}`),
  (() => {
    const toNum = (t) => {
      if (!t) return 0;
      const jo = /([\d,.]+)조/.exec(t); const eok = /([\d,.]+)억/.exec(t);
      return (jo ? parseFloat(jo[1].replace(/,/g, '')) * 1e12 : 0) + (eok ? parseFloat(eok[1].replace(/,/g, '')) * 1e8 : 0);
    };
    const vals = nxt.rows.map((r) => toNum(r.value));
    return `${vals.join(' > ')} ${vals.every((v, i) => i === 0 || vals[i - 1] >= v) ? '내림차순 OK' : '역전 있음'}`;
  })());
check('NXT 배지가 실제 조회 시각·통합대금 기준을 표기', /⚡ \d{2}:\d{2}:\d{2} 조회 · .*통합대금\(KRX\+NXT\)/.test(nxt.stamp), nxt.stamp);

/* ---------- 4) 3번 탭 요약 문장 ---------- */
const sum = await page.evaluate(() => {
  const g = (id) => (document.getElementById(id) || {}).textContent || null;
  const tab = document.getElementById('tabAftermarket');
  return {
    kospi: g('afKospi'), kosdaq: g('afKosdaq'), nq: g('afNq'), es: g('afEs'),
    liveAttr: ['afKospi', 'afKosdaq', 'afNq', 'afEs'].map((id) => (document.getElementById(id) || {}).getAttribute
      ? document.getElementById(id).getAttribute('data-live') : null),
    night: (() => {
      if (!tab) return null;
      const t = tab.textContent.replace(/\s+/g, ' ');
      const i = t.indexOf('KRX 야간선물(공개 실시간 API 없음');
      return i >= 0 ? t.slice(i, i + 130) : null;
    })(),
    nightValueKept: Boolean(tab && /837\.50/.test(tab.textContent)),
    afSpansHaveNight: ['afKospi', 'afKosdaq', 'afNq', 'afEs'].some((id) => {
      const el = document.getElementById(id);
      return Boolean(el && /837\.50/.test(el.textContent));
    }),
    hasNightText: tab ? /KRX 야간선물\(공개 실시간 API 없음 · 위 지수·선물과 별개\)/.test(tab.textContent) : false,
    hasFakeNight: tab ? /837\.50 \(\+0\.14% 🟢 836선 지지\) · CME/.test(tab.textContent) : false,
  };
});
check('요약 문장 코스피·코스닥·NQ=F·ES=F 실시간 표기',
  ['kospi', 'kosdaq', 'nq', 'es'].every((k) => /\d[\d,]*\.\d{2} \([-+]?\d+\.\d{2}%\)/.test(sum[k] || '')),
  `코스피 ${sum.kospi} · 코스닥 ${sum.kosdaq} · NQ ${sum.nq} · ES ${sum.es}`);
check('지수·선물 span 4개가 실시간 갱신 표시(data-live=1)', sum.liveAttr.every((v) => v === '1'), sum.liveAttr.join(','));
check('KRX 야간선물은 실시간이 아님을 분리 표기', sum.hasNightText && !sum.hasFakeNight && sum.nightValueKept && !sum.afSpansHaveNight, sum.night);

/* ---------- 4-1) 상단 WTI 유가 · 필라델피아 반도체(SOX) 실시간 연동 ---------- */
const macroReady = await page.waitForFunction(
  () => {
    const af = document.getElementById('afSox');
    return !!af && af.getAttribute('data-live') === '1';
  },
  { timeout: 90000 },
).then(() => true).catch(() => false);
const macro = await page.evaluate(() => {
  const bar = document.querySelector('.ticker-bar');
  const items = bar ? Array.from(bar.querySelectorAll('.ticker-item')) : [];
  const pick = (kw) => {
    const it = items.find((el) => {
      const l = el.querySelector('.label');
      return l && (l.textContent || '').indexOf(kw) >= 0;
    });
    if (!it) return null;
    const label = it.querySelector('.label');
    return {
      value: (it.querySelector('.val') || {}).textContent || null,
      badge: label ? (label.querySelector('span') || {}).textContent || null : null,
      title: it.getAttribute('title'),
      onclick: it.getAttribute('onclick'),
    };
  };
  return {
    wti: pick('WTI'),
    sox: pick('필라델피아'),
    afWti: (document.getElementById('afWti') || {}).textContent || null,
    afSox: (document.getElementById('afSox') || {}).textContent || null,
    mfSox: (document.getElementById('mfSox') || {}).textContent || null,
    // 현재상태를 보여주는 자리(상단 티커·요약 span)만 본다 — 날짜가 붙은 지난 브리핑 카드는 과거 기록
    staleSox: (() => {
      const bar = document.querySelector('.ticker-bar');
      const text = [bar ? bar.textContent : '', (document.getElementById('afSox') || {}).textContent || '',
        (document.getElementById('mfSox') || {}).textContent || '', (document.getElementById('afWti') || {}).textContent || ''].join(' ');
      return /5,232\.85|\+3\.42%/.test(text);
    })(),
  };
});
check('상단 WTI 유가 티커가 야후 CL=F 실시간 값으로 갱신',
  macroReady && Boolean(macro.wti) && /^\$\d+(\.\d+)? \([-+]?\d+\.\d{2}%\)$/.test(macro.wti.value || ''),
  `WTI ${macro.wti && macro.wti.value} · 배지 ${macro.wti && macro.wti.badge} · ${macro.wti && macro.wti.title}`);
check('상단 WTI 마감/실시간 구분 배지 + 열었을 때 값도 같은 수치',
  Boolean(macro.wti) && /NYMEX (실시간|마감값)/.test(macro.wti.badge || '') &&
    (macro.wti.onclick || '').indexOf((macro.wti.value || '').replace(/^/, '')) >= 0,
  `배지 ${macro.wti && macro.wti.badge} / 클릭 팝업 ${(macro.wti && macro.wti.onclick || '').slice(0, 90)}`);
check('상단 SOX 티커가 야후 ^SOX 최신치로 갱신 (낡은 +3.42% 5,232.85 소거)',
  macroReady && Boolean(macro.sox) && /^[\d,]+\.\d{2} \([-+]?\d+\.\d{2}%\)$/.test(macro.sox.value || '') && !macro.staleSox,
  `SOX ${macro.sox && macro.sox.value} · 배지 ${macro.sox && macro.sox.badge} · 낡은값 ${macro.staleSox ? '남아있음' : '없음'}`);
check('SOX는 美 장 마감값(일 1회) 성격을 배지·툴팁으로 표기',
  Boolean(macro.sox) && /(美장 마감 기준|SOX 실시간)/.test(macro.sox.badge || '') && /1일 1회/.test(macro.sox.title || ''),
  `배지 ${macro.sox && macro.sox.badge} / ${macro.sox && macro.sox.title}`);
check('3번 요약 문장·분석 패널의 SOX·WTI도 같은 실시간 값',
  /^[\d,]+\.\d{2} \([-+]?\d+\.\d{2}%\)$/.test(macro.afSox || '') && /^\$\d+(\.\d+)? \([-+]?\d+\.\d{2}%\)$/.test(macro.afWti || ''),
  `afSox ${macro.afSox} / afWti ${macro.afWti}`);

/* ---------- 4-2) 3번 탭 시간외 체결 대금·등락 순위 (감시군 실시간 산출) ---------- */
const afterReady = await page.waitForFunction(
  () => {
    const host = document.getElementById('tabsLiveAfterTop');
    return !!host && host.getAttribute('data-live') === '1';
  },
  { timeout: 90000 },
).then(() => true).catch(() => false);
const afterPanel = await page.evaluate(() => {
  const host = document.getElementById('tabsLiveAfterTop');
  if (!host) return { mounted: false };
  const rows = Array.from(host.querySelectorAll('.reason-item'));
  const title = Array.from(document.querySelectorAll('#tabAftermarket .sec-head'))
    .find((h) => (h.textContent || '').indexOf('시간외) 실시간 체결') >= 0);
  return {
    mounted: true,
    rows: rows.length,
    texts: rows.map((r) => (r.querySelector('.ri-head') || {}).textContent || ''),
    metas: rows.slice(0, 2).map((r) => (r.querySelector('.ri-meta') || {}).textContent || ''),
    sub: title ? ((title.querySelector('.sub') || {}).textContent || null) : null,
    head: title ? (title.textContent || '').replace(/\s+/g, ' ').trim() : null,
    bodyTop: host ? ((host.querySelector('div') || {}).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) : null,
    hasStaticStale: /11\/13 실체결/.test(host.parentNode ? host.parentNode.textContent : ''),
    note: (Array.from(host.querySelectorAll('div')).find((d) => /시간외 대금 =/.test(d.textContent || '')) || {}).textContent || null,
  };
});
check('3번 탭 시간외 대금/등락 순위 패널 실시간 렌더',
  afterReady && afterPanel.rows >= 3 && afterPanel.texts.every((t) => /\d{6}/.test(t)),
  `${afterPanel.rows}행`);
check('순위 행에 종목명·코드·시간외 대금·체결가·정규장 등락 표기',
  afterPanel.rows > 0 && afterPanel.texts.some((t) => /(억|조)/.test(t)) && afterPanel.metas.every((m) => /시간외 체결 [\d,]+원/.test(m)),
  `${afterPanel.texts[0]} || ${afterPanel.metas[0]}`);
check('시간외 세션 여부·직전 거래일 기준을 헤더에 명시',
  /(직전 거래일|시간외 세션 진행 중)/.test((afterPanel.sub || '') + ' ' + (afterPanel.bodyTop || '')) &&
    /\d{2}:\d{2}:\d{2} 갱신/.test(afterPanel.sub || ''),
  `${afterPanel.sub} || ${afterPanel.bodyTop}`);
check('정적 "11/13 실체결" 카드가 실시간 순위로 교체', !afterPanel.hasStaticStale, afterPanel.hasStaticStale ? '정적 카드 남음' : '정적 카드 제거됨');
check('시간외 대금 산정 기준(통합−정규장)을 화면에 설명', /시간외 대금 =/.test(afterPanel.note || ''), (afterPanel.note || '').slice(0, 90));

// NXT 랭킹 패널 · 지수/선물 요약 문장 확대 스크린샷
for (const [name, sel] of [
  ['nxt_panel', () => document.getElementById('nxtRankGrid') && document.getElementById('nxtRankGrid').closest('div[id="nxtRankPanel"]')],
  ['after_summary', () => document.getElementById('afKospi') && document.getElementById('afKospi').closest('.panel-box')],
]) {
  const handle = await page.evaluateHandle(sel);
  const el = handle.asElement();
  if (el) {
    try { await el.screenshot({ path: SHOT(name) }); } catch (_) { /* 高大한 요소는 넘어감 */ }
  }
  await handle.dispose();
}
await page.screenshot({ path: SHOT('aftermarket') });

/* ---------- 5) 2번 수급 탭 카드 ---------- */
await page.evaluate(() => {
  const btn = document.querySelector('.tab-btn[data-view="supply"]');
  if (btn) btn.click();
});
await sleep(600);
const supplyWait = await page.waitForFunction(
  () => {
    const tab = document.getElementById('tabSupply');
    if (!tab) return false;
    const cells = Array.from(tab.querySelectorAll('.ssc-price'));
    return cells.length > 0 && cells.filter((c) => c.getAttribute('data-live') === '1').length >= 10;
  },
  { timeout: 90000 },
).then(() => true).catch(() => false);

const supply = await page.evaluate(() => {
  const tab = document.getElementById('tabSupply');
  const cards = Array.from(tab.querySelectorAll('.supply-stock-card'));
  return {
    cards: cards.map((c) => ({
      name: (c.querySelector('.ssc-name') || {}).textContent,
      price: (c.querySelector('.ssc-price') || {}).textContent,
      code: (c.querySelector('.ssc-price') || {}).getAttribute
        ? c.querySelector('.ssc-price').getAttribute('data-live-code') : null,
      net: Array.from(c.querySelectorAll('.s-badge')).map((b) => b.textContent.trim()).join(' / '),
    })),
    stamp: (document.getElementById('supplyLiveStamp') || {}).textContent || '',
  };
});
check('2번 수급 카드 현재가·등락률 실시간 갱신', supplyWait, supply.cards.slice(0, 3).map((c) => `${c.name} ${c.price}`).join(' | '));
check('수급 카드에 6자리 종목코드 매핑', supply.cards.filter((c) => /^\d{6}$/.test(c.code || '')).length >= 12,
  Array.from(new Set(supply.cards.map((c) => c.code).filter(Boolean))).join(','));
check('외인·기관 순매수 금액은 확정치 그대로 유지(실시간 아님)',
  /외인 \+7,449억/.test(supply.cards[0].net) && /KRX 장마감 확정치/.test(supply.stamp),
  `${supply.cards[0].name}: ${supply.cards[0].net}`);
await page.screenshot({ path: SHOT('supply') });

/* ---------- 6) 정직 라벨(9번 달력·8번 DART) ---------- */
const labels = await page.evaluate(() => {
  const cal = document.getElementById('tabCalendar');
  const jong = document.getElementById('tabJongbe');
  return {
    calText: cal ? cal.textContent : '',
    jongText: jong ? jong.textContent : '',
    doc: document.body.textContent,
  };
});
check('9번 달력 배지: 정기 백엔드 반영 기준으로 표기',
  /정기 백엔드 반영 기준/.test(labels.calText) && !/실시간 자동 갱신: \d{2}:\d{2}:\d{2}/.test(labels.calText),
  (labels.calText.match(/정기 백엔드 반영 기준[^)]*\)/) || [''])[0]);
check('8번 DART 배지: 정기 스캔 결과로 표기',
  /DART 전자공시 정기 스캔 결과/.test(labels.jongText) && /자동 실시간 아님/.test(labels.jongText) &&
  !/DART 전자공시 실시간 악재 레이더 가동 중/.test(labels.doc));

/* ---------- 6-1) DART 실시간 레이더 (/api/dart-live) — 키 미설정 폴백이 정직한지 ---------- */
const dartApi = await (await fetch(`${BASE}/api/dart-live`)).json();
const dartDom = await page.evaluate(() => {
  const note = document.getElementById('dartKeyState');
  return {
    keyState: note ? (note.textContent || '').trim() : null,
    bannerTitle: (document.getElementById('dartRadarTitle') || {}).textContent || null,
    bannerBody: (document.getElementById('dartRadarBody') || {}).textContent || null,
    liveList: (document.getElementById('dartLiveList') || {}).textContent || '',
    modalSection: (document.getElementById('dartLiveSection') || {}).textContent || '',
    staticKept: /전 종목 악재 없음|정기 스캔/.test(document.getElementById('dartRadarBody') ? document.getElementById('dartRadarBody').textContent : ''),
  };
});
const dartKeySet = Boolean(dartApi && dartApi.ok === true);
check('8번 DART 레이더 — 실시간 조회 상태를 화면에 표시',
  Boolean(dartDom.keyState) || dartKeySet,
  dartKeySet ? `실시간 조회 ok (공시 ${dartApi.counts && dartApi.counts.matched}건)` : `상태표시 "${dartDom.keyState}"`);
check('DART_API_KEY 없으면 정직 폴백(정적 스캔 유지 · 가짜 실시간 표기 없음)',
  dartKeySet
    ? /DART 전자공시 실시간 조회/.test(dartDom.bannerTitle || '')
    : (/미설정|키 오류|조회 실패/.test(dartDom.keyState || '') && /정적 스캔|기존 정적/.test(dartDom.modalSection) && !/DART_API_KEY 미설정.*실시간 조회/.test(dartDom.bannerTitle || '')),
  dartKeySet ? dartDom.bannerTitle : `배지 ${dartDom.keyState} / 모달 ${(dartDom.modalSection || '').replace(/\s+/g, ' ').slice(0, 80)}`);
check('DART 모달에 실시간 섹션 자리 · 정적 판정 근거 유지',
  Boolean(dartDom.modalSection) && /4대 치명적 악재/.test(labels.doc),
  (dartDom.modalSection || '').replace(/\s+/g, ' ').slice(0, 70));

/* ---------- 7) 6·8·9번 탭 회귀(다른 탭이 상하지 않았는지) ---------- */
await page.evaluate(() => {
  const btn = document.querySelector('.tab-btn[data-view="rnzone"]');
  if (btn) btn.click();
});
await sleep(900);
const rnTab = await page.evaluate(() => {
  const tab = document.getElementById('tabRnzone');
  const grid = document.getElementById('stockListGrid');
  const cards = grid ? grid.querySelectorAll('.stock-card') : [];
  const row = cards[0];
  return {
    display: tab ? tab.style.display : null,
    cardCount: cards.length,
    firstCard: row ? row.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : null,
    hasLiveValue: tab ? /당일 대금/.test(tab.textContent) : false,
  };
});
check('6번 RN존 탭 정상 렌더(11종목 카드 · 당일 대금)', rnTab.display !== 'none' && rnTab.cardCount === 11 && rnTab.hasLiveValue, `${rnTab.cardCount}카드 · ${rnTab.firstCard}`);
await page.screenshot({ path: SHOT('rnzone') });

await page.evaluate(() => {
  const btn = document.querySelector('.tab-btn[data-view="jongbe"]');
  if (btn) btn.click();
});
await sleep(700);
const jong = await page.evaluate(() => {
  const tab = document.getElementById('tabJongbe');
  return {
    display: tab ? tab.style.display : null,
    lines: tab ? tab.textContent.replace(/\s+/g, ' ').trim().length : 0,
    dartText: tab ? /DART 전자공시 정기 스캔 결과/.test(tab.textContent) : false,
  };
});
check('8번 종베 탭 정상 렌더 + DART 정직 라벨', jong.display !== 'none' && jong.lines > 1500 && jong.dartText, `${jong.lines}자 · DART라벨=${jong.dartText}`);
await page.screenshot({ path: SHOT('jongbe') });

await page.evaluate(() => {
  const btn = document.querySelector('.tab-btn[data-view="calendar"]');
  if (btn) btn.click();
});
await sleep(700);
const cal = await page.evaluate(() => {
  const tab = document.getElementById('tabCalendar');
  const box = document.getElementById('calExpiryRuleBox');
  const todayCell = tab ? tab.querySelector('.cal-cell.today') : null;
  const optBadges = tab ? Array.from(tab.querySelectorAll('.cal-badge.opt')).map((b) => (b.textContent || '').trim()) : [];
  return {
    display: tab ? tab.style.display : null,
    cells: tab ? tab.querySelectorAll('.cal-cell').length : 0,
    dated: tab ? tab.querySelectorAll('.cal-cell[data-cal-date]').length : 0,
    badge: tab ? ((tab.textContent.match(/정기 백엔드 반영 기준[^)]*\)/) || [])[0] || null) : null,
    title: tab ? tab.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : null,
    today: todayCell ? (todayCell.getAttribute('data-cal-date') || '') : null,
    todayNum: todayCell ? ((todayCell.querySelector('.cal-date-num') || {}).textContent || '') : null,
    optBadges,
    ruleBox: box ? (box.textContent || '').replace(/\s+/g, ' ').trim() : null,
    ruleHalf: box ? /옵션만기일 = 매월 둘째 목요일/.test(box.textContent || '') && /3·6·9·12월 둘째 목요일/.test(box.textContent || '') : false,
    nextListed: box ? (box.textContent.match(/\d{4}\/\d{2}\/\d{2}\(목\) [^D]+/g) || []).slice(0, 3) : [],
    navText: (tab ? (tab.querySelector('.cal-month-nav') || {}).textContent : null) || null,
  };
});
check('9번 증시일정 탭 정상 렌더 + 정기 반영 라벨', cal.display !== 'none' && cal.cells > 20 && /정기 백엔드 반영 기준/.test(cal.badge || ''), `${cal.cells}셀 · ${cal.badge}`);
check('달력 칸마다 실제 날짜 부여 + 오늘 강조가 오늘 칸에',
  cal.dated >= cal.cells - 1 && Boolean(cal.today) && /⭐ 오늘: \d{1,2}월 \d{1,2}일/.test(cal.navText || ''),
  `data-cal-date ${cal.dated}/${cal.cells} · 오늘=${cal.today}(칸 ${cal.todayNum}) · 헤더 "${cal.navText}"`);
check('만기일 배지 = 둘째 목요일 규칙 + 상태(종료/D-N) 표시',
  cal.optBadges.length > 0 && cal.optBadges.every((t) => /(옵션만기|동시만기)/.test(t)) && cal.optBadges.some((t) => /\((종료|오늘 D-DAY|D-\d+)\)/.test(t)),
  cal.optBadges.join(' / '));
check('만기일 규칙·다가오는 만기 3건 박스',
  cal.ruleHalf && /D-\d+|오늘/.test(cal.ruleBox || '') && cal.nextListed.length >= 2,
  cal.nextListed.join(' → '));
await page.screenshot({ path: SHOT('calendar') });

/* ---------- 1번 탭 복귀 후 칩·레이아웃 ---------- */
await page.evaluate(() => {
  const btn = document.querySelector('.tab-btn[data-view="overview"]');
  if (btn) btn.click();
});
await sleep(500);
const layout = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  innerW: window.innerWidth,
  chipsOverflow: (() => {
    const host = document.getElementById('signalChipsScroll');
    return host ? host.scrollWidth : 0;
  })(),
}));
check('폴드8 폭(884px) 가로 넘침 0', layout.scrollW <= layout.innerW + 1, `scrollWidth ${layout.scrollW} / innerWidth ${layout.innerW}`);
await page.screenshot({ path: SHOT('overview_fold8') });

/* ---------- 오류 집계 ---------- */
check('콘솔 오류 0', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || 'none');
check('페이지(JS) 오류 0', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'none');
check('HTTP 4xx/5xx 0', httpErrors.length === 0, httpErrors.slice(0, 3).join(' | ') || 'none');

await browser.close();
if (server) server.kill('SIGKILL');

const passed = results.filter((r) => r.ok).length;
const out = {
  base: BASE,
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed,
  failed: results.filter((r) => !r.ok),
  results,
  chips: chipInfo,
  chipSync,
  rnAfter,
  nxt,
  sum,
  supplyCards: supply.cards,
  layout,
  consoleErrors,
  pageErrors,
  httpErrors,
};
writeFileSync(path.join(__dirname, 'e2e_extra_results.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('\n────────────────────────────────────────');
console.log(`E2E 결과: ${passed}/${results.length} 통과${passed === results.length ? ' — 전체 성공 🎉' : ''}`);
for (const f of out.failed) console.log(`  ❌ ${f.label} ${f.detail || ''}`);
console.log('상세 → dynamic_app/e2e_extra_results.json');
process.exit(passed === results.length ? 0 : 1);
