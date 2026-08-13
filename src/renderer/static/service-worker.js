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
 * Upgrades are safe. The new shell is precached **atomically**: any failed
 * fetch rejects the install promise, so the browser keeps the previous-good
 * service worker and its shell; `skipWaiting` runs only after every precache
 * entry is present and verified. Each shell cache records an install-sequence
 * metadata entry, so `activate` retains the current shell plus the **actual
 * previous-good shell** (the most recently installed predecessor) and prunes
 * everything older — no cache-name ordering assumptions. Only successful
 * responses are cached — caching a 404 would poison the cache and keep
 * replaying that failure.
 */
const PRECACHE_MANIFEST = /*__PRECACHE_MANIFEST__*/[]
const PRECACHE_VERSION = /*__PRECACHE_VERSION__*/"dev"
const CACHE_PREFIX = 'codeinoven-remote-shell-'
const CACHE_NAME = CACHE_PREFIX + PRECACHE_VERSION
const SHELL_META_KEY = './__sw_shell_meta__'
const CORE_ASSETS = ['./remote.html', './manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(installShell().then(() => self.skipWaiting()))
})

/**
 * Precache the disconnected shell and mark the cache complete.
 *
 * The whole operation is atomic: `cache.addAll` rejects when any request fails
 * or returns a non-OK status, and `verifyShell` re-checks every entry, so a
 * partially written shell rejects the install promise before `skipWaiting` can
 * run. The meta entry records an install sequence (max existing sequence + 1)
 * that `activate` uses to keep the actual previous-good shell.
 */
async function installShell() {
  const manifest = PRECACHE_MANIFEST.length > 0 ? PRECACHE_MANIFEST : CORE_ASSETS
  const cache = await caches.open(CACHE_NAME)
  await cache.addAll(manifest)
  await verifyShell(cache, manifest)
  const sequence = await nextInstallSequence()
  await cache.put(
    SHELL_META_KEY,
    new Response(JSON.stringify({ sequence, version: PRECACHE_VERSION }), {
      headers: { 'Content-Type': 'application/json' }
    })
  )
}

/** Throw unless every precache URL is stored with an OK response. */
async function verifyShell(cache, urls) {
  const results = await Promise.all(
    urls.map(async (url) => {
      const response = await cache.match(url)
      return Boolean(response && response.ok)
    })
  )
  if (results.some((ok) => !ok)) throw new Error('precache incomplete')
}

/** Read the install-sequence meta from a shell cache, if present. */
async function readShellMeta(cache) {
  try {
    const response = await cache.match(SHELL_META_KEY)
    if (!response) return null
    return await response.json()
  } catch {
    return null
  }
}

/** Next monotonic install sequence across every existing shell cache. */
async function nextInstallSequence() {
  const keys = await caches.keys()
  let max = 0
  for (const key of keys) {
    if (!key.startsWith(CACHE_PREFIX)) continue
    const cache = await caches.open(key)
    const meta = await readShellMeta(cache)
    if (meta && typeof meta.sequence === 'number' && meta.sequence > max) {
      max = meta.sequence
    }
  }
  return max + 1
}

self.addEventListener('activate', (event) => {
  event.waitUntil(activateShell())
})

/**
 * Retain the current (verified-complete) shell plus the actual previous-good
 * shell — the one with the highest install sequence among the other shell
 * caches — and delete everything older. This keeps retention bounded to two
 * caches and never relies on cache-name lexicographic order.
 */
async function activateShell() {
  const keys = await caches.keys()
  const shellKeys = keys.filter((key) => key.startsWith(CACHE_PREFIX))
  const keep = new Set([CACHE_NAME])

  let previousGood = null
  let previousSequence = -1
  for (const key of shellKeys) {
    if (key === CACHE_NAME) continue
    const cache = await caches.open(key)
    const meta = await readShellMeta(cache)
    if (meta && typeof meta.sequence === 'number' && meta.sequence > previousSequence) {
      previousSequence = meta.sequence
      previousGood = key
    }
  }
  if (previousGood) keep.add(previousGood)

  await Promise.all(
    keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key))
  )
  await self.clients.claim()
}

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
      return self.clients.openWindow('/')
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
