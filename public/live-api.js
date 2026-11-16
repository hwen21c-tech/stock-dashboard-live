/* ============================================================================
 * ⚡ 동적 실시간 API 연동 레이어  (Vercel Serverless  /api/stock-live · /api/stock-chart)
 * ----------------------------------------------------------------------------
 *  · 페이지 로드 직후 + 15초마다  /api/stock-live 를 호출해
 *      - 상단 9대 지표 중  코스피 · 코스닥 · 나스닥선물(NQ=F) · 원/달러 · S&P500선물(ES=F)
 *      - RN존 감시 종목(현재 목록)의 현재가 · 등락률 · 통합 거래대금
 *    을 실시간 값으로 덮어쓴다.
 *  · API 가 실패하면 아무것도 지우지 않고 내장(정적) 데이터를 그대로 유지한다.
 *      → 배지가 "⚠️ API 연결 실패 · 내장 데이터" 로 바뀔 뿐 화면은 정상 동작.
 *  · RN존 검색창은  /api/stock-chart 로 60거래일봉 + RN 지지/저항선을 즉시 그린다.
 * ==========================================================================*/
(function () {
  'use strict';

  var LIVE_URL = '/api/stock-live';
  var CHART_URL = '/api/stock-chart';
  var POLL_MS = 15000;
  var state = {
    polling: false,
    ok: null,
    timer: null,
    badge: null,
    lastLiveAt: null
  };

  function byId(id) { return document.getElementById(id); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function money(n) {
    if (n === null) return '—';
    return Math.round(n).toLocaleString('ko-KR');
  }
  function pctText(p) {
    if (p === null) return '';
    var sign = p > 0 ? '+' : (p < 0 ? '' : '');
    return '(' + sign + p.toFixed(2) + '%)';
  }
  function valClass(p) {
    if (p === null || p === 0) return 'val';
    return p > 0 ? 'val up' : 'val down';
  }
  function nowText() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ------------------------- 상단 지표 티커 갱신 ------------------------- */

  function tickerItems() {
    var bar = document.querySelector('.ticker-bar');
    if (!bar) return [];
    return Array.prototype.slice.call(bar.querySelectorAll('.ticker-item'));
  }

  function findTicker(match) {
    var items = tickerItems();
    for (var i = 0; i < items.length; i += 1) {
      var labelEl = items[i].querySelector('.label');
      var label = labelEl ? (labelEl.textContent || '').replace(/\s+/g, '') : '';
      if (match(label)) return { item: items[i], label: labelEl, val: items[i].querySelector('.val') };
    }
    return null;
  }

  function paintTicker(target, valueText, changePct) {
    if (!target || !target.item) return false;
    var val = target.val;
    if (!val) {
      val = document.createElement('span');
      val.className = 'val';
      target.item.appendChild(val);
    }
    val.textContent = valueText;
    val.className = valClass(changePct);
    return true;
  }

  // S&P500 선물(ES=F) 타일: 동적 API 가 값을 줄 때만 나스닥선물 옆에 새로 붙인다.
  function ensureSp500Tile() {
    if (findTicker(function (l) { return l.indexOf('S&P500') >= 0; })) return;
    var nas = findTicker(function (l) { return l.indexOf('나스닥선물') >= 0; });
    if (!nas || !nas.item.parentNode) return;

    var clone = nas.item.cloneNode(true);
    clone.removeAttribute('onclick');
    clone.style.cursor = 'default';
    var labelEl = clone.querySelector('.label');
    if (labelEl) labelEl.textContent = 'S&P500선물 🇺🇸 (ES=F)';
    var valEl = clone.querySelector('.val');
    if (valEl) { valEl.textContent = '—'; valEl.className = 'val'; }

    var sep = document.createElement('span');
    sep.className = 'ticker-sep';
    sep.textContent = '|';

    var anchor = nas.item;
    if (anchor.nextSibling) {
      anchor.parentNode.insertBefore(sep, anchor.nextSibling);
      anchor.parentNode.insertBefore(clone, sep.nextSibling);
    } else {
      anchor.parentNode.appendChild(sep);
      anchor.parentNode.appendChild(clone);
    }
  }

  /* -------------------- WTI 유가 · 필라델피아 반도체(SOX) -------------------- */

  // 티커 항목의 onclick(openIndexChart) 인자를 실시간 값으로 다시 쓴다
  function repaintOnclick(target, title, v1, v2, desc, key) {
    if (!target || !target.item) return false;
    function clean(s) {
      return String(s === null || s === undefined ? '' : s).replace(/['"\\]/g, '').replace(/\s+/g, ' ').trim();
    }
    target.item.setAttribute(
      'onclick',
      "openIndexChart('" + clean(title) + "', '" + clean(v1) + "', '" + clean(v2) + "', '" + clean(desc) + "', '" + clean(key) + "')"
    );
    return true;
  }

  // 라벨 안의 작은 배지(SOX 공식 / NYMEX) 문구 교체
  function setTickerBadge(target, text) {
    if (!target || !target.label) return false;
    var badge = target.label.querySelector('span');
    if (!badge) return false;
    if (badge.textContent !== text) badge.textContent = text;
    return true;
  }

  function macroValueText(m) {
    var price = num(m.price);
    if (price === null) return null;
    var pct = num(m.changePct);
    if (m.key === 'WTI') return '$' + price.toFixed(2) + ' ' + pctText(pct);
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + pctText(pct);
  }

  // 페이지 안 여러 위치(상단 요약·분석 모달)의 같은 지표 문구를 한 번에 맞춘다
  function paintInline(ids, text, pct) {
    if (!text) return 0;
    var hits = 0;
    for (var i = 0; i < ids.length; i += 1) {
      var el = byId(ids[i]);
      if (!el) continue;
      el.textContent = text;
      el.style.color = pct === null ? '#94a3b8' : (pct > 0 ? '#f43f5e' : '#38bdf8');
      el.setAttribute('data-live', '1');
      hits += 1;
    }
    return hits;
  }

  function applyMacro(payload) {
    var macro = payload.macro || {};
    var applied = 0;

    // ---- 상단 티커 · 요약 문장의 WTI ----
    var wti = macro.WTI;
    if (wti) {
      var wText = macroValueText(wti);
      var wTarget = findTicker(function (l) { return l.indexOf('WTI') >= 0; });
      if (wText && wTarget) {
        if (paintTicker(wTarget, wText, num(wti.changePct))) applied += 1;
        wTarget.item.setAttribute('title', '야후 CL=F · ' + (wti.basisLabel || '') + ' · ' + (wti.updateCycle || ''));
        setTickerBadge(wTarget, wti.sessionOpen === true ? 'NYMEX 실시간' : 'NYMEX 마감값');
        repaintOnclick(
          wTarget,
          'WTI 국제유가 선물 (NYMEX 최근월물)',
          '$' + num(wti.price).toFixed(2) + ' ' + pctText(num(wti.changePct)),
          '전일 종가 $' + (num(wti.previousClose) === null ? '—' : num(wti.previousClose).toFixed(2)) +
            (num(wti.change) === null ? '' : ' · ' + (num(wti.change) > 0 ? '+' : '') + num(wti.change).toFixed(2) + '달러'),
          '야후 CL=F · ' + (wti.basisLabel || '') + ' · ' + (wti.updateCycle || ''),
          'wti'
        );
      }
      var wInline = paintInline(['afWti', 'mfWti'], wText, num(wti.changePct));
      applied += wInline;
    }

    // ---- 상단 티커 · 요약 문장의 필라델피아 반도체(SOX) ----
    var sox = macro.SOX;
    if (sox) {
      var sText = macroValueText(sox);
      var sTarget = findTicker(function (l) { return l.indexOf('SOX') >= 0 || l.indexOf('필라델피아') >= 0; });
      if (sText && sTarget) {
        if (paintTicker(sTarget, sText, num(sox.changePct))) applied += 1;
        sTarget.item.setAttribute('title', '야후 ^SOX · ' + (sox.basisLabel || '') + ' · ' + (sox.updateCycle || ''));
        // 일 1회 갱신 성격을 배지로 명시
        setTickerBadge(sTarget, sox.sessionOpen === true ? 'SOX 실시간' : '美장 마감 기준');
        repaintOnclick(
          sTarget,
          '필라델피아 반도체 지수 (SOX)',
          num(sox.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'pt ' + pctText(num(sox.changePct)),
          '전일 종가 ' + (num(sox.previousClose) === null ? '—' : num(sox.previousClose).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + 'pt',
          '야후 ^SOX · ' + (sox.basisLabel || '') + ' · ' + (sox.updateCycle || ''),
          'sox'
        );
      }
      var sInline = paintInline(['afSox', 'mfSox'], sText, num(sox.changePct));
      applied += sInline;
    }

    return applied;
  }

  function applyLive(payload) {
    var applied = 0;
    var indices = payload.indices || [];

    for (var i = 0; i < indices.length; i += 1) {
      var idx = indices[i];
      var price = num(idx.price);
      if (price === null) continue;
      var p = num(idx.changePct);
      var target = null;
      if (idx.key === 'KOSPI') {
        target = findTicker(function (l) { return l.indexOf('코스피') >= 0 && l.indexOf('선물') < 0; });
      } else if (idx.key === 'KOSDAQ') {
        target = findTicker(function (l) { return l.indexOf('코스닥') >= 0 && l.indexOf('선물') < 0; });
      }
      if (target && paintTicker(target, price.toFixed(2) + ' ' + pctText(p), p)) applied += 1;
      // 모달을 열었을 때도 같은 수치가 보이도록 onclick 인자를 실시간 값으로 다시 쓴다
      if (target && (idx.key === 'KOSPI' || idx.key === 'KOSDAQ')) {
        var isKospi = idx.key === 'KOSPI';
        var v1 = price.toFixed(2) + 'pt ' + pctText(p);
        var v2 = '전일 종가 ' + (num(idx.price - (idx.change || 0)) === null ? '—'
          : (idx.price - (idx.change || 0)).toFixed(2) + 'pt') +
          (idx.valueText ? ' · 거래대금 ' + idx.valueText : '');
        var desc = (idx.status === 'CLOSE' ? '직전 정규장 마감값(네이버 금융) · ' : '네이버 금융 실시간 · ') +
          '일봉은 /api/index-chart(Yahoo 1년)에서 실제 캔들로 그립니다.';
        repaintOnclick(
          target,
          isKospi ? '코스피 (KOSPI)' : '코스닥 (KOSDAQ)',
          v1,
          v2,
          desc,
          isKospi ? 'kospi' : 'kosdaq'
        );
      }
    }

    var futures = payload.futures || [];
    if (futures.length) ensureSp500Tile();
    for (var f = 0; f < futures.length; f += 1) {
      var fut = futures[f];
      var fPrice = num(fut.price);
      if (fPrice === null) continue;
      var fp = num(fut.changePct);
      var ft = null;
      if (fut.symbol === 'NQ=F') {
        ft = findTicker(function (l) { return l.indexOf('나스닥선물') >= 0; });
      } else if (fut.symbol === 'ES=F') {
        ft = findTicker(function (l) { return l.indexOf('S&P500') >= 0; });
      }
      if (ft && paintTicker(ft, fPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + pctText(fp), fp)) applied += 1;
      if (ft && fut.symbol === 'NQ=F') {
        repaintOnclick(
          ft,
          'E-mini 나스닥 100 선물 (CME Globex NQ 최근월물)',
          fPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'pt ' + pctText(fp),
          '전일 종가 ' + (num(fut.previousClose) === null ? '—'
            : num(fut.previousClose).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'pt'),
          '야후 NQ=F · ' + (fut.asOfKst ? fut.asOfKst + ' KST 기준' : 'CME 최근월물') + ' · 일봉은 /api/index-chart 실데이터',
          'nasdaq_fut'
        );
      }
    }

    var fx = payload.fx;
    if (fx) {
      var fxPrice = num(fx.price);
      if (fxPrice !== null) {
        var fxp = num(fx.changePct);
        var ft2 = findTicker(function (l) { return l.indexOf('원/달러') >= 0; });
        if (ft2 && paintTicker(ft2, fxPrice.toFixed(2) + '원 ' + pctText(fxp), fxp)) applied += 1;
        if (ft2) {
          // 실제 값의 성격(네이버 환율 = 서울 외환시장 고시/최종 체결)으로 배지를 맞춘다 — '야간 NDF' 표기는 근거가 없다
          setTickerBadge(ft2, fx.source === 'yahoo' ? '야후 KRW=X' : '서울환시 기준');
          ft2.item.setAttribute('title', '원/달러 환율 · ' + (fx.source === 'yahoo' ? 'Yahoo KRW=X' : '네이버 환율(서울 외환시장)') +
            (fx.tradedDate ? ' · ' + fx.tradedDate + ' 기준' : '') + ' · NDF는 공개 실시간 API가 없습니다');
          repaintOnclick(
            ft2,
            '원/달러 환율 (서울 외환시장 기준)',
            fxPrice.toFixed(2) + '원 ' + pctText(fxp),
            '기준 ' + (fx.tradedDate || '—') + ' · 일봉은 /api/index-chart(KRW=X) 실데이터',
            '네이버·야후 환율 · NDF 환율은 공개 실시간 API가 없습니다.',
            'usdkrw'
          );
        }
      }
    }

    // WTI 유가 · 필라델피아 반도체(SOX)
    applied += applyMacro(payload);

    // 감시 종목(RN존 목록) 현재가·등락률·통합 거래대금
    var map = {};
    (payload.stocks || []).forEach(function (s) {
      if (!s || !s.code) return;
      map[s.code] = {
        price: num(s.price),
        changePct: num(s.changePct),
        // 카드의 거래대금은 통합(KRX+NXT·시간외 포함) 기준을 우선한다
        valueText: s.valueIntegText || s.valueText || null,
        valueBasis: s.valueBasis || null
      };
    });
    if (window.RnZone && typeof window.RnZone.refreshLivePrices === 'function' && Object.keys(map).length) {
      try { window.RnZone.refreshLivePrices(map); applied += 1; } catch (e) { /* noop */ }
    }

    // 8번 종베 탭 카드(현재가·등락률) · 7번 만쥬 탭 카드(현재가·등락률·통합대금)
    if (window.Jongbe && typeof window.Jongbe.refreshLivePrices === 'function' && Object.keys(map).length) {
      try { if (window.Jongbe.refreshLivePrices(map) > 0) applied += 1; } catch (e) { /* noop */ }
    }
    if (Object.keys(map).length) {
      try { if (applyManjuQuotes(map) > 0) applied += 1; } catch (e) { /* noop */ }
    }

    return applied;
  }

  /* --------------------------- 상태 배지 --------------------------- */

  function ensureBadge() {
    if (state.badge && document.body.contains(state.badge)) return state.badge;
    var host = document.querySelector('.srb-right') || document.querySelector('.session-radar-bar');
    if (!host) return null;
    var el = document.createElement('span');
    el.id = 'liveApiBadge';
    el.style.cssText = 'padding:3px 8px; font-size:10.5px; font-weight:800; border-radius:4px; ' +
      'background:rgba(16,185,129,0.15); color:#34d399; border:1px solid rgba(16,185,129,0.35); white-space:nowrap;';
    el.textContent = '⚡ 동적 API 연결 중…';
    var anchor = document.getElementById('lastSyncTxt');
    if (anchor && anchor.parentNode === host) host.insertBefore(el, anchor);
    else host.appendChild(el);
    state.badge = el;
    return el;
  }

  function setBadge(ok, text) {
    var el = ensureBadge();
    if (!el) return;
    el.textContent = text;
    if (ok === true) {
      el.style.background = 'rgba(16,185,129,0.15)';
      el.style.color = '#34d399';
      el.style.borderColor = 'rgba(16,185,129,0.35)';
    } else if (ok === false) {
      el.style.background = 'rgba(245,158,11,0.15)';
      el.style.color = '#fbbf24';
      el.style.borderColor = 'rgba(245,158,11,0.4)';
    } else {
      el.style.background = 'rgba(148,163,184,0.15)';
      el.style.color = '#94a3b8';
      el.style.borderColor = 'rgba(148,163,184,0.35)';
    }
  }

  /* --------------------------- 실시간 폴링 --------------------------- */

  /* ======================================================================
   * 7번 만쥬 탭 — 정적 카드의 현재가·등락률·통합대금을 실시간 시세로 갱신
   *   · 카드 구조(이름 (코드) / 11,210원 (+29.90%) / • 통합대금: 957억)를 그대로 두고
   *     텍스트 노드만 덮어쓴다. 종목 선정 이유·타점 문구는 손대지 않는다.
   * ==================================================================== */
  var manjuState = { map: null, at: 0 };

  function leafText(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function buildManjuMap() {
    var map = {};
    var tab = byId('tabManju');
    if (!tab) { manjuState.map = map; manjuState.at = Date.now(); return map; }

    Array.prototype.slice.call(tab.querySelectorAll('strong, span, b')).forEach(function (el) {
      if (el.children && el.children.length) return;
      var m = leafText(el).match(/^(.+?)\s*\((\d{6})\)$/);
      if (!m) return;
      var code = m[2];
      if (map[code]) return;

      var headRow = el.parentElement;                          // 순위·이름 한 줄
      var row = headRow ? headRow.parentElement : null;        // 이름 + 가격 줄
      var card = row ? row.parentElement : null;               // 카드 전체(대금·캔들상태·타점 포함)
      if (!card) return;

      var priceEl = null;
      var valueEl = null;
      var priceHost = row || card;
      Array.prototype.slice.call(priceHost.querySelectorAll('span, strong, div')).forEach(function (n) {
        if (priceEl || (n.children && n.children.length)) return;
        if (/^[\d,]+\s*원\s*\(\s*[+\-]?\d+(?:\.\d+)?%\s*\)$/.test(leafText(n))) priceEl = n;
      });
      Array.prototype.slice.call(card.querySelectorAll('span, div')).forEach(function (n) {
        if (valueEl) return;
        var t = leafText(n);
        if (t.indexOf('통합대금') === 0 || t.indexOf('• 통합대금') === 0 || t.indexOf('•통합대금') === 0) {
          var strong = n.querySelector ? n.querySelector('strong') : null;
          valueEl = strong || n;
        }
      });
      if (!priceEl) return;
      map[code] = { name: m[1], priceEl: priceEl, valueEl: valueEl };
    });

    manjuState.map = map;
    manjuState.at = Date.now();
    return map;
  }

  function manjuMap(force) {
    if (force || !manjuState.map || !Object.keys(manjuState.map).length) return buildManjuMap();
    return manjuState.map;
  }

  function manjuCodes() {
    return Object.keys(manjuMap(false) || {});
  }

  function applyManjuQuotes(map) {
    if (!map) return 0;
    var cards = manjuMap(false);
    var hits = 0;
    Object.keys(cards).forEach(function (code) {
      var q = map[code];
      var c = cards[code];
      if (!q || !c) return;
      if (!c.priceEl || !document.body.contains(c.priceEl)) {
        applyManjuQuotes.broken = true;
        return;
      }
      if (num(q.price) !== null) {
        var pct = num(q.changePct);
        c.priceEl.textContent = money(q.price) + '원' +
          (pct === null ? '' : ' (' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%)');
        c.priceEl.style.color = pct === null || pct === 0 ? '#e2e8f0' : (pct > 0 ? '#f43f5e' : '#38bdf8');
        hits += 1;
      }
      if (c.valueEl && q.valueText && document.body.contains(c.valueEl)) {
        c.valueEl.textContent = q.valueText;
        hits += 1;
      }
    });
    if (applyManjuQuotes.broken) {
      applyManjuQuotes.broken = false;
      manjuMap(true);
    }
    return hits;
  }

  /* ======================================================================
   * 6번 RN존 탭 — 기본 목록 11종목의 60일봉·현재가·RN선을 동적 갱신
   *   · 한꺼번에 11종목을 때리지 않는다: 선택 종목 먼저 → 나머지를 4종목씩 순차
   *   · 실패한 종목은 기존(내장) 데이터를 그대로 유지한다
   * ==================================================================== */
  var RN_BATCH = 4;           // 배치당 종목 수
  var RN_GAP_MS = 400;        // 종목 사이 간격
  var RN_CYCLE_MS = 300000;   // RN 탭을 보는 동안 5분마다 백그라운드 갱신
  var rnRefresh = { running: false, ok: 0, fail: 0, total: 0, lastAt: null, lastMs: null, timer: null, promise: null };

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function rnStatus(text, kind) {
    var el = byId('rnLiveStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === 'err' ? '#fca5a5' : kind === 'ok' ? '#34d399' : kind === 'warn' ? '#fbbf24' : '#94a3b8';
  }

  function rnCodes() {
    try {
      if (window.RnZone && typeof window.RnZone.getStocks === 'function') {
        return (window.RnZone.getStocks() || [])
          .map(function (s) { return s && s.code; })
          .filter(function (c) { return /^[0-9A-Z]{6}$/.test(String(c)); });
      }
    } catch (e) { /* noop */ }
    return [];
  }

  function isRnTabVisible() {
    var tab = byId('tabRnzone');
    return Boolean(tab && tab.style.display !== 'none' && !document.hidden);
  }

  function fetchChartJson(code, count) {
    var controller = null;
    var timer = null;
    try { controller = new AbortController(); } catch (e) { controller = null; }
    if (controller) timer = setTimeout(function () { try { controller.abort(); } catch (e) { /* noop */ } }, 12000);
    var url = CHART_URL + '?code=' + encodeURIComponent(code) + '&count=' + (count || 60);
    return fetch(url, controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null;
          try { json = JSON.parse(text); } catch (e) { json = null; }
          return { status: res.status, body: json };
        });
      })
      .then(function (out) { if (timer) clearTimeout(timer); return out; })
      .catch(function (err) { if (timer) clearTimeout(timer); throw err; });
  }

  /** 종목 1개의 60일봉·현재가·RN을 받아 RN존 목록 항목을 교체한다. 실패 시 false. */
  function refreshStockData(code) {
    if (!code) return Promise.resolve(false);
    return fetchChartJson(code, 60)
      .then(function (out) {
        var body = out.body;
        if (!body || body.ok !== true) return false;
        var stock = toRnStock(body);
        if (!stock) return false;
        if (!window.RnZone || typeof window.RnZone.updateStockData !== 'function') return false;
        return window.RnZone.updateStockData(stock) === true;
      })
      .catch(function () { return false; });
  }

  /** RN존 기본 목록 갱신 — 선택 종목 우선, 나머지는 RN_BATCH 개씩 순차 */
  function refreshRnList(opts) {
    opts = opts || {};
    if (rnRefresh.running) return rnRefresh.promise || Promise.resolve({ skipped: true });
    // 60초 안에 끝난 실측값이 있으면 같은 데이터를 다시 받지 않는다(수동 새로고침은 force:true)
    var quietMs = typeof opts.withinMs === 'number' ? opts.withinMs : 60000;
    if (!opts.force && rnRefresh.lastMs && (Date.now() - rnRefresh.lastMs) < quietMs) {
      return Promise.resolve({ skipped: true, fresh: true, lastAt: rnRefresh.lastAt });
    }
    var all = rnCodes();
    if (!all.length) return Promise.resolve({ ok: 0, fail: 0, total: 0 });

    var selected = window.RnZone && typeof window.RnZone.getSelectedCode === 'function'
      ? window.RnZone.getSelectedCode()
      : null;
    var order = [];
    if (selected && all.indexOf(selected) >= 0) order.push(selected);
    if (!opts.onlySelected) {
      all.forEach(function (c) { if (order.indexOf(c) < 0) order.push(c); });
    }

    rnRefresh.running = true;
    rnRefresh.ok = 0;
    rnRefresh.fail = 0;
    rnRefresh.total = order.length;
    rnStatus('⏳ RN 캔들·RN선 동적 갱신 중… (0/' + order.length + ')', null);

    rnRefresh.promise = new Promise(function (resolve) {
      var i = 0;

      function finish() {
        rnRefresh.running = false;
        rnRefresh.lastAt = nowText();
        rnRefresh.lastMs = Date.now();
        // RN 실측값이 갱신되면 1번 탭 '실전 타점 신호등' 칩도 다시 만든다
        try { if (window.LiveExtra && typeof window.LiveExtra.renderChips === 'function') window.LiveExtra.renderChips(); } catch (e) { /* noop */ }
        if (rnRefresh.fail === 0) {
          rnStatus('⚡ RN 캔들 동적 갱신 ' + rnRefresh.lastAt + ' · ' + rnRefresh.ok + '/' + rnRefresh.total +
            ' 종목 60일봉·현재가·RN선 최신 ( /api/stock-chart )', 'ok');
        } else {
          rnStatus('⚡ RN 캔들 동적 갱신 ' + rnRefresh.lastAt + ' · 성공 ' + rnRefresh.ok + ' · 보류 ' + rnRefresh.fail +
            '/' + rnRefresh.total + ' (보류 종목은 기존 데이터 유지)', 'warn');
        }
        resolve({ ok: rnRefresh.ok, fail: rnRefresh.fail, total: rnRefresh.total, lastAt: rnRefresh.lastAt });
      }

      function nextBatch() {
        if (i >= order.length) { finish(); return; }
        var batch = order.slice(i, i + RN_BATCH);
        i += batch.length;
        var seq = Promise.resolve();
        batch.forEach(function (code) {
          seq = seq
            .then(function () { return refreshStockData(code); })
            .then(function (done) {
              if (done) rnRefresh.ok += 1; else rnRefresh.fail += 1;
              rnStatus('⏳ RN 캔들·RN선 동적 갱신 ' + (rnRefresh.ok + rnRefresh.fail) + '/' + order.length +
                ' · 성공 ' + rnRefresh.ok + ' · 보류 ' + rnRefresh.fail, null);
            })
            .then(function () { return sleep(RN_GAP_MS); });
        });
        seq.then(nextBatch);
      }

      nextBatch();
    });

    return rnRefresh.promise;
  }

  /** RN 탭을 보는 동안 주기적으로 캔들을 최신화한다 */
  function startRnCycle() {
    if (rnRefresh.timer) clearInterval(rnRefresh.timer);
    rnRefresh.timer = setInterval(function () {
      if (!isRnTabVisible()) return;
      refreshRnList();
    }, RN_CYCLE_MS);
  }

  /* -------- 탭 전환·즉시 새로고침에 RN 갱신을 물려 둔다 -------- */
  function patchSwitchView() {
    var orig = window.switchView;
    if (typeof orig !== 'function') return false;
    if (orig.__rnLivePatched) return true;
    var patched = function (view) {
      var out = orig.apply(this, arguments);
      try {
        if (view === 'rnzone') {
          // 방금(60초 이내) 실측 갱신이 끝났으면 같은 데이터를 또 받지 않는다 — 불필요한 API 호출·진행률 0/11 깜빡임 방지
          var justRefreshed = rnRefresh.lastMs && (Date.now() - rnRefresh.lastMs) < 60000;
          if (!justRefreshed) {
            refreshRnList({ onlySelected: true })
              .then(function () { return sleep(700); })
              .then(function () { if (isRnTabVisible()) refreshRnList(); });
          }
        }
      } catch (e) { /* noop */ }
      return out;
    };
    patched.__rnLivePatched = true;
    window.switchView = patched;
    return true;
  }

  function patchForceRefresh() {
    var orig = window.forceLiveRefresh;
    if (typeof orig !== 'function') return false;
    if (orig.__rnForcePatched) return true;
    var patched = function () {
      try {
        poll();
        manjuMap(true);
        if (isRnTabVisible()) refreshRnList({ force: true });
      } catch (e) { /* noop */ }
      return orig.apply(this, arguments);
    };
    patched.__rnForcePatched = true;
    window.forceLiveRefresh = patched;
    return true;
  }

  /* 6번 RN존 + 7번 만쥬 카드 + 8번 종베 카드의 종목코드를 한 번에 폴링한다. */
  function pushCode(out, code) {
    var c = String(code || '').trim();
    if (!/^[0-9A-Z]{6}$/.test(c)) return;
    if (out.indexOf(c) === -1) out.push(c);
  }

  function watchCodes() {
    var codes = [];
    try {
      rnCodes().forEach(function (c) { if (/^\d{6}$/.test(String(c))) pushCode(codes, c); });
    } catch (e) { /* noop */ }
    try {
      if (window.Jongbe && typeof window.Jongbe.getStocks === 'function') {
        (window.Jongbe.getStocks() || []).forEach(function (s) { pushCode(codes, s && s.code); });
      }
    } catch (e) { /* noop */ }
    try {
      manjuCodes().forEach(function (c) { pushCode(codes, c); });
    } catch (e) { /* noop */ }
    return codes.slice(0, 40);
  }

  function poll() {
    if (state.polling) return;
    state.polling = true;
    var codes = watchCodes();
    var url = LIVE_URL + (codes.length ? '?codes=' + codes.join(',') : '');
    var controller = null;
    var timer = null;
    try { controller = new AbortController(); } catch (e) { controller = null; }
    if (controller) {
      timer = setTimeout(function () { try { controller.abort(); } catch (e) { /* noop */ } }, 12000);
    }

    fetch(url, controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null;
          try { json = JSON.parse(text); } catch (e) { json = null; }
          return { status: res.status, body: json };
        });
      })
      .then(function (out) {
        if (timer) clearTimeout(timer);
        state.polling = false;
        var body = out.body;
        if (!body || body.ok !== true) {
          state.ok = false;
          setBadge(false, '⚠️ API 응답 없음 · 내장 데이터 유지');
          return;
        }
        var applied = applyLive(body);
        if (applied > 0) {
          state.ok = true;
          state.lastLiveAt = nowText();
          setBadge(true, '⚡ 동적 LIVE ' + state.lastLiveAt + ' 갱신');
        } else {
          state.ok = false;
          setBadge(false, '⚠️ 갱신 항목 없음 · 내장 데이터 유지');
        }
      })
      .catch(function () {
        if (timer) clearTimeout(timer);
        state.polling = false;
        state.ok = false;
        setBadge(false, '⚠️ API 연결 실패 · 내장 데이터 유지');
      });
  }

  function start() {
    poll();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (document.hidden) return;
      poll();
    }, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) poll();
    });

    // 7·8번 탭 카드 매핑(만쥬)과 RN존 동적 캔들 갱신 준비
    try { manjuMap(false); } catch (e) { /* noop */ }
    var tries = 0;
    var t = setInterval(function () {
      tries += 1;
      var okView = patchSwitchView();
      var okForce = patchForceRefresh();
      if ((okView && okForce) || tries > 20) clearInterval(t);
    }, 250);
    startRnCycle();
    if (isRnTabVisible()) refreshRnList({ onlySelected: true });

    // ⚡ 1번 탭만 보고 있어도 RN존 11종목 실측(60일봉·RN선)을 백그라운드로 받아 둔다.
    //    → 6번 탭을 열지 않아도 1번 탭 상단 '실전 타점 신호등' 칩이 최신 실측치로 만들어진다.
    //    · 화면이 뜬 뒤 조용히 4종목씩 순차 갱신(먼저 도는 갱신이 있으면 끝날 때까지 대기)
    var bgTries = 0;
    var bgTimer = setInterval(function () {
      bgTries += 1;
      if (rnRefresh.running && bgTries < 40) return;
      clearInterval(bgTimer);
      refreshRnList().catch(function () { /* 실패 시 내장 데이터 유지 */ });
    }, 2500);
  }

  /* ------------------ RN존 실시간 종목 조회 (60일봉 + RN) ------------------ */

  function setSearchStatus(text, kind) {
    var el = byId('liveSearchStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = kind === 'err' ? '#fca5a5' : kind === 'ok' ? '#34d399' : kind === 'warn' ? '#fbbf24' : '#94a3b8';
  }

  function toRnStock(json) {
    var raw = json.candles || [];
    var candles = raw.map(function (c, i) {
      var prev = i > 0 ? raw[i - 1].c : c.o;
      var ratio = prev ? ((c.c - prev) / prev) * 100 : 0;
      return {
        date: String(c.date || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        vol: c.v,
        ratio: Number(ratio.toFixed(2))
      };
    });
    if (!candles.length) return null;

    var price = json.current && num(json.current.price) !== null ? json.current.price : candles[candles.length - 1].close;
    price = Math.round(price);
    var rn = json.rn || {};
    var rnBand = rn.band !== undefined && num(rn.band) !== null ? rn.band : null;
    var lower = rn.nearestSupport && num(rn.nearestSupport.level) !== null ? rn.nearestSupport.level : Math.floor(price / 10) * 10;
    var upper = rn.nearestResistance && num(rn.nearestResistance.level) !== null ? rn.nearestResistance.level : Math.ceil(price * 1.1);
    if (!(lower > 0)) lower = Math.floor(price / 10) * 10;
    if (!(upper > lower)) upper = Math.ceil(price * 1.1);
    var buy1 = Math.round(lower * 1.04);
    var buy2 = Math.round(buy1 * 0.8);
    var changePct = json.current && num(json.current.changePct) !== null ? Number(json.current.changePct.toFixed(2)) : Number(candles[candles.length - 1].ratio);

    return {
      name: json.name || json.code,
      code: json.code,
      category: 'search',
      price: price,
      changeRatio: changePct,
      upperRN: Math.round(upper),
      lowerRN: Math.round(lower),
      rnBand: rnBand,
      buy1: buy1,
      buy2: buy2,
      targetMin: Math.round(buy1 * 1.07),
      targetMax: Math.round(buy1 * 1.2),
      candles: candles
    };
  }

  function searchStock() {
    var input = byId('liveStockQuery');
    var q = input ? String(input.value || '').trim() : '';
    if (!q) {
      setSearchStatus('종목명 또는 6자리 코드를 입력해 주세요.', 'warn');
      return;
    }
    if (!window.RnZone || typeof window.RnZone.upsertStock !== 'function') {
      setSearchStatus('차트 엔진을 아직 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.', 'err');
      return;
    }
    setSearchStatus('⏳ ' + q + ' 실시간 조회 중… (60일봉 + RN 지지/저항)', null);

    var controller = null;
    var timer = null;
    try { controller = new AbortController(); } catch (e) { controller = null; }
    if (controller) timer = setTimeout(function () { try { controller.abort(); } catch (e) { /* noop */ } }, 14000);

    fetch(CHART_URL + '?q=' + encodeURIComponent(q), controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null;
          try { json = JSON.parse(text); } catch (e) { json = null; }
          return { status: res.status, body: json };
        });
      })
      .then(function (out) {
        if (timer) clearTimeout(timer);
        var body = out.body;
        if (!body || body.ok !== true) {
          var msg = body && body.message ? body.message : ('조회 실패 (HTTP ' + out.status + ')');
          setSearchStatus('⚠️ ' + msg, 'err');
          return;
        }
        var stock = toRnStock(body);
        if (!stock) {
          setSearchStatus('⚠️ ' + (body.name || q) + ' 일봉 데이터가 비어 있습니다.', 'err');
          return;
        }
        window.RnZone.upsertStock(stock);
        setSearchStatus(
          '🟢 ' + stock.name + ' (' + stock.code + ') · ' + stock.candles.length + '거래일봉 · ' +
          'RN ' + money(stock.lowerRN) + ' ~ ' + money(stock.upperRN) + '원 · ' +
          '1차 ' + money(stock.buy1) + ' / 2차 ' + money(stock.buy2) + '원',
          'ok'
        );
        // 같은 종목의 당일 통합 거래대금까지 한 번 더 받아 카드에 채운다
        fetch(LIVE_URL + '?codes=' + stock.code + '&fresh=1', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j || j.ok !== true) return;
            var map = {};
            (j.stocks || []).forEach(function (s) { if (s && s.code) map[s.code] = { price: num(s.price), changePct: num(s.changePct), valueText: s.valueIntegText || s.valueText || null }; });
            if (Object.keys(map).length && typeof window.RnZone.refreshLivePrices === 'function') window.RnZone.refreshLivePrices(map);
          })
          .catch(function () { /* 대금은 없어도 조회 결과는 그대로 유지 */ });
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        var reason = err && err.name === 'AbortError' ? '응답 시간 초과(14초)' : (err && err.message ? err.message : String(err));
        setSearchStatus('⚠️ 조회 실패: ' + reason + ' — 잠시 후 다시 시도해 주세요.', 'err');
      });
  }

  window.LiveAPI = {
    poll: poll,
    start: start,
    searchStock: searchStock,
    applyLive: applyLive,
    state: state,
    // 동적화 상태·수동 제어 (테스트·디버깅용)
    refreshRnList: refreshRnList,
    refreshStockData: refreshStockData,
    rnState: rnRefresh,
    watchCodes: watchCodes,
    manjuMap: manjuMap,
    applyManjuQuotes: applyManjuQuotes
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start);
  }
})();

