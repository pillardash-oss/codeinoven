<script lang="ts">
  import { Download, X } from '@lucide/svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
  import BrowserDownloadRow from './BrowserDownloadRow.svelte'

  interface Props {
    projectId: string
    onClose: () => void
  }

  let { projectId, onClose }: Props = $props()

  const downloads = $derived(browserDownloads.forProject(projectId))
  const activeCount = $derived(browserDownloads.activeCount(projectId))
</script>

<!--
  The list is rendered in the panel's normal flow instead of as an overlay. The
  page itself is a native `WebContentsView` that the compositor paints above every
  DOM surface, so an absolutely positioned bubble would sit behind the page.
  Taking layout space shrinks the view through the panel's existing bounds sync,
  which is the same mechanism that keeps the view aligned while the sidebar
  animates.
-->
<section class="shrink-0 border-b border-border bg-surface" aria-label="Browser downloads">
  <div class="flex h-9 items-center gap-2 px-3">
    <Download size={13} class="shrink-0 text-muted" aria-hidden="true" />
    <p class="text-[0.6875rem] font-semibold text-foreground">Downloads</p>
    {#if activeCount > 0}
      <span class="tabular-nums text-[0.625rem] text-muted">{activeCount} in progress</span>
    {/if}
    <button
      type="button"
      class="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Close the downloads list"
      title="Close the downloads list"
      onclick={onClose}
    >
      <X size={12} />
    </button>
  </div>
  {#if downloads.length === 0}
    <EmptyState
      icon={Download}
      title="No downloads yet"
      description="Files this browser downloads appear here with their progress."
    />
  {:else}
    <ul class="max-h-64 divide-y divide-border overflow-y-auto border-t border-border">
      {#each downloads as download (download.id)}
        <li>
          <BrowserDownloadRow {download} compact />
        </li>
      {/each}
    </ul>
  {/if}
</section>
