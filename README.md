# 연오랑 동적 관제탑 (stock-dashboard-live)

GitHub Pages로 서빙하던 **정적 관제탑**(`deploy_repo/`)의 **9대 탭 전체 화면과 기능을 100% 그대로 이식**하고,
서버(Vercel Serverless Functions)가 실시간 데이터를 직접 받아오는 **동적 웹앱**입니다.
정적 본체 저장소는 건드리지 않았고, 이 저장소만 Vercel에 Import하면 바로 열립니다.

```
public/index.html          증시 실시간 관제탑 — 9대 탭 풀버전 (3.5MB 단일 파일, 차트·브리핑 모달·데이터셋 그대로)
public/deals.html          패밀리 특가 레이더 — 여행·키즈·캘린더 + 🛒 쇼핑 최저가 탭
public/content-studio.html ✍️ 올인원 콘텐츠 스튜디오 — 관제탑/특가/유튜브/자유주제 → 제목 3안·블로그 원고·쇼츠 대본·썸네일·원고 보관함
public/content-engine.js   콘텐츠 생성 엔진 v1.1(브라우저 + 서버 공용, UMD) — 추출 요약 · 제목 3안 · 표/실전 포인트 · 리치 HTML · 쇼츠 MP4 스펙
public/live-api.js         동적 연동 레이어 (15초 지수/감시종목 · 30초 1·3·5탭 · RN존 실시간 종목 조회)
public/live-extra.js       1·2·3번 탭 잔여 고도화 (신호등 6칩 자동 생성 · NXT 랭킹 · 수급 카드 · 요약 문장)
public/deals-shopping.js   쇼핑 최저가 Top 5 렌더러 (키 미등록 시 안내 배너로 대체)
public/sw.js               PWA 서비스워커 (network-first, 캐시 없음) — scope /
public/manifest.json       PWA 매니페스트 (연오랑 관제탑, scope ./)
public/pokemon/manifest.json  포켓몬 배틀 월드 매니페스트 (id·start_url·scope = /pokemon/)
public/pokemon/sw.js          포켓몬 배틀 월드 서비스워커 (scope /pokemon/)
public/ebook.html          📖 eBook 오디오북 — TXT 뷰어 + 세미 오디오북 (단일 파일, 외부 의존 없음)
public/ebook/manifest.json    eBook 매니페스트 (id·start_url = /ebook.html, scope = /ebook/)
public/ebook-standalone-manifest.json  독립 eBook 도메인용 매니페스트 (start_url = /, scope = /)
public/ebook/sw.js            eBook 서비스워커 (scope /ebook/, 캐시 접두사 ebook-reader-)
public/ebook-root-sw.js       독립 eBook 도메인용 루트 서비스워커 (scope /)
public/ebook-icon.svg         eBook 앱 아이콘(책+헤드폰) — 192/512 PNG 동봉
check-inline.mjs           HTML 안의 인라인 <script> 구문 검사기 (index.html 3.5MB 본체 보호용)
public/downloads/          앱 아이콘 192/512
api/stock-live.js          지수·환율·해외선물·종목 현재가
api/tabs-live.js           1·3·5번 탭 — 8대 테마 32종목·52주 신고가·100억+ 상한가·최신 뉴스 12건(키워드 영향도·수혜주)
lib/news-impact.js         뉴스 제목·요약 키워드 → 영향도·테마·수혜종목 매칭 규칙
api/live-briefing.js       ⚡ 클릭 순간 실시간 팩트 브리핑 (지수·선물·환율·급등/대금 상위·최신 뉴스)
api/stock-chart.js         종목명/코드 → 60거래일 일봉 + RN 지지/저항
api/deals-shopping.js      네이버 쇼핑 최저가 Top 5
api/content-studio.js      ✍️ 콘텐츠 스튜디오 API — ?url=유튜브요약(oEmbed+Piped 자막) / ?mode=stock|deals|topic 서버 원고 생성 (titleSet·hook·points·shortsJson 포함)
lib/http.js                fetch 타임아웃 · EUC-KR 디코딩 · 숫자/금액 파싱 공용 유틸
vercel.json                /api/* 함수 + public/ 정적 서빙 설정
dev_server.mjs             Vercel 없이 로컬에서 그대로 띄우는 개발용 서버
test_local.mjs             API 실동작 테스트 (실제 네이버·야후 응답, 41개 항목)
```

## 화면 구성

