'use strict';

/**
 * 뉴스 제목·요약 키워드 기반 영향도 / 테마 / 수혜종목 자동 매칭 (규칙 기반)
 * ---------------------------------------------------------------------------
 *  · /api/tabs-live 의 `news` 12건에 붙는 impactLevel · impactDirection ·
 *    matchedThemes · beneficiaryStocks · impactNote 를 만든다.
 *  · 원칙 (가짜 매칭 금지)
 *      - 제목·요약에 실제로 등장한 키워드만 근거로 삼는다. 문장을 새로 만들지 않는다.
 *      - 관련 섹터·종목 키워드가 하나도 없으면 matchedThemes: [] · beneficiaryStocks: []
 *        · impactLevel: '참고' · impactNote: '... 일반 속보' 로 남긴다.
 *      - 종목은 ① 기사에 이름이 직접 등장한 상장사 → ② 매칭된 테마의 대표주 순으로 채우고
 *        최대 5개까지만 내려준다(같은 종목은 코드 기준 중복 제거).
 *  · 정시 AI 심층 분석과 구분하기 위해 impactNote 앞에 '키워드 자동 분석' 을 붙인다.
 */

const MAX_THEMES = 3;
const MAX_STOCKS_PER_THEME = 2;
const MAX_STOCKS = 5;
const MAX_MENTIONS = 2;

