<script lang="ts">
  import CioChat from '$lib/components/icons/cio/CioChat.svelte'
  import type { ActionDefinition, ActionSelection } from '$lib/actions'
  import { invoke } from '$lib/ipc.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { threadPaletteRow } from '$lib/threads/thread-palette-row'
  import { isOrchestrationChildThread, type Thread } from '$shared/types'
  import {
    carryBlockedReason,
    type ComposerRelocationItem,
    type ComposerRelocationMode
  } from './composer-relocation'

  interface Props {
    projectId: string
    /** Names the project on every row, so the destination is never in doubt. */
    projectName: string
    /** The chat the content is coming from: never a destination itself. */
    sourceThreadId: string
    /** What is being carried, so a row can say when it cannot take it. */
    item: ComposerRelocationItem
    /** Which verb the search field asks for: a thread to relocate into, or one
     *  to copy into. */
    mode: ComposerRelocationMode
    /** What the picker completes, e.g. `Relocate doc comment`. */
    title: string
    onSelect: (thread: Thread) => void
    onClose: () => void
  }

  let { projectId, projectName, sourceThreadId, item, mode, title, onSelect, onClose }: Props =
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

  /**
   * Why this destination cannot take the carry, or null when it can.
   *
   * A composer holds a bounded number of references and a carry never takes the
   * place of what the destination holds, so a chat that cannot fit it says so on
   * its own row instead of the carry being refused after it was picked. A chat
   * whose draft this window has not read answers null: the carry itself is the
   * authority, and it refuses with the same sentence.
   */
  function blockedReason(thread: Thread): string | null {
    return carryBlockedReason({
      item,
      existingReferences: rendererRecovery.draftPromptReferences(thread.projectId, thread.id)
    })
  }

  $effect(() => {
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
    threads.map((thread) => {
      const blocked = blockedReason(thread)
      return {
        ...threadPaletteRow({
          id: rowId(thread.id),
          thread,
          // One project is being picked from, so every row is named by it.
          container: { label: projectName, icon: CioChat }
        }),
        ...(blocked ? { disabledReason: blocked } : {})
      }
    })
  )

  function selectThread(selection: ActionSelection): void {
    const thread = threads.find((candidate) => rowId(candidate.id) === selection.action.id)
    if (thread) onSelect(thread)
  }
</script>

<!-- The picker is a dialog palette, so its module is only needed once the user
     asks for it: this component is mounted for one carry and unmounted with it,
     which keeps CommandPalette out of the conversation's own chunk. -->
{#await import('../actions/CommandPalette.svelte') then { default: CommandPalette }}
  <CommandPalette
    open
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
