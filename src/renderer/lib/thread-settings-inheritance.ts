import type { Project, Thread, ThreadSettings } from '$shared/types'
import { LOCAL_OVEN_ID } from '$shared/ovens'
import { invoke } from '$lib/ipc.svelte'
import { loadLifecycleIntent } from '$lib/stores/lifecycle-intent'
import {
  assistantEffectiveSettings,
  assistantSettings,
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
 * Seed a new thread's Oven binding from its project's remote location.
 *
 * A project created from the Add Project flow records the Oven and workspace it
 * runs in, so a chat started in it runs where the user pointed the project.
 * When the new chat inherits its settings from a sibling thread in the same
 * project, that sibling's own Oven choice is deliberate and kept; otherwise the
 * project's Oven applies, so a stale last-used Oven from another project can
 * never drag a chat into the wrong machine.
 */
export function withProjectOven(
  settings: ThreadSettings,
  project: Project,
  inheritedFromSameProject: boolean
): ThreadSettings {
  const ovenId = project.ovenId
  if (!ovenId || ovenId === LOCAL_OVEN_ID) return settings
  if (inheritedFromSameProject) return settings
  return {
    ...settings,
    ovenId,
    ...(project.path ? { ovenPath: project.path } : {})
  }
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
 */
export function settingsForNewAssistantTask(
  focusedTask: Thread | null,
  projectFallback: ThreadSettings
): ThreadSettings {
  const focused = focusedTask?.settings
  if (!focused) return assistantEffectiveSettings(projectFallback)
  const settings = cloneSettings(focused)
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
