import type { Thread } from './thread'

/**
 * One thread a workstation-control turn dispatched, as the orchestrator board
 * lists it.
 *
 * The row carries the child thread itself, not a summary of it: the board draws
 * a dispatched run with the same thread row the Threads view draws, so title,
 * status, branch, scope and activity stamp all come from the thread and can
 * never disagree with the sidebar. Everything beside `thread` is what the
 * dispatch chose and the thread cannot know about itself: the project it was
 * started in, the machine, and the exact model.
 */
export interface OrchestrationDispatch {
  /** The dispatched thread, as the app stores it. */
  thread: Thread
  /** Name of the project the thread lives in, for the board's grouping. */
  projectName: string
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
}

/** Props for the orchestrator board, which loads its own rows from its ids. */
export interface OrchestrateCoordinatorPanelProps {
  /** Project of the thread that asked for the dispatches. */
  projectId: string
  /** That thread: the board lists the dispatches it started. */
  threadId: string
}
