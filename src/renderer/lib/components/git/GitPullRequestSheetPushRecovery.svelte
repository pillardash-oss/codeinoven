<script lang="ts">
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
  import CioArrowRight from '@pdslng/cio-icon/CioArrowRight.svelte'
  interface Props {
    head: string
    headIsCurrent: boolean
    pushErrorDetails: string
    recoverMode: 'merge' | 'rebase' | null
    /**
     * The thread the divergence handoff minted, once it exists.
     *
     * The handoff is opened from this panel and the thread is built inside it,
     * so this is the id the panel is handed back: without it, a user who
     * reviewed the prompt first was left with a conversation they had to find in
     * the thread list.
     */
    agentThreadId?: string | null
    onRecover: (mode: 'merge' | 'rebase') => void
    onResolveWithAgent: () => void
    onOpenAgentThread?: () => void
  }

  let {
    head,
    headIsCurrent,
    pushErrorDetails,
    recoverMode,
    agentThreadId = null,
    onRecover,
    onResolveWithAgent,
    onOpenAgentThread
  }: Props = $props()
</script>

<div class="border border-warning/30 bg-warning/10 px-3 py-2.5">
  <div class="flex items-start gap-2">
    <CioAttention size={14} class="mt-0.5 shrink-0 text-warning" />
    <div class="min-w-0 flex-1">
      <p class="text-[0.625rem] font-semibold text-warning">Push blocked branch has diverged</p>
      <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-dimmed">
        The remote branch
        <span class="font-mono text-foreground">{head}</span> has commits you don't have locally, so Git
        won't let you push over them. Pull the remote changes in first the pull request is created automatically
        afterwards.
      </p>
      {#if pushErrorDetails}
        <details class="mt-2 text-[0.5625rem] text-dimmed">
          <summary class="cursor-pointer select-none font-medium text-foreground">
            Show Git error
          </summary>
          <pre
            class="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words border border-border bg-elevated p-2 font-mono text-[0.5625rem] leading-relaxed text-danger">{pushErrorDetails}</pre>
        </details>
      {/if}
      {#if headIsCurrent}
        <div class="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1.5 border border-border px-2.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
            disabled={recoverMode !== null}
            onclick={() => onRecover('rebase')}
          >
            {#if recoverMode === 'rebase'}
              <CioSpinner size={11} class="animate-spin" />
            {/if}
            Rebase &amp; push
          </button>
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1.5 bg-primary px-2.5 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
            disabled={recoverMode !== null}
            onclick={() => onRecover('merge')}
          >
            {#if recoverMode === 'merge'}
              <CioSpinner size={11} class="animate-spin" />
            {/if}
            Pull &amp; push
          </button>
        </div>
      {:else}
        <p class="mt-1 text-[0.5625rem] leading-relaxed text-dimmed">
          Check out <span class="font-mono text-foreground">{head}</span> first, then use Pull &amp; push
          to resolve this here.
        </p>
      {/if}
    </div>
  </div>
  <div class="mt-2 border-t border-warning/20 pt-2">
    {#if agentThreadId && onOpenAgentThread}
      <!--
        The handoff already minted a thread for this divergence. The agent's own
        turn is what resolves it, so the panel offers the way back into that
        conversation instead of a second identical handoff.
      -->
      <button
        type="button"
        class="flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 border border-border bg-surface px-3 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated"
        title="Open the agent thread resolving this divergence"
        onclick={onOpenAgentThread}
      >
        <CioArrowRight size={12} />
        Open agent thread
      </button>
    {:else}
      <button
        type="button"
        class="flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 border border-warning/40 bg-surface px-3 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
        title="Choose a model and scope, then hand this branch divergence to an agent"
        onclick={onResolveWithAgent}
      >
        <CioSubagent size={12} />
        Resolve with agent
      </button>
    {/if}
  </div>
</div>