/* ------------------------- 8대 주도 테마 + 매크로/업종 ------------------------- */
const NEWS_THEMES = [
  {
    name: '시스템반도체 · 디자인하우스',
    note: '시스템반도체·디자인하우스',
    keywords: ['시스템반도체', '디자인하우스', '팹리스', '반도체 설계', 'ASIC'],
    stocks: [
      { name: '가온칩스', code: '399720' },
      { name: '에이디테크놀로지', code: '200710' },
      { name: '피에스케이', code: '319660' },
      { name: '퀄리타스반도체', code: '432720' },
    ],
  },
  {
    name: '창투사 · 벤처캐피탈',
    note: '창투사·벤처캐피탈',
    keywords: ['창투사', '벤처캐피탈', '벤처 투자', '모태펀드', '투자조합', '스타트업 투자', 'VC'],
    stocks: [
      { name: 'DSC인베스트먼트', code: '241520' },
      { name: 'TS인베스트먼트', code: '246690' },
      { name: '미래에셋벤처투자', code: '100790' },
      { name: '컴퍼니케이', code: '307930' },
    ],
  },
  {
    name: '건설 중소형 · 인프라 재건',
    note: '건설·인프라 재건',
    keywords: ['건설', '재건', '인프라', '토목', 'SOC', '수주잔고', '재개발', '재건축', '부동산 PF'],
    stocks: [
      { name: '금호건설', code: '002990' },
      { name: '남화토건', code: '091590' },
      { name: '계룡건설', code: '013580' },
      { name: '동부건설', code: '005960' },
    ],
  },
  {
    name: '전선 · 전력 인프라',
    note: '전선·전력망',
    keywords: ['전선', '전력망', '송전', '변압기', '전력 인프라', '전력기기', '초고압', '그리드'],
    stocks: [
      { name: 'KBI메탈', code: '024840' },
      { name: '일진전기', code: '103590' },
      { name: '가온전선', code: '000500' },
      { name: '대한전선', code: '001440' },
    ],
  },
  {
    name: '지능형 로봇 · AI 제조',
    note: '로봇·자동화',
    keywords: ['로봇', '로보틱스', '자동화', '협동로봇', '휴머노이드', '스마트팩토리'],
    stocks: [
      { name: '레인보우로보틱스', code: '277810' },
      { name: '유진로봇', code: '056080' },
      { name: '엔젤로보틱스', code: '455900' },
      { name: '두산로보틱스', code: '454910' },
    ],
  },
  {
    name: '온디바이스 AI · 뉴로모픽',
    note: '온디바이스·뉴로모픽',
    keywords: ['온디바이스', '뉴로모픽', 'NPU'],
    stocks: [
      { name: '자람테크놀로지', code: '389020' },
      { name: '유니퀘스트', code: '077500' },
      { name: '네패스', code: '033640' },
      { name: '네패스아크', code: '330860' },
    ],
  },
  {
    name: 'CXL · 차세대 메모리 & 기판',
    note: 'CXL·차세대 메모리',
    keywords: ['CXL', '차세대 메모리', 'FC-BGA', '반도체 기판', '패키지 기판'],
    stocks: [
      { name: '코리아써키트', code: '007810' },
      { name: '이수페타시스', code: '007660' },
      { name: '티엘비', code: '356860' },
      { name: '심텍', code: '222800' },
    ],
  },
  {
    name: 'AI 보안 · EDR 제로트러스트',
    note: '보안·EDR',
    keywords: ['보안', 'EDR', '제로트러스트', '랜섬웨어', '해킹', '사이버 공격'],
    stocks: [
      { name: '지니언스', code: '263860' },
      { name: '샌즈랩', code: '411080' },
      { name: '모니터랩', code: '434480' },
      { name: '파수', code: '150900' },
    ],
  },
  {
    name: '반도체 · HBM',
    note: '반도체·HBM',
    keywords: ['반도체', 'HBM', 'D램', '낸드', '메모리', '파운드리', '엔비디아', '마이크론', 'TSMC'],
    stocks: [
      { name: '삼성전자', code: '005930' },
      { name: 'SK하이닉스', code: '000660' },
      { name: '한미반도체', code: '042700' },
    ],
  },
  {
    name: '우주항공 · 스페이스X',
    note: '우주항공·위성',
    keywords: ['우주', '스페이스X', '위성', '발사체', '항공우주', '스타링크'],
    stocks: [
      { name: '쎄트렉아이', code: '099320' },
      { name: '컨텍', code: '451760' },
      { name: 'AP위성', code: '211270' },
    ],
  },
  {
    name: '방산',
    note: '방산·국방',
    keywords: ['방산', '국방', '군사비', '국방비', 'K-방산', '미사일', '전차'],
    stocks: [
      { name: '한화에어로스페이스', code: '012450' },
      { name: 'LIG넥스원', code: '079550' },
      { name: '현대로템', code: '064350' },
      { name: '한국항공우주', code: '047810' },
    ],
  },
  {
    name: '원전',
    note: '원전·원자력',
    keywords: ['원전', '원자력', 'SMR', '핵발전'],
    stocks: [
      { name: '두산에너빌리티', code: '034020' },
      { name: '한전기술', code: '052690' },
      { name: '비에이치아이', code: '083650' },
    ],
  },
  {
    name: '2차전지',
    note: '2차전지·배터리',
    keywords: ['2차전지', '배터리', '양극재', '음극재', '니켈'],
    stocks: [
      { name: '에코프로비엠', code: '247540' },
      { name: 'LG에너지솔루션', code: '373220' },
      { name: '삼성SDI', code: '006400' },
      { name: '포스코퓨처엠', code: '003670' },
    ],
  },
  {
    name: '바이오 · 비만치료제',
    note: '바이오·비만치료제',
    keywords: ['바이오', '비만치료제', '비만', 'GLP-1', '임상', '신약', 'FDA'],
    stocks: [
      { name: '삼성바이오로직스', code: '207940' },
      { name: '알테오젠', code: '196170' },
      { name: '유한양행', code: '000100' },
      { name: '한미약품', code: '128940' },
    ],
  },
  {
    name: '엔터 · K-POP',
    note: '엔터·K-POP',
    keywords: ['엔터', 'K-POP', '아이돌', '콘서트', '음원', '월드투어', '앨범'],
    stocks: [
      { name: '하이브', code: '352820' },
      { name: 'JYP Ent.', code: '035900' },
      { name: '에스엠', code: '041510' },
      { name: '와이지엔터테인먼트', code: '122870' },
    ],
  },
  {
    name: '자동차 · 관세',
    note: '자동차·관세',
    keywords: ['자동차', '현대차', '기아', '완성차', '관세'],
    stocks: [
      { name: '현대차', code: '005380' },
      { name: '기아', code: '000270' },
      { name: '현대모비스', code: '012330' },
    ],
  },
  {
    name: '금리 · 환율 · 미 증시',
    note: '금리·연준·미 증시',
    keywords: [
      '연준',
      'FOMC',
      '기준금리',
      '금리 인상',
      '금리 인하',
      '국채',
      '환율',
      '원/달러',
      '나스닥',
      'S&P500',
      '다우',
      '미 증시',
      '빅스텝',
      '빅컷',
    ],
    stocks: [
      { name: 'KB금융', code: '105560' },
      { name: '신한지주', code: '055550' },
      { name: '삼성증권', code: '016360' },
    ],
  },
];