/* ============================================================================
 * 📊 종목 상세 모달 — 실시간 일봉·종목코드 연동
 * ----------------------------------------------------------------------------
 *  · openDetail() 은 제목에서 종목을 찾아 500일 캔들 DB(window.DAILY_500_CANDLES)를 쓰는데,
 *    DB에 없는 종목(예: 에이디테크놀로지)은 Math.sin/Math.random 으로 만든 가짜 차트를 그리고
 *    종목코드도 못 찾아(기본값 005930) 네이버/토스 링크가 삼성전자를 가리켰다.
 *  · 그래서 DB에 없는 종목은 /api/stock-chart 로 실시간 일봉·종목코드를 받아 다시 그린다.
 *    · 조회 중에는 가짜 차트 대신 "불러오는 중" 안내, 실패하면 가짜 차트를 만들지 않고 실패 안내
 *    · 받은 종목코드로 btnNaverQuote / btnTossQuote 링크를 즉시 갱신
 *  · DB에 실제 500일 치가 있는 종목·지수는 기존 엔진을 그대로 둔다(링크 코드만 보정).
 * ==========================================================================*/
(function () {
  'use strict';

  var CHART_URL = '/api/stock-chart';
  var state = { reqId: 0 };

  function $(id) { return document.getElementById(id); }

  /** 모당 제목 → 종목명 (코드·이모지·등락률·금액 알맹이 제거) */
  function cleanName(title) {
    return String(title || '')
      .replace(/\((\d{6})\)/g, ' ')
      .replace(/[★☆👑🎯🏆⚡☣🔥🔎📊📈📉]/g, ' ')
      .replace(/상한가|상한가임박|대장주|대장|수혜주|수혜|원탑|경보|돌파|안착|임박|신고가/g, ' ')
      .replace(/\d{1,3}(,\d{3})*(\.\d+)?\s*원/g, ' ')
      .replace(/[+\-]?\d+(\.\d+)?\s*%/g, ' ')
      .replace(/[\s,·|]+/g, ' ')
      .trim();
  }

  function codeFromTitle(title) {
    var m = String(title || '').match(/(?:^|[^\d])(\d{6})(?:[^\d]|$)/);
    return m ? m[1] : null;
  }

  /** 원본 renderUniversalModalChart 와 같은 순서로 "실제 500일 DB가 있는지" 먼저 확인한다 */
  function dbSeriesName(title, name) {
    var db = window.DAILY_500_CANDLES || {};
    var codes = window.stockCodes || {};
    var cleanTitle = String(title || '')
      .replace(/[★👑🎯🏆⚡\[\]()0-9.,%+원]/g, '')
      .replace(/상한가|대장|수혜|원탑|상|주의|경보|돌파|안착/g, '')
      .trim();
    var n;
    if (cleanTitle && db[cleanTitle]) return cleanTitle;
    if (title && db[title]) return title;
    for (n in codes) {
      if (
        (cleanTitle && (cleanTitle.indexOf(n) !== -1 || n.indexOf(cleanTitle) !== -1)) ||
        (title && (title.indexOf(n) !== -1 || n.indexOf(title) !== -1))
      ) {
        if (db[codes[n]]) return codes[n];
        if (db[n]) return n;
      }
    }
    if (name && db[name]) return name;
    for (var sName in db) {
      if (name && (name.indexOf(sName) !== -1 || sName.indexOf(name) !== -1)) return sName;
    }
    return null;
  }

  function knownCode(name, title) {
    var codes = window.stockCodes || {};
    if (name && codes[name]) return codes[name];
    for (var n in codes) {
      if (title && String(title).indexOf(n) !== -1) return codes[n];
      if (name && (name.indexOf(n) !== -1 || n.indexOf(name) !== -1)) return codes[n];
    }
    return null;
  }

  function setLinks(code) {
    if (!code) return;
    var nv = $('btnNaverQuote');
    var ts = $('btnTossQuote');
    if (nv) {
      nv.href = 'https://m.stock.naver.com/item/' + encodeURIComponent(code);
      nv.textContent = '📊 네이버 증권 실시간 호가창';
      nv.setAttribute('data-code', code);
      nv.style.opacity = '1';
    }
    if (ts) {
      ts.href = 'https://tossinvest.com/stocks/' + encodeURIComponent(code);
      ts.textContent = '📱 토스증권 실시간 차트';
      ts.setAttribute('data-code', code);
      ts.style.opacity = '1';
    }
  }

  /** 종목코드 확인 전 — 잘못된 기본 링크(005930)로 이동하는 일을 막는다 */
  function markLinksPending() {
    var nv = $('btnNaverQuote');
    var ts = $('btnTossQuote');
    if (nv) {
      nv.setAttribute('href', '#');
      nv.removeAttribute('data-code');
      nv.textContent = '⏳ 종목코드 확인 중…';
      nv.style.opacity = '0.55';
    }
    if (ts) {
      ts.setAttribute('href', '#');
      ts.removeAttribute('data-code');
      ts.textContent = '⏳ 종목코드 확인 중…';
      ts.style.opacity = '0.55';
    }
  }

  function markLinksFailed(name) {
    var nv = $('btnNaverQuote');
    var ts = $('btnTossQuote');
    var q = encodeURIComponent(name || '');
    if (nv) {
      nv.href = 'https://m.stock.naver.com/search?q=' + q;
      nv.textContent = '🔎 네이버 증권에서 검색';
      nv.style.opacity = '1';
    }
    if (ts) {
      ts.href = 'https://tossinvest.com/'; 
      ts.textContent = '📱 토스증권';
      ts.style.opacity = '1';
    }
  }

  function showNotice(text, color) {
    var wrap = $('modalCandleCanvasWrap');
    if (!wrap) return;
    var el = $('modalChartNotice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'modalChartNotice';
      el.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center; ' +
        'text-align:center; font-size:12px; font-weight:800; padding:10px; background:rgba(7,12,20,0.92); border-radius:6px; z-index:3;';
      wrap.appendChild(el);
    }
    el.style.color = color || '#94a3b8';
    el.textContent = text;
    el.style.display = 'flex';
  }

  function hideNotice() {
    var el = $('modalChartNotice');
    if (el) el.style.display = 'none';
  }

  function setTrend(text, color) {
    var el = $('modalChartTrend');
    if (!el) return;
    el.textContent = text;
    if (color) el.style.color = color;
  }

  /** DB에 없는 종목 → 실시간 일봉으로 모달 차트를 다시 그린다 */
  function loadLiveChart(title, code) {
    state.reqId += 1;
    var reqId = state.reqId;
    var name = cleanName(title);
    var query = code || name;
    if (!query) {
      showNotice('종목을 해석하지 못했습니다. 종목명을 확인해 주세요.', '#fca5a5');
      setTrend('데이터 없음', '#fca5a5');
      return;
    }

    // 가짜 차트가 남아 있으면 지운 뒤 로딩 안내를 띄운다
    window.modalAllCandles = [];
    window.modalViewCount = 60;
    window.modalViewOffset = 0;
    try { if (typeof window.drawModalCandles === 'function') window.drawModalCandles(); } catch (e) { /* noop */ }
    showNotice('⏳ ' + (name || code) + ' 실시간 일봉 불러오는 중…', '#7dd3fc');
    setTrend('실시간 조회 중…', '#7dd3fc');
    markLinksPending();

    var controller = null;
    var timer = null;
    try { controller = new AbortController(); } catch (e) { controller = null; }
    if (controller) timer = setTimeout(function () { try { controller.abort(); } catch (e) { /* noop */ } }, 14000);

    fetch(CHART_URL + '?q=' + encodeURIComponent(query) + '&count=250',
      controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null;
          try { json = JSON.parse(text); } catch (e) { json = null; }
          return { status: res.status, body: json };
        });
      })
      .then(function (out) {
        if (timer) clearTimeout(timer);
        if (reqId !== state.reqId) return;
        var body = out.body;
        if (!body || body.ok !== true) {
          var msg = body && body.message ? body.message : ('차트 데이터를 받지 못했습니다 (HTTP ' + out.status + ')');
          showNotice('⚠️ ' + msg + '\n가짜 차트를 대신 그리지 않습니다. 잠시 후 다시 눌러 주세요.', '#fca5a5');
          setTrend('실시간 데이터 없음', '#fca5a5');
          markLinksFailed(name);
          return;
        }
        var candles = (body.candles || []).map(function (c) {
          return { date: c.date, open: c.o, high: c.h, low: c.l, close: c.c, vol: c.v };
        });
        if (!candles.length) {
          showNotice('⚠️ ' + (body.name || name) + ' 일봉 데이터가 비어 있습니다.', '#fca5a5');
          setTrend('데이터 없음', '#fca5a5');
          return;
        }

        window.modalAllCandles = candles;
        window.modalViewCount = Math.min(60, candles.length);
        window.modalViewOffset = 0;
        // 종목 차트의 최고/최저는 '원' 단위 (지수 모달의 pt/$ 단위가 남아 있지 않게)
        if (typeof window.setModalValueUnit === 'function') window.setModalValueUnit('원', 0);

        setLinks(body.code);
        hideNotice();

        var last = candles[candles.length - 1];
        var first = candles[0];
        var up = last.close >= first.close;
        setTrend(
          '실시간 일봉 ' + candles.length + '봉 · ' + last.date + ' 종가 ' +
            Math.round(last.close).toLocaleString('ko-KR') + '원 (' + (up ? '우상향 🎯' : '조정·눌림') + ')',
          up ? '#4ade80' : '#fbbf24'
        );
        var hi = Math.max.apply(null, candles.map(function (c) { return c.high; }));
        var lo = Math.min.apply(null, candles.map(function (c) { return c.low; }));
        if ($('modalChartHigh')) $('modalChartHigh').textContent = Math.round(hi).toLocaleString('ko-KR') + '원';
        if ($('modalChartLow')) $('modalChartLow').textContent = Math.round(lo).toLocaleString('ko-KR') + '원';
        if ($('modalChartTitleTxt')) $('modalChartTitleTxt').textContent = '📊 실시간 일봉 ' + candles.length + '봉 (네이버 fchart·동적 API)';

        try { if (typeof window.setupModalCanvasInteraction === 'function') window.setupModalCanvasInteraction(); } catch (e) { /* noop */ }
        try { if (typeof window.drawModalCandles === 'function') window.drawModalCandles(); } catch (e) { /* noop */ }
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        if (reqId !== state.reqId) return;
        var reason = err && err.name === 'AbortError' ? '응답 시간 초과(14초)' : (err && err.message ? err.message : String(err));
        showNotice('⚠️ 실시간 일봉 조회 살패: ' + reason, '#fca5a5');
        setTrend('실시간 데이터 없음', '#fca5a5');
        markLinksFailed(name);
      });
  }

  /* ---------------- 기존 엔진 래핑 ---------------- */

  function patchRender() {
    var orig = window.renderUniversalModalChart;
    if (typeof orig !== 'function') return false;
    if (orig.__liveModalPatched) return true;
    var patched = function (seriesKey, title) {
      if (seriesKey) return orig.apply(this, arguments); // 지수·수급 시리즈는 기존 엔진 그대로
      var name = cleanName(title);
      var code = codeFromTitle(title);
      if (dbSeriesName(title, name)) {
        hideNotice();
        var titleTxt = document.getElementById('modalChartTitleTxt');
        if (titleTxt) titleTxt.textContent = '📊 1~2년 실시간 캔들 & 추세선 차트';
        var out = orig.apply(this, arguments);
        var known = code || knownCode(name, title);
        if (known) setLinks(known);
        else markLinksPending();
        return out;
      }
      loadLiveChart(title, code);
      return undefined;
    };
    patched.__liveModalPatched = true;
    window.renderUniversalModalChart = patched;
    return true;
  }

  function patchOpenDetail() {
    var orig = window.openDetail;
    if (typeof orig !== 'function') return false;
    if (orig.__liveDetailPatched) return true;
    var patched = function (title) {
      var out = orig.apply(this, arguments);
      try {
        // openDetail 은 종목을 못 찾으면 링크를 삼성전자(005930)로 두므로 즉시 정정/보류 처리
        var name = cleanName(title);
        var code = codeFromTitle(title) || knownCode(name, title);
        if (code) setLinks(code);
        else markLinksPending();
      } catch (e) { /* noop */ }
      return out;
    };
    patched.__liveDetailPatched = true;
    window.openDetail = patched;
    return true;
  }

  function boot() {
    var tries = 0;
    var t = setInterval(function () {
      tries += 1;
      var a = patchRender();
      var b = patchOpenDetail();
      if ((a && b) || tries > 24) clearInterval(t);
    }, 250);
  }

  window.ModuleLiveChart = { load: loadLiveChart, cleanName: cleanName, state: state };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

