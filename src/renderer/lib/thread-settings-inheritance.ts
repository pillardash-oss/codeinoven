import type { Thread, ThreadSettings } from '$shared/types'
import { invoke } from '$lib/ipc.svelte'

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
  return cloneSettings(settings)
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
