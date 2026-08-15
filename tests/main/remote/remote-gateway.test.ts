import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { request as httpsRequest } from 'node:https'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { RemoteGateway, type GatewayHandlers } from '../../../src/main/remote/remote-gateway'
import { createLanTransport, type TransportEvent } from '../../../src/renderer/lib/remote/transport'
import {
  createMemoryDeviceKeyStore,
  loadOrCreateDeviceKeyMaterial
} from '../../../src/renderer/lib/remote/device-identity'
import {
  DeviceCredentialService,
  type EnrolledDevice
} from '../../../src/main/remote/device-credential-service'
import DatabaseConstructor from 'better-sqlite3'
import type { Database } from '../../../src/main/database/database'
import { REMOTE_DEVICE_SQL } from '../../../src/main/database/schema'
import type { RemoteDeviceInfo } from '../../../src/main/remote/remote-types'

const SECRET = 'shared-peer-secret'

function makeRawDatabase(): Database {
  const raw = new DatabaseConstructor(':memory:')
  raw.pragma('foreign_keys = ON')
  raw.exec(REMOTE_DEVICE_SQL)
  const prepared = raw.prepare.bind(raw)
  return {
    run: (sql: string, ...params: unknown[]) => {
      prepared(sql).run(...params)
    },
    get: <T>(sql: string, ...params: unknown[]) => prepared(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]) => prepared(sql).all(...params) as T[],
    prepare: (sql: string) => ({
      run: (...params: unknown[]) => prepared(sql).run(...params)
    }),
    transaction: <T>(fn: () => T) => raw.transaction(fn)()
  } as unknown as Database
}

function deviceInfo(device: EnrolledDevice): RemoteDeviceInfo {
  return {
    id: device.deviceId,
    name: device.name,
    connectedAt: device.lastUsedAt ?? device.createdAt,
    transport: device.lastTransport,
    connected: true,
    scopes: device.scopes,
    fingerprint: device.publicKeyFingerprint,
    lastUsedAt: device.lastUsedAt,
    expiresAt: device.expiresAt,
    credentialExpiresAt: device.credentialExpiresAt,
    revokedAt: device.revokedAt,
    authVersion: device.authVersion,
    allProjects: device.allProjects,
    projectIds: device.projectIds
  }
}

async function makeGateway(
  secret: string | null = SECRET,
  overrides: Partial<ConstructorParameters<typeof RemoteGateway>[0]> = {},
  beforeStart?: (staticRoot: string, certificateDir: string) => Promise<void> | void
): Promise<{
  gateway: RemoteGateway
  port: number
  localPort: number
  devices: RemoteDeviceInfo[][]
  staticRoot: string
  certificateDir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codeinoven-gateway-'))
  const staticRoot = join(dir, 'renderer')
  const certificateDir = join(dir, 'cert')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(staticRoot, { recursive: true })
  await writeFile(join(staticRoot, 'remote.html'), '<h1>phone client</h1>', 'utf8')
  await writeFile(join(staticRoot, 'manifest.webmanifest'), '{"name":"test"}', 'utf8')
  await writeFile(join(staticRoot, 'service-worker.js'), 'self.onfetch=()=>{}', 'utf8')
  const devices: RemoteDeviceInfo[][] = []
  const handlers: GatewayHandlers = {
    onDevicesChange: (next) => devices.push(next)
  }
  const gateway = new RemoteGateway({
    port: 0,
    localPort: 0,
    peerSecret: secret,
    certificateDir,
    staticRoot,
    handlers,
    ...overrides
  })
  if (beforeStart) await beforeStart(staticRoot, certificateDir)
  const { port, localPort } = await gateway.start()
  return { gateway, port, localPort, devices, staticRoot, certificateDir }
}