/* 기사에 이름이 직접 등장하면 그대로 관련주로 올리는 상장사 (표기 흔들림 없는 종목만) */
const NEWS_MENTIONS = [
  { name: '삼성전자', code: '005930' },
  { name: 'SK하이닉스', code: '000660' },
  { name: '현대차', code: '005380' },
  { name: '기아', code: '000270' },
  { name: 'LG에너지솔루션', code: '373220' },
  { name: '삼성SDI', code: '006400' },
  { name: '삼성바이오로직스', code: '207940' },
  { name: '셀트리온', code: '068270' },
  { name: 'POSCO홀딩스', code: '005490' },
  { name: '포스코퓨처엠', code: '003670' },
  { name: '현대모비스', code: '012330' },
  { name: '한화에어로스페이스', code: '012450' },
  { name: 'LIG넥스원', code: '079550' },
  { name: '현대로템', code: '064350' },
  { name: '한국항공우주', code: '047810' },
  { name: '두산에너빌리티', code: '034020' },
  { name: '한전기술', code: '052690' },
  { name: '에코프로비엠', code: '247540' },
  { name: '알테오젠', code: '196170' },
  { name: '유한양행', code: '000100' },
  { name: '한미약품', code: '128940' },
  { name: '하이브', code: '352820' },
  { name: 'JYP Ent.', code: '035900' },
  { name: '에스엠', code: '041510' },
  { name: '크래프톤', code: '259960' },
  { name: '엔씨소프트', code: '036570' },
  { name: '한미반도체', code: '042700' },
  { name: '리노공업', code: '058470' },
  { name: '이오테크닉스', code: '039030' },
  { name: '주성엔지니어링', code: '036930' },
  { name: '원익IPS', code: '240810' },
  { name: 'HPSP', code: '403870' },
  { name: '두산로보틱스', code: '454910' },
  { name: '레인보우로보틱스', code: '277810' },
  { name: '쎄트렉아이', code: '099320' },
  { name: '컨텍', code: '451760' },
  { name: 'AP위성', code: '211270' },
  { name: '가온칩스', code: '399720' },
  { name: '지니언스', code: '263860' },
  { name: '코리아써키트', code: '007810' },
  { name: '티엘비', code: '356860' },
  { name: '심텍', code: '222800' },
  { name: '이수페타시스', code: '007660' },
  { name: '금호건설', code: '002990' },
  { name: '대한전선', code: '001440' },
  { name: '일진전기', code: '103590' },
  { name: 'KB금융', code: '105560' },
  { name: '신한지주', code: '055550' },
  { name: '현대건설', code: '000720' },
  { name: '대우건설', code: '047040' },
];

/* 재료 강도 — '상'급 키워드 (수주·계약·실적 서프라이즈·규제·금리 결정 등 몸값이 바로 움직이는 재료) */
const STRONG_KEYWORDS = [
  '수주',
  '계약',
  '상한가',
  '급등',
  '폭등',
  '폭락',
  '급락',
  '서프라이즈',
  '어닝',
  '최대 실적',
  '사상 최대',
  '흑자 전환',
  '적자 전환',
  'FDA',
  '승인',
  '허가',
  '유상증자',
  '무상감자',
  '리콜',
  '관세',
  '제재',
  '수출 규제',
  'FOMC',
  '빅스텝',
  '빅컷',
  '기준금리',
  '금리 인상',
  '금리 인하',
  '인수',
  '합병',
  'M&A',
  '파산',
  '부도',
  '디폴트',
  '횡령',
  '배임',
  '신고가',
  '최고치',
  '최저치',
  '철회',
  '취소',
];

/* '중'급 — 방향성은 있으나 단발 재료로 보기 어려운 표현 */
const MEDIUM_KEYWORDS = [
  '실적',
  '전망',
  '목표주가',
  '목표가',
  '투자',
  '공급',
  '확대',
  '축소',
  '증설',
  '출시',
  '개시',
  '착수',
  '선정',
  '상장',
  '우려',
  '경고',
  '하락',
  '상승',
  '약세',
  '강세',
  '반등',
  '조정',
  '변동성',
  '경쟁',
  '규제',
  '지원',
  '협력',
  '양해각서',
  'MOU',
];

/* 호재성 표현 */
const POSITIVE_KEYWORDS = [
  '수주',
  '계약',
  '상한가',
  '급등',
  '폭등',
  '호재',
  '호실적',
  '최대 실적',
  '사상 최대',
  '서프라이즈',
  '어닝',
  '흑자',
  '승인',
  '허가',
  'FDA',
  '상향',
  '신고가',
  '최고치',
  '돌파',
  '확대',
  '수혜',
  '반등',
  '강세',
  '개선',
  '증가',
  '성공',
  '채택',
  '유치',
  '선정',
  '투자 확대',
];

