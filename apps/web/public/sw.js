const CACHE_NAME = '__WEBSSH_CACHE_NAME__';
const BUILD_VERSION = '__WEBSSH_BUILD_VERSION__';
const PRECACHE_ASSETS = ['./manifest.webmanifest', './offline.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && k.startsWith('webssh-studio-shell'))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data.type === 'CLEAR_ASSET_CACHE') {
    event.waitUntil(
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((k) => k.startsWith('webssh-studio-shell')).map((k) => caches.delete(k))
          )
        )
        .then(() => {
          if (event.source && typeof event.source.postMessage === 'function') {
            event.source.postMessage({ type: 'ASSET_CACHE_CLEARED', version: BUILD_VERSION });
          }
        })
    );
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const accept = event.request.headers.get('accept') || '';
  const isHtmlNavigation =
    event.request.mode === 'navigate' ||
    event.request.destination === 'document' ||
    accept.includes('text/html') ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html');

  // Network-first with no-cache revalidation for HTML navigation so index.html and hashed bundles never mismatch.
  if (isHtmlNavigation) {
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then((networkRes) => {
          if (networkRes && networkRes.ok) {
            const copy = networkRes.clone();
            caches
              .open(CACHE_NAME)
              .then((cache) => {
                void cache.put(event.request, copy);
                void cache.put('./index.html', copy.clone());
              })
              .catch(() => undefined);
          }
          return networkRes;
        })
        .catch(() =>
          caches
            .match(event.request)
            .then((cached) => cached || caches.match('./index.html') || caches.match('./offline.html'))
        )
    );
    return;
  }

  // Network-first for static assets with offline cache fallback; never cache 404 or HTML error responses for JS/CSS.
  event.respondWith(
    fetch(event.request)
      .then((networkRes) => {
        if (networkRes && networkRes.ok) {
          const contentType = (networkRes.headers.get('content-type') || '').toLowerCase();
          const isScriptOrStyle =
            url.pathname.endsWith('.js') ||
            url.pathname.endsWith('.css') ||
            event.request.destination === 'script' ||
            event.request.destination === 'style';
          const isUnexpectedHtml = isScriptOrStyle && contentType.includes('text/html');
          if (!isUnexpectedHtml) {
            const copy = networkRes.clone();
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(event.request, copy))
              .catch(() => undefined);
          }
        }
        return networkRes;
      })
      .catch(() => caches.match(event.request))
  );
});
