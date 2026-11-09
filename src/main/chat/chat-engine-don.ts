import {
  ASSISTANT_SPACE_ID,
  assistantIsBuiltin,
  type Assistant,
  type AgentMessage,
  type MessageAuthor,
  type Thread
} from '../../lib/types'
import { DON_ASSISTANT_ID, DON_ASSISTANT_NAME } from '../../lib/types/assistant'
import type { DonExecutor } from '../utilities/utility-orchestration-service'

/**
 * Don's delegation: the one thing the orchestrator exists for.
 *
 * Don answers what it already knows and hands everything else to an assistant whose
 * description fits. This module owns the handoff itself: it reads the roster Don
 * chooses from, starts the chosen assistant on its own thread, and remembers the
 * handoff so the assistant's answer can come back into Don's thread under its own
 * name when the run settles.
 *
 * It is deliberately in memory only. A delegation is a live instruction, and an app
 * restart has no turn left to report into: the run thread's own row and the
 * assistant's transcript carry the outcome from there.
 */

/** What the user asked to be called, as config stores it. */
export const DON_NAME_LIMIT = 80

/** One handoff Don made, waiting for the assistant's run to settle. */
export interface PendingDonDelegation {
  /** The thread the delegated assistant runs on. */
  runThreadId: string
  /** Don's thread, which the answer is written back into. */
  donProjectId: string
  donThreadId: string
  /** Who took the work, snapshotted so the reply keeps its speaker. */
  author: MessageAuthor
  assistantName: string
  request: string
  createdAt: number
}

/** The handoffs Don has made and has not yet been told about. */
export class DonDelegations {
  private readonly pending = new Map<string, PendingDonDelegation>()

  remember(delegation: PendingDonDelegation): void {
    this.pending.set(delegation.runThreadId, delegation)
  }

  /** Take and remove the handoff a settled run thread belongs to. */
  settle(runThreadId: string): PendingDonDelegation | undefined {
    const delegation = this.pending.get(runThreadId)
    if (!delegation) return undefined
    this.pending.delete(runThreadId)
    return delegation
  }

  has(runThreadId: string): boolean {
    return this.pending.has(runThreadId)
  }

  /** Read the handoff a run thread belongs to without consuming it, so a run
   *  that pauses can be reported and still report its answer when it settles. */
  peek(runThreadId: string): PendingDonDelegation | undefined {
    return this.pending.get(runThreadId)
  }

  /** Forget one handoff, when the run could not actually be started. */
  forget(runThreadId: string): void {
    this.pending.delete(runThreadId)
  }
}

/** Don's implementation as the chat engine holds it. */
export interface DonRuntime {
  executor: DonExecutor
  delegations: DonDelegations
  /**
   * The current speaker snapshot for one assistant, when the app still holds
   * that assistant. A report rebuilt from a thread row can carry only a name; the
   * renderer needs the mark and colour to draw the group message as that
   * assistant, so the report asks here instead of shipping a bare name.
   */
  resolveAuthor?: (assistantId: string) => MessageAuthor | null
}

/** A teammate Don hired, as the tool answers with it. */
export interface DonRecruitedAssistant {
  assistantId: string
  name: string
  /** The Getting started conversation the request was carried into. */
  threadId: string
}

/** Everything the executor needs from the chat engine, narrow enough to test. */
export interface DonDeps {
  /**
   * Say one thing in the group chat this run was started from, under the run
   * assistant's own name and mark, while the work is still going.
   */
  replyInGroupChat: (
    context: { projectId: string; threadId: string },
    text: string
  ) => Promise<{ posted: boolean; error?: string }>
  readUserName: () => Promise<string>
  writeUserName: (name: string) => Promise<string>
  /**
   * Hire the teammate a request needs: create it, then open its Getting started
   * conversation with the request already in it. The chat engine owns assistant
   * rows, thread creation and the turn lifecycle, so the executor only names what
   * it wants and forwards the turn it came from.
   */
  createAssistant: (
    input: { name: string; purpose: string; request?: string },
    context: { projectId: string; threadId: string }
  ) => Promise<DonRecruitedAssistant>
}

/** The speaker snapshot a delegated assistant's reply carries. */
export function delegationAuthor(assistant: Assistant): NonNullable<AgentMessage['author']> {
  return {
    assistantId: assistant.id,
    name: assistant.name,
    ...(assistant.icon ? { icon: assistant.icon } : {}),
    ...(assistant.iconType ? { iconType: assistant.iconType } : {}),
    ...(assistant.customSvg ? { customSvg: assistant.customSvg } : {}),
    ...(assistant.color ? { color: assistant.color } : {})
  }
}

/**
 * Whether an assistant can take a handoff right now.
 *
 * A handoff runs on the model of the conversation that started it, so the
 * assistant's own model is not a requirement here: an assistant with
 * instructions can take work even before its scheduled row has a model of its
 * own.
 */
