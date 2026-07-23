const CACHE_NAME = 'dokodemo-nauru-v53';
const STATIC_SHELL = [
  './index.html',
  './game/index.html',
  './game/game.css',
  './game/game.js',
  './game/ranking-config.js',
  './privacy.html',
  './manifest.webmanifest',
  './data/game-places.json',
  './data/place-administrative-areas.json',
  './nauru_kun_outline.png',
  './assets/dokodemo-nauru-logo-transparent-v3.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

const NETWORK_FIRST_PATHS = new Set([
  './index.html',
  './game/index.html',
  './game/game.css',
  './game/game.js',
  './game/ranking-config.js',
  './privacy.html',
  './manifest.webmanifest',
  './data/game-places.json',
  './data/place-administrative-areas.json',
  './data/gsi-area-r8-04.json',
  './data/natural-features.geojson',
  './data/attractions.geojson',
  './data/countries.geojson',
  './data/jp-city-1995.topojson'
].map(path => new URL(path, self.registration.scope).pathname));

function stableCacheRequest(requestUrl, navigation) {
  let url;
  if (navigation) {
    const scopePath = new URL(self.registration.scope).pathname;
    const relativePath = requestUrl.pathname.slice(scopePath.length);
    const gameNavigation = relativePath === 'game' || relativePath === 'game/' || relativePath === 'game/index.html';
    url = new URL(gameNavigation ? './game/index.html' : './index.html', self.registration.scope);
  } else {
    url = new URL(requestUrl.pathname, requestUrl.origin);
  }
  return new Request(url.toString(), { method: 'GET' });
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(STATIC_SHELL.map(async path => {
      const url = new URL(path, self.registration.scope);
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (response.ok) await cache.put(url.toString(), response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  const navigation = event.request.mode === 'navigate';
  const networkFirst = navigation || NETWORK_FIRST_PATHS.has(requestUrl.pathname);
  const cacheKey = stableCacheRequest(requestUrl, navigation);

  if (networkFirst) {
    event.respondWith((async () => {
      try {
        const response = await fetch(new Request(event.request, { cache: 'no-store' }));
        if (response && response.ok) {
          const cache = await caches.open(CACHE_NAME);
          event.waitUntil(cache.put(cacheKey, response.clone()));
        }
        return response;
      } catch (_) {
        return (await caches.match(cacheKey)) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response && response.ok) {
        const cache = await caches.open(CACHE_NAME);
        event.waitUntil(cache.put(event.request, response.clone()));
      }
      return response;
    } catch (_) {
      return Response.error();
    }
  })());
});
