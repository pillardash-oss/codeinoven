<script lang="ts">
  import DiffRows from '../files/DiffRows.svelte'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import DiffLayoutToggle from '../ui/DiffLayoutToggle.svelte'
  import { diffLayoutState, diffLayoutToggleLabel } from '$lib/stores/diff-layout.svelte'
  import type { ToolFileDiff } from './tool-diff'

  interface Props {
    diffs: ToolFileDiff[]
  }

  let { diffs }: Props = $props()
</script>

<div class="space-y-2">
  {#each diffs as diff, diffIndex (`${diff.path}:${diffIndex}`)}
    {@const additions = diff.lines.filter((line) => line.kind === 'added').length}
    {@const deletions = diff.lines.filter((line) => line.kind === 'deleted').length}
    <section class="overflow-hidden rounded-md border border-border bg-app">
      <div class="flex h-8 items-center gap-2 border-b border-border px-2.5">
        <FileTypeIcon path={diff.path} size={13} />
        <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted">{diff.path}</span>
        <span class="font-mono text-[0.625rem] tabular-nums text-success">+{additions}</span>
        <span class="font-mono text-[0.625rem] tabular-nums text-danger">−{deletions}</span>
        <DiffLayoutToggle title={diffLayoutToggleLabel(diffLayoutState.layout)} size={12} />
      </div>
      <div class="max-h-72 overflow-x-hidden overflow-y-auto py-1 font-mono text-[0.6875rem] leading-5">
        <DiffRows lines={diff.lines} paneLabels />
      </div>
      {#if diff.truncated}
        <p class="border-t border-border px-2.5 py-1.5 text-[0.5625rem] text-warning">
          Diff preview limited to 120 lines
        </p>
      {/if}
    </section>
  {/each}
</div>
