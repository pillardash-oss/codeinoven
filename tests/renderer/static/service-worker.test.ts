import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

const BASE = 'https://remote.test/'
const SW_PATH = join(process.cwd(), 'src/renderer/static/service-worker.js')

function normalize(input: string): string {
  return new URL(input, BASE).href
}

function requestUrl(input: string | { url: string }): string {
  return typeof input === 'string' ? input : input.url
}

/** Deterministic in-memory network: set routes, toggle offline. */
class MockNetwork {
  private responses = new Map<string, Response>()
  offline = false

  set(url: string, body: string, contentType = 'text/plain', status = 200): void {
    this.responses.set(
      normalize(url),
      new Response(body, { status, headers: { 'Content-Type': contentType } })
    )
  }

  setStatus(url: string, status: number): void {
    this.responses.set(normalize(url), new Response('', { status }))
  }

  async fetch(input: string | { url: string }): Promise<Response> {
    if (this.offline) throw new TypeError('Failed to fetch')
    const hit = this.responses.get(normalize(requestUrl(input)))
    if (!hit) return new Response('Not Found', { status: 404 })
    return hit.clone()
  }
}

/** Minimal Cache object matching the Cache API surface the worker uses. */
class MockCache {
  private entries = new Map<string, Response>()

  constructor(private readonly network: MockNetwork) {}

  async addAll(urls: string[]): Promise<void> {
    for (const url of urls) {
      const response = await this.network.fetch(url)
      if (!response.ok) throw new Error(`addAll failed: ${url} (${response.status})`)
      this.entries.set(normalize(url), response.clone())
    }
  }

  async put(request: string | { url: string }, response: Response): Promise<void> {
    this.entries.set(normalize(requestUrl(request)), response.clone())
  }

  async match(request: string | { url: string }): Promise<Response | undefined> {
    const hit = this.entries.get(normalize(requestUrl(request)))
    return hit ? hit.clone() : undefined
  }

  async delete(request: string | { url: string }): Promise<boolean> {
    return this.entries.delete(normalize(requestUrl(request)))
  }

  has(url: string): boolean {
    return this.entries.has(normalize(url))
  }
}

/** Minimal CacheStorage mirroring the surface the worker uses. */
class MockCacheStorage {
  private caches = new Map<string, MockCache>()

  constructor(private readonly network: MockNetwork) {}

  async open(name: string): Promise<MockCache> {
    let cache = this.caches.get(name)
    if (!cache) {
      cache = new MockCache(this.network)
      this.caches.set(name, cache)
    }
    return cache
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()]
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name)
  }

  async match(request: string | { url: string }): Promise<Response | undefined> {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(request)
      if (hit) return hit
    }
    return undefined
  }

  names(): string[] {
    return [...this.caches.keys()]
  }

  get(name: string): MockCache | undefined {
    return this.caches.get(name)
  }
}

interface FetchRequest {
  url: string
  method?: string
  mode?: string
}

interface WorkerHarness {
  install(): Promise<void>
  activate(): Promise<void>
  fetch(req: FetchRequest): Promise<Response | undefined>
  skipWaitingCalled(): boolean
  cacheNames(): string[]
  hasCached(cacheName: string, url: string): boolean
  caches: MockCacheStorage
  network: MockNetwork
}

