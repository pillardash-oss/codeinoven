import { invoke } from '$lib/ipc.svelte'
import { ipcErrorMessage } from '$lib/ipc-errors'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
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

/** Open the thread a handoff created, so its run is visible from the first token. */
async function openAssistThread(projectId: string, threadId: string): Promise<void> {
  const project = await invoke('project:get', projectId).catch(() => null)
  // The thread was created optimistically a moment ago, so its row may not be
  // readable on the first attempt. Opening it is how the user watches the run
  // they paid for, so it is worth a few short retries rather than a silent miss.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const thread = await invoke('thread:get', projectId, threadId).catch(() => null)
    if (thread) {
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
  delivery: AgentAssistDelivery
): Promise<void> {
  const project = await invoke('project:get', request.projectId)
  if (!project) throw new Error('This project is no longer available')
  // The confirmed configuration seeds the next thread the user starts.
  threadSettings.commit(selection.settings)

  /**
   * Build the thread, open it, and start the brief.
   *
   * A run that cannot start is not a handoff that failed to be created: the
   * thread exists, is on screen, and carries the failure (a provider or Oven
   * problem lands there as its own card with the retry). Only the thread
   * creation itself is allowed to abort the handoff.
   */
  const prepare = async (scopeBucketId: string): Promise<string> => {
    const prepared = await request.prepare({
      scopeBucketId,
      settings: selection.settings,
      project
    })
    await openAssistThread(request.projectId, prepared.threadId)
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
        // can act on and retry. The thread exists either way, so the handoff
        // itself did not fail, and the scope job must not claim it did.
        reportStartFailure(request.projectId, prepared.threadId, selection, error)
      }
    } else {
      rendererRecovery.setDraft(
        request.projectId,
        prepared.threadId,
        prepared.text,
        prepared.attachments ?? [],
        []
      )
    }
    return prepared.threadId
  }

  if (selection.scopeBucketId) {
    await prepare(selection.scopeBucketId)
    return
  }

  const checkout = request.newCheckout
  if (!checkout) throw new Error('This action needs a scope to run in')
  await scopeState.ensureBoardLoaded(request.projectId)
  const defaults =
    scopeState.boards.get(request.projectId)?.worktreeDefaults ?? DEFAULT_SCOPE_WORKTREE_DEFAULTS
  let threadId: string | null = null
  // A checkout that takes minutes belongs in the scope dock, not in front of a
  // dialog: confirm hands the run over, and the dock reports the rest.
  scopeJobs.create(
    request.projectId,
    {
      title: checkout.title,
      isolated: true,
      ...(checkout.pullRequest ? { pullRequest: checkout.pullRequest } : {}),
      ...defaults,
      // Setup stays a deliberate next step: the checkout may hold code the user
      // has not trusted with install scripts yet.
      runSetup: false
    },
    {
      prepare: async (bucketId) => {
        threadId = await prepare(bucketId)
        return {
          label: 'Open thread',
          run: () => {
            if (threadId) void openAssistThread(request.projectId, threadId)
          }
        }
      }
    }
  )
}
