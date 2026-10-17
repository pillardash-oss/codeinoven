<script lang="ts">
  import CioChat from '$lib/components/icons/cio/CioChat.svelte'
  import type { ActionDefinition, ActionSelection } from '$lib/actions'
  import { invoke } from '$lib/ipc.svelte'
  import { threadPaletteRow } from '$lib/threads/thread-palette-row'
  import { isOrchestrationChildThread, type Thread } from '$shared/types'
  import type { ComposerRelocationMode } from './composer-relocation'

  interface Props {
    open: boolean
    projectId: string
    /** Names the project on every row, so the destination is never in doubt. */
    projectName: string
    /** The chat the content is coming from: never a destination itself. */
    sourceThreadId: string
    /** What the picker completes, e.g. `Relocate doc comment`. */
    title: string
    /** Which verb the search field asks for: a thread to relocate into, or one
     *  to copy into. */
    mode: ComposerRelocationMode
    onSelect: (thread: Thread) => void
    onClose: () => void
  }

  let { open, projectId, projectName, sourceThreadId, title, mode, onSelect, onClose }: Props =
    $props()

  let threads = $state<Thread[]>([])
  let loading = $state(false)
  let requestId = 0

  function isDestination(thread: Thread): boolean {
    return thread.id !== sourceThreadId && !thread.archived && !isOrchestrationChildThread(thread)
  }

  function rowId(threadId: string): ActionDefinition['id'] {
    return `relocate:${threadId}`
  }

  $effect(() => {
    if (!open || !projectId) return
    const request = ++requestId
    loading = true
    void invoke('thread:list', projectId)
      .then((result) => {
        if (request !== requestId) return
        // The list arrives in the project view's own order   pinned first, then
        // the order the sidebar shows   so the picker never re-sorts it.
        threads = result.filter(isDestination)
        loading = false
      })
      .catch(() => {
        if (request !== requestId) return
        threads = []
        loading = false
      })
  })

  const actions = $derived<ActionDefinition[]>(
    threads.map((thread) =>
      threadPaletteRow({
        id: rowId(thread.id),
        thread,
        // One project is being picked from, so every row is named by it.
        container: { label: projectName, icon: CioChat }
      })
    )
  )

  function selectThread(selection: ActionSelection): void {
    const thread = threads.find((candidate) => rowId(candidate.id) === selection.action.id)
    if (thread) onSelect(thread)
  }
</script>

<!-- The picker is a dialog palette, so its module is only needed once it is
     open. Deferring the import keeps this component out of the conversation's
     own chunk: it is reachable from the composer of every project thread. -->
{#if open}
  {#await import('../actions/CommandPalette.svelte') then { default: CommandPalette }}
    <CommandPalette
      {open}
      {title}
      {actions}
      placeholder={`Search threads to ${mode} into…`}
      emptyLabel={loading ? 'Loading threads…' : 'No other threads in this project'}
      headerIcon={CioChat}
      onSelect={selectThread}
      {onClose}
      shortcutLabel="ESC"
    />
  {/await}
{/if}
