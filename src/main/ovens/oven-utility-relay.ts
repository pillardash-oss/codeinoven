import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  OVEN_UTILITY_RELAY_MODE,
  type OvenUtilityRelayCommand,
  type OvenUtilityTurnInput
} from '../../lib/oven-utility-host'
import { Logger } from '../system/logger'
import { RelayChild, type RelayAsk, type RelayChildHost } from './oven-utility-relay/relay-child'
import { utilityJsonValue } from './oven-utility-relay/relay-frames'

/**
 * How many relays one Oven may hold at once.
 *
 * One relay is one SSH child, and several threads on the same machine can run
 * turns at the same time, so the cap is per Oven rather than global. A host that
 * kept every child alive would accumulate a process per thread; the oldest turn
 * goes when a ninth arrives, because it is the one most likely to be finished or
 * abandoned by then.
 */
export const OVEN_UTILITY_RELAY_LIMIT = 8

/** The turn as this app knows it: the contract's input plus the session it serves. */
export type OvenUtilityRelayTurn = OvenUtilityTurnInput & { sessionId: string }

/** What one turn's harness is pointed at while its relay is live. */
export interface OvenUtilityRelayEndpoint {
  /** The loopback URL of the Oven's own utility host, reached through the relay. */
  url: string
  /** The same information as a number, for a caller that builds its own URL. */
  port: number
  /** Retire this turn's relay. Idempotent, and safe after the turn already ended. */
  close: () => void
}

/**
 * The app-side runtime a relay answers calls through.
 *
 * Injected rather than imported so this module needs no Electron, no database and
 * no gateway of its own: a test supplies the same shape the app passes in.
 */
export interface OvenUtilityRelaySiteCalls {
  callRouteForTurn(turnId: string, route: string, input: unknown): Promise<unknown>
}

/** The one transport operation a relay needs: a long-lived duplex child. */
export interface OvenUtilityRelayTransport {
  duplex(
    id: string,
    argv: string[]
  ): Promise<{ child: ChildProcessWithoutNullStreams; dispose: () => Promise<void> }>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One relay per turn, so a turn running on an Oven reaches this app's gateway.
 *
 * A turn whose harness runs on an Oven cannot call the app's loopback gateway:
 * that address names the Oven's own loopback, where nothing listens. Each turn
 * therefore gets a relay — the Oven's service in `utility-relay` mode, spawned as
 * one SSH child with a duplex pipe — which registers the turn with the Oven's own
 * utility host and carries the calls the host cannot run there back to this app.
 *
 * Several threads on one Oven can run turns at once, so relays are keyed by turn
 * and every turn has its own child; a machine is only held to
 * `OVEN_UTILITY_RELAY_LIMIT` live children at a time. This class owns the
 * registry and the call routing; the pipe itself belongs to `RelayChild`.
 */
export class OvenUtilityRelays {
  private readonly relays = new Map<string, RelayChild>()

  /** How the children reach back into the registry, and nothing more. */
  private readonly host: RelayChildHost = {
    ask: (child: RelayChild, call: RelayAsk) => {
      void this.answer(child, call)
    },
    ended: (child: RelayChild) => {
      if (this.relays.get(child.turnId) === child) this.relays.delete(child.turnId)
    }
  }

  constructor(
    private readonly transport: OvenUtilityRelayTransport,
    private readonly siteCalls: OvenUtilityRelaySiteCalls
  ) {}

  /**
   * Where this turn's harness must point, starting its relay on first use.
   *
   * The same turn asking twice gets the relay it already has: a retry after the
   * port is known must not cost another SSH child on the Oven.
   */
  async endpoint(ovenId: string, turn: OvenUtilityRelayTurn): Promise<OvenUtilityRelayEndpoint> {
    const live = this.relays.get(turn.turnId)
    if (live?.alive()) {
      // A turn id is minted per turn and per app, so a different Oven here means
      // the old entry belongs to a turn that no longer exists.
      if (live.ovenId === ovenId) return await this.handed(live)
      live.retire()
    }
    // The limit is applied once the child exists, so a start that fails never
    // costs a live relay that another turn is using.
    const relay = await this.start(ovenId, turn)
    this.enforceLimit(ovenId)
    return await this.handed(relay)
  }

  /** Retire every relay one Oven holds, e.g. when it is removed or reconfigured. */
  retire(ovenId: string): void {
    for (const relay of [...this.relays.values()]) if (relay.ovenId === ovenId) relay.retire()
  }

  /** Retire one turn's relay, which is what a finished turn does. */
  retireTurn(turnId: string): void {
    this.relays.get(turnId)?.retire()
  }

  /** Retire every relay, as the app does on quit. */
  retireAll(): void {
    for (const relay of [...this.relays.values()]) relay.retire()
  }

  /** Spawn one relay and register the turn with the Oven's host. */
  private async start(ovenId: string, turn: OvenUtilityRelayTurn): Promise<RelayChild> {
    // `sessionId` is this app's own bookkeeping for the log lines it writes; the
    // host contract carries the turn only, so it never crosses the pipe.
    const { sessionId, ...input } = turn
    const channel = await this.transport.duplex(ovenId, [OVEN_UTILITY_RELAY_MODE])
    const relay = new RelayChild(this.host, {
      ovenId,
      turnId: input.turnId,
      sessionId,
      child: channel.child,
      dispose: channel.dispose
    })
    this.relays.set(relay.turnId, relay)
    relay.send({ kind: 'start', turn: input })
    Logger.dev('Started an Oven utility relay', {
      ovenId,
      turnId: relay.turnId,
      sessionId
    })
    return relay
  }

  /** One turn's URL and its `close`, once the relay has answered `ready`. */
  private async handed(relay: RelayChild): Promise<OvenUtilityRelayEndpoint> {
    const port = await relay.whenReady()
    return {
      port,
      url: `http://127.0.0.1:${port}`,
      close: () => relay.retire()
    }
  }

  /** Keep one Oven's children bounded, retiring the oldest for the newest. */
  private enforceLimit(ovenId: string): void {
    const live = [...this.relays.values()]
      .filter((relay) => relay.ovenId === ovenId && relay.alive())
      .sort((left, right) => left.started - right.started)
    while (live.length > OVEN_UTILITY_RELAY_LIMIT) {
      const oldest = live.shift()
      if (!oldest) return
      Logger.info('Retiring the oldest Oven utility relay to make room', {
        ovenId,
        turnId: oldest.turnId,
        limit: OVEN_UTILITY_RELAY_LIMIT
      })
      oldest.retire()
    }
  }

  /**
   * Run one forwarded call against the turn that relay is bound to.
   *
   * The child has already checked that the frame names its own turn, so the
   * turn's grants are the ones the app issued for this relay and no other.
   */
  private async answer(relay: RelayChild, call: RelayAsk): Promise<void> {
    let answer: OvenUtilityRelayCommand
    try {
      const value = await this.siteCalls.callRouteForTurn(relay.turnId, call.route, call.input)
      answer = { kind: 'answer', id: call.id, ok: true, value: utilityJsonValue(value) }
    } catch (error) {
      answer = { kind: 'answer', id: call.id, ok: false, error: messageOf(error) }
    }
    relay.send(answer)
  }
}