### 1) 주식 관제탑 `index.html` — 9대 탭 (정적 본체와 동일)
`⚡ 메인(테마·신고가·상한가)` · `💰 수급 주도주` · `🌙 애프터마켓` · `📊 시장&수급 심층 분석`
· `📰 시간별 뉴스` · `🎯 RN존 실전 차트` · `🎯 만쥬 종가베팅` · `🏆 종가베팅 마스터` · `📅 증시 일정`

상단 헤더의 `✈️ 특가 레이더` 링크는 `/deals.html` 로 연결됩니다.

**PIN 0623 잠금**: 처음 열면 다크 PIN 키패드 화면이 뜨고 `0623` 을 넣어야 본문이 보입니다
(키패드·키보드 숫자키·Backspace·Enter). `이 기기에서 유지`(기본 체크)를 켜면 `localStorage`,
끄면 `sessionStorage` 에만 남아 탭을 닫으면 다시 잠깁니다. 헤더의 `🔒 잠금` 버튼으로 언제든 재잠금.
**이 잠금은 화면만 가리는 오버레이**라, 잠긴 동안에도 `/api/stock-live`·`/api/tabs-live` 와
9대 탭 데이터 로드는 그대로 돌아갑니다. (해제 엔진은 본문 스크립트와 분리된 전용 `<script>` 블록 —
관제탑 본체 JS 가 어떤 이유로 멈춰도 잠금 해제는 항상 동작)

**동적 연동 추가분 (기존 화면은 삭제·변경 없음)**
- 페이지 로드 직후 + **15초마다** `/api/stock-live` 호출 →
  상단 티커의 **코스피 · 코스닥 · 나스닥선물(NQ=F) · 원/달러**를 실시간 값으로 갱신하고,
  **S&P500선물(ES=F)** 타일은 동적 값이 들어올 때만 나스닥선물 옆에 새로 표시됩니다.
- 페이지 로드 직후 + **30초마다**(+ **`🔄 즉시 새로고침`** 클릭 시 `?fresh=1`) `/api/tabs-live` 호출 →
  **1 · 3 · 5번 탭**이 실시간으로 갱신됩니다.
  - **1번 메인 탭**: 8대 테마 **32종목 카드 전체**의 현재가·등락률·시/고/저·거래대금,
    테마 헤더의 **평균 등락률 / 합산 거래대금**, **52주 신고가 돌파** 카드, **거래대금 100억+ 진성 상한가 · +25% 임박** 카드가
    실시간 재구성됩니다(카드를 누르면 열리는 상세 모달 인자도 실시간 값으로 다시 씌워집니다).
    상한가/임박은 **`상승률 +25% 이상 & 거래대금 100억 이상`** 만 인정하고 **100억 미만 소형주는 제외 목록**으로 분리합니다.
  - **3번 애프터마켓 · 5번 시간별 뉴스 탭**: 탭 **최상단**에 **최신 증시 속보 12건**(시간·언론사·제목·요약·기사 원문 링크)이 실시간 렌더됩니다.
    각 속보에는 **키워드 규칙 기반 자동 분석 결과**가 붙습니다.
    - **영향도 배지** `📈 호재 · 상`(빨강) / `⚠️ 주의 · 상`(노랑) / `➖ 중립 · 중`(회색) / `📌 참고`(회색)
    - **매칭 테마 태그**(8대 주도 테마 + 반도체·HBM / 우주항공 / 방산 / 원전 / 2차전지 / 바이오 / 엔터 / 자동차 / 금리·환율·미 증시)
    - **수혜·관련주 칩**(종목명 + 코드 표시, 누르면 RN존 실전 차트로 조회, `↗`는 네이버 호가창)
    - **한 줄 자동 분석 노트** (`키워드 자동 분석 · '반도체·HBM' 언급 → … 테마 · 강도 상(폭락)`)
    섹터·종목 키워드가 없는 기사는 **테마·수혜주를 비우고 `📌 참고`**로 남깁니다(억지 매칭 금지).
    기존 타임라인·과거 유사사례 섹션은 그대로 보존됩니다.
- 세션 레이더 바에 **`⚡ 동적 LIVE HH:MM:SS 갱신`** 배지 + **`⚡ 1·3·5탭 LIVE HH:MM:SS 갱신`** 배지: 정상(초록) / 실패(주황).
- **주말·휴장 표기 수정**: 토·일에는 세션 레이더가 `🌙 [주말 휴장]`(다음 정규장 월요일 09:00)으로 표시됩니다(기존에는 주말에도 `[정규장 진행 중]`).
- **RN존 감시 종목 11종목**의 현재가·등락률·통합 거래대금을 실시간 갱신
  (카드마다 `당일 대금` 줄, 차트 헤더 옆 `당일 대금` 칩).
