import type {
  AutoAnswerItem,
  BackgroundRun,
  CreateAssistantInput,
  MissedRun,
  Project,
  Assistant,
  AssistantDeletionResult,
  AssistantSchedule,
  SkippedRun,
  Thread,
  UpdateAssistantInput
} from '../types'
import type { CustomIconImage } from '../custom-icon'
import type { Contract } from './contract-helpers'

/**
 * Assistant View   assistants, task grouping, and missed scheduled runs.
 *
 * Assistant tasks are ordinary threads in the hidden assistant space, so task
 * creation, listing, forking, and conversation all reuse the existing thread
 * channels. These channels cover the assistant grouping layer and the scheduler's
 * run and skipped-slot surfaces.
 */
export const invokeAssistantContract = {
  /** Ensure the hidden assistant-space container exists, returning it. */
  'assistant:ensureSpace': {} as Contract<[], Project>,
  'assistant:list': {} as Contract<[], Assistant[]>,
  'assistant:create': {} as Contract<[input: CreateAssistantInput], Assistant>,
  'assistant:update': {} as Contract<[assistantId: string, input: UpdateAssistantInput], Assistant>,
  /**
   * Remove an assistant with everything it owns: its tasks, the runs they produced,
   * its hidden knowledge thread, the scheduler's records for them, and its artifact
   * folder. Returns what was swept, so the caller can report it to the user.
   */
  'assistant:delete': {} as Contract<[assistantId: string], AssistantDeletionResult>,
  'assistant:reorder': {} as Contract<[orderedIds: string[]], Assistant[]>,
  /** Pin or unpin an assistant so it sorts above the rest. */
  'assistant:setPinned': {} as Contract<[assistantId: string, pinned: boolean], Assistant>,
  /** Store a custom icon image for an assistant from the shared icon pipeline. */
  'assistant:setIcon': {} as Contract<[assistantId: string, image: CustomIconImage], Assistant>,
  /** Remove an assistant's custom icon image. */
  'assistant:clearIcon': {} as Contract<[assistantId: string], Assistant>,
  /** Read an assistant's custom icon as a data URL, or null when it has none. */
  'assistant:getIcon': {} as Contract<[assistantId: string], string | null>,
  /** Group a task into an assistant, or ungroup it with `null`. */
  'assistant:assignTask': {} as Contract<[threadId: string, assistantId: string | null], Thread>,
  /**
   * An assistant's knowledge ("Getting started") thread, hidden or not, or null when
   * the assistant has none. Hidden threads never reach the renderer's hydrated
   * thread list, so the knowledge panel asks for its own assistant's thread here.
   */
  'assistant:knowledgeThread': {} as Contract<[assistantId: string], Thread | null>,
  /**
   * The Getting started checkpoint the authoring agent keeps current, or null
   * while the interview has not saved one. The panel shows it so the interview's
   * agreed state is auditable without opening the thread.
   */
  'assistant:gettingStartedCheckpoint': {} as Contract<[assistantId: string], string | null>,
  /**
   * Hide or reveal an assistant's knowledge thread. The thread stays pinned in both
   * states; archiving is only what takes it out of the sidebar's lists.
   */
  'assistant:setKnowledgeHidden': {} as Contract<[assistantId: string, hidden: boolean], Thread>,
  /** Set or clear a task's per-task schedule override. */
  'assistant:setTaskSchedule': {} as Contract<
    [threadId: string, schedule: AssistantSchedule | null],
    Thread
  >,
  /**
   * Turn one function's clock on or off independently of its assistant: `true`
   * schedules it, `false` keeps it off the clock, `null` follows the assistant.
   */
  'assistant:setTaskScheduled': {} as Contract<
    [threadId: string, scheduled: boolean | null],
    Thread
  >,
  /**
   * Post the assistant's saved-knowledge next-steps message into its Getting started
   * thread. Sent as a hidden internal turn, so the user sees only the agent's
   * prose list and never a user bubble. Best-effort: a hidden or missing
   * Getting started thread makes this a no-op.
   */
  'assistant:postSetup': {} as Contract<[assistantId: string], void>,
  /**
   * Open a brand-new assistant's first conversation, for the create-by-chat flow:
   * the user sees one line saying a new assistant is being created, and the model
   * is told to run the setup conversation.
   */
  'assistant:startChatSetup': {} as Contract<[assistantId: string], void>,
  /**
   * Open a form-created assistant's first conversation: the user sees one line,
   * and the model is told its own name and personality and greets the user.
   */
  'assistant:startManualSetup': {} as Contract<[assistantId: string], void>,
  'assistant:listMissedRuns': {} as Contract<[], MissedRun[]>,
  /** Read user-skipped scheduled slots used to calculate each task's next run. */
  'assistant:listSkippedRuns': {} as Contract<[], SkippedRun[]>,
  /** Whether an assistant has any unskipped scheduled slot remaining today. */
  'assistant:hasRunsToday': {} as Contract<[assistantId: string], boolean>,
  /** Skip the closest upcoming unskipped slot in one assistant and return the new snapshot. */
  'assistant:skipNextRun': {} as Contract<[assistantId: string], SkippedRun[]>,
  /** Skip every remaining scheduled slot today in one assistant. */
  'assistant:skipRunsToday': {} as Contract<[assistantId: string], SkippedRun[]>,
  /**
   * Durable record of unattended runs, newest first. The "While you were away"
   * list and an assistant's own history read this so a run whose thread was since
   * evicted or deleted still shows what happened.
   */
  'assistant:listBackgroundRuns': {} as Contract<[], BackgroundRun[]>,
  /**
   * Acknowledge one unattended run, so it leaves the "While you were away"
   * surface while the assistant run history keeps the entry as evidence.
   */
  'assistant:dismissBackgroundRun': {} as Contract<[id: string], void>,
  'assistant:dismissMissedRun': {} as Contract<[id: string], void>,
  /**
   * Acknowledge several runs at once: the missed scheduled fires and the
   * unattended-run ledger entries a surface is clearing. The notification panel's
   * clear-all uses it so its Assistants tab never retires one row per call.
   */
  'assistant:dismissRuns': {} as Contract<
    [missedRunIds: string[], backgroundRunIds: string[]],
    void
  >,
  /**
   * Gates the app resolved without the user (a question whose timer answered
   * it, a secret card that expired, an image-descriptor decision that timed
   * out). The right-rail attention panel lists these until dismissed.
   */
  'assistant:listAutoAnswers': {} as Contract<[], AutoAnswerItem[]>,
  'assistant:dismissAutoAnswer': {} as Contract<[id: string], void>,
  /** Dismiss every unread auto-resolved gate. Returns how many were cleared. */
  'assistant:dismissAllAutoAnswers': {} as Contract<[], number>,
  /** Dispatch the missed run on a fresh run thread and settle the record. */
  'assistant:runMissedRunNow': {} as Contract<[id: string], Thread | null>,
  /**
   * Run an assistant immediately, ignoring its schedule and pause state. Each task
   * runs on its own fresh thread; the created run threads are returned in
   * dispatch order so the caller can open the first one. This is the manual
   * "test this assistant" action.
   */
  'assistant:runNow': {} as Contract<[assistantId: string], Thread[]>
}
