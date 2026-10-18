<script lang="ts">
  import CioChat from '@codeio/icon/CioChat.svelte'
  import type { ActionDefinition, ActionSelection } from '$lib/actions'
  import { invoke } from '$lib/ipc.svelte'
  import { logRendererDev, logRendererError } from '$lib/system/renderer-logger'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { threadPaletteRow } from '$lib/threads/thread-palette-row'
  import { isOrchestrationChildThread, type Thread } from '$shared/types'
  import {
    attachmentCarryBlockedReason,
    type ComposerRelocationItem,
    type ComposerRelocationMode
  } from './composer-relocation'

  interface Props {
    projectId: string
    /** Names the project on every row, so the destination is never in doubt. */
    projectName: string
    /** The chat the content is coming from: never a destination itself. */
    sourceThreadId: string
    /** What is being carried: a file has a ceiling a row has to be able to report. */
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
   * Only a file can be refused: a message carries a bounded number of files, and
   * making room by dropping one of the destination's own is not this feature's
   * business. A chat whose draft this window has not read answers null, and the
   * carry itself refuses with the same sentence.
   */
  function blockedReason(thread: Thread): string | null {
    if (item.kind !== 'attachment') return null
    return attachmentCarryBlockedReason({
      attachment: item.attachment,
      existingAttachments: rendererRecovery.attachmentsFor(thread.projectId, thread.id)
    })
  }

  /**
   * The project's chats, in the order the project view shows them.
   *
   * Nothing narrows them beyond the exclusions above, and every other chat of the
   * project is a destination: an annotation always fits, and a file only fails a
   * row that says so.
   */
  $effect(() => {
    const request = ++requestId
    logRendererDev(`[relocation] picker mounted for ${projectId} from ${sourceThreadId}`)
    loading = true
    void invoke('thread:list', projectId)
      .then((result) => {
        if (request !== requestId) return
        // The list arrives in the project view's own order   pinned first, then
        // the order the sidebar shows   so the picker never re-sorts it.
        threads = result.filter(isDestination)
        logRendererDev(`[relocation] picker listed ${threads.length} destinations`)
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
    logRendererDev(
      `[relocation] picker selected ${thread?.id ?? 'nothing'} (${selection.action.id})`
    )
    if (thread) onSelect(thread)
  }
</script>

<!-- The picker is a dialog palette, so its module is only needed once the user
     asks for it: this component is mounted for one carry and unmounted with it,
     which keeps CommandPalette out of the conversation's own chunk.

     `closeOnSelect` stays off, as every other host of this palette has it: a
     palette that owns the close closes *before* it reports the pick, and that
     close clears the state the host opened it with. This picker is closed by the
     carry itself, which is the same moment the request is consumed. -->
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
    closeOnSelect={false}
  />
{:catch importError}
  <!-- A picker that cannot load must say so rather than look like a click that
       did nothing. -->
  {logRendererError('The chat picker could not be opened', importError)}
{/await}