/* 주의(악재)성 표현 */
const NEGATIVE_KEYWORDS = [
  '폭락',
  '급락',
  '하락',
  '약세',
  '부진',
  '우려',
  '경고',
  '리콜',
  '제재',
  '규제',
  '관세',
  '손실',
  '악재',
  '부도',
  '파산',
  '디폴트',
  '횡령',
  '배임',
  '유상증자',
  '감자',
  '적자',
  '감소',
  '축소',
  '철회',
  '취소',
  '지연',
  '중단',
  '소송',
  '조사',
  '벌금',
  '과징금',
  '위기',
  '공포',
  '불안',
  '리스크',
  '탈출',
  '빠져나와',
  '손절',
  '무너진',
];

/* 특정 테마가 이미 잡혔을 때 일반 '반도체' 매칭을 접는 기준
 *  (예: '시스템반도체 수주' 기사에 '반도체·HBM' 까지 붙으면 태그가 중복된다) */
const SEMI_SPECIFIC_THEME_NAMES = [
  '시스템반도체 · 디자인하우스',
  '온디바이스 AI · 뉴로모픽',
  'CXL · 차세대 메모리 & 기판',
];
const MEMORY_KEYWORDS = ['HBM', 'D램', '낸드', '메모리'];
const GENERIC_SEMI_THEME_NAME = '반도체 · HBM';

/* ------------------------------- 유틸 ------------------------------- */

const WS_RE = /\s+/g;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAscii(s) {
  return /^[\x20-\x7E]+$/.test(s);
}

/** text(소문자) 안에 키워드가 실제로 등장하는지. 영문 키워드는 단어 경계로 본다. */
function hit(text, keyword) {
  const kw = String(keyword || '');
  if (!kw) return false;
  if (isAscii(kw)) {
    const body = escapeRe(kw.toLowerCase()).replace(/\\?\s+/g, '\\s*');
    return new RegExp('(^|[^a-z0-9])' + body + '($|[^a-z0-9])', 'i').test(text);
  }
  return text.indexOf(kw.toLowerCase()) !== -1;
}

function matchedKeywords(text, keywords) {
  return (keywords || []).filter((k) => hit(text, k));
}

function buildText(title, summary) {
  return String(title || '') + ' ' + String(summary || '');
}

/* ---------------------------- 영향도 판정 ---------------------------- */

function judgeLevel(text, hasThemes, hasMentions) {
  const strong = matchedKeywords(text, STRONG_KEYWORDS);
  const medium = matchedKeywords(text, MEDIUM_KEYWORDS);
  if (!hasThemes && !hasMentions) return { level: '참고', strong, medium };
  if (strong.length) return { level: '상', strong, medium };
  if (medium.length) return { level: '중', strong, medium };
  return { level: '참고', strong, medium };
}

function judgeDirection(text) {
  const pos = matchedKeywords(text, POSITIVE_KEYWORDS);
  const neg = matchedKeywords(text, NEGATIVE_KEYWORDS);
  if (neg.length > pos.length) return { direction: '주의', pos, neg };
  if (pos.length > neg.length) return { direction: '호재', pos, neg };
  if (pos.length === 0 && neg.length === 0) return { direction: '중립', pos, neg };
  return { direction: '중립', pos, neg };
}

/* ------------------------------ 테마 매칭 ------------------------------ */

function matchThemes(text) {
  const matched = [];
  NEWS_THEMES.forEach((theme) => {
    const hits = matchedKeywords(text, theme.keywords);
    if (hits.length) matched.push({ theme, hits });
  });

  /* 일반 '반도체' 만 걸린 반도체·HBM 태그는, 더 구체적인 반도체 테마가 잡혔고
   *  메모리 키워드가 없으면 접는다. */
  const specificMatched = matched.some(
    (m) => SEMI_SPECIFIC_THEME_NAMES.indexOf(m.theme.name) !== -1,
  );
  const generic = matched.find((m) => m.theme.name === GENERIC_SEMI_THEME_NAME);
  if (generic && specificMatched) {
    const hasMemory = matchedKeywords(text, MEMORY_KEYWORDS).length > 0;
    if (!hasMemory) {
      matched.splice(matched.indexOf(generic), 1);
    }
  }

  matched.sort((a, b) => b.hits.length - a.hits.length);
  return matched.slice(0, MAX_THEMES);
}

function matchMentions(text) {
  const found = [];
  NEWS_MENTIONS.forEach((s) => {
    if (hit(text, s.name)) found.push(s);
  });
  return found.slice(0, MAX_MENTIONS);
}

/* --------------------------- 수혜·관련주 조립 --------------------------- */

