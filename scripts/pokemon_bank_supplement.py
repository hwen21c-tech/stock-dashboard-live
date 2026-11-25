#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""포켓몬 배틀 한글·영어 문제 은행 자정 보충 (GitHub Actions)

기존 피클 스케줄(`🌙 포켓몬 배틀 자정 문제 은행 보충`)이 하던 일을 그대로 옮긴 실행기.
  · hangul-bank.json  — 중복되지 않는 낱말 6~9개(쉬움/중간/어려움 각 3개)
  · english-bank.json — 중복되지 않는 초등 영단어 5개 + 생활 문장 3개(빈칸·보기 4개·해석)

문제를 지어내지 않는다. 예비 어휘(`pokemon_bank_pool.json`)에서 아직 은행에 없는 것만 꺼내
넣고, 예비 어휘가 떨어지면 그 회차는 적게 넣고 로그로 알린다(가짜 낱말 생성 금지).

사용법
  python3 scripts/pokemon_bank_supplement.py            # 실제 반영
  python3 scripts/pokemon_bank_supplement.py --dry-run   # 파일을 쓰지 않고 결과만
  python3 scripts/pokemon_bank_supplement.py --hangul 9 --english 5 --sentences 3
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.environ.get("SYNC_REPO_ROOT") or os.path.dirname(HERE)
PUB = os.path.join(REPO_ROOT, "public")
HANGUL_PATH = os.path.join(PUB, "hangul-bank.json")
ENGLISH_PATH = os.path.join(PUB, "english-bank.json")
POOL_PATH = os.path.join(HERE, "pokemon_bank_pool.json")

LEVELS = ("easy", "mid", "hard")
HANGUL_RE = re.compile(r"^[가-힣]{2,6}$")
EN_RE = re.compile(r"^[a-z][a-z\- ]{0,20}$")


