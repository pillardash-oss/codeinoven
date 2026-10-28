<script lang="ts">
  import type { Snippet } from 'svelte'
  import { DropdownMenu } from 'bits-ui'
  import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
  import CioArrowLeft from '@pdslng/cio-icon/CioArrowLeft.svelte'
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioCommit from '@pdslng/cio-icon/CioCommit.svelte'
  import CioFileMinus from '@pdslng/cio-icon/CioFileMinus.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioLayers from '@pdslng/cio-icon/CioLayers.svelte'
  import CioMerge from '@pdslng/cio-icon/CioMerge.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import { formatCompactAge } from '$shared/date-time-format'
  import type {
    GitCommitInfo,
    GitConflictSide,
    GitFileChange,
    GitStashEntry,
    GitHubDeployment,
    GitHubDeploymentJob,
    GitHubNotification,
    GitHubWorkflowRun,
    PrListFilter,
    PrListSort,
    PrState,
    PullRequestBundle,
    PullRequestSummary
  } from '$shared/types'
  import { githubNotifications } from '$lib/stores/github-notifications.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import type { GitPanelTabId } from '$lib/stores/git-panel-view.svelte'
  import type { PrDetailTabId } from '../pr-view'
  import { reasonLabel, subjectIcon } from '../notification-view'
  import { stateGlyph, stateGlyphClass, stateLabel } from '../deployment-state'
  import PrIdentityRow from '../PrIdentityRow.svelte'
  import PrListOptionsMenu from '../PrListOptionsMenu.svelte'
  import PrStateFilter from '../PrStateFilter.svelte'
  import PrViewSwitcher from '../PrViewSwitcher.svelte'
  import PrReviewMenu from '../PrReviewMenu.svelte'
  import CancelRunButton from '../CancelRunButton.svelte'
  import RerunRunMenu from '../RerunRunMenu.svelte'

  interface Props {
    activeTab: GitPanelTabId
    selectedCommit: GitCommitInfo | null
    selectedStash: GitStashEntry | null
    selectedPullRequest: PullRequestSummary | null
    selectedDeployment: GitHubDeployment | null
    selectedRun: GitHubWorkflowRun | null
    prDetailTab: PrDetailTabId
    conflicted: GitFileChange[]
    changes: GitFileChange[]
    staged: GitFileChange[]
    unstaged: GitFileChange[]
    untracked: GitFileChange[]
    selectedPathList: string[]
    integrateBusy: boolean
    batchBusy: boolean
    canGoNewer: boolean
    canGoOlder: boolean
    openNotification: GitHubNotification | null
    notificationPrDetailViews: Array<{
      id: PrDetailTabId
      label: string
      icon: typeof CioSubagent
      count: number
    }>
    notificationBundle: PullRequestBundle | undefined
    notificationPullRequest: PullRequestSummary | null
    notificationIdentity: { owner: string; repo: string } | null
    prDetailViews: Array<{
      id: PrDetailTabId
      label: string
      icon: typeof CioSubagent
      count: number
    }>
    pullRequestBundle: PullRequestBundle | undefined
    prListState: PrState
    prListFilter: PrListFilter
    prListSort: PrListSort
    primaryRemote: { name: string; url: string } | null
    githubIdentity: { owner: string; repo: string } | null
    projectId: string
    openDeploymentState: string
    openRunState: string
    openRunJobs: GitHubDeploymentJob[]
    openRunFailedJob: GitHubDeploymentJob | null
    preparingRunDiagnosis: boolean
    abortIntegrationAction: Snippet<[boolean]>
    clearSelectedCommit: () => void
    clearSelectedStash: () => void
    navigateCommit: (direction: -1 | 1) => void
    stageAll: () => void
    unstageAll: () => void
    stageSelectedAction: (stage: boolean) => void
    requestCommitSelected: () => void
    requestStashFor: (paths: string[]) => void
    ignoreSelectedAction: () => void
    requestDiscard: (paths: string[]) => void
    requestRemoveCommitChanges: (paths: string[]) => void
    routeConflictResolution: () => void
    resolveConflictsWithAgent: () => void
    requestAcceptAllConflicts: (side: GitConflictSide) => void
    reviewOpenRunFailedJob: () => void
    reloadOpenRun: () => void
    isPanelRepository: (identity: { owner: string; repo: string } | null) => boolean
    selectPrListState: (next: PrState) => void
    selectPrListFilter: (next: PrListFilter) => void
    selectPrListSort: (next: PrListSort) => void
  }

  let {
    activeTab = $bindable(),
    selectedCommit,
    selectedStash,
    selectedPullRequest = $bindable(),
    selectedDeployment = $bindable(),
    selectedRun = $bindable(),
    prDetailTab = $bindable(),
    conflicted,
    changes,
    staged,
    unstaged,
    untracked,
    selectedPathList,
    integrateBusy,
    batchBusy,
    canGoNewer,
    canGoOlder,
    openNotification,
    notificationPrDetailViews,
    notificationBundle,
    notificationPullRequest,
    notificationIdentity,
    prDetailViews,
    pullRequestBundle,
    prListState,
    prListFilter,
    prListSort,
    primaryRemote,
    githubIdentity,
    projectId,
    openDeploymentState,
    openRunState,
    openRunJobs,
    openRunFailedJob,
    preparingRunDiagnosis,
    abortIntegrationAction,
    clearSelectedCommit,
    clearSelectedStash,
    navigateCommit,
    stageAll,
    unstageAll,
    stageSelectedAction,
    requestCommitSelected,
    requestStashFor,
    ignoreSelectedAction,
    requestDiscard,
    requestRemoveCommitChanges,
    routeConflictResolution,
    resolveConflictsWithAgent,
    requestAcceptAllConflicts,
    reviewOpenRunFailedJob,
    reloadOpenRun,
    isPanelRepository,
    selectPrListState,
    selectPrListFilter,
    selectPrListSort
  }: Props = $props()
