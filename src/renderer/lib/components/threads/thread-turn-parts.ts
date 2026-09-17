import { mergeSubagentParts } from '$lib/working-trace-parts'
import { isTodoToolPart } from '$lib/agent-todos'
import type { AgentMessage, AgentPart, AuditReport } from '$shared/types'

/**
 * Pure turn-partitioning rules for the conversation transcript.
 *
 * Every function here is a plain function of the persisted message list, so the
 * rules that decide where a turn starts and ends, which parts belong to its
 * working trace, and which part is its final answer can be reasoned about and
 * tested without a component instance or any reactive state.
 */

export type SubagentPart = Extract<AgentPart, { type: 'subagent' }>

/**
 * Activity-only user messages (compaction notices, sub-agent envelopes) ride
 * mid-turn on the user role. They must stay invisible in the transcript but
 * also transparent to turn grouping: one prompt -> one working trace, with the
 * final output after it.
 */
export function isActivityOnlyUserMessage(message: AgentMessage): boolean {
  return (
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === 'compaction' || part.type === 'subagent')
  )
}

/**
 * Collapse every persisted copy of one sub-agent part into the first copy.
 * Only that copy renders; later copies are folded into it through
 * `mergeSubagentParts`.
 */
export function resolvedSubagentPart(
  part: SubagentPart,
  messages: readonly AgentMessage[]
): SubagentPart | null {
  const childSessionId = part.activity.childSessionId
  if (!childSessionId) return part
  const related = messages.flatMap((message) =>
    message.parts.filter(
      (candidate): candidate is SubagentPart =>
        candidate.type === 'subagent' && candidate.activity.childSessionId === childSessionId
    )
  )
  const first = related[0]
  if (!first || first.id !== part.id || first.messageID !== part.messageID) return null
  return related.slice(1).reduce(mergeSubagentParts, first)
}

/** Append a working-trace part, folding compaction summaries and sub-agent copies. */
export function appendWorkingPart(
  parts: AgentPart[],
  part: AgentPart,
  messages: readonly AgentMessage[]
): void {
  if (part.type === 'compaction-summary') {
    const compactionIndex = parts.findLastIndex((candidate) => candidate.type === 'compaction')
    const compaction = parts[compactionIndex]
    if (compaction?.type === 'compaction') {
      parts[compactionIndex] = { ...compaction, summary: part.text }
    } else {
      parts.push(part)
    }
    return
  }
  if (part.type !== 'subagent') {
    parts.push(part)
    return
  }
  const resolved = resolvedSubagentPart(part, messages)
  if (resolved) parts.push(resolved)
}

/**
 * Index of the last message that belongs to the turn starting at
 * `startMsgIndex`. Activity-only user messages are transparent to the span.
 */
export function turnSpanEndIndex(messages: readonly AgentMessage[], startMsgIndex: number): number {
  let endIndex = startMsgIndex
  while (endIndex + 1 < messages.length) {
    const next = messages[endIndex + 1]
    if (!next) break
    if (next.role === 'assistant' || isActivityOnlyUserMessage(next)) {
      endIndex += 1
      continue
    }
    break
  }
  return endIndex
}

/**
 * Index just after the prompt that opens the turn ending at `endMsgIndex`.
 * Falls back to `endMsgIndex` when no opening prompt is found in the list.
 */
export function turnStartIndexForEnd(
  messages: readonly AgentMessage[],
  endMsgIndex: number
): number {
  for (let index = endMsgIndex; index >= 0; index--) {
    const message = messages[index]
    if (!message) break
    if (message.role !== 'user') continue
    if (isActivityOnlyUserMessage(message)) continue
    return index + 1
  }
  return endMsgIndex
}

/**
 * Deduped turn-start prompt indices before `fromIndex`, newest-first.
 * Every persisted turn carries the prompt twice (the display row and the
 * harness echo under its own id); counting both corrupts the "three pages"
 * anchor math, so adjacent prompt copies count as one turn start.
 */
export function turnStartPromptsBefore(
  messages: readonly AgentMessage[],
  fromIndex: number,
  count: number
): number[] {
  const starts: number[] = []
  for (let index = fromIndex - 1; index >= 0 && starts.length < count; index--) {
    const message = messages[index]
    if (!message) break
    if (message.role !== 'user' || isActivityOnlyUserMessage(message)) continue
    const previous = messages[index - 1]
    if (previous?.role === 'user' && !isActivityOnlyUserMessage(previous)) continue
    starts.push(index)
  }
  return starts
}

export function isTurnStartIndex(messages: readonly AgentMessage[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) break
    if (message.role === 'assistant') return false
    if (!isActivityOnlyUserMessage(message)) return true
  }
  return true
}

export function isTurnEndIndex(messages: readonly AgentMessage[], index: number): boolean {
  for (let i = index + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) break
    if (message.role === 'assistant') return false
    if (!isActivityOnlyUserMessage(message)) return true
  }
  return true
}

/**
 * Return the index of the first assistant message of the last turn in the
 * list. A trailing steer (a user message the agent has not responded to yet)
 * does not end the turn it intervenes in, so the last turn is the one that
 * contains the last assistant message, regardless of unresponded steers
 * appended after it. Returns -1 when no assistant message exists.
 */
export function lastTurnStartIndex(messages: readonly AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'assistant') continue
    let j = i
    while (j > 0) {
      const previous = messages[j - 1]
      if (previous?.role === 'assistant') {
        j--
        continue
      }
      if (previous?.role === 'user' && isActivityOnlyUserMessage(previous)) {
        j--
        continue
      }
      break
    }
    return j
  }
  return -1
}

