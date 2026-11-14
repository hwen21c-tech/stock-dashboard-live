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

      if (bodyEl) bodyEl.innerHTML = skeletonHtml() + deep;
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
    mounted: { news: false, after: false },
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

    var changeEl = tile.querySelector('.st-change');
    if (changeEl && isNum(stock.changePct)) {
      changeEl.textContent = pctTxt(stock.changePct);
      changeEl.style.color = colFor(stock.changePct);
      hits += 1;
    }

    var ohlcEl = tile.querySelector('.st-ohlc');
    if (ohlcEl && isNum(stock.price)) {
      ohlcEl.innerHTML =
        '종 <strong>' + esc(fmt(stock.price)) + '</strong> | 시 ' + esc(fmt(stock.open)) +
        ' 고 ' + esc(fmt(stock.high)) + ' 저 ' + esc(fmt(stock.low));
      hits += 1;
    }

    var volEl = tile.querySelector('.st-vol');
    if (volEl && stock.valueText) {
      volEl.textContent = stock.valueText;
      volEl.title = '거래대금 ' + stock.valueText + ' (' + (stock.valueBasis || '통합') + ')';
      hits += 1;
    }

    if (isNum(stock.price)) {
      var nameEl = tile.querySelector('.st-name');
      var shownName = nameEl ? nameEl.textContent.replace(/[★☆\s]/g, '') : (stock.tileName || stock.name);
      refreshTileOnclick(
        tile,
        shownName,
        pctTxt(stock.changePct),
        '대금 ' + (stock.valueText || '—') + ' | 현재가 ' + fmt(stock.price) + '원'
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
      avgEl.style.color = colFor(theme.avgPct);
      avgEl.innerHTML = esc(pctTxt(theme.avgPct)) +
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
        '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">' +
          '<div style="display:flex; align-items:center; gap:6px;">' +
            '<span class="nt-time" style="background:#0c4a6e; color:#bae6fd;">' + esc(n.time || '—') + ' 실시간 속보 ⚡</span>' +
            '<span style="font-size:10px; padding:2px 6px; border-radius:4px; background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); font-weight:700;">🏷️ ' + esc(n.press || '증시') + '</span>' +
          '</div>' + link +
        '</div>' +
        '<div class="nt-title">' + esc(n.title) + '</div>' +
        (n.summary ? '<div class="nt-history">' + esc(n.summary) + '</div>' : '') +
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
        '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">' +
          '<span class="af-time">' + esc(n.time || '—') + ' 실시간 속보 ⚡</span>' + link +
        '</div>' +
        '<div class="af-title">' + esc(n.title) + '</div>' +
        (n.summary ? '<div class="af-move">' + esc(n.summary) + '</div>' : '') +
        '<div class="af-history">🕒 ' + esc(newsMeta(n)) + ' · 네이버 증권 실시간 뉴스</div>' +
      '</div>';
  }

  function newsBoxHtml(inner, list, stamp, titleSuffix, accent) {
    return '' +
      '<div class="panel-box" style="background:#111827; border-color:' + accent.border + '; margin-bottom:12px;">' +
        '<div class="sec-head" style="border-bottom-color:' + accent.border + '; color:' + accent.color + '; padding-bottom:8px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">' +
          '<span style="font-weight:800; font-size:12.5px;">📡 실시간 최신 증시 속보 ' + list.length + '건 ' + esc(titleSuffix) + '</span>' +
          '<span class="sub" style="color:' + accent.color + ';">⚡ ' + esc(stamp) + ' 갱신 · 네이버 증권</span>' +
        '</div>' + inner +
        '<div style="font-size:10px; color:#64748b; margin-top:6px;">' +
          '※ 네이버 증권 실시간 뉴스 목록에서 방금 받아온 최신 속보입니다. 아래 기존 타임라인·과거 유사사례 섹션은 그대로 유지됩니다.' +
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

  /* ------------------ 주말/휴장 표현 정정 (정적 문구) ------------------ */

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

    // 1번 탭 — 8대 테마
    var themes = body.themes || [];
    themes.forEach(function (t, i) {
      var block = findThemeBlock(t, i);
      if (block) applied += applyTheme(t, block);
    });
    if (themes.length) markThemeHead(stamp);

    // 1번 탭 — 52주 신고가 / 100억+ 상한가
    var panels = overviewPanels();
    applied += renderHigh52(panels.gold, body.high52, stamp);
    applied += renderUpperLimit(panels.red, body.upperLimit, stamp);

    // 3·5번 탭 — 실시간 뉴스
    applied += renderNews(body, stamp);

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
    _renderNews: renderNews
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
