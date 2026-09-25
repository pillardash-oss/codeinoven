import type {
  CreateRoutineInput,
  MissedRun,
  Project,
  Routine,
  RoutineDeletionResult,
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
  /**
   * Remove a routine with everything it owns: its tasks, the runs they produced,
   * its hidden how-to thread, the scheduler's records for them, and its artifact
   * folder. Returns what was swept, so the caller can report it to the user.
   */
  'routine:delete': {} as Contract<[routineId: string], RoutineDeletionResult>,
  'routine:reorder': {} as Contract<[orderedIds: string[]], Routine[]>,
  /** Pin or unpin a routine so it sorts above the rest. */
  'routine:setPinned': {} as Contract<[routineId: string, pinned: boolean], Routine>,
  /** Store a custom icon image for a routine from a local file path. */
  'routine:setIcon': {} as Contract<[routineId: string, sourcePath: string], Routine>,
  /** Remove a routine's custom icon image. */
  'routine:clearIcon': {} as Contract<[routineId: string], Routine>,
  /** Read a routine's custom icon as a data URL, or null when it has none. */
  'routine:getIcon': {} as Contract<[routineId: string], string | null>,
  /** Group a task into a routine, or ungroup it with `null`. */
  'assistant:setTaskRoutine': {} as Contract<[threadId: string, routineId: string | null], Thread>,
  /**
   * A routine's how-to ("Getting started") thread, hidden or not, or null when
   * the routine has none. Hidden threads never reach the renderer's hydrated
   * thread list, so the how-to panel asks for its own routine's thread here.
   */
  'assistant:howToThread': {} as Contract<[routineId: string], Thread | null>,
  /**
   * The Getting started checkpoint the authoring agent keeps current, or null
   * while the interview has not saved one. The panel shows it so the interview's
   * agreed state is auditable without opening the thread.
   */
  'routine:gettingStartedCheckpoint': {} as Contract<[routineId: string], string | null>,
  /**
   * Hide or reveal a routine's how-to thread. The thread stays pinned in both
   * states; archiving is only what takes it out of the sidebar's lists.
   */
  'assistant:setHowToHidden': {} as Contract<[routineId: string, hidden: boolean], Thread>,
  /** Set or clear a task's per-task schedule override. */
  'assistant:setTaskSchedule': {} as Contract<
    [threadId: string, schedule: RoutineSchedule | null],
    Thread
  >,
  /**
   * Post the routine's saved-how-to next-steps message into its Getting started
   * thread. Sent as a hidden internal turn, so the user sees only the agent's
   * prose list and never a user bubble. Best-effort: a hidden or missing
   * Getting started thread makes this a no-op.
   */
  'assistant:postSetup': {} as Contract<[routineId: string], void>,
  'assistant:listMissedRuns': {} as Contract<[], MissedRun[]>,
  'assistant:dismissMissedRun': {} as Contract<[id: string], void>,
  /** Dispatch the missed run on a fresh run thread and settle the record. */
  'assistant:runMissedRunNow': {} as Contract<[id: string], Thread | null>,
  /**
   * Run a routine immediately, ignoring its schedule and pause state. Each task
   * runs on its own fresh thread; the created run threads are returned in
   * dispatch order so the caller can open the first one. This is the manual
   * "test this routine" action.
   */
  'assistant:runRoutineNow': {} as Contract<[routineId: string], Thread[]>
}
