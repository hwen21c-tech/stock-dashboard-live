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
  '매칭 없는 기사는 빈 배열 + 참고 + 일반 속보 (가짜 매칭 금지)',
  tlNews.every(
    (n) =>
      n.matchedThemes.length > 0 ||
      (n.beneficiaryStocks.length === 0 && n.impactLevel === '참고' && n.impactNote.includes('일반 속보')),
  ),
  `일반 속보 ${tlNews.filter((n) => !n.matchedThemes.length).length}건 / 테마 매칭 ${tlNews.filter((n) => n.matchedThemes.length).length}건`,
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
