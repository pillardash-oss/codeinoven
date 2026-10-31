import { invoke, subscribe } from '$lib/ipc.svelte'
import { ipcErrorMessage } from '$lib/ipc-errors'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { scopeJobStageLabel } from '$lib/stores/scope-jobs.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { sendThreadMessageHeadless } from '$lib/stores/thread-delivery'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { threadSettings } from '$lib/stores/thread-settings.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { classifyProviderIssue, parseUsageResetAt } from '$shared/provider-issue'
import { DEFAULT_SCOPE_WORKTREE_DEFAULTS } from '$shared/types'
import type {
  AgentAssistDelivery,
  AgentAssistRequest,
  AgentAssistSelection
} from './agent-assist-store.svelte'

export interface AgentAssistProgress {
  stage: 'project' | 'scope' | 'thread' | 'dispatch' | 'agent'
  detail?: string
  threadId?: string
}

/** The selection a handoff started from, so it can tell whether the reader is still there. */
interface AssistOrigin {
  projectId: string
  threadId: string
}

/**
 * Open the thread a handoff created, so its run is visible from the first token.
 *
 * `stillWanted` is what keeps a slow handoff from taking the screen. Preparing a
 * review checkout can take minutes, and the thread is only worth opening while
 * the reader is still where they were when they confirmed it: opening it later
 * pulled them off the conversation they had moved to since, and because a thread
 * open is what the app remembers as its last selection, it also made the next
 * start come back to that thread and its panels instead of the work they had
 * actually gone to.
 */
async function openAssistThread(
  projectId: string,
  threadId: string,
  stillWanted: () => boolean = () => true
): Promise<void> {
  const project = await invoke('project:get', projectId).catch(() => null)
  // The thread was created optimistically a moment ago, so its row may not be
  // readable on the first attempt. Opening it is how the user watches the run
  // they paid for, so it is worth a few short retries rather than a silent miss.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (!stillWanted()) return
    const thread = await invoke('thread:get', projectId, threadId).catch(() => null)
    if (thread) {
      if (!stillWanted()) return
      workspaceState.openThread(thread, project)
      return
    }
    await new Promise((done) => setTimeout(done, 150))
  }
}

/**
 * Put a refused start in front of the user where the work was meant to happen.
 *
 * A send can reject before it ever reaches the harness (an Oven that is not
 * answering, a provider that refused the session), and that rejection produces
 * no message to hang an error on. The run-issue card is the same surface a
 * mid-run provider failure uses, so the thread says what happened and what to
 * do about it instead of sitting there empty.
 */
function reportStartFailure(
  projectId: string,
  threadId: string,
  selection: AgentAssistSelection,
  error: unknown
): void {
  const raw = error instanceof Error ? error.message : 'The agent run could not be started.'
  const message = ipcErrorMessage(error, raw)
  const kind = classifyProviderIssue(message)
  const retryAt = kind === 'quota' || kind === 'rate_limit' ? parseUsageResetAt(message) : undefined
  threadMessages.setRunIssue(projectId, threadId, {
    kind,
    message,
    rawError: raw,
    harnessId: selection.settings.harnessId || 'unknown',
    retryable: true,
    ...(retryAt === undefined ? {} : { retryAt })
  })
}

/**
 * Carry out one confirmed agent handoff.
 *
 * The handoff is always two steps: the scope has to exist before a thread can
 * own it (a review checkout can take minutes), and the brief is only a draft
 * until this decides what to do with it. `immediate` sends the brief the moment
 * the thread exists, `draft` leaves the same brief in the composer for the user
 * to adjust. Both open the thread, so the user watches the run they started
 * with the model, thinking level, permissions, Oven and scope they confirmed.
 */
