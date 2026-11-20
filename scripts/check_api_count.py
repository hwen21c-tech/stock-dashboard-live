#!/usr/bin/env python3
"""api/ 서버리스 함수 개수 가드 — Vercel Hobby 12개 한도.

Vercel Hobby 플랜은 서버리스 함수 12개까지만 배포된다. 13개가 되면
빌드는 'Deployment has failed'로 조용히 실패하고 라이브는 옛 버전에 머문다
(2026-11-20 20:12 ~ 11-21 08:0x 실제 발생).

이 스크립트는
  1) api/*.js 파일 수가 12개 이하인지
  2) vercel.json 의 rewrite 목적지가 실제로 존재하는 api 파일을 가리키는지
를 확인한다. 새 엔드포인트가 필요하면 새 파일을 만들지 말고
기존 함수에 ?mode=... 분기를 붙이고 vercel.json rewrite 로 옛 경로를 살린다.

사용: python3 scripts/check_api_count.py   (위반 시 exit 1)
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = ROOT / "api"
LIMIT = 12


def pathendswith_js(p: str) -> bool:
    return p.endswith(".js")

def main() -> int:
    files = sorted(p.name for p in API.glob("*.js") if p.is_file())
    n = len(files)
    problems = []

    print(f"api 함수 {n}개 (한도 {LIMIT}개)")
    for f in files:
        print(f"  · api/{f}")
    if n > LIMIT:
        problems.append(f"api/ 함수가 {n}개 — 한도 {LIMIT}개 초과. 배포가 실패한다.")

    vj = ROOT / "vercel.json"
    if vj.exists():
        cfg = json.loads(vj.read_text(encoding="utf-8"))
        for rw in cfg.get("rewrites", []):
            dest = str(rw.get("destination", ""))
            if not dest.startswith("/api/"):
                continue
            path = dest.split("?")[0].lstrip("/")
            target = ROOT / path
            if not target.exists() and not pathendswith_js(path):
                target = ROOT / (path + ".js")
            if not target.exists():
                problems.append(f"rewrite {rw.get('source')} → {dest} : {path} 파일이 없다.")
            else:
                print(f"  ↳ rewrite {rw.get('source')} → {dest} ✓")

    if problems:
        print()
        for p in problems:
            print(f"❌ {p}")
        return 1
    print("\n✅ api 함수 수·rewrite 목적지 정상")
    return 0

if __name__ == "__main__":
    sys.exit(main())
