#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🧠 분석 고도화 공용 헬퍼 — 뉴스 · 공시 · 연속 수급 · 테마 연속성 · 오답 노트 · 미장 연결
========================================================================================
`intraday_gemini_telegram.py`(장중 브리핑)가 FACTS 를 만들 때 부르는 보조 모듈이다.
모두 무료·공개 엔드포인트만 쓰고, 키는 있어도 없어도 동작한다(없으면 다른 무료 경로).

1) 종목 최신 뉴스      네이버 증권 모바일  /api/news/stock/{code}
   · 제목에 종목명이 들어간 기사만 '재료'로 인정한다(시장 전체 기사가 섞여 오기 때문).
2) 당일 공시           DART 공시통합검색(dart.fss.or.kr, 키 불필요) → 없으면 그대로 '미확인'
   · DART_API_KEY 가 환경에 있으면 OpenDART list.json(회사 고유번호)으로 한 번 더 확인한다.
   · 공시명 키워드로 '주요 공시'와 '일반 공시'만 나눈다(내용 추정 없음).
3) 3~5거래일 연속 수급  네이버 증권 모바일  /api/stock/{code}/trend (10영업일 확정치)
   · 외인·기관 순매수(주수×종가) 연속 일수와 누적 금액. 최신일이 '확정 기준일'이다.
4) 테마 연속성·자금 잔류
   · 직전 거래일 스냅샷(`last-dynamic-themes.json` / `data/archives/YYYY-MM-DD.json`)과
     오늘 테마(tabs-live)를 이름으로 맞춰 순위 변화·대장 유지·전일 주도 종목 생존을 센다.
   · 보관 일수가 모자라면 있는 일수만 쓰고 그 사실을 함께 적는다(추정 금지).
5) 시나리오 오답 노트   `public/data/scenario_retro_notes.json` 최근 3~5건
6) 미장 → 국내 연결    Yahoo chart(^DJI · ^GSPC · ^IXIC · ^SOX · NQ=F) + 고정 연결 규칙

원칙
  · 모든 함수는 실패해도 예외를 밖으로 던지지 않고 ok:False + errors 를 돌려준다
    (뉴스·공시가 느리거나 막혀도 브리핑 발송이 멈추면 안 된다).
  · 수집한 제목·공시명·숫자만 넘긴다. 원인·전망은 만들지 않는다.
  · 전체 소요 시간은 `build_deep_context(budget=…)` 안에서 잘라 낸다.

오답 노트 파일 형식 (`public/data/scenario_retro_notes.json`)
{
  "schema": 1,
  "updatedAt": "2026-11-27T07:00:00+09:00",
  "notes": [
    {
      "date": "2026-11-26",          # 교훈이 나온 거래일
      "slot": "마감",                 # 마감·장중·09:30 등(자유)
      "title": "짧은 제목",
      "wrong": "그때 틀렸던 판단",
      "right": "실측으로 확인된 것",
      "lesson": "다음부터 지킬 한 줄",
      "evidence": ["11/26 기관 +7,529억(11/25 +39억)", "..."],  # 실측 근거(숫자 포함 가능)
      "tags": ["수급", "추격금지"]
    }
  ]
}

CLI
  python3 scripts/analysis_context.py --selftest            # 각 소스 연결 점검
  python3 scripts/analysis_context.py --probe 261780 --name 아리바이오랩
