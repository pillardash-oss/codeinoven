import type { AgentMessage, AgentPart, AgentToolState } from '../../../lib/types'
import { toolActionLabel } from '../../../lib/tool-action-label'
import {
  acpArray,
  acpNumber,
  acpRecord,
  acpString,
  type AcpSessionUpdate,
  type AcpToolCallKind,
  type AcpToolCallStatus
} from './acp-protocol'

/** How a fold publishes its parts to the driver's event stream. */
export interface AcpTurnSink {
  partUpdated: (part: AgentPart) => void
  partDelta: (partId: string, field: string, delta: string) => void
}

type ToolPart = Extract<AgentPart, { type: 'tool' }>
type TextPart = Extract<AgentPart, { type: 'text' }>
type ReasoningPart = Extract<AgentPart, { type: 'reasoning' }>

/** Provider-neutral tool name for an ACP tool kind, so labels stay readable. */
export function acpToolName(kind: AcpToolCallKind | undefined, title: string): string {
  if (kind && kind !== 'other') return kind
  const word = /^[a-z0-9_-]+/iu.exec(title.trim())?.[0]
  return word && word.length <= 32 ? word.toLowerCase() : 'tool'
}

function acpToolStatus(status: AcpToolCallStatus | undefined): ToolPart['state']['status'] {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'error'
  if (status === 'in_progress') return 'running'
  return 'pending'
}

/** Text of the tool's own reported content (diffs, terminals, embedded text). */
function acpToolContentText(content: unknown): string {
  const chunks: string[] = []
  for (const entry of acpArray(content)) {
    const record = acpRecord(entry)
    if (!record) continue
    const type = acpString(record['type'])
    if (type === 'content') {
      const block = acpRecord(record['content'])
      const text = acpString(block?.['text'])
      if (text) chunks.push(text)
      continue
    }
    if (type === 'diff') {
      const path = acpString(record['path']) ?? ''
      const text = acpString(record['newText']) ?? ''
      if (path || text) chunks.push(`${path ? `${path}\n` : ''}${text}`)
      continue
    }
    if (type === 'terminal') {
      const terminalId = acpString(record['terminalId'])
      if (terminalId) chunks.push(`terminal ${terminalId}`)
    }
  }
  return chunks.join('\n')
}

/**
 * Folds one turn's `session/update` stream into the app's message/part model.
 *
 * One assistant message per turn: ACP streams chunks, not separate messages,
 * and the app's timeline expects the answer, its reasoning and every tool call
 * of a turn on the message that turn produced.
 *
 * A turn writes prose more than once. An ACP agent narrates the step it is about
 * to take ("I'll pull the schema, then ask"), calls a tool, and narrates again,
 * and ACP streams every one of those as `agent_message_chunk` on the same turn.
 * Each stretch of prose is therefore its own text block, closed by the next
 * provider message or by the tool call that follows it, because the app reads a
 * turn's closing text block as the answer and every earlier one as commentary
 * for the working trace (see `getTurnFinalText`). Folding a whole turn into one
 * text block shipped that running commentary as the answer, glued together with
 * no separator between the steps.
 */
export class AcpTurnFold {
  readonly createdAt = Date.now()
  private readonly parts: AgentPart[] = []
  /** Every text block this turn wrote, in the order it wrote them. */
  private readonly textParts: TextPart[] = []
  private reasoning = ''
  private textPart: TextPart | null = null
  /** Provider message the open text block belongs to, when ACP reports one. */
  private textPartMessageId: string | undefined
  /** Set once the open text block is closed by a tool call or a new message. */
  private textPartSettled = true
  private reasoningPart: ReasoningPart | null = null
  private readonly tools = new Map<string, ToolPart>()
  /** Context occupancy the agent reported during the turn. */
  usedContext: number | undefined
  contextWindow: number | undefined

  constructor(
    readonly sessionId: string,
    readonly messageId: string,
    private readonly sink: AcpTurnSink,
    /** Harness id of the agent this turn belongs to. */
    private readonly harnessId: string
  ) {}

