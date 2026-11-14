'use strict';

/**
 * GET /api/econ-calendar
 * ---------------------------------------------------------------------------
 *  미국(USD) 주요 경제 일정 자동 연동 — 전부 무료·공개 소스(키 불필요)
 *
 *   1순위) ForexFactory 주간 JSON   https://nfs.faireconomy.media/ff_calendar_thisweek.json (+ nextweek)
 *          ※ 짧은 간격 반복 호출에 429 를 주는 일이 있다 → 실패하면 아래로 자동 대체
 *   2순위) TradingView 경제 캘린더  https://economic-calendar.tradingview.com/events?countries=US
 *          (발표치 actual 까지 제공 · 다음 주 일정도 포함)
 *   3순위) ForexFactory 주간 XML   ff_calendar_thisweek.xml
 *
 *  응답
 *   { ok, source, generatedAtKst, todayKst, todayLabel, items:[{title,country,impact,dateKst,timeKst,
 *     dateLabel,forecast,previous,actual,isPast,eventAt}], todayItems, next, counts, sources, errors, note }
 *
 *  · 시각은 전부 KST 로 변환한다. · 예상치/이전값/발표치는 원본 표기 그대로 둔다.
 *  · 캐시: public, s-maxage=1800 + 인스턴스 메모리 20분(실패 시 마지막 성공본 유지)
 */

const { fetchJson, fetchBuffer, kstLabel, sendJson, getQuery } = require('../lib/http');

