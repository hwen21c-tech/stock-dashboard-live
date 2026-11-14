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
    }

    var fx = payload.fx;
    if (fx) {
      var fxPrice = num(fx.price);
      if (fxPrice !== null) {
        var fxp = num(fx.changePct);
        var ft2 = findTicker(function (l) { return l.indexOf('원/달러') >= 0; });
        if (ft2 && paintTicker(ft2, fxPrice.toFixed(2) + '원 ' + pctText(fxp), fxp)) applied += 1;
      }
    }

    // 감시 종목(RN존 목록) 현재가·등락률·통합 거래대금
    var map = {};
    (payload.stocks || []).forEach(function (s) {
      if (!s || !s.code) return;
      map[s.code] = {
        price: num(s.price),
        changePct: num(s.changePct),
        valueText: s.valueText || null
      };
    });
    if (window.RnZone && typeof window.RnZone.refreshLivePrices === 'function' && Object.keys(map).length) {
      try { window.RnZone.refreshLivePrices(map); applied += 1; } catch (e) { /* noop */ }
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

  function watchCodes() {
    try {
      if (window.RnZone && typeof window.RnZone.getStocks === 'function') {
        var list = window.RnZone.getStocks() || [];
        var codes = list.map(function (s) { return s && s.code; }).filter(function (c) { return /^\d{6}$/.test(String(c)); });
        if (codes.length) return codes.slice(0, 30);
      }
    } catch (e) { /* noop */ }
    return [];
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
        date: c.date,
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
            (j.stocks || []).forEach(function (s) { if (s && s.code) map[s.code] = { price: num(s.price), changePct: num(s.changePct), valueText: s.valueText || null }; });
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
    state: state
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start);
  }
})();
