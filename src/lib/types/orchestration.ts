/**
 * The orchestrator board's props, and the change notice its rows listen to.
 *
 * The board reads the dispatch ledger itself, so these are only the ids it is
 * published under: the thread that asked for the runs. Nothing about a
 * dispatched run travels through props, because a run is a real thread and the
 * board reads those threads' own rows rather than a description of them.
 */
export interface OrchestrateCoordinatorPanelProps {
  /** Project of the thread that asked for the dispatches. */
  projectId: string
  /** That thread: the board lists the dispatches it started. */
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
