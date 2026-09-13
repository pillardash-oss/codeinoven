<script lang="ts">
  import { onMount } from 'svelte'
  import { Loader2, RefreshCw, ScrollText } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import type { UpdaterChangelog } from '$shared/ipc-contract'

  let changelog = $state<UpdaterChangelog | null>(null)
  let loading = $state(true)
  let error = $state(false)

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

  const formattedDate = $derived.by(() => {
    if (!changelog?.publishedAt) return ''
    const parsed = Date.parse(changelog.publishedAt)
    return Number.isNaN(parsed) ? '' : dateFormat.format(parsed)
  })

  async function load(): Promise<void> {
    loading = true
    error = false
    try {
      changelog = await invoke('updater:getChangelog')
      if (!changelog) error = true
    } catch {
      changelog = null
      error = true
    } finally {
      loading = false
    }
  }

  // The section mounts on every About visit; the main process serves the
  // fetch from its short-lived cache, so remounts stay cheap.
  onMount(() => {
    void load()
  })
</script>

<div id="settings-block-about-changelog" class="mt-4 rounded-xl border bg-surface p-4">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <h3 class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
      <ScrollText size={13} />
      Changelog
    </h3>
    {#if changelog}
      <div class="flex items-center gap-2 text-[0.6875rem] text-muted">
        <span class="rounded-lg bg-elevated px-2 py-0.5 font-mono">{changelog.tag}</span>
        {#if formattedDate}
          <span>{formattedDate}</span>
        {/if}
      </div>
    {/if}
  </div>

  {#if loading}
    <div class="flex items-center gap-2 text-xs text-muted">
      <Loader2 size={13} class="animate-spin" />
      Fetching release notes…
    </div>
  {:else if changelog}
    <div class="max-h-80 overflow-y-auto pr-1">
      <MarkdownView text={changelog.notes} />
    </div>
  {:else if error}
    <div class="flex items-center gap-3 text-xs text-dimmed">
      <span>Changelog is unavailable right now.</span>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg border bg-elevated px-2.5 py-1 text-xs font-medium hover:bg-overlay"
        title="Retry fetching the changelog"
        onclick={() => void load()}
      >
        <RefreshCw size={12} />
        Retry
      </button>
    </div>
  {/if}
</div>
