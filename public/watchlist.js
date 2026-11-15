/* ============================================================
   ⭐ 관제탑 관심종목(★) · 매수/손절/메모 · ☁️ 클라우드 동기화
   ─ 종목 카드마다 ☆/★ 를 달고, 매수·손절가와 메모를 남긴다.
   ─ 헤더의 「★ 관심종목」에서 한눈에 모아 보고, ★만 보기로 카드를 걸러낸다.
   ─ Supabase family_sync 테이블의 'stock_0623' 네임스페이스로 폰·PC 자동 동기화.
     (포켓몬 '0623' 과 절대 섞이지 않도록 키를 분리했다)
   ─ 다른 탭·모달·Hot-Swap 이 다시 그려도 MutationObserver 로 별을 다시 붙인다.
   ============================================================ */
(function () {
  'use strict';
  if (window.StockWatch && window.StockWatch.version) return;

  var VERSION = '1.0.0';
  var LS = 'stock.watch.v1';
  var LS_META = 'stock.watch.meta.v1';
  var SUP = {
    url: 'https://hiruybkapzuhjrzjoyik.supabase.co',
    key: 'sb_publishable_e5JJbvCPDhY91uXaUEVNVA_8Byv_gI8',
    table: 'family_sync',
    code: 'stock_0623'          /* 포켓몬 0623 과 분리된 전용 네임스페이스 */
  };

  /* ---------------------------------------------------------- 상태 */
  var S = {
    items: {},        /* key -> {code,name,market,buy,stop,memo,at,del} */
    clearedAt: 0,     /* 사용자가 전부 지운 시각(빈 목록을 클라우드에 반영하기 위한 표식) */
    at: 0,            /* 이 기기에서 마지막으로 바꾼 시각 */
    status: 'idle',   /* idle | syncing | ok | error | off */
    msg: '',
    lastSync: 0,
    remoteAt: null,
    onlyMine: false
  };

  function now() { return Date.now(); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function parseJ(raw, d) {
    if (!raw) return d;
    try { var v = JSON.parse(raw); return v == null ? d : v; } catch (e) { return d; }
  }

  /* ---------------------------------------------------------- 저장/불러오기 */
  function loadLocal() {
    var d = parseJ(lsGet(LS), null);
    if (d && typeof d === 'object') {
      var items = d.items && typeof d.items === 'object' ? d.items : {};
      Object.keys(items).forEach(function (k) {
        var it = items[k];
        if (!it || typeof it !== 'object') { delete items[k]; return; }
        if (typeof it.at !== 'number') it.at = 0;
      });
      S.items = items;
      S.at = typeof d.at === 'number' ? d.at : 0;
      S.clearedAt = typeof d.clearedAt === 'number' ? d.clearedAt : 0;
      dedupe();
    }
  }
  function saveLocal(touch) {
    if (touch) S.at = now();
    lsSet(LS, JSON.stringify({ v: 1, items: S.items, at: S.at, clearedAt: S.clearedAt }));
    if (touch) schedulePush();
  }
  function metaLoad() { var m = parseJ(lsGet(LS_META), {}); return m && typeof m === 'object' ? m : {}; }
  function metaSave(m) { lsSet(LS_META, JSON.stringify(m)); }

  /* ---------------------------------------------------------- 항목 */
  function keyOf(code, name) { return code ? String(code) : 'n:' + String(name || ''); }
  function live(key) {
    var it = S.items[key];
    return it && !it.del ? it : null;
  }
  function watched(key) { return !!live(key); }
  function count() { return Object.keys(S.items).filter(function (k) { return live(k); }).length; }
  function list() {
    return Object.keys(S.items).map(function (k) { return S.items[k]; })
      .filter(function (it) { return it && !it.del; })
      .sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  }

  /* 이름만으로 담아 둔 항목이 나중에 코드가 확인되면 코드 항목으로 합친다(중복 ★ 방지) */
  function dedupe() {
    var codeByName = {};
    Object.keys(S.items).forEach(function (k) {
      var it = S.items[k];
      if (!it || it.del) return;
      if (it.code) codeByName[it.name] = it;
    });
    Object.keys(S.items).forEach(function (k) {
      var it = S.items[k];
      if (!it || it.del || it.code) return;
      var twin = codeByName[it.name];
      if (!twin || twin === it) return;
      if (!twin.buy && it.buy) twin.buy = it.buy;
      if (!twin.stop && it.stop) twin.stop = it.stop;
      if (!twin.memo && it.memo) twin.memo = it.memo;
      twin.at = Math.max(twin.at || 0, it.at || 0);
      S.items[k] = { code: '', name: it.name, at: now(), del: true };
    });
  }

  function upsert(meta, patch) {
    var key = keyOf(meta.code, meta.name);
    var cur = S.items[key] || {};
    var it = {
      code: meta.code || cur.code || '',
      name: meta.name || cur.name || '',
      market: meta.market || cur.market || '',
      buy: cur.buy || '', stop: cur.stop || '', memo: cur.memo || '',
      at: now(), del: false
    };
    if (patch) for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) it[k] = patch[k];
    it.at = now();
    S.items[key] = it;
    dedupe();
    saveLocal(true);
    refreshUI();
    return it;
  }
  function remove(meta) {
    var key = keyOf(meta.code, meta.name);
    var cur = S.items[key];
    S.items[key] = { code: (cur && cur.code) || meta.code || '', name: (cur && cur.name) || meta.name || '',
                     at: now(), del: true };
    saveLocal(true);
    if (!count()) S.clearedAt = now();
    refreshUI();
  }

  /* ---------------------------------------------------------- 클라우드 */
  function api(path) { return SUP.url + '/rest/v1/' + SUP.table + path; }
  function headers(extra) {
    var h = { 'apikey': SUP.key, 'Authorization': 'Bearer ' + SUP.key, 'Content-Type': 'application/json' };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }
  function getRow() {
    var url = api('?code=eq.' + encodeURIComponent(SUP.code) + '&select=code,data,updated_at');
    return fetch(url, { headers: headers(), cache: 'no-store' }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + String(t).slice(0, 120)); });
      return r.json().then(function (a) { return (a && a.length) ? a[0] : null; });
    });
  }
  function putRow() {
    var payload = [{
      code: SUP.code,
      data: { v: 1, items: S.items, at: S.at, clearedAt: S.clearedAt, device: 'dashboard' },
      updated_at: new Date().toISOString()
    }];
    return fetch(api('?on_conflict=code'), {
      method: 'POST',
      headers: headers({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(payload), cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + String(t).slice(0, 120)); });
      return true;
    });
  }

  function mergeItems(localItems, remoteItems) {
    var out = {}, changed = false, localWins = 0;
    var keys = {};
    Object.keys(localItems || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(remoteItems || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      var a = localItems[k], b = remoteItems[k];
      if (!a && b) { out[k] = b; changed = true; return; }
      if (a && !b) { out[k] = a; localWins++; return; }
      if ((a.at || 0) >= (b.at || 0)) { out[k] = a; if (JSON.stringify(a) !== JSON.stringify(b)) localWins++; }
      else { out[k] = b; changed = true; }
    });
    return { items: out, changed: changed, localWins: localWins };
  }

  function setStatus(st, msg) {
    S.status = st; S.msg = msg || ''; renderSyncBar();
  }

  var syncing = false, pushTimer = null;
  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushNow(); }, 900);
  }
  function pushNow() {
    if (syncing) return Promise.resolve(false);
    if (!count() && !S.clearedAt) return Promise.resolve(false);  /* 빈 기기가 클라우드를 지우지 않는다 */
    syncing = true;
    setStatus('syncing', '올리는 중…');
    return putRow().then(function () {
      S.lastSync = now(); S.remoteAt = new Date().toISOString();
      var m = metaLoad(); m.lastPush = S.lastSync; m.at = S.at; metaSave(m);
      setStatus('ok');
      return true;
    }).catch(function (e) {
      setStatus('error', (e && e.message) ? e.message : '네트워크 오류');
      return false;
    }).then(function (r) { syncing = false; return r; });
  }

  function pullNow(force) {
    if (syncing) return Promise.resolve(false);
    if (!force && (now() - (S.lastPull || 0) < 20000)) return Promise.resolve(false);
    syncing = true;
    S.lastPull = now();
    setStatus('syncing', '맞추는 중…');
    return getRow().then(function (row) {
      var remote = (row && row.data) || null;
      if (!remote) {
        setStatus('ok');
        if (count()) return pushNowSoon();
        return false;
      }
      var mg = mergeItems(S.items, remote.items || {});
      if (typeof remote.clearedAt === 'number') S.clearedAt = Math.max(S.clearedAt, remote.clearedAt);
      if (mg.changed) {
        S.items = mg.items;
        dedupe();
        saveLocal(false);
        refreshUI();
      }
      S.remoteAt = row ? row.updated_at : null;
      S.lastSync = now();
      setStatus('ok');
      /* 로컬이 더 최신이거나, 클라우드에 없던 항목이 있으면 올려서 양쪽을 맞춘다 */
      if (mg.localWins > 0) return pushNowSoon();
      return true;
    }).catch(function (e) {
      setStatus('error', (e && e.message) ? e.message : '네트워크 오류');
      return false;
    }).then(function (r) { syncing = false; return r; });
  }
  function pushNowSoon() {
    return putRow().then(function () { S.lastSync = now(); setStatus('ok'); return true; })
      .catch(function (e) { setStatus('error', (e && e.message) || '오류'); return false; });
  }

  /* ---------------------------------------------------------- 이름 → 코드 */
  function cleanName(raw) {
    var s = String(raw || '');
    /* 과열 배지·경보 배지가 같은 줄에 붙어 있어도 종목명만 남긴다 */
    s = s.split(/[📈⚠🚨🔥⛔👑]/)[0];
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^[★☆\s]+/, '');
    s = s.replace(/\s*\(\d{6}\)\s*$/, '');
    s = s.replace(/\s*\[[^\]]*\]\s*$/, '');
    s = s.replace(/\s*\((?:외인|기관|연기금)[^)]*\)\s*$/, '');
    s = s.replace(/\s*\d{6}\s*$/, '');
    s = s.replace(/\s*\d+일?\s*[+-]?\d+(\.\d+)?%\s*$/, '');
    s = s.replace(/\s+(투자주의|투자경고|투자위험|거래정지|상한가)\s*$/, '');
    return s.trim();
  }
  function codeMap() {
    var map = {};
    try { if (window.stockCodes) for (var k in window.stockCodes) map[k] = window.stockCodes[k]; } catch (e) { /* */ }
    /* 카드 DOM 에서 (이름,코드) 쌍을 계속 보강한다 */
    try {
      document.querySelectorAll('[data-code],[data-live-code]').forEach(function (n) {
        var code = n.getAttribute('data-code') || n.getAttribute('data-live-code');
        if (!/^\d{6}$/.test(code || '')) return;
        var nm = n.querySelector('.nm, .c-name, .card-name span, .st-name, .ssc-name');
        var t = cleanName(nm ? nm.textContent : '');
        if (t && !map[t]) map[t] = code;
      });
    } catch (e) { /* */ }
    return map;
  }

  function nameFrom(el) {
    if (!el || !el.querySelector) return '';
    var node = el.querySelector('.nm, .c-name, .card-name, .st-name, .ssc-name, .ri-head span, .mi-title');
    if (!node) return cleanName((el.textContent || '').split('\n')[0]);
    var clone = node.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('.c-code, .c-mkt, .wl-star, .wl-note-chip'), function (n) { n.remove(); });
    Array.prototype.forEach.call(clone.querySelectorAll('span'), function (n) {
      if (/^\d{6}$/.test((n.textContent || '').trim())) n.remove();
    });
    return cleanName(clone.textContent);
  }

  function resolve(el) {
    if (!el) return null;
    var node = el, code = '', market = '';
    for (var i = 0; i < 4 && node; i++, node = node.parentElement) {
      if (!code) {
        var c = node.getAttribute && (node.getAttribute('data-code') || node.getAttribute('data-live-code') || node.getAttribute('data-live'));
        if (/^\d{6}$/.test(c || '')) code = c;
      }
    }
    var oc = el.getAttribute && el.getAttribute('onclick');
    if (!code && oc) {
      var m = /(\d{6})/.exec(oc) || /\(\s*'([^']*\d{6}[^']*)'\s*\)/.exec(oc);
      if (m) { var mm = /(\d{6})/.exec(m[1] || m[0]); if (mm) code = mm[1]; }
    }
    var raw = nameFrom(el);
    if (!code) { var cm = /(\d{6})/.exec(raw || ''); if (cm) code = cm[1]; }
    if (!code && oc) { var om = /'([^']*?)\s*\((\d{6})\)/.exec(oc); if (om) code = om[2]; }
    var name = cleanName(raw);
    if (!name && oc) name = cleanName((/'([^']+)'/.exec(oc) || [])[1]);
    if (!code && name) { var map = codeMap(); if (map[name]) code = map[name]; }
    var mk = el.querySelector ? el.querySelector('.sc-market, .c-mkt') : null;
    if (mk) market = cleanName(String(mk.textContent || '').replace(/\d{6}/, ''));
    if (!name) return null;
    if (!code && !name) return null;
    return { code: code || '', name: name, market: market || '' };
  }

  /* ---------------------------------------------------------- 스타일 */
  function injectCss() {
    if (document.getElementById('wlStyle')) return;
    var css = ''
      + '.wl-host{position:relative}'
      + '.wl-star{display:inline-flex;align-items:center;justify-content:center;gap:2px;flex:0 0 auto;'
      + 'margin-left:auto;padding:1px 5px;border-radius:7px;border:1px solid rgba(148,163,184,.38);'
      + 'background:rgba(2,6,23,.55);color:#7c8ba1;font-size:12.5px;line-height:1.35;cursor:pointer;'
      + 'user-select:none;-webkit-tap-highlight-color:transparent;font-weight:800}'
      + '.wl-star.on{color:#fbbf24;border-color:rgba(251,191,36,.65);background:rgba(120,53,15,.45)}'
      + '.wl-star .wl-dot{width:5px;height:5px;border-radius:50%;background:#f59e0b;display:none}'
      + '.wl-star.has-note .wl-dot{display:inline-block}'
      + '.wl-star:active{transform:scale(.94)}'
      + '.stock-tile .wl-star,.reason-item .wl-star,.manju-item .wl-star,.supply-stock-card .wl-star{font-size:11px;padding:0 3px;border-radius:6px}'
      + '.stock-tile,.stock-tile .st-top,.stock-tile .st-name{min-width:0}'
      + '.stock-tile .st-top{gap:4px}'
      + '.stock-tile .st-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.stock-tile .wl-note-chip,.reason-item .wl-note-chip{display:none}'
      + '.wl-note-chip{display:block;margin-top:4px;font-size:9.5px;color:#fbbf24;font-weight:700;'
      + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.wl-hbtn{position:relative}'
      + '.wl-hbtn .wl-badge{display:inline-block;min-width:16px;margin-left:4px;padding:0 4px;border-radius:9px;'
      + 'background:#f59e0b;color:#1c1917;font-weight:900;font-size:10px}'
      + '.wl-hbtn.on{background:#78350f !important;color:#fde68a !important;border-color:#fbbf24 !important}'
      + 'body.wl-only .stock-tile:not(.wl-on),body.wl-only .supply-stock-card:not(.wl-on),'
      + 'body.wl-only .hi-stock-card:not(.wl-on),body.wl-only article.card:not(.wl-on),'
      + 'body.wl-only .reason-item:not(.wl-on),body.wl-only .manju-item:not(.wl-on),'
      + 'body.wl-only #stockListGrid .stock-card:not(.wl-on){display:none !important}'
      + 'body.wl-only .wl-filter-hint{display:block !important}'
      + '.wl-filter-hint{display:none;position:fixed;left:8px;bottom:10px;z-index:1300;background:#78350f;color:#fde68a;'
      + 'border:1px solid #fbbf24;border-radius:18px;padding:6px 12px;font-size:11px;font-weight:800;box-shadow:0 4px 14px rgba(0,0,0,.45)}'
      + '#wlDrawer{position:fixed;top:0;right:0;height:100%;width:min(392px,94vw);z-index:1500;'
      + 'background:linear-gradient(180deg,#0b1220,#0a0f1a);border-left:1px solid rgba(251,191,36,.35);'
      + 'box-shadow:-12px 0 30px rgba(0,0,0,.55);transform:translateX(102%);transition:transform .22s ease;'
      + 'display:flex;flex-direction:column;font-family:inherit}'
      + '#wlDrawer.open{transform:translateX(0)}'
      + '#wlDrawer .wl-dhead{padding:12px 14px 10px;border-bottom:1px solid rgba(148,163,184,.18)}'
      + '#wlDrawer .wl-dtitle{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13.5px;font-weight:900;color:#fde68a}'
      + '#wlDrawer .wl-dtitle .x{cursor:pointer;color:#94a3b8;font-size:17px;padding:0 4px}'
      + '#wlDrawer .wl-dsub{margin-top:4px;font-size:10.5px;color:#94a3b8;line-height:1.5}'
      + '#wlDrawer .wl-dtools{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}'
      + '#wlDrawer .wl-tool{flex:1 1 auto;padding:6px 8px;border-radius:7px;border:1px solid rgba(148,163,184,.35);'
      + 'background:#0f172a;color:#cbd5e1;font-size:10.5px;font-weight:800;cursor:pointer;text-align:center}'
      + '#wlDrawer .wl-tool.on{background:#78350f;color:#fde68a;border-color:#fbbf24}'
      + '#wlDrawer .wl-dbody{flex:1 1 auto;overflow-y:auto;padding:10px 12px 18px;-webkit-overflow-scrolling:touch}'
      + '#wlDrawer .wl-empty{color:#64748b;font-size:11.5px;line-height:1.7;padding:14px 6px;text-align:center}'
      + '.wl-item{display:block;background:#0f172a;border:1px solid rgba(251,191,36,.28);border-radius:10px;'
      + 'padding:9px 10px;margin-bottom:8px}'
      + '.wl-row1{display:flex;align-items:center;gap:6px}'
      + '.wl-row1 .nm{font-weight:900;font-size:12.5px;color:#f8fafc}'
      + '.wl-row1 .cd{font-size:10px;color:#64748b}'
      + '.wl-row1 .sp{margin-left:auto;display:flex;gap:4px}'
      + '.wl-mini{border:1px solid rgba(148,163,184,.35);background:#111827;color:#cbd5e1;border-radius:6px;'
      + 'font-size:10px;font-weight:800;padding:2px 7px;cursor:pointer}'
      + '.wl-mini.gold{color:#fde68a;border-color:#b45309}'
      + '.wl-mini.red{color:#fca5a5;border-color:#7f1d1d}'
      + '.wl-prices{display:flex;gap:8px;flex-wrap:wrap;margin-top:5px;font-size:10.5px}'
      + '.wl-prices b{font-weight:800}'
      + '.wl-prices .buy b{color:#fda4af}.wl-prices .stop b{color:#7dd3fc}'
      + '.wl-memo{margin-top:5px;font-size:10.5px;color:#cbd5e1;line-height:1.55;white-space:pre-wrap;word-break:break-word}'
      + '#wlEditor{position:fixed;z-index:1600;width:min(320px,92vw);background:#0b1220;border:1px solid #fbbf24;'
      + 'border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.6);padding:11px 12px;display:none}'
      + '#wlEditor.open{display:block}'
      + '#wlEditor .wl-etitle{font-size:12.5px;font-weight:900;color:#fde68a;margin-bottom:7px;display:flex;justify-content:space-between;gap:6px}'
      + '#wlEditor .wl-etitle .x{cursor:pointer;color:#94a3b8;font-size:15px}'
      + '#wlEditor label{display:block;font-size:10px;color:#94a3b8;font-weight:800;margin:6px 0 2px}'
      + '#wlEditor input,#wlEditor textarea{width:100%;box-sizing:border-box;background:#0f172a;color:#e2e8f0;'
      + 'border:1px solid rgba(148,163,184,.4);border-radius:7px;padding:6px 8px;font-size:12px;font-family:inherit}'
      + '#wlEditor textarea{min-height:58px;resize:vertical}'
      + '#wlEditor .wl-eacts{display:flex;gap:6px;margin-top:9px}'
      + '#wlEditor .wl-ebtn{flex:1 1 auto;padding:7px;border-radius:8px;font-size:11.5px;font-weight:900;cursor:pointer;border:1px solid}'
      + '#wlEditor .save{background:#78350f;border-color:#fbbf24;color:#fde68a}'
      + '#wlEditor .un{background:#1e293b;border-color:rgba(148,163,184,.4);color:#cbd5e1}'
      + '#wlEditor .cancel{background:#111827;border-color:rgba(148,163,184,.3);color:#94a3b8}'
      + '.wl-modal-bar{margin:0 0 10px;padding:8px 10px;border:1px solid rgba(251,191,36,.35);border-radius:9px;'
      + 'background:rgba(120,53,15,.16);font-size:11px}'
      + '.wl-modal-bar .wl-row1{gap:6px;flex-wrap:wrap}'
      + '.wl-modal-bar .wl-memo{color:#fde68a}'
      + '@media (max-width:520px){.wl-star{font-size:12px;padding:1px 4px}'
      + '#wlEditor{left:6px !important;right:6px !important;width:auto !important;top:auto !important;bottom:8px}}';
    var st = document.createElement('style');
    st.id = 'wlStyle';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------------------------------------------------------- 별 붙이기 */
  var SELECTORS = ['.stock-tile', '.supply-stock-card', '.hi-stock-card', 'article.card[data-code]',
                   '.reason-item', '.manju-item', '#stockListGrid .stock-card'];
  var HEAD = '.sc-top, .c-head, .st-top, .ssc-top, .ri-head, .card-top, .mi-head';

  function mount(el) {
    if (!el || el.__wl) return;
    if (el.closest('#wlDrawer, #wlEditor, .modal-overlay, .hi-modal-overlay, .hi-modal-content, #modalOverlay')) return;
    var meta = resolve(el);
    if (!meta || !meta.name) return;
    if (!meta.code && !meta.name) return;
    /* 만쥬 타임라인·뉴스처럼 종목이 아닌 카드에는 달지 않는다 */
    if (!meta.code && !(el.classList.contains('stock-tile') || el.classList.contains('supply-stock-card') ||
        el.classList.contains('hi-stock-card') || el.classList.contains('reason-item'))) return;
    el.__wl = meta;
    el.classList.add('wl-host');
    var host = el.querySelector(HEAD) || el;
    var b = document.createElement('span');
    b.className = 'wl-star';
    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');
    b.setAttribute('data-wl', '1');
    b.title = '★ 관심종목 (매수·손절·메모)';
    b.innerHTML = '<i class="wl-ico">☆</i><i class="wl-dot"></i>';
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onStarClick(e, meta, el); });
    b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    b.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    b.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onStarClick(e, meta, el); }
    });
    host.appendChild(b);
    paintStar(meta, el);
  }

  function paintStar(meta, el) {
    var key = keyOf(meta.code, meta.name);
    var it = live(key);
    var b = el.querySelector(':scope > .wl-star') || el.querySelector('.wl-star');
    if (!b) return;
    var ico = b.querySelector('.wl-ico');
    if (ico) ico.textContent = it ? '★' : '☆';
    b.classList.toggle('on', !!it);
    b.classList.toggle('has-note', !!(it && (it.buy || it.stop || it.memo)));
    el.classList.toggle('wl-on', !!it);
    var wide = el.matches && el.matches('article.card, .hi-stock-card');
    var chip = el.querySelector('.wl-note-chip');
    var txt = (it && wide) ? [it.buy ? '매수 ' + it.buy : '', it.stop ? '손절 ' + it.stop : '', it.memo || '']
      .filter(Boolean).join(' · ') : '';
    if (txt) {
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'wl-note-chip';
        chip.setAttribute('data-wl', '1');
        el.appendChild(chip);
      }
      chip.textContent = '★ ' + txt;
      chip.title = txt;
    } else if (chip) {
      chip.remove();
    }
  }

  function scan(root) {
    injectCss();
    var scope = root && root.querySelectorAll ? root : document;
    SELECTORS.forEach(function (sel) {
      if (scope.matches && scope.matches(sel)) mount(scope);
      scope.querySelectorAll(sel).forEach(mount);
    });
  }

  function refreshUI() {
    /* 붙어 있는 별을 새 상태로 다시 칠한다 (Hot-Swap·재렌더 뒤에도) */
    SELECTORS.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        if (!el.__wl) return;
        var meta = resolve(el) || el.__wl;
        el.__wl = meta;
        paintStar(meta, el);
      });
    });
    document.querySelectorAll('.wl-hbtn').forEach(function (hb) {
      var n = count();
      var badge = hb.querySelector('.wl-badge');
      if (badge) badge.textContent = n;
      hb.classList.toggle('on', S.onlyMine);
    });
    document.body.classList.toggle('wl-only', S.onlyMine);
    renderDrawer();
    renderModalBar();
  }

  /* ---------------------------------------------------------- 편집기 */
  var ED = { meta: null, el: null };
  function editorEl() {
    var d = document.getElementById('wlEditor');
    if (d) return d;
    d = document.createElement('div');
    d.id = 'wlEditor';
    d.innerHTML = ''
      + '<div class="wl-etitle"><span id="wlETitle">★ 관심종목</span><span class="x" id="wlEX">✕</span></div>'
      + '<label>매수 희망가</label><input id="wlEBuy" inputmode="numeric" placeholder="예: 91,000">'
      + '<label>손절가</label><input id="wlEStop" inputmode="numeric" placeholder="예: 88,000">'
      + '<label>메모 (재료·타점·수급 등)</label><textarea id="wlEMemo" placeholder="예: 120일 전고점 돌파 · 대금 189억 · 11/16 눌림 대기"></textarea>'
      + '<div class="wl-eacts"><button class="wl-ebtn save" id="wlESave">저장</button>'
      + '<button class="wl-ebtn un" id="wlEUn">★ 해제</button>'
      + '<button class="wl-ebtn cancel" id="wlECancel">닫기</button></div>';
    document.body.appendChild(d);
    d.querySelector('#wlEX').addEventListener('click', closeEditor);
    d.querySelector('#wlECancel').addEventListener('click', closeEditor);
    d.querySelector('#wlESave').addEventListener('click', saveEditor);
    d.querySelector('#wlEUn').addEventListener('click', function () {
      if (ED.meta) remove(ED.meta);
      closeEditor();
    });
    d.addEventListener('click', function (e) { e.stopPropagation(); });
    return d;
  }
  function openEditor(meta, el) {
    ED.meta = meta; ED.el = el || null;
    var d = editorEl();
    var key = keyOf(meta.code, meta.name);
    var it = live(key) || {};
    d.querySelector('#wlETitle').textContent = '★ ' + meta.name + (meta.code ? ' (' + meta.code + ')' : '');
    d.querySelector('#wlEBuy').value = it.buy || '';
    d.querySelector('#wlEStop').value = it.stop || '';
    d.querySelector('#wlEMemo').value = it.memo || '';
    d.classList.add('open');
    var w = Math.min(320, window.innerWidth - 24);
    var h = d.offsetHeight || 268;
    var left, top;
    var r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (r && window.innerWidth > 520) {
      left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
      top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = r.top - h - 8;      /* 아래가 모자라면 카드 위로 */
      top = Math.max(8, Math.min(window.innerHeight - h - 8, top));
    } else {
      left = Math.max(8, (window.innerWidth - w) / 2);
      top = Math.max(8, window.innerHeight - h - 8);
    }
    d.style.left = left + 'px';
    d.style.top = top + 'px';
    setTimeout(function () { var f = d.querySelector('#wlEBuy'); if (f && window.innerWidth > 520) f.focus(); }, 60);
  }
  function closeEditor() {
    var d = document.getElementById('wlEditor');
    if (d) d.classList.remove('open');
    ED.meta = null; ED.el = null;
  }
  function saveEditor() {
    if (!ED.meta) return;
    var d = editorEl();
    var buy = d.querySelector('#wlEBuy').value.trim();
    var stop = d.querySelector('#wlEStop').value.trim();
    var memo = d.querySelector('#wlEMemo').value.trim();
    upsert(ED.meta, { buy: buy, stop: stop, memo: memo });
    closeEditor();
  }

  function onStarClick(e, meta, el) {
    var key = keyOf(meta.code, meta.name);
    if (live(key)) openEditor(meta, el);
    else {
      upsert(meta, { buy: '', stop: '', memo: '' });
      openEditor(meta, el);          /* 별을 찍으면 바로 매수·손절·메모를 적게 한다 */
    }
  }

  /* ---------------------------------------------------------- 드로어 */
  function drawerEl() {
    var d = document.getElementById('wlDrawer');
    if (d) return d;
    d = document.createElement('div');
    d.id = 'wlDrawer';
    d.innerHTML = ''
      + '<div class="wl-dhead">'
      + '<div class="wl-dtitle"><span>★ 내 관심종목 <span id="wlDCount" style="color:#fbbf24"></span></span>'
      + '<span class="x" id="wlDX" role="button" aria-label="닫기">✕</span></div>'
      + '<div class="wl-dsub" id="wlDSub">매수·손절가와 메모를 남겨 두면 폰·PC 어디서든 같이 보입니다.</div>'
      + '<div class="wl-dtools">'
      + '<button class="wl-tool" id="wlDFilter">★만 보기</button>'
      + '<button class="wl-tool" id="wlDSync">☁️ 지금 동기화</button>'
      + '<button class="wl-tool" id="wlDClearOnly" style="display:none">필터 해제</button>'
      + '</div></div>'
      + '<div class="wl-dbody" id="wlDBody"></div>';
    document.body.appendChild(d);
    d.querySelector('#wlDX').addEventListener('click', closeDrawer);
    d.querySelector('#wlDFilter').addEventListener('click', function () {
      S.onlyMine = !S.onlyMine;
      saveMetaOnly();
      refreshUI();
    });
    d.querySelector('#wlDSync').addEventListener('click', function () {
      pullNow(0).then(function () { pushNow(); });
    });
    d.addEventListener('click', function (e) { e.stopPropagation(); });
    return d;
  }
  function saveMetaOnly() { var m = metaLoad(); m.onlyMine = !!S.onlyMine; metaSave(m); }
  function openDrawer() {
    var d = drawerEl();
    d.classList.add('open');
    renderDrawer();
  }
  function closeDrawer() {
    var d = document.getElementById('wlDrawer');
    if (d) d.classList.remove('open');
  }
  function renderDrawer() {
    var d = document.getElementById('wlDrawer');
    if (!d) return;
    var c = d.querySelector('#wlDCount');
    if (c) c.textContent = count() ? '(' + count() + ')' : '';
    var f = d.querySelector('#wlDFilter');
    if (f) f.classList.toggle('on', S.onlyMine);
    var body = d.querySelector('#wlDBody');
    if (!body) return;
    var items = list();
    if (!items.length) {
      body.innerHTML = '<div class="wl-empty">아직 ★ 한 종목이 없습니다.<br>종목 카드 오른쪽의 <b style="color:#fbbf24">☆</b> 를 누르면<br>매수·손절가와 메모를 적을 수 있습니다.</div>';
      return;
    }
    body.innerHTML = items.map(function (it) {
      var key = keyOf(it.code, it.name);
      return '<div class="wl-item" data-key="' + esc(key) + '">'
        + '<div class="wl-row1"><span class="nm">' + esc(it.name) + '</span>'
        + '<span class="cd">' + esc(it.code || '') + '</span>'
        + '<span class="sp">'
        + '<button class="wl-mini" data-act="edit">수정</button>'
        + '<button class="wl-mini gold" data-act="chart">차트</button>'
        + '<button class="wl-mini red" data-act="del">해제</button>'
        + '</span></div>'
        + ((it.buy || it.stop) ? '<div class="wl-prices">'
          + (it.buy ? '<span class="buy">매수 <b>' + esc(it.buy) + '</b></span>' : '')
          + (it.stop ? '<span class="stop">손절 <b>' + esc(it.stop) + '</b></span>' : '') + '</div>' : '')
        + (it.memo ? '<div class="wl-memo">' + esc(it.memo) + '</div>' : '')
        + '</div>';
    }).join('');
    body.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var wrap = b.closest('.wl-item');
        var key = wrap && wrap.getAttribute('data-key');
        var it = key ? S.items[key] : null;
        if (!it) return;
        var meta = { code: it.code, name: it.name, market: it.market };
        var act = b.getAttribute('data-act');
        if (act === 'del') remove(meta);
        else if (act === 'edit') openEditor(meta, null);
        else if (act === 'chart') openChartFor(it);
      });
    });
  }

  function openChartFor(it) {
    try {
      if (it.code && window.HonginkiTab && typeof window.HonginkiTab.openChart === 'function') {
        var hasHi = document.querySelector('#tabHonginki');
        if (hasHi) { window.HonginkiTab.openChart(it.code); return; }
      }
      if (it.code && window.LiveAPI && typeof window.LiveAPI.openStock === 'function') {
        window.LiveAPI.openStock(it.code); return;
      }
      if (it.code && window.tabsLiveOpenStock) { window.tabsLiveOpenStock(it.name, it.code); return; }
      if (typeof window.openDetail === 'function') {
        window.openDetail(it.name + (it.code ? ' (' + it.code + ')' : ''), '', '', '★ 관심종목');
      }
    } catch (e) { /* */ }
  }

  /* ---------------------------------------------------------- 종목 모달 바 (공통·홍인기·비중법사) */
  var MODALS = [
    { ov: '#modalOverlay', title: '#modalTitle', body: '.modal-body', sub: '' },
    { ov: '#hiChartModal', title: '#hiCmTitle', body: '.hi-modal-body', sub: '#hiCmSub' },
    { ov: '#chartModal', title: '#cmTitle', body: '.modal-body', sub: '' }
  ];
  function visible(el) {
    if (!el) return false;
    var st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  function modalMeta(spec) {
    var tEl = document.querySelector(spec.title);
    if (!tEl) return null;
    var txt = (tEl.textContent || '').trim();
    var sub = spec.sub ? ((document.querySelector(spec.sub) || {}).textContent || '') : '';
    var cm = /(\d{6})/.exec(txt + ' ' + sub);
    var nm = cleanName(txt.replace(/^[📈🎯📊\s]+/, '').split('·')[0].split('—')[0]);
    if (!nm && !cm) return null;
    return { code: cm ? cm[1] : (codeMap()[nm] || ''), name: nm, market: '' };
  }
  function renderModalBar() {
    MODALS.forEach(function (spec) {
      var ov = document.querySelector(spec.ov);
      var body = ov ? ov.querySelector(spec.body) : null;
      if (!body) return;
      var bar = body.querySelector('.wl-modal-bar');
      if (!visible(ov)) { if (bar) bar.remove(); return; }
      var meta = modalMeta(spec);
      if (!meta || !meta.name) { if (bar) bar.remove(); return; }
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'wl-modal-bar';
        body.insertBefore(bar, body.firstChild);
      }
      var key = keyOf(meta.code, meta.name);
      var it = live(key);
      var note = it ? [it.buy ? '매수 ' + it.buy : '', it.stop ? '손절 ' + it.stop : '', it.memo || '']
        .filter(Boolean).join(' · ') : '';
      var label = '★ ' + esc(meta.name) + (meta.code ? ' <span class="cd">' + esc(meta.code) + '</span>' : '');
      bar.innerHTML = '<div class="wl-row1"><span class="nm" style="color:#fde68a">' + label + '</span>'
        + '<span class="sp"><button class="wl-mini gold" data-wl-act="toggle">'
        + (it ? '★ 메모 수정' : '☆ 관심종목 담기') + '</button></span></div>'
        + (note ? '<div class="wl-memo">' + esc(note) + '</div>' : '');
      var btn = bar.querySelector('[data-wl-act]');
      if (btn) btn.addEventListener('click', function (e) { e.stopPropagation(); openEditor(meta, bar); });
    });
  }

  function renderSyncBar() {
    var d = document.getElementById('wlDrawer');
    if (!d) return;
    var sub = d.querySelector('#wlDSub');
    if (!sub) return;
    var txt;
    if (S.status === 'ok') txt = '☁️ 폰·PC 동기화됨' + (S.lastSync ? ' · ' + new Date(S.lastSync).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '');
    else if (S.status === 'syncing') txt = '☁️ 동기화 중…';
    else if (S.status === 'error') txt = '⚠️ 동기화 실패 — 이 기기에 저장됨 (' + esc(S.msg).slice(0, 60) + ')';
    else txt = '이 기기에 저장됨 · 클라우드 연결 대기';
    sub.textContent = txt + ' · 매수·손절가와 메모를 남겨 두면 어디서든 같이 보입니다.';
  }

  /* ---------------------------------------------------------- 헤더 버튼 */
  function mountHeader() {
    if (document.getElementById('wlHdrBtn')) return;
    var host = document.querySelector('.header-actions');
    if (!host) return;
    var b = document.createElement('button');
    b.id = 'wlHdrBtn';
    b.className = 'btn-action wl-hbtn';
    b.style.cssText = 'background:#2a2113; color:#fde68a; border-color:#f59e0b; font-weight:800; cursor:pointer;';
    b.innerHTML = '★ 관심종목<span class="wl-badge">0</span>';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      var d = document.getElementById('wlDrawer');
      if (d && d.classList.contains('open')) closeDrawer(); else openDrawer();
    });
    host.insertBefore(b, host.firstChild);
    var hint = document.createElement('div');
    hint.className = 'wl-filter-hint';
    hint.setAttribute('data-wl', '1');
    hint.textContent = '★ 관심종목만 보는 중 — 눌러서 해제';
    hint.addEventListener('click', function () { S.onlyMine = false; saveMetaOnly(); refreshUI(); });
    document.body.appendChild(hint);
  }

  /* ---------------------------------------------------------- 부트 */
  function boot() {
    injectCss();
    loadLocal();
    var m = metaLoad();
    if (m && typeof m.onlyMine === 'boolean') S.onlyMine = m.onlyMine;
    mountHeader();
    scan(document);
    refreshUI();
    setStatus('idle');
    pullNow(0).then(function () { refreshUI(); });

    /* 카드가 새로 그려질 때마다(탭 전환·Hot-Swap·필터) 별을 다시 붙인다 */
    var t = null;
    var obs = new MutationObserver(function (muts) {
      var hit = false;
      for (var i = 0; i < muts.length && !hit; i++) {
        var tgt = muts[i].target;
        if (tgt && tgt.closest && tgt.closest('#wlDrawer, #wlEditor')) continue;
        if (muts[i].type === 'childList' && muts[i].addedNodes && muts[i].addedNodes.length) hit = true;
      }
      if (!hit) return;
      if (t) clearTimeout(t);
      t = setTimeout(function () { scan(document); refreshUI(); }, 220);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    /* 모달 열림/닫힘 감시 */
    var mo = new MutationObserver(function () { renderModalBar(); });
    ['#modalOverlay', '#hiChartModal', '#chartModal'].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) mo.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    });
    ['#modalTitle', '#hiCmTitle', '#cmTitle'].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) mo.observe(el, { childList: true, characterData: true, subtree: true });
    });

    /* 주기적 클라우드 맞춤 */
    setInterval(function () {
      if (document.visibilityState === 'visible') pullNow(0);
    }, 60000);
    window.addEventListener('online', function () { pullNow(0); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') pullNow(0);
    });
    document.addEventListener('click', function (e) {
      var ed = document.getElementById('wlEditor');
      if (!ed || !ed.classList.contains('open')) return;
      var t = e.target;
      if (t && t.closest && t.closest('#wlEditor, .wl-star, .wl-modal-bar')) return;
      if (t && t.closest && t.closest('#wlDrawer')) return;
      closeEditor();
    }, true);
    window.addEventListener('beforeunload', function () { if (S.at) saveLocal(false); });
  }

  window.StockWatch = {
    version: VERSION,
    toggle: function (meta, patch) {
      var key = keyOf(meta.code, meta.name);
      if (live(key)) remove(meta); else upsert(meta, patch || {});
    },
    note: function (meta, patch) { upsert(meta, patch); },
    isWatched: function (code, name) { return watched(keyOf(code, name)); },
    get: function (code, name) { return live(keyOf(code, name)) || null; },
    list: list,
    open: openDrawer,
    close: closeDrawer,
    onlyMine: function (v) { S.onlyMine = v !== false; saveMetaOnly(); refreshUI(); },
    sync: function () { return pullNow(0).then(pushNow); },
    state: function () { return { count: count(), status: S.status, msg: S.msg, items: S.items, onlyMine: S.onlyMine }; },
    rescan: function () { scan(document); refreshUI(); },
    KEY: LS,
    CLOUD_CODE: SUP.code
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
