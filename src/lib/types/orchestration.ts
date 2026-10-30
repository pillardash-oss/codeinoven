/**
 * Props for the orchestrator board.
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
