#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🦊 폭스시그널 · 장중 브리핑 (Gemini) → 텔레그램 자동 발송
================================================================
평일 10:00 · 11:00 · 13:00 · 14:00 KST 에 GitHub Actions 가 실행한다.
피클 크레딧을 쓰지 않고, Gemini API + 공개 실측 데이터만으로
정규 브리핑의 70~80% 분량(2,000~3,200자) 장중 브리핑을 만들어
텔레그램 채널(@fox_signal_stock)로 보낸다.

발송 + 관제탑 타임라인
  · 평일 09:30(장초반) · 10:00 · 11:00 · 13:00 · 14:00 회차를 텔레그램으로 보내고,
    같은 회차를 관제탑 1·7번 「시간별 수급 이동」 타임라인 슬롯(flow_timeline_today.json,
    index.html 내장 FLOW_TIMELINE, deploy_repo 미러)에 🤖 Gemini AI 작성 표기와 함께 넣는다.
    (09:30 은 타임라인의 '09:30' 슬롯, 헤더는 '🦊 폭스시그널 · 09:30 장초반 브리핑')
  · 텔레그램 공개 헤더에는 작성 주체 표기를 넣지 않는다(2026-11-26 사용자 요청).
  · Actions 에서는 JSON 만 커밋·push 한다(contents: write 필요).
  · 수동 백필: python3 scripts/intraday_gemini_telegram.py \
        --timeline-from artifacts/intraday.json --timeline-write

5블록 양식
  📌 한줄 요약            지수·외인 현선물 판정·대장 테마·대응 한 줄
  📊 핵심 지표 & 매크로    코스피·코스닥·선물(베이시스)·등락종목수·상한가·원/달러
  💰 투자자별 수급 & 해석  외인(현물·선물)·기관·개인·프로그램 + 왜/의미 해석
  🔥 주도 테마 & 대장주    300억↑ 실측 대장주·상승률·거래대금·재료 + 빠지는 섹터
  🧭 대응 시나리오         박스권·기준선 위치 + ① 돌파 ② 박스 ③ 이탈 때 내 계좌 행동·피할 것

원칙
  · 실측 팩트만 쓴다. 응답에 없는 숫자는 절대 만들지 않는다(검증기가 막는다).
  · 값이 없으면 "미수신"이라고 적는다(0·추정으로 채우지 않는다).
  · Gemini 가 실패하거나 검증을 통과하지 못하면, 같은 5블록 양식을 실측값으로만
    채운 대체(fallback) 본문을 보내고 헤더에 그 사실을 표기한다.

환경변수 (GitHub Secrets)
  GEMINI_API_KEY        Gemini API 키 (필수)
  TELEGRAM_BOT_TOKEN    텔레그램 봇 토큰 (필수, --dry-run 이면 없어도 됨)
  TELEGRAM_CHAT_ID      채널/채팅 id  예) @fox_signal_stock

중복 발송 방지 (기본 동작)
  · --dry-run 도 --force 도 없는 일반 운영 실행이면, 시작하자마자
    public/data/flow_timeline_today.json 을 읽어 오늘(date == 오늘) 그 회차(slot)가
    이미 state == 'done' 인지 본다. 이미 있으면 Gemini 호출·텔레그램 발송·타임라인
    덮어쓰기를 모두 건너뛰고 exit 0 으로 끝낸다(로그: [SKIP] today {slot} already done).
  · 이유: cron-job.org 가 정시에 부른 뒤 GitHub 자체 cron 이 몇 분 늦게 따라붙으면
    같은 회차가 두 번 발송됐다(2026-11-27).
  · 수동 재발송이 필요하면 --force 를 붙인다(가드 통과). --dry-run 도 가드를 지나
    실제로 생성·검증을 해 본다.

사용 예
  python3 scripts/intraday_gemini_telegram.py --dry-run
  python3 scripts/intraday_gemini_telegram.py --dry-run --slot 10:00 --force
  python3 scripts/intraday_gemini_telegram.py --skip-if-done --dry-run   # 예약 중복 방지
  python3 scripts/intraday_gemini_telegram.py --print-facts

데이터 소스
  · https://stock-dashboard-live-6frm.vercel.app/api/tabs-live
      주도 테마·구성종목·300억↑ 대장주·선물(KIS·베이시스)·뉴스·상한가·수급 참고
  · https://polling.finance.naver.com/api/realtime?query=SERVICE_INDEX:KOSPI,KOSDAQ
      코스피·코스닥 지수/등락/시고저/거래대금
  · https://stock-dashboard-live-6frm.vercel.app/api/live-briefing
      (네이버 폴링이 막힌 경우 지수 대체용)
  · https://m.stock.naver.com/api/index/{KOSPI,KOSDAQ}/integration
      전일 종가 · 상승/하락 종목수 · 프로그램 매매
  · https://m.stock.naver.com/api/index/{KOSPI,KOSDAQ,FUT}/trend
      외국인·기관·개인 순매수(현물 억원 / 선물 계약)
  · https://m.stock.naver.com/api/stocks/theme?page=1&pageSize=100
      업종(테마) 등락률 전수 → 받는 쪽 / 빠지는 쪽
  · https://m.stock.naver.com/api/stocks/theme/{no}
      약한 테마의 대표 종목(거래대금)
  · https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&reutersCode=FX_USDKRW
      원/달러 환율
  · public/data/supply-latest.json (있으면)
      외인·기관 순매수/순매도 상위 종목(확정 기준일) — 수급 해석 근거
  · scripts/analysis_context.py (심화 분석 헬퍼 · 무료·키 불필요)
      종목 최신 뉴스(네이버) · 당일 DART 공시 · 3~5거래일 연속 수급(네이버 일별 확정)
      · 전일 테마 연속성/자금 잔류 · scenario_retro_notes.json(오답 노트) · 미장(Yahoo) → 국내 연결
  · public/data/daily_levels.json (있으면)
      {"date":"2026-11-26","kospi":{"s1":4672.55,"s2":4586.8,"r1":4708.54,"r2":4809,"close":4697.51}}
      없으면 전일 종가를 기준선으로 쓴다.

Gemini 모델 (2026-11-27 재정렬)
  기본 체인 gemini-3.1-flash-lite → 3.5-flash → 3.8-flash → 3.1-flash-lite-preview.
  2026-11 기준 2.5 계열은 신규 사용자에게 닫혀 있고(404), 3.8/3.5 는 429·503 과
  50초 타임아웃이 잦아 실제로는 flash-lite 가 먼저 성공하는 날이 많다.
  그래서 응답이 가장 안정적인 flash-lite 를 앞에 두고, 큰 모델은 뒤 폴백으로만 쓴다.
  호출 타임아웃은 1회 30초(lite) / 35초(그 외) — 예전엔 50~55초여서 세 모델이
  연달아 타임아웃되면 발송까지 3분이 걸렸다(2026-11-27 10:00 실행 2분47초).
  모두 실패하면 실측 대체 본문으로 보낸다.
