#!/usr/bin/env node
/**
 * 로컬 실동작 테스트 (Vercel 배포 전 검증용)
 *   node test_local.mjs
 *
 * 실제 네이버 금융 / Yahoo Finance 를 때려서 각 핸들러의 응답과 JSON 파싱을 확인한다.
 * 네트워크가 없으면 해당 항목은 FAIL 로 표시되고 종료코드 1.
 */
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const handlers = {
  'stock-live': require('./api/stock-live.js'),
  'stock-chart': require('./api/stock-chart.js'),
  'deals-shopping': require('./api/deals-shopping.js'),
  'live-briefing': require('./api/live-briefing.js'),
  'tabs-live': require('./api/tabs-live.js'),
  'dart-live': require('./api/dart-live.js'),
  'index-chart': require('./api/index-chart.js'),
  'macro-live': require('./api/macro-live.js'),
  'econ-calendar': require('./api/econ-calendar.js'),
  'stock-trend': require('./api/stock-trend.js'),
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
{
  const withInteg = stocks.filter((s) => typeof s.valueInteg === 'number');
  liveOk &= check(
    '통합 대금(KRX+NXT) 필드 제공 · 통합≥정규장',
    withInteg.length > 0 && withInteg.every((s) => s.valueInteg >= (s.valueRegular || 0)),
    withInteg.slice(0, 4).map((s) => `${s.name} 통합 ${s.valueIntegText} / 정규 ${s.valueRegularText} (${s.valueBasis})`).join(' · ') || '통합 값 없음',
  );
}

/* ---- WTI 유가 · 필라델피아 반도체(SOX) — Yahoo CL=F / ^SOX ---- */
const macro = (live.json && live.json.macro) || {};
const wti = macro.WTI;
const sox = macro.SOX;
liveOk &= check('WTI 유가(CL=F) 수신', Boolean(wti && wti.price > 0), wti ? `$${nf(wti.price)} (${nf(wti.changePct)}%, ${wti.asOfKst} KST)` : '없음');
liveOk &= check('필라델피아 반도체(^SOX) 수신', Boolean(sox && sox.price > 0), sox ? `${nf(sox.price)}pt (${nf(sox.changePct)}%, ${sox.asOfKst} KST)` : '없음');
liveOk &= check(
  'WTI·SOX 모두 실시간/마감값 구분 라벨(basis·updateCycle) 보유',
  [wti, sox].every(
    (m) => m && typeof m.basis === 'string' && m.basis.length > 3 && typeof m.updateCycle === 'string' && m.updateCycle.length > 5,
  ),
  [wti, sox]
    .filter(Boolean)
    .map((m) => `${m.key}: ${m.basis} / ${m.updateCycle}`)
    .join(' | '),
);
liveOk &= check(
  'WTI·SOX 전일 종가·고저 계산 정합성',
  [wti, sox].every(
    (m) => !m || (typeof m.previousClose === 'number' && typeof m.dayHigh === 'number' && m.dayHigh >= m.dayLow),
  ),
  [wti, sox]
    .filter(Boolean)
    .map((m) => `${m.key} 전일 ${m.previousClose} · 고 ${m.dayHigh} / 저 ${m.dayLow}${m.sessionOpen === true ? ' (정규장 중)' : ' (마감값)'}`)
    .join(' | '),
);

summary.stockLive = {
  ...summary.stockLive,
  indices: idx.map((i) => `${i.name} ${nf(i.price)} (${nf(i.changePct)}%) 대금 ${i.valueText || '-'}`),
  fx: fx ? `${nf(fx.price)}원 (${nf(fx.changePct)}%, ${fx.source})` : null,
  futures: fut.map((f) => `${f.name} ${nf(f.price)} (${nf(f.changePct)}%)`),
  macro: { wti, sox },
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

/* ------------------------------ 5) tabs-live ------------------------------ */
console.log('\n▶ [8] /api/tabs-live?fresh=1 (1·3·5번 탭 실시간)');const tl = await call('tabs-live', '/api/tabs-live?fresh=1');
const tlJson = tl.json || {};
const tlThemes = tlJson.themes || [];
const tlStocks = tlThemes.reduce((acc, t) => acc.concat(t.stocks || []), []);
const tlHigh = tlJson.high52 || {};
const tlUpper = tlJson.upperLimit || {};
const tlUpperAll = [].concat(tlUpper.confirmed || [], tlUpper.near || []);
const tlNews = tlJson.news || [];

check('status 200 / ok:true', tl.status === 200 && tlJson.ok === true, `ms=${tl.ms} session=${tlJson.sessionPhase}`);
check('8대 테마 32종목 전부 시세 확보', tlThemes.length === 8 && tlStocks.length === 32 && tlStocks.every((s) => typeof s.price === 'number'), `${tlThemes.length}테마 / ${tlStocks.length}종목`);
check('32종목 시/고/저·거래대금·통합 대금', tlStocks.every((s) => typeof s.high === 'number' && typeof s.low === 'number' && Boolean(s.valueText) && Boolean(s.valueBasis)), `통합 기준 ${tlStocks.filter((s) => s.valueBasis === '통합(KRX+NXT)').length}종목`);
check('테마 평균 등락률·합산 대금', tlThemes.every((t) => typeof t.avgPct === 'number' && Boolean(t.sumValueText)), tlThemes.map((t) => `${t.rank}위 ${t.avgPct}%/${t.sumValueText}`).join(' '));
check('52주 신고가 대금순·상승률순', (tlHigh.byValue || []).length > 0 && (tlHigh.byPct || []).length > 0, (tlHigh.byValue || []).map((s) => `${s.name} ${s.valueText}`).join(' / '));
check('52주 신고가 당일 고가 확보', (tlHigh.byValue || []).length > 0 && tlHigh.byValue.every((s) => typeof s.high === 'number'), (tlHigh.byValue || []).map((s) => `${s.name} 고가 ${s.high}`).join(' / '));

/* ---- 52주 신고가 우선주 제외 ---- */
{
  const isPreferredStock = handlers['tabs-live'].isPreferredStock;
  const cases = [
    ['한진칼우', '18064K', true],
    ['삼성전자우', '005935', true],
    ['현대차2우B', '005387', true],
    ['CJ4우(전환)', '00104K', true],
    ['CJ제일제당 우', '097955', true],
    ['성우', '458650', false],
    ['이오플로우', '294090', false],
    ['파수', '150900', false],
    ['대우건설', '047040', false],
    ['한진칼', '180640', false],
  ];
  const wrong = cases.filter(([name, code, want]) => isPreferredStock({ name, code }) !== want);
  check(
    '우선주 판별 규칙(이름+코드 결합) — 보통주 오탐 없음',
    typeof isPreferredStock === 'function' && wrong.length === 0,
    wrong.length ? `오답 ${wrong.map((c) => `${c[0]}(${c[1]})`).join(',')}` : `한진칼우·삼성전자우·현대차2우B·CJ4우(전환)=제외 / 성우·이오플로우·파수·대우건설=보통주`,
  );

  const prefIn = [].concat(tlHigh.byValue || [], tlHigh.byPct || []);
  const leaked = prefIn.filter((s) => isPreferredStock(s));
  check(
    '52주 신고가 대금순·상승률순에 우선주 없음',
    leaked.length === 0,
    leaked.length ? `우선주 노출: ${leaked.map((s) => `${s.name}(${s.code})`).join(',')}` : `우선주 0건 · 제외 ${tlHigh.excludedPreferredCount || 0}건`,
  );
  const ex = tlHigh.excludedPreferred || [];
  check(
    '우선주 제외 목록이 응답에 기록됨(한진칼우 등)',
    Array.isArray(ex) && ex.every((s) => s.code && s.name && isPreferredStock(s)),
    ex.length ? ex.map((s) => `${s.name}(${s.code})`).join(', ') : '이번 응답엔 우선주 편입 0건(정상)',
  );
  {
    const upPref = [].concat(
      tlUpper.confirmed || [],
      tlUpper.near || [],
      tlUpper.watch || [],
    ).filter((s) => isPreferredStock(s));
    check('상한가·임박·관찰 목록에도 우선주 없음', upPref.length === 0,
      upPref.length ? `노출: ${upPref.map((s) => s.name).join(',')}` : `우선주 제외 ${tlUpper.excludedPreferredCount || 0}건 (금호건설우 등)`);
  }
  check(
    '52주 신고가 종목 수 = 보통주만 집계',
    typeof tlHigh.stockCount === 'number' &&
      tlHigh.stockCount === ((tlHigh.counts && tlHigh.counts.KOSPI) || 0) + ((tlHigh.counts && tlHigh.counts.KOSDAQ) || 0),
    `stockCount ${tlHigh.stockCount} = KOSPI ${tlHigh.counts && tlHigh.counts.KOSPI} + KOSDAQ ${tlHigh.counts && tlHigh.counts.KOSDAQ}`,
  );
}
check('상한가·임박은 +25% 이상 & 100억 이상', tlUpperAll.length > 0 && tlUpperAll.every((s) => s.changePct >= 25 && s.value >= 100 * 1e8), tlUpperAll.map((s) => `${s.name} ${s.changePct}% ${s.valueText}`).join(' / '));
check('100억 미만 소형주 제외 목록 분리', (tlUpper.excluded || []).length > 0 && tlUpper.excluded.every((s) => s.value < 100 * 1e8), (tlUpper.excluded || []).map((s) => `${s.name} ${s.changePct}% ${s.valueText}`).join(' / '));
check('상한가 확정 vs +25% 돌파 구분', (tlUpper.confirmed || []).every((s) => s.upperLimit === true) && (tlUpper.near || []).every((s) => s.upperLimit !== true), `확정 ${(tlUpper.confirmed || []).length} · 임박 ${(tlUpper.near || []).length}`);
check('최신 증시 뉴스 12건 + 링크', tlNews.length === 12 && tlNews.every((n) => n.title && /^https:\/\/n\.news\.naver\.com\//.test(n.url || '')), tlNews.slice(0, 3).map((n) => `${n.time} ${n.title.slice(0, 18)}`).join(' / '));
check('tabs-live 부분 실패 0건', (tlJson.errors || []).length === 0, (tlJson.errors || []).join(' · ') || 'none');

/* ---- 3번 탭: 감시군(테마32+RN11+종베10) 시간외 체결 대금·등락 순위 ---- */
const tlAfter = tlJson.aftermarket || {};
const aftValue = tlAfter.byValue || [];
const aftTop = tlAfter.byPctTop || [];
const aftBottom = tlAfter.byPctBottom || [];
{
  check('aftermarket 감시군 = 고정 41(테마32+RN존11+종베10) + NXT 랭킹 동적',
    tlAfter.universe >= 41 && tlAfter.universeGroups && tlAfter.universeGroups.테마 === 32 && tlAfter.universeGroups.RN존 === 11 && tlAfter.universeGroups.종베 === 10 &&
      (tlAfter.universe - 41) === (tlAfter.universeGroups['NXT동적'] || 0),
    `universe ${tlAfter.universe} (테마 ${tlAfter.universeGroups && tlAfter.universeGroups.테마} · RN ${tlAfter.universeGroups && tlAfter.universeGroups.RN존} · 종베 ${tlAfter.universeGroups && tlAfter.universeGroups.종베} · NXT동적 ${tlAfter.universeGroups && tlAfter.universeGroups['NXT동적']})`);
  check('시간외 체결 종목 수 = 있음 + 없음 합계',
    tlAfter.withAfterCount + tlAfter.noAfterCount + tlAfter.missingCount === tlAfter.universe && tlAfter.withAfterCount > 0,
    `체결 ${tlAfter.withAfterCount} · 미체결 ${tlAfter.noAfterCount} · 누락 ${tlAfter.missingCount}`);
  const tlNxt = tlJson.nxtLeaders || {};
  check('NXT 실시간 랭킹(nxtLeaders) — 상승률·거래대금 실측',
    typeof tlNxt.ok === 'boolean' && Array.isArray(tlNxt.byPct) && Array.isArray(tlNxt.byValue) &&
      (!tlNxt.ok || (tlNxt.byPct.length > 0 && tlNxt.byPct.every((x) => /^\d{6}$/.test(x.code) && typeof x.changePct === 'number' && typeof x.value === 'number'))),
    tlNxt.ok ? `session ${tlNxt.sessionType} · 상승 ${tlNxt.counts.byPct} · 대금 ${tlNxt.counts.byValue} · 동적 +${tlNxt.dynamicCount}종목 / ${(tlNxt.byPct || []).slice(0, 3).map((x) => x.name + ' ' + x.changePct + '%').join(', ')}` : '랭킹 실패(장외)' );
  check('프리마켓(08:00~08:50) 세션 인식',
    !['프리마켓', '장전', '정규장', '장마감', '주말휴장'].includes(tlJson.sessionPhase) ? false :
      (tlJson.sessionPhase !== '프리마켓' || (tlAfter.inSession === true && tlAfter.sessionPhase === '프리마켓')),
    `sessionPhase ${tlJson.sessionPhase} · aftermarket.inSession ${tlAfter.inSession} · phase ${tlAfter.sessionPhase}`);
  check('시간외 대금 순위 = 내림차순 · 6건 이하 · 0원 없음',
    aftValue.length > 0 && aftValue.length <= 6 &&
      aftValue.every((r, i) => typeof r.overValue === 'number' && r.overValue > 0 && /^\d{6}$/.test(r.code) && (i === 0 || aftValue[i - 1].overValue >= r.overValue)),
    aftValue.map((r) => `${r.rank}.${r.name} ${r.overValueText}`).join(' / '));
  check('시간외 등락 상위·하위 순위 (전일 종가 대비)',
    aftTop.length > 0 && aftBottom.length > 0 &&
      aftTop.every((r) => typeof r.overPct === 'number') &&
      aftTop[0].overPct >= aftTop[aftTop.length - 1].overPct &&
      aftBottom[0].overPct <= aftBottom[aftBottom.length - 1].overPct,
    `상위 ${aftTop.slice(0, 2).map((r) => `${r.name} ${r.overPct}%`).join(', ')} / 하위 ${aftBottom.map((r) => `${r.name} ${r.overPct}%`).join(', ')}`);
  check('시간외 체결가·기준 시각·세션 표기 제공',
    aftValue.every((r) => typeof r.overPrice === 'number' && Boolean(r.overTradedAt)) &&
      Boolean(tlAfter.basisLabel) && /^\d{4}-\d{2}-\d{2}$/.test(tlAfter.basisDate || '') &&
      typeof tlAfter.inSession === 'boolean' && Boolean(tlAfter.sessionLabel),
    `기준 ${tlAfter.basisLabel} · 세션 ${tlAfter.inSession ? '진행 중' : '아님'} (${tlAfter.sessionLabel})`);
  check('시간외 데이터 없는 종목을 0원으로 채우지 않음',
    aftValue.every((r) => r.overValue > 0) && (tlAfter.rules || {}).missing !== undefined,
    `미체결 ${tlAfter.noAfterCount}종목은 순위 제외 (규칙: ${(tlAfter.rules || {}).missing})`);
  check('세션 밖이면 직전 거래일 기준임을 notes 에 명시',
    tlAfter.inSession === true || (tlJson.notes || []).some((n) => /시간외 세션 아님/.test(n) && /기준 \d/.test(n)),
    (tlJson.notes || []).filter((n) => /시간외/.test(n)).join(' · '));
}
const tlCache = await call('tabs-live', '/api/tabs-live');
check('Cache-Control = s-maxage=15, swr=30', /s-maxage=15/.test(tlCache.headers['cache-control'] || '') && /stale-while-revalidate=30/.test(tlCache.headers['cache-control'] || ''), tlCache.headers['cache-control']);
summary.tabsLive = {
  status: tl.status,
  ms: tl.ms,
  sessionPhase: tlJson.sessionPhase,
  generatedAtKst: tlJson.generatedAtKst,
  themes: tlThemes.map((t) => ({ rank: t.rank, name: t.name, avgPct: t.avgPct, sumValueText: t.sumValueText })),
  high52: tlHigh,
  upperLimit: tlUpper,
  aftermarket: tlAfter,
  news: tlNews,
  errors: tlJson.errors || [],
};

/* ------------------- 6) 뉴스 영향도·테마·수혜주 키워드 매칭 ------------------- */
console.log('\n▶ [9] 속보 키워드 자동 분석 (영향도·테마·수혜주)');
const { analyzeNewsItem, NEWS_THEMES } = require('./lib/news-impact.js');
let niOk = true;
const THEME_NAMES = NEWS_THEMES.map((t) => t.name);
const LEVELS = ['상', '중', '참고'];
const DIRS = ['호재', '주의', '중립'];

niOk &= check(
  '12건 전부 5개 필드 보유',
  tlNews.length === 12 &&
    tlNews.every(
      (n) =>
        LEVELS.includes(n.impactLevel) &&
        DIRS.includes(n.impactDirection) &&
        Array.isArray(n.matchedThemes) &&
        Array.isArray(n.beneficiaryStocks) &&
        typeof n.impactNote === 'string' && n.impactNote.length > 10,
    ),
  tlNews.map((n) => `${n.impactLevel}/${n.impactDirection}`).join(' '),
);
niOk &= check(
  '테마·종목은 정의된 테마명·6자리 코드만',
  tlNews.every(
    (n) =>
      n.matchedThemes.every((t) => THEME_NAMES.includes(t)) &&
      n.beneficiaryStocks.every((s) => s && s.name && /^[0-9A-Z]{6}$/.test(s.code || '')),
  ),
  tlNews.map((n) => `${n.matchedThemes.join('+') || '-'}:${n.beneficiaryStocks.map((s) => s.name).join(',') || '-'}`).slice(0, 4).join(' | '),
);
niOk &= check(
  '테마 없는 기사 = 직접 언급 종목만 붙이거나(있으면) 참고·일반 속보(없으면) — 가짜 매칭 금지',
  tlNews.every(
    (n) =>
      n.matchedThemes.length > 0 ||
      (n.beneficiaryStocks.length === 0 && n.impactLevel === '참고' && n.impactNote.includes('일반 속보')) ||
      // 섹터 테마는 없지만 본문이 종목을 직접 지목한 경우(예: 삼성전자·SK하이닉스)는 정상
      (n.beneficiaryStocks.length > 0 && /직접 언급/.test(n.impactNote)),
  ),
  `일반 속보 ${tlNews.filter((n) => !n.matchedThemes.length && !n.beneficiaryStocks.length).length}건 / 테마 매칭 ${tlNews.filter((n) => n.matchedThemes.length).length}건 / 종목 직접언급만 ${tlNews.filter((n) => !n.matchedThemes.length && n.beneficiaryStocks.length).length}건`,
);
niOk &= check(
  '영향도 노트는 "키워드 자동 분석" 표기로 시작',
  tlNews.every((n) => n.impactNote.startsWith('키워드 자동 분석')),
  tlNews[0] && tlNews[0].impactNote,
);
niOk &= check(
  '테마가 있는 기사는 수혜·관련주 최소 1종목',
  tlNews.every((n) => n.matchedThemes.length === 0 || n.beneficiaryStocks.length > 0),
  `최대 ${Math.max(0, ...tlNews.map((n) => n.beneficiaryStocks.length))}종목`,
);

/* 규칙 단위 테스트 — 합성 문장 */
const unitCases = [
  {
    label: '수주·계약 → 시스템반도체 테마 / 호재·상',
    title: '가온칩스, 시스템반도체 수주 계약 체결',
    summary: '디자인하우스 부문 수주 확대',
    expect: (a) =>
      a.impactLevel === '상' &&
      a.impactDirection === '호재' &&
      a.matchedThemes.includes('시스템반도체 · 디자인하우스') &&
      a.beneficiaryStocks[0].name === '가온칩스',
  },
  {
    label: '유상증자·급락 → 건설 테마 / 주의·상',
    title: '금호건설 유상증자 결정에 주가 급락',
    summary: '건설주 투자심리 위축',
    expect: (a) =>
      a.impactLevel === '상' &&
      a.impactDirection === '주의' &&
      a.matchedThemes.includes('건설 중소형 · 인프라 재건') &&
      a.beneficiaryStocks.some((s) => s.name === '금호건설'),
  },
  {
    label: '로봇·자동화 → 지능형 로봇 테마',
    title: '레인보우로보틱스, 협동로봇 공급 확대',
    summary: '로봇·자동화 수주',
    expect: (a) => a.matchedThemes.includes('지능형 로봇 · AI 제조'),
  },
  {
    label: 'FDA 승인 → 바이오 테마 / 호재·상',
    title: '알테오젠 FDA 승인 획득',
    summary: '비만치료제 임상 성공',
    expect: (a) =>
      a.matchedThemes.includes('바이오 · 비만치료제') &&
      a.impactDirection === '호재' &&
      a.impactLevel === '상' &&
      a.beneficiaryStocks[0].name === '알테오젠',
  },
  {
    label: '관세 → 자동차 테마 / 주의',
    title: '美 관세 부과에 현대차·기아 타격',
    summary: '자동차 수출 우려',
    expect: (a) =>
      a.matchedThemes.includes('자동차 · 관세') &&
      a.impactDirection === '주의' &&
      ['현대차', '기아'].every((n) => a.beneficiaryStocks.some((s) => s.name === n)),
  },
  {
    label: '시스템반도체 기사에 반도체·HBM 태그 중복 방지',
    title: '시스템반도체 디자인하우스 수주',
    summary: '팹리스 ASIC 계약',
    expect: (a) =>
      a.matchedThemes.includes('시스템반도체 · 디자인하우스') &&
      !a.matchedThemes.includes('반도체 · HBM'),
  },
  {
    label: '섹터 키워드 없는 일반 기사 → 테마·종목 없음',
    title: '코스피 적정가는 6,390...그런데 상승 어렵다는 이유',
    summary: '실적 전망 하향과 수급 악화로 상승 동력을 찾기 어렵다',
    expect: (a) =>
      a.matchedThemes.length === 0 &&
      a.beneficiaryStocks.length === 0 &&
      a.impactLevel === '참고' &&
      a.impactNote.includes('일반 속보'),
  },
  {
    label: '완전 무관 기사 → 억지 매칭 없음',
    title: '오늘 서울 낮 최고 19도, 맑음',
    summary: '주말 나들이하기 좋은 날씨',
    expect: (a) => a.matchedThemes.length === 0 && a.beneficiaryStocks.length === 0,
  },
];

unitCases.forEach((c) => {
  const a = analyzeNewsItem({ title: c.title, summary: c.summary });
  niOk &= check(
    c.label,
    c.expect(a),
    `${a.impactLevel}/${a.impactDirection} ${a.matchedThemes.join('+') || '-'} [${a.beneficiaryStocks.map((s) => s.name).join(',')}]`,
  );
});
niOk &= check(
  '같은 입력은 항상 같은 결과(결정론적)',
  JSON.stringify(analyzeNewsItem({ title: '금호건설 수주 계약', summary: '건설' })) ===
    JSON.stringify(analyzeNewsItem({ title: '금호건설 수주 계약', summary: '건설' })),
);
summary.newsImpact = {
  items: tlNews.map((n) => ({
    time: n.time,
    title: n.title,
    impactLevel: n.impactLevel,
    impactDirection: n.impactDirection,
    matchedThemes: n.matchedThemes,
    beneficiaryStocks: n.beneficiaryStocks,
    impactNote: n.impactNote,
  })),
};

/* ------------- [10] public/index.html 내장 시드 정합성 (가온칩스 오기 재발방지) ------------- */
console.log('\n▶ [10] 내장 시드 데이터 정합성 (public/index.html)');
{
  const html = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  function arrayAt(marker) {
    const at = html.indexOf(marker);
    if (at < 0) return null;
    const start = html.indexOf('[', at);
    let depth = 0, inStr = false, esc = false, i = start;
    for (; i < html.length; i += 1) {
      const ch = html[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '[' || ch === '{') depth += 1;
      else if (ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) { i += 1; break; }
      }
    }
    try { return JSON.parse(html.slice(start, i)); } catch (e) { return null; }
  }

  const raw = arrayAt('const RAW_STOCKS = [');
  const jongbe = arrayAt('const STOCKS = [');
  check('RN존 내장 목록 파싱', Array.isArray(raw) && raw.length > 0, raw ? `${raw.length}종목` : '파싱 실패');
  check('종베 내장 목록 파싱', Array.isArray(jongbe) && jongbe.length > 0, jongbe ? `${jongbe.length}종목` : '파싱 실패');

  const gaon = (raw || []).find((s) => s.name === '가온칩스');
  const gaonJ = (jongbe || []).find((s) => s.name === '가온칩스');
  check('RN존 가온칩스 코드 = 399720', Boolean(gaon && gaon.code === '399720'), gaon ? gaon.code : '없음');
  check('종베 가온칩스 코드 = 399720 (동일 오기 정정)', Boolean(gaonJ && gaonJ.code === '399720'), gaonJ ? gaonJ.code : '없음');
  check('에코프로 코드(086520)가 가온칩스에 붙어있지 않음', Boolean(gaon && gaon.code !== '086520' && gaonJ && gaonJ.code !== '086520'));

  // 실측 일봉과 대조 (가온칩스 399720)
  const kc = await call('stock-chart', '/api/stock-chart?code=399720&count=60');
  const livePrice = kc.json && kc.json.current && kc.json.current.price;
  check('가온칩스 현재가 = 실측 현재가', Boolean(gaon && gaon.price === Math.round(livePrice)), gaon ? `${gaon.price}원 / 실측 ${livePrice}원` : '없음');
  check('가온칩스 캔들 = 실측 60봉 (마지막 봉 종가 일치)',
    Boolean(gaon && Array.isArray(gaon.candles) && gaon.candles.length === 60 &&
      gaon.candles[gaon.candles.length - 1].close === kc.json.candles[kc.json.candles.length - 1].c),
    gaon ? `${gaon.candles.length}봉 · ${gaon.candles[gaon.candles.length - 1].date} 종가 ${gaon.candles[gaon.candles.length - 1].close}` : '없음');
  check('가온칩스 RN·타점 = 실측 RN 기준 재계산',
    Boolean(gaon && kc.json &&
      gaon.upperRN === kc.json.rn.nearestResistance.level &&
      gaon.lowerRN === kc.json.rn.nearestSupport.level &&
      gaon.buy1 === Math.round(gaon.lowerRN * 1.04) &&
      gaon.buy2 === Math.round(gaon.buy1 * 0.8) &&
      gaon.targetMin === Math.round(gaon.buy1 * 1.07) &&
      gaon.targetMax === Math.round(gaon.buy1 * 1.2)),
    gaon ? `RN ${gaon.lowerRN}~${gaon.upperRN} · 1차 ${gaon.buy1} · 2차 ${gaon.buy2} · 목표 ${gaon.targetMin}~${gaon.targetMax}` : '없음');
  const codes = (raw || []).map((s) => s.code);
  check('RN존 내장 목록 코드 중복 없음', new Set(codes).size === codes.length, codes.join(','));
}

/* ============================================================
 *  1·2·3번 탭 잔여 실시간 고도화 (public/live-extra.js)
 *    · 신호등 6칩 자동 생성 규칙 · NXT 통합대금 재정렬 · 수급 카드 현재가 표기
 *    · index.html 정적 결선(칩 컨테이너·afKospi/afNq·data-nxt-code) · 정직 라벨
 * ============================================================ */
console.log('\n▶ [13] 1·2·3번 탭 잔여 실시간 고도화 (/public/live-extra.js)');
const le = require('./public/live-extra.js');
let leOk = true;
leOk &= check('live-extra.js 로드(순수 계산 함수 export)', Boolean(le && typeof le.buildSignalChips === 'function'), Object.keys(le || {}).length + '개 export');

/* 13-1) RN존 실측 → 신호등 칩 */
const chipStocks = [
  // 하단 RN 존 터치 후 종가 유지 (하단 안착)
  { name: '테스트하단', code: '111111', price: 92000, changeRatio: 3.2, lowerRN: 91000, upperRN: 93000, buy1: 94640, rnBand: 200, valueText: '1,200억',
    candles: [{ date: '2026-11-14', open: 90200, high: 92800, low: 90900, close: 92000, vol: 1000 }] },
  // 상단 RN 존 터치 후 눌림
  { name: '테스트상단', code: '222222', price: 58000, changeRatio: -1.1, lowerRN: 57000, upperRN: 59000, buy1: 59280, rnBand: 200, valueText: '300억',
    candles: [{ date: '2026-11-14', open: 60000, high: 58900, low: 57500, close: 58000, vol: 1000 }] },
  // 오래된 내장값(지지선·저항선이 현재가와 안 맞음) → 신호로 쓰면 안 됨
  { name: '깨진데이터', code: '333333', price: 174200, changeRatio: 1.3, lowerRN: 50000, upperRN: 75000, buy1: 52000, candles: [] },
];
const built = le.buildSignalChips(chipStocks, null, { maxChips: 6 });
const tags = built.chips.map((c) => c.tag);
leOk &= check('신호등 칩 생성 · 최대 6개', built.chips.length > 0 && built.chips.length <= 6, `${built.chips.length}칩 / 유효 ${built.validCount}종목`);
leOk &= check('하단 RN 터치·안착 칩 생성', tags.some((t) => t.includes('하단 터치·안착')), tags.join(' | '));
leOk &= check('상단 RN 터치 후 눌림 칩 생성', tags.some((t) => t.includes('상단 RN 터치 후 눌림')), tags.join(' | '));
leOk &= check('RN 지지·저항이 현재가와 안 맞는 내장값은 칩에서 제외',
  !built.chips.some((c) => c.code === '333333') && built.validCount === 2,
  `유효 ${built.validCount}종목 (깨진데이터 제외)`);
leOk &= check('칩 코드 중복 없음', new Set(built.chips.map((c) => c.code)).size === built.chips.length);

const dup = le.buildSignalChips(
  [chipStocks[0], chipStocks[0], chipStocks[0], chipStocks[1], chipStocks[1]],
  null,
  { maxChips: 6 },
);
leOk &= check('같은 종목이 여러 신호에 걸려도 칩은 1개만', dup.chips.length === 2 && new Set(dup.chips.map((c) => c.code)).size === 2, dup.chips.map((c) => c.code + ':' + c.tag).join(' / '));

const withTabs = le.buildSignalChips(
  chipStocks,
  { upperLimit: { confirmed: [{ code: '399720', name: '가온칩스', changePct: 29.92, valueText: '836억' }], near: [] },
    high52: { byValue: [{ code: '007810', name: '코리아써키트', changePct: 3.16, valueText: '2,240억' }] } },
  { maxChips: 6 },
);
leOk &= check('1번 탭 실시간 상한가·신고가가 칩으로 합류',
  withTabs.chips.some((c) => c.code === '399720' && c.tag.includes('상한가')) &&
  withTabs.chips.some((c) => c.code === '007810' && c.tag.includes('52주 신고가')),
  withTabs.chips.map((c) => `${c.name}:${c.tag}`).join(' | '));
leOk &= check('상한가 칩은 1번 탭으로 이동(overview)', withTabs.chips.find((c) => c.code === '399720').view === 'overview');
leOk &= check('칩 문구에 억지 생성 없음 — 근거 값 없는 종목은 관찰 칩으로만', withTabs.chips.every((c) => c.body && c.basis));

/* 13-2) NXT 통합대금 재정렬 */
const sorted = le.sortNxtByValue([
  { code: 'A', value: 1185000000000, order: 0 },
  { code: 'B', value: 440600000000, order: 1 },
  { code: 'C', value: null, order: 2 },
  { code: 'D', value: 76060000000, order: 3 },
  { code: 'E', value: 440600000000, order: 4 },
]);
leOk &= check('NXT 통합대금 내림차순 정렬 (동률·결측 처리)',
  JSON.stringify(sorted) === JSON.stringify(['A', 'B', 'E', 'D', 'C']), sorted.join(' > '));

/* 13-3) 수급 카드 현재가 표기 */
const up = le.formatPriceCell(208500, 0.48);
const down = le.formatPriceCell(768000, -2.78);
leOk &= check('수급 카드 표기 = "가격원 (+x.xx%)"', up.text === '208,500원 (+0.48%)' && down.text === '768,000원 (-2.78%)', `${up.text} / ${down.text}`);
leOk &= check('상승/하락 색 구분(상승=빨강, 하락=파랑)', up.color === '#f43f5e' && down.color === '#38bdf8', `${up.color} / ${down.color}`);
leOk &= check('가격 없으면 null (기존 표기 유지)', le.formatPriceCell(null, 1) === null && le.formatPriceCell(0, 1) === null);

/* 13-4) 문자열 파서 · 상태 문구 */
leOk &= check('통합대금 표기 파서(조/억/만)', le.parseValueText('6조 1,185억') > le.parseValueText('7,606억') && le.parseValueText('7,606억') > le.parseValueText('3,800억'),
  `6조1,185억=${le.parseValueText('6조 1,185억')} / 7,606억=${le.parseValueText('7,606억')}`);
leOk &= check('NXT 상태 문구는 등락률에서 자동 산출', le.nxtState(2) === '🟢 종가 지지 안착' && le.nxtState(-0.4) === '🟡 매물 소화 중' && le.nxtState(-4.5) === '🔵 약세 조정',
  `${le.nxtState(2)} / ${le.nxtState(-0.4)} / ${le.nxtState(-4.5)}`);

/* 13-5) index.html 정적 결선 */
const htmlSrc = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
leOk &= check('1번 탭 신호등 칩 컨테이너 존재', /id="signalChipsScroll"/.test(htmlSrc) && /id="signalChipsStamp"/.test(htmlSrc));
leOk &= check('live-extra.js 로드', /<script defer src="live-extra\.js"><\/script>/.test(htmlSrc));
leOk &= check('3번 요약 문장 실시간 span(afKospi·afKosdaq·afNq·afEs)',
  ['afKospi', 'afKosdaq', 'afNq', 'afEs'].every((id) => htmlSrc.includes('id="' + id + '"')));
leOk &= check('KRX 야간선물은 실시간과 분리 표기', /KRX 야간선물\(공개 실시간 API 없음/.test(htmlSrc) && /직전 확정 · 실시간 아님/.test(htmlSrc));

const nxtCodes = Array.from(htmlSrc.matchAll(/data-nxt-code="(\d{6})"/g)).map((m) => m[1]);
leOk &= check('3번 NXT 랭킹 카드 6개에 종목코드 매핑', nxtCodes.length === 6 && nxtCodes.every((c) => /^\d{6}$/.test(c)), nxtCodes.join(','));

const supplyNamesInHtml = Array.from(htmlSrc.matchAll(/class="ssc-name">([^<]+)</g)).map((m) => m[1].trim());
const supplyMapped = supplyNamesInHtml.filter((n) => le.SUPPLY_CODES[n]);
leOk &= check('2번 수급 카드 전 종목에 6자리 코드 매핑',
  supplyNamesInHtml.length >= 12 && supplyMapped.length === supplyNamesInHtml.length,
  `${supplyMapped.length}/${supplyNamesInHtml.length}종목 (${Array.from(new Set(supplyMapped)).join(',')})`);
leOk &= check('수급 코드는 전부 6자리', Object.values(le.SUPPLY_CODES).every((c) => /^\d{6}$/.test(c)), Object.entries(le.SUPPLY_CODES).map(([n, c]) => n + ':' + c).join(' '));

/* 13-6) 오해 소지 라벨 정직화 */
leOk &= check('가짜 "실시간 자동 갱신 HH:MM:SS" 배지 제거',
  !/실시간 자동 갱신: \d{2}:\d{2}:\d{2}/.test(htmlSrc) && /정기 백엔드 반영 기준/.test(htmlSrc));
leOk &= check('DART "실시간 악재 레이더" 오해 문구 제거',
  !/DART 전자공시 실시간 악재 레이더 가동 중/.test(htmlSrc) && /DART 전자공시 정기 스캔 결과/.test(htmlSrc) && /자동 실시간 아님/.test(htmlSrc));
leOk &= check('NXT 랭킹 배지의 고정 시각(05:31:08) 제거', !/KRX\+NXT 통합 실시간 파서 가동 중 \(05:31:08\)/.test(htmlSrc));

/* 13-7) 실 API — 수급 카드·NXT 6종목 코드가 한 번에 조회되는지 */
{
  const need = Array.from(new Set(le.NXT_CODES.concat(Object.values(le.SUPPLY_CODES))));
  const res = await call('stock-live', '/api/stock-live?codes=' + need.join(',') + '&fresh=1');
  const rows = (res.json && res.json.stocks) || [];
  const missing = need.filter((c) => !rows.some((s) => s.code === c && typeof s.price === 'number'));
  leOk &= check('수급·NXT 15종목 실시간 시세 일괄 수신', res.status === 200 && missing.length === 0,
    `${rows.length}종목 수신 / 누락 ${missing.join(',') || '없음'}`);
  leOk &= check('NXT 재정렬에 쓸 통합 거래대금(valueInteg) 확보',
    rows.filter((s) => typeof s.valueInteg === 'number').length >= 12,
    rows.slice(0, 4).map((s) => `${s.name} ${s.valueIntegText || s.valueText}`).join(' · '));
}

summary.liveExtra = {
  chips: built.chips.map((c) => `${c.name} ${c.tag} ${c.body}`),
  sorted,
  supplyMapped,
  nxtCodes,
};

/* ============================================================
 *  9번 달력 — 만기일 규칙 자동 계산 (public/live-calendar.js)
 *    · 옵션만기 = 매월 둘째 목요일 · 동시만기 = 3·6·9·12월 둘째 목요일
 * ============================================================ */
console.log('\n▶ [14] 9번 달력 만기일 규칙 (/public/live-calendar.js)');
const cal = require('./public/live-calendar.js');
let calOk = true;
calOk &= check('live-calendar.js 로드(순수 계산 export)', Boolean(cal && typeof cal.expiryOfMonth === 'function'), Object.keys(cal || {}).length + '개 export');
{
  // 둘째 목요일 검증 — 달력으로 확인 가능한 실제 날짜
  const cases = [
    [2026, 11, 12, false], // 2026-11-12 (목) 옵션만기
    [2026, 12, 10, true],  // 2026-12-10 (목) 선물·옵션 동시만기
    [2027, 1, 14, false],
    [2027, 3, 11, true],
    [2027, 6, 10, true],
    [2027, 9, 9, true],
    [2027, 2, 11, false],
  ];
  const wrong = cases.filter(([y, m, day, sim]) => {
    const e = cal.expiryOfMonth(y, m);
    return e.day !== day || e.simultaneous !== sim || !cal.isValidExpiry(e);
  });
  calOk &= check(
    '옵션만기=둘째 목요일 · 3·6·9·12월=동시만기 규칙 계산',
    wrong.length === 0,
    wrong.length ? `오답: ${wrong.map((c) => c.join('-')).join(', ')}` : cases.map(([y, m]) => `${y}-${m}:${cal.expiryOfMonth(y, m).day}일 ${cal.expiryOfMonth(y, m).simultaneous ? '동시만기' : '옵션만기'}`).join(' / '),
  );
  const allThursday = [];
  for (let y = 2026; y <= 2028; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      const e = cal.expiryOfMonth(y, m);
      const d = new Date(Date.UTC(y, m - 1, e.day));
      if (d.getUTCDay() !== 4) allThursday.push(`${y}-${m}`);
      if (e.simultaneous !== [3, 6, 9, 12].includes(m)) allThursday.push(`SIM:${y}-${m}`);
    }
  }
  calOk &= check('2026~2028 36개월 전수 — 전부 목요일 & 동시만기 월 일치', allThursday.length === 0, allThursday.join(',') || '36개월 이상 없음');

  const next = cal.nextExpiries('2026-11-14', 3);
  calOk &= check(
    '오늘(11/14) 이후 다가오는 만기 3건',
    next.length === 3 && next[0].date === '2026-12-10' && next[0].simultaneous === true && next[1].date === '2027-01-14' && next[2].date === '2027-02-11',
    next.map((e) => `${e.date}(${e.weekday}) ${e.kind}`).join(' → '),
  );
  calOk &= check(
    '당일 만기 포함(오늘 D-DAY) · 지난 만기는 제외',
    cal.nextExpiries('2026-11-12', 1)[0].date === '2026-11-12' && cal.nextExpiries('2026-11-13', 1)[0].date === '2026-12-10',
    `11/12 기준 → ${cal.nextExpiries('2026-11-12', 1)[0].date} / 11/13 기준 → ${cal.nextExpiries('2026-11-13', 1)[0].date}`,
  );
  const stPast = cal.expiryState('2026-11-12', '2026-11-14');
  const stToday = cal.expiryState('2026-11-14', '2026-11-14');
  const stSoon = cal.expiryState('2026-12-10', '2026-11-14');
  calOk &= check(
    '상태 문구 = 종료 / 오늘 D-DAY / D-N',
    stPast.label === '종료' && stToday.label === '오늘 D-DAY' && stSoon.label === 'D-26' && stSoon.days === 26,
    `${stPast.label} / ${stToday.label} / ${stSoon.label}`,
  );
}
{
  const htmlCal = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  calOk &= check('index.html 에 live-calendar.js 로드', /<script defer src="live-calendar\.js"><\/script>/.test(htmlCal));
  calOk &= check('달력 월 제목(연·월) 존재 — 월을 읽어 규칙 계산', /class="cal-title"[^>]*>[^<]*\d{4}년\s*\d{1,2}월/.test(htmlCal));
  calOk &= check('11월 만기 배지 = 둘째 목요일(11/12) 칸에 있음', /<span class="cal-date-num">12<\/span>\s*<span class="cal-badge opt"[^>]*>옵션만기 \(종료\)<\/span>/.test(htmlCal));
  calOk &= check(
    '"오늘" 강조가 실제 오늘(11/14) 칸에 있음',
    /<div class="cal-cell today selected" id="calCellToday"[^>]*>\s*<span class="cal-date-num"[^>]*>14<\/span>/.test(htmlCal),
  );
  calOk &= check('달력 헤더 "오늘" 문구는 11월 14일 기준', /⭐ 오늘: 11월 14일\(토\)/.test(htmlCal));
}
summary.calendar = {
  next: cal.nextExpiries(cal.kstToday().date, 3).map((e) => `${e.date} ${e.kind}`),
  today: cal.kstToday(),
};

/* ============================================================
 *  DART 실시간 공시 (/api/dart-live) — 키 없이도 정직하게 폴백
 *    · DART_API_KEY 미설정 → ok:false + reason DART_API_KEY_NOT_SET (정적 스캔 유지)
 *    · 키가 있으면 list.json 조회 · 관심종목/위험키워드 분류는 단위 테스트로 검증
 * ============================================================ */
console.log('\n▶ [15] /api/dart-live (오픈DART 공시 레이더)');
let dartOk = true;
{
  const dart = handlers['dart-live'];
  const hadKey = process.env.DART_API_KEY;
  // 키가 없는 상태(기본)에서의 응답
  const noKey = await (async () => {
    const res = makeRes();
    const prev = process.env.DART_API_KEY;
    delete process.env.DART_API_KEY;
    await dart(makeReq('/api/dart-live'), res);
    if (prev !== undefined) process.env.DART_API_KEY = prev;
    let json = null;
    try { json = JSON.parse(res._state.body); } catch (e) { json = null; }
    return { status: res._state.statusCode, headers: res._state.headers, json };
  })();
  if (!hadKey) {
    dartOk &= check('키 없음 → ok:false + reason DART_API_KEY_NOT_SET (200)',
      noKey.status === 200 && noKey.json && noKey.json.ok === false && noKey.json.reason === 'DART_API_KEY_NOT_SET' && noKey.json.keySet === false,
      noKey.json && noKey.json.message ? noKey.json.message.slice(0, 70) : '응답 없음');
    dartOk &= check('키 없음 응답은 캐시하지 않음(no-store) · 관심종목 목록은 그대로 제공',
      /no-store/.test(noKey.headers['cache-control'] || '') && (noKey.json.interestCount || 0) > 0,
      `cache-control=${noKey.headers['cache-control']} · 관심 ${noKey.json && noKey.json.interestCount}종목`);
  } else {
    check('DART_API_KEY 설정됨 — 로컬 1회 조회 결과 구조 확인', Boolean(noKey.json), noKey.json && (noKey.json.ok ? `ok:true · 공시 ${noKey.json.counts && noKey.json.counts.matched}건` : `ok:false ${noKey.json.reason}`));
  }

  // 분류 규칙 단위 테스트
  const cases = [
    ['주요사항보고서(유상증자결정)', 'risk'],
    ['주요사항보고서(전환사채권발행결정)', 'risk'],
    ['주요사항보고서(신주인수권부사채권발행결정)', 'risk'],
    ['불성실공시법인지정', 'risk'],
    ['단일판매·공급계약체결', 'watch'],
    ['주식등의대량보유상황보고서(약식)', 'watch'],
    ['주요사항보고서(자기주식취득결정)', 'watch'],
    ['분기보고서 (2026.09)', 'info'],
    ['임원ㆍ주요주주특정증권등소유상황보고서', 'info'],
  ];
  const wrongKind = cases.filter(([nm, want]) => dart.classifyReport(nm).kind !== want);
  dartOk &= check('공시명 키워드 분류(위험/주목/일반) — 오분류 없음', wrongKind.length === 0,
    wrongKind.length ? `오답: ${wrongKind.map((c) => c[0]).join(', ')}` : cases.map(([nm]) => `${nm.slice(0, 12)}→${dart.classifyReport(nm).kind}`).join(' · '));

  const sample = dart.normalizeRow({
    corp_name: '테스트전자', stock_code: '005930', report_nm: '주요사항보고서(유상증자결정)',
    rcept_no: '20261114000001', rcept_dt: '20261114', flr_nm: '테스트전자', corp_cls: 'Y',
  });
  dartOk &= check('DART 원문 필드 정규화(접수일·원문 URL·관심종목 여부)',
    sample.rceptDate === '2026-11-14' && /rcpNo=20261114000001$/.test(sample.url || '') && sample.kind === 'risk' && sample.stockCode === '005930',
    `${sample.rceptDate} · ${sample.kind} · ${sample.url}`);
  dartOk &= check('관심 종목 15종목(종베10+RN11 중복 제거) · 6자리 코드만',
    dart.INTEREST.length === 15 && dart.INTEREST_CODES.every((c) => /^\d{6}$/.test(c)),
    dart.INTEREST.map((s) => s.code).join(','));

  // 일반 공시 폭주 컷 · 위험 우선 정렬
  const picked = dart.pickItems([
    { corp_name: 'A', stock_code: '005930', report_nm: '분기보고서 (2026.09)', rcept_no: '20261114000001', rcept_dt: '20261114' },
    { corp_name: 'B', stock_code: '999999', report_nm: '분기보고서 (2026.09)', rcept_no: '20261114000002', rcept_dt: '20261114' },
    { corp_name: 'C', stock_code: '999999', report_nm: '주요사항보고서(유상증자결정)', rcept_no: '20261114000003', rcept_dt: '20261114' },
    { corp_name: 'D', stock_code: '000660', report_nm: '단일판매·공급계약체결', rcept_no: '20261114000004', rcept_dt: '20261113' },
  ]);
  dartOk &= check('관심종목 공시 + 위험·주목 키워드만 남기고 위험을 앞에 정렬',
    picked.length === 2 && picked[0].kind === 'risk' && picked[1].kind === 'watch' && !picked.some((p) => p.kind === 'info'),
    picked.map((p) => `${p.corpName}:${p.kind}${p.inInterest ? '(관심)' : ''}`).join(' → '));
  // 관심 종목이면 일반 공시도 남긴다 (예: SK하이닉스 분기보고서)
  const pickedInterestInfo = dart.pickItems([
    { corp_name: 'SK하이닉스', stock_code: '000660', report_nm: '분기보고서 (2026.09)', rcept_no: '20261114000009', rcept_dt: '20261114' },
    { corp_name: '무관회사', stock_code: '123456', report_nm: '분기보고서 (2026.09)', rcept_no: '20261114000010', rcept_dt: '20261114' },
  ]);
  dartOk &= check('관심종목 일반 공시는 유지 · 무관 종목 일반 공시는 제외',
    pickedInterestInfo.length === 1 && pickedInterestInfo[0].corpName === 'SK하이닉스',
    pickedInterestInfo.map((p) => p.corpName).join(',') || '없음');
}
summary.dartLive = {
  keySet: Boolean(process.env.DART_API_KEY),
  fallbackReason: handlers['dart-live'] ? 'DART_API_KEY_NOT_SET (키 없을 때)' : null,
  interestCount: handlers['dart-live'].INTEREST ? handlers['dart-live'].INTEREST.length : null,
};

/* ============================================================
 *  지수 실차트 · 거시 8종 · 미국 경제일정 · 종목별 확정 수급
 *    · /api/index-chart : 합성 캔들 금지 · 공개 API 없으면 정직하게 no_public_daily
 *    · /api/macro-live  : VIX·미10Y·DXY·금·구리·BTC + 국고3Y·10Y (8종)
 *    · /api/econ-calendar : 미국 High/Medium 일정 (KST 변환 · 출처 자동 대체)
 *    · /api/stock-trend : 종목별 일별 확정 수급(bizdate) + 금액 환산
 * ============================================================ */
console.log('\n▶ [16] 지수 실차트 · 거시 8종 · 미국 경제일정 · 확정 수급');
let dataOk = true;
{
  /* 16-1) 지수 일봉 실데이터 */
  const kospi = await call('index-chart', '/api/index-chart?key=kospi');
  const k = kospi.json || {};
  dataOk &= check('지수 일봉(코스피) — Yahoo ^KS11 실데이터 수신', kospi.status === 200 && k.ok === true && k.symbol === '^KS11' && (k.candles || []).length >= 200,
    `${(k.candles || []).length}봉 · ${k.range && k.range.from} ~ ${k.range && k.range.to}`);
  dataOk &= check('지수 일봉 — 마지막 캔들 종가가 상단 시세와 일치', Math.abs((k.candles || [{}]).slice(-1)[0].c - k.quote.price) < 0.02,
    `캔들 종가 ${(k.candles || [{}]).slice(-1)[0].c} / 시세 ${k.quote && k.quote.price} (${k.quote && k.quote.changePct}%)`);
  dataOk &= check('지수 단위는 pt·소수 2자리 (최고가에 "원"을 붙이던 오표기 제거)', k.unit === 'pt' && k.digits === 2 && k.quote.sessionOpen === false,
    `unit=${k.unit} digits=${k.digits} basis=${k.quote && k.quote.basis}`);
  const night = await call('index-chart', '/api/index-chart?key=kospi200_night');
  dataOk &= check('공개 일봉 API 없는 항목(KRX 야간선물) — no_public_daily + 캔들 0개',
    night.status === 200 && night.json.ok === false && night.json.reason === 'no_public_daily' && (night.json.candles || []).length === 0,
    night.json.message);
  const fx = await call('index-chart', '/api/index-chart?key=usdkrw');
  dataOk &= check('환율 일봉(원/달러) — KRW=X · 원 단위', fx.json.ok === true && fx.json.symbol === 'KRW=X' && fx.json.unit === '원',
    `${fx.json.quote && fx.json.quote.price}원`);

  /* 16-2) 거시 8종 */
  const mac = await call('macro-live', '/api/macro-live');
  const m = mac.json || {};
  const keys = (m.items || []).map((i) => i.key);
  const wantKeys = ['vix', 'us10y', 'dxy', 'gold', 'copper', 'btc', 'kr3y', 'kr10y'];
  dataOk &= check('거시 8종 — VIX·미10Y·달러인덱스·금·구리·BTC·국고3Y·국고10Y 모두 수신',
    mac.status === 200 && m.ok === true && wantKeys.every((key) => keys.indexOf(key) >= 0) && m.items.length === 8,
    (m.items || []).map((i) => `${i.name} ${i.value}${i.unit}`).join(' · '));
  dataOk &= check('거시 8종 — 값·단위·기준시각 함께 제공(가짜 값 없음)',
    (m.items || []).every((i) => i.ok !== true || (typeof i.value === 'number' && i.basis && i.digits !== undefined)),
    (m.items || []).filter((i) => i.ok).length + '/8 정상');

  /* 16-3) 미국 경제일정 */
  const ec = await call('econ-calendar', '/api/econ-calendar?fresh=1');
  const e = ec.json || {};
  dataOk &= check('미국 경제일정 — 소스 자동 확보(FF JSON → TradingView 대체)', ec.status === 200 && e.ok === true && Boolean(e.source) && e.counts.total > 0,
    `source=${e.source} (${e.sourceLabel}) · ${e.counts.total}건 (High ${e.counts.high})`);
  dataOk &= check('미국 경제일정 — KST 시각·요일 표기 + 예상/이전값', (e.items || []).length > 0 &&
    /^\d{1,2}\/\d{1,2}\((일|월|화|수|목|금|토)\) \d{2}:\d{2}$/.test(e.items[0].dateLabel) &&
    typeof e.items[0].forecast === 'string' && e.items[0].country === 'USD',
    (e.items || []).slice(0, 2).map((i) => `${i.dateLabel} ${i.title} (${i.impact})`).join(' / '));
  dataOk &= check('미국 경제일정 — "다음 일정"은 High 우선으로 선택', !e.next || e.next.impact === 'High' || e.counts.high === 0,
    e.next ? `${e.next.dateLabel} ${e.next.title} (${e.next.impact})` : '없음');

  /* 16-4) 종목별 확정 수급 */
  const tr = await call('stock-trend', '/api/stock-trend?codes=005930,000660');
  const t = tr.json || {};
  const sam = (t.stocks || []).find((x) => x.code === '005930');
  dataOk &= check('종목별 확정 수급 — 최신 bizdate 와 주수·금액 동시 제공', tr.status === 200 && t.ok === true &&
    /^\d{4}-\d{2}-\d{2}$/.test(t.basisDate) && sam && sam.latest && typeof sam.latest.foreignAmount === 'number',
    `기준일 ${t.basisDate}(${t.basisLabel}) · 삼성전자 외인 ${sam.latest.foreignQty}주/${sam.latest.foreignAmount}억`);
  dataOk &= check('확정 수급 금액 = 주수 × 종가 ÷ 1억 (환산식 일치)',
    Math.abs(sam.latest.foreignAmount - Math.round((sam.latest.foreignQty * sam.latest.close) / 1e8)) === 0,
    `${sam.latest.foreignQty} × ${sam.latest.close} = ${sam.latest.foreignAmount}억`);
  dataOk &= check('확정 수급 — 10영업일 흐름을 라벨과 함께 반환(트래커용)', (sam.rows || []).length >= 5 &&
    sam.rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.iso) && typeof r.foreignAmount === 'number'),
    (sam.rows || []).slice(0, 4).map((r) => `${r.label} ${r.foreignAmount}억`).join(' → '));
}

/* 16-5) 프론트 순수 계산 (live-extra · live-macro · live-calendar) */
{
  const le = require('./public/live-extra.js');
  dataOk &= check('억원 표기(부호·반올림) — signedEok', le.signedEok(-4566) === '-4,566억' && le.signedEok(17) === '+17억' && le.signedEok(0) === '0억',
    `${le.signedEok(-4566)} / ${le.signedEok(17)} / ${le.signedEok(0)}`);
  dataOk &= check('수급 배지 문구는 외인/기관 구분', le.trendBadgeText('foreign', { foreignAmount: 17 }) === '외인 +17억' &&
    le.trendBadgeText('organ', { organAmount: -687 }) === '기관 -687억',
    `${le.trendBadgeText('foreign', { foreignAmount: 17 })} / ${le.trendBadgeText('organ', { organAmount: -687 })}`);
  const sat = new Date('2026-11-14T03:00:00Z');   // 토요일 12:00 KST
  const mon = new Date('2026-11-16T01:00:00Z');   // 월요일 10:00 KST
  dataOk &= check('세션 문구 — 주말/정규장 자동 판정', /주말 휴장/.test(le.sessionText(sat)) && /정규장 진행 중/.test(le.sessionText(mon)),
    `${le.sessionText(sat)} / ${le.sessionText(mon)}`);
  dataOk &= check('레이더 종목 표기 = 이름 가격(등락률)', le.pmQuoteText('지니언스', { price: 34150, changePct: 8.93 }) === '지니언스 34,150원 (+8.93%)',
    le.pmQuoteText('지니언스', { price: 34150, changePct: 8.93 }));

  const lm = require('./public/live-macro.js');
  dataOk &= check('거시 값 표기 — %/달러/포인트 단위 구분',
    lm.macroValueText({ value: 5.154, digits: 3, unit: '%' }) === '5.154%' &&
    lm.macroValueText({ value: 3886.3, digits: 1, unit: '$' }) === '$3,886.3' &&
    lm.macroValueText({ value: 19.3, digits: 2, unit: 'pt' }) === '19.30 pt',
    [lm.macroValueText({ value: 5.154, digits: 3, unit: '%' }), lm.macroValueText({ value: 3886.3, digits: 1, unit: '$' })].join(' / '));
  dataOk &= check('날짜 표기 M/D(요일) 자동 계산', lm.mdLabel('2026-11-13') === '11/13(금)' && lm.mdLabel('2026-11-16') === '11/16(월)',
    `${lm.mdLabel('2026-11-13')} / ${lm.mdLabel('2026-11-16')}`);

  const cal = require('./public/live-calendar.js');
  const dec = cal.buildMonthCells(2026, 12);
  const decReal = dec.filter((c) => !c.other);
  dataOk &= check('12월 그리드 자동 생성 — 31칸 + 첫 칸 요일 계산(12/1 화)', decReal.length === 31 && decReal[0].iso === '2026-12-01' && decReal[30].iso === '2026-12-31',
    `실제 ${decReal.length}칸 · ${decReal[0].iso} ~ ${decReal[30].iso} · 전체 ${dec.length}칸`);
  dataOk &= check('그리드가 7열 배수(주 단위)로 정렬됨', dec.length % 7 === 0 && cal.firstWeekday(2026, 12) === 2,
    `${dec.length}칸 · 12/1 요일 index ${cal.firstWeekday(2026, 12)}(화=2)`);
  dataOk &= check('칸 HTML — 실제 날짜(data-cal-date) 부여', /data-cal-date="2026-12-01"/.test(cal.cellsToHtml(dec)) &&
    /class="cal-cell other-month"/.test(cal.cellsToHtml(dec)),
    '2026-12-01 셀 포함 · 앞 빈칸 other-month');
}

/* 16-6) index.html 정적 결선 — 가짜 잔재가 없어야 한다 */
{
  const html = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  dataOk &= check('합성 지수 캔들 생성기(cachedIndexSeries·Math.sin) 완전 제거',
    !/var cachedIndexSeries\s*=\s*\{/.test(html) && !/function generateCandlesForSeries/.test(html) && !/Math\.sin\(i \* 0\.(8|25)\)/.test(html));
  dataOk &= check('모달 안내: 공개 일봉 API 없음 문구 연결', /loadIndexModalLive/.test(html) && /공개 일봉 API 없음/.test(html) && /modalChartNotice/.test(html));
  dataOk &= check('1번 실시간 레이더 컨테이너 + 20초 폴링 표기', /id="premarketRadarBox"/.test(html) && /data-pm-code="263860"/.test(html) && !/30분 안심 주기로 추적/.test(html));
  dataOk &= check('1번 레이더 낡은 문구(SOX +3.42% 급등·장전 세션 진행·100% 일치) 제거',
    !/SOX \+3\.42% 급등/.test(html) && !/장전 세션 진행 \(08:30~09:00\)/.test(html) && !/확정 종가 100% 일치 동기화/.test(html));
  dataOk &= check('3번 정적 af-card 잔재 제거 → 실시간 컨테이너', /id="afStrongLive"/.test(html) && /id="afLeaderLive"/.test(html) &&
    !/주성엔지니어링 \[시간외 추가 상승\]/.test(html) && !/정규장 \+1\.48% ➔ 시간외 61,700원/.test(html));
  dataOk &= check('9번 거시 8종·경제일정 패널 결선', /id="macroLiveGrid"/.test(html) && /id="econCalList"/.test(html) && /live-macro\.js/.test(html));
  dataOk &= check('4번 탭 "지금 이 순간" 카드 결선', /id="nowMomentCard"/.test(html) && /id="nowMomentBody"/.test(html));
  dataOk &= check('"오늘(금)" 같은 고정 요일 문구 제거', !/오늘\(금\)/.test(html) && !/발표 시각: 오늘\(/.test(html));
  dataOk &= check('죽은 코드(navigateToSignalStock 내부 확률 블록) 제거',
    /function navigateToSignalStock\(tabKey, identifier\)/.test(html) &&
      !/selectStockByCode\(identifier\);\s*\n\s*\n\s*\/\/ 4\. Past History/.test(html) &&
      !/modalProbBadge[\s\S]{0,2000}selectStockByCode\(identifier\)[\s\S]{0,2000}modalProbBadge/.test(html));
  dataOk &= check('테마 헤더 중복 </span> 제거(고아 닫는 태그 0)', !/\(합산 [\d,]+억\)<\/span>(?:<\/span>){2,}/.test(html));
}
summary.marketData = { ok: dataOk };

/* -------------------------------- 결과 저장 -------------------------------- */const total = results.length;
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
