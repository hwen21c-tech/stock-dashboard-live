'use strict';

/**
 * 📘 침착해 종가베팅 — 후보 '재료(테마·뉴스·공시)' 판정
 * ---------------------------------------------------------------------------
 *  사용자 확정(11/25): "침착해는 재료가 있는 거에서 참고로 다른 걸 보는 거야"
 *   → 재료가 확인된 종목만 후보로 올리고, 프로그램·외인/기관 수급은 그 안에서
 *     참고 지표로 쓴다. 재료가 확인되지 않으면 후보에서 뺀다(임의 완화 금지).
 *
 *  재료 3종
 *   ① 테마  : 네이버 실시간 테마 랭킹·스탁이지 강세 테마의 구성종목인가
 *             (단, '52주 신고가'·'상한가·임박'·'NXT 상승률 상위'는 테마가 아니라
 *              후보 풀을 넓히려고 붙인 가짜 라벨이므로 재료로 인정하지 않는다)
 *   ② 뉴스  : 당일 네이버 종목 뉴스 헤드라인 중 **회사명이 제목에 있고**
 *             재료 키워드(수주·계약·실적·승인·지분·특징주·급등 등)가 있는 기사.
 *             악재 키워드가 더 많은 기사(급락·유증·제재 등)는 재료로 보지 않는다.
 *   ③ 공시  : 오픈DART 호재 공시(단일판매·공급계약 / 잠정실적 등)
 *
 *  원칙 — 제목에 실제로 적힌 것만 근거로 쓴다. 없는 재료를 만들지 않고,
 *         확인하지 못하면 '재료 미확인'으로 남겨 후보에서 제외한다.
 */

/* 후보 풀을 넓히려고 붙인 가짜 테마 라벨 — 재료 아님 */
const PSEUDO_THEMES = ['52주 신고가', '상한가·임박', 'NXT 상승률 상위', '상한가·임박(100억↑)'];

/* 실질 재료(펀더멘털·이벤트) — 있으면 가장 세게 본다 */
const FUNDAMENTAL_KEYWORDS = [
  { kw: '단일판매', label: '수주·공급계약' },
  { kw: '공급계약', label: '수주·공급계약' },
  { kw: '수주', label: '수주' },
  { kw: '납품', label: '납품' },
  { kw: '업무협약', label: '업무협약' },
  { kw: 'MOU', label: 'MOU' },
  { kw: '협약', label: '협약' },
  { kw: '계약', label: '계약' },
  { kw: '제휴', label: '제휴' },
  { kw: '최대 실적', label: '최대 실적' },
  { kw: '사상 최대', label: '사상 최대' },
  { kw: '영업이익', label: '실적' },
  { kw: '어닝', label: '어닝' },
  { kw: '실적', label: '실적' },
  { kw: '흑자', label: '흑자 전환' },
  { kw: '서프라이즈', label: '서프라이즈' },
  { kw: '품목허가', label: '품목허가' },
  { kw: '승인', label: '승인' },
  { kw: '허가', label: '허가' },
  { kw: '임상', label: '임상' },
  { kw: 'FDA', label: 'FDA' },
  { kw: '특허', label: '특허' },
  { kw: '기술수출', label: '기술수출' },
  { kw: '라이선스', label: '라이선스' },
  { kw: '공개매수', label: '공개매수' },
  { kw: '경영권', label: '경영권 분쟁' },
  { kw: '최대주주', label: '최대주주 변경' },
  { kw: '지분', label: '지분 변동' },
  { kw: '인수', label: '인수' },
  { kw: '합병', label: '합병' },
  { kw: '자사주', label: '자사주' },
  { kw: '무상증자', label: '무상증자' },
  { kw: '증설', label: '증설' },
  { kw: '출시', label: '출시' },
  { kw: '선정', label: '선정' },
  { kw: '수출', label: '수출' },
  { kw: '진출', label: '진출' },
  { kw: '투자유치', label: '투자유치' },
  { kw: '수혜', label: '수혜' },
];

/* 가격·수급 재료 — 재료로 인정하되 펀더멘털보다 약하게 본다 */
const PRICE_KEYWORDS = [
  { kw: '특징주', label: '특징주' },
  { kw: '상한가', label: '상한가' },
  { kw: '신고가', label: '신고가' },
  { kw: '폭등', label: '폭등' },
  { kw: '급등', label: '급등' },
  { kw: '목표주가', label: '목표주가' },
  { kw: '상향', label: '목표가 상향' },
  { kw: '강세', label: '강세' },
  { kw: '반등', label: '반등' },
  { kw: '돌파', label: '돌파' },
];

