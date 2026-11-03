<script lang="ts">
  import CioClipboardList from '@pdslng/cio-icon/CioClipboardList.svelte'
  import CioEye from '@pdslng/cio-icon/CioEye.svelte'

  /**
   * The two ways to find out what an entry means, side by side.
   *
   * A question, or one of its options, may carry a walkthrough (the step-by-step
   * text the user can read and copy) and a visual (a picture the agent drew).
   * They answer the same doubt, so they are never one hiding another: each is its
   * own button, drawn next to the other with a space between them, and an entry
   * that carries only one shows only that one.
   *
   * `attached` is the split-control edge of an option box, so the pair shares one
   * rule against the label it belongs to. `standalone` is the question's own row
   * under its prompt, where each button stands on its own frame.
   */
  interface Props {
    /** The entry carries step-by-step text the user can read and copy. */
    hasWalkthrough?: boolean
    /** The entry carries a picture of what it means. */
    hasVisual?: boolean
    /** What the pair is about, so every title names its own entry. */
    subject: string
    /** `attached` rides the option box's edge; `standalone` floats in the body. */
    variant?: 'attached' | 'standalone'
    disabled?: boolean
    onWalkthrough: () => void
    onVisual: () => void
  }

  let {
    hasWalkthrough = false,
    hasVisual = false,
    subject,
    variant = 'attached',
    disabled = false,
    onWalkthrough,
    onVisual
  }: Props = $props()

  const walkthroughTitle = $derived(`View the walkthrough for ${subject}`)
  const visualTitle = $derived(`Show the visual for ${subject}`)

  const buttonClass = $derived(
    variant === 'attached'
      ? 'flex h-full w-8 shrink-0 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50'
      : 'flex h-7 w-8 shrink-0 items-center justify-center border border-border bg-surface text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50'
  )
</script>

{#if hasWalkthrough || hasVisual}
  <div
    class={variant === 'attached'
      ? 'flex shrink-0 items-center gap-2 border-l border-border px-1.5'
      : 'flex shrink-0 items-center gap-2'}
    role="group"
    aria-label="Ways to understand {subject}"
  >
    {#if hasVisual}
      <button
        type="button"
        class={buttonClass}
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
        class={buttonClass}
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
