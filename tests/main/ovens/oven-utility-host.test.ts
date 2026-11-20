import { once } from 'node:events'
import { request as httpRequest, createServer, type Server } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OVEN_UTILITY_HOST_PROTOCOL,
  type OvenUtilityJson,
  type OvenUtilityRelayEvent,
  type OvenUtilityTurnInput
} from '../../../src/lib/oven-utility-host'
import {
  startOvenUtilityHost,
  type OvenUtilityHostHandle
} from '../../../src/main/ovens/remote/oven-utility-host'
import {
  ovenUtilityHostStatePath,
  readOvenUtilityHostState
} from '../../../src/main/ovens/remote/oven-utility-host/oven-utility-host-state'
import { runOvenUtilityRelay } from '../../../src/main/ovens/remote/oven-utility-relay'

const REVISION = 'test-revision'

interface CallResult {
  status: number
  body: OvenUtilityJson | undefined
}

/** One HTTP call the way a client or a harness makes it. */
function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<CallResult> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise<CallResult>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.byteLength }
            : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').trim()
          resolve({
            status: response.statusCode ?? 0,
            body: text ? (JSON.parse(text) as OvenUtilityJson) : undefined
          })
        })
      }
    )
    request.on('error', reject)
    request.end(payload)
  })
}

/** A value inside an envelope answer, for a test that knows the shape. */
function valueOf(result: CallResult): Record<string, OvenUtilityJson> {
  const body = result.body
  if (!body || typeof body !== 'object' || Array.isArray(body) || body['ok'] !== true)
    throw new Error(`Expected a successful envelope, got ${JSON.stringify(result)}`)
  const value = body['value']
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Expected an object value, got ${JSON.stringify(value)}`)
  return value
}

/** The error text of an envelope answer. */
function errorOf(result: CallResult): string {
  const body = result.body
  if (!body || typeof body !== 'object' || Array.isArray(body) || body['ok'] !== false)
    throw new Error(`Expected a failed envelope, got ${JSON.stringify(result)}`)
  const error = body['error']
  return typeof error === 'string' ? error : ''
}

function turnInput(overrides: Partial<OvenUtilityTurnInput> = {}): OvenUtilityTurnInput {
  return {
    turnId: 'turn-1',
    token: 'turn-token-1',
    grants: ['/invoke'],
    utilities: [],
    client: 'test-client',
    ...overrides
  }
}

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the Oven.')
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

/**
 * A stand-in for a turn's relay: it answers every forwarded call with the value
 * it was handed, and records what the host asked it.
 */
async function fakeRelay(): Promise<{
  url: string
  asks: Record<string, OvenUtilityJson>[]
  close: () => Promise<void>
}> {
  const asks: Record<string, OvenUtilityJson>[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        OvenUtilityJson
      >
      asks.push(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, value: { answered: 'by-the-app' } }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, asks, close: () => closeServer(server) }
}

/** The relay's stdout frames, in order, awaitable one at a time. */
function frameReader(output: PassThrough): () => Promise<OvenUtilityRelayEvent> {
  const frames: OvenUtilityRelayEvent[] = []
  const waiters: Array<() => void> = []
  let buffered = ''
  output.setEncoding('utf8')
  output.on('data', (chunk: string) => {
    buffered += chunk
    for (;;) {
      const end = buffered.indexOf('\n')
      if (end < 0) break
      frames.push(JSON.parse(buffered.slice(0, end)) as OvenUtilityRelayEvent)
      buffered = buffered.slice(end + 1)
    }
    for (const waiter of waiters.splice(0)) waiter()
  })
  return async () => {
    for (;;) {
      const frame = frames.shift()
      if (frame) return frame
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  }
}

describe('Oven utility host', () => {
  const hosts: OvenUtilityHostHandle[] = []
  const relays: Array<() => Promise<void>> = []
  let home = ''

  afterEach(async () => {
    for (const stop of relays.splice(0)) await stop()
    for (const host of hosts.splice(0)) await host.close()
    if (home) await rm(home, { recursive: true, force: true })
    home = ''
  })

  async function startHost(): Promise<OvenUtilityHostHandle> {
    home = await mkdtemp(join(tmpdir(), 'codeinoven-oven-utility-host-'))
    const host = await startOvenUtilityHost({ home, revision: REVISION })
    hosts.push(host)
    return host
  }

  async function hostToken(): Promise<string> {
    const state = await readOvenUtilityHostState(home)
    if (!state) throw new Error('The host published no state file.')
    return state.hostToken
  }

  it('publishes its state 0600 and withdraws it on close', async () => {
    const host = await startHost()
    const path = ovenUtilityHostStatePath(home)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    const state = await readOvenUtilityHostState(home)
    expect(state).toMatchObject({
      protocolVersion: OVEN_UTILITY_HOST_PROTOCOL,
      revision: REVISION,
      port: host.port,
      pid: process.pid
    })
    expect(state?.hostToken).toMatch(/^[0-9a-f]{64}$/u)
    await host.close()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a wrong credential on the host routes', async () => {
    const host = await startHost()
    expect((await call(host.port, 'GET', '/host/status')).status).toBe(401)
    expect((await call(host.port, 'GET', '/host/status', undefined, 'not-the-token')).status).toBe(
      401
    )
    expect((await call(host.port, 'POST', '/host/turn', turnInput(), 'not-the-token')).status).toBe(
      401
    )
    expect((await call(host.port, 'DELETE', '/host/turn', { turnId: 'turn-1' })).status).toBe(401)
  })

  it('reports its status and mints one turn', async () => {
    const host = await startHost()
    const token = await hostToken()
    const status = await call(host.port, 'GET', '/host/status', undefined, token)
    expect(status.status).toBe(200)
    expect(valueOf(status)).toMatchObject({
      protocolVersion: OVEN_UTILITY_HOST_PROTOCOL,
      port: host.port,
      revision: REVISION,
      turns: 0
    })
    const registered = await call(host.port, 'POST', '/host/turn', turnInput(), token)
    expect(registered.status).toBe(200)
    expect(valueOf(registered)).toMatchObject({ turnId: 'turn-1' })
    const withTurn = await call(host.port, 'GET', '/host/status', undefined, token)
    expect(valueOf(withTurn)['turns']).toBe(1)
    await call(host.port, 'DELETE', '/host/turn', { turnId: 'turn-1' }, token)
    const retired = await call(host.port, 'GET', '/host/status', undefined, token)
    expect(valueOf(retired)['turns']).toBe(0)
    // A relay that discovers its connection is gone reports the turn as gone too.
    await call(host.port, 'POST', '/host/turn', turnInput({ turnId: 'turn-2' }), token)
    const gone = await call(host.port, 'POST', '/host/turn/relay-gone', { turnId: 'turn-2' }, token)
    expect(valueOf(gone)).toMatchObject({ turnId: 'turn-2', retired: true })
    const empty = await call(host.port, 'GET', '/host/status', undefined, token)
    expect(valueOf(empty)['turns']).toBe(0)
  })

  it('refuses a route the turn was not granted', async () => {
    const host = await startHost()
    await call(host.port, 'POST', '/host/turn', turnInput(), await hostToken())
    const refused = await call(
      host.port,
      'POST',
      '/diagnostics',
      { topic: 'threads' },
      'turn-token-1'
    )
    expect(refused.status).toBe(403)
    expect(errorOf(refused)).toBe('Tool is not granted to this turn')
  })

  it('forwards a granted route to the turn relay and returns its answer', async () => {
    const host = await startHost()
    const relay = await fakeRelay()
    relays.push(relay.close)
    const token = await hostToken()
    await call(
      host.port,
      'POST',
      '/host/turn',
      turnInput({ relayUrl: relay.url, grants: ['invoke'] }),
      token
    )
    const answered = await call(
      host.port,
      'POST',
      '/invoke',
      { utility_id: 'cio:svelte' },
      'turn-token-1'
    )
    expect(answered.status).toBe(200)
    expect(answered.body).toEqual({ ok: true, value: { answered: 'by-the-app' } })
    expect(relay.asks).toHaveLength(1)
    expect(relay.asks[0]).toMatchObject({
      kind: 'ask',
      turnId: 'turn-1',
      route: '/invoke',
      input: { utility_id: 'cio:svelte' }
    })
  })

  it('answers a turn with no relay that the capability needs its app', async () => {
    const host = await startHost()
    await call(
      host.port,
      'POST',
      '/host/turn',
      turnInput({ grants: ['/search'] }),
      await hostToken()
    )
    const refused = await call(host.port, 'POST', '/search', { query: 'svelte' }, 'turn-token-1')
    expect(refused.status).toBe(503)
    expect(errorOf(refused)).toBe(
      'This capability needs its app: /search is app-owned and this client has no relay.'
    )
  })

  it('runs a relay that registers, forwards one ask, and retires on stop', async () => {
    const host = await startHost()
    const token = await hostToken()
    const input = new PassThrough()
    const output = new PassThrough()
    const nextFrame = frameReader(output)
    const finished = runOvenUtilityRelay({ home, input, output })
    relays.push(async () => {
      input.end()
      await finished
    })

    const ready = await nextFrame()
    expect(ready).toEqual({
      kind: 'ready',
      port: host.port,
      hostProtocolVersion: OVEN_UTILITY_HOST_PROTOCOL
    })

    input.write(`${JSON.stringify({ kind: 'start', turn: turnInput() })}\n`)
    await until(
      async () =>
        valueOf(await call(host.port, 'GET', '/host/status', undefined, token))['turns'] === 1
    )

    const invoked = call(host.port, 'POST', '/invoke', { utility_id: 'cio:svelte' }, 'turn-token-1')
    const ask = await nextFrame()
    if (ask.kind !== 'ask') throw new Error(`Expected an ask, got ${JSON.stringify(ask)}`)
    expect(ask).toMatchObject({
      turnId: 'turn-1',
      route: '/invoke',
      input: { utility_id: 'cio:svelte' }
    })

    input.write(
      `${JSON.stringify({ kind: 'answer', id: ask.id, ok: true, value: { ran: 'on-the-app' } })}\n`
    )
    const answered = await invoked
    expect(answered.status).toBe(200)
    expect(answered.body).toEqual({ ok: true, value: { ran: 'on-the-app' } })

    input.write(`${JSON.stringify({ kind: 'stop' })}\n`)
    await expect(finished).resolves.toEqual({ ok: true })
    const after = await call(host.port, 'GET', '/host/status', undefined, token)
    expect(valueOf(after)['turns']).toBe(0)
  })
})
