import type { OrchestrationInitiator } from '../types/orchestration'
import type { Thread } from '../types/thread'
import type { Contract } from './contract-helpers'

/**
 * The orchestrator's read channels.
 *
 * `orchestration:dispatches` answers "every thread this thread dispatched", each
 * one a real thread row from its own project, so the board draws them exactly as
 * the Threads view does. `orchestration:initiators` answers which threads have
 * dispatched anything at all, which is what a thread row's orchestrator mark
 * reads once at start; a new dispatch keeps it current through the
 * `orchestration:changed` event.
 *
 * There is no write channel: the app records a dispatch itself when
 * `cio_orchestrate_dispatch` accepts a run, so neither surface can disagree with
 * what actually started.
 */
export const invokeOrchestrationContract = {
  'orchestration:dispatches': {} as Contract<[projectId: string, threadId: string], Thread[]>,
  'orchestration:initiators': {} as Contract<[], OrchestrationInitiator[]>
}
