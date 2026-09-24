export interface ThreadClickedPayload {
  projectId: string
  threadId: string
  /** Present when the click came from a temporary (side) chat notification, so
   *  the renderer can focus the side-chat panel after opening the parent
   *  thread. Omitted for regular thread notifications. */
  temporaryChatId?: string
}

/** One thread still being worked on, blocking the close. */
export interface CloseConfirmationThread {
  threadId: string
  title: string
  status: 'planning' | 'executing'
}

/** A project with at least one thread still being worked on. */
export interface CloseConfirmationProject {
  projectId: string
  projectName: string
  threadCount: number
  /** The exact threads blocking the close, most active first. */
  threads: CloseConfirmationThread[]
}

/** An open file with unsaved edits, blocking the close. */
export interface CloseConfirmationFile {
  projectId: string
  path: string
}

/** Sent when the user tries to close the app while threads are still working
 *  or files have unsaved edits. `files` is populated by the renderer, which
 *  owns the unsaved-editor state. */
export interface CloseConfirmationPayload {
  projects: CloseConfirmationProject[]
  files: CloseConfirmationFile[]
}

export type AgentNotificationKind = 'completed' | 'chat-completed' | 'attention' | 'spec' | 'error'

/** Which bundled alert the renderer should play for a notification. */
export type NotificationSoundKind = 'default' | 'attention'

/**
 * Which surface raised an audible alert:
 *
 * - `system`   the app is in the background, so the OS card carries the
 *   notification and the full-volume alert announces it.
 * - `in-app`   the app is focused, so the user only sees the sonner toast and
 *   the quieter in-app alert announces the exact same event.
 *
 * The two are mutually exclusive per notification, so a single burst can never
 * play both.
 */
export type NotificationSoundSurface = 'system' | 'in-app'

/**
 * One audible alert request. The main process is the single producer (it owns
 * the burst dedup window and the focus decision) and emits at most one per
 * notification burst.
 */
export interface NotificationSoundRequest {
  kind: NotificationSoundKind
  surface: NotificationSoundSurface
}

/**
 * Which in-app alert group a sound kind belongs to. Success covers everything
 * that finished or is ready to review; an attention alert and a failure both
 * mean the user has to act, so they share the issue alert.
 */
export function inAppSoundGroup(kind: NotificationSoundKind): 'success' | 'issue' {
  return kind === 'attention' ? 'issue' : 'success'
}

/** Where a notification originated: a project thread, the global chat (inbox)
 *  or a temporary (side) chat piped through a parent thread. */
export type NotificationSource = 'project' | 'chat' | 'temporary-chat'

export interface AgentNotificationPayload extends ThreadClickedPayload {
  id: string
  kind: AgentNotificationKind
  title: string
  body: string
  /** Origin of the notification, used by the panel to tag its source. */
  source: NotificationSource
  /** Name of the owning project (or the inbox "Chats" project for chats). */
  projectName: string
  /** Accent colour of the owning project, when known. */
  projectColor?: string
  /** Full diagnostic text of the failure (message plus raw detail/stack) for
   *  `error` notifications, so the panel can show what actually went wrong and
   *  offer a faithful copy action. Absent for non-error notifications and when
   *  the engine had no readable error. */
  errorDetail?: string
}

export type SystemNotificationTestResult =
  | { status: 'shown'; message: string }
  | { status: 'unsupported'; message: string }
  | { status: 'failed'; message: string }

/**
 * macOS notification authorization, queried on demand. On non-macOS platforms the
 * permission concept does not apply, so `platform` is `'other'`.
 */
export type SystemNotificationPermissionStatus =
  { platform: 'darwin'; status: 'granted' | 'denied' | 'prompt' } | { platform: 'other' }
