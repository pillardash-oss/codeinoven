import type { AuxiliaryAgentConfig } from './types/agent'
import type { AgentModelSelection } from './types/common'

/**
 * Harnesses that may hold an auxiliary model assignment. The map is keyed by
 * the harness a thread runs on, and each value may name any harness, so the
 * bound is generous: the app ships seven harnesses today.
 */
export const MAX_AUXILIARY_AGENTS = 32

/** Longest accepted harness, provider, model, or account identifier. */
export const AUXILIARY_AGENT_ID_MAX_LENGTH = 200

/**
 * The auxiliary model assigned to threads running `threadHarnessId`, or
 * `undefined` when nothing usable is assigned. Incomplete assignments are
 * treated as unassigned so a partially written config can never route an
 * auxiliary call to a model that was never named.
 */
export function auxiliarySelectionFor(
  config: AuxiliaryAgentConfig | undefined | null,
  threadHarnessId: string
): AgentModelSelection | undefined {
  if (!config || !threadHarnessId) return undefined
  const selection = config[threadHarnessId]
  if (!selection) return undefined
  if (!selection.harnessId || !selection.providerId || !selection.modelId) return undefined
  return selection
}

/** True when a selection resolves to a usable harness, provider, and model. */
export function isCompleteAuxiliarySelection(
  selection: AgentModelSelection | undefined
): selection is AgentModelSelection {
  return Boolean(selection?.harnessId && selection.providerId && selection.modelId)
}
