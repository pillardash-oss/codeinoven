<script lang="ts">
  import CioCookie from '$lib/components/icons/cio/CioCookie.svelte'
  import CioDownload from '$lib/components/icons/cio/CioDownload.svelte'
  import type { WorkspaceBrowserController } from './WorkspaceBrowserController.svelte'

  interface Props {
    browser: WorkspaceBrowserController
  }

  let { browser }: Props = $props()
</script>

<button
  class="fixed inset-0 z-30 cursor-default"
  aria-label="Close browser menu"
  title="Close browser menu"
  onclick={() => (browser.menuOpen = false)}
  oncontextmenu={(event: MouseEvent) => {
    event.preventDefault()
    browser.menuOpen = false
  }}
></button>
<div
  class="absolute right-full top-0 z-40 mr-2 w-56 overflow-hidden border bg-surface p-1 shadow-lg"
  role="menu"
  aria-label="Browser menu"
>
  <button
    type="button"
    class="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-elevated"
    role="menuitem"
    title="Manage downloaded files"
    onclick={() => browser.openDownloads()}
  >
    <CioDownload size={14} />
    <span>Manage downloads</span>
    {#if browser.unfinishedDownloadCount > 0}
      <span
        class="ml-auto bg-elevated px-1.5 text-[0.625rem] font-semibold tabular-nums text-muted"
      >
        {browser.unfinishedDownloadCount}
      </span>
    {/if}
  </button>
  <button
    type="button"
    class="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs text-danger transition-colors hover:bg-danger/10"
    role="menuitem"
    title="Clear browser cookies and site data"
    onclick={() => browser.requestDataClear()}
  >
    <CioCookie size={14} />
    <span>Clear cookies and site data</span>
  </button>
</div>
