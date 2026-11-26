'use strict';

/**
 * GET /api/stock-trend?codes=005930,000660
 * ---------------------------------------------------------------------------
 *  종목별 '일별 확정 수급'(외국인·기관·개인 순매수 주수)과 그날 종가를 함께 내려준다.
 *  → 2번 수급 탭 카드의 금액을 라벨과 같은 날짜의 확정치로 맞추기 위한 API.
 *
 *  소스: 네이버 증권 모바일  https://m.stock.naver.com/api/stock/{code}/trend
 *        (10영업일 · bizdate · foreignerPureBuyQuant · organPureBuyQuant · individualPureBuyQuant · closePrice)
 *
 *  금액 환산: 순매수 주수 × 그날 종가 ÷ 1억 = 억원 (화면 표기와 같은 기준)
 *
 *  · 거래소 확정치 기반이라 장중에는 당일 값이 없다(직전 거래일이 최신) — 그 사실을 basis 로 명시한다.
 *  · 캐시: public, s-maxage=600 (하루 한 번 바뀌는 값)
 */

const { NAVER_HEADERS, fetchJson, parseNum, kstLabel, sendJson, getQuery } = require('../lib/http');

const CACHE_CONTROL = 'public, s-maxage=600, stale-while-revalidate=1800';
const TIMEOUT = 7000;
const MAX_CODES = 24;
const WEEKDAY_KO = { Sun: '일', Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토' };

const pad2 = (n) => (n < 10 ? '0' : '') + n;

function qty(v) {
  const n = parseNum(v);
  return n === null ? null : n;
}

function wonToEok(won) {
  if (won === null || !Number.isFinite(won)) return null;
  return Math.round(won / 1e8);
}

function bizdateLabel(bizdate) {
  const m = String(bizdate || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return { iso: null, label: null, weekdayKo: null };
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const wd = WEEKDAY_KO[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]] || '';
  return {
    iso: `${m[1]}-${m[2]}-${m[3]}`,
    label: `${Number(m[2])}/${Number(m[3])}(${wd})`,
    weekdayKo: wd,
  };
}

async function fetchTrend(code) {
  const url = `https://m.stock.naver.com/api/stock/${code}/trend?pageSize=10&page=1`;
  const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: TIMEOUT });
  if (!Array.isArray(data) || !data.length) throw new Error('trend empty');
  const rows = data
    .filter((r) => r && r.bizdate)
    .map((r) => {
      const close = parseNum(r.closePrice);
      const fq = qty(r.foreignerPureBuyQuant);
      const oq = qty(r.organPureBuyQuant);
      const iq = qty(r.individualPureBuyQuant);
      const toAmount = (q) => (q === null || close === null ? null : wonToEok(q * close));
      return {
        bizdate: String(r.bizdate),
        ...bizdateLabel(r.bizdate),
        close,
        foreignQty: fq,
        organQty: oq,
        individualQty: iq,
        foreignAmount: toAmount(fq),
        organAmount: toAmount(oq),
        individualAmount: toAmount(iq),
        foreignHoldRatio: r.foreignerHoldRatio || null,
        volume: parseNum(r.accumulatedTradingVolume),
      };
    })
    .sort((a, b) => (a.bizdate < b.bizdate ? 1 : a.bizdate > b.bizdate ? -1 : 0)); // 최신 먼저
  return { code, rows };
}

/** 최신일부터 연속 순매수(주수 > 0) 일수 — 0·순매도가 나오면 끊는다 */
function streakOf(rows, key) {
  const list = rows || [];
  let days = 0;
  let sumEok = 0;
  let lastDate = null;
  for (const r of list) {
    const q = key === 'organ' ? r.organQty : r.foreignQty;
    if (typeof q !== 'number' || q <= 0) break;
    days += 1;
    const amt = key === 'organ' ? r.organAmount : r.foreignAmount;
    if (typeof amt === 'number') sumEok += amt;
    if (!lastDate) lastDate = r.label || r.iso || null;
  }
  return { days, sumEok: Math.round(sumEok), since: lastDate };
}

/** '1,158조 1,478억' · '8,500억' → 억원 숫자 */
function marketCapEok(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return null;
  const jo = t.match(/(-?[\d,]+(?:\.\d+)?)조/);
  const eok = t.match(/(-?[\d,]+(?:\.\d+)?)억/);
  let n = 0;
  let hit = false;
  if (jo) {
    n += parseFloat(jo[1].replace(/,/g, '')) * 10000;
    hit = true;
  }
  if (eok) {
    n += parseFloat(eok[1].replace(/,/g, ''));
    hit = true;
  }
  if (!hit) {
    const raw = parseFloat(t.replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(raw)) return null;
    n = raw;
  }
  return Math.round(n);
}