"""

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:  # 심화 분석 헬퍼 — 없어도 브리핑은 그대로 돌아간다
    import analysis_context as analysis_ctx
except Exception as _e:  # noqa: BLE001
    analysis_ctx = None
    print(f"⚠️ analysis_context 로드 실패 — 심화 분석 생략 ({_e})", flush=True)

KST = timezone(timedelta(hours=9))
WEEKDAY_KO = ["월", "화", "수", "목", "금", "토", "일"]

TABS_LIVE_URL = os.environ.get(
    "TABS_LIVE_URL", "https://stock-dashboard-live-6frm.vercel.app/api/tabs-live"
)
NAVER_POLL_URL = "https://polling.finance.naver.com/api/realtime?query="
NAVER_MOBILE = "https://m.stock.naver.com/api/index/"
NAVER_THEME_LIST = "https://m.stock.naver.com/api/stocks/theme?page=1&pageSize=100"
NAVER_THEME_ONE = "https://m.stock.naver.com/api/stocks/theme/"
NAVER_FX_URL = (
    "https://m.stock.naver.com/front-api/marketIndex/prices"
    "?category=exchange&reutersCode=FX_USDKRW"
)
LIVE_BRIEFING_URL = os.environ.get(
    "LIVE_BRIEFING_URL", "https://stock-dashboard-live-6frm.vercel.app/api/live-briefing"
)

CHECKER_URL = "https://hwen21c-tech.github.io/foxsignal-checker/"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

BIG_VALUE_WON = 30_000_000_000  # 300억 — 사용자 확정 기준

# 모델 체인 — 빠르고 안정적인 flash-lite 를 먼저, 큰 모델은 뒤 폴백으로.
#   (2026-11-27: 3.8-flash 타임아웃 → 3.5-flash 타임아웃·검증실패 → lite 통과에 2분47초 걸린 실행을 보고 재정렬)
DEFAULT_MODELS = [
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.8-flash",
    "gemini-3.1-flash-lite-preview",
]

# 1회 호출 타임아웃 — 이 시간을 넘긴 모델은 버리고 다음 모델로 간다(총 소요 상한은 GEMINI_WALL_BUDGET).
GEMINI_TIMEOUT_DEFAULT = 30
GEMINI_WALL_BUDGET = 150  # 초 — Gemini 생성에 쓸 수 있는 전체 시간(3분 → 2분30초)
RETRYABLE = {429, 500, 502, 503, 504}

# 텔레그램 한 통 4,096자 · 목표 2,000~3,200자
TG_LIMIT = 4096
BODY_MIN = 1900      # 검증 통과 하한(목표 2,000~3,200자의 5% 여유 — 이보다 짧으면 재작성)
BODY_TARGET_MIN = 2000
BODY_TARGET_MAX = 3200
BODY_MAX = 3900      # 이 위는 잘라서 보내야 하므로 실패로 본다

# 5블록 정식 헤더 — 모델이 흔들려도 이 문구로 고정한다
BLOCK_HEADERS = [
    ("📌", "📌 한줄 요약"),
    ("📊", "📊 핵심 지표 & 매크로"),
    ("💰", "💰 투자자별 수급 & 흐름 해석"),
    ("🔥", "🔥 장중 주도 테마 & 대장주 (300억↑ 실측)"),
    ("🧭", "🧭 대응 시나리오"),
]
REQ_SECTIONS = [h for _, h in BLOCK_HEADERS]


# --------------------------------------------------------------------------- #
# 유틸
# --------------------------------------------------------------------------- #
def log(msg):
    print(msg, flush=True)


def http_json(url, timeout=20, retries=2, headers=None, backoff=2.0):
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode("utf-8", "replace")
            return json.loads(raw)
        except Exception as e:  # noqa: BLE001 — 네트워크/파싱 모두 재시도 대상
            last = e
            if attempt < retries:
                time.sleep(backoff * (attempt + 1))
    raise RuntimeError(f"GET {url[:90]} 실패: {last}")


def fnum(s):
    if s is None:
        return None
    t = str(s).replace(",", "").replace(" ", "").strip()
    t = t.replace("+", "")
    if not t or t in ("-", "."):
        return None
    try:
        v = float(t)
        return v if math.isfinite(v) else None
    except ValueError:
        return None


def sgn(v, dp=0, unit=""):
    if v is None:
        return "미수신"
    sign = "+" if v > 0 else ("-" if v < 0 else "")
    body = f"{abs(v):,.{dp}f}"
    return f"{sign}{body}{unit}"


def pct_text(v):
    if v is None:
        return "미수신"
    sign = "+" if v > 0 else ("" if v == 0 else "-")
    return f"{sign}{abs(v):.2f}%"


def eok_text(v):
    """억원 값 → '1,234억' / '1조 2,345억'"""
    if v is None:
        return "미수신"
    v = round(v)
    if abs(v) >= 10000:
        jo = int(abs(v) // 10000)
        rest = abs(v) % 10000
        sign = "-" if v < 0 else ""
        if rest == 0:
            return f"{sign}{jo}조"
        return f"{sign}{jo}조 {rest:,}억"
    return f"{v:,}억"


def money_text_eok(v_eok):
    if v_eok is None:
        return "미수신"
    if abs(v_eok) >= 10000:
        return eok_text(v_eok)
    if abs(v_eok - round(v_eok)) < 0.05:
        return f"{round(v_eok):,}억"
    return f"{v_eok:,.1f}억"


def won_to_eok(won):
    if won is None:
        return None
    return won / 1e8


def md_date(biz):
    """'20261125' → '11/25' (그 외 형식은 그대로)"""
    s = str(biz or "")
    if len(s) == 8 and s.isdigit():
        return f"{int(s[4:6])}/{int(s[6:8])}"
    return s


# --------------------------------------------------------------------------- #
# 수집
# --------------------------------------------------------------------------- #
def kst_now():
    return datetime.now(KST)


def fetch_tabs_live():
    try:
        return http_json(TABS_LIVE_URL, timeout=35, retries=1), None
    except Exception as e:  # noqa: BLE001
        return None, str(e)


def fetch_index_live():
    url = NAVER_POLL_URL + urllib.parse.quote("SERVICE_INDEX:KOSPI,KOSDAQ") + f"&_={int(time.time() * 1000)}"
    d = http_json(url, timeout=15, retries=2, headers={"Referer": "https://finance.naver.com/"})
    areas = ((d or {}).get("result") or {}).get("areas") or []
    out = {}
    for area in areas:
        for item in area.get("datas") or []:
            code = item.get("cd")
            if code not in ("KOSPI", "KOSDAQ"):
                continue
            out[code] = {
                "price": round(item.get("nv") / 100, 2) if isinstance(item.get("nv"), (int, float)) else None,
                "change": round(item.get("cv") / 100, 2) if isinstance(item.get("cv"), (int, float)) else None,
                "pct": round(float(item.get("cr")), 2) if item.get("cr") is not None else None,
                "open": round(item["ov"] / 100, 2) if item.get("ov") else None,
                "high": round(item["hv"] / 100, 2) if item.get("hv") else None,
                "low": round(item["lv"] / 100, 2) if item.get("lv") else None,
                "volume": (item.get("aq") or 0) * 1000 or None,
                "value_won": (item.get("aa") or 0) * 1e6 or None,
                "market_status": item.get("ms"),
            }
    return out


def fetch_index_via_api():
    """네이버 폴링이 막힌 경우 — 관제탑 /api/live-briefing 의 지수(같은 네이버 실측값)."""
    d = http_json(LIVE_BRIEFING_URL + "?fresh=1", timeout=25, retries=1)
    out = {}
    for r in d.get("indices") or []:
        key = r.get("key")
        if key not in ("KOSPI", "KOSDAQ"):
            continue
        out[key] = {
            "price": r.get("price"),
            "change": r.get("change"),
            "pct": r.get("changePct"),
            "open": r.get("open"),
            "high": r.get("high"),
            "low": r.get("low"),
            "volume": r.get("volume"),
            "value_won": r.get("value"),
            "market_status": r.get("status"),
        }
    return out


def fetch_index_detail(market):
    """integration — 전일 종가·상승/하락 종목수·프로그램 매매"""
    d = http_json(NAVER_MOBILE + market + "/integration", timeout=15, retries=2,
                  headers={"Referer": "https://m.stock.naver.com/"})
    info = {x.get("code"): x.get("value") for x in (d.get("totalInfos") or [])}
    up = d.get("upDownStockInfo") or {}
    prog = d.get("programTrendInfo") or {}
    deal = d.get("dealTrendInfo") or {}
    return {
        "prev_close": fnum(info.get("lastClosePrice")),
        "open": fnum(info.get("openPrice")),
        "high": fnum(info.get("highPrice")),
        "low": fnum(info.get("lowPrice")),
        "value_text": info.get("accumulatedTradingValue"),
        "breadth": {
            "up": fnum(up.get("riseCount")),
            "down": fnum(up.get("fallCount")),
            "flat": fnum(up.get("steadyCount")),
            "upper": fnum(up.get("upperCount")),
            "lower": fnum(up.get("lowerCount")),
        } if up else None,
        "program": {
            "delta": fnum(prog.get("indexDifferenceReal")),
            "bi": fnum(prog.get("indexBiDifferenceReal")),
            "total": fnum(prog.get("indexTotalReal")),
            "bizdate": prog.get("bizdate"),
        } if prog else None,
        "deal_bizdate": deal.get("bizdate"),
    }


def fetch_trend(market):
    d = http_json(NAVER_MOBILE + market + "/trend", timeout=15, retries=2,
                  headers={"Referer": "https://m.stock.naver.com/"})
    return {
        "foreign": fnum(d.get("foreignValue")),
        "organ": fnum(d.get("institutionalValue")),
        "personal": fnum(d.get("personalValue")),
        "bizdate": d.get("bizdate"),
    }


def fetch_fx():
    """원/달러 — 네이버 마켓인덱스(전일·장중 마지막 체결). 실패하면 None."""
    d = http_json(NAVER_FX_URL, timeout=12, retries=1,
                  headers={"Referer": "https://m.stock.naver.com/"})
    rows = (d or {}).get("result") or []
    if not rows:
        raise RuntimeError("fx 응답이 비었습니다")
    r = rows[0]
    price = fnum(r.get("closePrice"))
    if price is None:
        raise RuntimeError("fx 가격 파싱 실패")
    return {
        "name": "원/달러",
        "price": price,
        "change": fnum(r.get("fluctuations")),
        "pct": fnum(r.get("fluctuationsRatio")),
        "traded_date": r.get("localTradedAt") or "",
    }


def fetch_theme_rank():
    d = http_json(NAVER_THEME_LIST, timeout=20, retries=2,
                  headers={"Referer": "https://m.stock.naver.com/"})
    out = []
    for g in d.get("groups") or []:
        rate = fnum(g.get("changeRate"))
        if rate is None:
            continue
        total = fnum(g.get("totalCount"))
        # 장 시작 전에는 전체 0인 빈 껍데기 행이 온다 — 테마로 쓰지 않는다
        if rate == 0 and not total:
            continue
        out.append({
            "no": g.get("no"),
            "name": g.get("name"),
            "pct": rate,
            "total": total,
            "up": fnum(g.get("riseCount")),
            "down": fnum(g.get("fallCount")),
        })
    return out


def fetch_theme_members(theme_no, limit=40):
    d = http_json(f"{NAVER_THEME_ONE}{theme_no}?page=1&pageSize={limit}", timeout=15, retries=1,
                  headers={"Referer": "https://m.stock.naver.com/"})
    rows = []
    for s in d.get("stocks") or []:
        pct = fnum(s.get("fluctuationsRatio"))
        val_m = fnum(s.get("accumulatedTradingValue"))  # 백만원
        if pct is None:
            continue
        rows.append({
            "name": s.get("stockName"),
            "code": s.get("itemCode"),
            "pct": pct,
            "value_eok": (val_m * 1e6) / 1e8 if val_m is not None else None,
        })
    return rows


def read_supply(path):
    """supply-latest.json — 외인·기관 순매수/순매도 상위(확정). 없으면 None."""
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:  # noqa: BLE001
        return None
    g = d.get("groups") or {}

    def grab(key, n):
        rows = []
        for x in (g.get(key) or [])[:n]:
            if not x.get("name"):
                continue
            rows.append({
                "name": x.get("name"),
                "code": x.get("code"),
                "pct": fnum(x.get("pct")),
                "foreign_eok": fnum(x.get("foreignEok")),
                "organ_eok": fnum(x.get("organEok")),
            })
        return rows

    out = {
        "basis_label": d.get("basisLabel"),
        "confirmed": bool(d.get("confirmed")),
        "foreign_buy": grab("foreignBuy", 3),
        "organ_buy": grab("organBuy", 3),
        "foreign_sell": grab("foreignSell", 2),
        "dual_buy": grab("dualBuy", 2),
    }
    if not any(out[k] for k in ("foreign_buy", "organ_buy", "foreign_sell", "dual_buy")):
        return None
    return out


def read_daily_levels(path):
    """public/data/daily_levels.json — 없거나 형식이 다르면 None."""
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:  # noqa: BLE001
        return None
    out = {"date": d.get("date") or d.get("basisDate"), "markets": {}, "source": path,
           "note": d.get("note")}
    markets = d.get("markets") or d
    alias = {"kospi": "코스피", "kosdaq": "코스닥", "코스피": "코스피", "코스닥": "코스닥"}
    for key, name in alias.items():
        node = markets.get(key) if isinstance(markets, dict) else None
        if node is None:
            # 평면 키 (kospi_s1 등) 도 허용
            flat = {}
            for k2, v2 in (markets or {}).items() if isinstance(markets, dict) else []:
                if str(k2).lower().startswith(key + "_"):
                    flat[str(k2).lower()[len(key) + 1:]] = v2
            node = flat or None
        if not isinstance(node, dict):
            continue
        lv = {"s1": None, "s2": None, "r1": None, "r2": None, "close": None}
        for k2, v2 in node.items():
            kk = str(k2).lower()
            num = fnum(v2)
            if num is None:
                continue
            if kk in ("s1", "support1", "first", "1", "l1") and lv["s1"] is None:
                lv["s1"] = num
            elif kk in ("s2", "support2", "second", "2", "l2") and lv["s2"] is None:
                lv["s2"] = num
            elif kk in ("r1", "resist1", "resistance1") and lv["r1"] is None:
                lv["r1"] = num
            elif kk in ("r2", "resist2", "resistance2") and lv["r2"] is None:
                lv["r2"] = num
            elif kk in ("close", "prevclose", "prev_close") and lv["close"] is None:
                lv["close"] = num
        if any(lv[k] is not None for k in lv):
            out["markets"][name] = lv
    if not out["markets"]:
        return None
    return out


def pick_theme_leaders(tabs, limit=3):
    """tabs-live themes → 300억↑ 상승 대장주가 있는 주도 테마.

    같은 종목이 여러 테마에 중복으로 잡히므로(예: 파수AI — 재택근무·마이데이터),
    앞선 테마에서 이미 쓴 종목은 뒤 테마에서 빼고, 남는 대장주가 없으면 테마도 뺀다.
    300억 미만 동반 상승 종목은 '동반'으로만 붙인다(대장주로 쓰지 않는다).
    """
    out = []
    seen = set()
    for t in (tabs or {}).get("themes") or []:
        stocks = t.get("stocks") or []
        big, small = [], []
        for s in stocks:
            val = s.get("value")
            p = s.get("changePct")
            if val is None or p is None:
                continue
            if s.get("name") in seen:
                continue
            row = {
                "name": s.get("name"),
                "code": s.get("code"),
                "price": s.get("price"),
                "pct": round(float(p), 2),
                "value_eok": val / 1e8,
                "value_basis": s.get("valueBasis"),
                "upper_limit": bool(s.get("upperLimit")),
                "role": s.get("role"),
            }
            if val >= BIG_VALUE_WON and p > 0:
                big.append(row)
            elif p > 0 and val >= 5_000_000_000:      # 50억↑ 동반 상승만
                small.append(row)
        if not big:
            continue
        big.sort(key=lambda x: (-x["value_eok"], -x["pct"]))
        small.sort(key=lambda x: (-x["value_eok"], -x["pct"]))
        for s in big:
            seen.add(s["name"])
        out.append({
            "rank": t.get("rank"),
            "name": t.get("name"),
            "avg_pct": t.get("avgPct") if t.get("avgPct") is not None else t.get("avgPctCalc"),
            "calc_pct": t.get("avgPctCalc"),
            "basis_label": t.get("avgPctBasisLabel"),
            "rise": t.get("riseCount"),
            "fall": t.get("fallCount"),
            "total": t.get("stockCount"),
            "leaders": big[:3],
            "leaders_by_pct": sorted(big, key=lambda x: -x["pct"])[:2],
            "co_movers": small[:2],
        })
        if len(out) >= limit:
            break
    return out


def pick_decliners(tabs, limit=2):
    """tabs-live searchTop — 거래대금 300억↑ 하락 대표주."""
    rows = []
    for s in (tabs or {}).get("searchTop") or []:
        val = s.get("value") or 0
        p = s.get("changePct")
        if p is None or p >= 0 or val < BIG_VALUE_WON:
            continue
        rows.append({"name": s.get("name"), "pct": round(float(p), 2), "value_eok": val / 1e8})
    by_value = sorted(rows, key=lambda x: -x["value_eok"])
    by_pct = sorted(rows, key=lambda x: x["pct"])
    picked = []
    for r in (by_value[:1] + by_pct[:1]):
        if all(r["name"] != p["name"] for p in picked):
            picked.append(r)
    return picked[:limit]


def pick_upper_limit(tabs):
    ul = (tabs or {}).get("upperLimit") or {}

    def rows_of(name, n=3):
        out = []
        for s in ul.get(name) or []:
            out.append({
                "name": s.get("name"),
                "pct": round(float(s.get("changePct")), 2) if s.get("changePct") is not None else None,
                "value_text": s.get("valueIntegText") or s.get("valueDispText") or s.get("valueText"),
            })
        return out[:n]

    counts = ul.get("counts") or {}
    return {
        "count": counts.get("confirmed"),
        "near": counts.get("near"),
        "rows": rows_of("confirmed"),
        "near_rows": rows_of("near", 2),
    }


def pick_futures(tabs):
    """KIS 코스피200 선물 — 체결이 있는 시세를 고르고 베이시스까지 넘긴다.

    장전에는 야간(CM), 정규장에는 주간. 개장 직후 주간 시세가 0으로 비어 있으면
    다른 세션으로 건너뛰어 '0.00'을 보내지 않는다.
    """
    fk = (tabs or {}).get("futuresKis") or {}
    if not fk.get("ok"):
        return None
    cands = [fk.get("primaryQuote") or {}, fk.get("day") or {}, fk.get("night") or {}]
    session = fk.get("session") or {}
    q = next((c for c in cands if c.get("price")), None)
    if q is None:
        return None
    contract = q.get("contract") or fk.get("contract") or {}
    return {
        "price": q.get("price"),
        "change": q.get("change"),
        "pct": q.get("changePct"),
        "session": q.get("badge") or session.get("label") or "",
        "market_div": q.get("marketDiv"),
        "live": bool(q.get("live")),
        "label": contract.get("label"),
        "as_of": q.get("asOfKst"),
        "disparity": q.get("disparity"),
        "basis": q.get("basis"),
        "market_basis": q.get("marketBasis"),
        "kospi200": q.get("kospi200"),
        "open_interest": q.get("openInterest"),
        "oi_delta": q.get("openInterestDelta"),
        "volume": q.get("volume"),
        "prev_close": q.get("prevClose"),
    }


def pick_news(tabs, limit=6):
    rows = []
    for n in (tabs or {}).get("news") or []:
        title = (n.get("title") or "").strip()
        if not title:
            continue
        rows.append({
            "title": title,
            "press": n.get("press") or "",
            "time": n.get("time") or "",
            "impact": n.get("impactLevel") or "",
            "direction": n.get("impactDirection") or "",
            "themes": [t for t in (n.get("matchedThemes") or []) if t],
            "beneficiaries": [b.get("name") for b in (n.get("beneficiaryStocks") or []) if b.get("name")][:3],
        })
        if len(rows) >= limit:
            break
    return rows


def _theme_key(name):
    """테마 이름 비교용 — 괄호·공백·가운뎃점 제거."""
    s = re.sub(r"\([^)]*\)", "", str(name or ""))
    s = re.sub(r"[\s·,/]", "", s)
    return s.lower()


def _theme_tokens(name):
    """테마 이름을 뉴스 제목과 맞춰 볼 토큰으로 나눈다(보안주/재택근무/2차전지 등)."""
    s = re.sub(r"\([^)]*\)", " ", str(name or ""))
    raw = re.split(r"[\s·,/&]+", s)
    out = []
    for t in raw:
        t = t.strip()
        if len(t) < 2:
            continue
        if t in ("관련", "기타", "테마", "업종", "증시", "종목"):
            continue
        out.append(t)
    return out


def attach_news_to_themes(themes, news):
    """뉴스 ↔ 테마를 맞춰 테마별 재료 헤드라인을 붙인다.

    ① 뉴스의 matchedThemes 가 테마 이름과 같거나 포함하면
    ② 테마 이름 토큰이 뉴스 제목에 나오면
    ③ 테마 대장주 이름이 뉴스 제목·수해 종목에 나오면
    위 경우에만 붙인다(없으면 None). 재료를 지어내지 않기 위한 장치.
    """
    for t in themes:
        keys = {_theme_key(t.get("name"))}
        keys.discard("")
        tokens = _theme_tokens(t.get("name"))
        leader_names = [s.get("name") for s in (t.get("leaders") or []) if s.get("name")]
        hit = None
        for n in news or []:
            title = n.get("title") or ""
            matched = False
            for mt in n.get("themes") or []:
                mk = _theme_key(mt)
                if mk and (mk in keys or any(k and (k in mk or mk in k) for k in keys)):
                    matched = True
                    break
            if not matched:
                matched = any(tok in title for tok in tokens)
            if not matched:
                matched = any(lname in title for lname in leader_names)
            if not matched and n.get("beneficiaries"):
                matched = any(lname in n["beneficiaries"] for lname in leader_names)
            if matched:
                hit = n
                break
        t["news"] = hit
    return themes


def flow_verdict(fl):
    """외인 현·선물 판정 — 사용자가 정한 임계치(현물 ±1,000억 · 선물 ±1,500계약).

    현물이 0(집계 전)이거나 한쪽이 없으면 판정하지 않는다 — 0을 '순매수'로 읽지 않는다.
    """
    spot = fl.get("spot_foreign_total")
    fut = (fl.get("fut") or {}).get("foreign")
    if spot is None or fut is None or spot == 0 or fut == 0:
        return None
    spot_t, fut_t = 1000.0, 1500.0
    spot_big = abs(spot) >= spot_t
    fut_big = abs(fut) >= fut_t
    if not (spot_big or fut_big or abs(spot) >= 3000 or abs(fut) >= 3000):
        return {
            "label": "중립(임계 미달)",
            "spot": spot, "fut": fut,
            "text": f"임계 미달 — 현물 {sgn(spot)}억 / 선물 {sgn(fut)}계약 (현물 ±1,000억·선물 ±1,500계약 기준)",
        }
    if spot > 0 and fut > 0:
        label = "쌍매수"
        if spot_big and fut_big:
            label = "쌍매수(적극)"
    elif spot < 0 and fut < 0:
        label = "쌍매도"
        if spot_big and fut_big:
            label = "쌍매도(적극)"
    else:
        side = "현물 매도·선물 매수" if spot < 0 < fut else "현물 매수·선물 매도"
        label = f"엇갈림({side})"
    return {
        "label": label, "spot": spot, "fut": fut,
        "text": f"{label} — 현물 {sgn(spot)}억 / 선물 {sgn(fut)}계약",
    }


def collect(script_dir, use_fixture=None, verbose=True, deep=True, deep_budget=25.0):
    """모든 실측값 수집 → facts dict. 실패한 소스는 None 으로 남긴다(추정 금지)."""
    facts = {"errors": [], "asof": {}}
    now = kst_now()
    facts["asof"] = {
        "iso": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "date": now.strftime("%Y-%m-%d"),
        "date_label": now.strftime("%Y-%m-%d") + f"({WEEKDAY_KO[now.weekday()]})",
        "time": now.strftime("%H:%M"),
        "time_sec": now.strftime("%H:%M:%S"),
        "weekday": WEEKDAY_KO[now.weekday()],
    }

    fx = None
    supply = None

    if use_fixture:
        with open(os.path.join(use_fixture, "tabs_live.json"), encoding="utf-8") as f:
            tabs = json.load(f)
        idx = json.load(open(os.path.join(use_fixture, "indices.json"), encoding="utf-8"))
        detail = json.load(open(os.path.join(use_fixture, "detail.json"), encoding="utf-8"))
        trend = json.load(open(os.path.join(use_fixture, "trend.json"), encoding="utf-8"))
        themes = json.load(open(os.path.join(use_fixture, "themes.json"), encoding="utf-8"))
        member_path = os.path.join(use_fixture, "members.json")
        members = json.load(open(member_path, encoding="utf-8")) if os.path.exists(member_path) else {}
        fx_path = os.path.join(use_fixture, "fx.json")
        if os.path.exists(fx_path):
            fx = json.load(open(fx_path, encoding="utf-8"))
        supply_path = os.path.join(use_fixture, "supply.json")
        if os.path.exists(supply_path):
            supply = json.load(open(supply_path, encoding="utf-8"))
    else:
        tabs, err = fetch_tabs_live()
        if err:
            facts["errors"].append(f"tabs-live: {err}")
            if verbose:
                log(f"⚠️ tabs-live 실패 — {err}")
        idx, detail, trend, themes, members = {}, {}, {}, [], {}

        try:
            idx = fetch_index_live()
            if verbose:
                log(f"✓ 지수 {[(k, v['price'], v['pct']) for k, v in idx.items()]}")
        except Exception as e:  # noqa: BLE001
            facts["errors"].append(f"index-live: {e}")
            log(f"⚠️ 지수 실패 — {e}")
            try:
                idx = fetch_index_via_api()
                log(f"↺ 관제탑 API로 지수 대체 {[(k, v['price'], v['pct']) for k, v in idx.items()]}")
            except Exception as e2:  # noqa: BLE001
                facts["errors"].append(f"index-api: {e2}")
                log(f"⚠️ 관제탑 지수도 실패 — {e2}")

        try:
            fx = fetch_fx()
            if verbose:
                log(f"✓ 환율 원/달러 {fx['price']} ({fx['pct']}%)")
        except Exception as e:  # noqa: BLE001
            facts["errors"].append(f"fx: {e}")
            log(f"⚠️ 환율 실패 — {e}")

        for market in ("KOSPI", "KOSDAQ"):
            try:
                detail[market] = fetch_index_detail(market)
            except Exception as e:  # noqa: BLE001
                facts["errors"].append(f"detail-{market}: {e}")
                log(f"⚠️ {market} integration 실패 — {e}")
            try:
                trend[market] = fetch_trend(market)
            except Exception as e:  # noqa: BLE001
                facts["errors"].append(f"trend-{market}: {e}")
                log(f"⚠️ {market} trend 실패 — {e}")
        try:
            trend["FUT"] = fetch_trend("FUT")
        except Exception as e:  # noqa: BLE001
            facts["errors"].append(f"trend-FUT: {e}")
            log(f"⚠️ FUT trend 실패 — {e}")
        try:
            themes = fetch_theme_rank()
            if verbose:
                log(f"✓ 테마 {len(themes)}개")
        except Exception as e:  # noqa: BLE001
            facts["errors"].append(f"theme-rank: {e}")
            log(f"⚠️ 테마 랭킹 실패 — {e}")

    # ---------- 지수 ----------
    def idx_row(code, name):
        live = idx.get(code) or {}
        det = detail.get(code) or {}
        price = live.get("price")
        change = live.get("change")
        p = live.get("pct")
        # 장 시작 전·마감 후에는 0.00%가 '집계 전' 값이다 — 실시간 등락으로 읽히지 않게 표시
        status = str(live.get("market_status") or "").upper()
        stale = (change == 0 and status in ("PREOPEN", "CLOSE"))
        preopen = (status == "PREOPEN")
        prev = det.get("prev_close")
        if prev is None and price is not None and change is not None:
            prev = round(price - change, 2)
        breadth = det.get("breadth")
        value_won = live.get("value_won")
        return {
            "name": name,
            "price": price,
            "change": change,
            "pct": p,
            # 장전에는 시·고·저가 전일 종가로 채워져 온다 — 실제 체결로 오해되지 않게 비운다
            "open": None if preopen else (live.get("open") or det.get("open")),
            "high": None if preopen else (live.get("high") or det.get("high")),
            "low": None if preopen else (live.get("low") or det.get("low")),
            "prev_close": prev,
            "value_eok": won_to_eok(value_won),
            "value_text": det.get("value_text"),
            "breadth": breadth,
            "market_status": live.get("market_status"),
            "stale": stale,
        }

    facts["indices"] = [idx_row("KOSPI", "코스피"), idx_row("KOSDAQ", "코스닥")]
    facts["market_status"] = (idx.get("KOSPI") or {}).get("market_status")
    facts["tabs"] = {
        "generated_at_kst": (tabs or {}).get("generatedAtKst"),
        "generated_at_label": (tabs or {}).get("generatedAtLabel"),
        "session_phase": (tabs or {}).get("sessionPhase"),
        "session_label": (tabs or {}).get("sessionLabel"),
        "market_status": (tabs or {}).get("marketStatus"),
    }

    # ---------- 선물 ----------
    facts["futures"] = pick_futures(tabs)

    # ---------- 수급 ----------
    def flow_row(code):
        t = trend.get(code) or {}
        if all(t.get(k) is None for k in ("foreign", "organ", "personal")):
            return None
        # 장 시작 전에는 0으로 채운 빈 값이 온다 — 0은 실측 수급이 아니라 '집계 전'이다
        if all((t.get(k) or 0) == 0 for k in ("foreign", "organ", "personal")):
            return None
        return {
            "foreign": t.get("foreign"),
            "organ": t.get("organ"),
            "personal": t.get("personal"),
            "bizdate": t.get("bizdate"),
        }

    k = flow_row("KOSPI")
    q = flow_row("KOSDAQ")
    fu = flow_row("FUT")
    spot_foreign = (k["foreign"] + q["foreign"]) if k and q and k["foreign"] is not None and q["foreign"] is not None else None
    spot_organ = (k["organ"] + q["organ"]) if k and q and k["organ"] is not None and q["organ"] is not None else None
    facts["flows"] = {
        "kospi": k, "kosdaq": q, "fut": fu,
        "spot_foreign_total": spot_foreign,
        "spot_organ_total": spot_organ,
        "basis_date": (k or {}).get("bizdate") or (q or {}).get("bizdate") or (fu or {}).get("bizdate"),
        "program": (detail.get("KOSPI") or {}).get("program"),
    }
    facts["flows"]["verdict"] = flow_verdict(facts["flows"])

    # ---------- 환율·수급 종목 ----------
    facts["fx"] = fx
    if supply is None and not use_fixture:
        sp = os.path.abspath(os.path.join(script_dir, "..", "public", "data", "supply-latest.json"))
        supply = read_supply(sp)
    facts["supply"] = supply

    # ---------- 테마 ----------
    themes_out = pick_theme_leaders(tabs)
    news = pick_news(tabs)
    facts["themes"] = attach_news_to_themes(themes_out, news)
    facts["decliners"] = pick_decliners(tabs)
    facts["upper_limit"] = pick_upper_limit(tabs)
    facts["news"] = news

    weak = []
    if themes:
        eligible = [t for t in themes if (t.get("total") or 0) >= 5]
        negative = [t for t in eligible if (t.get("pct") or 0) < 0]
        weak = sorted(negative, key=lambda x: x["pct"])[:2]
        # 하락 업종이 하나도 없으면(전 테마 상승) '빠지는 쪽'으로 쓰지 않는다
        if not weak:
            lowest = min(eligible, key=lambda x: x["pct"]) if eligible else None
            if lowest:
                facts["all_themes_up"] = {"name": lowest["name"], "pct": lowest["pct"]}
        # 약한 테마 1순위의 대표 종목(거래대금 최대) 1개
        if weak and not use_fixture:
            try:
                members = fetch_theme_members(weak[0]["no"])
            except Exception as e:  # noqa: BLE001
                facts["errors"].append(f"theme-members: {e}")
                members = {}
        if isinstance(members, dict):
            members = members.get(str(weak[0]["no"])) if weak else None
        if weak and members:
            big = [m for m in members if m.get("value_eok")]
            if big:
                top = max(big, key=lambda x: x["value_eok"])
                weak[0]["leader"] = top if top["value_eok"] >= 300 else None
    facts["weak_themes"] = weak

    # ---------- 심화 분석(뉴스·공시·연속 수급·테마 연속성·오답 노트·미장) ----------
    #   · 네트워크 작업은 내부 시간 예산 안에서만 돌고, 실패해도 발송을 막지 않는다.
    facts["deep"] = None
    if deep and analysis_ctx is not None and not use_fixture:
        # 오늘 테마 순위 — 관제탑(tabs-live) 테마 목록이 단일 진실(순위·기준일 포함).
        #   관제탑 목록이 비어 있을 때만 네이버 테마 등락을 등락률순으로 임시 순위로 쓴다.
        rank_rows = [{"rank": t.get("rank"), "name": t.get("name"), "avg_pct": t.get("avgPct"),
                      "basis_label": t.get("avgPctBasisLabel")}
                     for t in (tabs or {}).get("themes") or [] if t.get("name")]
        if not rank_rows:
            rank_rows = [{"rank": None, "name": x.get("name"), "avg_pct": x.get("pct"),
                          "basis_label": "네이버 테마 등락(실시간)"} for x in themes or [] if x.get("name")]
            rank_rows.sort(key=lambda r: -(r["avg_pct"] if r.get("avg_pct") is not None else -1e9))
            for i, r in enumerate(rank_rows, 1):
                r["rank"] = i
        try:
            facts["deep"] = analysis_ctx.build_deep_context(
                script_dir, facts["themes"], theme_rank=rank_rows,
                budget=deep_budget, verbose=verbose)
        except Exception as e:  # noqa: BLE001 — 심화 분석은 보조 정보다
            facts["errors"].append(f"deep: {e}")
            log(f"⚠️ 심화 분석 실패 — {e}")

    # ---------- 기준선 ----------
    levels_path = os.path.join(script_dir, "..", "public", "data", "daily_levels.json")
    facts["levels"] = read_daily_levels(os.path.abspath(levels_path))

    facts["long"] = None
    if tabs:
        cp = (tabs.get("closingPicks") or {})
        facts["long"] = {
            "theme_track": [
                {"name": r.get("name"), "pct": r.get("changePct"), "value_eok": r.get("valueEok"),
                 "theme": r.get("themeName")}
                for r in (cp.get("themeTrack") or [])[:2]
            ],
            "supply_track": [
                {"name": r.get("name"), "pct": r.get("changePct"),
                 "foreign_eok": r.get("foreignEok"), "organ_eok": r.get("organEok"),
                 "kind": r.get("supplyKind")}
                for r in (cp.get("supplyTrack") or [])[:2]
            ],
            "basis_note": cp.get("asOfLabel"),
        }
    return facts


# --------------------------------------------------------------------------- #
# FACTS → 프롬프트 텍스트
# --------------------------------------------------------------------------- #
def _deep_theme(f, name):
    """deep["themes"] 에서 그 테마 항목(뉴스·공시·연속 수급)을 찾는다."""
    for t in (f.get("deep") or {}).get("themes") or []:
        if str(t.get("name") or "") == str(name or ""):
            return t
    return None


def _streak_line(node, label):
    """연속 수급 한 조각 — '외인 3일 연속 순매수 +152.0억(11/24~11/26)'."""
    if not node:
        return None
    days = node.get("days") or 0
    if node.get("dir") in (None, "flat") or days == 0:
        return f"{label} 연속 없음(직전일 0·보합)"
    word = "순매수" if node.get("dir") == "buy" else "순매도"
    if days >= 2:
        return (f"{label} {days}일 연속 {word} {sgn(node.get('sum_eok'), 1)}억"
                f"({node.get('from')}~{node.get('to')})")
    return f"{label} 직전일({node.get('to')}) {word} {sgn(node.get('sum_eok'), 1)}억"


def _eok_short(v):
    """억 단위 짧은 표기 — 10억 미만은 소수 1자리('-0억' 방지)."""
    if v is None:
        return "미수신"
    return f"{sgn(v, 1)}억" if abs(v) < 10 else f"{sgn(v)}억"


def deep_text(f):
    """심화 분석(연속 수급·테마 연속성·미장 연결·오답 노트) → FACTS 줄.

    모든 줄은 위에서 수집한 실측값이다. 숫자·일수는 여기 있는 그대로만 본문에 옮긴다.
    """
    d = f.get("deep") or {}
    if not d:
        return []
    L = []

    # ── ① 3~5거래일 연속 수급 ──────────────────────────────────────────
    #   · 종목별 일별 확정치는 네이버 trend(주수×종가)로 직접 계산한 값만 쓴다.
    #     supply-latest.json 의 streak* 필드는 금액 부호와 어긋나는 경우가 있어(SK스퀘어 기관 -496.5억인데 streak 1)
    #     API 계산값이 없을 때만, 부호가 맞을 때만 보조로 쓴다.
    ss = d.get("supply_streaks") or {}
    sup_rows = ss.get("rows") or []
    leader_rows = []
    for t in d.get("themes") or []:
        for s in t.get("leaders") or []:
            if (s.get("supply") or {}).get("ok"):
                leader_rows.append((t.get("name"), s, s["supply"]))
    if sup_rows or leader_rows:
        bases = [str((r.get("supply") or {}).get("basis")) for r in sup_rows if (r.get("supply") or {}).get("ok")]
        basis_txt = max(bases) if bases else (ss.get("basis") or "미수신")
        L.append(f"[3~5거래일 연속 수급] 확정 기준일 {basis_txt} — 확정치다(오늘 장중 값 아님)")
    for r in sup_rows[:4]:
        sv = r.get("supply") or {}
        if sv.get("ok"):
            seg = [x for x in (_streak_line(sv.get("foreign"), "외인"),
                               _streak_line(sv.get("organ"), "기관")) if x]
            last = (sv.get("rows") or [{}])[0]
            if seg:
                L.append(f"- {r.get('name')}: " + " · ".join(seg)
                         + f" (최근일 {last.get('date')} 외인 {_eok_short(last.get('foreign_eok'))}"
                           f"·기관 {_eok_short(last.get('organ_eok'))})")
            continue
        seg = []
        if r.get("foreign_streak") and (r.get("foreign_eok") or 0) > 0:
            seg.append(f"외인 {int(r['foreign_streak'])}일 연속 순매수")
        if r.get("organ_streak") and (r.get("organ_eok") or 0) > 0:
            seg.append(f"기관 {int(r['organ_streak'])}일 연속 순매수")
        if not seg:
            continue
        L.append(f"- {r.get('name')}: " + " · ".join(seg)
                 + f" (확정일 외인 {_eok_short(r.get('foreign_eok'))}·기관 {_eok_short(r.get('organ_eok'))})")

    for theme_name, s, supv in leader_rows[:5]:
        seg = [x for x in (_streak_line(supv.get("foreign"), "외인"),
                           _streak_line(supv.get("organ"), "기관")) if x]
        if not seg:
            continue
        recent = " / ".join(
            f"{r['date']} 외인 {_eok_short(r.get('foreign_eok'))}·기관 {_eok_short(r.get('organ_eok'))}"
            for r in (supv.get("rows") or [])[:3])
        L.append(f"- [테마대장] {s.get('name')}({theme_name}) 기준 {supv.get('basis')}: "
                 + " · ".join(seg) + (f" · 일별 {recent}" if recent else ""))
    if sup_rows or leader_rows:
        L.append("")

    # ── ② 테마 연속성·자금 잔류 ────────────────────────────────────────
    ct = d.get("continuity") or {}
    if ct.get("ok"):
        hist = ", ".join(md_date(str(x).replace("-", "")) for x in (ct.get("history_dates") or []))
        L.append(f"[테마 연속성·자금 잔류] 직전 거래일 {ct.get('prev_label')} 대비 · 보관 {ct.get('history_days')}일치({hist})")
        prev_md = md_date(str(ct.get("prev_date") or "").replace("-", ""))
        stale = next((t.get("basis_label") for t in (f.get("themes") or [])
                      if t.get("basis_label") and prev_md and prev_md in str(t.get("basis_label"))), None)
        for r in ct.get("themes") or []:
            tr = f"{int(r['today_rank'])}위" if r.get("today_rank") else "순위권 밖"
            seg = [f"전일 {r.get('prev_rank')}위 {pct_text(r.get('prev_avg'))} → 오늘 {tr} {pct_text(r.get('today_avg'))} ({r.get('status')})"]
            if r.get("today_basis"):
                seg.append(f"오늘 값 기준 '{r['today_basis']}'")
            if r.get("leader_prev"):
                state = r.get("leader_state") or ("대장 유지" if r.get("leader_kept") else "대장 교체")
                tail = f" 오늘 {pct_text(r.get('leader_pct'))}" if r.get("leader_pct") is not None else ""
                seg.append(state + tail)
            if r.get("prev4_checked"):
                names = ", ".join(r.get("prev4_up_names") or []) or "없음"
                seg.append(f"전일 주도 {r['prev4_checked']}종목 중 오늘 상승 {r['prev4_up']}({names})")
                if r.get("prev4_value_share") is not None:
                    seg.append(f"그 종목들이 오늘 이 테마 대금의 {r['prev4_value_share']:.1f}%"
                               + ("(직전 거래일 값)" if stale else ""))
            seg.append(f"보관 {r.get('history_days')}일 중 상위권 {r.get('appear_days')}일")
            L.append(f"- {r['name']}: " + " · ".join(seg))
        sm = ct.get("summary") or {}
        tail = f" · 전일 주도주가 오늘 상승한 테마 {sm['leader_up']}" if sm.get("leader_up") else ""
        L.append(f"  요약: 전일 상위 테마 중 오늘도 상위권 {sm.get('rank_kept')}" + tail)
        if stale:
            L.append(f"  ※ 지금 받는 쪽 테마 값은 '{stale}' 기준이라 오늘 장중 값이 아니다 — 연속성 판정은 장중에 의미가 있다.")
        L.append("")

    # ── ③ 미장 → 국내 연결 ────────────────────────────────────────────
    us = d.get("us") or {}
    if us.get("ok"):
        idx = [r for r in us.get("indices") or [] if r.get("ok")]
        if idx:
            L.append(f"[미장 → 국내 연결] 최근 정규장 {us.get('latest_date')}(현지) 기준")
            L.append("- " + " · ".join(
                f"{r['name']} {r['price']:,.2f}({pct_text(r.get('pct'))})" for r in idx))
            gap = us.get("gap_days")
            if gap and gap >= 2:
                L.append(f"  ※ 그 뒤 {int(gap)}일이 지났지만 새 정규장 값이 없다(휴장·미집계) — 값을 지어내지 말 것.")
        fut = us.get("futures") or {}
        if fut.get("ok"):
            L.append(f"- 나스닥100 선물 {fut['price']:,.2f}({pct_text(fut.get('pct'))}) · 지금 값")
        big = [r for r in us.get("bigtech") or [] if r.get("ok") and r.get("pct") is not None]
        if big:
            L.append("- 빅테크(같은 정규장): " + " · ".join(
                f"{r['name']} {r['price']:,.2f}({pct_text(r.get('pct'))})" for r in big))
        for r in us.get("rules") or []:
            L.append(f"- 연결 규칙(가설): {r}")
        L.append("")

    # ── ④ 오답 노트 ──────────────────────────────────────────────────
    rn = d.get("retro") or {}
    if rn.get("ok") and rn.get("notes"):
        L.append(f"[시나리오 오답 노트] 최근 {len(rn['notes'])}건 — 과거 교훈이다. 그날 숫자를 오늘 값처럼 쓰지 말 것")
        for n in rn["notes"][:5]:
            bits = [md_date(str(n.get("date") or "").replace("-", "")) + (f" {n['slot']}" if n.get("slot") else "")]
            if n.get("title"):
                bits.append(f"「{n['title']}」")
            if n.get("wrong"):
                bits.append(f"틀린 판단: {n['wrong']}")
            if n.get("right"):
                bits.append(f"그때 실측: {n['right']}")
            if n.get("lesson"):
                bits.append(f"교훈: {n['lesson']}")
            L.append("- " + " / ".join(bits))
        L.append("")

    if d.get("errors"):
        L.append("[심화 수집 실패] " + " | ".join(str(x)[:40] for x in d["errors"][:4]))
    return L


def facts_text(f):
    L = []
    a = f["asof"]
    L.append(f"[기준 시각] {a['date_label']} {a['time_sec']} KST · "
             f"{(f['tabs'] or {}).get('session_phase') or '장중'} · "
             f"시장상태 {(f['tabs'] or {}).get('market_status') or f.get('market_status') or '미수신'}")
    if (f["tabs"] or {}).get("session_label"):
        L.append(f"[세션] {f['tabs']['session_label']}")
    if (f["tabs"] or {}).get("generated_at_label"):
        L.append(f"[관제탑 API 기준] {f['tabs']['generated_at_label']}")
    L.append("")

    L.append("[지수]")
    for r in f["indices"]:
        if r["price"] is None:
            L.append(f"{r['name']} 미수신")
            continue
        parts = [f"{r['name']} {r['price']:,.2f}", f"{sgn(r['change'],2)}p", pct_text(r["pct"])]
        if r["prev_close"] is not None:
            parts.append(f"전일종가 {r['prev_close']:,.2f}")
        if r["open"] is not None:
            parts.append(f"시 {r['open']:,.2f}")
        if r["high"] is not None:
            parts.append(f"고 {r['high']:,.2f}")
        if r["low"] is not None:
            parts.append(f"저 {r['low']:,.2f}")
        if r["value_eok"] is not None:
            parts.append(f"대금 {eok_text(r['value_eok'])}")
        elif r.get("value_text"):
            parts.append(f"대금 {r['value_text']}")
        L.append(" · ".join(parts))
        b = r.get("breadth") or {}
        if r.get("stale"):
            L.append("  ※ 장 시작 전·마감 후 — 위 등락률 0.00%는 집계 전 값이며 직전 거래일 종가입니다.")
        if b.get("up") is not None and not (b.get("up") == 0 and b.get("down") == 0 and r.get("stale")):
            L.append(f"  {r['name']} 상승 {int(b['up'])} / 하락 {int(b['down'])} / 보합 {int(b.get('flat') or 0)}"
                     f" · 상한 {int(b.get('upper') or 0)} · 하한 {int(b.get('lower') or 0)}")
    kb = (f["indices"][0].get("breadth") or {})
    qb = (f["indices"][1].get("breadth") or {})
    if kb.get("up") is not None and qb.get("up") is not None and (kb["up"] + qb["up"]) > 0:
        L.append(f"상승:하락 합계 {int(kb['up'] + qb['up'])} : {int(kb['down'] + qb['down'])}")
    L.append("")

    fu = f.get("futures")
    L.append("[선물]")
    if fu:
        L.append(
            f"{fu.get('label') or '코스피200 선물'} {fu['price']:,.2f} ({sgn(fu.get('change'),2)}p, {pct_text(fu.get('pct'))})"
            f" · {fu.get('session') or ''} · {'실시간' if fu.get('live') else '실시간 아님'}"
        )
        basis_bits = []
        if fu.get("basis") is not None:
            basis_bits.append(f"베이시스 {sgn(fu['basis'],2)}p")
        if fu.get("market_basis") is not None:
            basis_bits.append(f"시장베이시스 {sgn(fu['market_basis'],2)}p")
        if fu.get("disparity") is not None:
            basis_bits.append(f"괴리율 {pct_text(fu['disparity'])}")
        if fu.get("kospi200") is not None:
            basis_bits.append(f"코스피200 {fu['kospi200']:,.2f}")
        if fu.get("open_interest") is not None:
            basis_bits.append(f"미결제 {int(fu['open_interest']):,}계약")
        if fu.get("oi_delta") is not None:
            basis_bits.append(f"미결제 증감 {sgn(fu['oi_delta'])}계약")
        if basis_bits:
            L.append("  " + " · ".join(basis_bits))
        if fu.get("prev_close") is not None:
            L.append(f"  전일 종가 {fu['prev_close']:,.2f}")
    else:
        L.append("코스피200 선물 미수신")
    L.append("")

    fx = f.get("fx")
    L.append("[환율]")
    if fx:
        L.append(f"{fx['name']} {fx['price']:,.2f}원 ({sgn(fx.get('change'),2)}, {pct_text(fx.get('pct'))})"
                 f" · 기준 {fx.get('traded_date') or '미상'}")
    else:
        L.append("원/달러 미수신")
    L.append("")

    fl = f.get("flows") or {}
    L.append(f"[수급] 기준일 {md_date(fl.get('basis_date')) or '미수신'} · 네이버 투자자별 (현물 억원 / 선물 계약)")
    for key, label in (("kospi", "코스피"), ("kosdaq", "코스닥")):
        r = fl.get(key)
        if not r:
            L.append(f"{label} 수급 미수신")
            continue
        L.append(f"{label} 외국인 {sgn(r['foreign'])}억 · 기관 {sgn(r['organ'])}억 · 개인 {sgn(r['personal'])}억")
    if not fl.get("kospi") and not fl.get("kosdaq"):
        L.append("※ 현물 투자자별 수급은 아직 집계 전입니다(장 시작 후값이 잡힙니다). 0을 쓰지 말고 '집계 전'이라 적으십시오.")
    if fl.get("spot_foreign_total") is not None:
        L.append(f"현물 합계 외국인 {sgn(fl['spot_foreign_total'])}억 · 기관 {sgn(fl['spot_organ_total'])}억")
    r = fl.get("fut")
    if r:
        L.append(f"선물 외국인 {sgn(r['foreign'])}계약 · 기관 {sgn(r['organ'])}계약 · 개인 {sgn(r['personal'])}계약"
                 f" (기준 {md_date(r.get('bizdate')) or '미수신'})")
    prog = fl.get("program")
    if prog and prog.get("total") is not None and not (prog["total"] == 0 and prog.get("bi") == 0):
        L.append(f"프로그램 순매수 {sgn(prog['total'])}억 (비차익 {sgn(prog.get('bi'))}억)")
    elif prog:
        L.append("프로그램 매매 집계 전")
    v = fl.get("verdict")
    if v:
        L.append(f"[임계] 현물 ±1,000억 · 선물 ±1,500계약(이 숫자는 판정 기준일 뿐, 다른 항목에 쓰지 말 것)")
        L.append(f"외인 현·선물 판정: {v['text']}")
    else:
        L.append("외인 현·선물 판정: 판정 보류(현물 또는 선물 집계 전)")
    L.append("")

    sup = f.get("supply")
    sup_date = (sup.get("basis_label") if sup else None) or "기준일 미수신"
    L.append(f"[수급 종목] 확정 {sup_date} 기준 — 아래 수치는 그 날짜의 확정치다(오늘 장중 수급이 아니다)")

    def sup_line(rows, key):
        bits = []
        for x in rows or []:
            amt = x.get(key)
            if amt is None:
                continue
            bits.append(f"{x['name']} {sgn(amt)}억")
        return ", ".join(bits)

    if sup:
        fb = sup_line(sup.get("foreign_buy"), "foreign_eok")
        ob = sup_line(sup.get("organ_buy"), "organ_eok")
        fs = sup_line(sup.get("foreign_sell"), "foreign_eok")
        db = ", ".join(f"{x['name']}(외인 {sgn(x.get('foreign_eok'))}억·기관 {sgn(x.get('organ_eok'))}억)"
                       for x in sup.get("dual_buy") or [])
        if fb:
            L.append(f"- 외국인 순매수 상위({sup_date} 확정): {fb}")
        if ob:
            L.append(f"- 기관 순매수 상위({sup_date} 확정): {ob}")
        if fs:
            L.append(f"- 외국인 순매도 상위({sup_date} 확정): {fs}")
        if db:
            L.append(f"- 외인·기관 동반 매수({sup_date} 확정): {db}")
    if not sup:
        L.append("- 종목별 수급 미수신")
    L.append("")

    L.append("[받는 쪽 — 주도 테마, 거래대금 300억↑ 상승 대장주]")
    _deep_done = set()
    if f["themes"]:
        for t in f["themes"]:
            avg = t.get("avg_pct")
            if avg is not None:
                strength = pct_text(avg)
                basis = ""
            else:
                strength = pct_text(t.get("calc_pct"))
                basis = f"{t.get('basis_label') or ''}, "
            head = (f"{t['rank']}위 {t['name']} {strength} ({basis}구성 {int(t.get('total') or 0)}종목 중"
                    f" 상승 {int(t.get('rise') or 0)} · 하락 {int(t.get('fall') or 0)})")
            L.append(head)
            for s in t.get("leaders") or []:
                extra = " · 상한가" if s.get("upper_limit") else ""
                L.append(f"   - 대장 {s['name']} {pct_text(s['pct'])} · 대금 {money_text_eok(s['value_eok'])}"
                         f" ({s.get('value_basis') or ''}){extra}")
            for s in t.get("co_movers") or []:
                L.append(f"   - 동반(300억 미만) {s['name']} {pct_text(s['pct'])} · 대금 {money_text_eok(s['value_eok'])}")
            n = t.get("news")
            if n:
                L.append(f"   - 재료(뉴스): {n['title']} ({n.get('press') or ''} {n.get('time') or ''})")
            dth = _deep_theme(f, t.get("name"))
            dart_bits = []
            for s in (dth or {}).get("leaders") or []:
                if s.get("name") in _deep_done:
                    continue
                _deep_done.add(s.get("name"))
                nw = s.get("news") or {}
                for it in (nw.get("items") or [])[:2]:
                    old = "  ※최근 기사 아님" if (it.get("age_h") or 0) > 36 else ""
                    L.append(f"   - 대장주 최신기사({s['name']}, {it.get('time') or ''}): {it['title']}"
                             f" ({it.get('press') or ''}){old}")
                if nw.get("ok") and nw.get("note"):
                    L.append(f"   - 대장주 기사({s['name']}): {nw['note']}")
                dt = s.get("dart") or {}
                if not dt:
                    continue
                day = md_date(str(dt.get("date") or "").replace("-", ""))
                if dt.get("ok") and dt.get("major"):
                    names = ", ".join(x["title"] + (f" 외 {x['count']-1}건" if (x.get("count") or 1) > 1 else "")
                                      for x in dt["major"])
                    dart_bits.append(f"{s['name']}: {names}")
                elif dt.get("ok") and dt.get("count"):
                    first = (dt.get("routine") or [{}])[0].get("title") or ""
                    dart_bits.append(f"{s['name']}: 일반공시 {int(dt['count'])}건({first} 등)")
            if dart_bits:
                L.append(f"   - 당일 공시({md_date(f['asof']['date'].replace('-', ''))}): " + " · ".join(dart_bits))
            elif dth:
                L.append(f"   - 당일 공시({md_date(f['asof']['date'].replace('-', ''))}): 대장주 접수 0건 — 주요 공시 없음")
    else:
        L.append("주도 테마 미수신")
    L.append("")

    L.append("[빠지는 쪽 — 하락 업종(전체 테마 중 하위) 및 대금 300억↑ 하락 대표]")
    for t in f.get("weak_themes") or []:
        line = f"{t['name']} {pct_text(t['pct'])} (구성 {int(t.get('total') or 0)}종목 중 상승 {int(t.get('up') or 0)} · 하락 {int(t.get('down') or 0)})"
        if t.get("leader"):
            line += f" · 대표 {t['leader']['name']} {pct_text(t['leader']['pct'])} 대금 {money_text_eok(t['leader']['value_eok'])}"
        else:
            line += " · 대표 종목 미수신"
        L.append(line)
    if not f.get("weak_themes"):
        atu = f.get("all_themes_up")
        if atu:
            L.append(f"하락 업종 없음 — 전 테마 상승(최저 {atu['name']} {pct_text(atu['pct'])})")
        else:
            L.append("하락 업종 미수신")
    for d in f.get("decliners") or []:
        L.append(f"하락 대표주 {d['name']} {pct_text(d['pct'])} · 대금 {money_text_eok(d['value_eok'])}")
    L.append("")

    ul = f.get("upper_limit") or {}
    if ul.get("count") is not None and (ul.get("count") or 0) + (ul.get("near") or 0) > 0:
        names = ", ".join(f"{r['name']} {pct_text(r['pct'])}" for r in ul.get("rows") or [])
        L.append(f"[상한가] 확정 {int(ul['count'])}종목" + (f" — {names}" if names else ""))
        if ul.get("near") is not None:
            near = ", ".join(f"{r['name']} {pct_text(r['pct'])}" for r in ul.get("near_rows") or [])
            L.append(f"  상한가 임박 {int(ul['near'])}종목" + (f" — {near}" if near else ""))
        L.append("")
    elif ul.get("count") is not None:
        L.append("[상한가] 확정 0종목 · 임박 0종목(관제탑 집계 기준)")
        L.append("")

    L.append("[기준선]")
    lv = f.get("levels")
    if lv and lv.get("markets"):
        for name, node in lv["markets"].items():
            bits = []
            if node.get("s1") is not None:
                bits.append(f"1차 지지 {node['s1']:,.2f}")
            if node.get("s2") is not None:
                bits.append(f"2차 지지 {node['s2']:,.2f}")
            if node.get("r1") is not None:
                bits.append(f"저항1 {node['r1']:,.2f}")
            if node.get("r2") is not None:
                bits.append(f"저항2 {node['r2']:,.2f}")
            if node.get("close") is not None:
                bits.append(f"전일 종가 {node['close']:,.2f}")
            if bits:
                L.append(f"{name} " + " · ".join(bits))
        L.append(f"(출처 daily_levels.json {lv.get('date') or ''})")
        if lv.get("note"):
            L.append(f"(기준 메모: {lv['note']})")
    else:
        L.append("저장된 1·2차 지지선 없음 — 전일 종가를 기준선으로 판단할 것")
    L.append("")

    if f.get("news"):
        L.append("[뉴스·재료]")
        for n in f["news"]:
            tag = ""
            if n.get("impact"):
                tag = f"[{n['impact']}" + (f"/{n['direction']}" if n.get("direction") else "") + "] "
            themes = f" → 관련테마: {', '.join(n['themes'])}" if n.get("themes") else ""
            L.append(f"- {tag}{n['title']} ({n.get('press') or ''} {n.get('time') or ''}){themes}")
        L.append("")

    if f.get("deep"):
        L.extend(deep_text(f))
        if L and L[-1] != "":
            L.append("")

    if f.get("long"):
        lg = f["long"]
        L.append("[관제탑 종가베팅 참고]")
        for r in lg.get("theme_track") or []:
            if r.get("name"):
                L.append(f"- 테마트랙 {r['name']} {pct_text(r.get('pct'))} · {r.get('theme') or ''}")
        for r in lg.get("supply_track") or []:
            if r.get("name"):
                L.append(f"- 수급트랙 {r['name']} {pct_text(r.get('pct'))} · 외인 {sgn(r.get('foreign_eok'))}억 · 기관 {sgn(r.get('organ_eok'))}억 · {r.get('kind') or ''}")
        if lg.get("basis_note"):
            L.append(f"- 기준 {lg['basis_note']}")
        L.append("")

    if f.get("errors"):
        L.append("[수집 실패] " + " | ".join(f["errors"][:4]))
    return "\n".join(L).strip()


SYSTEM_PROMPT = """너는 한국 주식 채널 '폭스시그널'의 장중 정통 브리핑 작성자다.
아래 FACTS에 적힌 실측값만으로, 정규 브리핑의 70~80% 분량(2,000~3,200자) 텔레그램 본문을 쓴다.
읽는 사람은 장중에 폰으로 잠깐 보는 개인 투자자다. 숫자·수급·테마·기준선이 한 번에 잡혀야 한다.

