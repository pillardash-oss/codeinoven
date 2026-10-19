<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import type { TurnCheckpointFileDiff } from '$shared/types'
  import { FileDiffState } from './file-diff-state.svelte'
  import DiffRows from './DiffRows.svelte'
  import {
    DEFAULT_CONTEXT_LINES,
    type DiffDetails,
    type DiffHunk,
    type DiffLine
  } from './file-diff'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'

  interface Props {
    diff: TurnCheckpointFileDiff
    /** Reuse worker results supplied by the owning panel. */
    preparedDetails?: DiffDetails | null
    /** Caps the height of the scrollable diff area (e.g. "24rem"). */
    maxHeight?: string
  }

  let { diff, preparedDetails = null, maxHeight = undefined }: Props = $props()
  const computation = new FileDiffState(() =>
    diff.binary || preparedDetails
      ? null
      : {
          before: diff.before,
          after: diff.after,
          beforeStartLine: diff.beforeStartLine,
          afterStartLine: diff.afterStartLine
        }
  )
  const emptyDetails: DiffDetails = { lines: [], hunks: [], additions: 0, deletions: 0 }
  let details = $derived(preparedDetails ?? computation.details ?? emptyDetails)
  let maxDiffLines = $derived(Math.min(appConfigState.maxDiffLines, 400))
  let hunkPage = $state(0)
  const HUNKS_PER_PAGE = 3
  let pageStart = $derived(
    Math.min(hunkPage, Math.max(0, Math.ceil(details.hunks.length / HUNKS_PER_PAGE) - 1)) *
      HUNKS_PER_PAGE
  )
  let visibleHunks = $derived(details.hunks.slice(pageStart, pageStart + HUNKS_PER_PAGE))

  const REVEAL_STEP = 10

  interface RevealState {
    above: number
    below: number
  }

  let reveal = $state<Record<string, RevealState>>({})
  /** Folds a single hunk (its changed block), not the whole file. */
  let foldedHunks = $state<Record<string, boolean>>({})

  interface HunkWindow {
    lines: DiffLine[]
    aboveHidden: number
    belowHidden: number
    beforeStart: number
    beforeCount: number
    afterStart: number
    afterCount: number
  }

  function hunkWindow(hunk: DiffHunk): HunkWindow {
    const state = reveal[hunk.id] ?? { above: 0, below: 0 }
    const above = Math.min(DEFAULT_CONTEXT_LINES + state.above, hunk.contextBefore, 100)
    const below = Math.min(DEFAULT_CONTEXT_LINES + state.below, hunk.contextAfter, 100)
    const start = hunk.changeStart - above
    const end = hunk.changeEnd + below
    const lines =
      hunk.changeEnd - hunk.changeStart + 1 > maxDiffLines
        ? []
        : details.lines.slice(start, end + 1)
    const beforeLines = lines.flatMap((line) =>
      line.beforeLine === undefined ? [] : [line.beforeLine]
    )
    const afterLines = lines.flatMap((line) =>
      line.afterLine === undefined ? [] : [line.afterLine]
    )
    return {
      lines,
      aboveHidden: hunk.contextBefore - above,
      belowHidden: hunk.contextAfter - below,
      beforeStart: beforeLines[0] ?? 0,
      beforeCount: beforeLines.length,
      afterStart: afterLines[0] ?? 0,
      afterCount: afterLines.length
    }
  }

  function expand(hunk: DiffHunk, direction: 'above' | 'below'): void {
    const state = reveal[hunk.id] ?? { above: 0, below: 0 }
    const amount = state[direction] + REVEAL_STEP
    const next = { ...state }
    if (direction === 'above') next.above = amount
    else next.below = amount
    reveal = { ...reveal, [hunk.id]: next }
  }

  function toggleHunkFold(hunkId: string): void {
    foldedHunks = { ...foldedHunks, [hunkId]: !(foldedHunks[hunkId] ?? false) }
  }
</script>

