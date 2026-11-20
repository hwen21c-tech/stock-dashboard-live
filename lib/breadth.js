'use strict';

/**
 * GET /api/breadth
 * ---------------------------------------------------------------------------
 *  코스피·코스닥 '상승 / 하락 / 보합' 종목 수(시장 폭)를 그대로 내려준다.
 *  스튜디오 v2 블로그 크림 차트(상승 vs 하락 대비)가 이 값을 1클릭으로 쓴다.
 *
 *  소스: 네이버 증권 종목 랭킹 (m.stock.naver.com)
 *    · 상승: /api/stocks/up/{KOSPI,KOSDAQ}   → totalCount
 *    · 하락: /api/stocks/down/{KOSPI,KOSDAQ} → totalCount
 *    · 전체 종목 수: /api/stocks/marketValue/{market}?page=1&pageSize=1 → totalCount
 *      (보합 = 전체 − 상승 − 하락 · 거래정지·거래없음이 섞일 수 있어 그대로 '보합'으로 표기한다)
 *
 *  · 관제탑의 '시장 폭(상승 비율)' 과 같은 소스·같은 계산이다(scripts/auto_update_all_tabs.py).
 *  · 값이 없으면 0으로 채우지 않고 null 로 둔다 — 화면에서 '—' 로 남긴다.
 *
 *  응답
 *   { ok, generatedAt, generatedAtKst, source, markets: {
 *       KOSPI:{up,down,total,flat,riseRatio}, KOSDAQ:{...},
 *       ALL:{up,down,total,flat,riseRatio} }, errors:[] }
 */

const { NAVER_HEADERS, fetchJson, parseNum, kstLabel, sendJson } = require('../lib/http');

const CACHE_CONTROL = 'public, s-maxage=120, stale-while-revalidate=600';
const TIMEOUT = 7000;
const MARKETS = ['KOSPI', 'KOSDAQ'];

async function countOf(kind, market) {
  const url = `https://m.stock.naver.com/api/stocks/${kind}/${market}?page=1&pageSize=1`;
  const d = await fetchJson(url, { headers: NAVER_HEADERS, timeout: TIMEOUT });
  const n = parseNum(d && d.totalCount);
  return Number.isFinite(n) ? n : null;
}

async function totalOf(market) {
  const url = `https://m.stock.naver.com/api/stocks/marketValue/${market}?page=1&pageSize=1`;
  const d = await fetchJson(url, { headers: NAVER_HEADERS, timeout: TIMEOUT });
  const n = parseNum(d && d.totalCount);
  return Number.isFinite(n) ? n : null;
}

function withRatio(m) {
  const up = m.up;
  const down = m.down;
  const base = (Number.isFinite(up) ? up : 0) + (Number.isFinite(down) ? down : 0);
  const flat = Number.isFinite(m.total) && Number.isFinite(up) && Number.isFinite(down)
    ? Math.max(0, m.total - up - down)
    : null;
  return {
    up: Number.isFinite(up) ? up : null,
    down: Number.isFinite(down) ? down : null,
    total: Number.isFinite(m.total) ? m.total : null,
    flat,
    riseRatio: base > 0 ? Math.round((up / base) * 1000) / 10 : null,
  };
}

module.exports = async function handler(req, res) {
  const errors = [];
  const markets = {};

  const rows = await Promise.all(
    MARKETS.map(async (market) => {
      const [up, down, total] = await Promise.all([
        countOf('up', market).catch((e) => {
          errors.push(`${market} 상승: ${(e && e.message) || 'error'}`);
          return null;
        }),
        countOf('down', market).catch((e) => {
          errors.push(`${market} 하락: ${(e && e.message) || 'error'}`);
          return null;
        }),
        totalOf(market).catch(() => null),
      ]);
      return [market, { up, down, total }];
    })
  );
  rows.forEach(([market, v]) => {
    markets[market] = withRatio(v);
  });

  const sum = (k) => {
    const vals = MARKETS.map((m) => markets[m][k]).filter((v) => Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  markets.ALL = withRatio({ up: sum('up'), down: sum('down'), total: sum('total') });

  const ok = Number.isFinite(markets.ALL.up) && Number.isFinite(markets.ALL.down);
  const now = Date.now();

  return sendJson(
    res,
    ok ? 200 : 502,
    {
      ok,
      generatedAt: new Date(now).toISOString(),
      generatedAtKst: kstLabel(now),
      source: '네이버 종목 랭킹 상승·하락 종목 수 (거래소 전체 종목)',
      markets,
      basis:
        '상승·하락은 네이버 종목 랭킹 totalCount, 보합은 전체 종목 수 − 상승 − 하락입니다(거래정지·거래없음 포함 가능).',
      errors,
    },
    CACHE_CONTROL
  );
};
