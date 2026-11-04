<script lang="ts">
  /**
   * The files a receipt reports, one row each: the letter Git uses, the path,
   * and the line counts right-aligned.
   *
   * A file row states summary only. The full diff stays in the rail's Changes
   * tab, which the receipt's own action opens, so the receipt can never grow
   * into a second changes panel.
   */
  import { formatLineCounts } from '$shared/run-receipt'
  import type { RunReceiptFile } from '$shared/types'

  interface Props {
    files: readonly RunReceiptFile[]
    /** Whether more rows exist than the read kept. */
    truncated?: boolean
    /** Label used by the empty case, which differs for committed and uncommitted. */
    emptyLabel: string
  }

  let { files, truncated = false, emptyLabel }: Props = $props()

  const STATUS_LETTER: Record<RunReceiptFile['status'], string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R'
  }

  const STATUS_TITLE: Record<RunReceiptFile['status'], string> = {
    added: 'Added',
    modified: 'Modified',
    deleted: 'Deleted',
    renamed: 'Renamed'
  }

  /** Only the file name is shown; the directory is the row's tooltip. */
  function fileName(path: string): string {
    const index = path.lastIndexOf('/')
    return index === -1 ? path : path.slice(index + 1)
  }
</script>

{#if files.length === 0}
  <p class="text-xs text-muted">{emptyLabel}</p>
{:else}
  <ul class="flex flex-col">
    {#each files as file (file.path)}
      <li class="flex min-w-0 items-baseline gap-2 py-0.5 text-xs">
        <span
          class="w-3 shrink-0 text-center text-muted"
          title={STATUS_TITLE[file.status]}
          aria-label={STATUS_TITLE[file.status]}
        >
          {STATUS_LETTER[file.status]}
        </span>
        <span class="min-w-0 flex-1 truncate text-muted" title={file.path}>
          {#if file.oldPath}
            <span class="text-muted">{fileName(file.oldPath)}</span>
            <span aria-hidden="true"> → </span>
          {/if}
          <span class="text-foreground">{fileName(file.path)}</span>
        </span>
        <span class="shrink-0 text-right text-muted">
          {#if file.binary}
            binary
          {:else}
            {formatLineCounts({ count: 1, additions: file.additions, deletions: file.deletions })}
          {/if}
        </span>
      </li>
    {/each}
  </ul>
  {#if truncated}
    <p class="pt-1 text-xs text-muted">More files than this receipt keeps.</p>
  {/if}
{/if}