[절대 규칙]
1. FACTS에 있는 숫자만 쓴다. FACTS에 없는 숫자·전망치·목표가·예상 지수·지표(VIX·국채금리·달러인덱스 등)를 만들지 않는다.
2. 합계·평균·증감률을 새로 계산하지 않는다. FACTS에 이미 적힌 값만 인용한다.
3. 숫자는 FACTS의 표기(쉼표·소수점)를 그대로 옮긴다. 단위(억/조/계약/%/p)와 기준을 바꾸지 않는다.
4. FACTS가 '미수신'·'미집계'·'실시간 아님'이라고 하면 숨기지 말고 그대로 적는다.
5. FACTS의 날짜·시각을 바꾸지 않는다. 수급 기준일이 오늘이 아니면 '기준 11/25'처럼 기준일을 밝힌다.
6. 출력은 맨 첫 줄 헤드라인 + 아래 5개 블록만. 인사·서론·면책·맺음말·마크다운(**·##·표·```) 금지.
7. 분량은 장중 2,000~3,200자. 블록별 목표: 📌 1줄(약 100자) / 📊 약 460자 / 💰 약 620자
   / 🔥 약 860자 / 🧭 약 700자. 한 줄은 40~80자로 끊어 폰 화면에서 읽히게 하고,
   한 줄에 몰아 쓰지 말고 항목마다 '- '로 시작하는 줄로 나눈다.
8. 매수·매도 '추천'이 아니라 조건부 대응만 쓴다. '반드시·무조건·수익 보장' 금지.
9. 원인·재료는 FACTS의 [뉴스·재료]·[수급 종목]에 적힌 것만 쓴다. FACTS에 없는 원인 추정
   ('패닉', '실망 매물', '차익실현', '기관 매도', '외인 환헤지', '기대감', '수혜', '순환매')을 새로 만들지 않는다.
   해석을 붙이는 줄은 반드시 '[해석]'으로 시작한다. '[재료]'·'[전망]' 같은 새 라벨을 만들지 않는다.
   헤드라인·본문에서 '출발'·'개장'이라고 쓰지 않는다(장 시작 전이면 '개장 전', 장중이면 '상승/하락'으로만).
10. [기준 시각]의 국면을 지킨다. '장전'·'프리마켓'이면 '마감'·'종가 확정'·'출발'·'개장'이라고 쓰지 않고,
    선물이 '실시간 아님'이면 세션 표기(예: 15:45 마감)를 함께 적는다.
    FACTS의 '11/26 정규장 마감' 같은 기준 표기는 '11/26 종가 기준'으로 바꿔 쓴다(장중에 '마감'으로 읽히지 않게).
    FACTS가 '집계 전'이라 적은 값(등락 0.00%·수급 0억·등락종목수 0)은 0으로 쓰지 말고 '집계 전'이라 쓰며,
    그것으로 시장 방향을 단정하지 않는다.
11. 거래대금 300억 미만 종목은 '동반'으로만 언급한다. 대장주로 쓰지 않는다.
12. 상한가는 FACTS에 '상한가' 표시가 있는 종목만 그렇게 쓴다. 등락률만 보고 단정하지 않는다.
13. 순위는 FACTS에 적힌 순위만 쓴다('대금 1위' 같은 새 순위 주장 금지). 테마·종목·공시를 새로 만들지 않는다.
    상한가 '확정' 수와 '임박' 수를 더하지 않는다. 테마의 '구성 종목수'와 '상승/하락 종목수'를 섞지 않는다.
    [임계] 숫자(±1,000억·±1,500계약)는 판정 기준일 뿐이니 프로그램·비차익·거래대금에 옮겨 쓰지 않는다.
    선물 '미결제약정'은 계약 수가 아니라 미청산 잔량이다 — 투자자별 선물 수급으로 바꿔 쓰지 않는다.
14. 모든 문장은 '~습니다/~입니다' 존댓말. 이모지는 형식에 있는 것만 쓴다.
    지수 숫자에는 'p'를 붙이지 않는다(p는 등락폭 단위다: '코스피 4,729.01' / '+31.50p').
    한국어로 쓴다 — 'Concentrated', 'risk' 처럼 영어 단어를 섞지 않는다. HBM·AI·ETF·NXT·DART 같은 통용 약어만 그대로 쓴다.
15. 읽는 사람은 초보자다. 어려운 말을 그대로 던지지 말고 쉬운 말로 먼저 풀어 쓴다.
    베이시스 → '선물이 현물보다 비싼지 싼지를 보는 값(베이시스)',
    콘탱고·백워데이션 → '선물이 현물보다 비싼 상태·싼 상태',
    괴리율 → '이론 가격과 실제 가격의 차이(%)', 프로그램 비차익 → '컴퓨터가 지수 바스켓을 통째로 사고파는 것',
    미결제약정 → '아직 청산되지 않은 선물 계약 수', 디커플링 → '같이 움직이던 것이 따로 움직이는 것'.
    용어를 빼라는 뜻이 아니라, 용어 옆에 한 번은 쉬운 설명을 붙이라는 뜻이다.
16. [미장 → 국내 연결]은 '규칙(가설)'이다. 미장을 인용할 때는 '최근 정규장 날짜(현지)'를 반드시 붙이고,
    연결은 '지난밤 반도체가 약했으니 오늘 반도체·장비 쪽 수급이 붙는지 본다'처럼 확인 항목으로만 쓴다.
    오늘 국내 테마가 실제로 그렇게 움직였다는 FACTS의 등락이 없으면 '연결됐다'고 단정하지 않는다.
    미장 숫자가 없거나 '새 정규장 값이 없다'고 적혀 있으면 미장 줄을 통째로 뺀다(예전 값을 오늘처럼 쓰지 않는다).
17. [시나리오 오답 노트]의 숫자는 그날(과거) 값이다. 오늘 수치처럼 쓰지 않고 '피할 것'·'체크포인트'의
    원칙으로만 반영한다(예: '연속이 확인되지 않은 수급은 전환 1일차로만 본다').

[출력 형식]
{헤드라인 한 줄 — 지수 방향 + 핵심 수급 또는 대장 테마, 30자 안팎}

📌 한줄 요약
코스피 {값} {등락률} · 코스닥 {값} {등락률} · 외인 {현·선물 판정} · 대장 테마 {테마} — {지금 대응 한 줄}

📊 핵심 지표 & 매크로
- 코스피 {값} ({등락}p / {등락률}) — 전일 종가 {값}
- 코스피 시 {값} · 고 {값} · 저 {값} · 대금 {값}
- 코스닥 {값} ({등락}p / {등락률}) — 전일 종가 {값}
- 코스닥 고 {값} · 저 {값} · 대금 {값}
- 선물 {값} ({등락률}, {세션}) · 베이시스 {값}p(선물이 현물보다 비싼지 싼지를 보는 값) · 미결제 {계약}
- 상승:하락 코스피 {상승}:{하락} / 코스닥 {상승}:{하락} · 상한가 확정 {개수}종목
- 원/달러 {값}원 ({등락률}, {기준일})
- 미장 {최근 정규장 날짜(현지)}: 다우 {값} {등락률} · 나스닥 {값} {등락률} · 필라델피아 반도체 {값} {등락률} · 엔비디아 {값} {등락률} (FACTS에 없으면 그 항목은 뺀다)

💰 투자자별 수급 & 흐름 해석
- 외국인 현물 코스피 {값} · 코스닥 {값}
- 외국인 선물 {계약} ({기준일})
- 기관 현물 코스피 {값} · 코스닥 {값} · 선물 {계약}
- 개인 코스피 {값} · 프로그램 {값}
- 현·선물 판정: {FACTS의 판정 문장}
- 외인 순매수 상위 {종목} · 기관 순매수 상위 {종목}
- 연속 수급: {FACTS의 [3~5거래일 연속 수급] — 전일 대장주 '외인 3일 연속 +152억' 같은 줄 2~3개}
- [해석] {왜 이런 수급이 나왔는지, 어떤 의미인지 — FACTS 근거로 2~3줄}

🔥 장중 주도 테마 & 대장주 (거래대금 300억↑)
- {테마1} {등락률} — 구성 {종목수}종목 중 상승 {상승} · 하락 {하락}
- 대장 {종목} {등락률} ({거래대금})
- 동반 {종목} {등락률} ({거래대금})
- {FACTS에 그 테마에 붙은 뉴스 헤드라인. 없으면 '재료 뉴스 미수신'}
- {테마2} {등락률} — 구성 {상승}상승/{하락}하락
- 대장 {종목} {등락률} ({거래대금})
- 재료: {헤드라인 또는 미수신}
- 공시: {FACTS의 그 테마 '당일 공시' — 주요 공시가 없으면 '주요 공시 없음'}
- {테마3} {등락률}
- 대장 {종목} {등락률} ({거래대금})
- 빠지는 쪽: {업종} {등락률}
- 하락 대표주: {종목} {등락률} ({거래대금})
- [해석] 테마 총평: {오늘 자금이 어느 테마로 몰리고 어디서 빠지는지 한 문장 — 새 수치 계산 금지}
🧭 대응 시나리오
- 지금 위치: 코스피 {값} — 오늘 {저}~{고} 박스에서 어디쯤, 1차 지지 {값} 대비 {위/아래} · 전일 종가 {값}
- 큰 틀: 1차 지지 {값} · 2차 지지 {값} · 저항1 {값} · 저항2 {값} — 지금 박스의 위·아래 경계
- 전일 테마 잔류: {전일 대장 테마 등락률 → 오늘 등락률(유지/약화/이탈) · 전일 주도 종목 중 오늘 상승 N/M}
- 코스닥 {값} — 1차 지지 {값} · 저항1 {값}
- ① 돌파·강세 ({숫자 조건}): {내 계좌 행동 — 분할 여부·비중·추격 금지}
- ② 박스권·혼조 ({숫자 조건}): {내 계좌 행동 — 관망·소액·대기}
- ③ 이탈·약세 ({숫자 조건}): {내 계좌 행동 — 비중 축소·현금·물타기 금지}
- 피할 것: {오늘 하면 안 되는 행동 하나 — FACTS 근거로}
- 확률 우위: {상승·박스·하락 중 무게가 실리는 쪽 + 근거 1줄 — 숫자는 FACTS 것만}
- 체크포인트: {다음에 확인할 것 — FACTS의 기준선·수급·상한가 중에서}
""" + CHECKER_URL + """

[작성 지침]
- 📌 는 정확히 한 줄이다(두 줄 금지). 지수 방향·외인 현선물 판정·대장 테마·대응이 모두 들어가야 한다.
- 📊 는 FACTS의 지수·선물·베이시스·등락종목수·상한가·환율만 쓴다. 없는 값은 그 줄을 빼고 '미수신'으로 남긴다.
  코스피·코스닥은 전일 종가·고가·저가·거래대금을 각각 한 줄로 나눠 적는다.
  미장·빅테크는 '최근 정규장 날짜'를 붙여 한 줄로 쓰고, 초보자를 위해 왜 보는지 한 줄을 덧붙인다
  (예: '간밤 미국 반도체·엔비디아가 약했습니다. 오늘 국내 반도체·HBM 수급이 따라오는지 보면 됩니다').
  '새 정규장 값이 없다'고 적혀 있으면 미장 줄을 빼고, 그 사실을 지어내지 않는다.
- 💰 는 시장 전체 투자자별 수급(현물 억원, 선물 계약)과 프로그램 수치를 줄별로 쓰고, 이어서 [수급 종목]의
  외인·기관 순매수·순매도 상위 종목을 근거로 '[해석]' 줄을 2~3줄 쓴다. 해석은 FACTS에 있는 종목·수급·뉴스로만 연결한다.
  [3~5거래일 연속 수급]은 일수·누적 금액을 FACTS에 적힌 그대로 옮기고 '확정 기준일'을 밝힌다.
  1일짜리는 '연속'이라 쓰지 않고 '11/25 하루 순매수'처럼 적는다. 확인되지 않은 수급을 '이어지는 매수세'로 읽지 않는다.
  '외국인·기관 선물'은 [수급]의 투자자별 계약 수만 쓴다. 미결제약정(예: 178,878계약)은 📊의 선물 줄에만 쓰고,
  투자자별 선물 수급이 '집계 전'이면 그 줄은 '집계 전'으로만 적는다(미결제를 외인 선물로 옮겨 쓰지 않는다).
- 🔥 는 [받는 쪽]의 2~3개 테마를 순서대로 쓴다. 테마마다 ① 첫 줄: 테마·등락률·(구성 상승/하락)
  ② 둘째 줄: 대장주와 등락률·거래대금 ③ 셋째 줄: 동반 종목과 재료(뉴스) — 로 나눠 적는다.
  '재료(뉴스)'가 FACTS의 그 테마 줄에 '재료(뉴스):'로 붙어 있을 때만 그 헤드라인을 인용하고,
  없으면 재료를 지어내지 말고 '재료 뉴스 미수신'이라 적는다. [뉴스·재료] 목록의 다른 헤드라인을
  특정 테마의 상승 이유로 끌어다 붙이지 않는다(테마↔뉴스 연결은 FACTS에 표시된 것만).
  마지막에 [빠지는 쪽]을 대비시키되, 업종의 대표 종목은 FACTS에 '대표'로 붙은
  종목만 쓰고 없으면 업종 등락률만 쓴다. '하락 대표주'는 FACTS에 그렇게 적힌 종목만 별도 줄로 쓰고
  업종 옆에 '— 대표'로 이어 붙이지 않는다.
  테마는 2~3개까지만 쓰고 테마당 5줄을 넘기지 않는다(분량은 지표·수급·시나리오에서 채운다).
  '당일 공시'는 FACTS에 적힌 공시명만 쓰고(무엇을 담은 공시인지·주가에 어떻게 작용할지는 추정하지 않는다),
  '대장주 최신기사'는 날짜를 붙여 인용하며 '※최근 기사 아님'이 붙은 기사는 오늘 재료로 쓰지 않는다.
  '대장주 기사: 제목에 종목명이 든 기사 없음'이면 '재료 뉴스 미수신'으로 적는다.
- 🧭 '대응 시나리오'는 이름 그대로 오늘의 대응만 쓴다(단순 전망·지수 나열 금지).
  첫 두 줄에서 큰 틀을 먼저 잡는다: ① 지금 지수가 오늘 저가·고가(또는 지지·저항) 박스 안 어디쯤인지,
  ② 전일 종가·1차/2차 지지·저항으로 이루어진 박스의 위·아래 경계. 숫자는 FACTS에 있는 값만 쓴다.
  이어서 세 갈래(① 돌파·강세 / ② 박스권·혼조 / ③ 이탈·약세)마다 FACTS의 기준선 숫자로 조건을 달고
  각 갈래의 '내 계좌 행동'을 구체적으로 쓴다 — 무엇을 분할로 담고, 무엇을 줄이고(비중 축소·청산),
  무엇을 하지 않는지(추격 금지·물타기 금지·종베 자제)를 조건과 함께 단호하게 적는다.
  '피할 것' 한 줄로 오늘 가장 위험한 행동을 못 박고, '확률 우위' 한 줄로 세 갈래 중 무게가 실리는 쪽과
  그 근거(FACTS의 수급·기준선·테마)를 적는다. 마지막 '체크포인트' 한 줄로 다음 확인 항목을 남긴다.
  FACTS에 없는 지지선·저항선·목표가를 새로 만들지 않는다. 지지선이 없으면 전일 종가를 기준선으로 쓴다.
  세 갈래 행동은 '관망 / 분할 / 추격 금지 / 비중 축소 / 현금' 중에서 조건과 함께 고른다.
  '전일 테마 잔류'는 FACTS의 [테마 연속성·자금 잔류] 값만 쓰고, '오늘 값이 직전 거래일 기준'이라고 적혀 있으면
  '장중에 다시 확인'이라고 덧붙인다(직전 거래일 값으로 오늘 판단을 단정하지 않는다).
  '확률 우위'에는 FACTS의 수급·기준선·테마 중 가장 무거운 근거 하나만 쓰고, 미장 연결은 가설로만 덧붙인다.
- 같은 숫자를 여러 블록에서 다시 써도 된다. 분량을 채우려고 없는 사실을 늘리지는 않는다.
  단, FACTS에 있는 수치·종목·테마·기준선은 빠짐없이 인용한다(인용만으로 분량이 채워진다).
- '동반'은 FACTS에 '동반(300억 미만)'으로 적힌 종목에만 쓰고, 거래대금 300억↑ 종목은 모두 '대장'으로 쓴다.
- 한 줄에 '집계 전'·'미수신'을 세 번 이상 쓰지 않는다. 그런 줄은 통째로 뺀다.
- 🔥 마지막에 '[해석] 테마 총평' 한 줄을 반드시 넣는다. 🧭 마지막에 '체크포인트' 한 줄을 반드시 넣는다.
- 다 쓰고 나서 글자 수를 세라. 2,000자보다 짧으면 FACTS에 있는 다른 수치·종목·기준선을 각 블록에 더 붙여 늘려라.
- 문장은 짧고 단정하게. '~로 보입니다'를 반복하지 말고 근거 숫자를 먼저 쓴다."""


def call_gemini(api_key, model, system_prompt, user_text, timeout=60, max_tokens=4096,
                temperature=0.35, thinking_budget=0):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    body = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
    }
    if thinking_budget is not None:
        body["generationConfig"]["thinkingConfig"] = {"thinkingBudget": thinking_budget}
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            pass
        # thinkingConfig 미지원 모델이면 한 번만 빼고 재시도
        if e.code == 400 and "thinking" in detail.lower() and "thinkingConfig" in body["generationConfig"]:
            body["generationConfig"].pop("thinkingConfig", None)
            req = urllib.request.Request(
                url, data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json", "User-Agent": UA},
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
        else:
            raise
    cands = data.get("candidates") or []
    if not cands:
        raise RuntimeError(f"후보 없음: {json.dumps(data)[:200]}")
    parts = (cands[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text:
        raise RuntimeError(f"빈 응답: finish={cands[0].get('finishReason')}")
    usage = data.get("usageMetadata") or {}
    usage["finishReason"] = cands[0].get("finishReason")
    return text, usage


# --------------------------------------------------------------------------- #
# 검증
# --------------------------------------------------------------------------- #
NUM_RE = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?")
URL_RE = re.compile(r"https?://\S+")
# FACTS에 없는 '원인·심리' 어휘 — [해석] 줄이 아니면 쓰지 않는다(숫자와 같은 방식으로 막는다)
RISK_WORDS = ["기대감", "수혜주", "수혜", "차익실현", "차익 실현", "실망 매물", "매물 소화", "순환매",
              "패닉", "공포 심리", "저가 매수세", "반발 매수", "기관 매도", "외인 환헤지"]
SAFE_INTS = set(range(0, 31)) | {32, 45, 50, 60, 100, 150, 200, 300, 500, 1000, 1200,
                                1500, 2000, 2500, 3000, 3200, 4096, 2025, 2026, 2027}


def numbers_in(text):
    out = []
    for m in NUM_RE.finditer(URL_RE.sub(" ", text)):
        try:
            out.append(float(m.group(0).replace(",", "")))
        except ValueError:
            pass
    return out


def allowed_numbers(ftext):
    allowed = set()
    for v in numbers_in(ftext):
        allowed.add(round(v, 4))
        allowed.add(float(round(v)))          # 정수 반올림 허용
        allowed.add(float(math.floor(v)))     # 내림 표기 허용 (4,697.51 → 4,697)
        allowed.add(float(math.ceil(v)))      # 올림 표기 허용
        allowed.add(round(v, 1))              # 소수 1자리 반올림 허용
        allowed.add(round(v, 2))
        if abs(v) >= 100:                     # 억 → 조 변환 허용
            allowed.add(round(v / 10000, 1))
            allowed.add(round(v / 10000, 2))
        if abs(v) >= 10000:                   # 원 → 억/조 표기 변환 허용
            allowed.add(round(v / 1e8, 1))
            allowed.add(round(v / 1e8, 0))
    allowed |= SAFE_INTS
    return allowed


def body_min_chars(facts):
    """근거가 얇은 장전에는 2,000자를 강요하지 않는다(빈말로 채우는 것보다 짧은 게 낫다).

    등락종목수·투자자별 수급·판정·테마·하락 섹터·상한가·종목수급 중 5개 이상이 잡히는
    정상 장중에는 2,000자 목표를 그대로 요구한다.
    """
    rich = 0
    idx = facts.get("indices") or []
    if any((r.get("breadth") or {}).get("up") for r in idx):
        rich += 1
    fl = facts.get("flows") or {}
    if fl.get("kospi"):
        rich += 1
    if fl.get("verdict"):
        rich += 1
    if facts.get("themes"):
        rich += 1
    if facts.get("decliners") or facts.get("weak_themes"):
        rich += 1
    if (facts.get("upper_limit") or {}).get("count"):
        rich += 1
    if facts.get("supply"):
        rich += 1
    return BODY_TARGET_MIN if rich >= 5 else 1400


def normalize_headers(body):
    """5블록 헤더를 정식 문구로 고정한다(모델이 흔들려도 양식이 유지되게)."""
    out = []
    for ln in body.splitlines():
        s = ln.strip()
        probe = re.sub(r"^[-•*]\s*", "", s)   # '- 📊 ...' 처럼 불릿이 붙은 헤더도 잡는다
        replaced = False
        for emoji, header in BLOCK_HEADERS:
            if probe.startswith(emoji):
                out.append(header)
                replaced = True
                break
        if not replaced:
            out.append(ln)
    return "\n".join(out)


def validate_body(body, ftext, phase=None, min_chars=BODY_MIN):
    """(ok, 문제점 리스트). 숫자 창작·형식 누락·분량 미달을 잡는다."""
    problems = []
    lines = [ln.strip() for ln in body.strip().splitlines() if ln.strip()]
    if not lines:
        return False, ["본문 비어 있음"]
    if len(lines) < 14:
        problems.append(f"줄 수 부족({len(lines)}자 아님)")

    n_chars = len(body)
    if n_chars < min_chars:
        problems.append(f"분량 부족({n_chars}자 < {BODY_TARGET_MIN}~{BODY_TARGET_MAX}자 목표)")
    if n_chars > BODY_MAX:
        problems.append(f"본문 과다({n_chars}자 > {BODY_MAX}자)")

    positions = {}
    for i, ln in enumerate(lines):
        for _, header in BLOCK_HEADERS:
            if ln.strip() == header and header not in positions:
                positions[header] = i
    for sec in REQ_SECTIONS:
        if sec not in positions:
            problems.append(f"섹션 누락: {sec}")
    if len(positions) == len(REQ_SECTIONS):
        order = [positions[s] for s in REQ_SECTIONS]
        if order != sorted(order):
            problems.append("섹션 순서 어긋남")

    # 📌 한 줄 요약은 두 줄 이상이면 안 된다
    try:
        i = positions["📌 한줄 요약"]
        j = positions["📊 핵심 지표 & 매크로"]
        block = [ln for ln in lines[i + 1:j] if ln.strip()]
        if len(block) > 1:
            problems.append(f"한줄 요약이 {len(block)}줄")
        if not block:
            problems.append("한줄 요약 내용 없음")
    except KeyError:
        pass

    # 🧭 대응 시나리오 3분기(① ② ③) + 계좌 행동·피할 것
    try:
        i = positions["🧭 대응 시나리오"]
        tail = "\n".join(lines[i + 1:])
        missing = [m for m in ("①", "②", "③") if m not in tail]
        if missing:
            problems.append(f"시나리오 누락: {''.join(missing)}")
        if len(tail) < 200:
            problems.append("🧭 분량 부족")
        elif len([ln for ln in tail.splitlines() if ln.strip()]) < 6:
            problems.append("🧭 항목 부족(박스 위치·3갈래·피할 것·체크포인트를 줄로 나눌 것)")
    except KeyError:
        pass

    # 🔥 테마 블록에 300억↑ 대장 종목 흔적
    try:
        i = positions["🔥 장중 주도 테마 & 대장주 (300억↑ 실측)"]
        j = positions["🧭 대응 시나리오"]
        block = "\n".join(lines[i + 1:j])
        if len(block) < 150:
            problems.append("🔥 테마 블록 분량 부족")
    except KeyError:
        pass

    if "**" in body or "##" in body:
        problems.append("마크다운 금지 위반")
    if phase in ("장전", "프리마켓", "정규장"):
        # 시각(06:00·15:45)이 앞에 붙은 '마감'은 선물 세션 표기라 위반이 아니다
        probe = re.sub(r"\d{1,2}:\d{2}", " ", body)
        # 날짜·직전 거래일이 붙은 '마감'은 그 세션을 가리키는 정상 표기다(오늘 마감 주장이 아니다)
        #   예: '11/26 정규장 마감 기준', '11/26(목) 마감', '전일 거래일 마감'
        probe = re.sub(r"\d{1,2}/\d{1,2}\s*(?:\([월화수목금토일]\))?\s*(?:정규장|정규|장)?\s*마감", " ", probe)
        probe = re.sub(r"(?:직전|전일)\s*(?:거래일)?[^\n]{0,6}마감", " ", probe)
        # '장 마감까지·마감 전' 처럼 앞을 가리키는 말은 '이미 끝났다'는 서술이 아니다
        probe = re.sub(r"마감\s*(?:까지|전|무렵|직전)", " ", probe)
        mm = re.search(r"(?:정규장|장)\s*마감|종가\s*확정|마감했|(?:상승|하락|보합|급등|급락)\s*마감", probe)
        if mm:
            ctx = probe[max(0, mm.start() - 12):mm.end() + 8].replace("\n", " ")
            problems.append(f"국면 불일치: {phase}인데 '마감' 서술 ({ctx})")
    if phase in ("장전", "프리마켓") and "출발" in body:
        problems.append(f"국면 불일치: {phase}인데 '출발' 서술")

    allowed = allowed_numbers(ftext)
    unknown = []
    for n in numbers_in(body):
        hit = any(abs(n - a) <= 0.011 or (a != 0 and abs(n - a) / abs(a) < 1e-9) for a in allowed)
        if not hit:
            unknown.append(n)
    if unknown:
        uniq = []
        for n in unknown:
            if all(abs(n - u) > 1e-9 for u in uniq):
                uniq.append(n)
        problems.append("근거 없는 숫자: " + ", ".join(f"{n:g}" for n in uniq[:8]))

    # FACTS에 없는 원인·심리 어휘([해석] 줄 제외) — 뉴스 제목에 있는 말은 허용
    bad_words = []
    for ln in lines:
        if ln.startswith("[해석]"):
            continue
        for w in RISK_WORDS:
            if w in ln and w not in ftext:
                bad_words.append(w)
    if bad_words:
        uniq_w = []
        for w in bad_words:
            if w not in uniq_w:
                uniq_w.append(w)
        problems.append("근거 없는 원인 어휘: " + ", ".join(uniq_w[:5]))

    # 테마 구성 종목수와 상승/하락 수를 섞어 쓴 경우("구성 19상승/7하락" 같은 표기)
    if re.search(r"구성\s*\d+\s*(?:상승|하락)", body):
        problems.append("테마 표기 오류: '구성 N상승/N하락'(구성 종목수와 상승/하락 수를 섞음)")

    # 상한가 '확정' 수와 '임박' 수를 더해 버린 경우(예: 2+1=3)
    m = re.search(r"상한가\s*(?:확정\s*)?(\d+)\s*종목", body)
    if m:
        n = int(m.group(1))
        fm = re.search(r"\[상한가\] 확정 (\d+)종목", ftext)
        nm = re.search(r"상한가 임박 (\d+)종목", ftext)
        bm = re.search(r"상한 (\d+)", ftext)      # 등락종목수 줄의 '상한 N'도 FACTS 실측치다
        confirmed = {float(fm.group(1))} if fm else set()
        near = {float(nm.group(1))} if nm else set()
        breadth = {float(bm.group(1))} if bm else set()
        if float(n) not in (confirmed | near | breadth):
            problems.append(f"상한가 수 불일치({n}종목 — FACTS와 다름)")
    return (not problems), problems


def clean_body(text):
    t = text.replace("\r", "").strip()
    t = re.sub(r"^\s*```[a-z]*\s*", "", t)
    t = t.replace("```", "")
    t = t.replace("**", "").replace("##", "")
    lines = [ln.rstrip() for ln in t.splitlines()]
    # 헤더를 Gemini가 다시 쓴 경우 제거
    while lines and lines[0].lstrip().startswith("🦊"):
        lines.pop(0)
    while lines and not lines[0].strip():
        lines.pop(0)
    # '헤드라인:' / '제목:' 접두어 제거
    if lines:
        lines[0] = re.sub(r"^\s*(헤드라인|제목)\s*[:：\-—]\s*", "", lines[0]).strip()
    # 과도한 빈 줄 정리(2줄 이상 → 1줄)
    out = []
    blank = 0
    for ln in lines:
        if not ln.strip():
            blank += 1
            if blank >= 2:
                continue
        else:
            blank = 0
        out.append(ln.strip())
    return normalize_headers("\n".join(out).strip())


def build_header(slot):
    """텔레그램 공개 발송 헤더 — 작성 주체 표기는 넣지 않는다(2026-11-26 사용자 요청).

    · 09:30 회차는 장이 막 열린 시각이라 '장초반 브리핑'으로 부른다(나머지는 '장중 브리핑').
    · Gemini 작성 여부는 관제탑 타임라인 슬롯(src·statusLabel)에만 남긴다.
    """
    label = "장초반 브리핑" if str(slot).strip().startswith("09:") else "장중 브리핑"
    return f"🦊 폭스시그널 · {slot} {label}"


def fit_telegram(text, limit=TG_LIMIT - 96):
    """텔레그램 4,096자 한도에 맞춘다(줄 경계에서 자른다)."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    idx = cut.rfind("\n")
    if idx > limit * 0.6:
        cut = cut[:idx]
    return cut.rstrip() + "\n… (분량 한도로 이하 생략)"


def _idx_line(r):
    if r["price"] is None:
        return f"{r['name']} 미수신"
    tail = "집계 전" if r.get("stale") else pct_text(r["pct"])
    return f"{r['name']} {r['price']:,.2f} ({sgn(r['change'],2)}p / {tail})"


def _breadth(r):
    b = r.get("breadth") or {}
    if b.get("up") is None:
        return "미수신"
    if (b.get("up") or 0) == 0 and (b.get("down") or 0) == 0:
        return "집계 전"
    return f"{int(b['up'])}:{int(b['down'])}"


def fallback_body(f):
    """Gemini 실패 시 — 실측값만으로 같은 5블록 양식."""
    k, q = f["indices"][0], f["indices"][1]
    fl = f.get("flows") or {}
    fu = f.get("futures")
    fx = f.get("fx")
    lv = (f.get("levels") or {}).get("markets") or {}
    kospi_lv = lv.get("코스피") or {}
    kosdaq_lv = lv.get("코스닥") or {}

    headline_bits = [x for x in (_idx_line(k), _idx_line(q)) if "미수신" not in x]
    headline = " · ".join(headline_bits) if headline_bits else "장중 시황"
    verdict = (fl.get("verdict") or {}).get("label")
    if verdict:
        headline += f" · 외인 {verdict}"
    elif f.get("themes"):
        headline += f" · {f['themes'][0]['name']} 강세"

    basis = f"기준 {md_date(fl.get('basis_date'))}" if fl.get("basis_date") else "기준일 미수신"

    # 📌
    summary = " · ".join(x for x in (_idx_line(k), _idx_line(q)) if "미수신" not in x) or "지수 미수신"
    if verdict:
        summary += f" · 외인 {verdict}"
    if f.get("themes"):
        t0 = f["themes"][0]
        lead = (t0.get("leaders") or [None])[0]
        summary += f" · 대장 테마 {t0['name']} {pct_text(t0.get('avg_pct'))}"
        if lead:
            summary += f"({lead['name']} {pct_text(lead['pct'])})"
    action_line = ""
    if k["price"] is not None and kospi_lv.get("s1") is not None:
        if k["price"] < kospi_lv["s1"]:
            action_line = "1차 지지 이탈 — 지지 회복 확인 전 추격 금지·비중 축소"
        elif kospi_lv.get("r1") is not None and k["price"] >= kospi_lv["r1"]:
            action_line = "저항1 위 유지 — 주도 테마 눌림만 분할 대응"
        else:
            action_line = "지지~저항 사이 박스 — 관망하며 거래대금 동반 확인"
    else:
        action_line = "실측값 확인 전 관망"
    summary += f" — {action_line}"

    # 📊
    macro = [_idx_line(k), _idx_line(q)]
    if k.get("prev_close") is not None:
        macro.append(f"코스피 전일 종가 {k['prev_close']:,.2f}" + (f" · 대금 {eok_text(k['value_eok'])}" if k.get("value_eok") else ""))
    if q.get("prev_close") is not None:
        macro.append(f"코스닥 전일 종가 {q['prev_close']:,.2f}" + (f" · 대금 {eok_text(q['value_eok'])}" if q.get("value_eok") else ""))
    if fu:
        basis_bit = f" · 베이시스 {sgn(fu.get('basis'),2)}p" if fu.get("basis") is not None else ""
        macro.append(f"선물 {fu['price']:,.2f} ({pct_text(fu.get('pct'))}, {fu.get('session') or ''}){basis_bit}")
    else:
        macro.append("선물 미수신")
    macro.append(f"상승:하락 코스피 {_breadth(k)} / 코스닥 {_breadth(q)}")
    ul = f.get("upper_limit") or {}
    if ul.get("count") is not None:
        if (ul.get("count") or 0) + (ul.get("near") or 0) > 0:
            macro.append(f"상한가 확정 {int(ul['count'])}종목 · 임박 {int(ul.get('near') or 0)}종목")
        else:
            macro.append("상한가 집계 전")
    if fx:
        macro.append(f"원/달러 {fx['price']:,.2f}원 ({pct_text(fx.get('pct'))}, 기준 {fx.get('traded_date') or '미상'})")
    else:
        macro.append("원/달러 미수신")
    us = ((f.get("deep") or {}).get("us") or {})
    us_idx = [r for r in us.get("indices") or [] if r.get("ok") and r.get("pct") is not None]
    if us_idx:
        macro.append(f"미장 {us.get('latest_date')}(현지): " + " · ".join(
            f"{r['name']} {r['price']:,.2f}({pct_text(r.get('pct'))})" for r in us_idx))

    # 💰
    flow = []
    for key, label in (("kospi", "코스피"), ("kosdaq", "코스닥")):
        r = fl.get(key)
        flow.append(f"{label} 외인 {sgn(r['foreign'])}억·기관 {sgn(r['organ'])}억·개인 {sgn(r['personal'])}억"
                    if r else f"{label} 수급 미수신")
    if fl.get("fut"):
        r = fl["fut"]
        flow.append(f"선물 외인 {sgn(r['foreign'])}계약·기관 {sgn(r['organ'])}계약 ({basis})")
    else:
        flow.append("선물 수급 미수신")
    prog = fl.get("program")
    if prog and prog.get("total") and not (prog["total"] == 0 and prog.get("bi") == 0):
        flow.append(f"프로그램 순매수 {sgn(prog['total'])}억 (비차익 {sgn(prog.get('bi'))}억)")
    if verdict:
        flow.append(f"외인 현·선물 판정: {(fl.get('verdict') or {}).get('text')}")
    else:
        flow.append("외인 현·선물 판정: 현물 수급 집계 전으로 판정 보류")
    sup = f.get("supply")
    if sup:
        fb = ", ".join(f"{x['name']} {sgn(x.get('foreign_eok'))}억" for x in sup.get("foreign_buy") or [])
        ob = ", ".join(f"{x['name']} {sgn(x.get('organ_eok'))}억" for x in sup.get("organ_buy") or [])
        if fb:
            flow.append(f"외인 순매수 상위(확정 {sup.get('basis_label') or ''}): {fb}")
        if ob:
            flow.append(f"기관 순매수 상위: {ob}")
    deep = f.get("deep") or {}
    streak_rows = []
    for r in (deep.get("supply_streaks") or {}).get("rows") or []:
        sv = r.get("supply") or {}
        if not sv.get("ok"):
            continue
        seg = [x for x in (_streak_line(sv.get("foreign"), "외인"),
                           _streak_line(sv.get("organ"), "기관")) if x and "연속 없음" not in x]
        if seg:
            streak_rows.append(f"{r.get('name')} " + " ".join(seg))
        if len(streak_rows) >= 2:
            break
    if streak_rows:
        flow.append("연속 수급(확정): " + " / ".join(streak_rows))
    flow.append("[해석] 수급 해석 문장은 Gemini 응답 실패로 생략했습니다. 위 수치는 수집된 실측값 그대로입니다.")

    # 🔥
    themes = []
    for t in (f.get("themes") or [])[:3]:
        leaders = t.get("leaders") or []
        if not leaders:
            continue
        themes.append(f"{t['name']} {pct_text(t.get('avg_pct'))}"
                      f" (구성 {int(t.get('total') or 0)}종목 중 상승 {int(t.get('rise') or 0)} · 하락 {int(t.get('fall') or 0)})")
        for s in leaders[:2]:
            themes.append(f"대장 {s['name']} {pct_text(s['pct'])} · 대금 {money_text_eok(s['value_eok'])}"
                          + (" · 상한가" if s.get("upper_limit") else ""))
        co = t.get("co_movers") or []
        if co:
            themes.append("동반: " + ", ".join(f"{s['name']} {pct_text(s['pct'])}" for s in co))
        n = t.get("news")
        if n:
            themes.append(f"재료: {n['title']} ({n.get('press') or ''})")
        dth = _deep_theme(f, t.get("name"))
        darts = []
        for s in (dth or {}).get("leaders") or []:
            dt = s.get("dart") or {}
            if dt.get("ok") and dt.get("major"):
                darts.append(f"{s['name']} {', '.join(x['title'] for x in dt['major'])}")
        if darts:
            themes.append("당일 공시: " + " / ".join(darts))
    if not themes:
        themes.append("주도 테마 미수신")
    weak = []
    for t in (f.get("weak_themes") or [])[:2]:
        line = f"{t['name']} {pct_text(t['pct'])}"
        if t.get("leader"):
            line += f" · 대표 {t['leader']['name']} {pct_text(t['leader']['pct'])} ({money_text_eok(t['leader']['value_eok'])})"
        weak.append(line)
    if not weak:
        for d in (f.get("decliners") or [])[:2]:
            weak.append(f"하락 대표 {d['name']} {pct_text(d['pct'])} ({money_text_eok(d['value_eok'])})")
    if weak:
        themes.append("빠지는 쪽: " + " · ".join(weak))
    elif f.get("all_themes_up"):
        themes.append(f"빠지는 쪽: 하락 업종 없음(전 테마 상승, 최저 {f['all_themes_up']['name']} {pct_text(f['all_themes_up']['pct'])})")
    ul = f.get("upper_limit") or {}
    if ul.get("rows"):
        themes.append("상한가: " + ", ".join(f"{r['name']} {pct_text(r['pct'])}" for r in ul["rows"]))

    # 🧭 대응 시나리오 (박스 위치 → 3갈래 계좌 행동 → 피할 것)
    view = []
    if k["price"] is not None:
        s1 = kospi_lv.get("s1")
        s2 = kospi_lv.get("s2")
        r1 = kospi_lv.get("r1")
        r2 = kospi_lv.get("r2")
        loc = []
        if k.get("low") is not None and k.get("high") is not None:
            loc.append(f"오늘 {k['low']:,.2f}~{k['high']:,.2f} 박스 안")
        if s1 is not None:
            loc.append(f"1차 지지 {s1:,.2f} {'위' if k['price'] >= s1 else '아래'}")
        if k.get("prev_close") is not None:
            loc.append(f"전일 종가 {k['prev_close']:,.2f} 대비 {'위' if k['price'] >= k['prev_close'] else '아래'}")
        view.append(f"지금 위치: 코스피 {k['price']:,.2f} — " + (" · ".join(loc) if loc else "박스 기준 미수신"))
        box = []
        for lab, v in (("1차 지지", s1), ("2차 지지", s2), ("저항1", r1), ("저항2", r2)):
            if v is not None:
                box.append(f"{lab} {v:,.2f}")
        view.append("큰 틀: " + (" · ".join(box) if box else "저장된 지지·저항 없음 — 전일 종가를 기준선으로 판단"))
        if s1 is not None and r1 is not None:
            view.append(f"① 돌파·강세: {r1:,.2f} 위 유지 시 → 주도 테마 눌림만 분할, 추격 매수 금지")
            view.append(f"② 박스권·혼조: {s1:,.2f}~{r1:,.2f} 왕복 시 → 관망, 거래대금 동반 확인 전 신규 진입 보류")
            view.append(f"③ 이탈·약세: {s1:,.2f} 아래로 밀리면 → 비중 축소·현금 확보, 반등 전 물타기 금지")
        elif s1 is not None:
            view.append(f"① 돌파·강세: 지지 {s1:,.2f} 위 유지 시 → 주도 테마 눌림 분할")
            view.append(f"② 박스권·혼조: {s1:,.2f} 부근 왕복 → 관망·소액만")
            view.append(f"③ 이탈·약세: {s1:,.2f} 아래 → 비중 축소·현금, 추격 금지")
        else:
            view.append("① 돌파·강세: 전일 종가 위 유지 시 → 주도 테마 눌림 분할")
            view.append("② 박스권·혼조: 전일 종가 부근 왕복 → 관망")
            view.append("③ 이탈·약세: 전일 종가 아래 → 비중 축소·현금, 물타기 금지")
        view.append("피할 것: 기준선 이탈 뒤 반등 없는 추격 매수·물타기, 거래대금 확인 전 신규 진입")
        view.append("확률 우위: 실측 대체 본문이라 확률 수치는 적지 않습니다 — 지지선 사수 여부와 외인 선물 방향으로 판단하십시오")
    else:
        view.append("지수 미수신 — 박스·기준선 판단 불가")
        view.append("① ② ③ 대응은 실측값 수신 후 판단")
    if kosdaq_lv.get("s1") is not None and q["price"] is not None:
        view.append(f"코스닥 지금 위치: {q['price']:,.2f} · 1차 지지 {kosdaq_lv['s1']:,.2f}")
    view.append("체크포인트: 1차 지지 사수 여부 · 외인 선물 방향 · 상한가 확대 여부")

    return "\n".join([
        headline,
        "📌 한줄 요약",
        summary,
        "📊 핵심 지표 & 매크로",
        *[f"- {x}" for x in macro],
        "💰 투자자별 수급 & 흐름 해석",
        *[f"- {x}" for x in flow],
        "🔥 장중 주도 테마 & 대장주 (300억↑ 실측)",
        *[f"- {x}" for x in themes],
        "🧭 대응 시나리오",
        *[f"- {x}" for x in view],
        CHECKER_URL,
    ])


# --------------------------------------------------------------------------- #
# 발송
# --------------------------------------------------------------------------- #
def send_telegram(token, chat_id, text, timeout=20, retries=3):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": True,
    }).encode("utf-8")
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
            if not data.get("ok"):
                raise RuntimeError(f"Telegram 응답 오류: {str(data)[:200]}")
            return data["result"]["message_id"]
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"텔레그램 발송 실패: {last}")


