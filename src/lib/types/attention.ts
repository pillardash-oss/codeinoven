/**
 * Auto-resolved gates: the cards the app settles on the user's behalf.
 *
 * A question whose timer runs out is answered with its recommended option, a
 * secret card whose deadline passes closes unanswered, and an image-descriptor
 * decision that times out is ignored. Each of those happens while the user is
 * away, so the decision has to leave a durable, inspectable record: what was
 * asked, the options that were offered, and what the app chose. The right-hand
 * attention rail reads these records so nothing is answered silently.
 */

/** Which kind of gate resolved without the user. */
export type AutoAnswerKind = 'question' | 'secret' | 'image-descriptor' | 'scope-confirmation'

/**
 * How a gate settled on its own.
 *
 * `auto-answered`   the timer picked the recommended option.
 * `expired`         the deadline closed the card; nothing could answer it.
 * `ignored`         the decision timed out and defaulted to taking no action.
 */
export type AutoAnswerOutcome = 'auto-answered' | 'expired' | 'ignored'

/** One question (or decision) inside an auto-resolved request. */
export interface AutoAnswerEntry {
  /** The question or prompt text. */
  prompt: string
  /** Short header shown above the prompt, when the provider supplied one. */
  header?: string
  /** Every option the user could have chosen, in the order they were offered. */
  options: string[]
  /** The label chosen on the user's behalf, or null when nothing was chosen. */
  picked: string | null
}

/** One gate the app resolved without the user. */
export interface AutoAnswerItem {
  /** The provider request id, unique per gate. */
  id: string
  kind: AutoAnswerKind
  outcome: AutoAnswerOutcome
  projectId: string
  threadId: string
  /** Epoch ms the gate was resolved. */
  at: number
  entries: AutoAnswerEntry[]
  /** Epoch ms the user dismissed the notice; absent while it is still unread. */
  dismissedAt?: number
}
