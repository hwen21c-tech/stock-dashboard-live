/* ============================================================
   쇼츠 스튜디오 PRO — 전용 서비스워커 (/shorts-editor.html 전용)
   · 관제탑 sw.js(scope '/')와 섞이지 않도록 이 페이지에서만
     scope:'/shorts-editor.html' 로 좁게 등록한다.
   · 규칙: 화면(HTML)은 네트워크 우선(항상 최신), 실패하면 캐시된 셸.
           API(/api/*)는 절대 가로채지 않고 그대로 통과.
   · 오프라인 셸: 편집기 화면 + 매니페스트 + 아이콘만 담는다.
   ============================================================ */
const PREFIX = 'shorts-studio-';
const VERSION = PREFIX + 'v1';
const SHELL = [
  '/shorts-editor.html',
  '/manifest-shorts.json',
  '/icons/shorts-192.png',
  '/icons/shorts-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // 하나가 실패해도 나머지는 담는다(첫 설치가 통째로 깨지지 않게)
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

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // 외부 CDN·폰트는 브라우저에 맡긴다
  if (url.pathname.startsWith('/api/')) return;         // 서버 API 는 항상 실시간 통과

  // 편집기 화면: 네트워크 우선 → 실패 시 캐시 셸
  if (req.mode === 'navigate' || url.pathname === '/shorts-editor.html') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        const cache = await caches.open(VERSION);
        cache.put('/shorts-editor.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch (_) {
        const cached = await caches.match('/shorts-editor.html');
        if (cached) return cached;
        return new Response('오프라인 상태입니다. 네트워크에 연결한 뒤 다시 열어 주세요.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // 나머지 정적 파일: 캐시 우선(stale-while-revalidate)
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
