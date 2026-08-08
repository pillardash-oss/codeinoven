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
const CACHE_NAME = 'codeinoven-remote-v3'
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
  // enter Cache Storage or be replayed after sign-out/revocation.
  if (url.pathname.startsWith('/v1/') || url.pathname === '/healthz') return

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
