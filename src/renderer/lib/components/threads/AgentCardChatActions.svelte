<script lang="ts">
  import { HelpCircle, MessageSquareDashed } from '@lucide/svelte'

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
</script>

{#if onExplain || onQuickChat}
  <div class="flex min-w-0 items-center gap-1">
    {#if onExplain}
      <button
        type="button"
        class="flex h-7 min-w-0 shrink items-center gap-1 rounded-lg border border-border px-2 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        {disabled}
        onclick={onExplain}
        title={explainTitle}
        aria-label={explainTitle}
      >
        <HelpCircle size={13} class="shrink-0" />
        <span class="agent-card-footer-action-label min-w-0 truncate">Explain</span>
      </button>
    {/if}
    {#if onQuickChat}
      <button
        type="button"
        class="flex h-7 min-w-0 shrink items-center gap-1 rounded-lg border border-border px-2 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        {disabled}
        onclick={onQuickChat}
        title={quickChatTitle}
        aria-label={quickChatTitle}
      >
        <MessageSquareDashed size={13} class="shrink-0" />
        <span class="agent-card-footer-action-label min-w-0 truncate">Quick chat</span>
      </button>
    {/if}
  </div>
{/if}

<style>
  /*
    The hosting card's footer is the query container (see `agent-card-footer` in
    `AgentQuestionCard` / `AgentSecretCard`). When the row runs out of room the
    action labels drop first: the glyph and the tooltip still say what each
    button does, which leaves the card's own controls their space instead of
    letting one control overlap the other.
  */
  @container agent-card-footer (max-width: 40rem) {
    .agent-card-footer-action-label {
      display: none;
    }
  }
</style>
