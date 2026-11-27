/**
 * The Oven gate for a turn that is about to start on a remote Oven.
 *
 * The local device gate answers for this machine, but a turn dispatched to an
 * Oven lands on another computer's memory, and this app cannot see inside it.
 * The Oven's own service reports what it has (`specs.memoryAvailableBytes`,
 * with `activeRuns` as the fallback on older services), so the gate probes the
 * Oven and answers with the same shared policy the local device uses: a
 * message may wait, and the window parks it with a card until the Oven has
 * room, exactly like a busy local machine.
 *
 * A probe is an SSH round trip, so readings are cached briefly: the waiting
 * card re-asks every few seconds, and one probe serves every thread held on
 * the same Oven. The cache is the only thing keeping that cadence cheap, and
 * it disarms with the waits: nothing here runs while no message is held.
 */
import {
  decideOvenAdmission,
  holdsAdmission,
  type AdmissionDecision,
  type OvenResourceSample
} from '../../lib/resource-admission'
import type { OvenProbe } from '../../lib/ovens'
import { Logger } from '../system/logger'
import { DEADLINE_EXCEEDED, withDeadline } from '../../lib/with-deadline'
import type { OvenRegistry } from './oven-registry'
import type { OvenService } from './oven-service'

/** How long one Oven's admission reading is reused before another probe. */
const OVEN_ADMISSION_TTL_MS = 10_000

/**
 * How long an SSH probe may take before the gate answers without it.
 *
 * A probe crosses the network to another machine, so it can stall for as long as
 * the network feels like it. The reading is a courtesy to that machine, never a
 * reason to hold a user's message: past this deadline the gate fails open, which
 * is exactly what it already does when the probe reports an error.
 */
const OVEN_PROBE_TIMEOUT_MS = 3_000

/** A user turn that may not start on an Oven yet, carrying the reading. */
export class OvenHoldError extends Error {
  readonly ovenId: string
  readonly ovenName: string
  readonly decision: AdmissionDecision

  constructor(ovenId: string, ovenName: string, decision: AdmissionDecision) {
    super(`${ovenName} is short on memory. The message is kept; it sends once the Oven has room.`)
    this.name = 'OvenHoldError'
    this.ovenId = ovenId
    this.ovenName = ovenName
    this.decision = decision
  }
}

/** One cached reading per Oven. */
interface CacheEntry {
  at: number
  decision: AdmissionDecision
}

export class OvenResourceGate {
  private readonly cache = new Map<string, CacheEntry>()
  /** Oven display names, resolved once: the registry read is async and heavy. */
  private readonly names = new Map<string, string>()

  constructor(
    private readonly service: OvenService,
    private readonly registry: OvenRegistry
  ) {}

  /**
   * The Oven's display name, for a card that says which machine waits.
   *
   * The registry read is async, so the name is resolved once and remembered;
   * a renamed Oven is picked up the next launch.
   */
  async nameFor(ovenId: string): Promise<string> {
    const known = this.names.get(ovenId)
    if (known !== undefined) return known
    try {
      const state = await this.registry.state()
      const found = state.ovens.find((oven) => oven.id === ovenId)?.name
      const name = found ?? 'the Oven'
      this.names.set(ovenId, name)
      return name
    } catch {
      return 'the Oven'
    }
  }

  /**
   * The reading that holds a new turn on this Oven, or null when it may start.
   *
   * A probe that fails fails open: an unreachable Oven answers at dispatch with
   * its own error, so holding the message here would only promise a wait the
   * dispatch cannot keep.
   */
  async holdFor(ovenId: string): Promise<OvenHoldError | null> {
    const decision = await this.read(ovenId)
    if (!holdsAdmission(decision)) return null
    return new OvenHoldError(ovenId, await this.nameFor(ovenId), decision)
  }

  /**
   * One Oven's admission decision, cached for one TTL window so the waiting
   * card's re-ask cadence costs one SSH probe per Oven, not per thread.
   */
  async read(ovenId: string): Promise<AdmissionDecision> {
    const cached = this.cache.get(ovenId)
    if (cached && Date.now() - cached.at <= OVEN_ADMISSION_TTL_MS) return cached.decision
    let decision: AdmissionDecision
    try {
      const probe = await withDeadline(this.service.probe(ovenId), OVEN_PROBE_TIMEOUT_MS)
      decision =
        probe === DEADLINE_EXCEEDED
          ? decideOvenAdmission({
              memoryAvailableBytes: null,
              totalMemoryBytes: 0,
              activeRuns: 0
            })
          : decideOvenAdmission(sampleFrom(probe))
      if (probe === DEADLINE_EXCEEDED) {
        // Not cached: a probe that timed out says nothing about this Oven, and
        // remembering "room" would hide a genuinely full machine for a whole TTL.
        return decision
      }
    } catch (error) {
      Logger.dev('Oven gate: probe failed, failing open', { ovenId, error: String(error) })
      decision = decideOvenAdmission({
        memoryAvailableBytes: null,
        totalMemoryBytes: 0,
        activeRuns: 0
      })
    }
    this.cache.set(ovenId, { at: Date.now(), decision })
    return decision
  }
}

/** The probe's own numbers, shaped for the shared policy. */
function sampleFrom(probe: OvenProbe): OvenResourceSample {
  const specs = probe.specs
  return {
    memoryAvailableBytes:
      typeof specs?.memoryAvailableBytes === 'number' && specs.memoryAvailableBytes >= 0
        ? specs.memoryAvailableBytes
        : null,
    totalMemoryBytes: specs?.memoryBytes ?? 0,
    activeRuns: probe.activeRuns
  }
}
