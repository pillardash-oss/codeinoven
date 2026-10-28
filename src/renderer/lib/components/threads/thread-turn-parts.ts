import { mergeSubagentParts } from '$lib/working-trace-parts'
import { isTodoToolPart } from '$lib/agent-todos'
import { checkpointForTurn } from '$lib/threads/checkpoint-matching'
import type {
  AgentMessage,
  AgentPart,
  AuditReport,
  TurnCheckpointChangeSummary,
  TurnCheckpointSummary
} from '$shared/types'

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
 * mid-turn on the user role, and an app-issued continuation prompt (origin
 * `orchestrator`, persisted hidden) re-prompts the same work. They must stay
 * invisible in the transcript but also transparent to turn grouping: one prompt
 * -> one working trace, with the final output after it.
 *
 * This mirrors the main process's `isTurnBoundaryPrompt`, which keeps the same
 * messages from moving the working trace's durable boundary.
 */
export function isActivityOnlyUserMessage(message: AgentMessage): boolean {
  if (message.origin === 'orchestrator') return true
  return (
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === 'compaction' || part.type === 'subagent')
  )
}

/**
 * Whether a user message is transparent to turn grouping: an activity notice
 * (compaction or sub-agent envelope), or a steer the renderer marked while it
 * waits for the harness. Neither opens or closes a turn, so the turn it rides
 * keeps one trace instead of splitting into a new one under the message.
 *
 * Unlike `isActivityOnlyUserMessage`, a transparent steer still renders: it is
 * the user's own message, it just does not move the turn boundary.
 */
