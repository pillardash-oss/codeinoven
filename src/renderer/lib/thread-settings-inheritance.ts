import type { AssistantExecution, Project, Thread, ThreadSettings } from '$shared/types'
import { settingsWithAssistantTarget } from '$shared/assistant-execution'
import { LOCAL_OVEN_ID } from '$shared/ovens'
import { invoke } from '$lib/ipc.svelte'
import { neutralEngineeringThreadSettings } from '$shared/thread-engineering-neutral'
import {
  assistantEffectiveSettings,
  assistantSettings,
  chatEffectiveSettings,
  chatSettings,
  normalizeChatSettings,
  threadSettings
} from '$lib/stores/thread-settings.svelte'

function cloneSettings(settings: ThreadSettings): ThreadSettings {
  return {
    ...settings,
    ...(settings.loopAuditor ? { loopAuditor: { ...settings.loopAuditor } } : {}),
    ...(settings.imageDescriptor ? { imageDescriptor: { ...settings.imageDescriptor } } : {}),
    ...(settings.imageDescriptorFallback
      ? { imageDescriptorFallback: { ...settings.imageDescriptorFallback } }
      : {})
  }
}

/** Clone the active thread's complete configuration when starting a sibling thread. */
export function settingsForNewThread(
  activeThread: Thread | null,
  fallback: ThreadSettings
): ThreadSettings {
  const settings = activeThread?.settings ?? fallback
  // A new thread starts neutral: Engineering is a set of stages the agent turns
  // on from the request, so a sibling created beside an Engineering thread must
  // never arrive already in Assignment or Achievement loop mode.
  const cloned = neutralEngineeringThreadSettings(cloneSettings(settings))
  // Persist this as the last-used default so a thread created later in another
  // project (where there is no active thread to inherit from) seeds from the
  // configuration the most recent thread was set up with, not the stale global
  // default. Idempotent when the fallback is already the saved value.
  threadSettings.commit(cloned)
  return cloned
}

/**
 * Where a minted thread runs.
 *
 * A thread is minted from another thread, and where that thread ran is part of
 * what the user configured: a sibling in this project hands its Oven and its
 * workspace over, so "New thread" keeps the machine the conversation was on.
 *
 * The destination project decides in every other case. A project created from
 * the Add Project flow records the Oven and workspace it runs in, so a chat
 * started in it runs where the user pointed the project; a local project runs
 * here. That else-branch is what keeps a remembered or foreign Oven from
 * following a thread into the wrong machine.
 */
export function withProjectOven(
  settings: ThreadSettings,
  project: Project,
  inheritedFromSameProject: boolean
): ThreadSettings {
  if (inheritedFromSameProject) return settings
  const ovenId = project.ovenId
  if (ovenId && ovenId !== LOCAL_OVEN_ID) {
    return {
      ...settings,
      ovenId,
      ...(project.path ? { ovenPath: project.path } : { ovenPath: undefined })
    }
  }
  return { ...settings, ovenId: LOCAL_OVEN_ID, ovenPath: undefined }
}

/**
 * Settings for a new chat: the chat in focus, else the chat family's memory.
 *
 * A chat is a project-less thread, so it has no project Oven to answer "which
 * machine?" from. The chat it was minted from is the authority, and failing one
 * the last chat is, so a new chat keeps running where the conversation it came
 * out of ran instead of silently dropping back to this computer.
 */
export function settingsForNewChat(
  focusedChat: Thread | null,
  projectFallback: ThreadSettings
): ThreadSettings {
  const source = focusedChat?.settings
  const settings = normalizeChatSettings(
    source ? cloneSettings(source) : chatEffectiveSettings(projectFallback)
  )
  chatSettings.commit(settings)
  return settings
}

/**
 * Settings for a new assistant task: the assistant task in focus, else the
 * assistant's own last-used settings, else the model the project work last ran
 * on (see `assistantEffectiveSettings`).
 *
 * Only a focused assistant task is ever inherited from. A thread selected in
 * another view is not a source here, and the borrowed project model is never
 * written back as the assistant's memory, so an assistant that never picked a
 * model keeps following what project work uses instead of freezing a copy of it.
 *
 * The assistant's own execution target is applied last because it is what every
 * dispatched run actually uses (`settingsWithAssistantTarget` in the main
 * process): a task starts showing the machine its run will happen on instead of
 * this computer while the work runs elsewhere.
 */
export function settingsForNewAssistantTask(
  focusedTask: Thread | null,
  projectFallback: ThreadSettings,
  execution?: AssistantExecution
): ThreadSettings {
  const focused = focusedTask?.settings
  const settings = settingsWithAssistantTarget(
    focused ? cloneSettings(focused) : assistantEffectiveSettings(projectFallback),
    execution
  )
  assistantSettings.commit(settings)
  return settings
}

/** Apply inherited settings immediately while their durable write finishes off the UI path. */
export function threadWithInheritedSettings(thread: Thread, settings: ThreadSettings): Thread {
  return { ...thread, settings: cloneSettings(settings) }
}

/**
 * Persist inherited settings through only long-established IPC channels. The
 * retry keeps this compatible with a pre-fix main process whose optimistic
 * thread creation may not have reached SQLite before the first update call.
 */
export async function persistInheritedThreadSettings(
  thread: Thread,
  settings: ThreadSettings
): Promise<Thread> {
  try {
    return await invoke('thread:updateSettings', thread.projectId, thread.id, settings)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('Thread not found')) throw error
    await invoke('thread:get', thread.projectId, thread.id)
    return invoke('thread:updateSettings', thread.projectId, thread.id, settings)
  }
}
