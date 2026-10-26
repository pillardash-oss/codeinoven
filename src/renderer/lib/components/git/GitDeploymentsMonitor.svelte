<script lang="ts">
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioClock from '@pdslng/cio-icon/CioClock.svelte'
  import CioCrossCircle from '@pdslng/cio-icon/CioCrossCircle.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioMinus from '@pdslng/cio-icon/CioMinus.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioRocket from '@pdslng/cio-icon/CioRocket.svelte'
  import CioServer from '@pdslng/cio-icon/CioServer.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTabGit from '@pdslng/cio-icon/CioTabGit.svelte'
  import { scheduleDeferredWork } from '$lib/deferred-work'
  import { formatCompactAge } from '$shared/date-time-format'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import GitDeploymentDetail from './GitDeploymentDetail.svelte'
  import GitWorkflowRunDetail from './GitWorkflowRunDetail.svelte'
  import WorkflowRunFilter from './WorkflowRunFilter.svelte'
  import type {
    GitHubDeployment,
    GitHubDeploymentJob,
    GitHubDeploymentJobLog,
    GitHubWorkflowRun,
    WorkflowRunFilter as WorkflowRunFilterId
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
    /**
     * The deployment whose page replaces the listing, and the workflow run that
     * does the same. The panel owns both so its action row can name what is open;
     * this view is the one that opens and closes them.
     */
    selectedDeployment?: GitHubDeployment | null
    selectedRun?: GitHubWorkflowRun | null
  }

  let {
    projectId,
    identity,
    githubConnected,
    onSignIn,
    requestedRunId = null,
    onRequestedRunOpened,
    onAgentDiagnoseRun,
    onAgentDiagnoseDeployment,
    selectedDeployment = $bindable(null),
    selectedRun = $bindable(null)
  }: Props = $props()

  /** Which of the repository's two activity listings is being read. */
  type DeploymentView = 'runs' | 'environments'

  /**
   * Workflow runs first, because that is what a deployable repository is usually
   * opened for: the last run, its state, and whether it is still moving. The
   * environments are where a run lands, and are read second.
   */
  let activeView = $state<DeploymentView>('runs')
  let runFilter = $state<WorkflowRunFilterId>('all')
  /**
   * One page per view, so switching tabs never loses the reader's place: the
   * environments stay where they were left while the runs are paged forward.
   */
  let runsPage = $state(1)
  let environmentsPage = $state(1)

  /** Non-reactive dedupe guard for direct navigation from a PR check. */
  let openingRequestedRunId: number | null = null

  /** A failure of this view's own navigation, drawn as a line above the rows. */
  let notice = $state('')

  const runPageCached = $derived(
    identity
      ? gitState.deploymentRunPages[
          GitState.workflowRunPageKey(identity.owner, identity.repo, runFilter, runsPage)
        ]
      : undefined
  )
  const runPage = $derived(runPageCached?.page ?? null)
  const runs = $derived(runPage?.items ?? [])
  const runsHasMore = $derived(runPage?.hasMore ?? false)

  const deploymentPageCached = $derived(
    identity
      ? gitState.deploymentPages[
          GitState.deploymentPageKey(identity.owner, identity.repo, environmentsPage)
        ]
      : undefined
  )
  const deploymentPage = $derived(deploymentPageCached?.page ?? null)
  const deployments = $derived(deploymentPage?.items ?? [])
  const deploymentsHasMore = $derived(deploymentPage?.hasMore ?? false)

  /** The page the visible view is reading, for the one set of loading and paging states. */
  const shownPage = $derived(activeView === 'runs' ? runPage : deploymentPage)
  const page = $derived(activeView === 'runs' ? runsPage : environmentsPage)
  const hasMore = $derived(activeView === 'runs' ? runsHasMore : deploymentsHasMore)
  const accessError = $derived(shownPage?.accessError ?? '')
  const transientError = $derived(shownPage?.transientError ?? '')
  const loading = $derived(
    gitState.isBusy(activeView === 'runs' ? 'deployment-runs' : 'deployment-environments')
  )
  const items = $derived(activeView === 'runs' ? runs : deployments)

  /**
   * The views, in the order the tab strip draws them. Icons only, because two of
   * them always fit one row at a sidebar width and their names are one hover away.
   */
  const views: Array<{ id: DeploymentView; label: string; icon: typeof CioPlay }> = [
    { id: 'runs', label: 'Workflow runs', icon: CioPlay },
    { id: 'environments', label: 'Environments', icon: CioServer }
  ]

  const permissionMissing = $derived(/HTTP 40[34]|Not Found|not accessible/iu.test(accessError))

  function message(reason: unknown): string {
    if (!(reason instanceof Error)) return 'Deployments could not be loaded.'
    return reason.message
      .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
      .replace(/^Error:\s*/u, '')
  }

  /**
   * Read the visible page. Hovering the other tab reads it ahead of the click
   * (`warmView`), so this is the slow path only on a cold entry.
   */
  $effect(() => {
    const source = identity
    if (!source || !githubConnected) return
    if (activeView === 'runs') {
      void gitState.ensureWorkflowRunPage(projectId, source.owner, source.repo, runFilter, runsPage)
      return
    }
    void gitState.ensureDeploymentPage(projectId, source.owner, source.repo, environmentsPage)
  })

  let pageVisible = $state(!document.hidden)

  const selectedDetailCompleted = $derived.by(() => {
    if (!identity) return false
    const { owner, repo } = identity
    if (selectedRun) {
      return (
        gitState.deploymentRunDetails[GitState.workflowRunKey(owner, repo, selectedRun.id)]?.detail
          .run.status === 'completed'
      )
    }
    if (selectedDeployment) {
      const state =
        gitState.deploymentDetails[GitState.deploymentDetailKey(owner, repo, selectedDeployment.id)]
          ?.detail.deployment.latestStatus?.state
      return ['success', 'failure', 'error', 'inactive'].includes(state ?? '')
    }
    return false
  })

  /** Refresh only the mounted, visible view, with no overlapping poll requests. */
  $effect(() => {
    const source = identity
    const currentProject = projectId
    const view = activeView
    const filter = runFilter
    const currentPage = view === 'runs' ? runsPage : environmentsPage
    const runId = selectedRun?.id
    const deploymentId = selectedDeployment?.id
    if (!source || !githubConnected || !pageVisible) return
    const { owner, repo } = source
    const completed = selectedDetailCompleted
    let stopped = false
    let timer: ReturnType<typeof setTimeout>

    async function refresh(): Promise<void> {
      let pollAgain = true
      try {
        if (deploymentId !== undefined) {
          const detail = await gitState.ensureDeploymentDetail(
            currentProject,
            owner,
            repo,
            deploymentId,
            true
          )
          pollAgain = !['success', 'failure', 'error', 'inactive'].includes(
            detail?.deployment.latestStatus?.state ?? ''
          )
        } else if (runId !== undefined) {
          const detail = await gitState.ensureWorkflowRunDetail(
            currentProject,
            owner,
            repo,
            runId,
            true
          )
          pollAgain = detail?.run.status !== 'completed'
        } else if (view === 'runs') {
          await gitState.ensureWorkflowRunPage(
            currentProject,
            owner,
            repo,
            filter,
            currentPage,
            true
          )
        } else {
          await gitState.ensureDeploymentPage(currentProject, owner, repo, currentPage, true)
        }
      } catch (reason) {
        if (!stopped) notice = message(reason)
      } finally {
        if (!stopped && pollAgain) timer = setTimeout(() => void refresh(), 10_000)
      }
    }

    timer = setTimeout(() => void refresh(), completed ? 1_000 : 500)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  })

  /**
   * Warm the view under the pointer, so the click that follows renders from cache
   * instead of spinning through a cold read.
   *
   * One deferred key for both tabs: a pointer crossing the strip warms the tab it
   * settles on, not every tab it crossed, and the fetch lands after the paint that
   * draws the hover.
   */
  function warmView(view: DeploymentView): void {
    const source = identity
    if (!source || !githubConnected || view === activeView) return
    const owner = source.owner
    const repo = source.repo
    const pageToWarm = view === 'runs' ? runsPage : environmentsPage
    const filterToWarm = runFilter
    scheduleDeferredWork(`git:deployments-preload:${projectId}`, () => {
      if (view === 'runs') {
        void gitState.preloadWorkflowRunPage(projectId, owner, repo, filterToWarm, pageToWarm)
        return
      }
      void gitState.preloadDeploymentPage(projectId, owner, repo, pageToWarm)
    })
  }

  /** Warm the page behind Next, so pressing it renders from cache. */
  function warmNextPage(): void {
    const source = identity
    if (!source || !hasMore) return
    const owner = source.owner
    const repo = source.repo
    const view = activeView
    const nextPage = page + 1
    const filterToWarm = runFilter
    scheduleDeferredWork(`git:deployments-page-preload:${projectId}`, () => {
      if (view === 'runs') {
        void gitState.preloadWorkflowRunPage(projectId, owner, repo, filterToWarm, nextPage)
        return
      }
      void gitState.preloadDeploymentPage(projectId, owner, repo, nextPage)
    })
  }

  function selectView(view: DeploymentView): void {
    activeView = view
    selectedRun = null
    selectedDeployment = null
  }

  /** Narrowing the runs listing always starts again at its first page. */
  function selectRunFilter(next: WorkflowRunFilterId): void {
    runFilter = next
    runsPage = 1
  }

  function changePage(next: number): void {
    if (next < 1) return
    if (activeView === 'runs') runsPage = next
    else environmentsPage = next
  }

  /** Re-read the visible page, for the failure block's Try again. */
  function retry(): void {
    const source = identity
    if (!source) return
    if (activeView === 'runs') {
      void gitState.ensureWorkflowRunPage(
        projectId,
        source.owner,
        source.repo,
        runFilter,
        runsPage,
        true
      )
      return
    }
    void gitState.ensureDeploymentPage(projectId, source.owner, source.repo, environmentsPage, true)
  }

  /**
   * Open a check-linked workflow run even when it is not on the page in view.
   *
   * The run's own detail read is the lookup: a listing page would only find the
   * run when it happened to be one of the twenty rows in front of the reader.
   */
  async function openRequestedRun(runId: number): Promise<void> {
    const source = identity
    if (!source || openingRequestedRunId === runId) return
    openingRequestedRunId = runId
    notice = ''
    try {
      const detail = await gitState.ensureWorkflowRunDetail(
        projectId,
        source.owner,
        source.repo,
        runId
      )
      if (detail) {
        activeView = 'runs'
        selectedDeployment = null
        selectedRun = detail.run
      }
    } catch (reason) {
      notice = message(reason)
    } finally {
      openingRequestedRunId = null
      onRequestedRunOpened?.()
    }
  }

  $effect(() => {
    // Runs on mount and whenever a check hands over a run id; the guard above
    // keeps the hand-off from repeating while its own read is in flight.
    const runId = requestedRunId
    if (runId === null || !identity || !githubConnected) return
    void openRequestedRun(runId)
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

  const emptyLabel = $derived(
    activeView === 'runs'
      ? runFilter === 'all'
        ? 'No workflow runs are available.'
        : `No ${runFilter} workflow runs are available.`
      : 'No GitHub deployments are available.'
  )
</script>

<svelte:document onvisibilitychange={() => (pageVisible = !document.hidden)} />

<div class="flex h-full min-h-0 flex-col">
  {#if !githubConnected}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <CioRocket size={22} class="text-dimmed" />
      <p class="max-w-[34ch] text-[0.6875rem] leading-relaxed text-muted">
        Sign in to GitHub to monitor workflow runs and deployments.
      </p>
      <button
        type="button"
        class="h-8 bg-primary px-3 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover"
        onclick={onSignIn}
      >
        Sign in to GitHub
      </button>
    </div>
  {:else if !identity}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <CioRocket size={20} class="text-dimmed" />
      <p class="max-w-[36ch] text-[0.6875rem] leading-relaxed text-muted">
        Add a GitHub origin remote to monitor deployments for this project.
      </p>
    </div>
  {:else if selectedRun && identity}
    <GitWorkflowRunDetail
      {projectId}
      {identity}
      run={selectedRun}
      onAgentDiagnose={onAgentDiagnoseRun}
    />
  {:else if selectedDeployment && identity}
    <GitDeploymentDetail
      {projectId}
      {identity}
      deployment={selectedDeployment}
      onAgentDiagnose={onAgentDiagnoseDeployment}
    />
  {:else}
    <!--
      The views and the filter that narrows them, in one fixed row: two icon tabs
      on the left, the run-state chips beside them, exactly where the pull request
      listing keeps its own. A sidebar has no width to spend on words, so the tab
      strip is icons only and each icon's name is one hover away.
    -->
    <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
      {#each views as view (view.id)}
        {@const ViewIcon = view.icon}
        <button
          type="button"
          class={[
            'flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center transition-colors',
            activeView === view.id
              ? 'bg-elevated text-foreground'
              : 'text-dimmed hover:bg-elevated hover:text-foreground'
          ]}
          title={view.label}
          aria-label={view.label}
          aria-pressed={activeView === view.id}
          onpointerenter={() => warmView(view.id)}
          onfocus={() => warmView(view.id)}
          onclick={() => selectView(view.id)}
        >
          <ViewIcon size={12} aria-hidden="true" />
        </button>
      {/each}
      {#if activeView === 'runs'}
        <span class="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
        <WorkflowRunFilter filter={runFilter} onSelect={selectRunFilter} />
      {/if}
    </div>

    {#if notice}
      <div
        class="flex shrink-0 items-start gap-1.5 border-b border-border bg-elevated/40 px-2.5 py-1.5"
      >
        <CioCrossCircle size={12} class="mt-0.5 shrink-0 text-danger" />
        <p class="text-[0.625rem] leading-relaxed text-dimmed">{notice}</p>
      </div>
    {/if}

    {#if transientError && items.length > 0}
      <div
        class="flex shrink-0 items-start gap-1.5 border-b border-border bg-elevated/40 px-2.5 py-1.5"
      >
        <CioCrossCircle size={12} class="mt-0.5 shrink-0 text-warning" />
        <p class="text-[0.625rem] leading-relaxed text-dimmed">{transientError}</p>
      </div>
    {/if}

    <!--
      The rows scroll between the two fixed bars rather than above the pager, so a
      page of twenty never pushes the Next control off the panel.
    -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if loading && items.length === 0}
        <div class="flex items-center justify-center gap-2 py-10 text-[0.6875rem] text-dimmed">
          <CioSpinner size={13} class="animate-spin" />
          {activeView === 'runs' ? 'Loading workflow runs' : 'Loading deployments'}
        </div>
      {:else if accessError}
        <div class="flex flex-col items-center gap-3 px-5 py-8 text-center">
          <CioCrossCircle size={18} class="text-danger" />
          <div>
            <p class="text-[0.6875rem] font-medium text-foreground">
              Deployment activity unavailable
            </p>
            <p class="mt-1 max-w-[42ch] text-[0.625rem] leading-relaxed text-dimmed">
              {#if permissionMissing}
                GitHub refused this sign-in access to the repository's Actions, Deployments, and
                Environments.
              {:else}
                {accessError}
              {/if}
            </p>
          </div>
          {#if permissionMissing}
            <button
              type="button"
              class="h-8 bg-primary px-3 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover"
              onclick={onSignIn}
            >
              Sign in to GitHub
            </button>
          {:else}
            <button
              type="button"
              class="h-8 border border-border px-3 text-[0.6875rem] font-medium text-foreground hover:bg-elevated"
              onclick={retry}
            >
              Try again
            </button>
          {/if}
        </div>
      {:else if transientError && items.length === 0}
        <div class="flex flex-col items-center gap-3 px-5 py-8 text-center">
          <CioCrossCircle size={18} class="text-warning" />
          <p class="max-w-[42ch] text-[0.625rem] leading-relaxed text-dimmed">{transientError}</p>
          <button
            type="button"
            class="h-8 border border-border px-3 text-[0.6875rem] font-medium text-foreground hover:bg-elevated"
            onclick={retry}
          >
            Try again
          </button>
        </div>
      {:else if items.length === 0}
        <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
          {#if activeView === 'runs'}
            <CioPlay size={18} class="text-dimmed" />
          {:else}
            <CioServer size={18} class="text-dimmed" />
          {/if}
          <p class="text-[0.6875rem] leading-relaxed text-dimmed">{emptyLabel}</p>
          {#if activeView === 'runs' && runFilter !== 'all'}
            <!--
              An empty list under a filter is the one case where "there are none"
              and "you are not looking at all of them" look identical.
            -->
            <p class="text-[0.5625rem] leading-relaxed text-dimmed">
              The {runFilter} filter is on.
            </p>
          {/if}
        </div>
      {:else if activeView === 'runs'}
        <div class="divide-y divide-border">
          {#each runs as run (run.id)}
            <button
              type="button"
              class="flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-elevated"
              title="View workflow run #{run.runNumber}"
              aria-label="View workflow run #{run.runNumber}"
              onclick={() => (selectedRun = run)}
            >
              {#if run.status !== 'completed'}
                <CioClock size={13} class="mt-0.5 shrink-0 text-warning" />
              {:else if run.conclusion === 'success'}
                <CioCheckCircle size={13} class="mt-0.5 shrink-0 text-success" />
              {:else if run.conclusion === 'skipped'}
                <CioMinus size={13} class="mt-0.5 shrink-0 text-dimmed" />
              {:else}
                <CioCrossCircle size={13} class="mt-0.5 shrink-0 text-danger" />
              {/if}
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <p class="truncate text-[0.6875rem] font-medium text-foreground">
                    {run.displayTitle}
                  </p>
                  <span
                    class={[
                      'shrink-0 px-1.5 py-0.5 text-[0.5rem] font-semibold uppercase',
                      runTone(run)
                    ]}
                  >
                    {runLabel(run)}
                  </span>
                </div>
                <div class="mt-0.5 flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
                  <span class="truncate">{run.name} #{run.runNumber}</span>
                  {#if run.branch}
                    <span>·</span>
                    <CioTabGit size={9} class="shrink-0" />
                    <span class="max-w-28 truncate font-mono">{run.branch}</span>
                  {/if}
                  <span>·</span>
                  <span class="shrink-0">{formatCompactAge(run.updatedAt)}</span>
                </div>
              </div>
            </button>
          {/each}
        </div>
      {:else}
        <div class="divide-y divide-border">
          {#each deployments as deployment (deployment.id)}
            <button
              type="button"
              class="flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-elevated"
              title="View {deployment.environment} deployment"
              aria-label="View {deployment.environment} deployment"
              onclick={() => (selectedDeployment = deployment)}
            >
              <CioRocket size={13} class="mt-0.5 shrink-0 text-muted" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <p class="truncate text-[0.6875rem] font-medium text-foreground">
                    {deployment.environment}
                  </p>
                  <span
                    class={[
                      'shrink-0 px-1.5 py-0.5 text-[0.5rem] font-semibold uppercase',
                      deploymentTone(deployment)
                    ]}
                  >
                    {deployment.latestStatus?.state ?? 'created'}
                  </span>
                </div>
                <div class="mt-0.5 flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
                  <span class="max-w-32 truncate font-mono">{deployment.ref}</span>
                  <span>·</span>
                  <span class="font-mono">{deployment.sha.slice(0, 7)}</span>
                  <span>·</span>
                  <span>{formatCompactAge(deployment.updatedAt)}</span>
                </div>
                {#if deployment.latestStatus?.description}
                  <p class="mt-1 truncate text-[0.5625rem] text-muted">
                    {deployment.latestStatus.description}
                  </p>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    {#if page > 1 || hasMore}
      <div class="flex shrink-0 items-center justify-between border-t border-border px-3 py-1.5">
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 px-2 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
          disabled={page === 1 || loading}
          onclick={() => changePage(page - 1)}
        >
          <CioBack size={12} />
          Previous
        </button>
        <span class="text-[0.5625rem] tabular-nums text-dimmed">Page {page}</span>
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 px-2 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
          disabled={!hasMore || loading}
          onpointerenter={warmNextPage}
          onfocus={warmNextPage}
          onclick={() => changePage(page + 1)}
        >
          Next
          <CioForward size={12} />
        </button>
      </div>
    {/if}
  {/if}
</div>
