import type { Thread, ThreadSettings } from '$shared/types'
import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.threadSettings.lastUsed`

/** Fallback settings used before anything has been persisted. */
export const DEFAULT_SETTINGS: ThreadSettings = {
  harnessId: 'opencode',
  providerId: '',
  modelId: '',
  thinkingLevel: 'medium',
  inferenceMode: 'normal',
  permissionLevel: 'auto_review',
  engineeringMode: true,
  loopMode: false,
  fileSystemMode: false
}

function load(): ThreadSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<ThreadSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function persist(settings: ThreadSettings): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Storage unavailable (private mode, quota) — non-fatal.
  }
}

/**
 * Per-thread agent settings with a "last-used wins" default.
 *
 * Each thread persists its own settings (see `Thread.settings`); the settings
 * used most recently become the seed for newly created threads, matching the
 * product rule that the last thread's configuration overrides the global
 * default while existing threads keep their own.
 */
class ThreadSettingsStore {
  /** Settings from the most recent send — seeds new threads. */
  lastUsed = $state<ThreadSettings>(load())

  /** Initial settings for a thread: its own persisted values, else the last-used ones. */
  initialFor(thread: Thread): ThreadSettings {
    return thread.settings ? { ...DEFAULT_SETTINGS, ...thread.settings } : { ...this.lastUsed }
  }

  /** Remember these settings as the default for future threads. */
  commit(settings: ThreadSettings): void {
    this.lastUsed = { ...settings }
    persist(this.lastUsed)
  }
}

export const threadSettings = new ThreadSettingsStore()
