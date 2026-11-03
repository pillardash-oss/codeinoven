<script lang="ts">
  import CioFileText from '@pdslng/cio-icon/CioFileText.svelte'
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { formatDateTimeCompact } from '$shared/date-time-format'
  import type { CitedEntry } from '$shared/cited-work'
  import { revealCitationFile } from '$lib/reveal-file'
  import CardButton from '../shared/CardButton.svelte'

  interface Props {
    /** One thing the settled turn left behind. */
    entry: CitedEntry
    /** The conversation whose workspace the entry lives in. */
    projectId?: string | null
    /** The thread the row is drawn in, which is where a served design opens. */
    threadId?: string | null
    /**
     * Where the row is drawn.
     *
     * `card` is the row standing for the whole answer: it carries the card's own
     * padding and type size, because it is the only thing on that surface. `list`
     * is the same row inside a bigger card, sharing the diff rows' rhythm and its
     * hairline, so two sections of one card read as one list.
     */
    density?: 'card' | 'list'
  }

  let { entry, projectId = null, threadId = null, density = 'list' }: Props = $props()

  const inCard = $derived(density === 'card')

  const modifiedAt = $derived(formatDateTimeCompact(entry.modifiedAt))
  const isFolder = $derived(entry.kind === 'directory')
  /** Authored work is served and shown, never browsed as a folder of files. */
  const work = $derived(entry.work ?? null)
  const label = $derived(
    work === 'design'
      ? 'Open design'
      : work === 'video'
        ? 'Open composition'
        : isFolder
          ? 'Open folder'
          : 'Open file'
  )

  async function openEntry(): Promise<void> {
    if (!projectId) return
    if (!work || !threadId) {
      void revealCitationFile(projectId, entry.path)
      return
    }
    try {
      // One call does all three steps the app owns: serve the folder (a server is
      // minted only when this folder has none), open it in the browser (an
      // existing tab for this design is reused, not stacked), and reveal it,
      // because clicking the row is the user asking to see the work.
      await invoke('design:open', projectId, threadId, entry.path, null, true, work)
    } catch {
      // A folder that is no longer a servable design still belongs to the reader:
      // revealing it is better than an action that reports nothing.
      void revealCitationFile(projectId, entry.path)
    }
  }
</script>

<div
  class={[
    'flex w-full min-w-0 items-center transition-colors hover:bg-elevated',
    inCard ? 'gap-3 px-3 py-2' : 'min-h-9 gap-2 border-b border-border px-3 last:border-b-0'
  ]}
>
  {#if isFolder}
    <CioFolder size={inCard ? 16 : 15} strokeWidth={1.6} class="shrink-0 text-muted" />
  {:else}
    <CioFileText size={inCard ? 16 : 15} strokeWidth={1.6} class="shrink-0 text-muted" />
  {/if}
  <div class="min-w-0 flex-1">
    <div
      class={[
        'truncate font-medium text-foreground',
        inCard ? 'text-[0.8125rem]' : 'text-[0.75rem]'
      ]}
    >
      {entry.name}
    </div>
    <div class={inCard ? 'text-[0.75rem] text-dimmed' : 'text-[0.6875rem] text-dimmed'}>
      {work === 'design'
        ? 'Design'
        : work === 'video'
          ? 'Composition'
          : isFolder
            ? 'Folder'
            : 'File'} · Modified {modifiedAt}
    </div>
  </div>
  <CardButton
    {label}
    title={work ? `${label}: ${entry.name}` : `Open ${entry.name}`}
    variant="secondary"
    size="sm"
    onclick={() => void openEntry()}
  />
</div>
