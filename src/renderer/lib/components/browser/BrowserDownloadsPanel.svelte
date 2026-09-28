<script lang="ts">
  import { onMount } from 'svelte'
  import { Download } from '@lucide/svelte'
  import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
  import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import BrowserDownloadRow from './BrowserDownloadRow.svelte'

  /**
   * The global browser's downloads drawer, docked in the shared right rail.
   *
   * Downloads are owned by the browser profile, not by a tab, so this panel is
   * the rail tool that works with no tab open. It renders the one downloads
   * list (`browserDownloads`) through the one row component the workspace's
   * downloads manager already uses, so a download looks the same wherever it
   * surfaces.
   */

  const downloads = $derived(browserDownloads.forProject(GLOBAL_BROWSER_PROJECT_ID))

  // Read the authoritative list from main on first show: live progress arrives
  // through the store subscription, but a session that started before this panel
  // opened (or a trimmed list) is only reconciled by asking.
  onMount(() => {
    void browserDownloads.load(GLOBAL_BROWSER_PROJECT_ID)
  })
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if downloads.length === 0}
    <EmptyState
      icon={Download}
      title="No downloads yet"
      description="Files this browser downloads appear here with their progress and the location they were saved to."
    />
  {:else}
    <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
      {#each downloads as download (download.id)}
        <li>
          <BrowserDownloadRow {download} />
        </li>
      {/each}
    </ul>
  {/if}
</div>
