#!/usr/bin/env node
/**
 * 로컬 실동작 테스트 (Vercel 배포 전 검증용)
 *   node test_local.mjs
 *
 * 실제 네이버 금융 / Yahoo Finance 를 때려서 각 핸들러의 응답과 JSON 파싱을 확인한다.
 * 네트워크가 없으면 해당 항목은 FAIL 로 표시되고 종료코드 1.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const handlers = {
  'stock-live': require('./api/stock-live.js'),
  'stock-chart': require('./api/stock-chart.js'),
  'deals-shopping': require('./api/deals-shopping.js'),
  'live-briefing': require('./api/live-briefing.js'),
};

function makeReq(urlPath, method = 'GET') {
  return { url: urlPath, method, headers: { host: 'localhost:8787' } };
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
      if (chunk) state.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      else if (state.body === null) state.body = '';
    },
    _state: state,
  };
}

async function call(name, urlPath) {
  const res = makeRes();
  const started = Date.now();
  await handlers[name](makeReq(urlPath), res);
  const ms = Date.now() - started;
  let json = null;
  try {
    json = JSON.parse(res._state.body);
  } catch (e) {
    /* JSON 아님 */
  }
  return { name, urlPath, status: res._status ?? res._state.statusCode, headers: res._state.headers, json, raw: res._state.body, ms };
}

/* ------------------------------ 검증 도우미 ------------------------------ */
const results = [];
function check(label, cond, detail) {
  results.push({ label, ok: Boolean(cond), detail });
  const mark = cond ? '✅' : '❌';
  console.log(`${mark} ${label}${detail ? `  → ${detail}` : ''}`);
  return Boolean(cond);
}

const nf = (n, d = 2) =>
  n === null || n === undefined || Number.isNaN(n)
    ? '-'
    : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: 0 });

const summary = {};

console.log('\n══════════════════════════════════════════════════');
console.log(' 동적 앱 로컬 실동작 테스트  ', new Date().toISOString());
console.log('══════════════════════════════════════════════════\n');

/* ------------------------------ 1) stock-live ------------------------------ */
console.log('▶ [1] /api/stock-live');
const live = await call('stock-live', '/api/stock-live?fresh=1');
summary.stockLive = { status: live.status, ms: live.ms };

let liveOk = true;
liveOk &= check('HTTP 200', live.status === 200, `status=${live.status} (${live.ms}ms)`);
liveOk &= check('JSON 파싱', Boolean(live.json));
liveOk &= check('ok:true', live.json && live.json.ok === true);
liveOk &= check(
  'Cache-Control = s-maxage=10, stale-while-revalidate=20',
  (live.headers['cache-control'] || '').includes('s-maxage=10') &&
    (live.headers['cache-control'] || '').includes('stale-while-revalidate=20'),
  live.headers['cache-control'],
);

const idx = (live.json && live.json.indices) || [];
const kospi = idx.find((i) => i.key === 'KOSPI');
const kosdaq = idx.find((i) => i.key === 'KOSDAQ');
liveOk &= check('코스피 지수 수신', Boolean(kospi && kospi.price > 0), kospi ? `${nf(kospi.price)} (${nf(kospi.changePct)}%)` : '없음');
liveOk &= check('코스닥 지수 수신', Boolean(kosdaq && kosdaq.price > 0), kosdaq ? `${nf(kosdaq.price)} (${nf(kosdaq.changePct)}%)` : '없음');

const fx = live.json && live.json.fx;
liveOk &= check('원/달러 환율 수신', Boolean(fx && fx.price > 0), fx ? `${nf(fx.price)}원 (${nf(fx.changePct)}%, ${fx.source})` : '없음');

const fut = (live.json && live.json.futures) || [];
const nq = fut.find((f) => f.symbol === 'NQ=F');
const es = fut.find((f) => f.symbol === 'ES=F');
liveOk &= check('나스닥100 선물(NQ=F) 수신', Boolean(nq && nq.price > 0), nq ? `${nf(nq.price)} (${nf(nq.changePct)}%)` : '없음');
liveOk &= check('S&P500 선물(ES=F) 수신', Boolean(es && es.price > 0), es ? `${nf(es.price)} (${nf(es.changePct)}%)` : '없음');