</script>

{#if activeTab === 'changes' && selectedCommit === null}
  {#if conflicted.length > 0}
    {@render abortIntegrationAction(true)}
    <!--
      The whole resolution, in the order it happens: open the per-hunk merge
      editor, or hand the files to an agent, or take one side of every file
      at once. They live here, beside Abort, because this row is where a
      conflicted integration is decided   the Conflicts section header used to
      carry Resolve all on its own, which the tree layout never showed.
    -->
    <button
      type="button"
      class="flex h-6 shrink-0 items-center gap-1.5 border border-warning/40 px-2 text-[0.625rem] font-medium text-warning transition-colors hover:bg-warning/10 disabled:cursor-default disabled:opacity-40"
      disabled={integrateBusy}
      title="Open the merge editor on the conflicted files, starting with the first"
      onclick={() => routeConflictResolution()}
    >
      <CioMerge size={11} />
      Resolve all
    </button>
    <button
      type="button"
      class="flex h-6 shrink-0 items-center gap-1.5 border border-border px-2 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
      disabled={integrateBusy}
      title="Hand every conflicted file to an agent to resolve"
      onclick={() => void resolveConflictsWithAgent()}
    >
      <CioSubagent size={11} />
      Resolve with agent
    </button>
    <!--
      One decision with two answers, so one control: which side of every
      conflicted file to keep. Its sides carry the merge editor's own names and
      colours   accent incoming, primary current   and the group's label plus
      each button's title spell out what they do, because the row cannot afford
      a third word. Both sides are destructive to the other, so both confirm.
    -->
    <div
      class="flex h-6 shrink-0 items-center gap-0.5 border border-border bg-elevated p-0.5"
      role="group"
      aria-label="Accept one side of every conflicted file"
    >
      <button
        type="button"
        class="h-5 shrink-0 px-1 text-[0.5625rem] font-medium text-accent transition-colors hover:bg-accent/15 disabled:cursor-default disabled:opacity-40"
        disabled={integrateBusy}
        title="Accept all incoming: replace every conflicted file with its incoming version"
        onclick={() => requestAcceptAllConflicts('incoming')}
      >
        incoming
      </button>
      <button
        type="button"
        class="h-5 shrink-0 px-1 text-[0.5625rem] font-medium text-primary transition-colors hover:bg-primary/15 disabled:cursor-default disabled:opacity-40"
        disabled={integrateBusy}
        title="Accept all current: replace every conflicted file with its current version"
        onclick={() => requestAcceptAllConflicts('current')}
      >
        current
      </button>
    </div>
  {:else if unstaged.length + untracked.length > 0}
    <button
      type="button"
      class="flex h-6 shrink-0 items-center border border-border px-2 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
      disabled={gitState.isBusy('stage')}
      onclick={() => void stageAll()}
    >
      Stage all
    </button>
  {:else if staged.length > 0}
    <button
      type="button"
      class="flex h-6 shrink-0 items-center border border-danger/30 px-2 text-[0.625rem] font-medium text-danger transition-colors hover:bg-danger/10 disabled:cursor-default disabled:opacity-40"
      disabled={gitState.isBusy('unstage')}
      onclick={() => void unstageAll()}
    >
      Unstage all
    </button>
  {/if}
  {#if changes.length > 0 && selectedPathList.length > 0}
    <span class="shrink-0 text-[0.625rem] font-medium tabular-nums text-foreground">
      {selectedPathList.length} selected
    </span>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
        disabled={batchBusy}
        aria-label="Selected actions"
        title="Selected actions"
      >
        <CioChevronDown size={12} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          class="z-50 min-w-44 overflow-hidden border border-border bg-surface p-1 shadow-xl"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
            disabled={batchBusy}
            onSelect={() => void stageSelectedAction(false)}
          >
            <CioCheck size={12} class="text-success" />
            Stage
          </DropdownMenu.Item>
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
            disabled={batchBusy}
            onSelect={() => void stageSelectedAction(true)}
          >
            <span class="inline-block w-3 text-center text-[0.625rem] text-danger">−</span>
            Unstage
          </DropdownMenu.Item>
          <DropdownMenu.Separator class="my-1 h-px bg-border" />
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
            disabled={batchBusy}
            onSelect={requestCommitSelected}
          >
            <CioCommit size={12} class="text-dimmed" />
            Commit…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
            disabled={batchBusy}
            onSelect={() => requestStashFor(selectedPathList)}
          >
            <CioArchive size={12} class="text-dimmed" />
            Stash…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
            disabled={batchBusy}
            onSelect={() => void ignoreSelectedAction()}
          >
            <span class="inline-block w-3 text-center text-[0.625rem]">⊘</span>
            Add to gitignore
          </DropdownMenu.Item>
          <DropdownMenu.Separator class="my-1 h-px bg-border" />
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-danger outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
            disabled={batchBusy}
            onSelect={() => requestDiscard(selectedPathList)}
          >
            <CioTrash size={12} />
            Discard changes
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  {/if}
{:else if activeTab === 'changes' && selectedCommit !== null}
  {@const commit = selectedCommit}
  <button
    type="button"
    class="shrink-0 p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    title="Back to history"
    aria-label="Back to history"
    onclick={() => {
      clearSelectedCommit()
      activeTab = 'history'
    }}
  >
    <CioArrowLeft size={12} />
  </button>
  <div class="flex shrink-0 items-center gap-0.5">
    <button
      type="button"
      class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
      title="Newer commit"
      aria-label="Newer commit"
      disabled={!canGoNewer}
      onclick={() => navigateCommit(-1)}
    >
      <CioBack size={12} />
    </button>
    <button
      type="button"
      class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
      title="Older commit"
      aria-label="Older commit"
      disabled={!canGoOlder}
      onclick={() => navigateCommit(1)}
    >
      <CioForward size={12} />
    </button>
  </div>
  <div class="min-w-0 grow-2 basis-0">
    <p class="truncate text-[0.6875rem] font-medium text-foreground" title={commit.message}>
      {commit.message.split('\n')[0]}
    </p>
    <div class="flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
      <span class="font-mono">{commit.shortHash}</span>
      <span>·</span>
      <span class="truncate">{commit.author}</span>
      <span>·</span>
      <span class="shrink-0">{formatCompactAge(commit.date)}</span>
    </div>
  </div>
  <!--
    The files of the open commit are selectable, so the row that reports a
    working-tree selection also reports this one. It talks about the commit
    instead of the working tree, which is why it lives here rather than beside
    Stage all.
  -->
  {#if selectedPathList.length > 0}
    <span class="shrink-0 text-[0.625rem] font-medium tabular-nums text-foreground">
      {selectedPathList.length} selected
    </span>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
        disabled={batchBusy}
        aria-label={`Actions for the ${selectedPathList.length} selected files`}
        title={`Actions for the ${selectedPathList.length} selected files`}
      >
        <CioChevronDown size={12} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          class="z-50 min-w-44 overflow-hidden border border-border bg-surface p-1 shadow-xl"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-danger outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
            disabled={batchBusy}
            onSelect={() => requestRemoveCommitChanges(selectedPathList)}
          >
            <CioFileMinus size={12} class="shrink-0" />
            Remove from commit…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  {/if}
{:else if activeTab === 'stashes' && selectedStash !== null}
  {@const stash = selectedStash}
  <button
    type="button"
    class="shrink-0 p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    title="Back to stash list"
    aria-label="Back to stash list"
    onclick={clearSelectedStash}
  >
    <CioArrowLeft size={12} />
  </button>
  <div class="min-w-0 grow-2 basis-0">
    <p class="truncate text-[0.6875rem] font-medium text-foreground" title={stash.message}>
      {stash.message}
    </p>
    <div class="flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
      <span class="font-mono">{stash.id}</span>
      {#if stash.branch}
        <span>·</span>
        <span class="truncate">{stash.branch}</span>
      {/if}
      <span>·</span>
      <span class="shrink-0">{formatCompactAge(stash.date)}</span>
    </div>
  </div>
{:else if activeTab === 'notifications' && openNotification}
  <!--
    Reading a notification: back to the listing, what thread this is, and   for
    a pull request or an issue   which part of it you are reading. The
    notification's own actions are in the header's action group, where every
    other view's live.
  -->
  {@const NotificationIcon = subjectIcon(openNotification.subjectType)}
  <button
    type="button"
    class="shrink-0 p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    title="Back to notifications"
    aria-label="Back to notifications"
    onclick={() => githubNotifications.closeNotification()}
  >
    <CioArrowLeft size={12} />
  </button>
  <span
    class="flex size-5 shrink-0 items-center justify-center {openNotification.unread
      ? 'text-primary'
      : 'text-dimmed'}"
    role="img"
    title={openNotification.unread ? 'Unread notification' : 'Read notification'}
    aria-label={openNotification.unread ? 'Unread notification' : 'Read notification'}
  >
    <NotificationIcon size={13} />
  </span>
  <div class="min-w-0 grow-2 basis-0">
    <p class="truncate text-[0.6875rem] font-medium text-foreground" title={openNotification.title}>
      {openNotification.title}
    </p>
    <div class="flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
      <span class="truncate">{openNotification.repositoryFullName}</span>
      <span>·</span>
      <span class="shrink-0">{reasonLabel(openNotification.reason)}</span>
      <span>·</span>
      <span class="shrink-0" title={openNotification.updatedAt}>
        {formatCompactAge(Date.parse(openNotification.updatedAt))}
      </span>
    </div>
  </div>
  {#if notificationPullRequest}
    <!--
      Which part of the thread is being read, exactly as the Pulls view offers
      it: a pull request's conversation, changes, checks and commits are the
      reason to read one, and none of them is reachable without this.
    -->
    {#if (notificationBundle?.stack?.length ?? 0) > 1}
      <button
        type="button"
        class="ml-auto flex shrink-0 cursor-pointer items-center gap-1 p-1 text-muted hover:bg-elevated hover:text-foreground"
        title="View stacked pull requests"
        aria-label="View stacked pull requests"
        onclick={() => (prDetailTab = 'stacks')}
      >
        <CioLayers size={13} /><span class="text-[0.5625rem] tabular-nums"
          >{notificationBundle?.stack?.length}</span
        >
      </button>
    {/if}
    <PrViewSwitcher
      views={notificationPrDetailViews}
      active={prDetailTab}
      onSelect={(id) => (prDetailTab = id)}
    />
    {#if primaryRemote && isPanelRepository(notificationIdentity)}
      <PrReviewMenu {projectId} pr={notificationPullRequest} remote={primaryRemote.name} />
    {/if}
  {/if}
{:else if activeTab === 'pulls'}
  {#if selectedPullRequest && githubIdentity}
    <PrIdentityRow
      summary={selectedPullRequest}
      detail={pullRequestBundle?.detail ?? null}
      checks={pullRequestBundle?.checks ?? null}
      onBack={() => (selectedPullRequest = null)}
      onOpenChecks={() => (prDetailTab = 'checks')}
      stackCount={pullRequestBundle?.stack?.length ?? 0}
      onOpenStacks={() => (prDetailTab = 'stacks')}
    />
    <!--
      Which part of the pull request you are reading, immediately ahead of the
      remote actions. The sidebar cannot hold a list of views of its own, and the
      row has the room the title row no longer needs.
    -->
    <PrViewSwitcher
      views={prDetailViews}
      active={prDetailTab}
      onSelect={(id) => (prDetailTab = id)}
    />
    {#if primaryRemote}
      <PrReviewMenu {projectId} pr={selectedPullRequest} remote={primaryRemote.name} />
    {/if}
  {:else}
    <PrStateFilter state={prListState} onSelect={selectPrListState} />
    <PrListOptionsMenu
      filter={prListFilter}
      sort={prListSort}
      onFilterChange={selectPrListFilter}
      onSortChange={selectPrListSort}
    />
  {/if}
{:else if activeTab === 'deployments' && selectedDeployment !== null}
  {@const DeploymentGlyph = stateGlyph(openDeploymentState)}
  <button
    type="button"
    class="shrink-0 p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    title="Back to deployment activity"
    aria-label="Back to deployment activity"
    onclick={() => (selectedDeployment = null)}
  >
    <CioArrowLeft size={12} />
  </button>
  <div class="min-w-0 grow-2 basis-0">
    <p
      class="truncate text-[0.6875rem] font-medium text-foreground"
      title={selectedDeployment.environment}
    >
      {selectedDeployment.environment}
    </p>
    <div class="flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
      <span class="truncate font-mono">{selectedDeployment.ref}</span>
      <span>·</span>
      <span class="shrink-0 font-mono">{selectedDeployment.sha.slice(0, 7)}</span>
      <span>·</span>
      <span class="shrink-0">{formatCompactAge(Date.parse(selectedDeployment.updatedAt))}</span>
    </div>
  </div>
  <span
    class="flex shrink-0 items-center gap-1 {stateGlyphClass(openDeploymentState)}"
    role="img"
    title="Deployment {stateLabel(openDeploymentState).toLowerCase()}"
    aria-label="Deployment {stateLabel(openDeploymentState).toLowerCase()}"
  >
    <DeploymentGlyph size={13} />
    <span class="text-[0.5625rem] font-semibold uppercase tracking-wide">
      {stateLabel(openDeploymentState)}
    </span>
  </span>
{:else if activeTab === 'deployments' && selectedRun !== null}
  <button
    type="button"
    class="shrink-0 p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    title="Back to deployment activity"
    aria-label="Back to deployment activity"
    onclick={() => (selectedRun = null)}
  >
    <CioArrowLeft size={12} />
  </button>
  <div class="min-w-0 grow-2 basis-0">
    <p
      class="truncate text-[0.6875rem] font-medium text-foreground"
      title={selectedRun.displayTitle}
    >
      {selectedRun.displayTitle}
    </p>
    <!--
      The run's identity and its size on one line: what it is, where it ran,
      the commit, and how many jobs it owns. The count used to sit in a Jobs
      heading of its own, which the list below already states.
    -->
    <div class="flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
      <span class="truncate">{selectedRun.name} #{selectedRun.runNumber}</span>
      {#if selectedRun.branch}
        <span>·</span>
        <span class="truncate font-mono">{selectedRun.branch}</span>
      {/if}
      <span>·</span>
      <span class="shrink-0 font-mono">{selectedRun.headSha.slice(0, 7)}</span>
      {#if openRunJobs.length > 0}
        <span>·</span>
        <span class="shrink-0">{openRunJobs.length} jobs</span>
      {/if}
    </div>
  </div>
  <!--
    The state is the word alone: the glyph rotating beside a label that already
    says the same thing was a mark repeating its own text. The run's controls
    sit here, next to the state they act on, which is why the detail page no
    longer carries an action row above its jobs.
  -->
  <span
    class="shrink-0 px-1 text-[0.5625rem] font-semibold uppercase tracking-wide {stateGlyphClass(
      openRunState
    )}"
    title="Run {stateLabel(openRunState).toLowerCase()}"
  >
    {stateLabel(openRunState)}
  </span>
  {#if githubIdentity}
    {#if openRunFailedJob}
      <button
        type="button"
        class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center border border-border text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-40"
        title={`Review failed job ${openRunFailedJob.name} with an agent`}
        aria-label="Review the failed job with an agent"
        disabled={preparingRunDiagnosis}
        onclick={() => void reviewOpenRunFailedJob()}
      >
        {#if preparingRunDiagnosis}
          <CioSpinner size={11} class="animate-spin" />
        {:else}
          <CioSubagent size={11} />
        {/if}
      </button>
    {/if}
    <RerunRunMenu
      {projectId}
      identity={githubIdentity}
      runId={selectedRun.id}
      runStatus={selectedRun.status}
      hasFailedJobs={openRunFailedJob !== null}
      compact
      onRerun={() => void reloadOpenRun()}
    />
    <CancelRunButton
      {projectId}
      identity={githubIdentity}
      runId={selectedRun.id}
      runStatus={selectedRun.status}
      compact
      onCancelled={() => void reloadOpenRun()}
    />
  {/if}
{/if}
