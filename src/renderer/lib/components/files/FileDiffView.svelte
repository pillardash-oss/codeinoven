<script lang="ts">
  import type { TurnCheckpointFileDiff } from '$shared/types'
  import DiffLayoutToggle from '../ui/DiffLayoutToggle.svelte'
  import { diffLayoutState, diffLayoutToggleLabel } from '$lib/stores/diff-layout.svelte'

  interface Props {
    diff: TurnCheckpointFileDiff
  }

  interface DiffLine {
    kind: 'context' | 'added' | 'deleted'
    text: string
    beforeLine?: number
    afterLine?: number
  }

  interface DiffHunk {
    startIndex: number
    lines: DiffLine[]
    beforeStart: number
    beforeCount: number
    afterStart: number
    afterCount: number
  }

  interface SplitRow {
    before: DiffLine | null
    after: DiffLine | null
  }

  let { diff }: Props = $props()
  const CONTEXT_LINES = 3

  function sourceLines(source: string | undefined): string[] {
    if (source === undefined) return []
    const lines = source.split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines
  }

  function fallbackDiff(before: string[], after: string[]): DiffLine[] {
    let prefix = 0
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
      prefix += 1
    }
    let suffix = 0
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - suffix - 1] === after[after.length - suffix - 1]
    ) {
      suffix += 1
    }
    return [
      ...before.slice(0, prefix).map((text, index): DiffLine => ({
        kind: 'context',
        text,
        beforeLine: index + 1,
        afterLine: index + 1
      })),
      ...before.slice(prefix, before.length - suffix).map((text, index): DiffLine => ({
        kind: 'deleted',
        text,
        beforeLine: prefix + index + 1
      })),
      ...after.slice(prefix, after.length - suffix).map((text, index): DiffLine => ({
        kind: 'added',
        text,
        afterLine: prefix + index + 1
      })),
      ...before.slice(before.length - suffix).map((text, index): DiffLine => ({
        kind: 'context',
        text,
        beforeLine: before.length - suffix + index + 1,
        afterLine: after.length - suffix + index + 1
      }))
    ]
  }

  function lineDiff(before: string | undefined, after: string | undefined): DiffLine[] {
    const beforeLines = sourceLines(before)
    const afterLines = sourceLines(after)
    if (beforeLines.length * afterLines.length > 500_000) {
      return fallbackDiff(beforeLines, afterLines)
    }

    const lengths = Array.from(
      { length: beforeLines.length + 1 },
      () => new Uint32Array(afterLines.length + 1)
    )
    for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
      for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
        lengths[beforeIndex][afterIndex] =
          beforeLines[beforeIndex] === afterLines[afterIndex]
            ? lengths[beforeIndex + 1][afterIndex + 1] + 1
            : Math.max(lengths[beforeIndex + 1][afterIndex], lengths[beforeIndex][afterIndex + 1])
      }
    }

    const lines: DiffLine[] = []
    let beforeIndex = 0
    let afterIndex = 0
    while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
      if (
        beforeIndex < beforeLines.length &&
        afterIndex < afterLines.length &&
        beforeLines[beforeIndex] === afterLines[afterIndex]
      ) {
        lines.push({
          kind: 'context',
          text: beforeLines[beforeIndex],
          beforeLine: beforeIndex + 1,
          afterLine: afterIndex + 1
        })
        beforeIndex += 1
        afterIndex += 1
      } else if (
        afterIndex < afterLines.length &&
        (beforeIndex >= beforeLines.length ||
          lengths[beforeIndex][afterIndex + 1] >= lengths[beforeIndex + 1][afterIndex])
      ) {
        lines.push({ kind: 'added', text: afterLines[afterIndex], afterLine: afterIndex + 1 })
        afterIndex += 1
      } else {
        lines.push({ kind: 'deleted', text: beforeLines[beforeIndex], beforeLine: beforeIndex + 1 })
        beforeIndex += 1
      }
    }
    return lines
  }

  function diffHunks(lines: DiffLine[]): DiffHunk[] {
    const changedIndexes = lines
      .map((line, index) => (line.kind === 'context' ? -1 : index))
      .filter((index) => index >= 0)
    if (changedIndexes.length === 0) return []

    const ranges: Array<{ start: number; end: number }> = []
    for (const changedIndex of changedIndexes) {
      const start = Math.max(0, changedIndex - CONTEXT_LINES)
      const end = Math.min(lines.length - 1, changedIndex + CONTEXT_LINES)
      const previous = ranges.at(-1)
      if (previous && start <= previous.end + 1) {
        previous.end = Math.max(previous.end, end)
      } else {
        ranges.push({ start, end })
      }
    }

    return ranges.map(({ start, end }) => {
      const hunkLines = lines.slice(start, end + 1)
      const beforeLines = hunkLines.flatMap((line) =>
        line.beforeLine === undefined ? [] : [line.beforeLine]
      )
      const afterLines = hunkLines.flatMap((line) =>
        line.afterLine === undefined ? [] : [line.afterLine]
      )
      return {
        startIndex: start,
        lines: hunkLines,
        beforeStart: beforeLines[0] ?? 0,
        beforeCount: beforeLines.length,
        afterStart: afterLines[0] ?? 0,
        afterCount: afterLines.length
      }
    })
  }

  let lines = $derived(lineDiff(diff.before, diff.after))
  let hunks = $derived(diffHunks(lines))
  let additions = $derived(lines.filter((line) => line.kind === 'added').length)
  let deletions = $derived(lines.filter((line) => line.kind === 'deleted').length)

  /** Pair deleted lines with the added lines that follow them so the split
   *  (horizontal) view can render before and after side by side. */
  function splitRows(hunkLines: DiffLine[]): SplitRow[] {
    const rows: SplitRow[] = []
    for (const line of hunkLines) {
      if (line.kind === 'context') {
        rows.push({ before: line, after: line })
      } else if (line.kind === 'deleted') {
        rows.push({ before: line, after: null })
      } else {
        const previous = rows.at(-1)
        if (previous && previous.before && !previous.after && previous.before.kind === 'deleted') {
          previous.after = line
        } else {
          rows.push({ before: null, after: line })
        }
      }
    }
    return rows
  }
</script>

{#if diff.binary}
  <div class="flex h-full items-center justify-center px-6 text-center">
    <p class="text-xs text-dimmed">Binary file · content preview unavailable.</p>
  </div>
{:else}
  <div class="flex h-full min-h-0 flex-col bg-app">
    <div
      class="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 font-mono text-[10px]"
    >
      <span class="text-success">+{additions}</span>
      <span class="text-danger">−{deletions}</span>
      <span class="flex-1"></span>
      {#if diff.truncated}
        <span class="text-warning">Preview truncated at 64 KiB</span>
      {/if}
      <DiffLayoutToggle title={diffLayoutToggleLabel(diffLayoutState.layout)} />
    </div>
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
