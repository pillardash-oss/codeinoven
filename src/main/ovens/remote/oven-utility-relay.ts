/**
 * One client's turn, carried between an Oven's utility host and that client.
 *
 * The relay is the only piece that spans the two machines: it is spawned on the
 * Oven (this app runs it over SSH with a duplex pipe), so it can both listen on
 * the Oven's loopback, where the host forwards app-bound calls, and answer its
 * client over stdin/stdout. It owns no policy: the client sends the whole turn,
 * and the host decides what that turn may call.
 *
 * The wire is newline-delimited JSON in both directions. stdout carries frames
 * and nothing else (`ready`, then `ask` per forwarded call, or `failed`);
 * diagnostics go through the logger, which the service points at stderr.
 */
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createInterface } from 'node:readline'
import {
  type OvenUtilityJson,
  type OvenUtilityRelayCommand,
  type OvenUtilityRelayEvent,
  type OvenUtilityTurnInput
} from '../../../lib/oven-utility-host'
import { Logger } from '../../system/logger'
import {
  OvenUtilityHttpError,
  closeOvenUtilityServer,
  ovenUtilityUrl,
  postOvenUtilityJson,
  readOvenUtilityJson,
  sendOvenUtilityEnvelope,
  type OvenUtilityEnvelope
} from './oven-utility-http'
import {
  OVEN_UTILITY_HOST_WAIT_MS,
  waitForOvenUtilityHostState
} from './oven-utility-host/oven-utility-host-state'

/** Registering a turn is one loopback round trip; it never takes seconds. */
const REGISTER_TIMEOUT_MS = 10_000
/** Retiring one is best effort: the host may already be gone. */
const RETIRE_TIMEOUT_MS = 5_000

export interface OvenUtilityRelayOptions {
  /** The Oven account's home; the host publishes itself under its data root. */
  home: string
  /** Frames from the client. Defaults to this process's stdin. */
  input?: NodeJS.ReadableStream
  /** Frames to the client. Defaults to this process's stdout. */
  output?: NodeJS.WritableStream
  /** How long to wait for the host's state file. */
  hostWaitMs?: number
}

export interface OvenUtilityRelayOutcome {
  ok: boolean
  reason?: string
}

/** One forwarded call waiting for its client's answer, keyed by the host's id. */
interface PendingAsk {
  settle: (answer: OvenUtilityEnvelope) => void
}

/**
 * Run one relay until its client stops it, closes the pipe, or the turn ends.
 *
 * Never throws: a failure is a `failed` frame plus `{ ok: false }`, because the
 * client learns what went wrong from the frame it can actually read.
 */
export async function runOvenUtilityRelay(
  options: OvenUtilityRelayOptions
): Promise<OvenUtilityRelayOutcome> {
  // stdout is the frame channel for this process, so no log line may land there.
  Logger.useStandardError()
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const emit = (event: OvenUtilityRelayEvent): void => {
    output.write(`${JSON.stringify(event)}\n`)
  }
  // A client that closed its end is a turn ending, not a crash on this side.
  output.on?.('error', () => undefined)
  const fail = (reason: string): OvenUtilityRelayOutcome => {
    emit({ kind: 'failed', error: reason })
    return { ok: false, reason }
  }

  const host = await waitForOvenUtilityHostState(
    options.home,
    options.hostWaitMs ?? OVEN_UTILITY_HOST_WAIT_MS
  )
  if (!host)
    return fail(
      'The Oven utility host is not running. Install the current Oven service, then start the turn again.'
    )
  const hostUrl = ovenUtilityUrl(host.port)
  const pending = new Map<string, PendingAsk>()
  let turnId: string | undefined
  let relay: { server: Server; url: string }
  try {
    relay = await listenForForwardedCalls(pending, emit, () => turnId)
  } catch (error) {
    return fail(`The relay could not listen on this Oven: ${reasonOf(error)}`)
  }
  // The first frame is always `ready`: the client publishes this host port as the
  // harness's gateway, and it must never be told that after a call arrives.
  emit({ kind: 'ready', port: host.port, hostProtocolVersion: host.protocolVersion })

  let outcome: OvenUtilityRelayOutcome = { ok: true }
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const payload = line.trim()
      if (payload.length === 0) continue
      const command = parseCommand(payload)
      if (!command) {
        Logger.dev('Oven utility relay ignored a frame it could not read.')
        continue
      }
      if (command.kind === 'answer') {
        settle(pending, command.id, command)
        continue
      }
      if (command.kind === 'stop') break
      // One relay carries one turn. A second `start` replaces the first rather
      // than leaving a turn registered with no process behind it.
      if (turnId !== undefined && turnId !== command.turn.turnId)
        await retireTurn(hostUrl, host.hostToken, turnId)
      const registered = await registerTurn(hostUrl, host.hostToken, command.turn, relay.url)
      if (!registered.ok) {
        outcome = fail(registered.reason)
        break
      }
      turnId = registered.turnId
    }
  } finally {
    lines.close()
    if (turnId) await retireTurn(hostUrl, host.hostToken, turnId)
    rejectPending(pending, 'The turn ended before the app answered.')
    await closeOvenUtilityServer(relay.server)
  }
  return outcome
}

/**
 * Listen on the Oven's loopback for the calls the host could not answer itself.
 *
 * This is the `relayUrl` the turn is registered with: the host POSTs one `ask`
 * frame per call and waits for the client's answer as this listener's response.
 * The relay adds no timeout of its own, because the client owns the deadline on
 * a call a human has to answer.
 */