/* ============================================================================
 * ⚡ 클릭 순간 실시간 브리핑  (/api/live-briefing)
 * ----------------------------------------------------------------------------
 *  · 상단 "⚡ 실시간 브리핑" 버튼 → openLiveBriefingModal() 를 감싸서
 *      ① 최상단에 "⚡ 지금 이 순간 실시간 팩트 브리핑 (HH:MM:SS)" 섹션을 즉시 렌더
 *      ② 모달 안에 "🔄 방금 시점으로 다시 브리핑" 버튼(?fresh=1 재호출)
 *      ③ 그 아래에 기존 정시(평일 14회) AI 심층 브리핑 전문을 그대로 보존
 *  · API 가 죽어도 기존 심층 브리핑 전문은 그대로 보인다.
 *  · 확인된 수치만 표시한다 — 응답에 없는 값은 '—' 로 두고 문장을 지어내지 않는다.
 * ==========================================================================*/
(function () {
  'use strict';

  var API_URL = '/api/live-briefing';
  var state = {
    deepHtml: null,
    loading: false,
    reqId: 0,
    lastBody: null
  };

  function $(id) { return document.getElementById(id); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n, maxd, mind) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return n.toLocaleString('ko-KR', {
      maximumFractionDigits: maxd === undefined ? 2 : maxd,
      minimumFractionDigits: mind === undefined ? 0 : mind
    });
  }
  function pct(p) {
    if (typeof p !== 'number' || !isFinite(p)) return '—';
    return (p > 0 ? '+' : '') + p.toFixed(2) + '%';
  }
  function col(p) {
    if (typeof p !== 'number' || !isFinite(p) || p === 0) return '#e2e8f0';
    return p > 0 ? '#f43f5e' : '#38bdf8';
  }
  function nowHms() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* ------------------------------ 카드 렌더러 ------------------------------ */

  function card(label, value, changePct, sub) {
    return '' +
      '<div style="background:#111827; padding:8px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.08);">' +
        '<div style="font-size:10.5px; color:#94a3b8;">' + esc(label) + '</div>' +
        '<div style="font-size:14px; font-weight:800; color:' + col(changePct) + '; margin-top:2px;">' +
          value +
          ' <span style="font-size:11px; font-weight:800;">' + esc(pct(changePct)) + '</span>' +
        '</div>' +
        (sub ? '<div style="font-size:10px; color:#64748b; margin-top:2px;">' + sub + '</div>' : '') +
      '</div>';
  }

  function renderFacts(j) {
    var cards = [];

    (j.indices || []).forEach(function (i) {
      cards.push(card(
        '📊 ' + (i.name || i.key) + (i.status === 'CLOSE' ? ' (종가)' : ''),
        '<span>' + esc(num(i.price, 2, 2)) + '</span>',
        i.changePct,
        (i.valueText ? '거래대금 ' + esc(i.valueText) : '') +
          (typeof i.change === 'number' ? (i.valueText ? ' · ' : '') + esc(num(i.change, 2)) + 'p' : '')
      ));
    });

    (j.futures || []).forEach(function (f) {
      cards.push(card(
        '🌎 ' + (f.name || f.symbol),
        '<span>' + esc(num(f.price, 2, 2)) + '</span>',
        f.changePct,
        (f.asOfKst ? '기준 ' + esc(f.asOfKst) : '') + ' · Yahoo Finance'
      ));
    });

    if (j.fx) {
      cards.push(card(
        '💱 ' + (j.fx.name || '원/달러'),
        '<span>' + esc(num(j.fx.price, 2, 2)) + '원</span>',
        j.fx.changePct,
        (j.fx.tradedDate ? '고시 ' + esc(j.fx.tradedDate) : '') +
          (typeof j.fx.change === 'number' ? ' · ' + esc(num(j.fx.change, 2)) + '원' : '')
      ));
    }

    var movers = (j.topMovers || []).map(function (s) {
      return '' +
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:5px 0; border-bottom:1px dashed rgba(255,255,255,0.07);">' +
          '<div style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' +
            '<span style="font-size:9.5px; font-weight:800; padding:1px 5px; border-radius:3px; ' +
              (s.tag === '급등'
                ? 'background:rgba(244,63,94,0.18); color:#fda4af;'
                : 'background:rgba(56,189,248,0.16); color:#7dd3fc;') + '">' + esc(s.tag || '') + '</span> ' +
            '<strong style="color:#f1f5f9; font-size:11.5px;">' + esc(s.name) + '</strong> ' +
            '<span style="font-size:9.5px; color:#64748b;">' + esc(s.code || '') + (s.market ? ' · ' + esc(s.market) : '') + '</span>' +
          '</div>' +
          '<div style="text-align:right; white-space:nowrap;">' +
            '<span style="font-size:11.5px; font-weight:800; color:' + col(s.changePct) + ';">' + esc(num(s.price, 2)) + '</span> ' +
            '<span style="font-size:10.5px; font-weight:800; color:' + col(s.changePct) + ';">' + esc(pct(s.changePct)) + '</span>' +
            '<span style="font-size:9.5px; color:#64748b; margin-left:6px;">' + esc(s.valueText || '—') + '</span>' +
          '</div>' +
        '</div>';
    }).join('');

    var news = (j.news || []).map(function (n, idx) {
      var head = '<span style="color:#475569; font-weight:800; margin-right:5px;">' + (idx + 1) + '</span>' +
        (n.time ? '<span style="color:#7dd3fc; font-weight:800; margin-right:5px;">' + esc(n.time) + '</span>' : '') +
        (n.press ? '<span style="color:#64748b; margin-right:5px;">[' + esc(n.press) + ']</span>' : '');
      var body = esc(n.title);
      var line = n.url
        ? '<a href="' + esc(n.url) + '" target="_blank" rel="noopener" style="color:#e2e8f0; text-decoration:none;">' + body + '</a>'
        : '<span style="color:#e2e8f0;">' + body + '</span>';
      return '<div style="padding:4px 0; border-bottom:1px dashed rgba(255,255,255,0.06); font-size:11px; line-height:1.5;">' + head + line + '</div>';
    }).join('');

    var okCount = (j.sources || []).filter(function (s) { return s.ok; }).length;
    var totalCount = (j.sources || []).length;
    var warn = '';
    if (j.partial && (j.errors || []).length) {
      warn = '<div style="margin-top:8px; font-size:10px; color:#fbbf24; line-height:1.5;">⚠️ 일부 소스 실패: ' +
        esc((j.errors || []).slice(0, 3).join(' · ')) + '</div>';
    }
    var notes = (j.notes || []).map(function (n) {
      return '<div style="font-size:10px; color:#94a3b8; margin-top:4px;">※ ' + esc(n) + '</div>';
    }).join('');

    return '' +
      (j.headline
        ? '<div style="background:#0b1220; border:1px solid rgba(56,189,248,0.35); border-radius:6px; padding:8px 10px; margin-bottom:8px; font-size:12px; font-weight:800; color:#e0f2fe; line-height:1.5;">' + esc(j.headline) + '</div>'
        : '') +
      '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:8px;">' + cards.join('') + '</div>' +
      (movers
        ? '<div style="margin-top:12px;">' +
            '<div style="font-size:11.5px; font-weight:800; color:#fda4af; margin-bottom:4px;">🔥 실시간 급등 · 거래대금 상위 (최대 6)</div>' +
            movers +
          '</div>'
        : '') +
      (news
        ? '<div style="margin-top:12px;">' +
            '<div style="font-size:11.5px; font-weight:800; color:#7dd3fc; margin-bottom:4px;">📰 최신 증시 뉴스 5건</div>' +
            news +
          '</div>'
        : '') +
      notes +
      warn +
      '<div style="margin-top:10px; font-size:10px; color:#64748b; line-height:1.5;">' +
        '수집 ' + esc(j.generatedAtLabel || j.generatedAtKst || '') +
        ' · 응답 ' + esc(String(j.elapsedMs || 0)) + 'ms' +
        ' · 소스 ' + esc(String(okCount)) + '/' + esc(String(totalCount)) + ' 정상' +
        '<br>출처: 네이버 금융(지수·종목·뉴스) / Yahoo Finance(해외선물)' +
        (j.dataBasis && j.dataBasis.tradingDate ? ' · 국내 기준일 ' + esc(j.dataBasis.tradingDateLabel || j.dataBasis.tradingDate) : '') +
      '</div>';
  }

  /* -------------------------------- 스켈레톤 -------------------------------- */

  function skeletonHtml() {
    return '' +
      '<div id="lbLiveSection" style="background:linear-gradient(90deg, rgba(2,132,199,0.16) 0%, rgba(16,185,129,0.12) 100%); border:1px solid #38bdf8; border-radius:8px; padding:12px 14px; margin-bottom:14px;">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">' +
          '<div id="lbLiveTitle" style="font-size:13.5px; font-weight:800; color:#7dd3fc;">⚡ 지금 이 순간 실시간 팩트 브리핑 (--:--:--)</div>' +
          '<button type="button" id="lbRefreshBtn" class="btn-action" style="font-size:11px; padding:5px 12px; background:rgba(56,189,248,0.2); color:#7dd3fc; border:1px solid #38bdf8; border-radius:5px; font-weight:800; cursor:pointer;">🔄 방금 시점으로 다시 브리핑</button>' +
        '</div>' +
        '<div id="lbLiveMeta" style="font-size:10.5px; color:#94a3b8; margin-top:3px;">실시간 팩트 수집 준비…</div>' +
        '<div id="lbLiveBody" style="margin-top:10px; font-size:11.5px; color:#cbd5e1; line-height:1.55;">⏳ 실시간 데이터 수집 중…</div>' +
      '</div>' +
      '<div style="display:flex; align-items:center; gap:8px; margin:0 0 8px 2px;">' +
        '<span style="font-size:11px; font-weight:800; color:#fbbf24;">📋 정시 AI 심층 브리핑 전문</span>' +
        '<span style="font-size:9.5px; color:#64748b;">직전 정시(평일 14회) 브리핑 스냅샷 — 위 실시간 팩트와 시점이 다를 수 있습니다</span>' +
      '</div>';
  }

  /* -------------------------------- API 호출 -------------------------------- */

  function setBusy(busy) {
    var btn = $('lbRefreshBtn');
    if (!btn) return;
    btn.disabled = !!busy;
    btn.style.opacity = busy ? '0.55' : '1';
    btn.textContent = busy ? '⏳ 다시 브리핑 중…' : '🔄 방금 시점으로 다시 브리핑';
  }

  function load(fresh) {
    var bodyEl = $('lbLiveBody');
    var metaEl = $('lbLiveMeta');
    if (!bodyEl) return;

    state.reqId += 1;
    var reqId = state.reqId;
    state.loading = true;
    setBusy(true);
    bodyEl.innerHTML = '⏳ ' + (fresh ? '방금 시점' : '현재 시점') + ' 실시간 데이터 수집 중…';
    if (metaEl) metaEl.textContent = 'API /api/live-briefing 호출 중…';

    var controller = null;
    var timer = null;
    try { controller = new AbortController(); } catch (e) { controller = null; }
    if (controller) timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, 14000);

    fetch(API_URL + (fresh ? '?fresh=1' : ''), controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null;
          try { json = JSON.parse(text); } catch (e) { json = null; }
          return { status: res.status, body: json };
        });
      })
      .then(function (out) {
        if (timer) clearTimeout(timer);
        if (reqId !== state.reqId) return;
        state.loading = false;
        setBusy(false);

        var j = out.body;
        if (!j || j.ok !== true) {
          var msg = (j && j.message) ? j.message : ('실시간 브리핑 API 응답 없음 (HTTP ' + out.status + ')');
          bodyEl.innerHTML = '<div style="color:#fca5a5; font-size:11.5px; font-weight:800;">⚠️ ' + esc(msg) + '</div>' +
            '<div style="color:#94a3b8; font-size:10.5px; margin-top:4px;">아래 정시 심층 브리핑 전문은 그대로 볼 수 있습니다. 잠시 후 🔄 버튼으로 다시 시도해 주세요.</div>' +
            ((j && j.errors && j.errors.length) ? '<div style="color:#64748b; font-size:10px; margin-top:4px;">' + esc(j.errors.join(' · ')) + '</div>' : '');
          if (metaEl) metaEl.textContent = '실시간 수집 실패 · ' + nowHms();
          return;
        }

        state.lastBody = j;
        var titleEl = $('lbLiveTitle');
        if (titleEl) {
          titleEl.textContent = '⚡ 지금 이 순간 실시간 팩트 브리핑 (' + (j.generatedAtKst || nowHms()) + ')';
        }

        if (metaEl) {
          metaEl.textContent = (j.generatedAtLabel || '') + ' · ' + (j.marketPhaseLabel || j.marketPhase || '') +
            (j.partial ? ' · 일부 소스 실패' : ' · 실시간 수집 완료');
        }
        bodyEl.innerHTML = renderFacts(j);
        console.log('[LiveBriefing] ' + (j.generatedAtKst || '') + ' ' + (j.marketPhase || '') +
          ' indices=' + (j.indices || []).length + ' movers=' + (j.topMovers || []).length +
          ' news=' + (j.news || []).length + ' errors=' + (j.errors || []).length);
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        if (reqId !== state.reqId) return;
        state.loading = false;
        setBusy(false);
        var reason = err && err.name === 'AbortError' ? '응답 시간 초과(14초)' : (err && err.message ? err.message : String(err));
        bodyEl.innerHTML = '<div style="color:#fca5a5; font-size:11.5px; font-weight:800;">⚠️ 실시간 브리핑 호출 실패: ' + esc(reason) + '</div>' +
          '<div style="color:#94a3b8; font-size:10.5px; margin-top:4px;">네트워크 상태를 확인한 뒤 🔄 버튼으로 다시 시도해 주세요.</div>';
        if (metaEl) metaEl.textContent = '실시간 수집 실패 · ' + nowHms();
      });
  }

  /* --------------------- 기존 실시간 브리핑 모달 감싸기 --------------------- */

  function patchModal() {
    var orig = window.openLiveBriefingModal;
    if (typeof orig !== 'function') return false;
    if (orig.__lbPatched) return true;

    var patched = function () {
      var bodyEl = $('liveModalBody');
      var modal = $('liveBriefingModal');
      var titleEl = $('liveModalTitle');
      var timeEl = $('liveBriefingTime');

      // ① 기존 정시 심층 브리핑 전문은 최초 1회만 렌더해 보관한다.
      if (bodyEl && state.deepHtml === null) {
        try {
          orig();
          state.deepHtml = bodyEl.innerHTML;
        } catch (e) {
          console.warn('[LiveBriefing] 심층 브리핑 렌더 실패', e);
        }
      }

      var deep = state.deepHtml && state.deepHtml.length > 50
        ? state.deepHtml
        : '<div style="color:#94a3b8; font-size:11.5px;">정시 AI 심층 브리핑 전문을 불러오지 못했습니다. 상단의 ⚡ 실시간 팩트 브리핑을 참고해 주세요.</div>';

      // 실시간 팩트(위)와 정시 전문 스냅샷(아래)의 시점이 다르다 — 경계를 화면에 적는다
      var sep = '<div style="margin:14px 0 8px 0; padding:6px 10px; border-radius:6px; background:rgba(148,163,184,0.10); ' +
        'border:1px dashed rgba(148,163,184,0.35); font-size:10.5px; color:#cbd5e1; font-weight:800;">' +
        '▼ 아래는 <span style="color:#fbbf24;">정시 브리핑 전문 스냅샷</span>입니다 — 위의 실시간 팩트와 시점이 달라 지수·선물 방향이 다를 수 있습니다.' +
        '</div>';
      if (bodyEl) bodyEl.innerHTML = skeletonHtml() + sep + deep;
      if (titleEl) titleEl.textContent = '⚡ 실시간 브리핑 — 지금 이 순간 팩트 + 정시 심층 전문';
      if (timeEl) timeEl.textContent = '클릭 순간 실시간 팩트 · ' + nowHms() + ' KST';
      if (modal) modal.style.display = 'flex';

      var btn = $('lbRefreshBtn');
      if (btn) btn.onclick = function () { load(true); };

      load(false);
    };
    patched.__lbPatched = true;
    window.openLiveBriefingModal = patched;
    return true;
  }

  function boot() {
    if (!patchModal()) {
      // 인라인 스크립트가 아직 준비되지 않은 경우를 대비해 몇 번 더 시도한다.
      var tries = 0;
      var t = setInterval(function () {
        tries += 1;
        if (patchModal() || tries > 20) clearInterval(t);
      }, 250);
    }
  }

  window.LiveBriefing = {
    load: load,
    open: function () { if (typeof window.openLiveBriefingModal === 'function') window.openLiveBriefingModal(); },
    state: state
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
/* ============================================================================
 * ⚡ 1·3·5번 탭 실시간 API 연동  (/api/tabs-live)
 * ----------------------------------------------------------------------------
 *  · 페이지 로드 직후 + 30초마다 + 상단 🔄 즉시 새로고침 시  /api/tabs-live 호출
 *
 *   [1번 메인 탭]
 *     - 8대 테마 32종목 카드: 종가(현재가)·등락률·시/고/저·거래대금 실시간 갱신
 *       + 테마 헤더의 평균 등락률 / 합산 거래대금 갱신
 *     - 52주 신고가 돌파 카드 영역 재구축(대금순 · 당일 고가 기준)
 *     - 거래대금 100억+ 진성 상한가 / +25% 임박 / 관찰 후보 / 제외(100억 미만) 재구축
 *   [3번 애프터마켓 · 5번 시간별 뉴스 탭]
 *     - 탭 상단에 "실시간 최신 증시 속보 12건" 리스트를 실시간 렌더
 *       (기존 스타일·과거 유사사례 섹션은 그대로 보존)
 *
 *  · 원칙: API 가 실패하면 화면을 지우지 않는다. 내장(정적) 데이터를 그대로 유지하고
 *    배지만 '⚠️ 1·3·5탭 API 실패' 로 바꾼다. 확인된 응답값만 표시하고 없는 값은 '—'.
 * ==========================================================================*/
(function () {
  'use strict';

  var TABS_URL = '/api/tabs-live';
  var POLL_MS = 30000;

  var state = {
    polling: false,
    ok: null,
    timer: null,
    lastAt: null,
    lastBody: null,
    applied: 0,
    mounted: { news: false, after: false, afterTop: false },
    sessionPhase: null,
    reqId: 0
  };

  /* ------------------------------ 포맷 유틸 ------------------------------ */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fmt(n) { return isNum(n) ? Math.round(n).toLocaleString('ko-KR') : '—'; }
  function fmt2(n) {
    return isNum(n) ? n.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—';
  }
  function pctTxt(p) {
    if (!isNum(p)) return '—';
    return (p > 0 ? '+' : '') + p.toFixed(2) + '%';
  }
  function colFor(p) {
    if (!isNum(p) || p === 0) return '#e2e8f0';
    return p > 0 ? '#f43f5e' : '#38bdf8';
  }
  function nowHms() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function norm(s) {
    return String(s || '').replace(/[★☆\s\u00a0]/g, '').replace(/[()]/g, '').toUpperCase();
  }

  /* ------------------------------ 상태 배지 ------------------------------ */

  function badgeHost() {
    return $('.srb-right') || $('.session-radar-bar');
  }

  function ensureBadge() {
    var existing = document.getElementById('tabsLiveBadge');
    if (existing) return existing;
    var host = badgeHost();
    if (!host) return null;
    var el = document.createElement('span');
    el.id = 'tabsLiveBadge';
    el.style.cssText = 'padding:3px 8px; font-size:10.5px; font-weight:800; border-radius:4px; ' +
      'background:rgba(16,185,129,0.15); color:#34d399; border:1px solid rgba(16,185,129,0.35); white-space:nowrap;';
    el.textContent = '⚡ 1·3·5탭 연결 중…';
    // '최근 갱신' 텍스트 바로 앞(왼쪽)에 넣어 레이더 바 오른쪽 잘림에 가리지 않게 한다.
    var anchor = document.getElementById('lastSyncTxt');
    if (anchor && anchor.parentNode === host) host.insertBefore(el, anchor);
    else host.appendChild(el);
    return el;
  }

  function setBadge(ok, text) {
    var el = ensureBadge();
    if (!el) return;
    el.textContent = text;
    if (ok === true) {
      el.style.background = 'rgba(16,185,129,0.15)';
      el.style.color = '#34d399';
      el.style.borderColor = 'rgba(16,185,129,0.35)';
    } else if (ok === false) {
      el.style.background = 'rgba(245,158,11,0.15)';
      el.style.color = '#fbbf24';
      el.style.borderColor = 'rgba(245,158,11,0.4)';
    } else {
      el.style.background = 'rgba(148,163,184,0.15)';
      el.style.color = '#94a3b8';
      el.style.borderColor = 'rgba(148,163,184,0.35)';
    }
  }

  /* --------------------- openDetail(...) onclick 재작성 --------------------- */

  function parseCallArgs(str) {
    var s = String(str || '').trim();
    var m = s.match(/^openDetail\(([\s\S]*)\);?$/);
    if (!m) return null;
    var body = m[1];
    var args = [];
    var cur = '';
    var quote = null;
    for (var i = 0; i < body.length; i += 1) {
      var ch = body.charAt(i);
      if (quote) {
        if (ch === quote) quote = null;
        else cur += ch;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === ',') {
        args.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    args.push(cur);
    return args.map(function (a) { return a.trim(); });
  }

  function buildOnclick(name, changeText, metaText, reason) {
    var clean = function (v) { return String(v === undefined || v === null ? '' : v).replace(/'/g, ''); };
    return "openDetail('" + clean(name) + "', '" + clean(changeText) + "', '" + clean(metaText) + "', '" + clean(reason) + "')";
  }

  function refreshTileOnclick(tile, name, changeText, metaText) {
    var cur = tile.getAttribute('onclick');
    if (!cur) return;
    var args = parseCallArgs(cur);
    if (!args || args.length < 2) return;
    var reason = args.length > 3 ? args[3] : (args[2] || '');
    var next = buildOnclick(name, changeText, metaText, reason);
    tile.setAttribute('onclick', next);
  }

  /* --------------------------- [1탭] 테마 타일 --------------------------- */

  function themeBlocks() {
    return $$('#tabOverview .theme-grid-8 .theme-block');
  }

  function findThemeBlock(theme, index) {
    var blocks = themeBlocks();
    if (!blocks.length) return null;
    var kw = norm(theme.keyword || '');
    for (var i = 0; i < blocks.length; i += 1) {
      var nameEl = blocks[i].querySelector('.theme-name');
      if (!nameEl) continue;
      var nm = norm(nameEl.textContent);
      if (kw && nm.indexOf(kw) >= 0) return blocks[i];
    }
    var byIndex = blocks[(theme.rank || index + 1) - 1] || blocks[index] || null;
    return byIndex;
  }

  function applyTile(tile, stock) {
    if (!tile || !stock) return 0;
    var hits = 0;

    // 프리마켓(08:00~08:50)에는 정규장 등락률이 0.00%로 내려온다 — 실제 체결(overPct)을 우선한다.
    var live = isNum(stock.livePct);
    var pctVal = live ? stock.livePct : stock.changePct;
    var priceVal = live && isNum(stock.livePrice) ? stock.livePrice : stock.price;

    var changeEl = tile.querySelector('.st-change');
    if (changeEl && isNum(pctVal)) {
      changeEl.textContent = pctTxt(pctVal) + (live ? ' 프' : '');
      changeEl.title = live ? 'NXT 프리마켓 체결가 기준 (전일 종가 대비)' : '';
      changeEl.style.color = colFor(pctVal);
      hits += 1;
    }

    var ohlcEl = tile.querySelector('.st-ohlc');
    if (ohlcEl && isNum(priceVal)) {
      ohlcEl.innerHTML =
        (live ? '프' : '종') + ' <strong>' + esc(fmt(priceVal)) + '</strong> | 시 ' + esc(fmt(stock.open)) +
        ' 고 ' + esc(fmt(stock.high)) + ' 저 ' + esc(fmt(stock.low));
      hits += 1;
    }

    var volEl = tile.querySelector('.st-vol');
    if (volEl && stock.valueText) {
      volEl.textContent = stock.valueText;
      volEl.title = '거래대금 ' + stock.valueText + ' (' + (stock.valueBasis || '통합') + ')';
      hits += 1;
    }

    if (isNum(priceVal)) {
      var nameEl = tile.querySelector('.st-name');
      var shownName = nameEl ? nameEl.textContent.replace(/[★☆\s]/g, '') : (stock.tileName || stock.name);
      refreshTileOnclick(
        tile,
        shownName,
        pctTxt(pctVal),
        '대금 ' + (stock.valueText || '—') + ' | 현재가 ' + fmt(priceVal) + '원'
      );
    }

    if (stock.upperLimit) tile.setAttribute('data-live-upper', '1');
    else tile.removeAttribute('data-live-upper');
    tile.setAttribute('data-live', '1');
    return hits;
  }

  function applyTheme(theme, block) {
    if (!block) return 0;
    var avgEl = block.querySelector('.theme-avg');
    if (avgEl) {
      // 프리마켓에는 정규장 등락률이 0.00%로 오므로 실측 프리마켓 평균(avgPctLive)만 쓴다.
      //  절반 이상 체결된 테마가 아니면 값을 만들지 않고 '—' 로 둔다(0.00% 표기 금지).
      var prePhase = state.sessionPhase === '프리마켓';
      var useLive = prePhase && isNum(theme.avgPctLive);
      var avgVal = useLive ? theme.avgPctLive : prePhase ? null : theme.avgPct;
      avgEl.style.color = avgVal === null ? '#94a3b8' : colFor(avgVal);
      avgEl.innerHTML = (avgVal === null ? '—' : esc(pctTxt(avgVal))) +
        (prePhase
          ? ' <span style="font-size:9.5px; color:#a7f3d0; font-weight:800; margin-left:3px;">프리마켓 ' +
            esc(theme.liveCoverage || '0/' + (theme.stockCount || 0)) + '</span>'
          : '') +
        ' <span style="font-size:10px; color:#94a3b8; font-weight:600; margin-left:4px; letter-spacing:-0.2px;">(합산 ' +
        esc(theme.sumValueText || '—') + ')</span>';
      block.setAttribute('data-live-avg', '1');
    }

    var tiles = $$('.stock-tiles .stock-tile', block);
    if (!tiles.length) return 0;
    var byName = {};
    (theme.stocks || []).forEach(function (s) {
      if (!s) return;
      byName[norm(s.tileName)] = s;
      byName[norm(s.name)] = s;
    });

    var applied = 0;
    var sameLen = tiles.length === (theme.stocks || []).length;
    for (var i = 0; i < tiles.length; i += 1) {
      var nameEl = tiles[i].querySelector('.st-name');
      var key = nameEl ? norm(nameEl.textContent) : '';
      var stock = byName[key] || (sameLen ? theme.stocks[i] : null);
      if (!stock || stock.missing) continue;
      if (applyTile(tiles[i], stock) > 0) applied += 1;
    }
    return applied;
  }

  /* ----------------------- [1탭] 52주 신고가 패널 ----------------------- */

  function overviewPanels() {
    var grid = $('#tabOverview .main-bottom-grid');
    if (!grid) return { gold: null, red: null };
    return {
      gold: grid.querySelector('.panel-box.gold'),
      red: grid.querySelector('.panel-box.red')
    };
  }

  // 패널의 정적 자식(sec-head 제외)을 모두 제거 — 실시간 블록으로 대체
  function clearPanel(panel, keepId) {
    Array.prototype.slice.call(panel.children).forEach(function (el) {
      if (el.id === keepId) return;
      if (el.className && String(el.className).indexOf('sec-head') >= 0) return;
      el.remove();
    });
  }

  function high52ItemHtml(s) {
    var highTxt = isNum(s.high) ? fmt(s.high) + '원' : null;
    var neg = isNum(s.changePct) && s.changePct < 0;
    var reason = highTxt
      ? (neg
        ? '당일 고가 ' + highTxt + '으로 52주 신고가를 터치한 뒤 종가 기준 ' + pctTxt(s.changePct) + '로 밀림 · 거래대금 ' + (s.valueText || '—')
        : '당일 고가 ' + highTxt + '으로 52주 신고가 경신 · 거래대금 ' + (s.valueText || '—') + ' 유입 (네이버 증권 52주 신고가 목록)')
      : '당일 52주 신고가 목록 편입 · 거래대금 ' + (s.valueText || '—');
    var metaTxt = '대금 ' + (s.valueText || '—') + (highTxt ? ' | 고가 ' + highTxt : '') +
      ' (52주 신고가' + (neg ? ' 터치 후 하락' : '') + ')';
    return '' +
      '<div class="reason-item" data-live="1" onclick="' +
        esc(buildOnclick(s.name + ' (' + s.code + ')', fmt(s.price) + '원 (' + pctTxt(s.changePct) + ')', metaTxt, reason)) + '">' +
        '<div class="ri-head"><span>★ ' + esc(s.name) + (neg ? ' <span style="font-size:9.5px; color:#94a3b8;">(신고가 터치 후 하락)</span>' : '') + '</span>' +
          '<span style="color:' + colFor(s.changePct) + ';">' + esc(fmt(s.price)) + '원 (' + esc(pctTxt(s.changePct)) + ')</span></div>' +
        '<div class="ri-meta">' + esc(metaTxt) + '</div>' +
        '<div class="ri-reason gold">' + esc(reason) + '</div>' +
      '</div>';
  }

  function renderHigh52(panel, data, stamp) {
    if (!panel || !data) return 0;
    var head = panel.querySelector('.sec-head');
    var sub = head ? head.querySelector('.sub') : null;
    if (sub) sub.textContent = '네이버 52주 신고가 목록 · 대금순 · ⚡ ' + stamp + ' 갱신';

    var list = (data.byValue && data.byValue.length ? data.byValue : data.byPct) || [];
    if (!list.length) return 0;

    var host = panel.querySelector('#tabsLiveHigh52');
    if (!host) {
      host = document.createElement('div');
      host.id = 'tabsLiveHigh52';
      clearPanel(panel, 'tabsLiveHigh52');
      if (head && head.nextSibling) panel.insertBefore(host, head.nextSibling);
      else panel.appendChild(host);
    }

    var html = list.map(high52ItemHtml).join('');
    html += '<div style="font-size:10px; color:#64748b; margin-top:6px;">' +
      '※ 네이버 증권 52주 신고가 목록(당일 신고가 터치 종목) · 코스피 ' +
      esc(String((data.counts && data.counts.KOSPI) || 0)) + '종목 · 코스닥 ' +
      esc(String((data.counts && data.counts.KOSDAQ) || 0)) + '종목 중 거래대금 상위.<br>' +
      '※ 거래대금은 통합(KRX+NXT·시간외 포함) 기준입니다.</div>';

    if (host.getAttribute('data-sig') !== html) {
      host.innerHTML = html;
      host.setAttribute('data-sig', html);
    }
    panel.setAttribute('data-live', '1');
    return list.length;
  }

  /* --------------------- [1탭] 100억+ 상한가 패널 --------------------- */

  function upperItemHtml(s, kind) {
    var isUpper = kind === 'confirmed';
    var badge = isUpper
      ? '👑 ★ '
      : (kind === 'near' ? '🚨 ★ ' : '★ ');
    var gap = isNum(s.gapToLimit) ? s.gapToLimit : null;
    var changeLabel = isUpper
      ? pctTxt(s.changePct) + ' (100억+ 진성 상한가 🚀)'
      : (kind === 'near'
        ? pctTxt(s.changePct) + ' (+25% 돌파 · 상한가 임박 🚨)'
        : pctTxt(s.changePct) + ' (25% 돌파까지 ' + (gap !== null && gap > 0 ? '+' + gap.toFixed(2) + '%p 남음' : '—') + ')');
    var changeCol = isUpper ? '#f43f5e' : (kind === 'near' ? '#fbbf24' : '#fde047');
    var border = kind === 'watch' ? '#fbbf24' : '#f43f5e';
    var bg = kind === 'watch' ? 'rgba(251,191,36,0.05)' : 'rgba(244,63,94,0.06)';
    var metaTxt = '거래대금 ' + (s.valueText || '—') + ' | 현재가 ' + fmt(s.price) + '원' +
      (isNum(s.high) ? ' | 고가 ' + fmt(s.high) + '원' : '');
    var reason = isUpper
      ? '당일 거래대금 ' + (s.valueText || '—') + ' 유입되며 ' + pctTxt(s.changePct) + ' 상한가 안착.'
      : (kind === 'near'
        ? '당일 거래대금 ' + (s.valueText || '—') + ' 유입되며 ' + pctTxt(s.changePct) + ' — +25% 상한가 임박 기준을 돌파한 상태입니다.'
        : '당일 거래대금 ' + (s.valueText || '—') + ' 유입 · 25% 돌파까지 ' +
          (gap !== null && gap > 0 ? '+' + gap.toFixed(2) + '%p 남음' : '—'));

    return '' +
      '<div class="reason-item" data-live="1" style="border-left: 3px solid ' + border + '; background: ' + bg + ';" onclick="' +
        esc(buildOnclick(s.name + ' (' + s.code + ')', fmt(s.price) + '원 (' + pctTxt(s.changePct) + ')', metaTxt, reason)) + '">' +
        '<div class="ri-head"><span style="color:#ffffff; font-weight:800;">' + badge + esc(s.name) + '</span> ' +
          '<span style="color:' + changeCol + '; font-weight:800; font-size:' + (kind === 'watch' ? '11.5px' : '12px') + ';">' +
          esc(changeLabel) + '</span></div>' +
        '<div class="ri-meta"' + (isUpper ? ' style="color:#fca5a5; font-weight:700;"' : '') + '>' + esc(metaTxt) + '</div>' +
        (kind === 'watch' ? '' : '<div class="ri-reason red">' + esc(reason) + '</div>') +
      '</div>';
  }

  function renderUpperLimit(panel, data, stamp) {
    if (!panel || !data) return 0;
    var head = panel.querySelector('.sec-head');
    var sub = head ? head.querySelector('.sub') : null;
    if (sub) sub.textContent = '100억+ & +25% 엄격 기준 · ⚡ ' + stamp + ' 갱신';

    var confirmed = data.confirmed || [];
    var near = data.near || [];
    var watch = data.watch || [];
    var excluded = data.excluded || [];
    if (!confirmed.length && !near.length && !watch.length && !excluded.length) return 0;

    var html = '';
    html += confirmed.map(function (s) { return upperItemHtml(s, 'confirmed'); }).join('');
    html += near.map(function (s) { return upperItemHtml(s, 'near'); }).join('');

    if (watch.length) {
      html += '<div style="font-size: 11px; font-weight: 800; color: #fbbf24; margin: 8px 0 4px 2px;">' +
        '👀 +25% 상한가 임박 돌파 관찰 후보 (거래대금 100억+ 유입)</div>';
      html += watch.map(function (s) { return upperItemHtml(s, 'watch'); }).join('');
    }

    var note = '※ <strong>상한가·임박 기준은 \'상승률 +25% 이상 &amp; 거래대금 100억 이상\'</strong>에만 부여됩니다 (현재 판정: 진성 상한가 ' +
      confirmed.length + ' · 임박 ' + near.length + ' · 관찰 ' + watch.length + ').<br>';
    if (excluded.length) {
      note += '※ 거래대금 100억 미만 소형주 ' + excluded.length + '종목은 진성 기준에서 제외: ' +
        excluded.map(function (s) {
          return esc(s.name) + '(' + esc(pctTxt(s.changePct)) + ', ' + esc(s.valueText || '—') + ')';
        }).join(', ') + '. 장중 100억 돌파 시 즉시 자동 편입됩니다.<br>';
    }
    note += '※ 거래대금은 통합(KRX+NXT·시간외 포함) 기준입니다.';
    if (data.excludedPreferredCount) {
      note += '<br>※ 우선주 ' + data.excludedPreferredCount + '종목(' +
        (data.excludedPreferred || []).map(function (s) { return esc(s.name); }).join(', ') +
        ')은 수급·호가 구조가 달라 상한가·임박 판정에서 제외합니다.';
    }

    var host = panel.querySelector('#tabsLiveUpper');
    if (!host) {
      host = document.createElement('div');
      host.id = 'tabsLiveUpper';
      clearPanel(panel, 'tabsLiveUpper');
      if (head && head.nextSibling) panel.insertBefore(host, head.nextSibling);
      else panel.appendChild(host);
    }

    html += '<div style="font-size: 10px; color: #64748b; margin-top: 6px;">' + note + '</div>';
    if (host.getAttribute('data-sig') !== html) {
      host.innerHTML = html;
      host.setAttribute('data-sig', html);
    }
    panel.setAttribute('data-live', '1');
    return confirmed.length + near.length + watch.length;
  }

  /* ------------------------ [3·5탭] 실시간 뉴스 ------------------------ */

  function newsMeta(n) {
    var bits = [];
    if (n.date) bits.push(n.date);
    if (n.time) bits.push(n.time);
    if (n.press) bits.push(n.press);
    return bits.join(' · ');
  }

  /* -------- 속보 영향도·테마·수혜주 배지 (키워드 자동 분석 결과 표시) -------- */

  var IMPACT_STYLE = {
    '호재': { icon: '📈', bg: 'rgba(244,63,94,0.16)', color: '#fb7185', border: 'rgba(244,63,94,0.45)' },
    '주의': { icon: '⚠️', bg: 'rgba(251,191,36,0.16)', color: '#fbbf24', border: 'rgba(251,191,36,0.45)' },
    '중립': { icon: '➖', bg: 'rgba(148,163,184,0.14)', color: '#cbd5e1', border: 'rgba(148,163,184,0.4)' }
  };
  var NEUTRAL_STYLE = { bg: 'rgba(148,163,184,0.12)', color: '#94a3b8', border: 'rgba(148,163,184,0.35)' };

  function cleanArg(v) {
    return String(v === null || v === undefined ? '' : v).replace(/['"\\\r\n]/g, '');
  }

  function impactBadge(n) {
    var lvl = n.impactLevel || '참고';
    var dir = n.impactDirection || '중립';
    var st = IMPACT_STYLE[dir] || IMPACT_STYLE['중립'];
    var neutral = lvl === '참고';
    var text = neutral ? '📌 참고' : st.icon + ' ' + dir + ' · ' + lvl;
    var bg = neutral ? NEUTRAL_STYLE.bg : st.bg;
    var color = neutral ? NEUTRAL_STYLE.color : st.color;
    var border = neutral ? NEUTRAL_STYLE.border : st.border;
    var kw = (n.matchedKeywords || []).join('·');
    var tip = '키워드 자동 분석 · 영향도 ' + lvl + ' / 방향 ' + dir + (kw ? ' / 키워드 ' + kw : '');
    return '<span title="' + esc(tip) + '" style="font-size:10px; font-weight:800; display:inline-block; padding:2px 7px; border-radius:4px; background:' +
      bg + '; color:' + color + '; border:1px solid ' + border + '; white-space:nowrap;">' + esc(text) + '</span>';
  }

  function impactThemeChips(n) {
    var themes = n.matchedThemes || [];
    if (!themes.length) return '';
    return '<div style="display:flex; flex-wrap:wrap; gap:4px; margin:5px 0 3px 0;">' +
      themes.map(function (t) {
        return '<span style="font-size:10px; font-weight:800; color:#c4b5fd; background:rgba(168,85,247,0.14); border:1px solid rgba(168,85,247,0.38); padding:2px 6px; border-radius:4px; white-space:nowrap;">🏷️ ' + esc(t) + '</span>';
      }).join('') + '</div>';
  }

  function impactStockChips(n) {
    var list = n.beneficiaryStocks || [];
    if (!list.length) return '';
    var chips = list.map(function (s) {
      var code = cleanArg(s.code);
      var name = cleanArg(s.name);
      return '<span onclick="event.stopPropagation();tabsLiveOpenStock(\'' + name + '\', \'' + code + '\')"' +
        ' title="종목코드 ' + esc(code) + ' · 누르면 RN존 실전 차트로 이동"' +
        ' style="font-size:10px; font-weight:800; color:#6ee7b7; background:rgba(16,185,129,0.13); border:1px solid rgba(16,185,129,0.4); padding:2px 6px; border-radius:4px; cursor:pointer; display:inline-flex; align-items:center; gap:3px; white-space:nowrap;">' +
        '🎯 ' + esc(s.name) + ' <span style="font-size:9px; opacity:.7; font-weight:700;">' + esc(s.code) + '</span>' +
        '<a href="https://m.stock.naver.com/item/' + encodeURIComponent(code) + '" target="_blank" rel="noopener noreferrer"' +
        ' onclick="event.stopPropagation()" title="네이버 증권 호가창 (새 탭)"' +
        ' style="color:#6ee7b7; text-decoration:none; opacity:.75; font-weight:900; padding-left:2px;">↗</a></span>';
    }).join('');
    return '<div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin:2px 0 3px 0;">' +
      '<span style="font-size:10px; font-weight:800; color:#34d399;">수혜·관련주</span>' + chips + '</div>';
  }

  function impactNoteLine(n) {
    if (!n.impactNote) return '';
    return '<div style="font-size:10px; color:#94a3b8; line-height:1.45; margin:3px 0 4px 0; padding-top:3px; border-top:1px dashed rgba(148,163,184,0.22);">🔎 ' +
      esc(n.impactNote) + '</div>';
  }

  /* 종목 칩 → RN존 실전 차트(실시간 60일봉 + RN 지지/저항). 실패 시 네이버 호가창으로 대체. */
  function openStockFromNews(name, code) {
    var fallback = function () {
      try { window.open('https://m.stock.naver.com/item/' + encodeURIComponent(code), '_blank', 'noopener'); } catch (e) { /* noop */ }
    };
    try {
      var input = document.getElementById('liveStockQuery');
      var canRn = input && window.RnZone && window.LiveAPI &&
        typeof window.LiveAPI.searchStock === 'function' && typeof window.switchView === 'function';
      if (!canRn) { fallback(); return; }
      input.value = String(code || '');
      window.switchView('rnzone', null);
      setTimeout(function () { try { window.LiveAPI.searchStock(); } catch (e) { fallback(); } }, 60);
    } catch (e) { fallback(); }
  }
  window.tabsLiveOpenStock = openStockFromNews;

  function impactCounts(list) {
    var c = { '상': 0, '중': 0, '참고': 0 };
    (list || []).forEach(function (n) {
      var l = n && n.impactLevel;
      if (c[l] === undefined) c['참고'] += 1; else c[l] += 1;
    });
    return c;
  }

  function newsNewsCard(n) {
    var href = n.url ? esc(n.url) : '';
    var link = href
      ? '<a href="' + href + '" target="_blank" rel="noopener noreferrer" style="font-size:10.5px; background:rgba(56,189,248,0.15); color:#7dd3fc; border:1px solid rgba(56,189,248,0.4); padding:2px 7px; border-radius:4px; text-decoration:none; font-weight:800;" onclick="event.stopPropagation()">🔗 기사 원문 ↗</a>'
      : '';
    var onclick = href
      ? esc(buildOnclick(n.title, (n.time || '') + ' 속보', href, '네이버 증권 실시간 뉴스 · ' + (n.press || '')))
      : '';
    return '' +
      '<div class="news-timeline-card" data-live="1" style="border-left-color:#38bdf8;"' +
        (onclick ? ' onclick="' + onclick + '"' : '') + '>' +
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:5px;">' +
          '<div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">' +
            '<span class="nt-time" style="background:#0c4a6e; color:#bae6fd;">' + esc(n.time || '—') + ' 실시간 속보 ⚡</span>' +
            '<span style="font-size:10px; padding:2px 6px; border-radius:4px; background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); font-weight:700;">🏷️ ' + esc(n.press || '증시') + '</span>' +
            impactBadge(n) +
          '</div>' + link +
        '</div>' +
        '<div class="nt-title">' + esc(n.title) + '</div>' +
        (n.summary ? '<div class="nt-history">' + esc(n.summary) + '</div>' : '') +
        impactThemeChips(n) +
        impactStockChips(n) +
        impactNoteLine(n) +
        '<div class="nt-beneficiary">🕒 ' + esc(newsMeta(n)) + ' · 네이버 증권 실시간 뉴스</div>' +
      '</div>';
  }

  function afNewsCard(n) {
    var href = n.url ? esc(n.url) : '';
    var link = href
      ? '<a href="' + href + '" target="_blank" rel="noopener noreferrer" style="font-size:10px; background:rgba(168,85,247,0.15); color:#c084fc; border:1px solid rgba(168,85,247,0.4); padding:2px 7px; border-radius:4px; text-decoration:none; font-weight:800;" onclick="event.stopPropagation()">🔗 기사 원문 ↗</a>'
      : '';
    var onclick = href
      ? esc(buildOnclick(n.title, (n.time || '') + ' 속보', href, '네이버 증권 실시간 뉴스 · ' + (n.press || '')))
      : '';
    return '' +
      '<div class="af-card" data-live="1" style="border-left: 3px solid #a855f7;"' +
        (onclick ? ' onclick="' + onclick + '"' : '') + '>' +
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:5px;">' +
          '<div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">' +
            '<span class="af-time">' + esc(n.time || '—') + ' 실시간 속보 ⚡</span>' +
            impactBadge(n) +
          '</div>' + link +
        '</div>' +
        '<div class="af-title">' + esc(n.title) + '</div>' +
        (n.summary ? '<div class="af-move">' + esc(n.summary) + '</div>' : '') +
        impactThemeChips(n) +
        impactStockChips(n) +
        impactNoteLine(n) +
        '<div class="af-history">🕒 ' + esc(newsMeta(n)) + ' · 네이버 증권 실시간 뉴스</div>' +
      '</div>';
  }

  function newsBoxHtml(inner, list, stamp, titleSuffix, accent) {
    var c = impactCounts(list);
    return '' +
      '<div class="panel-box" style="background:#111827; border-color:' + accent.border + '; margin-bottom:12px;">' +
        '<div class="sec-head" style="border-bottom-color:' + accent.border + '; color:' + accent.color + '; padding-bottom:8px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">' +
          '<span style="font-weight:800; font-size:12.5px;">📡 실시간 최신 증시 속보 ' + list.length + '건 ' + esc(titleSuffix) + '</span>' +
          '<span class="sub" style="color:' + accent.color + ';">⚡ ' + esc(stamp) + ' 갱신 · 네이버 증권</span>' +
        '</div>' +
        '<div style="font-size:10px; color:#94a3b8; margin-bottom:8px;">' +
          '🔎 키워드 자동 분석 — 영향도 <strong style="color:#fb7185;">상 ' + c['상'] + '</strong> · ' +
          '<strong style="color:#fbbf24;">중 ' + c['중'] + '</strong> · ' +
          '<strong style="color:#94a3b8;">참고 ' + c['참고'] + '</strong> / 테마·수혜주는 매칭된 기사에만 표기' +
        '</div>' +
        inner +
        '<div style="font-size:10px; color:#64748b; margin-top:6px;">' +
          '※ 네이버 증권 실시간 뉴스 목록에서 방금 받아온 최신 속보입니다. 영향도·테마·수혜주는 제목·요약 키워드 자동 분석 결과이며(정시 AI 심층 분석과 구분), 섹터 키워드가 없는 기사는 종목을 붙이지 않고 수혜·관련주를 비웁니다. 아래 기존 타임라인·과거 유사사례 섹션은 그대로 유지됩니다.' +
        '</div>' +
      '</div>';
  }

  function renderNewsInto(tabEl, mountId, list, stamp, buildCard, accent, titleSuffix) {
    if (!tabEl || !list.length) return 0;
    var host = document.getElementById(mountId);
    if (!host) {
      host = document.createElement('div');
      host.id = mountId;
      tabEl.insertBefore(host, tabEl.firstChild);
    }
    var inner = list.map(buildCard).join('');
    var html = newsBoxHtml(inner, list, stamp, titleSuffix, accent);
    if (host.getAttribute('data-sig') !== html) {
      host.innerHTML = html;
      host.setAttribute('data-sig', html);
    }
    host.setAttribute('data-live', '1');
    return list.length;
  }

  function renderNews(body, stamp) {
    var news = body.news || [];
    if (!news.length) return 0;
    var a = renderNewsInto(
      document.getElementById('tabAftermarket'),
      'tabsLiveAfterNews',
      news,
      stamp,
      afNewsCard,
      { border: '#9333ea', color: '#c084fc' },
      '(애프터마켓 · 장마감 후)'
    );
    var b = renderNewsInto(
      document.getElementById('tabNews'),
      'tabsLiveNewsTab',
      news,
      stamp,
      newsNewsCard,
      { border: '#9333ea', color: '#c084fc' },
      '(시간별 뉴스)'
    );
    state.mounted.after = a > 0;
    state.mounted.news = b > 0;
    return a + b;
  }

  /* ------------------ [3탭] 애프터마켓 시간외 체결 대금·등락 순위 ------------------ */

  function afterPanelEl() {
    var tab = document.getElementById('tabAftermarket');
    if (!tab) return null;
    var boxes = $$('.panel-box', tab);
    for (var i = 0; i < boxes.length; i += 1) {
      var head = boxes[i].querySelector('.sec-head');
      if (head && (head.textContent || '').indexOf('시간외) 실시간 체결') >= 0) return boxes[i];
    }
    for (var j = 0; j < boxes.length; j += 1) {
      var h2 = boxes[j].querySelector('.sec-head');
      if (h2 && (h2.textContent || '').indexOf('3. 애프터마켓') >= 0) return boxes[j];
    }
    return null;
  }

  // 패널의 정적 카드만 지운다 (sec-head·실시간 host 는 남긴다)
  function clearPanelCards(panel, keepId) {
    Array.prototype.slice.call(panel.children).forEach(function (el) {
      if (el.id === keepId) return;
      if (el.className && String(el.className).indexOf('sec-head') >= 0) return;
      el.remove();
    });
  }

  function afterRowHtml(r) {
    if (!r) return '';
    var pct = isNum(r.overPct) ? r.overPct : null;
    var sesWord = state.sesWord || '시간외';
    var bits = [];
    if (isNum(r.overPrice)) bits.push(sesWord + ' 체결 ' + fmt(r.overPrice) + '원 (' + pctTxt(pct) + ')');
    if (isNum(r.changePct)) bits.push('정규장 ' + pctTxt(r.changePct));
    if (isNum(r.afterSharePct)) bits.push('통합 대금 중 ' + sesWord + ' ' + Number(r.afterSharePct).toFixed(1) + '%');
    if (r.groups && r.groups.length) bits.push('감시군 ' + r.groups.join('·'));
    var metaTxt = bits.join(' | ');
    var reason = sesWord + ' 체결 대금 ' + (r.overValueText || '—') +
      (isNum(r.overPrice) ? ' · ' + sesWord + ' 체결가 ' + fmt(r.overPrice) + '원' : '') +
      (isNum(pct) ? ' (전일 종가 대비 ' + pctTxt(pct) + ')' : '') +
      (isNum(r.changePct) ? ' · 정규장 ' + pctTxt(r.changePct) : '') +
      ' · 네이버 ' + (state.sesWord === '프리마켓' ? 'NXT 프리마켓(08:00~08:50)' : '시간외 애프터마켓(NXT·시간외 단일가)') + ' 누적 체결 기준';
    var onclick = buildOnclick(
      r.name + ' (' + r.code + ')',
      (isNum(r.overPrice) ? fmt(r.overPrice) + '원' : '—') + ' (' + pctTxt(pct) + ')',
      metaTxt,
      reason
    );
    return '' +
      '<div class="reason-item" data-live="1" style="border-left:3px solid ' +
        (isNum(pct) && pct < 0 ? '#38bdf8' : '#34d399') + ';" onclick="' + esc(onclick) + '">' +
        '<div class="ri-head">' +
          '<span><span style="display:inline-block; min-width:14px; color:#64748b; font-weight:800;">' +
            esc(String(r.rank || '')) + '</span> ' + esc(r.name) +
            ' <span style="font-size:9.5px; color:#64748b; font-weight:700;">' + esc(r.code) + '</span>' +
            (r.upperLimit ? ' <span style="font-size:9.5px; color:#fca5a5;">상한가</span>' : '') +
          '</span>' +
          '<span style="color:#34d399; font-weight:800;">' + esc(r.overValueText || '—') + '</span>' +
        '</div>' +
        '<div class="ri-meta">' + esc(metaTxt) + '</div>' +
      '</div>';
  }

  function renderAftermarket(body, stamp) {
    var af = body.aftermarket;
    if (!af) return 0;
    var byValue = af.byValue || [];
    var byTop = af.byPctTop || [];
    var byBottom = af.byPctBottom || [];
    if (!byValue.length && !byTop.length) return 0;

    var isPre = af.sessionPhase === '프리마켓';
    // 장중(09:00~15:30)에는 NXT도 자체 정규장을 돌린다 — overMarketPriceInfo 가 NXT 정규장 체결로 계속 는다.
    var isNxtReg = !af.inSession && /^REGULAR/.test(String(af.basisSessionType || ''));
    state.sesWord = isPre ? '프리마켓' : isNxtReg ? 'NXT 정규장' : '시간외';
    var sesWord = state.sesWord;
    var sesMetric = isPre
      ? '프리마켓(08:00~08:50 NXT) 체결 대금'
      : isNxtReg
        ? 'NXT 정규장 체결 대금'
        : '시간외 체결 대금';
    var grows = af.inSession || isNxtReg;
    // 세션 밖이어도 응답의 체결 세션이 PRE_MARKET 이면 "오늘 프리마켓 체결" 이다(전일 마감값이 아님).
    var todayPre = !af.inSession && !isNxtReg && af.basisSessionType === 'PRE_MARKET';

    var panel = afterPanelEl();
    if (!panel) return 0;

    var head = panel.querySelector('.sec-head');
    var sub = head ? head.querySelector('.sub') : null;
    var basisTxt = (grows
      ? isPre
        ? 'NXT 프리마켓 진행 중'
        : isNxtReg
          ? 'NXT 정규장 체결 중'
          : '시간외 세션 진행 중'
      : '시간외 세션 아님') +
      (isNxtReg ? ' · 기준 NXT 정규장' : af.basisSessionType === 'PRE_MARKET' && !isPre ? ' · 기준 프리마켓' : '') +
      ' · ⚡ ' + stamp + ' 갱신';
    if (sub) {
      sub.textContent = basisTxt;
      sub.setAttribute('data-live', '1');
    }

    var html = '';
    html += '<div style="font-size:10.5px; color:#94a3b8; margin:0 0 6px 2px; line-height:1.5;">' +
      (grows
        ? '<strong style="color:#34d399;">' + esc(isPre ? 'NXT 프리마켓 진행 중' : isNxtReg ? 'NXT 정규장 체결 중' : '시간외 세션 진행 중') + '</strong> — ' +
          esc(sesWord) + ' 체결 대금이 계속 늘어납니다 · '
        : todayPre
          ? '<strong style="color:#cbd5e1;">오늘 ' + esc(af.basisLabel || '—') + ' 프리마켓 체결값</strong> · '
          : '<strong style="color:#cbd5e1;">직전 ' + esc(af.basisLabel || '—') + ' ' + esc(sesWord) + ' 마감값</strong> · ') +
      '감시군 ' + esc(String(af.universe || 0)) + '종목(테마·RN존·종베' +
      ((af.universeGroups && af.universeGroups['NXT동적']) ? '·NXT동적 ' + esc(String(af.universeGroups['NXT동적'])) : '') +
      ') 중 <strong style="color:#34d399;">' + esc(sesWord) + ' 체결 ' +
      esc(String(af.withAfterCount || 0)) + '종목</strong> 기준 · ' +
      '체결 데이터 없는 ' + esc(String(af.noAfterCount || 0)) + '종목은 순위에서 제외</div>';

    html += '<div style="font-size:11px; font-weight:800; color:#6ee7b7; margin:6px 0 4px 2px;">' +
      '💰 ' + esc(sesMetric) + ' 상위 ' + byValue.length + '종목</div>';
    html += byValue.map(afterRowHtml).join('');

    if (byTop.length) {
      html += '<div style="font-size:11px; font-weight:800; color:#fca5a5; margin:9px 0 4px 2px;">' +
        '📈 ' + esc(sesMetric) + ' 등락 상위 ' + byTop.length + '종목 (전일 종가 대비)</div>';
      html += byTop.map(afterRowHtml).join('');
    }
    if (byBottom.length) {
      html += '<div style="font-size:11px; font-weight:800; color:#7dd3fc; margin:9px 0 4px 2px;">' +
        '📉 ' + esc(sesMetric) + ' 등락 하위 ' + byBottom.length + '종목</div>';
      html += byBottom.map(afterRowHtml).join('');
    }

    var note = '※ ' + esc(sesMetric) + ' = 네이버 ' +
      (isPre
        ? 'NXT 프리마켓(08:00~08:50) 누적 체결 대금'
        : isNxtReg
          ? 'NXT 정규장 실시간 체결 대금(대체거래소 자체 정규 세션)'
          : '시간외 애프터마켓(NXT·시간외 단일가) 누적 체결 대금') +
      '입니다. ' + esc(sesWord) + ' 등락률은 ' + esc(sesWord) + ' 체결가의 전일 종가 대비 등락입니다.<br>';
    note += grows
      ? '※ 지금은 ' + esc(sesWord) + ' 세션 진행 중입니다 — 값이 계속 늘어납니다.'
      : todayPre
        ? '※ 지금은 프리마켓이 끝난 시점입니다 — 위 값은 오늘 ' + esc(af.basisLabel || '—') + ' NXT 프리마켓 누적 체결값입니다.'
        : '※ 지금은 ' + esc(sesWord) + ' 세션이 아닙니다 — 직전 ' + esc(af.basisLabel || '—') + ' 마감값이며, ' +
          (isPre ? '장마감 후 시간외 체결이 시작되면 자동으로 늘어납니다.' : '다음 프리마켓이 열리면 자동으로 갱신됩니다.');
    html += '<div style="font-size:10px; color:#64748b; margin-top:6px;">' + note + '</div>';

    var host = document.getElementById('tabsLiveAfterTop');
    if (!host) {
      host = document.createElement('div');
      host.id = 'tabsLiveAfterTop';
      clearPanelCards(panel, 'tabsLiveAfterTop');
      if (head && head.nextSibling) panel.insertBefore(host, head.nextSibling);
      else panel.appendChild(host);
    }
    if (host.getAttribute('data-sig') !== html) {
      host.innerHTML = html;
      host.setAttribute('data-sig', html);
    }
    host.setAttribute('data-live', '1');
    return byValue.length + byTop.length + byBottom.length;
  }

  /* ---------------- [1탭] NXT 실시간 주도주 트랙 ----------------
   * 실시간 주도 테마 레이더 안의 3장 카드는 지금까지 11/13 고정 종목명이었다.
   * /api/tabs-live 의 nxtLeaders(NXT 실측 랭킹: 상승률 · 거래대금 · 검색)로 그대로 다시 그린다.
   */

  function nxRowHtml(it) {
    var pct = isNum(it.changePct) ? it.changePct : null;
    var nm = String(it.name || '').replace(/'/g, '');
    var onclick = "if(window.tabsLiveOpenStock){tabsLiveOpenStock('" + nm + "','" + esc(it.code) + "')}";
    return '<div data-nxt-live="1" style="font-size:10.5px; color:#cbd5e1; margin-top:3px; line-height:1.5; cursor:pointer;" ' +
      'title="NXT 체결 기준 · 눌러서 RN존 차트" onclick="' + esc(onclick) + '">' +
      '• <strong style="color:#fff;">' + esc(it.name) + '</strong> ' +
      '<span style="color:' + colFor(pct) + '; font-weight:800;">' + esc(fmt(it.price)) + '원 ' + esc(pctTxt(pct)) + '</span>' +
      ' <span style="color:#94a3b8;">· ' + esc(it.valueText || '—') + '</span>' +
      (it.upperLimit ? ' <span style="font-size:9px; color:#fca5a5; font-weight:800;">상한가</span>' : '') +
      ' <span style="font-size:9px; color:#64748b;">' + esc(it.market || '') + '</span>' +
      '</div>';
  }

  function nxTrackHtml(title, color, items, note) {
    var head =
      '<div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">' +
        '<span style="font-size:11.5px; font-weight:800; color:' + color + ';">' + esc(title) + '</span>' +
        '<span style="font-size:10px; background:rgba(16,185,129,0.2); color:#a7f3d0; padding:1px 4px; border-radius:3px; white-space:nowrap;">' +
          esc(note) + '</span>' +
      '</div>';
    if (!items || !items.length) {
      return head + '<div style="font-size:10.5px; color:#94a3b8; margin-top:4px;">' + esc(note === '실패' ? '⚠️ NXT 랭킹 응답 없음 — 값을 만들지 않습니다.' : '해당 세션 체결 종목이 없습니다.') + '</div>';
    }
    return head + items.map(nxRowHtml).join('');
  }

  function renderNxtTracks(body, stamp) {
    var box = document.getElementById('premarketRadarBox');
    if (!box) return 0;
    var nx = body.nxtLeaders;
    var cards = $$('#premarketRadarBox div[onclick*="openPremarketDetail"]');
    if (!cards.length) return 0;

    var phase = (body.aftermarket && body.aftermarket.sessionPhase) || null;
    var ses = phase === '프리마켓' ? '프리마켓' : phase === '애프터마켓' ? '애프터마켓' : '장중';
    var applied = 0;

    if (!nx || !nx.ok) {
      var fail = nxTrackHtml('⚡ NXT ' + ses + ' 실시간 랭킹', '#94a3b8', [], '실패');
      cards.forEach(function (card) {
        if (card.getAttribute('data-sig') === 'fail') return;
        card.innerHTML = fail;
        card.setAttribute('data-sig', 'fail');
        applied += 1;
      });
      var bg = document.getElementById('pmSessionBadge');
      if (bg) { bg.textContent = '⚠️ NXT 랭킹 실패'; bg.style.background = '#7f1d1d'; bg.style.color = '#fecaca'; }
      return applied;
    }

    var badge = '⚡ ' + stamp;
    var tracks = [
      { title: '⚡ NXT ' + ses + ' 상승 주도주', color: '#6ee7b7', items: nx.byPct },
      { title: '💰 NXT ' + ses + ' 거래대금 상위', color: '#c7d2fe', items: nx.byValue },
      { title: '🔍 NXT 검색 상위', color: '#7dd3fc', items: nx.searchTop },
    ];
    tracks.forEach(function (t, i) {
      var card = cards[i];
      if (!card) return;
      var html = nxTrackHtml(t.title, t.color, t.items, badge);
      if (card.getAttribute('data-sig') !== html) {
        card.innerHTML = html;
        card.setAttribute('data-sig', html);
        applied += 1;
      }
      card.setAttribute('data-nxt-live', '1');
    });
    box.setAttribute('data-nxt-live', '1');

    var sessBadge = document.getElementById('pmSessionBadge');
    if (sessBadge) {
      var btxt = '⚡ NXT ' + (nx.sessionLabel || ses) + ' LIVE ' + stamp;
      if (sessBadge.textContent !== btxt) sessBadge.textContent = btxt;
      sessBadge.style.background = '#064e3b';
      sessBadge.style.color = '#6ee7b7';
      sessBadge.setAttribute('data-live', '1');
    }
    var noteEl = document.getElementById('pmNote');
    if (noteEl) {
      var ntxt = '※ NXT(넥스트레이드) 실시간 랭킹 ' + stamp + ' 조회 — ' + ses +
        ' 체결가·거래대금 기준입니다(전일 종가 대비). 감시군에 NXT 랭킹 종목 ' +
        (nx.dynamicCount || 0) + '개를 더해 3번 탭 순위에 함께 넣었습니다.';
      if (noteEl.textContent !== ntxt) noteEl.textContent = ntxt;
      noteEl.setAttribute('data-live', '1');
    }
    return applied + 1;
  }

  /* ---------------- 주말/휴장 표현 정정 (정적 문구) ---------------- */

  function fixSessionWording(phase) {
    if (phase !== '주말휴장') return;
    var roots = [document.getElementById('tabAftermarket'), document.getElementById('tabOverview')];
    roots.forEach(function (root) {
      if (!root) return;
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var hits = [];
      var node;
      while ((node = walker.nextNode())) {
        var t = node.nodeValue || '';
        if (t.indexOf('정규장 진행 중') >= 0) hits.push(node);
      }
      hits.forEach(function (n) {
        n.nodeValue = n.nodeValue.replace(/정규장 진행 중/g, '주말 휴장');
      });
    });
  }

  /* ==========================================================================
   * 실시간 전략 판정 패널 — 비중법사(#tabBijoong) · 홍인기(#tabHonginki)
   *  /api/tabs-live 의 strategyLive 를 그대로 그린다.
   *  · 0일차 : 오늘 장중 실제로 조건을 채운 종목(일봉 실측 판정)
   *  · 기존 카드 : 재스캔 기준봉·기준선 대비 장중 현재가 위치 · 패턴 · 분할선/5단 · 손절선
   *  값이 없으면 만들지 않고 '—' 로 남긴다.
   * ========================================================================== */

  function slPct(v) {
    return isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(2) + '%' : '—';
  }

  function slEok(v) {
    if (!isNum(v)) return '—';
    return v >= 1000 ? Math.round(v).toLocaleString('ko-KR') + '억' : v.toFixed(1) + '억';
  }

  function slWon(v) {
    return isNum(v) ? fmt(v) + '원' : '—';
  }

  function slCheck(on) {
    return on ? '<span style="color:#34d399;font-weight:900;">✅</span>' : '<span style="color:#64748b;font-weight:900;">✗</span>';
  }

  function slOpen(name, code) {
    var nm = String(name || '').replace(/'/g, '');
    return "if(window.tabsLiveOpenStock){tabsLiveOpenStock('" + nm + "','" + esc(code) + "')}";
  }

  function slRow(inner, name, code) {
    return (
      '<div data-live="1" onclick="' + esc(slOpen(name, code)) + '" ' +
      'style="cursor:pointer;padding:6px 8px;margin-bottom:4px;border-radius:6px;background:rgba(15,23,42,0.72);border:1px solid rgba(148,163,184,0.16);">' +
      inner +
      '</div>'
    );
  }

  function slHeadRow(name, code, price, pct, right, rawName) {
    return (
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px;flex-wrap:wrap;">' +
        '<span style="font-size:11.5px;font-weight:800;color:#e2e8f0;">' + (rawName ? name : esc(name)) +
          ' <span style="font-size:9.5px;color:#64748b;font-weight:700;">' + esc(code || '') + '</span></span>' +
        '<span style="font-size:11px;font-weight:800;color:' + colFor(pct) + ';white-space:nowrap;">' +
          esc(slWon(price)) + ' <span style="color:' + colFor(pct) + ';">' + esc(slPct(pct)) + '</span></span>' +
      '</div>' +
      (right ? '<div style="font-size:10px;color:#94a3b8;line-height:1.5;margin-top:2px;">' + right + '</div>' : '')
    );
  }

  function slBox(title, sub, accent, bodyHtml) {
    return (
      '<div class="panel-box" style="background:#0b1220;border:1px solid ' + accent + ';border-radius:10px;padding:10px 11px;margin:12px 0;">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;">' +
          '<span style="font-size:12px;font-weight:800;color:' + accent + ';">' + title + '</span>' +
          '<span style="font-size:10px;color:#94a3b8;font-weight:700;">' + sub + '</span>' +
        '</div>' + bodyHtml +
      '</div>'
    );
  }

  function ensureStratHost(tabId, hostId) {
    var tab = document.getElementById(tabId);
    if (!tab) return null;
    var host = document.getElementById(hostId);
    if (!host) {
      host = document.createElement('div');
      host.id = hostId;
      if (tab.firstChild) tab.insertBefore(host, tab.firstChild);
      else tab.appendChild(host);
    } else if (host.parentNode !== tab) {
      tab.insertBefore(host, tab.firstChild);
    }
    return host;
  }

  function slBijFreshHtml(list, near) {
    var out = '';
    if (list && list.length) {
      out += list.map(function (r) {
        var checks = r.bij.checks || {};
        return slRow(
          slHeadRow(
            '🔥 ' + esc(r.name) + ' <span style="color:#fca5a5;">기준봉 성립</span>',
            r.code, r.price, r.pct,
            '몸통 ' + slCheck(checks.body) + ' ' + slPct(r.bodyRate) +
            ' · 대금 ' + slCheck(checks.value) + ' ' + slEok(r.valueEok) +
            ' · 60일 전고점 ' + slCheck(checks.break60) + ' ' + slWon(r.hi60) +
            ' · 위꼬리 ' + slCheck(checks.upper) + ' ' + (isNum(r.upper) ? r.upper.toFixed(1) + '%' : '—') +
            '<br>20일평균 대비 ' + (isNum(r.volX) ? r.volX.toFixed(2) + '배' : '—') +
            ' · 대금 ' + (r.valueText || slEok(r.valueEok)) + ' (' + esc(r.valueBasis || '통합') + ')' +
            (r.valueRank ? ' · 대금 순위 ' + r.valueRank + '위' : ''),
            true
          ),
          r.name, r.code
        );
      }).join('');
    } else {
      out += '<div style="font-size:10.5px;color:#94a3b8;padding:4px 2px;">지금 조건(몸통 +10%↑ · 대금 300억↑ · 60일 전고점 돌파)을 모두 채운 종목은 없습니다 — 새로 생기면 이 자리에 자동으로 올라옵니다.</div>';
    }
    if (near && near.length) {
      out += '<div style="font-size:10.5px;font-weight:800;color:#fbbf24;margin:8px 0 3px;">⚖️ 아깝게 탈락한 장중 후보</div>';
      out += near.map(function (r) {
        return slRow(
          '<div style="display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;">' +
            '<span style="font-size:11px;font-weight:700;color:#cbd5e1;">' + esc(r.name) +
              ' <span style="font-size:9.5px;color:#64748b;">' + esc(r.code) + '</span></span>' +
            '<span style="font-size:10.5px;font-weight:800;color:' + colFor(r.pct) + ';">' + esc(slWon(r.price)) + ' ' + esc(slPct(r.pct)) + '</span>' +
          '</div>' +
          '<div style="font-size:9.8px;color:#94a3b8;line-height:1.45;margin-top:2px;">' +
            esc((r.bij.reasons || []).join(' · ') || '—') +
          '</div>',
          r.name, r.code
        );
      }).join('');
    }
    return out;
  }

  function slBijCardsHtml(cards, bij) {
    if (!cards || !cards.length) {
      var basis = (bij && (bij.basisLabel || bij.basisDate)) || '최근 기준일';
      return '<div style="font-size:10.5px;color:#94a3b8;padding:3px 2px;line-height:1.55;">최근 기준일(' + esc(basis) + ') 기준봉 0종목 — 몸통 +10%↑ · 거래대금 300억↑ · 60일 전고점 종가 돌파를 모두 채운 종목이 없습니다. 새로 기준봉이 생기면 이 자리에 자동으로 올라옵니다.</div>';
    }
    return cards.map(function (c) {
      if (c.missing || !c.live) {
        return slRow(
          '<div style="font-size:11px;color:#94a3b8;">' + esc(c.name) + ' — 실시간 시세 미수신(폴링 대기)</div>',
          c.name, c.code
        );
      }
      var L = c.live;
      var lines = (L.split4 && L.split4.lines) || [];
      var touched = (L.split4 && L.split4.touched) || [];
      var lineTxt = lines.map(function (v, i) {
        return slWon(v) + (touched[i] ? '✓' : '');
      }).join(' · ');
      var patColor = L.patternKey === 'ddeun' ? '#f43f5e' : L.patternKey === 'jungbong' ? '#fbbf24' : L.patternKey === 'eumbbong' ? '#38bdf8' : '#94a3b8';
      var right =
        '기준봉 종가 ' + slWon(L.base) + ' 대비 <b style="color:' + colFor(L.vsBasePct) + ';">' + esc(slPct(L.vsBasePct)) + '</b>' +
        ' · 시초 <b style="color:' + colFor(L.gapPct) + ';">' + esc(slPct(L.gapPct)) + '</b>' +
        '<br>시 ' + slWon(L.open) + ' · 고 ' + slWon(L.high) + ' · 저 ' + slWon(L.low) + ' · 현재 ' + slWon(L.price) +
        ' · <span style="color:' + patColor + ';font-weight:800;">' + esc(L.patternLabel) + '</span>' +
        '<br>4분할선 ' + esc(lineTxt) + ' → <b style="color:#c7d2fe;">' + esc(L.split4.zone) + '</b>' +
        ' · 손절선 ' + slWon(L.stopLine) + (L.stopBreach ? ' <span style="color:#fca5a5;font-weight:800;">이탈</span>' : '')
      ;
      return slRow(slHeadRow(c.name, c.code, L.price, L.vsBasePct, right), c.name, c.code);
    }).join('');
  }

  function slHongFreshHtml(list, near) {
    var out = '';
    if (list && list.length) {
      out += list.map(function (r) {
        var checks = r.hong.checks || {};
        return slRow(
          slHeadRow(
            '🔥 ' + esc(r.name) + ' <span style="color:#fca5a5;">D+0 성립</span>',
            r.code, r.price, r.pct,
            '등락률 ' + slCheck(checks.pct) + ' ' + slPct(r.pct) +
            ' · 120일 전고점 ' + slCheck(checks.break120) + ' ' + slWon(r.hi120) + '(' + esc(String(r.hi120Date || '').slice(4, 6) + '/' + String(r.hi120Date || '').slice(6, 8)) + ')' +
            ' · 첫 돌파 ' + slCheck(checks.firstBreak) +
            ' · 대금 상위 ' + slCheck(checks.valueTop) + ' ' + slEok(r.valueEok) +
            (r.valueRank ? '(' + r.valueRank + '위)' : '') +
            '<br>위꼬리 ' + (isNum(r.upper) ? r.upper.toFixed(1) + '%' : '—') +
            ' · 20일평균 대비 ' + (isNum(r.volX) ? r.volX.toFixed(2) + '배' : '—') +
            (r.firstBreak120 ? ' · <b style="color:#6ee7b7;">첫 장대양봉</b>' : ' · <span style="color:#fbbf24;">재돌파 ' + (r.priorBreakCount || 0) + '회</span>'),
            true
          ),
          r.name, r.code
        );
      }).join('');
    } else {
      out += '<div style="font-size:10.5px;color:#94a3b8;padding:4px 2px;">지금 조건(등락률 +10%↑ · 120일 전고점 돌파 · 대금 상위)을 모두 채운 종목은 없습니다 — 새로 생기면 이 자리에 자동으로 올라옵니다.</div>';
    }
    if (near && near.length) {
      out += '<div style="font-size:10.5px;font-weight:800;color:#fbbf24;margin:8px 0 3px;">⚖️ 전고점은 넘었지만 첫 돌파가 아닌 후보</div>';
      out += near.map(function (r) {
        return slRow(
          '<div style="display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;">' +
            '<span style="font-size:11px;font-weight:700;color:#cbd5e1;">' + esc(r.name) +
              ' <span style="font-size:9.5px;color:#64748b;">' + esc(r.code) + '</span></span>' +
            '<span style="font-size:10.5px;font-weight:800;color:' + colFor(r.pct) + ';">' + esc(slWon(r.price)) + ' ' + esc(slPct(r.pct)) + '</span>' +
          '</div>' +
          '<div style="font-size:9.8px;color:#94a3b8;line-height:1.45;margin-top:2px;">' + esc((r.hong.reasons || []).join(' · ') || '—') + '</div>',
          r.name, r.code
        );
      }).join('');
    }
    return out;
  }

  function slHongCardsHtml(cards) {
    if (!cards || !cards.length) {
      return '<div style="font-size:10.5px;color:#94a3b8;padding:3px 2px;">홍인기 카드가 없습니다(재스캔 JSON 미포함).</div>';
    }
    return cards.map(function (c) {
      if (c.missing || !c.live) {
        return slRow('<div style="font-size:11px;color:#94a3b8;">' + esc(c.name) + ' — 실시간 시세 미수신(폴링 대기)</div>', c.name, c.code);
      }
      var L = c.live;
      var stateColor = L.stateKey === 'tp10' ? '#34d399' : L.stateKey === 'tp5' ? '#6ee7b7' : L.stateKey === 'above' ? '#e2e8f0' : L.stateKey === 'dip' ? '#7dd3fc' : '#fca5a5';
      var ladder = (L.ladder || []).map(function (l) {
        return l.step + (l.hit === true ? ' ✅' : '') + ' ' + l.label;
      }).join(' · ');
      var right =
        '<b style="color:' + stateColor + ';">' + esc(L.stateLabel) + '</b>' +
        ' · 기준선 ' + slWon(L.base) + ' 대비 <b style="color:' + colFor(L.vsBasePct) + ';">' + esc(slPct(L.vsBasePct)) + '</b>' +
        (isNum(L.gapPct) ? ' · 시초 ' + esc(slPct(L.gapPct)) : '') +
        '<br>시 ' + slWon(L.open) + ' · 고 ' + slWon(L.high) + ' · 저 ' + slWon(L.low) + ' · 현재 ' + slWon(L.price) +
        '<br>' + esc(ladder) +
        '<br>익절 +5% ' + slWon(L.tp5) + ' / +10% ' + slWon(L.tp10) +
        ' · 손절 −3% ' + slWon(L.stopLine) +
        (L.stopBreach ? ' <span style="color:#fca5a5;font-weight:800;">이탈</span>' : '')
      ;
      var dayTag = c.dayLabel ? '[기준봉 → 오늘 ' + c.dayLabel + '] ' : c.kind ? '[' + c.kind + '] ' : '';
      return slRow(slHeadRow(dayTag + c.name, c.code, L.price, L.vsBasePct, right), c.name, c.code);
    }).join('');
  }

  function renderStrategyLive(body, stamp) {
    var sl = body.strategyLive;
    if (!sl) return 0;
    var applied = 0;
    var uni = sl.universe || {};
    var srcLine = '장중 스캔 ' + (uni.pool || 0) + '종목(등락률 상위 ' + (uni.pctTop || 0) + ' · 대금 상위 ' + (uni.valueTop || 0) + ')' +
      ' → 일봉 실측 ' + (uni.judged || 0) + '/' + (uni.candleChecks || 0) + '종목 · 통합(KRX+NXT) 거래대금 기준';

    var bij = sl.bij || {};
    var bijHtml = slBox(
      '⚡ 장중 실시간 기준봉 · 1일차 판정',
      '⚡ ' + esc(stamp) + ' 갱신 · 네이버 실시간',
      '#34d399',
      '<div style="font-size:10px;color:#94a3b8;margin:3px 0 6px;line-height:1.5;">' +
        '기준 ' + esc(bij.basisLabel || bij.basisDate || '—') + ' · 오늘 <b style="color:#e2e8f0;">' + esc(bij.dayLabel || '—') + '</b>' +
        ' · ' + esc(srcLine) + '</div>' +
      '<div style="font-size:11px;font-weight:800;color:#fca5a5;margin:6px 0 4px;">🔥 당일 실시간 기준봉(0일차) — 몸통 +10%↑ · 대금 300억↑ · 60일 전고점 돌파</div>' +
      slBijFreshHtml(bij.fresh, bij.near) +
      '<div style="font-size:11px;font-weight:800;color:#c7d2fe;margin:10px 0 4px;">📊 기존 기준봉 카드 · 오늘 1일차 실시간 판정 · 4분할 타점</div>' +
      slBijCardsHtml(bij.cards, bij)
    );

    var hong = sl.hong || {};
    var hongHtml = slBox(
      '⚡ 장중 실시간 홍인기 D+0 · 5단 타점 판정',
      '⚡ ' + esc(stamp) + ' 갱신 · 네이버 실시간',
      '#c084fc',
      '<div style="font-size:10px;color:#94a3b8;margin:3px 0 6px;line-height:1.5;">' +
        '기준 ' + esc(hong.basisLabel || hong.basisDate || '—') + ' · 오늘 <b style="color:#e2e8f0;">' + esc(hong.dayLabel || '—') + '</b>' +
        ' · ' + esc(srcLine) +
        (hong.basisStale
          ? '<br><span style="color:#fbbf24;font-weight:800;">⚠️ 기준일이 오늘의 전일이 아닙니다 — 카드의 기준선(전일 종가)이 실제 전일 종가와 다를 수 있어 재스캔이 필요합니다.</span>'
          : '') +
        '</div>' +
      '<div style="font-size:11px;font-weight:800;color:#fca5a5;margin:6px 0 4px;">🔥 당일 D+0 포착 — 등락률 +10%↑ · 120일 전고점 첫 돌파 · 대금 상위</div>' +
      slHongFreshHtml(hong.fresh, hong.near) +
      '<div style="font-size:11px;font-weight:800;color:#c7d2fe;margin:10px 0 4px;">📊 기존 카드 · 기준선 대비 실시간 위치 · 5단 타점</div>' +
      slHongCardsHtml(hong.cards) +
      '<div style="font-size:9.6px;color:#64748b;margin-top:6px;line-height:1.5;">※ 전고점은 일봉 실측(당일 봉 제외)이고, 5단 타점의 ✅는 1차 시초가 확인 · 2차 전일 종가 터치 · 3차 기준선 아래 · 4~5차 5일선 이탈 여부입니다. 투자 권유가 아닙니다.</div>'
    );

    var hostB = ensureStratHost('tabBijoong', 'stratLiveBijoongHost');
    if (hostB) {
      if (hostB.getAttribute('data-sig') !== bijHtml) {
        hostB.innerHTML = bijHtml;
        hostB.setAttribute('data-sig', bijHtml);
      }
      hostB.setAttribute('data-live', '1');
      applied += 1;
    }

    var hostH = ensureStratHost('tabHonginki', 'stratLiveHongHost');
    if (hostH) {
      if (hostH.getAttribute('data-sig') !== hongHtml) {
        hostH.innerHTML = hongHtml;
        hostH.setAttribute('data-sig', hongHtml);
      }
      hostH.setAttribute('data-live', '1');
      applied += 1;
    }
    return applied;
  }

  /* ==========================================================================
   * [1탭] 주도 테마맵 — 네이버 실시간 테마 랭킹(동적 Top 8)으로 통째로 다시 그린다.
   *  · /api/tabs-live 의 themes 가 themeSource='naver-theme' 일 때만 그린다.
   *  · 테마 랭킹이 죽으면 고정 8대 테마(정적 HTML)를 그대로 둔다 — 동적 테마를 고정값으로 덮어쓰지 않는다.
   * ========================================================================== */

  function dynTileHtml(s) {
    var pct = isNum(s.livePct) ? s.livePct : isNum(s.changePct) ? s.changePct : null;
    var price = isNum(s.livePrice) ? s.livePrice : s.price;
    var role = s.role || '';
    var roleStyle =
      role === '상승률 대장'
        ? 'background:#dc2626; color:#fff;'
        : role === '실질 거래대금 대장'
          ? 'background:#7c3aed; color:#fff;'
          : 'background:rgba(148,163,184,0.18); color:#cbd5e1;';
    var roleTxt =
      role === '상승률 대장' ? '👑 상승률 대장' : role === '실질 거래대금 대장' ? '💰 실질 거래대금 대장' : role;
    var click = buildOnclick(
      s.name + ' (' + s.code + ')',
      slPct(pct),
      '대금 ' + (s.valueText || '—') + ' | 현재가 ' + fmt(price) + '원',
      '네이버 실시간 테마 랭킹 · ' + (s.themeNameRef || '') + (role ? ' · ' + roleTxt : '') +
        ' (일봉·차트는 /api/stock-chart 실데이터)'
    );
    return (
      '<div class="stock-tile' + (role === '상승률 대장' || role === '실질 거래대금 대장' ? ' leader' : '') + '"' +
        ' data-live="1" data-code="' + esc(s.code) + '"' +
        ' onclick="' + esc(click) + '">' +
        '<div class="st-top">' +
          '<span class="st-name" style="color:#ffffff; font-weight:800;">' + esc(s.name) + '</span>' +
          '<span class="st-change" style="color:' + colFor(pct) + '; font-weight:800;">' + esc(slPct(pct)) + '</span>' +
        '</div>' +
        '<div class="st-ohlc">' + (isNum(s.livePrice) ? '프' : '현') + ' <strong>' + esc(fmt(price)) + '</strong>' +
          ' | 시 ' + esc(fmt(s.open)) + ' 고 ' + esc(fmt(s.high)) + ' 저 ' + esc(fmt(s.low)) + '</div>' +
        '<div class="st-bottom">' +
          '<span class="st-vol" title="거래대금 ' + esc(s.valueText || '—') + ' (' + esc(s.valueBasis || '통합') + ')">' + esc(s.valueText || '—') + '</span>' +
          (role ? '<span class="st-role" style="' + roleStyle + ' font-size:9px; white-space:nowrap;">' + esc(roleTxt) + '</span>' : '') +
        '</div>' +
      '</div>'
    );
  }

  function dynThemeHtml(t) {
    var avg = isNum(t.avgPct) ? t.avgPct : null;
    var stocks = t.stocks || [];
    var rise = isNum(t.riseCount) ? t.riseCount : 0;
    var fall = isNum(t.fallCount) ? t.fallCount : 0;
    return (
      '<div class="theme-block" data-live="1" data-theme-no="' + esc(t.themeNo || '') + '">' +
        '<div class="theme-header">' +
          '<span class="theme-name">' + esc(t.rank) + '위 🔥 ' + esc(t.name) + '</span>' +
          '<span class="theme-avg" style="color:' + colFor(avg) + '; font-weight:800; font-feature-settings:\'tnum\'; font-size:13px;">' +
            esc(slPct(avg)) +
            ' <span style="font-size:10px; color:#94a3b8; font-weight:600; margin-left:4px; letter-spacing:-0.2px;">' +
              '(합산 ' + esc(t.sumValueText || '—') + ' · 상승 ' + rise + '/' + (rise + fall) + ')</span>' +
          '</span>' +
        '</div>' +
        '<div class="stock-tiles">' +
          stocks.map(function (s) { s.themeNameRef = t.name; return dynTileHtml(s); }).join('') +
        '</div>' +
      '</div>'
    );
  }

  function renderDynamicThemes(body, stamp) {
    var gridEl = document.querySelector('#tabOverview .theme-grid-8');
    if (body.themeSource !== 'naver-theme') {
      // 랭킹이 죽으면 고정 8대 테마(과거 기준)가 그대로 남는다 — 오늘 값으로 오해하지 않게 머리말에 못박는다.
      if (gridEl && gridEl.previousElementSibling) {
        var h0 = gridEl.previousElementSibling;
        var s0 = h0.querySelector ? h0.querySelector('.sub') : null;
        if (s0) {
          var w0 = '⚠️ 실시간 테마 랭킹 응답 없음 — 고정 8대 테마(과거 기준) 표시 · ⚡ ' + stamp;
          if (s0.textContent !== w0) {
            s0.textContent = w0;
            s0.style.color = '#fbbf24';
          }
        }
      }
      return 0;
    }
    var themes = body.themes || [];
    if (!themes.length) return 0;
    var grid = gridEl;
    if (!grid) return 0;
    var html = themes.map(dynThemeHtml).join('');
    if (grid.getAttribute('data-sig') !== html) {
      grid.innerHTML = html;
      grid.setAttribute('data-sig', html);
    }
    grid.setAttribute('data-dynamic', '1');

    var head = grid.previousElementSibling;
    if (head && head.querySelector) {
      var title = head.querySelector('span');
      if (title) {
        var ttxt = '🔥 실시간 주도 테마맵 (오늘 장중 강세 테마 Top ' + themes.length + ')';
        if (title.textContent !== ttxt) title.textContent = ttxt;
      }
      var sub = head.querySelector('.sub');
      if (sub) {
        var stxt = '네이버 실시간 테마 랭킹(등락률 상위 ' + themes.length + '테마 · ' + (body.themeRankTotal || 0) + '개 중) · ⚡ ' + stamp + ' 갱신';
        if (sub.textContent !== stxt) sub.textContent = stxt;
        sub.setAttribute('data-live', '1');
      }
    }
    return themes.length;
  }

  /* ------------------------------ 적용 총괄 ------------------------------ */

  function markThemeHead(stamp) {
    var grid = document.querySelector('#tabOverview .theme-grid-8');
    if (!grid) return;
    var head = grid.previousElementSibling;
    var sub = head && head.querySelector ? head.querySelector('.sub') : null;
    if (!sub) return;
    var base = '스탁이지 · 주맵 실시간 체결 검증';
    sub.textContent = base + ' · ⚡ ' + stamp + ' 갱신';
    sub.setAttribute('data-live', '1');
  }

  function apply(body) {
    var stamp = body.generatedAtKst || nowHms();
    var applied = 0;
    state.sessionPhase = body.sessionPhase || null;

    // 1번 탭 — NXT 실시간 주도주 트랙(고정 텍스트 → 실데이터)
    applied += renderNxtTracks(body, stamp);

    // 1번 탭 — 주도 테마맵 : 네이버 실시간 테마 랭킹(동적 Top 8)으로 통째로 다시 그린다.
    //  랭킹이 살아 있으면 고정 8대 테마(정적 HTML)로 되돌리지 않는다.
    var dynThemes = renderDynamicThemes(body, stamp);
    var themes = body.themes || [];
    if (dynThemes > 0) {
      applied += dynThemes;
    } else {
      themes.forEach(function (t, i) {
        var block = findThemeBlock(t, i);
        if (block) applied += applyTheme(t, block);
      });
      if (themes.length) markThemeHead(stamp);
    }

    // 비중법사·홍인기 탭 — 장중 실시간 기준봉/타점 판정 패널
    applied += renderStrategyLive(body, stamp);

    // 1번 탭 — 52주 신고가 / 100억+ 상한가
    var panels = overviewPanels();
    applied += renderHigh52(panels.gold, body.high52, stamp);
    applied += renderUpperLimit(panels.red, body.upperLimit, stamp);

    // 3·5번 탭 — 실시간 뉴스
    applied += renderNews(body, stamp);

    // 3번 탭 — 시간외 체결 대금·등락 순위 (감시군 실시간 산출)
    var afCount = renderAftermarket(body, stamp);
    if (afCount > 0) {
      applied += afCount;
      state.mounted.afterTop = true;
    }

    // 주말 휴장 문구 정정
    fixSessionWording(body.sessionPhase);

    state.applied = applied;
    return applied;
  }

  /* ------------------------------ 폴링 ------------------------------ */

  function poll(fresh) {
    if (state.polling) return;
    state.polling = true;
    state.reqId += 1;
    var reqId = state.reqId;

    var controller = null;
    var timer = null;
    try { controller = new AbortController(); } catch (e) { controller = null; }
    if (controller) timer = setTimeout(function () { try { controller.abort(); } catch (e) { /* noop */ } }, 14000);

    var url = TABS_URL + (fresh ? '?fresh=1' : '');
    fetch(url, controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null;
          try { json = JSON.parse(text); } catch (e) { json = null; }
          return { status: res.status, body: json };
        });
      })
      .then(function (out) {
        if (timer) clearTimeout(timer);
        state.polling = false;
        if (reqId !== state.reqId) return;
        var body = out.body;
        if (!body || body.ok !== true) {
          state.ok = false;
          setBadge(false, '⚠️ 1·3·5탭 API 응답 없음 · 내장 데이터 유지');
          console.warn('[TabsLive] API 실패 (HTTP ' + out.status + ') — 내장 데이터 유지');
          return;
        }
        var applied = apply(body);
        state.lastBody = body;
        if (applied > 0) {
          state.ok = true;
          state.lastAt = nowHms();
          setBadge(true, '⚡ 1·3·5탭 LIVE ' + state.lastAt + ' 갱신');
          console.log('[TabsLive] ' + body.generatedAtKst + ' ' + body.sessionPhase +
            ' 테마=' + (body.themes || []).length +
            ' 52주=' + (body.high52 ? (body.high52.byValue || []).length : 0) +
            ' 상한가=' + (body.upperLimit ? (body.upperLimit.confirmed || []).length : 0) +
            ' 임박=' + (body.upperLimit ? (body.upperLimit.near || []).length : 0) +
            ' 뉴스=' + (body.news || []).length + ' applied=' + applied +
            ' errors=' + (body.errors || []).length);
        } else {
          state.ok = false;
          setBadge(false, '⚠️ 1·3·5탭 갱신 항목 없음 · 내장 데이터 유지');
        }
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        state.polling = false;
        if (reqId !== state.reqId) return;
        state.ok = false;
        var reason = err && err.name === 'AbortError' ? '응답 시간 초과' : (err && err.message ? err.message : String(err));
        setBadge(false, '⚠️ 1·3·5탭 API 연결 실패 · 내장 데이터 유지');
        console.warn('[TabsLive] 호출 실패: ' + reason);
      });
  }

  function start() {
    poll(false);
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (document.hidden) return;
      poll(false);
    }, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) poll(false);
    });
  }

  /* --------------- 🔄 즉시 새로고침 — 누르면 tabs-live 도 갱신 --------------- */

  function patchForceRefresh() {
    var orig = window.forceLiveRefresh;
    if (typeof orig !== 'function') return false;
    if (orig.__tabsPatched) return true;
    var patched = function () {
      try {
        console.log('[TabsLive] 🔄 즉시 새로고침 → /api/tabs-live?fresh=1');
        poll(true);
      } catch (e) { /* noop */ }
      return orig.apply(this, arguments);
    };
    patched.__tabsPatched = true;
    window.forceLiveRefresh = patched;
    return true;
  }

  window.TabsLive = {
    poll: poll,
    start: start,
    apply: apply,
    refresh: function () { poll(true); },
    state: state,
    _applyTheme: applyTheme,
    _renderHigh52: renderHigh52,
    _renderUpperLimit: renderUpperLimit,
    _renderNews: renderNews,
    _renderStrategyLive: renderStrategyLive,
    _renderDynamicThemes: renderDynamicThemes
  };

  function boot() {
    if (!patchForceRefresh()) {
      var tries = 0;
      var t = setInterval(function () {
        tries += 1;
        if (patchForceRefresh() || tries > 20) clearInterval(t);
      }, 250);
    }
    start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
