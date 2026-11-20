/**
 * What one turn holds on this Oven, and when all of it is let go.
 *
 * A turn is a capability: the host forgets it when its client retires it, when
 * its relay disconnects, or when it goes idle for the TTL. Each of those ends the
 * same way here, because the host tells this registry the moment a turn is
 * retired. Everything a local execution opened for that turn (MCP servers above
 * all) is closed then, so no child process outlives the capability that started
 * it.
 *
 * The other thing a turn remembers is which local failures it has already
 * reported. A server that cannot spawn fails on every call, and one log line per
 * utility per turn answers "why did this go to the app" without turning a loop
 * over a broken server into a page of identical lines.
 */
import type {
  OvenUtilityMcpServer,
  OvenUtilityTurnUtility
} from '../../../../lib/oven-utility-host'
import { OvenUtilityMcpClients } from './oven-utility-mcp-clients'
import type { OvenUtilityMcpClient } from './oven-utility-mcp'

/** One utility this turn activated, and whether its capability was handed over. */
export interface OvenActivatedUtility {
  readonly utility: OvenUtilityTurnUtility
  /** The first activation hands the capability over; later ones answer with a note. */
  announced: boolean
}

/** One turn's Oven-local state. */
export class OvenUtilityLocalTurn {
  private readonly activated = new Map<string, OvenActivatedUtility>()
  private readonly mcp = new OvenUtilityMcpClients()
  private readonly reported = new Set<string>()
  private closing = false

  constructor(readonly turnId: string) {}

  /** The activation already recorded for one utility, if any. */
  activation(utilityId: string): OvenActivatedUtility | undefined {
    return this.activated.get(utilityId)
  }

  /** Every utility this turn activated, for the search answer's `active` field. */
  activeIds(): ReadonlySet<string> {
    return new Set(this.activated.keys())
  }

  /** Remember one activation. Idempotent: an already-active utility keeps its entry. */
  activate(utility: OvenUtilityTurnUtility): OvenActivatedUtility {
    const existing = this.activated.get(utility.id)
    if (existing) return existing
    const created: OvenActivatedUtility = { utility, announced: false }
    this.activated.set(utility.id, created)
    return created
  }

  /**
   * Record that this turn is being handed one utility's capability.
   *
   * Answers whether this is the first time. Re-listing an unchanged capability
   * only duplicates its schema in the transcript, so a repeat is answered with a
   * note instead, exactly as the app does.
   */
  announce(utilityId: string): boolean {
    const entry = this.activated.get(utilityId)
    if (!entry || entry.announced) return false
    entry.announced = true
    return true
  }

  /** The connection for one utility's MCP server, opened once per turn. */
  async openMcp(server: OvenUtilityMcpServer): Promise<OvenUtilityMcpClient> {
    return await this.mcp.open(server)
  }

  /**
   * Record one local failure and answer whether it is the first for this utility.
   *
   * The reason is not part of the key: a spawn that failed yesterday and a call
   * that timed out now are the same question ("why is this running on the app?"),
   * and the log line carries the reason of the first one.
   */
  reportFailure(utilityId: string): boolean {
    if (this.reported.has(utilityId)) return false
    this.reported.add(utilityId)
    return true
  }

  /** Close every MCP connection this turn opened. Idempotent, never throws. */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.activated.clear()
    this.reported.clear()
    await this.mcp.closeAll()
  }
}

/** Every turn this host is keeping Oven-local state for. */
export class OvenUtilityLocalTurns {
  private readonly turns = new Map<string, OvenUtilityLocalTurn>()
  /** Retirements still closing, so a host close can wait for every last child. */
  private readonly closing = new Set<Promise<void>>()

  /** The state of one turn, created the first time it runs anything locally. */
  of(turnId: string): OvenUtilityLocalTurn {
    const existing = this.turns.get(turnId)
    if (existing) return existing
    const created = new OvenUtilityLocalTurn(turnId)
    this.turns.set(turnId, created)
    return created
  }

  /** Close what one retired turn opened. Unknown turns are already gone. */
  retire(turnId: string): Promise<void> {
    const turn = this.turns.get(turnId)
    if (!turn) return Promise.resolve()
    this.turns.delete(turnId)
    // A retirement is reached from a synchronous callback (the turn registry's
    // own retirement), so it is tracked here as well as awaited there: closing
    // the host must not resolve while a child is still being killed.
    const closing = turn.close()
    this.closing.add(closing)
    void closing.finally(() => this.closing.delete(closing))
    return closing
  }

  /** Close every turn's local work; the host is going away. */
  async close(): Promise<void> {
    const turns = [...this.turns.values()]
    this.turns.clear()
    const closing = [...this.closing]
    this.closing.clear()
    await Promise.allSettled([...turns.map(async (turn) => await turn.close()), ...closing])
  }
}
