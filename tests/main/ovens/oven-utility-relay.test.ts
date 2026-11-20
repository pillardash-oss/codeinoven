import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OVEN_UTILITY_HOST_PROTOCOL,
  OVEN_UTILITY_RELAY_MODE,
  type OvenUtilityRelayCommand,
  type OvenUtilityRelayEvent,
  type OvenUtilityTurnInput
} from '../../../src/lib/oven-utility-host'
import {
  OVEN_UTILITY_RELAY_LIMIT,
  OvenUtilityRelays,
  type OvenUtilityRelayEndpoint,
  type OvenUtilityRelaySiteCalls,
  type OvenUtilityRelayTransport
} from '../../../src/main/ovens/oven-utility-relay'
import { MAX_RELAY_FRAME_BYTES } from '../../../src/main/ovens/oven-utility-relay/relay-frames'

const OVEN = 'oven-6a1f0d3c'
const SESSION = 'session-4b2c'

/** One turn as the app hands it over: the contract's input plus its session. */
function turn(turnId: string): OvenUtilityTurnInput & { sessionId: string } {
  return {
    turnId,
    token: `token-${turnId}`,
    grants: ['/invoke'],
    utilities: [],
    client: 'cio-test',
    sessionId: SESSION
  }
}

/** The turn as it crosses the pipe: the session is this app's own bookkeeping. */
function wireTurn(turnId: string): OvenUtilityTurnInput {
  const { sessionId: _session, ...input } = turn(turnId)
  return input
}

/** The app's own stdin: everything the relay wrote, decoded in order. */
class CommandPipe extends Writable {
  private readonly parts: string[] = []
  ended = false

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.parts.push(chunk.toString())
    callback()
  }

  override _final(callback: () => void): void {
    this.ended = true
    callback()
  }

  /** Every command the app sent, in the order it sent them. */
  frames(): OvenUtilityRelayCommand[] {
    return this.parts
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as OvenUtilityRelayCommand)
  }
}

/**
 * The SSH child as a relay sees it: three pipes and process events.
 *
 * A real child is the honest way to test pure plumbing (`oven-request-channel`
 * does exactly that), but here the frames matter and they travel in both
 * directions from the test itself, so both ends of the pipe stay in the test:
 * `frames()` is what the app wrote, and `send` is what the Oven's relay would
 * have written back.
 */
class FakeChild extends EventEmitter {
  readonly stdin = new CommandPipe()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed: NodeJS.Signals | null = null
  disposed = false

  constructor() {
    super()
    this.stdout.setEncoding('utf8')
    this.stderr.setEncoding('utf8')
  }

  /** One frame the Oven's relay would have written. */
  send(frame: OvenUtilityRelayEvent): void {
    this.raw(`${JSON.stringify(frame)}\n`)
  }

  /** Raw stdout, so a test can send something this app must refuse. */
  raw(text: string): void {
    this.stdout.write(text)
  }

  /** The child died on the Oven's side. */
  exit(code: number | null = 1): void {
    this.emit('close', code)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = signal
    return true
  }

  commands(): OvenUtilityRelayCommand[] {
    return this.stdin.frames()
  }
}

/** The Oven transport, spawning fake children instead of SSH processes. */
class FakeOven implements OvenUtilityRelayTransport {
  readonly children: FakeChild[] = []
  readonly requests: { ovenId: string; argv: string[] }[] = []

  async duplex(
    id: string,
    argv: string[]
  ): Promise<{ child: ChildProcessWithoutNullStreams; dispose: () => Promise<void> }> {
    const child = new FakeChild()
    this.children.push(child)
    this.requests.push({ ovenId: id, argv })
    return {
      child: child as unknown as ChildProcessWithoutNullStreams,
      dispose: async () => {
        child.disposed = true
      }
    }
  }
}

/** The app-side runtime a relay answers through, recorded call by call. */
class FakeSite implements OvenUtilityRelaySiteCalls {
  readonly calls: { turnId: string; route: string; input: unknown }[] = []
  /** When set, every call fails the way a refused grant does. */
  failure: Error | null = null

  async callRouteForTurn(turnId: string, route: string, input: unknown): Promise<unknown> {
    this.calls.push({ turnId, route, input })
    if (this.failure) throw this.failure
    return { content: [{ type: 'text', text: `${route} answered` }] }
  }
}

type EndpointOutcome = { ok: true; value: OvenUtilityRelayEndpoint } | { ok: false; error: unknown }

