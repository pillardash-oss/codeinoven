<script lang="ts">
  import type { TurnCheckpointFileDiff } from '$shared/types'
  import { diffLayoutState } from '$lib/stores/diff-layout.svelte'
  import {
    DEFAULT_CONTEXT_LINES,
    diffDetails,
    splitRows,
    type DiffHunk,
    type DiffLine
  } from './file-diff'

  interface Props {
    diff: TurnCheckpointFileDiff
    /** Caps the height of the scrollable diff area (e.g. "24rem"). */
    maxHeight?: string
  }

  let { diff, maxHeight = undefined }: Props = $props()
  let details = $derived(diffDetails(diff.before, diff.after))

  const REVEAL_STEP = 10

  interface RevealState {
    above: number
    below: number
  }

  let reveal = $state<Record<string, RevealState>>({})

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
    const above = Math.min(DEFAULT_CONTEXT_LINES + state.above, hunk.contextBefore)
    const below = Math.min(DEFAULT_CONTEXT_LINES + state.below, hunk.contextAfter)
    const start = hunk.changeStart - above
    const end = hunk.changeEnd + below
    const lines = details.lines.slice(start, end + 1)
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
</script>

{#snippet contextExpander(hunk: DiffHunk, direction: 'above' | 'below', hidden: number)}
  <div class="flex items-center gap-2 border-y border-border bg-elevated px-3 py-1">
    <span class="text-[9px] tabular-nums text-dimmed">
      {hidden} hidden {direction === 'above' ? 'above' : 'below'}
    </span>
    <button
      type="button"
      class="rounded px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground"
      title={`Reveal ${Math.min(REVEAL_STEP, hidden)} more ${direction === 'above' ? 'lines above' : 'lines below'}`}
      onclick={() => expand(hunk, direction)}
    >
      Show {Math.min(REVEAL_STEP, hidden)} more
    </button>
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
    <div class="min-h-0 min-w-0 flex-1 overflow-auto py-1 font-mono text-[11px] leading-5">
      {#if details.hunks.length === 0}
        <p class="px-3 py-4 text-center text-dimmed">No textual changes.</p>
      {:else}
        {#each details.hunks as hunk (hunk.id)}
          {@const w = hunkWindow(hunk)}
          <section class="not-first:mt-1 border-y border-border first:border-t-0">
            {#if w.aboveHidden > 0}
              {@render contextExpander(hunk, 'above', w.aboveHidden)}
            {/if}
            <div class="flex items-center gap-2 bg-elevated px-3 py-0.5 text-[10px] text-info">
              <span>@@ -{w.beforeStart},{w.beforeCount} +{w.afterStart},{w.afterCount} @@</span>
              {#if diffLayoutState.layout === 'horizontal'}
                <span class="ml-auto flex items-center gap-3 text-dimmed">
                  <span>Before</span>
                  <span>After</span>
                </span>
              {/if}
            </div>
            {#if diffLayoutState.layout === 'horizontal'}
              {#each splitRows(w.lines) as row, index (`${row.before?.kind ?? 'none'}:${row.before?.beforeLine ?? 0}:${row.after?.afterLine ?? 0}:${index}`)}
                <div class="grid min-w-max grid-cols-[3rem_minmax(0,1fr)_3rem_minmax(0,1fr)] px-2">
                  <span
                    class={[
                      'select-none pr-2 text-right text-dimmed',
                      row.before?.kind === 'deleted' ? 'bg-danger/10 text-danger' : ''
                    ]}
                  >
                    {row.before?.beforeLine ?? ''}
                  </span>
                  <span
                    class={[
                      'whitespace-pre pr-2',
                      row.before?.kind === 'deleted'
                        ? 'bg-danger/10 text-foreground'
                        : row.before?.kind === 'context'
                          ? 'text-muted'
                          : ''
                    ]}
                  >
                    {row.before ? row.before.text || ' ' : ''}
                  </span>
                  <span
                    class={[
                      'select-none border-l border-border pr-2 text-right text-dimmed',
                      row.after?.kind === 'added' ? 'bg-success/10 text-success' : ''
                    ]}
                  >
                    {row.after?.afterLine ?? ''}
                  </span>
                  <span
                    class={[
                      'whitespace-pre pr-4',
                      row.after?.kind === 'added'
                        ? 'bg-success/10 text-foreground'
                        : row.after?.kind === 'context'
                          ? 'text-muted'
                          : ''
                    ]}
                  >
                    {row.after ? row.after.text || ' ' : ''}
                  </span>
                </div>
              {/each}
            {:else}
              {#each w.lines as line, index (`${line.kind}:${line.beforeLine ?? 0}:${line.afterLine ?? 0}:${index}`)}
                <div
                  class={[
                    'grid min-w-max grid-cols-[3rem_3rem_1rem_minmax(0,1fr)] px-2',
                    line.kind === 'added'
                      ? 'bg-success/10 text-foreground'
                      : line.kind === 'deleted'
                        ? 'bg-danger/10 text-foreground'
                        : 'text-muted'
                  ]}
                >
                  <span class="select-none pr-2 text-right text-dimmed"
                    >{line.beforeLine ?? ''}</span
                  >
                  <span class="select-none pr-2 text-right text-dimmed">{line.afterLine ?? ''}</span
                  >
                  <span
                    class={line.kind === 'added'
                      ? 'text-success'
                      : line.kind === 'deleted'
                        ? 'text-danger'
                        : 'text-dimmed'}
                  >
                    {line.kind === 'added' ? '+' : line.kind === 'deleted' ? '−' : ' '}
                  </span>
                  <span class="whitespace-pre pr-4">{line.text || ' '}</span>
                </div>
              {/each}
            {/if}
            {#if w.belowHidden > 0}
              {@render contextExpander(hunk, 'below', w.belowHidden)}
            {/if}
          </section>
        {/each}
      {/if}
    </div>
  </div>
{/if}
