import type {
  PromptAssignmentTaskReference,
  PromptAttachment,
  PromptProjectReference,
  PromptReference
} from '../../../lib/types'

/**
 * What the user put into a steer, as far as the undo window has to remember it.
 *
 * A held steer has not reached the harness yet, so its words, files and
 * references are still the user's to change. A second steer arriving while one
 * is held folds into it rather than replacing it, and this payload is what the
 * surviving message carries afterwards.
 */
export interface HeldSteerPayload {
  /** The words the user typed, exactly as the conversation shows them. */
  text: string
  /** The words the harness receives, when they differ from what is shown (a
   *  side chat's shortened label). Absent means `text` is both. */
  promptText?: string
  attachments: PromptAttachment[]
  promptReferences: PromptReference[]
  projectReferences: PromptProjectReference[]
  taskReferences: PromptAssignmentTaskReference[]
}

/** The separator between two steered messages folded into one. */
const HELD_STEER_JOIN = '\n'

/**
 * Fold one steered message's words into another.
 *
 * The hold used to keep a single steer per session and silently overwrite it,
 * so only the last message ever reached the harness while the earlier one
 * stayed on screen with its recall control: a message the agent never got.
 * When two steers are undoable at the same moment they are one request, so the
 * earlier words lead and the new ones follow on the next line.
 */
export function mergeHeldSteerText(previous: string, next: string): string {
  if (previous.trim().length === 0) return next
  if (next.trim().length === 0) return previous
  return `${previous}${HELD_STEER_JOIN}${next}`
}

/** Keep the first entry for every key, so a folded steer carries each file,
 *  selection or task reference exactly once. */
function dedupeBy<T>(entries: readonly T[], key: (entry: T) => string): T[] {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const entry of entries) {
    const id = key(entry)
    if (seen.has(id)) continue
    seen.add(id)
    kept.push(entry)
  }
  return kept
}

/** Fold an earlier held steer's whole payload into the message steering now. */
export function mergeHeldSteerPayload(
  previous: HeldSteerPayload,
  next: HeldSteerPayload
): HeldSteerPayload {
  return {
    text: mergeHeldSteerText(previous.text, next.text),
    promptText: mergeHeldSteerText(previous.promptText ?? previous.text, next.promptText ?? next.text),
    attachments: dedupeBy([...previous.attachments, ...next.attachments], (attachment) =>
      attachment.filename ? `${attachment.url}\n${attachment.filename}` : attachment.url
    ),
    promptReferences: dedupeBy(
      [...previous.promptReferences, ...next.promptReferences],
      (reference) => reference.id
    ),
    projectReferences: dedupeBy(
      [...previous.projectReferences, ...next.projectReferences],
      (reference) => `${reference.kind}:${reference.path}`
    ),
    taskReferences: dedupeBy(
      [...previous.taskReferences, ...next.taskReferences],
      (reference) => `${reference.assignmentId}:${reference.taskId}`
    )
  }
}