export function assistantCanDelegate(
  assistant: Assistant
): { ok: true } | { ok: false; reason: string } {
  if (assistant.id === DON_ASSISTANT_ID || assistantIsBuiltin(assistant)) {
    return { ok: false, reason: `${DON_ASSISTANT_NAME} delegates; it does not take work` }
  }
  if (assistant.paused) return { ok: false, reason: `${assistant.name} is paused` }
  if (assistant.knowledge.trim().length === 0) {
    return { ok: false, reason: `${assistant.name} has no instructions yet` }
  }
  return { ok: true }
}

/** Normalize a name the user gave Don: one line, no surrounding punctuation. */
export function normalizeUserName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw
    .replace(/\s+/gu, ' ')
    .replace(/^[\s"'`(]+|[\s"'`).!,;:]+$/gu, '')
    .trim()
  return trimmed.slice(0, DON_NAME_LIMIT)
}

/**
 * Build Don's executor.
 *
 * The operations are deliberately small: storing the name the user chose and
 * saying something in the group chat the turn belongs to. Starting work on an
 * assistant or in a project is the orchestration tool's job, so there is one
 * dispatch path with one set of model and Oven rules, not two that drift.
 */
export function createDonExecutor(deps: DonDeps): DonExecutor {
  return async (operation, input, context) => {
    if (operation === 'reply-in-chat') {
      const text = typeof input['text'] === 'string' ? input['text'].trim() : ''
      if (text.length === 0) return { posted: false, error: 'There is nothing to say' }
      return deps.replyInGroupChat(
        { projectId: context.projectId, threadId: context.threadId },
        text.slice(0, 4000)
      )
    }
    if (operation === 'user-name') {
      const requested = normalizeUserName(input['name'])
      if (requested.length === 0) {
        const current = await deps.readUserName()
        return current.length > 0 ? { name: current } : { name: null }
      }
      const stored = await deps.writeUserName(requested)
      return { name: stored, stored: true }
    }
    if (operation === 'create-assistant') {
      const name = typeof input['name'] === 'string' ? input['name'].trim() : ''
      const purpose = typeof input['purpose'] === 'string' ? input['purpose'].trim() : ''
      if (name.length === 0 || purpose.length === 0) {
        throw new Error('A new assistant needs a name and what it is for')
      }
      const request = typeof input['request'] === 'string' ? input['request'].trim() : ''
      const created = await deps.createAssistant(
        { name, purpose, ...(request.length > 0 ? { request } : {}) },
        { projectId: context.projectId, threadId: context.threadId }
      )
      return {
        status: 'created',
        assistant: { id: created.assistantId, name: created.name },
        threadId: created.threadId,
        projectId: ASSISTANT_SPACE_ID,
        note: `The new assistant is being interviewed in its own Getting started conversation, and the request is already with it. Say one short line naming who was created and that the work is with them. Do not do the work yourself, and do not wait for it.`
      }
    }
  }
}

/** The last assistant text a settled run left behind, if it left one. */
export function lastAssistantText(messages: readonly AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    if (message.visibility !== undefined && message.visibility !== 'conversation') continue
    const text = message.parts
      .filter(
        (part): part is Extract<(typeof message.parts)[number], { type: 'text' }> =>
          part.type === 'text'
      )
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text.length > 0) return text
  }
  return null
}

/**
 * Rebuild the handoff a run thread was started by, from the thread row itself.
 *
 * A delegation lives in memory while the run is in flight, and an app restart
 * takes that memory with it. The thread still carries its dispatch origin, so a
 * run that settles after a restart reports back instead of finishing silently.
 * Only a thread Don started qualifies: its initiator is Don's own conversation
 * and it lives in the assistant space.
 */
export function delegationFromThread(
  thread: Thread,
  donThreadId: string
): PendingDonDelegation | null {
  const origin = thread.dispatchOrigin
  if (!origin) return null
  if (origin.initiatorThreadId !== donThreadId) return null
  if (origin.initiatorProjectId !== ASSISTANT_SPACE_ID) return null
  const assistantId = thread.assistantId ?? origin.assistantId
  const assistantName = origin.assistantName?.trim()
  if (!assistantId || !assistantName) return null
  return {
    runThreadId: thread.id,
    donProjectId: origin.initiatorProjectId,
    donThreadId: origin.initiatorThreadId,
    author: origin.author ?? { assistantId, name: assistantName },
    assistantName,
    request: thread.title,
    createdAt: thread.createdAt
  }
}

/**
 * What Don's thread says when a delegated run settled without an answer.
 *
 * A silent delegation is the one outcome the user cannot act on, so the outcome is
 * stated plainly, naming the assistant that took it.
 */
export function delegationOutcomeText(
  delegation: Pick<PendingDonDelegation, 'assistantName'>,
  status: string
): string {
  const who = delegation.assistantName
  if (status === 'completed') return `${who} finished without writing an answer.`
  if (status === 'failed') return `${who} could not finish the work. Its thread has the details.`
  return `${who} stopped before finishing (${status}).`
}