export function isTurnTransparentUserMessage(message: AgentMessage): boolean {
  return isActivityOnlyUserMessage(message) || message.turnTransparent === true
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
 * Every per-message question the transcript render path asks, answered once per
 * transcript pass so the render path can read it by index.
 *
 * Each field is a function of message identity, role, and timestamps   never of
 * a part's text   which is what makes the index survive a streamed delta: a
 * delta replaces the text inside a part object that already exists, so the turn
 * boundaries, checkpoint windows, and part ownership recorded here stay true.
 * The caller rebuilds it when the message structure changes and reuses it
 * otherwise, so a long transcript costs one pass per structural change instead
 * of a rescan per mounted message on every streamed publish.
 *
 * Deliberately holds no part objects: a delta swaps the part object inside its
 * message, so a cached reference would silently go stale. Ids only.
 */
export interface TranscriptIndex {
  /** Part id -> the earliest message index that carries it. */
  partIndexById: Map<string, number>
  /** Last message index of the turn that contains this index. */
  turnEnd: number[]
  /** Whether the message at this index opens a turn. */
  isTurnStart: boolean[]
  /** Whether the message at this index closes a turn. */
  isTurnEnd: boolean[]
  /** Duration of the turn that ends at this index, or null. */
  duration: (number | null)[]
  /** Final text part id of the turn ending at this index, or ''. */
  finalTextId: string[]
  /** Message id -> its index in the transcript. */
  messageIndexById: Map<string, number>
  /** The checkpoint behind the assistant message at this index, or null. */
  checkpoint: (TurnCheckpointSummary | null)[]
  /**
   * Whether the checkpoint's file-changes card renders at this index   the
   * turn's final assistant, resolved by identity rather than by clock.
   */
  checkpointCard: boolean[]
  /**
   * The steered prompt that splits this card's turn, when a "changes so far"
   * card renders at this index instead of the whole turn's card. Null
   * everywhere else.
   */
  steerCard: (number | null)[]
  /** Whether the turn that opens at this index has completed. */
  turnCompleted: boolean[]
}

/**
 * The checkpoint that owns each assistant index, and the single index where
 * that checkpoint's file-changes card may render.
 *
 * A checkpoint records `sourceMessageId`, the prompt that opened its turn, so
 * the turn is anchored by identity instead of by clock. The turn runs until the
 * next prompt that opens one, which keeps a turn that stops on a mid-turn
 * question   and resumes behind the reader's answer   as one turn. That also
 * survives the harness flushing its final assistant message after the
 * checkpoint was completed: the completion timestamp used to cut the window
 * short, so the turn end the card attaches to fell outside it and the card
 * silently disappeared.
 *
 * Two checkpoints can share one prompt: a run that failed and was retried (or
 * resumed after a dropped connection) starts over on the prompt it never
 * finished. The newest checkpoint owns that slot whether or not it has finished
 * yet, so the failed attempt's card can never surface again under the work that
 * replaced it, and a slot whose newest run is still working shows no card at
 * all.
 *
 * A card states what a finished turn changed, so it only lands on the assistant
 * message that ends its own turn. A card sitting under a live trace reads as if
 * the work on screen already produced those files. A prompt sent mid-turn (a
 * steer, an answered question) belongs to the turn it interrupted, so it never
 * ends that turn's window or takes its card: the card still reports the whole
 * turn, once the turn is over.
 *
 * Checkpoints that predate `sourceMessageId`, or whose prompt is not in the
 * loaded transcript, keep the timestamp-window match as a fallback and only
 * claim indices no anchored turn already claimed.
 */
function resolveCheckpointOwners(
  messages: readonly AgentMessage[],
  checkpoints: readonly TurnCheckpointSummary[]
): {
  messageIndexById: Map<string, number>
  owners: (TurnCheckpointSummary | null)[]
  card: boolean[]
  steer: (number | null)[]
} {
  const owners: (TurnCheckpointSummary | null)[] = new Array(messages.length).fill(null)
  const card: boolean[] = new Array(messages.length).fill(false)
  const steer: (number | null)[] = new Array(messages.length).fill(null)
  /** Assistant indices a turn already decided, whether or not it owns them. */
  const claimed: boolean[] = new Array(messages.length).fill(false)

  const indexByMessageId = new Map<string, number>()
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message) indexByMessageId.set(message.id, index)
  }

  // Two checkpoints for one prompt (a resumed or retried turn) share a slot;
  // the newest one owns the turn, including while it is still running: an
  // active run supersedes the attempt that failed before it.
  const anchors = new Map<number, TurnCheckpointSummary>()
  for (const checkpoint of checkpoints) {
    const startId = checkpoint.sourceMessageId
    const start = startId === undefined ? undefined : indexByMessageId.get(startId)
    if (start === undefined) continue
    const prompt = messages[start]
    // A turn's prompt normally follows the previous turn's answer, so it is
    // never a "turn start" in the render path's sense. Requiring that here
    // rejected every prompt after the first one, and the first checkpoint then
    // spanned the whole transcript and took every later turn's card with it.
    if (!prompt || prompt.role !== 'user' || isTurnTransparentUserMessage(prompt)) continue
    const current = anchors.get(start)
    if (!current || current.createdAt <= checkpoint.createdAt) anchors.set(start, checkpoint)
  }

  const starts = [...anchors.keys()].sort((a, b) => a - b)
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!
    const checkpoint = anchors.get(start)!
    // The turn owns every message until the next anchored prompt, and it ends
    // at the last assistant message before the first prompt that was sent once
    // it had already finished. A prompt that arrives while the turn is still
    // running is a steer of that same turn, so it never splits the turn or
    // takes its card elsewhere.
    const windowEnd = starts[i + 1] ?? messages.length
    const turnEnd = nextTurnStartIndex(messages, start, windowEnd)
    let cardIndex = -1
    for (let index = start; index < windowEnd; index++) {
      const message = messages[index]
      if (!message || message.role !== 'assistant' || message.inlineArtifact) continue
      // A run that is still working claims its indices but places no card: the
      // attempt it replaced must not leave a card behind under the work being
      // redone, and a turn in flight reports its changes only once it ends.
      claimed[index] = true
      if (!isCompleted(checkpoint)) continue
      owners[index] = checkpoint
      if (index < turnEnd) cardIndex = index
    }
    if (cardIndex >= 0 && isTurnEndIndex(messages, cardIndex)) card[cardIndex] = true
    // A steer splits the turn into the work already done and the work it was
    // steered into, so the earlier half gets its own card above the steered
    // message, listing only the files recorded up to that point. The turn's own
    // card stays at its end with every file, the steered half's included.
    if (cardIndex < 0 || !isCompleted(checkpoint)) continue
    for (let index = start + 1; index < turnEnd; index++) {
      const message = messages[index]
      if (!message || message.role !== 'user' || isTurnTransparentUserMessage(message)) continue
      if (!promptContinuesTurn(messages, index, start)) continue
      const boundary = previousAssistantIndex(messages, index)
      if (boundary <= start || boundary >= cardIndex) continue
      if (isTurnEndIndex(messages, boundary)) steer[boundary] = index
    }
  }

  // Fallback for a checkpoint whose prompt is not in the loaded transcript: a
  // long thread loads a window of its messages, and the prompt that opened the
  // turn usually sits above it. Matching by timestamp then cut the turn at
  // `completedAt`, so a final assistant message the harness flushed after the
  // checkpoint settled fell outside the window, and the card lost its turn end
  // and disappeared even though the checkpoint held the changes. A turn also
  // runs until the next prompt that opens one, so the fallback adopts the run
  // up to that prompt instead of stopping at the completion clock.
  for (let index = 0; index < messages.length; index++) {
    if (claimed[index] || owners[index]) continue
    const owner = checkpointForTurn(messages, checkpoints, index)
    if (!owner) continue
    owners[index] = owner
    let cardIndex = index
    for (let next = index + 1; next < messages.length; next++) {
      const message = messages[next]
      // An index another turn already decided belongs to that turn, so the run
      // ends here rather than adopting someone else's answer.
      if (!message || claimed[next] || owners[next]) break
      if (message.role === 'user' && !isTurnTransparentUserMessage(message)) break
      if (message.role !== 'assistant' || message.inlineArtifact) continue
      owners[next] = owner
      cardIndex = next
    }
    // The fallback can match a trailing assistant of a run a later attempt
    // replaced, so it too places a card only where a turn actually ends.
    if (isTurnEndIndex(messages, cardIndex)) card[cardIndex] = true
    index = cardIndex
  }

  return { messageIndexById: indexByMessageId, owners, card, steer }
}