/** 종목 통합 정보 → 시가총액(억원) · 외인소진율 */
async function fetchCap(code) {
  const url = `https://m.stock.naver.com/api/stock/${code}/integration`;
  const data = await fetchJson(url, { headers: NAVER_HEADERS, timeout: TIMEOUT });
  const infos = (data && data.totalInfos) || [];
  const find = (k) => {
    const hit = infos.find((i) => i && (i.code === k || i.key === k));
    return hit ? hit.value : null;
  };
  const capText = find('marketValue') || null;
  return {
    capEok: marketCapEok(capText),
    capText,
    foreignRateText: find('foreignRate') || null,
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end();
  }

  const q = getQuery(req);
  const codes = String(q.codes || q.code || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{6}$/.test(s))
    .slice(0, MAX_CODES);

  if (!codes.length) {
    return sendJson(
      res,
      400,
      { ok: false, reason: 'missing_codes', message: '?codes=005930,000660 처럼 6자리 종목코드를 지정하세요.' },
      'no-store',
    );
  }

  const settled = await Promise.allSettled(codes.map((c) => fetchTrend(c)));
  const caps = await Promise.allSettled(codes.map((c) => fetchCap(c)));
  const stocks = [];
  const errors = [];
  const sources = [];

  settled.forEach((s, i) => {
    const code = codes[i];
    if (s.status === 'fulfilled') {
      sources.push({ name: 'naver-trend', code, ok: true });
      const rows = s.value.rows;
      const latest = rows[0] || null;
      const capR = caps[i];
      const cap = capR && capR.status === 'fulfilled' ? capR.value : { capEok: null, capText: null, foreignRateText: null };
      if (capR && capR.status !== 'fulfilled') {
        sources.push({ name: 'naver-integration', code, ok: false, error: String((capR.reason && capR.reason.message) || capR.reason) });
      }
      const fStreak = streakOf(rows, 'foreign');
      const oStreak = streakOf(rows, 'organ');
      // 시총 대비 순매수 비중(%) — 금액 착시 방지용(최신 확정일 금액 ÷ 시총)
      const ratioOf = (amountEok) =>
        typeof amountEok === 'number' && typeof cap.capEok === 'number' && cap.capEok > 0
          ? Number(((amountEok / cap.capEok) * 100).toFixed(3))
          : null;
      stocks.push({
        code,
        ok: Boolean(latest),
        latest,
        rows,
        streaks: { foreign: fStreak, organ: oStreak },
        marketCap: { eok: cap.capEok, text: cap.capText, foreignRate: cap.foreignRateText },
        ratioPct: {
          foreign: latest ? ratioOf(latest.foreignAmount) : null,
          organ: latest ? ratioOf(latest.organAmount) : null,
        },
      });
    } else {
      const msg = String((s.reason && s.reason.message) || s.reason);
      sources.push({ name: 'naver-trend', code, ok: false, error: msg });
      errors.push(`${code}: ${msg}`);
      stocks.push({ code, ok: false, latest: null, rows: [], streaks: null, marketCap: null, ratioPct: null, error: msg });
    }
  });

  // 기준일 = 성공한 종목들의 최신 bizdate 중 가장 최근
  let basisIso = null;
  let basisLabel = null;
  for (const s of stocks) {
    if (s.latest && s.latest.iso && (!basisIso || s.latest.iso > basisIso)) {
      basisIso = s.latest.iso;
      basisLabel = s.latest.label;
    }
  }

  const ok = stocks.some((s) => s.ok);
  const body = {
    ok,
    generatedAt: new Date().toISOString(),
    generatedAtKst: kstLabel(new Date()),
    basisDate: basisIso,
    basisLabel,
    basisNote:
      '거래소 확정 수급은 정규장 마감·정산 후 확정됩니다. 장중에는 직전 거래일 확정치가 최신이며, 당일 값은 확정 후 반영됩니다.',
    amountBasis: '순매수 주수 × 그날 종가 ÷ 1억 = 억원',
    streakNote: '연속 순매수 일수 = 최신 확정일부터 거슬러 세어 순매수(주수 > 0)가 이어진 날 수. 0·순매도가 나오면 끊습니다.',
    ratioNote: '시총 대비 비중(%) = 최신 확정일 순매수 금액 ÷ 시가총액 × 100 (시총은 네이버 증권 조회 시점 값)',
    stocks,
    sources,
    errors,
  };

  if (!ok) {
    return sendJson(
      res,
      200,
      { ...body, reason: 'upstream_failed', message: '수급 확정치를 받지 못했습니다.' },
      'no-store',
    );
  }

  return sendJson(res, 200, body, CACHE_CONTROL);
};

module.exports.fetchTrend = fetchTrend;

/* 🛡️ 2026-11-27: 예기치 못한 예외가 500(빈 응답)으로 나가지 않도록 핸들러를 감싼다.
 *    · 프론트는 ok:false + reason:'internal_error' 를 받고 직전 값을 유지한다.
 *    · 테스트용으로 붙인 module.exports 속성은 그대로 보존한다. */
(function () {
  const __http = require('../lib/http');
  const __h = module.exports;
  if (typeof __h === 'function' && !__h.__guarded) {
    const __wrapped = __http.safeHandler(__h, { label: 'stock-trend' });
    Object.assign(__wrapped, __h);
    __wrapped.__guarded = true;
    module.exports = __wrapped;
  }
})();
