#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""💸 5분 거래대금 버킷 스냅샷 — 관제탑 1번 탭 `300억 (25/5/6)` 용.

무엇을 하나
  · 관제탑 1번 탭 종목 타일의 거래대금 순증은 **최근 15분을 5분 간격 3구간**으로 본다.
      d1 = 최근 5분(현재 − 5분 전) · d2 = 5~10분 전 · d3 = 10~15분 전
  · 그 3구간을 계산하려면 5분 전·10분 전·15분 전의 대금이 남아 있어야 한다.
    브라우저(localStorage)만 쓰면 폰을 잠깐 열었을 때 기록이 비어 아무것도 안 보인다.
  · 그래서 이 스크립트가 **5분마다** 화면에 뜬 테마 종목들의 누적 대금(억)을
    Supabase family_sync[stock_tv_5m_v1] 의 그 5분 칸에 '처음 본 값'으로 남긴다.
    (동적 /api/tabs-live 와 정적 scripts/auto_update_all_tabs.py 가 같은 행을 읽고 쓴다)

부르는 곳
  · scheduled-actions/관심종목-타점-알리미/check.sh (평일 09:00~15:30 · 5분 주기)
    → 사용자가 브라우저를 열지 않아도, 알림이 울리지 않아도 5분 칸이 계속 쌓인다.

원칙
  · 한 칸은 덮어쓰지 않는다(칸 시작 시점 대금과 비교해야 5분 구간이 맞는다).
  · 장외(장전·야간·주막)·휴장일에는 기록하지 않는다 — 굳은 값을 새 기록처럼 남기지 않는다.
  · 없는 값을 만들지 않는다. 시세를 못 받으면 그냥 아무것도 하지 않는다.
  · **종료 코드는 항상 0** — 타점 알리미의 판정·알림 로직에 영향을 주지 않는다.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = '/workspace'
TRACK_CODES_PATH = os.path.join(ROOT, 'data', 'tv_track_codes.json')
LOCAL_DOC = os.path.join(ROOT, 'data', 'tv_5m_buckets.json')
STATIC_INDEX = os.path.join(ROOT, 'deploy_repo', 'index.html')
LIVE_INDEX = os.path.join(ROOT, 'sd_live', 'public', 'index.html')

SUPABASE = {
    'url': os.environ.get('SUPABASE_URL', 'https://hiruybkapzuhjrzjoyik.supabase.co'),
    'key': os.environ.get('SUPABASE_ANON_KEY', 'sb_publishable_e5JJbvCPDhY91uXaUEVNVA_8Byv_gI8'),
    'table': 'family_sync',
    'code': 'stock_tv_5m_v1',
}
NAVER_QUOTE = 'https://polling.finance.naver.com/api/realtime/domestic/stock/{codes}'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

BUCKET_MAX = 6        # 최근 30분(5분 칸 6개)
KEEP_MIN = 30
SESSION_START = 8 * 60
SESSION_END = 20 * 60
MAX_CODES = 80        # 한 번의 폴링에 넣을 종목 수 상한(요청 URL·응답 크기)


def kst_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=9)))


def in_session(now: dt.datetime) -> bool:
    if now.weekday() >= 5:
        return False
    minutes = now.hour * 60 + now.minute
    return SESSION_START <= minutes < SESSION_END


