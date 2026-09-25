import { ASSISTANT_SPACE_ID } from '../types'

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

/** Which bundled alert a notification maps to. */
export type NotificationSoundKind = 'default' | 'attention' | 'assistant'

/**
 * How long the app stays quiet after it played an alert. Only the first
 * notification of a burst is announced; the rest still show their card and
 * toast but stay silent, so a burst never machine-guns beeps.
 *
 * Both alert surfaces share this window: the main process gates the off-app
 * alert it dispatches, and the renderer sound module gates the in-app alert it
 * plays alongside the toast.
 */
export const NOTIFICATION_SOUND_DEDUP_MS = 2_500

/**
 * Which alert an event maps to. An attention request and a failure both mean
 * the user has to act, so they share the attention alert; a successful
 * assistant run (a thread in the assistant space that reached `completed`) has
 * its own alert; everything else is the default alert. The off-app card and the
 * in-app toast derive their alert from this one rule, so the same event never
 * sounds different per surface.
 */
export function notificationSoundKind(
  kind: AgentNotificationKind,
  projectId?: string
): NotificationSoundKind {
  if (kind === 'attention' || kind === 'error') return 'attention'
  if (kind === 'completed' && projectId === ASSISTANT_SPACE_ID) return 'assistant'
  return 'default'
}

/**
 * Which in-app alert group a sound kind belongs to. Success covers everything
 * that finished or is ready to review, including a successful assistant run;
 * an attention alert and a failure both mean the user has to act, so they share
 * the issue alert.
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
