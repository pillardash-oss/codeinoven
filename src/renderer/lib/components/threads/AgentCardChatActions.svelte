<script lang="ts">
  import CioTemporaryChat from '@codeinoven/icons/CioTemporaryChat.svelte'
  import TriangleQuestionMark from '$lib/components/icons/cio/TriangleQuestionMark.svelte'
  /**
   * The two context actions a human-decision card carries: explain it, or open a
   * quick chat about it.
   *
   * They live in the card head's quiet cluster at the top right, before the
   * reading and the fold, so the footer below keeps its room for the card's own
   * controls. At head size they are glyphs: the tooltip carries the wording, and
   * each title stays action-specific through `subject`.
   */
  interface Props {
    /** Opens the explain side chat; omitted hides the action. */
    onExplain?: () => void
    /** Opens a quick chat; omitted hides the action. */
    onQuickChat?: () => void
    /** Noun the titles name, so each card keeps an action-specific label. */
    subject: string
    /** Disables both actions while the owning card is submitting or resolving. */
    disabled?: boolean
  }

  let { onExplain, onQuickChat, subject, disabled = false }: Props = $props()

  const explainTitle = $derived(`Explain this ${subject} in a temporary read-only chat`)
  const quickChatTitle = $derived(`Start a temporary read-only quick chat about this ${subject}`)
  const actionClass =
    'flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40'
</script>

{#if onExplain || onQuickChat}
  <div class="flex shrink-0 items-center gap-0.5">
    {#if onExplain}
      <button
        type="button"
        class={actionClass}
        {disabled}
        onclick={onExplain}
        title={explainTitle}
        aria-label={explainTitle}
      >
        <TriangleQuestionMark size={14} class="shrink-0" />
      </button>
    {/if}
    {#if onQuickChat}
      <button
        type="button"
        class={actionClass}
        {disabled}
        onclick={onQuickChat}
        title={quickChatTitle}
        aria-label={quickChatTitle}
      >
        <CioTemporaryChat size={14} class="shrink-0" />
      </button>
    {/if}
  </div>
{/if}