/* 악재 — 이 기사는 재료로 쓰지 않는다(종베에 악재 붙은 종목은 패스) */
const NEGATIVE_KEYWORDS = [
  '급락',
  '폭락',
  '하락',
  '하회',
  '약세',
  '우려',
  '부진',
  '적자',
  '리콜',
  '제재',
  '관세',
  '소송',
  '압수',
  '수사',
  '논란',
  '의혹',
  '철회',
  '취소',
  '중단',
  '지연',
  '파산',
  '부도',
  '손실',
  '감소',
  '축소',
  '벌금',
  '과징금',
  '유상증자',
  '감자',
  '횡령',
  '배임',
  '불성실',
  '거래정지',
  '상장폐지',
  '관리종목',
  '단기과열',
  '투자주의',
  '투자경고',
  '악재',
  '공포',
  '순매도',
  '투매',
];

/* 회사명 표기 흔들림 — 제목에 다른 표기로 나오는 큰 이름만 보정한다 */
const NAME_ALIASES = {
  NAVER: ['네이버'],
  삼성에스디에스: ['삼성SDS', '삼성 SDS'],
  LG에너지솔루션: ['LG엔솔', 'LG에너지'],
  POSCO홀딩스: ['포스코홀딩스', 'POSCO'],
  'JYP Ent.': ['JYP'],
  HPSP: ['HPSP'],
  셀트리온: ['셀트리온'],
};

const WS_RE = /[\s\u00a0]+/g;

function normName(s) {
  return String(s === null || s === undefined ? '' : s)
    .normalize('NFKC')
    .replace(/[^0-9a-zA-Z가-힣]/g, '')
    .toLowerCase();
}

function isPseudoTheme(name) {
  const s = String(name === null || name === undefined ? '' : name).trim();
  if (!s) return true;
  return PSEUDO_THEMES.some((p) => s === p || s.indexOf(p) === 0);
}

/** 테마명이 실제 주도 테마인가(가짜 라벨 제외) */
function isRealTheme(name) {
  return !isPseudoTheme(name);
}

/** HTML 엔티티만 풀어 쓴다(제목 표시용) */
function decodeEntities(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(WS_RE, ' ')
    .trim();
}

/** 제목에 이 종목 이름이 실제로 등장하는가 */
function mentionsStock(title, name) {
  const t = normName(title);
  if (!t) return false;
  const base = normName(name);
  if (base && t.indexOf(base) >= 0) return true;
  const raw = String(name || '').trim();
  const aliases = NAME_ALIASES[raw] || [];
  for (let i = 0; i < aliases.length; i += 1) {
    const a = normName(aliases[i]);
    if (a && t.indexOf(a) >= 0) return true;
  }
  return false;
}

/**
 * 이 기사가 이 종목을 '주인공'으로 다루는가.
 *  한국 증권 헤드라인의 관행은 '주인공, 무슨 일' 형태다 → 첫 쉼표·콜론 앞 머리말에
 *  종목명이 없으면 다른 회사의 기사(예: "네오셈, 삼성전자와 65억원 공급계약")다.
 *  머리말이 없으면(쉼표·콜론 없음) 제목 안 어디에 있어도 그 종목 기사로 본다.
 */
function isSubjectOf(title, name) {
  if (!mentionsStock(title, name)) return false;
  const t = decodeEntities(title)
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/^【[^】]*】\s*/, '')
    .replace(/^[\[*]\s*/, '')
    .trim();
  const m = t.match(/^([^,:：·]{1,24})[,:：]/);
  if (!m) return true;
  return mentionsStock(m[1], name);
}

function hitsIn(text, list) {
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const k = list[i];
    if (text.indexOf(String(k.kw).toLowerCase()) >= 0) out.push(k.label);
  }
  return out;
}

function countIn(text, list) {
  let n = 0;
  for (let i = 0; i < list.length; i += 1) if (text.indexOf(list[i]) >= 0) n += 1;
  return n;
}

/**
 * 헤드라인 1건 판정.
 * @param {{title?:string, press?:string, datetime?:string, url?:string}} item
 * @param {string} stockName
 * @returns {{ok:boolean, score:number, label:string|null, adverse:boolean, negative:string[]}}
 */
function judgeHeadline(item, stockName) {
  const title = decodeEntities((item && (item.title || item.titleFull)) || '');
  const text = title.toLowerCase();
  const negBase = countIn(text, NEGATIVE_KEYWORDS);
  const mentions = isSubjectOf(title, stockName);
  const fund = hitsIn(text, FUNDAMENTAL_KEYWORDS);
  const price = hitsIn(text, PRICE_KEYWORDS);
  /* 화살표·% 표기는 그 종목의 방향을 바로 보여 준다(예: "실리콘토 13%↑…급락장서 강세") */
  const arrowUp = text.indexOf('↑') >= 0 ? 1 : 0;
  const arrowDown = text.indexOf('↓') >= 0 ? 1 : 0;
  const neg = negBase + arrowDown;
  /* 회사명이 제목에 없으면 이 종목의 재료가 아니다(시황·업종 기사 배제) */
  if (!mentions) return { ok: false, score: 0, label: null, adverse: false, negative: [] };
  const posCount = fund.length + price.length + arrowUp;
  /* 악재 표현이 재료 표현보다 많을 때만 악재로 본다(시장 전체를 말하는 '급락장' 같은 표현 허용) */
  if (neg > 0 && neg > posCount) {
    return { ok: false, score: 0, label: null, adverse: true, negative: [] };
  }
  if (fund.length) return { ok: true, score: 3, label: fund[0], adverse: false, negative: [] };
  if (price.length) return { ok: true, score: 2, label: price[0], adverse: false, negative: [] };
  return { ok: false, score: 0, label: null, adverse: false, negative: [] };
}

