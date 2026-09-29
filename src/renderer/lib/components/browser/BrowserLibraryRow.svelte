<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    /** The page's own title, or the host when it never reported one. */
    title: string
    /** The second line: the host, and for a visit when it happened. */
    meta: string
    /** The full address, for the hover tooltip and the screen reader. */
    url: string
    /** Open the page, which is what the row's body does. */
    onOpen: () => void
    /** The row's own controls. They sit beside the activation button rather than
     *  inside it, which is invalid markup and would also make them open the page. */
    actions: Snippet
    /**
     * The page's icon, drawn in a leading slot. A list whose rows carry no icon
     * (a visit has none of its own) passes nothing and the slot does not exist, so
     * the title keeps the row's full width.
     */
    icon?: Snippet
  }

  let { title, meta, url, onOpen, actions, icon }: Props = $props()

  /**
   * One page in a browser library panel: a visit in the history, or a saved page
   * in the bookmarks.
   *
   * Both lists show the same two facts about a page and differ only in what their
   * controls do, so the row is written once and the controls are the panel's own.
   * The same shape the browser's tab strip uses, which is what makes the rail read
   * as one surface rather than two.
   */
</script>

<div class="group flex items-center gap-1 rounded-md transition-colors hover:bg-elevated">
  {#if icon}
    <span class="ml-1.5 flex h-4 w-4 shrink-0 items-center justify-center">
      {@render icon()}
    </span>
  {/if}
  <button
    type="button"
    class="flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 text-left outline-none"
    title={url}
    aria-label={`Open ${title}`}
    onclick={onOpen}
  >
    <span class="truncate text-xs text-foreground">{title}</span>
    <span class="truncate text-[0.625rem] text-dimmed">{meta}</span>
  </button>
  <div class="flex shrink-0 items-center gap-0.5 pr-1">
    {@render actions()}
  </div>
</div>
