#!/usr/bin/env node
/**
 * 로컬 미리보기 서버 (Vercel 없이 동적 앱을 그대로 띄워보는 용도)
 *   node dev_server.mjs          → http://localhost:8787
 *   PORT=9000 node dev_server.mjs
 *
 * /api/* 는 Vercel 서버리스 핸들러를 그대로 호출하고, 나머지는 public/ 정적 파일을 서빙한다.
 * (배포에는 쓰이지 않는 개발 편의 스크립트)
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

const api = {
  '/api/stock-live': require('./api/stock-live.js'),
  '/api/tabs-live': require('./api/tabs-live.js'),
  '/api/live-briefing': require('./api/live-briefing.js'),
  '/api/stock-chart': require('./api/stock-chart.js'),
  '/api/deals-shopping': require('./api/deals-shopping.js'),
  '/api/dart-live': require('./api/dart-live.js'),
  '/api/index-chart': require('./api/index-chart.js'),
  '/api/macro-live': require('./api/macro-live.js'),
  '/api/econ-calendar': require('./api/econ-calendar.js'),
  '/api/stock-trend': require('./api/stock-trend.js'),
  '/api/tts': require('./api/tts.js'),
  '/api/content-studio': require('./api/content-studio.js'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  const handler = api[pathname];
  if (handler) {
    try {
      await handler(req, res);
    } catch (e) {
      console.error('[api error]', pathname, e);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, reason: 'unhandled', message: e.message }));
      }
    }
    console.log(`${req.method} ${req.url} → ${res.statusCode}`);
    return;
  }

  const rel = pathname === '/' ? '/index.html' : pathname;
  const toDisk = (r) => path.join(__dirname, 'public', path.normalize(r).replace(/^(\.\.[/\\])+/, ''));

  // vercel.json 의 `/pokemon/` rewrite 를 로컬에서도 똑같이 흉내낸다.
  // (실제 파일이 먼저 — public/pokemon/manifest.json · sw.js 는 그대로 서빙)
  const candidates = [rel];
  if (pathname === '/pokemon' || pathname === '/pokemon/') {
    candidates.push('/pokemon-battle.html');
  } else if (pathname.startsWith('/pokemon/')) {
    candidates.push('/' + pathname.slice('/pokemon/'.length));
  }
  // vercel.json 의 `/ebook` · `/ebook/` rewrite 를 로컬에서도 똑같이 흉내낸다.
  // (실제 파일이 먼저 — public/ebook/manifest.json · sw.js 는 그대로 서빙)
  if (pathname === '/ebook' || pathname === '/ebook/') {
    candidates.push('/ebook.html');
  }

  let filePath = null;
  let buf = null;
  for (const cand of candidates) {
    try {
      buf = await readFile(toDisk(cand));
      filePath = toDisk(cand);
      break;
    } catch (e) { /* 다음 후보 */ }
  }
  try {
    if (!buf) throw new Error('not found');
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
    console.log(`${req.method} ${req.url} → 200 (static)`);
  } catch (e) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('404 Not Found');
    console.log(`${req.method} ${req.url} → 404`);
  }
});

server.listen(PORT, () => {
  console.log(`동적 앱 로컬 미리보기: http://localhost:${PORT}`);
  console.log('종료: Ctrl+C');
});
