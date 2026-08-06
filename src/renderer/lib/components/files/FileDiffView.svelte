<script lang="ts">
  import type { TurnCheckpointFileDiff } from '$shared/types'
  import { diffLayoutState } from '$lib/stores/diff-layout.svelte'
  import { diffDetails, splitRows } from './file-diff'

  interface Props {
    diff: TurnCheckpointFileDiff
    /** Caps the height of the scrollable diff area (e.g. "24rem"). */
    maxHeight?: string
  }

  let { diff, maxHeight = undefined }: Props = $props()
  let hunks = $derived(diffDetails(diff.before, diff.after).hunks)
</script>

{#if diff.binary}
  <div class="flex h-full items-center justify-center px-6 text-center">
    <p class="text-xs text-dimmed">Binary file · content preview unavailable.</p>
  </div>
{:else}
  <div
    class="flex h-full min-h-0 flex-col bg-app"
    style={maxHeight ? `max-height:${maxHeight}` : undefined}
  >
    <div class="min-h-0 flex-1 overflow-auto py-1 font-mono text-[11px] leading-5">
      {#if hunks.length === 0}
        <p class="px-3 py-4 text-center text-dimmed">No textual changes.</p>
      {:else if diffLayoutState.layout === 'horizontal'}
        {#each hunks as hunk (hunk.startIndex)}
          <section class="not-first:mt-1 border-y border-border first:border-t-0">
            <div class="flex items-center gap-2 bg-elevated px-3 py-0.5 text-[10px] text-info">
              <span
                >@@ -{hunk.beforeStart},{hunk.beforeCount} +{hunk.afterStart},{hunk.afterCount} @@</span
              >
              <span class="ml-auto flex items-center gap-3 text-dimmed">
                <span>Before</span>
                <span>After</span>
              </span>
            </div>
            {#each splitRows(hunk.lines) as row, index (`${row.before?.kind ?? 'none'}:${row.before?.beforeLine ?? 0}:${row.after?.afterLine ?? 0}:${index}`)}
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
          </section>
        {/each}
      {:else}
        {#each hunks as hunk (hunk.startIndex)}
          <section class="not-first:mt-1 border-y border-border first:border-t-0">
            <div class="bg-elevated px-3 py-0.5 text-[10px] text-info">
              @@ -{hunk.beforeStart},{hunk.beforeCount} +{hunk.afterStart},{hunk.afterCount} @@
            </div>
            {#each hunk.lines as line, index (`${line.kind}:${line.beforeLine ?? 0}:${line.afterLine ?? 0}:${index}`)}
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
                <span class="select-none pr-2 text-right text-dimmed">{line.beforeLine ?? ''}</span>
                <span class="select-none pr-2 text-right text-dimmed">{line.afterLine ?? ''}</span>
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
          </section>
        {/each}
      {/if}
    </div>
  </div>
{/if}