const stocks = (live.json && live.json.stocks) || [];
liveOk &= check('주요 종목 현재가 10개 이상', stocks.length >= 10, `${stocks.length}종목`);
const samsung = stocks.find((s) => s.code === '005930');
liveOk &= check(
  '삼성전자 현재가·등락률·거래대금',
  Boolean(samsung && samsung.price > 0 && samsung.valueText),
  samsung ? `${nf(samsung.price)}원 ${nf(samsung.changePct)}% / 대금 ${samsung.valueText}` : '없음',
);

summary.stockLive = {
  ...summary.stockLive,
  indices: idx.map((i) => `${i.name} ${nf(i.price)} (${nf(i.changePct)}%) 대금 ${i.valueText || '-'}`),
  fx: fx ? `${nf(fx.price)}원 (${nf(fx.changePct)}%, ${fx.source})` : null,
  futures: fut.map((f) => `${f.name} ${nf(f.price)} (${nf(f.changePct)}%)`),
  stocks: stocks.map((s) => ({ code: s.code, name: s.label || s.name, price: s.price, changePct: s.changePct, valueText: s.valueText })),
  marketStatus: live.json && live.json.marketStatus,
  errors: (live.json && live.json.errors) || [],
};

/* ------------------------------ 2) stock-chart ------------------------------ */
console.log('\n▶ [2] /api/stock-chart?q=지니언스');
const chart1 = await call('stock-chart', '/api/stock-chart?q=' + encodeURIComponent('지니언스'));
let chartOk = true;
chartOk &= check('HTTP 200', chart1.status === 200, `status=${chart1.status} (${chart1.ms}ms)`);
chartOk &= check('종목코드 263860 자동 해석', chart1.json && chart1.json.code === '263860', chart1.json ? `${chart1.json.code} / ${chart1.json.resolvedBy}` : '');
chartOk &= check('일봉 60개 파싱', Boolean(chart1.json && chart1.json.candleCount === 60), `${chart1.json && chart1.json.candleCount}개`);
const c60 = (chart1.json && chart1.json.candles) || [];
const ohlcValid = c60.every((c) => c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c) && c.h >= c.l);
chartOk &= check('OHLC 정합성(고가≥max(시,종), 저가≤min(시,종))', ohlcValid);
const rn1 = chart1.json && chart1.json.rn;
chartOk &= check(
  'RN 지지/저항선 계산',
  Boolean(rn1 && rn1.supports.length > 0 && rn1.resistances.length > 0),
  rn1 ? `step ${rn1.step} / 지지 ${rn1.supports[0].level} (${rn1.supports[0].distancePct}%) / 저항 ${rn1.resistances[0].level} (+${rn1.resistances[0].distancePct}%)` : '',
);
chartOk &= check(
  '지지선 < 현재가 < 저항선',
  Boolean(rn1 && rn1.nearestSupport && rn1.nearestResistance && rn1.nearestSupport.level < chart1.json.current.price && rn1.nearestResistance.level > chart1.json.current.price),
);
chartOk &= check(
  '최근 봉 날짜·종가',
  Boolean(chart1.json && chart1.json.candles[c60.length - 1].date),
  chart1.json ? `${c60[c60.length - 1].date} 종가 ${nf(c60[c60.length - 1].c)}원 / 현재가 ${nf(chart1.json.current.price)}원` : '',
);
const cc = chart1.json && chart1.json.closeChange;
chartOk &= check(
  '일봉 종가 기준 등락(closeChange) 제공',
  Boolean(cc && typeof cc.changePct === 'number'),
  cc ? `${nf(cc.change)}원 (${nf(cc.changePct)}%) ${cc.fromDate}→${cc.toDate}` : '',
);
summary.stockChart = {
  query: '지니언스',
  code: chart1.json && chart1.json.code,
  name: chart1.json && chart1.json.name,
  resolvedBy: chart1.json && chart1.json.resolvedBy,
  candleCount: chart1.json && chart1.json.candleCount,
  from: chart1.json && chart1.json.range && chart1.json.range.from,
  to: chart1.json && chart1.json.range && chart1.json.range.to,
  current: chart1.json && chart1.json.current,
  rn: rn1
    ? {
        step: rn1.step,
        band: rn1.band,
        supports: rn1.supports.map((s) => `${s.level}(${s.distancePct}%, 터치${s.touches})`),
        resistances: rn1.resistances.map((s) => `${s.level}(${s.distancePct}%, 터치${s.touches})`),
      }
    : null,
  errors: (chart1.json && chart1.json.errors) || [],
};

