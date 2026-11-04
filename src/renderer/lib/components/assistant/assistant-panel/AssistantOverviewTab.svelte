<script lang="ts">
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import AssistantIcon, {
    type AssistantIconMark
  } from '$lib/components/icons/cio/AssistantIcon.svelte'
  import CardButton from '$lib/components/shared/CardButton.svelte'
  import CardFoot from '$lib/components/shared/CardFoot.svelte'
  import type { AssistantPanelTab } from '$lib/stores/context-sidebar-types'
  import { formatDateTimeWithWeekday } from '$shared/date-time-format'
  import type { FollowUpNotice } from '$shared/follow-up'

  /**
   * The panel's opening section: a table of contents, not a second copy of every
   * tab. Each line is one door, so the reader sees what the assistant holds and
   * picks the section to open. The run counts are the one exception: they are the
   * state of the clock, which no other tab reads at a glance.
   */
  interface Props {
    scheduled: boolean
    lastRunLabel: string
    lastSuccessLabel: string
    nextRunLabel: string
    running: boolean
    knowledgeComplete: boolean
    sectionCount: number
    scheduleLabel: string
    wakes: readonly FollowUpNotice[]
    connectionCount: number
    connectionProblems: number
    agentsComplete: boolean
    agentCount: number
    reportingBrief: string
    deliveryReady: boolean
    missedCount: number
    runIssueCount: number
    onRunNow: () => void
    onSelect: (tab: AssistantPanelTab) => void
  }

  let {
    scheduled,
    lastRunLabel,
    lastSuccessLabel,
    nextRunLabel,
    running,
    knowledgeComplete,
    sectionCount,
    scheduleLabel,
    wakes,
    connectionCount,
    connectionProblems,
    agentsComplete,
    agentCount,
    reportingBrief,
    deliveryReady,
    missedCount,
    runIssueCount,
    onRunNow,
    onSelect
  }: Props = $props()
</script>

{#snippet glanceRow(args: {
  title: string
  detail: string
  target: AssistantPanelTab
  icon: AssistantIconMark
  warn?: boolean
})}
  <!--
    The All tab is a table of contents, not a second copy of every section, so
    each line is one door: what the section holds and a way in. The warn line
    wears the missed-run ink on its left edge, which is the only colour an
    assistant surface spends on a problem.
  -->
  <button
    type="button"
    class="flex w-full items-center gap-2.5 border border-border border-l-2 bg-surface px-2.5 py-2 text-left transition-colors hover:bg-elevated"
    style={args.warn
      ? 'border-left-color: var(--color-missed)'
      : 'border-left-color: var(--color-border)'}
    title="Open {args.title}"
    aria-label="Open the {args.title} section"
    onclick={() => onSelect(args.target)}
  >
    <span class="flex h-7 w-7 shrink-0 items-center justify-center bg-elevated text-foreground">
      <AssistantIcon mark={args.icon} size={16} />
    </span>
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-[0.75rem] font-semibold text-foreground">{args.title}</span>
      <span class="text-[0.625rem] leading-relaxed text-muted">{args.detail}</span>
    </span>
    <span class="shrink-0 text-[0.5625rem] tracking-wide text-dimmed uppercase">Open</span>
  </button>
{/snippet}

<div class="flex flex-col gap-3 p-3">
  {#if scheduled}
    <div class="flex flex-col border border-border bg-surface">
      <dl class="flex flex-wrap gap-x-5 gap-y-2 p-3">
        <div class="flex flex-col gap-0.5">
          <dt
            class="text-[0.5625rem] tracking-wide text-dimmed uppercase"
            title="The last time a run was dispatched"
          >
            Last run
          </dt>
          <dd class="text-[0.75rem] text-foreground">{lastRunLabel}</dd>
        </div>
        <div class="flex flex-col gap-0.5">
          <dt
            class="text-[0.5625rem] tracking-wide text-dimmed uppercase"
            title="The last time a run finished successfully"
          >
            Last success
          </dt>
          <dd class="text-[0.75rem] text-foreground">{lastSuccessLabel}</dd>
        </div>
        <div class="flex flex-col gap-0.5">
          <dt
            class="text-[0.5625rem] tracking-wide text-dimmed uppercase"
            title="The next time this assistant is due to run"
          >
            Next run
          </dt>
          <dd class="text-[0.75rem] text-foreground">{nextRunLabel}</dd>
        </div>
      </dl>
      <CardFoot>
        {#snippet left()}
          <p class="text-[0.6875rem] leading-relaxed text-muted">
            {knowledgeComplete
              ? 'Run a task now without waiting for the schedule.'
              : 'Save the assistant instructions first.'}
          </p>
        {/snippet}
        {#snippet right()}
          <CardButton
            label="Run now"
            title="Run a task now, even while the assistant is paused"
            icon={CioUndo}
            variant="primary"
            loading={running}
            disabled={running || !knowledgeComplete}
            onclick={onRunNow}
          />
        {/snippet}
      </CardFoot>
    </div>
  {/if}

  <ul class="flex flex-col gap-2">
    <li>
      {@render glanceRow({
        title: 'Behaviour',
        icon: 'knowledge',
        detail: knowledgeComplete
          ? `${sectionCount} section${sectionCount === 1 ? '' : 's'} · ${scheduleLabel}`
          : 'No behavior yet. Describe the assistant to the agent in its task.',
        target: 'behaviour',
        warn: !knowledgeComplete
      })}
    </li>
    <li>
      {@render glanceRow({
        title: 'Schedule',
        icon: 'run',
        detail: scheduled ? scheduleLabel : 'Runs on demand.',
        target: 'schedule'
      })}
    </li>
    <li>
      {@render glanceRow({
        title: 'Scheduled wakes',
        icon: 'run',
        detail:
          wakes.length === 0
            ? 'No thread wakes itself.'
            : `${wakes.length} ${wakes.length === 1 ? 'thread wakes' : 'threads wake'} itself · next ${formatDateTimeWithWeekday(wakes[0].dueAt)}${wakes[0].paused ? ' (on hold)' : ''}.`,
        target: 'wakes'
      })}
    </li>
    <li>
      {@render glanceRow({
        title: 'Reporting',
        icon: 'assistant',
        detail: reportingBrief,
        target: 'reporting',
        warn: !deliveryReady
      })}
    </li>
    <li>
      {@render glanceRow({
        title: 'Connections',
        icon: 'connection',
        detail:
          connectionCount === 0
            ? 'No connections yet.'
            : connectionProblems === 0
              ? `${connectionCount} connected and ready.`
              : `${connectionProblems} of ${connectionCount} need setup.`,
        target: 'connections',
        warn: connectionProblems > 0
      })}
    </li>
    <li>
      {@render glanceRow({
        title: 'Agents',
        icon: 'agent',
        detail: agentsComplete
          ? `${agentCount} models: a primary and its fallbacks.`
          : 'No model set. Add a primary and fallbacks on the Agents tab.',
        target: 'agents',
        warn: !agentsComplete
      })}
    </li>
    {#if scheduled || missedCount + runIssueCount > 0}
      <li>
        {@render glanceRow({
          title: 'Issues',
          icon: 'run',
          detail:
            missedCount + runIssueCount === 0
              ? 'Nothing needs attention.'
              : `${missedCount} missed · ${runIssueCount} run issue${runIssueCount === 1 ? '' : 's'}.`,
          target: 'issues',
          warn: missedCount + runIssueCount > 0
        })}
      </li>
    {/if}
  </ul>
</div>
