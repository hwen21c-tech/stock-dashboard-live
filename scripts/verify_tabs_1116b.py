#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""5개 전략 탭 통합 고도화 검증 (동적 본체 · Playwright 실측)

  python3 scripts/verify_tabs_1116b.py
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

NODE = "/workspace/.local/nodejs/node-v20.18.0-linux-x64/bin/node"
CHROME = "/workspace/.cache/puppeteer/chrome-headless-shell/linux-131.0.6778.204/chrome-headless-shell-linux64/chrome-headless-shell"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("VERIFY_PORT", "8836"))
BASE = f"http://127.0.0.1:{PORT}/"
OUT = os.path.join(ROOT, "screenshots", "tabs_1116b")

fails, oks = [], []


def check(cond, label, detail=""):
    (oks if cond else fails).append(label)
    print(("OK   " if cond else "FAIL ") + label + ((" — " + str(detail)) if detail else ""))


def main():
    os.makedirs(OUT, exist_ok=True)
    srv = subprocess.Popen([NODE, "dev_server.mjs"], cwd=ROOT,
                           env={**os.environ, "PORT": str(PORT)},
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        time.sleep(0.3)
        try:
            urllib.request.urlopen(BASE, timeout=1)
            break
        except Exception:
            continue
    logs = []
    result = {}
    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch(executable_path=CHROME, args=["--no-sandbox", "--disable-dev-shm-usage"])
            for w, h, tag in ((400, 860, "400"), (884, 960, "884")):
                ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
                page = ctx.new_page()
                page.on("console", lambda m: logs.append(tag + " console." + m.type + ": " + m.text[:200])
                        if m.type == "error" else None)
                page.on("pageerror", lambda e: logs.append(tag + " pageerror: " + str(e)[:200]))
                page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(9000)
                page.evaluate("""() => {
                  document.querySelectorAll('#pinLockOverlay,[id^=pinLockOverlay]').forEach(e=>e.remove());
                  document.documentElement.classList.remove('pin-locked');
                }""")

                # 1) RN존
                page.evaluate("() => switchView('rnzone', null)")
                page.wait_for_timeout(1500)
                cards = page.eval_on_selector_all("#stockListGrid .stock-card", "els => els.length")
                cats = page.eval_on_selector_all("#tabRnzone .cat-tab-btn", "els => els.map(e=>e.textContent.trim())")
                sample = page.evaluate("""() => {
                  const c = document.querySelector('#stockListGrid .stock-card[data-code="009150"]');
                  return c ? c.innerText.replace(/\\n/g, ' | ') : null;
                }""")
                page.screenshot(path=os.path.join(OUT, f"rn_{tag}.png"))
                try:
                    page.eval_on_selector("#stockListGrid", "el => el.scrollIntoView({block:'start'})")
                    page.wait_for_timeout(500)
                    page.screenshot(path=os.path.join(OUT, f"rn_list_{tag}.png"))
                    page.eval_on_selector("#chartWrapper", "el => el.scrollIntoView({block:'center'})")
                    page.wait_for_timeout(500)
                    page.screenshot(path=os.path.join(OUT, f"rn_chart_{tag}.png"))
                except Exception as e:
                    print('scroll shot skip', e)
                result[f"rn_cards_{tag}"] = cards
                if tag == "400":
                    check(cards == 12, "RN 카드 12종목", cards)
                    check(len(cats) == 5, "RN 카테고리 5개(전체·하단터치·하단근접·상단근접·상단돌파)", cats)
                    check(sample is not None and "750,000" in sample and "1,000,000" in sample and "옥색" in sample,
                          "삼성전기 779,000 → 하단 750,000(옥색) / 상단 1,000,000(붉은색)", (sample or "")[:160])
                    check(sample is not None and ("하단 RN 근접" in sample or "하단 RN 터치" in sample),
                          "삼성전기 = 하단 RN 근접/터치 분류", (sample or "")[:80])
                    chart_colors = page.evaluate("""() => {
                      const s = window.RnZone.getStocks().find(x => x.code === '009150');
                      return s ? [s.lowerColorHex, s.upperColorHex, s.lowerColorKo, s.upperColorKo] : null;
                    }""")
                    check(chart_colors == ['#14b8a6', '#ef4444', '옥색', '붉은색'],
                          "RN선 색상 필드(옥색 #14b8a6 / 붉은색 #ef4444)", chart_colors)

                # 2) 비중법사
                page.evaluate("() => switchView('bijoong', null)")
                page.wait_for_timeout(1200)
                bij_txt = page.evaluate("() => { const c=document.querySelector('#tabBijoong .card'); return c? c.innerText.replace(/\\n/g,' | ') : null; }")
                page.screenshot(path=os.path.join(OUT, f"bij_{tag}.png"))
                if tag == "400":
                    check(bool(bij_txt) and "통합" in bij_txt and "위" in bij_txt,
                          "비중법사 카드 거래대금 순위 + 기준 표기", (bij_txt or "")[:200])

                # 3) 홍인기
                page.evaluate("() => switchView('honginki', null)")
                page.wait_for_timeout(1800)
                hong_card = page.evaluate("() => { const c=document.querySelector('#hiStockGrid .hi-stock-card'); return c? c.innerText.replace(/\\n/g,' | ') : null; }")
                hong_note = page.evaluate("() => { const e=document.getElementById('hiChipNote'); return e? e.innerText : null; }")
                page.screenshot(path=os.path.join(OUT, f"hong_{tag}.png"))
                if tag == "400":
                    check(bool(hong_card) and "기준봉 중심선" in hong_card, "홍인기 카드 기준봉 중심선 칩", (hong_card or "")[:200])
                    check(bool(hong_note) and "중심선 이탈" in hong_note, "홍인기 D+1 중심선 이탈 자동제외 표기", hong_note)

                # 4) 깡토
                page.evaluate("() => switchView('kkangto', null)")
                page.wait_for_timeout(2000)
                kk_n = page.eval_on_selector_all("#tabKkangto .kk-news", "els => els.length")
                kk_txt = page.evaluate("() => { const e=document.querySelector('#tabKkangto .kk-news'); return e? e.innerText.replace(/\\n/g,' | ') : null; }")
                page.screenshot(path=os.path.join(OUT, f"kkangto_{tag}.png"))
                try:
                    page.eval_on_selector("#kkNearGrid", "el => el.scrollIntoView({block:'start'})")
                    page.wait_for_timeout(500)
                    page.screenshot(path=os.path.join(OUT, f"kkangto_cards_{tag}.png"))
                except Exception as e:
                    print('kk scroll skip', e)
                if tag == "400":
                    check(kk_n > 0, "깡토 카드 📌 재료·이슈 블록", kk_n)
                    check(bool(kk_txt) and "재료·이슈" in kk_txt, "깡토 재료 문구", (kk_txt or "")[:160])

                # 5) 만쥬 + 상세 팝업
                page.evaluate("() => switchView('manju', null)")
                page.wait_for_timeout(1200)
                mood = page.evaluate("() => { const e=document.querySelector('#tabManju .manju-mood, #tabManju [id], #tabManju'); return document.body.innerText.indexOf('지수 종가베팅 점수') !== -1; }")
                data_len = page.evaluate("() => Object.keys((window.MANJU_DATA||{}).stocks||{}).length")
                page.screenshot(path=os.path.join(OUT, f"manju_{tag}.png"))
                try:
                    page.eval_on_selector("#tabManju .mj-screener-card", "el => el.scrollIntoView({block:'start'})")
                    page.wait_for_timeout(400)
                    page.screenshot(path=os.path.join(OUT, f"manju_cards_{tag}.png"))
                except Exception as e:
                    print('manju scroll skip', e)
                if tag == "400":
                    check(mood is True, "만쥬 탭 지수 종가베팅/하방 점수 카드")
                    check(data_len >= 5, "MANJU_DATA 상세 데이터 로드", data_len)
                # 카드 클릭 → 상세 팝업
                clicked = page.evaluate("""() => {
                  const c = document.querySelector('#tabManju .mj-screener-card[data-manju-code]');
                  if (!c) return null;
                  c.click();
                  return c.getAttribute('data-manju-code');
                }""")
                page.wait_for_timeout(1200)
                modal_open = page.evaluate("() => { const m=document.getElementById('manjuDetailModal'); return m ? getComputedStyle(m).display : 'none'; }")
                modal_txt = page.evaluate("() => { const b=document.getElementById('mjdBody'); return b? b.innerText.replace(/\\n+/g,' | ') : null; }")
                page.screenshot(path=os.path.join(OUT, f"manju_modal_{tag}.png"))
                if tag == "400":
                    check(clicked is not None, "만쥬 스크리너 카드 클릭 대상", clicked)
                    check(modal_open == "block", "만쥬 상세 팝업 열림", modal_open)
                    for seg in ("①", "오늘 상승 이유", "②", "캔들 상태", "③", "외인", "④", "시장분위기", "⑤", "20일"):
                        check(bool(modal_txt) and seg in modal_txt, f"팝업 항목 포함: {seg}", (modal_txt or "")[:60])
                page.evaluate("() => { if (window.ManjuDetail) ManjuDetail.close(); }")
                # 최종 후보 카드(한진칼)도 같은 상세 팝업으로 열리는지
                f_clicked = page.evaluate("""() => {
                  const c = document.querySelector('#tabManju .manju-item[data-manju-code="180640"]');
                  if (!c) return null; c.click(); return c.getAttribute('data-manju-code');
                }""")
                page.wait_for_timeout(1200)
                f_title = page.evaluate("() => { const t=document.getElementById('mjdTitle'); return t? t.innerText : ''; }")
                page.screenshot(path=os.path.join(OUT, f"manju_final_modal_{tag}.png"))
                if tag == "400":
                    check(f_clicked == "180640" and "한진칼" in (f_title or ""), "만쥬 최종 후보(한진칼) 클릭 → 상세 팝업", f_title)
                page.evaluate("() => { if (window.ManjuDetail) ManjuDetail.close(); }")
                ctx.close()
            b.close()
    finally:
        srv.terminate()

    errs = [l for l in logs if "console.error" in l or "pageerror" in l]
    check(len(errs) == 0, "콘솔 오류 0", errs[:4])
    print("\n--- 결과:", len(oks), "통과 /", len(fails), "실패")
    if fails:
        print("실패:", fails)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