/**
 * Index of the first prompt at or after `from` that begins the next turn, or
 * `limit` when the turn runs to the end of the transcript.
 *
 * A prompt sent while the turn's last assistant message was still open belongs
 * to that turn: a steer continues it, and an answered question resumes it. Only
 * a prompt written after that message closed begins the next turn, which is why
 * this reads the message that was streaming rather than a checkpoint clock: the
 * two orders are independent, and the turn a prompt interrupted is a fact of the
 * transcript.
 */
function nextTurnStartIndex(
  messages: readonly AgentMessage[],
  start: number,
  limit: number
): number {
  for (let index = start + 1; index < limit; index++) {
    const message = messages[index]
    if (!message || message.role !== 'user' || isTurnTransparentUserMessage(message)) continue
    if (promptContinuesTurn(messages, index, start)) continue
    return index
  }
  return limit
}

/** Whether this prompt arrived while the turn that owns `start` was still writing. */
function promptContinuesTurn(
  messages: readonly AgentMessage[],
  index: number,
  start: number
): boolean {
  const prompt = messages[index]
  if (!prompt) return false
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const message = messages[cursor]
    if (!message) return false
    if (message.inlineArtifact) continue
    if (message.role === 'user') {
      if (isTurnTransparentUserMessage(message)) continue
      // A second prompt before the agent answered anything is the same turn's
      // steer, not a turn of its own.
      return cursor === start
    }
    return message.completedAt === undefined || message.completedAt > prompt.createdAt
  }
  return false
}

/** Index of the assistant message the prompt at `index` interrupted, or -1. */
function previousAssistantIndex(messages: readonly AgentMessage[], index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const message = messages[cursor]
    if (!message || message.inlineArtifact) continue
    return message.role === 'assistant' ? cursor : -1
  }
  return -1
}

/**
 * The files a turn had already changed when it was steered.
 *
 * Each recorded change names the tool messages that produced it, and a change
 * counts as done before the steer when any of those messages was written before
 * the steered prompt. Changes with no recorded source cannot be placed in time,
 * so they stay out of the "so far" card rather than implying the steer caused
 * them; the turn's own card at its end still lists every file.
 */
export function changesBeforeSteer(
  checkpoint: TurnCheckpointSummary,
  messageIndexById: ReadonlyMap<string, number>,
  promptIndex: number
): TurnCheckpointChangeSummary[] {
  return checkpoint.changes.filter((change) =>
    change.sources?.some((source) => {
      const at = messageIndexById.get(source.messageId)
      return at !== undefined && at < promptIndex
    })
  )
}

