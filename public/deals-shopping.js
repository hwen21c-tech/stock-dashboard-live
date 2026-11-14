/* ============================================================================
 * 🛒 쇼핑 실시간 최저가 Top 5  (Vercel Serverless  /api/deals-shopping)
 * ----------------------------------------------------------------------------
 *  · 키워드를 넣으면 네이버 쇼핑 검색 API(최저가순) 결과 Top 5를 카드로 그린다.
 *  · NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 미등록이면
 *      "키 연동 안내 배너 + 네이버쇼핑 직통 링크"로 안전하게 대체한다. (에러 아님)
 *  · 기존 특가 레이더(여행·키즈·캘린더) 화면과 로직은 건드리지 않는 추가 탭.
 * ==========================================================================*/
(function () {
  'use strict';

  var API_URL = '/api/deals-shopping';
  var CHIPS = [
    '돼지고기 국내산 1kg',
    '계란 대란 30구',
    '우유 1L 6팩',
    '화장지 30롤',
    '쌀 10kg',
    '세탁세제 3L'
  ];
  var lastQuery = '';

  function byId(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function won(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString('ko-KR') + '원';
  }

  function setStatus(html, color) {
    var el = byId('shoppingStatus');
    if (!el) return;
    el.innerHTML = html || '';
    el.style.color = color || '#94a3b8';
  }

  function renderChips() {
    var host = byId('shoppingChips');
    if (!host) return;
    host.innerHTML = CHIPS.map(function (q) {
      return '<button type="button" class="q-chip" data-q="' + esc(q) + '" ' +
        'style="background: rgba(56,189,248,0.10); border: 1px solid rgba(56,189,248,0.35); color: #7dd3fc; ' +
        'border-radius: 999px; padding: 5px 11px; font-size: 11px; font-weight: 700; cursor: pointer;">' +
        esc(q) + '</button>';
    }).join('');
    host.querySelectorAll('button[data-q]').forEach(function (b) {
      b.addEventListener('click', function () {
        var input = byId('shoppingQuery');
        if (input) input.value = b.getAttribute('data-q');
        search();
      });
    });
  }

  function keyGuide(body) {
    var searchUrl = (body && body.searchUrl) || ('https://search.shopping.naver.com/search/all?query=' + encodeURIComponent(lastQuery));
    var setup = (body && body.setup) || {};
    var envKeys = (setup.envKeys || ['NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET']).map(function (k) {
      return '<code style="background:#0b1120; border:1px solid rgba(148,163,184,0.35); border-radius:4px; padding:1px 5px;">' + esc(k) + '</code>';
    }).join(' ');
    return '' +
      '<div style="background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.4); border-radius: 12px; padding: 14px 16px; line-height: 1.65;">' +
      '<div style="font-size: 13px; font-weight: 800; color: #fbbf24; margin-bottom: 6px;">🔑 네이버 쇼핑 API 키가 아직 연결되지 않았습니다</div>' +
      '<div style="font-size: 11.5px; color: #cbd5e1;">' +
      'Vercel 프로젝트 → <b>Settings → Environment Variables</b> 에 ' + envKeys + ' 를 등록하면 ' +
      '이 탭에서 실시간 최저가 Top 5(가격·판매처·직통 링크)가 바로 표시됩니다.' +
      (setup.where ? '<br>발급: <a href="' + esc(setup.where) + '" target="_blank" rel="noopener" style="color:#7dd3fc; text-decoration:underline;">네이버 개발자센터 애플리케이션 등록</a> (사용 API: 검색)' : '') +
      '</div>' +
      '<div style="margin-top: 10px;">' +
      '<a href="' + esc(searchUrl) + '" target="_blank" rel="noopener" ' +
      'style="display:inline-flex; align-items:center; gap:6px; background:#022c22; color:#6ee7b7; border:1px solid #10b981; border-radius:8px; padding:7px 14px; font-size:12px; font-weight:800; text-decoration:none;">' +
      '🛒 네이버쇼핑에서 "' + esc(lastQuery) + '" 최저가 직접 보기 →</a>' +
      '</div></div>';
  }

  function itemCard(it) {
    var img = it.image
      ? '<img src="' + esc(it.image) + '" alt="" loading="lazy" style="width:74px; height:74px; object-fit:cover; border-radius:8px; background:#0f172a; flex-shrink:0;">'
      : '<div style="width:74px; height:74px; border-radius:8px; background:#0f172a; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:20px;">🛒</div>';
    var rankColor = it.rank === 1 ? '#fbbf24' : it.rank === 2 ? '#cbd5e1' : it.rank === 3 ? '#d97706' : '#64748b';
    return '' +
      '<div style="display:flex; gap:10px; background:#0b1120; border:1px solid rgba(148,163,184,0.22); border-radius:12px; padding:10px;">' +
      '<div style="display:flex; flex-direction:column; align-items:center; gap:4px; flex-shrink:0;">' +
      '<span style="font-size:11px; font-weight:900; color:' + rankColor + ';">' + it.rank + '위</span>' + img +
      '</div>' +
      '<div style="min-width:0; flex:1; display:flex; flex-direction:column; gap:4px;">' +
      '<a href="' + esc(it.link || '#') + '" target="_blank" rel="noopener" ' +
      'style="font-size:12px; font-weight:700; color:#e2e8f0; text-decoration:none; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">' +
      esc(it.title) + '</a>' +
      '<div style="display:flex; align-items:baseline; gap:8px; flex-wrap:wrap;">' +
      '<span style="font-size:15px; font-weight:900; color:#34d399;">' + won(it.price) + '</span>' +
      (it.highPrice && it.highPrice > it.price ? '<span style="font-size:10.5px; color:#64748b; text-decoration:line-through;">' + won(it.highPrice) + '</span>' : '') +
      '</div>' +
      '<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:10.5px; color:#94a3b8;">' +
      (it.mall ? '<span style="background:rgba(56,189,248,0.10); border:1px solid rgba(56,189,248,0.3); color:#7dd3fc; border-radius:4px; padding:1px 6px; font-weight:800;">' + esc(it.mall) + '</span>' : '') +
      (it.brand ? '<span>' + esc(it.brand) + '</span>' : '') +
      '<a href="' + esc(it.link || '#') + '" target="_blank" rel="noopener" style="margin-left:auto; color:#4ade80; font-weight:800; text-decoration:none;">최저가 보기 →</a>' +
      '</div></div></div>';
  }

  function renderResults(body) {
    var host = byId('shoppingResults');
    if (!host) return;
    var items = body.items || [];
    if (!items.length) {
      host.innerHTML = '<div style="color:#94a3b8; font-size:12px; padding:16px;">&#34;' + esc(lastQuery) + '&#34; 조건에 맞는 상품이 없습니다. 다른 키워드로 시도해 보세요.</div>';
      return;
    }
    host.innerHTML =
      '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; margin:10px 0 8px;">' +
      '<div style="font-size:12.5px; font-weight:800; color:#e2e8f0;">"' + esc(lastQuery) + '" 실시간 최저가 Top ' + items.length + '</div>' +
      '<div style="font-size:11px; color:#94a3b8;">최저 ' + won(body.lowest) + ' · 네이버 쇼핑 검색 API · 최저가순</div>' +
      '</div>' +
      '<div style="display:grid; gap:8px;">' + items.map(itemCard).join('') + '</div>' +
      '<div style="margin-top:10px; font-size:10.5px; color:#64748b; line-height:1.6;">' +
      '※ 표시가는 상품 최저가(배송비 별도일 수 있음)입니다. 옵션·배송비 포함 최종가 비교가 필요하면 채팅으로 품목만 말씀해 주세요.' +
      '</div>';
  }

  function search() {
    var input = byId('shoppingQuery');
    var q = input ? String(input.value || '').trim() : '';
    if (!q) {
      setStatus('🔍 찾으실 품목을 입력해 주세요. 예) 돼지고기 국내산 1kg', '#fbbf24');
      return;
    }
    lastQuery = q;
    var host = byId('shoppingResults');
    if (host) host.innerHTML = '';
    setStatus('⏳ "' + esc(q) + '" 실시간 최저가 조회 중…', '#94a3b8');

    var controller = null;
    var timer = null;
    try { controller = new AbortController(); } catch (e) { controller = null; }
    if (controller) timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, 12000);

    fetch(API_URL + '?q=' + encodeURIComponent(q), controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' })
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
        if (!body) {
          setStatus('⚠️ 응답을 해석하지 못했습니다 (HTTP ' + out.status + '). 잠시 후 다시 시도해 주세요.', '#fca5a5');
          return;
        }
        if (body.ok !== true) {
          if (body.reason === 'missing_naver_api_key') {
            setStatus('🔑 API 키 미등록 — 아래 안내대로 키를 넣으면 실시간 최저가가 표시됩니다. 지금은 네이버쇼핑 직통 링크로 확인하세요.', '#fbbf24');
            if (host) host.innerHTML = keyGuide(body);
            return;
          }
          setStatus('⚠️ ' + (body.message || '최저가 조회에 실패했습니다.'), '#fca5a5');
          if (body.searchUrl && host) {
            host.innerHTML = '<div style="padding:10px 0;"><a href="' + esc(body.searchUrl) + '" target="_blank" rel="noopener" ' +
              'style="color:#7dd3fc; font-size:12px; text-decoration:underline;">🛒 네이버쇼핑에서 직접 검색하기 →</a></div>';
          }
          return;
        }
        setStatus('🟢 "' + esc(q) + '" 실시간 최저가 ' + (body.count || 0) + '건 · 최저 ' + won(body.lowest), '#34d399');
        renderResults(body);
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        var reason = err && err.name === 'AbortError' ? '응답 시간 초과(12초)' : (err && err.message ? err.message : String(err));
        setStatus('⚠️ 조회 실패: ' + esc(reason) + ' — 잠시 후 다시 시도해 주세요.', '#fca5a5');
      });
  }

  function init() {
    renderChips();
    var input = byId('shoppingQuery');
    if (input && !input.dataset.bound) {
      input.dataset.bound = '1';
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); search(); }
      });
    }
    var btn = byId('shoppingSearchBtn');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', search);
    }
    if (!byId('shoppingStatus') || !byId('shoppingStatus').textContent.trim()) {
      setStatus('🔍 품목을 입력하거나 아래 빠른 검색을 눌러 주세요. (네이버 쇼핑 최저가순 · Top 5)', '#94a3b8');
    }
  }

  window.ShoppingDeals = { init: init, search: search };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
