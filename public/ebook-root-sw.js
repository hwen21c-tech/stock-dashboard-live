/* ============================================================
   연오랑 eBook 오디오북 — 독립 도메인용 루트 서비스워커
   · 이 파일은 독립 eBook 도메인(예: yeonolang-ebook.vercel.app)에서만 등록된다.
     (scope '/', Service-Worker-Allowed '/' 헤더 — vercel.json)
   · 관제탑 도메인의 /sw.js (scope: '/') 와는 오리진이 달라 섞이지 않는다.
   · 캐시 이름은 /ebook/sw.js 와 같은 ebook-reader- 접두사를 쓴다.
   ============================================================ */
const PREFIX = 'ebook-reader-';
const VERSION = PREFIX + 'root-v1';
const SHELL = [
  '/',
  '/ebook.html',
  '/ebook-standalone-manifest.json',
  '/ebook-icon.svg',
  '/ebook-icon-192.png',
  '/ebook-icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // 하나가 실패해도 나머지는 담는다 (첫 설치가 통째로 깨지지 않게)
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // 음성 API 는 그대로 통과

  event.respondWith((async () => {
    const cache = await caches.open(VERSION).catch(() => null);
    try {
      // 화면(HTML)은 항상 최신, 나머지는 브라우저 기본 캐시 정책
      const res = await fetch(req, req.mode === 'navigate' ? { cache: 'no-store' } : undefined);
      if (cache && res && res.ok && res.type === 'basic') {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      if (cache) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
      }
      throw err;
    }
  })());
});
