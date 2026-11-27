import type { ThinkingLevel } from './common'

/**
 * Lifecycle state of one tool invocation or delegated sub-agent task.
 *
 * `aborted` is distinct from `error` on purpose: a deliberate user stop is not
 * a failure, and a surface that reported it as `completed` would claim work
 * that never finished.
 */
export type AgentToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'aborted'

/** State of a tool invocation as reported by the harness. */
export interface AgentToolState {
  status: AgentToolStatus
  input: Record<string, unknown>
  title?: string
  /**
   * True when `title` names what the call acted on, not what it did.
   *
   * An agent protocol client titles a call with its subject (Cursor titles a
   * shell call with the command itself, a search with `Find `<pattern>``), so
   * the title is the row's subject and the action is derived from the tool. A
   * harness that titles a call with the action it performed leaves this unset,
   * and its title stays the row's label.
   */
  titleIsSubject?: boolean
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  time?: { start: number; end?: number }
  /**
   * Provider-reported USD cost of this call, when the harness reports it.
   * A harness can fold work that produced no assistant message onto a tool
   * result (Pi's codemode: the script's nested calls and its classifier
   * models), and this is the only place that spend survives for accounting.
   */
  cost?: number
}

/**
 * A live operating-system process started beneath one task's agent harness.
 *
 * `scope` distinguishes processes started beneath a thread's own per-session
 * harness (`'thread'`) from processes started beneath a shared, app-wide
 * harness that is not tied to a single thread (e.g. the pooled opencode server),
 * so callers can show the right context and warn the user before killing it.
 */
export interface AgentRunningProcess {
  pid: number
  parentPid: number
  command: string
  startedAt: number
  scope: 'thread' | 'app'
  /** The directory it runs in, when the tracker knows it. */
  cwd?: string | null
  /** TCP ports it listens on, best-effort: what a busy port is traced by. */
  ports?: number[]
}

/**
 * App-wide process row surfaced by the task manager. Extends the per-thread
 * `AgentRunningProcess` with the working directory the process was launched in
 * and the project/thread that owns it (both `null` for app-scoped pooled
 * harness processes). `ports` lists any TCP ports the process is currently
 * listening on (best-effort OS detection).
 */
export interface TaskManagerProcess extends AgentRunningProcess {
  cwd: string | null
  projectId: string | null
  threadId: string | null
  ports: number[]
  /** Best-effort CPU use the operating system reports for this one process. */
  cpuPercent: number | null
  /** Resident/working-set memory for this one process. */
  memoryBytes: number | null
  /** Display name of the owning project, resolved at IPC time. */
  projectName?: string | null
  /** Display title of the owning thread, resolved at IPC time. */
  threadTitle?: string | null
}

/**
 * Kind of app-owned runtime a `TaskManagerService` describes. `server` is an
 * in-process loopback listener with no child process, `mcp` is a stdio MCP
 * server, and `worker` is any other app-owned helper. Distinct from
 * `TaskManagerProcess` because a service may have no pid at all.
 */
export type TaskManagerServiceKind = 'server' | 'mcp' | 'worker'

/**
 * App-wide runtime row surfaced by the task manager alongside OS processes.
 *
 * OS processes come from `AgentProcessService`; this covers everything that has
 * no tracked child process, so in-process loopback servers (the prototype
 * preview server, a previewed folder's static host, the utility gateway) and
 * spawned MCP servers are visible instead of absent. Project and thread names
 * are resolved at IPC time.
 */
export interface TaskManagerService {
  id: string
  kind: TaskManagerServiceKind
  name: string
  /** A URL, command line, or folder that says what the service is. */
  detail: string | null
  /** `thread`/`project` when the service belongs to one; `app` when shared. */
  scope: 'app' | 'project' | 'thread'
  projectId: string | null
  threadId: string | null
  /** OS pid when the service is backed by a process; `null` for in-process servers. */
  pid: number | null
  /** Loopback port the service listens on, when it listens. */
  port: number | null
  /** Origin URL a user can open, when the service serves HTTP. */
  url: string | null
  startedAt: number
  /** True when the service can be ended from the task manager. */
  stoppable: boolean
  /**
   * Best-effort CPU use the OS reports for the process backing this service.
   * `null` for a service with no process of its own (an in-process loopback
   * server) and for a pid the process snapshot does not know.
   */
  cpuPercent: number | null
  /** Resident/working-set memory of the process backing this service. */
  memoryBytes: number | null
  /** Display name of the owning project, resolved at IPC time. */
  projectName?: string | null
  /** Display title of the owning thread, resolved at IPC time. */
  threadTitle?: string | null
}

