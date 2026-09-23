import type { AgentModelSelection, RoutineAgents, ThreadSettings } from './types'

/**
 * Routine model sets, as pure functions.
 *
 * A routine carries one primary model and any number of fallbacks. The order in
 * `routineModelCandidates` is the order the runner tries them: a run starts on
 * the primary and, when that model fails, moves to the next fallback instead of
 * waiting out the failed provider's reset window. Both the scheduler and the
 * chat engine's retry path read the order from here, so the two can never
 * disagree about which model comes next.
 */

/** The model a run starts on: the routine's primary, when it has one. */
export function routinePrimaryModel(
  agents: RoutineAgents | undefined
): AgentModelSelection | undefined {
  return routineModelCandidates(agents)[0]
}

/** Every model a routine can run on, primary first, in the order to try them. */
export function routineModelCandidates(
  agents: RoutineAgents | undefined
): AgentModelSelection[] {
  if (!agents) return []
  return [agents.primary, ...agents.fallbacks].filter(
    (entry): entry is AgentModelSelection =>
      typeof entry?.modelId === 'string' && entry.modelId.length > 0
  )
}

/** Whether two selections point at the same model on the same provider and harness. */
export function sameModelSelection(
  a: Pick<AgentModelSelection, 'harnessId' | 'providerId' | 'modelId'>,
  b: Pick<AgentModelSelection, 'harnessId' | 'providerId' | 'modelId'>
): boolean {
  return a.harnessId === b.harnessId && a.providerId === b.providerId && a.modelId === b.modelId
}

/**
 * The model to try after `current` fails, or null when there is nothing left to
 * try. A current model that is not part of the routine's set means the user
 * picked it themselves, and their choice is never overridden.
 */
export function nextRoutineModel(
  current: Pick<AgentModelSelection, 'harnessId' | 'providerId' | 'modelId'>,
  agents: RoutineAgents | undefined
): AgentModelSelection | null {
  const candidates = routineModelCandidates(agents)
  const index = candidates.findIndex((candidate) => sameModelSelection(candidate, current))
  if (index < 0) return null
  return candidates[index + 1] ?? null
}

/** The same thread settings, running on one of the routine's models. */
export function settingsWithRoutineModel(
  settings: ThreadSettings,
  selection: AgentModelSelection
): ThreadSettings {
  return {
    ...settings,
    harnessId: selection.harnessId,
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.accountId ? { accountId: selection.accountId } : {}),
    ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {})
  }
}

/**
 * The model set a routine starts with. When the user did not pick a primary,
 * the model they were already working on   the composer's current selection  
 * becomes the primary, so a routine defaults to the model they started with
 * rather than blocking on an explicit pick.
 */
export function withDefaultRoutinePrimary(
  agents: RoutineAgents,
  fallback: AgentModelSelection | undefined
): RoutineAgents {
  if (agents.primary?.modelId) return agents
  if (!fallback || !fallback.modelId) return agents
  return { ...agents, primary: fallback }
}
