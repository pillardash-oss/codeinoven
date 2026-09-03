<script lang="ts">
  import {
    ArrowLeft,
    Bot,
    CircleX,
    ExternalLink,
    GitBranch,
    Loader2,
    PackageCheck,
    RefreshCw,
    Terminal
  } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import { openInBrowser } from '$lib/open-in-browser'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import type {
    GitHubDeploymentJob,
    GitHubDeploymentJobLog,
    GitHubWorkflowRun
  } from '$shared/types'

  interface Props {
    projectId: string
    identity: { owner: string; repo: string }
    run: GitHubWorkflowRun
    onBack: () => void
    onAgentDiagnose: (
      run: GitHubWorkflowRun,
      job: GitHubDeploymentJob,
      log: GitHubDeploymentJobLog | null
    ) => void
  }

  let { projectId, identity, run, onBack, onAgentDiagnose }: Props = $props()

  let error = $state('')
  let expandedLog = $state<Record<number, boolean>>({})
  let loadingLog = $state<Record<number, boolean>>({})
  let logErrors = $state<Record<number, string>>({})
  let preparingAgent = $state(false)

  /** Detail is served from the store cache so re-entering the view is instant. */
  const cached = $derived(
    gitState.deploymentRunDetails[GitState.workflowRunKey(identity.owner, identity.repo, run.id)]
  )
  const detail = $derived(cached?.detail ?? null)
  const loading = $derived(gitState.isBusy('deployment-run-detail'))

  function isFailedJob(job: GitHubDeploymentJob): boolean {
    return (
      job.status === 'completed' &&
      job.conclusion !== 'success' &&
      job.conclusion !== 'neutral' &&
      job.conclusion !== 'skipped' &&
      job.conclusion !== 'cancelled'
    )
  }

  const failedJob = $derived((detail?.jobs ?? []).find(isFailedJob) ?? null)

  function cachedLog(jobId: number): GitHubDeploymentJobLog | null {
    return (
      gitState.deploymentLogs[GitState.deploymentLogKey(identity.owner, identity.repo, jobId)]
        ?.log ?? null
    )
  }

  /** Cached logs for the jobs currently expanded — non-null for markup safety. */
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
    if (!(reason instanceof Error)) return 'Workflow run details could not be loaded.'
    return reason.message
      .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
      .replace(/^Error:\s*/u, '')
  }

  async function loadDetail(force = false): Promise<void> {
    error = ''
    try {
      const loaded = await gitState.ensureWorkflowRunDetail(
        projectId,
        identity.owner,
        identity.repo,
        run.id,
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
        [job.id]: reason instanceof Error ? reason.message : 'The log could not be loaded.'
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
      onAgentDiagnose(detail?.run ?? run, job, cachedLog(job.id))
    } finally {
      preparingAgent = false
    }
  }

  onMount(() => {
    void loadDetail()
  })

  function runTone(): string {
    if (run.status !== 'completed') return 'bg-warning/10 text-warning'
    if (run.conclusion === 'success') return 'bg-success/10 text-success'
    if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') {
      return 'bg-elevated text-dimmed'
    }
    return 'bg-danger/10 text-danger'
  }

  function runLabel(): string {
    if (run.status !== 'completed') return run.status.replace('_', ' ')
    return run.conclusion ?? 'completed'
  }

  function jobTone(job: GitHubDeploymentJob): string {
    if (job.status !== 'completed') return 'bg-warning/10 text-warning'
    if (job.conclusion === 'success') return 'bg-success/10 text-success'
    if (
      job.conclusion === 'skipped' ||
      job.conclusion === 'neutral' ||
      job.conclusion === 'cancelled'
    ) {
      return 'bg-elevated text-dimmed'
    }
    return 'bg-danger/10 text-danger'
  }

  function stepTone(step: { status: string; conclusion: string | null }): string {
    if (step.status !== 'completed') return 'text-warning'
    if (step.conclusion === 'success') return 'text-success'
    if (
      step.conclusion === 'skipped' ||
      step.conclusion === 'neutral' ||
      step.conclusion === 'cancelled'
    ) {
      return 'text-dimmed'
    }
    return 'text-danger'
  }

  function stepGlyph(step: { status: string; conclusion: string | null }): string {
    if (step.status !== 'completed') return '•'
    if (step.conclusion === 'success') return '✓'
    if (
      step.conclusion === 'skipped' ||
      step.conclusion === 'neutral' ||
      step.conclusion === 'cancelled'
    ) {
      return '·'
    }
    return '✕'
  }

  function jobSummary(job: GitHubDeploymentJob): string {
    const started = Date.parse(job.startedAt)
    const completed = job.completedAt ? Date.parse(job.completedAt) : null
    if (!Number.isFinite(started)) return ''
    if (completed !== null && Number.isFinite(completed)) {
      const seconds = Math.max(0, Math.floor((completed - started) / 1000))
      if (seconds < 60) return `${seconds}s`
      return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    }
    return 'running'
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <!-- Header -->
  <div class="shrink-0 border-b border-border px-3 py-2">
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Back to deployment activity"
        aria-label="Back to deployment activity"
        onclick={onBack}
      >
        <ArrowLeft size={13} />
      </button>
      <PackageCheck size={12} class="shrink-0 text-muted" />
      <span class="min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-foreground">
        {run.displayTitle}
      </span>
      <span
        class={[
          'shrink-0 rounded px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide',
          runTone()
        ]}
      >
        {runLabel()}
      </span>
      <button
        type="button"
        class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-50"
        title="Refresh workflow run"
        aria-label="Refresh workflow run"
        disabled={loading}
        onclick={() => void loadDetail(true)}
      >
        <RefreshCw size={12} class={loading ? 'animate-spin' : ''} />
      </button>
      {#if run.url}
        <button
          type="button"
          class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Open workflow run on GitHub"
          aria-label="Open workflow run on GitHub"
          onclick={() => void openInBrowser(run.url)}
        >
          <ExternalLink size={13} />
        </button>
      {/if}
    </div>
    <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.5625rem] text-dimmed">
      <span>{run.name} #{run.runNumber}</span>
      {#if run.event}
        <span>{run.event}</span>
      {/if}
      {#if run.branch}
        <span class="flex items-center gap-1">
          <GitBranch size={9} class="shrink-0" />
          <span class="max-w-32 truncate font-mono">{run.branch}</span>
        </span>
      {/if}
      {#if run.headSha}
        <span class="font-mono">{run.headSha.slice(0, 7)}</span>
      {/if}
      {#if run.actorLogin}
        <span>{run.actorLogin}</span>
      {/if}
      {#if run.createdAt}
        <span>{relativeTime(run.createdAt)}</span>
      {/if}
      {#if failedJob}
        <button
          type="button"
          class="ml-auto flex h-6 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[0.5625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-40"
          title={`Review failed job ${failedJob.name} with an agent`}
          disabled={preparingAgent || loading}
          onclick={() => void reviewWithAgent(failedJob)}
        >
          {#if preparingAgent}
            <Loader2 size={11} class="animate-spin" />
          {:else}
            <Bot size={11} />
          {/if}
          Review
        </button>
      {/if}
    </div>
  </div>

  {#if loading && !detail}
    <div class="flex flex-1 items-center justify-center gap-2 text-[0.6875rem] text-dimmed">
      <Loader2 size={13} class="animate-spin" />
      Loading workflow run details
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
      <!-- Jobs -->
      <section>
        <div class="flex items-center gap-2 bg-surface px-3 py-1.5">
          <Terminal size={11} class="text-dimmed" />
          <h3 class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">Jobs</h3>
          <span class="ml-auto text-[0.5625rem] tabular-nums text-dimmed">{detail.jobs.length}</span>
        </div>
        {#if detail.jobs.length === 0}
          <p class="px-3 py-5 text-center text-[0.625rem] text-dimmed">No job details are available.</p>
        {:else}
          <div class="divide-y divide-border">
            {#each detail.jobs as job (job.id)}
              <div class="px-3 py-2">
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center gap-2 text-left"
                  onclick={() => toggleJobLog(job)}
                >
                  <span
                    class="shrink-0 text-[0.5625rem] font-bold leading-none {stepTone(job)}"
                    aria-hidden="true"
                  >
                    {job.status !== 'completed' ? '•' : job.conclusion === 'success' ? '✓' : '✕'}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-foreground">
                    {job.name}
                  </span>
                  <span
                    class={[
                      'shrink-0 rounded px-1.5 py-0.5 text-[0.5rem] font-semibold uppercase',
                      jobTone(job)
                    ]}
                  >
                    {job.status !== 'completed'
                      ? job.status.replace('_', ' ')
                      : (job.conclusion ?? 'completed')}
                  </span>
                  <span class="shrink-0 text-[0.5625rem] tabular-nums text-dimmed">
                    {jobSummary(job)}
                  </span>
                </button>

                {#if job.steps.length > 0}
                  <ul class="mt-1.5 space-y-0.5 border-l border-border pl-3">
                    {#each job.steps as step (step.number)}
                      <li class="flex items-center gap-1.5 text-[0.5625rem]">
                        <span
                          class="w-2 shrink-0 text-center text-[0.5rem] leading-none {stepTone(step)}"
                          aria-hidden="true"
                        >
                          {stepGlyph(step)}
                        </span>
                        <span class="truncate text-muted">{step.name}</span>
                        <span class="ml-auto shrink-0 text-dimmed">
                          {step.status !== 'completed'
                            ? step.status.replace('_', ' ')
                            : (step.conclusion ?? 'completed')}
                        </span>
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
                            onclick={() => void openInBrowser(job.url)}
                          >
                            <ExternalLink size={10} />
                            Follow live on GitHub
                          </button>
                        {/if}
                      </div>
                    {:else if loadingLog[job.id]}
                      <div class="flex items-center gap-2 py-2 text-[0.625rem] text-dimmed">
                        <Loader2 size={11} class="animate-spin" />
                        Loading log…
                      </div>
                    {:else if logErrors[job.id]}
                      <p class="rounded-md bg-danger/10 px-2 py-1.5 text-[0.625rem] text-danger">
                        {logErrors[job.id]}
                      </p>
                    {:else if logs[job.id]}
                      <div class="relative">
                        <pre
                          class="max-h-64 overflow-auto rounded-md bg-black/5 p-2 font-mono text-[0.5625rem] leading-relaxed text-muted dark:bg-black/30">{logs[
                            job.id
                          ].log}</pre>
                        {#if logs[job.id].truncated}
                          <p class="mt-1 text-[0.5625rem] text-dimmed">
                            Log truncated — {job.name} may exceed the in-app limit.
                          </p>
                        {/if}
                      </div>
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
