import type { ThreadStatus } from './thread'

/**
 * One thread a workstation-control turn dispatched, as the orchestrator board
 * lists it.
 *
 * The row carries the target's identity (which project, which thread) and the
 * exact machine and model the run was started with, and nothing about how the
 * run is going: `status` and `title` are read from the child thread's own row
 * at read time, so a board never shows a status it remembered instead of the
 * one the run actually has. A dispatch is a pointer, not a copy.
 */
export interface OrchestrationDispatch {
  /** Project the dispatched thread lives in. */
  childProjectId: string
  /** Name of that project, so a row can name its project without a second read. */
  childProjectName: string
  /** The dispatched thread. */
  childThreadId: string
  /** The thread's own title, as it reads in the sidebar today. */
  title: string
  /** The run's live status, from the child thread row. */
  status: ThreadStatus
  /** Machine the run was dispatched to. `local` is this computer. */
  ovenId: string
  ovenName: string
  /** Harness the run uses, e.g. `pi`, `claude-code`, `antigravity`. */
  harnessId: string
  providerId: string
  modelId: string
  thinkingLevel?: string
  /** When the dispatch was accepted. */
  createdAt: number
  /** When the child thread last changed, so a board can order by activity. */
  updatedAt: number
}

/** Props for the orchestrator board, which loads its own rows from its ids. */
export interface OrchestrateCoordinatorPanelProps {
  /** Project of the thread that asked for the dispatches. */
  projectId: string
  /** That thread: the board lists the dispatches it started. */
  threadId: string
}
