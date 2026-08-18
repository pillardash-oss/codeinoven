<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { gitPanelView } from '$lib/stores/git-panel-view.svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { PullRequestSummary } from '$shared/types'
  import GitPullRequestSheet from './GitPullRequestSheet.svelte'

  const store = prLifecycleStore

  async function revealPullRequest(
    projectId: string,
    originalThreadId: string,
    pullRequest: PullRequestSummary
  ): Promise<void> {
    const currentThread = workspaceState.selectedThread
    const threadId = currentThread?.projectId === projectId ? currentThread.id : originalThreadId

    if (currentThread?.projectId !== projectId || currentThread.id !== threadId) {
      const [project, thread] = await Promise.all([
        invoke('project:get', projectId).catch(() => null),
        invoke('thread:get', projectId, threadId).catch(() => null)
      ])
      if (thread) workspaceState.openThread(thread, project)
    }

    gitPanelView.openPullRequest(projectId, threadId, pullRequest)
    contextSidebarState.openGit(projectId, threadId)
  }
</script>

<!--
  Global PR dock — mirrors `HarnessRunModal` in `src/renderer/App.svelte:1638`.
  Mounted at the app root so each `GitPullRequestSheet` stays alive regardless
  of thread / project / view or whether the git sidebar is visible. One sheet
  per `PrDraft` (hence per project by default) gives the same multi-entry
  behaviour as `harnessLifecycleStore.runs`.
-->
{#each store.drafts as draft (draft.id)}
  <GitPullRequestSheet
    projectId={draft.projectId}
    minimized={draft.minimized}
    onMinimize={() => store.minimize(draft.id)}
    onExpand={() => store.expand(draft.id)}
    onClose={() => store.close(draft.id)}
    onView={(pullRequest) => void revealPullRequest(draft.projectId, draft.threadId, pullRequest)}
    storageKey={store.storageKeyFor(draft.id)}
    onCreated={() => {
      // The per-panel prListRefresh signal is intentionally not wired here —
      // the panel refetches on next open. Global drafts still create the PR
      // via `gitState.createPullRequest`.
    }}
  />
{/each}