- **RN존 탭 상단 🔎 실시간 종목 조회**: 종목명/6자리 코드 입력 → `/api/stock-chart` 로
  **60거래일 일봉 캔들 + RN 지지/저항 + 1차/2차 타점·목표가**를 즉시 계산해 목록 맨 앞에 추가하고 차트를 그립니다.
- **1번 탭 상단 `🎯 실전 타점 신호등` 6칩 자동 생성 (`public/live-extra.js`)**
  RN존 11종목의 60일봉·RN 지지/저항 **실측값**으로 칩을 다시 만듭니다.
  `하단 RN 터치·안착` · `상단 RN 터치 후 눌림` · `100억+ 진성 상한가` · `52주 신고가 대금주` ·
  `RN 1차 타점 근접` · `RN존 통합대금 최대` · `하단 RN 근접/이탈` 중 근거가 있는 것만 최대 6개(없으면 억지 생성 없음).
  칩 배지에 `RN 실측 HH:MM:SS 갱신`(또는 `내장 60일봉 기준 · 실측 갱신 대기`)을 표기하고, 누르면 RN존/1번 탭으로 이동합니다.
- **6번 탭을 열지 않아도 RN존 11종목 실측 백그라운드 갱신**: 페이지 로드 후 조용히 4종목씩 순차 `/api/stock-chart` 를 호출합니다(신호등 칩이 즉시 최신 실측치가 됨).
- **3번 애프터마켓 NXT 랭킹 Top 6 실시간화**: 현재가·등락률·`통합대금(KRX+NXT)` 을 `/api/stock-live` 로 갱신하고 **통합대금 내림차순으로 카드를 재정렬**(TOP 1~6 라벨 재부여). 상태 문구(🟢/🟡/🔵)는 표시 등락률에서 자동 산출합니다. 순위는 이 6종목 안에서의 순위임을 명시합니다.
- **3번 탭 상단 요약 문장 실시간화**: 코스피·코스닥·나스닥100선물(NQ=F)·S&P500선물(ES=F) 만 실시간으로 갱신합니다.
  **KRX 야간선물(837.50)·코스피200 주간선물**은 공개 실시간 API 가 없어 `공개 실시간 API 없음 · 직전 확정`으로 **분리 표기**합니다(가짜 실시간 표기 금지).
- **2번 수급 탭 종목 카드 현재가·등락률 실시간화**: 카드의 종목명을 6자리 코드로 매핑해 `/api/stock-live` 값으로 현재가·등락률만 갱신합니다.
  **외인·기관·연기금 순매수 금액은 KRX 장마감 확정치**이므로 건드리지 않고, 탭 상단에 그 사실을 명시합니다.
- **9번 달력·8번 DART 배지 정직화**: 자동 실시간 갱신 API 가 없는데 `실시간 자동 갱신 05:31:08` 처럼 보이던 문구를 `정기 백엔드 반영 기준` / `DART 전자공시 정기 스캔 결과(자동 실시간 아님)` 로 바꿨습니다.
- **API 가 죽어도 화면은 그대로**: 실패 시 내장(정적) 데이터를 유지하고 배지만 `⚠️ API 연결 실패 · 내장 데이터 유지` 로 바뀝니다.
- **`⚡ 실시간 브리핑` 버튼 = 클릭 순간 실시간 팩트 브리핑**
  버튼을 누른 그 순간 `/api/live-briefing` 이 **코스피·코스닥 지수/거래대금 · 원/달러 · 나스닥100(NQ=F)·S&P500(ES=F) 선물 ·
  실시간 급등/거래대금 상위 6종목 · 최신 증시 뉴스 5건**을 병렬 수집해 모달 최상단
  **`⚡ 지금 이 순간 실시간 팩트 브리핑 (HH:MM:SS)`** 섹션으로 즉시 렌더합니다. 모달 안의
  **`🔄 방금 시점으로 다시 브리핑`** 버튼은 `?fresh=1` 로 캐시를 건너뛰고 다시 받아옵니다.
  그 아래에는 기존 **정시(평일 14회) AI 심층 브리핑 전문**이 그대로 보존됩니다(시점이 다른 스냅샷임을 명시).
  수치·뉴스는 확인된 응답값만 표시하고, 없는 값은 `—` 로 두며 코멘트·전망 문장을 지어내지 않습니다.

