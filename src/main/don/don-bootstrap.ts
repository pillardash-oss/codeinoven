import { ASSISTANT_SPACE_ID, type Thread, type ThreadSettings } from '../../lib/types'
import {
  DON_KNOWLEDGE,
  DON_THREAD_TITLE,
  donAssistantSeed,
  donThreadSettings
} from '../../lib/don-assistant'
import { DON_ASSISTANT_ID } from '../../lib/types/assistant'
import type { AgentModelSelection } from '../../lib/types/common'
import { assistantPrimaryModel } from '../../lib/assistant-agents'
import type { AssistantManager } from '../../lib/engines/assistant-manager'
import type { ThreadManager } from '../../lib/engines/thread-manager'
import { Logger } from '../system/logger'

/** The reserved thread id Don's one conversation is written under. */
export const DON_THREAD_ID = 'don'

/**
 * The greeting earlier builds seeded as a plain message.
 *
 * Don now opens the conversation the way every other assistant does, with a
 * real turn the model answers, so the static question is retired on launch for
 * installs that already had it.
 */
const LEGACY_GREETING_ID = `${DON_THREAD_ID}-greeting`

/** What the bootstrap touched, so the caller can broadcast exactly that. */
export interface DonBootstrapResult {
  /** Don's thread, always present after a successful run. */
  thread: Thread | null
  /** Whether this call is what created Don's assistant row. */
  assistantCreated: boolean
  /** Whether this call is what created Don's thread. */
  threadCreated: boolean
  /** Whether this call is what gave an existing thread its model settings. */
  threadSettingsRepaired: boolean
}

/**
 * Seed Don, the app's orchestrator, once per install.
 *
 * Three rows make Don work, and all three are idempotent:
 *
 *   1. the assistant, under its reserved id, so the sidebar can always draw it and
 *      no import or rename can produce a second one;
 *   2. its single group thread, in the hidden assistant space, pinned so no
 *      eviction pass can take the one conversation delegated work reports into,
 *      and carrying the same thread settings every assistant task carries, so
 *      the engine can actually run a turn on it;
 *   3. nothing else. Don introduces itself the way every other assistant does,
 *      with a real turn when the user first opens it, instead of a pre-written
 *      question sitting in the transcript with no model behind it.
 *
 * Everything already present is left exactly as it is, so a user who changed Don's
 * model or connections keeps them across launches. The one repair is a thread
 * seeded before settings were written: a model with no settings can never run,
 * so a resolvable default is written once. Failure is logged and never thrown: a
 * broken orchestrator row must not stop the app from starting.
 */