/** Start one endpoint without ever leaving its rejection unhandled. */
function outcomeOf(pending: Promise<OvenUtilityRelayEndpoint>): Promise<EndpointOutcome> {
  return pending.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * The spawned child, once the app is waiting for its `ready`.
 *
 * `endpoint()` spawns the child before it starts waiting, so the wait is one
 * turn of the event loop away; a test that wrote a frame before that point would
 * be racing the relay rather than testing it.
 */
async function childAt(oven: FakeOven, index: number): Promise<FakeChild> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await settled()
    const child = oven.children[index]
    if (child && child.commands().length > 0) return child
  }
  throw new Error('The relay never opened an SSH child.')
}

/** Wait for the app to have written one more command than it has so far. */
async function waitForCommands(child: FakeChild, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.commands().length >= count) return
    await settled()
  }
  throw new Error('The relay never wrote that command.')
}

/** Wait for the app to have ended the child. */
async function waitForKill(child: FakeChild): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.killed) return
    await settled()
  }
  throw new Error('The relay was never closed.')
}

const opened: OvenUtilityRelays[] = []

function open(): { relays: OvenUtilityRelays; oven: FakeOven; site: FakeSite } {
  const oven = new FakeOven()
  const site = new FakeSite()
  const relays = new OvenUtilityRelays(oven, site)
  opened.push(relays)
  return { relays, oven, site }
}

/** Start one turn and answer its `ready`, as a healthy relay does. */
async function liveTurn(
  relays: OvenUtilityRelays,
  oven: FakeOven,
  turnId: string,
  port = 43_210
): Promise<{ child: FakeChild; endpoint: OvenUtilityRelayEndpoint }> {
  const index = oven.children.length
  const outcome = outcomeOf(relays.endpoint(OVEN, turn(turnId)))
  const child = await childAt(oven, index)
  child.send({ kind: 'ready', port, hostProtocolVersion: OVEN_UTILITY_HOST_PROTOCOL })
  const result = await outcome
  if (!result.ok) throw result.error
  return { child, endpoint: result.value }
}

afterEach(() => {
  for (const relays of opened.splice(0)) relays.retireAll()
})

