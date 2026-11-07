/**
 * The delegation board's props: the thread that started the work.
 *
 * Like every coordinator board, nothing about a delegated thread travels through
 * props. A pawn and a dispatched run are real threads the renderer already holds,
 * so the board is published under the spawner's ids and reads its rows from thread
 * memory and the dispatch ledger itself.
 */
export interface DelegationCoordinatorPanelProps {
  /** Project of the thread that started the work. */
  projectId: string
  /** That thread: the board lists what it started. */
  threadId: string
}

/**
 * One thread that has dispatched runs, and how many.
 *
 * This is what a thread row needs to wear the orchestrator mark: the count is
 * read once at start and kept current by {@link OrchestrationDispatchChange}, so
 * a row never has to ask whether its own thread dispatched anything.
 */
export interface OrchestrationInitiator {
  threadId: string
  count: number
}

/** A thread's dispatch count changed, because a run was just dispatched. */
export type OrchestrationDispatchChange = OrchestrationInitiator
