import type { AgentMessage } from './types'

/**
 * Harness-neutral recovery for a provider that answered "model at capacity".
 *
 * A model that is momentarily at capacity returns a refusal that says nothing
 * about the work in progress: the same session answers the same prompt normally
 * once it is asked again. Users learn this quickly and type `continue` by hand,
 * which is why pi has healed this class of failure silently for a while. This
 * module is the app-wide half of that contract: any harness that surfaces such
 * a failure as an error event is re-prompted automatically instead of parking
 * the thread on an error card.
 *
 * Detection is deliberately narrow and structural. It only ever runs on an
 * error the harness itself reported, never on assistant prose (an agent
 * discussing capacity in its answer must not be re-prompted), and it excludes
 * the two neighbouring failure families that already own their recovery:
 *
 * - usage/rate/quota limits, which become a scheduled reset wait, and
 * - oversized request bodies, which compact a `message.completed` recovery.
 */
export const CAPACITY_CONTINUE_MAX_ATTEMPTS = 3

/**
 * The prompt an owed continuation sends. It matches what the user types by
 * hand for exactly this failure, so the harness resumes its own work instead
 * of treating the nudge as a new task.
 */
export const CAPACITY_CONTINUE_PROMPT = 'Continue.'

/**
 * The message recorded on the interrupted attempt. It reaches the transcript's
 * turn record (and the developer logs), never an error card unless the budget
 * runs out and the failure is surfaced for real.
 */
export const CAPACITY_CONTINUE_MESSAGE =
  'The model was at capacity. Sent a continuation automatically.'

/**
 * Capacity phrasing, matched against a message whose separators were
 * normalized to spaces and lowercased. Every harness words this differently
 * ("Selected model is at capacity", `model_capacity_exceeded`,
 * "capacity exceeded"), so the shapes are listed instead of one literal.
 */
const CAPACITY_PATTERNS: readonly RegExp[] = [
  /\bat capacity\b/u,
  /\bcapacity (?:has been |is |was )?(?:exceeded|reached|exhausted|full)\b/u,
  /\bno (?:available |model )?capacity\b/u,
  /\bout of capacity\b/u
]

/** Failures that own a different recovery than a plain continuation. */
const OTHER_RECOVERY =
  /rate limit|usage limit|quota|too many requests|context (?:window|length)|maximum context|request body exceeds|too many images|exceeded your current/u

/**
 * True when a harness-reported error is a provider capacity refusal that a
 * plain `continue` recovers from.
 */
export function isCapacityContinueError(message: string | undefined | null): boolean {
  const text = message?.trim()
  if (!text) return false
  const normalized = text.replaceAll(/[_-]+/gu, ' ').toLowerCase()
  if (OTHER_RECOVERY.test(normalized)) return false
  return CAPACITY_PATTERNS.some((pattern) => pattern.test(normalized))
}

/**
 * Clear the claimed capacity error from a turn's messages before they are
 * persisted, so the continuation's own transcript does not carry a red error
 * row for a turn the app already recovered. A message that held nothing but
 * the failure is dropped entirely; a message that produced real content keeps
 * its content and only loses the error stamp.
 */
export function stripCapacityContinueErrors(messages: AgentMessage[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant' || !isCapacityContinueError(message.error)) continue
    message.error = undefined
    const hasContent = message.parts.some((part) => {
      if (part.type === 'text' || part.type === 'reasoning') return part.text.trim().length > 0
      return part.type === 'tool'
    })
    if (!hasContent) messages.splice(index, 1)
  }
}
