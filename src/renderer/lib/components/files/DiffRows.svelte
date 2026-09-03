<script lang="ts">
  import { diffLayoutState } from '$lib/stores/diff-layout.svelte'
  import { splitRows, type DiffLine } from './file-diff'

  interface Props {
    /** Lines of a single diff block, in source order. */
    lines: DiffLine[]
    /** Renders "Before"/"After" captions above the split panes. */
    paneLabels?: boolean
  }

  let { lines, paneLabels = false }: Props = $props()

  /** Background tint for a line, matching across the gutter and the text cell. */
  function tint(kind: DiffLine['kind'] | undefined): string {
    if (kind === 'added') return 'bg-success/10'
    if (kind === 'deleted') return 'bg-danger/10'
    return ''
  }

  function textTone(kind: DiffLine['kind'] | undefined): string {
    if (kind === 'added' || kind === 'deleted') return 'text-foreground'
    return 'text-muted'
  }
</script>

{#snippet pane(rows: { line: DiffLine | null }[], side: 'before' | 'after')}
  <div class="min-w-0 overflow-x-auto">
    <div class="min-w-max">
      {#each rows as row, index (`${side}:${row.line?.kind ?? 'none'}:${row.line?.beforeLine ?? row.line?.afterLine ?? 0}:${index}`)}
        {@const kind = row.line?.kind}
        <div class={['flex', row.line ? tint(kind) : 'bg-elevated/40']}>
          <span class="sticky left-0 z-10 flex shrink-0 bg-app">
            <span
              class={[
                'w-11 select-none pr-2 text-right tabular-nums text-dimmed',
                row.line ? tint(kind) : 'bg-elevated/40'
              ]}
            >
              {(side === 'before' ? row.line?.beforeLine : row.line?.afterLine) ?? ''}
            </span>
          </span>
          <span class={['flex-1 whitespace-pre pr-4 pl-2', textTone(kind)]}>
            {row.line ? row.line.text || ' ' : ' '}
          </span>
        </div>
      {/each}
    </div>
  </div>
{/snippet}

{#if diffLayoutState.layout === 'horizontal'}
  {@const rows = splitRows(lines)}
  {#if paneLabels}
    <div
      class="sticky top-0 z-20 grid grid-cols-2 divide-x divide-border border-b border-border bg-elevated text-[0.5625rem] tracking-wide text-dimmed uppercase"
    >
      <span class="px-3 py-0.5">Before</span>
      <span class="px-3 py-0.5">After</span>
    </div>
  {/if}
  <div class="grid grid-cols-2 divide-x divide-border">
    {@render pane(
      rows.map((row) => ({ line: row.before })),
      'before'
    )}
    {@render pane(
      rows.map((row) => ({ line: row.after })),
      'after'
    )}
  </div>
{:else}
  <div class="overflow-x-auto">
    <div class="min-w-max">
      {#each lines as line, index (`${line.kind}:${line.beforeLine ?? 0}:${line.afterLine ?? 0}:${index}`)}
        <div class={['flex', tint(line.kind)]}>
          <span class="sticky left-0 z-10 flex shrink-0 bg-app">
            <span class={['flex', tint(line.kind)]}>
              <span class="w-11 select-none pr-2 text-right tabular-nums text-dimmed">
                {line.beforeLine ?? ''}
              </span>
              <span class="w-11 select-none pr-2 text-right tabular-nums text-dimmed">
                {line.afterLine ?? ''}
              </span>
              <span
                class={[
                  'w-4 select-none text-center',
                  line.kind === 'added'
                    ? 'text-success'
                    : line.kind === 'deleted'
                      ? 'text-danger'
                      : 'text-dimmed'
                ]}
              >
                {line.kind === 'added' ? '+' : line.kind === 'deleted' ? '−' : ' '}
              </span>
            </span>
          </span>
          <span class={['flex-1 whitespace-pre pr-4 pl-2', textTone(line.kind)]}>
            {line.text || ' '}
          </span>
        </div>
      {/each}
    </div>
  </div>
{/if}
