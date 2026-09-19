import type { AgentSubagentActivity, ThreadSettings } from '$shared/types'

export type TerminalPlacement = 'right' | 'bottom'

export interface TerminalContextTab {
  id: string
  kind: 'terminal'
  title: string
  terminalId: string
  projectId: string
  threadId: string
}

export interface FilesContextTab {
  id: string
  kind: 'files'
  title: string
  projectId: string
  threadId: string
  fileTabId: string | null
  path: string | null
  preview: boolean
}

export interface DiffContextTab {
  id: string
  kind: 'diff'
  title: string
  projectId: string
  threadId: string
  checkpointId: string | null
  /** When set, the Changes panel scrolls to this file's diff. */
  revealPath: string | null
  /** Bumped on every reveal request so re-clicking the same file re-triggers. */
  revealNonce: number
}

export interface SubagentContextTab {
  id: string
  kind: 'subagent'
  title: string
  projectId: string
  threadId: string
  sourcePartId: string
  activity: AgentSubagentActivity
}

export interface DebuggerContextTab {
  id: string
  kind: 'debugger'
  title: string
  projectId: string
  threadId: string
}

export interface SourcesContextTab {
  id: string
  kind: 'sources'
  title: string
  projectId: string
  threadId: string
}

export interface GitContextTab {
  id: string
  kind: 'git'
  title: string
  projectId: string
  threadId: string
}

export interface ActionsContextTab {
  id: string
  kind: 'actions'
  title: string
  projectId: string
  threadId: string
}

export interface BrowserContextTab {
  id: string
  kind: 'browser'
  title: string
  projectId: string
  threadId: string
  url: string
  /** Live page favicon (data URL) from the browser panel, if reported. */
  favicon?: string
}

export interface ThreadNoteContextTab {
  id: string
  kind: 'thread-note'
  title: string
  projectId: string
  threadId: string
  /** Display name of the owning thread, used in the delete confirmation. */
  threadTitle: string
  /** The last-saved body, or null before the first save. Diffing against
   *  this (rather than a separate `dirty` flag) is what lets the panel
   *  survive a hide/show without losing an unsaved draft, both fields
   *  live on the tab itself, not in the component that gets unmounted. */
  savedBody: string | null
  draftBody: string
  mode: 'edit' | 'read'
  /** Monotonic request used to return keyboard focus to the editor when an
   *  already-open note is explicitly opened for writing. */
  focusRequest: number
  loading: boolean
  saving: boolean
  error: string | null
}

export interface CloudDeploymentContextTab {
  id: string
  kind: 'cloud-deployment'
  title: string
  projectId: string
  threadId: string
}

export interface NotificationContextTab {
  id: string
  kind: 'notifications'
  title: string
}

export type MemorySection = 'active' | 'proposed'

export interface MemoryContextTab {
  id: string
  kind: 'memory'
  title: string
  projectId: string
  threadId: string
  memorySection: MemorySection
}

/**
 * The Assignment / Achievement / Audit coordinator, docked into the sidebar. The tab
 * carries no data of its own: the panel is a snippet published by the thread
 * that owns the coordination, registered on `coordinatorDockState`.
 */
export interface CoordinatorContextTab {
  id: string
  kind: 'coordinator'
  title: string
  projectId: string
  threadId: string
}

export type TemporaryChatMode = 'elaborate' | 'quick'

/** Shared instruction sent to the harness when the user asks a side chat to
 *  explain a selection. Displayed in the conversation as the short action
 *  label ("Explain") while the full instruction travels as the transport text. */
export const EXPLAIN_SELECTION_PROMPT =
  'Explain the selected content clearly, based on the surrounding context. Use simple, everyday language and avoid unnecessary technical jargon unless it is truly needed. Be read-only \u2014 do not make changes or run commands.'

export interface TemporaryChatContextTab {
  id: string
  kind: 'temporary-chat'
  title: string
  projectId: string
  threadId: string
  temporaryChatId: string
  /** Isolated harness session for the side chat, once the first turn starts. */
  sessionId: string | null
  mode: TemporaryChatMode
  selections: string[]
  initialContext: string
  settings: ThreadSettings
  selectionAttached: boolean
  autoPromptSent: boolean
  /** Id of the user message seeded at open time for the auto-sent explain
   *  prompt, so the prompt shows as a sent message the instant the tab opens
   *  (the send reuses it instead of appending a duplicate). */
  autoPromptMessageId: string | null
  /** Override for the auto-sent explain prompt, when the tab was opened to
   *  explain a specific selection (e.g. an agent question) rather than the
   *  generic "explain this selection" elaboration. */
  autoPrompt?: string
  sessionStarted: boolean
  expired: boolean
  expiresAt: number
}

export type ContextSidebarTab =
  | FilesContextTab
  | DiffContextTab
  | TerminalContextTab
  | SubagentContextTab
  | DebuggerContextTab
  | SourcesContextTab
  | GitContextTab
  | ActionsContextTab
  | ThreadNoteContextTab
  | CloudDeploymentContextTab
  | TemporaryChatContextTab
  | NotificationContextTab
  | MemoryContextTab
  | CoordinatorContextTab
  | BrowserContextTab

export interface ThreadSidebarContext {
  projectId: string
  threadId: string
  tabs: ContextSidebarTab[]
  activeTabIds: Partial<Record<ContextSidebarTab['kind'], string>>
}

export interface ProjectSidebarContext {
  projectId: string
  tabs: ContextSidebarTab[]
  activeKind: ContextSidebarTab['kind'] | null
  activeTabIds: Partial<Record<ContextSidebarTab['kind'], string>>
  terminalActiveTabId: string | null
  visible: boolean
  /** Whether the bottom terminal dock is open. Only meaningful while
   * `terminalPlacement === 'bottom'`; lets the dock hide independently of the
   * sidebar (e.g. from the header terminal toggle). */
  terminalDockOpen: boolean
  terminalSequence: number
}

export const EMPTY_TABS: ContextSidebarTab[] = []
export const NOTIFICATIONS_TAB: NotificationContextTab = {
  id: 'notifications',
  kind: 'notifications',
  title: 'Notifications'
}

/** Tabs whose component/session state belongs to a project. Every other tab
 * remains in its owning thread context and is swapped when the thread changes. */
export const PROJECT_TAB_KINDS = new Set<ContextSidebarTab['kind']>([
  'files',
  'terminal',
  'actions',
  'git',
  'cloud-deployment',
  'memory'
])

export function isProjectTab(tab: ContextSidebarTab): boolean {
  return PROJECT_TAB_KINDS.has(tab.kind)
}

export function contextKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

export function sameSubagentActivity(
  current: AgentSubagentActivity,
  next: AgentSubagentActivity
): boolean {
  return (
    current.status === next.status &&
    current.agent === next.agent &&
    current.description === next.description &&
    current.prompt === next.prompt &&
    current.childSessionId === next.childSessionId &&
    current.providerTaskId === next.providerTaskId &&
    current.providerId === next.providerId &&
    current.modelId === next.modelId &&
    current.background === next.background &&
    current.output === next.output &&
    current.error === next.error &&
    current.time?.start === next.time?.start &&
    current.time?.end === next.time?.end
  )
}

/** Idle window after which a temporary side chat expires. */
export const TEMPORARY_CHAT_INACTIVITY_MS = 3 * 60 * 60 * 1000
