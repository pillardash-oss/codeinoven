<script lang="ts">
  import CioChevronDown from '@pillardash-oss/cio-icon/CioChevronDown.svelte'
  import TimelineRailItem from './TimelineRailItem.svelte'

  /**
   * The stand-in a long history puts where its middle would be.
   *
   * github.com collapses the middle of a long timeline and keeps both ends, so a
   * reader sees how the conversation began and where it stands without scrolling
   * through everything between. This is that control: one row on the rail, the same
   * as any event, that opens the run it hides.
   *
   * It is deliberately one-way. Opening is the reader asking to see the middle, and
   * a control that could also fold it away again would let a stray click drop a run
   * of comments back out of the page while the reader is scrolling through it.
   */
  interface Props {
    /** How many rows the middle holds, which is what the control offers. */
    hidden: number
    onExpand: () => void
  }

  let { hidden, onExpand }: Props = $props()
</script>

<TimelineRailItem>
  {#snippet gutter()}
    <span class="flex size-5 shrink-0 items-center justify-center bg-elevated text-dimmed">
      <CioChevronDown size={12} class="shrink-0" aria-hidden="true" />
    </span>
  {/snippet}
  <button
    type="button"
    class="cursor-pointer px-1.5 py-0.5 text-left text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
    aria-expanded="false"
    title="Show the {hidden} items this history hides"
    onclick={onExpand}
  >
    {`Show ${hidden} ${hidden === 1 ? 'earlier item' : 'earlier items'}`}
  </button>
</TimelineRailItem>
