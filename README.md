# 연오랑 동적 관제탑 (stock-dashboard-live)

GitHub Pages로 서빙하던 **정적 관제탑**(`deploy_repo/`)의 **9대 탭 전체 화면과 기능을 100% 그대로 이식**하고,
서버(Vercel Serverless Functions)가 실시간 데이터를 직접 받아오는 **동적 웹앱**입니다.
정적 본체 저장소는 건드리지 않았고, 이 저장소만 Vercel에 Import하면 바로 열립니다.

```
public/index.html          증시 실시간 관제탑 — 9대 탭 풀버전 (3.5MB 단일 파일, 차트·브리핑 모달·데이터셋 그대로)
public/deals.html          패밀리 특가 레이더 — 여행·키즈·캘린더 + 🛒 쇼핑 최저가 탭
public/live-api.js         동적 연동 레이어 (15초 지수/감시종목 · 30초 1·3·5탭 · RN존 실시간 종목 조회)
public/deals-shopping.js   쇼핑 최저가 Top 5 렌더러 (키 미등록 시 안내 배너로 대체)
public/sw.js               PWA 서비스워커 (network-first, 캐시 없음)
public/manifest.json       PWA 매니페스트
public/downloads/          앱 아이콘 192/512
api/stock-live.js          지수·환율·해외선물·종목 현재가
api/tabs-live.js           1·3·5번 탭 — 8대 테마 32종목·52주 신고가·100억+ 상한가·최신 뉴스 12건
api/live-briefing.js       ⚡ 클릭 순간 실시간 팩트 브리핑 (지수·선물·환율·급등/대금 상위·최신 뉴스)
api/stock-chart.js         종목명/코드 → 60거래일 일봉 + RN 지지/저항
api/deals-shopping.js      네이버 쇼핑 최저가 Top 5
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
    기존 타임라인·과거 유사사례 섹션은 그대로 보존됩니다.
- 세션 레이더 바에 **`⚡ 동적 LIVE HH:MM:SS 갱신`** 배지 + **`⚡ 1·3·5탭 LIVE HH:MM:SS 갱신`** 배지: 정상(초록) / 실패(주황).
- **주말·휴장 표기 수정**: 토·일에는 세션 레이더가 `🌙 [주말 휴장]`(다음 정규장 월요일 09:00)으로 표시됩니다(기존에는 주말에도 `[정규장 진행 중]`).
- **RN존 감시 종목 11종목**의 현재가·등락률·통합 거래대금을 실시간 갱신
  (카드마다 `당일 대금` 줄, 차트 헤더 옆 `당일 대금` 칩).
- **RN존 탭 상단 🔎 실시간 종목 조회**: 종목명/6자리 코드 입력 → `/api/stock-chart` 로
  **60거래일 일봉 캔들 + RN 지지/저항 + 1차/2차 타점·목표가**를 즉시 계산해 목록 맨 앞에 추가하고 차트를 그립니다.
- **API 가 죽어도 화면은 그대로**: 실패 시 내장(정적) 데이터를 유지하고 배지만 `⚠️ API 연결 실패 · 내장 데이터 유지` 로 바뀝니다.
- **`⚡ 실시간 브리핑` 버튼 = 클릭 순간 실시간 팩트 브리핑**
  버튼을 누른 그 순간 `/api/live-briefing` 이 **코스피·코스닥 지수/거래대금 · 원/달러 · 나스닥100(NQ=F)·S&P500(ES=F) 선물 ·
  실시간 급등/거래대금 상위 6종목 · 최신 증시 뉴스 5건**을 병렬 수집해 모달 최상단
  **`⚡ 지금 이 순간 실시간 팩트 브리핑 (HH:MM:SS)`** 섹션으로 즉시 렌더합니다. 모달 안의
  **`🔄 방금 시점으로 다시 브리핑`** 버튼은 `?fresh=1` 로 캐시를 건너뛰고 다시 받아옵니다.
  그 아래에는 기존 **정시(평일 14회) AI 심층 브리핑 전문**이 그대로 보존됩니다(시점이 다른 스냅샷임을 명시).
  수치·뉴스는 확인된 응답값만 표시하고, 없는 값은 `—` 로 두며 코멘트·전망 문장을 지어내지 않습니다.

### 2) 패밀리 특가 레이더 `deals.html` — 5탭 (정적 본체 4탭 + 쇼핑 1탭)
`🔎 여행·키즈 맞춤 검색기` · `✈️ 국내&해외 여행 특가(11건)` · `🎪 키즈카페·박물관(11건)`
· `📅 다가오는 특가 & 예약 캘린더(9건)` · **`🛒 쇼핑 실시간 최저가 Top 5`(신규)**

- 상단 헤더의 `📈 주식 관제탑 가기` 링크는 `/index.html` 로 연결됩니다.
- 쇼핑 탭: 키워드 입력 → `/api/deals-shopping` → **최저가순 Top 5**(이미지·가격·판매처·직통 링크).
- 네이버 API 키가 없으면 **키 연동 안내 배너 + 네이버쇼핑 직통 링크**로 대체(오류 아님).

## API

| 엔드포인트 | 설명 | 캐시 |
|---|---|---|
| `GET /api/stock-live` | 코스피·코스닥, 원/달러, 나스닥100(NQ=F)·S&P500(ES=F) 선물, 종목 현재가·등락률·통합 거래대금 | `s-maxage=10, swr=20` |
| `GET /api/stock-chart?q=지니언스` | 종목명 → 코드 자동 해석 후 60거래일 일봉 + RN 지지/저항 5단계 | `s-maxage=60, swr=300` |
| `GET /api/stock-chart?code=005930` | 코드 직접 지정 | 동일 |
| `GET /api/deals-shopping?q=돼지고기 국내산 1kg` | 네이버 쇼핑 최저가순 Top 5 | `s-maxage=300, swr=600` |
| `GET /api/live-briefing` | 클릭 순간 실시간 팩트 브리핑 — 지수·선물·환율·급등/거래대금 상위 6종목·최신 뉴스 5건 + `marketPhase`/`headline` 구조화 JSON | `s-maxage=15, swr=30` (`?fresh=1` → 5/10) |
| `GET /api/tabs-live` | **1·3·5번 탭 실시간** — 8대 테마 32종목 시세(시/고/저·통합 거래대금), 52주 신고가(대금순·상승률순), 거래대금 100억+ 진성 상한가·+25% 임박·관찰·제외, 최신 뉴스 12건 | `s-maxage=15, swr=30` (`?fresh=1` → 5/10) |

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

## 로컬 실행 · 검증

```bash
npm run check                 # 모든 서버·프론트 JS 구문 검사
node test_local.mjs           # 실제 네이버·야후 응답으로 53개 항목 검증 (stock-live/chart/deals/live-briefing/tabs-live)
node dev_server.mjs           # http://localhost:8787 (public/ 정적 + /api/* 핸들러 그대로)
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
