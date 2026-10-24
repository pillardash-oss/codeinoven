<script lang="ts">
  import CioLightbulb from '@pdslng/cio-icon/CioLightbulb.svelte'
  import CioTemporaryChat from '@pdslng/cio-icon/CioTemporaryChat.svelte'
  import type { Snippet } from 'svelte'

  /**
   * The bottom row of an annotation box, in one row.
   *
   * Every surface that lets a user comment on something in the app draws the same
   * footer: what the surface does with the annotation on the left (Remove, Resolve),
   * the read-only chat pair, and the surface's own commit actions on the right
   * (Cancel, Save, Cancel/Done/Comment). They used to be two rows in some surfaces
   * and one in others, which made the same four actions move around between the
   * studio, an artifact inspector and a comment bubble. This is that row, once.
   *
   * It also decides how the pair is drawn. An annotation box can be a 26rem studio
   * popover or a narrow bubble pinned to a picked element, and a row that wrapped
   * onto a second line in either of them was the defect this replaces: the pair
   * keeps its words while the box has room for them and falls back to two titled
   * icon buttons when it does not, so the footer is always exactly one row.
   */
  interface Props {
    /**
     * What the actions are about, in the caller's words: "selection", "annotation",
     * "artifact element", "mark", "moment", "design element", "passage". It
     * completes both names, so no two surfaces share one accessible name.
     */
    subject: string
    /** The side-chat handlers. Both are needed for the pair to be offered. */
    onExplain?: () => void
    onQuickChat?: () => void
    /**
     * The dismissal action.
     *
     * A falsy action always sits at the far bottom left of an annotation box, which
     * is the app's footer rule, so the bar draws it itself instead of trusting each
     * surface to place it: no call site can put Cancel next to the commit action.
     */
    onCancel?: () => void
    /** What cancel dismisses, when "Cancel" alone would not say it ("Cancel editing"). */
    cancelTitle?: string
    /** The surface's own annotation actions, drawn after Cancel (falsy actions lead). */
    leading?: Snippet
    /** The surface's commit actions, drawn last and to the right. */
    trailing?: Snippet
  }

  let {
    subject,
    onExplain,
    onQuickChat,
    onCancel,
    cancelTitle = 'Cancel',
    leading,
    trailing
  }: Props = $props()

  const explainTitle = $derived(`Explain this ${subject}`)
  const quickChatTitle = $derived(`Quick chat about this ${subject}`)
</script>

<div class="mt-2 flex items-center gap-1 @container">
  {#if onCancel}
    <button
      type="button"
      class="shrink-0 px-2 py-1.5 text-xs text-muted transition-colors hover:bg-overlay"
      title={cancelTitle}
      onclick={onCancel}>{cancelTitle}</button
    >
  {/if}
  {@render leading?.()}
  {#if onExplain && onQuickChat}
    <button
      type="button"
      class="flex h-8 shrink-0 items-center gap-1 px-1.5 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title={explainTitle}
      aria-label={explainTitle}
      onclick={onExplain}
    >
      <CioLightbulb size={13} aria-hidden="true" />
      <span class="hidden @min-[22rem]:inline">Explain</span>
    </button>
    <button
      type="button"
      class="flex h-8 shrink-0 items-center gap-1 px-1.5 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title={quickChatTitle}
      aria-label={quickChatTitle}
      onclick={onQuickChat}
    >
      <CioTemporaryChat size={13} aria-hidden="true" />
      <span class="hidden @min-[22rem]:inline">Quick Chat</span>
    </button>
  {/if}
  {#if trailing}
    <div class="ml-auto flex shrink-0 items-center gap-1.5">
      {@render trailing()}
    </div>
  {/if}
</div>
