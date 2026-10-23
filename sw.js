'use strict';

const CACHE_NAME = 'kedolaka-market-v2';
const OFFLINE_PAGE = '/offline.html';
const PRECACHE_URLS = [
  '/',
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
      fetch(request).then(function (response) {
        const contentType = response.headers.get('content-type') || '';
        if (response.ok && contentType.includes('text/html')) {
          const pageRequest = new Request(url.origin + url.pathname);
          const cachePage = caches.open(CACHE_NAME).then(function (cache) {
            return cache.put(pageRequest, response.clone());
          }).catch(function (error) {
            console.error('Could not cache this page for offline viewing:', error);
          });
          event.waitUntil(cachePage);
        }
        return response;
      }).catch(async function () {
        const pageRequest = new Request(url.origin + url.pathname);
        return (await caches.match(pageRequest)) || caches.match(OFFLINE_PAGE);
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