export interface TaskManagerSnapshot {
  processes: TaskManagerProcess[]
  services: TaskManagerService[]
  /**
   * One row per live renderer surface (a window, a browser tab, a webview, an
   * extension's offscreen document). `app.getAppMetrics()` alone reports one
   * row per process, so a renderer at 90% CPU cannot be attributed to anything
   * a user recognises; joining each WebContents to its OS process is what names
   * the surface that is hot.
   */
  surfaces: TaskManagerSurface[]
  power: {
    source: 'ac' | 'battery'
    thermalState: 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical'
  }
  sampledAt: number
}

/**
 * The surface a renderer process draws: `window` is the app window itself,
 * `tab` an embedded browser view, `webview` an in-page guest, `offscreen` an
 * extension document with nothing on screen, and `other` anything Electron
 * types that the task manager does not name.
 */
export type TaskManagerSurfaceKind = 'window' | 'tab' | 'offscreen' | 'webview' | 'other'

/**
 * One live renderer surface with the CPU and memory its OS process uses.
 *
 * The pid is the renderer's own OS process, the same pid `app.getAppMetrics()`
 * reports, so a row here can be matched against the process list above it.
 */
export interface TaskManagerSurface {
  pid: number
  kind: TaskManagerSurfaceKind
  /** Display label: the page title, or the sanitized URL when it has none. */
  title: string
  /** Origin and path only, with no query or hash, so no token ever reaches the UI. */
  url: string
  /** `null` when the OS reported no CPU sample for this process. */
  cpuPercent: number | null
  /** `null` when the OS reported no memory sample for this process. */
  memoryBytes: number | null
}

/** Provider-neutral lifecycle state for one delegated child-agent task. */
export interface AgentSubagentActivity {
  status: AgentToolStatus
  agent: string
  description: string
  prompt?: string
  childSessionId?: string
  providerTaskId?: string
  providerId?: string
  modelId?: string
  /** Harness that ran the worker, when it is not simply the parent's harness. */
  harnessId?: string
  /** Reasoning effort the worker ran with. A harness that reports none per
   *  worker leaves this unset and the surface falls back to the parent thread's
   *  level, which is what a nested worker inherits. */
  thinkingLevel?: ThinkingLevel
  background: boolean
  /**
   * True when the worker is the app's own Assignment draft run. It wears the
   * same card, body and session view as any other worker because the user
   * watches it the same way: it is one job, not a second conversation.
   */
  assignmentDraft?: boolean
  output?: string
  error?: string
  /**
   * When the app will retry this worker's own session after a transient
   * failure. The parent's card counts this down instead of declaring the worker
   * dead while the app is about to run it again.
   */
  retryAt?: number
  /** True when `retryAt` is the app's rate-limit cooldown, not a provider reset. */
  retryCooldown?: boolean
  /** Project-relative paths the sub-agent's file tools edited or wrote. */
  files?: string[]
  /**
   * File the worker's session is persisted in, when the harness names one.
   *
   * It is the only handle a nested worker can be continued from: the session
   * file holds the transcript a harness re-opens, so another app instance that
   * cannot speak this process's protocol can resume the worker from it instead
   * of losing the work.
   */
  sessionFile?: string
  /**
   * Worker id the primary agent addresses this worker by in its own tool calls
   * (`cio-subagent-N`).
   *
   * It is not the tool call id: a worker that is resumed on another instance
   * has to keep this id, or every `cio_agent_status` and `cio_agent_output` the
   * primary agent already made would name a worker that no longer exists.
   */
  agentId?: string
  time?: { start: number; end?: number }
  /**
   * True when the delegated worker is a pawn agent: an independent thread the
   * app spawned for an agent, rather than a session nested inside the harness.
   *
   * A pawn wears the same card, body and session view as a sub-agent, because
   * the agent that reads them needs the same three things (the prompt it gave,
   * the work as it happened, and the final report). Only the mark changes, so
   * the rail can tell the two apart, and `childSessionId` names a session on the
   * pawn's own thread rather than one nested under its parent.
   */
  pawn?: boolean
}

/** User-facing copy for a turn whose full text is an internal agent instruction. */
export interface UserMessagePresentation {
  action: string
  body?: string
}

/** Durable source identity for a persisted conversation record. */
export type AgentMessageOrigin =
  'user' | 'assistant' | 'harness' | 'orchestrator' | 'subagent' | 'compaction' | 'provider'

/** Durable UI channel for a persisted conversation record. */
export type AgentMessageVisibility = 'conversation' | 'working_trace' | 'subagent_trace' | 'hidden'
