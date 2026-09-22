<script lang="ts">
  import { Bot } from '@lucide/svelte'
  import PrAgentReportCard from './PrAgentReportCard.svelte'
  import type { PrAgentReport, PullRequestSummary } from '$shared/types'

  /**
   * The agent assignments on one pull request, newest first.
   *
   * A pull request can hold several at once: a triage, then one for each comment
   * handed to an agent, so this is a list of independent cards rather than a list
   * plus one report on show. Each card carries its own fold, which is what lets a
   * reader move between them by scrolling instead of reading one enormous report
   * and losing the rest.
   *
   * Nothing here starts an agent. The row menu, a comment's own menu and the
   * empty state's button do that, and a report appears here when the agent writes
   * it. That separation is why the empty state explains what an assignment is
   * instead of hiding it behind an icon, and why no assignment button is drawn
   * once there is one: assigning again is a row menu action, and the count this
   * view used to repeat is already in the view switcher's own menu.
   */
  interface Props {
    number: number
    projectId: string
    summary: PullRequestSummary
    /** Every assignment on this pull request, newest first. */
    reports: PrAgentReport[]
    /** True while a report is being posted as a pull request comment. */
    posting: boolean
    onOpenThread: (threadId: string) => void
    onAssignAgent: (pr: PullRequestSummary) => void
    /** Show the conversation entry an assignment answered, in the reader. */
    onShowInConversation: (report: PrAgentReport) => void
    onPostReport: (report: PrAgentReport) => void
  }

  let {
    number,
    projectId,
    summary,
    reports,
    posting,
    onOpenThread,
    onAssignAgent,
    onShowInConversation,
    onPostReport
  }: Props = $props()
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
  <div class="flex flex-col gap-2 p-2">
    {#each reports as report (report.id)}
      <PrAgentReportCard
        {projectId}
        {report}
        {posting}
        {onOpenThread}
        {onShowInConversation}
        {onPostReport}
      />
    {/each}
  </div>
{/if}
