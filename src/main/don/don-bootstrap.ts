import { ASSISTANT_SPACE_ID, type AgentMessage, type Thread } from '../../lib/types'
import { DON_ADDRESS_QUESTION, DON_THREAD_TITLE, donAssistantSeed } from '../../lib/don-assistant'
import { DON_ASSISTANT_ID } from '../../lib/types/assistant'
import type { AssistantManager } from '../../lib/engines/assistant-manager'
import type { ThreadManager } from '../../lib/engines/thread-manager'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'

/** The reserved thread id Don's one conversation is written under. */
export const DON_THREAD_ID = 'don'

/** What the bootstrap touched, so the caller can broadcast exactly that. */
export interface DonBootstrapResult {
  /** Don's thread, always present after a successful run. */
  thread: Thread | null
  /** Whether this call is what created Don's assistant row. */
  assistantCreated: boolean
  /** Whether this call is what created Don's thread. */
  threadCreated: boolean
}

/**
 * The greeting Don's thread opens with.
 *
 * It is written as an ordinary assistant message rather than asked by a model
 * turn: a fresh install should not spend a token before the user has said
 * anything, and the question has to be on screen the first time the thread is
 * opened. The message carries no model, provider or harness because no model
 * produced it, and the app's own transcript renders an author-less assistant
 * message as the thread's assistant.
 */
function donGreeting(at: number): AgentMessage {
  return {
    id: `${DON_THREAD_ID}-greeting`,
    role: 'assistant',
    origin: 'assistant',
    visibility: 'conversation',
    parts: [
      {
        type: 'text',
        id: `${DON_THREAD_ID}-greeting-part`,
        messageID: `${DON_THREAD_ID}-greeting`,
        text: DON_ADDRESS_QUESTION
      }
    ],
    createdAt: at
  }
}

/**
 * Seed Don, the app's orchestrator, once per install.
 *
 * Three rows make Don work, and all three are idempotent:
 *
 *   1. the assistant, under its reserved id, so the sidebar can always draw it and
 *      no import or rename can produce a second one;
 *   2. its single group thread, in the hidden assistant space, pinned so no
 *      eviction pass can take the one conversation delegated work reports into;
 *   3. the greeting that asks what to call the user, written once, before any
 *      model turn exists.
 *
 * Everything already present is left exactly as it is, so a user who changed Don's
 * model or connections keeps them across launches. Failure is logged and never
 * thrown: a broken orchestrator row must not stop the app from starting.
 */
export async function ensureDonOrchestrator(deps: {
  assistantManager: AssistantManager
  threadManager: ThreadManager
  storage: StorageEngine
}): Promise<DonBootstrapResult> {
  const { assistantManager, threadManager, storage } = deps
  try {
    const config = await storage.getConfig()
    // Don inherits the model the user already works on, so it can answer the first
    // time it is opened instead of arriving incomplete. The panel's Agents tab
    // changes it later like any other assistant.
    const primary = config.agentDefaults?.seniorEngineer
    const seed = donAssistantSeed(primary ? { primary, fallbacks: [] } : undefined)
    const { created: assistantCreated } = assistantManager.ensureBuiltinAssistant(seed)

    const existing = await threadManager.getThread(ASSISTANT_SPACE_ID, DON_THREAD_ID)
    if (existing) return { thread: existing, assistantCreated, threadCreated: false }

    await threadManager.createThread({
      id: DON_THREAD_ID,
      projectId: ASSISTANT_SPACE_ID,
      providerId: '',
      title: DON_THREAD_TITLE,
      titleSource: 'default',
      workingDirectory: '',
      assistantId: DON_ASSISTANT_ID,
      groupParticipants: [DON_ASSISTANT_ID],
      groupTitle: DON_THREAD_TITLE
    })
    // Pinning is a user action everywhere else, so it is an explicit write here
    // rather than a creation flag: the one thread the front door lives on has to
    // survive every eviction pass.
    await threadManager.setPinned(ASSISTANT_SPACE_ID, DON_THREAD_ID, true)
    await threadManager.upsertMessages(ASSISTANT_SPACE_ID, DON_THREAD_ID, [donGreeting(Date.now())])
    const thread = await threadManager.getThread(ASSISTANT_SPACE_ID, DON_THREAD_ID)
    return { thread, assistantCreated, threadCreated: true }
  } catch (error) {
    Logger.error('Don bootstrap failed', {
      error: error instanceof Error ? error.message : String(error)
    })
    return { thread: null, assistantCreated: false, threadCreated: false }
  }
}