### 2) 포켓몬 배틀 월드 `/pokemon/` — 관제탑과 분리된 독립 PWA

같은 오리진에 있지만 **홈 화면 앱으로는 완전히 별개**로 설치되도록 스코프를 나눠 두었다.

| | 연오랑 관제탑 | 포켓몬 배틀 월드 |
|---|---|---|
| 매니페스트 | `/manifest.json` (`scope: ./` → `/`) | `/pokemon/manifest.json` (`id·start_url·scope` 모두 `/pokemon/`) |
| 서비스워커 | `/sw.js` (`scope: /`) | `/pokemon/sw.js` (`scope: /pokemon/`, 캐시 접두사 `pkm-world-`) |
| 진입 | `/` | `/pokemon/` (런처), `/pokemon/{math,hangul,english,versus,village}-pokemon.html` |

- **URL 매핑**: `vercel.json` 의 `rewrites` 가 `/pokemon/` → `/pokemon-battle.html`, `/pokemon/:path*` → `/:path*` 로 넘긴다.
  HTML 은 `public/` 루트에 한 벌만 두고 두 주소에서 함께 쓴다(사본 없음). `public/pokemon/` 의 실파일(매니페스트·SW)이 항상 우선한다.
- **기존 주소 호환**: `/pokemon-battle.html` 등 루트 주소도 그대로 200 이고, 안의 링크·매니페스트는 `/pokemon/` 기준이라 열어도 새 앱 스코프로 들어간다.
- **페이지 사이 이동은 반드시 `/pokemon/...` 안에서** 한다(런처 ↔ 산수/한글/영어/2인대결/마을). 그래야 설치된 앱 창이 풀리지 않는다.
- 공용 리소스(`/api/tts`, `/pokemon-db.json`, `/hangul-bank.json`, `/english-bank.json`, 아이콘)는 절대경로 그대로 쓰고,
  같은 오리진이므로 `localStorage`(`pkm.shared.dex.v1.*`, `pkm.quota.v1`, 마을 저장)는 두 앱이 그대로 공유한다.
- 검증: `BASE=<주소> node /workspace/_tools/e2e/pk4_scope.mjs` (매니페스트·SW scope·5개 페이지 이동·콘솔 에러·localStorage 공유 실측)

#### 마을(`village-pokemon.html`) — 4대 수채화 테마 · 가로/세로 · 마을별 독립 배치

| 항목 | 내용 |
|---|---|
| 테마 | 🌿 **초원**(기본) · 🏖️ **바다 해변**(도감 10마리) · 🏔️ **산속 고원**(20) · 🏜️ **사막 오아시스**(30) — `THEMES` 배열에 `need` 한 줄만 더하면 40·50마리 마을이 된다. `guest` 프로필은 체험용으로 전부 열림 |
| 그림 | `/art/village-{day,sunset,night}[,-wide].webp` (초원) · `/art/village-{beach,mountain,desert}[,-wide].webp` — 무대가 가로로 넓으면(비율 ≥1.15) 자동으로 `-wide`(16:9), 아니면 정사각 |
| 노을·밤 | 초원은 시간대별 그림 3장, 사진 테마 3종은 낮 그림 + `.art` 색 보정 + `.wash`(빛막, 밤은 multiply) + `.glow`(별·달빛·해 장식)로 만든다 |
| 소품 | `/assets/props/*.png` — 수채화 12종(벤치·돗자리·모닥불·텐트·꽃아치·우물·해먹·표지판·랜턴·화단·보물상자·통나무), `POK_PROPS` SVG·이모지보다 우선하고 파일 이름이 아이템 키와 같다 |
| 배치 | 마을(테마)별로 따로 저장 — `pkm.village.v2.{profile}.{theme}`. 예전 단일 저장(`pkm.village.v1.*`)은 초원 마을로 자동 이전(손실 0). 다른 마을에 산 포켓몬은 `🌿 초원 거주중` 배지로 보이고 누르면 이사 확인을 거친다 |
| 검증 | `node /workspace/_tools/e2e/village_wide.mjs` (1100×800·884×960·400×860 × 테마 4종·노을/밤·잠금·이사·콘솔 0) |

### 3) eBook 오디오북 `/ebook/` · `/ebook.html` — 독립 PWA

