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
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  time?: { start: number; end?: number }
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
  /** Best-effort CPU use reported by the operating system for this process or tree. */
  cpuPercent: number | null
  /** Resident/working-set memory for this process or tree. */
  memoryBytes: number | null
  /** Harness roots include their descendants; descendant rows describe one process. */
  resourceScope: 'process' | 'tree'
  /** Display name of the owning project, resolved at IPC time. */
  projectName?: string | null
  /** Display title of the owning thread, resolved at IPC time. */
  threadTitle?: string | null
}

export interface TaskManagerSnapshot {
  processes: TaskManagerProcess[]
  power: {
    source: 'ac' | 'battery'
    thermalState: 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical'
  }
  sampledAt: number
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
  background: boolean
  output?: string
  error?: string
  /** Project-relative paths the sub-agent's file tools edited or wrote. */
  files?: string[]
  time?: { start: number; end?: number }
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