console.log('\n▶ [3] /api/stock-chart?code=005930 (삼성전자, 코드 직접)');
const chart2 = await call('stock-chart', '/api/stock-chart?code=005930');
chartOk &= check('HTTP 200 + 60봉', chart2.status === 200 && chart2.json.candleCount === 60, `${chart2.json && chart2.json.candleCount}봉 / ${chart2.json && chart2.json.name}`);

console.log('\n▶ [4] /api/stock-chart?q=코리아써키트 (종목명 한글)');
const chart3 = await call('stock-chart', '/api/stock-chart?q=' + encodeURIComponent('코리아써키트'));
chartOk &= check('HTTP 200 + 종목코드 007810', chart3.status === 200 && chart3.json.code === '007810', `${chart3.json && chart3.json.code} / ${chart3.json && chart3.json.name} / 현재 ${nf(chart3.json && chart3.json.current.price)}원`);

console.log('\n▶ [5] 예외 처리');
const chart4 = await call('stock-chart', '/api/stock-chart?q=' + encodeURIComponent('존재하지않는종목zzz'));
chartOk &= check('없는 종목 → 404 + reason', chart4.status === 404 && chart4.json.reason === 'not_found', `status=${chart4.status}`);
const chart5 = await call('stock-chart', '/api/stock-chart');
chartOk &= check('q 없음 → 400', chart5.status === 400, `status=${chart5.status}`);

/* ---------------------------- 3) deals-shopping ---------------------------- */
console.log('\n▶ [6] /api/deals-shopping?q=돼지고기 국내산 1kg');
const shop = await call('deals-shopping', '/api/deals-shopping?q=' + encodeURIComponent('돼지고기 국내산 1kg'));
let shopOk = true;
shopOk &= check('HTTP 200 (키 없음에도 503 아님)', shop.status === 200, `status=${shop.status} (${shop.ms}ms)`);
shopOk &= check('ok:false + reason', Boolean(shop.json && shop.json.ok === false), shop.json && JSON.stringify({ reason: shop.json.reason, message: shop.json.message }).slice(0, 160));
shopOk &= check(
  '키 미연동 시 missing_naver_api_key',
  Boolean(shop.json && shop.json.reason === 'missing_naver_api_key'),
  shop.json && shop.json.reason,
);
shopOk &= check('직접검색 대체 링크 제공', Boolean(shop.json && shop.json.searchUrl));
const shop2 = await call('deals-shopping', '/api/deals-shopping');
shopOk &= check('q 없음 → 400', shop2.status === 400, `status=${shop2.status}`);
summary.dealsShopping = {
  status: shop.status,
  reason: shop.json && shop.json.reason,
  message: shop.json && shop.json.message,
  searchUrl: shop.json && shop.json.searchUrl,
  envKeysPresent: Boolean(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET),
};

