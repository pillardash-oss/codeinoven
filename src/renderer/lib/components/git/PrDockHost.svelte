<script lang="ts">
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import GitPullRequestSheet from './GitPullRequestSheet.svelte'

  const store = prLifecycleStore
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
    storageKey={store.storageKeyFor(draft.id)}
    onCreated={() => {
      // The per-panel prListRefresh signal is intentionally not wired here —
      // the panel refetches on next open. Global drafts still create the PR
      // via `gitState.createPullRequest`.
    }}
  />
{/each}