# --------------------------------------------------------------------------- #
# 관제탑 타임라인 연동 (1번·7번 탭 FLOW_TIMELINE)
#
#   1·7번 탭의 시간별 브리핑 타임라인은 두 곳에서 읽힌다.
#     · 동적(Vercel)  public/data/flow_timeline_today.json  — 15초마다 fetch 해 슬롯을 갈아끼움
#     · 정적(Pages)   index.html 의 <!-- FLOW_TIMELINE_START --> 안 window.FLOW_TIMELINE
#     · 정적 미러      deploy_repo/data/flow_timeline_today.json (작업트리에 있을 때만)
#   발송 성공한 회차를 JSON 슬롯으로 넣고(필요하면 html 내장 블록도 같이 갱신) commit·push 하면
#   두 화면이 같은 값을 본다. 슬롯에는 🤖 Gemini AI 작성 표기를 남긴다(텔레그램 헤더와 별개 — 내부 데이터).
# --------------------------------------------------------------------------- #
GEMINI_MARK = "🤖 Gemini AI 자동 작성"
GEMINI_TAG = "Gemini"
FLOW_SLOT_TIMES = ["08:50", "09:30", "10:00", "11:00", "12:00",
                   "13:00", "14:00", "15:00", "16:00"]
# Gemini 장중 브리핑이 도는 정규 회차(09:30 장초반 + 10·11·13·14시, 보통 1~8분 늦게 발송)
#   · 09:30 회차는 관제탑 타임라인의 '09:30'(장초반) 슬롯에 그대로 들어간다.
INTRADAY_SLOTS = ["09:30", "10:00", "11:00", "13:00", "14:00"]