TXT 파일을 책처럼 넘겨 읽고, 대사와 지문을 구분해 장면 효과음까지 깔아 주는 세미 오디오북.
파일 하나(`public/ebook.html`)로 끝나며 외부 CSS/JS 에 의존하지 않는다.

| | 연오랑 관제탑 | eBook 오디오북 |
|---|---|---|
| 매니페스트 | `/manifest.json` (`scope: ./`) | `/ebook/manifest.json` (`start_url: /ebook.html`, `scope: /ebook/`) |
| 서비스워커 | `/sw.js` (`scope: /`) | `/ebook/sw.js` (`scope: /ebook/`, 캐시 접두사 `ebook-reader-`) |
| 진입 | `/` | `/ebook.html`, `/ebook/` (`vercel.json` rewrite) |

**독립 도메인 `yeonolang-ebook.vercel.app`** — 같은 저장소를 별도 Vercel 프로젝트로 한 번 더 배포한 eBook 전용 주소.

| | 값 |
|---|---|
| 루트(`/`) | `vercel.json` 의 `has: host` **redirect** → `/ebook.html` (rewrite 는 파일이 있으면 진다 — `redirects` 는 파일시스템보다 먼저 처리됨) + `index.html` 최상단 호스트 분기 스크립트가 2중 안전망 |
| 매니페스트 | `/ebook-standalone-manifest.json` (`start_url: /ebook.html`, `scope: /`, `id: /`) |
| 서비스워커 | `/ebook-root-sw.js` (`scope: /`, `Service-Worker-Allowed: /`) |
| 설치 이름 | 연오랑 eBook 오디오북 / eBook |

호스트 이름에 `ebook` 이 들어가면(운영·프리뷰·커스텀 도메인 모두) eBook 이 첫 화면이 되고,
관제탑 주소(`stock-dashboard-live-bice.vercel.app`)에서는 분기가 동작하지 않아 PIN 잠금·9대 탭이 그대로다.

- **TXT 열기**: 드래그&드롭 · 파일 선택. `TextDecoder('utf-8',{fatal:true})` 실패 시 `euc-kr` 로 자동 폴백.
  올린 책은 IndexedDB(`ebook-library`), 읽던 위치·책갈피·형광펜·설정은 `localStorage` 에만 저장(서버 전송 없음).
- **본문 구조**: `제1장`·`1장`·`Chapter 1`·`1.`·`프롤로그/에필로그` 등을 장으로 인식해 목차 드로어를 만들고,
  장 첫머리는 새 쪽에서 시작한다. 문단은 문장 단위 `<span class="sn">` 로 쪼개 대사(`"…"`, `“…”`, 「…」)와 지문을 구분한다.
- **화면**: 멀티컬럼 페이지 엔진. 넓은 화면(≥780px) 2쪽 펼침(책등 표시) / 좁은 화면 1쪽, 푸터에서 전환 가능.
  좌우 화면 끝 탭·스와이프·←/→ 키로 넘김, 진행률 슬라이더, 글자 14~26px · 줄간격 1.4~2.4 · 고딕/명조 · 종이/세피아/검은바탕.
- **몰입 모드**: 본문 가운데를 한 번 탭하면 상·하단 바가 .32s 모션으로 접혀 전체 화면 읽기, 다시 탭하면 복귀(바가 접힌 뒤 본문을 새 높이로 다시 편다).
- **책장 넘김 모션**: `goSpread` 가 방향을 알고 `#pageTurn` 슬라이드+페이드(.30s)와 `#turnShade` 종이 그림자 스윕(.34s)을 함께 건다. `prefers-reduced-motion` 이면 둘 다 끔.
- **형광펜**: 문장을 460ms 길게 누르거나 끌어서 선택하면 노랑·민트·분홍·지우기 팝업(`#hlPop`)이 뜨고, 색은 `localStorage(ebook.highlights.v1)` 에 책별(`book.id` → 문장번호)로 저장된다.
  목차 드로어의 `🖍 형광펜` 탭이 모아보기 — 누르면 그 문장으로 바로 점프(책갈피 탭과 토글).
- **본문 검색**: 헤더 `🔍` → 책 전체 `b.sentences` 를 훑어 장 이름·앞뒤 문맥과 함께 `<mark>` 로 보여주고, 누르면 해당 문장으로 이동(최대 150건 표시, 총 건수 별도).
- **세미 오디오북(`/api/tts`)**: 문장 단위로 낭독하며 현재 문장을 하이라이트하고 쪽 끝에서 자동으로 넘긴다.
  대사는 속도·호흡(서버 음성) / 음높이(기기 음성)로 지문과 구분. `/api/tts` 가 실패하면 `speechSynthesis` 로 자동 폴백.