{#snippet foldBar(
  hunk: DiffHunk,
  additions: number,
  deletions: number,
  hidden: number,
  direction: 'above' | 'below'
)}
  {@const isFolded = foldedHunks[hunk.id] ?? false}
  <div
    role="button"
    tabindex="0"
    aria-expanded={!isFolded}
    title={isFolded ? 'Show this hunk' : 'Fold this hunk'}
    class="flex h-8 cursor-pointer items-center gap-2 bg-elevated px-3 text-[0.625rem]"
    onclick={() => toggleHunkFold(hunk.id)}
    onkeydown={(e: KeyboardEvent) => {
      if (keymapState.matches('ui-activate', e)) {
        e.preventDefault()
        toggleHunkFold(hunk.id)
      }
    }}
  >
    <span class="shrink-0 font-mono tabular-nums text-success">+{additions}</span>
    <span class="shrink-0 font-mono tabular-nums text-danger">−{deletions}</span>
    <span class="flex-1"></span>
    {#if !isFolded && hidden > 0 && (reveal[hunk.id]?.[direction] ?? 0) + DEFAULT_CONTEXT_LINES < 100}
      <button
        type="button"
        class="shrink-0 px-1.5 py-0.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground"
        title={`Reveal ${Math.min(REVEAL_STEP, hidden)} more ${direction === 'above' ? 'lines above' : 'lines below'}`}
        onclick={(e: MouseEvent) => {
          e.stopPropagation()
          expand(hunk, direction)
        }}
      >
        Show {Math.min(REVEAL_STEP, hidden)} more {direction}
      </button>
    {/if}
    {#if isFolded}
      <CioForward size={12} class="shrink-0 text-dimmed" />
    {:else}
      <CioChevronDown size={12} class="shrink-0 text-dimmed" />
    {/if}
  </div>
{/snippet}

{#if diff.binary}
  <div class="flex h-full items-center justify-center px-6 text-center">
    <p class="text-xs text-dimmed">Binary file · content preview unavailable.</p>
  </div>
{:else}
  <div
    class="flex h-full min-h-0 min-w-0 flex-col bg-app"
    style={maxHeight ? `max-height:${maxHeight}` : undefined}
  >
    <div
      class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto py-1 font-mono text-[0.6875rem] leading-5"
    >
      {#if !preparedDetails && computation.error}
        <p class="px-3 py-4 text-center text-muted" role="note">{computation.error}</p>
      {:else if !preparedDetails && !computation.details}
        <p class="px-3 py-4 text-center text-dimmed" role="status">Computing diff…</p>
      {:else if details.hunks.length === 0}
        <p class="px-3 py-4 text-center text-dimmed">No textual changes.</p>
      {:else}
        {#each visibleHunks as hunk (hunk.id)}
          {@const w = hunkWindow(hunk)}
          {@const hunkAdditions = hunk.additions}
          {@const hunkDeletions = hunk.deletions}
          {@const hunkChanged = hunkAdditions + hunkDeletions}
          {@const isFolded = foldedHunks[hunk.id] ?? false}
          {@const limitExceeded = hunkChanged > maxDiffLines}
          <section class="not-first:mt-1 border-y border-border first:border-t-0">
            {@render foldBar(hunk, hunkAdditions, hunkDeletions, w.aboveHidden, 'above')}
            {#if !isFolded}
              {#if limitExceeded}
                <div
                  class="px-3 py-3 text-center font-sans text-[0.6875rem] text-muted"
                  role="note"
                >
                  Maximum diff exceeded this hunk changes {hunkChanged} lines (limit {maxDiffLines}).
                  The lines are hidden to keep the diff responsive.
                </div>
              {:else}
                <DiffRows lines={w.lines} paneLabels />
                {#if w.belowHidden > 0}
                  {@render foldBar(hunk, hunkAdditions, hunkDeletions, w.belowHidden, 'below')}
                {/if}
              {/if}
            {/if}
          </section>
        {/each}
        {#if details.hunks.length > HUNKS_PER_PAGE}
          <div class="flex items-center justify-end gap-2 px-3 py-2 font-sans text-xs">
            <span
              >{pageStart + 1}–{Math.min(pageStart + HUNKS_PER_PAGE, details.hunks.length)} of {details
                .hunks.length} hunks</span
            >
            <button
              type="button"
              class="px-2 py-1 hover:bg-elevated disabled:opacity-40"
              disabled={pageStart === 0}
              onclick={() => (hunkPage -= 1)}>Previous hunks</button
            >
            <button
              type="button"
              class="px-2 py-1 hover:bg-elevated disabled:opacity-40"
              disabled={pageStart + HUNKS_PER_PAGE >= details.hunks.length}
              onclick={() => (hunkPage += 1)}>Next hunks</button
            >
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
