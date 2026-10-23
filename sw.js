'use strict';

const CACHE_NAME = 'kedolaka-market-v1';
const OFFLINE_PAGE = '/offline.html';
const PRECACHE_URLS = [
  OFFLINE_PAGE,
  '/site.webmanifest',
  '/css/styles.css',
  '/css/market-theme.css',
  '/css/home.css',
  '/js/app-launch.js',
  '/js/marketplace.js',
  '/assets/kedolaka-market-icon.svg',
  '/assets/kedolaka-market-compact.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE_URLS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.filter(function (name) {
          return name.startsWith('kedolaka-market-') && name !== CACHE_NAME;
        }).map(function (name) { return caches.delete(name); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match(OFFLINE_PAGE);
      })
    );
    return;
  }

  if (!/^\/(?:css|js|assets)\//.test(url.pathname) && url.pathname !== '/site.webmanifest') return;
  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      const cached = cache.match(request);
      const update = fetch(request).then(function (response) {
        if (response.ok) cache.put(request, response.clone());
        return response;
      }).catch(function () { return Response.error(); });
      return cached.then(function (response) { return response || update; });
    })
  );
});