describe('oven utility relay', () => {
  it('points the turn at the host the relay reports, and asks for the relay mode', async () => {
    const { relays, oven } = open()
    const result = await liveTurn(relays, oven, 'turn-1', 52_101)

    expect(result.endpoint.url).toBe('http://127.0.0.1:52101')
    expect(result.endpoint.port).toBe(52_101)
    // The child runs the utility relay of the Oven's own service bundle.
    expect(oven.requests).toEqual([{ ovenId: OVEN, argv: [OVEN_UTILITY_RELAY_MODE] }])
    // `start` carries the whole turn, because the client owns the registry.
    expect(result.child.commands()).toEqual([{ kind: 'start', turn: wireTurn('turn-1') }])
  })

  it('answers one forwarded call with the id the host minted', async () => {
    const { relays, oven, site } = open()
    const { child } = await liveTurn(relays, oven, 'turn-1')

    child.send({
      kind: 'ask',
      id: 'ask-7',
      turnId: 'turn-1',
      route: '/invoke',
      input: { utilityId: 'utility-1' }
    })
    await waitForCommands(child, 2)

    expect(site.calls).toEqual([
      { turnId: 'turn-1', route: '/invoke', input: { utilityId: 'utility-1' } }
    ])
    expect(child.commands()[1]).toEqual({
      kind: 'answer',
      id: 'ask-7',
      ok: true,
      value: { content: [{ type: 'text', text: '/invoke answered' }] }
    })
  })

  it('answers a refused call with the reason instead of failing the relay', async () => {
    const { relays, oven, site } = open()
    site.failure = new Error('Tool is not granted to this turn')
    const { child } = await liveTurn(relays, oven, 'turn-1')

    child.send({ kind: 'ask', id: 'ask-8', turnId: 'turn-1', route: '/invoke', input: {} })
    await waitForCommands(child, 2)

    expect(child.commands()[1]).toEqual({
      kind: 'answer',
      id: 'ask-8',
      ok: false,
      error: 'Tool is not granted to this turn'
    })
    // A refused call is an answer, not a broken channel.
    expect(child.killed).toBeNull()
  })

  it('rejects the endpoint when the relay exits before it is ready, and drops it', async () => {
    const { relays, oven } = open()
    const outcome = outcomeOf(relays.endpoint(OVEN, turn('turn-1')))
    const child = await childAt(oven, 0)
    child.stderr.write('ssh: connect to host oven port 22: Connection refused\n')
    child.exit(255)

    const result = await outcome
    if (result.ok) throw new Error('The endpoint resolved after the relay died.')
    expect(String(result.error)).toContain('Connection refused')
    expect(child.disposed).toBe(true)

    // Nothing stale is left: the same turn asking again gets a fresh child.
    const again = outcomeOf(relays.endpoint(OVEN, turn('turn-1')))
    const next = await childAt(oven, 1)
    expect(next).not.toBe(child)
    next.send({ kind: 'ready', port: 40_000, hostProtocolVersion: OVEN_UTILITY_HOST_PROTOCOL })
    const retried = await again
    if (!retried.ok) throw retried.error
    expect(retried.value.port).toBe(40_000)
  })

  it('retires one turn with stop, and forgets it', async () => {
    const { relays, oven } = open()
    const { child, endpoint } = await liveTurn(relays, oven, 'turn-1')

    endpoint.close()
    await settled()

    expect(child.commands().at(-1)).toEqual({ kind: 'stop' })
    expect(child.stdin.ended).toBe(true)
    // The relay is gone from the bookkeeping, so a new turn gets a new child.
    const again = outcomeOf(relays.endpoint(OVEN, turn('turn-1')))
    const next = await childAt(oven, 1)
    expect(next).not.toBe(child)
    next.send({ kind: 'ready', port: 40_001, hostProtocolVersion: OVEN_UTILITY_HOST_PROTOCOL })
    expect((await again).ok).toBe(true)
  })

  it('refuses a frame past the size bound instead of buffering it', async () => {
    const { relays, oven } = open()
    const outcome = outcomeOf(relays.endpoint(OVEN, turn('turn-1')))
    const child = await childAt(oven, 0)

    child.raw(`${'x'.repeat(MAX_RELAY_FRAME_BYTES + 1)}\n`)

    const result = await outcome
    if (result.ok) throw new Error('The endpoint resolved from an oversized frame.')
    expect(String(result.error)).toContain('8 MiB')
    expect(child.killed).toBe('SIGTERM')
  })

  it('rejects the endpoint when the relay reports it could not register', async () => {
    const { relays, oven } = open()
    const outcome = outcomeOf(relays.endpoint(OVEN, turn('turn-1')))
    const child = await childAt(oven, 0)

    child.send({ kind: 'failed', error: 'The Oven utility host refused the turn.' })

    const result = await outcome
    if (result.ok) throw new Error('The endpoint resolved after the relay failed.')
    expect(String(result.error)).toContain('The Oven utility host refused the turn.')
    expect(child.killed).toBe('SIGTERM')
  })

  it('refuses a call the relay forwarded for another turn', async () => {
    const { relays, oven, site } = open()
    const { child } = await liveTurn(relays, oven, 'turn-1')

    child.send({ kind: 'ask', id: 'ask-9', turnId: 'turn-2', route: '/invoke', input: {} })
    await waitForKill(child)

    // A relay serves one turn, so the app never runs a route for another one.
    expect(site.calls).toEqual([])
    expect(child.commands()).toHaveLength(1)
  })

  it('retires the oldest turn when one Oven reaches its relay cap', async () => {
    const { relays, oven } = open()
    const turns = Array.from(
      { length: OVEN_UTILITY_RELAY_LIMIT },
      (_, index) => `turn-${index + 1}`
    )
    for (const turnId of turns) await liveTurn(relays, oven, turnId)
    const oldest = oven.children[0]
    // Filling the Oven to its cap retires nothing: the cap is what it may hold.
    for (const child of oven.children) expect(child.commands()).toHaveLength(1)

    const extra = outcomeOf(relays.endpoint(OVEN, turn('turn-9')))
    const next = await childAt(oven, OVEN_UTILITY_RELAY_LIMIT)
    next.send({ kind: 'ready', port: 40_002, hostProtocolVersion: OVEN_UTILITY_HOST_PROTOCOL })
    expect((await extra).ok).toBe(true)

    expect(oldest?.commands().at(-1)).toEqual({ kind: 'stop' })
    expect(oven.children[1]?.commands()).toHaveLength(1)
    expect(oven.children).toHaveLength(OVEN_UTILITY_RELAY_LIMIT + 1)
  })
})
