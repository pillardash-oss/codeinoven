<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Check, Copy, Expand, Lock, LockOpen, TextWrap } from '@lucide/svelte'
  import { copyText } from '$lib/copy-text'
  import Modal from '../ui/Modal.svelte'
  import { attachTableColumnResize, type TableColumnResizeSession } from './table-column-resize'
  import { tableHtmlToMarkdown } from './table-markdown'

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

  /** The reader asked for the whole window, so the table is read in a modal. */
  let expanded = $state(false)

  /** The copy control confirms itself on the button, like a code block's does. */
  let copied = $state(false)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Widths of the live resize session, carried across a re-render of the same
   * table (a streaming answer, a picture that resolved) so a drag is not undone.
   * Deliberately not reactive: the drag writes it, and making it state would
   * rebuild the session on every frame of the drag.
   */
  let columnWidths: readonly number[] = []

  const wrapLabel = $derived(wrapped ? 'Unwrap table columns' : 'Wrap table columns')
  const lockLabel = $derived(unlocked ? 'Lock column widths' : 'Unlock column widths')

  onDestroy(() => clearTimeout(copyResetTimer))

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

  /**
   * Copy the table as markdown rather than making the reader drag a selection
   * across it. The button carries the confirmation, so the copy raises no toast.
   */
  async function copyTable(): Promise<void> {
    const markdown = tableHtmlToMarkdown(html)
    if (markdown === '') return
    try {
      await copyText(markdown, null)
      copied = true
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copied = false), 1500)
    } catch {
      // Clipboard unavailable   the button simply stays idle.
    }
  }
</script>

{#snippet tableControls(withResize: boolean, withExpand: boolean)}
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
  {#if withResize}
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
  {/if}
  <button
    type="button"
    class="md-table-control"
    aria-label="Copy table as Markdown"
    title="Copy table as Markdown"
    onclick={() => void copyTable()}
  >
    {#if copied}
      <Check size={12} class="text-success" />
    {:else}
      <Copy size={12} />
    {/if}
  </button>
  {#if withExpand}
    <button
      type="button"
      class="md-table-control"
      aria-label="Expand table"
      title="Expand table"
      onclick={() => (expanded = true)}
    >
      <Expand size={12} />
    </button>
  {/if}
{/snippet}

<div class="md-table-block">
  <div class="md-table-controls" role="group" aria-label="Table controls">
    {@render tableControls(true, true)}
  </div>
  <div
    class={['md-table-wrap', wrapped && 'md-table-fit', unlocked && 'md-table-resizable']}
    {@attach tableColumnResize}
  >
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- blockHtml is DOMPurify-sanitized -->
    {@html html}
  </div>
</div>

<!-- The same table, given the whole window so a grid too wide for the panel can
     be read (and scrolled, or wrapped) without the message body around it. -->
<Modal
  open={expanded}
  title="Table"
  onClose={() => (expanded = false)}
  size="full"
  fill
  contentClass="flex min-h-0 flex-col overflow-hidden p-0"
>
  <div class="markdown-body md-table-fullscreen">
    <div class="md-table-controls" role="group" aria-label="Table controls">
      {@render tableControls(false, false)}
    </div>
    <div class={['md-table-wrap md-table-fullscreen-scroll', wrapped && 'md-table-fit']}>
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- blockHtml is DOMPurify-sanitized -->
      {@html html}
    </div>
  </div>
</Modal>
