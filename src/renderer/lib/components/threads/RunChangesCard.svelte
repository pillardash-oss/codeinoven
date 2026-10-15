<script lang="ts">
  import { Eye, FileDiff, RotateCcw, RotateCw } from '@lucide/svelte'
  import { fly, slide } from 'svelte/transition'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import HoverDiffPopover from '../files/HoverDiffPopover.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardNotice from '../shared/CardNotice.svelte'
  import { foldSlide, rowArrive } from '../shared/card-motion'
  import type { TurnCheckpointChangeSummary, TurnCheckpointSummary } from '$shared/types'

  interface Props {
    checkpoint: TurnCheckpointSummary
    projectId: string
    threadId: string
    /** Reveals the file's diff on the Changes tab (not opening the file directly). */
    onRevealFile: (path: string) => void
    /** Opens the original file in the file viewer. */
    onOpenFile: (path: string) => void
    onReview: () => void
    onUndo: () => Promise<void>
    onRedo: () => Promise<void>
  }

  let {
    checkpoint,
    projectId,
    threadId,
    onRevealFile,
    onOpenFile,
    onReview,
    onUndo,
    onRedo
  }: Props = $props()

  // The head's fold owns the card's body visibility, so the two are one value.
  let folded = $state(false)
  let showAll = $state(false)
  let undoing = $state(false)
  let redoing = $state(false)
  /** The card's own box, watched so a fold never slides the transcript. */
  let cardRoot = $state<HTMLElement | undefined>(undefined)

  const additionsTotal = $derived(
    checkpoint.changes.reduce((total, change) => total + (change.additions ?? 0), 0)
  )
  const deletionsTotal = $derived(
    checkpoint.changes.reduce((total, change) => total + (change.deletions ?? 0), 0)
  )
  const remainingChanges = $derived(
    checkpoint.changes.filter((change) => !checkpoint.rolledBackPaths?.includes(change.path))
  )
  const visibleChanges = $derived(showAll ? checkpoint.changes : checkpoint.changes.slice(0, 3))
  const hiddenCount = $derived(Math.max(0, checkpoint.changes.length - 3))
  const rolledBack = $derived(
    checkpoint.status === 'rolled_back' ||
      (checkpoint.changes.length > 0 && remainingChanges.length === 0)
  )
  const canUndo = $derived(checkpoint.changes.length > 0 && !rolledBack)
  const canRedo = $derived(checkpoint.changes.length > 0 && rolledBack)
  /** A block above the file list already separates itself from the head. */
  const hasLeadBlock = $derived(
    Boolean(checkpoint.failure) || (checkpoint.skippedFiles?.length ?? 0) > 0
  )
  /** The state the card is honestly in, not a duration it does not track. */
  const chip = $derived(rolledBack ? { text: 'Undone', tone: 'paused' as const } : undefined)
  const title = $derived(
    `Edited ${checkpoint.changes.length} ${checkpoint.changes.length === 1 ? 'file' : 'files'}`
  )

  function statusLabel(kind: TurnCheckpointChangeSummary['kind']): string {
    if (kind === 'created') return 'A'
    if (kind === 'deleted') return 'D'
    return 'M'
  }

  function additions(change: TurnCheckpointChangeSummary): number | null {
    return 'additions' in change && typeof change.additions === 'number' ? change.additions : null
  }

  function deletions(change: TurnCheckpointChangeSummary): number | null {
    return 'deletions' in change && typeof change.deletions === 'number' ? change.deletions : null
  }

  async function undo(): Promise<void> {
    if (undoing || !canUndo) return
    undoing = true
    try {
      await onUndo()
    } finally {
      undoing = false
    }
  }

  async function redo(): Promise<void> {
    if (redoing || !canRedo) return
    redoing = true
    try {
      await onRedo()
    } finally {
      redoing = false
    }
  }

  const undoTitle = $derived(
    rolledBack
      ? canRedo
        ? 'Redo this turn’s file changes'
        : 'This turn did not change any files'
      : canUndo
        ? 'Undo this turn’s file changes'
        : 'This turn did not change any files'
  )

  /**
   * Keep the reader's place across a fold.
   *
   * The transcript turns native scroll anchoring off (`overflow-anchor: none`),
   * so a card that grows or shrinks above the visible part of the conversation
   * would drag everything under the viewport with it. A card that is still in
   * view must not move the page at all, so the offset is only corrected when the
   * card has been scrolled past the top edge.
   */
  function holdReadingPosition(delta: number): void {
    const card = cardRoot
    const scroller = card?.closest<HTMLElement>('.conversation-scroll')
    if (!card || !scroller || delta === 0) return
    if (card.getBoundingClientRect().top >= scroller.getBoundingClientRect().top) return
    scroller.scrollTop += delta
  }

  // Height changes run through the fold transition, one frame at a time, so the
  // correction follows the animation instead of landing after it.
  $effect(() => {
    const card = cardRoot
    if (!card) return
    let lastHeight = card.offsetHeight
    const observer = new ResizeObserver(() => {
      const height = card.offsetHeight
      holdReadingPosition(height - lastHeight)
      lastHeight = height
    })
    observer.observe(card)
    return () => observer.disconnect()
  })
</script>

