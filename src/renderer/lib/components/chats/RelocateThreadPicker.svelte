<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import CioChat from '@pdslng/cio-icon/CioChat.svelte'
  import type { ActionDefinition, ActionSelection } from '$lib/actions'
  import { invoke } from '$lib/ipc.svelte'
  import { logRendererDev, logRendererError } from '$lib/system/renderer-logger'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { orderedBuckets } from '$lib/stores/scope-board'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { threadPaletteRow } from '$lib/threads/thread-palette-row'
  import { isOrchestrationChildThread, type Thread } from '$shared/types'
  import {
    attachmentCarryBlockedReason,
    type ComposerRelocationItem,
    type ComposerRelocationMode
  } from './composer-relocation'
  import { orderRelocationDestinations } from './relocation-destinations'

  interface Props {
    projectId: string
    /** Names the project on every row, so the destination is never in doubt. */
    projectName: string
    /**
     * Assistant whose tasks are the destinations, for a carry inside Assistant
     * View. Every task of one assistant reads the same `assistant-cwd/<id>`
     * workspace, so a file, a doc comment or an inspector comment means the same
     * thing in all of them; another assistant's tasks read a different
     * directory, so they are never offered.
     */
    assistantId?: string
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

  let {
    projectId,
    projectName,
    assistantId,
    sourceThreadId,
    item,
    mode,
    title,
    onSelect,
    onClose
  }: Props = $props()

  /** The project's rows as the database reported them on mount. */
  let listedThreads = $state<Thread[]>([])
  let loading = $state(false)
  let requestId = 0

  function isDestination(thread: Thread): boolean {
    if (thread.id === sourceThreadId || thread.archived || isOrchestrationChildThread(thread)) {
      return false
    }
    if (assistantId === undefined) return true
    // Assistant scope: the assistant's own tasks. A run is one execution of a
    // task rather than a place the user writes, so it is never a destination.
    return thread.assistantId === assistantId && thread.assistantTaskId === undefined
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

  const projectBuckets = $derived.by(() => {
    const board = scopeState.boards.get(projectId)
    return board ? orderedBuckets(board) : []
  })

  /**
   * The scope the sidebar is showing, which leads the destination list.
   *
   * A picker is one flat list and the sidebar draws one scope at a time, so the
   * scope the user can see has to be named explicitly: without it the rows a
   * project keeps in its first scope   last week's work   filled the top of the
   * picker however recent the threads in the scope on screen were. When no
   * sidebar context belongs to this project, the source chat's own scope is the
   * closest stand-in, because that is the work being carried away from.
   */
  const currentBucketId = $derived.by((): string | null => {
    const context = scopeState.sidebarContext
    if (context?.projectId === projectId) return context.bucketId
    const source = scopeState.allScopeThreads.find(
      (thread) => thread.id === sourceThreadId && thread.projectId === projectId
    )
    return source ? scopeState.bucketForThread(source) : null
  })

  /**
   * The project's chats, in the order the project view shows them.
   *
   * Nothing narrows them beyond the exclusions above, and every other chat of the
   * project is a destination: an annotation always fits, and a file only fails a
   * row that says so.
   *
   * The rows are the ones the sidebar draws, not a second reading of the database:
   * this window's live thread memory wins over the row the query returned, and the
   * sidebar's own staging decides the order. That is what keeps a chat holding
   * unsent composer text in the Todo slice the sidebar lifted it to, instead of
   * leaving it at the bottom where its last activity put it.
   */
  const destinations = $derived.by((): Thread[] => {
    // This window's snapshot wins for a row it holds: that is the row the sidebar
    // draws, carrying the draft state committed here rather than the delay of a
    // database read.
    const live = scopeState.allScopeThreads.filter((thread) => thread.projectId === projectId)
    const liveIds = new SvelteSet(live.map((thread) => thread.id))
    const rows = [...live, ...listedThreads.filter((thread) => !liveIds.has(thread.id))]
    return orderRelocationDestinations(rows.filter(isDestination), {
      buckets: projectBuckets,
      currentBucketId,
      sliceFor: (thread) => ({
        bucketId: scopeState.bucketForThread(thread),
        stage: scopeState.stageForThread(thread)
      })
    })
  })

  /**
   * Load the project's chats once, then let the live thread memory keep the list
   * current.
   *
   * Deliberately not reactive: the destination list reads the memory this window
   * already holds, so re-asking the database on every draft or status change
   * would be one round trip per keystroke elsewhere in the app.
   */
  $effect(() => {
    const request = ++requestId
    logRendererDev(
      `[relocation] picker mounted for ${projectId}${assistantId ? ` (assistant ${assistantId})` : ''} from ${sourceThreadId}`
    )
    loading = true
    void invoke('thread:list', projectId)
      .then((result) => {
        if (request !== requestId) return
        listedThreads = result
        loading = false
        logRendererDev(
          `[relocation] picker listed ${destinations.length} destinations of ${result.length} rows`
        )
      })
      .catch(() => {
        if (request !== requestId) return
        listedThreads = []
        loading = false
      })
  })

  // One mount, one carry: a project's scope board is cached for whichever project
  // the user activated last, so the scopes the order is read from are warmed here
  // rather than inside the effect above, which never asks the database twice.
  onMount(() => {
    void scopeState.ensureBoardLoaded(projectId).catch(() => undefined)
    void scopeState.ensureProjectThreadsLoaded(projectId).catch(() => undefined)
  })

  const actions = $derived<ActionDefinition[]>(
    destinations.map((thread) => {
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
    const thread = destinations.find((candidate) => rowId(candidate.id) === selection.action.id)
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
<!-- The destination list is the sidebar's own: every chat is reachable without
     typing, because the palette's default bound draws sixty rows and a project's
     older chats   the one holding an unsent draft among them   are exactly what
     fell past it. -->
{#await import('../actions/CommandPalette.svelte') then { default: CommandPalette }}
  <CommandPalette
    open
    {title}
    {actions}
    maxResults={Math.max(actions.length, 1)}
    placeholder={`Search threads to ${mode} into…`}
    emptyLabel={loading
      ? 'Loading threads…'
      : assistantId
        ? 'No other tasks in this assistant'
        : 'No other threads in this project'}
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