- **화자 힌트 톤 분리**: 대사 앞뒤 3문장에서 노인/아이/여성/남성 키워드를 점수화(가까운 문장·`말했다/물었다` 가중, 호칭이면 반대편 화자 보정)해
  기기 음성은 `pitch` 0.80(노인)~1.28(아이)·`rate`, 서버 음성은 `speed=0.5~1`(`ttsspeed`)과 대사 앞뒤 쉼(pre 240ms/post 330ms 등)으로 호흡을 가른다.
- **수면 타이머**: 낭독 바의 `⏰ 타이머`(끄기→15분→30분→이 장 끝 순환)와 오디오 시트의 4버튼. 남은 시간을 1초마다 표시하고,
  만료·장 끝이면 `Ambience.fadeOut()` + `<audio>.volume` 램프로 0.9초 페이드아웃 후 정지한다.
- **검은 바탕(OLED)**: `--bg/--page #000000` + 글자 `#d4d8df`(눈 부심 억제). 설정 시트 3번째 버튼과 헤더 원터치 `🌙/☀️` 버튼 두 곳에서 즉시 전환.
- **장면 효과음**: 비·천둥·바람·숲·밤·긴장·발소리·파도·불 키워드를 감지해 **Web Audio 합성음**을 겹친다(외부 오디오 파일 0).
  ON/OFF·볼륨 조절, 낭독을 멈추면 함께 멈춘다.
- 검증: `node /workspace/_tools/e2e/ebook_local.mjs` (3화면 넘침·목차 점프·2쪽/1쪽·낭독 하이라이트·EUC-KR·이어보기·`/ebook/` 리라이트)
  · v2: `/workspace/_ebook_v2/test_local_v2.mjs`(몰입·책장넘김·형광펜·검색·수면타이머·화자힌트·OLED·3화면 넘침) 와 `test_branch_v2.mjs`(호스트 분기)

### 4) 패밀리 특가 레이더 `deals.html` — 5탭 (정적 본체 4탭 + 쇼핑 1탭)
`🔎 여행·키즈 맞춤 검색기` · `✈️ 국내&해외 여행 특가(11건)` · `🎪 키즈카페·박물관(11건)`
· `📅 다가오는 특가 & 예약 캘린더(9건)` · **`🛒 쇼핑 실시간 최저가 Top 5`(신규)**

- 상단 헤더의 `📈 주식 관제탑 가기` 링크는 `/index.html` 로 연결됩니다.
- 쇼핑 탭: 키워드 입력 → `/api/deals-shopping` → **최저가순 Top 5**(이미지·가격·판매처·직통 링크).
- 네이버 API 키가 없으면 **키 연동 안내 배너 + 네이버쇼핑 직통 링크**로 대체(오류 아님).

## 📊🎯 전략 자동 재스캔 · ⭐ 관심종목

### 1) 비중법사 · 홍인기 자동 재스캔 — `scripts/rescan_strategies.py`

전 종목(코스피·코스닥 2,400여 종목 · ETF/우선주/스팩 제외)의 **fchart 일봉 260개**를 다시 받아
`비중법사 기준봉·1일차`와 `홍인기 D+0·D+1·D+2` 후보를 매번 새로 계산하고, 관제탑(`public/index.html`)의
**내장 스냅샷(DATA)** 과 `public/data/*.json` 을 최신 기준일로 갈아끼운다. 카드 UI·4분할선·200일 캔들·
타점 계산 로직은 그대로 두고 데이터만 교체한다.

```bash
python3 scripts/rescan_strategies.py                 # 오늘 장마감(15:35) 이후 기준 1회 · 최신이면 skip
python3 scripts/rescan_strategies.py --if-stale-hours 6   # 스케줄러용: 6시간 안에 갱신했으면 skip
python3 scripts/rescan_strategies.py --force         # 무조건 다시 스캔
python3 scripts/rescan_strategies.py --dry           # JSON만 생성(HTML 미반영)
python3 scripts/rescan_strategies.py --check          # 네트워크 없이 현재 index.html 구문·구조 점검
```

