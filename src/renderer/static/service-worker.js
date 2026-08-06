/**
 * CodeInOven Remote — service worker.
 *
 * Classic worker that keeps the installable phone client working offline
 * without ever pinning it to a stale build.
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
 * Only successful responses are cached — caching a 404 would poison the cache
 * and keep replaying that failure.
 */
const CACHE_NAME = 'codeinoven-remote-v2'
const CORE_ASSETS = ['./remote.html', './manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(() => undefined)
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
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