/** Whether a checkpoint has finished its turn and may show a changes card. */
function isCompleted(checkpoint: TurnCheckpointSummary): boolean {
  return checkpoint.status !== 'active'
}

/** Duration of a completed assistant message's turn, or null while unfinished. */
function turnDurationAt(messages: readonly AgentMessage[], messageIndex: number): number | null {
  const assistant = messages[messageIndex]
  if (assistant?.role !== 'assistant' || !assistant.completedAt) return null
  let startIndex = messageIndex - 1
  while (startIndex >= 0) {
    const message = messages[startIndex]
    if (!message) break
    if (message.role === 'assistant' || isTurnTransparentUserMessage(message)) {
      startIndex--
      continue
    }
    break
  }
  const prompt = messages[startIndex]
  if (prompt?.role !== 'user' || !prompt.createdAt) return null
  return assistant.completedAt - prompt.createdAt
}

/** Build the index for one transcript in a single pass. */
export function buildTranscriptIndex(
  messages: readonly AgentMessage[],
  checkpoints: readonly TurnCheckpointSummary[]
): TranscriptIndex {
  const count = messages.length
  const partIndexById = new Map<string, number>()
  const turnEnd: number[] = new Array(count)
  const isTurnStart: boolean[] = new Array(count)
  const isTurnEnd: boolean[] = new Array(count)
  const duration: (number | null)[] = new Array(count)
  const finalTextId: string[] = new Array(count)
  const checkpoint: (TurnCheckpointSummary | null)[] = new Array(count)
  const checkpointCard: boolean[] = new Array(count)
  const steerCard: (number | null)[] = new Array(count)
  const turnCompleted: boolean[] = new Array(count)

  for (let index = 0; index < count; index++) {
    const message = messages[index]
    if (!message) continue
    for (const part of message.parts) {
      if (!partIndexById.has(part.id)) partIndexById.set(part.id, index)
    }
  }

  const { messageIndexById, owners, card, steer } = resolveCheckpointOwners(messages, checkpoints)
  for (let index = 0; index < count; index++) {
    const opens = isTurnStartIndex(messages, index)
    const closes = isTurnEndIndex(messages, index)
    isTurnStart[index] = opens
    isTurnEnd[index] = closes
    turnEnd[index] = turnSpanEndIndex(messages, index)
    duration[index] = turnDurationAt(messages, index)
    finalTextId[index] = closes ? (getTurnFinalText(messages, index)?.id ?? '') : ''
    checkpoint[index] = owners[index] ?? null
    checkpointCard[index] = card[index] ?? false
    steerCard[index] = steer[index] ?? null
    turnCompleted[index] = opens ? isTurnCompleted(messages, index) : false
  }

  return {
    partIndexById,
    turnEnd,
    isTurnStart,
    isTurnEnd,
    duration,
    finalTextId,
    messageIndexById,
    checkpoint,
    checkpointCard,
    steerCard,
    turnCompleted
  }
}

/**
 * A predicate that reports a user message as transparent to turn grouping: an
 * activity notice, or a steer still held for its undo window. The default is
 * the persisted rule; callers that hold a live steer pass one that also checks
 * the held ids, because that state is not on the message itself.
 */
export type TurnTransparency = (message: AgentMessage) => boolean

const persistedTurnTransparency: TurnTransparency = (message) =>
  isTurnTransparentUserMessage(message)

/**
 * Index of the last message that belongs to the turn starting at
 * `startMsgIndex`. Activity-only user messages are transparent to the span.
 */
