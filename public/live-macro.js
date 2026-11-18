/* ============================================================================
 * 🌐 9번 탭 거시·매크로 8종 / 미국 경제일정 · 4번 탭 '지금 이 순간' 카드
 * ----------------------------------------------------------------------------
 *  1) /api/macro-live      → VIX · 미10년 · 달러인덱스 · 금 · 구리 · BTC · 국고3Y · 국고10Y
 *  2) /api/econ-calendar   → ForexFactory 주간 JSON(미국 High/Medium) · KST 변환
 *  3) /api/live-briefing   → 4번 탭 상단 '지금 이 순간(실시간)' 카드
 *  4) 날짜·요일 표기 자동화 → '오늘(금)' 처럼 굳은 요일/기준일 문구를 실제 값으로 다시 쓴다
 *
 *  · API 가 실패하면 기존(정적) 표기를 그대로 두고, 배지에 실패 사실을 적는다(가짜 값 금지).
 *  · 브라우저(main)와 Node 테스트(test_local.mjs)에서 같이 쓰도록 순수 계산 함수를 export 한다.
 * ==========================================================================*/
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  var HAS_DOM = typeof document !== 'undefined';

  var MACRO_URL = '/api/macro-live';
  var ECON_URL = '/api/econ-calendar';
  var BRIEF_URL = '/api/live-briefing';

  var MACRO_MS = 120000;   // 거시 8종 2분
  var ECON_MS = 1800000;   // 경제일정 30분
  var BRIEF_MS = 60000;    // 지금 이 순간 60초

  var WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

  /* ------------------------------- 유틸 ------------------------------- */

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function fmtNum(v, digits) {
    var n = num(v);
    if (n === null) return '—';
    return n.toLocaleString('en-US', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits || 0,
    });
  }

  function fmtPct(p) {
    var n = num(p);
    if (n === null) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function colorOf(p) {
    var n = num(p);
    if (n === null) return '#cbd5e1';
    if (n > 0) return '#f43f5e';
    if (n < 0) return '#38bdf8';
    return '#cbd5e1';
  }

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** KST 현재 시각 정보 (기기 시간대와 무관) */
  function kstNow(date) {
    var d = date instanceof Date ? date : new Date();
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(d);
    var g = function (t) {
      return (parts.find(function (p) {
        return p.type === t;
      }) || {}).value || '';
    };
    var hh = Number(g('hour')) % 24;
    return {
      date: g('year') + '-' + g('month') + '-' + g('day'),
      y: g('year'),
      m: Number(g('month')),
      d: Number(g('day')),
      hh: hh,
      mm: Number(g('minute')),
      wd: g('weekday'),
      weekdayKo: WEEKDAY_KO[new Date(Date.UTC(Number(g('year')), Number(g('month')) - 1, Number(g('day')))).getUTCDay()],
    };
  }

  /** 'M/D(요일)' 표기 */
  function mdLabel(isoDate) {
    var m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    var wd = WEEKDAY_KO[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
    return Number(m[2]) + '/' + Number(m[3]) + '(' + wd + ')';
  }

  /** 4번 탭 '지금 이 순간' 문구 — 정규장 시간대 계산 (정시 브리핑 안내용) */
  function briefingSchedule(now) {
    var t = now || kstNow();
    return {
      isWeekend: t.wd === 'Sat' || t.wd === 'Sun',
      hhmm: (t.hh < 10 ? '0' : '') + t.hh + ':' + (t.mm < 10 ? '0' : '') + t.mm,
      todayLabel: mdLabel(t.date),
      weekdayKo: t.weekdayKo,
    };
  }

  /* --------------------------- 1) 거시 8종 카드 --------------------------- */

  function macroValueText(item) {
    var v = num(item && item.value);
    if (v === null) return '—';
    var digits = typeof item.digits === 'number' ? item.digits : 2;
    var txt = fmtNum(v, digits);
    if (item.unit === '$') return '$' + txt;
    if (item.unit === '%') return txt + '%';
    if (item.unit === '원') return txt + '원';
    return txt + (item.unit ? ' ' + item.unit : '');
  }

  function macroCardHtml(item) {
    var p = num(item.changePct);
    var color = colorOf(p);
    var isPct = item.unit === '%';
    // 금리(%)은 변화폭(bp)이 더 읽기 쉽다
    var delta = isPct && num(item.change) !== null
      ? (num(item.change) > 0 ? '+' : '') + (num(item.change) * 100).toFixed(1) + 'bp'
      : fmtPct(p);
    var basis = item.basis ? String(item.basis) : '';
    var live = item.sessionOpen === true;
    var badgeColor = live ? '#34d399' : '#94a3b8';
    return (
      '<div data-macro-key="' + esc(item.key) + '" data-live="1" title="' + esc(basis + (item.asOfKst ? ' · ' + item.asOfKst + ' KST' : '')) + '" ' +
      'style="background:#0f172a; border:1px solid rgba(56,189,248,0.22); border-radius:6px; padding:8px 10px;">' +
      '<div style="display:flex; justify-content:space-between; align-items:center; gap:4px;">' +
      '<span style="font-size:10.5px; color:#94a3b8; font-weight:800;">' + esc(item.name) + '</span>' +
      '<span style="font-size:9px; color:' + badgeColor + '; font-weight:800;">' + (live ? '● 실시간' : '○ 확정') + '</span>' +
      '</div>' +
      '<div style="font-size:14px; font-weight:800; color:#f1f5f9; margin-top:3px; font-feature-settings:\'tnum\';">' +
      esc(macroValueText(item)) + '</div>' +
      '<div style="font-size:10.5px; font-weight:800; color:' + color + '; font-variant-numeric:tabular-nums;">' +
      esc(delta) + '</div>' +
      '<div style="font-size:9px; color:#64748b; margin-top:2px;">' + esc(item.asOfKst || basis || '') + '</div>' +
      '</div>'
    );
  }

  function renderMacro(body) {
    var grid = document.getElementById('macroLiveGrid');
    var stamp = document.getElementById('macroLiveStamp');
    if (!grid) return 0;
    var items = (body && body.items) || [];
    if (!items.length) return 0;
    var html = items.map(macroCardHtml).join('');
    if (grid.getAttribute('data-sig') !== html) {
      grid.innerHTML = html;
      grid.setAttribute('data-sig', html);
    }
    grid.setAttribute('data-live', '1');
    if (stamp) {
      var okCount = items.filter(function (i) { return i.ok; }).length;
      stamp.textContent = '⚡ ' + (body.generatedAtKst || '') + ' 조회 · ' + okCount + '/' + items.length + '지표';
      stamp.setAttribute('data-live', '1');
    }
    return items.length;
  }

  /* ------------------------- 2) 미국 경제일정 패널 ------------------------- */

  var IMPACT_STYLE = {
    High: { icon: '🔴', color: '#fca5a5', bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.35)' },
    Medium: { icon: '🟡', color: '#fde047', bg: 'rgba(234,179,8,0.10)', border: 'rgba(234,179,8,0.30)' },
    Low: { icon: '⚪', color: '#cbd5e1', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' },
    Holiday: { icon: '🎌', color: '#cbd5e1', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' },
  };

  function econRowHtml(ev) {
    var st = IMPACT_STYLE[ev.impact] || IMPACT_STYLE.Low;
    var past = ev.isPast === true;
    var tag = past ? '<span style="font-size:9px; color:#64748b; font-weight:800;">지난 일정</span>'
      : '<span style="font-size:9px; color:#34d399; font-weight:800;">예정</span>';
    var nums = [];
    if (ev.forecast) nums.push('예상 ' + ev.forecast);
    if (ev.previous) nums.push('이전 ' + ev.previous);
    return (
      '<div data-live="1" style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; ' +
      'background:' + st.bg + '; border:1px solid ' + st.border + '; border-radius:5px; padding:5px 8px;' + (past ? ' opacity:0.62;' : '') + '">' +
      '<div style="min-width:0;">' +
      '<div style="font-size:10.5px; font-weight:800; color:' + st.color + ';">' + st.icon + ' ' + esc(ev.title) + '</div>' +
      '<div style="font-size:9.5px; color:#94a3b8; margin-top:1px;">' + esc(ev.dateLabel) + ' KST · ' + esc(ev.country) + ' · ' + esc(ev.impact) +
      (nums.length ? ' · ' + esc(nums.join(' · ')) : '') + '</div>' +
      '</div>' +
      '<div style="white-space:nowrap;">' + tag + '</div>' +
      '</div>'
    );
  }

  function renderEcon(body) {
    var host = document.getElementById('econCalList');
    var stamp = document.getElementById('econCalStamp');
    if (!host) return 0;
    var items = (body && body.items) || [];
    if (!items.length) {
      if (stamp) stamp.textContent = '⚠️ 미국 경제 일정을 받지 못했습니다 (다음 주기에 재시도)';
      var t0 = document.getElementById('macroSignalNextTitle');
      var n0 = document.getElementById('macroSignalNextNote');
      if (t0) t0.textContent = '🔴 [미국 주요 지표] 일정 조회 실패';
      if (n0) n0.textContent = '경제 일정 피드(ForexFactory)를 받지 못했습니다. 이 카드는 값을 지어내지 않습니다 — 다음 주기에 자동 재시도합니다.';
      return 0;
    }
    // 오늘 일정 → 다가오는 일정(High 우선, 그다음 시각순) 6건
    var today = (body.todayItems || []).slice(0, 3);
    var upcoming = items
      .filter(function (e) { return !e.isPast; })
      .sort(function (a, b) {
        var d = (b.impactRank || 0) - (a.impactRank || 0);
        if (d !== 0) return d;
        return a.eventAt < b.eventAt ? -1 : 1;
      })
      .slice(0, Math.max(2, 6 - today.length));
    var show = today.concat(upcoming);
    if (!show.length) show = items.slice(-6);
    var html = show.map(econRowHtml).join('');
    if (host.getAttribute('data-sig') !== html) {
      host.innerHTML = html;
      host.setAttribute('data-sig', html);
    }
    host.setAttribute('data-live', '1');
    if (stamp) {
      var c = body.counts || {};
      stamp.textContent = '📅 ' + (body.todayLabel || '') + ' · 오늘 ' + (c.today || 0) + '건 · High ' + (c.high || 0) + ' / Medium ' + (c.medium || 0) +
        (body.stale ? ' · 직전 성공본' : '') + ' · ' + ((body && body.sourceLabel) || '출처 미상');
      stamp.setAttribute('data-live', '1');
    }
    applySignalCard(body);
    return show.length;
  }

  /** '거시경제 지표 임팩트 신호등' 첫 카드를 다음 미국 지표로 갱신 ('오늘(금)' 굳은 문구 제거) */
  function applySignalCard(body) {
    var title = document.getElementById('macroSignalNextTitle');
    var note = document.getElementById('macroSignalNextNote');
    var card = document.getElementById('macroSignalNextCard');
    if (!title || !note) return false;
    var items = (body && body.items) || [];
    var next = (body && body.next) || null;
    var today = (body && body.todayItems && body.todayItems[0]) || null;
    // ①다음 High 일정 → ②다음 일정 → ③오늘 High → ④오늘 → ⑤마지막 일정 순으로 고른다.
    var todayHigh = (body && body.todayItems || []).filter(function (e) { return e.impact === 'High'; })[0] || null;
    var ev = (body && body.nextHigh) || next || todayHigh || today || (items.length ? items[items.length - 1] : null);
    if (!ev) {
      title.textContent = '🔴 [미국 주요 지표] 일정 없음';
      note.textContent = '이번 주·다음 주 미국 High/Medium 일정이 피드에 없습니다 — 값을 지어내지 않습니다.';
      return false;
    }
    var st = IMPACT_STYLE[ev.impact] || IMPACT_STYLE.Low;
    var nums = [];
    if (ev.forecast) nums.push('예상 ' + ev.forecast);
    if (ev.previous) nums.push('이전 ' + ev.previous);
    title.textContent = st.icon + ' [' + (ev.impact === 'High' ? '미국 주요 지표' : '미국 지표') + '] ' + ev.title;
    note.textContent = '발표 시각: ' + ev.dateLabel + ' KST' + (nums.length ? ' · ' + nums.join(' · ') : '') +
      (ev.isPast ? ' (지난 일정 · 다음 일정은 피드 공개 시 자동 갱신)' : '') + ' · ' +
      ((body && body.sourceLabel) || '경제 캘린더') + ' 자동 연동' +
      (ev.actual ? ' · 발표치 ' + ev.actual : '');
    if (card) {
      card.style.background = st.bg;
      card.style.borderLeftColor = ev.impact === 'High' ? '#ef4444' : '#eab308';
      card.setAttribute('data-live', '1');
    }
    return true;
  }

  /* --------------------------- 3) '지금 이 순간' 카드 --------------------------- */

  function indexLine(indices) {
    return (indices || [])
      .filter(function (i) { return num(i.price) !== null; })
      .map(function (i) {
        /* 장전(PREOPEN) 미체결이면 지수 등락률이 0.00%로 내려온다.
         *  → 상단 티커에 그려 둔 전일 확정 등락률을 그대로 써서 카드끼리 숫자가 어긋나지 않게 한다. */
        var pct = preopenFlat(i) ? tickerPct(i.name) : num(i.changePct);
        return '<span style="color:#f1f5f9; font-weight:800;">' + esc(i.name) + '</span> ' +
          '<span style="color:' + colorOf(pct) + '; font-weight:800;">' + fmtNum(i.price, 2) +
          (pct === null ? '' : ' (' + fmtPct(pct) + ')') + '</span>';
      })
      .join(' · ');
  }

  /** 장전 미체결 지수 — change·changePct 0 · volume 0 */
  function preopenFlat(i) {
    if (!i) return false;
    if (String(i.status || '').toUpperCase() !== 'PREOPEN') return false;
    if (num(i.change) !== null && i.change !== 0) return false;
    if (num(i.changePct) !== null && i.changePct !== 0) return false;
    return true;
  }

  /** 상단 티커에 현재 그려져 있는 '이름 (x.xx%)' 의 등락률 */
  function tickerPct(name) {
    if (!HAS_DOM || !name) return null;
    var items = document.querySelectorAll('.ticker-bar .ticker-item');
    for (var i = 0; i < items.length; i += 1) {
      var label = items[i].querySelector('.label');
      var val = items[i].querySelector('.val');
      if (!label || !val) continue;
      var lt = String(label.textContent || '').replace(/\s+/g, '');
      if (lt.indexOf(String(name)) < 0) continue;
      /* 코스피/코스닥 이름이 선물·야간선물 타일에 걸리지 않게 */
      if (name.indexOf('코스') === 0 && lt.indexOf('선물') >= 0) continue;
      var m = /\(([+-]?\d+\.\d+)%\)/.exec(String(val.textContent || ''));
      if (m) return Number(m[1]);
    }
    return null;
  }

  function futuresLine(futures) {
    return (futures || [])
      .filter(function (f) { return num(f.price) !== null; })
      .map(function (f) {
        return '<span style="color:#f1f5f9; font-weight:800;">' + esc(f.name) + '</span> ' +
          '<span style="color:' + colorOf(f.changePct) + '; font-weight:800;">' + fmtNum(f.price, 2) + ' (' + fmtPct(f.changePct) + ')</span>';
      })
      .join(' · ');
  }

  function nowCardHtml(body) {
    var out = [];
    var idx = indexLine(body.indices);
    var fut = futuresLine(body.futures);
    var fx = body.fx;
    if (idx) out.push('📊 ' + idx);
    if (fut) out.push('🌙 ' + fut);
    if (fx && num(fx.price) !== null) {
      out.push('💵 <span style="color:#f1f5f9; font-weight:800;">원/달러</span> <span style="color:' + colorOf(fx.changePct) + '; font-weight:800;">' + fmtNum(fx.price, 2) + '원 (' + fmtPct(fx.changePct) + ')</span>');
    }
    var movers = (body.topMovers || []).slice(0, 3);
    if (movers.length) {
      out.push('🔥 급등·대금 상위: ' + movers.map(function (m) {
        return '<span style="color:#f1f5f9; font-weight:700;">' + esc(m.name) + '</span> ' +
          '<span style="color:' + colorOf(m.changePct) + '; font-weight:800;">' + fmtPct(m.changePct) + '</span>' +
          (m.valueText ? ' <span style="color:#94a3b8;">(' + esc(m.valueText) + ')</span>' : '');
      }).join(' · '));
    }
    var basis = body.dataBasis || {};
    var foot = [];
    if (basis.tradingDateLabel) foot.push('시세 기준일 ' + basis.tradingDateLabel);
    if (basis.futuresAsOfKst) foot.push('선물 ' + basis.futuresAsOfKst + ' KST');
    if (body.partial) foot.push('일부 소스 실패');
    if (foot.length) out.push('<div style="font-size:10px; color:#64748b; margin-top:4px;">' + esc(foot.join(' · ')) + '</div>');
    return out.join('<br>') || '<div style="color:#94a3b8;">실시간 값을 받지 못했습니다.</div>';
  }

  function renderNow(body) {
    var host = document.getElementById('nowMomentBody');
    var stamp = document.getElementById('nowMomentStamp');
    if (!host) return 0;
    var html = nowCardHtml(body);
    if (host.getAttribute('data-sig') !== html) {
      host.innerHTML = html;
      host.setAttribute('data-sig', html);
    }
    host.setAttribute('data-live', '1');
    if (stamp) {
      stamp.textContent = '⚡ ' + (body.marketPhaseLabel || body.marketPhase || '') + ' · ' + (body.generatedAtLabel || body.generatedAtKst || '');
      stamp.setAttribute('data-live', '1');
    }
    return 1;
  }

  /* --------------------------- 4) 날짜·요일 자동화 --------------------------- */

  function applyDates(body) {
    var applied = 0;
    var t = kstNow();
    // 4번 탭 타임라인 제목: '직전 거래일' 기준 표기를 실제 값으로
    var td = body && body.dataBasis && body.dataBasis.tradingDate;
    var tdLabel = td ? mdLabel(td) : null;
    var title = document.getElementById('analysisTimelineTitle');
    if (title && tdLabel) {
      var txt = '📊 시간대별 시장 & 수급 심층 분석 (' + tdLabel + ' 정시 타임라인)';
      if (title.textContent !== txt) {
        title.textContent = txt;
        applied += 1;
      }
    }
    var sub = document.getElementById('analysisTimelineSub');
    if (sub && tdLabel) {
      var stxt = '직전 거래일(' + tdLabel + ') 정시 브리핑 전문 스냅샷 · 위의 ⚡ 지금 이 순간 카드가 실시간 값입니다 · 카드 터치 시 전문 팝업';
      if (sub.textContent !== stxt) {
        sub.textContent = stxt;
        applied += 1;
      }
    }
    // 정규 브리핑 안내: 오늘이 주말이면 다음 평일 안내로 바꾼다
    var rt = document.getElementById('remainingBriefingTitle');
    var rx = document.getElementById('remainingBriefingText');
    if (rt && rx) {
      var isWeekend = t.wd === 'Sat' || t.wd === 'Sun';
      var rtitle = isWeekend ? '⏳ 다음 정규 브리핑 안내' : '⏳ 오늘 남은 정규 브리핑 안내';
      var rtext = isWeekend
        ? '오늘(' + mdLabel(t.date) + ')은 주말 휴장입니다. 다음 정규 브리핑은 직전 거래일 종가·주말 뉴스를 정리한 뒤 평일 장전(07:30)부터 타임라인에 자동 등록됩니다.'
        : '오늘(' + mdLabel(t.date) + ') 정규 브리핑은 16:00 장마감 총평 · 17:30/19:00/20:00 애프터마켓 결산 · 22:00/23:59 야간선물 순서로 해당 시각에 타임라인에 자동 등록됩니다.';
      if (rt.textContent !== rtitle) { rt.textContent = rtitle; applied += 1; }
      if (rx.textContent !== rtext) { rx.textContent = rtext; applied += 1; }
    }
    return applied;
  }

  /* ------------------------------- 폴링 ------------------------------- */

  var state = { macro: 0, econ: 0, now: 0, timers: [], busy: {} };

  function getJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      return res.json();
    });
  }

  function loadMacro() {
    if (!HAS_DOM || state.busy.macro) return Promise.resolve(0);
    state.busy.macro = true;
    return getJson(MACRO_URL)
      .then(function (body) {
        state.busy.macro = false;
        if (!body || body.ok !== true) {
          var st = document.getElementById('macroLiveStamp');
          if (st) st.textContent = '⚠️ 거시 지표 조회 실패 (' + ((body && body.message) || '응답 없음') + ')';
          return 0;
        }
        state.macro = renderMacro(body);
        return state.macro;
      })
      .catch(function () {
        state.busy.macro = false;
        var st = document.getElementById('macroLiveStamp');
        if (st) st.textContent = '⚠️ 거시 지표 연결 실패 · 다음 주기에 재시도';
        return 0;
      });
  }

  function loadEcon() {
    if (!HAS_DOM || state.busy.econ) return Promise.resolve(0);
    state.busy.econ = true;
    return getJson(ECON_URL)
      .then(function (body) {
        state.busy.econ = false;
        if (!body || body.ok !== true) {
          var st = document.getElementById('econCalStamp');
          if (st) st.textContent = '⚠️ 경제 일정 조회 실패 · 다음 주기 재시도';
          var t1 = document.getElementById('macroSignalNextTitle');
          var n1 = document.getElementById('macroSignalNextNote');
          if (t1) t1.textContent = '🔴 [미국 주요 지표] 일정 조회 실패';
          if (n1) n1.textContent = '경제 일정 피드(ForexFactory)를 받지 못했습니다(원본 429/네트워크). 값을 지어내지 않고 다음 주기에 자동 재시도합니다.';
          return 0;
        }
        state.econ = renderEcon(body);
        return state.econ;
      })
      .catch(function () {
        state.busy.econ = false;
        var st = document.getElementById('econCalStamp');
        if (st) st.textContent = '⚠️ 경제 일정 연결 실패 · 다음 주기에 재시도';
        return 0;
      });
  }

  function loadNow() {
    if (!HAS_DOM || state.busy.now) return Promise.resolve(0);
    state.busy.now = true;
    return getJson(BRIEF_URL)
      .then(function (body) {
        state.busy.now = false;
        if (!body || body.ok !== true) return 0;
        state.now = renderNow(body);
        applyDates(body);
        return state.now;
      })
      .catch(function () {
        state.busy.now = false;
        return 0;
      });
  }

  function start() {
    if (!HAS_DOM) return;
    var run = function () {
      if (document.hidden) return;
      loadMacro();
      loadNow();
      loadEcon();
    };
    run();
    state.timers.push(setInterval(function () { if (!document.hidden) loadMacro(); }, MACRO_MS));
    state.timers.push(setInterval(function () { if (!document.hidden) loadNow(); }, BRIEF_MS));
    state.timers.push(setInterval(function () { if (!document.hidden) loadEcon(); }, ECON_MS));
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) run();
    });
  }

  var api = {
    kstNow: kstNow,
    mdLabel: mdLabel,
    briefingSchedule: briefingSchedule,
    macroValueText: macroValueText,
    macroCardHtml: macroCardHtml,
    econRowHtml: econRowHtml,
    nowCardHtml: nowCardHtml,
    applyDates: applyDates,
    loadMacro: loadMacro,
    loadEcon: loadEcon,
    loadNow: loadNow,
    start: start,
    state: state,
  };

  root.LiveMacro = api;

  if (HAS_DOM) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