/* ---------------------------- 4) live-briefing ---------------------------- */
console.log('\n▶ [7] /api/live-briefing?fresh=1 (⚡ 클릭 순간 실시간 브리핑)');
const lb = await call('live-briefing', '/api/live-briefing?fresh=1');
let lbOk = true;
lbOk &= check('HTTP 200', lb.status === 200, `status=${lb.status} (${lb.ms}ms)`);
lbOk &= check('ok:true + 부분 실패 0건', lb.json && lb.json.ok === true && (lb.json.errors || []).length === 0, (lb.json && (lb.json.errors || []).join(' · ')) || 'none');
lbOk &= check('generatedAtKst HH:MM:SS', /^\d{2}:\d{2}:\d{2}$/.test((lb.json && lb.json.generatedAtKst) || ''), lb.json && lb.json.generatedAtKst);
lbOk &= check('marketPhase 판정', Boolean(lb.json && lb.json.marketPhase), lb.json ? `${lb.json.marketPhase} — ${lb.json.marketPhaseLabel}` : '');
lbOk &= check('코스피·코스닥 지수 + 거래대금', Boolean(lb.json && (lb.json.indices || []).length === 2 && lb.json.indices.every((i) => i.price > 0 && i.valueText)), (lb.json && (lb.json.indices || []).map((i) => `${i.name} ${nf(i.price)} (${nf(i.changePct)}%) ${i.valueText}`).join(' / ')) || '');
lbOk &= check('선물 NQ=F·ES=F', Boolean(lb.json && (lb.json.futures || []).length === 2), (lb.json && (lb.json.futures || []).map((f) => `${f.symbol} ${nf(f.price)} (${nf(f.changePct)}%)`).join(' / ')) || '');
lbOk &= check('원/달러 환율', Boolean(lb.json && lb.json.fx && lb.json.fx.price > 0), lb.json && lb.json.fx ? `${nf(lb.json.fx.price)}원 (${nf(lb.json.fx.changePct)}%) ${lb.json.fx.source}` : '없음');
lbOk &= check('급등·거래대금 상위 1~6종목', Boolean(lb.json && (lb.json.topMovers || []).length > 0 && lb.json.topMovers.length <= 6), (lb.json && (lb.json.topMovers || []).map((s) => `${s.tag}:${s.name} ${nf(s.price)} (${nf(s.changePct)}%) ${s.valueText}`).join(' / ')) || '');
lbOk &= check('최신 뉴스 5건 + n.news 링크', Boolean(lb.json && (lb.json.news || []).length === 5 && lb.json.news.every((n) => n.title && /^https:\/\/n\.news\.naver\.com\//.test(n.url || ''))), (lb.json && (lb.json.news || []).map((n) => `${n.time} ${n.title.slice(0, 20)}`).join(' / ')) || '');
{
  const td = lb.json && lb.json.dataBasis && lb.json.dataBasis.tradingDate;
  const wdKo = { Sun: '일', Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토' };
  const expect = td
    ? `${td}(${wdKo[new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(new Date(`${td}T00:00:00+09:00`))]})`
    : null;
  lbOk &= check('기준일 요일(KST 정확)', Boolean(td) && lb.json.dataBasis.tradingDateLabel === expect, `${td} → ${lb.json && lb.json.dataBasis && lb.json.dataBasis.tradingDateLabel} (기대 ${expect})`);
}
lbOk &= check('headline 팩트 요약', Boolean(lb.json && typeof lb.json.headline === 'string' && lb.json.headline.length > 20), lb.json && lb.json.headline);
const lbCache = await call('live-briefing', '/api/live-briefing');
lbOk &= check('Cache-Control = s-maxage=15, swr=30', /s-maxage=15/.test(lbCache.headers['cache-control'] || '') && /stale-while-revalidate=30/.test(lbCache.headers['cache-control'] || ''), lbCache.headers['cache-control']);
lbOk &= check('메모리 캐시 HIT (동일 인스턴스 연속 호출)', lbCache.headers['x-cache'] === 'HIT-memory' || lbCache.ms < lb.ms, `x-cache=${lbCache.headers['x-cache']}, ${lbCache.ms}ms`);
summary.liveBriefing = {
  status: lb.status,
  ms: lb.ms,
  generatedAtKst: lb.json && lb.json.generatedAtKst,
  marketPhase: lb.json && lb.json.marketPhase,
  marketPhaseLabel: lb.json && lb.json.marketPhaseLabel,
  headline: lb.json && lb.json.headline,
  indices: (lb.json && lb.json.indices) || [],
  futures: (lb.json && lb.json.futures) || [],
  fx: lb.json && lb.json.fx,
  topMovers: (lb.json && lb.json.topMovers) || [],
  news: (lb.json && lb.json.news) || [],
  dataBasis: lb.json && lb.json.dataBasis,
  errors: (lb.json && lb.json.errors) || [],
};

/* -------------------------------- 결과 저장 -------------------------------- */
const total = results.length;
const passed = results.filter((r) => r.ok).length;
summary.total = total;
summary.passed = passed;
summary.failed = results.filter((r) => !r.ok);
summary.generatedAt = new Date().toISOString();

console.log('\n══════════════════════════════════════════════════');
console.log(` 결과: ${passed}/${total} 통과${passed === total ? ' — 전체 성공 🎉' : ''}`);
if (passed !== total) {
  console.log(' 실패 항목:');
  for (const f of summary.failed) console.log(`  - ${f.label} ${f.detail || ''}`);
}
console.log('══════════════════════════════════════════════════\n');

writeFileSync(path.join(__dirname, 'test_results.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log('상세 결과 저장 → dynamic_app/test_results.json');

process.exit(passed === total ? 0 : 1);