  /** Apply one `session/update` payload. Unknown variants are ignored by design. */
  apply(update: AcpSessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.appendText(textOfChunk(update.content), update.messageId)
        return
      case 'agent_thought_chunk':
        this.appendReasoning(textOfChunk(update.content))
        return
      case 'tool_call':
        // The prose before a call has made its point; anything the agent writes
        // after it answers the result and starts a block of its own.
        this.closeTextBlock()
        this.upsertTool({
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          content: update.content
        })
        return
      case 'tool_call_update':
        this.upsertTool(update)
        return
      case 'usage_update':
        this.usedContext = acpNumber(update.used)
        this.contextWindow = acpNumber(update.size)
        return
      default:
        return
    }
  }

  /**
   * The turn's assistant message, ready for the transcript. Parts are copied
   * rather than shared: the fold keeps mutating its own part objects while
   * chunks arrive, and a transcript that held those references would absorb any
   * late chunk a second time after the message was already stored.
   */
  message(): AgentMessage {
    const answer = this.answerPart()
    return {
      id: this.messageId,
      role: 'assistant',
      parts: this.parts.map((part) =>
        part.type === 'text'
          ? {
              ...part,
              phase: part === answer ? ('final_answer' as const) : ('commentary' as const)
            }
          : { ...part }
      ),
      createdAt: this.createdAt,
      harnessId: this.harnessId
    }
  }

  /** Answer text the turn produced, used by the one-shot helpers. */
  answerText(): string {
    return this.answerPart()?.text ?? ''
  }

  /** The block the turn stopped on: the answer, never the commentary before it. */
  private answerPart(): TextPart | null {
    for (let index = this.textParts.length - 1; index >= 0; index -= 1) {
      const part = this.textParts[index]
      if (part && part.text.trim().length > 0) return part
    }
    return null
  }

  private appendText(delta: string, messageId: string | undefined): void {
    if (delta.length === 0) return
    const continuesOpenBlock =
      this.textPart !== null &&
      !this.textPartSettled &&
      (messageId === undefined ||
        this.textPartMessageId === undefined ||
        messageId === this.textPartMessageId)
    const part = continuesOpenBlock && this.textPart ? this.textPart : this.openTextBlock(messageId)
    part.text += delta
    this.sink.partDelta(part.id, 'text', delta)
  }

  private openTextBlock(messageId: string | undefined): TextPart {
    const part: TextPart = {
      type: 'text',
      id: `${this.messageId}:text:${this.textParts.length + 1}`,
      messageID: this.messageId,
      text: ''
    }
    this.textParts.push(part)
    this.parts.push(part)
    this.textPart = part
    this.textPartMessageId = messageId
    this.textPartSettled = false
    this.sink.partUpdated(part)
    return part
  }

  /** Close the open block so the next chunk starts a new stretch of prose. */
  private closeTextBlock(): void {
    if (this.textPart === null) return
    this.textPartSettled = true
    this.textPart = null
    this.textPartMessageId = undefined
  }

  private appendReasoning(delta: string): void {
    if (delta.length === 0) return
    if (!this.reasoningPart) {
      this.reasoningPart = {
        type: 'reasoning',
        id: `${this.messageId}:reasoning`,
        messageID: this.messageId,
        text: '',
        time: { start: Date.now() }
      }
      this.parts.push(this.reasoningPart)
      this.sink.partUpdated(this.reasoningPart)
    }
    this.reasoning += delta
    this.reasoningPart.text = this.reasoning
    this.sink.partDelta(this.reasoningPart.id, 'text', delta)
  }

  private upsertTool(update: {
    toolCallId: string
    title?: string | null
    kind?: AcpToolCallKind | null
    status?: AcpToolCallStatus | null
    rawInput?: unknown
    rawOutput?: unknown
    content?: readonly unknown[] | null
  }): void {
    const existing = this.tools.get(update.toolCallId)
    // An ACP agent's title describes what the call acted on (Cursor titles a
    // shell call with the command itself and a search with `Find `<pattern>``),
    // so it is the row's subject and never its action label. The label is
    // derived from the tool kind, the way every other harness's is.
    const reportedTitle = update.title?.trim() || existing?.state.title
    const title = reportedTitle || update.kind || 'tool'
    const input = acpRecord(update.rawInput) ?? existing?.state.input ?? {}
    const outputText = acpToolContentText(update.content)
    const status: AgentToolState['status'] = acpToolStatus(update.status ?? undefined)
    const tool = acpToolName(update.kind ?? undefined, title)
    // Only a kind names the action. Without one the title's own words are all the
    // row has, so it stays the label instead of being demoted to the subject.
    const kindNamesAction = !!update.kind && update.kind !== 'other'
    const label = toolActionLabel({ tool })
    const now = Date.now()
    const part: ToolPart = existing ?? {
      type: 'tool',
      id: `${this.messageId}:tool:${update.toolCallId}`,
      messageID: this.messageId,
      callID: update.toolCallId,
      tool,
      ...(label ? { actionLabel: label } : {}),
      state: {
        status: 'pending',
        input,
        ...(reportedTitle ? { title: reportedTitle } : {}),
        ...(reportedTitle && kindNamesAction ? { titleIsSubject: true } : {}),
        time: { start: now }
      }
    }
    // An agent that titles a call without naming its kind still owes the row an
    // action, and the label is stamped once so a settled call keeps it.
    part.actionLabel = part.actionLabel ?? label
    const finished = status === 'completed' || status === 'error'
    part.state = {
      ...part.state,
      status,
      input,
      ...(reportedTitle ? { title: reportedTitle } : {}),
      ...(reportedTitle && kindNamesAction ? { titleIsSubject: true } : {}),
      ...(outputText.length > 0 && status === 'completed' ? { output: outputText } : {}),
      ...(finished ? { time: { start: part.state.time?.start ?? now, end: now } } : {})
    }
    if (!existing) this.parts.push(part)
    this.tools.set(update.toolCallId, part)
    this.sink.partUpdated(part)
  }
}

/** Text of one streamed chunk, which ACP encodes as a content block. */
function textOfChunk(content: unknown): string {
  const record = acpRecord(content)
  if (!record) return ''
  const type = acpString(record['type'])
  if (type === 'text') return acpString(record['text']) ?? ''
  if (type === 'resource') return acpString(acpRecord(record['resource'])?.['text']) ?? ''
  if (type === 'resource_link') return acpString(record['uri']) ?? ''
  return ''
}
