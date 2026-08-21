<script lang="ts">
  import { CircleCheck, GitPullRequest, Loader2, TriangleAlert } from '@lucide/svelte'
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
  per `PrDraft` (hence per project scope by default) gives the same multi-entry
  behaviour as `harnessLifecycleStore.runs`.
-->
{#each store.drafts as draft (draft.id)}
  <GitPullRequestSheet
    projectId={draft.projectId}
    scopeBucketId={draft.scopeBucketId}
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
    draftId={draft.id}
  />
{/each}

<!--
  Unified dock: each minimized draft's sheet suppresses its own dock
  (passes an empty snippet when `draftId` is set), so this single row is
  the only one. Chips sit side by side, one per minimized draft, showing
  the project icon, project name, live status, and PR title reported by
  each sheet's `updateDock`.
-->
{#if store.drafts.some((draft) => draft.minimized)}
  <div
    class="fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-2rem)] items-stretch gap-1 overflow-x-auto rounded-xl border bg-surface p-1.5 shadow-xl"
    role="group"
    aria-label="Docked pull request drafts"
  >
    {#each store.drafts as draft (draft.id)}
      {@const dock = draft.dock}
      {#if draft.minimized}
        <button
          class="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
          title={`${dock.projectName || 'Project'} — ${dock.title}`}
          aria-label={`Expand ${dock.projectName ? `${dock.projectName} ` : ''}${dock.title}`}
          onclick={() => store.expand(draft.id)}
        >
          {#if dock.iconUrl}
            <img src={dock.iconUrl} alt="" class="h-4 w-4 shrink-0 rounded" />
          {:else}
            <GitPullRequest size={14} class="shrink-0 text-dimmed" aria-hidden="true" />
          {/if}
          <span class="flex min-w-0 flex-col">
            {#if dock.projectName}
              <span class="max-w-36 truncate text-[9px] font-medium leading-tight text-muted">
                {dock.projectName}
              </span>
            {/if}
            <span class="max-w-36 truncate text-[10px] font-medium leading-tight text-foreground"
              >{dock.title}</span
            >
          </span>
          {#if dock.status === 'working'}
            <Loader2 size={12} class="shrink-0 animate-spin text-info" aria-hidden="true" />
          {:else if dock.status === 'attention'}
            <TriangleAlert
              size={12}
              class="shrink-0 text-warning"
              title="Needs attention"
              aria-hidden="true"
            />
          {:else if dock.status === 'composed' || dock.status === 'created'}
            <CircleCheck size={12} class="shrink-0 text-success" aria-hidden="true" />
          {/if}
        </button>
      {/if}
    {/each}
  </div>
{/if}