def _hm_minutes(t):
    a = str(t).split(":")
    try:
        return int(a[0]) * 60 + int(a[1])
    except (IndexError, ValueError):
        return 0


def target_slot(t):
    """발송 시각(11:08) → 타임라인 회차(11:00). 50분 넘게 떨어졌으면 그 시각 정시 슬롯."""
    s = str(t or "").strip()
    if s in FLOW_SLOT_TIMES:
        return s
    m = re.match(r"^(\d{1,2}):(\d{2})", s)
    if m:
        mins = int(m.group(1)) * 60 + int(m.group(2))
    else:
        n = kst_now()
        mins = n.hour * 60 + n.minute
    best = min(INTRADAY_SLOTS, key=lambda x: abs(_hm_minutes(x) - mins))
    if abs(_hm_minutes(best) - mins) <= 50:
        return best
    hh = f"{mins // 60:02d}:00"
    return hh if hh in FLOW_SLOT_TIMES else best
FLOW_START_MARK = "<!-- FLOW_TIMELINE_START -->"
FLOW_END_MARK = "<!-- FLOW_TIMELINE_END -->"


def dashboard_root(script_dir):
    """관제탑 저장소 루트 — Actions(체크아웃 루트)와 워크스페이스(sd_live/) 둘 다 지원."""
    cands = [os.environ.get("SD_LIVE_ROOT"), os.environ.get("GITHUB_WORKSPACE"),
             os.path.abspath(os.path.join(script_dir, "..")),
             os.path.abspath(script_dir)]
    for c in cands:
        if c and os.path.isdir(os.path.join(c, "public", "data")):
            return c
    return None