/**
 * Find the last text part in a turn ending at the given message index.
 * Activity-only user messages are transparent to the turn span.
 */
export function getTurnFinalText(
  messages: readonly AgentMessage[],
  endMsgIndex: number
): AgentPart | null {
  const turnStart = turnStartIndexForEnd(messages, endMsgIndex)
  let finalText: AgentPart | null = null
  for (let i = turnStart; i <= endMsgIndex; i++) {
    if (i >= messages.length) break
    const message = messages[i]
    if (!message) break
    if (message.role === 'user') {
      if (isActivityOnlyUserMessage(message)) continue
      break
    }
    for (const part of message.parts) {
      if (part.type === 'text') finalText = part
    }
  }
  return finalText
}

/**
 * Collect every ordered intermediate part as two runs: `leading` holds the
 * compaction/sub-agent context harvested from the activity messages that
 * precede the prompt, `body` holds the turn itself. They are kept apart
 * because the durable stream window can only supply the turn body: the leading
 * context must stay in front of it, while the body has to follow the log's
 * own order. Only the final text is rendered below the trace.
 */
export function getTurnWorkingParts(
  messages: readonly AgentMessage[],
  startMsgIndex: number,
  includeCurrentFinal: boolean
): { leading: AgentPart[]; body: AgentPart[] } {
  const leading: AgentPart[] = []
  for (let i = startMsgIndex - 1; i >= 0; i--) {
    const preceding = messages[i]
    if (!preceding || preceding.role !== 'user') break
    for (const part of preceding.parts) {
      if (part.type === 'compaction' || part.type === 'subagent') {
        appendWorkingPart(leading, part, messages)
      }
    }
    if (!isActivityOnlyUserMessage(preceding)) break
  }
  const body: AgentPart[] = []
  const turnEndIndex = turnSpanEndIndex(messages, startMsgIndex)
  const finalText = getTurnFinalText(messages, turnEndIndex)
  for (let i = startMsgIndex; i <= turnEndIndex; i++) {
    const message = messages[i]
    if (!message) break
    if (message.role === 'user') {
      if (!isActivityOnlyUserMessage(message)) break
      for (const part of message.parts) {
        if (part.type === 'compaction' || part.type === 'subagent') {
          appendWorkingPart(body, part, messages)
        }
      }
      continue
    }
    for (const part of message.parts) {
      if (
        part.type === 'text' &&
        finalText &&
        part.id === finalText.id &&
        (!includeCurrentFinal || part.phase === 'final_answer')
      ) {
        continue
      }
      if (part.type === 'question') continue
      if (isTodoToolPart(part)) continue
      appendWorkingPart(body, part, messages)
    }
  }
  return { leading, body }
}

/**
 * True once the turn starting at `startMsgIndex` produced a completed
 * assistant message: the only state in which the working trace may fold.
 */
export function isTurnCompleted(messages: readonly AgentMessage[], startMsgIndex: number): boolean {
  const endIndex = turnSpanEndIndex(messages, startMsgIndex)
  const last = messages[endIndex]
  return last?.role === 'assistant' && last.completedAt !== undefined
}

export function hasRenderableWorkingParts(parts: readonly AgentPart[]): boolean {
  return parts.some(
    (part) =>
      part.type === 'reasoning' ||
      part.type === 'tool' ||
      part.type === 'subagent' ||
      part.type === 'compaction' ||
      part.type === 'compaction-summary' ||
      part.type === 'step-finish' ||
      part.type === 'file'
  )
}

/**
 * Merge durable stream-log parts (freshest) with mirror parts, deduped by id
 * and preserving the preferred list's order (see `mergeWorkingParts`).
 */
export function streamWorkingPartsForTurn(
  messages: readonly AgentMessage[],
  streamParts: readonly AgentPart[],
  startMsgIndex: number
): AgentPart[] {
  const turnEndIndex = turnSpanEndIndex(messages, startMsgIndex)
  const finalText = getTurnFinalText(messages, turnEndIndex)
  // The durable stream log is thread-wide and its turn tags are not a safe
  // scope: a steered continuation keeps the original turn's anchor, and log
  // segments written before turn binding fold into the latest turn. Drop
  // every durable part the mirror already persisted BEFORE this turn started
  // so earlier traces can never bleed into the newest one; parts not yet in
  // the mirror (the current turn's in-flight work) are exactly the gap this
  // list exists to fill.
  const priorPartIds = new Set<string>()
  for (let i = 0; i < startMsgIndex; i++) {
    for (const part of messages[i]?.parts ?? []) priorPartIds.add(part.id)
  }
  return streamParts.filter((part) => {
    if (part.type === 'question' || isTodoToolPart(part)) return false
    if (part.type === 'text' && finalText?.id === part.id) return false
    return !priorPartIds.has(part.id)
  })
}

/** Match a completed auditor turn to the report version created before the next turn. */
export function auditReportForTurn(
  messages: readonly AgentMessage[],
  auditVersions: readonly AuditReport[],
  msgIndex: number
): AuditReport | null {
  let turnStartedAt = 0
  for (let index = msgIndex; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (candidate?.role !== 'user') continue
    turnStartedAt = candidate.createdAt
    break
  }
  let nextTurnStartedAt = Number.POSITIVE_INFINITY
  for (let index = msgIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index]
    if (candidate?.role !== 'user') continue
    nextTurnStartedAt = candidate.createdAt
    break
  }
  return (
    auditVersions.find(
      (report) => report.createdAt >= turnStartedAt && report.createdAt < nextTurnStartedAt
    ) ?? null
  )
}
