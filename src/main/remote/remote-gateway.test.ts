import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { request as httpsRequest } from 'node:https'
import { RemoteGateway, type GatewayHandlers } from './remote-gateway'
import { createLanTransport, type TransportEvent } from '../../renderer/lib/remote/transport'

const SECRET = 'shared-peer-secret'

async function makeGateway(
  secret: string | null = SECRET,
  overrides: Partial<ConstructorParameters<typeof RemoteGateway>[0]> = {}
): Promise<{
  gateway: RemoteGateway
  port: number
  localPort: number
  sessions: boolean[]
  staticRoot: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codeinoven-gateway-'))
  const staticRoot = join(dir, 'renderer')
  const certificateDir = join(dir, 'cert')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(staticRoot, { recursive: true })
  await writeFile(join(staticRoot, 'remote.html'), '<h1>phone client</h1>', 'utf8')
  await writeFile(join(staticRoot, 'manifest.webmanifest'), '{"name":"test"}', 'utf8')
  await writeFile(join(staticRoot, 'service-worker.js'), 'self.onfetch=()=>{}', 'utf8')

  const sessions: boolean[] = []
  const handlers: GatewayHandlers = {
    onSessionChange: (live) => sessions.push(live)
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
  const { port, localPort } = await gateway.start()
  return { gateway, port, localPort, sessions, staticRoot }
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

function httpsGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: '127.0.0.1', port, path, rejectUnauthorized: false },
      (response) => {
        let body = ''
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
      }
    )
    request.on('error', reject)
    request.end()
  })
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

      const assets = await httpsGet(port, '/assets/app-something.js')
      expect(assets.status).toBe(404)

      const pwaAsset = await httpsGet(port, '/assets/remote-abc123.js')
      expect(pwaAsset.status).toBe(404) // not present in the fixture tree
    } finally {
      await gateway.stop()
    }
  })

  it('accepts a loopback WebSocket session with the correct PEER_SECRET_AUTH', async () => {
    const { gateway, localPort, sessions } = await makeGateway()
    try {
      const events: TransportEvent[] = []
      const transport = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        onEvent: (event) => events.push(event)
      })
      const result = await transport.connect()
      expect(result).toBe('open')
      expect(sessions).toContain(true)

      await transport.send(JSON.stringify({ type: 'ping' }))
      await waitForMessage(events, JSON.stringify({ type: 'pong' }))

      transport.close()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(sessions[sessions.length - 1]).toBe(false)
    } finally {
      await gateway.stop()
    }
  })

  it('rejects a WebSocket session with a wrong PEER_SECRET_AUTH', async () => {
    const { gateway, localPort, sessions } = await makeGateway()
    try {
      const transport = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: 'wrong-secret',
        scheme: 'ws',
        onEvent: () => undefined
      })
      const result = await transport.connect()
      expect(result).toBe('rejected')
      expect(sessions).not.toContain(true)
    } finally {
      await gateway.stop()
    }
  })

  it('enforces single-session takeover: a second live peer is rejected', async () => {
    const { gateway, localPort, sessions } = await makeGateway()
    try {
      const first = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        onEvent: () => undefined
      })
      await expect(first.connect()).resolves.toBe('open')

      const second = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        onEvent: () => undefined
      })
      await expect(second.connect()).resolves.toBe('rejected')

      // Exactly one live transition despite two handshakes.
      expect(sessions.filter((live) => live)).toHaveLength(1)

      first.close()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(sessions[sessions.length - 1]).toBe(false)
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
    const { gateway, localPort, sessions } = await makeGateway()
    try {
      const transport = createLanTransport({
        peer: { host: '127.0.0.1', port: localPort },
        authSecret: SECRET,
        scheme: 'ws',
        onEvent: () => undefined
      })
      await expect(transport.connect()).resolves.toBe('open')
      expect(sessions).toContain(true)
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

  it('exposes a QR pairing URL that embeds the peer secret', async () => {
    const { gateway } = await makeGateway()
    try {
      const info = gateway.info()
      expect(info.pairingUrl).toMatch(/^https:\/\/.+:\d+\/remote\.html\?pair=/)
      expect(info.pairingUrl).toContain(encodeURIComponent(SECRET))
      expect(info.url).not.toContain('pair=')
    } finally {
      await gateway.stop()
    }
  })

  it('omits the QR pairing URL while the gateway is not listening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-gateway-nolisten-'))
    const gateway = new RemoteGateway({
      port: 0,
      localPort: 0,
      peerSecret: SECRET,
      certificateDir: join(dir, 'cert'),
      staticRoot: join(dir, 'renderer'),
      handlers: { onSessionChange: () => undefined }
    })
    expect(gateway.info().pairingUrl).toBeNull()
    expect(gateway.info().url).toBeNull()
  })
})