export async function runAgentAssist(
  request: AgentAssistRequest,
  selection: AgentAssistSelection,
  delivery: AgentAssistDelivery,
  onProgress: (progress: AgentAssistProgress) => void = () => undefined
): Promise<void> {
  const project = await invoke('project:get', request.projectId)
  if (!project) throw new Error('This project is no longer available')
  // The reader's place when they confirmed the handoff: the prepared thread only
  // opens itself if they are still here (see `openAssistThread`).
  const selectedAtStart = workspaceState.selectedThread
  const origin: AssistOrigin | null = selectedAtStart
    ? { projectId: selectedAtStart.projectId, threadId: selectedAtStart.id }
    : null
  // The confirmed configuration seeds the next thread the user starts.
  threadSettings.commit(selection.settings)

  /**
   * Build the thread, open it, and start the brief.
   *
   * A run that cannot start is not a handoff that failed to be created: the
   * thread exists, is on screen, and carries the failure (a provider or Oven
   * problem lands there as its own card with the retry). The background job
   * also reports the failure, while preserving the prepared thread.
   */
  const prepare = async (scopeBucketId: string): Promise<string> => {
    onProgress({ stage: 'thread', detail: 'Preparing the thread and prompt' })
    const prepared = await request.prepare({
      scopeBucketId,
      settings: selection.settings,
      project
    })
    onProgress({
      stage: 'dispatch',
      detail: delivery === 'draft' ? 'Opening the prompt' : 'Starting the agent',
      threadId: prepared.threadId
    })
    if (delivery === 'draft') {
      // The brief has to be in the draft store before the thread opens. A
      // composer captures its restored draft exactly once, when it mounts, so a
      // draft written after the open waited in the store while the user looked
      // at an empty composer, and only appeared after leaving the thread and
      // coming back. Writing it first is what makes the prompt arrive with the
      // thread instead of a visit later.
      rendererRecovery.setDraft(
        request.projectId,
        prepared.threadId,
        prepared.text,
        prepared.attachments ?? [],
        []
      )
    }
    await openAssistThread(request.projectId, prepared.threadId, () => {
      const current = workspaceState.selectedThread
      if (!current) return origin === null
      return (
        origin !== null && current.projectId === origin.projectId && current.id === origin.threadId
      )
    })
    if (delivery === 'immediate') {
      try {
        // The confirmed configuration travels with the message: the turn runs
        // (and the thread's row is written) with the model, Oven and
        // permissions the user picked, never with whatever a row read returns.
        await sendThreadMessageHeadless(request.projectId, prepared.threadId, {
          text: prepared.text,
          attachments: prepared.attachments ?? [],
          settings: selection.settings
        })
      } catch (error) {
        // A submit-time failure (an unreachable Oven, a provider that refused
        // the session) is reported in the thread itself, as the card the user
        // can act on and retry. Propagate it to the background job too, so a
        // refused start never looks like a successful review.
        reportStartFailure(request.projectId, prepared.threadId, selection, error)
        throw error
      }
    }
    return prepared.threadId
  }

  if (selection.scopeBucketId) {
    onProgress({ stage: 'scope', detail: 'Using the selected checkout' })
    await prepare(selection.scopeBucketId)
    return
  }

  const checkout = request.newCheckout
  if (!checkout) throw new Error('This action needs a scope to run in')
  onProgress({ stage: 'scope', detail: 'Preparing the isolated checkout' })
  await scopeState.ensureBoardLoaded(request.projectId)
  const defaults =
    scopeState.boards.get(request.projectId)?.worktreeDefaults ?? DEFAULT_SCOPE_WORKTREE_DEFAULTS
  const bucket = await scopeState.createBucketForProject(request.projectId, checkout.title)
  if (!bucket) throw new Error('The review scope could not be created')
  // This handoff's job owns the full lifecycle, so the underlying managed
  // checkout streams into it instead of opening a second progress panel.
  const dispose = subscribe('scope:worktree:progress', (event) => {
    if (event.projectId === request.projectId && event.scopeBucketId === bucket.id) {
      onProgress({ stage: 'scope', detail: scopeJobStageLabel(event.stage) })
    }
  })
  try {
    const descriptor = await scopeState.createWorktree(request.projectId, bucket.id, {
      title: checkout.title,
      ...(checkout.pullRequest ? { pullRequest: checkout.pullRequest } : {}),
      ...defaults,
      // Setup stays a deliberate next step: the checkout may hold code the user
      // has not trusted with install scripts yet.
      runSetup: false
    })
    if (!descriptor) throw new Error('The isolated checkout could not be prepared')
  } finally {
    dispose()
  }
  await prepare(bucket.id)
}

export { openAssistThread }
