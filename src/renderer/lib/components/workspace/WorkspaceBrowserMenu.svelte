<script lang="ts">
  import { Cookie, Download } from '@lucide/svelte'
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
  class="absolute right-full top-0 z-40 mr-2 w-56 overflow-hidden rounded-lg border bg-surface p-1 shadow-lg"
  role="menu"
  aria-label="Browser menu"
>
  <button
    type="button"
    class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-elevated"
    role="menuitem"
    title="Manage downloaded files"
    onclick={() => browser.openDownloads()}
  >
    <Download size={14} />
    <span>Manage downloads</span>
    {#if browser.activeDownloadCount > 0}
      <span
        class="ml-auto rounded-full bg-elevated px-1.5 text-[0.625rem] font-semibold tabular-nums text-muted"
      >
        {browser.activeDownloadCount}
      </span>
    {/if}
  </button>
  <button
    type="button"
    class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-danger transition-colors hover:bg-danger/10"
    role="menuitem"
    title="Clear browser cookies and site data"
    onclick={() => browser.requestDataClear()}
  >
    <Cookie size={14} />
    <span>Clear cookies and site data</span>
  </button>
</div>