function waitForMessage(events: TransportEvent[], data: string, timeoutMs = 3_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const poll = (): void => {
      if (events.some((event) => event.kind === 'message' && event.data === data)) {
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for message "${data}"`))
        return
      }
      setTimeout(poll, 10)
    }
    poll()
  })
}

function httpsGet(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{
  status: number
  body: string
  headers?: Record<string, string | string[] | undefined>
}> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: '127.0.0.1', port, path, headers, rejectUnauthorized: false },
      (response) => {
        let body = ''
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
        })
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers })
        )
      }
    )
    request.on('error', reject)
    request.end()
  })
}

function httpsGetRaw(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{
  status: number
  body: Buffer
  headers: Record<string, string | string[] | undefined>
}> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: '127.0.0.1', port, path, headers, rejectUnauthorized: false },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
            headers: response.headers
          })
        )
      }
    )
    request.on('error', reject)
    request.end()
  })
}

function gunzipBuffer(data: Buffer): Buffer {
  return gunzipSync(data)
}

function brotliDecompressBuffer(data: Buffer): Buffer {
  return brotliDecompressSync(data)
}

function rawHandshake(
  port: number,
  headers: Record<string, string>,
  secure = false
): Promise<{ status: string; socket: Socket | TLSSocket }> {
  return new Promise((resolve, reject) => {
    const attachResponseReader = (socket: Socket | TLSSocket): void => {
      let buffer = ''
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('latin1')
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd !== -1) {
          resolve({ status: buffer.slice(0, buffer.indexOf('\r\n')), socket })
        }
      })
      socket.on('error', reject)
    }
    const sendUpgrade = (socket: Socket | TLSSocket): void => {
      const lines = [
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket'
      ]
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    }
    if (secure) {
      const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () =>
        sendUpgrade(socket)
      )
      attachResponseReader(socket)
    } else {
      const socket = netConnect({ host: '127.0.0.1', port }, () => sendUpgrade(socket))
      attachResponseReader(socket)
    }
  })
}

describe('RemoteGateway', () => {
  it('serves the PWA over HTTPS with a self-signed certificate', async () => {
    const { gateway, port } = await makeGateway()
    try {
      const page = await httpsGet(port, '/remote.html')
      expect(page.status).toBe(200)
      expect(page.body).toBe('<h1>phone client</h1>')

      const manifest = await httpsGet(port, '/manifest.webmanifest')
      expect(manifest.status).toBe(200)

      const worker = await httpsGet(port, '/service-worker.js')
      expect(worker.status).toBe(200)
    } finally {
      await gateway.stop()
    }
  })

  it('serves only allow-listed PWA assets — never the whole renderer bundle', async () => {
    const { gateway, port, staticRoot } = await makeGateway()
    try {
      await writeFile(join(staticRoot, 'index.html'), '<h1>desktop app</h1>', 'utf8')
      await writeFile(join(staticRoot, 'secrets.txt'), 'nope', 'utf8')

      const index = await httpsGet(port, '/index.html')
      expect(index.status).toBe(404)

      const secret = await httpsGet(port, '/secrets.txt')
      expect(secret.status).toBe(404)

      // A Vite-shared chunk that the PWA does not reference is never served.
      const assets = await httpsGet(port, '/assets/app-something.js')
      expect(assets.status).toBe(404)
    } finally {
      await gateway.stop()
    }
  })

  it('serves the PWA asset closure from remote.html (code-split shared chunks)', async () => {
    const { gateway, port } = await makeGateway(SECRET, {}, async (root) => {
      // Mimic a Vite build: remote.html references an entry chunk that imports
      // a shared chunk plus a stylesheet — all hashed, unrelated names.
      await writeFile(
        join(root, 'remote.html'),
        '<script type="module" src="./assets/remote-abc123.js"></script>' +
          '<link rel="stylesheet" href="./assets/app-shared123.css">',
        'utf8'
      )
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root, 'assets'), { recursive: true })
      await writeFile(
        join(root, 'assets', 'remote-abc123.js'),
        'import { mount } from "./app-shared123.js"; void mount;',
        'utf8'
      )
      await writeFile(
        join(root, 'assets', 'app-shared123.js'),
        'export const mount = () => undefined;',
        'utf8'
      )
      await writeFile(join(root, 'assets', 'app-shared123.css'), 'body { color: black; }', 'utf8')
    })
    try {
      const entry = await httpsGet(port, '/assets/remote-abc123.js')
      expect(entry.status).toBe(200)
      expect(entry.body).toContain('import')

      const shared = await httpsGet(port, '/assets/app-shared123.js')
      expect(shared.status).toBe(200)
      expect(shared.body).toContain('export const mount')

      const css = await httpsGet(port, '/assets/app-shared123.css')
      expect(css.status).toBe(200)
      expect(css.headers?.['content-type']).toContain('text/css')

      // A chunk never referenced by the PWA stays blocked.
      const other = await httpsGet(port, '/assets/other-unrelated.js')
      expect(other.status).toBe(404)
    } finally {
      await gateway.stop()
    }
  })

  it('serves gzip-compressed assets with correct headers and an intact body', async () => {
    const { gateway, port } = await makeGateway(SECRET, {}, async (root) => {
      await writeFile(
        join(root, 'remote.html'),
        '<script type="module" src="./assets/remote-abc123.js"></script>',
        'utf8'
      )
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root, 'assets'), { recursive: true })
      await writeFile(
        join(root, 'assets', 'remote-abc123.js'),
        'export const phrase = "compressed-asset-body";',
        'utf8'
      )
    })
    try {
      const raw = await httpsGetRaw(port, '/assets/remote-abc123.js', {
        'Accept-Encoding': 'gzip'
      })
      expect(raw.status).toBe(200)
      expect(raw.headers['content-encoding']).toBe('gzip')
      expect(raw.headers['vary']).toBe('Accept-Encoding')
      expect(Number(raw.headers['content-length'])).toBe(raw.body.length)
      expect(gunzipBuffer(raw.body).toString('utf8')).toContain('compressed-asset-body')
    } finally {
      await gateway.stop()
    }
  })

  it('serves brotli-compressed assets when br is advertised', async () => {
    const { gateway, port } = await makeGateway(SECRET, {}, async (root) => {
      await writeFile(
        join(root, 'remote.html'),
        '<script type="module" src="./assets/remote-abc123.js"></script>',
        'utf8'
      )
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root, 'assets'), { recursive: true })
      await writeFile(
        join(root, 'assets', 'remote-abc123.js'),
        'export const phrase = "brotli-compressed-asset-body";',
        'utf8'
      )
    })
    try {
      const raw = await httpsGetRaw(port, '/assets/remote-abc123.js', {
        'Accept-Encoding': 'br, gzip'
      })
      expect(raw.status).toBe(200)
      expect(raw.headers['content-encoding']).toBe('br')
      expect(brotliDecompressBuffer(raw.body).toString('utf8')).toContain(
        'brotli-compressed-asset-body'
      )
    } finally {
      await gateway.stop()
    }
  })

  it('serves hashed assets with immutable caching and a repeat 304', async () => {
    const { gateway, port } = await makeGateway(SECRET, {}, async (root) => {
      await writeFile(
        join(root, 'remote.html'),
        '<script type="module" src="./assets/remote-abc123.js"></script>',
        'utf8'
      )
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root, 'assets'), { recursive: true })
      await writeFile(join(root, 'assets', 'remote-abc123.js'), 'export default 1;', 'utf8')
    })
    try {
      const first = await httpsGet(port, '/assets/remote-abc123.js')
      expect(first.status).toBe(200)
      expect(first.headers?.['cache-control']).toBe('public, max-age=31536000, immutable')
      const etag = first.headers?.['etag']
      expect(etag).toBeTruthy()

      const repeat = await httpsGet(port, '/assets/remote-abc123.js', {
        'If-None-Match': etag as string
      })
      expect(repeat.status).toBe(304)
      expect(repeat.body).toBe('')
      expect(repeat.headers?.['etag']).toBe(etag)
    } finally {
      await gateway.stop()
    }
  })

  it('serves mutable shell endpoints with no-store and never immutable', async () => {
    const { gateway, port, staticRoot } = await makeGateway(SECRET, {}, async (root) => {
      await writeFile(
        join(root, 'remote.html'),
        '<script type="module" src="./assets/remote-abc123.js"></script>',
        'utf8'
      )
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root, 'assets'), { recursive: true })
      await writeFile(join(root, 'assets', 'remote-abc123.js'), 'export default 1;', 'utf8')
      await writeFile(join(root, 'manifest.webmanifest'), '{"name":"test"}', 'utf8')
    })
    try {
      const html = await httpsGet(port, '/remote.html')
      expect(html.headers?.['cache-control']).toBe('no-store')
      expect(html.headers?.['cache-control']).not.toContain('immutable')

      const manifest = await httpsGet(port, '/manifest.webmanifest')
      expect(manifest.headers?.['cache-control']).toBe('no-store')
      expect(manifest.headers?.['cache-control']).not.toContain('immutable')

      // A mutable public asset (agent icon) is never immutable.
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(staticRoot, 'assets/agents'), { recursive: true })
      await writeFile(join(staticRoot, 'assets/agents/openai.svg'), '<svg/>', 'utf8')
      const icon = await httpsGet(port, '/assets/agents/openai.svg')
      expect(icon.headers?.['cache-control']).toBe('no-store')
    } finally {
      await gateway.stop()
    }
  })

  it('serves a generated service worker and precache manifest from the asset graph', async () => {
    const { gateway, port } = await makeGateway(SECRET, {}, async (root) => {
      await writeFile(
        join(root, 'remote.html'),
        '<script type="module" src="./assets/remote-abc123.js"></script>',
        'utf8'
      )
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root, 'assets'), { recursive: true })
      await writeFile(join(root, 'assets', 'remote-abc123.js'), 'export default 1;', 'utf8')
      // A realistic service-worker template: the gateway injects the precache
      // manifest and a build version into the placeholders before serving.
      await writeFile(
        join(root, 'service-worker.js'),
        'const PRECACHE_MANIFEST = /*__PRECACHE_MANIFEST__*/[];\n' +
          'const PRECACHE_VERSION = /*__PRECACHE_VERSION__*/"dev";\n',
        'utf8'
      )
    })
    try {
      const worker = await httpsGet(port, '/service-worker.js')
      expect(worker.status).toBe(200)
      expect(worker.headers?.['cache-control']).toBe('no-store')
      // The precache manifest is injected by the gateway.
      expect(worker.body).toContain('/remote.html')
      expect(worker.body).toContain('/assets/remote-abc123.js')
      expect(worker.body).toContain('PRECACHE_VERSION')

      const manifest = await httpsGet(port, '/precache-manifest.json')
      expect(manifest.status).toBe(200)
      const parsed = JSON.parse(manifest.body) as { urls: string[] }
      expect(parsed.urls).toContain('/remote.html')
      expect(parsed.urls).toContain('/assets/remote-abc123.js')
    } finally {
      await gateway.stop()
    }
  })

  it('accepts a loopback WebSocket session with the correct PEER_SECRET_AUTH', async () => {
    const { gateway, localPort, devices } = await makeGateway()
    try {
      const events: TransportEvent[] = []
      const transport = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        deviceId: 'phone-1',
        deviceName: 'iPhone',
        onEvent: (event) => events.push(event)
      })
      const result = await transport.connect()
      expect(result).toBe('open')
      expect(devices[devices.length - 1]?.some((device) => device.id === 'phone-1')).toBe(true)

      await transport.send(JSON.stringify({ type: 'ping' }))
      await waitForMessage(events, JSON.stringify({ type: 'pong' }))

      transport.close()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(devices[devices.length - 1]?.some((device) => device.id === 'phone-1')).toBe(false)
    } finally {
      await gateway.stop()
    }
  })

  it('rejects a WebSocket session with a wrong PEER_SECRET_AUTH', async () => {
    const { gateway, localPort, devices } = await makeGateway()
    try {
      const transport = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: 'wrong-secret',
        scheme: 'ws',
        deviceId: 'phone-1',
        deviceName: 'iPhone',
        onEvent: () => undefined
      })
      const result = await transport.connect()
      expect(result).toBe('rejected')
      expect(devices.every((snapshot) => snapshot.length === 0)).toBe(true)
    } finally {
      await gateway.stop()
    }
  })

  it('allows multiple simultaneous phone devices', async () => {
    const { gateway, localPort, devices } = await makeGateway()
    try {
      const first = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        deviceId: 'phone-1',
        deviceName: 'iPhone',
        onEvent: () => undefined
      })
      await expect(first.connect()).resolves.toBe('open')

      const second = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        deviceId: 'phone-2',
        deviceName: 'Android phone',
        onEvent: () => undefined
      })
      await expect(second.connect()).resolves.toBe('open')

      const live = gateway.listDevices()
      expect(live.map((device) => device.id).sort()).toEqual(['phone-1', 'phone-2'])
      expect(live.map((device) => device.name).sort()).toEqual(['Android phone', 'iPhone'])

      // Both stay live when the first disconnects.
      first.close()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(gateway.listDevices().map((device) => device.id)).toEqual(['phone-2'])
      expect(devices[devices.length - 1]?.some((device) => device.id === 'phone-2')).toBe(true)

      second.close()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(gateway.listDevices()).toEqual([])
    } finally {
      await gateway.stop()
    }
  })

  it('takes over a reconnect from the same device id', async () => {
    const { gateway, localPort } = await makeGateway()
    try {
      const first = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        deviceId: 'phone-1',
        deviceName: 'iPhone',
        onEvent: () => undefined
      })
      await expect(first.connect()).resolves.toBe('open')

      const second = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        deviceId: 'phone-1',
        deviceName: 'iPhone',
        onEvent: () => undefined
      })
      await expect(second.connect()).resolves.toBe('open')

      // Exactly one live device for the shared id — the old socket was replaced.
      const live = gateway.listDevices()
      expect(live).toHaveLength(1)
      expect(live[0]?.id).toBe('phone-1')
      expect(live[0]?.name).toBe('iPhone')

      first.close()
      second.close()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(gateway.listDevices()).toEqual([])
    } finally {
      await gateway.stop()
    }
  })

  it('disconnects a specific device on request', async () => {
    const { gateway, localPort } = await makeGateway()
    try {
      const first = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        deviceId: 'phone-1',
        deviceName: 'iPhone',
        onEvent: () => undefined
      })
      await expect(first.connect()).resolves.toBe('open')

      const second = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        deviceId: 'phone-2',
        deviceName: 'Android phone',
        onEvent: () => undefined
      })
      await expect(second.connect()).resolves.toBe('open')

      expect(gateway.disconnectDevice('phone-1')).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(gateway.listDevices().map((device) => device.id)).toEqual(['phone-2'])

      // Unknown ids are a no-op.
      expect(gateway.disconnectDevice('ghost')).toBe(false)
      second.close()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(gateway.listDevices()).toEqual([])
    } finally {
      await gateway.stop()
    }
  })

  it('rejects upgrades with a wrong Sec-WebSocket-Version', async () => {
    const { gateway, localPort } = await makeGateway()
    try {
      const { status } = await rawHandshake(localPort, {
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '8'
      })
      expect(status).toContain('400 Bad Request')
    } finally {
      await gateway.stop()
    }
  })

  it('rejects upgrades from a foreign origin', async () => {
    const { gateway, localPort } = await makeGateway()
    try {
      const { status } = await rawHandshake(localPort, {
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        Origin: 'https://evil.example.test'
      })
      expect(status).toContain('403 Forbidden')
    } finally {
      await gateway.stop()
    }
  })

  it('accepts a null-origin (desktop renderer) upgrade', async () => {
    const { gateway, localPort, devices } = await makeGateway()
    try {
      const transport = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        deviceId: 'phone-1',
        deviceName: 'iPhone',
        onEvent: () => undefined
      })
      await expect(transport.connect()).resolves.toBe('open')
      expect(gateway.listDevices().some((device) => device.id === 'phone-1')).toBe(true)
      expect(devices[devices.length - 1]?.length).toBeGreaterThan(0)
    } finally {
      await gateway.stop()
    }
  })

  it('evicts unauthenticated peers after a short timeout', async () => {
    const { gateway, localPort } = await makeGateway(SECRET, { unauthenticatedTimeoutMs: 50 })
    try {
      const { status, socket } = await rawHandshake(localPort, {
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13'
      })
      expect(status).toContain('101 Switching Protocols')

      await new Promise<void>((resolve) => {
        socket.on('close', () => resolve())
        setTimeout(resolve, 300) // failsafe if close does not fire
      })
      expect(socket.destroyed || socket.readableEnded).toBe(true)
    } finally {
      await gateway.stop()
    }
  })

  it('stops cleanly after a rejected handshake (no double-end)', async () => {
    const { gateway, localPort } = await makeGateway()
    const transport = createLanTransport({
      peer: { host: '127.0.0.1', port: localPort },
      authSecret: 'wrong-secret',
      scheme: 'ws',
      onEvent: () => undefined
    })
    await expect(transport.connect()).resolves.toBe('rejected')
    await expect(gateway.stop()).resolves.toBeUndefined()
  })

  it('accepts the production file:// origin on the loopback listener', async () => {
    const { gateway, localPort } = await makeGateway()
    try {
      const { status } = await rawHandshake(localPort, {
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        Origin: 'file://'
      })
      expect(status).toContain('101 Switching Protocols')
    } finally {
      await gateway.stop()
    }
  })

  it('accepts the dev-server http://localhost origin on the loopback listener', async () => {
    const { gateway, localPort } = await makeGateway()
    try {
      const { status } = await rawHandshake(localPort, {
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        Origin: 'http://localhost:5173'
      })
      expect(status).toContain('101 Switching Protocols')
    } finally {
      await gateway.stop()
    }
  })

  it('keeps the LAN-exposed HTTPS listener strict against file:// origins', async () => {
    const { gateway, port } = await makeGateway()
    try {
      const { status } = await rawHandshake(
        port,
        {
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          Origin: 'file://'
        },
        true
      )
      expect(status).toContain('403 Forbidden')
    } finally {
      await gateway.stop()
    }
  })

  it('serves the self-signed certificate at /cert.pem for iOS trust profiles', async () => {
    const { gateway, port } = await makeGateway()
    try {
      const cert = await httpsGet(port, '/cert.pem')
      expect(cert.status).toBe(200)
      expect(cert.body).toContain('BEGIN CERTIFICATE')
    } finally {
      await gateway.stop()
    }
  })

  it('renders IPv6 PWA URLs in bracketed host form using advertised gateway metadata', async () => {
    const { gateway, port, certificateDir } = await makeGateway()
    try {
      await writeFile(
        join(certificateDir, 'meta.json'),
        JSON.stringify({ hosts: ['2001:db8::2'] }),
        'utf8'
      )
      const info = gateway.info()
      expect(port).toBeGreaterThan(0)
      expect(info.url).toContain('https://[2001:db8::2]:')
    } finally {
      await gateway.stop()
    }
  })

  it('omits the PWA URL while the gateway is not listening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-gateway-nolisten-'))
    const gateway = new RemoteGateway({
      port: 0,
      localPort: 0,
      peerSecret: SECRET,
      certificateDir: join(dir, 'cert'),
      staticRoot: join(dir, 'renderer'),
      handlers: { onDevicesChange: () => undefined }
    })
    expect(gateway.info().url).toBeNull()
  })

  it('routes RPC invokes to the handler and delivers results back to the peer', async () => {
    const received: string[] = []
    const { gateway, localPort } = await makeGateway(SECRET, {
      handlers: {
        onDevicesChange: () => undefined,
        onRpc: async (channel, args) => {
          received.push(`${channel}:${args.join(',')}`)
          return { ok: true, result: { echo: channel } }
        }
      }
    })
    try {
      const events: TransportEvent[] = []
      const transport = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        onEvent: (event) => events.push(event)
      })
      await expect(transport.connect()).resolves.toBe('open')
      await transport.send(
        JSON.stringify({ rpc: 'invoke', id: 7, channel: 'thread:listAll', args: [] })
      )

      await new Promise<void>((resolve, reject) => {
        const started = Date.now()
        const poll = (): void => {
          const frame = events.find(
            (event) => event.kind === 'message' && event.data.includes('"rpc":"result"')
          )
          if (frame && frame.kind === 'message') {
            const parsed = JSON.parse(frame.data) as {
              rpc: string
              id: number
              result: { echo: string }
            }
            expect(parsed.rpc).toBe('result')
            expect(parsed.id).toBe(7)
            expect(parsed.result.echo).toBe('thread:listAll')
            resolve()
            return
          }
          if (Date.now() - started > 3_000) {
            reject(new Error('Timed out waiting for the RPC result'))
            return
          }
          setTimeout(poll, 10)
        }
        poll()
      })
      expect(received).toEqual(['thread:listAll:'])
      transport.close()
    } finally {
      await gateway.stop()
    }
  })

  it('delivers forwarded events to the live peer via sendToPeer', async () => {
    const { gateway, localPort } = await makeGateway(SECRET, {
      handlers: { onDevicesChange: () => undefined }
    })
    try {
      const events: TransportEvent[] = []
      const transport = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        onEvent: (event) => events.push(event)
      })
      await expect(transport.connect()).resolves.toBe('open')

      gateway.sendToPeer({ rpc: 'event', channel: 'thread:updated', payload: { id: 't1' } })

      await new Promise<void>((resolve, reject) => {
        const started = Date.now()
        const poll = (): void => {
          const frame = events.find(
            (event) => event.kind === 'message' && event.data.includes('"rpc":"event"')
          )
          if (frame && frame.kind === 'message') {
            const parsed = JSON.parse(frame.data) as {
              rpc: string
              channel: string
              payload: { id: string }
            }
            expect(parsed.channel).toBe('thread:updated')
            expect(parsed.payload.id).toBe('t1')
            resolve()
            return
          }
          if (Date.now() - started > 3_000) {
            reject(new Error('Timed out waiting for the forwarded event'))
            return
          }
          setTimeout(poll, 10)
        }
        poll()
      })
      transport.close()
    } finally {
      await gateway.stop()
    }
  })
})

describe('RemoteGateway — device proof of possession (A-04)', () => {
  it('enrolls a phone from a single-use bootstrap and authenticates its reconnect by signature', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-gateway-pop-'))
    const staticRoot = join(dir, 'renderer')
    const certificateDir = join(dir, 'cert')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(staticRoot, { recursive: true })
    await writeFile(join(staticRoot, 'remote.html'), '<h1>phone client</h1>', 'utf8')

    const db = makeRawDatabase()
    const service = new DeviceCredentialService(db)
    const bootstrap = await service.createPairingBootstrap()

    const devices: RemoteDeviceInfo[][] = []
    let lastAuthReason: string | null = null
    const gateway = new RemoteGateway({
      port: 0,
      localPort: 0,
      peerSecret: SECRET,
      certificateDir,
      staticRoot,
      handlers: {
        onDevicesChange: (next) => devices.push(next),
        authenticateDevice: async ({
          signature,
          transcript,
          bootstrap: presentedBootstrap,
          signingPublicJwk,
          agreementPublicJwk,
          authVersion,
          deviceId,
          deviceName
        }) => {
          if (!signature || !transcript) return { accepted: false }
          if (presentedBootstrap && signingPublicJwk && agreementPublicJwk) {
            const outcome = await service.enrollDevice({
              bootstrapValue: presentedBootstrap,
              name: deviceName,
              signingPublicJwk,
              agreementPublicJwk,
              signingProof: signature,
              proofTranscript: transcript,
              transport: 'lan'
            })
            if (!outcome.ok || !outcome.device) {
              lastAuthReason = outcome.reason ?? 'enroll-failed'
              return { accepted: false }
            }
            return { accepted: true, device: deviceInfo(outcome.device) }
          }
          if (deviceId && typeof authVersion === 'number') {
            const result = await service.authenticateDevice({
              deviceId,
              authVersion,
              transcript,
              signature,
              transport: 'lan'
            })
            if (!result.ok || !result.device) {
              lastAuthReason = result.reason ?? 'auth-failed'
              return { accepted: false }
            }
            return { accepted: true, device: deviceInfo(result.device) }
          }
          lastAuthReason = 'missing-fields'
          return { accepted: false }
        }
      }
    })
    try {
      const { localPort } = await gateway.start()

      // First connection: the phone presents its public keys + bootstrap + a
      // signature proving it owns the signing key. The desktop assigns the id.
      const keyMaterial = await loadOrCreateDeviceKeyMaterial({
        store: createMemoryDeviceKeyStore()
      })
      let assignedId = ''
      const first = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: bootstrap.value,
        pairingBootstrap: bootstrap.value,
        scheme: 'ws',
        device: {
          deviceId: keyMaterial.deviceId,
          deviceName: keyMaterial.deviceName,
          authVersion: keyMaterial.authVersion,
          signingKey: keyMaterial.signingKey,
          signingPublicJwk: keyMaterial.signingPublicJwk,
          agreementPublicJwk: keyMaterial.agreementPublicJwk
        },
        onAssignedDevice: (deviceId) => {
          assignedId = deviceId
        },
        onEvent: () => undefined
      })
      const firstResult = await first.connect()
      expect({ firstResult, lastAuthReason }).toEqual({ firstResult: 'open', lastAuthReason: null })
      expect(assignedId.length).toBeGreaterThan(0)
      expect(service.listDevices()).toHaveLength(1)

      // The bootstrap is single-use — a second enrollment with it fails.
      const second = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: bootstrap.value,
        pairingBootstrap: bootstrap.value,
        scheme: 'ws',
        device: {
          deviceId: keyMaterial.deviceId,
          deviceName: keyMaterial.deviceName,
          authVersion: keyMaterial.authVersion,
          signingKey: keyMaterial.signingKey,
          signingPublicJwk: keyMaterial.signingPublicJwk,
          agreementPublicJwk: keyMaterial.agreementPublicJwk
        },
        onEvent: () => undefined
      })
      await expect(second.connect()).resolves.toBe('rejected')
      first.close()
      second.close()

      // Reconnect: the enrolled phone proves possession of its signing key.
      const reconnect = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        device: {
          deviceId: assignedId,
          deviceName: keyMaterial.deviceName,
          authVersion: 1,
          signingKey: keyMaterial.signingKey,
          signingPublicJwk: keyMaterial.signingPublicJwk,
          agreementPublicJwk: keyMaterial.agreementPublicJwk
        },
        onEvent: () => undefined
      })
      lastAuthReason = null
      const reconnectResult = await reconnect.connect()
      expect({ reconnectResult, lastAuthReason }).toEqual({
        reconnectResult: 'open',
        lastAuthReason: null
      })
      expect(gateway.listDevices().some((device) => device.id === assignedId)).toBe(true)
      reconnect.close()
    } finally {
      await gateway.stop()
    }
  })
})
