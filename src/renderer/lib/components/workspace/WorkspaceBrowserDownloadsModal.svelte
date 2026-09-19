<script lang="ts">
  import { Download } from '@lucide/svelte'
  import BrowserDownloadRow from '../browser/BrowserDownloadRow.svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import type { WorkspaceBrowserController } from './WorkspaceBrowserController.svelte'

  interface Props {
    browser: WorkspaceBrowserController
  }

  let { browser }: Props = $props()
</script>

<Modal
  open={browser.downloadsOpen}
  title="Browser downloads"
  onClose={() => browser.closeDownloads()}
  size="lg"
  contentClass="overflow-y-auto p-5"
  closeOnBackdrop={false}
>
  {#if browser.downloads.length === 0}
    <EmptyState
      icon={Download}
      title="No downloads for this project yet"
      description="Files this browser downloads appear here with their progress and the location they were saved to."
    />
  {:else}
    <ul class="space-y-2">
      {#each browser.downloads as download (download.id)}
        <li>
          <BrowserDownloadRow {download} />
        </li>
      {/each}
    </ul>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Close the downloads manager"
      onclick={() => browser.closeDownloads()}
    >
      Close
    </button>
  {/snippet}
</Modal>
