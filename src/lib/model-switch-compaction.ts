/**
 * Decide whether a reused native harness session must be compacted before it
 * resumes under a newly selected model.
 *
 * When a user switches a thread's model, the app keeps the same native session
 * (e.g. the Codex native thread). Replaying that conversation under a model
 * with a smaller context window can exceed the window and make the harness
 * refuse the turn ("Codex ran out of room in the model's context window").
 *
 * When the thread's last-known native context usage already occupies a large
 * share of the new model's window, the app compacts the native thread first so
 * the resume starts comfortably inside the window.
 */

/** Fraction of the new model's context window that triggers auto-compaction. */
export const MODEL_SWITCH_COMPACT_THRESHOLD_RATIO = 0.8

export interface ModelSwitchCompactionInput {
  /** Newly selected model's maximum context window in tokens. */
  contextWindow?: number
  /** Last-known tokens occupying the native session context. */
  contextUsed?: number
}

export interface ModelSwitchCompactionDecision {
  /** Whether the native session should be compacted before resuming. */
  shouldCompact: boolean
  /** Human-readable reason when `shouldCompact` is true. */
  reason?: string
}

/**
 * Compact when the thread's last-known native usage already fills >=80% of the
 * new model's context window. Missing or invalid signals never trigger a
 * compaction — without a known window the app cannot judge a mismatch, and
 * without known usage it could over-compact a short conversation.
 */
export function decideModelSwitchCompaction(
  input: ModelSwitchCompactionInput
): ModelSwitchCompactionDecision {
  const { contextWindow, contextUsed } = input
  if (contextWindow === undefined || contextUsed === undefined) {
    return { shouldCompact: false }
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { shouldCompact: false }
  }
  if (!Number.isFinite(contextUsed) || contextUsed <= 0) {
    return { shouldCompact: false }
  }
  const threshold = Math.round(contextWindow * MODEL_SWITCH_COMPACT_THRESHOLD_RATIO)
  if (contextUsed >= threshold) {
    return {
      shouldCompact: true,
      reason: `native usage (${contextUsed} tokens) fills >=80% of the new model's ${contextWindow}-token window`
    }
  }
  return { shouldCompact: false }
}
