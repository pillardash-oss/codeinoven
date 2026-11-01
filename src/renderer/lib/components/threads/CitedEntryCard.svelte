<script lang="ts">
  import CioFileText from '@pdslng/cio-icon/CioFileText.svelte'
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import { formatDateTimeCompact } from '$shared/date-time-format'
  import type { CitedEntry } from '$shared/cited-work'
  import { revealCitationFile } from '$lib/reveal-file'
  import CardButton from '../shared/CardButton.svelte'

  interface Props {
    /** One thing the settled turn left behind. */
    entry: CitedEntry
    /** The conversation whose workspace the entry lives in. */
    projectId?: string | null
  }

  let { entry, projectId = null }: Props = $props()

  const modifiedAt = $derived(formatDateTimeCompact(entry.modifiedAt))
  const isFolder = $derived(entry.kind === 'directory')

  function openEntry(): void {
    if (!projectId) return
    void revealCitationFile(projectId, entry.path)
  }
</script>

<div class="flex min-w-0 items-center gap-3 border border-border bg-surface px-3 py-2">
  {#if isFolder}
    <CioFolder size={16} strokeWidth={1.6} class="shrink-0 text-muted" />
  {:else}
    <CioFileText size={16} strokeWidth={1.6} class="shrink-0 text-muted" />
  {/if}
  <div class="min-w-0 flex-1">
    <div class="truncate text-[0.8125rem] font-medium text-foreground">{entry.name}</div>
    <div class="text-[0.75rem] text-dimmed">
      {isFolder ? 'Folder' : 'File'} · Modified {modifiedAt}
    </div>
  </div>
  <CardButton
    label={isFolder ? 'Open folder' : 'Open file'}
    title={`Open ${entry.name}`}
    variant="secondary"
    size="sm"
    onclick={openEntry}
  />
</div>
