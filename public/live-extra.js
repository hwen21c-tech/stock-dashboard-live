/* ============================================================================
 * ⚡ 1·2·3번 탭 잔여 실시간 고도화  (/api/stock-live · RN존 실측 데이터 재사용)
 * ----------------------------------------------------------------------------
 *  1) 1번 탭 상단 '실전 타점 신호등' 6칩을 RN존 60일봉 실측값으로 자동 생성
 *       - 하드코딩 문구/가격을 지우고, RN 지지·저항 존 터치 / 1차 타점 근접 /
 *         상한가·52주 신고가 대금주 / 통합대금 상위를 실측 기준으로 다시 만든다.
 *       - 칩은 6개까지만 만들고, 근거가 없는 칩은 억지로 만들지 않는다.
 *  2) 3번 애프터마켓 NXT 랭킹 Top 6 — 현재가·등락률·통합대금 실시간 + 통합대금순 재정렬
 *  3) 3번 탭 상단 요약 문장 — 코스피·코스닥·NQ=F·ES=F 만 실시간
 *       (KRX 야간선물·주간선물은 공개 실시간 API 가 없으므로 '직전 확정'으로 분리 표기)
 *  4) 2번 수급 탭 종목 카드 — 현재가·등락률 + 일별 '확정' 수급(/api/stock-trend)
 *       (외인·기관 순매수 금액은 거래소 확정치이며, 라벨의 날짜와 같은 bizdate 값으로만 채운다)
 *  5) 1번 탭 실시간 시세 레이더 — 테마·시초가 관심주·검색 상위 가격 실시간 + 세션 문구 계산
 *  6) 3번 탭 강세주 카드 — 정적 가격 카드 대신 현재가·등락률·통합대금 실시간 카드로 렌더
 *
 *  · API 가 실패하면 아무것도 지우지 않고 내장(정적) 값을 그대로 유지한다.
 *  · 이 파일은 브라우저(main)와 Node 테스트(test_local.mjs)에서 같이 쓸 수 있도록
 *    순수 계산 함수와 DOM 반영 함수를 분리해 export 한다.
 * ==========================================================================*/
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  var HAS_DOM = typeof document !== 'undefined';

  var LIVE_URL = '/api/stock-live';
  var POLL_MS = 20000;      // 지수·수급카드·NXT 랭킹 폴링 주기
  var CHIP_MS = 15000;      // 신호등 칩 재계산 주기(로컬 계산만, 네트워크 없음)

  /* ------------------------------ 종목 코드표 ------------------------------ */

  // 2번 수급 탭 카드 종목명 → 6자리 코드
  var SUPPLY_CODES = {
    '삼성전자': '005930',
    'SK스퀘어': '402340',
    'JYP Ent.': '035900',
    '티엘비': '356860',
    'SK하이닉스': '000660',
    '알테오젠': '196170',
    '지니언스': '263860',
    '주성엔지니어링': '036930',
    '심텍': '222800',
    '에코프로비엠': '247540',
    'KB금융': '105560',
    '신한지주': '055550'
  };

  // 3번 애프터마켓 NXT 랭킹 Top 6 카드 (HTML 순서 = 초기 순위)
  var NXT_CODES = ['000660', '005930', '009150', '402340', '035420', '006400'];

  var NXT_NAMES = {
    '000660': 'SK하이닉스',
    '005930': '삼성전자',
    '009150': '삼성전기',
    '402340': 'SK스퀘어',
    '035420': 'NAVER',
    '006400': '삼성SDI'
  };

  // 3번 탭 강세주 카드 (정적 카드 → 실시간 카드로 대체). note 는 수치 없는 테마 설명만.
  var AF_CARDS = {
    strong: [
      { code: '002990', name: '금호건설', tag: '건설·인프라', note: '대형 공공 인프라 수주 공시 모멘텀. 상한가 잔량은 실시간 등락률로 확인.' },
      { code: '399720', name: '가온칩스', tag: '시스템반도체', note: '2나노 AI 디자인하우스 수주 부각. 상한가 여부는 실시간 등락률 기준.' },
      { code: '241520', name: 'DSC인베스트먼트', tag: '창투사', note: 'AI 벤처 투자 회수 사이클 기대. 상한가 여부는 실시간 등락률 기준.' }
    ],
    leader: [
      { code: '263860', name: '지니언스', tag: 'AI 보안', note: 'EDR·제로트러스트 수요 부각. 대금과 등락률은 실시간 통합대금 기준.' },
      { code: '007810', name: '코리아써키트', tag: 'CXL/PCB', note: 'CXL 기판·FC-BGA 모멘텀. 대금과 등락률은 실시간 통합대금 기준.' },
      { code: '036930', name: '주성엔지니어링', tag: '반도체 장비', note: 'ALD 증착 장비 수주 모멘텀. 대금과 등락률은 실시간 통합대금 기준.' }
    ]
  };

  var TREND_URL = '/api/stock-trend';
  var TREND_MS = 30 * 60 * 1000;   // 확정 수급은 하루 한 번 바뀐다 → 30분이면 충분

  /* -------------------------------- 유틸 -------------------------------- */

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }
  function fmtInt(n) {
    return num(n) === null ? '—' : Math.round(n).toLocaleString('ko-KR');
  }
  function fmtPct(p) {
    if (num(p) === null) return '—';
    var v = Number(p).toFixed(2);
    return (p > 0 ? '+' : '') + v + '%';
  }
  function fmtDecimal(n) {
    return num(n) === null ? '—' : Number(n).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function colorOf(p) {
    if (num(p) === null || p === 0) return '#94a3b8';
    return p > 0 ? '#f43f5e' : '#38bdf8';
  }
  function clsOf(p) {
    if (num(p) === null || p === 0) return '';
    return p > 0 ? 'up' : 'down';
  }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function nowHms() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  /* 서버가 준 조회 시각(ISO) → 화면 표기용 HH:MM:SS (없으면 로컬 시각) */
  function stampOf(iso) {
    if (!iso) return nowHms();
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return nowHms();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* 2번 탭 카드용 현재가·등락률 문자열 (외인·기관 금액은 건드리지 않는다) */
  function formatPriceCell(price, pct) {
    if (num(price) === null || price <= 0) return null;
    return {
      text: fmtInt(price) + '원 (' + fmtPct(pct) + ')',
      cls: clsOf(pct),
      color: colorOf(pct)
    };
  }

  /* --------------------- RN존 실측 → 신호등 칩 (순수 계산) --------------------- */

  // api/stock-chart.js 의 rnStep 과 동일 규칙 (RN존 폭 = step × 0.2)
  function rnStep(price) {
    var p = Math.abs(price);
    if (p < 1000) return 10;
    if (p < 5000) return 50;
    if (p < 10000) return 100;
    if (p < 50000) return 500;
    if (p < 100000) return 1000;
    if (p < 500000) return 5000;
    return 10000;
  }
  function rnBandOf(price, band) {
    if (num(band) !== null && band > 0) return band;
    return rnStep(price) * 0.2;
  }

  /**
   * RN존 목록 1건 → 신호등 계산용 정규화.
   *  · 내장 데이터와 /api/stock-chart 실측값이 섞여 있어도 계산 가능한 형태만 통과시킨다.
   *  · 지지선 < 현재가 < 저항선 관계가 깨진 항목(오래된 내장값)은 신호로 쓰지 않는다.
   */
  function normalizeRnStock(s) {
    if (!s || !s.code) return null;
    var price = num(s.price);
    if (price === null || price <= 0) return null;
    var lower = num(s.lowerRN);
    var upper = num(s.upperRN);
    if (lower === null || upper === null) return null;
    if (!(lower > 0) || !(upper > lower)) return null;
    // RN 지지선은 현재가 아래, 저항선은 현재가 위여야 한다
    if (lower > price * 1.02) return null;
    if (upper < price * 0.98) return null;

    var candles = Array.isArray(s.candles) ? s.candles : [];
    var last = candles.length ? candles[candles.length - 1] : null;
    var band = rnBandOf(price, s.rnBand);
    var buy1 = num(s.buy1) !== null ? s.buy1 : Math.round(lower * 1.04);

    return {
      code: String(s.code),
      name: s.name || s.code,
      price: price,
      changePct: num(s.changeRatio),
      lower: lower,
      upper: upper,
      buy1: buy1,
      band: band,
      last: last,
      valueText: s.valueText || null,
      touchedLower: Boolean(last && num(last.low) !== null && last.low <= lower + band && price >= lower - band),
      brokeLower: price < lower - band,
      touchedUpper: Boolean(last && num(last.high) !== null && last.high >= upper - band && price < upper),
      nearBuy1: buy1 > 0 && Math.abs(price - buy1) / buy1 <= 0.03,
      upperGapPct: Number((((upper - price) / price) * 100).toFixed(2)),
      lowerGapPct: Number((((price - lower) / price) * 100).toFixed(2))
    };
  }

  function pctPhrase(p) {
    return num(p) === null ? '' : ' (' + fmtPct(p) + ')';
  }

  /**
   * 1번 탭 신호등 칩 생성.
   *  @param rnStocks  window.RnZone.getStocks() 결과 (내장 or 실측 갱신본)
   *  @param tabsBody  /api/tabs-live 응답 (없으면 상한가·신고가 칩은 생략)
   *  @param opts      { maxChips }
   *  @returns { chips: [...], basis, validCount }
   */
  function buildSignalChips(rnStocks, tabsBody, opts) {
    opts = opts || {};
    var max = opts.maxChips || 6;
    var list = [];
    (rnStocks || []).forEach(function (s) {
      var n = normalizeRnStock(s);
      if (n) list.push(n);
    });

    var used = {};
    var chips = [];

    function add(chip) {
      if (!chip || !chip.code || used[chip.code]) return false;
      if (chips.length >= max) return false;
      used[chip.code] = true;
      chips.push(chip);
      return true;
    }

    // ① 하단 RN 존 터치 후 지지 — 현재가가 존 안(하단RN +3% 이내)이면 '안착', 위로 벗어났으면 '반등'
    var lowerTouches = list.filter(function (n) { return n.touchedLower && !n.brokeLower; });
    lowerTouches.sort(function (a, b) {
      var ah = a.price <= a.lower * 1.03 ? 1 : 0;
      var bh = b.price <= b.lower * 1.03 ? 1 : 0;
      if (bh !== ah) return bh - ah;
      var av = Math.abs(num(a.changePct) === null ? 0 : a.changePct);
      var bv = Math.abs(num(b.changePct) === null ? 0 : b.changePct);
      return bv - av;
    });
    lowerTouches.slice(0, 3).forEach(function (n) {
      var held = n.price <= n.lower * 1.03;
      add({
        code: n.code, name: n.name, color: 'green', view: 'rnzone',
        tag: held ? '[RN존 하단 터치·안착]' : '[RN존 하단 터치 후 반등]',
        body: held
          ? '하단RN ' + fmtInt(n.lower) + '원 존 터치 후 ' + fmtInt(n.price) + '원' + pctPhrase(n.changePct)
          : '하단RN ' + fmtInt(n.lower) + '원 터치 → ' + fmtInt(n.price) + '원' + pctPhrase(n.changePct),
        detail: (n.last && n.last.date ? n.last.date + ' ' : '') + '저가 ' + fmtInt(n.last && n.last.low) + '원으로 하단RN ' + fmtInt(n.lower) + '원 존(±' + fmtInt(n.band) + ') 진입, 현재가 ' +
          (held ? '존 안 유지' : '존 위 ' + n.lowerGapPct + '%'),
        basis: 'RN 60일봉 실측'
      });
    });

    // ② 상단 RN 존 터치 후 눌림
    list.filter(function (n) { return n.touchedUpper; })
      .sort(function (a, b) { return (b.upperGapPct || 0) - (a.upperGapPct || 0); })
      .slice(0, 2)
      .forEach(function (n) {
        add({
          code: n.code, name: n.name, color: 'yellow', view: 'rnzone',
          tag: '[상단 RN 터치 후 눌림]',
          body: '상단RN ' + fmtInt(n.upper) + '원 터치 → ' + fmtInt(n.price) + '원' + pctPhrase(n.changePct),
          detail: (n.last && n.last.date ? n.last.date + ' ' : '') + '고가 ' + fmtInt(n.last && n.last.high) + '원으로 상단RN ' + fmtInt(n.upper) + '원 존까지 올라간 뒤 ' + n.upperGapPct + '% 아래로 밀림',
          basis: 'RN 60일봉 실측'
        });
      });

    // ③ 상한가·52주 신고가 대금주 (1번 탭 실시간 데이터 재사용)
    var tabs = tabsBody || {};
    var ul = (tabs.upperLimit || {});
    var confirmed = (ul.confirmed || [])[0];
    var near = (ul.near || [])[0];
    var h52 = ((tabs.high52 || {}).byValue || [])[0];
    if (confirmed) {
      add({
        code: confirmed.code, name: confirmed.name, color: 'purple', view: 'overview',
        tag: '[100억+ 진성 상한가]',
        body: fmtPct(confirmed.changePct) + ' · 통합대금 ' + (confirmed.valueText || '—'),
        detail: '상승률 +25% 이상 & 거래대금 100억 이상 확정 상한가 (1번 탭 실시간 기준)',
        basis: '1번 탭 실시간'
      });
    } else if (near) {
      add({
        code: near.code, name: near.name, color: 'purple', view: 'overview',
        tag: '[상한가 임박]',
        body: fmtPct(near.changePct) + ' · 통합대금 ' + (near.valueText || '—'),
        detail: '상한가 임박 기준(+25% 돌파·100억+) 통과 (1번 탭 실시간 기준)',
        basis: '1번 탭 실시간'
      });
    }
    if (h52) {
      add({
        code: h52.code, name: h52.name, color: 'purple', view: 'overview',
        tag: '[52주 신고가 대금주]',
        body: fmtPct(h52.changePct) + ' · 통합대금 ' + (h52.valueText || '—'),
        detail: '52주 신고가 목록 중 거래대금 1위 (1번 탭 실시간 기준)',
        basis: '1번 탭 실시간'
      });
    }

    // ④ RN 1차 타점 근접
    list.filter(function (n) { return n.nearBuy1; })
      .sort(function (a, b) {
        return Math.abs(a.price - a.buy1) / a.buy1 - Math.abs(b.price - b.buy1) / b.buy1;
      })
      .slice(0, 2)
      .forEach(function (n) {
        add({
          code: n.code, name: n.name, color: 'green', view: 'rnzone',
          tag: '[RN 1차 타점 근접]',
          body: '1차 타점 ' + fmtInt(n.buy1) + '원 = 하단RN ' + fmtInt(n.lower) + '원+4% · 현재 ' + fmtInt(n.price) + '원' + pctPhrase(n.changePct),
          detail: '하단RN ' + fmtInt(n.lower) + '원 +4% = ' + fmtInt(n.buy1) + '원 기준 (2차 ' + fmtInt(Math.round(n.buy1 * 0.8)) + '원)',
          basis: 'RN 60일봉 실측'
        });
      });

    // ⑤ RN존 통합대금 상위 (대금 값이 들어온 종목만)
    list.filter(function (n) { return Boolean(n.valueText); })
      .sort(function (a, b) { return parseValueText(b.valueText) - parseValueText(a.valueText); })
      .slice(0, 1)
      .forEach(function (n) {
        add({
          code: n.code, name: n.name, color: 'yellow', view: 'rnzone',
          tag: '[RN존 통합대금 최대]',
          body: '통합대금 ' + n.valueText + ' · ' + fmtInt(n.price) + '원' + pctPhrase(n.changePct) + ' · RN ' + fmtInt(n.lower) + '~' + fmtInt(n.upper),
          detail: 'KRX+NXT 통합 거래대금 기준 RN존 11종목 중 최대',
          basis: '실시간 시세'
        });
      });

    // ⑥ 나머지 자리는 관찰 칩으로 채운다 (전부 실측 수치만 표기)
    list.slice()
      .sort(function (a, b) {
        var av = num(a.changePct), bv = num(b.changePct);
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return bv - av;
      })
      .forEach(function (n) {
        if (chips.length >= max) return;
        var tag = n.brokeLower ? '[RN 하단 이탈]' : (n.lowerGapPct <= 3 ? '[하단 RN 근접]' : '[RN존 관찰]');
        add({
          code: n.code, name: n.name, color: n.brokeLower ? 'yellow' : 'green', view: 'rnzone',
          tag: tag,
          body: fmtInt(n.price) + '원' + pctPhrase(n.changePct) + ' · RN ' + fmtInt(n.lower) + '~' + fmtInt(n.upper),
          detail: '하단RN ' + fmtInt(n.lower) + '원까지 ' + n.lowerGapPct + '% · 상단RN ' + fmtInt(n.upper) + '원까지 ' + n.upperGapPct,
          basis: 'RN 60일봉 실측'
        });
      });

    return { chips: chips, validCount: list.length };
  }

  /* '6조 1,185억' 같은 표기 → 비교용 숫자(원) */
  function parseValueText(text) {
    if (!text) return 0;
    var t = String(text).replace(/\s+/g, '');
    var jo = t.match(/(-?[\d,]+(?:\.\d+)?)조/);
    var eok = t.match(/(-?[\d,]+(?:\.\d+)?)억/);
    var man = t.match(/(-?[\d,]+(?:\.\d+)?)만/);
    var n = 0;
    if (jo) n += parseFloat(jo[1].replace(/,/g, '')) * 1e12;
    if (eok) n += parseFloat(eok[1].replace(/,/g, '')) * 1e8;
    if (man) n += parseFloat(man[1].replace(/,/g, '')) * 1e4;
    if (!jo && !eok && !man) {
      var raw = parseFloat(t.replace(/[^\d.-]/g, ''));
      if (isFinite(raw)) n += raw;
    }
    return n;
  }

  /* ---------------------- NXT 랭킹 재정렬 (순수 계산) ---------------------- */

  /**
   * @param entries [{ code, value, order }] · value = 통합 거래대금(원)
   * @returns 통합대금 내림차순 코드 배열 (값 없는 항목은 뒤로, 동률은 원래 순서)
   */
  function sortNxtByValue(entries) {
    var arr = (entries || []).slice();
    arr.sort(function (a, b) {
      var av = num(a.value), bv = num(b.value);
      if (av === null && bv === null) return (a.order || 0) - (b.order || 0);
      if (av === null) return 1;
      if (bv === null) return -1;
      if (bv !== av) return bv - av;
      return (a.order || 0) - (b.order || 0);
    });
    return arr.map(function (e) { return e.code; });
  }

  /* 등락률로 표기하는 상태 문구(숫자와 같은 값에서 나온다 — 임의 판단 없음) */
  function nxtState(pct) {
    if (num(pct) === null) return '— 등락률 없음';
    if (pct >= 1) return '🟢 종가 지지 안착';
    if (pct > 0) return '🟢 보합권 지지';
    if (pct > -1) return '🟡 매물 소화 중';
    return '🔵 약세 조정';
  }

  /* ------------------------------- DOM 반영 ------------------------------- */

  var state = {
    lastAt: null,
    ok: null,
    chipsSig: null,
    timer: null,
    chipTimer: null,
    chips: [],
    polling: false
  };

  function $(sel, rootEl) {
    if (!HAS_DOM) return null;
    return (rootEl || document).querySelector(sel);
  }
  function setText(el, text, color) {
    if (!el) return false;
    if (el.textContent !== text) el.textContent = text;
    if (color) el.style.color = color;
    return true;
  }

  /* 1) 신호등 칩 렌더 */
  function renderChips() {
    if (!HAS_DOM) return 0;
    var host = document.getElementById('signalChipsScroll');
    if (!host) return 0;
    var rnStocks = [];
    try {
      if (root.RnZone && typeof root.RnZone.getStocks === 'function') rnStocks = root.RnZone.getStocks() || [];
    } catch (e) { rnStocks = []; }
    var tabsBody = null;
    try { tabsBody = (root.TabsLive && root.TabsLive.state && root.TabsLive.state.lastBody) || null; } catch (e) { tabsBody = null; }

    var built = buildSignalChips(rnStocks, tabsBody, { maxChips: 6 });
    var chips = built.chips;
    var stampEl = document.getElementById('signalChipsStamp');

    if (!chips.length) {
      // 실측 근거가 없으면 기존(내장) 칩을 지우지 않고 그대로 둔다
      setText(stampEl, 'RN 실측 대기 · 내장 칩 유지', '#94a3b8');
      return 0;
    }

    state.chips = chips;
    var sig = chips.map(function (c) { return c.code + '|' + c.tag + '|' + c.body; }).join('~');
    if (sig !== state.chipsSig) {
      var html = chips.map(function (c, i) {
        return '<div class="signal-chip ' + c.color + '" data-live="1" data-signal-code="' + esc(c.code) + '"' +
          ' title="' + esc(c.detail + ' · ' + c.basis) + '"' +
          ' onclick="LiveExtra._open(' + i + ')">' +
          '<span>' + esc(c.tag) + '</span>' +
          '<strong>' + esc(c.name) + ':</strong>' +
          '<span>' + esc(c.body) + '</span>' +
          '</div>';
      }).join('');
      host.innerHTML = html;
      host.setAttribute('data-live', '1');
      state.chipsSig = sig;
    }

    var lastRn = null;
    try { lastRn = root.LiveAPI && root.LiveAPI.rnState ? root.LiveAPI.rnState.lastAt : null; } catch (e) { lastRn = null; }
    var basis = lastRn
      ? 'RN 실측 ' + lastRn + ' 갱신 · ' + chips.length + '칩'
      : 'RN 내장 60일봉 기준 · 실측 갱신 대기 · ' + chips.length + '칩';
    setText(stampEl, basis, lastRn ? '#34d399' : '#94a3b8');
    return chips.length;
  }

  function openChip(i) {
    var c = state.chips[i];
    if (!c) return;
    if (c.view === 'overview') {
      try { root.switchView('overview', null); } catch (e) { /* noop */ }
      return;
    }
    try {
      if (typeof root.navigateToSignalStock === 'function') {
        root.navigateToSignalStock('rnzone', c.code);
        return;
      }
    } catch (e) { /* noop */ }
    try {
      if (typeof root.tabsLiveOpenStock === 'function') root.tabsLiveOpenStock(c.name, c.code);
    } catch (e) { /* noop */ }
  }

  /* 2) 3번 탭 요약 문장 — 코스피·코스닥·NQ=F·ES=F 만 실시간 */
  function applySummary(payload) {
    var applied = 0;
    var indices = payload.indices || [];
    indices.forEach(function (it) {
      var price = num(it.price);
      if (price === null) return;
      var el = it.key === 'KOSPI' ? document.getElementById('afKospi')
        : it.key === 'KOSDAQ' ? document.getElementById('afKosdaq') : null;
      if (!el) return;
      setText(el, fmtDecimal(price) + ' (' + fmtPct(it.changePct) + ')', colorOf(it.changePct));
      el.setAttribute('data-live', '1');
      applied += 1;
    });
    (payload.futures || []).forEach(function (f) {
      var price = num(f.price);
      if (price === null) return;
      var el = f.symbol === 'NQ=F' ? document.getElementById('afNq')
        : f.symbol === 'ES=F' ? document.getElementById('afEs') : null;
      if (!el) return;
      setText(el, fmtDecimal(price) + ' (' + fmtPct(f.changePct) + ')', colorOf(f.changePct));
      el.setAttribute('data-live', '1');
      applied += 1;
    });
    return applied;
  }

  /* 3) 2번 수급 탭 카드 — 현재가·등락률만 */
  function applySupplyCards(byCode) {
    var tab = document.getElementById('tabSupply');
    if (!tab) return 0;
    var names = tab.querySelectorAll('.supply-stock-card .ssc-name');
    var applied = 0;
    Array.prototype.forEach.call(names, function (nameEl) {
      var name = (nameEl.textContent || '').replace(/\s+/g, ' ').trim();
      var code = SUPPLY_CODES[name];
      if (!code) return;
      var q = byCode[code];
      if (!q) return;
      var cell = formatPriceCell(q.price, q.changePct);
      if (!cell) return;
      // '대금 2,203억' 같은 정적 대금 배지도 실시간 통합대금으로 맞춘다
      var volText = q.valueIntegText || q.valueText || null;
      if (volText) {
        Array.prototype.forEach.call(nameEl.parentNode.parentNode.querySelectorAll('.s-badge'), function (b) {
          if (/^대금\s*[\d,]+\s*억/.test((b.textContent || '').trim())) {
            var vt = '대금 ' + volText;
            if (b.textContent !== vt) { b.textContent = vt; b.setAttribute('data-live', '1'); }
          }
        });
      }
      var top = nameEl.parentNode;
      var priceEl = top ? top.querySelector('.ssc-price') : null;
      if (!priceEl) return;
      if (priceEl.textContent !== cell.text) priceEl.textContent = cell.text;
      priceEl.className = 'ssc-price' + (cell.cls ? ' ' + cell.cls : '');
      priceEl.style.color = cell.color;
      priceEl.setAttribute('data-live', '1');
      priceEl.setAttribute('data-live-code', code);
      applied += 1;
    });
    return applied;
  }

  /* 4) 3번 애프터마켓 NXT Top 6 — 시세 갱신 + 통합대금순 재정렬 */
  function applyNxtRanking(byCode) {
    var grid = document.getElementById('nxtRankGrid');
    if (!grid) return 0;
    var cards = Array.prototype.slice.call(grid.querySelectorAll('[data-nxt-code]'));
    if (!cards.length) return 0;

    var entries = [];
    var applied = 0;
    cards.forEach(function (card, i) {
      var code = card.getAttribute('data-nxt-code');
      var q = byCode[code] || null;
      var order = Number(card.getAttribute('data-nxt-order') || i);
      if (q) {
        var cell = formatPriceCell(q.price, q.changePct);
        if (cell) {
          var priceEl = card.querySelector('.nxt-price');
          var pctEl = card.querySelector('.nxt-pct');
          var stateEl = card.querySelector('.nxt-state');
          var valueEl = card.querySelector('.nxt-value');
          if (priceEl) { priceEl.textContent = fmtInt(q.price) + '원'; priceEl.style.color = cell.color; }
          if (pctEl) { pctEl.textContent = fmtPct(q.changePct); pctEl.style.color = cell.color; }
          if (stateEl) stateEl.textContent = nxtState(q.changePct);
          var vText = q.valueIntegText || q.valueText || null;
          if (valueEl) valueEl.textContent = vText || '—';
          card.setAttribute('data-live', '1');
          applied += 1;
        }
        entries.push({ code: code, value: num(q.valueInteg) !== null ? q.valueInteg : num(q.value), order: order });
      } else {
        entries.push({ code: code, value: null, order: order });
      }
    });

    var sorted = sortNxtByValue(entries);
    var changed = sorted.some(function (code, i) {
      return cards[i] && cards[i].getAttribute('data-nxt-code') !== code;
    });
    if (changed) {
      var byCodeEl = {};
      cards.forEach(function (c) { byCodeEl[c.getAttribute('data-nxt-code')] = c; });
      sorted.forEach(function (code) { if (byCodeEl[code]) grid.appendChild(byCodeEl[code]); });
    }
    // 순위 라벨은 항상 DOM 순서대로 다시 매긴다
    Array.prototype.slice.call(grid.querySelectorAll('[data-nxt-code]')).forEach(function (card, i) {
      var rankEl = card.querySelector('.nxt-rank');
      if (rankEl) rankEl.textContent = 'TOP ' + (i + 1);
    });
    return applied;
  }

  /* 5) 갱신 시각 배지 (3번 NXT 랭킹 · 2번 수급 카드) */
  function stampBadges(payload, stamp) {
    var nxtEl = document.getElementById('nxtRankStamp');
    var supplyEl = document.getElementById('supplyLiveStamp');
    var weekend = null;
    try {
      var b = root.TabsLive && root.TabsLive.state && root.TabsLive.state.lastBody;
      weekend = b && b.sessionPhase ? b.sessionPhase : null;
    } catch (e) { weekend = null; }
    var phaseTxt = weekend === '주말휴장' ? ' · 주말 휴장(직전 거래일 종가)' : '';
    if (nxtEl) {
      nxtEl.textContent = '⚡ ' + stamp + ' 조회 · 현재가·등락률·통합대금(KRX+NXT) 실시간' + phaseTxt;
    }
    if (supplyEl) {
      supplyEl.textContent = '⚡ ' + stamp + ' 조회 현재가·등락률 실시간 (/api/stock-live)' + phaseTxt +
        ' — 외인·기관·연기금 순매수 금액은 KRX 장마감 확정치이며 실시간이 아닙니다.';
    }
    if (payload && payload.generatedAtKst) state.lastAt = stamp;
  }

  /* ============================ 1번 탭 실시간 시세 레이더 ============================ */

  // 장 세션 문구 (KST 고정 · 기기 시간대 무관)
  function kstClock(date) {
    var d = date instanceof Date ? date : new Date();
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
    }).formatToParts(d);
    var g = function (t) { return (parts.find(function (p) { return p.type === t; }) || {}).value || ''; };
    return {
      y: g('year'), m: Number(g('month')), d: Number(g('day')),
      hh: Number(g('hour')) % 24, mm: Number(g('minute')), wd: g('weekday')
    };
  }

  function sessionText(date) {
    var t = kstClock(date);
    var mins = t.hh * 60 + t.mm;
    if (t.wd === 'Sat' || t.wd === 'Sun') return '주말 휴장 · 직전 거래일 종가 기준';
    if (mins < 8 * 60) return '장 개시 전 · 직전 거래일 종가 기준';
    if (mins < 8 * 60 + 30) return '장전 준비 (08:00~08:30)';
    if (mins < 9 * 60) return '장전 시간외 종가 접수 (08:30~09:00)';
    if (mins < 15 * 60 + 30) return '정규장 진행 중 (09:00~15:30)';
    if (mins < 20 * 60) return '시간외 · NXT 애프터마켓 (15:30~20:00)';
    return '장 마감 · 시간외 종료';
  }

  /** '지니언스 34,150원 (+8.93%)' — 값이 없으면 이름만 */
  function pmQuoteText(name, q) {
    var price = q ? num(q.price) : null;
    if (price === null) return String(name || '');
    var pct = num(q.changePct);
    var pctTxt = pct === null ? '' : ' (' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%)';
    return String(name || '') + ' ' + fmtInt(price) + '원' + pctTxt;
  }

  function premarketCodes() {
    if (!HAS_DOM) return [];
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('#premarketRadarBox [data-pm-code]'), function (el) {
      var c = el.getAttribute('data-pm-code');
      if (c && /^\d{6}$/.test(c) && out.indexOf(c) < 0) out.push(c);
    });
    return out;
  }

  function applyPremarket(byCode, stamp) {
    if (!HAS_DOM) return 0;
    var box = document.getElementById('premarketRadarBox');
    if (!box) return 0;
    var applied = 0;
    Array.prototype.forEach.call(box.querySelectorAll('[data-pm-code]'), function (el) {
      var code = el.getAttribute('data-pm-code');
      var name = el.getAttribute('data-pm-name') || '';
      var q = byCode[code];
      if (!q) return;
      var txt = pmQuoteText(name, q);
      if (el.textContent !== txt) el.textContent = txt;
      var color = colorOf(num(q.changePct));
      el.style.color = color;
      el.style.fontWeight = '800';
      el.setAttribute('data-live', '1');
      el.setAttribute('title', '실시간 시세 · ' + (q.marketStatus || '') + ' · ' + (q.tradedAtKst || ''));
      applied += 1;
    });
    var sessionEl = document.getElementById('pmSessionText');
    var nowTxt = '🎯 세션 상태: ' + sessionText();
    if (sessionEl && sessionEl.textContent !== nowTxt) {
      sessionEl.textContent = nowTxt;
      sessionEl.setAttribute('data-live', '1');
      applied += 1;
    }
    var badge = document.getElementById('pmSyncBadge');
    if (badge) {
      var btxt = '⚡ ' + (stamp || '') + ' 시세 동기화 · /api/stock-live';
      if (badge.textContent !== btxt) badge.textContent = btxt;
      badge.style.color = '#6ee7b7';
      badge.setAttribute('data-live', '1');
    }
    var sessBadge = document.getElementById('pmSessionBadge');
    if (sessBadge) {
      var isWeekend = /주말/.test(sessionText());
      var stxt = isWeekend ? '🌙 주말 휴장 · 직전 종가' : '⚡ 실시간 폴링';
      if (sessBadge.textContent !== stxt) sessBadge.textContent = stxt;
      sessBadge.style.background = isWeekend ? '#1e293b' : '#064e3b';
      sessBadge.style.color = isWeekend ? '#cbd5e1' : '#6ee7b7';
      sessBadge.setAttribute('data-live', '1');
    }
    return applied;
  }

  /* ============================ 3번 탭 강세주 실시간 카드 ============================ */

  function afCardHtml(def, q) {
    var price = q ? num(q.price) : null;
    if (price === null) {
      return ('<div class="af-card" style="opacity:0.55;">' +
        '<div style="display:flex; justify-content:space-between;"><span style="font-weight:800; color:#fff;">' + esc(def.name) + '</span>' +
        '<span style="font-weight:700; color:#94a3b8;">시세 대기</span></div>' +
        '<div style="font-size:10.5px; color:#94a3b8; margin:2px 0;">' + esc(def.tag) + ' · 실시간 시세를 받지 못했습니다</div></div>');
    }
    var pct = num(q.changePct);
    var color = colorOf(pct);
    var cell = formatPriceCell(price, pct);
    var vol = q.valueIntegText || q.valueText || '—';
    var limit = pct !== null && pct >= 29.5;
    var stateTag = limit ? '<span style="font-size:9.5px; font-weight:800; background:#7f1d1d; color:#fecaca; padding:1px 5px; border-radius:3px;">상한가</span>' : '';
    var nameClean = esc(def.name);
    return ('<div class="af-card" data-live="1" data-live-code="' + esc(def.code) + '" style="cursor:pointer;" ' +
      'onclick="if(window.tabsLiveOpenStock){tabsLiveOpenStock(\'' + def.name.replace(/'/g, '') + '\', \'' + def.code + '\')}" ' +
      'title="실시간 시세 · 눌러서 RN존 실전 차트">' +
      '<div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">' +
      '<span style="font-weight:800; color:#fff;">★ ' + nameClean + ' ' + stateTag + '</span>' +
      '<span style="font-weight:800; color:' + (cell ? cell.color : color) + ';">' + (cell ? cell.text : fmtInt(price) + '원') + '</span>' +
      '</div>' +
      '<div style="font-size:10.5px; color:#94a3b8; margin:2px 0;">' + esc(def.tag) + ' · 통합대금 <strong style="color:#c084fc;">' + esc(vol) + '</strong></div>' +
      '<div style="font-size:10.5px; color:#cbd5e1;">' + esc(def.note) + '</div>' +
      '</div>');
  }

  function renderAfCards(byCode) {
    if (!HAS_DOM) return 0;
    var applied = 0;
    [['afStrongLive', AF_CARDS.strong], ['afLeaderLive', AF_CARDS.leader]].forEach(function (pair) {
      var host = document.getElementById(pair[0]);
      if (!host) return;
      var html = pair[1].map(function (def) { return afCardHtml(def, byCode[def.code]); }).join('');
      if (host.getAttribute('data-sig') !== html) {
        host.innerHTML = html;
        host.setAttribute('data-sig', html);
      }
      host.setAttribute('data-live', '1');
      applied += pair[1].length;
    });
    return applied;
  }

  /* ============================ 2번 탭 확정 수급 (/api/stock-trend) ============================ */

  /** 억원 표기 (부호 포함) */
  function signedEok(n) {
    var v = num(n);
    if (v === null) return '—';
    var sign = v > 0 ? '+' : '';
    return sign + Math.round(v).toLocaleString('ko-KR') + '억';
  }

  function qtyText(n) {
    var v = num(n);
    if (v === null) return '—';
    return (v > 0 ? '+' : '') + Math.round(v).toLocaleString('ko-KR') + '주';
  }

  /** 카드 배지 문구 — 라벨(bizdate)과 같은 날의 확정치 */
  function trendBadgeText(kind, row) {
    if (!row) return null;
    if (kind === 'foreign') return '외인 ' + signedEok(row.foreignAmount);
    if (kind === 'organ') return '기관 ' + signedEok(row.organAmount);
    return null;
  }

  function trendBadgeTitle(kind, row) {
    if (!row) return '';
    var qty = kind === 'organ' ? row.organQty : row.foreignQty;
    return (row.label || row.iso || '') + ' 확정 · ' + (kind === 'organ' ? '기관 ' : '외인 ') + qtyText(qty) +
      ' × ' + (num(row.close) === null ? '—' : fmtInt(row.close) + '원') + ' = ' + trendBadgeText(kind, row);
  }

  // 카드 배지의 외인/기관 금액을 확정치로 맞춘다
  function applyTrendToCard(card, row) {
    var badges = Array.prototype.slice.call(card.querySelectorAll('.s-badge'));
    var applied = 0;
    var targets = [
      { kind: 'foreign', re: /^외인|^외국인/ },
      { kind: 'organ', re: /^기관/ },
      // '−8,720억 원' 처럼 숫자만 적힌 배지(외국인 순매도 패널)는 있으면 갱신만 한다
      { kind: 'foreign', re: /^-?[\d,]+(\.\d+)?\s*억\s*원?$/, create: false, plain: true }
    ];
    targets.forEach(function (t) {
      var badge = null;
      for (var i = 0; i < badges.length; i += 1) {
        if (t.re.test((badges[i].textContent || '').trim())) { badge = badges[i]; break; }
      }
      var text = trendBadgeText(t.kind, row);
      if (!text) return;
      // 숫자만 있던 배지는 접두어 없이 금액만 (같은 카드에 '외인 …' 배지가 이미 있을 수 있다)
      if (t.plain) text = signedEok(t.kind === 'organ' ? row.organAmount : row.foreignAmount);
      if (!badge) {
        if (t.create === false) return;   // 숫자만 있던 배지는 새로 만들지 않는다
        badge = document.createElement('span');
        badge.className = 's-badge net';
        var host = card.querySelector('.ssc-badges');
        if (host) host.appendChild(badge);
      }
      var amount = t.kind === 'organ' ? num(row.organAmount) : num(row.foreignAmount);
      var color = amount === null ? '#cbd5e1' : amount > 0 ? '#6ee7b7' : '#fca5a5';
      var bg = amount === null ? 'rgba(148,163,184,0.18)' : amount > 0 ? '#065f46' : '#7f1d1d';
      if (badge.textContent !== text) badge.textContent = text;
      badge.style.color = color;
      badge.style.background = bg;
      badge.setAttribute('title', trendBadgeTitle(t.kind, row));
      badge.setAttribute('data-live', '1');
      applied += 1;
    });

    // 금투·연기금처럼 세부 투자자 분해 금액은 공개 API 가 없다 → 숫자를 지우고 성격을 적는다
    badges.concat(Array.prototype.slice.call(card.querySelectorAll('.s-badge'))).forEach(function (b) {
      var bt = (b.textContent || '').trim();
      if (/금투|연기금/.test(bt) && /[\d,]+\s*(억|원)/.test(bt)) {
        b.textContent = '금투·연기금 세부(확정자료)';
        b.setAttribute('title', '금융투자·연기금 세부 순매수는 KRX 확정 자료 기준이며 이 화면에서 자동 갱신하지 않습니다.');
        b.setAttribute('data-live', 'static-note');
      }
    });

    // 설명문(ssc-desc)에 남아 있는 옛 금액·문구는 근거가 바뀌었으므로 확정치 문장으로 바꾼다
    var desc = card.querySelector('.ssc-desc');
    if (desc) {
      var closeTxt = num(row.close) === null ? '—' : fmtInt(row.close) + '원';
      var dtxt = '확정 수급(' + (row.label || row.iso || '') + ') · 외인 ' + signedEok(row.foreignAmount) +
        ' · 기관 ' + signedEok(row.organAmount) + ' · 종가 ' + closeTxt +
        ' — 거래소 확정치이며 장중 실시간 수치가 아닙니다.';
      if (desc.textContent !== dtxt) {
        desc.textContent = dtxt;
        desc.setAttribute('data-live', '1');
        applied += 1;
      }
    }
    return applied;
  }

  // '장중 실시간 추적 중 / 10:00·12:00·14:00·15:30' 자리에 실제 확정 4거래일 흐름을 넣는다
  function trackerHtml(rows, kind) {
    var list = (rows || []).slice(0, 4);
    if (!list.length) return null;
    var cells = list.map(function (r, i) {
      var amount = kind === 'organ' ? num(r.organAmount) : num(r.foreignAmount);
      var color = amount === null ? '#cbd5e1' : amount > 0 ? '#fca5a5' : '#7dd3fc';
      var label = r.label || r.iso || '';
      return '<span style="color:' + color + ';">' + esc(label) + ' ' + esc(signedEok(amount)) + '</span>' +
        (i < list.length - 1 ? '<span class="stb-arrow">➔</span>' : '');
    }).join('');
    var basis = list[0];
    return ('<div class="stb-title"><span>⏱️ ' + esc(basis.label || '') + ' ' + (kind === 'organ' ? '기관' : '외인') + ' 확정</span>' +
      '<span style="color:#38bdf8;">최근 4거래일 확정 순매수</span></div>' +
      '<div class="stb-flow">' + cells + '</div>');
  }

  function applySupplyTrend(body) {
    if (!HAS_DOM || !body || body.ok !== true) return 0;
    var tab = document.getElementById('tabSupply');
    if (!tab) return 0;
    var rowsByCode = {};
    (body.stocks || []).forEach(function (s) {
      if (s && s.ok && s.latest) rowsByCode[s.code] = s;
    });
    var applied = 0;
    var basisLabel = body.basisLabel || '';

    Array.prototype.forEach.call(tab.querySelectorAll('.supply-stock-card'), function (card) {
      var nameEl = card.querySelector('.ssc-name');
      var name = nameEl ? (nameEl.textContent || '').trim() : '';
      var code = SUPPLY_CODES[name];
      var st = code ? rowsByCode[code] : null;
      if (!st) return;
      applied += applyTrendToCard(card, st.latest);
      var box = card.querySelector('.supply-tracker-box');
      if (box) {
        var kind = /기관/.test((box.textContent || '')) && !/외인/.test((card.querySelector('.s-badge') || {}).textContent || '') ? 'organ' : 'foreign';
        // 카드 첫 배지가 '기관'이면 기관 흐름을, 아니면 외인 흐름을 보여준다
        var firstBadge = card.querySelector('.s-badge');
        if (firstBadge && /^기관/.test((firstBadge.textContent || '').trim())) kind = 'organ';
        var html = trackerHtml(st.rows, kind);
        if (html && box.innerHTML !== html) {
          box.innerHTML = html;
          box.setAttribute('data-live', '1');
          applied += 1;
        }
      }
    });

    // 섹션 제목의 '(11/13 실시간 관제)' → 실제 기준일로
    Array.prototype.forEach.call(tab.querySelectorAll('.sec-head'), function (head) {
      var span = head.querySelector('span');
      if (!span) return;
      var t = span.textContent || '';
      var shortBasis = String(basisLabel || '').replace(/\([^)]*\)/, '').trim();
      var next = t.replace(/\(\d{1,2}\/\d{1,2}\s*실시간 관제\)/, '(' + shortBasis + ' 확정)');
      if (next !== t) {
        span.textContent = next;
        span.setAttribute('data-live', '1');
        applied += 1;
      }
    });

    // 상단 총평 — 시장 전체 시계열은 공개 API 가 없으므로 정적 숫자를 지우고 사실만 남긴다
    var banner = tab.querySelector('.panel-box.blue > div[style*="SUPPLY OVERVIEW"]');
    if (!banner) {
      var cand = Array.prototype.slice.call(tab.querySelectorAll('div')).filter(function (d) {
        return /당일 시간대별 수급 유지도 총평/.test(d.textContent || '') && (d.textContent || '').length < 400;
      })[0];
      banner = cand || null;
    }
    if (banner) {
      var bhtml = '<strong style="color:#38bdf8;">⏱️ 종목별 확정 수급:</strong> 아래 카드의 외인·기관 금액과 최근 4거래일 흐름은 거래소 확정치(' +
        esc(basisLabel) + ')로 자동 반영됩니다.<br>' +
        '<span style="color:#94a3b8; font-size:10.5px;">※ 시장 전체(코스피·코스닥) 투자자별 시간대별 수급 시계열은 무료 공개 API가 없어 자동 갱신하지 않습니다.</span>';
      if (banner.getAttribute('data-sig') !== bhtml) {
        banner.innerHTML = bhtml;
        banner.setAttribute('data-sig', bhtml);
        banner.setAttribute('data-live', '1');
        applied += 1;
      }
    }

    var stampEl = document.getElementById('supplyLiveStamp');
    if (stampEl) {
      var txt = '⚡ 현재가·등락률 실시간(/api/stock-live) · 외인·기관·개인 수급은 거래소 확정치(' +
        (basisLabel || '—') + ') 자동 반영 · ' + (body.amountBasis || '순매수 주수 × 종가');
      if (stampEl.textContent !== txt) stampEl.textContent = txt;
      stampEl.setAttribute('data-live', '1');
      applied += 1;
    }
    return applied;
  }

  function trendCodes() {
    return Object.keys(SUPPLY_CODES).map(function (n) { return SUPPLY_CODES[n]; });
  }

  function loadTrend(force) {
    if (!HAS_DOM) return Promise.resolve(0);
    if (state.trendBusy) return Promise.resolve(0);
    if (!force && state.trendAt && Date.now() - state.trendAt < TREND_MS) return Promise.resolve(0);
    state.trendBusy = true;
    return fetch(TREND_URL + '?codes=' + trendCodes().join(','), { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        state.trendBusy = false;
        if (!body || body.ok !== true) return 0;
        state.trendAt = Date.now();
        state.trend = body;
        return applySupplyTrend(body);
      })
      .catch(function () {
        state.trendBusy = false;
        return 0;
      });
  }

  function applyLive(payload) {
    if (!HAS_DOM || !payload || payload.ok !== true) return 0;
    var byCode = {};
    (payload.stocks || []).forEach(function (s) {
      if (s && s.code) byCode[s.code] = s;
    });
    var stamp = stampOf(payload.generatedAt);
    var applied = 0;
    applied += applySummary(payload);
    applied += applySupplyCards(byCode);
    applied += applyNxtRanking(byCode);
    applied += applyPremarket(byCode, stamp);
    applied += renderAfCards(byCode);
    stampBadges(payload, stamp);
    state.ok = applied > 0;
    return applied;
  }

  /* -------------------------------- 폴링 -------------------------------- */

  function codes() {
    var out = [];
    var afCodes = AF_CARDS.strong.concat(AF_CARDS.leader).map(function (d) { return d.code; });
    NXT_CODES
      .concat(Object.keys(SUPPLY_CODES).map(function (n) { return SUPPLY_CODES[n]; }))
      .concat(afCodes)
      .concat(premarketCodes())
      .forEach(function (c) { if (c && /^\d{6}$/.test(c) && out.indexOf(c) < 0) out.push(c); });
    return out;
  }

  function poll() {
    if (!HAS_DOM || state.polling) return;
    state.polling = true;
    var url = LIVE_URL + '?codes=' + codes().join(',');
    fetch(url, { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        state.polling = false;
        if (!body || body.ok !== true) {
          state.ok = false;
          return;
        }
        applyLive(body);
      })
      .catch(function () {
        state.polling = false;
        state.ok = false;
      });
  }

  function start() {
    poll();
    renderChips();
    loadTrend(false);
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (document.hidden) return;
      poll();
    }, POLL_MS);
    if (state.chipTimer) clearInterval(state.chipTimer);
    state.chipTimer = setInterval(function () {
      if (document.hidden) return;
      renderChips();
    }, CHIP_MS);
    // 확정 수급(/api/stock-trend)을 아직 못 받았으면 1분마다 재시도한다(성공하면 30분 캐시)
    if (state.trendTimer) clearInterval(state.trendTimer);
    state.trendTimer = setInterval(function () {
      if (document.hidden) return;
      if (!state.trend) loadTrend(false);
    }, 60000);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      poll();
      renderChips();
    });
  }

  var api = {
    // 순수 계산 (Node 테스트에서 직접 검증)
    buildSignalChips: buildSignalChips,
    normalizeRnStock: normalizeRnStock,
    sortNxtByValue: sortNxtByValue,
    formatPriceCell: formatPriceCell,
    nxtState: nxtState,
    parseValueText: parseValueText,
    rnStep: rnStep,
    SUPPLY_CODES: SUPPLY_CODES,
    NXT_CODES: NXT_CODES,
    NXT_NAMES: NXT_NAMES,
    // DOM/폴링
    applyLive: applyLive,
    applySummary: applySummary,
    applySupplyCards: applySupplyCards,
    applyNxtRanking: applyNxtRanking,
    renderChips: renderChips,
    poll: poll,
    start: start,
    // 2026-11-14 추가: 실시간 레이더 · 강세주 카드 · 확정 수급
    applyPremarket: applyPremarket,
    renderAfCards: renderAfCards,
    applySupplyTrend: applySupplyTrend,
    loadTrend: loadTrend,
    trendCodes: trendCodes,
    sessionText: sessionText,
    pmQuoteText: pmQuoteText,
    signedEok: signedEok,
    qtyText: qtyText,
    trendBadgeText: trendBadgeText,
    trendBadgeTitle: trendBadgeTitle,
    trackerHtml: trackerHtml,
    AF_CARDS: AF_CARDS,
    TREND_URL: TREND_URL,
    state: state,
    _open: openChip,
    codes: codes
  };

  root.LiveExtra = api;

  if (HAS_DOM) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
