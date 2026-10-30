<script lang="ts">
  /**
   * One composer tag, drawn as its mark and its name.
   *
   * The menu row, and anything else that lists a tag, draws this instead of
   * laying the parts out again: the mark comes from `composer-tag.ts`, the name
   * is truncated to the row's width rather than wrapped, and the line under it
   * names where the tag points. Two root elements so the badge drops straight
   * into a flex row.
   */
  interface Props {
    /** Inline markup of the mark this tag wears: an `<img>` or an inline `<svg>`. */
    markHtml: string
    /** The tag's name. Never wrapped: the row truncates it. */
    label: string
    /** The line under the name, naming what the tag points at. */
    detail?: string
  }

  let { markHtml, label, detail }: Props = $props()
</script>

<span class="flex h-[13px] w-[13px] shrink-0 items-center justify-center">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html markHtml}
</span>
<span class="min-w-0 flex-1">
  <span class="block truncate">{label}</span>
  {#if detail}
    <span class="block truncate text-[0.625rem] text-dimmed">{detail}</span>
  {/if}
</span>