def flow_paths(root):
    """(json 경로, 미러 json 경로 또는 None, [html 경로들])"""
    jp = os.path.join(root, "public", "data", "flow_timeline_today.json")
    parent = os.path.dirname(os.path.abspath(root).rstrip(os.sep))
    mirror = os.path.join(parent, "deploy_repo", "data", "flow_timeline_today.json")
    if not os.path.isdir(os.path.dirname(mirror)):
        mirror = None
    htmls = [os.path.join(root, "public", "index.html")]
    mh = os.path.join(parent, "deploy_repo", "index.html")
    if os.path.exists(mh):
        htmls.append(mh)
    return jp, mirror, htmls


def _json_for_script(obj):
    """<script> 안 JSON — '<'·'>' 이스케이프로 </script> 조기 종료를 막는다."""
    js = json.dumps(obj, ensure_ascii=False)
    bs = chr(92)
    return (js.replace("<", bs + "u003c").replace(">", bs + "u003e")
              .replace(chr(0x2028), " ").replace(chr(0x2029), " "))


def blank_timeline(now):
    slots = []
    for t in FLOW_SLOT_TIMES:
        if t == "08:50":
            slots.append({"t": t, "tag": "프리마켓", "state": "wait", "waitLabel": "08:50 브리핑 대기"})
        else:
            slots.append({"t": t, "tag": "", "state": "wait",
                          "waitLabel": "자동동기화 대기" if t in ("09:30", "12:00") else "브리핑 대기"})
    return {"date": now.strftime("%Y-%m-%d"),
            "day": WEEKDAY_KO[now.weekday()],
            "updated": now.strftime("%H:%M"), "slots": slots}


def load_timeline(path, now):
    """오늘 타임라인을 읽는다.

    날짜가 바뀐 파일이면 오늘 빈 슬롯으로 새로 시작하되, 직전 거래일의 **제미나이 장중
    브리핑 5회차**(09:30·10:00·11:00·13:00·14:00)만 `prev` 로 남긴다. 관제탑
    「시장&수급심층분석」 탭은 오늘 첫 회차(09:30) 전까지 이 `prev` 를 ‘직전 거래일 기록’
    으로 보여 주고, 오늘 회차가 들어오면 오늘 것으로 바꿔 그린다(전일 값을 오늘로 쓰지는 않는다).
    """
    data = None
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:  # noqa: BLE001
            data = None
    today = now.strftime("%Y-%m-%d")
    if not data or data.get("date") != today or not data.get("slots"):
        fresh = blank_timeline(now)
        if data and data.get("date") and data.get("date") != today:
            keep = [s for s in (data.get("slots") or [])
                    if isinstance(s, dict) and s.get("t") in INTRADAY_SLOTS
                    and s.get("state") == "done"]
            if keep:
                fresh["prev"] = {"date": data.get("date"), "day": data.get("day"),
                                 "updated": data.get("updated"), "slots": keep}
        return fresh
    return data


def prev_done_slot(slots, slot_t):
    """slot_t 보다 앞선 완료 슬롯(유지/신규 판정 기준)."""
    target = next((i for i, s in enumerate(slots) if s.get("t") == slot_t), None)
    if target is None:
        return None
    for i in range(target - 1, -1, -1):
        if slots[i].get("state") == "done":
            return slots[i]
    return None


def slot_done_today(script_dir, slot_t):
    """오늘 그 회차가 이미 기록됐는지 — 예약이 중복·지연 발송되는 것을 막는다.

    반환: (이미 완료, 슬롯 dict 또는 None). 관제탑 저장소를 못 찾으면 False.
    """
    root = dashboard_root(script_dir)
    if not root:
        return False, None
    now = kst_now()
    try:
        data = load_timeline(flow_paths(root)[0], now)
    except Exception:  # noqa: BLE001
        return False, None
    if data.get("date") != now.strftime("%Y-%m-%d"):
        return False, None
    for s in data.get("slots") or []:
        if isinstance(s, dict) and s.get("t") == slot_t and s.get("state") == "done":
            return True, s
    return False, None


