<script lang="ts">
  import { Bot, ChevronRight, ExternalLink, Loader2, Rocket, ShieldCheck } from '@lucide/svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { gitState } from '$lib/stores/git.svelte'
  import type { GitHubDeploymentJobLog, PullRequestCheck, PullRequestChecks } from '$shared/types'
  import GitJobLogView from './GitJobLogView.svelte'
  import RerunRunMenu from './RerunRunMenu.svelte'
  import { jobForCheck } from './pr-check-job'
  import {
    checkClass,
    checkFailed,
    checkIcon,
    checkKey,
    checkLogMessage,
    checkStateLabel
  } from './git-pull-request-detail-format'

  interface Props {
    projectId: string
    identity: { owner: string; repo: string }
    checks: PullRequestChecks | null
    /** Reveal a GitHub Actions check in the in-app Deployments tab. */
    onOpenWorkflowRun: (runId: number) => void
    /** Hand a failed check to an agent to diagnose and report on. */
    onAssignCheck: (check: PullRequestCheck) => Promise<void>
    /** Reload the bundle after a re-run of one of the checks. */
    onRefresh: () => Promise<void>
  }

  let { projectId, identity, checks, onOpenWorkflowRun, onAssignCheck, onRefresh }: Props = $props()

  /** Which check's log is open, keyed the way the checks list is keyed. */
  let expandedCheck = $state<string | null>(null)
  let checkLogs = $state<Record<string, GitHubDeploymentJobLog>>({})
  let checkLogErrors = $state<Record<string, string>>({})
  let loadingCheckLogs = $state<Record<string, boolean>>({})
  /** The check an assignment is being prepared for, keyed the same way. */
  let assigningCheck = $state<string | null>(null)

  /**
   * The job behind a check. Actions names the job in the check's `details_url`,
   * which is exact even for one leg of a matrix run; when the provider only gives
   * the run, the job is matched by name so the wrong leg's log is never shown.
   *
   * The run detail is read only when the check does not already name a job, since
   * this is a log toggle and the answer it needs is already in hand otherwise.
   */
  async function resolveCheckJobId(check: PullRequestCheck): Promise<number | null> {
    if (check.jobId !== null) return check.jobId
    if (check.workflowRunId === null) return null
    const run = await gitState
      .ensureWorkflowRunDetail(projectId, identity.owner, identity.repo, check.workflowRunId)
      .catch(() => null)
    return jobForCheck(run, check)?.id ?? null
  }

  /**
   * Prepare an assignment for one check.
   *
   * Preparing takes the time (the run, the job, the log) and ends by opening the
   * new thread, so exactly one runs at a time: two in flight would race for the
   * open thread and the reader would lose the first draft. The clicked row is the
   * row that spins; the others wait on it rather than starting a second.
   */
  async function assignCheck(check: PullRequestCheck): Promise<void> {
    if (assigningCheck !== null) return
    assigningCheck = checkKey(check)
    try {
      await onAssignCheck(check)
    } finally {
      assigningCheck = null
    }
  }

  async function toggleCheckLog(check: PullRequestCheck): Promise<void> {
    const key = checkKey(check)
    if (expandedCheck === key) {
      expandedCheck = null
      return
    }
    expandedCheck = key
    if (checkLogs[key] || loadingCheckLogs[key]) return
    loadingCheckLogs = { ...loadingCheckLogs, [key]: true }
    checkLogErrors = { ...checkLogErrors, [key]: '' }
    try {
      const jobId = await resolveCheckJobId(check)
      if (jobId === null) {
        checkLogErrors = {
          ...checkLogErrors,
          [key]: 'This check does not name a job, so its log has to be read on GitHub.'
        }
        return
      }
      const log = await gitState.ensureDeploymentJobLog(
        projectId,
        identity.owner,
        identity.repo,
        jobId
      )
      if (log) checkLogs = { ...checkLogs, [key]: log }
    } catch (reason) {
      checkLogErrors = { ...checkLogErrors, [key]: checkLogMessage(reason) }
    } finally {
      loadingCheckLogs = { ...loadingCheckLogs, [key]: false }
    }
  }