"""

import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone

try:  # 미국 장 날짜 표기용(없으면 고정 오프셋)
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
except Exception:  # noqa: BLE001
    ET = timezone(timedelta(hours=-5))

KST = timezone(timedelta(hours=9))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

NAVER_NEWS = "https://m.stock.naver.com/api/news/stock/{code}"
NAVER_TREND = "https://m.stock.naver.com/api/stock/{code}/trend"
NAVER_THEME_ONE = "https://m.stock.naver.com/api/stocks/theme/"
DART_SEARCH = "https://dart.fss.or.kr/dsab007/detailSearch.ax"
DART_LIST = "https://opendart.fss.or.kr/api/list.json"
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}"

# 공시명에 이 말이 있으면 '주요 공시'로 본다(내용 해석이 아니라 이름 분류다)
DART_MAJOR_KEYS = [
    "유상증자", "무상증자", "전환사채", "신주인수권", "교환사채", "합병", "분할", "영업양수",
    "영업양도", "타법인주식", "최대주주", "자기주식", "공급계약", "수주", "단일판매",
    "투자판단", "풍문", "소송", "횡령", "배임", "감자", "상장폐지", "관리종목", "실적",
    "잠정", "배당", "주주총회", "의결권", "증권신고서", "주요사항보고서", "조회공시",
    "불성실공시", "매매거래정지", "투자경고", "투자주의", "단기과열", "사업보고서",
    "반기보고서", "분기보고서", "대량보유",
]
# 흔한 정기·절차성 공시 — 이것만 있으면 '특이 공시 없음'으로 적는다
#   (임원 소유상황 보고는 하루에 여러 건이 흔해 '주요'로 올리면 잡음이 된다)
DART_ROUTINE_KEYS = ["임원ㆍ주요주주특정증권등소유상황보고서", "기업설명회",
                     "증권발행실적보고서", "일괄신고추가서류"]

# 미장 → 국내 연결 규칙(가설). 오늘 실제로 그 섹터에 수급이 붙었는지는 테마 등락으로만 확인한다.
US_KR_RULES = [
    ("semis", "필라델피아 반도체", "반도체·반도체 장비·소재"),
    ("nasdaq", "나스닥", "성장주(2차전지·바이오·플랫폼)"),
    ("sp500", "S&P500", "코스피 대형 수출주·지수 전체 방향"),
    ("dow", "다우", "경기소비재·산업재·금융"),
]


# --------------------------------------------------------------------------- #
# 유틸
# --------------------------------------------------------------------------- #
def _num(v):
    if v is None:
        return None
    t = str(v).replace(",", "").replace("+", "").replace(" ", "").strip()
    if not t or t in ("-", "."):
        return None
    try:
        n = float(t)
        return n if math.isfinite(n) else None
    except ValueError:
        return None


def _get(url, timeout=4.0, headers=None, encoding="utf-8"):
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode(encoding if encoding != "auto" else "utf-8", "replace")


def _getj(url, timeout=4.0, headers=None):
    return json.loads(_get(url, timeout=timeout, headers=headers))


def _md(biz):
    """'20261125' → '11/25'"""
    s = str(biz or "")
    if len(s) == 8 and s.isdigit():
        return f"{int(s[4:6])}/{int(s[6:8])}"
    return s


def _norm_name(s):
    return re.sub(r"[\sㆍ·,.\-()\[\]]", "", str(s or "")).lower()


def _strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", str(s or ""))).strip()


def _theme_key(name):
    s = re.sub(r"\([^)]*\)", "", str(name or ""))
    return re.sub(r"[\s·,/]", "", s).lower()


def _theme_tokens(name):
    s = re.sub(r"\([^)]*\)", " ", str(name or ""))
    return [t for t in re.split(r"[\s·,/&]+", s) if len(t) >= 2 and t not in ("관련", "기타", "테마")]


# --------------------------------------------------------------------------- #
# 1) 종목 최신 뉴스
# --------------------------------------------------------------------------- #
def fetch_stock_news(code, name="", limit=2, timeout=3.5):
    """네이버 증권 종목 뉴스 → 제목에 종목명이 있는 기사 우선 최신 limit건.

    반환 {"ok":bool, "items":[{"title","press","time","mentions"}], "error":str|None}
    """
    if not code:
        return {"ok": False, "items": [], "error": "종목코드 없음"}
    url = f"{NAVER_NEWS.format(code=code)}?pageSize=12&page=1"
    try:
        data = _getj(url, timeout=timeout, headers={"Referer": "https://m.stock.naver.com/"})
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "items": [], "error": f"뉴스 {type(e).__name__}"}
    rows = []
    now = datetime.now(KST)
    for block in data or []:
        for it in (block.get("items") or []):
            title = _strip_tags(it.get("title"))
            if not title:
                continue
            raw = str(it.get("datetime") or "")
            when, age_h = "", None
            if len(raw) >= 12 and raw.isdigit():
                when = f"{int(raw[4:6])}/{int(raw[6:8])} {raw[8:10]}:{raw[10:12]}"
                try:
                    dt = datetime.strptime(f"{now.year}/{raw[4:6]}/{raw[6:8]} {raw[8:10]}:{raw[10:12]}",
                                           "%Y/%m/%d %H:%M").replace(tzinfo=KST)
                    age_h = round((now - dt).total_seconds() / 3600, 1)
                except Exception:  # noqa: BLE001
                    age_h = None
            mentions = bool(name) and _norm_name(name) in _norm_name(title)
            rows.append({"title": title, "press": it.get("officeName") or "",
                         "time": when, "mentions": mentions, "age_h": age_h, "sort": raw})
    if not rows:
        return {"ok": True, "items": [], "error": None}
    rows.sort(key=lambda r: r.get("sort") or "", reverse=True)
    # 제목에 종목명이 들어간 기사만 쓴다(시장 전체 기사가 섞여 오면 재료로 오해된다)
    picked = [r for r in rows if r["mentions"]][:limit]
    for r in picked:
        r.pop("sort", None)
    return {"ok": True, "items": picked, "error": None,
            "note": None if picked else "제목에 종목명이 든 기사 없음"}


# --------------------------------------------------------------------------- #
# 2) 당일 공시 (DART)
# --------------------------------------------------------------------------- #
_TR_RE = re.compile(r"<tr>(.*?)</tr>", re.S)
_CORP_RE = re.compile(r"openCorpInfoNew\('(\d{8})'[^>]*title=\"([^\"]+?)\s*기업개황", re.S)
_REPORT_RE = re.compile(r"/dsaf001/main\.do\?rcpNo=(\d+)\"[^>]*>(.*?)</a>", re.S)
_DATE_RE = re.compile(r"<td>\s*(\d{4}\.\d{2}\.\d{2})\s*</td>")


def _dart_search(name, timeout=4.0):
    """DART 공시통합검색 HTML → 그 회사 행만. (키 불필요)"""
    url = (DART_SEARCH + "?textCrpNm=" + urllib.parse.quote(str(name or ""))
           + "&option=corp&pageGrouping=1&currentPage=1&maxResults=30&sort=date&series=desc")
    html = _get(url, timeout=timeout, headers={"Referer": "https://dart.fss.or.kr/"})
    want = _norm_name(name)
    rows = []
    for tr in _TR_RE.findall(html):
        corp = _CORP_RE.search(tr)
        rep = _REPORT_RE.search(tr)
        if not rep:
            continue
        company = _strip_tags(corp.group(2)) if corp else ""
        if want and _norm_name(company) and _norm_name(company) != want:
            continue            # 다른 회사 행은 절대 붙이지 않는다
        date = _DATE_RE.search(tr)
        rows.append({
            "company": company,
            "corp_code": corp.group(1) if corp else None,
            "report": _strip_tags(rep.group(2)),
            "rcp_no": rep.group(1),
            "date": date.group(1).replace(".", "-") if date else None,
        })
    return rows


def _dart_opendart(corp_code, ymd, api_key, timeout=4.0):
    url = (DART_LIST + "?crtfc_key=" + urllib.parse.quote(api_key)
           + "&corp_code=" + urllib.parse.quote(str(corp_code))
           + f"&bgn_de={ymd}&end_de={ymd}&page_count=30&page_no=1")
    d = _getj(url, timeout=timeout)
    status = str(d.get("status") or "")
    if status == "013":          # 조회된 데이터 없음
        return []
    if status != "000":
        raise RuntimeError(f"opendart status {status}")
    out = []
    for it in d.get("list") or []:
        dt = str(it.get("rcept_dt") or "")
        out.append({
            "company": it.get("corp_name") or "",
            "report": _strip_tags(it.get("report_nm")),
            "rcp_no": it.get("rcept_no"),
            "date": f"{dt[:4]}-{dt[4:6]}-{dt[6:8]}" if len(dt) == 8 else None,
        })
    return out


def _classify_disclosures(rows):
    major, routine = [], []
    for r in rows:
        title = r.get("report") or ""
        if any(k in title for k in DART_MAJOR_KEYS):
            major.append(r)
        else:
            routine.append(r)
    return major, routine


def fetch_dart_today(name, today_iso=None, timeout=4.5):
    """그 회사의 '당일' 공시만. 주요/일반으로 이름만 분류한다.

    반환 {"ok","date","major":[{title,time,url}],"routine":[{title}],"count","source","error"}
    """
    today_iso = today_iso or datetime.now(KST).strftime("%Y-%m-%d")
    ymd = today_iso.replace("-", "")
    try:
        rows = _dart_search(name, timeout=timeout)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "date": today_iso, "major": [], "routine": [], "count": 0,
                "source": "dart-search", "error": f"공시검색 {type(e).__name__}"}

    source = "dart-search"
    key = (os.environ.get("DART_API_KEY") or "").strip()
    if key and rows:
        corp_code = next((r["corp_code"] for r in rows if r.get("corp_code")), None)
        if corp_code:
            try:
                api_rows = _dart_opendart(corp_code, ymd, key, timeout=timeout)
                if api_rows:
                    rows = [r for r in api_rows if (r.get("date") or today_iso) == today_iso]
                    source = "opendart"
            except Exception:  # noqa: BLE001 — 키가 막히면 검색 결과로 계속
                pass

    todays = [r for r in rows if r.get("date") == today_iso]
    major, routine = _classify_disclosures(todays)

    def brief(group, limit=3):
        """같은 공시명은 한 줄로 묶는다(임원 소유상황 보고가 하루 3~4건씩 온다)."""
        out, seen = [], {}
        for r in group:
            title = r.get("report") or ""
            if not title:
                continue
            if title in seen:
                seen[title] += 1
                continue
            seen[title] = 1
            out.append({"title": title, "when": _md(ymd), "count": 1,
                        "url": f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={r.get('rcp_no')}"
                               if r.get("rcp_no") else None})
        for o in out:
            o["count"] = seen.get(o["title"], 1)
        return out[:limit]

    return {
        "ok": True, "date": today_iso,
        "major": brief(major),
        "routine": brief(routine),
        "count": len(todays),
        "major_count": len(major),
        "routine_count": len(routine),
        "source": source,
        "error": None,
    }


# --------------------------------------------------------------------------- #
# 3) 3~5거래일 연속 수급
# --------------------------------------------------------------------------- #
def _streak(rows, key):
    """최신일부터 같은 방향(순매수>0 / 순매도<0)이 이어진 일수와 누적 금액(억)."""
    days, total, since = 0, 0.0, None
    direction = 0
    for r in rows:
        v = r.get(key)
        if v is None or v == 0:
            break
        s = 1 if v > 0 else -1
        if direction == 0:
            direction = s
        elif s != direction:
            break
        days += 1
        total += v
        since = r["date"]
    if direction == 0:
        return {"dir": "flat", "days": 0, "sum_eok": 0.0, "from": None, "to": None}
    return {
        "dir": "buy" if direction > 0 else "sell",
        "days": days,
        "sum_eok": round(total, 1),
        "from": since,          # streak 첫날(가장 오래된 날)
        "to": rows[0]["date"] if rows else None,
    }


def fetch_stock_supply(code, days=5, timeout=4.0):
    """네이버 종목별 투자자별 매매동향(확정) → 3~5거래일 연속 순매수/순매도.

    금액 = 순매수 주수 × 그날 종가 ÷ 1억 (관제탑 /api/stock-trend 와 같은 기준).
    """
    if not code:
        return {"ok": False, "error": "종목코드 없음"}
    url = f"{NAVER_TREND.format(code=code)}?pageSize=10&page=1"
    try:
        data = _getj(url, timeout=timeout, headers={"Referer": "https://m.stock.naver.com/"})
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"수급 {type(e).__name__}"}
    if not isinstance(data, list) or not data:
        return {"ok": False, "error": "수급 응답 비었음"}
    rows = []
    for r in data:
        biz = str(r.get("bizdate") or "")
        close = _num(r.get("closePrice"))
        if len(biz) != 8 or close is None:
            continue
        fq, oq = _num(r.get("foreignerPureBuyQuant")), _num(r.get("organPureBuyQuant"))
        rows.append({
            "date": _md(biz),
            "bizdate": biz,
            "close": close,
            "foreign_eok": round(fq * close / 1e8, 1) if fq is not None else None,
            "organ_eok": round(oq * close / 1e8, 1) if oq is not None else None,
        })
    rows.sort(key=lambda x: x["bizdate"], reverse=True)
    if not rows:
        return {"ok": False, "error": "수급 행 없음"}
    return {
        "ok": True,
        "basis": rows[0]["date"],
        "rows": rows[:max(3, min(days, 5))],
        "foreign": _streak(rows, "foreign_eok"),
        "organ": _streak(rows, "organ_eok"),
        "error": None,
    }


# --------------------------------------------------------------------------- #
# 4) 테마 연속성 · 자금 잔류
# --------------------------------------------------------------------------- #
def _data_dirs(script_dir):
    """저장소 루트 기준 public/data 후보(로컬 sd_live · CI 체크아웃 모두 대응)."""
    root = os.path.dirname(os.path.abspath(script_dir))
    cands = [os.path.join(root, "public", "data"), os.path.join(root, "data")]
    return root, [c for c in cands if os.path.isdir(c)]


def load_theme_history(script_dir, max_days=5):
    """보관된 일별 테마 스냅샷 — 최근 max_days일(오늘 이전)."""
    root, dirs = _data_dirs(script_dir)
    today = datetime.now(KST).strftime("%Y-%m-%d")
    out = []
    for d in dirs:
        adir = os.path.join(d, "archives")
        if not os.path.isdir(adir):
            continue
        for fn in sorted(os.listdir(adir), reverse=True):
            m = re.match(r"^(\d{4}-\d{2}-\d{2})\.json$", fn)
            if not m or fn.startswith("index"):
                continue
            date = m.group(1)
            if date >= today:
                continue
            try:
                with open(os.path.join(adir, fn), encoding="utf-8") as f:
                    a = json.load(f)
            except Exception:  # noqa: BLE001
                continue
            themes = [{"rank": t.get("rank"), "name": t.get("name"),
                       "avg_pct": _num(t.get("avgPct")), "leader": t.get("leader"),
                       "leader_pct": _num(t.get("leaderPct"))}
                      for t in (a.get("themes") or []) if t.get("name")]
            if themes:
                out.append({"date": date, "label": a.get("label") or date, "themes": themes})
            if len(out) >= max_days:
                break
        if len(out) >= max_days:
            break
    out.sort(key=lambda x: x["date"], reverse=True)
    return out


def prev_theme_snapshot(script_dir, max_days=5):
    """직전 거래일 테마 스냅샷 — 종목별 대금까지 있는 `last-dynamic-themes.json` 우선."""
    root, dirs = _data_dirs(script_dir)
    today = datetime.now(KST).strftime("%Y-%m-%d")
    for d in dirs:
        p = os.path.join(d, "last-dynamic-themes.json")
        if not os.path.exists(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                j = json.load(f)
        except Exception:  # noqa: BLE001
            continue
        asof = str(j.get("asOfDate") or "")
        iso = f"{asof[:4]}-{asof[4:6]}-{asof[6:8]}" if len(asof) == 8 else None
        if iso and iso >= today:
            continue          # 오늘 값이 이미 덮였다 → 아카이브로
        themes = []
        for t in j.get("themes") or []:
            stocks = []
            for s in (t.get("stocks") or []):
                stocks.append({"code": s.get("code"), "name": s.get("name"),
                               "pct": _num(s.get("changePct")),
                               "value_eok": round((_num(s.get("value")) or 0) / 1e8, 1)})
            stocks.sort(key=lambda x: -(x.get("value_eok") or 0))
            themes.append({
                "rank": t.get("rank"), "name": t.get("name"),
                "avg_pct": _num(t.get("avgPct")), "leader": t.get("leaderName"),
                "stocks": stocks[:4],
            })
        if themes:
            label = j.get("basisLong") or (j.get("shortLabel") or _md(asof))
            return {"date": iso, "label": label,
                    "themes": themes, "source": "last-dynamic-themes.json"}
    hist = load_theme_history(script_dir, max_days=1)
    if hist:
        h = hist[0]
        return {"date": h["date"], "label": h["label"], "themes": [
            {"rank": t["rank"], "name": t["name"], "avg_pct": t["avg_pct"],
             "leader": t["leader"], "stocks": []} for t in h["themes"]],
            "source": "archives"}
    return None


def _match_theme(name, themes):
    """같은 테마를 찾는다 — 괄호 안까지 같은 이름 우선(코로나19 치료제 ≠ 코로나19 진단)."""
    if not name or not themes:
        return None
    want = str(name).strip()
    for t in themes:
        if str(t.get("name") or "").strip() == want:
            return t
    full = _norm_name(name)
    for t in themes:
        if _norm_name(t.get("name")) == full:
            return t
    key = _theme_key(name)
    if key:
        same = [t for t in themes if _theme_key(t.get("name")) == key]
        if len(same) == 1:
            return same[0]
    toks = _theme_tokens(name)
    cands = []
    for t in themes:
        tn = str(t.get("name") or "")
        score = sum(1 for x in toks if x in tn)
        if score >= 2:
            cands.append((score, t))
    if cands:
        cands.sort(key=lambda x: -x[0])
        return cands[0][1]
    return None


def _today_stock_index(themes):
    """오늘 테마의 종목별 {이름: {pct, value_eok}} — leaders/co_movers/stocks 를 모두 훑는다."""
    idx = {}
    for t in themes or []:
        rows = (list(t.get("stocks") or []) + list(t.get("leaders") or [])
                + list(t.get("leaders_by_pct") or []) + list(t.get("co_movers") or []))
        for s in rows:
            nm = s.get("name")
            if not nm or nm in idx:
                continue
            val = _num(s.get("value_eok"))
            if val is None and s.get("value") is not None:
                val = round((_num(s.get("value")) or 0) / 1e8, 1)
            idx[nm] = {"pct": _num(s.get("pct")), "value_eok": val}
    return idx


def theme_continuity(script_dir, today_themes, theme_rank=None, max_days=5):
    """직전 거래일 주도 테마/대장주가 오늘 살아남았는지.

    · 순위 변화(유지/약화/밀림/이탈) · 대장주 유지 여부
    · 전일 주도 4종목 중 오늘 상승한 수와, 그 종목들이 오늘 테마 대금에서 차지하는 비중(자금 잔류)
    · 보관 일수 안에서 그 테마가 상위권(10위 내)에 등장한 일수(테마 지속성)
    · 오늘 순위는 `theme_rank`(전체 테마 순위) 기준, 없으면 `today_themes` 안에서만 본다.
    """
    prev = prev_theme_snapshot(script_dir)
    hist = load_theme_history(script_dir, max_days=max_days)
    if not prev:
        return {"ok": False, "reason": "직전 거래일 테마 스냅샷 없음", "themes": []}
    rank_list = list(theme_rank or [])
    rich_list = list(today_themes or [])
    rank_scope = len(rank_list) if rank_list else len(rich_list)
    rows = []
    for pt in (prev.get("themes") or [])[:3]:
        tt = _match_theme(pt["name"], rich_list)
        tr = _match_theme(pt["name"], rank_list)
        prev_rank = pt.get("rank")
        today_rank = (tr or {}).get("rank") if tr else ((tt or {}).get("rank") if tt else None)
        if today_rank is None:
            status = "이탈(관제탑 목록 밖)" if rank_scope else "순위 미수신"
        elif prev_rank and today_rank <= prev_rank:
            status = "유지"
        elif prev_rank and today_rank <= prev_rank + 2:
            status = "약화"
        else:
            status = "밀림"
        leader_prev = pt.get("leader")
        leader_now = None
        if tt:
            leader_now = next((s.get("name") for s in (tt.get("leaders") or [])), None) \
                or next((s.get("name") for s in (tt.get("stocks") or [])), None)
        if not tt:
            leader_state = "대장 미수집"
        elif not leader_now:
            leader_state = "대장 미수집"
        elif leader_prev and leader_prev == leader_now:
            leader_state = "대장 유지"
        else:
            leader_state = f"대장 교체({leader_now})"

        # 전일 주도 종목은 '그 테마의 오늘 종목' 안에서만 본다(다른 테마 종목으로 메우지 않는다)
        local = _today_stock_index([tt]) if tt else {}
        alive, checked, up, overlap_value = [], 0, 0, 0.0
        for s in (pt.get("stocks") or []):
            nm = s.get("name")
            cur = local.get(nm)
            if not cur or cur.get("pct") is None:
                continue
            checked += 1
            overlap_value += cur.get("value_eok") or 0
            if cur["pct"] > 0:
                up += 1
                alive.append(f"{nm} {cur['pct']:+.2f}%")

        theme_stocks = (tt or {}).get("stocks") or []
        if not theme_stocks and tt:
            theme_stocks = list(tt.get("leaders") or []) + list(tt.get("co_movers") or [])
        total_now = sum((_num(s.get("value_eok")) or 0) for s in theme_stocks)
        share = round(overlap_value / total_now * 100, 1) if (checked and total_now) else None

        appear = 0
        for h in hist:
            if any(_norm_name(t.get("name")) == _norm_name(pt["name"]) and (t.get("rank") or 99) <= 10
                   for t in h.get("themes") or []):
                appear += 1
        rows.append({
            "name": pt["name"],
            "prev_rank": prev_rank, "prev_avg": pt.get("avg_pct"),
            "today_rank": today_rank,
            "today_avg": _num((tt or {}).get("avg_pct")) if tt else _num((tr or {}).get("avg_pct")),
            "today_basis": (tt or {}).get("basis_label") or (tr or {}).get("basis_label"),
            "status": status,
            "leader_prev": leader_prev, "leader_now": leader_now,
            "leader_kept": leader_state == "대장 유지", "leader_state": leader_state,
            "leader_pct": (local.get(leader_prev) or {}).get("pct") if leader_prev else None,
            "prev4_checked": checked, "prev4_up": up, "prev4_up_names": alive,
            "prev4_value_share": share,
            "appear_days": appear, "history_days": len(hist),
        })
    kept = sum(1 for r in rows if r["status"] in ("유지", "약화"))
    checked_rows = [r for r in rows if r["prev4_checked"]]
    leader_up = sum(1 for r in checked_rows if r["prev4_up"] >= 1)
    summary = {"rank_kept": f"{kept}/{len(rows)}"}
    if checked_rows:
        summary["leader_up"] = f"{leader_up}/{len(checked_rows)}"
    return {
        "ok": True,
        "prev_date": prev.get("date"), "prev_label": prev.get("label"),
        "prev_source": prev.get("source"),
        "history_days": len(hist),
        "history_dates": [h["date"] for h in hist],
        "themes": rows,
        "summary": summary,
    }


def fetch_theme_members(theme_no, limit=40, timeout=4.0):
    """네이버 테마 구성종목(대금 포함) — 필요할 때만 쓴다."""
    if not theme_no:
        return {"ok": False, "rows": []}
    try:
        d = _getj(f"{NAVER_THEME_ONE}{theme_no}?page=1&pageSize={limit}", timeout=timeout,
                  headers={"Referer": "https://m.stock.naver.com/"})
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "rows": [], "error": type(e).__name__}
    rows = []
    for s in d.get("stocks") or []:
        val_m = _num(s.get("accumulatedTradingValue"))
        rows.append({"code": s.get("itemCode"), "name": s.get("stockName"),
                     "pct": _num(s.get("fluctuationsRatio")),
                     "value_eok": round(val_m * 1e6 / 1e8, 1) if val_m is not None else None})
    return {"ok": True, "rows": rows}


# --------------------------------------------------------------------------- #
# 5) 시나리오 오답 노트
# --------------------------------------------------------------------------- #
def retro_notes_path(script_dir):
    _, dirs = _data_dirs(script_dir)
    for d in dirs:
        p = os.path.join(d, "scenario_retro_notes.json")
        if os.path.exists(p):
            return p
    return None


def load_retro_notes(script_dir, limit=5):
    """최근 오답 노트(날짜 내림차순) — 없거나 깨졌으면 빈 목록."""
    p = retro_notes_path(script_dir)
    if not p:
        return {"ok": False, "reason": "scenario_retro_notes.json 없음", "notes": []}
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"읽기 실패 {type(e).__name__}", "notes": []}
    notes = [n for n in (d.get("notes") or []) if isinstance(n, dict) and (n.get("date") or n.get("lesson"))]
    notes.sort(key=lambda n: str(n.get("date") or ""), reverse=True)
    out = []
    for n in notes[:limit]:
        out.append({
            "date": n.get("date"), "slot": n.get("slot"),
            "title": n.get("title"), "wrong": n.get("wrong"), "right": n.get("right"),
            "lesson": n.get("lesson"), "evidence": (n.get("evidence") or [])[:3],
        })
    return {"ok": True, "path": p, "count": len(notes), "notes": out}


# --------------------------------------------------------------------------- #
# 6) 미장 → 국내 연결
# --------------------------------------------------------------------------- #
_US_SYMBOLS = [("^DJI", "dow", "다우"), ("^GSPC", "sp500", "S&P500"),
               ("^IXIC", "nasdaq", "나스닥"), ("^SOX", "semis", "필라델피아 반도체"),
               ("NQ=F", "nq", "나스닥100 선물")]
# 빅테크 — 국내 섹터와 바로 이어지는 두 종목만(반도체·HBM / 2차전지)
_US_BIGTECH = [("NVDA", "엔비디아", "반도체·HBM·장비"), ("TSLA", "테슬라", "2차전지·소재")]


def _us_one(sym, key, name, timeout):
    try:
        d = _getj(YAHOO_CHART.format(sym=urllib.parse.quote(sym)) + "?interval=1d&range=5d",
                 timeout=timeout)
        r = ((d.get("chart") or {}).get("result") or [None])[0]
        m = (r or {}).get("meta") or {}
        price = m.get("regularMarketPrice")
        pct = m.get("regularMarketChangePercent")
        ts = m.get("regularMarketTime")
        when = ""
        if isinstance(ts, (int, float)):
            when = datetime.fromtimestamp(ts, ET).strftime("%m/%d")
        if not isinstance(price, (int, float)):
            return {"key": key, "name": name, "ok": False}
        return {"key": key, "name": name, "ok": True, "price": round(float(price), 2),
                "pct": round(float(pct), 2) if isinstance(pct, (int, float)) else None,
                "date": when}
    except Exception:  # noqa: BLE001
        return {"key": key, "name": name, "ok": False}


def fetch_us_market(timeout=4.0):
    """최근 미장 정규장 지수 + 나스닥100 선물 + 빅테크. 실패한 심볼은 ok:False 로 남긴다."""
    out, big = [], []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(_us_one, s, k, n, timeout) for s, k, n in _US_SYMBOLS]
        for f in futs:
            try:
                out.append(f.result(timeout=timeout + 2))
            except Exception:  # noqa: BLE001
                out.append({"ok": False})
        bt = {name: ex.submit(_us_one, sym, name, name, timeout) for sym, name, _t in _US_BIGTECH}
        for sym, name, target in _US_BIGTECH:
            try:
                r = bt[name].result(timeout=timeout + 2)
            except Exception:  # noqa: BLE001
                r = {"ok": False}
            r["target"] = target
            big.append(r)
    idx = [r for r in out if r.get("ok") and r["key"] != "nq"]
    fut = next((r for r in out if r.get("ok") and r["key"] == "nq"), None)
    latest = max((r["date"] for r in idx if r.get("date")), default="")
    gap = None
    if latest:
        try:
            md = datetime.strptime(f"{datetime.now(KST).year}/{latest}", "%Y/%m/%d").date()
            gap = (datetime.now(KST).date() - md).days
        except Exception:  # noqa: BLE001
            gap = None
    rules = []
    for key, label, target in US_KR_RULES:
        r = next((x for x in idx if x["key"] == key and x.get("pct") is not None), None)
        if r:
            rules.append(f"{r['name']} {r['pct']:+.2f}% → {target} 쪽에 오늘 실제 수급이 붙는지"
                         f" 테마 등락으로 확인")
    for r in big:
        if r.get("ok") and r.get("pct") is not None:
            rules.append(f"빅테크 {r['name']} {r['pct']:+.2f}% → {r.get('target')} 쪽 수급이 오늘 붙는지 확인")
    return {"ok": bool(idx), "indices": idx, "futures": fut, "bigtech": big,
            "latest_date": latest, "gap_days": gap, "rules": rules}


# --------------------------------------------------------------------------- #
# 오케스트레이터
# --------------------------------------------------------------------------- #
def _supply_streaks_from_json(script_dir, limit=4):
    """supply-latest.json 의 확정 연속 수급(streakForeign/streakOrgan) — 요청 없이 바로."""
    _, dirs = _data_dirs(script_dir)
    for d in dirs:
        p = os.path.join(d, "supply-latest.json")
        if not os.path.exists(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                j = json.load(f)
        except Exception:  # noqa: BLE001
            continue
        rows, seen = [], set()
        for group in ("foreignBuy", "organBuy", "foreignSell"):
            for s in (j.get("groups") or {}).get(group) or []:
                code = s.get("code")
                if not code or code in seen:
                    continue
                seen.add(code)
                rows.append({
                    "code": code, "name": s.get("name"), "group": group,
                    "foreign_streak": s.get("streakForeign"),
                    "organ_streak": s.get("streakOrgan"),
                    "foreign_eok": _num(s.get("foreignEok")),
                    "organ_eok": _num(s.get("organEok")),
                    "pct": _num(s.get("pct")),
                })
        return {"basis": j.get("basisLabel"), "rows": rows[:limit]}
    return {"basis": None, "rows": []}


def build_deep_context(script_dir, today_themes, theme_rank=None, budget=25.0, verbose=True):
    """뉴스·공시·연속 수급·테마 연속성·오답 노트·미장을 한 번에 모은다.

    · 네트워크 작업은 스레드로 던지고 전체 시간 예산(budget)을 넘기면 남은 것은 버린다.
    · 어떤 작업이 실패해도 다른 결과와 브리핑 발송은 그대로 간다.
    """
    t0 = time.time()
    deep = {"ok": True, "errors": [], "themes": [], "continuity": {}, "us": {},
            "supply_streaks": {}, "retro": {}, "elapsed": 0.0}

    def log(msg):
        if verbose:
            print(msg, flush=True)

    # 로컬 파일(네트워크 없음) — 예산과 무관하게 먼저
    try:
        deep["supply_streaks"] = _supply_streaks_from_json(script_dir)
    except Exception as e:  # noqa: BLE001
        deep["errors"].append(f"supply-streaks: {e}")
    try:
        deep["retro"] = load_retro_notes(script_dir, limit=5)
    except Exception as e:  # noqa: BLE001
        deep["errors"].append(f"retro: {e}")

    # 네트워크 작업 목록
    jobs = {}
    with ThreadPoolExecutor(max_workers=12) as ex:
        jobs["us"] = ex.submit(fetch_us_market, 4.0)
        jobs["continuity"] = ex.submit(theme_continuity, script_dir, today_themes, theme_rank)
        # 수급 상위 종목도 같은 방식(일별 확정)으로 연속 일수를 직접 계산한다
        for r in (deep["supply_streaks"] or {}).get("rows") or []:
            if r.get("code"):
                jobs[f"supjson:{r['code']}"] = ex.submit(fetch_stock_supply, r["code"], 5, 4.0)
        for ti, t in enumerate((today_themes or [])[:3]):
            leaders = list(t.get("leaders") or [])[:2]
            if not leaders and t.get("leaders_by_pct"):
                leaders = list(t.get("leaders_by_pct"))[:1]
            entry = {"name": t.get("name"), "rank": t.get("rank"), "leaders": []}
            for s in leaders:
                code, name = s.get("code"), s.get("name")
                if not code or not name:
                    continue
                entry["leaders"].append({
                    "name": name, "code": code,
                    "pct": s.get("pct"), "value_eok": s.get("value_eok"),
                })
                jobs[f"news:{code}"] = ex.submit(fetch_stock_news, code, name, 2, 3.5)
                jobs[f"dart:{code}"] = ex.submit(fetch_dart_today, name, None, 4.5)
                jobs[f"sup:{code}"] = ex.submit(fetch_stock_supply, code, 5, 4.0)
            deep["themes"].append(entry)

        deadline = t0 + budget
        for name, fut in jobs.items():
            left = deadline - time.time()
            if left <= 0:
                deep["errors"].append(f"{name}: 시간 예산 초과로 생략")
                continue
            try:
                done, _ = wait([fut], timeout=left)
                if not done:
                    deep["errors"].append(f"{name}: 시간 초과")
                    continue
                val = fut.result()
            except Exception as e:  # noqa: BLE001
                deep["errors"].append(f"{name}: {str(e)[:60]}")
                continue
            kind, _, key = name.partition(":")
            if kind == "us":
                deep["us"] = val
            elif kind == "continuity":
                deep["continuity"] = val
            elif kind == "supjson":
                for r in (deep["supply_streaks"] or {}).get("rows") or []:
                    if r.get("code") == key:
                        r["supply"] = val
            else:
                for entry in deep["themes"]:
                    for s in entry["leaders"]:
                        if s["code"] == key:
                            s[{"news": "news", "dart": "dart", "sup": "supply"}[kind]] = val

    deep["elapsed"] = round(time.time() - t0, 1)
    if deep["errors"]:
        log(f"🧠 심화 분석 일부 실패: {deep['errors'][:4]}")
    log(f"🧠 심화 분석 완료 {deep['elapsed']}s — 테마 {len(deep['themes'])}개/"
        f" 연속성 {len((deep.get('continuity') or {}).get('themes') or [])}개/"
        f" 오답노트 {len((deep.get('retro') or {}).get('notes') or [])}건")
    return deep


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _selftest(script_dir):
    print("== 뉴스 ==", json.dumps(fetch_stock_news("261780", "아리바이오랩"), ensure_ascii=False)[:400])
    print("== 공시 ==", json.dumps(fetch_dart_today("삼성전자"), ensure_ascii=False)[:400])
    print("== 수급 ==", json.dumps(fetch_stock_supply("005930"), ensure_ascii=False)[:600])
    print("== 미장 ==", json.dumps(fetch_us_market(), ensure_ascii=False)[:600])
    print("== 스냅샷 ==", json.dumps(prev_theme_snapshot(script_dir), ensure_ascii=False)[:400])
    print("== 노트 ==", json.dumps(load_retro_notes(script_dir), ensure_ascii=False)[:400])


if __name__ == "__main__":
    sdir = os.path.dirname(os.path.abspath(__file__))
    if "--selftest" in sys.argv:
        _selftest(sdir)
    elif "--probe" in sys.argv:
        i = sys.argv.index("--probe")
        code = sys.argv[i + 1] if len(sys.argv) > i + 1 else "005930"
        name = ""
        if "--name" in sys.argv:
            j = sys.argv.index("--name")
            name = sys.argv[j + 1] if len(sys.argv) > j + 1 else ""
        print(json.dumps({"news": fetch_stock_news(code, name), "dart": fetch_dart_today(name),
                          "supply": fetch_stock_supply(code)}, ensure_ascii=False, indent=1))
    else:
        print(__doc__)
