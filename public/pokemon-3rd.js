/* ============================================================
   포켓몬 배틀 3탄 — 공통 데이터 (타입 상성 · 마을 꾸미기 아이템)
   ─ pokemon-battle2.js(3게임 공통) · versus-pokemon.html · village-pokemon.html 이 함께 쓴다.
   ─ 이 파일 하나만 고치면 세 곳이 같이 바뀐다.
   ============================================================ */
(function () {
  'use strict';
  if (window.POK3 && window.POK3.version) return;

  /* 공격 타입 → 효과가 굉장한(2배) 방어 타입 */
  var TYPE_CHART = {
    '노말': [],
    '불꽃': ['풀', '얼음', '벌레', '강철'],
    '물': ['불꽃', '땅', '바위'],
    '풀': ['물', '땅', '바위'],
    '전기': ['물', '비행'],
    '얼음': ['풀', '땅', '비행', '드래곤'],
    '격투': ['노말', '얼음', '바위', '강철', '악'],
    '독': ['풀', '페어리'],
    '땅': ['불꽃', '전기', '독', '바위', '강철'],
    '비행': ['풀', '격투', '벌레'],
    '에스퍼': ['격투', '독'],
    '벌레': ['풀', '에스퍼', '악'],
    '바위': ['불꽃', '얼음', '비행', '벌레'],
    '고스트': ['에스퍼', '고스트'],
    '드래곤': ['드래곤'],
    '악': ['에스퍼', '고스트'],
    '강철': ['얼음', '바위', '페어리'],
    '페어리': ['격투', '드래곤', '악'],
  };

  /* 마을 꾸미기 아이템 — zone 은 기본 느낌(한 풀밭에서는 모두 자유 배치),
     env:true 는 '환경 아이템'이라 가방 소모 없이 언제든 놓을 수 있다 */
  var ITEMS = [
    { k: 'pond', name: '물가 연못', emoji: '💧', zone: 'grass', env: true, desc: '반짝이는 연못을 풀밭에 직접' },
    { k: 'hill', name: '낮잠 언덕', emoji: '😴', zone: 'grass', env: true, desc: '둥글둥글 잔디 언덕' },
    { k: 'arena', name: '작은 배틀 연습장', emoji: '⚔️', zone: 'grass', env: true, desc: '모래로 다진 연습장' },
    { k: 'tent', name: '포켓몬센터 텐트', emoji: '⛺', zone: 'grass', desc: '빨간 지붕의 작은 치료소' },
    { k: 'statue', name: '피카츄 동상', emoji: '🗿', zone: 'grass', desc: '번쩍번쩍 돌로 만든 피카츄' },
    { k: 'cushion', name: '잠만보 쿠션', emoji: '🛋️', zone: 'hill', desc: '폭신폭신 낮잠 쿠션' },
    { k: 'ballpot', name: '몬스터볼 화분', emoji: '🪴', zone: 'grass', desc: '몬스터볼 모양 화분' },
    { k: 'berrytree', name: '오랑열매 나무', emoji: '🌳', zone: 'grass', desc: '열매가 주렁주렁' },
    { k: 'berrybasket', name: '열매 바구니', emoji: '🍇', zone: 'grass', desc: '갓 딴 열매를 담아 둔 바구니' },
    { k: 'campfire', name: '캠프파이어', emoji: '🔥', zone: 'grass', desc: '따뜻한 모닥불' },
    { k: 'fountain', name: '연못 분수', emoji: '⛲', zone: 'pond', desc: '물이 솟는 분수' },
    { k: 'flowerbed', name: '꽃밭', emoji: '🌷', zone: 'grass', desc: '알록달록 꽃밭' },
    { k: 'bench', name: '나무 벤치', emoji: '🪑', zone: 'grass', desc: '쉬어 가는 나무 의자' },
    { k: 'flag', name: '응원 깃발', emoji: '🚩', zone: 'arena', desc: '연습장 응원 깃발' },
    { k: 'arch', name: '배틀 아치', emoji: '🏟️', zone: 'arena', desc: '연습장 어구 — 드림 매치!' },
    { k: 'mailbox', name: '작은 우편함', emoji: '📮', zone: 'grass', desc: '친구에게 마음을 전해요' },
    { k: 'hammock', name: '낮잠 해먹', emoji: '🛌', zone: 'hill', desc: '나무 사이 둥실둥실 그네 침대' },
    { k: 'lantern', name: '별빛 랜턴', emoji: '🕯️', zone: 'hill', desc: '밤에 온은하게 빛나는 등' },
    { k: 'stones', name: '둥근 징검돌', emoji: '🪨', zone: 'pond', desc: '연못을 건너는 징검다리' },
    { k: 'sandcastle', name: '모래성', emoji: '🏰', zone: 'pond', desc: '연못가에 쌓은 모래성' },
    { k: 'parasol', name: '해변 파라솔', emoji: '⛱️', zone: 'pond', desc: '햇살을 가려 주는 파라솔' },
    { k: 'lamp', name: '몬스터볼 가로등', emoji: '🏮', zone: 'grass', desc: '밤을 밝히는 가로등' },
    { k: 'mat', name: '피크닉 매트', emoji: '🧺', zone: 'hill', desc: '도시락 싸 온 매트' },
    { k: 'mill', name: '미니 풍차', emoji: '🎡', zone: 'grass', desc: '빙글빙글 도는 풍차' },
    { k: 'star', name: '별빛 조명', emoji: '🌟', zone: 'hill', desc: '반짝반짝 별 조명' },
    { k: 'kite', name: '연 날리기', emoji: '🪁', zone: 'grass', desc: '하늘 높이 연' },
    { k: 'teddy', name: '포켓몬 인형', emoji: '🧸', zone: 'grass', desc: '꼭 안고 자고 싶은 인형' },
    { k: 'balloon', name: '풍선 장식', emoji: '🎈', zone: 'grass', desc: '생일 파티 같은 풍선' },
    { k: 'slide', name: '미끄럼틀', emoji: '🛝', zone: 'grass', desc: '쭉 미끄러져 내려오는 놀이기구' },
    { k: 'sign', name: '마을 표지판', emoji: '🪧', zone: 'grass', desc: '“환영해요!” 라고 적힌 팻말' },
    { k: 'log', name: '통나무 의자', emoji: '🪵', zone: 'grass', desc: '동그랗게 자른 통나무 의자' },
    { k: 'birdhouse', name: '새집', emoji: '🐦', zone: 'grass', desc: '구구가 찾아오는 작은 새집' },
    { k: 'boat', name: '작은 보트', emoji: '⛵', zone: 'pond', desc: '연못에 둥둥 떠 있는 배' },
    { k: 'waterfall', name: '작은 폭포', emoji: '🌊', zone: 'pond', desc: '시원하게 떨어지는 물줄기' },
    { k: 'fireflies', name: '반딧불 랜턴', emoji: '✨', zone: 'hill', desc: '밤하늘을 수놓는 작은 빛' },
  ];

  var byKey = {};
  ITEMS.forEach(function (it) { byKey[it.k] = it; });

  window.POK3 = {
    version: 1,
    typeChart: TYPE_CHART,
    items: ITEMS,
    item: function (k) { return byKey[k] || null; },
    itemKeys: function () { return ITEMS.map(function (it) { return it.k; }); },
    /* 공격 타입이 방어 타입 목록 중 하나라도 찌르면 true */
    strong: function (atkType, defTypes) {
      var list = TYPE_CHART[atkType];
      if (!list || !list.length) return false;
      var defs = Array.isArray(defTypes) ? defTypes : [defTypes];
      for (var i = 0; i < defs.length; i += 1) {
        if (list.indexOf(defs[i]) >= 0) return true;
      }
      return false;
    },
    /* 포켓몬(타입 배열)이 상대 포켓몬에게 유리한가 */
    strongPair: function (atkTypes, defTypes) {
      var a = Array.isArray(atkTypes) ? atkTypes : [atkTypes];
      for (var i = 0; i < a.length; i += 1) {
        if (window.POK3.strong(a[i], defTypes)) return true;
      }
      return false;
    },
  };
})();