def log(msg):
    print(msg, flush=True)


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save(path, data):
    """기존 파일과 같은 압축 JSON(공백 없음)으로 저장한다."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def take_hangul(pool, bank, want_per_level=3):
    have = {w.get("w") for w in bank["words"]}
    picked = []
    for level in LEVELS:
        n = 0
        for entry in pool:
            if n >= want_per_level:
                break
            if entry.get("level") != level:
                continue
            w = (entry.get("w") or "").strip()
            if not HANGUL_RE.match(w) or w in have:
                continue
            c = entry.get("c") or ""
            if not c:
                continue
            picked.append({"w": w, "e": entry.get("e") or "", "c": c, "level": level})
            have.add(w)
            n += 1
        if n < want_per_level:
            log("  ! 예비 한글 낱말 부족 — %s %d개만 추가(요청 %d개)" % (level, n, want_per_level))
    return picked


def take_english_words(pool, bank, want=5):
    have = {(w.get("en") or "").lower() for w in bank["words"]}
    picked = []
    for entry in pool:
        if len(picked) >= want:
            break
        en = (entry.get("en") or "").strip().lower()
        if not EN_RE.match(en) or en in have:
            continue
        if not entry.get("ko"):
            continue
        picked.append({"en": en, "ko": entry["ko"], "e": entry.get("e") or "",
                       "cat": entry.get("cat") or "word", "level": entry.get("level") or "mid"})
        have.add(en)
    if len(picked) < want:
        log("  ! 예비 영단어 부족 — %d개만 추가(요청 %d개)" % (len(picked), want))
    return picked


def take_sentences(pool, bank, want_per_level=1):
    def norm(q):
        return re.sub(r"\s+", " ", (q or "").replace("___", " ")).strip().lower()

    have = {norm(s.get("q")) for s in bank["sentences"]}
    picked = []
    for level in LEVELS:
        n = 0
        for s in pool:
            if n >= want_per_level:
                break
            if (s.get("level") or "") != level:
                continue
            q = (s.get("q") or "").strip()
            a = (s.get("a") or "").strip()
            opts = [str(o).strip() for o in (s.get("o") or [])]
            if "___" not in q or not a or len(opts) != 3:
                continue
            if a in opts:
                continue
            if not s.get("k"):
                continue
            key = norm(q)
            if key in have:
                continue
            picked.append({"q": q, "a": a, "o": opts, "k": s["k"], "level": level})
            have.add(key)
            n += 1
        if n < want_per_level:
            log("  ! 예비 문장 부족 — %s %d개만 추가" % (level, n))
    return picked


def validate(hangul, english, new_h, new_e, new_s):
    """새로 넣는 항목만 형식을 검사하고, 은행 전체는 중복만 검사한다(기존 자료는 건드리지 않는다)."""
    errors = []
    words = [w["w"] for w in hangul["words"]]
    if len(words) != len(set(words)):
        errors.append("한글 낱말 중복")
    for w in new_h:
        if not HANGUL_RE.match(w.get("w") or ""):
            errors.append("한글 형식 오류: %r" % w.get("w"))
        if w.get("level") not in LEVELS:
            errors.append("한글 난이도 오류: %r" % w.get("w"))
        if not (w.get("c") or "").strip():
            errors.append("한글 분류 없음: %r" % w.get("w"))
    ens = [(w.get("en") or "").lower() for w in english["words"]]
    if len(ens) != len(set(ens)):
        errors.append("영단어 중복")
    for w in new_e:
        if not EN_RE.match((w.get("en") or "").lower()):
            errors.append("영단어 형식 오류: %r" % w.get("en"))
        if not (w.get("ko") or "").strip():
            errors.append("영단어 뜻 없음: %r" % w.get("en"))
    qs = [(s.get("q") or "") for s in english["sentences"]]
    if len(qs) != len(set(qs)):
        errors.append("문장 중복")
    for s in new_s:
        if "___" not in (s.get("q") or ""):
            errors.append("문장 빈칸 없음: %r" % s.get("q"))
        if s.get("a") in (s.get("o") or []):
            errors.append("문장 정답이 보기에 포함: %r" % s.get("q"))
        if len(s.get("o") or []) != 3:
            errors.append("문장 보기 개수 오류: %r" % s.get("q"))
        if not (s.get("k") or "").strip():
            errors.append("문장 해석 없음: %r" % s.get("q"))
    return errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hangul", type=int, default=3, help="난이도별 한글 낱말 수(기본 3 → 총 9)")
    ap.add_argument("--english", type=int, default=5, help="추가할 영단어 수")
    ap.add_argument("--sentences", type=int, default=1, help="난이도별 문장 수(기본 1 → 총 3)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    for p in (HANGUL_PATH, ENGLISH_PATH, POOL_PATH):
        if not os.path.exists(p):
            log("[FAIL] 파일이 없습니다: %s" % p)
            return 1

    pool = load(POOL_PATH)
    hangul = load(HANGUL_PATH)
    english = load(ENGLISH_PATH)
    before_h, before_e, before_s = len(hangul["words"]), len(english["words"]), len(english["sentences"])

    new_h = take_hangul(pool.get("hangul") or [], hangul, args.hangul)
    new_e = take_english_words((pool.get("english") or {}).get("words") or [], english, args.english)
    new_s = take_sentences((pool.get("english") or {}).get("sentences") or [], english, args.sentences)

    log("· 추가 예정 — 한글 %d · 영단어 %d · 문장 %d" % (len(new_h), len(new_e), len(new_s)))
    for w in new_h:
        log("   + %s (%s/%s)" % (w["w"], w["c"], w["level"]))
    for w in new_e:
        log("   + %s (%s)" % (w["en"], w["ko"]))
    for s in new_s:
        log("   + %s → %s" % (s["q"], s["a"]))

    if not (new_h or new_e or new_s):
        log("· NO_CHANGE — 예비 어휘가 소진되어 이번 회차는 비웁니다")
        return 0

    stamp = datetime.now(KST).strftime("%Y-%m-%d")
    hangul["words"].extend(new_h)
    english["words"].extend(new_e)
    english["sentences"].extend(new_s)
    hangul["updated"] = stamp
    english["updated"] = stamp

    errors = validate(hangul, english, new_h, new_e, new_s)
    if errors:
        log("[FAIL] 검증 실패 — 파일을 쓰지 않습니다")
        for e in errors[:10]:
            log("   - " + e)
        return 1

    log("· 검증 통과 — 한글 %d→%d · 영단어 %d→%d · 문장 %d→%d"
        % (before_h, len(hangul["words"]), before_e, len(english["words"]),
           before_s, len(english["sentences"])))

    if args.dry_run:
        log("[dry-run] 파일을 쓰지 않습니다")
        return 0

    save(HANGUL_PATH, hangul)
    save(ENGLISH_PATH, english)
    log("· 저장 완료 — public/hangul-bank.json · public/english-bank.json (updated %s)" % stamp)
    return 0


if __name__ == "__main__":
    sys.exit(main())
