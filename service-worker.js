const CACHE_NAME = 'dokodemo-nauru-v29';
const APP_SHELL = [
  './',
  './index.html',
  './privacy.html',
  './manifest.webmanifest',
  './nauru_kun_outline.png',
  './assets/dokodemo-nauru-logo-transparent-v3.png',
  './data/gsi-area-r8-04.json',
  './data/natural-features.geojson',
  './data/attractions.geojson',
  './data/countries.geojson',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];
const NETWORK_FIRST_PATHS = new Set([
  './index.html',
  './privacy.html',
  './manifest.webmanifest',
  './data/gsi-area-r8-04.json',
  './data/natural-features.geojson',
  './data/attractions.geojson',
  './data/countries.geojson',
  './data/jp-city-1995.topojson'
].map(path => new URL(path, self.location.href).pathname));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys
      .filter(key => key !== CACHE_NAME)
      .map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  const useNetworkFirst = event.request.mode === 'navigate' || NETWORK_FIRST_PATHS.has(requestUrl.pathname);

  const fetchAndCache = () => fetch(event.request).then(response => {
    if (!response || !response.ok) return response;
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)));
    return response;
  });

  if (useNetworkFirst) {
    event.respondWith(fetchAndCache().catch(() =>
      caches.match(event.request).then(cached => cached ||
        (event.request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
    ));
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetchAndCache().catch(() => {
      if (event.request.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    }))
  );
});
