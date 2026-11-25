/**
 * Conversations attached to a composer as context rather than as text.
 *
 * The user never has to copy a thread's content to ask about it: the composer
 * carries the thread's identity, the badge names it, and the agent is told which
 * thread it may read if the message needs that background. The whole payload is
 * the id, because the agent already reads threads by id (the app's diagnostics
 * tool looks one up), so nothing else has to travel with it.
 */
import type { PromptReference } from '$shared/types'

/** One conversation riding a prompt as context. */
export interface ThreadContextReference {
  /** Project the thread lives in, which is what the badge's icon names. */
  projectId: string
  /** The thread the agent may read. */
  threadId: string
  /** The thread's title as it was when the attachment was made. */
  title: string
}

/**
 * What an attached thread says to the agent, or undefined when nothing is
 * attached.
 *
 * This is hidden context, never part of the message the user wrote: it is folded
 * into the turn's prompt context so a removed attachment removes the sentence
 * too. One line per thread, and the sentence is exactly the instruction the
 * agent needs, because the lookup tool is already documented in its prompt.
 */
export function threadContextPrompt(
  references: readonly ThreadContextReference[]
): string | undefined {
  if (references.length === 0) return undefined
  return references
    .map(
      (reference) =>
        `You may lookup this thread: ${reference.threadId} if you need some context as to the sent message`
    )
    .join('\n')
}

/** Drop repeats of one thread, keeping the first attachment of it. */
export function uniqueThreadContextReferences(
  references: readonly ThreadContextReference[]
): ThreadContextReference[] {
  const kept: ThreadContextReference[] = []
  for (const reference of references) {
    if (kept.some((existing) => existing.threadId === reference.threadId)) continue
    kept.push(reference)
  }
  return kept
}

/**
 * An attached conversation as the chip its message keeps.
 *
 * The turn already carries the lookup sentence, so this travels for the reader:
 * after the send the composer has handed the attachment away, and the message is
 * the only place left that says which conversation the turn was given. It is the
 * same chip a selection becomes, so one row of the transcript shows every
 * attachment a prompt had, and clicking it opens the thread itself.
 */
export function threadReferenceAttachment(reference: ThreadContextReference): PromptReference {
  return {
    id: reference.threadId,
    label: reference.title,
    text: reference.threadId,
    kind: 'thread',
    threadId: reference.threadId,
    projectId: reference.projectId
  }
}
