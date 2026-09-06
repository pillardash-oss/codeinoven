import { sanitizeThreadSettings, type Thread, type ThreadSettings } from '$shared/types'
import { APP_SLUG } from '$shared/brand'
import { DEFAULT_HARNESS } from '$shared/harness-default'

const THREAD_SETTINGS_KEY = `${APP_SLUG}.threadSettings.lastUsed`
const CHAT_SETTINGS_KEY = `${APP_SLUG}.chatSettings.lastUsed`

/** Fallback settings used before anything has been persisted. */
export const DEFAULT_SETTINGS: ThreadSettings = {
  harnessId: DEFAULT_HARNESS,
  providerId: '',
  modelId: '',
  thinkingLevel: 'medium',
  inferenceMode: 'normal',
  permissionLevel: 'auto_review',
  loopMode: false,
  fileSystemMode: false
}

/**
 * Fallback settings for the Chats tab. Chats are for questions and research:
 * they always run with auto permission review and never inject the Engineering
 * workflow, and they keep their own last-used model so chatting with a cheap
 * model never changes the model used for project work.
 */
export const CHAT_DEFAULT_SETTINGS: ThreadSettings = {
  ...DEFAULT_SETTINGS,
  permissionLevel: 'auto_review'
}

function load(storageKey: string, defaults: ThreadSettings): ThreadSettings {
  if (typeof window === 'undefined') return { ...defaults }
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return { ...defaults }
    const parsed = sanitizeThreadSettings(JSON.parse(raw))
    return { ...defaults, ...parsed }
  } catch {
    return { ...defaults }
  }
}

function persist(storageKey: string, settings: ThreadSettings): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(settings))
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
 *
 * The Chats tab gets its own instance (`chatSettings`) so switching a model
 * there never affects the model used for project threads.
 */
class ThreadSettingsStore {
  /** Settings from the most recent send — seeds new threads. Replaced by the
   *  persisted value in the constructor, before any reactive reader can run. */
  lastUsed = $state<ThreadSettings>({ ...DEFAULT_SETTINGS })

  constructor(
    private readonly storageKey: string,
    private readonly defaults: ThreadSettings
  ) {
    this.lastUsed = load(storageKey, defaults)
  }

  /** Initial settings for a thread: its own persisted values, else the last-used ones. */
  initialFor(thread: Thread, fallback?: ThreadSettings): ThreadSettings {
    return thread.settings
      ? { ...this.defaults, ...thread.settings }
      : { ...(fallback ?? this.lastUsed) }
  }

  /** Remember these settings as the default for future threads. */
  commit(settings: ThreadSettings): void {
    this.lastUsed = { ...settings }
    persist(this.storageKey, this.lastUsed)
  }
}

export const threadSettings = new ThreadSettingsStore(THREAD_SETTINGS_KEY, DEFAULT_SETTINGS)

export const chatSettings = new ThreadSettingsStore(CHAT_SETTINGS_KEY, CHAT_DEFAULT_SETTINGS)

/**
 * The effective settings for a chat: the chat's own last-used settings.
 * Chats keep their own storage (model, thinking level, File System, permiss-
 * ions), so a new chat always inherits the previous chat's configuration —
 * never the project view's model or thinking level.
 *
 * Web-only chats stay pinned to auto review. Once the user turns on File
 * System, the permission picker unlocks up to Full Access, so that level is
 * carried through here instead of being clobbered back to auto review.
 */
export function chatEffectiveSettings(): ThreadSettings {
  const chat = chatSettings.lastUsed
  return {
    ...chat,
    permissionLevel: chat.fileSystemMode ? chat.permissionLevel : ('auto_review' as const)
  }
}
