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
    ShieldCheck,
    TriangleAlert
  } from '@lucide/svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import { githubAppInstallUrl } from '$lib/github-references'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import PrListOptionsMenu from './PrListOptionsMenu.svelte'
  import PrStateFilter from './PrStateFilter.svelte'
  import { prChecksStateLabel, prChecksToneClass, prLabelStyle, prListFilterLabel } from './pr-view'
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
    showControls = true
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

<div class="flex h-full min-h-0 flex-col">
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
        {#each items as pr (pr.number)}
          {@const hasIssue = identity
            ? gitState.hasPrIssue(identity.owner, identity.repo, pr.number)
            : false}
          {@const Icon = icon(pr)}
          {@const labels = pr.labels ?? []}
          {@const shownLabels = labels.slice(0, VISIBLE_LABELS)}
          {@const hiddenLabels = labels.slice(VISIBLE_LABELS)}
          <button
            type="button"
            class="flex w-full cursor-pointer items-start gap-2 border-b border-border/50 px-3 py-2 text-left transition-colors hover:bg-elevated"
            onclick={() => onOpen(pr)}
          >
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
              <p class="mt-0.5 truncate text-[0.5625rem] text-dimmed">
                #{pr.number} by {githubDisplayLogin(pr.authorLogin)} · {relativeTime(pr.updatedAt)}
              </p>
              <p class="mt-0.5 truncate font-mono text-[0.5625rem] text-dimmed">
                {pr.headRef} → {pr.baseRef}
              </p>
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
                  <ShieldCheck size={9} />
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
          </button>
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
          onclick={() => onPageChange(page + 1)}
        >
          Next
          <ChevronRight size={12} />
        </button>
      </div>
    {/if}
  {/if}
</div>
