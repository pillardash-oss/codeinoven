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
  /** The conversation the gate settled on: what the panel is keyed to. */
  threadId: string
  /**
   * The assistant task this gate belongs to, when it settled on a run thread.
   * The run thread is transient and gets evicted, so without this a decision
   * would stop surfacing on the task it actually ran for.
   */
  taskId?: string
  /**
   * The assistant that owned the task when the gate settled. Provenance only: it
   * is kept on the record for reference and never keys where the decision shows,
   * because an assistant owns many tasks and a gate settled in one of them is not
   * news on the others.
   */
  assistantId?: string
  /** Epoch ms the gate was resolved. */
  at: number
  entries: AutoAnswerEntry[]
  /** Epoch ms the user dismissed the notice; absent while it is still unread. */
  dismissedAt?: number
}

/**
 * The identity a decision is keyed to, resolved from a thread row. Only the
 * fields the scope test needs, so the thread a gate settled on and the task
 * thread it ran for both match without loading the whole thread graph.
 */
export interface AutoAnswerThreadScope {
  id: string
  projectId: string
}

/**
 * Whether a decision concerns the given thread.
 *
 * A gate belongs to the one conversation that settled it, and to the assistant
 * task that conversation ran for: a run thread is transient and gets evicted, so
 * the task thread is the only other place the decision may surface. It never
 * widens to the assistant that owns the task, because one assistant holds many
 * tasks and a gate settled inside one of them would otherwise light the rail on
 * every thread of that assistant.
 */
export function autoAnswerConcernsThread(
  item: AutoAnswerItem,
  thread: AutoAnswerThreadScope
): boolean {
  if (item.projectId !== thread.projectId) return false
  if (item.threadId === thread.id) return true
  return item.taskId !== undefined && item.taskId === thread.id
}
