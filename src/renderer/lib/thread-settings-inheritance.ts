import type { Thread, ThreadSettings } from '$shared/types'
import { invoke } from '$lib/ipc.svelte'
import { threadSettings } from '$lib/stores/thread-settings.svelte'

function cloneSettings(settings: ThreadSettings): ThreadSettings {
  return {
    ...settings,
    ...(settings.loopAuditor ? { loopAuditor: { ...settings.loopAuditor } } : {}),
    ...(settings.imageDescriptor ? { imageDescriptor: { ...settings.imageDescriptor } } : {})
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
 * Carry the source thread's Engineering stage selection into a sibling thread
 * so the switch that was turned on stays on. Best-effort and non-fatal: when
 * the source has no lifecycle selection (or is not in engineering mode) the
 * destination keeps its default untouched state.
 */
export async function inheritEngineeringLifecycle(
  projectId: string,
  sourceThreadId: string,
  destinationThreadId: string
): Promise<void> {
  try {
    const source = await invoke('engineeringLifecycle:get', projectId, sourceThreadId)
    if (!source?.selection || source.selection === 'none') return
    // The destination is created optimistically; make sure its row is durable
    // before writing lifecycle state onto it.
    await invoke('thread:get', projectId, destinationThreadId)
    await invoke('engineeringLifecycle:select', projectId, destinationThreadId, {
      stages: source.selectedStages ?? [],
      autopilot: source.autopilot
    })
    // The destination view may already be mounted and have hydrated its
    // lifecycle state before this copy landed — signal it to re-read so the
    // inherited switches show as on instead of staying neutral.
    notifyEngineeringLifecycleInherited(destinationThreadId)
  } catch {
    // Lifecycle inheritance is cosmetic — never block thread creation on it.
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
