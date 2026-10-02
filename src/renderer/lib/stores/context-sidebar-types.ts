import type { AgentSubagentActivity, ThreadSettings } from '$shared/types'

export type TerminalPlacement = 'right' | 'bottom'

export interface TerminalContextTab {
  id: string
  kind: 'terminal'
  title: string
  terminalId: string
  projectId: string
  threadId: string
  /** Project-relative folder the shell starts in, set when the tab was opened
   *  at a path from the file tree. Undefined starts at the scope root. */
  startingDirectory?: string
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
  /**
   * The page's own icon as a data URL, as the app last had it, or null while the
   * tab has none.
   *
   * The icon belongs to the address rather than to the running page, so it is
   * written down with the tab list: a strip restored by a restart wears the marks
   * it wore when the tabs were last open, and a saved page copies the icon of the
   * tab it was saved from.
   */
  favicon: string | null
  /**
   * The box this thread-browser tab runs against, or null for the scope's own
   * jar.
   *
   * The scope's own jar is the default every conversation starts from: a
   * project's threads share the project's jar, and an assistant routine or a
   * chat browses its own. A named box is the profile's one jar for that box, not
   * the scope's own, so a tab in it shares its cookies and logins with every other
   * context that picks the box. That includes the profile's own box, which names
   * itself here like any other box: a conversation that picks it is browsing the
   * jar the global browser's everyday pages live in, signed in as the person, so
   * the id and null are two different jars rather than two spellings of one. A tab
   * keeps the box it was created in for its whole life, because cookies cannot
   * migrate between jars, so picking another box reopens the tab in it rather than
   * moving it.
   */
  boxId: string | null
}

/**
 * A browser tab's agent conversation, on the browser's right rail.
 *
 * The conversation is a real chat thread of the reserved hidden browser project,
 * so the tab is a view of that thread rather than a conversation of its own: the
 * title is the thread's title, the panel renders the thread's own transcript and
 * settings, and closing the tab deletes the thread. The browser tab it answers
 * about is carried here because the rail only ever shows the conversation of the
 * tab on screen.
 */