</script>

{#if !checks || checks.checks.length === 0}
  <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
    <ShieldCheck size={18} class="text-dimmed" />
    <p class="text-[0.6875rem] leading-relaxed text-dimmed">
      No checks have reported on this branch.
    </p>
  </div>
{:else}
  {#each checks.checks as check (checkKey(check))}
    {@const Icon = checkIcon(check)}
    {@const key = checkKey(check)}
    {@const runId = check.workflowRunId}
    {@const isOpen = expandedCheck === key}
    <div class="border-b border-border/50">
      <!-- The whole row is the log toggle: a check's result is only half the
           story, and the reason to open the tab is to read why it failed. -->
      <div class="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          title={isOpen ? `Hide the ${check.name} log` : `Show the ${check.name} log`}
          aria-expanded={isOpen}
          onclick={() => void toggleCheckLog(check)}
        >
          <ChevronRight
            size={11}
            class="shrink-0 text-dimmed transition-transform {isOpen ? 'rotate-90' : ''}"
          />
          <Icon size={12} class="shrink-0 {checkClass(check)}" />
          <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-foreground">
            {check.name}
          </span>
          <span class="shrink-0 text-[0.5625rem] text-dimmed">{checkStateLabel(check)}</span>
        </button>
        {#if checkFailed(check)}
          <!--
            A failed check is the one thing here an agent can be asked about, and the
            row is where that question occurs to the reader. The run detail and the job
            log are read when the assignment is prepared, not when the row is drawn.
          -->
          <button
            type="button"
            class="shrink-0 cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
            title="Assign this failed check to an agent to diagnose and report on"
            aria-label="Assign the {check.name} check to an agent"
            disabled={assigningCheck !== null}
            onclick={() => void assignCheck(check)}
          >
            {#if assigningCheck === key}
              <Loader2 size={12} class="animate-spin" />
            {:else}
              <Bot size={12} />
            {/if}
          </button>
        {/if}
        {#if checkFailed(check) && runId !== null}
          <!-- A failing check is a job with a problem, so the re-run lives on
               its row. GitHub only re-runs a whole run, which is why the menu
               offers "all jobs" beside "failed jobs only". -->
          <RerunRunMenu
            {projectId}
            {identity}
            {runId}
            runStatus="completed"
            hasFailedJobs
            compact
            onRerun={() => void onRefresh()}
          />
        {/if}
        {#if check.url}
          <button
            type="button"
            class="shrink-0 cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            title="Open {check.name} externally"
            aria-label="Open {check.name} externally"
            data-external-url={check.url}
            onclick={() => void openInBrowser(check.url ?? '')}
          >
            <ExternalLink size={12} />
          </button>
        {/if}
      </div>
      {#if isOpen}
        <div class="border-t border-border/50 bg-elevated/20">
          <!-- No `failedSteps` here on purpose: a check is named after its job, and
               the log's sections are named after steps, so there is nothing to match.
               The view marks the step GitHub flagged with an error in the log itself. -->
          <GitJobLogView
            log={checkLogs[key] ?? null}
            loading={loadingCheckLogs[key] === true}
            error={checkLogErrors[key] ?? ''}
            class="px-3 py-2"
          />
          {#if runId !== null}
            <div class="border-t border-border/40 px-3 py-1.5">
              <button
                type="button"
                class="flex h-6 min-w-0 cursor-pointer items-center gap-1 text-[0.625rem] font-medium text-muted transition-colors hover:text-foreground"
                title="Open this workflow run in the Deployments tab to inspect every job and step"
                onclick={() => onOpenWorkflowRun(runId)}
              >
                <Rocket size={11} class="shrink-0" />
                <span class="min-w-0 truncate">Open the full run in Deployments</span>
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
{/if}
