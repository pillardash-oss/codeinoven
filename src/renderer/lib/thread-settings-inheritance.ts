import type { AssistantExecution, Project, Thread, ThreadSettings } from '$shared/types'
import { settingsWithAssistantTarget } from '$shared/assistant-execution'
import { LOCAL_OVEN_ID } from '$shared/ovens'
import { invoke } from '$lib/ipc.svelte'
import { loadLifecycleIntent } from '$lib/stores/lifecycle-intent'
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
  const cloned = cloneSettings(settings)
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

/**
 * Carry the source thread's Engineering identity into a sibling thread: mark it
 * as an Engineering thread and copy the switches the user actually sees.
 *
 * An Engineering thread stays one for its lifetime, even with every switch off
 * (a parked, completed or cancelled run): its Toolbox is still filled, so a
 * sibling must inherit that highlight instead of arriving neutral. The switch
 * set the user sees wins over the persisted row   a staged (not-yet-sent)
 * Toolbox selection must travel too.
 *
 * Best-effort and non-fatal: a source that is not an Engineering thread, or an
 * independent-audit/orchestration-child source, leaves the destination neutral
 * and returns `null`.
 *
 * Returns the destination as persisted once inheritance lands, so a caller that
 * opens the thread afterwards can adopt the row that carries the marker and the
 * attached defaults instead of a stale pre-inheritance snapshot.
 */
export async function inheritEngineeringLifecycle(
  projectId: string,
  sourceThreadId: string,
  destinationThreadId: string
): Promise<Thread | null> {
  try {
    const [sourceThread, sourceLifecycle] = await Promise.all([
      invoke('thread:get', projectId, sourceThreadId),
      invoke('engineeringLifecycle:get', projectId, sourceThreadId)
    ])
    if (!sourceThread) return null
    // The staged (not-yet-sent) Toolbox selection is what the source view is
    // currently showing as on; it is intent the user expects to travel even
    // though it was never committed to the lifecycle row.
    const staged = loadLifecycleIntent(projectId, sourceThreadId)
    const stagedActive = staged !== null && (staged.autopilot === true || staged.stages.length > 0)
    const sourceIsEngineering =
      sourceThread.engineering === true ||
      sourceLifecycle?.startedAt !== undefined ||
      (sourceLifecycle?.selection ?? 'none') !== 'none' ||
      stagedActive
    if (!sourceIsEngineering) return null
    // The destination is created optimistically; make sure its row is durable
    // before writing onto it (the handler also waits, but an early failure here
    // keeps the attempt off the wire entirely).
    await invoke('thread:get', projectId, destinationThreadId)
    const inherited = await invoke(
      'engineeringLifecycle:inherit',
      projectId,
      sourceThreadId,
      destinationThreadId,
      staged ?? undefined
    )
    // The destination view may already be mounted and have hydrated its
    // lifecycle state before the copy landed   signal it to re-read so the
    // inherited switches show as on instead of staying neutral.
    notifyEngineeringLifecycleInherited(destinationThreadId)
    return inherited
  } catch {
    // Lifecycle inheritance is cosmetic   never block thread creation on it.
    return null
  }
}

/**
 * Reactive signal raised after an Engineering lifecycle selection is copied
 * into a destination thread. Thread views subscribe so a lifecycle that was
 * inherited after their initial hydration still lights the inherited switches.
 */
type EngineeringLifecycleInheritanceListener = (threadId: string) => void
const lifecycleInheritanceListeners = new Set<EngineeringLifecycleInheritanceListener>()

/** Subscribe to lifecycle-inheritance notifications; returns an unsubscribe fn. */
export function onEngineeringLifecycleInherited(
  listener: EngineeringLifecycleInheritanceListener
): () => void {
  lifecycleInheritanceListeners.add(listener)
  return () => lifecycleInheritanceListeners.delete(listener)
}

function notifyEngineeringLifecycleInherited(threadId: string): void {
  for (const listener of lifecycleInheritanceListeners) listener(threadId)
}
