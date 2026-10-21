import { invoke } from '$lib/ipc.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { sendThreadMessageHeadless } from '$lib/stores/thread-delivery'
import { threadSettings } from '$lib/stores/thread-settings.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { DEFAULT_SCOPE_WORKTREE_DEFAULTS } from '$shared/types'
import type {
  AgentAssistDelivery,
  AgentAssistRequest,
  AgentAssistSelection
} from './agent-assist-store.svelte'

/** Open the thread a handoff created, so its run is visible from the first token. */
async function openAssistThread(projectId: string, threadId: string): Promise<void> {
  const [project, thread] = await Promise.all([
    invoke('project:get', projectId).catch(() => null),
    invoke('thread:get', projectId, threadId).catch(() => null)
  ])
  if (thread) workspaceState.openThread(thread, project)
}

/**
 * Carry out one confirmed agent handoff.
 *
 * The handoff is always two steps: the scope has to exist before a thread can
 * own it (a review checkout can take minutes), and the brief is only a draft
 * until this decides what to do with it. `immediate` sends the brief the moment
 * the thread exists, `draft` leaves the same brief in the composer for the user
 * to adjust. Both open the thread, so the user watches the run they started.
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

  const prepare = async (scopeBucketId: string): Promise<string> => {
    const prepared = await request.prepare({
      scopeBucketId,
      settings: selection.settings,
      project
    })
    await openAssistThread(request.projectId, prepared.threadId)
    if (delivery === 'immediate') {
      await sendThreadMessageHeadless(request.projectId, prepared.threadId, {
        text: prepared.text,
        attachments: prepared.attachments ?? []
      })
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
