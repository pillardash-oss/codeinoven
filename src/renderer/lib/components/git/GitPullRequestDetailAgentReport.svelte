<script lang="ts">
  import { Bot, ExternalLink, Send } from '@lucide/svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import type { PrAgentReport, PullRequestSummary } from '$shared/types'

  /**
   * The agent assignments on one pull request.
   *
   * A pull request can hold several at once: a triage, then one for each comment
   * handed to an agent. So this is a list of reports rather than a single one, and
   * the rows name what each assignment was asked to do while the body below is the
   * one being read.
   *
   * Nothing here starts an agent. The row menu and this view's own button do that,
   * and the report appears here when the agent writes it. That separation is why the
   * empty state explains what an assignment is instead of hiding it behind an icon.
   */
  interface Props {
    number: number
    summary: PullRequestSummary
    /** Every assignment on this pull request, newest first. */
    reports: PrAgentReport[]
    /** The assignment being read, or null when there is none yet. */
    agentReport: PrAgentReport | null
    /** True while the report is being posted as a pull request comment. */
    posting: boolean
    onOpenThread: (threadId: string) => void
    onAssignAgent: (pr: PullRequestSummary) => void
    onSelectReport: (id: string) => void
    onPostReport: () => void
  }

  let {
    number,
    summary,
    reports,
    agentReport,
    posting,
    onOpenThread,
    onAssignAgent,
    onSelectReport,
    onPostReport
  }: Props = $props()

  /**
   * When an assignment was last written, or when it was made if it has not written
   * anything yet. A running assignment is the common case here, and "assigned 2
   * minutes ago" is the honest label for it.
   */
  function assignmentTime(report: PrAgentReport): number | null {
    return report.updatedAt ?? report.createdAt
  }

  /** What one row says on hover: what it addresses, and where its report lives. */
  function assignmentTitle(report: PrAgentReport): string {
    return `${report.title} · ${report.path}`
  }

  const rowClass =
    'flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left text-[0.625rem] transition-colors'
</script>

{#if reports.length === 0}
  <div class="flex flex-col items-center gap-3 px-6 py-10 text-center">
    <Bot size={18} class="text-dimmed" />
    <p class="text-[0.6875rem] leading-relaxed text-muted">
      No agent assignment yet. Assigning an agent opens a thread where it triages this pull request
      in a worktree of its own, tests it when that is warranted, and writes its findings to
      <span class="font-mono">.cio/git/pr/{number}/review-&lt;id&gt;.md</span>. The report shows up
      here, and nothing is pushed, merged, or closed without your go-ahead.
    </p>
    <button
      type="button"
      class="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover"
      onclick={() => onAssignAgent(summary)}
    >
      <Bot size={12} class="shrink-0" />
      <span class="min-w-0 truncate">Assign an agent</span>
    </button>
  </div>
{:else}
  <div class="border-b border-border/60 px-2 py-1.5">
    <ul class="flex flex-col gap-0.5">
      {#each reports as report (report.id)}
        {@const selected = report.id === agentReport?.id}
        {@const written = assignmentTime(report)}
        <li class="flex items-center gap-1">
          <button
            type="button"
            class="{rowClass} {selected
              ? 'bg-primary/10 text-foreground'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            title={assignmentTitle(report)}
            aria-pressed={selected}
            onclick={() => onSelectReport(report.id)}
          >
            <Bot
              size={11}
              class="shrink-0 {report.content.trim() ? 'text-primary' : 'text-dimmed'}"
            />
            <span class="min-w-0 flex-1 truncate">{report.title}</span>
            {#if written}
              <span class="shrink-0 text-[0.5625rem] tabular-nums text-dimmed"
                >{relativeTime(written)}</span
              >
            {/if}
          </button>
          {#if report.threadId}
            <button
              type="button"
              class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              title="Open the thread this assignment runs in"
              aria-label="Open the thread this assignment runs in"
              onclick={() => onOpenThread(report.threadId ?? '')}
            >
              <ExternalLink size={11} />
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  </div>

  {#if agentReport?.content.trim()}
    <div class="px-3 py-2">
      <div class="mb-2 flex items-center gap-2">
        <p class="min-w-0 flex-1 truncate text-[0.5625rem] text-dimmed">
          {agentReport.path}
          {#if agentReport.updatedAt}
            · written {relativeTime(agentReport.updatedAt)}
          {/if}
        </p>
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
        This assignment has not written its report yet. It lands in the file above when the agent
        finishes, and the thread is where you can watch it work.
      </p>
      {#if agentReport?.threadId}
        <button
          type="button"
          class="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
          title="Open the thread this assignment runs in"
          onclick={() => onOpenThread(agentReport?.threadId ?? '')}
        >
          <Bot size={12} class="shrink-0" />
          <span class="min-w-0 truncate">Open agent thread</span>
        </button>
      {/if}
    </div>
  {/if}
{/if}