- 기준일은 **KOSPI 지수 일봉의 마지막 거래일**(공휴일 자동 반영)이며, 15:35 이전에는 미완성 당일 봉을 쓰지 않고 직전 거래일로 잡는다.
- 일봉 캐시 `scripts/.cache/candles.json.gz` 에 누적되고, 갱신이 필요한 종목만 최근 90봉을 다시 받는다(첫 실행만 260봉 전수).
- 출력: `public/data/strategies-latest.json`(통합) · `honginki-latest.json` · `bijoong-latest.json` + `index.html` 내장 DATA.
- 종료 코드 `3` = 일봉 수집이 시간 예산(기본 420초)에 걸림 → 다음 실행이 이어받는다(HTML은 건드리지 않음).
- 기준일이 넘어가면 카드 문장의 날짜(11/13·11/16 등)도 **데이터에서 계산**해 함께 바뀐다(`DATA.days` · `basisLongLabel` · `nextLabel`).

### 2) 관심종목(★) · 매수/손절 메모 · 클라우드 동기화 — `public/watchlist.js`

- 모든 종목 카드(메인 테마 타일 · 수급 · 비중법사 · 홍인기 · RN존 · 만쥬 · 종목 모달)에 **☆/★** 를 붙이고,
  누르면 **매수 희망가 · 손절가 · 메모**를 적는 편집기가 열린다(다시 누르면 수정).
- 헤더 **★ 관심종목** 버튼 → 모아보기 드로어(수정·차트·해제) + **★만 보기** 필터(카드 전체에 즉시 적용).
- 저장: `localStorage['stock.watch.v1']` + Supabase `family_sync` 의 **`stock_0623`** 네임스페이스(포켓몬 `0623` 과 분리).
  항목별 `at`(수정 시각) 기준 병합, 삭제는 tombstone, 빈 기기가 클라우드를 지우지 않음. 60초 주기 + 복귀 시 자동 맞춤.

## API

| 엔드포인트 | 설명 | 캐시 |
|---|---|---|
| `GET /api/stock-live` | 코스피·코스닥, 원/달러, 나스닥100(NQ=F)·S&P500(ES=F) 선물, 종목 현재가·등락률·통합 거래대금 | `s-maxage=10, swr=20` |
| `GET /api/stock-chart?q=지니언스` | 종목명 → 코드 자동 해석 후 60거래일 일봉 + RN 지지/저항 5단계 | `s-maxage=60, swr=300` |
| `GET /api/stock-chart?code=005930` | 코드 직접 지정 | 동일 |
| `GET /api/deals-shopping?q=돼지고기 국내산 1kg` | 네이버 쇼핑 최저가순 Top 5 | `s-maxage=300, swr=600` |
| `GET /api/live-briefing` | 클릭 순간 실시간 팩트 브리핑 — 지수·선물·환율·급등/거래대금 상위 6종목·최신 뉴스 5건 + `marketPhase`/`headline` 구조화 JSON | `s-maxage=15, swr=30` (`?fresh=1` → 5/10) |
| `GET /api/tabs-live` | **1·3·5번 탭 실시간** — 8대 테마 32종목 시세(시/고/저·통합 거래대금), 52주 신고가(대금순·상승률순), 거래대금 100억+ 진성 상한가·+25% 임박·관찰·제외, 최신 뉴스 12건(각 뉴스에 `impactLevel`·`impactDirection`·`matchedThemes`·`beneficiaryStocks`·`impactNote` 자동 분석 필드) | `s-maxage=15, swr=30` (`?fresh=1` → 5/10) |

옵션: `stock-live?codes=005930,000660`(종목 지정), `?fresh=1`(메모리 캐시 무시),
`stock-chart?count=120`(봉 수 20~200), `deals-shopping?sort=asc|sim|date|dsc`.

### 데이터 소스
- 지수·국내종목: `polling.finance.naver.com/api/realtime` (키 불필요)
- 52주 신고가: `m.stock.naver.com/api/stocks/high52week/{KOSPI,KOSDAQ}`
- 급등·상한가: `m.stock.naver.com/api/stocks/up/{KOSPI,KOSDAQ}` (+100억·+25% 엄격 필터)
- 환율: `m.stock.naver.com/front-api/marketIndex/prices` → 실패 시 Yahoo `KRW=X`
- 해외선물: Yahoo `query1.finance.yahoo.com/v8/finance/chart/{NQ=F,ES=F}`
- 급등·거래대금 상위: `stock.naver.com/api/domestic/market/stock/default?orderType=up|priceTop` (KRX·KOSPI+KOSDAQ)
- 증시 뉴스: `stock.naver.com/api/domestic/news/list` → 실패 시 `.../news/search?query=증시`
- 일봉: `fchart.stock.naver.com/sise.nhn` (EUC-KR 디코딩)
- 종목명 검색: `ac.finance.naver.com/ac` → `m.stock.naver.com/front-api/search` → 내장 별칭표
- 쇼핑: `openapi.naver.com/v1/search/shop.json` (**NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 필요**)