export function turnSpanEndIndex(
  messages: readonly AgentMessage[],
  startMsgIndex: number,
  isTransparent: TurnTransparency = persistedTurnTransparency
): number {
  let endIndex = startMsgIndex
  let cursor = startMsgIndex
  while (cursor + 1 < messages.length) {
    const next = messages[++cursor]
    if (next?.inlineArtifact) continue
    if (!next) break
    if (next.role === 'assistant' || isTransparent(next)) {
      endIndex = cursor
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
  endMsgIndex: number,
  isTransparent: TurnTransparency = persistedTurnTransparency
): number {
  for (let index = endMsgIndex; index >= 0; index--) {
    const message = messages[index]
    if (!message) break
    if (message.role !== 'user') continue
    if (isTransparent(message)) continue
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
    if (message.role !== 'user' || isTurnTransparentUserMessage(message)) continue
    const previous = messages[index - 1]
    if (previous?.role === 'user' && !isTurnTransparentUserMessage(previous)) continue
    starts.push(index)
  }
  return starts
}

export function isTurnStartIndex(messages: readonly AgentMessage[], index: number): boolean {
  if (messages[index]?.inlineArtifact) return false
  for (let i = index - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.inlineArtifact) continue
    if (!message) break
    if (message.role === 'assistant') return false
    if (!isTurnTransparentUserMessage(message)) return true
  }
  return true
}

export function isTurnEndIndex(messages: readonly AgentMessage[], index: number): boolean {
  if (messages[index]?.inlineArtifact) return false
  for (let i = index + 1; i < messages.length; i++) {
    const message = messages[i]
    if (message?.inlineArtifact) continue
    if (!message) break
    if (message.role === 'assistant') return false
    if (!isTurnTransparentUserMessage(message)) return true
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
    if (messages[i]?.inlineArtifact || messages[i]?.role !== 'assistant') continue
    let j = i
    let start = i
    while (j > 0) {
      const previous = messages[j - 1]
      if (previous?.inlineArtifact) {
        j--
        continue
      }
      if (previous?.role === 'assistant') {
        j--
        start = j
        continue
      }
      if (previous?.role === 'user' && isTurnTransparentUserMessage(previous)) {
        j--
        start = j
        continue
      }
      break
    }
    return start
  }
  return -1
}

/**
 * Index of the newest user message that opens a turn and still has no assistant
 * message mirrored after it, or -1 when the transcript's own turn already has
 * its assistant row (or has no user message at all).
 *
 * A turn that settles before the mirror captures it - a provider failure, a
 * user stop, a paused will-retry wait - has no assistant row, so the durable
 * working trace streaming for it has no turn of its own to render under. This
 * finds the prompt that work belongs to: the newest real user message, never an
 * activity notice (a compaction summary or sub-agent envelope). An assistant
 * row after the prompt means the turn is already represented by the mirror and
 * a durable duplicate must not mount.
 */
export function pendingTurnAnchorIndex(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user' || isTurnTransparentUserMessage(message)) continue
    const assistantMirrored = messages
      .slice(index + 1)
      .some((candidate) => candidate.role === 'assistant' && !candidate.inlineArtifact)
    return assistantMirrored ? -1 : index
  }
  return -1
}

type TurnTextPart = Extract<AgentPart, { type: 'text' }>

/**
 * The agent's closing statement for the turn ending at `endMsgIndex`: the last
 * non-empty text part of the turn.
 *
 * The text inside one turn is two different things. The statement the agent
 * leaves for the reader is the one it stops on; everything it writes between
 * tool calls ("Let me check the running instances") is commentary on work still
 * in progress. Only the closing statement is the transcript's answer, so a turn
 * reads as one message instead of a monologue, and each turn's statement is
 * what replaces the one before it. The commentary stays in the working trace at
 * its stream position, where it reads as the log of the work behind the answer,
 * and empty text placeholders emitted at a step start are never a statement.
 *
 * Because the closing statement is the turn's last text, it is also the text an
 * agent leaves behind when it hands the turn back with a question: whatever it
 * said last is what it is saying to the reader now.
 *
 * Activity-only user messages (compaction notices, sub-agent envelopes) are
 * transparent to the turn span, exactly as they are for the trace.
 */
export function getTurnFinalText(
  messages: readonly AgentMessage[],
  endMsgIndex: number,
  isTransparent: TurnTransparency = persistedTurnTransparency
): TurnTextPart | null {
  const turnStart = turnStartIndexForEnd(messages, endMsgIndex, isTransparent)
  let closing: TurnTextPart | null = null
  for (let i = turnStart; i <= endMsgIndex; i++) {
    const message = messages[i]
    if (!message || message.inlineArtifact) continue
    if (message.role === 'user') {
      if (isTransparent(message)) continue
      break
    }
    for (const part of message.parts) {
      if (part.type === 'text' && part.text.trim().length > 0) closing = part
    }
  }
  return closing
}

/** Parts that only mark where a step began or ended. They can follow a question
 *  without changing what the turn ended on. */
