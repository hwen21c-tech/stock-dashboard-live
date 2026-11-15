// Service Worker for Yeonolang Stock Dashboard PWA (Live Real-time Force Network)
const CACHE_NAME = 'yeonolang-terminal-v25';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      // 포켓몬 배틀 월드(/pokemon/, 접두사 pkm-world-)와 eBook(/ebook/, 접두사 ebook-reader-)의
      // 오프라인 캐시는 건드리지 않는다 — 각각 독립 앱.
      return Promise.all(keys.filter((key) => !key.startsWith('pkm-world-') && !key.startsWith('ebook-reader-')).map((key) => caches.delete(key)));
    }).then(() => self.clients.claim())
  );
});

// ALWAYS NETWORK-FIRST & NO CACHE FOR HTML
self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate' || e.request.url.includes('index.html') || e.request.url.includes('deals.html')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
