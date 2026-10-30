import type { OrchestrationDispatch } from '../types/orchestration'
import type { Contract } from './contract-helpers'

/**
 * The orchestrator board's read channel.
 *
 * One call answers "every run this thread dispatched", with each run's own
 * project, machine, model and live status. There is no write channel: the app
 * writes a dispatch itself when `cio_orchestrate_dispatch` accepts a run, so the
 * board can never disagree with what actually started.
 */
export const invokeOrchestrationContract = {
  'orchestration:dispatches': {} as Contract<
    [projectId: string, threadId: string],
    OrchestrationDispatch[]
  >
}
