<script lang="ts">
  import { Bot, Send } from '@lucide/svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import type { PrAgentReport, PullRequestSummary } from '$shared/types'

  interface Props {
    number: number
    summary: PullRequestSummary
    agentReport: PrAgentReport | null
    /** True while the report is being posted as a PR comment. */
    posting: boolean
    onOpenThread: (threadId: string) => void
    onAgentReview: (pr: PullRequestSummary) => void
    onPostReport: () => void
  }

  let { number, summary, agentReport, posting, onOpenThread, onAgentReview, onPostReport }: Props =
    $props()
</script>

{#if agentReport?.content.trim()}
  <div class="px-3 py-2">
    <div class="mb-2 flex items-center gap-2">
      <p class="flex-1 truncate text-[0.5625rem] text-dimmed">
        {agentReport.path} · {relativeTime(agentReport.updatedAt)}
      </p>
      {#if agentReport.threadId}
        <button
          type="button"
          class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Open the thread that produced this review"
          onclick={() => onOpenThread(agentReport?.threadId ?? '')}
        >
          <Bot size={12} />
          Open thread
        </button>
      {/if}
      <button
        type="button"
        class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
        title="Post this report as a comment on the pull request"
        disabled={posting}
        onclick={onPostReport}
      >
        <Send size={12} />
        Post to PR
      </button>
    </div>
    <MarkdownView text={agentReport.content} class="text-[0.6875rem] leading-relaxed" />
  </div>
{:else}
  <div class="flex flex-col items-center gap-3 px-6 py-10 text-center">
    <Bot size={18} class="text-dimmed" />
    <p class="text-[0.6875rem] leading-relaxed text-muted">
      No agent review yet. "Agent review" opens a thread where an agent checks this PR out in a
      worktree and writes its findings to <span class="font-mono"
        >.cio/git/pr/{number}/review.md</span
      >. The report shows up here when it lands.
    </p>
    <div class="flex items-center gap-2">
      {#if agentReport?.threadId}
        <button
          type="button"
          class="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
          title="Open the review thread already running for this pull request"
          onclick={() => onOpenThread(agentReport?.threadId ?? '')}
        >
          <Bot size={12} class="shrink-0" />
          <span class="min-w-0 truncate">Open review thread</span>
        </button>
      {/if}
      <button
        type="button"
        class="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover"
        onclick={() => onAgentReview(summary)}
      >
        <Bot size={12} class="shrink-0" />
        <span class="min-w-0 truncate">Start agent review</span>
      </button>
    </div>
  </div>
{/if}
