<script lang="ts">
  import DesignHistoryActions from './DesignHistoryActions.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import EnumSelect from '$lib/components/ui/EnumSelect.svelte'
  import { onMount } from 'svelte'
  import { GitBranch, History, LoaderCircle, X } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { formatDateTimeCompact } from '$shared/date-time-format'
  import { isThreadBusyStatus } from '$shared/thread-status-policy'
  import type {
    DesignHistoryState,
    DesignPageHistoryState,
    DesignRevisionCause,
    DesignRevisionSummary
  } from '$shared/ipc-contract'

  /**
   * The history half of a design or video board.
   *
   * A design is iterated, and this is the way back: every change the app has seen
   * becomes a point the user can stand on, and Undo and Redo walk the line the way
   * they walk a project's commits. The pane sits under the board so the top half
   * always shows the design as the folder currently is, and a step back redraws it.
   *
   * The pane stays mounted while the board is open, even when it is not on screen,
   * because its job is not only to be looked at: a turn that settles is what turns
   * the agent's iteration into a revision, and a pane mounted only when the user is
   * watching would forget every step taken while their eyes were elsewhere.
   */

  interface Props {
    projectId: string
    threadId: string
    /** Project-relative folder whose history this is. */
    directory: string
    /** The session's noun, for wording only: a design or a composition. */
    noun: string
    /** What a revision counts: a design's screens, a composition's files. */
    unit?: string
    /** Whether the pane is on screen; a closed pane still captures changes. */
    open: boolean
    /** Called after the folder moved, so the board re-pictures the design. */
    onRestored: () => void
    /** Called when the user dismisses the pane. */
    onClose: () => void
    /**
     * The pane's Undo and Redo, handed to the board.
     *
     * The history read lives here, so the two steps do too; the board shows them in
     * its own header. Publishing them keeps one implementation instead of a second
     * history read that could disagree with this one.
     */
    onActions?: (actions: {
      canUndo: boolean
      canRedo: boolean
      undo: () => void
      redo: () => void
    }) => void
  }

  let {
    projectId,
    threadId,
    directory,
    noun,
    unit = 'screen',
    open,
    onRestored,
    onClose,
    onActions
  }: Props = $props()

  /** The session's noun, capitalised, for headings and revision labels. */
  let nounTitle = $derived(noun.charAt(0).toUpperCase() + noun.slice(1))

  let history = $state.raw<DesignHistoryState | null>(null)
  /** Reading the timeline, which includes capturing the present. */
  let loading = $state(false)
  /** The revision being restored, so its own row shows the wait. */
  let restoring = $state('')
  let error = $state('')
  let scope = $state('')
  let page = $state.raw<DesignPageHistoryState | null>(null)
  let pendingRestore = $state('')
  let request = 0
  const scopeOptions = $derived([
    { id: '', label: `Whole ${noun}` },
    ...(history?.files ?? []).map((file) => ({ id: file.path, label: file.name }))
  ])

  let revisions = $derived(
    scope === ''
      ? (history?.revisions ?? [])
      : (page?.revisions ?? []).map((entry): DesignRevisionSummary => ({
          id: entry.revisionId,
          sequence: entry.sequence,
          createdAt: entry.createdAt,
          cause: 'user',
          label: entry.label,
          changedFiles: 1,
          changedPaths: [scope],
          fileCount: entry.present ? 1 : 0,
          totalBytes: 0
        }))
  )
  let cursorIndex = $derived((scope === '' ? history?.cursorIndex : page?.cursorIndex) ?? -1)
  let canUndo = $derived(
    (scope === '' ? history?.canUndo : page?.canUndo) === true && restoring === '' && !loading
  )
  let canRedo = $derived(
    (scope === '' ? history?.canRedo : page?.canRedo) === true && restoring === '' && !loading
  )
  /**
   * The timeline newest first, each row carrying its ascending position.
   *
   * The position is the index in the stored list, not `sequence - 1`: pruning the
   * oldest revisions leaves the sequences starting wherever the survivors begin, so
   * only the index can be compared against the cursor.
   */
  let timeline = $derived(revisions.map((revision, index) => ({ revision, index })).reverse())

  /** What produced a revision, in the user's terms. */
  function causeLabel(revision: DesignRevisionSummary): string {
    if (revision.label) return revision.label
    if (revision.cause === 'initial') return 'First captured'
    if (revision.cause === 'agent') return 'Agent turn'
    return 'Your edit'
  }

  /** A revision's time, short enough for a row and exact enough to tell steps apart. */
  function timeLabel(createdAt: number): string {
    if (createdAt <= 0) return ''
    return formatDateTimeCompact(createdAt)
  }

  /** How much a revision changed, in files. */
  function changeLabel(revision: DesignRevisionSummary): string {
    if (revision.cause === 'initial') {
      return `Initial ${noun}`
    }
    const changed = revision.changedPaths.filter((path) =>
      history?.files.some((screen) => screen.path === path)
    ).length
    if (changed === 0) return `${nounTitle} updated`
    return `${changed} ${unit}${changed === 1 ? '' : 's'} changed`
  }

  /** Read the folder's history, capturing the present as `cause` when it changed. */
  async function load(cause: DesignRevisionCause): Promise<void> {
    if (directory === '') {
      history = null
      return
    }
    const token = ++request
    loading = true
    try {
      const next = await invoke('design:history', projectId, threadId, directory, cause)
      if (token !== request) return
      const nextPage =
        scope === ''
          ? null
          : await invoke('design:historyPage', projectId, threadId, directory, scope)
      if (token !== request) return
      history = next
      page = nextPage
      error = ''
    } catch (failure) {
      // A history that cannot be read must not take the design down with it: the
      // board above still shows the work, and the pane says what happened.
      error = failure instanceof Error ? failure.message : 'The history could not be read.'
    } finally {
      if (token === request) loading = false
    }
  }

  /** Move the folder to a revision, then let the board re-picture it. */
  async function restore(revisionId: string): Promise<void> {
    if (restoring !== '' || directory === '' || revisionId === '') return
    restoring = revisionId
    try {
      if (scope === '') {
        history = await invoke('design:historyRestore', projectId, threadId, directory, revisionId)
      } else {
        const result = await invoke(
          'design:historyRestoreFile',
          projectId,
          threadId,
          directory,
          scope,
          revisionId
        )
        history = result.history
        page = result.page
      }
      error = ''
      onRestored()
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The design could not be moved back.'
    } finally {
      restoring = ''
    }
  }

  function requestRestore(revisionId: string): void {
    if (!revisionId || loading || restoring !== '') return
    const removesPage =
      page?.revisions.find((revision) => revision.revisionId === revisionId)?.present === false
    if (scope === '' || removesPage) pendingRestore = revisionId
    else void restore(revisionId)
  }

  function undo(): void {
    if (scope === '' && history?.modified) {
      requestRestore(revisions[cursorIndex]?.id ?? '')
      return
    }
    if (cursorIndex <= 0) return
    requestRestore(revisions[cursorIndex - 1]?.id ?? '')
  }

  function redo(): void {
    if (cursorIndex < 0 || cursorIndex >= revisions.length - 1) return
    requestRestore(revisions[cursorIndex + 1]?.id ?? '')
  }

  onMount(() => {
    void load('user')
    const unsubscribeThread = subscribe('thread:updated', (thread) => {
      if (thread.id !== threadId || thread.projectId !== projectId) return
      if (isThreadBusyStatus(thread.status)) return
      // The agent settles, so whatever it wrote is a revision now. Reading captures
      // it: the pane never has to guess that a turn touched this folder.
      void load('agent')
    })
    const unsubscribeHistory = subscribe('design:historyChanged', (owner, folder) => {
      if (owner === projectId && folder === directory && restoring === '') void load('agent')
    })
    return () => {
      ++request
      unsubscribeThread()
      unsubscribeHistory()
    }
  })

  // Opening the pane re-reads the folder. Reading captures the present, so a change
  // the pane has not seen (a control edit saved in the video board, or anything
  // else) becomes the newest point the moment the user looks for it, instead of the
  // pane showing a snapshot from when it first mounted.
  let wasOpen = false
  $effect(() => {
    if (open === wasOpen) return
    wasOpen = open
    if (open) void load('user')
  })

  // The board shows the same two steps in its header, so they are published rather
  // than reimplemented against a second history read.
  $effect(() => {
    onActions?.({ canUndo, canRedo, undo, redo })
  })
