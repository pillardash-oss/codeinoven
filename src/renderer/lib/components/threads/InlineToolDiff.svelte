<script lang="ts">
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import { diffLayoutState } from '$lib/stores/diff-layout.svelte'
  import type { ToolFileDiff } from './tool-diff'

  interface Props {
    diffs: ToolFileDiff[]
  }

  let { diffs }: Props = $props()
</script>

<div
  class={diffLayoutState.layout === 'horizontal'
    ? 'flex items-start gap-2 overflow-x-auto'
    : 'space-y-2'}
>
  {#each diffs as diff, diffIndex (`${diff.path}:${diffIndex}`)}
    {@const additions = diff.lines.filter((line) => line.kind === 'added').length}
    {@const deletions = diff.lines.filter((line) => line.kind === 'deleted').length}
    <section
      class={[
        'overflow-hidden rounded-md border border-border bg-app',
        diffLayoutState.layout === 'horizontal' ? 'min-w-72 flex-1' : ''
      ]}
    >
      <div class="flex h-8 items-center gap-2 border-b border-border px-2.5">
        <FileTypeIcon path={diff.path} size={13} />
        <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">{diff.path}</span>
        <span class="font-mono text-[10px] tabular-nums text-success">+{additions}</span>
        <span class="font-mono text-[10px] tabular-nums text-danger">−{deletions}</span>
      </div>
      <div class="max-h-72 overflow-auto py-1 font-mono text-[11px] leading-5">
        {#each diff.lines as line, lineIndex (`${line.kind}:${line.beforeLine ?? 0}:${line.afterLine ?? 0}:${lineIndex}`)}
          <div
            class={[
              'grid min-w-max grid-cols-[2.5rem_2.5rem_1rem_minmax(0,1fr)] px-2',
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
      </div>
      {#if diff.truncated}
        <p class="border-t border-border px-2.5 py-1.5 text-[9px] text-warning">
          Diff preview limited to 120 lines
        </p>
      {/if}
    </section>
  {/each}
</div>