<!-- The turn's checkpoint: what the turn touched, what it cost in lines, and the
two things a reader does with it. Square, in the same head/body/foot language as
the composer cards, with both actions quiet in the head: undoing is the frequent
one and reviewing is optional, so neither is dressed as the card's main call. -->
<div bind:this={cardRoot} class="min-w-0">
  <CardFrame placement="top" label="Edited files">
    <CardHead {title} icon={FileDiff} {chip} foldLabel="changed files" bind:folded>
      {#snippet meta()}
        <span class="flex shrink-0 gap-1.5 text-xs font-medium tabular-nums">
          <span class="text-success">+{additionsTotal}</span>
          <span class="text-danger">−{deletionsTotal}</span>
          {#if checkpoint.changes.some((change) => change.lineCountsTruncated)}
            <span class="font-normal text-dimmed">partial count</span>
          {/if}
        </span>
      {/snippet}
      {#snippet controls()}
        {#if rolledBack}
          <CardButton
            label={redoing ? 'Redoing…' : 'Redo'}
            title={undoTitle}
            icon={RotateCw}
            variant="ghost-text"
            loading={redoing}
            disabled={undoing || redoing || !canRedo}
            onclick={() => void redo()}
          />
        {:else}
          <CardButton
            label={undoing ? 'Undoing…' : 'Undo'}
            title={undoTitle}
            icon={RotateCcw}
            variant="ghost-text"
            loading={undoing}
            disabled={undoing || redoing || !canUndo}
            onclick={() => void undo()}
          />
        {/if}
        <CardButton
          label="Review"
          title="Review all changes from this turn"
          variant="ghost"
          onclick={onReview}
        />
      {/snippet}
    </CardHead>

    {#if !folded}
      <div transition:slide={foldSlide()}>
        {#if checkpoint.failure}
          <div class="px-3 py-2.5">
            <CardNotice
              tone={checkpoint.stopReason === 'app-closed' ? 'default' : 'danger'}
              class="text-[0.6875rem]"
            >
              {checkpoint.failure}
            </CardNotice>
          </div>
        {/if}

        {#if checkpoint.skippedFiles && checkpoint.skippedFiles.length > 0}
          <p
            class="px-3 py-2.5 text-[0.6875rem] leading-relaxed text-dimmed"
            title={checkpoint.skippedFiles.join('\n')}
          >
            {checkpoint.skippedFiles.length}
            {checkpoint.skippedFiles.length === 1 ? 'file is' : 'files are'} too large to checkpoint,
            so changes to {checkpoint.skippedFiles.length === 1 ? 'it' : 'them'} cannot be undone.
          </p>
        {/if}

        {#if checkpoint.changes.length === 0}
          <p class="px-3 py-2.5 text-[0.6875rem] text-dimmed">No file changes detected.</p>
        {:else}
          <div class={hasLeadBlock ? 'border-t border-border' : ''}>
            {#each visibleChanges as change (`${change.kind}:${change.path}`)}
              {@const added = additions(change)}
              {@const removed = deletions(change)}
              {@const changeRolledBack = checkpoint.rolledBackPaths?.includes(change.path)}
              <!-- A row arrives where it belongs and moves nothing else: the row
                 animates transform and opacity only, so expanding the list never
                 steps on the fold's scroll compensation above. -->
              <div
                class="group flex min-h-9 w-full items-center gap-1 border-b border-border px-3 transition-colors last:border-b-0 hover:bg-elevated"
                in:fly={rowArrive()}
              >
                <HoverDiffPopover
                  {projectId}
                  {threadId}
                  checkpointId={checkpoint.id}
                  path={change.path}
                  class="min-w-0 flex-1"
                  maxHeight="18rem"
                >
                  {#snippet trigger()}
                    <button
                      type="button"
                      class="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-left font-mono text-[0.6875rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                      title={`Reveal ${change.path} on the Changes tab`}
                      onclick={() => onRevealFile(change.path)}
                    >
                      <span
                        class="w-3 shrink-0 text-center font-semibold text-warning"
                        class:text-success={change.kind === 'created'}
                        class:text-danger={change.kind === 'deleted'}
                      >
                        {statusLabel(change.kind)}
                      </span>
                      <FileTypeIcon path={change.path} size={14} />
                      <span
                        class="min-w-0 flex-1 truncate text-muted"
                        class:line-through={changeRolledBack}
                      >
                        {change.path}
                      </span>
                      {#if changeRolledBack}
                        <span class="shrink-0 font-sans text-[0.5625rem] text-dimmed">restored</span
                        >
                      {:else if change.binary}
                        <span class="shrink-0 font-sans text-[0.5625rem] text-dimmed">binary</span>
                      {:else if added !== null || removed !== null}
                        <span class="flex shrink-0 gap-1 tabular-nums">
                          <span class="text-success">+{added ?? 0}</span>
                          <span class="text-danger">−{removed ?? 0}</span>
                        </span>
                      {/if}
                    </button>
                  {/snippet}
                </HoverDiffPopover>
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  aria-label={`Open ${change.path} in the file viewer`}
                  title={`Open ${change.path} in the file viewer`}
                  onclick={() => onOpenFile(change.path)}
                >
                  <Eye size={13} />
                </button>
              </div>
            {/each}
          </div>

          {#if hiddenCount > 0}
            <button
              type="button"
              class="flex min-h-9 w-full items-center gap-1 border-t border-border px-3 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
              aria-expanded={showAll}
              onclick={() => (showAll = !showAll)}
            >
              {#if showAll}
                Show fewer
              {:else}
                +{hiddenCount} more {hiddenCount === 1 ? 'file' : 'files'}
              {/if}
            </button>
          {/if}
        {/if}
      </div>
    {/if}
  </CardFrame>
</div>