/** 'YYYY-MM-DD' → 'MM/DD' */
function mdOf(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[2] + '/' + m[3] : null;
}

/** 'YYYYMMDDHHMM' → { date:'YYYY-MM-DD', time:'HH:MM' } */
function parseStamp(raw) {
  const m = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return { date: null, time: null };
  return { date: m[1] + '-' + m[2] + '-' + m[3], time: m[4] + ':' + m[5] };
}

/**
 * 종목 뉴스 목록에서 재료 기사를 고른다.
 * @param {string} stockName
 * @param {Array<{title?:string, titleFull?:string, press?:string, datetime?:string, url?:string}>} items
 * @param {string|null} dateYmd 허용 날짜('YYYY-MM-DD'). null 이면 날짜 제한 없음.
 * @returns {{material:{title,press,time,date,url,label,score,ageText}|null, adverse:object|null, scanned:number, dated:number}}
 */
function pickMaterialNews(stockName, items, dateYmd) {
  const list = Array.isArray(items) ? items : [];
  let dated = 0;
  const good = [];
  let adverse = null;
  for (let i = 0; i < list.length; i += 1) {
    const it = list[i] || {};
    const stamp = parseStamp(it.datetime);
    if (dateYmd && stamp.date !== dateYmd) continue;
    dated += 1;
    const verdict = judgeHeadline(it, stockName);
    if (verdict.ok) {
      good.push({
        title: decodeEntities(it.titleFull || it.title),
        press: it.press || it.officeName || null,
        datetime: String(it.datetime || ''),
        date: stamp.date,
        time: stamp.time,
        url: it.url || it.mobileNewsUrl || null,
        label: verdict.label,
        score: verdict.score,
      });
      continue;
    }
    if (verdict.adverse && !adverse) {
      adverse = {
        title: decodeEntities(titleOf(it)),
        press: it.press || it.officeName || null,
        time: stamp.time,
        date: stamp.date,
        url: it.url || it.mobileNewsUrl || null,
      };
    }
  }
  if (!good.length) return { material: null, adverse, scanned: list.length, dated };
  /* 점수 높은 기사 → 같은 점수면 최신 기사 */
  good.sort((a, b) => b.score - a.score || String(b.datetime).localeCompare(String(a.datetime)));
  return { material: good[0], adverse, scanned: list.length, dated };
}

function titleOf(it) {
  return (it && (it.titleFull || it.title)) || '';
}

/** 헤드라인을 카드 한 줄에 들어가게 자른다 */
function shortTitle(title, max) {
  const s = decodeEntities(title);
  const n = max || 44;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * 재료 1줄 문장 — 테마와 뉴스를 합쳐 카드에 그대로 쓴다.
 * @param {{themeName?:string|null, themeRank?:number|null, news?:object|null, dart?:object|null}} m
 */
function materialLine(m) {
  const parts = [];
  if (m && m.themeName && isRealTheme(m.themeName)) {
    parts.push("주도 테마 '" + m.themeName + "'" + (m.themeRank ? ' ' + m.themeRank + '위' : ''));
  }
  if (m && m.dart && m.dart.label) parts.push('공시 ' + m.dart.label);
  if (m && m.news && m.news.title) {
    parts.push(
      (m.news.label ? m.news.label + ' — ' : '') +
        shortTitle(m.news.title, 46) +
        (m.news.press ? ' (' + m.news.press + (m.news.time ? ' ' + m.news.time : '') + ')' : ''),
    );
  }
  return parts.join(' · ');
}

/** 카드 뱃지 문구 — 테마명이 있으면 테마, 없으면 핵심 재료 키워드 */
function materialTag(m) {
  if (m && m.themeName && isRealTheme(m.themeName)) return m.themeName;
  if (m && m.dart && m.dart.label) return m.dart.label;
  if (m && m.news && m.news.label) return m.news.label;
  return '재료 미확인';
}

module.exports = {
  PSEUDO_THEMES,
  FUNDAMENTAL_KEYWORDS,
  PRICE_KEYWORDS,
  NEGATIVE_KEYWORDS,
  isPseudoTheme,
  isRealTheme,
  decodeEntities,
  mentionsStock,
  isSubjectOf,
  judgeHeadline,
  pickMaterialNews,
  parseStamp,
  shortTitle,
  materialLine,
  materialTag,
  mdOf,
};
