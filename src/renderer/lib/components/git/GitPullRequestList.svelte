<script lang="ts">
  import {
    ChevronLeft,
    ChevronRight,
    GitMerge,
    GitPullRequest,
    GitPullRequestClosed,
    GitPullRequestDraft,
    Loader2,
    Maximize2,
    MessageSquare,
    RefreshCw,
    RotateCcw,
    TriangleAlert,
    X
  } from '@lucide/svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { scheduleDeferredWork } from '$lib/deferred-work'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import { githubAppInstallUrl } from '$lib/github-references'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import Switch from '$lib/components/ui/Switch.svelte'
  import PrListOptionsMenu from './PrListOptionsMenu.svelte'
  import PrRowContextMenu from './PrRowContextMenu.svelte'
  import BotBadge from './BotBadge.svelte'
  import PrStateFilter from './PrStateFilter.svelte'
  import {
    prChecksStateIcon,
    prChecksStateLabel,
    prChecksStateSpinning,
    prChecksToneClass,
    prLabelStyle,
    prListFilterLabel,
    type PrListAction
  } from './pr-view'
  import type { PrListFilter, PrListSort, PrState, PullRequestSummary } from '$shared/types'

  interface Props {
    projectId: string
    /** Repository the PRs belong to; null when origin isn't a GitHub remote. */
    identity: { owner: string; repo: string } | null
    githubConnected: boolean
    onOpen: (pr: PullRequestSummary) => void
    onSignIn: () => void
    onCreate: () => void
    /** Open the list in the full screen reader, like the file editor. */
    onFullscreen?: () => void
    /** Which state filter to list. Owned by the parent, which draws the filter in its own header row. */
    state: PrState
    /** Which relationship to keep and how to order. Owned by the parent for the same reason. */
    filter: PrListFilter
    sort: PrListSort
    /** Current page. Owned by the parent for the same reason. */
    page: number
    onPageChange: (page: number) => void
    /** Reports a chip click upward; the parent resets the page and passes the new state back down. */
    onStateChange: (state: PrState) => void
    /** Same hand-off for the relationship filter and the ordering. */
    onFilterChange: (filter: PrListFilter) => void
    onSortChange: (sort: PrListSort) => void
    /** The Git panel draws the filter and the actions itself, so it passes false. The full screen reader has no such row and keeps its own (default true). */
    showControls?: boolean
    /**
     * Which rows are selected, owned by the panel rather than by this component.
     *
     * The list is mounted twice, in the dock and in the full screen reader, exactly
     * as the filter and page are, and both mounts draw the same listing. A selection
     * held here would let the two mounts disagree about what a batch action means.
     */
    selected: Record<number, boolean>
    onSelectionChange: (next: Record<number, boolean>) => void
    /**
     * One hand-off for every row action, so the list stays a renderer of rows and
     * the panel owns what each action actually does. `targets` already carries the
     * scope the action applies to: one row, or the whole selection.
     */
    onAction: (action: PrListAction) => void
  }

  let {
    projectId,
    identity,
    githubConnected,
    onOpen,
    onSignIn,
    onCreate,
    onFullscreen,
    state,
    filter,
    sort,
    page,
    onPageChange,
    onStateChange,
    onFilterChange,
    onSortChange,
    showControls = true,
    selected,
    onSelectionChange,
    onAction
  }: Props = $props()

  /** The choices that identify a listing, in the shape both the store and the cache key take. */
  const query = $derived({ filter, sort })

  /** Cached page for the current listing   renders instantly on tab re-entry. */
  const cached = $derived(
    identity
      ? gitState.prPages[GitState.pageKey(identity.owner, identity.repo, state, filter, sort, page)]
      : undefined
  )
  const items = $derived(cached?.page.items ?? [])
  const hasMore = $derived(cached?.page.hasMore ?? false)
  const accessError = $derived(cached?.page.accessError ?? '')
  const loading = $derived(gitState.isBusy('pr-list'))

  /**
   * Labels drawn on a row before the rest are counted.
   *
   * A sidebar row is one line of chips wide; three covers the labelled work and
   * a `+N` says the rest exists without pushing the row onto a second line.
   */
  const VISIBLE_LABELS = 3

  /**
   * Where the last selection click landed, so shift extends from there.
   *
   * An index into this page rather than a pull request number: shift-clicking a
   * range means a range of what is on screen, and a number that has been paged
   * away is not on screen. Each mount keeps its own anchor, the way two windows on
   * one folder do.
   *
   * Deliberately not `$state`: only the click handlers read it, nothing renders
   * from it, and this component takes a prop named `state`, which is the rune's own
   * name here.
   */
  let selectionAnchor: number | null = null

  const selectedItems = $derived(items.filter((pr) => selected[pr.number] === true))
  const closableSelection = $derived(selectedItems.filter((pr) => pr.state === 'open'))
  const reopenableSelection = $derived(selectedItems.filter((pr) => pr.state === 'closed'))

  /**
   * What one row's menu acts on: the whole selection when the row is part of it,
   * and the row alone when the user right-clicked outside the selection. Acting on
   * a selection the row is not part of would be the menu answering a question the
   * user did not ask.
   */
  function targetsFor(pr: PullRequestSummary): PullRequestSummary[] {
    if (selected[pr.number] === true && selectedItems.length > 0) return selectedItems
    return [pr]
  }

  /**
   * One selection click, in the three shapes a list of rows accepts: a plain click
   * picks the row alone, a modifier click adds or removes it, and shift extends from
   * the last click. The selected record is rewritten rather than mutated, because
   * the panel renders both mounts from it.
   */
  function selectRow(
    pr: PullRequestSummary,
    index: number,
    options: { additive: boolean; range: boolean }
  ): void {
    const anchor = selectionAnchor
    selectionAnchor = index
    // A plain click replaces the selection rather than adding to it, and that same
    // replacement is what makes a right-click on an unselected row act on that row
    // alone. Only the modifier and shift shapes need the previous selection.
    if (!options.additive && !options.range) {
      onSelectionChange({ [pr.number]: true })
      return
    }
    const next = { ...selected }
    if (options.range && anchor !== null) {
      const from = Math.min(anchor, index)
      const to = Math.max(anchor, index)
      for (let cursor = from; cursor <= to; cursor += 1) {
        const item = items[cursor]
        if (item) next[item.number] = true
      }
    } else if (next[pr.number] === true) {
      delete next[pr.number]
    } else {
      next[pr.number] = true
    }
    onSelectionChange(next)
  }

  function clearSelection(): void {
    selectionAnchor = null
    onSelectionChange({})
  }

  function selectEveryRow(): void {
    const next: Record<number, boolean> = {}
    for (const item of items) next[item.number] = true
    selectionAnchor = null
    onSelectionChange(next)
  }

  /**
   * Escape gives the selection back, which is the only way out of a sweep that does
   * not also leave the view. It is consumed only when there is something to give
   * back, so a panel with no selection still answers Escape itself.
   */
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || selectedItems.length === 0) return
    event.stopPropagation()
    clearSelection()
  }

  async function load(force = false): Promise<void> {
    if (!identity || !githubConnected) return
    await gitState.ensurePullRequestPage(
      projectId,
      identity.owner,
      identity.repo,
      state,
      page,
      query,
      force
    )
  }

  /**
   * Warm one entry's detail bundle while the pointer rests on it, so the click
   * that follows renders from cache instead of spinning through a cold
   * `pr:bundle` (seven GitHub calls).
   *
   * Every row shares one deferred key rather than owning one. `scheduleDeferredWork`
   * keeps only the latest scheduling for a key, so a pointer dragged down the
   * list warms the row it settles on and never the twenty it crossed. That is
   * also the whole concurrency story: twenty simultaneous bundles is a rate
   * limit, not a fast list. Scheduling after the paint and through idle keeps
   * the fetch off the frame that is drawing the hover highlight.
   */
  function warmEntry(pr: PullRequestSummary): void {
    const source = identity
    if (!source) return
    const owner = source.owner
    const repo = source.repo
    scheduleDeferredWork(`git:pr-preload:${projectId}`, () => {
      void gitState.preloadPullRequestBundle(projectId, owner, repo, pr.number)
    })
  }

  /**
   * Warm the page behind Next. The listing is captured at hover time, so a
   * warm-up that lands after the user has already paged forward finds its page
   * cached and stops there instead of fetching one nobody asked for.
   */
  function warmNextPage(): void {
    const source = identity
    if (!source || !hasMore) return
    const owner = source.owner
    const repo = source.repo
    const listingState = state
    const listingPage = page
    const listing = { ...query }
    scheduleDeferredWork(`git:pr-page-preload:${projectId}`, () => {
      void gitState.preloadPullRequestNextPage(
        projectId,
        owner,
        repo,
        listingState,
        listingPage,
        listing
      )
    })
  }

  function icon(pr: PullRequestSummary): typeof GitPullRequest {
    if (pr.state === 'merged') return GitMerge
    if (pr.state === 'closed') return GitPullRequestClosed
    return pr.draft ? GitPullRequestDraft : GitPullRequest
  }

  function stateClass(pr: PullRequestSummary): string {
    if (pr.state === 'merged') return 'text-primary'
    if (pr.state === 'closed') return 'text-danger'
    if (identity && gitState.hasPrIssue(identity.owner, identity.repo, pr.number)) {
      return 'text-danger'
    }
    return pr.draft ? 'text-dimmed' : 'text-success'
  }

  /** How many comments a row reports, as one number and one accessible phrase. */
  function commentLabel(count: number): string {
    return count === 1 ? '1 comment' : `${count} comments`
  }

  $effect(() => {
    // Re-runs whenever the repo, filter, ordering, or page changes; the store
    // decides whether that actually needs a network call.
    if (identity && githubConnected) {
      const owner = identity.owner
      const repo = identity.repo
      void gitState.ensurePullRequestPage(projectId, owner, repo, state, page, query)
    }
  })
