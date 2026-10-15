import type { AgentModelSelection, AssistantAgents, ThreadSettings } from './types'

/**
 * Assistant model sets, as pure functions.
 *
 * An assistant carries one primary model and any number of fallbacks. The order in
 * `assistantModelCandidates` is the order the runner tries them: a run starts on
 * the primary and, when that model fails, moves to the next fallback instead of
 * waiting out the failed provider's reset window. Both the scheduler and the
 * chat engine's retry path read the order from here, so the two can never
 * disagree about which model comes next.
 */

/** The model a run starts on: the assistant's primary, when it has one. */
export function assistantPrimaryModel(
  agents: AssistantAgents | undefined
): AgentModelSelection | undefined {
  return assistantModelCandidates(agents)[0]
}

/** Every model an assistant can run on, primary first, in the order to try them. */
export function assistantModelCandidates(
  agents: AssistantAgents | undefined
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
 * try. A current model that is not part of the assistant's set means the user
 * picked it themselves, and their choice is never overridden.
 */
export function nextAssistantModel(
  current: Pick<AgentModelSelection, 'harnessId' | 'providerId' | 'modelId'>,
  agents: AssistantAgents | undefined
): AgentModelSelection | null {
  const candidates = assistantModelCandidates(agents)
  const index = candidates.findIndex((candidate) => sameModelSelection(candidate, current))
  if (index < 0) return null
  return candidates[index + 1] ?? null
}

/** The same thread settings, running on one of the assistant's models. */
export function settingsWithAssistantModel(
  settings: ThreadSettings,
  selection: AgentModelSelection
): ThreadSettings {
  return {
    ...settings,
    harnessId: selection.harnessId,
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.accountId ? { accountId: selection.accountId } : {}),
    inferenceMode: selection.inferenceMode,
    contextWindow: selection.contextWindow,
    ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {})
  }
}

/**
 * The model set an assistant starts with. When the user did not pick a primary,
 * the model they were already working on   the composer's current selection  
 * becomes the primary, so an assistant defaults to the model they started with
 * rather than blocking on an explicit pick.
 */
export function withDefaultAssistantPrimary(
  agents: AssistantAgents,
  fallback: AgentModelSelection | undefined
): AssistantAgents {
  if (agents.primary?.modelId) return agents
  if (!fallback || !fallback.modelId) return agents
  return { ...agents, primary: fallback }
}
