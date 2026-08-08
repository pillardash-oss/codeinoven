/**
 * CodeInOven Remote — service worker.
 *
 * Classic worker that keeps the installable phone client working offline.
 *
 * The gateway injects the build-time asset graph into this file when it serves
 * it: the `PRECACHE_MANIFEST` and `PRECACHE_VERSION` placeholder constants below
 * are replaced with the current precache list and a build fingerprint. Every
 * production rebuild changes the hashed chunk names in `remote.html`, so the
 * precache list and version are regenerated on each serve. In development the
 * raw template is served with an empty precache and a `"dev"` version.
 *
 * Caching is split by request kind, because the two have opposite requirements:
 *
 * - **Navigations / `remote.html`** are served **network-first**. Every desktop
 *   rebuild rewrites the HTML with freshly hashed chunk names, so a cache-first
 *   shell keeps asking for asset hashes that no longer exist. Those requests
 *   404, the entry's dynamic import rejects, and the phone shows a blank page
 *   that reloading cannot fix. Network-first picks a rebuild up on the next
 *   load, and the cached copy still answers when the desktop is unreachable.
 * - **Hashed `/assets/...` files** stay cache-first, which is safe precisely
 *   because the hash changes whenever the content does.
 *
 * Upgrades are safe because the precache version changes with the build: the
 * new shell is written to a fresh cache while `activate` retains **one bounded
 * previous-good shell** for fallback when the newest build is interrupted or
 * cannot be fetched. Only successful responses are cached — caching a 404 would
 * poison the cache and keep replaying that failure.
 */
const PRECACHE_MANIFEST = /*__PRECACHE_MANIFEST__*/[]
const PRECACHE_VERSION = /*__PRECACHE_VERSION__*/"dev"
const CACHE_PREFIX = 'codeinoven-remote-shell-'
const CACHE_NAME = CACHE_PREFIX + PRECACHE_VERSION
const CORE_ASSETS = ['./remote.html', './manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(PRECACHE_MANIFEST.length > 0 ? PRECACHE_MANIFEST : CORE_ASSETS)
      )
      .catch(() => undefined)
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        const shellKeys = keys
          .filter((key) => key.startsWith(CACHE_PREFIX))
          .sort()
        // Retain the current shell plus exactly one bounded previous-good shell.
        // Anything older than the immediate predecessor is removed so upgrades
        // never accumulate unbounded caches while an interrupted update still
        // has a working shell to fall back to.
        const keep = new Set([CACHE_NAME])
        const previous = shellKeys.filter((key) => key !== CACHE_NAME).pop()
        if (previous) keep.add(previous)
        return Promise.all(
          keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key))
        )
      })
      .then(() => self.clients.claim())
  )
})

/**
 * A tapped phone notification focuses the client and asks it to open the
 * thread. The desktop pushes `notification:show` over the bridge and the page
 * posts it through the service worker, so `notificationclick` runs here; the
 * page listens for the `notification:open` message to route to the thread.
 */
self.addEventListener('notificationclick', (event) => {
  const notification = event.notification
  const data = notification.data || {}
  notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.focus()
          if (data.projectId && data.threadId) {
            client.postMessage({
              type: 'notification:open',
              projectId: data.projectId,
              threadId: data.threadId
            })
          }
          return
        }
      }
      return self.clients.openWindow('./remote.html')
    })
  )
})

/** Cache a successful response without blocking the response handed back. */
function cacheSuccess(request, response) {
  if (!response || !response.ok || response.type === 'opaque') return
  const copy = response.clone()
  caches
    .open(CACHE_NAME)
    .then((cache) => cache.put(request, copy))
    .catch(() => undefined)
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Account, desktop, and connection responses may contain private state or a
  // desktop control secret. They must always go to the network and must never
  // enter Cache Storage or be replayed after sign-out/revocation. The precache
  // manifest is mutable version metadata, never cached either.
  if (
    url.pathname.startsWith('/v1/') ||
    url.pathname === '/healthz' ||
    url.pathname === '/precache-manifest.json'
  ) {
    return
  }

  const isShell = request.mode === 'navigate' || url.pathname.endsWith('/remote.html')

  if (isShell) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          cacheSuccess(request, response)
          return response
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached || caches.match('./remote.html'))
            .then(
              (cached) =>
                cached ||
                new Response('Desktop unreachable. Reconnect and reload.', {
                  status: 503,
                  headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                })
            )
        )
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request)
        .then((response) => {
          cacheSuccess(request, response)
          return response
        })
        .catch(() => Response.error())
    })
  )
})
