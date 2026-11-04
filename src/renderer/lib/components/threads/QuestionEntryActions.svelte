<script lang="ts">
  import CioClipboardList from '@pdslng/cio-icon/CioClipboardList.svelte'
  import CioEye from '@pdslng/cio-icon/CioEye.svelte'

  /**
   * The two ways to find out what an option means, on the option's own edge.
   *
   * One option may carry a walkthrough (the step-by-step text the user can read
   * and copy) and a visual (a picture the agent drew). They answer the same
   * doubt, so each is its own button and neither hides the other. The pair
   * shares the option's trailing edge: one rule divides the control from the
   * label, and a second rule divides the two buttons from each other, so an
   * option with both never reads as one wide target.
   *
   * The question itself carries no such pair: the picture and the walkthrough
   * describe an alternative, not the choice between alternatives.
   */
  interface Props {
    /** The option carries step-by-step text the user can read and copy. */
    hasWalkthrough?: boolean
    /** The option carries a picture of what it produces. */
    hasVisual?: boolean
    /** The option label, so every title names its own option. */
    subject: string
    disabled?: boolean
    onWalkthrough: () => void
    onVisual: () => void
  }

  let {
    hasWalkthrough = false,
    hasVisual = false,
    subject,
    disabled = false,
    onWalkthrough,
    onVisual
  }: Props = $props()

  const walkthroughTitle = $derived(`View the walkthrough for ${subject}`)
  const visualTitle = $derived(`Show the visual for ${subject}`)
</script>

{#if hasWalkthrough || hasVisual}
  <div
    class="flex shrink-0 items-stretch divide-x divide-border border-l border-border"
    role="group"
    aria-label="Ways to understand {subject}"
  >
    {#if hasVisual}
      <button
        type="button"
        class="flex h-full w-8 shrink-0 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        {disabled}
        onclick={onVisual}
        title={visualTitle}
        aria-label={visualTitle}
      >
        <CioEye size={14} class="shrink-0" />
      </button>
    {/if}
    {#if hasWalkthrough}
      <button
        type="button"
        class="flex h-full w-8 shrink-0 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        {disabled}
        onclick={onWalkthrough}
        title={walkthroughTitle}
        aria-label={walkthroughTitle}
      >
        <CioClipboardList size={14} class="shrink-0" />
      </button>
    {/if}
  </div>
{/if}
