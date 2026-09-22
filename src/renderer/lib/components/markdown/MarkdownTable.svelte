<script lang="ts">
  import { Lock, LockOpen, TextWrap } from '@lucide/svelte'
  import { attachTableColumnResize, type TableColumnResizeSession } from './table-column-resize'

  interface Props {
    /** DOMPurify-sanitized HTML of exactly one markdown table block. */
    html: string
  }

  let { html }: Props = $props()

  /**
   * Both toggles are per-table and in memory only. A table is wrapped or made
   * resizable when the reader asks for it and forgotten when they leave: a wide
   * table costs nothing until then, and a relaunch renders plain tables again.
   */
  let wrapped = $state(false)
  let unlocked = $state(false)

  /**
   * Widths of the live resize session, carried across a re-render of the same
   * table (a streaming answer, a picture that resolved) so a drag is not undone.
   * Deliberately not reactive: the drag writes it, and making it state would
   * rebuild the session on every frame of the drag.
   */
  let columnWidths: readonly number[] = []

  const wrapLabel = $derived(wrapped ? 'Unwrap table columns' : 'Wrap table columns')
  const lockLabel = $derived(unlocked ? 'Lock column widths' : 'Unlock column widths')

  /**
   * Column resizing is imperative because the table markup is sanitized HTML this
   * component never rewrites: the widths and the drag handles are added to the
   * rendered DOM and taken off again when the padlock is re-locked or the table is
   * replaced. The attachment re-runs after the `{@html}` update of the same
   * element, so an unlocked table survives streaming.
   */
  function tableColumnResize(node: HTMLDivElement): (() => void) | undefined {
    // Every input is read before the early return, so the attachment re-runs when
    // the rendered table is replaced or either toggle flips.
    const rendered = html
    const resizable = unlocked
    const fitToWidth = wrapped
    if (!rendered || !resizable) return
    const table = node.querySelector('table')
    if (!(table instanceof HTMLTableElement)) return
    const session: TableColumnResizeSession | null = attachTableColumnResize(table, {
      container: node,
      fitToWidth,
      widths: columnWidths,
      onWidthsChange: (widths) => (columnWidths = widths)
    })
    return session ? () => session.destroy() : undefined
  }
</script>

<div class="md-table-block">
  <div class="md-table-controls" role="group" aria-label="Table controls">
    <button
      type="button"
      class="md-table-control"
      aria-pressed={wrapped}
      aria-label={wrapLabel}
      title={wrapLabel}
      onclick={() => (wrapped = !wrapped)}
    >
      <TextWrap size={12} />
    </button>
    <button
      type="button"
      class="md-table-control"
      aria-pressed={unlocked}
      aria-label={lockLabel}
      title={lockLabel}
      onclick={() => (unlocked = !unlocked)}
    >
      {#if unlocked}
        <LockOpen size={12} />
      {:else}
        <Lock size={12} />
      {/if}
    </button>
  </div>
  <div
    class={['md-table-wrap', wrapped && 'md-table-fit', unlocked && 'md-table-resizable']}
    {@attach tableColumnResize}
  >
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- blockHtml is DOMPurify-sanitized -->
    {@html html}
  </div>
</div>
