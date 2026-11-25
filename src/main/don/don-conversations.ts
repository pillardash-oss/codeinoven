import { ASSISTANT_SPACE_ID, type Thread, type ThreadSettings } from '../../lib/types'
import { DON_ASSISTANT_ID } from '../../lib/types/assistant'
import { donThreadSettings } from '../../lib/don-assistant'
import type { AgentModelSelection } from '../../lib/types/common'
import type { ThreadManager } from '../../lib/engines/thread-manager'
import { DEFAULT_THREAD_TITLE } from '../../lib/types/thread'

/**
 * Don's conversations.
 *
 * The orchestrator used to hold exactly one thread for its whole life. It now
 * holds one conversation per topic, each an ordinary assistant-space thread that
 * still belongs to Don: its own transcript, its own agent session, its own tab in
 * the assistant header, and a name the user can set.
 *
 * A thread is a Don conversation when it lives in the assistant space and its
 * assistant is Don. That one predicate is what every routing decision asks, so a
 * second conversation is not a special case anywhere else: dispatch reports, the
 * question router and the group-reply tool all follow the initiating thread rather
 * than a reserved id.
 *
 * The first conversation keeps the reserved `don` id, so installs, the intro turn,
 * voice and pending wakes continue against the same row they always did.
 */

/** Whether this thread is one of Don's conversations. */
export function isDonConversation(thread: Thread | null | undefined): thread is Thread {
  if (!thread) return false
  return thread.projectId === ASSISTANT_SPACE_ID && thread.assistantId === DON_ASSISTANT_ID
}

/**
 * Every conversation Don holds, newest activity first.
 *
 * Archived rows are left out: an archived conversation is one the user put away,
 * and nothing may reopen a place they closed.
 */
export async function listDonConversations(threadManager: ThreadManager): Promise<Thread[]> {
  const threads = await threadManager.listThreads(ASSISTANT_SPACE_ID)
  return threads
    .filter((thread) => !thread.archived && isDonConversation(thread))
    .sort((a, b) => b.lastActivity - a.lastActivity)
}

/** The conversation a surface with only a "Don" door should open. */
export async function newestDonConversation(threadManager: ThreadManager): Promise<Thread | null> {
  const conversations = await listDonConversations(threadManager)
  return conversations[0] ?? null
}

/** The next default name, so two empty conversations never read the same. */
function nextConversationTitle(taken: readonly Thread[]): string {
  const names = new Set(taken.map((thread) => thread.title.trim()))
  if (!names.has(DEFAULT_THREAD_TITLE)) return DEFAULT_THREAD_TITLE
  for (let index = 2; index < 500; index++) {
    const candidate = `${DEFAULT_THREAD_TITLE} ${index}`
    if (!names.has(candidate)) return candidate
  }
  return DEFAULT_THREAD_TITLE
}

/** What creating one conversation needs; kept narrow so it is testable alone. */
export interface CreateDonConversationDeps {
  threadManager: ThreadManager
  /** The model to fall back on when no conversation of Don's carries settings. */
  fallback?: AgentModelSelection | null
}

/**
 * Create one more conversation for Don.
 *
 * The new thread copies the settings of the conversation that already works, so it
 * can run the moment the user types without a second model decision. It is pinned:
 * a pin is what keeps the automatic capacity sweep away from a space the user
 * expects to find every launch, and the header strip already folds extra pinned
 * tabs behind a count rather than growing without bound.
 *
 * The title starts as the app's default and the first message renames it until the
 * user names it themselves, which is the same bargain every other thread makes.
 */
export async function createDonConversation(deps: CreateDonConversationDeps): Promise<Thread> {
  const { threadManager } = deps
  const existing = await listDonConversations(threadManager)
  const title = nextConversationTitle(existing)
  const inherited = existing.find((thread) => thread.settings)?.settings
  const settings: ThreadSettings | null = inherited
    ? { ...inherited }
    : deps.fallback
      ? donThreadSettings(deps.fallback)
      : null
  const created = await threadManager.createThread({
    projectId: ASSISTANT_SPACE_ID,
    providerId: settings?.providerId ?? '',
    title,
    workingDirectory: '',
    assistantId: DON_ASSISTANT_ID,
    groupParticipants: [DON_ASSISTANT_ID],
    groupTitle: title,
    ...(settings ? { settings } : {})
  })
  await threadManager.setPinned(ASSISTANT_SPACE_ID, created.id, true)
  return (await threadManager.getThread(ASSISTANT_SPACE_ID, created.id)) ?? created
}
