<script lang="ts">
  import { MessageSquareText } from '@lucide/svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'

  function formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    }).format(timestamp)
  }
</script>

<div class="flex min-h-full flex-col gap-2" aria-label="Spec conversation">
  {#each workspaceState.specAgentResponses as response (response.id)}
    <article class="rounded-lg border bg-elevated px-3 py-2.5">
      <div class="mb-2 flex items-center justify-between gap-2">
        <span class="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
          <MessageSquareText size={12} class="shrink-0 text-accent" />
          Agent
        </span>
        <time class="shrink-0 text-[10px] tabular-nums text-dimmed">
          {formatTime(response.createdAt)}
        </time>
      </div>
      <MarkdownView text={response.content} class="text-xs leading-relaxed" />
    </article>
  {:else}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 px-3 py-10 text-center">
      <MessageSquareText size={20} class="text-dimmed" />
      <p class="text-xs font-medium text-muted">No agent response yet</p>
      <p class="text-[11px] leading-relaxed text-dimmed">
        The planning conversation will appear here as the spec develops.
      </p>
    </div>
  {/each}
</div>