const CACHE_CONTROL = 'public, s-maxage=1800, stale-while-revalidate=3600';
const TIMEOUT = 9000;
const WEEKDAY_KO = { Sun: '일', Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토' };
const IMPACT_RANK = { High: 3, Medium: 2, Low: 1, Holiday: 0 };

// 이번 주 JSON 만 쓴다(nextweek 경로는 404 를 돌려주는 경우가 있다).
// 다음 주 일정은 TradingView 보강 단계에서 채운다.
const FF_JSON = [
  { name: 'thisweek', url: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json' },
];
const FF_XML = [
  { name: 'thisweek-xml', url: 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml' },
  { name: 'nextweek-xml', url: 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml' },
];
const TV_URL = 'https://economic-calendar.tradingview.com/events';

const memCache = { at: 0, body: null };
const MEM_TTL_MS = 20 * 60 * 1000;

const pad2 = (n) => (n < 10 ? '0' : '') + n;

function kstParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date);
  const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return {
    y: g('year'),
    m: Number(g('month')),
    d: Number(g('day')),
    hh: Number(g('hour')) % 24,
    mm: Number(g('minute')),
    wd: g('weekday'),
  };
}

function kstStamp(date) {
  const p = kstParts(date);
  return {
    date: `${p.y}-${pad2(p.m)}-${pad2(p.d)}`,
    time: `${pad2(p.hh)}:${pad2(p.mm)}`,
    label: `${p.m}/${p.d}(${WEEKDAY_KO[p.wd] || ''}) ${pad2(p.hh)}:${pad2(p.mm)}`,
    weekdayKo: WEEKDAY_KO[p.wd] || '',
  };
}

function makeItem(title, country, impact, at, forecast, previous, actual, source, nowMs) {
  if (!title || !at || Number.isNaN(at.getTime())) return null;
  const stamp = kstStamp(at);
  return {
    title: String(title),
    country: String(country || '').toUpperCase(),
    impact,
    impactRank: IMPACT_RANK[impact] === undefined ? 1 : IMPACT_RANK[impact],
    eventAt: at.toISOString(),
    dateKst: stamp.date,
    timeKst: stamp.time,
    dateLabel: stamp.label,
    forecast: forecast === null || forecast === undefined ? '' : String(forecast),
    previous: previous === null || previous === undefined ? '' : String(previous),
    actual: actual === null || actual === undefined ? '' : String(actual),
    isPast: at.getTime() < nowMs,
    source,
  };
}

/* ------------------------- 1) ForexFactory (JSON/XML) ------------------------- */

async function fetchFFJson() {
  const out = [];
  const sources = [];
  const errors = [];
  for (const feed of FF_JSON) {
    try {
      const raw = await fetchJson(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        timeout: TIMEOUT,
      });
      if (!Array.isArray(raw)) throw new Error('not an array');
      sources.push({ name: `forexfactory-${feed.name}`, ok: true, count: raw.length });
      out.push({ raw, name: feed.name });
    } catch (e) {
      const msg = String((e && e.message) || e);
      sources.push({ name: `forexfactory-${feed.name}`, ok: false, error: msg });
      errors.push(`${feed.name}: ${msg}`);
    }
  }
  return { feeds: out, sources, errors };
}

function parseFF(raw, nowMs) {
  const items = [];
  for (const ev of raw) {
    if (!ev || !ev.date || !ev.title) continue;
    const at = new Date(ev.date);
    const item = makeItem(ev.title, ev.country, String(ev.impact || 'Low'), at, ev.forecast, ev.previous, '', 'forexfactory', nowMs);
    if (item) items.push(item);
  }
  return items;
}

function xmlUnescape(v) {
  return String(v || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

async function fetchFFXml() {
  const items = [];
  const sources = [];
  const errors = [];
  for (const feed of FF_XML) {
    try {
      const buf = await fetchBuffer(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: TIMEOUT });
      const xml = buf.toString('utf8');
      const blocks = xml.split('<event>').slice(1);
      let count = 0;
      for (const block of blocks) {
        const body = block.split('</event>')[0];
        const pick = (t) => {
          const m = body.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`));
          return m ? xmlUnescape(m[1]).trim() : '';
        };
        const dateRaw = pick('date');
        const m = dateRaw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
        if (!m) continue;
        // ForexFactory XML 의 date 는 미국 동부 시각
        const iso = `${m[3]}-${pad2(Number(m[4] || m[1]))}-${pad2(Number(m[2]))}T${pick('time') || '00:00'}:00-05:00`;
        const at = new Date(iso);
        const item = makeItem(pick('title'), pick('country'), pick('impact') || 'Low', at, pick('forecast'), pick('previous'), '', 'forexfactory-xml', Date.now());
        if (item) {
          items.push(item);
          count += 1;
        }
      }
      sources.push({ name: `forexfactory-${feed.name}`, ok: true, count });
    } catch (e) {
      const msg = String((e && e.message) || e);
      sources.push({ name: `forexfactory-${feed.name}`, ok: false, error: msg });
      errors.push(`${feed.name}: ${msg}`);
    }
  }
  return { items, sources, errors };
}

/* --------------------------- 2) TradingView 캘린더 --------------------------- */

function tvText(v, unit) {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  const txt = Math.abs(n) >= 1000 ? n.toLocaleString('en-US') : String(n);
  return unit ? `${txt}${unit === '%' ? '%' : ' ' + unit}` : txt;
}

async function fetchTradingView() {
  const now = new Date();
  const from = new Date(now.getTime() - 7 * 86400000).toISOString();
  const to = new Date(now.getTime() + 14 * 86400000).toISOString();
  const url = `${TV_URL}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&countries=US`;
  const data = await fetchJson(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
      Origin: 'https://www.tradingview.com',
      Referer: 'https://www.tradingview.com/',
    },
    timeout: TIMEOUT,
  });
  const rows = (data && data.result) || [];
  const nowMs = Date.now();
  const items = [];
  for (const ev of rows) {
    if (!ev || !ev.date || !ev.title) continue;
    const at = new Date(ev.date);
    const impact = ev.importance >= 1 ? 'High' : ev.importance === 0 ? 'Medium' : 'Low';
    // TradingView 는 국가를 'US' 로 준다 → 내부 표기 'USD' 로 맞춘다
    const country = String(ev.country || 'US').toUpperCase();
    const item = makeItem(
      ev.title,
      country === 'US' ? 'USD' : country,
      impact,
      at,
      tvText(ev.forecast, ev.unit),
      tvText(ev.previous, ev.unit),
      tvText(ev.actual, ev.unit),
      'tradingview',
      nowMs,
    );
    if (item) items.push(item);
  }
  return { items, raw: rows.length };
}

/* ------------------------------ 정리 · 응답 ------------------------------ */

function dedupe(items) {
  const out = [];
  const seen = new Set();
  for (const ev of items) {
    const k = `${ev.country}|${ev.title}|${ev.eventAt}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ev);
  }
  out.sort((a, b) => (a.eventAt < b.eventAt ? -1 : a.eventAt > b.eventAt ? 1 : 0));
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end();
  }

  const q = getQuery(req);
  const impactFilter = String(q.impact || 'high_medium').toLowerCase(); // high | high_medium | all
  const countryFilter = String(q.country || 'USD').toUpperCase();
  const fresh = q.fresh === '1';

  if (!fresh && memCache.body && Date.now() - memCache.at < MEM_TTL_MS) {
    res.setHeader('X-Cache', 'HIT-memory');
    return sendJson(res, 200, memCache.body, CACHE_CONTROL);
  }

  const now = new Date();
  const nowMs = now.getTime();
  const today = kstStamp(now);

  const sources = [];
  const errors = [];
  let raw = [];
  let source = null;

  // 1순위: ForexFactory JSON
  const ff = await fetchFFJson();
  sources.push(...ff.sources);
  errors.push(...ff.errors);
  let ffItems = [];
  ff.feeds.forEach((f) => {
    ffItems = ffItems.concat(parseFF(f.raw, nowMs));
  });
  if (ffItems.filter((i) => i.country === 'USD').length) {
    raw = ffItems;
    source = 'forexfactory-json';
    // 이번 주 피드에 '앞으로의 일정'이 없으면 TradingView 로 다음 주 일정을 보강한다
    if (!ffItems.some((i) => i.country === 'USD' && !i.isPast)) {
      try {
        const tv = await fetchTradingView();
        sources.push({ name: 'tradingview', ok: true, count: tv.raw, role: 'next-week-fill' });
        raw = ffItems.concat(tv.items);
      } catch (e) {
        const msg = String((e && e.message) || e);
        sources.push({ name: 'tradingview', ok: false, error: msg });
        errors.push(`tradingview: ${msg}`);
      }
    }
  }

  // 2순위: TradingView (FF 가 429 등으로 비었을 때)
  if (!source) {
    try {
      const tv = await fetchTradingView();
      sources.push({ name: 'tradingview', ok: true, count: tv.raw });
      if (tv.items.length) {
        raw = tv.items;
        source = 'tradingview';
      }
    } catch (e) {
      const msg = String((e && e.message) || e);
      sources.push({ name: 'tradingview', ok: false, error: msg });
      errors.push(`tradingview: ${msg}`);
    }
  }

  // 3순위: ForexFactory XML
  if (!source) {
    const xml = await fetchFFXml();
    sources.push(...xml.sources);
    errors.push(...xml.errors);
    if (xml.items.filter((i) => i.country === 'USD').length) {
      raw = xml.items;
      source = 'forexfactory-xml';
    }
  }

  const uniq = dedupe(raw);
  let items = uniq.filter((ev) => ev.country === countryFilter);
  if (impactFilter === 'high') items = items.filter((ev) => ev.impact === 'High');
  else if (impactFilter !== 'all') items = items.filter((ev) => ev.impact === 'High' || ev.impact === 'Medium');

  const todayItems = items.filter((ev) => ev.dateKst === today.date);
  const upcoming = items.filter((ev) => !ev.isPast);
  // '다음 일정'은 중요도(High 우선) → 시각 순으로 고른다 (국채 입찰 같은 Medium 잡음 배제)
  const next =
    upcoming.find((ev) => ev.impact === 'High') ||
    upcoming[0] ||
    null;
  const nextHigh = upcoming.find((ev) => ev.impact === 'High') || null;
  const ok = uniq.length > 0;

  const okSources = sources.filter((x) => x.ok && !/xml$/.test(x.name));
  const usedTv = sources.some((x) => x.name === 'tradingview' && x.ok);
  const usedFf = sources.some((x) => /forexfactory/.test(x.name) && x.ok && x.count > 0);
  const sourceLabel = usedFf && usedTv ? 'ForexFactory + TradingView'
    : usedTv ? 'TradingView 캘린더'
    : usedFf ? 'ForexFactory 캘린더'
    : '없음(원본 응답 실패)';

  const body = {
    ok,
    source,
    sourceLabel,
    okSourceCount: okSources.length,
    generatedAt: now.toISOString(),
    generatedAtKst: kstLabel(now),
    todayKst: today.date,
    todayLabel: today.label,
    todayWeekdayKo: today.weekdayKo,
    country: countryFilter,
    impactFilter,
    // 화면용 목록: 오늘 · 다가오는 일정(중요도 우선) · 최근 지난 일정 5건
    items: (function () {
      const pastRecent = items.filter((ev) => ev.isPast).slice(-5);
      const up = upcoming
        .slice()
        .sort((a, b) => {
          const d = (b.impactRank || 0) - (a.impactRank || 0);
          if (d !== 0) return d;
          return a.eventAt < b.eventAt ? -1 : 1;
        })
        .slice(0, 40);
      const merged = []
        .concat(todayItems, up, pastRecent)
        .filter((ev, i, arr) => arr.findIndex((x) => x.eventAt === ev.eventAt && x.title === ev.title) === i);
      merged.sort((a, b) => (a.eventAt < b.eventAt ? -1 : a.eventAt > b.eventAt ? 1 : 0));
      return merged;
    })(),
    todayItems,
    next,
    nextHigh,
    upcoming: upcoming.slice(0, 12),
    counts: {
      totalAll: uniq.length,
      total: items.length,
      high: items.filter((ev) => ev.impact === 'High').length,
      medium: items.filter((ev) => ev.impact === 'Medium').length,
      today: todayItems.length,
      upcoming: items.filter((ev) => !ev.isPast).length,
    },
    sources,
    errors,
    note:
      source === 'tradingview'
        ? 'TradingView 경제 캘린더(무료)로 미국 High/Medium 일정을 KST 로 변환 — ForexFactory JSON 이 429 등으로 응답하지 않아 자동 대체했습니다. 발표치·예상치·이전값은 원본 표기 그대로입니다.'
        : 'ForexFactory 주간 캘린더(무료 공개 JSON·XML)를 KST 로 변환한 값입니다. 발표 예상치·이전값은 원본 표기 그대로입니다.',
  };

  if (!ok) {
    if (memCache.body) {
      res.setHeader('X-Cache', 'STALE-memory');
      return sendJson(
        res,
        200,
        {
          ...memCache.body,
          stale: true,
          errors: (memCache.body.errors || []).concat(errors),
          note: (memCache.body.note || '') + ' · 최신 조회 실패로 직전 성공본을 표시합니다.',
        },
        CACHE_CONTROL,
      );
    }
    return sendJson(
      res,
      200,
      { ...body, reason: 'upstream_failed', message: '경제 일정 피드를 받지 못했습니다(원본 429/네트워크).' },
      'no-store',
    );
  }

  memCache.at = Date.now();
  memCache.body = body;
  res.setHeader('X-Cache', 'MISS');
  return sendJson(res, 200, body, CACHE_CONTROL);
};

module.exports.kstStamp = kstStamp;
module.exports.parseFF = parseFF;
module.exports.tvText = tvText;
