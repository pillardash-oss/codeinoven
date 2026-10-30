import type { Thread } from '../types/thread'
import type { Contract } from './contract-helpers'

/**
 * The orchestrator board's read channel.
 *
 * One call answers "every thread this thread dispatched", each one a real thread
 * row from its own project, so the board draws them exactly as the Threads view
 * does. There is no write channel: the app records a dispatch itself when
 * `cio_orchestrate_dispatch` accepts a run, so the board can never disagree with
 * what actually started.
 */
export const invokeOrchestrationContract = {
  'orchestration:dispatches': {} as Contract<[projectId: string, threadId: string], Thread[]>
}
