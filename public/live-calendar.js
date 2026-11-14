/* ============================================================================
 * 📅 9번 탭(증시 일정) 달력 — 만기일 규칙 자동 계산 + '오늘' 표시 자동 정정
 * ----------------------------------------------------------------------------
 *  규칙 (KRX 파생상품 만기)
 *   · 옵션만기일            = 매월 둘째 목요일
 *   · 선물·옵션 동시만기일  = 3·6·9·12월의 둘째 목요일
 *
 *  하는 일
 *   1) 달력 칸마다 실제 날짜(data-cal-date)를 붙인다 (월 제목에서 연·월을 읽는다)
 *      · 화면의 월 제목이 이번 달과 다르면(예: 11월 고정 → 12월) 그리드를 이번 달로 다시 그린다
 *        — 12월이 되어도 '오늘' 강조·만기 배지가 정상 동작하도록 (2026-11-14 추가)
 *   2) '오늘' 칸 강조를 실제 오늘(KST)로 옮긴다 — 날짜가 바뀌어도 굳지 않는다
 *   3) 만기일 칸에 옵션만기 / ★선물·옵션 동시만기 배지를 붙이고 (종료 · D-DAY · D-N) 상태를 계산
 *   4) 다가오는 만기일 3건을 규칙과 함께 보여준다
 *
 *  · 값을 모르면 아무것도 바꾸지 않는다(기존 정적 표시 유지).
 *  · 달력 월(연·월)은 화면의 "YYYY년 M월" 제목에서 읽으므로 달을 넘겨도 규칙이 그대로 동작한다.
 * ==========================================================================*/
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  var HAS_DOM = typeof document !== 'undefined';
  var WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
  var SIMULTANEOUS_MONTHS = [3, 6, 9, 12];

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /* ------------------------------- 순수 계산 ------------------------------- */

  /** year년 month월(1~12)의 n번째 weekday(0=일 … 4=목) 날짜(일) */
  function nthWeekdayOfMonth(year, month, weekday, n) {
    var first = new Date(Date.UTC(year, month - 1, 1));
    var firstWd = first.getUTCDay();
    var day = 1 + ((weekday - firstWd + 7) % 7) + (n - 1) * 7;
    return day;
  }

  /** 그 달의 만기일 — 둘째 목요일 / 3·6·9·12월은 선물·옵션 동시만기 */
  function expiryOfMonth(year, month) {
    var day = nthWeekdayOfMonth(year, month, 4, 2);
    var simultaneous = SIMULTANEOUS_MONTHS.indexOf(month) >= 0;
    return {
      year: year,
      month: month,
      day: day,
      date: year + '-' + pad2(month) + '-' + pad2(day),
      weekday: '목',
      simultaneous: simultaneous,
      kind: simultaneous ? '선물·옵션 동시만기' : '옵션만기',
    };
  }

  /** 그 달에 만기일이 있는지 (둘째 목요일이 그 달 안에 있는지) */
  function isValidExpiry(e) {
    var len = new Date(Date.UTC(e.year, e.month, 0)).getUTCDate();
    return e.day >= 1 && e.day <= len;
  }

  /** fromDate(YYYY-MM-DD) 이후 만기일 count건 (오늘 포함) */
  function nextExpiries(fromDate, count) {
    var m = String(fromDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return [];
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var from = fromDate;
    var out = [];
    var limit = count || 3;
    var guard = 0;
    while (out.length < limit && guard < 60) {
      guard += 1;
      var e = expiryOfMonth(y, mo);
      if (isValidExpiry(e) && e.date >= from) out.push(e);
      mo += 1;
      if (mo > 12) {
        mo = 1;
        y += 1;
      }
    }
    return out;
  }

  function daysBetween(aDate, bDate) {
    var a = Date.parse(aDate + 'T00:00:00Z');
    var b = Date.parse(bDate + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.round((a - b) / 86400000);
  }

  /** 오늘 기준 상태 문구 — 종료 / 오늘(D-DAY) / D-N */
  function expiryState(expiryDate, today) {
    var d = daysBetween(expiryDate, today);
    if (d === null) return { state: 'unknown', label: '' };
    if (d < 0) return { state: 'past', label: '종료', days: d };
    if (d === 0) return { state: 'today', label: '오늘 D-DAY', days: 0 };
    return { state: 'upcoming', label: 'D-' + d, days: d };
  }

  function formatDateLabel(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return iso || '';
    return m[1] + '/' + m[2] + '/' + m[3];
  }

  /* ------------------------------ 월 그리드 ------------------------------ */

  var EN_MONTH = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  /** 그 달 1일의 요일 (0=일 … 6=토) */
  function firstWeekday(year, month) {
    return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  }

  /**
   * 이번 달 그리드 HTML — 앞뒤 빈 칸은 'other-month' 로 채워 7열을 맞춘다.
   * 값 비교가 아니라 계산으로만 만든다(가짜 일정 배지를 새로 만들지 않는다).
   */
  function buildMonthCells(year, month) {
    var lead = firstWeekday(year, month);
    var total = daysInMonth(year, month);
    var prevMonth = month - 1 < 1 ? 12 : month - 1;
    var prevYear = month - 1 < 1 ? year - 1 : year;
    var prevDays = daysInMonth(prevYear, prevMonth);
    var cells = [];
    var week = 1;
    var i;

    for (i = lead - 1; i >= 0; i -= 1) {
      cells.push({ other: true, day: prevDays - i, week: week });
      if ((cells.length % 7) === 0) week += 1;
    }
    for (i = 1; i <= total; i += 1) {
      var wd = (lead + i - 1) % 7;
      cells.push({
        other: false,
        day: i,
        week: week,
        weekday: wd,
        iso: year + '-' + pad2(month) + '-' + pad2(i),
      });
      if ((cells.length % 7) === 0) week += 1;
    }
    // 마지막 주를 7칸으로 채운다
    var tail = 1;
    while (cells.length % 7 !== 0) {
      cells.push({ other: true, day: tail, week: week });
      tail += 1;
    }
    return cells;
  }

  function cellsToHtml(cells) {
    return cells
      .map(function (c) {
        if (c.other) {
          return '<div class="cal-cell other-month" onclick="selectCalWeek(' + c.week + ')">' +
            '<span class="cal-date-num">' + c.day + '</span></div>';
        }
        var color = c.weekday === 0 ? ' style="color:#f87171;"' : c.weekday === 6 ? ' style="color:#60a5fa;"' : '';
        return '<div class="cal-cell" data-cal-date="' + c.iso + '" onclick="selectCalWeek(' + c.week + ')">' +
          '<span class="cal-date-num"' + color + '>' + c.day + '</span></div>';
      })
      .join('');
  }

  /**
   * 화면 달력이 이번 달이 아니면 이번 달로 다시 그린다.
   *  · 정적 그리드가 이미 이번 달이면 아무것도 바꾸지 않는다(기존 표시 유지).
   *  · 주간 확대 뷰는 11월 정적 자료라 다른 달에서는 숨기고 그 사실을 알린다.
   */
  function ensureMonth(doc, today) {
    if (!doc) return 0;
    var grid = doc.querySelector('#tabCalendar .cal-grid');
    var titleEl = doc.querySelector('#tabCalendar .cal-title');
    if (!grid || !titleEl) return 0;
    var t = today || kstToday();
    var y = Number(t.date.slice(0, 4));
    var m = Number(t.date.slice(5, 7));
    var stamp = y + '-' + pad2(m);
    if (grid.getAttribute('data-cal-month') === stamp) return 0;

    var base = readBaseMonth(doc);
    if (base && base.year === y && base.month === m) {
      grid.setAttribute('data-cal-month', stamp);
      return 0;
    }

    var cells = buildMonthCells(y, m);
    grid.innerHTML = cellsToHtml(cells);
    grid.setAttribute('data-cal-month', stamp);
    grid.setAttribute('data-live', '1');

    var title = '🗓️ ' + y + '년 ' + m + '월 (' + EN_MONTH[m - 1] + ' ' + y + ')';
    if (titleEl.textContent !== title) titleEl.textContent = title;
    var panelTitle = doc.getElementById('calPanelTitle');
    if (panelTitle) {
      var pt = '📅 ' + y + '년 ' + m + '월 주요 증시 일정 & 주간 확대 뷰';
      if (panelTitle.textContent !== pt) panelTitle.textContent = pt;
    }

    // 주간 확대 뷰(정적 11월 자료)는 다른 달에서 숨긴다
    var zoom = doc.getElementById('weeklyZoomContainer');
    if (zoom) {
      zoom.style.display = 'none';
      var note = doc.getElementById('calMonthNote');
      if (!note && zoom.parentNode) {
        note = doc.createElement('div');
        note.id = 'calMonthNote';
        note.style.cssText = 'font-size:10.5px; color:#94a3b8; background:rgba(148,163,184,0.08); ' +
          'border:1px dashed rgba(148,163,184,0.3); border-radius:6px; padding:7px 9px; margin-top:8px; line-height:1.5;';
        zoom.parentNode.insertBefore(note, zoom);
      }
      if (note) {
        note.textContent = '※ 주간 확대 뷰(주차별 상세 일정)는 11월 정적 자료라 ' + m + '월에는 표시하지 않습니다. ' +
          '만기일(둘째 목요일)과 오늘 위치는 계산값으로 정상 표시됩니다.';
      }
    }
    return 1;
  }

  /* -------------------------------- DOM 반영 -------------------------------- */

  function kstToday() {
    // KST 고정 (기기 시간대와 무관)
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    }).formatToParts(new Date());
    var g = function (t) {
      return (parts.find(function (p) {
        return p.type === t;
      }) || {}).value || '';
    };
    return {
      date: g('year') + '-' + g('month') + '-' + g('day'),
      month: Number(g('month')),
      day: Number(g('day')),
      weekday: g('weekday'),
      weekdayKo: WEEKDAY_KO[new Date(Date.UTC(Number(g('year')), Number(g('month')) - 1, Number(g('day')))).getUTCDay()],
    };
  }

  /** 달력 제목("🗓️ 2026년 11월 …")에서 연·월을 읽는다 */
  function readBaseMonth(doc) {
    var el = doc.querySelector('#tabCalendar .cal-title');
    var text = el ? el.textContent || '' : '';
    var m = text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월/);
    if (!m) return null;
    return { year: Number(m[1]), month: Number(m[2]) };
  }

  function ensureBadge(doc, cell, cls, text) {
    var badges = Array.prototype.slice.call(cell.querySelectorAll('.cal-badge'));
    var found = null;
    for (var i = 0; i < badges.length; i += 1) {
      if (/만기/.test(badges[i].textContent || '')) {
        found = badges[i];
        break;
      }
    }
    if (!found) {
      found = doc.createElement('span');
      found.className = 'cal-badge ' + cls;
      cell.appendChild(found);
    }
    if ((found.textContent || '') !== text) found.textContent = text;
    found.setAttribute('data-live', '1');
    found.setAttribute('title', '매월 둘째 목요일 = 옵션만기 · 3·6·9·12월 둘째 목요일 = 선물·옵션 동시만기 (KRX 규칙)');
    return found;
  }

  function applyCalendar(doc, today) {
    if (!doc) return 0;
    var t0 = today || kstToday();
    // 달을 넘겼으면 먼저 이번 달 그리드로 다시 그린다
    var remade = ensureMonth(doc, t0);
    var grid = doc.querySelector('#tabCalendar .cal-grid');
    if (!grid) return 0;
    var base = readBaseMonth(doc);
    if (!base) return 0;
    var t = today || kstToday();
    var cells = Array.prototype.slice.call(grid.querySelectorAll('.cal-cell'));
    if (!cells.length) return 0;

    var applied = remade ? 1 : 0;

    // 1) 칸마다 실제 날짜 (시작 = 그 달 1일)
    cells.forEach(function (cell, i) {
      var dt = new Date(Date.UTC(base.year, base.month - 1, 1 + i));
      var numEl = cell.querySelector('.cal-date-num');
      var shown = numEl ? Number(String(numEl.textContent || '').replace(/[^\d]/g, '')) : NaN;
      if (shown !== dt.getUTCDate()) return; // 화면 날짜와 계산이 어긋나면 건드리지 않는다
      var iso = dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
      cell.setAttribute('data-cal-date', iso);
      applied += 1;
    });

    // 2) 오늘 강조 이동
    var todayCell = null;
    cells.forEach(function (cell) {
      var iso = cell.getAttribute('data-cal-date');
      cell.classList.remove('today');
      if (iso === t.date) todayCell = cell;
    });
    cells.forEach(function (cell) {
      if (cell !== todayCell) cell.classList.remove('selected');
    });
    if (todayCell) {
      todayCell.classList.add('today', 'selected');
      applied += 1;
    }

    // 3) 이 달 + 다음 달 만기일 배지
    var monthCell = {};
    cells.forEach(function (cell) {
      var iso = cell.getAttribute('data-cal-date');
      if (iso) monthCell[iso] = cell;
    });
    var checked = 0;
    for (var k = 0; k < 2; k += 1) {
      var mm = base.month + k;
      var yy = base.year;
      if (mm > 12) {
        mm -= 12;
        yy += 1;
      }
      var e = expiryOfMonth(yy, mm);
      var cell = monthCell[e.date];
      if (!cell) continue;
      var st = expiryState(e.date, t.date);
      var label = (e.simultaneous ? '★' : '') + e.kind + (st.label ? ' (' + st.label + ')' : '');
      var badge = ensureBadge(doc, cell, 'opt', label);
      if (e.simultaneous) {
        badge.style.background = '#7f1d1d';
        badge.style.color = '#fecaca';
      } else if (st.state === 'past') {
        badge.style.background = '#374151';
        badge.style.color = '#9ca3af';
      } else {
        badge.style.background = '#854d0e';
        badge.style.color = '#fef08a';
      }
      checked += 1;
      applied += 1;
    }

    // 4) 헤더 '오늘' 문구도 실제 오늘로
    var nav = doc.querySelector('#tabCalendar .cal-month-nav');
    if (nav) {
      var isWeekend = t.weekday === 'Sat' || t.weekday === 'Sun';
      var text = '⭐ 오늘: ' + t.month + '월 ' + t.day + '일(' + t.weekdayKo + ')' + (isWeekend ? ' · 주말 휴장' : '');
      if (nav.textContent !== text) {
        nav.textContent = text;
        nav.setAttribute('data-live', '1');
        applied += 1;
      }
    }

    // 5) 규칙 · 다가오는 만기일 박스
    var host = doc.getElementById('calExpiryRuleBox');
    if (!host) {
      var wrapper = doc.querySelector('#tabCalendar .cal-wrapper');
      if (wrapper && wrapper.parentNode) {
        host = doc.createElement('div');
        host.id = 'calExpiryRuleBox';
        wrapper.parentNode.insertBefore(host, wrapper);
      }
    }
    if (host) {
      var list = nextExpiries(t.date, 3);
      var rows = list
        .map(function (e) {
          var st = expiryState(e.date, t.date);
          var tag = st.state === 'today' ? '🟠 오늘' : 'D-' + st.days;
          return (
            '<div style="display:flex; justify-content:space-between; gap:8px; padding:4px 8px; border-radius:4px; background:' +
            (e.simultaneous ? 'rgba(244,63,94,0.10)' : 'rgba(148,163,184,0.08)') +
            '; margin-bottom:3px;">' +
            '<span style="color:' + (e.simultaneous ? '#fca5a5' : '#cbd5e1') + '; font-weight:800;">' +
            (e.simultaneous ? '★ ' : '') + formatDateLabel(e.date) + '(' + e.weekday + ') ' + e.kind +
            '</span>' +
            '<span style="color:' + (st.state === 'today' ? '#fbbf24' : '#94a3b8') + '; font-weight:800;">' + tag + '</span>' +
            '</div>'
          );
        })
        .join('');
      var html =
        '<div style="background:#111827; border:1px solid #334155; border-left:3px solid #f59e0b; border-radius:8px; padding:9px 11px; margin-bottom:12px;">' +
        '<div style="font-size:12px; font-weight:800; color:#fbbf24; margin-bottom:5px;">📐 만기일 규칙 자동 계산 (KRX)</div>' +
        '<div style="font-size:10.5px; color:#94a3b8; line-height:1.5; margin-bottom:6px;">' +
        '· 옵션만기일 = <strong style="color:#cbd5e1;">매월 둘째 목요일</strong><br>' +
        '· 선물·옵션 동시만기일 = <strong style="color:#fca5a5;">3·6·9·12월 둘째 목요일</strong><br>' +
        '· 위 배지의 (종료 · 오늘 D-DAY · D-N)은 오늘 날짜로 계산한 값입니다.</div>' +
        (rows || '<div style="font-size:10.5px; color:#64748b;">계산 가능한 만기일이 없습니다.</div>') +
        '<div style="font-size:10px; color:#64748b; margin-top:5px;">기준 오늘: ' + t.date + ' (' + t.weekdayKo + ') · 달력 배지도 같은 규칙으로 표시됩니다.</div>' +
        '</div>';
      if (host.getAttribute('data-sig') !== html) {
        host.innerHTML = html;
        host.setAttribute('data-sig', html);
        applied += 1;
      }
      host.setAttribute('data-live', '1');
    }

    return applied;
  }

  function boot() {
    if (!HAS_DOM) return 0;
    try {
      return applyCalendar(document, kstToday());
    } catch (e) {
      return 0;
    }
  }

  var api = {
    nthWeekdayOfMonth: nthWeekdayOfMonth,
    expiryOfMonth: expiryOfMonth,
    nextExpiries: nextExpiries,
    expiryState: expiryState,
    daysBetween: daysBetween,
    isValidExpiry: isValidExpiry,
    formatDateLabel: formatDateLabel,
    readBaseMonth: readBaseMonth,
    applyCalendar: applyCalendar,
    kstToday: kstToday,
    // 2026-11-14 추가: 월 자동 전환
    daysInMonth: daysInMonth,
    firstWeekday: firstWeekday,
    buildMonthCells: buildMonthCells,
    cellsToHtml: cellsToHtml,
    ensureMonth: ensureMonth,
    EN_MONTH: EN_MONTH,
  };

  root.LiveCalendar = api;

  if (HAS_DOM) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
    // 탭을 열 때 · 자정을 넘겼을 때도 다시 계산 (값이 같으면 아무것도 바뀌지 않는다)
    setInterval(function () {
      if (!document.hidden) boot();
    }, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) boot();
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