def _money_eok_text(v):
    """300.55 → '300.6억' / 1186.1 → '1,186.1억' / 311.0 → '311억'"""
    if v is None:
        return ""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return ""
    if abs(f - round(f)) < 0.05:
        return f"{round(f):,}억"
    return f"{f:,.1f}억"


def name_code_map(root):
    """종목명 → 코드 (숫자가 아니라 이름·코드 대응만 읽는다). 없으면 빈 dict."""
    for cand in (os.path.join(root, "data", "stock_name_codes.json"),
                 os.path.join(os.path.dirname(os.path.abspath(root)), "data", "stock_name_codes.json")):
        if not os.path.exists(cand):
            continue
        try:
            with open(cand, encoding="utf-8") as fh:
                d = json.load(fh)
        except Exception:  # noqa: BLE001
            continue
        mp = d.get("map") if isinstance(d.get("map"), dict) else None
        if mp:
            return {str(k): str(v) for k, v in mp.items() if v}
    return {}


def build_timeline_slot(facts, slot_t, measured, body, generator, prev_slot=None, code_map=None):
    """발송한 장중 브리핑을 관제탑 타임라인 슬롯(같은 스키마)으로 옮긴다.

    · 숫자는 전부 facts(발송 직전 수집한 실측)에서만 가져온다 — 새로 계산하지 않는다.
    · 유지/신규는 직전 완료 슬롯의 대장 종목 코드·테마 이름과 비교한 결과다.
    """
    themes = facts.get("themes") or []
    flows = facts.get("flows") or {}
    prev_slot = prev_slot if isinstance(prev_slot, dict) else None
    prev_codes = {str(t.get("code")) for t in (prev_slot or {}).get("themes") or [] if t.get("code")}
    prev_keys = {_theme_key(t.get("name")) for t in (prev_slot or {}).get("themes") or [] if t.get("name")}

    rows, used = [], set()
    for th in themes[:3]:
        leaders = [l for l in (th.get("leaders") or []) if l.get("name")]
        if not leaders:
            continue
        lead = next((l for l in leaders if (l.get("code") or l.get("name")) not in used), leaders[0])
        used.add(lead.get("code") or lead.get("name"))
        is_keep = bool(prev_slot) and (
            (lead.get("code") and str(lead.get("code")) in prev_codes)
            or _theme_key(th.get("name")) in prev_keys)
        note = []
        if th.get("avg_pct") is not None:
            note.append(f"테마 평균 {float(th['avg_pct']):+.2f}%")
        if th.get("total") is not None:
            note.append(f"구성 {int(th['total'])}종목 중 상승 {int(th.get('rise') or 0)}"
                        f" · 하락 {int(th.get('fall') or 0)}")
        news = th.get("news") or {}
        note.append("재료: " + (news.get("title") if news.get("title") else "뉴스 미수신"))
        extra = " · ".join(
            f"{c.get('name')} {float(c.get('pct') or 0):+.2f}% ({_money_eok_text(c.get('value_eok'))})"
            for c in (th.get("co_movers") or [])[:2])
        price = lead.get("price")
        code = lead.get("code") or (code_map or {}).get(lead.get("name") or "")
        rows.append({
            "name": th.get("name"),
            "status": ("keep" if is_keep else "new") if prev_slot else "live",
            "statusLabel": ("🟢 유지" if is_keep else "🔴 신규 유입") if prev_slot else "📊 실측",
            "leader": lead.get("name"),
            "code": str(code or ""),
            "chg": round(float(lead.get("pct") or 0), 2),
            "price": f"{int(float(price)):,}원" if isinstance(price, (int, float)) else "",
            "value": _money_eok_text(lead.get("value_eok")),
            "note": " · ".join(note),
            "extra": extra,
        })

    top = rows[0] if rows else None
    n_new = sum(1 for r in rows if r["status"] == "new")
    n_keep = sum(1 for r in rows if r["status"] == "keep")
    sub_bits = ([f"🔴{n_new} 🟢{n_keep}"] if prev_slot else [f"📊{len(rows)} 실측"])

    # 한 줄 요약 — 본문의 📌 블록 첫 줄(없으면 헤드라인)
    lines = [ln.strip() for ln in (body or "").splitlines() if ln.strip()]
    ctx = ""
    for i, ln in enumerate(lines):
        if ln.startswith("📌"):
            ctx = lines[i + 1] if i + 1 < len(lines) else ""
            break
    if not ctx and len(lines) >= 2:
        ctx = lines[1]
    if not ctx and lines:
        ctx = lines[0]

    def num(v):
        return v if isinstance(v, (int, float)) else None

    k, q, fu = flows.get("kospi") or {}, flows.get("kosdaq") or {}, flows.get("fut") or {}
    sup = {
        "at": measured,
        "kospi": {"foreign": num(k.get("foreign")), "organ": num(k.get("organ")),
                  "personal": num(k.get("personal"))},
        "kosdaq": {"foreign": num(q.get("foreign")), "organ": num(q.get("organ")),
                   "personal": num(q.get("personal"))},
        "fut": {"foreign": num(fu.get("foreign")), "organ": num(fu.get("organ")),
                "personal": num(fu.get("personal"))},
        "diff": {},
    }
    basis = flows.get("basis_date")
    has_sup = any(v is not None for v in sup["kospi"].values()) or any(
        v is not None for v in sup["fut"].values())
    if has_sup:
        sup["note"] = ((f"네이버 현물·선물 수급 실측(기준 {md_date(basis)}) — {measured} 발송 시점 값. "
                        "현물 억원 · 선물 계약.") if basis else
                       f"네이버 현물·선물 수급 실측 — {measured} 발송 시점 값.")
        sup["source"] = "naver"
        sup["label"] = f"기준 {md_date(basis)}" if basis else ""
    else:
        sup["note"] = "발송 시점 수급 집계 전 — 0 이 아니라 미집계입니다"

    chip = "new" if n_new else ("keep" if n_keep else "live")
    return {
        "t": slot_t,
        "tag": GEMINI_TAG,
        "state": "done",
        "measured": measured,
        "status": chip,
        "statusLabel": "🤖 Gemini AI 작성",
        "title": f"{slot_t} 대응 시나리오",
        # 발송본 전문 — 관제탑 「시장&수급심층분석」 탭의 회차 카드에서 그대로 열린다.
        "body": (body or "").strip(),
        "bodyLen": len((body or "").strip()),
        "leadName": top["leader"] if top else "",
        "leadChg": f"{top['chg']:+.2f}%" if top else "",
        "leadSub": ((top["name"] + " · ") if top else "") + " ".join(sub_bits),
        "ctx": ctx,
        "src": (f"{GEMINI_MARK} · 텔레그램 발송본 {measured} · "
                f"{'Gemini 생성' if generator == 'gemini' else '실측 요약(대체)'}"),
        "writer": "gemini" if generator == "gemini" else "fallback",
        "supply": sup,
        "themes": rows,
        "basis": ("유지/신규 판정 = 직전 완료 슬롯(" + str(prev_slot.get("t")) +
                  ") 대장 종목 코드·테마 이름 일치 여부." if prev_slot else
                  "오늘 첫 완료 슬롯 — 직전 슬롯이 없어 유지/신규 판정 없이 실측값만 기록했습니다."),
        "sent": (facts.get("asof") or {}).get("iso", ""),
    }


# --------------------------------------------------------------------------- #
# 🕘 시간별 지수 흐름 백업 (INDEX_HOURLY_FLOW) — 타임라인 JSON 에 함께 저장 (2026-11-26)
#
#   동적 관제탑의 지수 흐름은 /api/stock-live 가 네이버 분봉으로 직접 계산한다.
#   여기서는 같은 값을 flow_timeline_today.json 의 `index_hourly_flow` 로 남겨
#   (1) API 가 분봉을 못 받는 순간의 백업, (2) 정적 본체·점검용 근거가 되게 한다.
#
#   · 지수 값  : 네이버 지수 분봉(1분) — 슬롯 'HH:00' = 그 시각 직후 1분봉(HH:01) 종가
#                (기존 정적 09:00 4,754.81 과 같은 규칙)
#   · 수급     : 타임라인 슬롯의 그 시각 실측 supply(브리핑 발송 시점). 없으면 비운다.
#   · 거래대금 : 슬롯 시점 누적 대금의 공개 이력이 없다 — 이미 저장된 실측만 승계.
#   · 실패하면 기존 값을 건드리지 않는다(0 이나 추정으로 채우지 않음).
# --------------------------------------------------------------------------- #
INDEX_FLOW_SLOTS_LOCAL = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "15:30"]
NAVER_INDEX_MINUTE = "https://api.stock.naver.com/chart/domestic/index/{sym}/minute"


def _index_minute_series(sym, ymd):
    """오늘(KST) 지수 1분봉 → [(분, 가격, 'HH:MM')] 오름차순

    · 발송을 붙잡지 않도록 짧게 끊는다(timeout 8초, 재시도 없음) — 백업이지 본선이 아니다.
    """
    d = http_json(NAVER_INDEX_MINUTE.format(sym=sym), timeout=8, retries=0,
                  headers={"Referer": "https://m.stock.naver.com/"})
    rows = []
    for b in d or []:
        dt = str(b.get("localDateTime") or "")
        if len(dt) < 12 or dt[:8] != ymd:
            continue
        try:
            price = float(b.get("currentPrice"))
        except (TypeError, ValueError):
            continue
        rows.append((int(dt[8:10]) * 60 + int(dt[10:12]), price, dt[8:10] + ":" + dt[10:12]))
    rows.sort(key=lambda r: r[0])
    return rows


def _index_prev_close(market):
    """지수 전일 종가 — 통합(information) 응답의 lastClosePrice."""
    d = http_json(NAVER_MOBILE + market + "/integration", timeout=8, retries=0,
                  headers={"Referer": "https://m.stock.naver.com/"})
    info = {x.get("code"): x.get("value") for x in (d.get("totalInfos") or [])}
    return fnum(info.get("lastClosePrice"))


def _bar_at(series, minute):
    """정확히 그 분의 봉 (없으면 None)"""
    for r in series:
        if r[0] == minute:
            return r
        if r[0] > minute:
            return None
    return None


def _bar_after(series, minute):
    """그 분 이후 첫 봉 (없으면 None)"""
    for r in series:
        if r[0] > minute:
            return r
    return None


def merge_index_hourly_flow(data, timeline_slots, now):
    """data['index_hourly_flow'] 를 오늘 실측으로 다시 만든다. 실패하면 아무것도 바꾸지 않는다."""
    today = now.strftime("%Y-%m-%d")
    ymd = now.strftime("%Y%m%d")
    ks, qs = [], []
    prev_close = {"KOSPI": None, "KOSDAQ": None}
    try:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as ex:
            fut = {
                "ks": ex.submit(_index_minute_series, "KOSPI", ymd),
                "qs": ex.submit(_index_minute_series, "KOSDAQ", ymd),
                "pk": ex.submit(_index_prev_close, "KOSPI"),
                "pq": ex.submit(_index_prev_close, "KOSDAQ"),
            }
            for key in ("ks", "qs"):
                try:
                    val = fut[key].result(timeout=20)
                    if key == "ks":
                        ks = val
                    else:
                        qs = val
                except Exception as e:  # noqa: BLE001
                    log(f"⚠️ index_hourly_flow {key} 분봉 실패 — {e}")
            for key, mk in (("pk", "KOSPI"), ("pq", "KOSDAQ")):
                try:
                    prev_close[mk] = fut[key].result(timeout=20)
                except Exception:  # noqa: BLE001
                    prev_close[mk] = None
    except Exception as e:  # noqa: BLE001
        log(f"⚠️ index_hourly_flow 분봉 실패 — 기존 값 유지: {e}")
        return
    if not ks and not qs:
        return

    old_flow = data.get("index_hourly_flow") if isinstance(data.get("index_hourly_flow"), dict) else {}
    old_slots = {}
    if old_flow.get("date") == today:
        for s in old_flow.get("slots") or []:
            if isinstance(s, dict) and s.get("t"):
                old_slots[s["t"]] = s
    done_slots = {s.get("t"): s for s in (timeline_slots or [])
                  if isinstance(s, dict) and s.get("state") == "done"}

    carry_pairs = (("f", "kospi", "foreign"), ("o", "kospi", "organ"),
                   ("qf", "kosdaq", "foreign"), ("qo", "kosdaq", "organ"),
                   ("ff", "fut", "foreign"), ("fo", "fut", "organ"))
    now_min = now.hour * 60 + now.minute
    rows = []
    last_k = last_q = None
    for t in INDEX_FLOW_SLOTS_LOCAL:
        hh, mm = [int(x) for x in t.split(":")]
        tmin = hh * 60 + mm
        row = {"t": t, "m": None, "k": None, "q": None, "kp": None, "qp": None,
               "dk": None, "dq": None, "kv": None, "qv": None,
               "f": None, "o": None, "qf": None, "qo": None, "ff": None, "fo": None, "n": ""}
        old = old_slots.get(t) or {}
        for k in ("kv", "qv", "f", "o", "qf", "qo", "ff", "fo"):
            if isinstance(old.get(k), (int, float)):
                row[k] = old[k]
        tl = done_slots.get(t)
        if tl and isinstance(tl.get("supply"), dict):
            sp = tl["supply"]
            for key, mk, fld in carry_pairs:
                v = (sp.get(mk) or {}).get(fld)
                if isinstance(v, (int, float)):
                    row[key] = v
            if tl.get("measured") and str(tl.get("measured")) != t:
                row["n"] = "수급 " + str(tl.get("measured"))
        if tmin <= now_min:
            # 슬롯 HH:00 = 그 시간대 봉의 종가. 아직 만들어지는 중이면 비운다(추정 금지).
            last_slot = t == INDEX_FLOW_SLOTS_LOCAL[-1]
            k_done = (now_min > tmin) if last_slot else bool(_bar_after(ks, tmin))
            q_done = (now_min > tmin) if last_slot else bool(_bar_after(qs, tmin))
            kb = (_bar_at(ks, tmin) or _bar_after(ks, tmin)) if (ks and k_done) else None
            qb = (_bar_at(qs, tmin) or _bar_after(qs, tmin)) if (qs and q_done) else None
            if kb:
                row["k"] = round(kb[1], 2)
                row["m"] = kb[2]
                pc = prev_close.get("KOSPI")
                if pc:
                    row["kp"] = round((kb[1] - pc) / pc * 100, 2)
                if last_k is not None:
                    row["dk"] = round(kb[1] - last_k, 2)
                last_k = kb[1]
            if qb:
                row["q"] = round(qb[1], 2)
                pc = prev_close.get("KOSDAQ")
                if pc:
                    row["qp"] = round((qb[1] - pc) / pc * 100, 2)
                if last_q is not None:
                    row["dq"] = round(qb[1] - last_q, 2)
                last_q = qb[1]
        rows.append(row)

    data["index_hourly_flow"] = {"date": today, "updated": now.strftime("%H:%M"),
                                 "source": "naver-minute", "slots": rows}
    filled = sum(1 for r in rows if isinstance(r.get("k"), (int, float)))
    log(f"🕘 index_hourly_flow 백업 — {filled}슬롯 실측 기록")


