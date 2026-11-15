#!/usr/bin/env node
/**
 * 인라인 <script> 구문 검사기
 *
 *   node check-inline.mjs public/index.html public/ebook.html ...
 *
 * index.html 처럼 HTML 안에 JS 를 직접 넣는 파일은 `node --check` 로 잡히지 않는다.
 * (11/12 캔들 쉼표 오타로 관제탑 JS 가 통째로 멈춘 사고의 재발 방지용)
 * <script src> 는 대상에서 빼고, type 이 javascript/module 인 블록만 검사한다.
 */
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('사용법: node check-inline.mjs <html 파일...>');
  process.exit(2);
}

let bad = 0;
let total = 0;

for (const file of files) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`✗ ${file} — 파일을 읽지 못했습니다 (${e.message})`);
    bad++;
    continue;
  }

  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(src))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const tm = /type\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const type = tm ? tm[1].toLowerCase() : '';
    if (type && !/javascript|ecmascript|^module$/.test(type)) continue;
    n++;
    total++;
    try {
      // 컴파일만 한다(실행하지 않음) — SyntaxError 면 즉시 던진다
      new Script(m[2], { filename: `${file}#inline${n}` });
    } catch (e) {
      bad++;
      console.error(`✗ ${file} inline#${n} — ${e.message}`);
    }
  }
  console.log(`· ${file} — 인라인 스크립트 ${n}개 검사`);
}

if (bad) {
  console.error(`\n❌ 구문 오류 ${bad}건 / 검사 ${total}블록`);
  process.exit(1);
}
console.log(`\n✅ 인라인 JS 구문 검사 통과 (${total}블록)`);