## API 함수 수 제한 (Vercel Hobby 12개)

**`api/` 안의 `.js` 파일은 12개를 넘길 수 없다.** 넘기면 Vercel이 빌드를 `Deployment has failed`로 실패시키고 라이브는 옛 버전에 머문다
(2026-11-20 20:12 ~ 11-21 08:08 실제 발생 — `api/breadth.js` 13번째 파일 때문).

현재 12개: `content-ai` · `dart-live` · `econ-calendar` · `index-chart` · `live-briefing` · `macro-live` · `picks-search` · `stock-chart` · `stock-live` · `stock-trend` · `tabs-live` · `tts`

새 엔드포인트가 필요하면 **새 파일을 만들지 말고** 기존 함수에 `?mode=` 분기를 붙이고 `vercel.json` `rewrites` 로 옛 경로를 살린다.

- 예) 시장 폭(상승/하락 종목 수)은 `lib/breadth.js` 수집 모듈 + `api/macro-live.js` 의 `mode=breadth` 분기가 담당하고,
  `vercel.json` 이 `GET /api/breadth` → `/api/macro-live?mode=breadth` 로 rewrite 한다(경로·응답 그대로 유지).
- 배포 전 확인: `python3 scripts/check_api_count.py` (함수 수 + rewrite 목적지 존재 검사)

## 로컬 실행 · 검증

```bash
npm run check                 # 모든 서버·프론트 JS 구문 + HTML 인라인 <script> 구문 검사 (check-inline.mjs)
node test_local.mjs           # 실제 네이버·야후 응답으로 110개 항목 검증 (stock-live/chart/deals/live-briefing/tabs-live/신호등·NXT·수급 규칙)
node test_e2e_extra.mjs       # 헤드리스 E2E: 1·2·3·6·8·9번 탭 + 폴드8(884px) 넘침 + 콘솔·HTTP 오류 0
node dev_server.mjs           # http://localhost:8787 (public/ 정적 + /api/* 핸들러 그대로)
python3 scripts/check_js.py   # node 가 없을 때의 동일 범위 검사(esprima) — 인라인 <script>·DIV 균형 포함
python3 scripts/check_api_count.py  # api/ 함수 12개 한도 + rewrite 목적지 검사
python3 scripts/dev_server.py # node 없이 로컬 미리보기(정적 + /api/* 는 라이브 Vercel 프록시)
```

## Vercel 배포

1. Vercel → **Add New Project** → 이 저장소 Import (Framework Preset: **Other**, Root Directory: 그대로)
2. Settings → Environment Variables
   - `NAVER_CLIENT_ID`
   - `NAVER_CLIENT_SECRET`
   (네이버 개발자센터 → 애플리케이션 등록 → 사용 API: **검색**)
3. Deploy 후 `https://<프로젝트>.vercel.app/api/stock-live` 응답 확인 → `/` (관제탑) · `/deals.html` (특가 레이더)

키를 넣기 전에도 관제탑·차트·여행/키즈 특가는 모두 동작하고, 쇼핑 탭만 "키 연동 안내 + 네이버쇼핑 직통 링크"로 대체됩니다.

## 알려진 범위

- **주간선물·야간선물(KRX 06:00 확정)·필라델피아반도체(SOX)·WTI**는 무료 실시간 소스가 없어
  기존 내장 값(마지막 동기화 시점)으로 표시됩니다. 나머지 지표·종목은 동적 갱신입니다.
- 등락률은 두 기준을 함께 내려줍니다. `current.change/changePct`는 네이버 증권 화면과 같은 표기(전일 종가·시간외 반영),
  `closeChange`는 일봉 정규장 종가끼리의 비교입니다.
- 종목별 **외국인·기관 실시간 순매수**는 무료 공개 API가 없어 기존처럼 확정치 기반으로만 표시됩니다.
- 서버리스 함수는 `maxDuration: 10s` 기준으로 설계되어 외부 응답이 늦으면 개별 소스만 실패로 남고 나머지는 정상 반환합니다.