def write_timeline(root, slot_t, slot, now, patch_html=True):
    """JSON(동적) + 미러 JSON(정적) + 내장 FLOW_TIMELINE 블록 갱신. 바뀐 파일 목록을 돌려준다."""
    jp, mirror, htmls = flow_paths(root)
    data = load_timeline(jp, now)
    slots = data["slots"]
    idx = next((i for i, s in enumerate(slots) if s.get("t") == slot_t), None)
    if idx is None:
        slots.append(slot)
        slots.sort(key=lambda s: (int(str(s.get("t", "00:00")).split(":")[0]) * 60
                                  + int(str(s.get("t", "00:00")).split(":")[1])))
    else:
        slots[idx] = slot
    data["updated"] = now.strftime("%H:%M")
    data.setdefault("day", WEEKDAY_KO[now.weekday()])
    merge_index_hourly_flow(data, slots, now)

    changed = []
    os.makedirs(os.path.dirname(jp), exist_ok=True)
    with open(jp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    changed.append(jp)
    if mirror:
        with open(mirror, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        changed.append(mirror)

    if patch_html:
        js = _json_for_script(data)
        block = (FLOW_START_MARK + "\n    <script>window.FLOW_TIMELINE = " + js +
                 ";</script>\n    " + FLOW_END_MARK)
        for hp in htmls:
            if not os.path.exists(hp):
                continue
            with open(hp, encoding="utf-8") as fh:
                src = fh.read()
            i = src.find(FLOW_START_MARK)
            j = src.find(FLOW_END_MARK, i + 1) if i != -1 else -1
            if i == -1 or j == -1:
                log(f"⚠️ {os.path.basename(hp)} — FLOW_TIMELINE 마커 없음(내장 블록 생략)")
                continue
            new = src[:i] + block + src[j + len(FLOW_END_MARK):]
            if new != src:
                with open(hp, "w", encoding="utf-8") as fh:
                    fh.write(new)
                changed.append(hp)
    return changed, data


def repo_root_of(path):
    """파일이 속한 git 저장소 루트(없으면 None)."""
    p = os.path.abspath(path)
    while True:
        if os.path.isdir(os.path.join(p, ".git")):
            return p
        parent = os.path.dirname(p)
        if parent == p:
            return None
        p = parent


def git_commit_push(repo, files, message, push=False):
    """그 저장소에 속한 파일만 커밋(원하면 push). 실패해도 발송은 성공이므로 예외를 던지지 않는다."""
    import subprocess

    def run(args, **kw):
        return subprocess.run(args, cwd=repo, capture_output=True, text=True, **kw)

    base = os.path.abspath(repo)
    rel = [os.path.relpath(f, base) for f in files
           if os.path.abspath(f).startswith(base + os.sep)]
    if not rel:
        return False, "이 저장소 파일 없음"
    if not os.path.isdir(os.path.join(base, ".git")):
        return False, "git 저장소가 아님(파일만 갱신)"
    try:
        add = run(["git", "add", "--"] + rel)
        if add.returncode != 0:
            return False, f"add 실패: {(add.stderr or '')[:160]}"
        staged = run(["git", "diff", "--cached", "--quiet", "--"] + rel)
        if staged.returncode == 0:
            return True, "변경 없음(이미 반영된 슬롯)"
        com = run(["git", "-c", "user.name=github-actions[bot]",
                   "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                   "commit", "-m", message, "--"] + rel)
        if com.returncode != 0:
            return False, f"커밋 실패: {(com.stderr or com.stdout or '')[:160]}"
    except Exception as e:  # noqa: BLE001
        return False, f"커밋 예외: {e}"
    if not push:
        return True, "커밋만(푸시 생략)"
    p = run(["git", "push", "origin", "HEAD"])
    if p.returncode != 0:
        # 원격이 앞서 있으면(30분 동기화와 겹침) rebase 후 한 번 더
        run(["git", "fetch", "origin", "--depth=1"])
        rb = run(["git", "rebase", "--autostash", "origin/HEAD"])
        if rb.returncode != 0:
            run(["git", "rebase", "--abort"])
            return False, f"푸시 실패(원격 충돌): {(p.stderr or '')[:160]}"
        p = run(["git", "push", "origin", "HEAD"])
    if p.returncode != 0:
        return False, f"푸시 실패: {(p.stderr or p.stdout or '')[:200]}"
    return True, "커밋·푸시 완료"


def apply_timeline(facts, slot_t, measured, body, generator, script_dir,
                   write=False, push=False, patch_html=True):
    """발송본을 관제탑 타임라인 슬롯으로 반영한다. write=False 면 슬롯 JSON만 출력(검사용)."""
    root = dashboard_root(script_dir)
    if not root:
        log("⚠️ 관제탑 저장소를 찾지 못해 타임라인 반영을 건너뜁니다(public/data 없음)")
        return None
    jp = flow_paths(root)[0]
    now = kst_now()
    data = load_timeline(jp, now)
    prev = prev_done_slot(data["slots"], slot_t)
    slot = build_timeline_slot(facts, slot_t, measured, body, generator, prev,
                               code_map=name_code_map(root))
    log(f"🗂 타임라인 슬롯 {slot_t} — {slot['leadName']} {slot['leadChg']} · 테마 {len(slot['themes'])}개"
        f" · 출처 '{GEMINI_MARK}'")
    if not write:
        print(json.dumps(slot, ensure_ascii=False, indent=1))
        log("TIMELINE DRY — 파일을 쓰지 않았습니다(--timeline-write 로 반영)")
        return slot

    changed, _data = write_timeline(root, slot_t, slot, now, patch_html=patch_html)
    rel = [os.path.relpath(p, root) if os.path.abspath(p).startswith(os.path.abspath(root) + os.sep)
           else p for p in changed]
    log(f"🗂 타임라인 저장 {rel}")
    msg = (f"chore(타임라인): {now.strftime('%m/%d')} {slot_t} Gemini 장중 브리핑 반영"
           f" ({measured} 발송 · {len(slot['themes'])}테마)")
    # 같은 작업트리에 있는 저장소(sd_live · deploy_repo)별로 각각 커밋
    groups = {}
    for f in changed:
        rr = repo_root_of(f)
        groups.setdefault(rr, []).append(f)
    for rr, files in groups.items():
        if not rr:
            continue
        ok, note = git_commit_push(rr, files, msg, push=push)
        log(("✓ " if ok else "⚠️ ") + f"타임라인 git({os.path.basename(rr)}): {note}")
        if not ok and push:
            log("   → 워크플로 permissions(contents: write) 또는 원격 상태를 확인해야 합니다")
    return slot


# --------------------------------------------------------------------------- #
# 실행
# --------------------------------------------------------------------------- #
def market_guard(facts, force=False):
    """휴장·장외에 잘못 보내지 않는다. (skip, reason)"""
    now = kst_now()
    if force:
        return False, "force"
    if now.weekday() >= 5:
        return True, "주말"
    minutes = now.hour * 60 + now.minute
    if minutes < 8 * 60 + 50 or minutes > 15 * 60 + 40:
        return True, f"장외 시간({now.strftime('%H:%M')})"
    biz = (facts.get("flows") or {}).get("basis_date")
    today = now.strftime("%Y%m%d")
    ms = facts.get("market_status")
    if biz and biz != today and ms == "CLOSE":
        return True, f"휴장 추정(수급 기준일 {biz})"
    return False, "장중"


def main(argv=None):
    ap = argparse.ArgumentParser(description="폭스시그널 장중 브리핑 (Gemini → 텔레그램)")
    ap.add_argument("--dry-run", action="store_true", help="발송하지 않고 본문만 출력")
    ap.add_argument("--print-facts", action="store_true", help="수집한 FACTS만 출력")
    ap.add_argument("--slot", default=None, help="헤더 시각 표기 (기본: 현재 KST HH:MM)")
    ap.add_argument("--force", action="store_true", help="휴장/장외 가드 무시(테스트용)")
    ap.add_argument("--model", default=None, help="Gemini 모델 고정 (기본: 폴백 체인)")
    ap.add_argument("--models", default=None, help="콤마로 구분한 폴백 체인")
    ap.add_argument("--out", default=None, help="결과 JSON 저장 경로 (본문·facts·검증)")
    ap.add_argument("--out-text", default=None, help="발송 본문 텍스트 저장 경로")
    ap.add_argument("--env-file", action="append", default=[], help="환경변수 파일(.env 형식)")
    ap.add_argument("--fixture", default=None, help="오프라인 테스트용 JSON 폴더")
    ap.add_argument("--no-ai", action="store_true", help="Gemini 호출 없이 대체 본문만 생성")
    ap.add_argument("--no-deep", action="store_true",
                    help="심화 분석(뉴스·공시·연속 수급·테마 연속성·오답 노트·미장) 생략")
    ap.add_argument("--deep-budget", type=float, default=25.0,
                    help="심화 분석(네트워크)에 쓸 최대 초 — 넘기면 남은 항목은 버린다")
    ap.add_argument("--timeout", type=int, default=GEMINI_TIMEOUT_DEFAULT,
                    help=f"Gemini 호출 1회 타임아웃(초, 기본 {GEMINI_TIMEOUT_DEFAULT}) — 큰 모델은 +5초")
    ap.add_argument("--max-tokens", type=int, default=4096, help="Gemini maxOutputTokens")
    ap.add_argument("--summary", default=None, help="결과 JSON 을 Actions 요약(markdown)으로 출력")
    ap.add_argument("--timeline-slot", default=None,
                    help="관제탑 타임라인 슬롯 시각 (기본: 발송 시각에서 가장 가까운 정규 회차)")
    ap.add_argument("--no-timeline", action="store_true", help="관제탑 타임라인 반영을 생략")
    ap.add_argument("--timeline-write", action="store_true",
                    help="dry-run 에서도 타임라인 파일을 쓴다(검사·수동 반영용)")
    ap.add_argument("--timeline-from", default=None,
                    help="저장된 결과 JSON(intraday.json)으로 타임라인 슬롯만 재생성")
    ap.add_argument("--no-html", action="store_true", help="정적 index.html 내장 블록은 건드리지 않는다")
    ap.add_argument("--push-timeline", action="store_true",
                    help="타임라인 커밋을 원격에 push (GitHub Actions 에서는 자동)")
    ap.add_argument("--skip-if-done", action="store_true",
                    help="오늘 그 회차가 이미 기록됐으면 발송·생성 없이 종료(기본 운영 실행은 이 가드가 자동 적용)")
    args = ap.parse_args(argv)

    if args.summary:
        print_summary(args.summary)
        return 0

    # ── 저장된 발송본으로 타임라인만 재생성(수동 백필) ──────────────────
    if args.timeline_from:
        with open(args.timeline_from, encoding="utf-8") as fh:
            saved = json.load(fh)
        if not saved.get("facts"):
            log(f"❌ {args.timeline_from} 에 facts 가 없습니다")
            return 2
        sdir = os.path.dirname(os.path.abspath(__file__))
        sent = saved.get("facts", {}).get("asof", {}).get("time") or ""
        slot_t = target_slot(args.timeline_slot or saved.get("slot") or sent)
        apply_timeline(saved["facts"], slot_t, sent or slot_t, saved.get("message") or "",
                       saved.get("generator") or "gemini", sdir,
                       write=bool(args.timeline_write), push=bool(args.push_timeline),
                       patch_html=not args.no_html)
        return 0

    for path in args.env_file:
        load_env_file(path)

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    tg_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = (os.environ.get("TELEGRAM_CHAT_ID") or os.environ.get("TELEGRAM_CHANNEL") or "").strip()

    script_dir = os.path.dirname(os.path.abspath(__file__))

    # ── 중복 발송 가드 (2026-11-27) ──────────────────────────────────────
    #   cron-job.org 가 정시에 부른 뒤 GitHub 자체 cron 이 몇 분 늦게 따라붙으면
    #   같은 회차가 두 번 발송됐다. 일반 운영 실행(--dry-run·--force 아님)이면
    #   오늘 그 회차가 이미 done 인지 먼저 보고, 있으면 아무것도 하지 않고 끝낸다.
    #   · --force : 수동 재실행 — 그대로 통과(재발송 의도)
    #   · --dry-run : 발송하지 않는 검사 — 생성·검증을 해 볼 수 있게 통과
    #   · --timeline-from : 저장된 발송본으로 타임라인만 재생성 — 가드 대상 아님
    if not args.timeline_from and not args.dry_run and not args.force:
        pre_slot = target_slot(args.timeline_slot or args.slot or kst_now().strftime("%H:%M"))
        done_already, done_slot = slot_done_today(script_dir, pre_slot)
        if done_already:
            measured = (done_slot or {}).get("measured") or "-"
            log(f"[SKIP] today {pre_slot} already done")
            log(f"⏭ 오늘 {pre_slot} 회차는 이미 기록·발송됐습니다(발송 {measured}) — 중복 발송 생략")
            if args.out:
                write_out(args.out, {"skipped": True, "reason": f"duplicate {pre_slot}",
                                    "slot": pre_slot, "timeline_slot": done_slot})
            if args.out_text:
                os.makedirs(os.path.dirname(os.path.abspath(args.out_text)), exist_ok=True)
                with open(args.out_text, "w", encoding="utf-8") as fh:
                    fh.write(f"[SKIP] today {pre_slot} already done (발송 {measured})\n")
            return 0

    # 예전 --skip-if-done 플래그도 그대로 받는다(dry-run 검사·수동 백업 호출호환)
    if args.skip_if_done and not args.timeline_from and (args.dry_run or args.force):
        pre_slot = target_slot(args.timeline_slot or args.slot or kst_now().strftime("%H:%M"))
        done_already, done_slot = slot_done_today(script_dir, pre_slot)
        if done_already:
            log(f"⏭ {pre_slot} 회차는 오늘 이미 기록됐습니다(발송 {(done_slot or {}).get('measured') or '-'}) — 중복 발송 생략")
            if args.out:
                write_out(args.out, {"skipped": True, "reason": f"duplicate {pre_slot}",
                                     "slot": pre_slot, "timeline_slot": done_slot})
            return 0

    facts = collect(script_dir, use_fixture=args.fixture,
                    deep=not args.no_deep, deep_budget=args.deep_budget)
    ftext = facts_text(facts)

    if args.print_facts:
        print(ftext)
        return 0

    skip, reason = market_guard(facts, force=args.force)
    if skip:
        log(f"⏭ 발송 생략 — {reason}")
        if args.out:
            write_out(args.out, {"skipped": True, "reason": reason, "facts": facts})
        return 0

    slot = args.slot or facts["asof"]["time"]
    header = build_header(slot)

    gens = []
    body = None
    validation = None
    soft_best = None   # 분량만 모자란 초안 — 형식·숫자를 통과한 것 중 가장 긴 것
    if not args.no_ai and api_key:
        models = [args.model] if args.model else (
            [m.strip() for m in args.models.split(",") if m.strip()] if args.models else DEFAULT_MODELS
        )
        base_text = f"FACTS:\n{ftext}\n\n위 FACTS만으로 5블록 장중 브리핑 본문을 작성하라."
        started = time.time()

        def model_timeout(name):
            """1회 호출 타임아웃 — lite 30초, 큰 모델 35초(기본값 기준)."""
            return args.timeout + (0 if "flash-lite" in name else 5)

        def try_models(model_list, pass_no):
            nonlocal body, validation, soft_best
            for model in model_list:
                prompt = base_text
                for attempt in (1, 2):
                    if time.time() - started > GEMINI_WALL_BUDGET:
                        log(f"… Gemini 전체 시간 {GEMINI_WALL_BUDGET}초 초과 — 남은 모델 건너뜀")
                        return
                    try:
                        t0 = time.time()
                        text, usage = call_gemini(
                            api_key, model, SYSTEM_PROMPT, prompt,
                            timeout=model_timeout(model),
                            max_tokens=args.max_tokens,
                            thinking_budget=0,
                        )
                        cand = clean_body(text)
                        ok, problems = validate_body(cand, ftext, phase=(facts.get("tabs") or {}).get("session_phase"),
                                                     min_chars=body_min_chars(facts))
                        gens.append({"model": model, "pass": pass_no, "attempt": attempt, "ok": ok,
                                     "problems": problems, "chars": len(cand),
                                     "sec": round(time.time() - t0, 1), "usage": usage})
                        if ok:
                            body = cand
                            validation = {"ok": True, "problems": [], "chars": len(cand)}
                            log(f"✓ Gemini({model}) 생성·검증 통과 ({len(cand)}자, {time.time()-t0:.1f}s)")
                            return
                        hard = [p for p in problems
                                if not p.startswith(("분량 부족", "줄 수 부족"))]
                        if not hard and len(cand) >= 1500:
                            if soft_best is None or len(cand) > soft_best[0]:
                                soft_best = (len(cand), cand, problems, model)
                                log(f"… Gemini({model}) 형식·숫자는 통과, 분량 {len(cand)}자 — 후보로 보류")
                        log(f"… Gemini({model}) 검증 실패({len(cand)}자): {problems}")
                        if attempt == 1:
                            bad = [p.split(": ")[-1] for p in problems if p.startswith("근거 없는 숫자")]
                            extra = f"\n\n[재작성 지시] 아래 숫자는 FACTS에 없다. 쓰지 마라: {', '.join(bad)}" if bad else ""
                            if any(p.startswith("분량 부족") for p in problems):
                                extra += ("\n[재작성 지시] 분량이 모자란다. 각 블록을 3~6줄로 늘리고,"
                                          " FACTS에 있는 수치·종목·테마·기준선을 빠짐없이 인용해 2,000~3,200자로 써라.")
                            extra += f"\n[이전 초안의 문제] {' / '.join(problems)}"
                            prompt = (base_text + extra +
                                      "\nFACTS의 숫자만 그대로 옮기고, 지시한 5블록 형식·국면·2,000~3,200자를 지켜 다시 써라.")
                    except urllib.error.HTTPError as e:
                        detail = ""
                        try:
                            detail = e.read().decode("utf-8", "replace")[:120]
                        except Exception:  # noqa: BLE001
                            pass
                        gens.append({"model": model, "pass": pass_no, "attempt": attempt,
                                     "ok": False, "error": f"HTTP {e.code} {detail[:60]}"})
                        log(f"… Gemini({model}) HTTP {e.code} — 다음 모델")
                        break  # 같은 모델 재시도 없이 다음 모델로
                    except Exception as e:  # noqa: BLE001
                        gens.append({"model": model, "pass": pass_no, "attempt": attempt,
                                     "ok": False, "error": str(e)[:160]})
                        log(f"… Gemini({model}) 실패: {str(e)[:100]}")
                        break

        try_models(models, 1)
        if not body and any(g.get("error", "").startswith(("HTTP 429", "HTTP 503", "HTTP 500")) for g in gens):
            log("… 전 모델 실패 — 5초 뒤 한 번 더 시도")
            time.sleep(5)
            retry = [m for m in models if m in {g["model"] for g in gens
                                                if g.get("error", "").startswith(("HTTP 429", "HTTP 503", "HTTP 500"))}]
            try_models(retry, 2)

        # 분량만 모자란 초안이 있으면 대체(fallback)보다 그 초안을 살린다
        if not body and soft_best:
            body = soft_best[1]
            validation = {
                "ok": True,
                "problems": ["분량 미달이나 형식·숫자 검증 통과 → 최선 초안 채택"] + soft_best[2],
                "chars": soft_best[0],
                "model": soft_best[3],
            }
            log(f"↺ 분량 미달 최선 초안 채택 ({soft_best[0]}자, {soft_best[3]})")

    generator = "gemini"
    if not body:
        body = fallback_body(facts)
        generator = "fallback"
        validation = {"ok": True, "problems": ["Gemini 미사용 — 실측 대체 본문"], "chars": len(body)}
        log("⚠️ Gemini 본문 없음 → 실측 대체 본문으로 발송")

    # Gemini 실패 시에만 '실측 요약'임을 밝힌다(공개 헤더에는 AI 표기를 넣지 않는다)
    header_line = header if generator == "gemini" else f"{header} (실측 요약)"
    message = f"{header_line}\n{body}".strip()
    if generator == "gemini" and CHECKER_URL not in message:
        message += "\n" + CHECKER_URL
    message = fit_telegram(message)

    print("\n" + "=" * 60)
    print(message)
    print("=" * 60)
    log(f"본문 {len(message)}자 (헤더 포함, 텔레그램 한도 {TG_LIMIT}자)")

    message_id = None
    if args.dry_run:
        log("DRY-RUN — 텔레그램 발송하지 않음")
    else:
        if not tg_token or not chat_id:
            log("❌ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 없음 — 발송 불가")
            if args.out:
                write_out(args.out, {"ok": False, "reason": "missing telegram env", "message": message})
            return 2
        message_id = send_telegram(tg_token, chat_id, message)
        log(f"✓ 텔레그램 발송 완료 message_id={message_id}")

    # ── 관제탑 1·7번 타임라인에 이번 회차를 남긴다(발송 성공본) ──────────
    #   · GitHub Actions 에서는 JSON 만 바꾼다 — index.html 내장 블록까지 건드리면
    #     30분 자동동기화와 같은 파일을 동시에 고쳐 push 충돌이 난다.
    #     (동적 관제탑은 JSON 을 15초마다 읽고, 정적 Pages 는 다음 동기화 때 따라온다)
    if not args.no_timeline and (message_id or args.timeline_write):
        slot_t = target_slot(args.timeline_slot or slot)
        in_ci = os.environ.get("GITHUB_ACTIONS") == "true"
        apply_timeline(facts, slot_t, facts["asof"]["time"], message, generator, script_dir,
                       write=True,
                       push=bool(args.push_timeline) or in_ci,
                       patch_html=(not args.no_html) and not in_ci)

    if args.out_text:
        os.makedirs(os.path.dirname(os.path.abspath(args.out_text)), exist_ok=True)
        with open(args.out_text, "w", encoding="utf-8") as fh:
            fh.write(message + "\n")
    if args.out:
        write_out(args.out, {
            "ok": True, "generator": generator, "model": gens[-1]["model"] if gens else None,
            "validation": validation, "generations": gens, "message": message,
            "message_chars": len(message),
            "message_id": message_id, "slot": slot, "facts": facts, "facts_text": ftext,
        })
    return 0


def print_summary(path):
    """Actions $GITHUB_STEP_SUMMARY 용 markdown."""
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception as e:  # noqa: BLE001
        print(f"- 결과 JSON 읽기 실패: {e}")
        return
    if d.get("skipped"):
        print(f"- 생략 사유: {d.get('reason')}")
        return
    print(f"- 생성기: **{d.get('generator')}** · 모델: `{d.get('model')}`")
    print(f"- 본문 길이: **{d.get('message_chars') or len(d.get('message') or '')}자** (텔레그램 한도 4,096자)")
    print(f"- 텔레그램 message_id: `{d.get('message_id')}`")
    print(f"- 검증: `{d.get('validation')}`")
    for g in d.get("generations") or []:
        status = "OK" if g.get("ok") else "FAIL"
        chars = f"{g.get('chars')}자 " if g.get("chars") else ""
        sec = f"{g.get('sec')}s" if g.get("sec") else ""
        head = f"{g.get('model')} " + (f"p{g.get('pass')} " if g.get("pass") else "") + f"try{g.get('attempt')} {status} {chars}{sec}"
        parts = [head]
        if g.get("error"):
            parts.append(str(g["error"])[:80])
        if g.get("problems"):
            parts.append(" ".join(g["problems"])[:140])
        print(f"  · {' — '.join(parts)}")


def write_out(path, obj):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)


def load_env_file(path):
    """KEY=VALUE 형식(.env) 읽기. 이미 있는 환경변수는 덮어쓰지 않는다."""
    if not path or not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


if __name__ == "__main__":
    sys.exit(main())