function buildStocks(themeMatches, mentions) {
  const seen = new Set();
  const out = [];

  mentions.forEach((s) => {
    if (seen.has(s.code)) return;
    seen.add(s.code);
    out.push({ name: s.name, code: s.code });
  });

  for (let i = 0; i < themeMatches.length; i += 1) {
    const leaders = themeMatches[i].theme.stocks.slice(0, MAX_STOCKS_PER_THEME);
    for (let j = 0; j < leaders.length; j += 1) {
      const s = leaders[j];
      if (seen.has(s.code)) continue;
      seen.add(s.code);
      out.push({ name: s.name, code: s.code });
      if (out.length >= MAX_STOCKS) return out;
    }
  }
  return out.slice(0, MAX_STOCKS);
}

/* ------------------------------ 노트 문장 ------------------------------ */

function buildNote(themeMatches, mentions, levelInfo, direction) {
  const parts = ['키워드 자동 분석'];

  if (themeMatches.length) {
    const notes = themeMatches
      .slice(0, 2)
      .map((m) => "'" + m.theme.note + "'")
      .join(', ');
    const names = themeMatches.map((m) => m.theme.name).join(' · ');
    parts.push(notes + ' 언급 → ' + names + ' 테마');
  } else {
    parts.push('관련 섹터·종목 키워드 없음 → 일반 속보');
  }

  if (mentions.length) parts.push('직접 언급 ' + mentions.map((m) => m.name).join('·'));

  /* 강도 근거는 대표 키워드 1개 + 방향 대표 키워드 1개까지만 (한 줄 유지) */
  const levelKws = levelInfo.strong.length ? levelInfo.strong : levelInfo.medium;
  const mark = levelInfo.strong.length ? '상' : levelInfo.medium.length ? '중' : null;
  if (mark) {
    const kws = levelKws.slice(0, 1);
    const dirKws = direction.neg.length > direction.pos.length ? direction.neg : direction.pos;
    if (dirKws.length && kws.indexOf(dirKws[0]) === -1) kws.push(dirKws[0]);
    parts.push('강도 ' + mark + '(' + kws.slice(0, 2).join('·') + ')');
  }

  return parts.join(' · ');
}

/* ------------------------------- 공개 API ------------------------------- */

/**
 * 속보 1건을 분석한다.
 * @param {{title?:string, summary?:string}} item
 * @returns {{impactLevel:'상'|'중'|'참고', impactDirection:'호재'|'주의'|'중립',
 *            matchedThemes:string[], beneficiaryStocks:{name:string,code:string}[],
 *            impactNote:string, matchedKeywords:string[]}}
 */
function analyzeNewsItem(item) {
  const text = buildText(item && item.title, item && item.summary)
    .replace(WS_RE, ' ')
    .trim()
    .toLowerCase();

  const themeMatches = matchThemes(text);
  const mentions = matchMentions(text);
  const hasThemes = themeMatches.length > 0;
  const hasMentions = mentions.length > 0;

  /* 테마가 없고 직접 언급 종목도 없으면 → 일반 속보(가짜 매칭 금지) */
  if (!hasThemes && !hasMentions) {
    return {
      impactLevel: '참고',
      impactDirection: '중립',
      matchedThemes: [],
      beneficiaryStocks: [],
      impactNote: '키워드 자동 분석 · 관련 섹터·종목 키워드 없음 → 일반 속보',
      matchedKeywords: [],
    };
  }

  const levelInfo = judgeLevel(text, hasThemes, hasMentions);
  const direction = judgeDirection(text);
  const matchedThemes = themeMatches.map((m) => m.theme.name);
  const beneficiaryStocks = buildStocks(themeMatches, mentions);
  const kw = [];
  themeMatches.forEach((m) => m.hits.forEach((h) => kw.push(h)));
  levelInfo.strong.forEach((k) => kw.push(k));

  return {
    impactLevel: levelInfo.level,
    impactDirection: direction.direction,
    matchedThemes,
    beneficiaryStocks,
    impactNote: buildNote(themeMatches, mentions, levelInfo, direction),
    matchedKeywords: Array.from(new Set(kw)).slice(0, 8),
  };
}

module.exports = {
  analyzeNewsItem,
  NEWS_THEMES,
  NEWS_MENTIONS,
  STRONG_KEYWORDS,
  MEDIUM_KEYWORDS,
  POSITIVE_KEYWORDS,
  NEGATIVE_KEYWORDS,
  SEMI_SPECIFIC_THEME_NAMES,
  MEMORY_KEYWORDS,
  GENERIC_SEMI_THEME_NAME,
  MAX_STOCKS,
};
