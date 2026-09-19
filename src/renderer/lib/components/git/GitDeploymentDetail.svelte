<script lang="ts">
  import {
    Bot,
    CircleDot,
    CircleX,
    ExternalLink,
    GitBranch,
    Loader2,
    PackageCheck,
    Terminal
  } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import { formatDurationSeconds } from '$lib/format/duration'
  import { openInBrowser } from '$lib/open-in-browser'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import { failedJobStepNames, isFailedJob } from '$shared/github-job-log'
  import GitJobLogView from './GitJobLogView.svelte'
  import RerunRunMenu from './RerunRunMenu.svelte'
  import { stateGlyph, stateGlyphClass, stateLabel } from './deployment-state'
  import type {
    GitHubDeployment,
    GitHubDeploymentJob,
    GitHubDeploymentJobLog,
    GitHubDeploymentStatus,
    GitHubWorkflowRun
  } from '$shared/types'

  interface Props {
    projectId: string
    identity: { owner: string; repo: string }
    deployment: GitHubDeployment
    onAgentDiagnose: (
      deployment: GitHubDeployment,
      run: GitHubWorkflowRun | null,
      job: GitHubDeploymentJob,
      log: GitHubDeploymentJobLog | null
    ) => void
  }

  let { projectId, identity, deployment, onAgentDiagnose }: Props = $props()

  let error = $state('')
  let expandedLog = $state<Record<number, boolean>>({})
  let loadingLog = $state<Record<number, boolean>>({})
  let logErrors = $state<Record<number, string>>({})
  let preparingAgent = $state(false)

  /** Detail is served from the store cache so re-entering the view is instant. */
  const cached = $derived(
    gitState.deploymentDetails[
      GitState.deploymentDetailKey(identity.owner, identity.repo, deployment.id)
    ]
  )
  const detail = $derived(cached?.detail ?? null)
  const loading = $derived(gitState.isBusy('deployment-detail'))

  /** GitHub returns newest-first; the current status is the first entry. */
  const statusHistory = $derived(detail?.statuses ?? [])

  function cachedLog(jobId: number): GitHubDeploymentJobLog | null {
    return (
      gitState.deploymentLogs[GitState.deploymentLogKey(identity.owner, identity.repo, jobId)]
        ?.log ?? null
    )
  }

  /** The job whose failure the agent button acts on, when the deployment has one. */
  const failedJob = $derived((detail?.jobs ?? []).find(isFailedJob) ?? null)

  /** Cached logs for the jobs currently expanded   non-null for markup safety. */
  const logs = $derived.by(() => {
    const result: Record<number, GitHubDeploymentJobLog> = {}
    for (const key of Object.keys(expandedLog)) {
      if (!expandedLog[Number(key)]) continue
      const cached = cachedLog(Number(key))
      if (cached) result[Number(key)] = cached
    }
    return result
  })

  function message(reason: unknown): string {
    if (!(reason instanceof Error)) return 'Deployment details could not be loaded.'
    return reason.message
      .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
      .replace(/^Error:\s*/u, '')
  }

  async function loadDetail(force = false): Promise<void> {
    error = ''
    try {
      const loaded = await gitState.ensureDeploymentDetail(
        projectId,
        identity.owner,
        identity.repo,
        deployment.id,
        force
      )
      for (const job of loaded?.jobs ?? []) {
        if (expandedLog[job.id] && job.status === 'completed' && !cachedLog(job.id)) {
          void loadJobLog(job)
        }
      }
    } catch (reason) {
      error = message(reason)
    }
  }

  async function loadJobLog(job: GitHubDeploymentJob, force = false): Promise<void> {
    if (job.status !== 'completed' || loadingLog[job.id]) return
    loadingLog = { ...loadingLog, [job.id]: true }
    logErrors = { ...logErrors, [job.id]: '' }
    try {
      await gitState.ensureDeploymentJobLog(projectId, identity.owner, identity.repo, job.id, force)
    } catch (reason) {
      logErrors = {
        ...logErrors,
        [job.id]: /Provider returned HTTP 404/u.test(String((reason as Error)?.message ?? ''))
          ? 'No log is available for this job yet.'
          : reason instanceof Error
            ? reason.message
            : 'The log could not be loaded.'
      }
    } finally {
      loadingLog = { ...loadingLog, [job.id]: false }
    }
  }

  function toggleJobLog(job: GitHubDeploymentJob): void {
    const open = !expandedLog[job.id]
    expandedLog = { ...expandedLog, [job.id]: open }
    if (open && job.status === 'completed' && !cachedLog(job.id) && !loadingLog[job.id]) {
      void loadJobLog(job)
    }
  }

  /** Load one failed job's evidence before opening its agent review thread. */
  async function reviewWithAgent(job: GitHubDeploymentJob): Promise<void> {
    if (preparingAgent || !isFailedJob(job)) return
    preparingAgent = true
    try {
      await gitState
        .ensureDeploymentJobLog(projectId, identity.owner, identity.repo, job.id)
        .catch(() => null)
      onAgentDiagnose(deployment, detail?.workflowRun ?? null, job, cachedLog(job.id))
    } finally {
      preparingAgent = false
    }
  }

  onMount(() => {
    void loadDetail()
  })

  function statusTone(state: string): string {
    if (state === 'success') return 'bg-success/10 text-success'
    if (state === 'failure' || state === 'error') return 'bg-danger/10 text-danger'
    if (state === 'inactive') return 'bg-elevated text-dimmed'
    return 'bg-warning/10 text-warning'
  }

  function runTone(run: { status: string; conclusion: string | null }): string {
    if (run.status !== 'completed') return 'bg-warning/10 text-warning'
    if (run.conclusion === 'success') return 'bg-success/10 text-success'
    if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') {
      return 'bg-elevated text-dimmed'
    }
    return 'bg-danger/10 text-danger'
  }

  function runLabel(run: { status: string; conclusion: string | null }): string {
    if (run.status !== 'completed') return run.status.replace('_', ' ')
    return run.conclusion ?? 'completed'
  }

  function jobSummary(job: GitHubDeploymentJob): string {
    const started = Date.parse(job.startedAt)
    const completed = job.completedAt ? Date.parse(job.completedAt) : null
    if (!Number.isFinite(started)) return ''
    if (completed !== null && Number.isFinite(completed)) {
      const seconds = Math.max(0, Math.floor((completed - started) / 1000))
      return formatDurationSeconds(seconds)
    }
    return 'running'
  }

  function statusSummary(status: GitHubDeploymentStatus): string {
    return status.description || status.state.replace('_', ' ')
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <!--
    No header row: the panel's action row carries the back control and names this
    deployment, and its own refresh and external link cover the two this page used
    to repeat.
  -->
  {#if deployment.description}
    <p class="shrink-0 border-b border-border px-3 py-1.5 text-[0.625rem] text-muted">
      {deployment.description}
    </p>
  {/if}

  {#if loading && !detail}
    <div class="flex flex-1 items-center justify-center gap-2 text-[0.6875rem] text-dimmed">
      <Loader2 size={13} class="animate-spin" />
      Loading deployment details
    </div>
  {:else if error && !detail}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <CircleX size={20} class="text-danger" />
      <p class="max-w-[42ch] text-[0.625rem] leading-relaxed text-dimmed">{error}</p>
      <button
        type="button"
        class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-foreground hover:bg-elevated"
        onclick={() => void loadDetail(true)}
      >
        Try again
      </button>
    </div>
  {:else if detail}
    <div class="min-h-0 flex-1 overflow-y-auto">
      <!-- Status history -->
      <section class="border-b border-border">
        <div class="flex items-center gap-2 bg-surface px-3 py-1.5">
          <CircleDot size={11} class="text-dimmed" />
          <h3 class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
            Status history
          </h3>
          <span class="ml-auto text-[0.5625rem] tabular-nums text-dimmed"
            >{statusHistory.length}</span
          >
        </div>
        {#if statusHistory.length === 0}
          <p class="px-3 py-5 text-center text-[0.625rem] text-dimmed">
            No status updates recorded.
          </p>
        {:else}
          <div class="divide-y divide-border">
            {#each statusHistory as status, index (index)}
              <div class="flex items-start gap-2.5 px-3 py-2 {index === 0 ? 'bg-success/5' : ''}">
                <span
                  class={[
                    'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[0.5rem] font-semibold uppercase',
                    statusTone(status.state)
                  ]}
                >
                  {status.state}
                </span>
                <div class="min-w-0 flex-1">
                  <p class="text-[0.625rem] leading-relaxed text-muted">{statusSummary(status)}</p>
                  <div class="mt-0.5 flex items-center gap-2 text-[0.5625rem] text-dimmed">
                    {#if index === 0}
                      <span class="font-medium text-muted">Latest</span>
                    {/if}
                    <span>{relativeTime(status.createdAt)}</span>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <!-- Linked workflow run -->
      <section class="border-b border-border">
        <div class="flex items-center gap-2 bg-surface px-3 py-1.5">
          <PackageCheck size={11} class="text-dimmed" />
          <h3 class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
            Workflow run
          </h3>
        </div>
        {#if detail.workflowRun}
          {@const run = detail.workflowRun}
          <div class="px-3 py-2">
            <div class="flex items-center gap-2">
              <p class="min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-foreground">
                {run.displayTitle}
              </p>
              <span
                class={[
                  'shrink-0 rounded px-1.5 py-0.5 text-[0.5rem] font-semibold uppercase',
                  runTone(run)
                ]}
              >
                {runLabel(run)}
              </span>
              {#if run.url}
                <button
                  type="button"
                  class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  title="Open workflow run on GitHub"
                  aria-label="Open workflow run on GitHub"
                  data-external-url={run.url}
                  onclick={() => void openInBrowser(run.url)}
                >
                  <ExternalLink size={11} />
                </button>
              {/if}
            </div>
            <div
              class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.5625rem] text-dimmed"
            >
              <span>{run.name} #{run.runNumber}</span>
              <span>{run.event}</span>
              {#if run.branch}
                <span class="flex items-center gap-1">
                  <GitBranch size={9} class="shrink-0" />
                  <span class="max-w-28 truncate font-mono">{run.branch}</span>
                </span>
              {/if}
              <span class="font-mono">{run.headSha.slice(0, 7)}</span>
              {#if run.actorLogin}
                <span>{run.actorLogin}</span>
              {/if}
            </div>
          </div>
        {:else}
          <p class="px-3 py-5 text-center text-[0.625rem] text-dimmed">
            No linked workflow run found.
          </p>
        {/if}
      </section>

      <!-- Jobs -->
      <section>
        <div class="flex items-center gap-2 bg-surface px-3 py-1.5">
          <Terminal size={11} class="text-dimmed" />
          <h3 class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">Jobs</h3>
          <span class="ml-auto text-[0.5625rem] tabular-nums text-dimmed">{detail.jobs.length}</span
          >
          {#if failedJob}
            <!--
              The failed job's handoff lives with the jobs it is about: it used to
              sit in the header row, which this page no longer has.
            -->
            <button
              type="button"
              class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-xs border border-border px-2 text-[0.5625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-40"
              title={`Review failed job ${failedJob.name} with an agent`}
              disabled={preparingAgent || loading}
              onclick={() => void reviewWithAgent(failedJob)}
            >
              {#if preparingAgent}
                <Loader2 size={11} class="animate-spin" />
              {:else}
                <Bot size={11} />
              {/if}
              Review failed job
            </button>
          {/if}
          {#if detail.workflowRun}
            <RerunRunMenu
              {projectId}
              {identity}
              runId={detail.workflowRun.id}
              runStatus={detail.workflowRun.status}
              hasFailedJobs={failedJob !== null}
              onRerun={() => void loadDetail(true)}
            />
          {/if}
        </div>
        {#if detail.jobs.length === 0}
          <p class="px-3 py-5 text-center text-[0.625rem] text-dimmed">
            No job details are available.
          </p>
        {:else}
          <div class="divide-y divide-border">
            {#each detail.jobs as job (job.id)}
              {@const jobState = job.conclusion ?? job.status}
              {@const JobGlyph = stateGlyph(jobState)}
              <div class="px-3 py-2">
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center gap-2 text-left"
                  onclick={() => toggleJobLog(job)}
                >
                  <!--
                    The status leads the row, the way the Changes view leads a file
                    with its status mark: one icon before the name, rather than a
                    badge holding its own space at the end of the row.
                  -->
                  <JobGlyph
                    size={12}
                    class="shrink-0 {stateGlyphClass(jobState)}"
                    role="img"
                    aria-label={stateLabel(jobState)}
                    title={stateLabel(jobState)}
                  />
                  <span
                    class="min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-foreground"
                    title={job.name}
                  >
                    {job.name}
                  </span>
                  <span class="shrink-0 text-[0.5625rem] tabular-nums text-dimmed">
                    {jobSummary(job)}
                  </span>
                </button>

                {#if job.steps.length > 0}
                  <ul class="mt-1.5 space-y-0.5 border-l border-border pl-3">
                    {#each job.steps as step (step.number)}
                      {@const stepState = step.conclusion ?? step.status}
                      {@const StepGlyph = stateGlyph(stepState)}
                      <li class="flex items-center gap-1.5 text-[0.5625rem]">
                        <StepGlyph
                          size={10}
                          class="shrink-0 {stateGlyphClass(stepState)}"
                          role="img"
                          aria-label={stateLabel(stepState)}
                          title={stateLabel(stepState)}
                        />
                        <span class="truncate text-muted" title={step.name}>{step.name}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}

                {#if expandedLog[job.id]}
                  <div class="mt-2">
                    {#if job.status !== 'completed'}
                      <div
                        class="rounded-md bg-elevated px-2 py-2 text-[0.625rem] leading-relaxed text-dimmed"
                      >
                        <p>Logs become available here after this job finishes.</p>
                        {#if job.url}
                          <button
                            type="button"
                            class="mt-1.5 flex h-6 cursor-pointer items-center gap-1 text-[0.5625rem] font-medium text-foreground hover:text-primary"
                            title="Follow this running job on GitHub"
                            data-external-url={job.url}
                            onclick={() => void openInBrowser(job.url)}
                          >
                            <ExternalLink size={10} />
                            Follow live on GitHub
                          </button>
                        {/if}
                      </div>
                    {:else if loadingLog[job.id] || logErrors[job.id] || logs[job.id]}
                      <GitJobLogView
                        log={logs[job.id] ?? null}
                        loading={loadingLog[job.id] === true}
                        error={logErrors[job.id] ?? ''}
                        failedSteps={failedJobStepNames(job)}
                        class="rounded-md bg-black/5 p-2 dark:bg-black/30"
                      />
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>
