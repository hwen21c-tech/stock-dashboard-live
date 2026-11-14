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
