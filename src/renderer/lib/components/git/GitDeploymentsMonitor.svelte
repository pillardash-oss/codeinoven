<script lang="ts">
  import {
    CircleCheck,
    CircleDot,
    CircleX,
    Clock3,
    ExternalLink,
    GitBranch,
    Loader2,
    PackageCheck,
    RefreshCw,
    Rocket
  } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import { openInBrowser } from '$lib/open-in-browser'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import GitDeploymentDetail from './GitDeploymentDetail.svelte'
  import GitWorkflowRunDetail from './GitWorkflowRunDetail.svelte'
  import type {
    GitHubDeployment,
    GitHubDeploymentJob,
    GitHubDeploymentJobLog,
    GitHubWorkflowRun
  } from '$shared/types'

  interface Props {
    projectId: string
    identity: { owner: string; repo: string } | null
    githubConnected: boolean
    onSignIn: () => void
    requestedRunId?: number | null
    onRequestedRunOpened?: () => void
    onAgentDiagnoseRun: (
      run: GitHubWorkflowRun,
      job: GitHubDeploymentJob,
      log: GitHubDeploymentJobLog | null
    ) => void
    onAgentDiagnoseDeployment: (
      deployment: GitHubDeployment,
      run: GitHubWorkflowRun | null,
      job: GitHubDeploymentJob,
      log: GitHubDeploymentJobLog | null
    ) => void
  }

  let {
    projectId,
    identity,
    githubConnected,
    onSignIn,
    requestedRunId = null,
    onRequestedRunOpened,
    onAgentDiagnoseRun,
    onAgentDiagnoseDeployment
  }: Props = $props()

  let error = $state('')
  /** When set, the in-app deployment detail view replaces the list. */
  let selectedDeployment = $state<GitHubDeployment | null>(null)
  /** When set, the in-app workflow-run detail view replaces the list. */
  let selectedRun = $state<GitHubWorkflowRun | null>(null)
  /** Non-reactive dedupe guard for direct navigation from a PR check. */
  let openingRequestedRunId: number | null = null

  /**
   * The overview is cached in the store, so switching back to this tab renders
   * the last-fetched content instantly and revalidates in the background.
   */
  const cached = $derived(
    identity
      ? gitState.deploymentOverviews[GitState.deploymentKey(identity.owner, identity.repo)]
      : undefined
  )
  const overview = $derived(cached?.overview ?? null)
  const loading = $derived(gitState.isBusy('deployments'))

  const permissionMissing = $derived(/HTTP 40[34]|Not Found|not accessible/iu.test(error))

  function message(reason: unknown): string {
    if (!(reason instanceof Error)) return 'Deployments could not be loaded.'
    return reason.message
      .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
      .replace(/^Error:\s*/u, '')
  }

  async function load(force = false): Promise<void> {
    if (!identity || !githubConnected) return
    error = ''
    try {
      const result = await gitState.ensureDeploymentOverview(
        projectId,
        identity.owner,
        identity.repo,
        force
      )
      if (result?.accessError) error = result.accessError
    } catch (reason) {
      error = message(reason)
    }
  }

  $effect(() => {
    // Runs on mount and whenever the repo/identity changes; the store decides
    // whether a network call is actually needed (TTL) or cached data suffices.
    if (identity && githubConnected) void load()
  })

  /** Open a check-linked workflow run even when it is older than the overview page. */
  async function openRequestedRun(runId: number): Promise<void> {
    if (!identity || openingRequestedRunId === runId) return
    openingRequestedRunId = runId
    try {
      const listed = overview?.workflowRuns.find((run) => run.id === runId)
      if (listed) {
        selectedDeployment = null
        selectedRun = listed
        return
      }
      const detail = await gitState.ensureWorkflowRunDetail(
        projectId,
        identity.owner,
        identity.repo,
        runId
      )
      if (detail) {
        selectedDeployment = null
        selectedRun = detail.run
      }
    } catch (reason) {
      error = message(reason)
    } finally {
      openingRequestedRunId = null
      onRequestedRunOpened?.()
    }
  }

  onMount(() => {
    const runId = requestedRunId
    if (runId !== null && identity && githubConnected) void openRequestedRun(runId)
  })

  function runTone(run: GitHubWorkflowRun): string {
    if (run.status !== 'completed') return 'bg-warning/10 text-warning'
    if (run.conclusion === 'success') return 'bg-success/10 text-success'
    if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') {
      return 'bg-elevated text-dimmed'
    }
    return 'bg-danger/10 text-danger'
  }

  function deploymentTone(deployment: GitHubDeployment): string {
    const state = deployment.latestStatus?.state
    if (state === 'success') return 'bg-success/10 text-success'
    if (state === 'failure' || state === 'error') return 'bg-danger/10 text-danger'
    if (state === 'inactive') return 'bg-elevated text-dimmed'
    return 'bg-warning/10 text-warning'
  }

  function runLabel(run: GitHubWorkflowRun): string {
    if (run.status !== 'completed') return run.status.replace('_', ' ')
    return run.conclusion ?? 'completed'
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if !githubConnected}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Rocket size={22} class="text-dimmed" />
      <p class="max-w-[34ch] text-[11px] leading-relaxed text-muted">
        Sign in to GitHub to monitor workflow runs and deployments.
      </p>
      <button
        type="button"
        class="h-8 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary hover:bg-primary-hover"
        onclick={onSignIn}
      >
        Sign in to GitHub
      </button>
    </div>
  {:else if !identity}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <Rocket size={20} class="text-dimmed" />
      <p class="max-w-[36ch] text-[11px] leading-relaxed text-muted">
        Add a GitHub origin remote to monitor deployments for this project.
      </p>
    </div>
  {:else}
    {#if selectedRun && identity}
      <GitWorkflowRunDetail
        {projectId}
        {identity}
        run={selectedRun}
        onBack={() => (selectedRun = null)}
        onAgentDiagnose={onAgentDiagnoseRun}
      />
    {:else if selectedDeployment && identity}
      <GitDeploymentDetail
        {projectId}
        {identity}
        deployment={selectedDeployment}
        onBack={() => (selectedDeployment = null)}
        onAgentDiagnose={onAgentDiagnoseDeployment}
      />
    {:else if loading && !overview}
      <div class="flex flex-1 items-center justify-center gap-2 text-[11px] text-dimmed">
        <Loader2 size={13} class="animate-spin" />
        Loading deployment activity
      </div>
    {:else if error && !overview}
      <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <CircleX size={20} class="text-danger" />
        <div>
          <p class="text-[11px] font-medium text-foreground">Deployment activity unavailable</p>
          <p class="mt-1 max-w-[42ch] text-[10px] leading-relaxed text-dimmed">
            {#if permissionMissing}
              Install CodeInOven on this repository and grant Actions, Deployments, and Environments
              read access.
            {:else}
              {error}
            {/if}
          </p>
        </div>
        {#if permissionMissing}
          <button
            type="button"
            class="h-8 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary hover:bg-primary-hover"
            onclick={() =>
              void openInBrowser('https://github.com/apps/codeinoven/installations/new')}
          >
            Install GitHub App
          </button>
        {:else}
          <button
            type="button"
            class="h-8 rounded-lg border border-border px-3 text-[11px] font-medium text-foreground hover:bg-elevated"
            onclick={() => void load(true)}
          >
            Try again
          </button>
        {/if}
      </div>
    {:else if overview}
      <div class="min-h-0 flex-1 overflow-y-auto">
        <section class="border-b border-border">
          <div class="flex items-center gap-2 bg-surface px-3 py-1.5">
            <CircleDot size={11} class="text-dimmed" />
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-muted">
              Workflow runs
            </h3>
            <span class="ml-auto text-[9px] tabular-nums text-dimmed">
              {overview.workflowRuns.length}
            </span>
            <button
              type="button"
              class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              title="View workflow runs on GitHub"
              aria-label="View workflow runs on GitHub"
              onclick={() =>
                void openInBrowser(`https://github.com/${identity.owner}/${identity.repo}/actions`)}
            >
              <ExternalLink size={11} />
            </button>
            <button
              type="button"
              class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
              title="Refresh deployments"
              aria-label="Refresh deployments"
              disabled={loading}
              onclick={() => void load(true)}
            >
              <RefreshCw size={11} class={loading ? 'animate-spin' : ''} />
            </button>
          </div>
          {#if overview.workflowRuns.length === 0}
            <p class="px-3 py-5 text-center text-[10px] text-dimmed">
              No workflow runs are available.
            </p>
          {:else}
            <div class="divide-y divide-border">
              {#each overview.workflowRuns as run (run.id)}
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-elevated"
                  title="View workflow run #{run.runNumber}"
                  aria-label="View workflow run #{run.runNumber}"
                  onclick={() => (selectedRun = run)}
                >
                  {#if run.status !== 'completed'}
                    <Clock3 size={13} class="mt-0.5 shrink-0 text-warning" />
                  {:else if run.conclusion === 'success'}
                    <CircleCheck size={13} class="mt-0.5 shrink-0 text-success" />
                  {:else}
                    <CircleX size={13} class="mt-0.5 shrink-0 text-danger" />
                  {/if}
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <p class="truncate text-[11px] font-medium text-foreground">
                        {run.displayTitle}
                      </p>
                      <span
                        class={[
                          'shrink-0 rounded px-1.5 py-0.5 text-[8px] font-semibold uppercase',
                          runTone(run)
                        ]}
                      >
                        {runLabel(run)}
                      </span>
                    </div>
                    <div class="mt-0.5 flex items-center gap-1.5 text-[9px] text-dimmed">
                      <span class="truncate">{run.name} #{run.runNumber}</span>
                      {#if run.branch}
                        <span>·</span>
                        <GitBranch size={9} class="shrink-0" />
                        <span class="max-w-28 truncate font-mono">{run.branch}</span>
                      {/if}
                      <span>·</span>
                      <span class="shrink-0">{relativeTime(run.updatedAt)}</span>
                    </div>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </section>

        <section>
          <div class="flex items-center gap-2 bg-surface px-3 py-1.5">
            <PackageCheck size={11} class="text-dimmed" />
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-muted">
              Environments
            </h3>
            <span class="ml-auto text-[9px] tabular-nums text-dimmed">
              {overview.deployments.length}
            </span>
          </div>
          {#if overview.deployments.length === 0}
            <p class="px-3 py-5 text-center text-[10px] text-dimmed">
              No GitHub deployments are available.
            </p>
          {:else}
            <div class="divide-y divide-border">
              {#each overview.deployments as deployment (deployment.id)}
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-elevated"
                  title="View {deployment.environment} deployment"
                  aria-label="View {deployment.environment} deployment"
                  onclick={() => (selectedDeployment = deployment)}
                >
                  <Rocket size={13} class="mt-0.5 shrink-0 text-muted" />
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <p class="truncate text-[11px] font-medium text-foreground">
                        {deployment.environment}
                      </p>
                      <span
                        class={[
                          'shrink-0 rounded px-1.5 py-0.5 text-[8px] font-semibold uppercase',
                          deploymentTone(deployment)
                        ]}
                      >
                        {deployment.latestStatus?.state ?? 'created'}
                      </span>
                    </div>
                    <div class="mt-0.5 flex items-center gap-1.5 text-[9px] text-dimmed">
                      <span class="max-w-32 truncate font-mono">{deployment.ref}</span>
                      <span>·</span>
                      <span class="font-mono">{deployment.sha.slice(0, 7)}</span>
                      <span>·</span>
                      <span>{relativeTime(deployment.updatedAt)}</span>
                    </div>
                    {#if deployment.latestStatus?.description}
                      <p class="mt-1 truncate text-[9px] text-muted">
                        {deployment.latestStatus.description}
                      </p>
                    {/if}
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {/if}
  {/if}
</div>
