<script lang="ts">
  import { Bot, Loader2, TriangleAlert } from '@lucide/svelte'

  interface Props {
    head: string
    headIsCurrent: boolean
    pushErrorDetails: string
    recoverMode: 'merge' | 'rebase' | null
    resolveThreadError: string
    openingResolveThread: boolean
    onRecover: (mode: 'merge' | 'rebase') => void
    onResolveWithAgent: () => void
  }

  let {
    head,
    headIsCurrent,
    pushErrorDetails,
    recoverMode,
    resolveThreadError,
    openingResolveThread,
    onRecover,
    onResolveWithAgent
  }: Props = $props()
</script>

<div class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
  <div class="flex items-start gap-2">
    <TriangleAlert size={14} class="mt-0.5 shrink-0 text-warning" />
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
            class="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-elevated p-2 font-mono text-[0.5625rem] leading-relaxed text-danger">{pushErrorDetails}</pre>
        </details>
      {/if}
      {#if headIsCurrent}
        <div class="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
            disabled={recoverMode !== null}
            onclick={() => onRecover('rebase')}
          >
            {#if recoverMode === 'rebase'}
              <Loader2 size={11} class="animate-spin" />
            {/if}
            Rebase &amp; push
          </button>
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
            disabled={recoverMode !== null}
            onclick={() => onRecover('merge')}
          >
            {#if recoverMode === 'merge'}
              <Loader2 size={11} class="animate-spin" />
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
    {#if resolveThreadError}
      <p class="mb-2 text-[0.5625rem] leading-relaxed text-danger">{resolveThreadError}</p>
    {/if}
    <button
      type="button"
      class="flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-warning/40 bg-surface px-3 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
      title="Open a new thread with this branch-divergence issue prefilled"
      disabled={openingResolveThread}
      onclick={onResolveWithAgent}
    >
      {#if openingResolveThread}
        <Loader2 size={12} class="animate-spin" />
      {:else}
        <Bot size={12} />
      {/if}
      Resolve with agent
    </button>
  </div>
</div>