export async function ensureDonOrchestrator(deps: {
  assistantManager: AssistantManager
  threadManager: ThreadManager
}): Promise<DonBootstrapResult> {
  const { assistantManager, threadManager } = deps
  try {
    // Don's own assistant record owns his model. A global Sr. Engineer default used
    // to override it, which made Don run on a model the user never chose for him.
    // On a fresh install there is no record yet, so he inherits the model of the
    // conversation the user last worked in, which is what the app itself treats as
    // "the model you are using" when a new thread starts.
    const primary: AgentModelSelection | undefined =
      assistantPrimaryModel(assistantManager.getAssistant(DON_ASSISTANT_ID)?.agents) ??
      (await mostRecentThreadModel(threadManager))
    const seed = donAssistantSeed(primary ? { primary, fallbacks: [] } : undefined)
    const { created: assistantCreated } = assistantManager.ensureBuiltinAssistant(seed)
    // The instructions moved from a dedicated delegate tool to the unified
    // dispatch tool, later from asking the user to settle a dispatched question to
    // settling it in Don's own turn, later still to settling an install suggestion
    // too, and then to Don writing a hire's instructions itself. Only knowledge
    // that still reads as one of those shipped versions is upgraded, so an install
    // that changed Don's own instructions keeps them.
    const existingAssistant = assistantManager.getAssistant(DON_ASSISTANT_ID)
    if (
      existingAssistant?.knowledge.includes('cio_delegate') ||
      existingAssistant?.knowledge.includes('nothing travels through you') ||
      existingAssistant?.knowledge.includes(
        "already in this conversation under the thread's own badge"
      ) ||
      existingAssistant?.knowledge.includes('writes its own instructions')
    ) {
      assistantManager.updateAssistant(DON_ASSISTANT_ID, { knowledge: DON_KNOWLEDGE })
    }
    const settings = primary ? donThreadSettings(primary) : null

    const existing = await threadManager.getThread(ASSISTANT_SPACE_ID, DON_THREAD_ID)
    if (existing) {
      await threadManager.deleteAppMessages(ASSISTANT_SPACE_ID, DON_THREAD_ID, [LEGACY_GREETING_ID])
      let threadSettingsRepaired = false
      if (!existing.settings && settings) {
        await threadManager.updateSettings(ASSISTANT_SPACE_ID, DON_THREAD_ID, settingsFor(settings))
        threadSettingsRepaired = true
      }
      // An earlier build let the first opening prompt auto-title this thread,
      // which put the app's instruction text in the sidebar. The group
      // participants were also never persisted by that build, which is what made
      // the conversation render as a project transcript instead of the group chat
      // it is.
      //
      // A name the user gave this conversation is theirs: Don now holds one
      // conversation per topic, and the seeded name is only ever restored while
      // the title is still one the app wrote. A manual title is left exactly as it
      // is, and the group shape is repaired without touching the row's identity.
      const userNamed = existing.titleSource === 'manual'
      const needsTitleRepair = !userNamed && existing.title !== DON_THREAD_TITLE
      const needsGroupRepair =
        existing.assistantId !== DON_ASSISTANT_ID ||
        existing.groupParticipants?.[0] !== DON_ASSISTANT_ID ||
        existing.groupTitle === undefined
      if (needsTitleRepair || needsGroupRepair) {
        await threadManager.updateThread(ASSISTANT_SPACE_ID, DON_THREAD_ID, {
          ...(needsTitleRepair ? { title: DON_THREAD_TITLE, titleSource: 'manual' as const } : {}),
          assistantId: DON_ASSISTANT_ID,
          groupParticipants: [DON_ASSISTANT_ID],
          groupTitle: existing.groupTitle ?? existing.title
        })
      }
      const thread = await threadManager.getThread(ASSISTANT_SPACE_ID, DON_THREAD_ID)
      return {
        thread: thread ?? existing,
        assistantCreated,
        threadCreated: false,
        threadSettingsRepaired
      }
    }

    await threadManager.createThread({
      id: DON_THREAD_ID,
      projectId: ASSISTANT_SPACE_ID,
      providerId: settings?.providerId ?? '',
      title: DON_THREAD_TITLE,
      // Named by the app, never by a prompt: the orchestrator's conversation is
      // one fixed place, so a turn must not rename it.
      titleSource: 'manual',
      workingDirectory: '',
      assistantId: DON_ASSISTANT_ID,
      groupParticipants: [DON_ASSISTANT_ID],
      groupTitle: DON_THREAD_TITLE,
      ...(settings ? { settings: settingsFor(settings) } : {})
    })
    // Pinning is a user action everywhere else, so it is an explicit write here
    // rather than a creation flag: the one thread the front door lives on has to
    // survive every eviction pass.
    await threadManager.setPinned(ASSISTANT_SPACE_ID, DON_THREAD_ID, true)
    const thread = await threadManager.getThread(ASSISTANT_SPACE_ID, DON_THREAD_ID)
    return { thread, assistantCreated, threadCreated: true, threadSettingsRepaired: false }
  } catch (error) {
    Logger.error('Don bootstrap failed', {
      error: error instanceof Error ? error.message : String(error)
    })
    return {
      thread: null,
      assistantCreated: false,
      threadCreated: false,
      threadSettingsRepaired: false
    }
  }
}

/** A copy, so a caller can never mutate the settings a caller handed over. */
function settingsFor(settings: ThreadSettings): ThreadSettings {
  return { ...settings }
}

/**
 * The model of the conversation the user last worked in.
 *
 * Don has no model of his own until something assigns one, and on a fresh install
 * that would leave his first question unaskable. The most recently active thread
 * that has run settings is the same mind the user is already talking to, so it is
 * the honest answer; an install with no threads at all keeps the assistant's own
 * built-in default.
 */
async function mostRecentThreadModel(
  threadManager: ThreadManager
): Promise<AgentModelSelection | undefined> {
  try {
    const threads = await threadManager.listAllThreads({ limit: 20, order: 'activity' })
    const settings = threads.find((thread) => thread.settings?.harnessId)?.settings
    if (!settings) return undefined
    return {
      harnessId: settings.harnessId,
      providerId: settings.providerId,
      modelId: settings.modelId,
      ...(settings.accountId ? { accountId: settings.accountId } : {}),
      ...(settings.thinkingLevel ? { thinkingLevel: settings.thinkingLevel } : {})
    }
  } catch (error) {
    Logger.dev('Don could not inherit a model from recent threads:', error)
    return undefined
  }
}
