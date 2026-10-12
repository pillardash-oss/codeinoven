<script lang="ts">
  import { onMount } from 'svelte'
  import { GitBranch, History, LoaderCircle, Redo2, Undo2, X } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { isThreadBusyStatus } from '$shared/thread-status-policy'
  import type {
    DesignHistoryState,
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
    /** Whether the pane is on screen; a closed pane still captures changes. */
    open: boolean
    /** Called after the folder moved, so the board re-pictures the design. */
    onRestored: () => void
    /** Called when the user dismisses the pane. */
    onClose: () => void
  }

  let { projectId, threadId, directory, noun, open, onRestored, onClose }: Props = $props()

  let history = $state<DesignHistoryState | null>(null)
  /** Reading the timeline, which includes capturing the present. */
  let loading = $state(false)
  /** The revision being restored, so its own row shows the wait. */
  let restoring = $state('')
  let error = $state('')

  let revisions = $derived(history?.revisions ?? [])
  let cursorIndex = $derived(history?.cursorIndex ?? -1)
  let canUndo = $derived(history?.canUndo === true && restoring === '')
  let canRedo = $derived(history?.canRedo === true && restoring === '')
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
    if (revision.cause === 'initial') return 'First captured'
    if (revision.cause === 'agent') return 'Agent turn'
    return 'Your edit'
  }

  /** A revision's time, short enough for a row and exact enough to tell steps apart. */
  function timeLabel(createdAt: number): string {
    if (createdAt <= 0) return ''
    return new Date(createdAt).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  /** How much a revision changed, in files. */
  function changeLabel(revision: DesignRevisionSummary): string {
    if (revision.cause === 'initial') {
      return `${revision.fileCount} file${revision.fileCount === 1 ? '' : 's'}`
    }
    const changed = revision.changedFiles
    if (changed === 0) return 'No file changed'
    return `${changed} file${changed === 1 ? '' : 's'} changed`
  }

  /** Read the folder's history, capturing the present as `cause` when it changed. */
  async function load(cause: DesignRevisionCause): Promise<void> {
    if (directory === '') {
      history = null
      return
    }
    loading = true
    try {
      history = await invoke('design:history', projectId, threadId, directory, cause)
      error = ''
    } catch (failure) {
      // A history that cannot be read must not take the design down with it: the
      // board above still shows the work, and the pane says what happened.
      error = failure instanceof Error ? failure.message : 'The history could not be read.'
    } finally {
      loading = false
    }
  }

  /** Move the folder to a revision, then let the board re-picture it. */
  async function restore(revisionId: string): Promise<void> {
    if (restoring !== '' || directory === '' || revisionId === '') return
    restoring = revisionId
    try {
      history = await invoke('design:historyRestore', projectId, threadId, directory, revisionId)
      error = ''
      onRestored()
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The design could not be moved back.'
    } finally {
      restoring = ''
    }
  }

  function undo(): void {
    if (cursorIndex <= 0) return
    void restore(revisions[cursorIndex - 1]?.id ?? '')
  }

  function redo(): void {
    if (cursorIndex < 0 || cursorIndex >= revisions.length - 1) return
    void restore(revisions[cursorIndex + 1]?.id ?? '')
  }

  $effect(() => {
    // A different folder is a different history: read it as the user's own view,
    // never as an agent step the previous folder's turn happened to announce. The
    // call reads `directory` before its first await, so this re-runs on a switch.
    void load('user')
  })

  onMount(() =>
    subscribe('thread:updated', (thread) => {
      if (thread.id !== threadId || thread.projectId !== projectId) return
      if (isThreadBusyStatus(thread.status)) return
      // The agent settles, so whatever it wrote is a revision now. Reading captures
      // it: the pane never has to guess that a turn touched this folder.
      void load('agent')
    })
  )
</script>

<section
  class="flex min-h-0 flex-col border-t border-border {open ? 'h-1/2' : 'hidden'}"
  aria-label={`${noun} history`}
>
  <header class="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
    <History size={12} class="shrink-0 text-accent" />
    <span class="text-[0.6875rem] font-semibold text-foreground">History</span>
    {#if !history?.gitBacked && revisions.length > 0}
      <span
        class="shrink-0 rounded-full bg-elevated px-1.5 text-[0.625rem] tabular-nums text-muted"
      >
        {cursorIndex >= 0 ? `${cursorIndex + 1}/${revisions.length}` : revisions.length}
      </span>
    {/if}
    <span class="min-w-0 flex-1"></span>
    {#if loading}
      <LoaderCircle size={11} class="shrink-0 animate-spin text-dimmed" aria-hidden="true" />
    {/if}
    <button
      type="button"
      class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
      disabled={!canUndo}
      title="Undo the last change to this {noun}"
      aria-label="Undo the last change to this {noun}"
      onclick={undo}
    >
      <Undo2 size={12} />
    </button>
    <button
      type="button"
      class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
      disabled={!canRedo}
      title="Redo the change that was undone"
      aria-label="Redo the change that was undone"
      onclick={redo}
    >
      <Redo2 size={12} />
    </button>
    <button
      type="button"
      class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
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
        class="mb-1.5 rounded-md border border-danger/20 bg-danger/10 px-2 py-1 text-[0.6875rem] text-danger"
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
          {@const current = revision.id === history?.cursorId}
          {@const ahead = cursorIndex >= 0 && position > cursorIndex}
          <li>
            <button
              type="button"
              class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-elevated disabled:opacity-60 {current
                ? 'bg-elevated'
                : ''}"
              disabled={restoring !== '' || directory === ''}
              title={current
                ? `This ${noun} is at this point`
                : `Go back to this point in the ${noun}'s history`}
              aria-current={current ? 'true' : undefined}
              onclick={() => void restore(revision.id)}
            >
              <span class="mt-0.5 flex w-3 shrink-0 flex-col items-center self-stretch">
                <span
                  class="block h-2 w-2 rounded-full {current
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
                    {causeLabel(revision)}
                  </span>
                  {#if current}
                    <span
                      class="shrink-0 rounded-full bg-accent/15 px-1.5 text-[0.5625rem] font-medium text-accent"
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
