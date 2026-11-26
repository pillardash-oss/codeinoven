/**
 * One queued message as the queue card lists it.
 *
 * The card draws the head's full detail from its own props; every row, head
 * included, needs the little a list row shows: what it will say, how many files
 * go with it, and whether it waits on something before it sends.
 */
export interface QueuedRowSummary {
  /** Stable identity of the queued entry, which is what a reorder moves. */
  id: string
  /** The message text, empty when the entry carries only files or a picture. */
  text: string
  /** How many files the entry carries. */
  attachments: number
  /** How many threads the entry waits on before it sends. */
  waitsOn: number
  /** Whether the entry carries a presentation instead of editable text. */
  hasPresentation: boolean
}