function isTurnBookkeepingPart(part: AgentPart): boolean {
  return part.type === 'step-start' || part.type === 'step-finish'
}

/**
 * True when the turn ending at `endMsgIndex` stops on the harness's question
 * tool: the agent is not working any more, it is waiting for the reader's
 * answer.
 *
 * The run stays flagged busy for as long as the question is pending, so the
 * busy flag alone would hold the agent's closing statement inside the trace
 * while it sits on screen unanswered. This is the evidence that the agent has
 * handed the turn back, and the statement belongs in the transcript with it.
 */
export function turnEndsOnQuestion(
  messages: readonly AgentMessage[],
  endMsgIndex: number,
  isTransparent: TurnTransparency = persistedTurnTransparency
): boolean {
  const turnStart = turnStartIndexForEnd(messages, endMsgIndex, isTransparent)
  for (let i = endMsgIndex; i >= turnStart; i--) {
    const message = messages[i]
    if (!message || message.inlineArtifact) continue
    if (message.role === 'user') {
      if (isTransparent(message)) continue
      break
    }
    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j]
      if (!part || isTurnBookkeepingPart(part)) continue
      if (part.type === 'text' && part.text.trim().length === 0) continue
      return part.type === 'question'
    }
  }
  return false
}

/**
 * Collect every ordered intermediate part as two runs: `leading` holds the
 * compaction/sub-agent context harvested from the activity messages that
 * precede the prompt, `body` holds the turn itself. They are kept apart
 * because the durable stream window can only supply the turn body: the leading
 * context must stay in front of it, while the body has to follow the log's
 * own order.
 *
 * Only the turn's closing text leaves the trace for the transcript (see
 * `getTurnFinalText`); every other text part stays in `body`, where it reads as
 * the commentary behind the answer. The auditor transcript renders its own
 * commentary from the trace, so its closing text stays in until the report card
 * replaces it.
 */
export function getTurnWorkingParts(
  messages: readonly AgentMessage[],
  startMsgIndex: number,
  includeCurrentFinal: boolean,
  isTransparent: TurnTransparency = persistedTurnTransparency
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
    if (!isTransparent(preceding)) break
  }
  const body: AgentPart[] = []
  const turnEndIndex = turnSpanEndIndex(messages, startMsgIndex, isTransparent)
  const finalText = getTurnFinalText(messages, turnEndIndex, isTransparent)
  for (let i = startMsgIndex; i <= turnEndIndex; i++) {
    const message = messages[i]
    if (message?.inlineArtifact) continue
    if (!message) break
    if (message.role === 'user') {
      if (!isTransparent(message)) break
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
 *
 * `holdsClosingText` is true while the trace owns the turn's closing statement
 * because the transcript is not showing it yet: the live text streams inside
 * the trace, and dropping it here would blank the very text the reader is
 * watching. Once the statement is promoted to the transcript, its trace copy is
 * dropped so the two surfaces never show the same sentence twice.
 */
export function streamWorkingPartsForTurn(
  streamParts: readonly AgentPart[],
  index: TranscriptIndex,
  startMsgIndex: number,
  holdsClosingText = false
): AgentPart[] {
  const turnEndIndex = index.turnEnd[startMsgIndex] ?? -1
  const finalTextId = turnEndIndex >= 0 ? (index.finalTextId[turnEndIndex] ?? '') : ''
  // The durable stream log is thread-wide and its turn tags are not a safe
  // scope: a steered continuation keeps the original turn's anchor, and log
  // segments written before turn binding fold into the latest turn. Drop
  // every durable part the mirror already persisted BEFORE this turn started
  // so earlier traces can never bleed into the newest one; parts not yet in
  // the mirror (the current turn's in-flight work) are exactly the gap this
  // list exists to fill. `partIndexById` answers that question by index lookup
  //   the previous form walked every earlier message on every render.
  return streamParts.filter((part) => {
    if (part.type === 'question' || isTodoToolPart(part)) return false
    if (
      !holdsClosingText &&
      part.type === 'text' &&
      finalTextId !== '' &&
      finalTextId === part.id
    ) {
      return false
    }
    const carriedAt = index.partIndexById.get(part.id)
    return carriedAt === undefined || carriedAt >= startMsgIndex
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
