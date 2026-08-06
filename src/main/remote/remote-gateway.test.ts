import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteGateway, type GatewayHandlers } from './remote-gateway'
import { createLanTransport, type TransportEvent } from '../../renderer/lib/remote/transport'

const SECRET = 'shared-peer-secret'

async function makeGateway(secret: string | null = SECRET): Promise<{
  gateway: RemoteGateway
  port: number
  sessions: boolean[]
  staticRoot: string
}> {
  const staticRoot = await mkdtemp(join(tmpdir(), 'codeinoven-gateway-'))
  await writeFile(join(staticRoot, 'remote.html'), '<h1>phone client</h1>', 'utf8')
  const sessions: boolean[] = []
  const handlers: GatewayHandlers = {
    onSessionChange: (live) => sessions.push(live)
  }
  const gateway = new RemoteGateway({
    port: 0,
    peerSecret: secret,
    staticRoot,
    handlers
  })
  const port = await gateway.start()
  return { gateway, port, sessions, staticRoot }
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

describe('RemoteGateway', () => {
  it('serves the phone client PWA over HTTP', async () => {
    const { gateway, port } = await makeGateway()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/remote.html`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('<h1>phone client</h1>')
    } finally {
      await gateway.stop()
    }
  })

  it('accepts a LAN WebSocket session with the correct PEER_SECRET_AUTH', async () => {
    const { gateway, port, sessions } = await makeGateway()
    try {
      const events: TransportEvent[] = []
      const transport = createLanTransport({
        peer: { host: '127.0.0.1', port },
        authSecret: SECRET,
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

  it('rejects a LAN WebSocket session with a wrong PEER_SECRET_AUTH', async () => {
    const { gateway, port, sessions } = await makeGateway()
    try {
      const transport = createLanTransport({
        peer: { host: '127.0.0.1', port },
        authSecret: 'wrong-secret',
        onEvent: () => undefined
      })
      const result = await transport.connect()
      expect(result).toBe('rejected')
      expect(sessions).not.toContain(true)
    } finally {
      await gateway.stop()
    }
  })

  it('stops listening after stop()', async () => {
    const { gateway, port } = await makeGateway()
    await gateway.stop()
    await expect(fetch(`http://127.0.0.1:${port}/remote.html`)).rejects.toThrow()
  })
})
