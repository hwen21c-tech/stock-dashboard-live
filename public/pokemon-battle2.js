/* ============================================================
   포켓몬 배틀 2탄 — 3게임(산수·한글·영어) 공통 확장 모듈
   ─ 타입별 배경 · 파트너 · 공격/피격 모션 · 진화 · 콤보
   ─ 일일 미션 · 오답 복습 · 몬스터볼 · 이로치 · 울음소리 · 타이머 OFF · 랭크
   게임 본체(math/hangul/english-pokemon.html)의 전역 함수를 감싸서(post-hook)
   화면과 저장소만 덧붙인다. 본체 로직·문제 생성은 건드리지 않는다.
   ============================================================ */
(function () {
  'use strict';
  if (window.__PB2_LOADED__) return;
  window.__PB2_LOADED__ = true;
  if (typeof S === 'undefined' || typeof GAME === 'undefined' || typeof Profiles === 'undefined') return;

  /* ---------- 0. 작은 도구 ---------- */
  const q = (s, r) => (r || document).querySelector(s);
  const qa = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const warn = (m, e) => { try { console.warn('[pb2]', m, e || ''); } catch (_) { /* */ } };
  const LSK = {
    partner: (s) => 'pkm.partner.v1.' + s,
    balls: (s) => 'pkm.balls.v1.' + s,
    shiny: (s) => 'pkm.shiny.v1.' + s,
    mission: (s) => 'pkm.mission.v1.' + s,
    buff: (s) => 'pkm.buff.v1.' + s,
    timer: (s) => 'pkm.timer.v1.' + s,
  };
  function lsGet(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* */ }
  }
  function slotId() {
    try { return slotFor(GAME, Profiles.data.active) || 'p1'; } catch (e) { return 'p1'; }
  }
  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  const ART2 = (id) => 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/' + id + '.png';
  const SHINY_ART = (id) => 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/shiny/' + id + '.png';
  const SHINY_SPR = (id) => 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/' + id + '.png';
  const CRY = (id) => 'https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest/' + id + '.ogg';

  /* ---------- 1. 타입 → 배경 테마 ---------- */
  const THEME_OF = {
    물: 'lake', 얼음: 'lake',
    불꽃: 'volcano', 드래곤: 'volcano',
    전기: 'power', 강철: 'power',
    에스퍼: 'ruins', 고스트: 'ruins', 악: 'ruins',
    바위: 'canyon', 땅: 'canyon', 격투: 'canyon',
    비행: 'sky', 페어리: 'sky',
    풀: 'forest', 벌레: 'forest', 독: 'forest', 노말: 'forest',
  };
  const THEME_NAME = {
    lake: '에메랄드 호수', volcano: '붉은 화산', power: '밤하늘 발전소',
    ruins: '보랏빛 유적', canyon: '황토 협곡', sky: '구름 꽃밭', forest: '상록수 숲',
  };
  function themeFor(p) {
    const t = (p && p.types && p.types[0]) || '노말';
    return THEME_OF[t] || 'forest';
  }

  /* ---------- 2. 타입 → 공격 이펙트 ---------- */
  const ATK = {
    물: { k: 'water', n: '물대포', f: 560 }, 얼음: { k: 'ice', n: '냉동빔', f: 900 },
    불꽃: { k: 'fire', n: '화염방사', f: 320 }, 드래곤: { k: 'dragon', n: '드래곤브레스', f: 200 },
    전기: { k: 'elec', n: '백만볼트', f: 1200 }, 강철: { k: 'steel', n: '메탈클로', f: 700 },
    에스퍼: { k: 'psychic', n: '염동력', f: 1000 }, 고스트: { k: 'ghost', n: '섀도볼', f: 240 },
    악: { k: 'dark', n: '악의파동', f: 180 }, 바위: { k: 'rock', n: '스톤샤워', f: 260 },
    땅: { k: 'ground', n: '모래뿌리기', f: 200 }, 비행: { k: 'flying', n: '제비반환', f: 1400 },
    페어리: { k: 'fairy', n: '문포스', f: 1500 }, 풀: { k: 'grass', n: '잎날가르기', f: 760 },
    벌레: { k: 'bug', n: '벌레먹기', f: 620 }, 독: { k: 'poison', n: '독찌르기', f: 420 },
    노말: { k: 'normal', n: '몸통박치기', f: 500 }, 격투: { k: 'fight', n: '인파이트', f: 380 },
  };
  const atkOf = (t) => ATK[t] || ATK.노말;

  /* ---------- 3. 확장 상태 ---------- */
  const PB = {
    partnerId: 0,
    combo: 0,
    bestCombo: 0,
    balls: { super: 2, hyper: 0, master: 0 },
    ball: 'poke',
    wrong: [],
    shiny: new Set(),
    evo: {},
    rv: null,
    audio: null,
    cryAt: 0,
  };
  const EVO_RATE = 0.5;
  const SHINY_RATE = 0.015;

  function partner() {
    try { return Partner.pokemon(); } catch (e) { return null; }
  }
  function partnerType() { const p = Partner.pokemon(); return (p && p.types && p.types[0]) || '노말'; }

  /* ---------- 4. 저장소(프로필 슬롯 공유) ---------- */
  const Partner = {
    key() { return LSK.partner(slotId()); },
    /* 잡은 포켓몬만 파트너가 될 수 있다 */
    caught(id) {
      try { return !!(id && byId(id) && S.dex && S.dex.ids && S.dex.ids.has(Number(id))); } catch (e) { return false; }
    },
    pokemon() { try { return Partner.caught(PB.partnerId) ? byId(PB.partnerId) : null; } catch (e) { return null; } },
    load() {
      const raw = lsGet(Partner.key(), null);
      const id = Number(raw);
      if (Partner.caught(id)) { PB.partnerId = id; return; }
      /* 잡은 적 없는 포켓몬이 저장돼 있으면 지운다 */
      if (Number.isFinite(id) && id > 0) lsSet(Partner.key(), 0);
      PB.partnerId = 0;
      /* 아직 파트너가 없으면 처음 잡은 몬스터를 자동 등록 (잡은 게 없으면 파트너 없음) */
      let first = 0;
      try {
        const dates = (S.dex && S.dex.dates) || {};
        const ids = Array.from((S.dex && S.dex.ids) || []).filter((n) => byId(n));
        ids.sort((a, b) => String(dates[a] || '9999').localeCompare(String(dates[b] || '9999')) || a - b);
        if (ids.length) first = ids[0];
      } catch (e) { /* */ }
      if (first) {
        PB.partnerId = first;
        lsSet(Partner.key(), first);
      }
    },
    set(id) {
      if (!Partner.caught(id)) return false;
      PB.partnerId = Number(id);
      lsSet(Partner.key(), PB.partnerId);
      UI.partner();
      UI.detailPartnerBtn();
      return true;
    },
  };

  const Balls = {
    load() {
      const b = lsGet(LSK.balls(slotId()), null) || {};
      PB.balls = {
        super: Number.isFinite(b.super) ? Math.max(0, b.super) : 2,
        hyper: Number.isFinite(b.hyper) ? Math.max(0, b.hyper) : 0,
        master: Number.isFinite(b.master) ? Math.max(0, b.master) : 0,
      };
    },
    save() { lsSet(LSK.balls(slotId()), PB.balls); },
    add(add, quiet) {
      Object.keys(add).forEach((k) => { PB.balls[k] = Math.max(0, (PB.balls[k] || 0) + add[k]); });
      Balls.save();
      UI.renderBalls();
      if (!quiet) {
        const parts = Object.keys(add).filter((k) => add[k] > 0)
          .map((k) => BALLS[k].name + ' ×' + add[k]);
        if (parts.length) UI.toast(parts.join(' · ') + ' 획득!', 'good', 1500);
      }
    },
    take(k) {
      if (k === 'poke') return true;
      if (!PB.balls[k]) return false;
      PB.balls[k] -= 1;
      Balls.save();
      UI.renderBalls();
      return true;
    },
  };
  const BALLS = {
    poke: { name: '몬스터볼', dmg: 1 },
    super: { name: '슈퍼볼', dmg: 2 },
    hyper: { name: '하이퍼볼', dmg: 3 },
    master: { name: '마스터볼', dmg: 0 },
  };
  const ballDmg = () => (BALLS[PB.ball] ? BALLS[PB.ball].dmg : 1);

  const Shiny = {
    load() {
      const a = lsGet(LSK.shiny(slotId()), []);
      PB.shiny = new Set(Array.isArray(a) ? a.filter((n) => Number.isFinite(n)) : []);
    },
    has(id) { return PB.shiny.has(id); },
    add(id) {
      PB.shiny.add(id);
      lsSet(LSK.shiny(slotId()), Array.from(PB.shiny));
    },
  };

  const TimerPref = {
    off() { return lsGet(LSK.timer(slotId()), 'on') === 'off'; },
    set(off) {
      lsSet(LSK.timer(slotId()), off ? 'off' : 'on');
      if (off) { try { cancelAnimationFrame(S.raf); } catch (e) { /* */ } }
      UI.timer();
      if (!off) { try { startTimer(); } catch (e) { /* */ } }
      else { try { renderTimer(); } catch (e) { /* */ } }
    },
  };

  const Mission = {
    get() {
      const today = todayKey();
      let m = lsGet(LSK.mission(slotId()), null);
      if (!m || typeof m !== 'object' || m.date !== today) m = { date: today, done: {}, reward: false };
      return m;
    },
    save(m) { lsSet(LSK.mission(slotId()), m); },
    mark(game) {
      const m = Mission.get();
      m.done[game] = true;
      const all = ['math', 'hangul', 'english'].every((g) => m.done[g]);
      let rewarded = false;
      if (all && !m.reward) { m.reward = true; rewarded = true; }
      Mission.save(m);
      UI.missionBadge();
      if (rewarded) Mission.reward();
      return rewarded;
    },
    reward() {
      lsSet(LSK.buff(slotId()), { date: todayKey(), legend: true });
      Balls.add({ super: 2, hyper: 1 }, true);
      UI.missionRewardNote();
      UI.toast('🎉 오늘의 미션 완료! 전설 확률 UP + 볼 보상!', 'good', 2600);
      try { Sound.fanfare(); } catch (e) { /* */ }
    },
    buffOn() {
      const b = lsGet(LSK.buff(slotId()), null);
      return !!(b && b.date === todayKey() && b.legend);
    },
  };

  function legendBoost() {
    if (!Mission.buffOn()) return null;
    if (Math.random() > 0.12) return null;
    const pool = POKEMON.filter((p) => !p.form && (p.leg || p.myth));
    if (!pool.length) return null;
    const p = pick(pool);
    return Object.assign({}, p, { level: rand(20, 50), cp: rand(400, 900) });
  }

  /* ---------- 5. 울음소리 ---------- */
  function playCry(id, force) {
    try {
      if (typeof Sound !== 'undefined' && Sound.muted) return;
      const now = Date.now();
      if (!force && now - PB.cryAt < 2500) return;
      PB.cryAt = now;
      const a = PB.audio || (PB.audio = new Audio());
      a.pause();
      a.src = CRY(id);
      a.volume = 0.5;
      const pr = a.play();
      if (pr && pr.catch) pr.catch(() => { /* 자동재생 차단 등은 조용히 무시 */ });
    } catch (e) { /* */ }
  }

  /* ---------- 6. 화면 구성 ---------- */
  const UI = {
    toast(msg, kind, ms) { try { toast(msg, kind || 'info', ms || 1300); } catch (e) { /* */ } },

    stage() {
      const stage = q('#stage');
      if (!stage || q('#pb2Bg')) return;
      const bg = document.createElement('div');
      bg.className = 'pb2-bg';
      bg.id = 'pb2Bg';
      bg.setAttribute('data-theme', 'forest');
      bg.setAttribute('aria-hidden', 'true');
      bg.innerHTML = '<i class="pb2-sky"></i><i class="pb2-far"></i><i class="pb2-mid"></i>'
        + '<i class="pb2-ground"></i><i class="pb2-motes" id="pb2Motes"></i>';
      stage.insertBefore(bg, stage.firstChild);

      const banner = document.createElement('div');
      banner.className = 'pb2-banner';
      banner.id = 'pb2Banner';
      banner.hidden = true;
      banner.innerHTML = '<b id="pb2BannerText"></b>';
      stage.appendChild(banner);

      const evo = document.createElement('div');
      evo.className = 'pb2-evo';
      evo.id = 'pb2Evo';
      evo.hidden = true;
      evo.setAttribute('aria-hidden', 'true');
      evo.innerHTML = '<i class="pb2-pillar"></i><i class="pb2-ring"></i><i class="pb2-ring"></i><i class="pb2-ring"></i>';
      stage.appendChild(evo);

      const shinyLight = document.createElement('div');
      shinyLight.className = 'pb2-shinylight';
      shinyLight.id = 'pb2ShinyLight';
      shinyLight.hidden = true;
      shinyLight.setAttribute('aria-hidden', 'true');
      stage.appendChild(shinyLight);

      const p = document.createElement('div');
      p.className = 'pb2-partner';
      p.id = 'pb2Partner';
      p.setAttribute('role', 'button');
      p.tabIndex = 0;
      p.setAttribute('aria-label', '파트너 포켓몬 바꾸기');
      p.innerHTML = '<b class="pb2-combo" id="pb2Combo" hidden></b>'
        + '<img id="pb2PartnerImg" alt="" decoding="async">'
        + '<span class="pb2-pname" id="pb2PartnerName">파트너 없음</span>'
        + '<span class="pb2-pswap" aria-hidden="true">🔄</span>';
      p.addEventListener('click', (e) => {
        e.stopPropagation();
        try { Sound.ensure(); Sound.click(); } catch (_) { /* */ }
        UI.partnerModal();
      });
      p.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); UI.partnerModal(); }
      });
      stage.appendChild(p);
    },

    balls() {
      const controls = q('.controls');
      if (!controls || q('#pb2Balls')) return;
      const host = document.createElement('div');
      host.className = 'pb2-balls';
      host.id = 'pb2Balls';
      host.setAttribute('role', 'group');
      host.setAttribute('aria-label', '몬스터볼 선택');
      controls.insertBefore(host, controls.firstChild);
      host.addEventListener('click', (e) => {
        const b = e.target.closest('.pb2-ball');
        if (!b) return;
        const k = b.dataset.ball;
        try { Sound.ensure(); Sound.click(); } catch (_) { /* */ }
        if (k === 'master') { instantCapture(); return; }
        if (k !== 'poke' && !PB.balls[k]) {
          UI.toast(BALLS[k].name + '이 없어요 — 미션·복습·콤보로 모아요!', 'info', 1600);
          return;
        }
        PB.ball = k;
        UI.renderBalls();
      });
      UI.renderBalls();
    },

    renderBalls() {
      const host = q('#pb2Balls');
      if (!host) return;
      if (PB.ball !== 'poke' && !PB.balls[PB.ball]) PB.ball = 'poke';
      const rows = [
        ['poke', '기본', '1칸', ''],
        ['super', '슈퍼', '2칸', PB.balls.super],
        ['hyper', '하이퍼', '3칸', PB.balls.hyper],
        ['master', '마스터', '즉시', PB.balls.master],
      ];
      host.innerHTML = rows.map(([k, nm, dmg, ct]) =>
        '<button class="pb2-ball' + (PB.ball === k ? ' on' : '') + (k !== 'poke' && !ct ? ' dim' : '')
        + '" data-ball="' + k + '" aria-label="' + BALLS[k].name + '">'
        + '<i class="dot"></i><span class="nm">' + nm + '</span>'
        + '<span class="dmg">' + dmg + '</span>'
        + (k === 'poke' ? '' : '<span class="ct">×' + ct + '</span>')
        + '</button>').join('');
    },

    partner() {
      const img = q('#pb2PartnerImg');
      const nm = q('#pb2PartnerName');
      const host = q('#pb2Partner');
      const p = partner();
      if (host) {
        host.classList.toggle('empty', !p);
        host.setAttribute('data-type', (p && p.types && p.types[0]) || '');
        host.title = p ? (p.name + ' · 눌러서 파트너 바꾸기') : '눌러서 파트너 고르기';
        host.setAttribute('aria-label', p ? p.name + ' 파트너 · 눌러서 바꾸기' : '파트너 없음 · 눌러서 고르기');
      }
      if (img) {
        if (p) {
          img.style.display = '';
          img.onerror = () => { img.onerror = null; img.src = ART2(p.id); };
          img.src = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/' + p.id + '.png';
          img.alt = p.name;
        } else {
          img.style.display = 'none';
          img.removeAttribute('src');
          img.alt = '';
        }
      }
      if (nm) nm.textContent = p ? p.name : '파트너 없음';
    },

    partnerModal() {
      const grid = q('#pb2PartnerGrid');
      if (!grid) return;
      const ids = Array.from((S.dex && S.dex.ids) || []).filter((n) => byId(n));
      if (!ids.length) {
        UI.toast('먼저 몬스터를 잡으면 파트너로 삼을 수 있어요!', 'info', 1800);
        return;
      }
      ids.sort((a, b) => a - b);
      grid.innerHTML = ids.map((id) => {
        const p = byId(id);
        return '<button class="pb2-pcard' + (id === PB.partnerId ? ' on' : '') + '" data-id="' + id + '">'
          + '<img loading="lazy" decoding="async" src="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/' + id + '.png" alt="">'
          + '<span>' + esc(p.name) + '</span></button>';
      }).join('');
      const note = q('#pb2PartnerNote');
      if (note) note.textContent = '잡은 ' + ids.length + '마리 중에서 고를 수 있어요';
      try { openModal('pb2PartnerModal'); } catch (e) { /* */ }
    },

    missionBtn() {
      const menu = q('#menu');
      if (!menu || q('#pb2MissionBtn')) return;
      const b = document.createElement('button');
      b.className = 'mbtn';
      b.id = 'pb2MissionBtn';
      b.innerHTML = '<span class="ico">🎯</span><span class="txt">미션</span><span class="badge" id="pb2MissionBadge">0/3</span>';
      menu.appendChild(b);
      b.addEventListener('click', () => {
        try { Sound.ensure(); Sound.click(); } catch (_) { /* */ }
        UI.missionModal();
      });
    },

    missionBadge() {
      const el = q('#pb2MissionBadge');
      if (!el) return;
      const m = Mission.get();
      const n = ['math', 'hangul', 'english'].filter((g) => m.done[g]).length;
      el.innerHTML = n + '<span class="mb-all">/3</span>';
      el.style.background = n >= 3 ? '#2ea11c' : '';
      el.title = '오늘의 미션 ' + n + '/3';
    },

    rank() {
      const chip = q('#profileChip');
      if (!chip) return;
      let el = q('#pb2Rank');
      if (!el) {
        el = document.createElement('b');
        el.id = 'pb2Rank';
        el.className = 'pb2-rank';
        const caret = chip.querySelector('.caret');
        if (caret) chip.insertBefore(el, caret); else chip.appendChild(el);
      }
      const n = (S.dex && S.dex.ids) ? S.dex.ids.size : 0;
      const r = rankOf(n);
      el.innerHTML = '<span class="re">' + r.emoji + '</span><span class="rt">' + r.label + '</span>';
      el.title = '트레이너 랭크 ' + r.emoji + ' ' + r.label + ' · 잡은 ' + n + '마리';
    },

    theme(p) {
      const bg = q('#pb2Bg');
      const stage = q('#stage');
      if (!bg || !stage) return;
      const key = themeFor(p);
      if (bg.dataset.theme === key) return;
      bg.dataset.theme = key;
      stage.classList.toggle('pb2-themed', key !== 'forest');
      bg.setAttribute('aria-label', THEME_NAME[key] + ' 배경');
      UI.motes(key);
    },

    motes(key) {
      const host = q('#pb2Motes');
      if (!host) return;
      host.innerHTML = '';
      const style = {
        lake: { n: 12, w: [3, 6], c: '#e8fdff', a: 'pb2-down', d: [3.4, 6.5] },
        volcano: { n: 16, w: [3, 6], c: '#ffb347', a: 'pb2-up', d: [2.6, 5.2] },
        power: { n: 10, w: [2, 4], c: '#ffe873', a: 'pb2-twinkle', d: [1.8, 3.6] },
        ruins: { n: 14, w: [3, 6], c: '#e2b6ff', a: 'pb2-twinkle', d: [2.2, 4.4] },
        canyon: { n: 10, w: [3, 6], c: '#ffe6b0', a: 'pb2-drift', d: [4.5, 8] },
        sky: { n: 12, w: [5, 9], c: '#ffc0e0', a: 'pb2-down', d: [5, 9] },
        forest: { n: 8, w: [3, 5], c: '#f5ffcf', a: 'pb2-drift', d: [5, 9] },
      }[key] || { n: 8, w: [3, 5], c: '#fff', a: 'pb2-up', d: [4, 7] };
      for (let i = 0; i < style.n; i += 1) {
        const s = document.createElement('i');
        s.className = 'pb2-mote';
        const w = style.w[0] + Math.random() * (style.w[1] - style.w[0]);
        s.style.cssText = 'left:' + (Math.random() * 100).toFixed(1) + '%;top:'
          + (style.a === 'pb2-up' ? (55 + Math.random() * 42) : style.a === 'pb2-down' ? (Math.random() * 30) : (Math.random() * 80))
          + '%;width:' + w.toFixed(1) + 'px;height:' + w.toFixed(1) + 'px;background:' + style.c
          + ';animation:' + style.a + ' ' + (style.d[0] + Math.random() * (style.d[1] - style.d[0])).toFixed(2)
          + 's linear ' + (Math.random() * 4).toFixed(2) + 's infinite';
        host.appendChild(s);
      }
    },

    banner(kind, text, ms) {
      const b = q('#pb2Banner');
      const t = q('#pb2BannerText');
      if (!b || !t) return;
      b.hidden = false;
      b.dataset.kind = kind || 'evo';
      b.style.animation = 'none';
      void b.offsetWidth;
      b.style.animation = '';
      t.textContent = text;
      clearTimeout(UI._bt);
      UI._bt = setTimeout(() => { b.hidden = true; }, ms || 2400);
    },

    evo(p) {
      const el = q('#pb2Evo');
      if (!el) return;
      const t = (p && p.types && p.types[0]) || '노말';
      el.dataset.el = atkOf(t).k;
      el.hidden = false;
      el.querySelectorAll('.pb2-ring, .pb2-pillar').forEach((n) => {
        n.style.animation = 'none';
        void n.offsetWidth;
        n.style.animation = '';
      });
      clearTimeout(UI._et);
      UI._et = setTimeout(() => { el.hidden = true; }, 1600);
    },

    shinyLight(on) {
      const el = q('#pb2ShinyLight');
      if (el) el.hidden = !on;
    },

    combo() {
      const el = q('#pb2Combo');
      if (!el) return;
      if (PB.combo >= 2) {
        el.hidden = false;
        el.textContent = '🔥 ×' + PB.combo;
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = '';
      } else {
        el.hidden = true;
      }
    },

    timer() {
      const strip = q('.timerstrip');
      const off = TimerPref.off();
      if (strip) strip.classList.toggle('pb2-notimer', off);
      const num = q('#timerNum');
      const fill = q('#timerFill');
      const bar = q('#timerBar');
      if (off) {
        if (fill) fill.style.transform = 'scaleX(1)';
        if (num) num.textContent = '⏱️ OFF';
        if (bar) bar.classList.remove('warn', 'crit');
      }
    },

    timerGrid() {
      const body = q('#settingsModal .sheet-body');
      if (!body || q('#pb2TimerGrid')) return;
      const h = document.createElement('h3');
      h.className = 'sect';
      h.textContent = '⏱️ 시간제한 (30초)';
      const g = document.createElement('div');
      g.className = 'pb2-timgrid';
      g.id = 'pb2TimerGrid';
      g.innerHTML = '<button data-timer="on"><b>⏱️ 켜기</b><span>30초 안에 풀어요 · 기본</span></button>'
        + '<button data-timer="off"><b>🐢 끄기</b><span>천천히 모드 · 시간 압박 없음</span></button>';
      const note = body.querySelector('.setnote');
      if (note) { body.insertBefore(g, note); body.insertBefore(h, g); }
      else { body.appendChild(h); body.appendChild(g); }
      g.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-timer]');
        if (!b) return;
        try { Sound.ensure(); Sound.click(); } catch (_) { /* */ }
        const off = b.dataset.timer === 'off';
        TimerPref.set(off);
        UI.paintTimerGrid();
        UI.toast(off ? '🐢 천천히 모드 — 시간제한 없이 풀어요' : '⏱️ 시간제한 30초 켜짐', 'info', 1500);
      });
    },

    paintTimerGrid() {
      const off = TimerPref.off();
      qa('#pb2TimerGrid button').forEach((b) => {
        b.classList.toggle('on', (b.dataset.timer === 'off') === off);
      });
    },

    missionModal() {
      const list = q('#pb2MissionList');
      if (!list) return;
      const m = Mission.get();
      const rows = [
        ['math', '⚡', '산수 배틀'],
        ['hangul', '📖', '한글 배틀'],
        ['english', '🔤', '영어 배틀'],
      ];
      list.innerHTML = rows.map(([g, ic, nm]) =>
        '<div class="pb2-mrow' + (m.done[g] ? ' done' : '') + '">'
        + '<span class="mi">' + ic + '</span>'
        + '<span class="mt">' + nm + '<small>' + (m.done[g] ? '오늘 클리어!' : '몬스터 1마리 잡기 (한 판)') + '</small></span>'
        + '<span class="mk">' + (m.done[g] ? '✅' : '⬜') + '</span></div>').join('');
      const rw = q('#pb2MissionReward');
      if (rw) {
        const buff = Mission.buffOn();
        rw.innerHTML = '<span class="' + (m.reward ? '' : 'off') + '">' + (m.reward ? '🎉 전설 확률 UP (오늘)' : '전설 확률 UP') + '</span>'
          + '<span class="' + (m.reward ? '' : 'off') + '">슈퍼볼 ×2</span>'
          + '<span class="' + (m.reward ? '' : 'off') + '">하이퍼볼 ×1</span>'
          + (buff ? '<span>지금 적용 중!</span>' : '');
      }
      UI.missionBadge();
      try { openModal('pb2MissionModal'); } catch (e) { /* */ }
    },

    missionRewardNote() {
      const modal = q('#catchModal');
      if (!modal) return;
      const body = modal.querySelector('.body');
      if (!body || body.querySelector('.pb2-missiondone')) return;
      const d = document.createElement('div');
      d.className = 'pb2-mreward pb2-missiondone';
      d.innerHTML = '<span>🎉 오늘의 미션 완료!</span><span>전설 UP</span><span>슈퍼볼 ×2</span><span>하이퍼볼 ×1</span>';
      const row = body.querySelector('.btnrow');
      if (row) body.insertBefore(d, row); else body.appendChild(d);
    },

    detailPartnerBtn() {
      const foot = q('#detailModal .sheet-foot');
      if (!foot) return;
      if (!q('#pb2PartnerBtn')) {
        const b = document.createElement('button');
        b.id = 'pb2PartnerBtn';
        b.className = 'pb2-pbtn';
        b.addEventListener('click', () => {
          try { Sound.ensure(); Sound.click(); } catch (_) { /* */ }
          const id = Number(UI._detailId);
          if (!id) return;
          if (!S.dex.ids.has(id)) { UI.toast('아직 잡지 못한 몬스터예요', 'info', 1100); return; }
          Partner.set(id);
          const p = byId(id);
          UI.toast('🤝 ' + (p ? p.name : '포켓몬') + ' 파트너 지정!', 'good', 1500);
          playCry(id, true);
        });
        foot.appendChild(b);
      }
      const btn = q('#pb2PartnerBtn');
      const id = Number(UI._detailId);
      const on = id && id === PB.partnerId;
      btn.textContent = on ? '⭐ 지금 파트너' : '🤝 파트너로 지정';
      btn.classList.toggle('on', !!on);

      if (!q('#pb2CryBtn')) {
        const c = document.createElement('button');
        c.id = 'pb2CryBtn';
        c.className = 'pb2-crybtn';
        c.textContent = '🔊 울음소리';
        c.addEventListener('click', () => {
          const iid = Number(UI._detailId);
          if (iid) playCry(iid, true);
        });
        foot.insertBefore(c, btn);
      }

      let sm = q('#pb2ShinyTag');
      if (id && Shiny.has(id)) {
        if (!sm) {
          sm = document.createElement('span');
          sm.id = 'pb2ShinyTag';
          sm.className = 'detrank';
          sm.style.cssText = 'color:#c98a10;background:#fff6d2;border:1.5px solid #e8c25a;border-radius:999px;padding:1px 8px;font-weight:900;font-size:11px';
          const meta = q('#detailModal .detmeta');
          if (meta) meta.appendChild(sm);
        }
        sm.textContent = '✨ 이로치';
      } else if (sm) {
        sm.remove();
      }
    },

    reviewBtn(modalId) {
      const body = q('#' + modalId + ' .body');
      if (!body) return;
      let b = body.querySelector('.pb2-reviewbtn');
      if (!PB.wrong.length) { if (b) b.remove(); return; }
      if (!b) {
        b = document.createElement('button');
        b.className = 'pb2-reviewbtn';
        b.addEventListener('click', () => Review.open());
        body.appendChild(b);
      }
      b.textContent = '📝 틀린 ' + PB.wrong.length + '문제 복습하기';
    },

    modals() {
      if (q('#pb2MissionModal')) return;
      const mk = document.createElement('div');
      mk.className = 'modal';
      mk.id = 'pb2MissionModal';
      mk.hidden = true;
      mk.innerHTML = '<div class="sheet">'
        + '<div class="sheet-head"><h2>🎯 오늘의 미션</h2>'
        + '<button class="x" data-pb2close="pb2MissionModal">✕</button></div>'
        + '<div class="sheet-body">'
        + '<p class="pb2-mnote">산수·한글·영어에서 각각 <b>1마리</b> 이상 잡으면 오늘의 미션 완료!<br>보상은 하루 한 번, 자정에 새로 시작해요.</p>'
        + '<div class="pb2-mission-list" id="pb2MissionList"></div>'
        + '<div class="pb2-mreward" id="pb2MissionReward"></div>'
        + '</div>'
        + '<div class="sheet-foot pb2-setfoot"><button class="pb2-confirm" data-pb2close="pb2MissionModal">확인</button></div>'
        + '</div>';

      const rk = document.createElement('div');
      rk.className = 'modal';
      rk.id = 'pb2ReviewModal';
      rk.hidden = true;
      rk.innerHTML = '<div class="sheet">'
        + '<div class="sheet-head"><h2>📝 틀린 문제 복습</h2>'
        + '<button class="x" data-pb2close="pb2ReviewModal">✕</button></div>'
        + '<div class="sheet-body" id="pb2ReviewBody"></div>'
        + '<div class="sheet-foot" id="pb2ReviewFoot" hidden>'
        + '<button class="pb2-confirm" id="pb2ReviewGo">계속 모험 ⚡</button></div>'
        + '</div>';

      const pk = document.createElement('div');
      pk.className = 'modal';
      pk.id = 'pb2PartnerModal';
      pk.hidden = true;
      pk.innerHTML = '<div class="sheet">'
        + '<div class="sheet-head"><h2>🤝 파트너 고르기</h2>'
        + '<button class="x" data-pb2close="pb2PartnerModal">✕</button></div>'
        + '<div class="sheet-body">'
        + '<p class="pb2-mnote" id="pb2PartnerNote">잡은 포켓몬 중에서 고를 수 있어요</p>'
        + '<div class="pb2-pgrid" id="pb2PartnerGrid"></div>'
        + '</div>'
        + '<div class="sheet-foot pb2-setfoot"><button class="pb2-confirm" data-pb2close="pb2PartnerModal">닫기</button></div>'
        + '</div>';

      document.body.appendChild(mk);
      document.body.appendChild(rk);
      document.body.appendChild(pk);
      pk.addEventListener('click', (e) => {
        const card = e.target.closest('.pb2-pcard');
        if (card) {
          const id = Number(card.dataset.id);
          try { Sound.ensure(); Sound.click(); } catch (_) { /* */ }
          if (Partner.set(id)) {
            const p = byId(id);
            UI.toast('🤝 ' + (p ? p.name : '포켓몬') + ' 파트너!', 'good', 1400);
            playCry(id, true);
            pk.hidden = true;
            try { syncPause(); } catch (_) { /* */ }
          }
          return;
        }
        if (e.target === pk) { pk.hidden = true; try { syncPause(); } catch (_) { /* */ } }
      });
      [mk, rk].forEach((m) => {
        m.addEventListener('click', (e) => {
          if (e.target === m) { m.hidden = true; try { syncPause(); } catch (_) { /* */ } }
        });
      });
      qa('[data-pb2close]', mk.parentNode).forEach((b) => {
        b.addEventListener('click', () => {
          const m = document.getElementById(b.dataset.pb2close);
          if (m) { m.hidden = true; try { syncPause(); } catch (_) { /* */ } }
        });
      });
      q('#pb2ReviewGo').addEventListener('click', () => {
        try { Sound.click(); } catch (_) { /* */ }
        ['pb2ReviewModal', 'catchModal', 'faintModal'].forEach((id) => {
          const m = document.getElementById(id);
          if (m) m.hidden = true;
        });
        PB.wrong = [];
        try { newEncounter({}); } catch (e) { /* */ }
      });
    },
  };

  /* ---------- 7. 랭크 ---------- */
  function josaOf(name) {
    try { return josa(name, '이', '가'); } catch (e) { return '가'; }
  }

  function rankOf(n) {
    if (n >= 100) return { emoji: '👑', label: '마스터' };
    if (n >= 30) return { emoji: '🥇', label: '골드' };
    if (n >= 10) return { emoji: '🥈', label: '실버' };
    return { emoji: '🌱', label: '초보' };
  }

  /* ---------- 8. 공격/피격 모션 ---------- */
  function fire(fromEl, toEl, type, opts) {
    const o = opts || {};
    const fx = q('#fx');
    if (!fx || !fromEl || !toEl) return;
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const x0 = a.left + a.width * (o.back ? 0.35 : 0.55);
    const y0 = a.top + a.height * 0.5;
    const x1 = b.left + b.width * 0.5;
    const y1 = b.top + b.height * 0.5;
    const atk = atkOf(type);
    const el = document.createElement('div');
    el.className = 'pb2-proj';
    el.dataset.el = atk.k;
    el.style.left = x0.toFixed(1) + 'px';
    el.style.top = y0.toFixed(1) + 'px';
    el.innerHTML = '<i class="core"></i><i class="tr"></i><i class="tr"></i><i class="tr"></i>';
    fx.appendChild(el);
    qa('.tr', el).forEach((t, i) => {
      t.style.transform = 'translate(' + (-9 * (i + 1)) + 'px,' + ((i % 2 ? 1 : -1) * 4) + 'px)';
    });
    const ang = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
    const arc = -Math.min(70, Math.abs(x1 - x0) * 0.14);
    const dur = o.slow ? 470 : 360;
    try {
      el.animate([
        { transform: 'translate(0,0) rotate(0deg) scale(.7)', opacity: 0 },
        { transform: 'translate(' + (x1 - x0) * 0.5 + 'px,' + ((y1 - y0) * 0.5 + arc) + 'px) rotate(' + ang + 'deg) scale(1)', opacity: 1, offset: 0.5 },
        { transform: 'translate(' + (x1 - x0) + 'px,' + (y1 - y0) + 'px) rotate(' + ang + 'deg) scale(1.1)', opacity: 1 },
      ], { duration: dur, easing: 'cubic-bezier(.3,.05,.5,1)' }).finished
        .then(() => {
          el.remove();
          try { burst(x1, y1, o.strong ? 22 : 14, o.strong ? 120 : 80); } catch (e) { /* */ }
          if (o.onHit) { try { o.onHit(); } catch (e) { /* */ } }
        })
        .catch(() => el.remove());
    } catch (e) { el.remove(); }
    try {
      Sound.ensure();
      Sound.tone(atk.f, 0.12, 'triangle', 0.05, 0, o.back ? atk.f * 0.6 : atk.f * 1.6);
    } catch (e) { /* */ }
    return el;
  }

  function partnerAttack(crit) {
    const p = q('#pb2Partner');
    const w = q('#wildWrap');
    if (!p || !w) return;
    const pr = p.getBoundingClientRect();
    const wr = w.getBoundingClientRect();
    const dx = (wr.left + wr.width * 0.5) - (pr.left + pr.width * 0.5);
    const dy = (wr.top + wr.height * 0.55) - (pr.top + pr.height * 0.5);
    try {
      p.animate([
        { transform: 'translate(0,0) scale(1)' },
        { transform: 'translate(' + dx * 0.26 + 'px,' + dy * 0.26 + 'px) scale(1.08)', offset: 0.34 },
        { transform: 'translate(' + dx * 0.56 + 'px,' + dy * 0.56 + 'px) scale(1.05)', offset: 0.52 },
        { transform: 'translate(0,0) scale(1)' },
      ], { duration: 560, easing: 'cubic-bezier(.25,1.3,.4,1)' });
    } catch (e) { /* */ }
    setTimeout(() => {
      fire(p, w, partnerType(), {
        strong: !!crit,
        onHit: () => {
          try { hitWild(); } catch (e) { /* */ }
          w.classList.remove('pb2-flash');
          void w.offsetWidth;
          w.classList.add('pb2-flash');
          setTimeout(() => w.classList.remove('pb2-flash'), 460);
        },
      });
    }, 110);
    p.classList.remove('pb2-jump');
    setTimeout(() => { p.classList.add('pb2-jump'); }, 300);
    setTimeout(() => p.classList.remove('pb2-jump'), 900);
  }

  /* 야생 포켓몬: 앞으로 돌진(lunge) → 타입 투사체 → 내 파트너 피격 */
  function wildAttack() {
    const p = q('#pb2Partner');
    const w = q('#wildWrap');
    if (!p || !w) return;
    const t = (S.wild && S.wild.types && S.wild.types[0]) || '노말';
    const pr = p.getBoundingClientRect();
    const wr = w.getBoundingClientRect();
    const dx = (pr.left + pr.width * 0.55) - (wr.left + wr.width * 0.5);
    const dy = (pr.top + pr.height * 0.5) - (wr.top + wr.height * 0.55);
    try {
      w.animate([
        { transform: 'translate(0,0) scale(1)' },
        { transform: 'translate(' + dx * 0.1 + 'px,' + dy * 0.1 + 'px) scale(.97)', offset: 0.16 },
        { transform: 'translate(' + dx * 0.34 + 'px,' + dy * 0.34 + 'px) scale(1.1)', offset: 0.55 },
        { transform: 'translate(0,0) scale(1)' },
      ], { duration: 660, easing: 'cubic-bezier(.3,1.25,.4,1)' });
    } catch (e) { /* */ }
    setTimeout(() => {
      fire(w, p, t, {
        back: true, slow: true, strong: true,
        onHit: () => {
          p.classList.remove('pb2-hurt');
          void p.offsetWidth;
          p.classList.add('pb2-hurt');
          setTimeout(() => p.classList.remove('pb2-hurt'), 680);
          try { flashScreen(); } catch (e) { /* */ }
        },
      });
    }, 230);
  }

  /* ---------- 9. 정답/오답 처리 ---------- */
  function snapshotQuestion() {
    const el = q('#question');
    const extra = q('#qExtra');
    const choices = qa('#choices .choice')
      .filter((b) => b.style.display !== 'none' && b.offsetParent !== null)
      .map((b) => {
        const vEl = b.querySelector('.v');
        let ok;
        if (b.dataset && b.dataset.ok !== undefined) ok = b.dataset.ok === '1';
        else if (S.q && S.q.ans !== undefined) ok = String(S.q.ans).trim() === (vEl || b).textContent.trim();
        else ok = b.classList.contains('correct');
        return { v: ((vEl || b).textContent || '').trim(), ok: !!ok };
      });
    return {
      q: el ? el.innerHTML : '',
      extra: extra && !extra.hidden ? extra.innerHTML : '',
      choices,
    };
  }

  function recordWrong(snap) {
    if (!snap || !snap.choices || !snap.choices.length) return;
    if (!snap.choices.some((c) => c.ok)) return;
    const key = snap.q + '|' + snap.choices.map((c) => c.v).join(',');
    if (PB.wrong.some((w) => w.key === key)) return;
    const ans = (S.q && (S.q.answer || S.q.ans)) ? String(S.q.answer || S.q.ans) : '';
    PB.wrong.push({ key, q: snap.q, extra: snap.extra, choices: snap.choices, ans });
    if (PB.wrong.length > 12) PB.wrong.shift();
  }

  function applyDamage(extra) {
    if (!(extra > 0)) return;
    const before = S.foeHP;
    S.foeHP = Math.max(0, S.foeHP - extra);
    if (S.foeHP !== before) {
      try { renderHp(q('#foeHp'), S.foeHP); bumpHp(q('#foeHp')); } catch (e) { /* */ }
      try { hitWild(); } catch (e) { /* */ }
    }
  }

  const AnswerHook = {
    attach() {
      const orig = window.answer;
      if (typeof orig !== 'function' || orig.__pb2) return;
      const wrapped = function (idx) {
        const active = S.screen === 'battle' && !S.locked && !!S.q;
        try { if (q('#pb2Banner') && q('#pb2Banner').dataset.kind === 'combo') q('#pb2Banner').hidden = true; } catch (e) { /* */ }
        const snap = active ? snapshotQuestion() : null;
        const btn = qa('#choices .choice')[idx];
        const r = orig.apply(this, arguments);
        if (!active || !btn) return r;
        const ok = btn.classList.contains('correct');
        try {
          if (ok) {
            PB.combo += 1;
            if (PB.combo > PB.bestCombo) PB.bestCombo = PB.combo;
            const crit = PB.combo > 0 && PB.combo % 3 === 0;
            applyDamage(ballDmg() - 1 + (crit ? 1 : 0));
            partnerAttack(crit);
            UI.combo();
            if (crit) {
              Balls.add({ super: 1 }, true);
              UI.banner('combo', '🔥 ' + PB.combo + ' 콤보 크리티컬! HP 2칸!', 1200);
            }
          } else {
            PB.combo = 0;
            UI.combo();
            recordWrong(snap);
            wildAttack();
          }
        } catch (e) { warn('answer hook', e); }
        return r;
      };
      wrapped.__pb2 = true;
      window.answer = wrapped;
    },
  };

  const TimeoutHook = {
    attach() {
      const orig = window.onTimeout;
      if (typeof orig !== 'function' || orig.__pb2) return;
      const wrapped = function () {
        const active = S.screen === 'battle';
        const snap = active ? snapshotQuestion() : null;
        if (active && TimerPref.off()) return;
        const r = orig.apply(this, arguments);
        if (!active) return r;
        try {
          PB.combo = 0;
          UI.combo();
          recordWrong(snap);
          wildAttack();
        } catch (e) { warn('timeout hook', e); }
        return r;
      };
      wrapped.__pb2 = true;
      window.onTimeout = wrapped;
    },
  };

  /* ---------- 10. 등장(진화·이로치·배경·파트너·울음) ---------- */
  const SpawnHook = {
    attach() {
      const origPick = window.pickWild;
      if (typeof origPick === 'function' && !origPick.__pb2) {
        const pickW = function (excludeId) {
          try {
            const evo = SpawnHook.rollEvo(excludeId);
            if (evo) return evo;
            const boost = legendBoost();
            if (boost) return boost;
          } catch (e) { warn('pickWild pre', e); }
          const w = origPick.apply(this, arguments);
          try {
            if (w && Math.random() < SHINY_RATE) w.shiny = true;
          } catch (e) { /* */ }
          return w;
        };
        pickW.__pb2 = true;
        window.pickWild = pickW;
      }

      const origNew = window.newEncounter;
      if (typeof origNew === 'function' && !origNew.__pb2) {
        const newEnc = function (opts) {
          PB.combo = 0;
          PB.wrong = [];
          const o = opts || {};
          const r = origNew.apply(this, arguments);
          const after = () => {
            try { SpawnHook.onEncounter(o); } catch (e) { warn('onEncounter', e); }
          };
          if (r && typeof r.then === 'function') r.then(after, after); else after();
          return r;
        };
        newEnc.__pb2 = true;
        window.newEncounter = newEnc;
      }
    },

    rollEvo(excludeId) {
      if (!S.dex || !S.dex.counts) return null;
      if (!PB.evo || !Object.keys(PB.evo).length) return null;
      if (Math.random() > EVO_RATE) return null;
      const cands = [];
      Object.keys(S.dex.counts).forEach((k) => {
        const id = Number(k);
        if (!(S.dex.counts[k] >= 2)) return;
        if (!byId(id)) return;
        const nexts = PB.evo[String(id)];
        if (!nexts) return;
        nexts.forEach((n) => {
          if (n !== excludeId && byId(n) && !byId(n).form) cands.push({ from: id, to: n });
        });
      });
      if (!cands.length) return null;
      const c = pick(cands);
      const t = byId(c.to);
      return Object.assign({}, t, {
        level: rand(4, 12), cp: rand(20, 220), evolved: true, evoFrom: c.from,
        shiny: Math.random() < SHINY_RATE,
      });
    },

    onEncounter(o) {
      const p = S.wild;
      if (!p) return;
      UI.theme(p);
      UI.partner();
      UI.renderBalls();
      UI.rank();
      UI.combo();
      UI.timer();
      const wrap = q('#wildWrap');
      if (wrap) wrap.classList.remove('pb2-shiny-fallback');
      SpawnHook.applyShiny(p);
      if (p.evolved) {
        UI.banner('evo', '🔥 진화 포켓몬 출현!!', 2600);
        UI.evo(p);
      } else if (p.shiny) {
        UI.banner('shiny', '✨ 이로치!', 2400);
      }
      try { if (o && o.silent) return; } catch (e) { /* */ }
      if (p.evolved || p.shiny) { try { flashScreen(); } catch (e) { /* */ } }
      setTimeout(() => playCry(p.id), 260);
    },

    applyShiny(p) {
      const wrap = q('#wildWrap');
      UI.shinyLight(!!(p && p.shiny));
      if (!wrap || !p || !p.shiny) return;
      wrap.classList.add('pb2-shiny-fallback');
      const img = new Image();
      img.onload = () => {
        try {
          const art = q('#wildArt');
          const spr = q('#wildSprite');
          if (art) { art.onerror = null; art.src = SHINY_ART(p.id); art.style.display = ''; art.style.opacity = '1'; }
          if (spr) { spr.onerror = null; spr.src = SHINY_SPR(p.id); }
          wrap.classList.remove('pb2-shiny-fallback');
        } catch (e) { /* */ }
      };
      img.onerror = () => { /* 공식 이미지가 없으면 hue-rotate 폴백 유지 */ };
      img.src = SHINY_ART(p.id);
    },
  };

  /* ---------- 11. 포획 · 전투불능 ---------- */
  const CaptureHook = {
    attach() {
      const orig = window.captureSequence;
      if (typeof orig === 'function' && !orig.__pb2) {
        const cap = function () {
          const used = PB.ball;
          try {
            if (used !== 'poke') Balls.take(used);
          } catch (e) { /* */ }
          const r = orig.apply(this, arguments);
          const after = () => {
            try { CaptureHook.after(used); } catch (e) { warn('afterCapture', e); }
          };
          if (r && typeof r.then === 'function') r.then(after, after); else after();
          return r;
        };
        cap.__pb2 = true;
        window.captureSequence = cap;
      }
      const origF = window.faint;
      if (typeof origF === 'function' && !origF.__pb2) {
        const f = function () {
          const r = origF.apply(this, arguments);
          const after = () => {
            try { UI.reviewBtn('faintModal'); } catch (e) { /* */ }
          };
          if (r && typeof r.then === 'function') r.then(after, after); else after();
          return r;
        };
        f.__pb2 = true;
        window.faint = f;
      }
    },

    after(used) {
      if (PB.ball !== 'poke') PB.ball = 'poke';
      const hadPartner = !!Partner.pokemon();
      if (S.wild) {
        if (S.wild.shiny) {
          Shiny.add(S.wild.id);
          UI.toast('✨ 이로치 ' + S.wild.name + ' 도감 등록!', 'good', 2200);
        }
        playCry(S.wild.id);
      }
      /* 잡은 포켓몬만 파트너 · 파트너가 없으면 방금 잡은 몬스터를 자동 등록 */
      if (!hadPartner && S.wild && Partner.caught(S.wild.id)) {
        Partner.set(S.wild.id);
        UI.toast('🐣 ' + S.wild.name + josaOf(S.wild.name) + ' 첫 파트너가 되었어요!', 'good', 2000);
      } else {
        UI.partner();
      }
      Mission.mark(GAME);
      UI.renderBalls();
      UI.rank();
      UI.reviewBtn('catchModal');
      const dexm = q('#dexModal');
      if (dexm && !dexm.hidden) { try { renderDex(false); } catch (e) { /* */ } }
      void used;
    },
  };

  function instantCapture() {
    if (S.screen !== 'battle' || S.locked) { UI.toast('지금은 쓸 수 없어요', 'info', 1100); return; }
    if (!PB.balls.master) { UI.toast('마스터볼이 없어요 — 미션·복습 보상으로 모아요!', 'info', 1700); return; }
    PB.ball = 'master';
    UI.toast('🟣 마스터볼! 즉시 포획!', 'good', 1400);
    try { Sound.throwBall(); } catch (e) { /* */ }
    try { captureSequence(); } catch (e) { warn('master', e); }
  }

  /* ---------- 12. 도감 · 상세 · 프로필 확장 ---------- */
  const DexHook = {
    attach() {
      const origDex = window.renderDex;
      if (typeof origDex === 'function' && !origDex.__pb2) {
        const r = function () {
          const out = origDex.apply(this, arguments);
          try { DexHook.mark(); } catch (e) { warn('dex mark', e); }
          return out;
        };
        r.__pb2 = true;
        window.renderDex = r;
      }
      const origDetail = window.openDetail;
      if (typeof origDetail === 'function' && !origDetail.__pb2) {
        const d = function (id) {
          UI._detailId = id;
          const out = origDetail.apply(this, arguments);
          try { UI.detailPartnerBtn(); } catch (e) { warn('detail', e); }
          return out;
        };
        d.__pb2 = true;
        window.openDetail = d;
      }
      const origBadge = window.renderDexBadge;
      if (typeof origBadge === 'function' && !origBadge.__pb2) {
        const b = function () {
          const out = origBadge.apply(this, arguments);
          try { UI.rank(); } catch (e) { /* */ }
          return out;
        };
        b.__pb2 = true;
        window.renderDexBadge = b;
      }
      const origReset = window.doReset;
      if (typeof origReset === 'function' && !origReset.__pb2) {
        const dr = function () {
          const out = origReset.apply(this, arguments);
          try { Partner.load(); UI.partner(); UI.rank(); } catch (e) { /* */ }
          return out;
        };
        dr.__pb2 = true;
        window.doReset = dr;
      }
      const origOpenSettings = window.openSettings;
      if (typeof origOpenSettings === 'function' && !origOpenSettings.__pb2) {
        const s = function () {
          const out = origOpenSettings.apply(this, arguments);
          try { UI.paintTimerGrid(); } catch (e) { /* */ }
          return out;
        };
        s.__pb2 = true;
        window.openSettings = s;
      }
    },

    mark() {
      const grid = q('#dexGrid');
      if (!grid) return;
      qa('.dexcell', grid).forEach((cell) => {
        const id = Number(cell.dataset.id);
        const on = id && Shiny.has(id);
        cell.classList.toggle('pb2-shiny', !!on);
        let m = cell.querySelector('.pb2-shinymark');
        if (on && !m) {
          m = document.createElement('span');
          m.className = 'pb2-shinymark';
          m.textContent = '✨';
          cell.appendChild(m);
        } else if (!on && m) {
          m.remove();
        }
      });
    },
  };

  /* ---------- 13. 타이머 · 설정 확인 ---------- */
  const TimerHook = {
    attach() {
      const origStart = window.startTimer;
      if (typeof origStart === 'function' && !origStart.__pb2) {
        const st = function () {
          if (TimerPref.off()) {
            try { cancelAnimationFrame(S.raf); } catch (e) { /* */ }
            try { renderTimer(); } catch (e) { /* */ }
            return undefined;
          }
          return origStart.apply(this, arguments);
        };
        st.__pb2 = true;
        window.startTimer = st;
      }
      const origRender = window.renderTimer;
      if (typeof origRender === 'function' && !origRender.__pb2) {
        const rt = function () {
          const out = origRender.apply(this, arguments);
          try { if (TimerPref.off()) UI.timer(); } catch (e) { /* */ }
          return out;
        };
        rt.__pb2 = true;
        window.renderTimer = rt;
      }
    },

    confirm() {
      const btn = q('#pb2SetConfirm');
      if (!btn || btn.__pb2) return;
      btn.__pb2 = true;
      btn.addEventListener('click', () => {
        try { Sound.ensure(); Sound.click(); } catch (e) { /* */ }
        try { closeModal('settingsModal'); } catch (e) { /* */ }
        UI.toast('설정을 저장했어요 ✅', 'good', 1400);
        try {
          if (S.screen === 'battle' && !S.locked) {
            renderAll();
            UI.timer();
          }
        } catch (e) { /* */ }
      });
    },
  };

  /* ---------- 14. 복습 ---------- */
  const Review = {
    open() {
      if (!PB.wrong.length) return;
      PB.rv = { i: 0, right: 0, items: PB.wrong.slice() };
      try { openModal('pb2ReviewModal'); } catch (e) { /* */ }
      Review.paint();
    },

    paint() {
      const body = q('#pb2ReviewBody');
      const foot = q('#pb2ReviewFoot');
      if (!body) return;
      const rv = PB.rv;
      if (!rv) return;
      if (foot) foot.hidden = true;
      const it = rv.items[rv.i];
      if (!it) { Review.finish(); return; }
      body.innerHTML = '<div class="pb2-rv">'
        + '<div class="pb2-rvhead"><b>📝 ' + (rv.i + 1) + ' / ' + rv.items.length + '</b>'
        + '<span>' + '🔥'.repeat(Math.min(3, rv.right)) + '</span></div>'
        + '<div class="pb2-rvq">' + it.q + '</div>'
        + (it.extra ? '<div class="pb2-rvq" style="font-size:clamp(15px,4vw,20px)">' + it.extra + '</div>' : '')
        + '<div class="pb2-rvchoices" id="pb2RvChoices">'
        + it.choices.map((c, i) => '<button data-i="' + i + '">' + c.v + '</button>').join('')
        + '</div>'
        + '<div class="pb2-rvmsg" id="pb2RvMsg">정답을 골라 보세요!</div>'
        + '</div>';
      qa('#pb2RvChoices button').forEach((b) => {
        b.addEventListener('click', () => {
          const idx = Number(b.dataset.i);
          Review.pick(idx);
        });
      });
    },

    pick(idx) {
      const rv = PB.rv;
      if (!rv) return;
      const it = rv.items[rv.i];
      if (!it) return;
      const btns = qa('#pb2RvChoices button');
      if (btns.some((b) => b.disabled)) return;
      const chosen = it.choices[idx];
      const msg = q('#pb2RvMsg');
      btns.forEach((b, i) => {
        b.disabled = true;
        if (it.choices[i].ok) b.classList.add('ok');
      });
      if (chosen && chosen.ok) {
        rv.right += 1;
        if (msg) msg.textContent = '✅ 맞았어요!';
        try { Sound.correct(); } catch (e) { /* */ }
      } else {
        if (chosen && btns[idx]) btns[idx].classList.add('no');
        if (msg) {
          msg.className = 'pb2-rvmsg bad';
          const ansTxt = (it.choices.find((c) => c.ok) || {}).v || it.ans || '';
          msg.textContent = '❌ 정답은 「' + ansTxt + '」';
        }
        try { Sound.wrong(); } catch (e) { /* */ }
      }
      setTimeout(() => {
        if (!PB.rv) return;
        PB.rv.i += 1;
        Review.paint();
      }, 1050);
    },

    finish() {
      const rv = PB.rv;
      const body = q('#pb2ReviewBody');
      const foot = q('#pb2ReviewFoot');
      if (!body || !rv) return;
      const all = rv.right === rv.items.length;
      const reward = all ? 'hyper' : 'super';
      if (!rv.done) {
        rv.done = true;
        Balls.add(reward === 'hyper' ? { hyper: 1 } : { super: 1 }, true);
      }
      body.innerHTML = '<div class="pb2-rvdone">'
        + '<div class="big">' + (all ? '🎉' : '💪') + '</div>'
        + '<h3>' + (all ? '복습 완벽해요!' : '복습 완료!') + '</h3>'
        + '<p>' + rv.items.length + '문제 중 <b>' + rv.right + '문제</b> 정답 · 보너스 '
        + (reward === 'hyper' ? '하이퍼볼 ×1' : '슈퍼볼 ×1') + '</p>'
        + '<p style="color:#8a7a3a">복습한 문제는 이제 자신 있어요!</p>'
        + '</div>';
      if (foot) foot.hidden = false;
      try { Sound.fanfare(); } catch (e) { /* */ }
      UI.renderBalls();
    },
  };

  /* ---------- 15. 데이터 · 초기화 ---------- */
  function loadEvoMap() {
    fetch('./evo-map.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((o) => { if (o && o.next) PB.evo = o.next; })
      .catch(() => { /* 진화 데이터 없으면 진화 등장만 생략 */ });
  }

  function loadAll() {
    Partner.load();
    Balls.load();
    Shiny.load();
  }

  function init() {
    UI.stage();
    UI.balls();
    UI.missionBtn();
    UI.modals();
    UI.timerGrid();
    UI.rank();
    loadAll();
    UI.partner();
    UI.missionBadge();
    UI.timer();
    UI.paintTimerGrid();
    TimerHook.attach();
    AnswerHook.attach();
    TimeoutHook.attach();
    SpawnHook.attach();
    CaptureHook.attach();
    DexHook.attach();
    TimerHook.confirm();
    loadEvoMap();
    try { SpawnHook.onEncounter({ silent: true }); } catch (e) { warn('init encounter', e); }
    /* 프로필을 바꾸면 그 친구의 파트너·볼·랭크로 다시 그린다 */
    const origApply = window.applyProfile;
    if (typeof origApply === 'function' && !origApply.__pb2) {
      const a = function () {
        const out = origApply.apply(this, arguments);
        try {
          loadAll();
          UI.partner();
          UI.renderBalls();
          UI.rank();
          UI.missionBadge();
          UI.timer();
        } catch (e) { warn('applyProfile', e); }
        return out;
      };
      a.__pb2 = true;
      window.applyProfile = a;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* 검증·디버그용 최소 공개 API */
  window.PB2 = {
    state: PB,
    partnerId: () => PB.partnerId,
    setPartner(id) { return Partner.set(id); },
    partnerModal() { UI.partnerModal(); },
    caughttle() { return Array.from((S.dex && S.dex.ids) || []); },
    balls: () => Object.assign({}, PB.balls),
    grant(add) { Balls.add(add, true); },
    combo: () => PB.combo,
    wrong: () => PB.wrong.slice(),
    shiny: () => Array.from(PB.shiny),
    mission: () => Mission.get(),
    timerOff: () => TimerPref.off(),
    theme: () => (q('#pb2Bg') ? q('#pb2Bg').dataset.theme : ''),
    rank: () => rankOf((S.dex && S.dex.ids) ? S.dex.ids.size : 0),
    forceSpawn(opts) {
      const o = opts || {};
      if (o.dex) {
        Object.keys(o.dex).forEach((id) => {
          S.dex.ids.add(Number(id));
          S.dex.counts[Number(id)] = o.dex[id];
        });
      }
      PB.evo = PB.evo || {};
      const orig = window.pickWild;
      window.pickWild = function () {
        const t = byId(o.id) || byId(25);
        return Object.assign({}, t, { level: 5, cp: 50, evolved: !!o.evolved, shiny: !!o.shiny });
      };
      newEncounter({ silent: true });
      window.pickWild = orig;
    },
    fireAt(type, back) {
      const p = q('#pb2Partner');
      const w = q('#wildWrap');
      if (back) fire(w, p, type || '불꽃', { back: true });
      else fire(p, w, type || '불꽃', {});
    },
    cry(id) { playCry(id || (S.wild && S.wild.id) || 25, true); },
    openMission() { UI.missionModal(); },
    openReview() { Review.open(); },
    reviewState() { return PB.rv; },
    markMission(g) { return Mission.mark(g || GAME); },
    settingsConfirm() { const b = q('#pb2SetConfirm'); if (b) b.click(); },
  };
})();
