import type {
  ComputerUseActivity,
  ComputerUsePipFrame,
  ComputerUsePipState,
  CuaUpdateProgress,
  LocalRankingGradeProgress,
  ProviderConnectionInfo,
  Thread,
  TypesafeStatus
} from '../types'
import type {
  BrowserDevToolsState,
  BrowserDownload,
  BrowserInspectorEvent,
  BrowserOpenRequestContext,
  BrowserPageState,
  BrowserPanelShortcutAction,
  BrowserPermissionRequest
} from './browser'
import type {
  AgentNotificationPayload,
  CloseConfirmationPayload,
  NotificationSoundKind,
  SystemNotificationPermissionStatus,
  ThreadClickedPayload
} from './notifications'
import type { UpdaterStatus } from './updater'
import type { SkillUpdateStatus } from '../types/utility'

export const IPC_EVENT_CONTRACT = {
  /** Post-paint feature IPC, chat, and harness registration completed. */
  'app:featuresReady': [] as [],
  'agent:processesChanged': [] as unknown as [projectId: string, threadId: string],
  /** Live agent lifecycle/stream event broadcast to every window. */
  'agent:event': [] as unknown as [event: import('../types').AgentEvent],
  'taskManager:processesChanged': [] as [],
  'agent:temporaryChatExpired': [] as unknown as [temporaryChatId: string],
  'thread:deleted': [] as unknown as [projectId: string, threadId: string],
  /** Live thread snapshot push so sidebar indicators react without polling. */
  'thread:updated': [] as unknown as [thread: Thread],
  /** Lightweight draft-state push (flag + committed draft content). Kept
   *  separate from `thread:updated` so commits land while the user is typing
   *  without triggering the full-transcript reconcile. */
  'thread:draftUpdated': [] as unknown as [
    projectId: string,
    threadId: string,
    drafting: boolean,
    draftJson: string | null
  ],
  /** Branch association changed for a thread. */
  'thread:branchUpdated': [] as unknown as [projectId: string, threadId: string, branch: string],
  /** Note presence changed for a thread (saved or deleted). */
  'note:changed': [] as unknown as [projectId: string, threadId: string, hasNote: boolean],
  /**
   * Threads another live CodeInOven instance is running right now, pushed
   * whenever that set changes. A second window has no harness for those turns
   * and receives none of their stream, so without this it can only show a
   * working spinner with no live output.
   */
  'thread:foreignRuns': [] as unknown as [notices: import('../types').ForeignRunNotice[]],
  /** Assistant routines changed (created, updated, deleted, reordered). */
  'routine:changed': [] as unknown as [routines: import('../types').Routine[]],
  /**
   * A routine's Getting started checkpoint was saved. Only the routine id
   * travels: the checkpoint itself is read on demand by the panel that shows it.
   */
  'routine:checkpointChanged': [] as unknown as [routineId: string],
  /** The set of pending missed scheduled runs changed. */
  'assistant:missedRunsChanged': [] as unknown as [runs: import('../types').MissedRun[]],
  /** The off-app audible alert for a notification, dispatched by the main
   *  process to a live renderer while the app is in the background. The in-app
   *  alert for a focused toast is played by the renderer itself, at the moment
   *  it shows that toast (see src/renderer/lib/notification-sound.ts). */
  'notification:playSound': [] as unknown as [kind: NotificationSoundKind],
  'notification:show': [] as unknown as [payload: AgentNotificationPayload],
  /** Transient in-app toast (error/info, optional navigation action). */
  'app:toast': [] as unknown as [
    payload: {
      message: string
      type: 'error' | 'info'
      projectId?: string
      threadId?: string
      action?: { label: string; projectId: string; threadId: string }
    }
  ],
  'notification:threadClicked': [] as unknown as [payload: ThreadClickedPayload],
  /** macOS notification authorization changed (delivery outcome or re-verification). */
  'notification:permissionStatus': [] as unknown as [status: SystemNotificationPermissionStatus],
  /** Emitted before the main process begins its shutdown disposal chain.
   *  The renderer should unsubscribe from IPC events and release resources. */
  'window:beforeQuit': [] as [],
  /**
   * Folders/files the operating system asked CodeInOven to open while the app
   * was already running (Finder/Explorer "Open in CodeInOven", a drop on the
   * Dock/taskbar icon, or a relayed launch argument). The renderer adds folders
   * as projects (deduplicated) and opens single files in the standalone viewer.
   */
  'openWith:paths': [] as unknown as [paths: import('../types').OpenedPath[]],
  /** Emitted when the app is asked to close while threads are still working or
   *  files have unsaved edits. The renderer populates `files` from its editor
   *  state and either confirms the close or shows the confirmation modal. */
  'window:confirmClose': [] as unknown as [payload: CloseConfirmationPayload],
  /**
   * Emitted when the user presses Cmd/Ctrl+W. The main process intercepts the
   * key (so the macOS "Close Window" menu accelerator never fires) and asks the
   * renderer to close the active in-app surface: modal, settings page, sidebar
   * panel, or thread. The shortcut never closes the native application window.
   */
  'window:closeShortcut': [] as [],
  /**
   * Emitted when the user presses Cmd/Ctrl+T while a terminal holds focus. The
   * main process intercepts the key (so ghostty-web never feeds it to the
   * shell) and asks the renderer to open a new terminal tab in the terminal
   * panel: right sidebar or bottom dock, whichever is active.
   */
  'window:newTerminalShortcut': [] as [],
  /**
   * Emitted when the user presses the mouse's back side button. Windows and
   * Linux surface it as the `browser-backward` app command in the main process;
   * the main process forwards it here so the renderer can walk its own
   * in-app navigation history (the window has no native browser history).
   * On macOS the renderer instead sees a raw `mousedown`/`auxclick` with
   * button 3: handled directly in App.svelte.
   */
  'window:historyBack': [] as [],
  /** Emitted when the user presses the mouse's forward side button. */
  'window:historyForward': [] as [],
  'updater:status': [] as unknown as [status: UpdaterStatus],
  'updater:waiting-for-threads': [] as unknown as [activeCount: number],
  /**
   * State of the app-owned TypeSafe (Jev) capability, pushed after any change
   * to the key or after a connection check, so an open Settings card never
   * shows a state the app has already moved past.
   */
  'typesafe:status': [] as unknown as [status: TypesafeStatus],
  /** Background pass over the skills CodeInOven installed (progress and result). */
  'utilities:skillUpdates': [] as unknown as [status: SkillUpdateStatus],
  /**
   * Progress of a manual ranking grade run, pushed after every pass so a queue
   * of conversations graded three at a time never looks like a hang. The run
   * itself answers over `account:gradeRankingQueue`; this stream carries only
   * the counters, so a pass never triggers a second read of the queue.
   */
  'account:rankingGradeProgress': [] as unknown as [progress: LocalRankingGradeProgress | null],
  'computerUse:pipFrame': [] as unknown as [frame: ComputerUsePipFrame],
  'computerUse:pipState': [] as unknown as [state: ComputerUsePipState],
  /**
   * Progress of an in-app Cua Driver update. The update itself answers over
   * `computerUse:updateCua`; this stream carries the installer's milestones so a
   * multi-minute download never looks like a hang.
   */
  'computerUse:cuaUpdate': [] as unknown as [progress: CuaUpdateProgress],
  /**
   * Emitted for every computer-use operation an agent performs, and again with
   * `active: false` when that thread's turn ends. Thread rows use this (not the
   * PiP state) so a row still signals desktop-scoped computer use, which has no
   * tracked window and therefore no PiP.
   */
  'computerUse:activity': [] as unknown as [activity: ComputerUseActivity],
  'browser:state': [] as unknown as [state: BrowserPageState],
  'gateway:state': [] as unknown as [status: import('../gateway-types').GatewayStatus],
  /** Live provider connection health/status snapshot. */
  'providers:status': [] as unknown as [payload: ProviderConnectionInfo[]],
  /** DevTools open state changed for a browser tab (open/closed). */
  'browser:devToolsChanged': [] as unknown as [state: BrowserDevToolsState],
  /** One event from a tab's injected design inspector: a pick, a finished
   *  comment, a removed pin, or inspect mode ending on its own. */
  'browser:inspector': [] as unknown as [tabId: string, event: BrowserInspectorEvent],
  /**
   * A browser shortcut the renderer has to carry out, because it owns the tab
   * strip: focusing the address bar of a tab, or closing or opening a tab. Main
   * decides the key, the renderer decides what the tab strip does with it.
   */
  'browser:panelShortcut': [] as unknown as [tabId: string, action: BrowserPanelShortcutAction],
  'browser:openRequested': [] as unknown as [url: string, context?: BrowserOpenRequestContext],
  /**
   * Delivered to the native permission-prompt popup window (not the main
   * renderer): the page permission awaiting a decision, plus how many requests
   * are queued behind it.
   */
  'browser:popup:permission': [] as unknown as [
    request: BrowserPermissionRequest,
    context: { queueSize: number; projectLabel: string | null }
  ],
  /** The native site-settings menu was closed; the panel resets its expanded state. */
  'browser:siteMenuClosed': [] as unknown as [],
  'browser:download': [] as unknown as [download: BrowserDownload],
  'speech:progress': [] as unknown as [progress: import('../speech/types').SpeechProgressEvent],
  /**
   * One live stage of a managed-worktree creation/adoption job. The renderer
   * keeps its docked job panel on these so the user sees real progress while
   * git, the environment copy and the setup commands run.
   */
  'scope:worktree:progress': [] as unknown as [
    progress: import('../types').ScopeWorktreeProgressEvent
  ],
  /**
   * An agent changed scope state (created, renamed, archived, deleted, synced
   * or merged a scope). The board reloads so agent-made scopes never hide
   * behind a stale snapshot.
   */
  'scope:boardChanged': [] as unknown as [event: import('../types').ScopeBoardChangedEvent],
  /**
   * A destructive scope action an agent asked for, awaiting the user's decision
   * in the app. Rendered as a confirmation dialog; the agent's tool call blocks
   * until it is answered or expires.
   */
  'scope:agentConfirmation': [] as unknown as [
    request: import('../types').ScopeAgentConfirmationRequest
  ],
  /** Live progress/prompt/completion updates for an in-app Pi OAuth sign-in. */
  'providerAccounts:oauthEvent': [] as unknown as [
    payload:
      | { loginId: string; kind: 'event'; event: import('../types').PiOAuthUiEvent }
      | {
          loginId: string
          kind: 'prompt'
          promptId: string
          prompt: import('../types').PiOAuthUiPrompt
        }
      | { loginId: string; kind: 'complete'; providerId: string }
      | { loginId: string; kind: 'failed'; error: string }
  ]
}