</script>

<section
  class="flex min-h-0 flex-col border-t border-border {open ? 'h-1/2' : 'hidden'}"
  aria-label={`${noun} history`}
>
  <header class="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
    <History size={12} class="shrink-0 text-accent" />
    <span class="text-[0.6875rem] shrink-0 font-semibold tracking-wide text-dimmed uppercase"
      >History</span
    >
    {#if !history?.gitBacked}
      <EnumSelect
        compact
        class="min-w-0 flex-1"
        options={scopeOptions}
        value={scope}
        placeholder={`${nounTitle} history`}
        ariaLabel="History scope"
        title={`Choose the whole ${noun} or one ${unit}`}
        disabled={loading || restoring !== ''}
        onChange={(value) => {
          scope = value
          void load('user')
        }}
      />
    {:else}<span class="min-w-0 flex-1"></span>{/if}
    {#if loading}
      <LoaderCircle size={11} class="shrink-0 animate-spin text-dimmed" aria-hidden="true" />
    {/if}
    <DesignHistoryActions
      {canUndo}
      {canRedo}
      undoTitle={scope === ''
        ? `Undo the last change to this ${noun}`
        : `Undo the last change to ${history?.files.find((screen) => screen.path === scope)?.name ?? 'this screen'}`}
      redoTitle="Redo the change that was undone"
      onUndo={undo}
      onRedo={redo}
    />
    <button
      type="button"
      class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Close the history"
      aria-label="Close the history"
      onclick={onClose}
    >
      <X size={12} />
    </button>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
    {#if error !== ''}
      <p
        class="mb-1.5 border border-danger/20 bg-danger/10 px-2 py-1 text-[0.6875rem] text-danger"
        role="alert"
      >
        {error}
      </p>
    {/if}

    {#if history?.gitBacked}
      <div class="flex h-full flex-col items-center justify-center gap-1.5 px-3 text-center">
        <GitBranch size={16} class="text-dimmed" />
        <p class="text-[0.6875rem] text-muted">Git already versions this {noun}.</p>
        <p class="text-[0.625rem] text-dimmed">
          This folder lives in your repository, so its history belongs to Git. Use your repository
          to go back.
        </p>
      </div>
    {:else if revisions.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-1.5 px-3 text-center">
        <History size={16} class="text-dimmed" />
        <p class="text-[0.6875rem] text-muted">
          {loading ? 'Reading the history…' : `No history for this ${noun} yet.`}
        </p>
        {#if !loading}
          <p class="text-[0.625rem] text-dimmed">
            Every change is kept here, so you can go back and forward freely.
          </p>
        {/if}
      </div>
    {:else}
      <ul class="flex flex-col gap-0.5">
        {#each timeline as entry (entry.revision.id)}
          {@const revision = entry.revision}
          {@const position = entry.index}
          {@const current = position === cursorIndex && (scope !== '' || !history?.modified)}
          {@const ahead = cursorIndex >= 0 && position > cursorIndex}
          <li>
            <button
              type="button"
              class="flex w-full items-start gap-2 px-2 py-1.5 text-left transition-colors hover:bg-elevated disabled:opacity-60 {current
                ? 'bg-elevated'
                : ''}"
              disabled={restoring !== '' || directory === '' || loading}
              title={current
                ? `This ${noun} is at this point`
                : `Go back to this point in the ${noun}'s history`}
              aria-current={current ? 'true' : undefined}
              onclick={() => requestRestore(revision.id)}
            >
              <span class="mt-0.5 flex w-3 shrink-0 flex-col items-center self-stretch">
                <span
                  class="block h-2 w-2 {current
                    ? 'bg-accent'
                    : ahead
                      ? 'border border-dashed border-dimmed'
                      : 'border border-border bg-app'}"
                  aria-hidden="true"
                ></span>
                <span class="mt-0.5 block w-px flex-1 bg-border" aria-hidden="true"></span>
              </span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span
                    class="truncate text-[0.6875rem] {current
                      ? 'font-semibold text-foreground'
                      : 'text-muted'}"
                  >
                    {revision.label
                      ? revision.label
                      : scope === ''
                        ? causeLabel(revision)
                        : (history?.files.find((screen) => screen.path === scope)?.name ??
                          'Screen')}
                  </span>
                  {#if current}
                    <span
                      class="shrink-0 bg-accent/15 px-1.5 text-[0.5625rem] font-medium text-accent"
                    >
                      Here
                    </span>
                  {/if}
                  {#if restoring === revision.id}
                    <LoaderCircle size={10} class="shrink-0 animate-spin text-accent" />
                  {/if}
                </span>
                <span class="flex items-center gap-1.5 text-[0.625rem] text-dimmed">
                  <span>{timeLabel(revision.createdAt)}</span>
                  <span aria-hidden="true">·</span>
                  <span class="truncate">{changeLabel(revision)}</span>
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<ConfirmDialog
  open={pendingRestore !== ''}
  title={scope === '' ? `Restore this ${noun}?` : 'Remove this screen?'}
  confirmLabel="Restore history point"
  variant="primary"
  onCancel={() => (pendingRestore = '')}
  onConfirm={() => {
    const id = pendingRestore
    pendingRestore = ''
    void restore(id)
  }}
>
  <p>
    {scope === ''
      ? `This replaces the entire ${noun} with the selected history point. Screens absent from that point will be removed.`
      : `The ${history?.files.find((screen) => screen.path === scope)?.name ?? 'selected'} screen did not exist at this history point and will be removed.`}
  </p>
  <p>You can return to its current version through history.</p>
</ConfirmDialog>