/** Load the real service-worker source with the gateway's placeholder injection. */
function loadWorker(opts: {
  manifest: string[]
  version: string
  network: MockNetwork
  storage?: MockCacheStorage
}): WorkerHarness {
  const source = readFileSync(SW_PATH, 'utf8')
  const injected = source
    .replace('/*__PRECACHE_MANIFEST__*/[]', JSON.stringify(opts.manifest))
    .replace('/*__PRECACHE_VERSION__*/"dev"', JSON.stringify(opts.version))

  const listeners: Record<string, Array<(event: Record<string, unknown>) => void>> = {}
  let skipWaitingCalled = false
  const caches = opts.storage ?? new MockCacheStorage(opts.network)

  const sandbox: Record<string, unknown> = {
    caches,
    fetch: (input: string | { url: string }) => opts.network.fetch(input),
    Response,
    URL,
    Headers,
    location: { origin: new URL(BASE).origin, pathname: '/service-worker.js' },
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void): void => {
      listeners[type] = listeners[type] ?? []
      listeners[type].push(fn)
    },
    skipWaiting: (): void => {
      skipWaitingCalled = true
    },
    clients: {
      claim: async (): Promise<void> => undefined,
      matchAll: async (): Promise<unknown[]> => [],
      openWindow: async (): Promise<unknown> => undefined
    }
  }
  sandbox.self = sandbox
  runInNewContext(injected, sandbox)

  return {
    install(): Promise<void> {
      let promise: Promise<void> = Promise.resolve()
      const handler = listeners['install'][0]
      handler({ waitUntil: (p: Promise<void>) => (promise = p) })
      return promise
    },
    activate(): Promise<void> {
      let promise: Promise<void> = Promise.resolve()
      const handler = listeners['activate'][0]
      handler({ waitUntil: (p: Promise<void>) => (promise = p) })
      return promise
    },
    fetch(req: FetchRequest): Promise<Response | undefined> {
      let promise: Promise<Response> | undefined
      const request = { url: req.url, method: req.method ?? 'GET', mode: req.mode ?? 'cors' }
      const handler = listeners['fetch'][0]
      handler({ request, respondWith: (p: Promise<Response>) => (promise = p) })
      return Promise.resolve(promise)
    },
    skipWaitingCalled: () => skipWaitingCalled,
    cacheNames: () => caches.names(),
    hasCached: (cacheName: string, url: string) => caches.get(cacheName)?.has(url) ?? false,
    caches,
    network: opts.network
  }
}
describe('service worker lifecycle', () => {
  it('precaches a verifiably complete shell and serves it offline after first install', async () => {
    const network = new MockNetwork()
    network.set('/remote.html', '<h1>shell</h1>', 'text/html')
    network.set('/manifest.webmanifest', '{}', 'application/manifest+json')
    network.set('/assets/entry-abc.js', 'export default 1;', 'text/javascript')

    const worker = loadWorker({
      manifest: ['/remote.html', '/manifest.webmanifest', '/assets/entry-abc.js'],
      version: 'v1',
      network
    })

    await worker.install()
    expect(worker.skipWaitingCalled()).toBe(true)
    expect(worker.cacheNames()).toEqual(['codeinoven-remote-shell-v1'])
    expect(worker.hasCached('codeinoven-remote-shell-v1', '/remote.html')).toBe(true)
    expect(worker.hasCached('codeinoven-remote-shell-v1', '/manifest.webmanifest')).toBe(true)
    expect(worker.hasCached('codeinoven-remote-shell-v1', '/assets/entry-abc.js')).toBe(true)
    expect(worker.hasCached('codeinoven-remote-shell-v1', './__sw_shell_meta__')).toBe(true)

    network.offline = true

    const navigation = await worker.fetch({
      url: 'https://remote.test/remote.html',
      mode: 'navigate'
    })
    expect(navigation).toBeDefined()
    expect(navigation!.status).toBe(200)
    expect(await navigation!.text()).toBe('<h1>shell</h1>')

    const asset = await worker.fetch({ url: 'https://remote.test/assets/entry-abc.js' })
    expect(asset).toBeDefined()
    expect(asset!.status).toBe(200)
    expect(await asset!.text()).toBe('export default 1;')
  })

  it('keeps the previous-good shell and never activates when an update install is interrupted', async () => {
    const network = new MockNetwork()
    network.set('/remote.html', '<h1>v1</h1>', 'text/html')
    network.set('/assets/entry-abc.js', 'export default 1;', 'text/javascript')

    const v1 = loadWorker({
      manifest: ['/remote.html', '/assets/entry-abc.js'],
      version: 'v1',
      network
    })
    await v1.install()
    await v1.activate()
    expect(v1.skipWaitingCalled()).toBe(true)
    expect(v1.cacheNames()).toEqual(['codeinoven-remote-shell-v1'])

    // Rebuild references a chunk the desktop no longer serves: install fails.
    const updateNetwork = new MockNetwork()
    updateNetwork.set('/remote.html', '<h1>v2</h1>', 'text/html')
    updateNetwork.setStatus('/assets/gone-abc.js', 404)

    const v2 = loadWorker({
      manifest: ['/remote.html', '/assets/gone-abc.js'],
      version: 'v2',
      network: updateNetwork
    })
    await expect(v2.install()).rejects.toThrow()
    expect(v2.skipWaitingCalled()).toBe(false)

    // The old shell is untouched and still serves offline.
    expect(v1.cacheNames()).toEqual(['codeinoven-remote-shell-v1'])
    expect(
      await v1.fetch({ url: 'https://remote.test/remote.html', mode: 'navigate' })
    ).toBeDefined()
  })

  it('retains the current shell plus exactly one actual previous-good shell', async () => {
    const network = new MockNetwork()
    const storage = new MockCacheStorage(network)
    network.set('/remote.html', '<h1>v1</h1>', 'text/html')
    const v1 = loadWorker({ manifest: ['/remote.html'], version: '1', network, storage })
    await v1.install()
    await v1.activate()
    expect(v1.cacheNames()).toEqual(['codeinoven-remote-shell-1'])

    network.set('/remote.html', '<h1>v2</h1>', 'text/html')
    const v2 = loadWorker({ manifest: ['/remote.html'], version: '2', network, storage })
    await v2.install()
    await v2.activate()
    expect(v2.cacheNames().sort()).toEqual([
      'codeinoven-remote-shell-1',
      'codeinoven-remote-shell-2'
    ])

    network.set('/remote.html', '<h1>v3</h1>', 'text/html')
    const v3 = loadWorker({ manifest: ['/remote.html'], version: '3', network, storage })
    await v3.install()
    await v3.activate()
    expect(v3.cacheNames().sort()).toEqual([
      'codeinoven-remote-shell-2',
      'codeinoven-remote-shell-3'
    ])
    expect(v3.cacheNames()).not.toContain('codeinoven-remote-shell-1')
  })

  it('retains the actual previous-good shell regardless of cache-name ordering', async () => {
    const network = new MockNetwork()
    const storage = new MockCacheStorage(network)
    // Install "b" first, then "a". Lexicographically a < b, so a name-sorted
    // "previous" would keep "b" again; sequence-based retention must keep the
    // real predecessor "a" once "c" activates.
    network.set('/remote.html', '<h1>b</h1>', 'text/html')
    const b = loadWorker({ manifest: ['/remote.html'], version: 'b', network, storage })
    await b.install()
    await b.activate()

    network.set('/remote.html', '<h1>a</h1>', 'text/html')
    const a = loadWorker({ manifest: ['/remote.html'], version: 'a', network, storage })
    await a.install()
    await a.activate()

    network.set('/remote.html', '<h1>c</h1>', 'text/html')
    const c = loadWorker({ manifest: ['/remote.html'], version: 'c', network, storage })
    await c.install()
    await c.activate()

    expect(c.cacheNames().sort()).toEqual([
      'codeinoven-remote-shell-a',
      'codeinoven-remote-shell-c'
    ])
    expect(c.cacheNames()).not.toContain('codeinoven-remote-shell-b')
  })

  it('never caches private or mutable endpoints', async () => {
    const network = new MockNetwork()
    network.set('/remote.html', '<h1>shell</h1>', 'text/html')
    const worker = loadWorker({ manifest: ['/remote.html'], version: 'v1', network })
    await worker.install()

    const bypassed = await worker.fetch({ url: 'https://remote.test/v1/session' })
    expect(bypassed).toBeUndefined()
    const manifest = await worker.fetch({ url: 'https://remote.test/precache-manifest.json' })
    expect(manifest).toBeUndefined()
  })
})