def bucket_of(minute: int) -> int:
    return int(minute // 5 * 5)


def hhmm(bucket_min: int) -> str:
    d = dt.datetime.fromtimestamp(bucket_min * 60, dt.timezone.utc) + dt.timedelta(hours=9)
    return d.strftime('%H:%M')


def http_json(url: str, headers: dict | None = None, timeout: int = 8):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode('utf-8', 'replace')
    return json.loads(raw) if raw.strip() else None


def load_track_codes() -> list[str]:
    """① 동기화 스크립트가 남긴 종목 목록 → ② 정적 페이지 카드의 종목코드 순서."""
    codes: list[str] = []
    try:
        with open(TRACK_CODES_PATH, encoding='utf-8') as f:
            doc = json.load(f)
        for c in doc.get('codes') or []:
            c = str(c).strip()
            if re.fullmatch(r'\d{6}', c) and c not in codes:
                codes.append(c)
    except Exception:                                   # noqa: BLE001
        pass
    if not codes:
        for path in (STATIC_INDEX, LIVE_INDEX):
            try:
                with open(path, encoding='utf-8') as f:
                    src = f.read()
            except Exception:                           # noqa: BLE001
                continue
            for m in re.finditer(r"openDetail\('[^']*\((\d{6})\)'", src):
                if m.group(1) not in codes:
                    codes.append(m.group(1))
            if codes:
                break
    return codes[:MAX_CODES]


def fetch_values(codes: list[str]) -> dict:
    """{code: 억원} — 통합(KRX+NXT) 누적 대금. 정규장 단독보다 큰 쪽을 쓴다(tabs-live 와 같은 기준)."""
    values = {}
    for i in range(0, len(codes), 40):
        chunk = codes[i:i + 40]
        if not chunk:
            continue
        try:
            data = http_json(NAVER_QUOTE.format(codes=','.join(chunk)),
                             {'User-Agent': UA, 'Accept': 'application/json'}) or {}
        except Exception:                               # noqa: BLE001
            continue
        for d in data.get('datas') or []:
            code = str(d.get('itemCode') or '')
            if not re.fullmatch(r'\d{6}', code):
                continue
            integ = (d.get('integratedPriceInfo') or {}).get('accumulatedTradingValueRaw')
            regular = d.get('accumulatedTradingValueRaw')
            nums = []
            for raw in (integ, regular):
                try:
                    n = float(str(raw).replace(',', '').strip())
                except (TypeError, ValueError):
                    continue
                if n > 0:
                    nums.append(n)
            if not nums:
                continue
            values[code] = round(max(nums) / 1e8, 1)
    return values


def read_doc(now: dt.datetime):
    """(doc, readable) — readable=False 면 기존 행을 덮어쓰지 않는다(지난 칸 보호)."""
    cloud = None
    cloud_ok = False
    try:
        url = (f"{SUPABASE['url']}/rest/v1/{SUPABASE['table']}"
               f"?code=eq.{urllib.parse.quote(SUPABASE['code'])}&select=code,data")
        rows = http_json(url, {'apikey': SUPABASE['key'],
                               'Authorization': 'Bearer ' + SUPABASE['key'],
                               'Accept': 'application/json'}, timeout=6) or []
        data = (rows[0] or {}).get('data') if rows else None
        cloud_ok = True
        if isinstance(data, dict):
            cloud = data
    except Exception:                                   # noqa: BLE001
        cloud_ok = False

    local = None
    try:
        with open(LOCAL_DOC, encoding='utf-8') as f:
            local = json.load(f)
        if not isinstance(local, dict):
            local = None
    except Exception:                                   # noqa: BLE001
        local = None

    merged: dict[int, dict] = {}
    for src in (cloud, local):
        for b in (src or {}).get('buckets') or []:
            try:
                t = int(b.get('t'))
            except (TypeError, ValueError):
                continue
            slot = merged.setdefault(t, {'t': t, 'hhmm': b.get('hhmm') or hhmm(t), 's': {}})
            for code, val in (b.get('s') or {}).items():
                try:
                    v = round(float(val), 1)
                except (TypeError, ValueError):
                    continue
                if v > 0:
                    slot['s'].setdefault(code, v)

    kst = dt.timezone(dt.timedelta(hours=9))
    day_start = int(dt.datetime(now.year, now.month, now.day, tzinfo=kst).timestamp() // 60)
    now_min = int(time.time() // 60)
    keep = [b for t, b in merged.items() if day_start <= t and t >= now_min - 60]
    keep.sort(key=lambda x: x['t'])
    return {'v': 1, 'date': now.strftime('%Y-%m-%d'), 'buckets': keep[-BUCKET_MAX:]}, (cloud_ok or local is not None)


def write_doc(doc: dict) -> bool:
    doc = dict(doc)
    doc['updatedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
    doc.setdefault('v', 1)
    try:
        body = [{'code': SUPABASE['code'], 'data': doc,
                 'updated_at': dt.datetime.now(dt.timezone.utc).isoformat()}]
        req = urllib.request.Request(
            f"{SUPABASE['url']}/rest/v1/{SUPABASE['table']}?on_conflict=code",
            data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
            headers={'apikey': SUPABASE['key'],
                     'Authorization': 'Bearer ' + SUPABASE['key'],
                     'Content-Type': 'application/json',
                     'Prefer': 'resolution=merge-duplicates,return=minimal'},
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            return 200 <= r.status < 300
    except Exception:                                   # noqa: BLE001
        return False


def main() -> int:
    now = kst_now()
    if not in_session(now):
        return 0
    codes = load_track_codes()
    if not codes:
        return 0
    values = fetch_values(codes)
    if not values:
        return 0

    doc, readable = read_doc(now)
    if not readable:
        print('[TV5] 기록 읽기 실패 — 기존 칸을 덮어쓰지 않고 건너뜁니다')
        return 0
    bucket_min = bucket_of(int(time.time() // 60))
    buckets = doc.setdefault('buckets', [])
    bucket = next((b for b in buckets if b.get('t') == bucket_min), None)
    if bucket is None:
        bucket = {'t': bucket_min, 'hhmm': hhmm(bucket_min), 's': {}}
        buckets.append(bucket)

    added = 0
    for code, eok in values.items():
        if code in bucket['s'] or eok <= 0:
            continue
        bucket['s'][code] = eok
        added += 1

    if not added:
        print(f"[TV5] {hhmm(bucket_min)} 칸 이미 기록됨(추가 0)")
        return 0

    buckets.sort(key=lambda x: x['t'])
    doc['buckets'] = buckets[-BUCKET_MAX:]
    doc['date'] = now.strftime('%Y-%m-%d')
    doc['src'] = 'check.sh'
    try:
        os.makedirs(os.path.dirname(LOCAL_DOC) or '.', exist_ok=True)
        with open(LOCAL_DOC, 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False)
    except Exception:                                   # noqa: BLE001
        pass
    ok = write_doc(doc)
    print(f"[TV5] {hhmm(bucket_min)} 칸 +{added}종목 "
          f"(보관 {len(doc['buckets'])}칸 · {'저장' if ok else '저장 실패'})")
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:                              # noqa: BLE001
        # 알림 판정(check.sh)에 절대 영향을 주지 않는다.
        print(f"[TV5] 건너뜀: {e}")
        sys.exit(0)