export interface BrowserAgentContextTab {
  id: string
  kind: 'browser-agent'
  title: string
  /** The reserved browser project the conversation's thread lives in. */
  projectId: string
  /** The conversation thread itself. */
  threadId: string
  /** The browser tab whose page the conversation answers about. */
  browserTabId: string
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

/**
 * The rail panel that lists the gates the app resolved without the user.
/**
 * The auto-resolved decision panel, keyed to the conversation it belongs to.
 *
 * A decision concerns the thread it settled on, and through it the assistant
 * task it ran for and the routine that owns that task; the tab therefore carries
 * the thread it was opened for, exactly like the sources or memory panels, and
 * the rail icon only exists while that scope has an undismissed record.
 */
export interface AttentionContextTab {
  id: string
  kind: 'attention'
  title: string
  projectId: string
  threadId: string
}

/**
 * The global browser's downloads panel.
 *
 * Downloads belong to the shared browser profile, not to a project or thread,
 * so the tab carries no scope and is the one browser rail tool that can be
 * docked with no tab on screen.
 */
export interface BrowserDownloadsContextTab {
  id: string
  kind: 'downloads'
  title: string
}

/**
 * The global browser's browsing history panel.
 *
 * History is scoped to the browser that made each visit, so this panel lists the
 * global browser's own and none of a thread browser's. Inside that browser it
 * belongs to the profile rather than to a tab, so the tab carries no scope and is
 * one of the rail tools that can be docked with no tab on screen.
 */
export interface BrowserHistoryContextTab {
  id: string
  kind: 'history'
  title: string
}

/**
 * The global browser's bookmarks panel. A saved page belongs to the person rather
 * than to the browser that saved it, unlike the history, so the tab carries no
 * scope either.
 */
export interface BrowserBookmarksContextTab {
  id: string
  kind: 'bookmarks'
  title: string
}

/**
 * The global browser's boxes panel.
 *
 * A box is a property of the profile rather than of a page, so like downloads,
 * history and bookmarks this panel carries no scope and stays docked with no tab
 * on screen. It is also the one browser panel that is useful before any tab
 * exists, which is exactly when a user makes their first box.
 */
export interface BrowserBoxesContextTab {
  id: string
  kind: 'boxes'
  title: string
}

/**
 * The global browser's extensions panel.
 *
 * An extension belongs to the browser profile rather than to a page, exactly like
 * a box, so this panel carries no scope and stays docked with no tab on screen.
 * It is also the panel a user needs before a box can be given anything: installing
 * is what puts the extension on disk to be contained.
 */
export interface BrowserExtensionsContextTab {
  id: string
  kind: 'extensions'
  title: string
}

/**
 * One popup window on the browser's right rail.
 *
 * The app hosts the popup page in the rail and carries one tab per visible popup.
 * Dismissing an extension action popup hides its tab while retaining the page;
 * dismissing a page-created popup closes its window. The renderer mirrors popup
 * state from main (see `browser-popup-windows.svelte.ts`).
 */
export interface BrowserPopupWindowContextTab {
  /** The popup window's own id, so a tab and a window are the same thing. */
  id: string
  kind: 'popup-window'
  title: string
  /** Action popups hide in place when dismissed; page popups close. */
  extensionPopup: boolean
  /** The browser tab whose page opened it, for the label when a title is missing. */
  openerTabId: string
  /** Live page favicon (data URL) from the browser, if the popup reported one. */
  favicon?: string
}

export type MemorySection = 'active' | 'proposed'

export interface MemoryContextTab {
  id: string
  kind: 'memory'
  title: string
  projectId: string
  threadId: string
  memorySection: MemorySection
  /** Routine of the assistant task this panel shows memory for; undefined for
   *  project and chat tabs, which have no routine. */
  routineId?: string
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

/** Sections of the assistant how-to panel, in strip order. */
export type AssistantPanelTab = 'all' | 'routine' | 'connections' | 'agents' | 'issues'

/**
 * Assistant View's how-to panel, docked into the context sidebar. There is
 * exactly one panel per routine, exactly like the file tree keeps one panel per
 * file: the tab lives in the project's context (not a task's), so it survives
 * task switches, and its id is keyed by the routine so opening the how-to from
 * any of the routine's tasks focuses the same panel. A routine-less task keys on
 * its own thread and so still owns exactly one panel. The tab shows the
 * routine's how-to, schedule, and connections, plus the anchor task's own
 * schedule override.
 */
export interface AssistantHowToContextTab {
  id: string
  kind: 'assistant-how-to'
  title: string
  projectId: string
  /** Task the panel was last opened from; refreshes the panel's task-scoped
   *  content (Issues) and never changes the panel's identity. */
  threadId: string
  /** Routine whose how-to the panel edits; null for a routine-less task. */
  routineId: string | null
  /** The section the panel was last showing. It lives on the tab, not in the
   *  component, so switching to another sidebar panel and back reopens the same
   *  section instead of resetting the panel to "All". */
  panelTab: AssistantPanelTab
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
  | AttentionContextTab
  | BrowserDownloadsContextTab
  | BrowserHistoryContextTab
  | BrowserBookmarksContextTab
  | BrowserBoxesContextTab
  | BrowserExtensionsContextTab
  | BrowserPopupWindowContextTab
  | MemoryContextTab
  | CoordinatorContextTab
  | AssistantHowToContextTab
  | BrowserContextTab
  | BrowserAgentContextTab

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
export const ATTENTION_TAB_ID = 'attention'

/** The decision panel for one conversation, constructed for its thread's scope. */
export function attentionTab(projectId: string, threadId: string): AttentionContextTab {
  return {
    id: ATTENTION_TAB_ID,
    kind: 'attention',
    title: 'Decisions made for you',
    projectId,
    threadId
  }
}

/** Tabs whose component/session state belongs to a project. Every other tab
 * remains in its owning thread context and is swapped when the thread changes. */
export const PROJECT_TAB_KINDS = new Set<ContextSidebarTab['kind']>([
  'files',
  'terminal',
  'actions',
  'git',
  'cloud-deployment',
  'memory',
  'assistant-how-to'
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
