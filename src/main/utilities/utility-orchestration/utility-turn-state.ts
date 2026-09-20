import type { ResolvedUtility, UtilityKind } from '../../../lib/types'

/**
 * What a thread's durable utilities bank keeps about one entry.
 *
 * This lives here rather than beside the orchestration service so the maps a
 * live turn holds can be reasoned about, and tested, without constructing the
 * whole service.
 */
export interface ThreadBankEntry {
  id: string
  name: string
  kind: UtilityKind
  description: string
}

/** The registry-derived maps one live turn holds about the utilities it may reach. */
export interface TurnUtilityMaps {
  eligible: Map<string, ResolvedUtility>
  activated: Map<string, ResolvedUtility>
  bank: Map<string, ThreadBankEntry>
}

/**
 * Drop one utility from a live turn.
 *
 * A registry change has to land in the turn that is already running, not only in
 * the next one. A user who switches a capability off expects it to stop being
 * callable now, not after they send another message, and a turn lasts minutes.
 *
 * Returns true when the utility was reachable in this turn, so the caller knows
 * whether it has a client or a session to close.
 */
export function forgetUtility(maps: TurnUtilityMaps, utilityId: string): boolean {
  const wasReachable = maps.eligible.delete(utilityId)
  maps.activated.delete(utilityId)
  maps.bank.delete(utilityId)
  return wasReachable
}

/**
 * Reconcile a turn's reachable utilities with what the registry resolves now.
 *
 * An activated entry used to stay reachable for the rest of the turn even after
 * it was removed from the registry, which is what kept a disabled capability
 * alive until the turn ended. A refresh has just listed everything that is
 * eligible now, so an activated id missing from that list has been disabled,
 * deleted, or moved out of scope. The earlier call the transcript already made
 * has returned, so the id is dropped rather than kept alive on its behalf.
 *
 * Returns the ids that were dropped, so the caller can close their clients.
 */
export function reconcileActivated(
  maps: TurnUtilityMaps,
  stillResolvable: ReadonlySet<string>
): string[] {
  const dropped: string[] = []
  for (const utilityId of [...maps.activated.keys()]) {
    if (stillResolvable.has(utilityId)) continue
    forgetUtility(maps, utilityId)
    dropped.push(utilityId)
  }
  return dropped
}
