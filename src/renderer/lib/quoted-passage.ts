import { DEFAULT_SCOPE_BUCKET_ID, DEFAULT_THREAD_TITLE, type Thread } from '$shared/types'
import { invoke } from '$lib/ipc.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'

/**
 * Handing a quoted passage of something to a new thread.
 *
 * Two surfaces quote a passage and offer to spin it off into a thread of its
 * own: a selection taken from an assistant response, and a passage selected in an
 * annotated project document. Both seed the same draft and inherit the same
 * scope, so the mechanics live here rather than in each reader.
 */

/**
 * The draft a quoted passage becomes in a fresh thread.
 *
 * The passage is the user's own words carried over, so it lands as plain text:
 * fencing it turned a sentence they wanted to write on top of into a code block
 * the agent read as a quotation of code. A blank line above keeps the passage
 * apart from whatever they type before it.
 */
export function quotedPassageDraft(passage: string): string {
  return `\n${passage.trim()}\n`
}

/**
 * Spin a quoted passage off into a brand-new thread in the same project, seeded
 * with the passage as its composer draft.
 *
 * The source thread is read through the main process instead of being taken from
 * the current selection, because a document annotation names the conversation
 * that owns it and that is not always the thread on screen. A thread that has
 * gone since the passage was quoted is reported rather than swallowed: the draft
 * would otherwise land in a conversation that no longer exists.
 */
export function openPassageInNewThread(projectId: string, threadId: string, passage: string): void {
  void (async () => {
    try {
      const thread: Thread | null = await invoke('thread:get', projectId, threadId)
      if (!thread) throw new Error('the conversation the passage came from no longer exists')
      const project = scopeState.projectRecords.find((record) => record.id === projectId) ?? null
      const created = await invoke('thread:create', {
        projectId,
        providerId: thread.providerId,
        title: DEFAULT_THREAD_TITLE,
        workingDirectory: thread.workingDirectory,
        settings: thread.settings,
        // Inherit the source thread's scope so the spun-off thread stays in the
        // same bucket instead of dropping to the default one.
        scopeBucketId: thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
      })
      rendererRecovery.setDraft(created.projectId, created.id, quotedPassageDraft(passage))
      // The passage came out of that conversation, so the new thread starts with
      // it attached as context: a badge the user can detach, and a lookup the
      // agent may make when the passage alone does not say enough.
      rendererRecovery.setThreadReferences(created.projectId, created.id, [
        {
          projectId,
          threadId,
          title: thread.title
        }
      ])
      // The thread the passage becomes has to be on screen and ready to type
      // into: a draft nobody can see, in a view that cannot show it, is the
      // whole point of the action lost.
      workspaceState.openThreadInOwningView(created, project)
    } catch (error) {
      reportError(error, 'The new thread could not be created.')
    }
  })()
}
