/**
 * SiliconBeest Service Worker
 * Handles: Web Push notifications, app shell caching, offline navigation fallback
 */

/* eslint-env serviceworker */

const CACHE_NAME = 'siliconbeest-v1';

// Paths that should never be cached (API, federation, auth, etc.)
const NO_CACHE_PREFIXES = [
  '/api/',
  '/oauth/',
  '/.well-known/',
  '/nodeinfo',
  '/users/',
  '/actor',
  '/inbox',
  '/media/',
  '/proxy',
  '/internal/',
  '/auth/',
  '/healthz',
];

function shouldNotCache(url) {
  const path = new URL(url).pathname;
  return NO_CACHE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isNavigationRequest(request) {
  return request.mode === 'navigate';
}

function isStaticAsset(url) {
  return /\.(js|css|woff2?|ttf|eot|png|jpg|jpeg|gif|svg|ico|webp|avif)(\?.*)?$/.test(url);
}

// ─── Install: cache the app shell (index.html) ───
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        '/',
        '/manifest.json',
      ]);
    }).then(() => self.skipWaiting()),
  );
});

// ─── Activate: clean old caches, claim all clients immediately ───
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
    }).then(() => self.clients.claim()),
  );
});

// ─── Fetch: network-first for navigations with app shell fallback,
//     stale-while-revalidate for static assets ───
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip API and other dynamic paths
  if (shouldNotCache(request.url)) return;

  // Navigation requests: network-first with offline fallback to cached index.html
  if (isNavigationRequest(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache the latest index.html
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/', clone));
          return response;
        })
        .catch(() => {
          // Offline: serve cached app shell — Vue Router handles the route client-side
          return caches.match('/');
        }),
    );
    return;
  }

  // Static assets: stale-while-revalidate
  if (isStaticAsset(request.url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(request).then((cached) => {
          const fetchPromise = fetch(request)
            .then((response) => {
              if (response.ok) {
                cache.put(request, response.clone());
              }
              return response;
            })
            .catch(() => cached);

          return cached || fetchPromise;
        });
      }),
    );
    return;
  }
});

// ─── Web Push notifications ───
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'New notification', body: event.data?.text() || '' };
  }

  const title = data.title || 'SiliconBeest';
  const options = {
    body: data.body || '',
    icon: data.icon || '/pwa-icon/192.png',
    badge: data.badge || '/pwa-icon/192.png',
    tag: data.notification_id || undefined,
    data: {
      url: data.url || '/',
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    }),
  );
});

// ─── Message handling for cache updates ───
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
