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

  /* ------------------------- 장전(PREOPEN) 미체결 가드 -------------------------
   *  장이 열리기 전 네이버는 전 지수·종목을 '보합(0.00%) · 거래대금 -' 로 내려준다.
   *  이 값으로 화면을 덮으면 07:30 동기화로 그려 둔 '전일(11/18) 확정' 등락률·대금이 0.00% 로 지워진다.
   *  → 체결 근거(거래량·등락률)가 없는 장전 응답은 화면에 반영하지 않는다.
   *    (정규장 안의 진짜 보합 0.00% 는 체결·거래량이 있으므로 그대로 반영된다)
   */
  function isPreopen(payload) {
    return String((payload && payload.marketStatus) || '').toUpperCase() === 'PREOPEN';
  }
  function quoteTraded(q) {
    if (!q) return false;
    var vol = num(q.volume);
    if (vol !== null && vol > 0) return true;
    var chg = num(q.change);
    if (chg !== null && chg !== 0) return true;
    var pct = num(q.changePct);
    if (pct !== null && pct !== 0) return true;
    var over = num(q.overVolume);
    if (over !== null && over > 0) return true;
    return false;
  }
  /* '-' · '0' 같은 빈 값으로 옛 거래대금을 지우지 않게 */
  function liveValueText(v) {
    if (v === null || v === undefined) return null;
    var t = String(v).trim();
    if (!t || t === '-' || t === '—' || t === '0') return null;
    return t;
  }

  /* 통합 대금 표기 — '589억(NXT 445억)' (NXT 없으면 '589억'). 값이 없으면 null.
     · API 의 valueDispText(통합+NXT 병기) → valueIntegText(통합) → valueText 순으로 고른다. */
  function vText(o) {
    if (!o) return null;
    return liveValueText(o.valueDispText) || liveValueText(o.valueIntegText) || liveValueText(o.valueText);
  }
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
    var preopen = isPreopen(payload);
    var indices = payload.indices || [];
    /* 화면에 실제로 반영한 값을 남긴다 — '💾 오늘 저장' 이 옛 하드코딩 대신 이 값을 쓴다 */
    try {
      window.__LIVE_SNAPSHOT = {
        at: payload.generatedAtKst || nowText(),
        marketStatus: payload.marketStatus || null,
        indices: indices.map(function (i) {
          /* 장전 미체결 지수는 등락률을 비워 둔다 — 저장 기록에 0.00% 가 박히지 않게 */
          return { key: i.key, price: num(i.price),
                   changePct: preopen && !quoteTraded(i) ? null : num(i.changePct),
                   status: i.status || null, valueText: liveValueText(i.valueText) };
        })
      };
    } catch (e) { /* noop */ }

    for (var i = 0; i < indices.length; i += 1) {
      var idx = indices[i];
      var price = num(idx.price);
      if (price === null) continue;
      var p = num(idx.changePct);
      /* 장전 미체결이면 티커·모달의 전일 확정 등락률을 0.00% 로 덮지 않는다 */
      if (preopen && !quoteTraded(idx)) continue;
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
    var heldCodes = [];
    (payload.stocks || []).forEach(function (s) {
      if (!s || !s.code) return;
      /* 장전 미체결 종목은 손대지 않는다 — RN존·종베·만쥬 카드의 11/18 확정값 유지 */
      if (preopen && !quoteTraded(s)) { heldCodes.push(s.code); return; }
      map[s.code] = {
        price: num(s.price),
        changePct: num(s.changePct),
        // 카드의 거래대금은 통합(KRX+NXT·시간외 포함) 기준을 우선한다
        valueText: vText(s),
        valueEok: num(s.value) === null ? null : s.value / 1e8,   // IIFE1 헬퍼는 num() (isNum 은 4번째 IIFE 전용)
        valueNxtText: liveValueText(s.valueNxtText),
        valueBasis: s.valueBasis || null
      };
    });
    state.preopenHeld = preopen ? heldCodes.length : 0;
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
      if (c.valueEl && (q.valueText || vText(q)) && document.body.contains(c.valueEl)) {
        c.valueEl.textContent = q.valueText || vText(q);
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
   * 6번 RN존 탭 — 기본 목록 종목의 250봉(1년)·현재가·RN선을 동적 갱신
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

  /* RN존 차트는 250봉(1년)을 쓴다 — 60봉만 받아 오면 들고 있던 1년 이력이 60봉으로 잘려
     '직전 상단 RN 터치 후 눌림' 파동이 사라진다(2026-11-25 수리). */
  var RN_CANDLE_COUNT = 250;

  /** 종목 1개의 250봉·현재가·RN을 받아 RN존 목록 항목을 교체한다. 실패 시 false. */
  function refreshStockData(code) {
    if (!code) return Promise.resolve(false);
    return fetchChartJson(code, RN_CANDLE_COUNT)
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
            ' 종목 250봉·현재가·RN선 최신 ( /api/stock-chart )', 'ok');
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

    // ⚡ 1번 탭만 보고 있어도 RN존 종목 실측(250봉·RN선)을 백그라운드로 받아 둔다.
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

  /* ------------------ RN존 실시간 종목 조회 (250일봉 + RN) ------------------ */

  function setSearchStatus(text, kind) {
    var el = byId('liveSearchStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = kind === 'err' ? '#fca5a5' : kind === 'ok' ? '#34d399' : kind === 'warn' ? '#fbbf24' : '#94a3b8';
  }

  /** KRX 호가 단위로 반올림 — RN존 타점·목표가가 종이 위 숫자가 되지 않게 한다 */
  function krTick(p) {
    var v = Math.abs(p);
    if (v < 2000) return 1;
    if (v < 5000) return 5;
    if (v < 20000) return 10;
    if (v < 50000) return 50;
    if (v < 200000) return 100;
    if (v < 500000) return 500;
    return 1000;
  }
  function tickRound(v) {
    var t = krTick(v);
    return Math.round(Number(v) / t) * t;
  }

  function toRnStock(json) {    var raw = json.candles || [];
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

    /* 장전(PREOPEN)에는 네이버가 '현재가 = 전일 종가 근사치 · 등락률 0.00%' 를 내려준다.
     *  그 값을 그대로 쓰면 RN존 카드·칩의 11/18 확정 등락률이 0.00% 로 지워진다.
     *  체결이 없는 장전에는 마지막 일봉(직전 거래일 확정 종가·등락률)을 쓴다 — 쌍이 서로 맞는다. */
    var cur = json.current || {};
    var curPct = num(cur.changePct);
    var curChg = num(cur.change);
    var noTrade = String(cur.marketStatus || '').toUpperCase() === 'PREOPEN' && !cur.liveBar &&
      (curPct === null || curPct === 0) && (curChg === null || curChg === 0);
    var lastCandle = candles[candles.length - 1];

    var price = noTrade ? lastCandle.close
      : (num(cur.price) !== null ? cur.price : lastCandle.close);
    price = Math.round(price);
    var rn = json.rn || {};
    var rnBand = rn.band !== undefined && num(rn.band) !== null ? rn.band : null;
    var lower = rn.nearestSupport && num(rn.nearestSupport.level) !== null ? rn.nearestSupport.level : Math.floor(price / 10) * 10;
    var upper = rn.nearestResistance && num(rn.nearestResistance.level) !== null ? rn.nearestResistance.level : Math.ceil(price * 1.1);
    if (!(lower > 0)) lower = Math.floor(price / 10) * 10;
    if (!(upper > lower)) upper = Math.ceil(price * 1.1);
    var buy1 = tickRound(lower * 1.04);
    var buy2 = tickRound(buy1 * 0.8);
    var changePct = noTrade ? lastCandle.ratio
      : (curPct !== null ? Number(curPct.toFixed(2)) : Number(lastCandle.ratio));

    return {
      name: json.name || json.code,
      code: json.code,
      category: 'search',
      price: price,
      changeRatio: changePct,
      upperRN: Math.round(upper),
      lowerRN: Math.round(lower),
      /* 공식 21개 RN선 색상·분류(/api/stock-chart rn) — 카드 지표·차트 수평선에 그대로 쓴다 */
      upperColor: rn.upperColor || null,
      lowerColor: rn.lowerColor || null,
      upperColorHex: rn.upperColor || null,
      lowerColorHex: rn.lowerColor || null,
      upperColorKo: rn.upperColorKo || null,
      lowerColorKo: rn.lowerColorKo || null,
      rnCategory: rn.category || null,
      rnBand: rnBand,
      buy1: buy1,
      buy2: buy2,
      targetMin: tickRound(buy1 * 1.07),
      targetMax: tickRound(buy1 * 1.2),
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
    setSearchStatus('⏳ ' + q + ' 실시간 조회 중… (250일봉 + RN 지지/저항)', null);

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
            (j.stocks || []).forEach(function (s) { if (s && s.code) map[s.code] = { price: num(s.price), changePct: num(s.changePct), valueText: vText(s) }; });
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

  /** 모달 제목 → 종목명 (코드·이모지·등락률·금액·[수급 3위] 같은 꼬리표 제거) */
  function cleanName(title) {
    return String(title || '')
      .replace(/\((\d{6})\)/g, ' ')
      /* 카드 제목 뒤에 붙는 대괄호 꼬리표([수급 3위]·[외인 순매도 1위] 등)는 종목명이 아니다 */
      .replace(/\[[^\]]{0,30}\]/g, ' ')
      .replace(/[★☆👑🎯🏆⚡☣🔥🔎📊📈📉]/g, ' ')
      .replace(/상한가|상한가임박|대장주|대장|수혜주|수혜|원탑|경보|돌파|안착|임박|신고가/g, ' ')
      .replace(/(외국인|외인|기관|개인)?\s*(순매수|순매도|수급)/g, ' ')
      .replace(/\d{1,3}(,\d{3})*(\.\d+)?\s*원/g, ' ')
      .replace(/[+\-]?\d+(\.\d+)?\s*%/g, ' ')
      .replace(/(^|\s)\d{1,3}\s*위(?=\s|$)/g, ' ')
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

  /* ── 종목코드 최종 폴백 ───────────────────────────────────────────────
     내장 500일 캔들 DB에는 있는데 window.stockCodes(내장 87종목)에 없는 종목
     (예: SK스퀘어 402340)은 코드를 못 찾아 '⏳ 종목코드 확인 중…'에서 영구히 멈췄다.
     /api/stock-chart 는 종목명을 네이버 자동완성·검색으로 6자리 코드까지 해석해 주므로
     그 응답의 code 로 네이버·토스 링크를 즉시 활성화한다(실패하면 '네이버에서 검색'). */
  var codeLookup = { cache: {}, reqId: 0 };

  function resolveCodeViaApi(name, title) {
    var query = name || cleanName(title);
    if (!query) { markLinksFailed(name); return; }
    if (codeLookup.cache[query]) { setLinks(codeLookup.cache[query]); return; }
    codeLookup.reqId += 1;
    var myId = codeLookup.reqId;
    var controller = null;
    var timer = null;
    try { controller = new AbortController(); } catch (e) { controller = null; }
    if (controller) timer = setTimeout(function () { try { controller.abort(); } catch (e) { /* noop */ } }, 9000);
    fetch(CHART_URL + '?code=' + encodeURIComponent(query) + '&count=20',
      controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (res) { return res.json().catch(function () { return null; }); })
      .then(function (body) {
        if (timer) clearTimeout(timer);
        if (myId !== codeLookup.reqId) return;         // 그 사이 다른 종목이 열렸다
        var code = body && body.ok === true ? String(body.code || '') : '';
        if (/^\d{6}$/.test(code)) {
          codeLookup.cache[query] = code;
          setLinks(code);
        } else {
          markLinksFailed(name || query);
        }
      })
      .catch(function () {
        if (timer) clearTimeout(timer);
        if (myId !== codeLookup.reqId) return;
        markLinksFailed(name || query);
      });
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

  /** 모달 차트 캔버스를 비운다 — 조회 실패 때 '앞 종목 차트'가 남아 사실처럼 보이는 것을 막는다 */
  function clearModalChart() {
    window.modalAllCandles = [];
    var canvas = $('modalChartCanvas');
    if (canvas) {
      try {
        var ctx = canvas.getContext('2d');
        var dpr = window.devicePixelRatio || 1;
        var rect = canvas.getBoundingClientRect();
        var w = Math.max(160, Math.round(rect.width || (canvas.parentElement && canvas.parentElement.clientWidth) || 340));
        var h = Math.max(120, Math.round(rect.height || 210));
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#070c14';
        ctx.fillRect(0, 0, w, h);
      } catch (e) { /* noop */ }
    }
    if ($('modalChartHigh')) $('modalChartHigh').textContent = '—';
    if ($('modalChartLow')) $('modalChartLow').textContent = '—';
    if ($('modalChartTitleTxt')) $('modalChartTitleTxt').textContent = '📊 실시간 캔들 & 추세선 차트';
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
    /* 뉴스 제목처럼 '종목명이 아닌 문장'을 차트 API 로 보내면 404 만 쌓인다 → 요청하지 않고 사실대로 말한다.
     *  (종목코드가 있거나, 짧은 종목명이면 그대로 조회한다 — 긴 제목만 걸러낸다) */
    var known = null;
    try { known = code || (window.stockCodes && window.stockCodes[name]) || null; } catch (e) { known = code || null; }
    var wordCount = String(query).split(/\s+/).filter(Boolean).length;
    if (!known && (String(query).length >= 18 || wordCount >= 5)) {
      clearModalChart();
      showNotice('📰 이 항목은 종목이 아니라 기사·지표 제목입니다 —\n종목 차트를 조회하지 않습니다.', '#94a3b8');
      setTrend('종목 아님(기사·지표)', '#94a3b8');
      markLinksFailed(name);
      return;
    }

    // 가짜·이전 종목 차트가 남아 있으면 지운 뒤 로딩 안내를 띄운다
    clearModalChart();
    window.modalViewCount = 60;
    window.modalViewOffset = 0;
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
          clearModalChart();
          showNotice('⚠️ ' + msg + '\n가짜 차트를 대신 그리지 않습니다. 잠시 후 다시 눌러 주세요.', '#fca5a5');
          setTrend('실시간 데이터 없음', '#fca5a5');
          markLinksFailed(name);
          return;
        }
        var candles = (body.candles || []).map(function (c) {
          return { date: c.date, open: c.o, high: c.h, low: c.l, close: c.c, vol: c.v };
        });
        if (!candles.length) {
          clearModalChart();
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
        clearModalChart();
        showNotice('⚠️ 실시간 일봉 조회 실패: ' + reason, '#fca5a5');
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
        else {
          /* 내장 DB엔 있지만 코드표에 없는 종목 — 대기 상태로 두지 말고 API로 코드를 찾는다 */
          markLinksPending();
          resolveCodeViaApi(name, title);
        }
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
        else { markLinksPending(); resolveCodeViaApi(name, title); }
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
 * ⚡ 실시간 브리핑 모달 — 2026-11-22 새 구현으로 이관
 * ----------------------------------------------------------------------------
 *  예전에는 이 블록이 window.openLiveBriefingModal 을 감싸서(monkey patch)
 *  모달을 '실시간 팩트 + 정시 브리핑 스냅샷'으로 다시 그렸다. 그 래퍼가 새 모달을
 *  덮어써 화면이 두 번 바뀌고 옛 스냅샷이 남았으므로 **래퍼를 걷어냈다**.
 *  버튼 클릭 → 그 시각 실측 즉석 브리핑(/api/content-ai live_briefing)과
 *  '🔄 지금 다시 생성' 재호출은 index.html 의 openLiveBriefingModal / runLiveBriefing 이 맡는다.
 * ==========================================================================*/
(function () {
  'use strict';
  window.LiveBriefing = {
    open: function () { if (typeof window.openLiveBriefingModal === 'function') window.openLiveBriefingModal(); }
  };
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
 *       (기존 스타일은 보존 · 과거 유사사례 문구는 2026-11-22 제거)
 *
 *  · 원칙: API 가 실패하면 화면을 지우지 않는다. 내장(정적) 데이터를 그대로 유지하고
 *    배지만 '⚠️ 1·3·5탭 API 실패' 로 바꾼다. 확인된 응답값만 표시하고 없는 값은 '—'.
 * ==========================================================================*/
(function () {
  'use strict';

  var TABS_URL = '/api/tabs-live';
  /* 통합 대금 표기 — '612억(NXT 457억)' (NXT 없으면 '612억') · 값이 없으면 null.
     · API 의 valueDispText(통합+NXT 병기) → valueIntegText(통합) → valueText 순으로 고른다.
     · 이 파일은 IIFE 가 여러 개라 렌더 블록마다 같은 도우미를 둔다(스코프 분리). */
  function vText(o) {
    if (!o) return null;
    var v = o.valueDispText || o.valueIntegText || o.valueText;
    if (v === null || v === undefined) return null;
    var t = String(v).trim();
    if (!t || t === '-' || t === '—' || t === '0') return null;
    return t;
  }

  var CHART_API_URL = '/api/stock-chart';
  var POLL_MS = 30000;
  var AFTER_MIN_VALUE = 10 * 1e8; // 3번 탭 '거돈대금 10억↑만 보기' 기준(10억 원)
  var AFTER_FILTER_KEY = 'tabs_after_min10eok';

  /* 3번 탭 필터 기본값 — 명시적으로 끈 적이 없으면 ON */
  function afterFilterOn() {
    if (state.afterMinValue !== null) return state.afterMinValue;
    var saved = null;
    try { saved = window.localStorage ? window.localStorage.getItem(AFTER_FILTER_KEY) : null; } catch (e) { saved = null; }
    state.afterMinValue = saved === '0' ? false : true;
    return state.afterMinValue;
  }

  function setAfterFilter(on) {
    state.afterMinValue = Boolean(on);
    try { if (window.localStorage) window.localStorage.setItem(AFTER_FILTER_KEY, on ? '1' : '0'); } catch (e) { /* 저장소 없음 */ }
    if (state.lastAf && state.lastAfStamp) renderAftermarket({ aftermarket: state.lastAf }, state.lastAfStamp, true);
    return state.afterMinValue;
  }

  function toggleAfterFilter() { return setAfterFilter(!afterFilterOn()); }

  /* --- 3·5번 탭 '📡 실시간 최신 증시 속보' 박스 접기/펼치기 (11/24 사용자 요청) ----------
   *  · 이 박스는 host.innerHTML 을 30초 폴링마다 통째로 다시 그린다 → 접힘 상태를 DOM 에만 두면
   *    다음 갱신에서 펼쳐진다. 그래서 접힘을 렌더 HTML 자체(display:none)에 넣고 data-sig 에도
   *    포함시켜, 다시 그려져도 사용자가 접어 둔 상태가 그대로 유지되게 한다.
   *  · 상태는 localStorage 에 남겨 새로고침·재방문에도 유지된다.
   */
  var NEWS_FOLD_KEY = 'tabs_news_fold_v1';

  function newsFoldMap() {
    try {
      var raw = window.localStorage ? window.localStorage.getItem(NEWS_FOLD_KEY) : null;
      var o = raw ? JSON.parse(raw) : {};
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }

  function newsBoxFolded(key) {
    var m = newsFoldMap();
    return m[key] === true || m[key] === 1 || m[key] === '1';
  }

  function setNewsBoxFolded(key, folded) {
    var m = newsFoldMap();
    m[key] = Boolean(folded);
    try { if (window.localStorage) window.localStorage.setItem(NEWS_FOLD_KEY, JSON.stringify(m)); } catch (e) { /* 저장소 없음 */ }
    return Boolean(folded);
  }

  function applyNewsFoldDom(key, folded) {
    var bodies = document.querySelectorAll('[data-news-body="' + key + '"]');
    for (var i = 0; i < bodies.length; i += 1) bodies[i].style.display = folded ? 'none' : '';
    var btns = document.querySelectorAll('[data-news-toggle="' + key + '"]');
    for (var j = 0; j < btns.length; j += 1) {
      btns[j].textContent = folded ? '펼치기 ▾' : '접기 ▴';
      btns[j].setAttribute('aria-expanded', folded ? 'false' : 'true');
    }
  }

  /* 버튼이 누르는 함수 — 상태를 뒤집고 지금 화면의 두 탭 박스를 즉시 바꾼다.
     다음 폴링은 newsBoxHtml 이 저장된 상태로 다시 그리므로 접힘이 풀리지 않는다. */
  function toggleNewsBox(key) {
    if (!key) return false;
    var next = !newsBoxFolded(key);
    setNewsBoxFolded(key, next);
    applyNewsFoldDom(key, next);
    return next;
  }

  var state = {
    polling: false,
    ok: null,
    timer: null,
    lastAt: null,
    lastBody: null,
    applied: 0,
    mounted: { news: false, after: false, afterTop: false },
    sessionPhase: null,
    reqId: 0,
    renderErrors: 0,   // 이번 갱신에서 예외가 난 렌더러 수(성공 배지와 분리해 표시)
    pendingRest: 0,    // 지금 보는 탭을 먼저 그린 뒤 백그라운드로 채울 렌더 수
    cacheHit: false,   // sessionStorage 캐시로 먼저 그렸는지
    prevQuotes: {},    // ⑦ 반짝임 판정용 직전 시세(종목코드 → 가격·등락률)
    folds: {},          // 접힘 목록 사용자 상태(기본 접힘)
    afterMinValue: null, // 3번 탭 '시간외 대금 10억↑만 보기' 토글 상태(null=기본 ON)
    tv: null,            // 당일 거래대금 1분 버킷(종목코드 → [[분, 억], ...])
    tvDate: null,        // 버킷을 불러온 날짜(당일 키)
    tvNowMin: null       // 마지막 버킷 기록 분
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

  /* ---------------- 장전(PREOPEN) 가드 — 이 IIFE 전용 사본 ----------------
   *  이 파일 위쪽(지수·감시종목 레이어)에도 같은 이름의 함수가 있지만 다른 IIFE 라
   *  여기서는 보이지 않는다. renderNxtTracks 가 그 이름을 그대로 써서 갱신마다
   *  ReferenceError 가 났고, 그 예외가 폴링 catch 로 떨어져 화면에는
   *  '⚠️ 1·3·5탭 API 연결 실패' 로 표시됐다(실제로는 200 OK 응답을 받고 있었다).
   *  → 탭 레이어 안에 자체 정의해 스코프 사고로 탭 전체 렌더가 멈추지 않게 한다. */
  function isPreopen(payload) {
    return String((payload && payload.marketStatus) || '').toUpperCase() === 'PREOPEN';
  }
  function quoteTraded(q) {
    if (!q) return false;
    if (isNum(q.volume) && q.volume > 0) return true;
    if (isNum(q.change) && q.change !== 0) return true;
    if (isNum(q.changePct) && q.changePct !== 0) return true;
    if (isNum(q.overVolume) && q.overVolume > 0) return true;
    return false;
  }

  /* ---------------- ① sessionStorage 3분 초고속 캐시 ----------------
   *  최근 실시간(/api/tabs-live) 응답만 sessionStorage 에 3분간 보관한다.
   *  화면을 열면 캐시로 0.1초 안에 먼저 그리고(이전에 보던 날짜면 즉시 폐기),
   *  백그라운드에서 최신 응답으로 교체한다. 3분이 지난 캐시는 쓰지 않는다. */
  var CACHE_KEY = 'sd_tabs_live_cache_v1';
  var CACHE_TTL = 3 * 60 * 1000;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function kstDateKey(d) {
    var t = d ? new Date(d.getTime()) : new Date();
    var k = new Date(t.getTime() + (t.getTimezoneOffset() * 60000) + (9 * 3600000));
    return k.getFullYear() + '-' + pad2(k.getMonth() + 1) + '-' + pad2(k.getDate());
  }
  function bodyDateKey(body) {
    var label = String((body && body.generatedAtLabel) || '');
    if (/^\d{4}-\d{2}-\d{2}/.test(label)) return label.slice(0, 10);
    if (body && body.generatedAt) {
      var d = new Date(body.generatedAt);
      if (!isNaN(d.getTime())) return kstDateKey(d);
    }
    return null;
    }
  function saveCache(body) {
    if (!body || body.ok !== true) return;
    try {
      var store = window.sessionStorage;
      if (!store) return;
      store.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), day: bodyDateKey(body), body: body }));
    } catch (e) { /* 저장소 없음·용량 초과 */ }
  }
  function readCache() {
    try {
      var store = window.sessionStorage;
      if (!store) return null;
      var raw = store.getItem(CACHE_KEY);
      if (!raw) return null;
      var rec = JSON.parse(raw);
      if (!rec || !rec.body || rec.body.ok !== true) return null;
      var age = Date.now() - (rec.t || 0);
      if (!(age >= 0 && age <= CACHE_TTL)) { store.removeItem(CACHE_KEY); return null; }
      /* 옛 날짜 응답이 오늘 화면에 섞이지 않게 오늘(KST) 데이터만 복원한다 */
      var day = rec.day || bodyDateKey(rec.body);
      if (day !== kstDateKey()) { store.removeItem(CACHE_KEY); return null; }
      return rec.body;
    } catch (e) { return null; }
  }

  /* ---------------- ⑦ 바뀐 숫자만 0.5초 반짝임 ---------------- */
  function flashEl(el, pct) {
    if (!el || !el.classList) return;
    try {
      el.classList.remove('sd-num-flash', 'sd-num-up', 'sd-num-down');
      void el.offsetWidth; /* 애니메이션 재시작 */
      el.classList.add('sd-num-flash');
      el.classList.add(isNum(pct) && pct < 0 ? 'sd-num-down' : 'sd-num-up');
      if (el.__sdFlashTimer) clearTimeout(el.__sdFlashTimer);
      el.__sdFlashTimer = setTimeout(function () {
        try { el.classList.remove('sd-num-flash', 'sd-num-up', 'sd-num-down'); } catch (e) { /* noop */ }
      }, 500);
    } catch (e) { /* noop */ }
  }

  /* ---------------- 렌더 단계별 예외 격리 ----------------
   *  한 렌더러가 예외를 던져도 나머지 탭 렌더가 멈추지 않게 한다.
   *  (예전에는 예외 하나가 폴링 전체를 catch 로 떨어뜨려 'API 연결 실패' 로 보였다) */
  function safe(label, fn) {
    try {
      var v = fn();
      return isNum(v) ? v : 0;
    } catch (e) {
      state.renderErrors = (state.renderErrors || 0) + 1;
      try { console.warn('[TabsLive] ' + label + ' 렌더 실패: ' + (e && e.message ? e.message : e)); } catch (e2) { /* noop */ }
      return 0;
    }
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

  /* ---------------- ② 실시간 기준 시각 뱃지 (⏱ 10:35 실측 · 네이버) ----------------
   *  화면에 지금 깔린 숫자가 몇 시 몇 분에 실측된 값인지, 어느 소스인지 명시한다.
   *  KIS 는 응답 sources 에 실제로 있을 때만 적는다(없는데 적으면 가짜 표기가 된다). */
  function stampLabel(body) {
    var list = (body && body.sources) || [];
    var hasNaver = false, hasKis = false, hasSe = false;
    for (var i = 0; i < list.length; i += 1) {
      var n = String((list[i] && list[i].name) || '').toLowerCase();
      if (n.indexOf('naver') === 0 || n.indexOf('naver-') >= 0) hasNaver = true;
      if (n.indexOf('kis') >= 0) hasKis = true;
      if (n.indexOf('stockeasy') >= 0) hasSe = true;
    }
    if (body && body.themeSeIn) hasSe = true;
    var parts = [];
    if (hasKis) parts.push('KIS');
    if (hasNaver) parts.push('네이버');
    if (hasSe) parts.push('스탁이지');
    return parts.length ? parts.join('/') : '실시간';
  }

  function setStamp(body, cached) {
    var el = document.getElementById('tabsLiveStamp');
    if (!el) return;
    var hm = String((body && body.generatedAtKst) || '').slice(0, 5);
    var txt = hm ? '⏱ ' + hm + ' 실측 · ' + stampLabel(body) : '⏱ 실측 시각 확인 중';
    if (cached) txt += ' · 캐시';
    if (el.textContent !== txt) el.textContent = txt;
    el.title = (body && body.generatedAtLabel ? body.generatedAtLabel + ' KST 응답' : '') +
      ' · ' + (body && body.themeSource === 'naver-theme' ? '네이버 테마 랭킹' : '테마 랭킹 확인 중');
    el.setAttribute('data-ok', cached ? '0' : '1');
    el.style.color = cached ? '#fbbf24' : '#34d399';
    el.style.borderColor = cached ? 'rgba(245,158,11,0.45)' : 'rgba(16,185,129,0.4)';
  }

  /* ---------------- ③ 지연 시 '다시 불러오기' 스트립 ----------------
   *  옛 종목·옛 테마를 대신 깔지 않고, 지연 사실과 재시도 버튼만 보여준다. */
  function showRetry(reason) {
    var box = document.getElementById('tabsLiveRetry');
    if (!box) return;
    var txt = box.querySelector('.tlr-txt');
    if (txt) {
      var msg = '⏱ 실시간 응답이 지연되고 있습니다' + (reason ? ' (' + reason + ')' : '') +
        ' — 옛 종목을 대신 보여주지 않습니다.';
      if (txt.textContent !== msg) txt.textContent = msg;
    }
    box.hidden = false;
    box.setAttribute('data-reason', String(reason || ''));
  }
  function hideRetry() {
    var box = document.getElementById('tabsLiveRetry');
    if (!box) return;
    if (!box.hidden) box.hidden = true;
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
      var prevChange = changeEl.textContent;
      var nextChange = pctTxt(pctVal) + (live ? ' 프' : '');
      /* ⑦ 값이 실제로 바뀐 종목만 0.5초 반짝인다(화면 전체 깜박임 금지) */
      if (prevChange && prevChange !== nextChange) flashEl(changeEl, pctVal);
      changeEl.textContent = nextChange;
      changeEl.title = live ? 'NXT 프리마켓 체결가 기준 (전일 종가 대비)' : '';
      changeEl.style.color = colFor(pctVal);
      hits += 1;
    }

    var ohlcEl = tile.querySelector('.st-ohlc');
    if (ohlcEl && isNum(priceVal)) {
      var prevPriceEl = ohlcEl.querySelector('strong');
      var prevPrice = prevPriceEl ? prevPriceEl.textContent : '';
      ohlcEl.innerHTML =
        (live ? '프' : '종') + ' <strong>' + esc(fmt(priceVal)) + '</strong> | 시 ' + esc(fmt(stock.open)) +
        ' 고 ' + esc(fmt(stock.high)) + ' 저 ' + esc(fmt(stock.low));
      var nextPriceEl = ohlcEl.querySelector('strong');
      if (prevPrice && nextPriceEl && prevPrice !== nextPriceEl.textContent) flashEl(nextPriceEl, pctVal);
      hits += 1;
    }

    var volEl = tile.querySelector('.st-vol');
    if (volEl && vText(stock)) {
      var g = isNum(stock.value) && stock.code ? tvGain(stock.code, tvEok(stock.value), state.tvNowMin) : null;
      volEl.className = 'st-vol' + (g && g.level !== 'low' ? ' tv-' + g.level : '');
      volEl.innerHTML = esc(vText(stock)) +
        (g ? '<span class="tv-gain">' + esc(tvGainText(g)) + '</span>' : '') +
        (g && g.level === 'hot' ? '<span class="tv-badge">🔥 급증</span>' : '');
      volEl.title = '거래대금 ' + vText(stock) + ' (' + (stock.valueBasis || '통합') + ')' +
        (g ? ' · ' + tvTip(g) + (tvLevelText(g) ? ' · ' + tvLevelText(g) : '') : '');
      hits += 1;
    }

    if (isNum(priceVal)) {
      var nameEl = tile.querySelector('.st-name');
      var shownName = nameEl ? nameEl.textContent.replace(/[★☆\s]/g, '') : (stock.tileName || stock.name);
      refreshTileOnclick(
        tile,
        shownName,
        pctTxt(pctVal),
        '대금 ' + (vText(stock) || '—') + ' | 현재가 ' + fmt(priceVal) + '원'
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
        ? '당일 고가 ' + highTxt + '으로 52주 신고가를 터치한 뒤 종가 기준 ' + pctTxt(s.changePct) + '로 밀림 · 거래대금 ' + (vText(s) || '—')
        : '당일 고가 ' + highTxt + '으로 52주 신고가 경신 · 거래대금 ' + (vText(s) || '—') + ' 유입 (네이버 증권 52주 신고가 목록)')
      : '당일 52주 신고가 목록 편입 · 거래대금 ' + (vText(s) || '—');
    var metaTxt = '대금 ' + (vText(s) || '—') + (highTxt ? ' | 고가 ' + highTxt : '') +
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
    var metaTxt = '거래대금 ' + (vText(s) || '—') + ' | 현재가 ' + fmt(s.price) + '원' +
      (isNum(s.high) ? ' | 고가 ' + fmt(s.high) + '원' : '');
    var reason = isUpper
      ? '당일 거래대금 ' + (vText(s) || '—') + ' 유입되며 ' + pctTxt(s.changePct) + ' 상한가 안착.'
      : (kind === 'near'
        ? '당일 거래대금 ' + (vText(s) || '—') + ' 유입되며 ' + pctTxt(s.changePct) + ' — +25% 상한가 임박 기준을 돌파한 상태입니다.'
        : '당일 거래대금 ' + (vText(s) || '—') + ' 유입 · 25% 돌파까지 ' +
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
          return esc(s.name) + '(' + esc(pctTxt(s.changePct)) + ', ' + esc(vText(s) || '—') + ')';
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

  /* 수혜주 칩 · inPlace=true 면 RN존 이동 대신 이 자리에서 차트 팝업(3번 탭 전용) */
  function impactStockChips(n, inPlace) {
    var list = n.beneficiaryStocks || [];
    if (!list.length) return '';
    var anyPre = list.some(function (s) { return s && s.preRun; });
    var chips = list.map(function (s) {
      var code = cleanArg(s.code);
      var name = cleanArg(s.name);
      var live = s.live || null;
      var pct = live && isNum(live.changePct) ? live.changePct : null;
      var pctColor = pct === null ? '#94a3b8' : pct > 0 ? '#f87171' : pct < 0 ? '#38bdf8' : '#cbd5e1';
      var liveTxt = live
        ? '<span style="color:' + pctColor + ';font-weight:900;font-variant-numeric:tabular-nums;">' +
            (pct === null ? '—' : (pct > 0 ? '+' : '') + pct.toFixed(2) + '%') + '</span>' +
          (vText(live) ? ' <span style="color:#94a3b8;font-weight:700;">' + esc(vText(live)) + '</span>' : '')
        : '<span style="color:#64748b;font-weight:700;">시세 대기</span>';
      var preBadge = s.preRun
        ? '<span title="기사가 나온 시점에 이미 +15% 이상 오른 종목 — 뉴스가 가격을 끌어올린 것이 아니라 이미 반영됐거나 뒤늦은 기사일 수 있습니다."' +
            ' style="font-size:9px;font-weight:900;color:#fca5a5;background:rgba(239,68,68,0.16);border:1px solid rgba(239,68,68,0.45);padding:1px 4px;border-radius:3px;white-space:nowrap;">⚠️ 선반영/후행</span>'
        : '';
      var tip = '종목코드 ' + code + ' · ' +
        (inPlace ? '누르면 이 자리에서 실시간 차트 팝업(탭 이동 없음)' : '누르면 RN존 실전 차트로 이동') +
        (live ? ' · ' + (live.valueBasis || '통합') + ' 거래대금 ' + (vText(live) || '—') : ' · 실시간 시세 미수신');
      var openJs = inPlace
        ? 'event.stopPropagation();' + inPlaceOpenJs(s.name, code,
            live && isNum(live.price) ? fmt(live.price) + '원' : '',
            pct === null ? '' : (pct > 0 ? '+' : '') + pct.toFixed(2) + '%')
        : "event.stopPropagation();tabsLiveOpenStock('" + name + "', '" + code + "')";
      return '<span onclick="' + esc(openJs) + '"' +
        ' title="' + esc(tip) + '"' +
        ' style="font-size:10px; font-weight:800; color:#6ee7b7; background:rgba(16,185,129,0.13); border:1px solid rgba(16,185,129,0.4); padding:2px 6px; border-radius:4px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; white-space:nowrap; flex-wrap:wrap;">' +
        '🎯 ' + esc(s.name) + ' <span style="font-size:9px; opacity:.7; font-weight:700;">' + esc(s.code) + '</span>' +
        liveTxt + preBadge +
        '<a href="https://m.stock.naver.com/item/' + encodeURIComponent(code) + '" target="_blank" rel="noopener noreferrer"' +
        ' onclick="event.stopPropagation()" title="네이버 증권 호가창 (새 탭)"' +
        ' style="color:#6ee7b7; text-decoration:none; opacity:.75; font-weight:900; padding-left:2px;">↗</a></span>';
    }).join('');
    return '<div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin:2px 0 3px 0;">' +
      '<span style="font-size:10px; font-weight:800; color:#34d399;">수혜·관련주</span>' + chips +
      (anyPre ? '<span style="font-size:9.5px;color:#fca5a5;font-weight:800;">← ⚠️ 는 이미 +15%↑ 오른 뒤 나온 기사</span>' : '') +
      '</div>';
  }

  function impactNoteLine(n) {
    if (!n.impactNote) return '';
    return '<div style="font-size:10px; color:#94a3b8; line-height:1.45; margin:3px 0 4px 0; padding-top:3px; border-top:1px dashed rgba(148,163,184,0.22);">🔎 ' +
      esc(n.impactNote) + '</div>';
  }

  /* 종목 칩 → RN존 실전 차트(실시간 250일봉 + RN 지지/저항). 실패 시 네이버 호가창으로 대체. */
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

  /* ============================================================================
   * 종목 클릭 → 지금 보고 있는 탭 그대로, 이 자리에서 실시간 일봉 차트 팝업
   * ----------------------------------------------------------------------------
   *  · 3번(프리·애프터마켓) 탭의 NXT 랭킹 행 · 속보 수혜주 칩은 예전에 tabsLiveOpenStock
   *    (= RN존 탭 강제 이동 + RN 검색)에 연결돼 있어, 종목을 누를 때마다 탭이 RN존으로 튀었다.
   *  · RN선 차트는 RN 탭에서만 본다. 이 자리에서는 공통 차트 팝업(openDetail)만 열고 탭은 그대로 둔다.
   *  · 팝업 캔들은 /api/stock-chart 실측 일봉(당일 실시간 봉 포함)으로 다시 그린다.
   *    조회가 실패하면 내장 일봉을 그대로 두고 제목에 출처를 솔직히 적는다(가짜 차트 금지).
   * ========================================================================== */

  var chartPopupReq = 0;

  function todayKstYmd() {
    var d = new Date(Date.now() + 9 * 3600 * 1000);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  }

  function modalVisible() {
    var ov = document.getElementById('modalOverlay');
    return Boolean(ov) && getComputedStyle(ov).display !== 'none';
  }

  /* 내장 500일 DB(직전 거래일까지)로 그려진 팝업을 실시간 일봉으로 다시 그린다.
   *  · DB에 없는 종목은 openDetail 패치(live-api.js 종목 상세 모달 블록)가 이미 API로 그리고 있으므로
   *    캔들이 비어 있으면 아무 것도 하지 않는다(중복 요청·덮어쓰기 방지). */
  function refreshPopupChart(code) {
    if (!code) return;
    var arr0 = window.modalAllCandles || [];
    var lastDate = arr0.length ? String(arr0[arr0.length - 1].date || '') : '';
    if (!arr0.length || lastDate === todayKstYmd()) return;
    chartPopupReq += 1;
    var req = chartPopupReq;
    fetch(CHART_API_URL + '?code=' + encodeURIComponent(code) + '&count=250', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (req !== chartPopupReq) return;                        // 더 최근 클릭이 있으면 이 응답은 버린다
        if (!modalVisible()) return;
        var tEl = document.getElementById('modalTitle');
        if (!tEl || String(tEl.innerText || '').indexOf(code) < 0) return; // 다른 종목 팝업으로 바뀌었으면 버린다
        if (!d || d.ok !== true || !d.candles || !d.candles.length) throw new Error('no candles');
        var arr = d.candles.map(function (c) {
          return { date: String(c.date || ''), open: c.o, high: c.h, low: c.l, close: c.c, vol: isNum(c.v) ? c.v : 0 };
        }).filter(function (c) {
          return isNum(c.close) && isNum(c.high) && isNum(c.low);
        });
        if (!arr.length) throw new Error('no usable candles');
        window.modalAllCandles = arr;
        window.modalViewCount = Math.min(60, arr.length);
        window.modalViewOffset = 0;
        if (typeof window.setModalValueUnit === 'function') window.setModalValueUnit('원', 0);
        if (typeof window.modalClearNotice === 'function') window.modalClearNotice();
        var noticeEl = document.getElementById('modalChartNotice');
        if (noticeEl) noticeEl.style.display = 'none';
        try { if (typeof window.drawModalCandles === 'function') window.drawModalCandles(); } catch (e) { /* noop */ }
        var head = document.getElementById('modalChartTitleTxt');
        if (head) head.textContent = '📊 실시간 일봉 캔들 & 추세선 (' + arr.length + '봉 · 당일 봉 포함)';
        var last = arr[arr.length - 1];
        var trend = document.getElementById('modalChartTrend');
        if (trend) trend.textContent = '실시간 일봉 · ' + last.date + ' 종가 ' + fmt(last.close) + '원';
        var cur = d.current || {};
        var v1 = document.getElementById('modalVal1');
        var v2 = document.getElementById('modalVal2');
        if (v1 && isNum(cur.price)) v1.innerText = fmt(cur.price) + '원';
        if (v2 && isNum(cur.changePct)) v2.innerText = (cur.changePct > 0 ? '+' : '') + cur.changePct.toFixed(2) + '%';
      })
      .catch(function () {
        if (req !== chartPopupReq) return;
        var head = document.getElementById('modalChartTitleTxt');
        if (head) head.textContent = '📊 내장 실측 일봉 캔들 (직전 거래일까지 · 실시간 일봉 미응답)';
      });
  }

  /* 종목 클릭 → 제자리 차트 팝업. RN존 탭으로 이동하지 않는다(11/16). */
  function openChartHere(name, code, priceText, pctText) {
    var nm = String(name || '').replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/'/g, '').replace(/\s+/g, ' ').trim();
    var cd = String(code || '').replace(/[^0-9A-Za-z]/g, '');
    if (!nm && !cd) return false;
    var opened = false;
    try {
      if (typeof window.slOpenStockChart === 'function') {
        opened = window.slOpenStockChart(nm, cd, '', priceText || '', pctText || '') !== false;
      }
    } catch (e) { opened = false; }
    if (!opened) {
      try {
        if (typeof window.openDetail === 'function') {
          window.openDetail(
            nm + (cd ? ' (' + cd + ')' : ''),
            priceText || '실시간 일봉 차트',
            pctText || '현재 탭 유지',
            '이 자리에서 연 차트입니다 — 탭을 옮기지 않습니다. 일봉은 /api/stock-chart 실시간(당일 봉 포함)이며, ' +
              '응답이 없으면 페이지 내장 실측 일봉으로 그립니다.'
          );
          opened = true;
        }
      } catch (e2) { opened = false; }
    }
    if (opened) setTimeout(function () { refreshPopupChart(cd); }, 200);
    return opened;
  }
  window.tabsLiveOpenChartHere = openChartHere;

  /* onclick 속성에 넣을 안전한 호출문 (따옴표·줄바꿈 제거) */
  function inPlaceOpenJs(name, code, priceText, pctText) {
    var nm = String(name || '').replace(/'/g, '').replace(/[\r\n]/g, ' ').trim();
    var pt = String(priceText === null || priceText === undefined ? '' : priceText).replace(/'/g, '');
    var ct = String(pctText === null || pctText === undefined ? '' : pctText).replace(/'/g, '');
    return "if(window.tabsLiveOpenChartHere){tabsLiveOpenChartHere('" + nm + "','" + esc(code || '') + "','" + pt + "','" + ct + "')}";
  }

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
        impactStockChips(n, true) + /* 3번(프리·애프터) 탭 — RN존 이동 없이 이 자리 팝업 */
        impactNoteLine(n) +
        '<div class="af-history">🕒 ' + esc(newsMeta(n)) + ' · 네이버 증권 실시간 뉴스</div>' +
      '</div>';
  }

  function newsBoxHtml(inner, list, stamp, titleSuffix, accent, boxKey) {
    var c = impactCounts(list);
    var folded = boxKey ? newsBoxFolded(boxKey) : false;
    /* 접기/펼치기 버튼 — 이 HTML 이 data-sig 로 통째 비교되므로, 누른 뒤에도 다음 갱신이 같은 상태로 그린다 */
    var foldBtn = boxKey
      ? '<button type="button" data-news-toggle="' + esc(boxKey) + '" aria-expanded="' + (folded ? 'false' : 'true') + '"' +
        ' onclick="if(window.TabsLive){TabsLive.toggleNewsBox(this.getAttribute(&#39;data-news-toggle&#39;))}"' +
        ' title="' + esc('실시간 속보 목록을 접거나 페칩니다 — 접힘 상태는 이 기기에 저장됩니다') + '"' +
        ' style="font-size:10px; font-weight:800; padding:2px 8px; border-radius:4px; cursor:pointer; white-space:nowrap;' +
        ' background:rgba(148,163,184,0.16); color:#cbd5e1; border:1px solid rgba(148,163,184,0.35);">' +
        (folded ? '펼치기 ▾' : '접기 ▴') + '</button>'
      : '';
    return '' +
      '<div class="panel-box" style="background:#111827; border-color:' + accent.border + '; margin-bottom:12px;">' +
        '<div class="sec-head" style="border-bottom-color:' + accent.border + '; color:' + accent.color + '; padding-bottom:8px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">' +
          '<span style="font-weight:800; font-size:12.5px;">📡 실시간 최신 증시 속보 ' + list.length + '건 ' + esc(titleSuffix) + '</span>' +
          '<span style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">' +
            '<span class="sub" style="color:' + accent.color + ';">⚡ ' + esc(stamp) + ' 갱신 · 네이버 증권</span>' +
            foldBtn +
          '</span>' +
        '</div>' +
        '<div' + (boxKey ? ' data-news-body="' + esc(boxKey) + '"' : '') + (folded ? ' style="display:none;"' : '') + '>' +
          '<div style="font-size:10px; color:#94a3b8; margin-bottom:8px;">' +
            '🔎 키워드 자동 분석 — 영향도 <strong style="color:#fb7185;">상 ' + c['상'] + '</strong> · ' +
            '<strong style="color:#fbbf24;">중 ' + c['중'] + '</strong> · ' +
            '<strong style="color:#94a3b8;">참고 ' + c['참고'] + '</strong> / 테마·수혜주는 매칭된 기사에만 표기' +
          '</div>' +
          inner +
          '<div style="font-size:10px; color:#64748b; margin-top:6px;">' +
            '※ 네이버 증권 실시간 뉴스 목록에서 방금 받아온 최신 속보입니다. 영향도·테마·수혜주는 제목·요약 키워드 자동 분석 결과이며(정시 AI 심층 분석과 구분), 섹터 키워드가 없는 기사는 종목을 붙이지 않고 수혜·관련주를 비웁니다. 아래 정적 타임라인은 기사 제목·시각·원문 링크만 표시합니다(과거 유사사례·수혜주 추정 문구는 2026-11-22 제거).' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function renderNewsInto(tabEl, mountId, list, stamp, buildCard, accent, titleSuffix, boxKey) {
    if (!tabEl || !list.length) return 0;
    var host = document.getElementById(mountId);
    if (!host) {
      host = document.createElement('div');
      host.id = mountId;
      tabEl.insertBefore(host, tabEl.firstChild);
    }
    var inner = list.map(buildCard).join('');
    var html = newsBoxHtml(inner, list, stamp, titleSuffix, accent, boxKey);
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
      '(애프터마켓 · 장마감 후)',
      'aftermarket'
    );
    var b = renderNewsInto(
      document.getElementById('tabNews'),
      'tabsLiveNewsTab',
      news,
      stamp,
      newsNewsCard,
      { border: '#9333ea', color: '#c084fc' },
      '(시간별 뉴스)',
      'news'
    );
    state.mounted.after = a > 0;
    state.mounted.news = b > 0;
    return a + b;
  }

  /* ------------------ [3탭] 애프터마켓 시간외 체결 대금·등락 순위 ------------------ */

  function afterPanelEl() {
    var tab = document.getElementById('tabAftermarket');
    if (!tab) return null;
    /* ① 고정 앵커 — 한 번 찾은 패널에 data-live-after-panel 을 붙여 다음부터는 즉시 잡는다 */
    var fixed = tab.querySelector('[data-live-after-panel]');
    if (fixed) return fixed;
    var boxes = $$('.panel-box', tab);
    var headTxt = function (i) {
      var h = boxes[i].querySelector('.sec-head');
      return h ? (h.textContent || '') : '';
    };
    /* ② 제목 문구 후보를 넓힌다 — 정적(Pages)·동적(sd_live) 본문이 서로 다른 제목을 써도 잡히게.
     *    11/24 사고: sd_live 본문 제목이 '🚀 3. NXT 20:00 최종 마감' 이라 기존 두 문구로는
     *    null 이 되어 renderAftermarket 이 한 번도 돌지 않았고, 11/20 정적 종목이 그대로 남았다. */
    var needles = ['시간외) 실시간 체결', '3. 애프터마켓', '3. NXT', '애프터마켓(시간외)'];
    for (var n = 0; n < needles.length; n += 1) {
      for (var i = 0; i < boxes.length; i += 1) {
        if (headTxt(i).indexOf(needles[n]) >= 0) {
          boxes[i].setAttribute('data-live-after-panel', '1');
          return boxes[i];
        }
      }
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
    var div = isNum(r.divergencePct) ? r.divergencePct : null;
    var sesWord = state.sesWord || '시간외';
    var bits = [];
    if (isNum(r.overPrice)) bits.push(sesWord + ' 체결 ' + fmt(r.overPrice) + '원 (' + pctTxt(pct) + ')');
    if (isNum(r.changePct)) bits.push('정규장 ' + pctTxt(r.changePct));
    if (div !== null) bits.push('정규장 종가 대비 ' + pctTxt(div));
    if (isNum(r.afterSharePct)) bits.push('통합 대금 중 ' + sesWord + ' ' + Number(r.afterSharePct).toFixed(1) + '%');
    if (r.groups && r.groups.length) bits.push('감시군 ' + r.groups.join('·'));
    var metaTxt = bits.join(' | ');
    var reason = sesWord + ' 체결 대금 ' + (r.overValueText || '—') +
      (isNum(r.overPrice) ? ' · ' + sesWord + ' 체결가 ' + fmt(r.overPrice) + '원' : '') +
      (isNum(pct) ? ' (전일 종가 대비 ' + pctTxt(pct) + ')' : '') +
      (div !== null ? ' · 정규장 종가 ' + fmt(r.regularClose) + '원 대비 ' + pctTxt(div) + ' 괴리' : '') +
      (isNum(r.changePct) ? ' · 정규장 ' + pctTxt(r.changePct) : '') +
      ' · 네이버 ' + (state.sesWord === '프리마켓' ? 'NXT 프리마켓(08:00~08:50)' : '시간외 애프터마켓(NXT·시간외 단일가)') + ' 누적 체결 기준';
    var onclick = buildOnclick(
      r.name + ' (' + r.code + ')',
      (isNum(r.overPrice) ? fmt(r.overPrice) + '원' : '—') + ' (' + pctTxt(pct) + ')',
      metaTxt,
      reason
    );
    var hidden = afterFilterOn() && isNum(r.overValue) && r.overValue < AFTER_MIN_VALUE;
    return '' +
      '<div class="reason-item" data-live="1" data-af-value="' + (isNum(r.overValue) ? Math.round(r.overValue) : '') + '"' +
        (hidden ? ' style="display:none;border-left:3px solid ' + (isNum(pct) && pct < 0 ? '#38bdf8' : '#34d399') + ';"'
                : ' style="border-left:3px solid ' + (isNum(pct) && pct < 0 ? '#38bdf8' : '#34d399') + ';"') +
        ' onclick="' + esc(onclick) + '">' +
        '<div class="ri-head">' +
          '<span><span style="display:inline-block; min-width:14px; color:#64748b; font-weight:800;">' +
            esc(String(r.rank || '')) + '</span> ' + esc(r.name) +
            ' <span style="font-size:9.5px; color:#64748b; font-weight:700;">' + esc(r.code) + '</span>' +
            (r.upperLimit ? ' <span style="font-size:9.5px; color:#fca5a5;">상한가</span>' : '') +
          '</span>' +
          '<span style="color:#34d399; font-weight:800;">' + esc(r.overValueText || '—') + '</span>' +
        '</div>' +
        '<div class="ri-meta">' + esc(metaTxt) + '</div>' +
        (div !== null
          ? '<div style="display:flex;align-items:center;gap:5px;margin-top:3px;flex-wrap:wrap;">' +
              '<span style="font-size:9.5px;font-weight:800;color:#94a3b8;">📏 정규장 종가 ' + esc(fmt(r.regularClose)) + '원 대비</span>' +
              '<span style="font-size:11px;font-weight:900;color:' + colFor(div) + ';">' + esc(pctTxt(div)) + '</span>' +
              '<span style="font-size:9.5px;font-weight:800;color:' + (Math.abs(div) >= 3 ? '#fca5a5' : '#94a3b8') + ';">' +
                (Math.abs(div) >= 3 ? '⚠️ 괴리 큼' : Math.abs(div) >= 1 ? '괴리 주의' : '괴리 작음') + '</span>' +
            '</div>'
          : '') +
      '</div>';
  }

  function renderAftermarket(body, stamp, fromToggle) {
    var af = body.aftermarket;
    if (!af) return 0;
    state.lastAf = af;
    state.lastAfStamp = stamp;
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

    var allRows = byValue.concat(byTop, byBottom);
    var hiddenN = 0;
    if (afterFilterOn()) {
      allRows.forEach(function (r) { if (isNum(r.overValue) && r.overValue < AFTER_MIN_VALUE) hiddenN += 1; });
    }
    var on = afterFilterOn();
    html += '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:7px; margin:2px 0 8px 2px; padding:7px 9px; border:1px solid rgba(56,189,248,0.28); border-radius:7px; background:rgba(56,189,248,0.06);">' +
      '<button type="button" data-af-filter="' + (on ? 'on' : 'off') + '" onclick="if(window.TabsLive){TabsLive.toggleAfterFilter()}" ' +
        'title="' + esc('시간외 체결 대금 10억 원 미만 종목을 목록에서 숨깁니다(설정 유지)') + '" ' +
        'style="display:inline-flex; align-items:center; gap:6px; padding:5px 10px; border-radius:6px; cursor:pointer; font-size:11px; font-weight:800; ' +
        'background:' + (on ? '#065f46' : 'rgba(148,163,184,0.16)') + '; color:' + (on ? '#6ee7b7' : '#cbd5e1') + '; border:1px solid ' + (on ? '#10b981' : 'rgba(148,163,184,0.35)') + ';">' +
        '<span>' + (on ? '✅' : '⬜') + '</span><span>거래대금 10억↑만 보기</span>' +
        '<span style="font-size:9.5px; opacity:.85;">' + (on ? 'ON' : 'OFF') + '</span>' +
      '</button>' +
      '<span style="font-size:10px; color:#94a3b8; font-weight:700;">' +
        (on ? (hiddenN > 0 ? '10억 미만 ' + hiddenN + '종목 숨김 (전체 ' + allRows.length + '종목)' : '10억 미만 없음 · 전체 ' + allRows.length + '종목 표시') : '필터 꿈 · 전체 ' + allRows.length + '종목 표시') +
      '</span>' +
      '<span style="font-size:10px; color:#64748b; font-weight:700; margin-left:auto;">📏 정규장 종가 대비 괴리율 같이 표기</span>' +
    '</div>';
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

  /* ---------------- [3탭] 상단 NXT 애프터마켓 Top 6 랭킹 ----------------
   *  · 11/14 정적 카드(고정 6종목·옛 날짜 라벨)는 이 렌더러가 통째로 덮는다.
   *  · 소스는 /api/tabs-live 의 nxtLeaders.byValue(NXT 체결 거래대금 상위) — 없는 값을 만들지 않는다.
   *  · 카드에는 data-nxt-code 를 붙여, 15초 stock-live 가격 갱신(live-extra.js applyNxtRanking)이 계속돼도
   *    종목 구성이 옛 카드로 돌아가지 않게 한다(구성이 같을 때는 카드를 다시 그리지 않는다).
   */

  function kstMarketLabel() {
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
      }).formatToParts(new Date());
      var g = function (t) {
        for (var i = 0; i < parts.length; i += 1) { if (parts[i].type === t) return parts[i].value; }
        return '';
      };
      var y = Number(g('year'));
      var m = Number(g('month'));
      var d = Number(g('day'));
      if (!y || !m || !d) return '';
      var base = new Date(Date.UTC(y, m - 1, d, 12));
      // 주말엔 오늘 애프터마켓이 없다 — 직전 거래일(금) 라벨로 적는다
      while (base.getUTCDay() === 0 || base.getUTCDay() === 6) base.setUTCDate(base.getUTCDate() - 1);
      var wd = ['일', '월', '화', '수', '목', '금', '토'][base.getUTCDay()];
      return (base.getUTCMonth() + 1) + '/' + base.getUTCDate() + ' ' + wd;
    } catch (e) { return ''; }
  }

  function nxtRankStateTxt(pct) {
    if (!isNum(pct)) return '— 등락률 없음';
    if (pct >= 1) return '🟢 종가 지지 안착';
    if (pct > 0) return '🟢 보합권 지지';
    if (pct > -1) return '🟡 매물 소화 중';
    return '🔵 약세 조정';
  }

  function nxtRankCardHtml(it, i) {
    var pct = isNum(it.changePct) ? it.changePct : null;
    var col = colFor(pct);
    var onclick = inPlaceOpenJs(it.name, it.code,
      isNum(it.price) ? fmt(it.price) + '원' : '', pct === null ? '' : pctTxt(pct));
    return '<div data-nxt-code="' + esc(it.code || '') + '" data-nxt-order="' + i + '" data-live="1"' +
      ' style="background:#0f172a; border:1px solid rgba(168,85,247,0.3); border-radius:6px; padding:9px 11px; display:flex; justify-content:space-between; align-items:center; gap:8px; cursor:pointer;"' +
      ' title="' + esc('NXT 체결 실시간 · 눌러서 이 자리에서 차트 팝업(탭 이동 없음)') + '"' +
      ' onclick="' + esc(onclick) + '">' +
      '<div>' +
        '<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">' +
          '<span class="nxt-rank" style="font-size:10px; font-weight:800; background:#581c87; color:#f3e8ff; padding:1px 6px; border-radius:4px;">TOP ' + (i + 1) + '</span>' +
          '<strong style="color:#fff; font-size:12.5px;">' + esc(it.name || '') + '</strong>' +
          '<span class="nxt-state" style="font-size:10px; color:#94a3b8; font-weight:700;">' + esc(nxtRankStateTxt(pct)) + '</span>' +
        '</div>' +
        '<div style="font-size:10.5px; color:#94a3b8; margin-top:3px;">통합 체결 대금: <strong class="nxt-value" style="color:#c084fc;">' + esc(it.valueDispText || it.valueText || '—') + '</strong></div>' +
      '</div>' +
      '<div style="text-align:right;">' +
        '<div class="nxt-price" style="font-size:13px; font-weight:800; color:' + col + ';">' + esc(isNum(it.price) ? fmt(it.price) + '원' : '—') + '</div>' +
        '<div class="nxt-pct" style="font-size:11px; font-weight:700; color:' + col + ';">' + esc(pct === null ? '—' : pctTxt(pct).replace(/[()]/g, '')) + '</div>' +
      '</div>' +
    '</div>';
  }

  function renderNxtRankPanel(body, stamp) {
    var tab = document.getElementById('tabAftermarket');
    if (!tab) return 0;
    var panel = tab.querySelector('#nxtRankPanel') || tab.querySelector('[data-nxt-rank-panel]');
    if (!panel) return 0;
    panel.setAttribute('data-nxt-rank-panel', '1');
    var nl = body.nxtLeaders || {};
    var list = (nl.byValue || []).filter(function (x) { return x && x.name; }).slice(0, 6);
    var src = 'NXT 체결 대금';
    if (!list.length) {
      list = (nl.byPct || []).filter(function (x) { return x && x.name; }).slice(0, 6);
      src = 'NXT 상승률';
    }
    var label = kstMarketLabel();
    var titleEl = panel.querySelector('#nxtRankTitle') || panel.querySelector('[data-nxt-rank-title]');
    if (titleEl) {
      var title = (label ? '🌙 [' + label + '] ' : '🌙 ') + 'NXT 애프터마켓 체결 대금 Top ' + (list.length || 6) + ' 랭킹' +
        (src === 'NXT 상승률' ? ' (상승률 기준)' : '');
      if (titleEl.textContent !== title) titleEl.textContent = title;
    }
    var stampEl = panel.querySelector('#nxtRankStamp') || panel.querySelector('[data-nxt-rank-stamp]');
    if (stampEl) {
      /* 15초 stock-live 갱신(live-extra.js stampBadges)이 이 배지를 직접 쓴다.
       * 여기서는 '정적 생성 시각(파서 가동 중 …)' 문구만 한 번 바로잡아, 두 문구가 번갈아 깜박이지 않게 한다. */
      var cur = stampEl.textContent || '';
      if (!cur || cur.indexOf('파서 가동') >= 0) {
        stampEl.textContent = '⚡ ' + stamp + ' 조회 · NXT 체결 실시간 (응답이 없으면 옛 종목을 대신 쓰지 않습니다)';
      }
    }
    var grid = panel.querySelector('#nxtRankGrid') || panel.querySelector('[data-nxt-rank-grid]');
    if (!grid) return 0;
    if (!list.length) {
      if (grid.getAttribute('data-codes') !== '') {
        grid.innerHTML = '<div style="grid-column:1/-1; font-size:11px; color:#94a3b8; padding:6px 2px; line-height:1.5;">' +
          '⚠️ NXT 랭킹 응답이 없습니다 — 옛 종목·옛 날짜를 대신 보여주지 않습니다.</div>';
        grid.setAttribute('data-codes', '');
      }
      return 0;
    }
    var codes = list.map(function (x) { return x.code; }).join(',');
    if (grid.getAttribute('data-codes') !== codes) {
      grid.innerHTML = list.map(nxtRankCardHtml).join('');
      grid.setAttribute('data-codes', codes);
    }
    grid.setAttribute('data-live', '1');
    grid.setAttribute('data-nxt-rank-grid', '1');
    return list.length;
  }

  /* ---------------- [1탭] NXT 실시간 주도주 트랙 ----------------
   * 실시간 주도 테마 레이더 안의 3장 카드는 지금까지 11/13 고정 종목명이었다.
   * /api/tabs-live 의 nxtLeaders(NXT 실측 랭킹: 상승률 · 거래대금 · 검색)로 그대로 다시 그린다.
   */

  function nxRowHtml(it) {
    var pct = isNum(it.changePct) ? it.changePct : null;
    /* NXT 랭킹 행도 RN존 탭으로 튀지 않고 이 자리에서 차트 팝업을 연다(11/16)
     *  · 행을 감싼 레이더 카드에도 onclick(openPremarketDetail)이 있어, 그대로 두면
     *    카드 핸들러까지 올라가 팝업이 테마 상세 모달로 덮인다 → 버블링을 끊는다. */
    var onclick = 'event.stopPropagation();' + inPlaceOpenJs(it.name, it.code,
      isNum(it.price) ? fmt(it.price) + '원' : '',
      pct === null ? '' : pctTxt(pct));
    return '<div data-nxt-live="1" style="font-size:10.5px; color:#cbd5e1; margin-top:3px; line-height:1.5; cursor:pointer;" ' +
      'title="NXT 체결 기준 · 눌러서 이 자리에서 실시간 차트 팝업(탭 이동 없음)" onclick="' + esc(onclick) + '">' +
      '• <strong style="color:#fff;">' + esc(it.name) + '</strong> ' +
      '<span style="color:' + colFor(pct) + '; font-weight:800;">' + esc(fmt(it.price)) + '원 ' + esc(pctTxt(pct)) + '</span>' +
      ' <span style="color:#94a3b8;">· ' + esc(vText(it) || '—') + '</span>' +
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

  /* ---------------- [1탭] 실시간 주도 테마 · 오늘의 주도주 · 검색 카드 ----------------
   *  · 카드1 = 네이버 실시간 테마 랭킹 상위 6 (themeSource='naver-theme' 일 때만)
   *  · 카드2 = 오늘 실제 급등주 + 거래대금 상위 (NXT 체결 랭킹 실측)
   *  · 카드3 = NXT 검색 상위
   *  · 그린 내용을 window.PM_LIVE 로 넘겨, 카드를 눌러 연 모달도 같은 실측값을 보여준다.
   */

  /* 원 단위 거래대금 → '1,604억' / '4.61조' */
  function pmEok(won) {
    if (!isNum(won) || won <= 0) return '';
    if (won >= 1e12) return (won / 1e12).toFixed(2) + '조';
    return Math.round(won / 1e8).toLocaleString('ko-KR') + '억';
  }

  function pmSpanStyle(bg, fg) {
    return 'font-size:10px; background:' + bg + '; color:' + fg + '; padding:1px 4px; border-radius:3px; white-space:nowrap;';
  }

  function pmHeadHtml(title, color, badge, bg, fg) {
    return '<div style="display:flex; justify-content:space-between; align-items:center; gap:4px; flex-wrap:wrap;">' +
      '<span style="font-size:11.5px; font-weight:800; color:' + color + ';">' + esc(title) + '</span>' +
      '<span style="' + pmSpanStyle(bg, fg) + '">' + esc(badge) + '</span></div>';
  }

  function pmQuoteHtml(it, showValue) {
    var pct = isNum(it.changePct) ? it.changePct : null;
    var onclick = 'event.stopPropagation();' + inPlaceOpenJs(it.name, it.code,
      isNum(it.price) ? fmt(it.price) + '원' : '', pct === null ? '' : pctTxt(pct));
    var txt = String(it.name || '') + (isNum(it.price) ? ' ' + fmt(it.price) + '원' : '') +
      (pct === null ? '' : ' (' + pctTxt(pct) + ')') +
      (showValue && vText(it)
        ? ' · ' + vText(it) + (it.valueBasis && String(vText(it)).indexOf('(NXT') < 0 ? ' (' + it.valueBasis + ')' : '')
        : '');   /* NXT 병기 표기에는 '(통합(KRX+NXT))' 접미사를 겹쳐 쓰지 않는다 */
    return '<span class="pm-q" data-pm-code="' + esc(it.code || '') + '" data-pm-name="' + esc(it.name || '') + '"' +
      (showValue ? ' data-pm-show="value"' : '') +
      ' style="color:' + colFor(pct) + '; font-weight:800; cursor:pointer;"' +
      ' title="눌러서 이 자리에서 실시간 차트 팝업" onclick="' + esc(onclick) + '">' + esc(txt) + '</span>';
  }

  function pmThemeRowHtml(t) {
    /* 등락률·합산 대금 기준 = 대금 300억↑ 종목 평균(없으면 100억↑ 저유동성).
     *  노출 상위 4종목 평균(top4Avg)·테마 전체 평균(avgPct)은 참고값으로만 둔다. */
    var avg = isNum(t.avgPctCalc) ? t.avgPctCalc : (isNum(t.top4Avg) ? t.top4Avg : (isNum(t.avgPct) ? t.avgPct : null));
    var sumTxt = t.sumValueText || (isNum(t.top4Sum) ? pmEok(t.top4Sum) : '');
    var stocks = (t.stocks || []).slice(0, 2);
    var rise = isNum(t.riseCount) ? t.riseCount : 0;
    var total = isNum(t.stockCount) ? t.stockCount : (rise + (t.fallCount || 0) + (t.steadyCount || 0));
    var stxt = stocks.length
      ? stocks.map(function (s) { return pmQuoteHtml(s, true); }).join(' · ')
      : '<span style="color:#64748b;">구성종목 응답 없음</span>';
    return '<div style="font-size:10.5px; color:#cbd5e1; margin-top:3px; line-height:1.5;">' +
      '• <strong style="color:#fff;" title="' + esc(t.avgPctBasisLabel || '대금 300억↑ 종목 평균 등락률 · 합산 거래대금') + '">' + esc(t.rank) + '위 ' +
      esc(t.name) + ' ' + esc(pctTxt(avg)) + (sumTxt ? ' · ' + esc(sumTxt) : '') + '</strong>' +
      (total ? ' <span style="color:#94a3b8;">(상승 ' + rise + '/' + total + ')</span>' : '') +
      ': ' + stxt + '</div>';
  }

  function pmLeadRole(ratio) {
    if (ratio === null) return { txt: '주도주', color: '#fca5a5' };
    if (ratio >= 29.5) return { txt: '👑 상한가', color: '#fca5a5' };
    if (ratio >= 25.0) return { txt: '🚨 상한가 임박', color: '#fca5a5' };
    if (ratio >= 10.0) return { txt: '🚀 급등', color: '#fca5a5' };
    return { txt: '📈 상승 상위', color: '#fca5a5' };
  }

  function pmLeadRowHtml(it, roleTxt) {
    var pct = isNum(it.changePct) ? it.changePct : null;
    var role = roleTxt || pmLeadRole(pct).txt;
    return '<div style="font-size:10.5px; color:#cbd5e1; margin-top:3px; line-height:1.5;">' +
      '• <strong style="color:#fca5a5;">' + esc(role) + '</strong> ' + pmQuoteHtml(it, true) + '</div>';
  }

  /* 카드를 그린 뒤 — 모달(window.PM_LIVE)도 같은 HTML 로 채운다 */
  function publishPmLive(body, stamp) {
    var cards = $$('#premarketRadarBox div[onclick*="openPremarketDetail"]');
    if (cards.length < 3) return;
    function wrap(title, v1, v2, card) {
      return {
        title: title,
        v1: v1,
        v2: v2,
        html: '<div style="font-size:12px; color:#e2e8f0; line-height:1.6;">' +
          '<div style="margin-bottom:10px; padding:8px 10px; background:rgba(16,185,129,0.1); ' +
          'border:1px solid rgba(16,185,129,0.3); border-radius:6px;">' +
          '<strong style="color:#6ee7b7;">📌 ' + esc(v2) + '</strong></div>' +
          '<div style="background:#131d2e; border:1px solid #1e293b; padding:10px; border-radius:6px;">' +
          (card ? card.innerHTML : '') + '</div></div>'
      };
    }
    var themes = (body.themes || []).filter(function (t) { return t && t.name; });
    var leaders = pmLeaderPick(body);
    var nx = body.nxtLeaders || {};
    var payload = {};
    if (themes.length && body.themeSource === 'naver-theme') {
      payload.nxt = wrap('⚡ 실시간 6대 주도 테마 (네이버 실측)',
        themes[0].rank + '위 ' + themes[0].name + ' ' + pctTxt(isNum(themes[0].avgPct) ? themes[0].avgPct : themes[0].avgPctCalc),
        '네이버 테마 랭킹 ' + (body.themeRankTotal || 0) + '개 중 상위 ' + themes.slice(0, 6).length + ' · ' + stamp + ' 갱신',
        cards[0]);
    }
    if (leaders.length) {
      payload.krx = wrap('🎯 오늘의 핵심 주도주 분석 (네이버 실측)',
        pmLeadRole(isNum(leaders[0].changePct) ? leaders[0].changePct : null).txt + ' ' + (leaders[0].name || ''),
        'NXT 체결 랭킹 실측(상승률·거래대금 상위) · ' + stamp + ' 갱신', cards[1]);
    }
    if ((nx.searchTop || []).length) {
      payload.search = wrap('🔍 실시간 검색 상위 (NXT 실측)', '1위 ' + nx.searchTop[0].name,
        '네이버 NXT 검색 랭킹 · ' + stamp + ' 갱신', cards[2]);
    }
    if (Object.keys(payload).length) window.PM_LIVE = payload;
  }

  /* 카드2에 쓸 주도주 — 상승률 상위 2 + 거래대금 상위 2 (중복 제거) */
  function pmLeaderPick(body) {
    var nx = body.nxtLeaders || {};
    var out = [];
    var seen = {};
    (nx.byPct || []).forEach(function (it) {
      if (out.length >= 2 || !it || !it.name || seen[it.code]) return;
      var pct = isNum(it.changePct) ? it.changePct : 0;
      if (pct <= 0) return;
      seen[it.code] = 1;
      out.push(it);
    });
    (nx.byValue || []).forEach(function (it) {
      if (out.length >= 4 || !it || !it.name || seen[it.code]) return;
      seen[it.code] = 1;
      out.push(it);
    });
    return out;
  }

  function renderNxtTracks(body, stamp) {
    var box = document.getElementById('premarketRadarBox');
    if (!box) return 0;
    var cards = $$('#premarketRadarBox div[onclick*="openPremarketDetail"]');
    if (!cards.length) return 0;
    var applied = 0;

    /* --- 카드1: 네이버 실시간 테마 랭킹 상위 6 --- */
    var themes = (body.themes || []).filter(function (t) { return t && t.name; });
    var themeOk = body.themeSource === 'naver-theme' && themes.length > 0;
    if (themeOk) {
      var html = pmHeadHtml('⚡ 실시간 6대 주도 테마 (네이버 실측)', '#6ee7b7', stamp + ' 갱신',
        'rgba(16,185,129,0.2)', '#a7f3d0') +
        themes.slice(0, 6).map(pmThemeRowHtml).join('');
      if (cards[0].getAttribute('data-sig') !== html) {
        cards[0].innerHTML = html;
        cards[0].setAttribute('data-sig', html);
        applied += 1;
      }
      cards[0].setAttribute('data-nxt-live', '1');
    }

    /* --- 카드2: 오늘의 주도주 --- */
    var leaders = pmLeaderPick(body);
    if (leaders.length) {
      var lhtml = pmHeadHtml('🎯 오늘의 핵심 주도주 분석 (네이버 실측)', '#c7d2fe', stamp + ' 갱신',
        'rgba(99,102,241,0.2)', '#c7d2fe') +
        leaders.map(function (it, i) { return pmLeadRowHtml(it, i >= 2 ? '💰 대금 상위' : null); }).join('');
      if (cards[1].getAttribute('data-sig') !== lhtml) {
        cards[1].innerHTML = lhtml;
        cards[1].setAttribute('data-sig', lhtml);
        applied += 1;
      }
      cards[1].setAttribute('data-nxt-live', '1');
    }

    /* --- 카드3: NXT 검색 상위 --- */
    var nx = body.nxtLeaders || {};
    /* 장전에는 NXT 체결이 없는데도 검색 랭킹이 0.00%·대금 0 으로 내려온다.
     *  체결 근거가 없는 행은 빼고 그린다 — 다 빼면 카드는 07:30 스냅샷 그대로 둔다. */
    var search = (nx.searchTop || []).filter(function (it) {
      return !isPreopen(body) || quoteTraded(it);
    }).slice(0, 5);
    if (search.length) {
      var shtml = pmHeadHtml('🔍 실시간 검색 상위 (NXT 실측)', '#7dd3fc', stamp + ' 갱신',
        'rgba(56,189,248,0.2)', '#7dd3fc') +
        search.map(function (it, i) {
          return '<div style="font-size:10.5px; color:#cbd5e1; margin-top:3px; line-height:1.5;">• ' +
            (i + 1) + '위 ' + pmQuoteHtml(it, true) + '</div>';
        }).join('');
      if (cards[2].getAttribute('data-sig') !== shtml) {
        cards[2].innerHTML = shtml;
        cards[2].setAttribute('data-sig', shtml);
        applied += 1;
      }
      cards[2].setAttribute('data-nxt-live', '1');
    }

    box.setAttribute('data-nxt-live', '1');
    publishPmLive(body, stamp);

    var sessBadge = document.getElementById('pmSessionBadge');
    if (sessBadge) {
      var phase = (body.aftermarket && body.aftermarket.sessionPhase) || body.sessionPhase || '';
      var btxt = '⚡ ' + (phase ? phase + ' · ' : '') + stamp + ' 실시간';
      if (sessBadge.textContent !== btxt) sessBadge.textContent = btxt;
      sessBadge.style.background = '#064e3b';
      sessBadge.style.color = '#6ee7b7';
      sessBadge.setAttribute('data-live', '1');
    }
    var noteEl = document.getElementById('pmNote');
    if (noteEl) {
      var ntxt = '※ 네이버 테마 랭킹·NXT 체결 랭킹을 ' + stamp + '에 조회한 실측값입니다. ' +
        '표시 종목을 누르면 이 자리에서 실시간 차트가 열립니다(외인·기관 순매수 확정치는 실시간이 아닙니다).';
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

  function slOpen(name, code, src, priceText, pctText) {
    var nm = String(name || '').replace(/'/g, '').replace(/[\r\n]/g, ' ');
    var pt = String(priceText === null || priceText === undefined ? '' : priceText).replace(/'/g, '');
    var ct = String(pctText === null || pctText === undefined ? '' : pctText).replace(/'/g, '');
    return (
      "if(window.slOpenStockChart){slOpenStockChart('" + nm + "','" + esc(code || '') + "','" +
      (src || '') + "','" + pt + "','" + ct + "')}"
    );
  }

  /* 종목 클릭 → 지금 보고 있는 탭 그대로, 그 종목 차트 팝업만 연다.
   *  · 비중법사/홍인기 카드에 있는 종목이면 그 탭의 전략 모달(기준봉 4분할 · 5단 타점)
   *  · 카드에 없으면 공통 차트 팝업(openDetail → /api/stock-chart 실시간 일봉)
   *  · RN존 탭으로 점프하지 않는다(11/16 수리) */
  function slModalOpen(id) {
    var el = document.getElementById(id);
    if (!el) return false;
    var cls = ' ' + String(el.className || '') + ' ';
    return cls.indexOf(' on ') >= 0 || cls.indexOf(' open ') >= 0 || el.style.display === 'flex';
  }

  function slOpenStockChart(name, code, src, priceText, pctText) {
    var nm = String(name || '').replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/'/g, '').replace(/\s+/g, ' ').trim();
    var opened = false;
    try {
      if (src === 'hong' && window.HonginkiTab && typeof window.HonginkiTab.openChart === 'function') {
        window.HonginkiTab.openChart(code);
        opened = slModalOpen('hiChartModal');
      } else if (src === 'bij' && window.BijoongTab && typeof window.BijoongTab.openChart === 'function') {
        window.BijoongTab.openChart(code);
        opened = slModalOpen('chartModal');
      }
    } catch (e) { opened = false; }
    if (opened) return true;
    try {
      if (typeof window.openDetail === 'function') {
        window.openDetail(
          nm + ' (' + code + ')',
          priceText || '실시간 일봉 차트',
          pctText || '현재 탭 유지',
          '장중 실시간 판정에서 연 차트입니다 — 탭을 옮기지 않고 이 자리에서 엽니다. ' +
            '일봉은 /api/stock-chart 실시간(당일 봉 포함)이며, 전략 카드가 있는 종목은 그 탭의 카드 모달이 우선 열립니다.'
        );
        return true;
      }
    } catch (e2) { /* 아래 대체 경로 */ }
    try {
      if (window.StrategyPins && typeof window.StrategyPins.openChart === 'function') {
        window.StrategyPins.openChart(code, nm);
        return true;
      }
    } catch (e3) { /* noop */ }
    return false;
  }
  window.slOpenStockChart = slOpenStockChart;

  /* 접힘 토글 — 새로고침(폴링 재렌더) 뒤에도 사용자가 연 상태를 유지한다 */
  function slFoldOpen(key) {
    return Boolean(state.folds && state.folds[key]);
  }

  function slFoldButton(key, label, count, accent) {
    var open = slFoldOpen(key);
    var txt = label + ' (' + (isNum(count) ? count : 0) + '종목) ' + (open ? '▾' : '▸');
    return (
      '<button type="button" data-sl-fold="' + esc(key) + '" onclick="' +
      esc("if(window.slFoldToggle){slFoldToggle('" + key + "')}") + '" ' +
      'style="width:100%;display:flex;align-items:center;gap:6px;margin:8px 0 4px;padding:6px 9px;' +
      'background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.35);border-radius:6px;' +
      'font-size:11px;font-weight:800;color:' + (accent || '#fbbf24') + ';cursor:pointer;text-align:left;">' +
      '<span>' + esc(txt) + '</span>' +
      '<span style="margin-left:auto;font-size:9.5px;font-weight:700;color:#94a3b8;">기본 접힘 · 눌러서 펼치기</span>' +
      '</button>'
    );
  }

  function slFoldBody(key, innerHtml) {
    var open = slFoldOpen(key);
    return (
      '<div data-sl-fold-body="' + esc(key) + '" style="display:' + (open ? 'block' : 'none') + ';">' + innerHtml + '</div>'
    );
  }

  function slFoldToggle(key) {
    if (!state.folds) state.folds = {};
    var open = !state.folds[key];
    state.folds[key] = open;
    Array.prototype.forEach.call(document.querySelectorAll('[data-sl-fold-body="' + key + '"]'), function (el) {
      el.style.display = open ? 'block' : 'none';
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-sl-fold="' + key + '"]'), function (btn) {
      var span = btn.querySelector('span');
      if (span) span.textContent = (span.textContent || '').replace(/[▾▸]\s*$/, open ? '▾' : '▸');
    });
    return open;
  }
  window.slFoldToggle = slFoldToggle;

  function slRow(inner, name, code, src, price, pct) {
    return (
      '<div data-live="1" onclick="' + esc(slOpen(name, code, src, isNum(price) ? fmt(price) + '원' : '', isNum(pct) ? slPct(pct) : '')) + '" ' +
      'title="누르면 이 종목 차트 팝업(탭 이동 없음)" ' +
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
            ' · 대금 ' + (vText(r) || slEok(r.valueEok)) + ' (' + esc(r.valueBasis || '통합') + ')' +
            (r.valueRank ? ' · 대금 순위 ' + r.valueRank + '위' : ''),
            true
          ),
          r.name, r.code, 'bij', r.price, r.pct
        );
      }).join('');
    } else {
      out += '<div style="font-size:10.5px;color:#94a3b8;padding:4px 2px;">지금 조건(몸통 +10%↑ · 대금 300억↑ · 60일 전고점 돌파)을 모두 채운 종목은 없습니다 — 새로 생기면 이 자리에 자동으로 올라옵니다.</div>';
    }
    if (near && near.length) {
      out += slFoldButton('bij-near', '⚖️ 아깝게 탈락한 후보', near.length, '#fbbf24');
      out += slFoldBody('bij-near', near.map(function (r) {
        return slRow(
          '<div style="display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;">' +
            '<span style="font-size:11px;font-weight:700;color:#cbd5e1;">' + esc(r.name) +
              ' <span style="font-size:9.5px;color:#64748b;">' + esc(r.code) + '</span></span>' +
            '<span style="font-size:10.5px;font-weight:800;color:' + colFor(r.pct) + ';">' + esc(slWon(r.price)) + ' ' + esc(slPct(r.pct)) + '</span>' +
          '</div>' +
          '<div style="font-size:9.8px;color:#94a3b8;line-height:1.45;margin-top:2px;">' +
            esc((r.bij.reasons || []).join(' · ') || '—') +
          '</div>',
          r.name, r.code, 'bij', r.price, r.pct
        );
      }).join(''));
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
          c.name, c.code, 'bij'
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
      return slRow(slHeadRow(c.name, c.code, L.price, L.vsBasePct, right), c.name, c.code, 'bij', L.price, L.vsBasePct);
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
          r.name, r.code, 'hong', r.price, r.pct
        );
      }).join('');
    } else {
      out += '<div style="font-size:10.5px;color:#94a3b8;padding:4px 2px;">지금 조건(등락률 +10%↑ · 120일 전고점 돌파 · 대금 상위)을 모두 채운 종목은 없습니다 — 새로 생기면 이 자리에 자동으로 올라옵니다.</div>';
    }
    if (near && near.length) {
      out += slFoldButton('hong-near', '⚖️ 아깝게 탈락한 후보(전고점 넘었지만 첫 돌파 아님)', near.length, '#fbbf24');
      out += slFoldBody('hong-near', near.map(function (r) {
        return slRow(
          '<div style="display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;">' +
            '<span style="font-size:11px;font-weight:700;color:#cbd5e1;">' + esc(r.name) +
              ' <span style="font-size:9.5px;color:#64748b;">' + esc(r.code) + '</span></span>' +
            '<span style="font-size:10.5px;font-weight:800;color:' + colFor(r.pct) + ';">' + esc(slWon(r.price)) + ' ' + esc(slPct(r.pct)) + '</span>' +
          '</div>' +
          '<div style="font-size:9.8px;color:#94a3b8;line-height:1.45;margin-top:2px;">' + esc((r.hong.reasons || []).join(' · ') || '—') + '</div>',
          r.name, r.code, 'hong', r.price, r.pct
        );
      }).join(''));
    }
    return out;
  }

  function slHongCardsHtml(cards, afterHours) {
    if (!cards || !cards.length) {
      return '<div style="font-size:10.5px;color:#94a3b8;padding:3px 2px;">홍인기 카드가 없습니다(재스캔 JSON 미포함).</div>';
    }
    return cards.map(function (c) {
      if (c.missing || !c.live) {
        return slRow('<div style="font-size:11px;color:#94a3b8;">' + esc(c.name) + ' — 실시간 시세 미수신(폴링 대기)</div>', c.name, c.code, 'hong');
      }
      var L = c.live;
      var stateColor = afterHours ? '#93c5fd' : L.stateKey === 'tp10' ? '#34d399' : L.stateKey === 'tp5' ? '#6ee7b7' : L.stateKey === 'above' ? '#e2e8f0' : L.stateKey === 'dip' ? '#7dd3fc' : '#fca5a5';
      var stateTxt = afterHours ? '🌙 시간외 체결(판정 아님)' : L.stateLabel;
      var ladder = (L.ladder || []).map(function (l) {
        return l.step + (l.hit === true ? ' ✅' : '') + ' ' + l.label;
      }).join(' · ');
      var right =
        '<b style="color:' + stateColor + ';">' + esc(stateTxt) + '</b>' +
        ' · 기준선 ' + slWon(L.base) + ' 대비 <b style="color:' + colFor(L.vsBasePct) + ';">' + esc(slPct(L.vsBasePct)) + '</b>' +
        (isNum(L.gapPct) ? ' · 시초 ' + esc(slPct(L.gapPct)) : '') +
        '<br>시 ' + slWon(L.open) + ' · 고 ' + slWon(L.high) + ' · 저 ' + slWon(L.low) + ' · 현재 ' + slWon(L.price) +
        '<br>' + esc(ladder) +
        '<br>익절 +5% ' + slWon(L.tp5) + ' / +10% ' + slWon(L.tp10) +
        ' · 손절 −3% ' + slWon(L.stopLine) +
        (!afterHours && L.stopBreach ? ' <span style="color:#fca5a5;font-weight:800;">이탈</span>' : '')
      ;
      var dayTag = c.dayLabel ? '[기준봉 → 오늘 ' + c.dayLabel + '] ' : c.kind ? '[' + c.kind + '] ' : '';
      return slRow(slHeadRow(dayTag + c.name, c.code, L.price, L.vsBasePct, right), c.name, c.code, 'hong', L.price, L.vsBasePct);
    }).join('');
  }

  /* ---------- 깡토 · 종가베팅 · RN존 장중 실시간 판정 패널 (11/24) ----------
   *  /api/tabs-live 의 strategyLive.kkangto · .jongbe · .rnzone 을 그린다.
   *  카드 자체(전략 모달·캔들)는 각 탭 엔진이 그대로 그리고, 여기서는 '지금 조건을
   *  채웠는지'만 기준선과 실시간 시세로 대조해 맨 위에 붙인다. 시세가 없으면 '미수신'.
   */
  function slStateColor(key) {
    if (key === 'stop' || key === 'below') return '#fca5a5';
    if (key === 'tp' || key === 'tp1' || key === 'tp2' || key === 'target' || key === 'upper') return '#fbbf24';
    if (key === 'break' || key === 'lower' || key === 'hold' || key === 'entry') return '#34d399';
    if (key === 'near' || key === 'near_lower') return '#93c5fd';
    return '#94a3b8';
  }

  function slStateBadge(live) {
    if (!live) return '<span style="color:#64748b;font-weight:800;">시세 미수신</span>';
    return (
      '<span style="color:' + slStateColor(live.stateKey) + ';font-weight:900;">' + esc(live.stateLabel || '—') + '</span>'
    );
  }

  function slKkangtoRow(c) {
    var L = c.live;
    if (!L) return slRow('<div style="font-size:11px;color:#94a3b8;">' + esc(c.name) + ' — 실시간 시세 미수신</div>', c.name, c.code, 'kkangto');
    var right =
      '매수타점(전고점) ' + slWon(L.pivot) +
      (isNum(L.toPivotPct) ? ' · 거리 ' + (L.toPivotPct >= 0 ? '+' : '') + L.toPivotPct.toFixed(2) + '%' : '') +
      ' · 손절 ' + slWon(L.stop) + (L.stopBreach ? ' <span style="color:#fca5a5;font-weight:800;">이탈</span>' : '') +
      ' · 익절 ' + slWon(L.tp) + (L.tpReached ? ' <span style="color:#fbbf24;font-weight:800;">도달</span>' : '') +
      '<br>60일선 ' + slWon(L.ma60) + ' <b style="color:' + (L.aboveMa60 ? '#34d399' : '#fca5a5') + ';">' +
      (L.aboveMa60 ? '위' : '아래') + '</b> · 대금 ' + slEok(L.valueEok) +
      ' · 기준일 종가 ' + slWon(L.base) + ' 대비 <b style="color:' + colFor(L.vsBasePct) + ';">' + slPct(L.vsBasePct) + '</b>';
    return slRow(slHeadRow(esc(c.name) + ' <span style="font-size:9.5px;color:#64748b;">(' + esc(c.section === 'break' ? '돌파' : '접근') + ')</span> ' + slStateBadge(L), c.code, L.price, L.pct, right, true), c.name, c.code, 'kkangto', L.price, L.pct);
  }

  function slJongbeRow(c) {
    var L = c.live;
    /* 2026-11-25 신정재 4대 패턴 개편 — 트랙 키가 p1~p4 로 바뀌었다(강창권 제거).
       알 수 없는 키면 서버가 준 patternLabel 을 그대로 쓴다(값을 지어내지 않는다). */
    var JB_TRACKS = { p1: '① 위꼬리', p2: '② 5일선 지지', p3: '③ 마른 양봉', p4: '④ 20일선 눌림' };
    var track = JB_TRACKS[c.track] || (c.live && c.live.patternLabel) || '';
    var tipTxt = (L && typeof L.tipScore === 'number')
      ? ' · 팁 <b style="color:#fbbf24;">' + L.tipScore + '/' + (L.tipTotal || 6) + '</b>' : '';
    if (!L) return slRow('<div style="font-size:11px;color:#94a3b8;">' + esc(c.name) + ' — 실시간 시세 미수신</div>', c.name, c.code, 'jongbe');
    var right =
      (track ? '<b style="color:#fbbf24;">' + esc(track) + '</b> · ' : '') +
      '기준가 ' + slWon(L.base) + ' 대비 <b style="color:' + colFor(L.vsBasePct) + ';">' + slPct(L.vsBasePct) + '</b>' +
      ' · 목표 ' + slWon(L.target1) + (isNum(L.target2) ? ' / ' + slWon(L.target2) : '') +
      ' · 손절 ' + slWon(L.stopPrice) + (L.stopBreach ? ' <span style="color:#fca5a5;font-weight:800;">이탈</span>' : '') +
      (isNum(L.ma5) ? '<br>5일선 ' + slWon(L.ma5) + ' · 20일선 ' + slWon(L.ma20) : '') +
      ' · 대금 ' + (L.valueText || slEok(L.valueEok)) + tipTxt;
    return slRow(slHeadRow(esc(c.name) + ' ' + slStateBadge(L), c.code, L.price, L.pct, right, true), c.name, c.code, 'jongbe', L.price, L.pct);
  }

  function slRnzoneRow(c) {
    var L = c.live;
    if (!L) return slRow('<div style="font-size:11px;color:#94a3b8;">' + esc(c.name) + ' — 실시간 시세 미수신</div>', c.name, c.code, 'rnzone');
    var right =
      '하단 RN ' + slWon(L.lowerRN) + (isNum(L.toLowerPct) ? ' (' + (L.toLowerPct >= 0 ? '+' : '') + L.toLowerPct.toFixed(2) + '%)' : '') +
      ' · 상단 RN ' + slWon(L.upperRN) + (isNum(L.toUpperPct) ? ' (' + (L.toUpperPct >= 0 ? '+' : '') + L.toUpperPct.toFixed(2) + '%)' : '') +
      (isNum(L.zonePct) ? ' · 구간 ' + L.zonePct.toFixed(0) + '%' : '') +
      (isNum(L.buy1) ? '<br>매수 1차 ' + slWon(L.buy1) + (L.inBuy1 ? ' <span style="color:#34d399;font-weight:800;">도달</span>' : '') : '') +
      (isNum(L.buy2) ? ' · 2차 ' + slWon(L.buy2) + (L.inBuy2 ? ' <span style="color:#34d399;font-weight:800;">도달</span>' : '') : '') +
      ' · 대금 ' + (L.valueText || slEok(L.valueEok));
    return slRow(slHeadRow(esc(c.name) + ' ' + slStateBadge(L), c.code, L.price, L.pct, right, true), c.name, c.code, 'rnzone', L.price, L.pct);
  }

  function slStratChips(sec) {
    var counts = {};
    var colorOf = {};
    ((sec && sec.cards) || []).forEach(function (c) {
      var L = c && c.live;
      if (!L) return;
      var lab = L.stateLabel || '—';
      counts[lab] = (counts[lab] || 0) + 1;
      if (!colorOf[lab]) colorOf[lab] = slStateColor(L.stateKey);
    });
    return Object.keys(counts)
      .sort(function (a, b) { return counts[b] - counts[a]; })
      .map(function (lab) {
        return '<span style="font-size:9.6px;font-weight:800;color:' + colorOf[lab] + ';background:rgba(148,163,184,0.1);border:1px solid rgba(148,163,184,0.22);border-radius:4px;padding:1px 5px;">' + esc(lab) + ' ' + counts[lab] + '</span>';
      })
      .join(' ');
  }

  function slStratPanel(sec, title, accent, rowFn, extraNote) {
    if (!sec || !sec.cards || !sec.cards.length) return null;
    var chips = slStratChips(sec);
    return slBox(
      title,
      '실시간 ' + (sec.live || 0) + '/' + (sec.total || 0) + '종목',
      accent,
      '<div style="font-size:10px;color:#94a3b8;margin:3px 0 6px;line-height:1.5;">' +
        '기준 ' + esc(sec.basisLabel || sec.basisDate || '—') + ' · 오늘 <b style="color:#e2e8f0;">' + esc(sec.dayLabel || '—') + '</b>' +
        (sec.basisStale ? ' <span style="color:#fbbf24;font-weight:800;">⚠️ 재스캔 필요(기준일 경과)</span>' : '') +
        (chips ? '<br><span style="display:inline-flex;gap:4px;flex-wrap:wrap;margin-top:3px;">' + chips + '</span>' : '') +
        '</div>' +
        sec.cards.map(rowFn).join('') +
        '<div style="font-size:9.6px;color:#64748b;margin-top:6px;line-height:1.5;">' +
          (extraNote || '') + ' 투자 권유가 아닙니다.</div>'
    );
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
        (sl.afterHours
          ? '<br><span style="color:#7dd3fc;font-weight:800;">🌙 정규장 마감 후 — 현재가는 NXT 시간외 체결가입니다. −3% 손절·+5%/+10% 익절은 <u>정규장 종가</u>로 판정하고, 이 패널의 위치는 참고값입니다.</span>'
          : '') +
        '</div>' +
      '<div style="font-size:11px;font-weight:800;color:#fca5a5;margin:6px 0 4px;">🔥 당일 D+0 포착 — 등락률 +10%↑ · 120일 전고점 첫 돌파 · 대금 상위</div>' +
      slHongFreshHtml(hong.fresh, hong.near) +
      '<div style="font-size:11px;font-weight:800;color:#c7d2fe;margin:10px 0 4px;">📊 기존 카드 · 기준선 대비 실시간 위치 · 5단 타점</div>' +
      slHongCardsHtml(hong.cards, sl.afterHours) +
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

    /* ---- 깡토 · 종가베팅 · RN존 : 기준선 대비 지금 조건 충족 상태 ---- */
    var panels = [
      ['tabKkangto', 'stratLiveKkangtoHost', sl.kkangto, '⚡ 깡토 추세추종 · 실시간 조건 판정', '#38bdf8', slKkangtoRow,
        '전고점(매수타점) 돌파 유지 여부 · −8% 손절 · +24% 1차 익절 · 60일선 위/아래를 장중 현재가로 다시 판정합니다.'],
      ['tabJongbe', 'stratLiveJongbeHost', sl.jongbe, '💪 종가베팅 마스터 · 실시간 조건 판정', '#fbbf24', slJongbeRow,
        '신정재 4대 패턴 — ①~③은 15:18~15:20 종가매수 · 익일 09:05 전 청산(손절선 이탈 즉시), ④는 5일선을 깬 자리라 엔벨로프 중심선(20일선) 스윙 손절 기준입니다.'],
      ['tabRnzone', 'stratLiveRnzoneHost', sl.rnzone, '🎯 RN존 · 실시간 구간 판정', '#f472b6', slRnzoneRow,
        '하단·상단 RN 사이에서 지금 위치(구간 %)와 매수 1·2차 도달 여부입니다. RN은 재스캔 기준일 일봉으로 계산된 값입니다.']
    ];
    panels.forEach(function (p) {
      var html = slStratPanel(p[2], p[3], p[4], p[5], p[6]);
      var host = ensureStratHost(p[0], p[1]);
      if (!host) return;
      if (html) {
        if (host.getAttribute('data-sig') !== html) {
          host.innerHTML = html;
          host.setAttribute('data-sig', html);
        }
        host.setAttribute('data-live', '1');
        applied += 1;
      } else {
        host.innerHTML = '';
        host.setAttribute('data-sig', '');
      }
    });
    return applied;
  }

  /* ==========================================================================
   * 💸 [1탭] 거래대금 5분 간격 3구간 순증 — `300억 (25/5/6)` + 형광 신호등
   * ----------------------------------------------------------------------------
   *  · 15분을 5분 간격 3구간으로 본다.
   *      d1 = 최근 5분    (현재 − 5분 전 칸)
   *      d2 = 5~10분 전   (5분 전 칸 − 10분 전 칸)
   *      d3 = 10~15분 전  (10분 전 칸 − 15분 전 칸)
   *  · 칸은 '5분 버킷'(epoch 분을 5로 내림)이고, 한 칸에는 그 칸에서 처음 본 값을 남긴다
   *    (덮어쓰지 않는다) — 칸 시작 시점 대금과 비교해야 5분 구간이 맞는다.
   *  · 값은 두 곳에서 합친다.
   *      ① 서버: /api/tabs-live 의 tvBuckets (Supabase family_sync[stock_tv_5m_v1])
   *         → 폰 브라우저를 처음 열어도 이미 쌓인 기록으로 바로 표시된다.
   *      ② 브라우저: localStorage(당일 키 sd_tv_bucket5_YYYY-MM-DD)
   *    같은 칸에 둘 다 있으면 더 이른(작은) 값을 쓴다 — 누적 대금은 시간이 갈수록 커지므로
   *    작은 쪽이 '칸 시작 시점'에 가깝다.
   *  · 표기: 세 구간 모두 있으면 `(25/5/6)`, 앞 구간만 있으면 `(25/-/-)`.
   *    10억 미만 소수 1자리 · 10억 이상 정수 · 0 이하/변동없음은 `0` · 기록 없으면 `-`.
   *    최근 5분 기준점이 없으면 아무것도 그리지 않는다(값을 만들지 않는다).
   *  · 신호등: 최근 5분 d1 ≥ 30억 또는 15분 합계 ≥ 100억 = 🔥 급증,
   *            최근 5분 d1 ≥ 10억 또는 15분 합계 ≥ 30억  = 🌿 유입.
   * ==========================================================================*/
  var TV_KEY_PREFIX = 'sd_tv_bucket5_';
  var TV_KEEP_MIN = 60;
  var TV_GAIN_HOT_5 = 30;
  var TV_GAIN_HOT_15 = 100;
  var TV_GAIN_IN_5 = 10;
  var TV_GAIN_IN_15 = 30;

  function tvTodayKey() {
    var d = new Date();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  /* epoch 분 → 5분 칸 시작(내림). KST 오프셋(540분)이 5의 배수라 KST 정각·5분과도 맞는다. */
  function tvBucketOf(min) { return Math.floor(min / 5) * 5; }

  function tvLoad() {
    var today = tvTodayKey();
    if (state.tvDate === today && state.tv) return state.tv;
    var parsed = {};
    try {
      var raw = window.localStorage ? window.localStorage.getItem(TV_KEY_PREFIX + today) : null;
      parsed = raw ? JSON.parse(raw) : {};
    } catch (e) { parsed = {}; }
    state.tvDate = today;
    state.tv = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    return state.tv;
  }

  function tvSave(tv) {
    try {
      if (window.localStorage) window.localStorage.setItem(TV_KEY_PREFIX + tvTodayKey(), JSON.stringify(tv));
    } catch (e) { /* 저장소 가득참·사생활 모드 — 메모리 값으로만 계산한다 */ }
  }

  function tvEok(value) { return Math.round((value / 1e8) * 10) / 10; }

  function tvSlot(tv, bucketMin) {
    var slot = tv[String(bucketMin)];
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return null;
    return slot;
  }

  /* 이번 응답의 현재 5분 칸에 값을 기록한다 — 그 칸에서 처음 본 종목만 채운다. */
  function tvRecord(themes, nowMin) {
    var tv = tvLoad();
    var now = isNum(nowMin) ? nowMin : Math.floor(Date.now() / 60000);
    var key = String(tvBucketOf(now));
    var slot = tv[key];
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) slot = tv[key] = {};
    var added = 0;
    (themes || []).forEach(function (t) {
      (t.stocks || []).forEach(function (s) {
        if (!s || !s.code || !isNum(s.value)) return;
        if (isNum(slot[s.code])) return;   // 이 5분 칸에 이미 남긴 종목은 그대로 둔다
        slot[s.code] = tvEok(s.value);
        added += 1;
      });
    });
    state.tvNowMin = now;
    if (added) tvSave(tv);
    return added;
  }

  /* 서버(Supabase) 5분 버킷 병합 — 같은 칸에 이미 있으면 더 이른(작은) 값을 쓴다. */
  function tvApplyServer(doc) {
    if (!doc || !Array.isArray(doc.buckets) || !doc.buckets.length) {
      if (doc && isNum(doc.now)) state.tvNowMin = doc.now;
      return 0;
    }
    var tv = tvLoad();
    var now = isNum(doc.now) ? doc.now : Math.floor(Date.now() / 60000);
    var n = 0;
    doc.buckets.forEach(function (bucket) {
      if (!bucket || !isNum(bucket.t) || !bucket.s || typeof bucket.s !== 'object') return;
      var slot = tvSlot(tv, bucket.t);
      if (!slot) slot = tv[String(bucket.t)] = {};
      Object.keys(bucket.s).forEach(function (code) {
        var v = bucket.s[code];
        if (!isNum(v)) return;
        if (!isNum(slot[code])) { slot[code] = v; n += 1; }
        else if (v < slot[code]) slot[code] = v;
      });
    });
    if (isNum(doc.now)) state.tvNowMin = doc.now;
    if (n) tvSave(tv);
    /* 오늘·최근 1시간 밖의 칸은 버린다(어제 칸이 오늘 값으로 섞이지 않게) */
    var keys = Object.keys(tv);
    keys.forEach(function (k) {
      var b = Number(k);
      if (!isFinite(b) || b < now - TV_KEEP_MIN) delete tv[k];
    });
    return n;
  }

  function tvAt(code, bucketMin) {
    var tv = state.tv || tvLoad();
    var slot = tvSlot(tv, bucketMin);
    if (!slot) return null;
    return isNum(slot[code]) ? slot[code] : null;
  }

  function tvRound1(v) { return Math.round(v * 10) / 10; }

  /* 최근 15분 5분 간격 3구간 순증. 최근 5분 기준점이 없으면 null(표시 안 함). */
  function tvGain(code, eok, nowMin) {
    if (!code || !isNum(eok)) return null;
    var now = isNum(nowMin) ? nowMin : Math.floor(Date.now() / 60000);
    var b = tvBucketOf(now);
    var p1 = tvAt(code, b - 5);
    if (!isNum(p1)) return null;
    var p2 = tvAt(code, b - 10);
    var p3 = tvAt(code, b - 15);
    var d1 = tvRound1(eok - p1);
    var d2 = isNum(p2) ? tvRound1(p1 - p2) : null;
    var d3 = isNum(p2) && isNum(p3) ? tvRound1(p2 - p3) : null;
    var sum = tvRound1(d1 + (isNum(d2) ? d2 : 0) + (isNum(d3) ? d3 : 0));
    var level = 'low';
    if (d1 >= TV_GAIN_HOT_5 || sum >= TV_GAIN_HOT_15) level = 'hot';
    else if (d1 >= TV_GAIN_IN_5 || sum >= TV_GAIN_IN_15) level = 'in';
    return { d1: d1, d2: d2, d3: d3, sum: sum, level: level };
  }

  /* (25/5/6) 숫자 하나 — 10억 미만 소수 1자리(정수면 .0 생략), 10억 이상 정수, 0 이하 0, 기록 없음 - */
  function tvNum(v) {
    if (!isNum(v)) return '-';
    var n = Math.round(v * 10) / 10;
    if (!(n > 0)) return '0';
    if (n >= 10) return String(Math.round(n));
    var s = n.toFixed(1);
    return s.slice(-2) === '.0' ? s.slice(0, -2) : s;
  }

  function tvGainText(g) {
    if (!g) return '';
    return ' (' + tvNum(g.d1) + '/' + tvNum(g.d2) + '/' + tvNum(g.d3) + ')';
  }

  function tvTip(g) {
    if (!g) return '';
    function one(v) {
      if (!isNum(v)) return '미수집';
      var n = Math.round(v * 10) / 10;
      return (n > 0 ? '+' : '') + n + '억';
    }
    return '최근 5분 ' + one(g.d1) + ' / 5~10분 전 ' + one(g.d2) + ' / 10~15분 전 ' + one(g.d3);
  }

  function tvLevelText(g) {
    if (!g || g.level === 'low') return '';
    return g.level === 'hot'
      ? '급증(최근 5분 +30억↑ / 15분 합계 +100억↑)'
      : '유입(최근 5분 +10억↑ / 15분 합계 +30억↑)';
  }

  /* 거래대금 span — 순증 텍스트 + 신호등 클래스. 순증이 없으면 원래 표기 그대로. */
  function volHtml(stock) {
    var text = esc(vText(stock) || '—');
    if (!stock || !stock.code || !isNum(stock.value)) return '<span class="st-vol">' + text + '</span>';
    var g = tvGain(stock.code, tvEok(stock.value), state.tvNowMin);
    var tip = '거래대금 ' + (vText(stock) || '—') + ' (' + ((stock && stock.valueBasis) || '통합') + ')';
    if (g) tip += ' · ' + tvTip(g);
    if (g && g.level !== 'low') tip += ' · ' + tvLevelText(g);
    return '<span class="st-vol' + (g && g.level !== 'low' ? ' tv-' + g.level : '') + '" title="' + esc(tip) + '">' +
      text + (g ? '<span class="tv-gain">' + esc(tvGainText(g)) + '</span>' : '') +
      (g && g.level === 'hot' ? '<span class="tv-badge">🔥 급증</span>' : '') +
      '</span>';
  }

  /* ==========================================================================
   * 👀 [1탭] 지금 봐야 할 섹터 & 종목 (테마맵 바로 아래 접기/펴기 박스)
   *  · 점수 = 등락률×3 + log10(합산/종목 대금)×4 + 검색순위 가점((31-순위)/3) + 진입종목×0.8
   *          + 최근 5분·15분 거래대금 순증 가중치 (2026-11-23 사용자 확정 '돈의 흐름')
   *  · 강세 테마·거래대금·실시간 검색순위·순증을 한 줄에 모아, 직장인이 잠깐 봐도
   *    '지금 강한 섹터'와 '그 안에서 대금·검색이 붙는 종목'을 바로 집게 한다.
   *  · 1등 대장주가 같은 테마는 1칸으로 묶고 '+A·B 동반'으로 메타에 적는다(11/23 확정).
   *    대장주가 다르면(반도체·반도체 소부장·반도체 전력) 각각 독립 순위.
   *  · 값은 /api/tabs-live 의 themes(top4 평균·합산 대금·검색 뱃지)만 쓴다 — 추정 없음.
   *  · 종목 1·2·3위 후보는 **통합 거래대금 100억↑만** (2026-11-20 사용자 확정).
   *    등락률만 높은 초소형주(예: 대금 2억 +30%)가 log 대금 점수 때문에 1위로 올라오는 것을 막는다.
   * ==========================================================================*/
  var WATCH_MIN_EOK = 100;   // 100억 미만 잡주 제외 하한(억 단위)
  /* 💸 돈의 흐름 가중치 (2026-11-23 사용자 확정) — 정적(scripts/auto_update_all_tabs.py)과 같은 값.
   *    "등락률만 높은 이미 오른 종목"이 아니라 최근 5분·15분 대금 순증이 붙으면서 상승률도
   *    높은 섹터·종목이 1·2·3위에 오게 한다. 단위는 억 원(순증). */
  var WATCH_FLOW_5M = 0.5;
  var WATCH_FLOW_15M = 0.15;
  var WATCH_FLOW_CAP = 45;          // 섹터 돈의 흐름 가점 최대(등락률 15%p 급)
  var WATCH_STOCK_FLOW_5M = 0.6;
  var WATCH_STOCK_FLOW_15M = 0.18;
  var WATCH_STOCK_FLOW_CAP = 70;    // 종목 돈의 흐름 가점 최대(등락률 23%p 급)

  /* 테마의 '돈의 흐름' = 노출 종목의 최근 5분·15분 순증 합(플러스만). 기록 없으면 0. */
  function watchThemeFlow(t) {
    var f5 = 0, f15 = 0, n = 0;
    (t.stocks || []).forEach(function (s) {
      if (!s || !s.code || !isNum(s.value)) return;
      var g = tvGain(s.code, tvEok(s.value), state.tvNowMin);
      if (!g) return;
      if (g.d1 > 0) f5 += g.d1;
      if (g.sum > 0) f15 += g.sum;
      n += 1;
    });
    return { f5: Math.round(f5 * 10) / 10, f15: Math.round(f15 * 10) / 10, n: n };
  }

  function watchRound1(v) { return Math.round(v * 10) / 10; }

  /* '스마트팩토리(스마트공장)' → '스마트팩토리' — 동반 표기에 쓸 짧은 테마명 */
  function watchShortName(nm) {
    var s = String(nm || '').replace(/^\s*\d+위\s*/, '');
    s = s.replace(/\s*[\(\[].*$/, '').trim();
    s = s.replace(/[^0-9A-Za-z가-힣·&\/+~\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s;
  }

  /* 테마의 1등 대장주 — 👑 상승률 대장 → 💰 실질 거래대금 대장 → 첫 종목 순 */
  function watchThemeLead(t) {
    var list = (t.stocks || []).filter(function (s) { return s && s.code; });
    function pick(txt) {
      for (var i = 0; i < list.length; i += 1) {
        if ((list[i].role || '').indexOf(txt) >= 0) return list[i];
      }
      return null;
    }
    var lead = pick('상승률 대장') || pick('실질 거래대금 대장') || pick('대장') || list[0] || null;
    return lead ? { code: lead.code, name: lead.name || '' } : { code: '', name: '' };
  }

  function watchScoreTheme(t) {
    var avg = isNum(t.avgPctCalc) ? t.avgPctCalc : (isNum(t.top4Avg) ? t.top4Avg : t.avgPct);
    var sumEok = isNum(t.sumValue) ? t.sumValue / 1e8 : 0;
    var best = t.searchBadge && isNum(t.searchBadge.bestRank) ? t.searchBadge.bestRank : null;
    var cnt = t.searchBadge && isNum(t.searchBadge.count) ? t.searchBadge.count : 0;
    var flow = watchThemeFlow(t);
    var flowBonus = Math.min(flow.f5 * WATCH_FLOW_5M + flow.f15 * WATCH_FLOW_15M, WATCH_FLOW_CAP);
    /* '상승률도 높은 곳' — +3%↑(11/23 대장 기준)은 그대로, 0~3%는 절반, 하락은 돈만 많아도 0 */
    flowBonus *= (isNum(avg) && avg >= 3) ? 1 : ((isNum(avg) && avg > 0) ? 0.5 : 0);
    var score = (isNum(avg) ? avg * 3 : 0) + Math.log(Math.max(sumEok, 1)) / Math.LN10 * 4 +
      (best ? (31 - best) / 3 : 0) + cnt * 0.8 + flowBonus;
    var lead = watchThemeLead(t);
    return {
      name: t.name || '—',
      leadCode: lead.code,
      leadName: lead.name,
      short: watchShortName(t.name),
      mates: [],
      avg: isNum(avg) ? avg : null,
      sumEok: sumEok,
      sumText: t.sumValueText || '—',
      bestRank: best,
      count: cnt,
      flow5: flow.f5,
      flow15: flow.f15,
      /* 노출 종목이 100% 같은 묶음인지 판별하는 지문 — 세부 분야가 다른 테마는 그대로 인정한다 */
      sig: (t.stocks || []).map(function (s) { return s && s.code; }).filter(Boolean).sort().join(','),
      score: Math.round(score * 10) / 10,
      rank: t.rank || 0,
    };
  }

  function watchScoreStock(s, themeScore) {
    var pct = isNum(s.livePct) ? s.livePct : s.changePct;
    var eok = isNum(s.value) ? s.value / 1e8 : 0;
    var rank = isNum(s.searchRank) ? s.searchRank : null;
    var g = s.code && isNum(s.value) ? tvGain(s.code, tvEok(s.value), state.tvNowMin) : null;
    var f5 = g ? g.d1 : 0;
    var f15 = g ? g.sum : 0;
    var flowBonus = Math.min(Math.max(f5, 0) * WATCH_STOCK_FLOW_5M + Math.max(f15, 0) * WATCH_STOCK_FLOW_15M,
      WATCH_STOCK_FLOW_CAP);
    flowBonus *= (isNum(pct) && pct >= 3) ? 1 : ((isNum(pct) && pct > 0) ? 0.5 : 0);
    var score = (isNum(pct) ? pct * 3 : 0) + Math.log(Math.max(eok, 1)) / Math.LN10 * 3 +
      (rank ? (31 - rank) / 3 : 0) + (isNum(themeScore) ? themeScore * 0.05 : 0) + flowBonus;
    return {
      name: s.name || '—',
      code: s.code || '',
      pct: isNum(pct) ? pct : null,
      price: isNum(s.livePrice) ? s.livePrice : s.price,
      valueEok: eok,
      valueText: vText(s) || '—',
      searchRank: rank,
      themeName: s.themeNameRef || '',
      role: s.role || '',
      flow5: watchRound1(f5),
      flow15: watchRound1(f15),
      score: Math.round(score * 10) / 10,
    };
  }

  function watchFlowText(v) {
    if (!isNum(v) || Math.abs(v) < 1) return '';
    return (v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + '억';
  }

  function watchFlowRaw(v) {
    if (!isNum(v)) return '0억';
    return (v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + '억';
  }

  function watchSectorItemHtml(w, idx) {
    var meta = '합산 ' + w.sumText;
    if (watchFlowText(w.flow5)) meta += ' · 💸 5분 ' + watchFlowText(w.flow5);
    if (w.bestRank) meta += ' · 🔍 최고 ' + w.bestRank + '위 · ' + w.count + '종목';
    if (w.mates && w.mates.length) {
      var matesTxt = w.mates.slice(0, 4).join('·');
      if (w.mates.length > 4) matesTxt += ' 외 ' + (w.mates.length - 4);
      meta += ' · +' + matesTxt + ' 동반';
    }
    var tip = '종합점수 ' + w.score + ' = 등락률×3 + log₁₀(합산 대금)×4' +
      (w.bestRank ? ' + 검색순위 가점' : '') + ' + 검색 진입종목×0.8' +
      ' + 최근 5분 대금 순증×0.5 + 15분 순증×0.15 (최대 45점)' +
      (isNum(w.flow5) ? ' (지금 5분 ' + watchFlowRaw(w.flow5) + ' / 15분 ' + watchFlowRaw(w.flow15) + ')' : '') +
      (w.mates && w.mates.length ? ' — 같은 1등 대장주 ' + (w.leadName || w.leadCode) + '로 묶음: ' + w.mates.join(', ') : '') +
      ' (누르면 테마 카드로 이동)';
    return '<div class="watch-item" data-live="1" onclick="themeWatchFocus(' + (idx - 1) + ')" title="' + esc(tip) + '">' +
      '<div class="wi-head"><span class="wi-rank">' + idx + '</span>' +
        '<span class="wi-name">' + esc(w.name) + '</span>' +
        '<span class="wi-pct" style="color:' + colFor(w.avg) + '">' + esc(pctTxt(w.avg)) + '</span></div>' +
      '<div class="wi-meta">' + esc(meta) + '</div></div>';
  }

  function watchStockItemHtml(w, idx) {
    var meta = w.valueText;
    if (watchFlowText(w.flow5)) meta += ' · 💸 5분 ' + watchFlowText(w.flow5);
    if (w.searchRank) meta += ' · 🔍 ' + w.searchRank + '위';
    if (w.themeName) meta += ' · ' + w.themeName;
    var click = buildOnclick(
      w.name + (w.code ? ' (' + w.code + ')' : ''),
      pctTxt(w.pct),
      '대금 ' + w.valueText + ' | 현재가 ' + fmt(w.price) + '원',
      '지금 봐야 할 종목 ' + idx + '위 — ' + (w.themeName || '테마') + ' · ' +
        (w.searchRank ? '실시간 검색 ' + w.searchRank + '위 · ' : '') + '대금 ' + w.valueText
    );
    var tip = '종합점수 ' + w.score + ' = 등락률×3 + log₁₀(대금)×3' +
      (w.searchRank ? ' + 검색순위 가점' : '') + ' + 소속 테마 점수 가점' +
      ' + 최근 5분 대금 순증×0.6 + 15분 순증×0.18 (최대 70점)' +
      (isNum(w.flow5) ? ' (지금 5분 ' + watchFlowRaw(w.flow5) + ' / 15분 ' + watchFlowRaw(w.flow15) + ')' : '');
    return '<div class="watch-item" data-live="1" onclick="' + esc(click) + '" title="' + esc(tip) + '">' +
      '<div class="wi-head"><span class="wi-rank">' + idx + '</span>' +
        '<span class="wi-name">' + esc(w.name) + '</span>' +
        '<span class="wi-pct" style="color:' + colFor(w.pct) + '">' + esc(pctTxt(w.pct)) + '</span></div>' +
      '<div class="wi-meta">' + esc(meta) + '</div></div>';
  }

  function renderWatchBox(body, stamp) {
    var host = document.getElementById('watchBody');
    if (!host) return 0;
    var themes = (body.themes || []).filter(function (t) { return t && t.name; });
    if (!themes.length) return 0;

    var rankOf = {};
    (body.searchTop || []).forEach(function (x) {
      if (x && x.code && isNum(x.rank)) rankOf[x.code] = x.rank;
    });

    var sectors = themes.map(function (t) { return watchScoreTheme(t); });
    var stocks = [];
    themes.forEach(function (t, ti) {
      var sc = sectors[ti].score;
      (t.stocks || []).forEach(function (s) {
        if (!s || !s.code) return;
        var row = watchScoreStock(s, sc);
        if (!(row.valueEok >= WATCH_MIN_EOK)) return;   // 통합 거래대금 100억 미만 제외
        row.searchRank = rankOf[s.code] || null;
        row.themeName = t.name || '';
        stocks.push(row);
      });
    });

    var bestByCode = {};
    stocks.forEach(function (st) {
      var k = st.code || st.name;
      if (!bestByCode[k] || st.score > bestByCode[k].score) bestByCode[k] = st;
    });
    var uniqueStocks = Object.keys(bestByCode).map(function (k) { return bestByCode[k]; });
    /* 🧩 1등 대장주가 같은 테마는 1개 대표 칸으로 묶고, 나머지 테마명은 '+A·B 동반'으로
     * 메타에 적는다(2026-11-23 사용자 확정). 대장주가 다르면(반도체·반도체 소부장·반도체 전력)
     * 각각 독립 순위로 세운다 — 대장주를 못 읽으면 노출 종목이 100% 같은 묶음만 하나로 친다. */
    var topSectors = [];
    var byLead = {};
    sectors.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (w) {
      var key = w.leadCode ? ('c:' + w.leadCode) : ('s:' + (w.sig || w.name));
      var rep = byLead[key];
      if (rep) {
        if (w.short && w.short !== rep.short && rep.mates.indexOf(w.short) < 0) rep.mates.push(w.short);
        return;
      }
      w.mates = [];
      byLead[key] = w;
      topSectors.push(w);
    });
    topSectors = topSectors.slice(0, 3);
    var topStocks = uniqueStocks.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 3);

    var leftHtml = topSectors.map(function (w, i) {
      return watchSectorItemHtml(w, i + 1);
    }).join('');
    var rightHtml = topStocks.map(function (w, i) {
      return watchStockItemHtml(w, i + 1);
    }).join('');
    if (!leftHtml && !rightHtml) return 0;

    var html =
      '<div class="watch-col"><div class="watch-col-head">🔥 지금 봐야 할 섹터 <span>1 · 2 · 3위</span></div>' +
        (leftHtml || '<div class="watch-empty">실시간 테마 데이터 없음</div>') + '</div>' +
      '<div class="watch-col"><div class="watch-col-head">🎯 지금 봐야 할 종목 <span>1 · 2 · 3위</span></div>' +
        (rightHtml || '<div class="watch-empty">대금 100억↑ 종목 없음</div>') + '</div>';

    if (host.getAttribute('data-sig') !== html) {
      host.innerHTML = html;
      host.setAttribute('data-sig', html);
    }
    host.setAttribute('data-live', '1');
    var box = document.getElementById('watchBox');
    if (box) {
      var sub = box.querySelector('.watch-sub');
      if (sub) {
        var txt = '등락률 + 거래대금 + 돈의 흐름(5·15분 순증) + 검색 종합 · 대금 100억↑ · ⚡ ' + stamp + ' 갱신';
        if (sub.textContent !== txt) sub.textContent = txt;
      }
      box.setAttribute('data-live', '1');
    }
    return topSectors.length + topStocks.length;
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
      '대금 ' + (vText(s) || '—') + ' | 현재가 ' + fmt(price) + '원',
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
        '<div class="st-ohlc">' + (isNum(s.livePrice) ? '프' : s.priceBasis === '직전 종가' ? '종' : '현') + ' <strong>' + esc(fmt(price)) + '</strong>' +
          ' | 시 ' + esc(fmt(s.open)) + ' 고 ' + esc(fmt(s.high)) + ' 저 ' + esc(fmt(s.low)) + '</div>' +
        '<div class="st-bottom">' +
          volHtml(s) +
          (role ? '<span class="st-role" style="' + roleStyle + ' font-size:9px; white-space:nowrap;">' + esc(roleTxt) + '</span>' : '') +
        '</div>' +
      '</div>'
    );
  }

  function dynThemeHtml(t) {
    /* 헤더 등락률은 대금 300억↑ 종목 평균(avg) — 전체 종목 평균(avgPct)은 참고값으로만 둔다.
     *  테마 순위도 같은 기준으로 /api/tabs-live 가 매겨서 내려준다. */
    var avg = isNum(t.avgPctCalc) ? t.avgPctCalc : (isNum(t.top4Avg) ? t.top4Avg : (isNum(t.avgPct) ? t.avgPct : null));
    var stocks = t.stocks || [];
    var rise = isNum(t.riseCount) ? t.riseCount : 0;
    var fall = isNum(t.fallCount) ? t.fallCount : 0;
    var steady = isNum(t.steadyCount) ? t.steadyCount : 0;
    var totalN = isNum(t.stockCount) ? t.stockCount : (rise + fall + steady);
    var riseRatio = isNum(t.riseRatio) ? t.riseRatio : (totalN ? Math.round((rise / totalN) * 1000) / 10 : null);
    /* 🔗 스탁이지 테마는 '네이버 랭킹'이 아니라 스탁이지 분류임을 카드에서 바로 구분되게 표시한다 */
    var isSe = t.source === 'stockeasy';
    var lowLiq = !!t.lowLiquidity;
    /* 대장 대금 300억 미만 — '테마 강도'로 오해하지 않게 카드에 그대로 적는다 */
    var lowBadge = lowLiq
      ? '<span style="font-size:9px; font-weight:900; color:#fcd34d; background:rgba(245,158,11,0.16); border:1px solid rgba(180,83,9,0.7); border-radius:4px; padding:1px 4px; margin-left:4px; letter-spacing:-0.2px;" title="거래대금 300억↑ 종목이 아직 없어 100억↑ 종목 평균으로 순위를 매겼습니다(장 초반 폴백)">⚠ 저유동성</span>'
      : '';
    var joinBadge = t.seJoined
      ? '<span style="font-size:9px; font-weight:900; color:#c4b5fd; background:rgba(124,58,237,0.18); border:1px solid rgba(167,139,250,0.4); border-radius:4px; padding:1px 4px; margin-left:4px; letter-spacing:-0.2px;" title="스탁이지 실시간 테마 구성종목이 이 카드에 함께 들어왔습니다">🔗 구성 합류</span>'
      : '';
    var nameBadge = isSe
      ? '<span style="font-size:9px; font-weight:900; color:#c4b5fd; background:rgba(124,58,237,0.22); border:1px solid rgba(167,139,250,0.45); border-radius:4px; padding:1px 4px; margin-left:5px; letter-spacing:-0.2px;">스탁이지</span>'
      : '';
    /* 🔍 실시간 검색 뱃지 — 테마 카드 노출 종목 중 검색 Top 30 진입분(최고 순위 + 종목 수) */
    var sb = t.searchBadge;
    var searchBadge = sb && isNum(sb.bestRank)
      ? '<span class="tv-search" title="네이버 실시간 검색순위 Top 30 — 테마 카드 노출 종목 중 ' + esc(sb.count) + '종목 진입 · 최고 ' + esc(sb.bestRank) + '위">🔍 최고 ' + esc(sb.bestRank) + '위 · ' + esc(sb.count) + '종목</span>'
      : '';
    /* 상승 확산도 — 단독 1종목 급등인지 섹터 전체가 오르는지 한눈에 보이게 한다 */
    var spread = totalN
      ? ' · 상승 ' + rise + '/' + totalN + (riseRatio != null ? ' (' + riseRatio + '%)' : '')
      : '';
    var spreadColor = riseRatio == null ? '#94a3b8' : (riseRatio >= 60 ? '#f87171' : (riseRatio >= 40 ? '#fbbf24' : '#94a3b8'));
    return (
      '<div class="theme-block" data-live="1" data-theme-no="' + esc(t.themeNo || '') + '">' +
        '<div class="theme-header">' +
          '<span class="theme-name" title="순위·등락률 = ' + esc(t.avgPctBasisLabel || '테마 등락률') + '">' + esc(t.rank) + '위 ' + (isSe ? '🔗 ' : '🔥 ') + esc(t.name) + '</span>' + nameBadge + lowBadge + joinBadge + searchBadge +
          '<span class="theme-avg" style="color:' + colFor(avg) + '; font-weight:800; font-feature-settings:\'tnum\'; font-size:13px;">' +
            esc(slPct(avg)) +
            (t.avgPctBasisLabel
              ? '<span style="font-size:9px; color:#94a3b8; font-weight:700; margin-left:3px; letter-spacing:-0.2px;">' +
                esc(t.avgPctBasisLabel) + '</span>'
              : '') +
            ' <span style="font-size:10px; color:' + spreadColor + '; font-weight:700; margin-left:4px; letter-spacing:-0.2px;" title="테마 구성종목 중 당일 상승 종목 비율(확산도)">' +
              '(합산 ' + esc(t.sumValueText || '—') + spread + ')</span>' +
          '</span>' +
          (isNum(t.avgPctLive)
            ? '<span style="font-size:10px; font-weight:800; color:' + colFor(t.avgPctLive) + '; letter-spacing:-0.2px;"' +
              ' title="오늘 아침 NXT 프리마켓 체결 평균 (' + esc(t.liveCoverage || '') + ' 종목 체결)">프 ' +
              esc(slPct(t.avgPctLive)) + '</span>'
            : '') +
        '</div>' +
        '<div class="stock-tiles">' +
          stocks.map(function (s) { s.themeNameRef = t.name; return dynTileHtml(s); }).join('') +
        '</div>' +
      '</div>'
    );
  }

  /* ⑦ 다시 그린 테마맵에서 '직전 응답과 값이 달라진 종목'만 반짝인다.
   *  테마맵은 innerHTML 을 통째로 갈기 때문에, 종목코드 기준으로 직전 가격·등락률을
   *  기억해 두고 이번 값과 다른 카드에만 하이라이트를 붙인다(차트 전체 깜박임 금지). */
  function flashChangedTiles(grid, themes) {
    var prev = state.prevQuotes || {};
    var next = {};
    (themes || []).forEach(function (t) {
      (t.stocks || []).forEach(function (s) {
        if (!s || !s.code) return;
        var key = String(s.code);
        var pct = isNum(s.livePct) ? s.livePct : (isNum(s.changePct) ? s.changePct : null);
        var price = isNum(s.livePrice) ? s.livePrice : s.price;
        var before = prev[key];
        next[key] = { p: price, c: pct };
        if (!before) return;                       /* 첫 렌더는 반짝이지 않는다 */
        if (before.p === price && before.c === pct) return;
        var tile = grid.querySelector('.stock-tile[data-code="' + key + '"]');
        if (!tile) return;
        flashEl(tile.querySelector('.st-change'), pct);
        flashEl(tile.querySelector('.st-ohlc strong'), pct);
      });
    });
    state.prevQuotes = next;
  }

  function renderDynamicThemes(body, stamp) {
    var gridEl = document.querySelector('#tabOverview .theme-grid-8');
    var isPrevDay = body.themeSource === 'prev-day-dynamic';
    if (body.themeSource !== 'naver-theme' && !isPrevDay) {
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
      flashChangedTiles(grid, themes);
    }
    grid.setAttribute('data-dynamic', '1');
    grid.setAttribute('data-theme-source', body.themeSource);

    var head = grid.previousElementSibling;
    if (head && head.querySelector) {
      var title = head.querySelector('span');
      if (title) {
        var ttxt = isPrevDay
          ? '🔥 주도 테마맵 (직전 강세' + (body.themeSeCards ? ' + 스탁이지' : '') + ' Top ' + themes.length + ')'
          : '🔥 실시간 주도 테마맵 (오늘 장중 강세 테마 Top ' + themes.length + ')';
        if (title.textContent !== ttxt) title.textContent = ttxt;
      }
      var sub = head.querySelector('.sub');
      if (sub) {
        /* 프리마켓 — '직전 마감 실질 대장 등락률' 기준임을 머리말에 그대로 적는다(상위 4종목 평균 아님).
         *  스탁이지 테마가 합류하면 몇 개가 들어왔는지(카드 + 기존 카드 구성 병합)도 함께 밝힌다. */
        var seBits = [];
        if (body.themeSeIn) seBits.push('🔗 스탁이지 카드 ' + body.themeSeIn + '개');
        if (body.themeSeJoined) seBits.push('🔗 스탁이지 구성 병합 ' + body.themeSeJoined + '개');
        var seTxt = seBits.length ? ' + ' + seBits.join(' · ') : '';
        var stxt = isPrevDay
          ? '직전 ' + (body.themePrevLabel || '거래일') + ' 마감 대금 300억↑ 기준주 등락률(±100% 이상 제외) · 프리마켓 체결 병기' +
            seTxt + ' · ⚡ ' + stamp + ' 갱신'
          : '네이버 실시간 테마 랭킹(노출 상위 4종목 평균 등락률·합산 대금 기준 ' + themes.length +
            '테마 · 후보 ' + (body.themeRankTotal || 0) + '개)' + seTxt +
            ' · ⚡ ' + stamp + ' 갱신';
        if (sub.textContent !== stxt) sub.textContent = stxt;
        sub.style.color = isPrevDay ? '#7dd3fc' : '';
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
    var base = '네이버 실시간 체결 검증 · 고정 8대 테마(과거 기준)';
    sub.textContent = base + ' · ⚡ ' + stamp + ' 갱신';
    sub.setAttribute('data-live', '1');
  }

  /* 지금 화면에 띄우고 있는 탭 (④ 우선 로딩 판단) */
  function currentView() {
    try {
      var btn = document.querySelector('.tab-btn.active');
      return (btn && btn.getAttribute('data-view')) || 'overview';
    } catch (e) { return 'overview'; }
  }

  /* ------------------------------------------------------------------
   * 🌙 코스피200 주간선물(F) · 야간선물(CM) — 한투 KIS 실전 시세
   * ------------------------------------------------------------------
   *  · /api/tabs-live 의 futuresKis(KIS FHMIF10000000)만 쓴다.
   *  · 상단 티커의 `주간선물` · `야간선물(코스피)` 자리를 실값으로 덮고,
   *    만쥬 시장분위기(MANJU_MOOD)의 `야간선물` 축·지수 베팅 점수도 실측값으로 다시 계산한다.
   *  · 응답이 없거나 실패면 화면을 지우지 않는다(기존 기록값 유지).
   */
  function fnum(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function futTickerTargets() {
    var bar = document.querySelector('.ticker-bar');
    if (!bar) return null;
    var items = Array.prototype.slice.call(bar.querySelectorAll('.ticker-item'));
    var day = null;
    var night = null;
    items.forEach(function (it) {
      var l = it.querySelector('.label');
      var t = l ? (l.textContent || '').replace(/\s+/g, '') : '';
      if (!day && t.indexOf('주간선물') >= 0) day = { item: it, label: l, val: it.querySelector('.val') };
      if (!night && t.indexOf('야간선물') >= 0 && t.indexOf('코스닥') < 0) {
        night = { item: it, label: l, val: it.querySelector('.val') };
      }
    });
    return { day: day, night: night };
  }

  function futBadge(t, text) {
    if (!t || !t.label || !text) return false;
    var b = t.label.querySelector('span');
    if (!b) {
      b = document.createElement('span');
      b.style.cssText =
        'font-size:8.5px;background:rgba(255,255,255,0.08);padding:1px 3px;border-radius:2px;color:#cbd5e1;';
      t.label.appendChild(b);
    }
    if (b.textContent !== text) b.textContent = text;
    return true;
  }

  function futQuoteDesc(q, label) {
    var bits = [];
    bits.push('한투 KIS 실전 국내선물옵션 시세(FHMIF10000000) · ' + (label || '') + ' ' + (q.code || ''));
    if (fnum(q.prevClose) !== null) bits.push('기준(전일) ' + q.prevClose.toFixed(2));
    if (fnum(q.open) !== null) bits.push('시 ' + q.open.toFixed(2));
    if (fnum(q.high) !== null) bits.push('고 ' + q.high.toFixed(2));
    if (fnum(q.low) !== null) bits.push('저 ' + q.low.toFixed(2));
    if (fnum(q.volume) !== null) bits.push('누적거래량 ' + Math.round(q.volume).toLocaleString('ko-KR') + '계약');
    if (fnum(q.openInterest) !== null) bits.push('미결제약정 ' + Math.round(q.openInterest).toLocaleString('ko-KR'));
    if (fnum(q.kospi200) !== null) bits.push('코스피200 현물 ' + q.kospi200.toFixed(2));
    bits.push('조회 ' + (q.asOfKst || '') + ' KST');
    return bits.join(' · ');
  }

  function futPaintTile(t, q, title, key, label) {
    if (!t || !t.item || !q || q.ok !== true) return 0;
    var price = fnum(q.price);
    if (price === null) return 0;
    var p = fnum(q.changePct);
    var txt = price.toFixed(2) + ' ' + (p === null ? '' : '(' + (p > 0 ? '+' : '') + p.toFixed(2) + '%)');
    var val = t.val;
    if (!val) {
      val = document.createElement('span');
      val.className = 'val';
      t.item.appendChild(val);
    }
    if (val.textContent !== txt) val.textContent = txt;
    val.className = p === null || p === 0 ? 'val' : p > 0 ? 'val up' : 'val down';
    val.style.color = '';
    futBadge(t, q.badge);
    t.item.setAttribute('title', futQuoteDesc(q, label));
    var clean = function (s) { return String(s == null ? '' : s).replace(/['"\\]/g, '').replace(/\s+/g, ' ').trim(); };
    t.item.setAttribute(
      'onclick',
      "openIndexChart('" + clean(title) + "', '" + clean(price.toFixed(2) + 'pt ' + (p === null ? '' : '(' + (p > 0 ? '+' : '') + p.toFixed(2) + '%)')) +
        "', '" + clean((q.badge || '') + ' · ' + (label || '')) +
        "', '" + clean(futQuoteDesc(q, label)) +
        "', '" + clean(key) + "')"
    );
    return 1;
  }

  /* 만쥬 시장분위기 점수 — auto_update_all_tabs.py 의 mj_market_mood 와 같은 식
     (정규장 등락 30% · 외인+기관 수급 25% · 시장폭 15% · 야간선물 15% · 나스닥100선물 15%) */
  function manjuMoodWithFutures(nfValue, nfPct, sourceLabel) {
    var D = window.MANJU_DATA;
    if (!D || !D.mood || typeof D.mood !== 'object') return null;
    var mood = D.mood;
    if (fnum(nfPct) === null) return null;
    mood.nightFuture = { value: fnum(nfValue), pct: nfPct, label: sourceLabel };

    function normPct(x) { return x == null ? null : Math.max(0, Math.min(1, (x / 3 + 1) / 2)); }
    function normSupply(v) { return v == null ? null : Math.max(0, Math.min(1, (v / 10000 + 1) / 2)); }
    var k = mood.kospi || {};
    var s = mood.supply || {};
    var sup = s.foreign != null && s.organ != null ? (s.foreign || 0) + (s.organ || 0) : null;
    var b = mood.breadth || {};
    var nq = mood.nq || {};
    var axes = [
      { name: '코스피 등락', x: normPct(k.pct), w: 0.3 },
      { name: '외인+기관 수급(코스피)', x: normSupply(sup), w: 0.25 },
      { name: '시장폭(상승 비율)', x: b.ratio != null ? b.ratio / 100 : null, w: 0.15 },
      { name: '야간선물(코스피200)', x: normPct(nfPct), w: 0.15 },
      { name: '나스닥100 선물', x: normPct(nq.pct), w: 0.15 },
    ];
    var wsum = 0;
    var acc = 0;
    var rows = [];
    axes.forEach(function (a) {
      if (a.x === null) {
        rows.push({ name: a.name, weight: a.w, score: null });
        return;
      }
      rows.push({ name: a.name, weight: a.w, score: Math.round(a.x * 100) });
      wsum += a.w;
      acc += a.x * a.w;
    });
    var closeScore = wsum > 0 ? Math.round((acc / wsum) * 100) : null;
    mood.indexCloseScore = closeScore;
    mood.indexDownScore = closeScore === null ? null : 100 - closeScore;
    mood.coverage = Math.round(wsum * 100);
    if (Array.isArray(mood.rows)) {
      // 기존 row 의 text 는 건드리지 않고 점수만 맞춘다(야간선물 text 는 아래 DOM 단계에서 실값으로)
      mood.rows.forEach(function (r) {
        var hit = null;
        rows.forEach(function (n) { if (n.name === r.name) hit = n; });
        if (hit) {
          r.score = hit.score;
          if (hit.name === '야간선물(코스피200)' && fnum(nfValue) !== null) {
            r.text = nfValue.toFixed(2) + 'pt (' + (nfPct > 0 ? '+' : '') + nfPct.toFixed(2) + '%)';
          }
        }
      });
    } else {
      mood.rows = rows;
    }
    return { closeScore: closeScore, nightScore: rows[3].score };
  }

  function manjuMoodDom(closeScore, nightScore, nfValue, nfPct, live) {
    /* 헤더가 가장 짧은(= 안쪽) div를 고른다 — 바깥 컨테이너도 같은 문장으로 시작하기 때문 */
    var header = null;
    var divs = document.querySelectorAll('div');
    for (var i = 0; i < divs.length; i += 1) {
      var t = (divs[i].textContent || '').trim();
      if (t.indexOf('🧭 만쥬 시장분위기') !== 0) continue;
      if (!header || t.length < (header.textContent || '').trim().length) header = divs[i];
    }
    if (!header) return 0;
    var block = header;
    for (var up = 0; up < 4; up += 1) {
      var parent = block.parentElement;
      if (!parent) break;
      block = parent;
      if ((block.textContent || '').indexOf('지수 종가베팅 점수') >= 0) break;
    }
    var blockText = block.textContent || '';
    if (blockText.indexOf('지수 종가베팅 점수') < 0 || blockText.length > 1600) return 0;
    var applied = 0;

    // ① 야간선물 입력행의 값·점수
    var all = block.querySelectorAll('div');
    for (var j = 0; j < all.length; j += 1) {
      var row = all[j];
      var txt = (row.textContent || '').replace(/^\s*·\s*/, '');
      if (txt.indexOf('야간선물(코스피200)') !== 0) continue;
      var spans = row.querySelectorAll('span');
      if (spans.length < 2) continue;
      var scoreCol = nightScore == null ? '#64748b' : nightScore >= 55 ? '#34d399' : nightScore >= 45 ? '#fbbf24' : '#f87171';
      spans[spans.length - 1].innerHTML =
        (fnum(nfValue) === null ? '—' : nfValue.toFixed(2) + 'pt (' + (nfPct > 0 ? '+' : '') + nfPct.toFixed(2) + '%)') +
        ' <b style="color:' + scoreCol + ';">' + (nightScore == null ? '—' : nightScore + '점') + '</b>';
      row.setAttribute('title', live ? '한투 KIS 야간선물(CM) 실시간' : '한투 KIS 야간선물 마감값');
      applied += 1;
      break;
    }

    // ② 지수 종가베팅 / 하방베팅 점수 카드
    var labels = block.querySelectorAll('div');
    for (var k = 0; k < labels.length; k += 1) {
      var lt = (labels[k].textContent || '').trim();
      if (lt.length > 34) continue;
      var isClose = lt.indexOf('지수 종가베팅 점수') >= 0;
      var isDown = lt.indexOf('지수 하방베팅 점수') >= 0;
      if (!isClose && !isDown) continue;
      var card = labels[k].parentElement;
      if (!card) continue;
      var numEl = card.children[1];
      if (!numEl) continue;
      var sc = isClose ? closeScore : closeScore == null ? null : 100 - closeScore;
      if (sc == null) continue;
      numEl.innerHTML =
        sc + '<span style="font-size:12px;color:#94a3b8;font-weight:700;"> / 100</span>';
      applied += 1;
    }
    return applied;
  }

  function applyFuturesKis(fk) {
    if (!fk || fk.ok !== true) return 0;
    var contract = fk.contract || {};
    var label = contract.label || '코스피200 근월물';
    var t = futTickerTargets();
    var applied = 0;
    if (t && fk.day) {
      applied += futPaintTile(t.day, fk.day, '코스피200 주간선물 (' + label + ')', 'kospi200_day', label);
    }
    if (t && fk.night) {
      applied += futPaintTile(
        t.night,
        fk.night,
        '코스피200 야간선물 (' + (fk.night.live ? '실시간' : '마감값') + ')',
        'kospi200_night',
        label
      );
    }
    // 만쥬 시장분위기의 야간선물 축 — 세션 중이면 실시간 CM, 아니면 직전 야간장 마감값
    var nq = fk.night && fk.night.ok ? fk.night : null;
    if (nq && fnum(nq.price) !== null) {
      var res = manjuMoodWithFutures(nq.price, fnum(nq.changePct), nq.live ? '한투 KIS 실시간(CM)' : '한투 KIS 야간선물 마감값');
      if (res) applied += manjuMoodDom(res.closeScore, res.nightScore, nq.price, fnum(nq.changePct), nq.live);
    }
    // 애프터마켓 탭 요약의 '선물·글로벌' 문장 — 옛날 확정치 대신 지금 실측값으로
    var afEl = document.getElementById('afFutText');
    if (afEl) {
      var seg = [];
      var dq = fk.day && fk.day.ok ? fk.day : null;
      var nq2 = fk.night && fk.night.ok ? fk.night : null;
      function seg1(name, q) {
        if (!q || fnum(q.price) === null) return;
        var p = fnum(q.changePct);
        seg.push(name + ' ' + q.price.toFixed(2) + (p === null ? '' : ' (' + (p > 0 ? '+' : '') + p.toFixed(2) + '%)') + (q.live ? ' 실시간' : ' ' + (q.badge || '마감')));
      }
      seg1('주간선물', dq);
      seg1('야간선물', nq2);
      if (seg.length) {
        var txt = seg.join(' · ');
        if (afEl.textContent !== txt) afEl.textContent = txt;
        applied += 1;
      }
    }
    return applied;
  }

  function apply(body) {
    var stamp = body.generatedAtKst || nowHms();
    state.sessionPhase = body.sessionPhase || null;
    state.renderErrors = 0;
    var view = currentView();
    var applied = 0;

    /* ④ 보고 있는 탭 우선 — 지금 탭의 렌더러를 먼저 돌려 즉시 그리고,
     *    나머지 탭은 다음 프레임에 백그라운드로 채운다(체감 속도).
     *    각 단계는 safe() 로 감싸 한 렌더러의 예외가 전체 탭을 멈추지 않게 한다. */
    var steps = [];
    function step(label, views, fn) { steps.push({ label: label, views: views, fn: fn }); }

    /* ① 거래대금 5분 칸은 테마 렌더보다 먼저 채워야 이번 값까지 순증에 들어간다.
     *    서버(Supabase) 버킷을 먼저 병합한 뒤, 이번 응답의 현재 칸을 기록한다. */
    step('tv', ['overview'], function () {
      tvApplyServer(body.tvBuckets);
      tvRecord(body.themes || [], state.tvNowMin);
      return 1;
    });

    // 1번 탭 — NXT 실시간 주도주 트랙(고정 텍스트 → 실데이터)
    step('nxt', ['overview'], function () { return renderNxtTracks(body, stamp); });

    // 1번 탭 — 주도 테마맵 : 네이버 실시간 테마 랭킹(동적 Top 8)으로 통째로 다시 그린다.
    //  랭킹이 살아 있으면 고정 8대 테마(정적 HTML)로 되돌리지 않는다.
    step('themes', ['overview'], function () {
      var themes = body.themes || [];
      var dynThemes = renderDynamicThemes(body, stamp);
      if (dynThemes > 0) return dynThemes;
      var n = 0;
      themes.forEach(function (t, i) {
        var block = findThemeBlock(t, i);
        if (block) n += applyTheme(t, block);
      });
      if (themes.length) markThemeHead(stamp);
      return n;
    });

    // 1번 탭 — 👀 지금 봐야 할 섹터 & 종목 (테마맵 바로 아래 박스)
    step('watch', ['overview'], function () { return renderWatchBox(body, stamp); });

    // 1번 탭 — 52주 신고가 / 100억+ 상한가
    step('high52', ['overview'], function () { return renderHigh52(overviewPanels().gold, body.high52, stamp); });
    step('upper', ['overview'], function () { return renderUpperLimit(overviewPanels().red, body.upperLimit, stamp); });

    // 3·5번 탭 — 실시간 뉴스
    step('news', ['aftermarket', 'news'], function () { return renderNews(body, stamp); });

    // 3번 탭 — 시간외 체결 대금·등락 순위 (감시군 실시간 산출)
    step('after', ['aftermarket'], function () {
      var afCount = renderAftermarket(body, stamp);
      if (afCount > 0) state.mounted.afterTop = true;
      return afCount;
    });

    // 3번 탭 — 상단 NXT 애프터마켓 Top 6 랭킹 (11/14 옛 날짜·옛 종목 → 오늘 실시간 NXT 랭킹)
    step('nxtRank', ['aftermarket'], function () { return renderNxtRankPanel(body, stamp); });

    // 비중법사·홍인기 탭 — 장중 실시간 기준봉/타점 판정 패널
    step('strategy', ['bijoong', 'honginki', 'kkangto', 'supply', 'manju', 'jongbe', 'rnzone', 'ipo'],
      function () { return renderStrategyLive(body, stamp); });

    // 주말 휴장 문구 정정 (모든 탭 공통)
    step('wording', null, function () { fixSessionWording(body.sessionPhase); return 1; });

    // 🌙 상단 티커의 주간·야간선물 + 만쥬 시장분위기 — 한투 KIS 실측(모든 탭 공통)
    step('futures', null, function () { return applyFuturesKis(body.futuresKis); });

    var rest = [];
    for (var i = 0; i < steps.length; i += 1) {
      var s = steps[i];
      var isActive = view && s.views && s.views.indexOf(view) >= 0;
      if (isActive || !s.views) {
        applied += safe(s.label, s.fn);
      } else {
        rest.push(s);
      }
    }
    state.pendingRest = rest.length;
    if (rest.length) {
      var runRest = function () {
        for (var j = 0; j < rest.length; j += 1) {
          applied += safe(rest[j].label, rest[j].fn);
        }
        state.pendingRest = 0;
        state.applied = applied;
      };
      setTimeout(function () {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(runRest);
        else runRest();
      }, 0);
    }

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
          var why = 'HTTP ' + out.status + ' · 응답 본문 없음';
          setBadge(false, '⚠️ 실시간 지연 · ' + (state.lastBody ? (state.lastBody.generatedAtKst || '') + ' 값 유지' : '다시 불러오기 필요'));
          showRetry(why);
          console.warn('[TabsLive] API 실패 (' + why + ') — 옛 종목을 새 값으로 덮지 않는다');
          return;
        }
        var applied = apply(body);
        state.lastBody = body;
        /* ④ 나머지 탭은 다음 프레임에 채우므로, 우선 탭만 그려졌어도 성공으로 본다. */
        if (applied > 0 || state.pendingRest > 0) {
          state.ok = true;
          state.cacheHit = false;
          state.lastAt = nowHms();
          saveCache(body);          /* ① 3분 캐시 저장 */
          hideRetry();
          setStamp(body);
          setBadge(true, '⚡ 1·3·5탭 LIVE ' + state.lastAt + ' 갱신' +
            (state.renderErrors ? ' · 렌더오류 ' + state.renderErrors : ''));
          console.log('[TabsLive] ' + body.generatedAtKst + ' ' + body.sessionPhase +
            ' 테마=' + (body.themes || []).length +
            ' 52주=' + (body.high52 ? (body.high52.byValue || []).length : 0) +
            ' 상한가=' + (body.upperLimit ? (body.upperLimit.confirmed || []).length : 0) +
            ' 임박=' + (body.upperLimit ? (body.upperLimit.near || []).length : 0) +
            ' 뉴스=' + (body.news || []).length + ' applied=' + applied +
            ' errors=' + (body.errors || []).length);
        } else {
          state.ok = false;
          setBadge(false, '⚠️ 1·3·5탭 갱신 항목 없음');
          showRetry('갱신 항목 없음');
        }
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        state.polling = false;
        if (reqId !== state.reqId) return;
        state.ok = false;
        var reason = err && err.name === 'AbortError' ? '응답 시간 초과(14초)' : (err && err.message ? err.message : String(err));
        /* ③ 이미 그려 둔 값이 있으면 지우지 않고 '지연 + 재시도' 만 알린다. */
        setBadge(false, state.lastBody
          ? '⚠️ 실시간 지연 · ' + (state.lastBody.generatedAtKst || '') + ' 값 유지'
          : '⚠️ 실시간 연결 실패');
        showRetry(reason);
        console.warn('[TabsLive] 호출 실패: ' + reason);
      });
  }

  function start() {
    /* ① 화면을 열자마자 3분 내 캐시로 먼저 그린다(0.1초 체감). 최신 응답은 곧바로 이어서 받는다. */
    var cached = readCache();
    if (cached) {
      var n = apply(cached);
      state.lastBody = cached;
      state.cacheHit = true;
      setStamp(cached, true);
      setBadge(null, '⚡ 캐시 즉시 복원 ' + (cached.generatedAtKst || '') + ' · 최신 확인 중');
      try {
        console.log('[TabsLive] sessionStorage 캐시 복원 ' + (cached.generatedAtKst || '') +
          ' (applied=' + n + ') → 최신 응답 확인');
      } catch (e) { /* noop */ }
    }
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

  /* --------------- ⑤ 원클릭 즉시 새로고침 (KIS·네이버·스탁이지 재조회) ---------------
   *  자동 주기(30초)를 기다리지 않고 지금 바로 다시 받아온다. 연타로 API 를 때리지 않게
   *  10초 쿨다운을 두고 버튼에 남은 초를 보여준다(서버 API 한도 보호). */
  var QUICK_COOLDOWN_MS = 10 * 1000;
  var quickAt = 0;
  var quickTick = null;

  function quickButton() { return document.getElementById('sdQuickRefresh'); }

  function quickRefresh() {
    var btn = quickButton();
    var now = Date.now();
    var left = Math.ceil((quickAt + QUICK_COOLDOWN_MS - now) / 1000);
    if (left > 0) {
      if (btn) { btn.textContent = '⏳ ' + left + '초 후'; btn.classList.add('busy'); }
      return false;
    }
    quickAt = now;
    if (btn) { btn.textContent = '🔄 조회 중…'; btn.classList.add('busy'); }

    /* tabs-live 는 캐시 우회(?fresh=1)로, 지수·감시종목·수급 카드는 각 레이어의 poll 로 다시 받는다. */
    try { poll(true); } catch (e) { /* noop */ }
    try { if (window.LiveAPI && typeof window.LiveAPI.poll === 'function') window.LiveAPI.poll(); } catch (e) { /* noop */ }
    try { if (window.LiveExtra && typeof window.LiveExtra.poll === 'function') window.LiveExtra.poll(); } catch (e) { /* noop */ }
    try { if (window.LiveExtra && typeof window.LiveExtra.loadTrend === 'function') window.LiveExtra.loadTrend(); } catch (e) { /* noop */ }

    if (quickTick) clearInterval(quickTick);
    quickTick = setInterval(function () {
      var b = quickButton();
      var l = Math.ceil((quickAt + QUICK_COOLDOWN_MS - Date.now()) / 1000);
      if (l > 0) {
        if (b) { b.textContent = '⏳ ' + l + '초 후'; b.classList.add('busy'); }
      } else {
        if (b) { b.textContent = '🔄 즉시 새로고침'; b.classList.remove('busy'); }
        clearInterval(quickTick);
        quickTick = null;
      }
    }, 1000);
    return true;
  }

  window.TabsLive = {
    poll: poll,
    start: start,
    apply: apply,
    refresh: function () { poll(true); },
    quickRefresh: quickRefresh,
    readCache: readCache,
    clearCache: function () { try { window.sessionStorage.removeItem(CACHE_KEY); } catch (e) { /* noop */ } },
    state: state,
    _applyTheme: applyTheme,
    _renderWatchBox: renderWatchBox,
    _watchScoreTheme: watchScoreTheme,
    _watchScoreStock: watchScoreStock,
    _tvRecord: tvRecord,
    _tvGain: tvGain,
    _tvLoad: tvLoad,
    _tvApplyServer: tvApplyServer,
    _tvGainText: tvGainText,
    _volHtml: volHtml,
    _themeState: function () { return { tvDate: state.tvDate, tvNowMin: state.tvNowMin, buckets: state.tv ? Object.keys(state.tv).length : 0, codes: state.tv ? Object.keys(state.tv).length : 0 }; },
    _renderHigh52: renderHigh52,
    _renderUpperLimit: renderUpperLimit,
    _renderNews: renderNews,
    _renderStrategyLive: renderStrategyLive,
    _renderDynamicThemes: renderDynamicThemes,
    toggleAfterFilter: toggleAfterFilter,
    toggleNewsBox: toggleNewsBox,
    newsBoxFolded: newsBoxFolded,
    setAfterFilter: setAfterFilter,
    afterFilterOn: afterFilterOn,
    _folds: function () { return state.folds; },
    _renderAftermarket: renderAftermarket,
    openChartHere: openChartHere
  };

  /* ----------------------------------------------------------------
   * 정적 뉴스 카드의 onclick 자가 복구
   *  · 자동 동기화 스크립트가 기사 제목을 onclick="openNewsDetail('...')" 에 넣을 때
   *    제목 속 따옴표가 새면 문자열이 끊겨 카드가 '눌러도 반응 없음'이 된다(11/16 적발).
   *  · 배포된 HTML 을 고쳐도 과거에 박힌 카드는 남으므로, 읽는 쪽에서도 한 번 더 고친다.
   *  · 화면에 보이는 제목·시간·원문 링크로 핸들러를 다시 만든다(없는 값은 빈 문자열).
   * ------------------------------------------------------------------ */
  function jsStr(v) {
    return "'" + String(v === null || v === undefined ? '' : v)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r?\n/g, ' ')
      .replace(/</g, '&lt;') + "'";
  }

  function repairInlineHandlers() {
    var fixed = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.news-timeline-card[onclick]'), function (el) {
      var code = el.getAttribute('onclick') || '';
      if (!code) return;
      var bad = false;
      try { new Function(code); } catch (e) { bad = true; }
      if (!bad) return;
      var titleEl = el.querySelector('.nt-title');
      var timeEl = el.querySelector('.nt-time');
      var linkEl = el.querySelector('a[href]');
      var title = titleEl ? String(titleEl.textContent || '').trim() : '';
      if (!title) return;
      var time = timeEl ? String(timeEl.textContent || '').trim().split(/\s+/)[0] : '';
      var url = linkEl ? linkEl.getAttribute('href') || '' : '';
      var args = [title, time ? time + ' 속보' : '실시간 속보', url, title,
        '키워드 자동 분석으로 매칭된 기사입니다. 원문 링크로 확인하십시오.', '']; 
      el.setAttribute('onclick', 'openNewsDetail(' + args.map(jsStr).join(', ') + ')');
      el.setAttribute('data-handler-repaired', '1');
      fixed += 1;
    });
    return fixed;
  }
  window.repairInlineHandlers = repairInlineHandlers;

  function boot() {
    if (!patchForceRefresh()) {
      var tries = 0;
      var t = setInterval(function () {
        tries += 1;
        if (patchForceRefresh() || tries > 20) clearInterval(t);
      }, 250);
    }
    try { repairInlineHandlers(); } catch (e) { /* noop */ }
    setInterval(function () { if (!document.hidden) { try { repairInlineHandlers(); } catch (e) { /* noop */ } } }, 45000);
    start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* ============================================================
   🎯 1·7번 수급 이동 타임라인 — 장중 잠정 외국인·기관 배지 (KIS 대체)
   ------------------------------------------------------------
   · 네이버 stock.naver.com .../trend/trendForeignOrg 는 404(2026-11-24 실측)라
     window.FLOW_TIMELINE 의 investor 가 비어 있었다.
   · 그 자리를 한투 KIS 장중 가집계(/api/tabs-live?mode=supply_live)로 채운다.
   · 이미 값이 있는 슬롯(네이버 응답 성공분)은 건드리지 않는다.
   · 15:30 이후·휴장일·개장 전에는 서버가 확정치로 폴백(confirmed=true) → '확정'으로 표기하고
     실시간 가집계처럼 쓰지 않는다.
   · 60초마다 확인하되, 채울 슬롯이 없으면 요청하지 않는다(호출 낭비 없음).
   ============================================================ */
(function () {
  'use strict';
  var API = '/api/tabs-live?mode=supply_live&top=30';
  var lastTry = 0, busy = false;

  function needsFill() {
    var d = window.FLOW_TIMELINE || {};
    var slots = d.slots || [];
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (!s || s.state !== 'done') continue;
      var inv = s.investor || {};
      if ((inv.foreign || []).length || (inv.organ || []).length) continue;
      return true;
    }
    return false;
  }

  function build(d) {
    var g = d.groups || {}, top = d.top || [];
    var mm = String(d.asOfLabel || '').match(/(\d{1,2}:\d{2})/);
    var out = { at: mm ? mm[1] : '', label: d.asOfLabel || '', foreign: [], organ: [],
                note: '', source: 'kis', unit: '억', asOfLabel: d.asOfLabel || '',
                confirmed: !!d.confirmed,
                basis: 'KIS 장중 가집계(외국인·기관계 순매수 상위, 억 원)' };
    var push = function (key, rows) {
      (rows || []).forEach(function (r, i) {
        if (!r || !r.code) return;
        var net = (typeof r.netValueEok === 'number') ? r.netValueEok
          : (key === 'foreign' ? r.foreignEok : r.organEok);
        if (typeof net !== 'number') return;
        out[key].push({ code: String(r.code), name: r.name || '', rank: r.rank || (i + 1),
                        eok: Math.round(net * 10) / 10, price: r.price, chg: r.changePct });
      });
    };
    push('foreign', (g.foreign || {}).top);
    push('organ', (g.organ || {}).top);
    if (!out.foreign.length && !out.organ.length) { push('foreign', top); push('organ', top); }
    if (!out.foreign.length && !out.organ.length) return null;
    out.note = out.confirmed
      ? ('네이버 trendForeignOrg 404 → KIS 확정치 폴백(' + (d.asOfLabel || '') + ') — 장중 가집계가 아닙니다')
      : ('네이버 trendForeignOrg 404 → KIS 장중 가집계로 대체(' + (d.asOfLabel || '') + ') · 금액은 억 원');
    return out;
  }

  function apply(inv) {
    var d = window.FLOW_TIMELINE;
    if (!d || !d.slots) return 0;
    var n = 0;
    d.slots.forEach(function (s) {
      if (!s || s.state !== 'done') return;
      var cur = s.investor || {};
      if ((cur.foreign || []).length || (cur.organ || []).length) return;
      s.investor = { at: inv.at, label: inv.label, foreign: inv.foreign, organ: inv.organ,
                     note: inv.note, source: 'kis', unit: '억', confirmed: inv.confirmed,
                     asOfLabel: inv.asOfLabel, basis: inv.basis };
      n += 1;
    });
    window.__KIS_INVESTOR_LIVE = { filled: n, at: inv.at, confirmed: inv.confirmed };
    return n;
  }

  function run(force) {
    if (busy || !needsFill()) return;
    if (!force && Date.now() - lastTry < 55000) return;
    busy = true; lastTry = Date.now();
    fetch(API, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        busy = false;
        if (!d || d.mode !== 'supply_live' || !d.ok) return;
        var inv = build(d);
        if (inv) apply(inv);
      })
      .catch(function () { busy = false; });
  }

  function boot() {
    run(true);
    setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      run(false);
    }, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

