/*!
 * content-engine.js — 올인원 콘텐츠 스튜디오 생성 엔진
 * ------------------------------------------------------------------
 * 브라우저(window.CS_ENGINE)와 서버(api/youtube-summary.js 의 require)가
 * 같은 파일을 쓰는 UMD 모듈이다. (Vercel 은 public/ 도 함수 번들에 포함한다)
 *
 * 원칙 — "없는 사실은 만들지 않는다"
 *  - 주식·특가 모드: /api/stock-live · /api/tabs-live · deals.html 의 실측 데이터만 문장 재료로 쓴다.
 *  - 유튜브 모드: 실제 자막 문장에서 뽑은 문장만 쓴다(추출 요약). 자막이 없으면 요약을 지어내지 않는다.
 *  - 자유 주제 모드: 사용자가 넣은 키워드·메모 문장만 쓴다. 빈 자리는 [ ] 로 남긴다.
 *  - LLM API 키 없이 도는 규칙 기반 엔진이므로, 문장은 '실데이터 + 템플릿 조합'이다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CS_ENGINE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  /* ============================================================
   * 0. 공통 유틸
   * ============================================================ */
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  function pad2(n) { return String(n).padStart(2, '0'); }

  function num(n, digits) {
    if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '-';
    const d = digits === undefined ? 2 : digits;
    return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: d });
  }

  function pct(n, digits) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '-';
    const v = Number(n);
    const d = digits === undefined ? 2 : digits;
    return (v > 0 ? '+' : '') + v.toFixed(d) + '%';
  }

  function arrow(n) {
    const v = Number(n);
    if (Number.isNaN(v)) return '·';
    return v > 0 ? '▲' : (v < 0 ? '▼' : '–');
  }

  function won(n) {
    if (n === null || n === undefined || n === '') return '-';
    return num(n, 0) + '원';
  }

  function clamp(s, n) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (t.length <= n) return t;
    return t.slice(0, n - 1).trim() + '…';
  }

  function kstNow(now) {
    const base = now ? new Date(now) : new Date();
    const kst = new Date(base.getTime() + 9 * 3600 * 1000);
    return {
      date: kst,
      y: kst.getUTCFullYear(),
      m: kst.getUTCMonth() + 1,
      d: kst.getUTCDate(),
      hh: kst.getUTCHours(),
      mm: kst.getUTCMinutes(),
      dow: kst.getUTCDay(),
      label: `${kst.getUTCFullYear()}.${pad2(kst.getUTCMonth() + 1)}.${pad2(kst.getUTCDate())}(${WEEKDAYS[kst.getUTCDay()]})`,
      short: `${kst.getUTCMonth() + 1}/${kst.getUTCDate()}`,
      time: `${pad2(kst.getUTCHours())}:${pad2(kst.getUTCMinutes())}`
    };
  }

  function dedupe(arr) {
    const seen = new Set();
    const out = [];
    arr.forEach(function (v) {
      const k = String(v).trim();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(k);
    });
    return out;
  }

  /* ============================================================
   * 1. 한국어 문장·단어 처리
   * ============================================================ */
  const STOP = new Set(('그 저 것 수 등 및 그리고 그래서 그러나 하지만 그런데 그러면 이렇게 저렇게 그렇게 ' +
    '우리 너희 여러분 이 그 저 그것 이것 저것 있다 없다 합니다 입니다 됩니다 하는 있는 없는 위한 통해 대해 ' +
    '때 경우 정도 부분 생각 얘기 이야기 지금 오늘 어제 내일 정말 진짜 너무 아주 매우 계속 다시 먼저 사실 ' +
    '근데 뭐 좀 잘 안 못 더 덜 왜 어떤 무슨 누가 언제 어디 어떻게 왜냐하면 따라서 또한 즉 예를 들어 ' +
    '합니다입니다 그리고 또 혹은 또는 하지만 그래도 그거 저거 여기 저기 요즘 최근 현재 바로 함께 같이 ' +
    '보다 이제 그게 저게 이거 그거 사실상 약간 조금 많이 가장 첫 번째 두 번째 세 번째 마지막 ' +
    '하는데 하니까 하면 하고 해서 했다 한다 됐다 되는 되고 되어 이라 이라는 라는 이라는 걸 거를 게 ' +
    '에서 으로 로써 부터 까지 만큼 보다 처럼 이랑 랑 과 와 은 는 이 가 을 를 의 에 도 만').split(/\s+/));

  function normalizeText(raw) {
    return String(raw || '')
      .replace(/\r\n?/g, '\n')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\[(음악|박수|웃음|웃음소리|음향|효과음|자막|광고|BGM|Music)\]/gi, ' ')
      .replace(/\((음악|박수|웃음|웃음소리|음향|효과음|자막|광고|BGM|Music)\)/gi, ' ')
      .replace(/[ \t\u00a0]+/g, ' ')
      .trim();
  }

  /** "00:01:23.400 --> 00:01:25.000" 같은 타임코드 줄 추출 */
  function parseTimecode(line) {
    const src = String(line);
    // 1) hh:mm:ss,mmm  /  mm:ss.mmm  /  hh:mm:ss.mmm
    let m = src.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?[.,](\d{1,3})/);
    if (m) {
      const h = Number(m[1]), mi = Number(m[2]);
      if (m[3] !== undefined) return h * 3600 + mi * 60 + Number(m[3]) + Number('0.' + m[4]);
      return h * 60 + mi + Number('0.' + m[4]);
    }
    // 2) 소수점 없는 mm:ss / hh:mm:ss  ("00:12 문장" 형태)
    m = src.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s|$)/);
    if (m) {
      return m[3] === undefined ? Number(m[1]) * 60 + Number(m[2]) : Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
    return null;
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    if (h > 0) return `${h}:${pad2(m)}:${pad2(ss)}`;
    return `${pad2(m)}:${pad2(ss)}`;
  }

  /** SRT / VTT / YouTube 스크립트(타임스탬프+문장) 모두 받아 세그먼트로 */
  function parseTranscript(raw) {
    const src = String(raw || '').replace(/\r\n?/g, '\n');
    const segments = [];
    if (!src.trim()) return { segments: segments, text: '' };

    // VTT/SRT 블록 형태
    const blocks = src.split(/\n{2,}/);
    let usedCue = false;
    blocks.forEach(function (block) {
      const lines = block.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      if (!lines.length) return;
      let ti = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/-->/.test(lines[i])) { ti = i; break; }
      }
      if (ti === -1) return;
      const start = parseTimecode(lines[ti]);
      const body = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, ' ').trim();
      if (!body) return;
      usedCue = true;
      segments.push({ t: start === null ? null : start, text: body });
    });

    // YouTube 스크립트 패널 복사본: "0:12\n문장" 또는 "0:12 문장"
    if (!usedCue) {
      src.split('\n').forEach(function (line) {
        const t = line.trim();
        if (!t) return;
        const m = t.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/);
        if (m && m[2]) segments.push({ t: parseTimecode(m[1]), text: m[2] });
        else segments.push({ t: null, text: t });
      });
    }

    // 한 줄로 붙어 들어온 경우(세그먼트 없음) → 통짜 문장으로
    const text = segments.map(function (s) { return s.text; }).join(' ').replace(/\s+/g, ' ').trim();
    return { segments: segments, text: text };
  }

  function tokenize(text) {
    const out = [];
    const src = String(text || '');
    const re = /[가-힣]{2,}|[A-Za-z]{2,}|\d+(?:[.,]\d+)?%?/g;
    let m;
    while ((m = re.exec(src))) {
      let w = m[0];
      if (/^\d/.test(w)) { out.push(w); continue; }
      if (STOP.has(w)) continue;
      // 한 글자 조사 제거(간단 처리): '코스피는' → '코스피'
      w = w.replace(/(은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만|보다|처럼|께서|에게|에는|에도|부터|까지|이라|라는|라고|라고는)$/, '');
      if (w.length < 2 || STOP.has(w)) continue;
      out.push(w);
    }
    return out;
  }

  function keywordRank(textOrTokens, limit) {
    const tokens = Array.isArray(textOrTokens) ? textOrTokens : tokenize(textOrTokens);
    const freq = Object.create(null);
    tokens.forEach(function (w) {
      const key = String(w);
      freq[key] = (freq[key] || 0) + 1;
    });
    return Object.keys(freq)
      .map(function (w) { return { w: w, n: freq[w] }; })
      .filter(function (x) { return x.w.length >= 2; })
      .sort(function (a, b) { return b.n - a.n || b.w.length - a.w.length; })
      .slice(0, limit || 12);
  }

  function splitSentences(text) {
    const src = normalizeText(text);
    const parts = src.split(/(?<=[.!?。！？])\s+|\n+/);
    const out = [];
    parts.forEach(function (p) {
      let t = p.trim();
      if (!t) return;
      // 한국어 어미로 문장 나누기(마침표 없는 자막 대응)
      const chunks = t.split(/(?<=다\.|요\.|죠\.|까\?|니다\.|세요\.|어요\.)\s*/);
      chunks.forEach(function (c) {
        const s = c.trim();
        if (s.length < 6) return;
        // (음악) (웃음) 같은 효과음 큐는 요약 재료에서 제외
        if (/^[\(\[][^\)\]]{0,40}[\)\]]$/.test(s)) return;
        if (/^[^\w가-힣]*$/.test(s)) return;
        out.push(s);
      });
    });
    return out;
  }

  const CUE_STRONG = /(핵심|중요|포인트|결론|정리하면|요약|반드시|꼭|주의|위험|기회|때문에|이유는|첫째|둘째|셋째|결국|사실은)/;
  const CUE_WEAK = /^(그래서|그런데|그러면|그리고|또|자|이제|여기서|근데)\s/;

  /** 추출 요약: 문장 점수 → 중복 제거 → 시간순 상위 N개 */
  function summarizeText(input, options) {
    // summarizeText({text, segments, maxLines}) 또는 summarizeText(text, {maxLines}) 둘 다 지원
    const opts = (typeof input === 'string')
      ? Object.assign({ text: input }, options || {})
      : Object.assign({}, input || {}, options || {});
    const maxLines = opts.maxLines || 5;
    let sentences = [];

    if (opts.segments && opts.segments.length) {
      const segs = opts.segments.filter(function (s) { return s && s.text; });
      const total = segs.length || 1;
      segs.forEach(function (s, i) {
        splitSentences(s.text).forEach(function (sent) {
          sentences.push({ text: sent, t: s.t, pos: i / total, order: sentences.length });
        });
      });
    } else {
      const list = splitSentences(opts.text || '');
      list.forEach(function (sent, i) {
        sentences.push({ text: sent, t: null, pos: list.length ? i / list.length : 0 });
      });
    }

    if (!sentences.length) return [];

    const tokens = [];
    sentences.forEach(function (s) { tokens.push.apply(tokens, tokenize(s.text)); });
    const freq = Object.create(null);
    tokens.forEach(function (w) { freq[w] = (freq[w] || 0) + 1; });
    const maxFreq = Math.max.apply(null, Object.keys(freq).map(function (k) { return freq[k]; }).concat([1]));

    sentences.forEach(function (s) {
      const words = tokenize(s.text);
      let score = 0;
      words.forEach(function (w) { score += (freq[w] || 0) / maxFreq; });
      score = score / Math.sqrt(Math.max(4, words.length));
      // 숫자·퍼센트·금액: 사실 밀도가 높은 문장
      const numbers = (s.text.match(/\d+(?:[.,]\d+)?\s*(?:%|퍼센트|억|조|만|원|배|개|명|위|년|월|일|분|초)?/g) || []).length;
      score += Math.min(1.2, numbers * 0.16);
      if (CUE_STRONG.test(s.text)) score += 0.35;
      if (CUE_WEAK.test(s.text)) score -= 0.1;
      // 위치: 도입부와 결론부 가중
      if (s.pos < 0.12) score += 0.25;
      if (s.pos > 0.82) score += 0.3;
      const len = s.text.length;
      if (len < 12) score -= 0.3;
      if (len > 140) score -= 0.25;
      s.score = score;
    });

    const ranked = sentences.slice().sort(function (a, b) { return b.score - a.score; });
    const picked = [];
    ranked.forEach(function (cand) {
      if (picked.length >= maxLines) return;
      const cw = new Set(tokenize(cand.text));
      let tooClose = false;
      picked.forEach(function (p) {
        const pw = new Set(tokenize(p.text));
        let inter = 0;
        cw.forEach(function (w) { if (pw.has(w)) inter++; });
        const jac = inter / Math.max(1, Math.min(cw.size, pw.size));
        if (jac > 0.55) tooClose = true;
      });
      if (tooClose) return;
      picked.push(cand);
    });

    // 시간순 정렬 유지(자막이 있으면 타임스탬프 순)
    if (picked.length && picked[0].t !== null && picked[0].t !== undefined) {
      picked.sort(function (a, b) {
        const dt = (a.t || 0) - (b.t || 0);
        return dt !== 0 ? dt : (a.order || 0) - (b.order || 0);
      });
    }
    return picked.map(function (p) {
      return { text: clamp(p.text, 220), t: p.t === undefined ? null : p.t, score: p.score };
    });
  }

  /** 상위 키워드로 문단 제목 만들기 */
  function headingFor(texts) {
    const rank = keywordRank(texts.join(' '), 3).map(function (x) { return x.w; });
    return rank.length ? rank.join(' · ') : '이야기';
  }

  /* ============================================================
   * 2. 블로그·쇼츠 공통 빌더
   * ============================================================ */
  function buildHashtags(seed, mode) {
    const base = {
      stock: ['#주식', '#코스피', '#코스닥', '#국내증시', '#주도테마', '#매매일지', '#시황', '#투자공부'],
      deals: ['#동탄', '#동탄나들이', '#가족나들이', '#키즈카페', '#여행특가', '#주말나들이', '#4인가족', '#특가'],
      video: ['#유튜브요약', '#영상정리', '#핵심요약', '#쇼츠', '#정보정리'],
      topic: ['#블로그', '#콘텐츠', '#정보공유', '#글쓰기']
    }[mode] || ['#콘텐츠'];
    const extra = (seed || []).slice(0, 6).map(function (w) {
      const t = String(w).replace(/[^\w가-힣]/g, '');
      return t.length >= 2 ? '#' + t : '';
    });
    return dedupe(base.concat(extra)).slice(0, 12);
  }

  function buildSeoMeta(content) {
    const mode = content.mode;
    const kst = kstNow();
    const kw = content.keywords && content.keywords.length ? content.keywords.slice(0, 3).join(' · ') : '콘텐츠';
    let meta = '';
    if (mode === 'stock') meta = `${kst.short} 국내 증시 마감 정리 — ${clamp(content.headline, 55)}. 주도 테마·신고가·상한가·주요 뉴스까지 실측 데이터로 정리했습니다.`;
    else if (mode === 'deals') meta = `${clamp(content.headline, 60)} — 동탄 4인 가족 기준 가격·주차·이동 시간까지 한 번에 비교했습니다.`;
    else if (mode === 'video') meta = `${clamp(content.headline, 60)} — 영상에서 실제로 말한 내용만 추려 5줄 요약과 정리글로 만들었습니다.`;
    else meta = `${clamp(content.headline, 60)} — ${kw} 핵심만 정리한 글.`;
    return clamp(meta, 155);
  }

  function buildCta(mode) {
    if (mode === 'stock') return '오늘 시황이 도움이 됐다면 구독·알림 설정해 두세요. 매 거래일 마감 후 실제 수치로 정리해 올립니다. (본 글은 정보 정리이며 투자 권유가 아닙니다. 투자 판단과 책임은 투자자 본인에게 있습니다.)';
    if (mode === 'deals') return '이번 주말 계획 세우실 때 저장해 두고 예약 화면에서 가격·운영시간을 한 번 더 확인하세요. 새 특가가 확인되면 다시 정리해 올립니다.';
    if (mode === 'video') return '영상 전체가 궁금하시면 원본 링크를 확인해 보세요. 다른 영상도 링크만 주시면 같은 방식으로 정리해 드립니다.';
    return '궁금한 점이나 추가로 정리했으면 하는 부분은 댓글로 남겨 주세요.';
  }

  /** 50초 쇼츠 대본: 후킹 3초 → 본론 3블록 → 마무리 CTA */
  function buildShortsScript(opts) {
    const hook = clamp(opts.hook || '', 60);
    const blocks = (opts.blocks || []).filter(Boolean).slice(0, 4);
    const cta = clamp(opts.cta || '더 자세한 내용은 고정 댓글 링크에서 확인하세요.', 80);
    const total = opts.total || 50;

    const plan = [];
    plan.push({ sec: 3, role: '후킹', text: hook || '지금 확인해야 할 내용, 50초로 정리합니다.' });
    const bodyBudget = total - 3 - 8; // 후킹 3초 + CTA 8초
    const each = Math.max(6, Math.floor(bodyBudget / Math.max(1, blocks.length)));
    blocks.forEach(function (b, i) {
      plan.push({ sec: each, role: `본론 ${i + 1}`, text: clamp(b, 130) });
    });
    plan.push({ sec: 8, role: '마무리', text: cta });

    let acc = 0;
    const timeline = plan.map(function (p) {
      const start = acc;
      acc += p.sec;
      return { start: start, end: acc, role: p.role, text: p.text, label: fmtTime(start) };
    });
    const duration = acc;

    // 자막(SRT)
    const srt = timeline.map(function (t, i) {
      return `${i + 1}\n${srtTime(t.start)} --> ${srtTime(t.end)}\n${t.text}\n`;
    }).join('\n');

    const plain = timeline.map(function (t) { return `[${t.label}] (${t.role}) ${t.text}`; }).join('\n');

    return {
      total: duration,
      hook: hook,
      blocks: timeline,
      srt: srt,
      plain: plain,
      hashtags: opts.hashtags || []
    };
  }

  function srtTime(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${pad2(h)}:${pad2(m)}:${pad2(ss)},${String(ms).padStart(3, '0')}`;
  }

  function contentToMarkdown(content) {
    const b = content.blog;
    const lines = [];
    lines.push(`# ${b.titles[0]}`);
    lines.push('');
    if (content.source && content.source.label) {
      lines.push(`> 출처: ${content.source.label}${content.source.asOf ? ' · ' + content.source.asOf : ''}`);
      lines.push('');
    }
    if (b.intro) { lines.push(b.intro); lines.push(''); }
    b.sections.forEach(function (s) {
      lines.push(`## ${s.h2}`);
      (s.paras || []).forEach(function (p) { lines.push(''); lines.push(p); });
      if (s.items && s.items.length) {
        lines.push('');
        s.items.forEach(function (it) { lines.push(`- ${it}`); });
      }
      lines.push('');
    });
    lines.push('## 마무리');
    lines.push('');
    lines.push(b.cta);
    lines.push('');
    if (b.tags && b.tags.length) lines.push(b.tags.join(' '));
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  function shortsToText(shorts) {
    return [`■ 50초 쇼츠 대본 (${shorts.total}초)`, ''].concat(
      shorts.blocks.map(function (b) { return `[${b.label} · ${b.role}] ${b.text}`; }),
      ['', '■ 해시태그', (shorts.hashtags || []).join(' ')]
    ).join('\n');
  }

  function blogTitleCandidates(subject, mode, kst) {
    const s = clamp(subject, 46);
    const dateShort = kst ? kst.short : '';
    if (mode === 'stock') {
      return [
        `${dateShort} 국내 증시 마감 총정리 — ${s}`,
        `${s} | 코스피·코스닥 흐름과 주도 테마 3가지`,
        `오늘 장, 무엇이 올랐나 — ${s}`
      ];
    }
    if (mode === 'deals') {
      return [
        `${dateShort} 동탄 4인 가족 나들이 추천 — ${s}`,
        `이번 주말 아이와 어디 갈까? ${s}`,
        `${s} (가격·주차·이동시간 비교)`
      ];
    }
    if (mode === 'video') {
      return [
        `${s} — 영상 핵심 5줄 요약`,
        `"${clamp(s, 34)}" 영상 정리, 3분이면 충분합니다`,
        `${s} | 자막으로 직접 확인한 핵심 정리`
      ];
    }
    return [
      `${s} — 한 번에 정리했습니다`,
      `${s}, 이렇게 보면 쉽습니다`,
      `${s} 핵심만 뽑은 정리 노트`
    ];
  }

  function finishContent(content) {
    content.blog.metaDesc = buildSeoMeta(content);
    content.blog.cta = content.blog.cta || buildCta(content.mode);
    content.blog.tags = content.blog.tags && content.blog.tags.length
      ? content.blog.tags
      : buildHashtags(content.keywords || [], content.mode);
    content.shorts.hashtags = content.blog.tags;
    content.blog.markdown = contentToMarkdown(content);
    content.shorts.plain = shortsToText(content.shorts);
    content.generatedAt = kstNow().label + ' ' + kstNow().time;
    content.engine = 'content-engine ' + VERSION;
    return content;
  }

  /* ============================================================
   * 3. 📈 주식 관제탑 모드
   * ============================================================ */
  function themeLine(theme) {
    const top = (theme.stocks || []).slice(0, 2).map(function (s) {
      return `${s.name} ${num(s.price, 0)}원(${pct(s.changePct)})`;
    });
    return `${theme.name} — 평균 ${pct(theme.avgPct)}, 합산 거래대금 ${theme.sumValueText || num(theme.sumValue, 0) + '원'}${top.length ? ' · 대표 ' + top.join(', ') : ''}`;
  }

  function buildFromStocks(payload) {
    const live = payload.live || {};
    const tabs = payload.tabs || {};
    const kst = kstNow();
    const indices = live.indices || [];
    const kospi = indices.find(function (i) { return i.key === 'KOSPI'; }) || indices[0] || {};
    const kosdaq = indices.find(function (i) { return i.key === 'KOSDAQ'; }) || indices[1] || {};
    const fx = live.fx || {};
    const futures = (live.futures || [])[0] || {};
    const themes = (tabs.themes || []).slice(0, 3);
    const high52 = (tabs.high52 && tabs.high52.byValue) || [];
    const upper = tabs.upperLimit || {};
    const confirmed = upper.confirmed || [];
    const near = upper.near || [];
    const news = (tabs.news || []).slice(0, 3);
    const sessionLabel = tabs.sessionLabel || '';
    const closed = /휴장|마감|CLOSE/.test(String(tabs.sessionPhase || '')) || live.marketStatus === 'CLOSE';
    const basis = tabs.generatedAtLabel || live.generatedAtKst || '';
    const isWeekend = kst.dow === 0 || kst.dow === 6;

    const headlineBase = `코스피 ${num(kospi.price)} ${arrow(kospi.changePct)} ${pct(kospi.changePct)}`;
    const headline = isWeekend ? `${kst.short} 주말 결산 — ${headlineBase}` : `${kst.short} 국내 증시 마감 — ${headlineBase}`;

    const pills = [
      `코스피 ${num(kospi.price)} (${pct(kospi.changePct)})`,
      `코스닥 ${num(kosdaq.price)} (${pct(kosdaq.changePct)})`,
      fx.price ? `원/달러 ${num(fx.price, 1)}원` : '',
      futures.price ? `나스닥선물 ${num(futures.price)} (${pct(futures.changePct)})` : ''
    ].filter(Boolean);

    const facts = [];
    if (kospi.price) facts.push({ k: '코스피', v: `${num(kospi.price)} (${pct(kospi.changePct)}) · 거래대금 ${kospi.valueText || '-'}` });
    if (kosdaq.price) facts.push({ k: '코스닥', v: `${num(kosdaq.price)} (${pct(kosdaq.changePct)}) · 거래대금 ${kosdaq.valueText || '-'}` });
    if (fx.price) facts.push({ k: '원/달러', v: `${num(fx.price, 1)}원 (${pct(fx.changePct)})` });
    if (futures.price) facts.push({ k: futures.name || '나스닥 선물', v: `${num(futures.price)} (${pct(futures.changePct)})` });
    themes.forEach(function (t, i) { facts.push({ k: `주도 테마 ${i + 1}`, v: t.name + ' · 평균 ' + pct(t.avgPct) + ' · ' + (t.sumValueText || '') }); });
    if (confirmed.length) facts.push({ k: '상한가 확정', v: confirmed.map(function (s) { return `${s.name} ${pct(s.changePct)}`; }).join(', ') });
    if (near.length) facts.push({ k: '상한가 임박', v: near.map(function (s) { return `${s.name} ${pct(s.changePct)}`; }).join(', ') });
    if (high52.length) facts.push({ k: '52주 신고가', v: `${(tabs.high52.counts ? (tabs.high52.counts.KOSPI + tabs.high52.counts.KOSDAQ) : high52.length)}종목 · 대표 ${high52.slice(0, 3).map(function (s) { return s.name; }).join(', ')}` });

    /* ---- 5줄 요약: 실측 수치만 ---- */
    const summary = [];
    if (kospi.price) {
      summary.push(`코스피는 ${num(kospi.price)}(${pct(kospi.changePct)})로 ${Number(kospi.changePct) >= 0 ? '상승' : '하락'} 마감했습니다. 거래대금은 ${kospi.valueText || '-'}입니다.`);
    }
    if (kosdaq.price) {
      summary.push(`코스닥은 ${num(kosdaq.price)}(${pct(kosdaq.changePct)})를 기록했습니다. 거래대금은 ${kosdaq.valueText || '-'}입니다.`);
    }
    if (themes.length) {
      summary.push(`주도 테마 1위는 ${themes[0].name}로, 평균 ${pct(themes[0].avgPct)}에 합산 거래대금 ${themes[0].sumValueText || '-'}를 기록했습니다.`);
    }
    if (confirmed.length || near.length) {
      summary.push(`${confirmed.length ? '상한가 확정 ' + confirmed.length + '종목(' + confirmed.slice(0, 3).map(function (s) { return s.name; }).join(', ') + ')' : ''}${confirmed.length && near.length ? ', ' : ''}${near.length ? '상한가 임박 ' + near.length + '종목(' + near.slice(0, 3).map(function (s) { return s.name; }).join(', ') + ')' : ''}이 거래대금 100억 이상 기준으로 잡혔습니다.`);
    } else {
      summary.push('거래대금 100억 이상 · +25% 기준을 통과한 상한가·임박 종목은 없었습니다.');
    }
    const fxLine = fx.price
      ? `원/달러는 ${num(fx.price, 1)}원(${pct(fx.changePct)})${futures.price ? `, ${futures.name || '나스닥 선물'}은 ${num(futures.price)}(${pct(futures.changePct)})` : ''}입니다.`
      : '';
    if (news.length) {
      summary.push(`주요 뉴스는 "${clamp(news[0].title, 62)}"(${news[0].press || '언론사'}) 등이며 ${news[0].impactDirection || '중립'}(${news[0].impactLevel || '-'}) 신호로 분류됐습니다. ${fxLine}`.trim());
    } else {
      summary.push(('특이 뉴스가 수집되지 않았습니다. ' + fxLine).trim());
    }

    /* ---- 블로그 ---- */
    const sections = [];
    sections.push({
      h2: '오늘 시장 한눈에',
      paras: [
        `${isWeekend ? '주말 휴장 기준으로 직전 거래일' : '오늘'} 증시는 ${headlineBase}로 마무리됐습니다. 코스닥은 ${num(kosdaq.price)}(${pct(kosdaq.changePct)})를 기록했고, 코스피 거래대금은 ${kospi.valueText || '-'}였습니다.`,
        fx.price ? `환율은 원/달러 ${num(fx.price, 1)}원(${pct(fx.changePct)})에서 움직였고, ${futures.price ? `${futures.name || '나스닥 선물'}은 ${num(futures.price)}(${pct(futures.changePct)})로 ` : ''}${futures.price ? '해외 선행 지표도 함께 확인할 수 있습니다.' : '해외 지표는 별도 확인이 필요합니다.'}` : '환율·해외 지표는 수집되지 않았습니다.'
      ],
      items: facts.map(function (f) { return `${f.k}: ${f.v}`; })
    });

    if (themes.length) {
      sections.push({
        h2: '주도 테마 — 오늘 돈이 몰린 곳',
        paras: [
          `오늘 상위 테마는 ${themes.map(function (t) { return t.name; }).join(', ')} 순으로 정렬됐습니다. 정렬 기준은 평균 등락률이며, 각 테마의 1~4등 합산 거래대금을 함께 봐야 실제 자금 유입을 가늠할 수 있습니다.`
        ],
        items: themes.map(function (t) { return themeLine(t); })
      });
    }

    if (high52.length || confirmed.length || near.length) {
      sections.push({
        h2: '신고가 · 상한가 — 대금이 붙은 종목만',
        paras: [
          `52주 신고가는 ${tabs.high52 && tabs.high52.counts ? `${tabs.high52.counts.KOSPI}개(코스피) · ${tabs.high52.counts.KOSDAQ}개(코스닥)` : high52.length + '종목'}가 잡혔습니다. 상한가 판정은 거래대금 100억 이상 · 상승률 +25% 이상 기준을 통과한 종목만 인정하고, 이 기준을 못 넘은 종목은 '관찰'로 따로 분리합니다.`
        ],
        items: []
          .concat(confirmed.slice(0, 5).map(function (s) { return `상한가 확정: ${s.name}(${s.code}) ${pct(s.changePct)} · 거래대금 ${s.valueText || '-'}`; }))
          .concat(near.slice(0, 5).map(function (s) { return `상한가 임박: ${s.name}(${s.code}) ${pct(s.changePct)} · 거래대금 ${s.valueText || '-'}`; }))
          .concat(high52.slice(0, 5).map(function (s) { return `52주 신고가: ${s.name}(${s.code}) ${pct(s.changePct)} · 거래대금 ${s.valueText || '-'}`; }))
      });
    }

    if (news.length) {
      sections.push({
        h2: '오늘의 뉴스 체크',
        paras: ['기사 제목과 요약에서 뽑은 키워드로 영향도·테마를 자동 분류했습니다. 숫자와 함께 봐야 할 기사만 골랐습니다.'],
        items: news.map(function (n) {
          return `${n.title} (${n.press || ''} ${n.time || ''}) — ${n.impactDirection || '중립'} · ${n.impactLevel || '-'}${n.impactNote ? ' · ' + n.impactNote : ''}`;
        })
      });
    }

    sections.push({
      h2: '내일 체크 포인트',
      paras: [
        `① 주도 테마가 이틀 연속 유지되는지 ② 상한가 종목의 다음 날 시초가와 거래대금 유지 여부 ③ 환율·해외 선물의 야간 방향 — 이 세 가지를 먼저 보면 됩니다. 오늘 수치는 ${basis || kst.label + ' ' + kst.time} 기준 실측입니다.`
      ],
      items: []
    });

    const hook = `코스피 ${num(kospi.price)}, ${pct(kospi.changePct)}. 오늘 돈이 몰린 테마는?`;
    const blocks = [];
    if (kospi.price) blocks.push(`코스피 ${num(kospi.price)} ${pct(kospi.changePct)}, 코스닥 ${num(kosdaq.price)} ${pct(kosdaq.changePct)}로 마감했습니다.`);
    if (themes[0]) blocks.push(`1위 테마는 ${themes[0].name}. 평균 ${pct(themes[0].avgPct)}, 거래대금 ${themes[0].sumValueText || '-'} 규모입니다.`);
    if (confirmed.length) blocks.push(`상한가 확정은 ${confirmed.slice(0, 2).map(function (s) { return s.name; }).join(', ')}. 거래대금 100억을 넘긴 종목만 셌습니다.`);
    else if (high52.length) blocks.push(`52주 신고가 ${high52.slice(0, 2).map(function (s) { return s.name; }).join(', ')} 등, 대금이 붙은 종목만 골랐습니다.`);

    const content = {
      mode: 'stock',
      source: {
        label: '주식 관제탑 실시간 (/api/stock-live · /api/tabs-live)',
        url: '/index.html',
        asOf: basis
      },
      headline: headline,
      subline: themes.length ? `주도 테마 ${themes[0].name} · ${pct(themes[0].avgPct)}` : '',
      pills: pills,
      facts: facts,
      keywords: themes.map(function (t) { return t.name.split(' ·')[0]; }).concat(['코스피', '코스닥']),
      summary: summary,
      blog: {
        titles: blogTitleCandidates(`코스피 ${num(kospi.price)} ${pct(kospi.changePct)} 마감, ${themes[0] ? themes[0].name + ' 주도' : '테마 혼조'}`, 'stock', kst),
        intro: `${kst.short} 국내 증시를 숫자로만 정리했습니다. 코스피 ${num(kospi.price)}(${pct(kospi.changePct)}), 코스닥 ${num(kosdaq.price)}(${pct(kosdaq.changePct)}). 아래 내용은 관제탑이 실시간으로 받아온 값 그대로이며, 추론한 시나리오는 넣지 않았습니다.`,
        sections: sections,
        cta: buildCta('stock'),
        tags: []
      },
      shorts: buildShortsScript({ hook: hook, blocks: blocks, cta: '자세한 수치와 종목 정리는 고정 댓글 링크에서 확인하세요.', total: 50 }),
      notices: [
        { level: 'info', text: `기준 시각: ${basis || '-'} · 출처: 네이버 증권 폴링 + 야후 선물` },
        sessionLabel ? { level: 'info', text: `세션 상태: ${sessionLabel}` } : null,
        isWeekend ? { level: 'warn', text: '주말 휴장 — 직전 거래일 종가 기준입니다. 실시간 시세가 아닙니다.' } : null,
        { level: 'warn', text: '수급(외국인·기관) 금액과 주간/야간 선물 일부는 확정치 또는 내장 값이며, 실시간 체결이 아닙니다.' }
      ].filter(Boolean)
    };
    return finishContent(content);
  }

  /* ============================================================
   * 4. 🎡 특가 레이더 모드
   * ============================================================ */
  function dealPriceNumber(d) {
    const txt = String(d.deal_price || d.price_info || '');
    const m = txt.replace(/,/g, '').match(/(\d{4,})/);
    return m ? Number(m[1]) : (Number(d.unit_price) || 0);
  }

  /** 표시용 가격 문구 — '정상 8,000원 → 카톡 특가 7,000원 (12% 할인)' 같은 문장에서 실제 특가만 */
  function dealPriceText(d) {
    const raw = String(d.deal_price || '').trim();
    if (/^[\d,]{3,}\s*원/.test(raw)) return raw;
    const info = String(d.price_info || '').trim();
    const arrow = info.split(/→/);
    const cand = arrow.length > 1 ? arrow[arrow.length - 1] : info;
    const matches = String(cand).match(/[\d,]{3,}\s*원~?/g) || String(raw).match(/[\d,]{3,}\s*원~?/g);
    if (matches && matches.length) return matches[matches.length - 1].replace(/\s+/g, '');
    if (info) return clamp(info.replace(/\s+/g, ' '), 40);
    return raw || '-';
  }

  /** '동탄 4인 가족' 눈높이 순서: 국내 체험/테마파크 → 국내 숙소 → 해외 */
  function pickFamilyDeals(deals, limit) {
    const A = [], B = [], C = [];
    (deals || []).forEach(function (d) {
      const overseas = /overseas/.test(String(d.type || ''));
      const lodging = /stay|resort|snow|city/.test(String(d.theme || ''))
        && !/themepark|kids_cafe|museum/.test(String(d.category || ''))
        || /호텔|리조트|풀빌라|글램핑|펜션|콘도|룸온리/.test(String(d.title || ''));
      if (overseas) C.push(d);
      else if (lodging) B.push(d);
      else A.push(d);
    });
    const quotaA = Math.min(A.length, Math.max(3, limit - 2));
    const out = A.slice(0, quotaA);
    if (out.length < limit) out.push.apply(out, B.slice(0, 1));
    if (out.length < limit) out.push.apply(out, C.slice(0, 1));
    if (out.length < limit) out.push.apply(out, A.slice(quotaA).concat(B.slice(1), C.slice(1)).slice(0, limit - out.length));
    return out.slice(0, limit || 5);
  }

  function titleOf(d) {
    return clamp(String((d && d.title) || '').replace(/^[^\w가-힣]+/, ''), 60);
  }

  /** 스캔 팁 문장을 문장 경계에서 자른다 */
  function tipOf(d) {
    const t = String((d && d.tips) || '')
      .replace(/^★\s*실측 확인:\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) return '';
    const cut = t.split(/(?<=[.!?])\s/)[0] || t;
    return clamp(cut, 90);
  }

  function buildFromDeals(payload) {
    const deals = payload.deals || {};
    const travel = deals.travelDeals || [];
    const kids = deals.kidsDeals || [];
    const meta = deals.meta || {};
    const kst = kstNow();
    const isWeekend = kst.dow === 0 || kst.dow === 6;
    const top = pickFamilyDeals(kids.concat(travel), 5);
    const kidsTop = pickFamilyDeals(kids, 3);
    const travelTop = pickFamilyDeals(travel, 2);

    const headline = `동탄 4인 가족 ${isWeekend ? '이번 주말' : '다음 주말'} 이 가격에 가볼 만한 곳 ${top.length}곳`;
    const pills = top.slice(0, 4).map(function (d) { return clamp(titleOf(d), 22); });

    const facts = top.map(function (d) {
      return { k: clamp(titleOf(d), 26), v: `${dealPriceText(d)} · ${d.region || d.location || ''}` };
    });

    const summary = [];
    top.slice(0, 4).forEach(function (d) {
      const price = dealPriceText(d);
      const benefit = String(d.benefit_tag || d.discount || '').replace(/\s+/g, ' ').trim();
      const dup = benefit && price.indexOf(benefit) === -1 ? ' · ' + clamp(benefit, 26) : '';
      summary.push(`${clamp(titleOf(d), 40)} — ${price}${dup}, ${d.region || d.location || ''}`);
    });
    if (meta.scannedAt) summary.push(`가격은 ${meta.scannedAt} 실측 스캔 기준이며, 예약 화면에서 날짜·인원에 따라 달라질 수 있습니다.`);

    const sections = [
      {
        h2: '이번 주말, 이 가격이면 갈 만합니다',
        paras: [
          `${meta.scannedAt ? meta.scannedAt + ' 기준으로 ' : ''}실제 판매 화면에서 확인된 가격만 골랐습니다. 후기·평점이 있는 상품은 함께 표시했고, 확인되지 않은 값은 비워 뒀습니다.`,
          isWeekend ? '오늘 바로 움직일 수 있는 곳은 이동 시간과 주차 조건을 먼저 보세요. 동탄 기준 자차 40분~1시간 30분이면 당일 코스로 충분합니다.' : '주말 예약은 금요일 저녁에 마감되는 경우가 많으니 미리 날짜를 잡아 두는 편이 좋습니다.'
        ],
        items: []
      },
      {
        h2: '아이와 가기 좋은 곳 — 키즈·실내',
        paras: ['실내 위주라 날씨 영향을 덜 받고, 미취학·초등이 함께 놀기 좋은 곳부터 정리했습니다.'],
        items: kidsTop.map(function (d) {
          return `${clamp(titleOf(d), 44)} — ${dealPriceText(d)} · ${d.location || ''}${d.tips ? ' · ' + tipOf(d) : ''}`;
        })
      },
      {
        h2: '1박으로 쉬어가는 코스',
        paras: ['숙소는 4인 기준 객실인지, 조식·부대시설이 포함인지까지 확인해야 실제 결제 금액이 맞습니다.'],
        items: travelTop.map(function (d) {
          return `${clamp(titleOf(d), 44)} — ${dealPriceText(d)} · ${d.region || ''}${d.family_fit ? ' · ' + clamp(d.family_fit, 60) : ''}`;
        })
      },
      {
        h2: '예약 전 체크리스트',
        paras: ['가격은 실측 시점 기준입니다. 결제 직전 화면에서 아래 항목을 꼭 다시 확인하세요.'],
        items: [
          '이용일·시간 지정 여부 (당일 취소 불가 상품이 많습니다)',
          '인원 기준 — 4인 기준인지, 1인권이라 4장 필요한지',
          '주차 무료 시간과 초과 요금',
          '현장 결제 항목(수영장·바베큐 등)이 따로 있는지',
          '36개월 미만 무료 여부·키 제한'
        ]
      }
    ];

    const hook = top[0] ? `${clamp(titleOf(top[0]), 30)}, ${dealPriceText(top[0])}?` : '이번 주말 동탄에서 갈 만한 곳, 정리했습니다.';
    const blocks = top.slice(0, 3).map(function (d) {
      return `${clamp(titleOf(d), 30)} ${dealPriceText(d)}.`;
    });
    blocks.push('가격은 실측 시점 기준이니 예약 화면에서 한 번 더 확인하세요.');

    const content = {
      mode: 'deals',
      source: {
        label: '패밀리 특가 레이더 (/deals.html 실측 스캔)',
        url: '/deals.html',
        asOf: meta.scannedAt || ''
      },
      headline: headline,
      subline: top[0] ? `${clamp(titleOf(top[0]), 28)} ${dealPriceText(top[0])}` : '',
      pills: pills,
      facts: facts,
      keywords: ['동탄', '가족나들이', '키즈카페', '여행특가', '주말나들이'],
      summary: summary.slice(0, 5),
      blog: {
        titles: blogTitleCandidates(`가볼 만한 곳 ${top.length}곳`, 'deals', kst),
        intro: `${kst.short} 기준 동탄 4인 가족 눈높이로 다시 골랐습니다. 여행 ${travel.length}건 · 키즈 ${kids.length}건 중에서 아이와 바로 갈 수 있는 곳, 1박으로 쉬어갈 곳을 나눠 정리했습니다.`,
        sections: sections,
        cta: buildCta('deals'),
        tags: []
      },
      shorts: buildShortsScript({ hook: hook, blocks: blocks, cta: '주소와 가격은 고정 댓글에 정리해 뒀습니다.', total: 50 }),
      notices: [
        meta.scannedAt ? { level: 'info', text: `실측 스캔: ${meta.scannedAt} · ${meta.source || ''}` } : null,
        { level: 'warn', text: '가격·운영시간은 실측 시점 기준입니다. 결제 화면에서 날짜·인원에 따라 달라집니다.' },
        { level: 'warn', text: '확인되지 않은 평점·후기·할인율은 비워 두었습니다(추정값을 넣지 않았습니다).' }
      ].filter(Boolean)
    };
    return finishContent(content);
  }

  /* ============================================================
   * 5. ▶️ 유튜브 요약 모드
   * ============================================================ */
  function buildFromVideo(payload) {
    const video = payload.video || {};
    const parsed = parseTranscript(payload.transcript || '');
    const kst = kstNow();
    const title = video.title || '유튜브 영상';
    const channel = video.channel || '';
    const points = summarizeText({ segments: parsed.segments, text: parsed.text, maxLines: 5 });
    const hasTranscript = points.length >= 1 && (parsed.text || '').length >= 60;

    if (!hasTranscript) {
      return finishContent({
        mode: 'video',
        ok: false,
        source: { label: '유튜브', url: video.url || '', asOf: kst.label },
        headline: title,
        subline: channel,
        pills: channel ? [channel] : [],
        facts: [],
        keywords: tokenize(title).slice(0, 5),
        summary: [],
        blog: { titles: blogTitleCandidates(title, 'video', kst), intro: '', sections: [], cta: buildCta('video'), tags: [] },
        shorts: buildShortsScript({ hook: title, blocks: [], cta: '', total: 50 }),
        notices: [{ level: 'warn', text: '자막이 없어 요약을 만들지 않았습니다. 가짜 요약은 생성하지 않습니다.' }],
        reason: 'no_captions'
      });
    }

    const allText = parsed.text;
    const rank = keywordRank(allText, 14).map(function (x) { return x.w; });
    const key3 = rank.slice(0, 3);
    const summary = points.map(function (p, i) {
      return (p.t !== null && p.t !== undefined ? `[${fmtTime(p.t)}] ` : '') + p.text;
    });

    const headline = clamp(title, 60);
    const subline = channel ? `${channel} · ${fmtTime(video.duration || 0)}` : '';
    const pills = [channel || '', key3.join(' · ')].filter(Boolean);

    /* 구간별 정리: 타임라인 3분할 + 각 구간의 핵심 문장 */
    const thirds = [[], [], []];
    points.forEach(function (p) {
      const t = p.t === null || p.t === undefined ? 0 : p.t;
      const dur = video.duration || (parsed.segments.length ? parsed.segments[parsed.segments.length - 1].t : 0) || 1;
      const idx = Math.min(2, Math.floor((t / dur) * 3));
      thirds[idx].push(p);
    });

    const sections = [];
    sections.push({
      h2: '영상 한 줄 결론',
      paras: [points[0].text],
      items: []
    });
    sections.push({
      h2: '핵심 5줄 요약',
      paras: ['영상에서 실제로 말한 문장 중 핵심만 시간 순으로 추렸습니다.'],
      items: points.map(function (p, i) {
        return `${i + 1}. ${p.text}${p.t !== null && p.t !== undefined ? ` (${fmtTime(p.t)})` : ''}`;
      })
    });

    const partNames = ['도입 — 문제 제기', '본론 — 근거와 사례', '정리 — 결론과 시사점'];
    const segs = parsed.segments.filter(function (s) { return s && s.text; });
    const dur = video.duration || (segs.length ? segs[segs.length - 1].t : 0) || 0;
    const pickedText = new Set(points.map(function (p) { return p.text; }));
    thirds.forEach(function (group, i) {
      const from = dur ? dur * i / 3 : 0;
      const to = dur ? dur * (i + 1) / 3 : Infinity;
      // 그 구간 자막에서 요약에 안 뽑힌 보조 문장 2개 (문장 길이 우선)
      const extras = [];
      segs.forEach(function (s) {
        if (s.t === null || s.t === undefined) return;
        if (dur && (s.t < from || s.t >= to)) return;
        splitSentences(s.text).forEach(function (sent) {
          if (pickedText.has(sent)) return;
          if (sent.length < 18 || sent.length > 150) return;
          if (extras.indexOf(sent) !== -1) return;
          extras.push(sent);
        });
      });
      if (!group.length && !extras.length) return;
      const range = dur ? ` (${fmtTime(from)}~${fmtTime(to)})` : '';
      sections.push({
        h2: `${partNames[i]}${range}`,
        paras: []
          .concat(group.length ? [group.map(function (p) { return p.text; }).join(' ')] : [])
          .concat(extras.slice(0, 2)),
        items: []
      });
    });

    sections.push({
      h2: '이 영상에서 확인해야 할 점',
      paras: [
        `영상은 ${channel || '해당 채널'}에서 ${video.duration ? fmtTime(video.duration) + ' 분량으로 ' : ''}다뤘습니다. 자막 ${parsed.segments.length ? parsed.segments.length + '개 구간' : '전문'}에서 뽑은 내용이라, 영상에 없는 해석이나 추정은 넣지 않았습니다.`,
        `키워드: ${key3.join(', ') || '-'}`
      ],
      items: []
    });

    const hookPoint = points[0] ? points[0].text : title;
    const blocks = points.slice(1, 4).map(function (p) { return p.text; });
    if (!blocks.length) blocks.push(clamp(title, 60));

    const content = {
      mode: 'video',
      ok: true,
      source: {
        label: `유튜브 — ${channel || '채널 미확인'}`,
        url: video.url || '',
        asOf: video.fetchedAt || kst.label
      },
      headline: headline,
      subline: subline,
      pills: pills,
      facts: [
        { k: '영상 제목', v: title },
        { k: '채널', v: channel || '-' },
        { k: '길이', v: video.duration ? fmtTime(video.duration) : '-' },
        { k: '자막', v: `${parsed.segments.length ? parsed.segments.length + '구간' : '전문'} · ${(video.captionSource || '직접 입력/붙여넣기')}` }
      ],
      keywords: key3,
      summary: summary,
      blog: {
        titles: blogTitleCandidates(title, 'video', kst),
        intro: `${video.url ? `[${title}](${video.url})` : title}${channel ? ' · ' + channel : ''} 영상을 실제 자막으로 정리했습니다. 5줄 요약과 구간별 내용을 한 번에 볼 수 있게 구성했습니다.`,
        sections: sections,
        cta: buildCta('video'),
        tags: []
      },
      shorts: buildShortsScript({
        hook: clamp(hookPoint, 60),
        blocks: blocks,
        cta: '영상 전체는 고정 댓글 링크에서 확인하세요.',
        total: 50
      }),
      notices: [
        { level: 'info', text: `자막 ${parsed.segments.length ? parsed.segments.length + '개 구간' : '전문'}에서 추출 요약 — 영상에 없는 내용은 생성하지 않았습니다.` },
        video.captionSource ? { level: 'info', text: `자막 출처: ${video.captionSource}` } : null,
        video.duration ? { level: 'info', text: `영상 길이: ${fmtTime(video.duration)}` } : null
      ].filter(Boolean)
    };
    return finishContent(content);
  }

  /* ============================================================
   * 6. ✍️ 자유 주제/키워드 모드
   * ============================================================ */
  function buildFromTopic(payload) {
    const keyword = clamp(payload.keyword || '', 60);
    const memo = String(payload.memo || '').trim();
    const kst = kstNow();
    const points = memo ? summarizeText({ text: memo, maxLines: 5 }) : [];
    const templates = payload.template || 'info';

    if (!keyword) {
      return null;
    }

    const summary = points.length
      ? points.map(function (p) { return p.text; })
      : [`키워드: ${keyword}`, '메모가 비어 있어 뼈대만 만들었습니다. [ ] 자리에 실제 내용을 채우면 그대로 발행할 수 있습니다.']; 

    const sections = [];
    sections.push({
      h2: '왜 이 주제인가',
      paras: points.length
        ? [points[0].text]
        : [`${keyword}에 대해 정리합니다. 이 글은 메모로 받은 내용만으로 작성됐고, 확인되지 않은 수치나 사례는 넣지 않았습니다.`],
      items: []
    });

    if (points.length > 1) {
      sections.push({
        h2: '핵심 정리',
        paras: ['메모에서 뽑은 핵심 문장을 순서대로 정리했습니다.'],
        items: points.slice(1).map(function (p) { return p.text; })
      });
    } else {
      sections.push({
        h2: '핵심 정리',
        paras: ['아래 항목을 채우면 글이 됩니다.'],
        items: [
          `① ${keyword}이 중요한 이유 — [한 문장]`,
          `② 실제 사례·수치 — [확인한 자료 1개]`,
          `③ 내 경험·의견 — [직접 겪은 내용]`,
          `④ 주의할 점 — [반대 의견이나 한계]`
        ]
      });
    }

    sections.push({
      h2: '적용 방법',
      paras: [templates === 'review'
        ? `${keyword}를 직접 써 본 기준으로 정리합니다. 좋았던 점과 아쉬웠던 점을 나눠 쓰면 읽는 사람이 판단하기 쉽습니다.`
        : `${keyword}를 실제로 써먹으려면 순서를 정해 두는 게 좋습니다. 한 번에 다 하기보다 작은 단위로 나눠 시도하고, 결과를 기록해 두세요.`],
      items: [
        templates === 'review' ? '장점 — [ ]' : '1단계 — [ ]',
        templates === 'review' ? '아쉬운 점 — [ ]' : '2단계 — [ ]',
        templates === 'review' ? '이런 분께 추천 — [ ]' : '3단계 — [ ]'
      ]
    });

    sections.push({
      h2: '정리',
      paras: [`${keyword}에 대해 지금까지 확인한 내용을 정리했습니다. 추가로 확인되는 자료가 있으면 이 글에 이어서 업데이트합니다.`],
      items: []
    });

    const content = {
      mode: 'topic',
      source: { label: '자유 주제 입력', url: '', asOf: kst.label + ' ' + kst.time },
      headline: keyword,
      subline: memo ? clamp(memo, 50) : '메모 없이 뼈대만 생성',
      pills: keyword ? [keyword] : [],
      facts: points.length ? [{ k: '메모 문장', v: points.length + '문장에서 추출' }] : [{ k: '입력', v: '키워드만' }],
      keywords: tokenize(keyword + ' ' + memo).slice(0, 5),
      summary: summary,
      blog: {
        titles: blogTitleCandidates(keyword, 'topic', kst),
        intro: `${keyword} — ${memo ? '메모로 주신 내용을 기준으로' : '기본 뼈대를 기준으로'} 정리했습니다.`,
        sections: sections,
        cta: buildCta('topic'),
        tags: []
      },
      shorts: buildShortsScript({
        hook: `${keyword}, 이거 하나만 알면 됩니다`,
        blocks: points.length ? points.slice(0, 3).map(function (p) { return p.text; })
          : [`${keyword}가 필요한 순간은 [상황]입니다.`, `핵심은 [한 가지]입니다.`, `실제로 해보면 [결과]가 나옵니다.`],
        cta: '자세한 내용은 고정 댓글 링크에서 확인하세요.',
        total: 50
      }),
      notices: [
        points.length
          ? { level: 'info', text: `메모 ${points.length}문장에서 추출 — 없는 사실은 넣지 않았습니다.` }
          : { level: 'warn', text: '메모가 비어 있어 뼈대만 만들었습니다. [ ] 자리를 채워 주세요.' }
      ]
    };
    return finishContent(content);
  }

  /* ============================================================
   * 7. 📅 요일별 추천
   * ============================================================ */
  function weekdayPlan(now) {
    const kst = kstNow(now);
    const dow = kst.dow;
    const dayName = WEEKDAYS[dow];
    let plan;
    if (dow >= 1 && dow <= 4) {
      plan = {
        kind: '장중·마감 시황',
        chips: [
          { label: '📈 오늘 마감 시황 정리', mode: 'stock', keyword: '' },
          { label: '🔥 주도 테마 3곳만 보기', mode: 'stock', keyword: '주도테마' },
          { label: '👑 상한가·신고가 체크', mode: 'stock', keyword: '상한가' },
          { label: '✍️ 관심 종목 메모 정리', mode: 'topic', keyword: '오늘의 관심종목' }
        ],
        note: `${dayName}요일 — 장 마감(15:30) 후 시황 글을 쓰기 좋은 날입니다. 관제탑 숫자를 그대로 원고로 바꿉니다.`
      };
    } else if (dow === 5) {
      plan = {
        kind: '주간 결산',
        chips: [
          { label: '🏁 이번 주 주도주 결산', mode: 'stock', keyword: '주간결산' },
          { label: '📊 이번 주 테마 3곳 정리', mode: 'stock', keyword: '주간테마' },
          { label: '🎡 주말 나들이 특가 5곳', mode: 'deals', keyword: '' },
          { label: '✍️ 한 주 회고 메모', mode: 'topic', keyword: '한 주 회고' }
        ],
        note: `${dayName}요일 — 한 주를 결산하는 글(주간 주도주·테마)과 주말 나들이 특가를 함께 준비하기 좋은 날입니다.`
      };
    } else {
      plan = {
        kind: '가족 나들이',
        chips: [
          { label: '🎡 동탄 4인 가족 나들이 5곳', mode: 'deals', keyword: '' },
          { label: '❄️ 눈썰매·스키 특가', mode: 'deals', keyword: '눈썰매' },
          { label: '🏛️ 비 오는 날 실내 코스', mode: 'deals', keyword: '실내' },
          { label: '✍️ 아이와 다녀온 곳 후기', mode: 'topic', keyword: '동탄 아이와 가볼 만한 곳' }
        ],
        note: `${dayName}요일 — 아이와 다녀온 곳 후기나 주말 나들이 코스 글이 잘 먹히는 날입니다. 특가 레이더 데이터를 그대로 재료로 씁니다.`
      };
    }
    return { dow: dow, dayName: dayName, label: kst.label, plan: plan };
  }

  /* ============================================================
   * export
   * ============================================================ */
  return {
    VERSION: VERSION,
    weekdayPlan: weekdayPlan,
    kstNow: kstNow,
    normalizeText: normalizeText,
    parseTranscript: parseTranscript,
    summarizeText: summarizeText,
    keywordRank: keywordRank,
    buildFromStocks: buildFromStocks,
    buildFromDeals: buildFromDeals,
    buildFromVideo: buildFromVideo,
    buildFromTopic: buildFromTopic,
    _debug: { splitSentences: splitSentences, tokenize: tokenize },
    buildHashtags: buildHashtags,
    contentToMarkdown: contentToMarkdown,
    shortsToText: shortsToText,
    fmtTime: fmtTime,
    num: num,
    pct: pct,
    clamp: clamp
  };
});