async function listenForForwardedCalls(
  pending: Map<string, PendingAsk>,
  emit: (event: OvenUtilityRelayEvent) => void,
  registeredTurn: () => string | undefined
): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const frame = askFrame(await readOvenUtilityJson(request))
        // Only the turn this relay registered travels to its client: another
        // process on the Oven that found this port cannot ask it for anything.
        if (frame.turnId !== registeredTurn())
          throw new OvenUtilityHttpError(
            403,
            'This call does not belong to the turn of this relay.'
          )
        const answer = await ask(pending, emit, frame)
        sendOvenUtilityEnvelope(response, 200, answer)
      } catch (error) {
        sendOvenUtilityEnvelope(response, 502, { ok: false, error: reasonOf(error) })
      }
    })()
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
  } catch (error) {
    await closeOvenUtilityServer(server)
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeOvenUtilityServer(server)
    throw new Error('this Oven did not resolve a loopback port')
  }
  return { server, url: ovenUtilityUrl((address as AddressInfo).port) }
}

/** Emit one ask to the client and wait for the answer it settles with. */
function ask(
  pending: Map<string, PendingAsk>,
  emit: (event: OvenUtilityRelayEvent) => void,
  frame: { id: string; turnId: string; route: string; input: OvenUtilityJson }
): Promise<OvenUtilityEnvelope> {
  const existing = pending.get(frame.id)
  existing?.settle({ ok: false, error: 'The host reused a call id the relay already carried.' })
  return new Promise<OvenUtilityEnvelope>((resolve) => {
    pending.set(frame.id, {
      settle: (answer) => {
        pending.delete(frame.id)
        resolve(answer)
      }
    })
    emit({ kind: 'ask', ...frame })
  })
}

/** Settle one forwarded call with the client's own answer. */
function settle(pending: Map<string, PendingAsk>, id: string, answer: OvenUtilityEnvelope): void {
  const call = pending.get(id)
  if (!call) {
    // The host gave up on this call before the client answered it. Dropping the
    // answer is correct: nothing is waiting for it any more.
    Logger.dev('Oven utility relay dropped an answer for a call that is gone.')
    return
  }
  call.settle(answer)
}

function rejectPending(pending: Map<string, PendingAsk>, reason: string): void {
  for (const call of [...pending.values()]) call.settle({ ok: false, error: reason })
  pending.clear()
}

/** Tell the host this turn is over, so no token outlives its client. */
async function retireTurn(hostUrl: string, hostToken: string, turnId: string): Promise<void> {
  try {
    await postOvenUtilityJson(
      `${hostUrl}/host/turn`,
      { turnId },
      { method: 'DELETE', token: hostToken, timeoutMs: RETIRE_TIMEOUT_MS }
    )
  } catch {
    // The host is gone, which is what retirement was going to say anyway.
  }
}

async function registerTurn(
  hostUrl: string,
  hostToken: string,
  turn: OvenUtilityTurnInput,
  relayUrl: string
): Promise<{ ok: true; turnId: string } | { ok: false; reason: string }> {
  let result
  try {
    result = await postOvenUtilityJson(
      `${hostUrl}/host/turn`,
      { ...turn, relayUrl },
      { token: hostToken, timeoutMs: REGISTER_TIMEOUT_MS }
    )
  } catch (error) {
    return { ok: false, reason: `The Oven utility host did not answer: ${reasonOf(error)}` }
  }
  if (result.envelope?.ok === false) return { ok: false, reason: result.envelope.error }
  const value = result.envelope?.ok === true ? result.envelope.value : null
  const turnId =
    value && typeof value === 'object' && !Array.isArray(value) ? value['turnId'] : undefined
  if (typeof turnId !== 'string' || turnId.length === 0)
    return {
      ok: false,
      reason: `The Oven utility host did not register this turn (HTTP ${result.status}).`
    }
  return { ok: true, turnId }
}

/**
 * One command from the client.
 *
 * The turn inside `start` is passed on exactly as sent: the host validates it
 * strictly and the relay has no opinion about another machine's registry.
 */
function parseCommand(payload: string): OvenUtilityRelayCommand | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const kind = record['kind']
  if (kind === 'stop') return { kind: 'stop' }
  if (kind === 'start') {
    const turn = record['turn']
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return null
    return { kind: 'start', turn: turn as OvenUtilityTurnInput }
  }
  if (kind === 'answer') {
    const id = record['id']
    if (typeof id !== 'string' || id.length === 0) return null
    if (record['ok'] === true)
      return { kind: 'answer', id, ok: true, value: (record['value'] ?? null) as OvenUtilityJson }
    if (record['ok'] === false) {
      const error = record['error']
      return {
        kind: 'answer',
        id,
        ok: false,
        error: typeof error === 'string' && error.length > 0 ? error : 'The app could not answer.'
      }
    }
  }
  return null
}

/** One ask frame from the host, validated. */
function askFrame(body: OvenUtilityJson | undefined): {
  id: string
  turnId: string
  route: string
  input: OvenUtilityJson
} {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new OvenUtilityHttpError(400, 'A forwarded call must be an object.')
  const record = body as Record<string, OvenUtilityJson>
  const id = record['id']
  const turnId = record['turnId']
  const route = record['route']
  if (record['kind'] !== 'ask' || typeof id !== 'string' || typeof turnId !== 'string')
    throw new OvenUtilityHttpError(400, 'The relay can only carry an ask frame.')
  if (typeof route !== 'string' || route.length === 0)
    throw new OvenUtilityHttpError(400, 'A forwarded call needs its route.')
  return { id, turnId, route, input: record['input'] ?? null }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