</script>

<!--
  Escape gives the selection back from anywhere inside the list. The container is
  not itself interactive: every row and every control in the bar is, and Escape is
  a shortcut beside the bar's own Clear button rather than the only way out.
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex h-full min-h-0 flex-col" onkeydown={handleKeydown}>
  {#if !githubConnected}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <VendorIcon name="GitHub" size={22} class="text-dimmed" />
      <p class="text-[0.6875rem] leading-relaxed text-muted">
        Sign in to GitHub to review, comment on, and merge pull requests from here.
      </p>
      <button
        type="button"
        class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover"
        onclick={onSignIn}
      >
        Sign in to GitHub
      </button>
    </div>
  {:else if !identity}
    <p class="px-4 py-6 text-center text-[0.6875rem] leading-relaxed text-dimmed">
      This project's origin remote isn't a GitHub repository, so there are no pull requests to show.
    </p>
  {:else}
    {#if showControls}
      <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <PrStateFilter {state} onSelect={onStateChange} />
        <PrListOptionsMenu {filter} {sort} {onFilterChange} {onSortChange} />
        <span class="flex-1"></span>
        {#if onFullscreen}
          <button
            type="button"
            class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            title="Open in full screen"
            aria-label="Open in full screen"
            onclick={onFullscreen}
          >
            <Maximize2 size={12} />
          </button>
        {/if}
        <button
          type="button"
          class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Create pull request"
          aria-label="Create pull request"
          onclick={onCreate}
        >
          <GitPullRequest size={12} />
        </button>
        <button
          type="button"
          class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-50"
          title="Refresh pull requests"
          aria-label="Refresh pull requests"
          disabled={loading}
          onclick={() => void load(true)}
        >
          <RefreshCw size={12} class={loading ? 'animate-spin' : ''} />
        </button>
      </div>
    {/if}

    <!--
      The selection bar names what a batch would act on and offers only the actions
      that apply to every row picked, so a mixed selection of open and closed pull
      requests still says exactly how many of each it will touch.
    -->
    {#if selectedItems.length > 0}
      <div
        class="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-elevated/50 px-2 py-1.5"
      >
        <span class="text-[0.625rem] font-medium tabular-nums text-foreground">
          {selectedItems.length} selected
        </span>
        <span class="flex-1"></span>
        {#if closableSelection.length > 0}
          <button
            type="button"
            class="flex h-6 cursor-pointer items-center gap-1 rounded-md bg-danger/10 px-2 text-[0.625rem] font-medium text-danger transition-colors hover:bg-danger/20"
            title={`Close ${closableSelection.length} selected ${
              closableSelection.length === 1 ? 'pull request' : 'pull requests'
            } without merging`}
            onclick={() => onAction({ kind: 'close', targets: closableSelection })}
          >
            <X size={11} />
            Close {closableSelection.length}
          </button>
        {/if}
        {#if reopenableSelection.length > 0}
          <button
            type="button"
            class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title={`Reopen ${reopenableSelection.length} selected ${
              reopenableSelection.length === 1 ? 'pull request' : 'pull requests'
            }`}
            onclick={() => onAction({ kind: 'reopen', targets: reopenableSelection })}
          >
            <RotateCcw size={11} />
            Reopen {reopenableSelection.length}
          </button>
        {/if}
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Clear the selection"
          onclick={clearSelection}
        >
          Clear
        </button>
      </div>
    {/if}

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if loading && items.length === 0}
        <div class="flex items-center justify-center gap-2 py-10 text-[0.6875rem] text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Loading pull requests…
        </div>
      {:else if accessError}
        <div class="flex flex-col items-center gap-3 px-5 py-8 text-center">
          <GitPullRequestClosed size={18} class="text-danger" />
          <p class="text-[0.625rem] leading-relaxed text-dimmed">{accessError}</p>
          <button
            type="button"
            class="h-8 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover"
            data-external-url={githubAppInstallUrl()}
            onclick={() => void openInBrowser(githubAppInstallUrl())}
          >
            Install GitHub App
          </button>
        </div>
      {:else if items.length === 0}
        <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <GitPullRequest size={18} class="text-dimmed" />
          <p class="text-[0.6875rem] leading-relaxed text-dimmed">
            No {state === 'all' ? '' : state} pull requests.
          </p>
          {#if filter !== 'all'}
            <!--
              An empty list under a filter is the one case where "there are none"
              and "you are not looking at all of them" look identical, so the
              narrowing choice is named rather than left to the menu's tint.
            -->
            <p class="text-[0.5625rem] leading-relaxed text-dimmed">
              The {prListFilterLabel(filter)} filter is on.
            </p>
          {/if}
        </div>
      {:else}
        {#each items as pr, index (pr.number)}
          {@const hasIssue = identity
            ? gitState.hasPrIssue(identity.owner, identity.repo, pr.number)
            : false}
          {@const Icon = icon(pr)}
          {@const labels = pr.labels ?? []}
          {@const shownLabels = labels.slice(0, VISIBLE_LABELS)}
          {@const hiddenLabels = labels.slice(VISIBLE_LABELS)}
          {@const checksState = pr.checks?.state ?? 'none'}
          {@const ChecksIcon = prChecksStateIcon(checksState)}
          {@const rowSelected = selected[pr.number] === true}
          <PrRowContextMenu
            {pr}
            targets={targetsFor(pr)}
            onOpen={(target) => onAction({ kind: 'open', targets: [target] })}
            onOpenInBrowser={(target) => onAction({ kind: 'open-in-browser', targets: [target] })}
            onCopyLinks={(targets) => onAction({ kind: 'copy-links', targets })}
            onCopyBranches={(targets) => onAction({ kind: 'copy-branches', targets })}
            onClosePullRequests={(targets) => onAction({ kind: 'close', targets })}
            onReopenPullRequests={(targets) => onAction({ kind: 'reopen', targets })}
            onExplain={(target) => onAction({ kind: 'explain', targets: [target] })}
            onQuickChat={(target) => onAction({ kind: 'quick-chat', targets: [target] })}
            onAgentReview={(target) => onAction({ kind: 'agent-review', targets: [target] })}
            onMerge={(target, method) => onAction({ kind: 'merge', targets: [target], method })}
            onMarkReady={(target) => onAction({ kind: 'mark-ready', targets: [target] })}
            onEditLabels={(target) => onAction({ kind: 'labels', targets: [target] })}
            onEditAssignees={(target) => onAction({ kind: 'assignees', targets: [target] })}
            onEditMilestone={(target) => onAction({ kind: 'milestone', targets: [target] })}
            onSelectAll={selectEveryRow}
            onClearSelection={clearSelection}
          >
            <div
              class="group flex w-full cursor-pointer items-start gap-2 border-b border-border/50 px-3 py-2 text-left transition-colors {rowSelected
                ? 'bg-primary/10'
                : 'hover:bg-elevated'}"
              role="button"
              tabindex="0"
              aria-pressed={rowSelected}
              onpointerenter={() => warmEntry(pr)}
              onfocus={() => warmEntry(pr)}
              oncontextmenu={() => {
                if (!rowSelected) selectRow(pr, index, { additive: false, range: false })
              }}
              onclick={(event: MouseEvent) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) {
                  event.preventDefault()
                  selectRow(pr, index, {
                    additive: event.metaKey || event.ctrlKey,
                    range: event.shiftKey
                  })
                  return
                }
                onOpen(pr)
              }}
              onkeydown={(event: KeyboardEvent) => {
                if (event.key === 'Enter') onOpen(pr)
              }}
            >
              <span
                class="mt-0.5 shrink-0"
                role="presentation"
                onclick={(event: MouseEvent) => {
                  event.stopPropagation()
                  event.preventDefault()
                }}
                onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
              >
                <Switch
                  checked={rowSelected}
                  onchange={() => selectRow(pr, index, { additive: true, range: false })}
                  title={rowSelected
                    ? `Deselect pull request #${pr.number}`
                    : `Select pull request #${pr.number}`}
                  aria-label={rowSelected
                    ? `Deselect pull request #${pr.number}`
                    : `Select pull request #${pr.number}`}
                  activeClass="border-primary bg-primary"
                />
              </span>
              <Icon size={13} class="mt-0.5 shrink-0 {stateClass(pr)}" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-[0.6875rem] font-medium text-foreground">{pr.title}</p>
                {#if labels.length > 0}
                  <span class="mt-1 flex min-w-0 items-center gap-1 overflow-hidden">
                    {#each shownLabels as label (label.name)}
                      <span
                        class="max-w-[9ch] truncate rounded-full px-1.5 py-0.5 text-[0.5rem] font-medium leading-none"
                        style={prLabelStyle(label.color)}
                        title={label.name}
                      >
                        {label.name}
                      </span>
                    {/each}
                    {#if hiddenLabels.length > 0}
                      <span
                        class="shrink-0 text-[0.5rem] tabular-nums text-dimmed"
                        title={hiddenLabels.map((label) => label.name).join(', ')}
                      >
                        +{hiddenLabels.length}
                      </span>
                    {/if}
                  </span>
                {/if}
                <p class="mt-0.5 flex min-w-0 items-center gap-1 text-[0.5625rem] text-dimmed">
                  <span class="truncate">#{pr.number} by {githubDisplayLogin(pr.authorLogin)}</span>
                  {#if pr.authorIsBot}
                    <BotBadge />
                  {/if}
                  <span class="shrink-0">· {relativeTime(pr.updatedAt)}</span>
                </p>
                <p class="mt-0.5 truncate font-mono text-[0.5625rem] text-dimmed">
                  {pr.headRef} → {pr.baseRef}
                </p>
                {#if pr.assignees && pr.assignees.length > 0}
                  <!--
                    Assignees and the milestone are one line of plain reports, not
                    controls: a row has two lines of room for chips before the
                    sidebar starts hiding the title, and the menu is where they are
                    changed.
                  -->
                  <p class="mt-0.5 flex min-w-0 items-center gap-1 text-[0.5625rem] text-dimmed">
                    <span class="truncate"
                      >{pr.assignees
                        .map((assignee) => githubDisplayLogin(assignee.login))
                        .join(', ')}</span
                    >
                    {#if pr.milestone}
                      <span class="shrink-0">· {pr.milestone.title}</span>
                    {/if}
                  </p>
                {:else if pr.milestone}
                  <p class="mt-0.5 truncate text-[0.5625rem] text-dimmed">{pr.milestone.title}</p>
                {/if}
              </div>
              <!--
                The row's right edge carries the review signals GitHub puts there,
                stacked so a labelled pull request with checks and comments still
                fits a sidebar width. Each one is a report, not a control: the row
                is the button, so the signals carry no hover of their own.
              -->
              <div class="flex shrink-0 flex-col items-end gap-1">
                {#if hasIssue}
                  <span
                    class="flex shrink-0 items-center gap-0.5 rounded-full bg-danger/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold text-danger"
                    title="This pull request has merge conflicts and needs resolution"
                  >
                    <TriangleAlert size={9} />
                    Conflicts
                  </span>
                {/if}
                {#if pr.checks && pr.checks.state !== 'none' && pr.checks.total > 0}
                  <span
                    class="flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[0.5625rem] font-medium tabular-nums {prChecksToneClass(
                      pr.checks.state
                    )}"
                    title="{prChecksStateLabel(pr.checks.state)}: {pr.checks.passed} of {pr.checks
                      .total}"
                  >
                    <ChecksIcon
                      size={9}
                      class={prChecksStateSpinning(pr.checks.state) ? 'animate-spin' : ''}
                    />
                    {pr.checks.passed}/{pr.checks.total}
                  </span>
                {/if}
                {#if pr.comments > 0}
                  <span
                    class="flex shrink-0 items-center gap-0.5 text-[0.5625rem] tabular-nums text-dimmed"
                    title={commentLabel(pr.comments)}
                  >
                    <MessageSquare size={10} />
                    {pr.comments}
                  </span>
                {/if}
              </div>
            </div>
          </PrRowContextMenu>
        {/each}
      {/if}
    </div>

    {#if page > 1 || hasMore}
      <div class="flex shrink-0 items-center justify-between border-t border-border px-3 py-1.5">
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
          disabled={page === 1 || loading}
          onclick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={12} />
          Previous
        </button>
        <span class="text-[0.5625rem] tabular-nums text-dimmed">Page {page}</span>
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
          disabled={!hasMore || loading}
          onpointerenter={warmNextPage}
          onfocus={warmNextPage}
          onclick={() => onPageChange(page + 1)}
        >
          Next
          <ChevronRight size={12} />
        </button>
      </div>
    {/if}
  {/if}
</div>
