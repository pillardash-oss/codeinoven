import { Logger } from '../system/logger'
import {
  assistantIsBuiltin,
  type Assistant,
  type AgentMessage,
  type MessageAuthor,
  type Thread
} from '../../lib/types'
import { assistantPrimaryModel, settingsWithAssistantModel } from '../../lib/assistant-agents'
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

  /** Forget one handoff, when the run could not actually be started. */
  forget(runThreadId: string): void {
    this.pending.delete(runThreadId)
  }
}

/** Don's implementation as the chat engine holds it. */
export interface DonRuntime {
  executor: DonExecutor
  delegations: DonDelegations
}

/** Everything the executor needs from the chat engine, narrow enough to test. */
export interface DonDeps {
  assistants: () => Assistant[]
  getAssistant: (assistantId: string) => Assistant | null
  /**
   * Create the thread a delegation runs on and dispatch the request into it.
   * Returns the created thread, or null when the run could not be started.
   */
  startDelegation: (
    assistant: Assistant,
    request: string
  ) => Promise<{ thread: Thread } | { error: string }>
  /** Announce that a delegation started, so Don's thread shows it working. */
  announceDelegation: (delegation: PendingDonDelegation) => Promise<void>
  readUserName: () => Promise<string>
  writeUserName: (name: string) => Promise<string>
}

/** One assistant as Don sees it, when it asks for the roster. */
interface DelegationCandidate {
  assistantId: string
  name: string
  description?: string
  /** Whether it has instructions and a model, so a handoff can actually run. */
  ready: boolean
  paused: boolean
  scheduled: boolean
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

/** Whether an assistant can take a handoff right now. */
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
  if (!assistantPrimaryModel(assistant.agents)) {
    return { ok: false, reason: `${assistant.name} has no model yet` }
  }
  return { ok: true }
}

/** The roster Don reads before it picks, in sidebar order. */
export function delegationRoster(assistants: readonly Assistant[]): DelegationCandidate[] {
  return assistants
    .filter((assistant) => assistant.id !== DON_ASSISTANT_ID && !assistantIsBuiltin(assistant))
    .map((assistant) => ({
      assistantId: assistant.id,
      name: assistant.name,
      ...(assistant.description ? { description: assistant.description } : {}),
      ready: assistantCanDelegate(assistant).ok,
      paused: assistant.paused === true,
      scheduled: assistant.scheduled !== false
    }))
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

/** The model a delegated run starts on, from the assistant's own model set. */
export function delegationSettings(settings: Thread['settings'], assistant: Assistant) {
  const primary = assistantPrimaryModel(assistant.agents)
  return primary && settings ? settingsWithAssistantModel(settings, primary) : settings
}

/**
 * Build Don's executor.
 *
 * The two operations are deliberately small: one reads the roster or starts a
 * handoff, the other reads or stores the user's name. Every judgement about *which*
 * assistant fits stays with the model, exactly as skill selection does, and the app
 * only validates the id it is given.
 */
export function createDonExecutor(deps: DonDeps): DonExecutor {
  return async (operation, input) => {
    if (operation === 'user-name') {
      const requested = normalizeUserName(input['name'])
      if (requested.length === 0) {
        const current = await deps.readUserName()
        return current.length > 0 ? { name: current } : { name: null }
      }
      const stored = await deps.writeUserName(requested)
      return { name: stored, stored: true }
    }

    const assistantId = typeof input['assistantId'] === 'string' ? input['assistantId'].trim() : ''
    if (assistantId.length === 0) {
      return { assistants: delegationRoster(deps.assistants()) }
    }

    const assistant = deps.getAssistant(assistantId)
    if (!assistant) {
      return { delegated: false, error: `No assistant has the id ${assistantId}` }
    }
    const usable = assistantCanDelegate(assistant)
    if (!usable.ok) return { delegated: false, assistant: assistant.name, error: usable.reason }

    const request = typeof input['request'] === 'string' ? input['request'].trim() : ''
    if (request.length === 0) {
      return { delegated: false, assistant: assistant.name, error: 'The request was empty' }
    }

    const started = await deps.startDelegation(assistant, request)
    if ('error' in started)
      return { delegated: false, assistant: assistant.name, error: started.error }

    const delegation: PendingDonDelegation = {
      runThreadId: started.thread.id,
      donProjectId: started.thread.dispatchOrigin?.initiatorProjectId ?? started.thread.projectId,
      donThreadId: started.thread.dispatchOrigin?.initiatorThreadId ?? '',
      author: delegationAuthor(assistant),
      assistantName: assistant.name,
      request,
      createdAt: Date.now()
    }
    try {
      await deps.announceDelegation(delegation)
    } catch (error) {
      Logger.dev('Don delegation activity card skipped:', error)
    }
    return {
      delegated: true,
      assistant: assistant.name,
      assistantId: assistant.id,
      threadId: started.thread.id,
      note: 'Accepted. The assistant runs on its own thread; its reply appears in this conversation under its own name. Do not wait for it.'
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
