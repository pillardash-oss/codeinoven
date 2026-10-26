/**
 * Rules for the task-list reconcile exchange that can follow a finished answer.
 *
 * A run that settles on a lagging task list is nudged once to publish the true
 * list. That nudge is bookkeeping, but the model is free to keep talking, and its
 * words land in the same turn as the answer the user already read. The renderer
 * treats a turn's last text as the turn's answer and folds everything before it
 * into the working trace, so a list-only reply silently replaced the real answer
 * with three sentences about a checklist, and the answer itself became a trace
 * entry nobody can annotate.
 *
 * The exchange is identifiable from the boundary message:
 *
 * - a harness that nudges inside its own turn (pi's core-tools extension) reports
 *   the message that owns the answer;
 * - the engine's own reconcile prompt (`taskReconcilePrompt`) is the boundary, and
 *   the answer it must keep sits just before it.
 *
 * What the exchange is not allowed to do is replace that answer, unless it did
 * something material of its own. That distinction is the whole point: a reconcile
 * that only published the list belongs in the trace, and one that also fixed a
 * test or made a commit is a new answer the user must be able to read and annotate.
 */
import { isTodoToolPart } from '../../../lib/agent-todos'
import type { AgentMessage, AgentPart } from '../../../lib/types'
import { assistantText } from './chat-engine-message-text'

/** Where a turn's task-list reconcile exchange sits, and what it amounted to. */
export interface TaskReconcileExchange {
  /** The message the exchange starts after. */
  boundaryId: string
  /** Whether the exchange did anything beyond publishing the task list. */
  addedWork: boolean
}

/**
 * The turn's reconcile exchange, or null when the boundary message is not in the
 * transcript that was loaded for this turn (an older turn's mark, or a turn with
 * no nudge at all).
 */
export function taskReconcileExchange(
  messages: readonly AgentMessage[],
  boundaryId: string | undefined
): TaskReconcileExchange | null {
  if (boundaryId === undefined) return null
  const boundaryIndex = messages.findIndex((message) => message.id === boundaryId)
  if (boundaryIndex < 0) return null
  let addedWork = false
  for (let index = boundaryIndex + 1; index < messages.length; index++) {
    const message = messages[index]
    if (!message) continue
    if (isReconcileWorkMessage(message)) {
      addedWork = true
      break
    }
  }
  return { boundaryId, addedWork }
}

/**
 * Whether one message after the boundary is work of its own rather than a
 * publication of the task list.
 *
 * Deliberately broad: a steer, a deliverable, a delegated worker, or any tool the
 * agent chose to run means the exchange is doing something the reader has to be
 * told about. Reading a file to double-check a status counts, because the honest
 * handling is to keep the model's words and let the prompt ask for a recap, not to
 * throw away an answer that may carry information the reader needs.
 */
function isReconcileWorkMessage(message: AgentMessage): boolean {
  if (message.role === 'user') return message.visibility !== 'hidden'
  if (message.role !== 'assistant') return false
  if (message.structuredOutput !== undefined || message.inlineArtifact === true) return true
  return message.parts.some(isReconcileWorkPart)
}

function isReconcileWorkPart(part: AgentPart): boolean {
  if (part.type === 'tool') return !isTodoToolPart(part)
  return part.type === 'subagent' || part.type === 'file' || part.type === 'question'
}

/**
 * Move a reconcile exchange that added no work out of the turn's answer slot.
 *
 * Its prose is dropped rather than shown: the answer the agent already gave stays
 * the turn's closing text, so it is the message the reader can select and annotate,
 * and the corrected task list still renders in the working trace beside the work it
 * describes. Nothing else about the exchange changes, so its tool calls, its
 * reasoning, and its usage stay exactly where they were.
 */
export function demoteTaskReconcileAnswer(
  messages: readonly AgentMessage[],
  boundaryId: string
): AgentMessage[] {
  const boundaryIndex = messages.findIndex((message) => message.id === boundaryId)
  if (boundaryIndex < 0) return [...messages]
  return messages.map((message, index) => {
    if (index <= boundaryIndex || message.role !== 'assistant') return message
    return {
      ...message,
      visibility: 'working_trace',
      parts: message.parts.filter((part) => part.type !== 'text')
    }
  })
}

/**
 * The answer the exchange must not replace: the last assistant message that
 * carries one at or before the boundary.
 *
 * When the reconcile ran as a turn of its own (the engine-issued prompt), the
 * answer sits before this turn's transcript slice, so `earlier` (the thread's
 * surrounding messages) is searched as well, oldest-first ordering assumed, and
 * anything written after the boundary is refused.
 */
export function taskReconcileAnswer(
  messages: readonly AgentMessage[],
  boundaryId: string,
  earlier: readonly AgentMessage[]
): AgentMessage | undefined {
  const boundaryIndex = messages.findIndex((message) => message.id === boundaryId)
  if (boundaryIndex < 0) return undefined
  for (let index = boundaryIndex; index >= 0; index--) {
    const candidate = messages[index]
    if (candidate?.role !== 'assistant') continue
    if (carriesAnswer(candidate)) return candidate
  }
  const boundaryAt = messages[boundaryIndex]?.createdAt
  for (let index = earlier.length - 1; index >= 0; index--) {
    const candidate = earlier[index]
    if (candidate?.role !== 'assistant') continue
    if (candidate.visibility !== 'conversation') continue
    if (boundaryAt !== undefined && candidate.createdAt >= boundaryAt) continue
    if (carriesAnswer(candidate)) return candidate
  }
  return undefined
}

function carriesAnswer(message: AgentMessage): boolean {
  return assistantText(message).trim().length > 0 || message.structuredOutput !== undefined
}
