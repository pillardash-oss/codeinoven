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
   * The routine that owns the task, when the task belongs to one. A routine's
   * decisions surface on any of its threads, so the panel is keyed to what the
   * gate concerns rather than to the window it happened to land in.
   */
  routineId?: string
  /** Epoch ms the gate was resolved. */
  at: number
  entries: AutoAnswerEntry[]
  /** Epoch ms the user dismissed the notice; absent while it is still unread. */
  dismissedAt?: number
}

/**
 * The identity a decision is keyed to, resolved from a thread row. Only the
 * fields the scope test needs, so a run thread, its task, and the task's routine
 * all match without loading the whole thread graph.
 */
export interface AutoAnswerThreadScope {
  id: string
  projectId: string
  routineId?: string
  assistantTaskId?: string
}

/**
 * Whether a decision concerns the given thread.
 *
 * A gate belongs to the conversation it settled on, and through that
 * conversation to the assistant task it ran for and the routine that owns that
 * task. It is shown wherever any of those is open, so an unattended decision is
 * visible exactly where the user would look for it.
 */
export function autoAnswerConcernsThread(
  item: AutoAnswerItem,
  thread: AutoAnswerThreadScope
): boolean {
  if (item.projectId !== thread.projectId) return false
  if (item.threadId === thread.id) return true
  if (
    item.taskId !== undefined &&
    (item.taskId === thread.id || item.taskId === thread.assistantTaskId)
  ) {
    return true
  }
  return item.routineId !== undefined && item.routineId === thread.routineId
}
