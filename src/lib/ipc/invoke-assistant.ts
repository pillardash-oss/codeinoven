import type {
  CreateRoutineInput,
  MissedRun,
  Project,
  Routine,
  RoutineSchedule,
  Thread,
  UpdateRoutineInput
} from '../types'
import type { Contract } from './contract-helpers'

/**
 * Assistant View   routines, task grouping, and missed scheduled runs.
 *
 * Assistant tasks are ordinary threads in the hidden assistant space, so task
 * creation, listing, forking, and conversation all reuse the existing thread
 * channels. These channels cover only the routine grouping layer and the
 * scheduler's missed-run surface.
 */
export const invokeAssistantContract = {
  /** Ensure the hidden assistant-space container exists, returning it. */
  'routine:ensureSpace': {} as Contract<[], Project>,
  'routine:list': {} as Contract<[], Routine[]>,
  'routine:create': {} as Contract<[input: CreateRoutineInput], Routine>,
  'routine:update': {} as Contract<[routineId: string, input: UpdateRoutineInput], Routine>,
  'routine:delete': {} as Contract<[routineId: string], void>,
  'routine:reorder': {} as Contract<[orderedIds: string[]], Routine[]>,
  /** Pin or unpin a routine so it sorts above the rest. */
  'routine:setPinned': {} as Contract<[routineId: string, pinned: boolean], Routine>,
  /** Group a task into a routine, or ungroup it with `null`. */
  'assistant:setTaskRoutine': {} as Contract<[threadId: string, routineId: string | null], Thread>,
  /** Set or clear a task's per-task schedule override. */
  'assistant:setTaskSchedule': {} as Contract<
    [threadId: string, schedule: RoutineSchedule | null],
    Thread
  >,
  'assistant:listMissedRuns': {} as Contract<[], MissedRun[]>,
  'assistant:dismissMissedRun': {} as Contract<[id: string], void>,
  /** Dispatch the missed run on its task thread and settle the record. */
  'assistant:runMissedRunNow': {} as Contract<[id: string], void>
}
