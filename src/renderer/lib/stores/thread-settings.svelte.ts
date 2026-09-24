import { sanitizeThreadSettings, type Thread, type ThreadSettings } from '$shared/types'
import { APP_SLUG } from '$shared/brand'
import { DEFAULT_HARNESS } from '$shared/harness-default'

const THREAD_SETTINGS_KEY = `${APP_SLUG}.threadSettings.lastUsed`
const CHAT_SETTINGS_KEY = `${APP_SLUG}.chatSettings.lastUsed`
const ASSISTANT_SETTINGS_KEY = `${APP_SLUG}.assistantSettings.lastUsed`

/** Fallback settings used before anything has been persisted. */
export const DEFAULT_SETTINGS: ThreadSettings = {
  harnessId: DEFAULT_HARNESS,
  accountId: `${DEFAULT_HARNESS}.default`,
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

/**
 * Fallback settings for assistant tasks. A task is a chat-shaped conversation
 * ("run this for me on this computer"), so it starts on the same auto review
 * level as a chat and keeps its own model memory.
 */
export const ASSISTANT_DEFAULT_SETTINGS: ThreadSettings = {
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
 * Every conversation family owns one instance, so the model picked for one kind
 * of work never changes what another kind starts on:
 * `threadSettings` for project threads, `chatSettings` for the Chats tab, and
 * `assistantSettings` for assistant tasks.
 */
export class ThreadSettingsStore {
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

export const assistantSettings = new ThreadSettingsStore(
  ASSISTANT_SETTINGS_KEY,
  ASSISTANT_DEFAULT_SETTINGS
)

/**
 * The effective settings for a chat: the chat's own last-used settings once a
 * chat has picked a model, else the model the project work last ran on, so a
 * fresh chat starts on the model already in use.
 *
 * Chats keep their own storage (model, thinking level, File System, permissions),
 * so a new chat inherits the previous chat's configuration rather than the
 * project view's, and only the model identity is borrowed from the project
 * (harness, account, provider, model). A chat never inherits the project's File
 * System mode or permission level, because that would unlock access nobody
 * granted a chat.
 *
 * Web-only chats stay pinned to auto review. Once the user turns on File
 * System, the permission picker unlocks up to Full Access, so that level is
 * carried through here instead of being clobbered back to auto review.
 */
export function chatEffectiveSettings(projectFallback: ThreadSettings): ThreadSettings {
  return effectiveSettings(chatSettings.lastUsed, CHAT_DEFAULT_SETTINGS, projectFallback)
}

/**
 * The effective settings for an assistant task when no task is in focus: the
 * assistant's own last-used settings once it has run on a model, else the model
 * the project work last ran on.
 *
 * The same borrowing rule as a chat applies: only the model identity comes from
 * the project (harness, account, provider, model), never its File System mode or
 * permission level, since that would hand a routine's task access nobody granted
 * it. A task stays pinned to auto review until File System is turned on for the
 * assistant itself.
 */
export function assistantEffectiveSettings(projectFallback: ThreadSettings): ThreadSettings {
  return effectiveSettings(assistantSettings.lastUsed, ASSISTANT_DEFAULT_SETTINGS, projectFallback)
}

/**
 * The settings a conversation family starts on when it has not picked a model
 * yet: its own last-used settings once it has one, else the model the project
 * work last ran on.
 */
function effectiveSettings(
  own: ThreadSettings,
  defaults: ThreadSettings,
  projectFallback: ThreadSettings
): ThreadSettings {
  const seed = own.modelId ? own : withModelFrom(defaults, projectFallback)
  return {
    ...seed,
    permissionLevel: seed.fileSystemMode ? seed.permissionLevel : ('auto_review' as const)
  }
}

/** The same settings, running on the model another settings object carries. */
function withModelFrom(base: ThreadSettings, source: ThreadSettings): ThreadSettings {
  if (!source.modelId) return base
  return {
    ...base,
    harnessId: source.harnessId,
    ...(source.accountId ? { accountId: source.accountId } : {}),
    providerId: source.providerId,
    modelId: source.modelId
  }
}

/** Which conversation family owns a model memory. */
export type ModelScope = 'project' | 'chat' | 'assistant'

/** The last-used settings store of a conversation family. */
export function settingsStoreFor(scope: ModelScope): ThreadSettingsStore {
  if (scope === 'assistant') return assistantSettings
  if (scope === 'chat') return chatSettings
  return threadSettings
}

/**
 * The settings a conversation of this family starts on when it has none of its
 * own. Projects seed from the last project thread; chats from the last chat, else
 * from the model the project work last ran on; assistant tasks from the
 * assistant's own memory, else from that same project model.
 */
export function defaultSettingsFor(scope: ModelScope): ThreadSettings {
  if (scope === 'assistant') return assistantEffectiveSettings(threadSettings.lastUsed)
  if (scope === 'chat') return chatEffectiveSettings(threadSettings.lastUsed)
  return threadSettings.lastUsed
}

/** Initial settings for a thread of this family: its own, else the family default. */
export function initialSettingsFor(scope: ModelScope, thread: Thread): ThreadSettings {
  return settingsStoreFor(scope).initialFor(thread, defaultSettingsFor(scope))
}
