<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type MarkdownTable from './MarkdownTable.svelte'
  import { loadMarkdownTable } from './markdown-chunk'

  /**
   * A table behind its own chunk.
   *
   * The table component owns column resizing, wrap mode and the full-screen
   * reading surface. A table is a small part of a conversation, so it arrives
   * with its own chunk and borrows the app's own table styles until then: the
   * grid is readable immediately, and the controls appear with it.
   */
  let props: ComponentProps<typeof MarkdownTable> = $props()
</script>

{#await loadMarkdownTable()}
  <div class="md-table-block relative">
    <div class="md-table-wrap">
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- blockHtml is DOMPurify-sanitized -->
      {@html props.html}
    </div>
  </div>
{:then { default: MarkdownTable }}
  <MarkdownTable {...props} />
{/await}
