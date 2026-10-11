<script lang="ts">
  import {
    ChevronLeft,
    ChevronRight,
    CircleDot,
    Loader2,
    MessageSquare,
    TriangleAlert
  } from '@lucide/svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { scheduleDeferredWork } from '$lib/deferred-work'
  import { relativeTime } from '$lib/format/relative-time'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import { githubAppInstallUrl } from '$lib/github-references'
  import { GitState, gitState } from '$lib/stores/git.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import BotBadge from './BotBadge.svelte'
  import PrStateFilter from './PrStateFilter.svelte'
  import GitListOptionsMenu from './GitListOptionsMenu.svelte'
  import IssueRowContextMenu from './IssueRowContextMenu.svelte'
  import {
    ISSUE_LIST_FILTER_OPTIONS,
    ISSUE_LIST_SORT_OPTIONS,
    issueListFilterLabel,
    issueListSortLabel,
    issueStateIcon,
    issueStateToneClass,
    type IssueListAction
  } from './issue-view'
  import { prLabelStyle } from './pr-view'
  import type { IssueListFilter, IssueListSort, IssueSummary, PrState } from '$shared/types'

  /** How many label chips a row draws before it stops, like the pull request row. */
  const VISIBLE_LABELS = 3

  interface Props {
    projectId: string
    /** Repository the issues belong to; null when origin isn't a GitHub remote. */
    identity: { owner: string; repo: string } | null
    githubConnected: boolean
    onOpen: (issue: IssueSummary) => void
    onSignIn: () => void
    onCreate: () => void
    /** Which state filter to list. Owned by the parent, which draws the filter. */
    state: PrState
    /** Which relationship to keep and how to order. Owned by the parent. */
    filter: IssueListFilter
    sort: IssueListSort
    /** Current page. Owned by the parent for the same reason. */
    page: number
    onPageChange: (page: number) => void
    onStateChange: (state: PrState) => void
    onFilterChange: (filter: IssueListFilter) => void
    onSortChange: (sort: IssueListSort) => void
    /** One hand-off for every row action, so the list only renders rows. */
    onAction: (action: IssueListAction) => void
    /** The Git panel draws the filter and the actions itself, so it passes false. */
    showControls?: boolean
  }

  let {
    projectId,
    identity,
    githubConnected,
    onOpen,
    onSignIn,
    onCreate,
    state,
    filter,
    sort,
    page,
    onPageChange,
    onStateChange,
    onFilterChange,
    onSortChange,
    onAction,
    showControls = true
  }: Props = $props()

  const query = $derived({ filter, sort })

  /** The key this listing is cached and requested under, shared with the store. */
  const pageKey = $derived(
    identity ? GitState.issuePageKey(identity.owner, identity.repo, state, filter, sort, page) : ''
  )

  const cachedPage = $derived(identity ? gitState.issuePages[pageKey]?.page : undefined)
  const items = $derived(cachedPage?.items ?? [])
  const hasMore = $derived(cachedPage?.hasMore ?? false)
  const accessError = $derived(cachedPage?.accessError ?? null)
  const transientError = $derived(cachedPage?.transientError ?? null)
  const loading = $derived(gitState.isBusy('issue-list'))

  async function load(force = false): Promise<void> {
    if (!identity) return
    await gitState.ensureIssuePage(
      projectId,
      identity.owner,
      identity.repo,
      state,
      page,
      query,
      force
    )
  }

  $effect(() => {
    // Every input is read here so the effect re-runs when the listing identity
    // changes; `load` itself only reads what it is given.
    const owner = identity?.owner
    const repo = identity?.repo
    const listState = state
    const listPage = page
    const listing = query
    if (!projectId || !owner || !repo) return
    void gitState.ensureIssuePage(projectId, owner, repo, listState, listPage, listing, false)
  })

  /** Warm the issue under the pointer so the click that opens it renders from cache. */
  function warm(issue: IssueSummary): void {
    if (!identity) return
    scheduleDeferredWork(`git:issue-preload:${projectId}`, () => {
      void gitState.preloadIssueBundle(projectId, identity.owner, identity.repo, issue.number)
    })
  }

  function warmNextPage(): void {
    if (!identity || !hasMore) return
    scheduleDeferredWork(`git:issue-page-preload:${projectId}`, () => {
      void gitState.preloadIssueNextPage(
        projectId,
        identity.owner,
        identity.repo,
        state,
        page,
        query
      )
    })
  }

  const narrowed = $derived(filter !== 'all' || sort !== 'updated')

  function commentLabel(count: number): string {
    return count === 1 ? '1 comment' : `${count} comments`
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if !githubConnected}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <VendorIcon name="GitHub" size={20} />
      <p class="text-[0.6875rem] leading-relaxed text-dimmed">
        Sign in to GitHub to read this repository's issues.
      </p>
      <button
        type="button"
        class="h-8 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover"
        onclick={onSignIn}
      >
        Sign in to GitHub
      </button>
    </div>
  {:else if !identity}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <VendorIcon name="GitHub" size={20} />
      <p class="text-[0.6875rem] leading-relaxed text-dimmed">
        This project's origin is not a GitHub repository.
      </p>
    </div>
  {:else}
    {#if showControls}
      <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <PrStateFilter {state} onSelect={onStateChange} />
        <span class="flex-1"></span>
        <GitListOptionsMenu
          {filter}
          {sort}
          filterOptions={ISSUE_LIST_FILTER_OPTIONS}
          sortOptions={ISSUE_LIST_SORT_OPTIONS}
          {onFilterChange}
          {onSortChange}
          label="Filter and sort issues"
          current="{issueListFilterLabel(filter)}, {issueListSortLabel(sort)}"
          {narrowed}
        />
        <button
          type="button"
          class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Refresh issues"
          aria-label="Refresh issues"
          onclick={() => void load(true)}
        >
          <Loader2 size={11} class={loading ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          class="h-6 shrink-0 cursor-pointer rounded-md bg-primary px-2 text-[0.625rem] font-medium text-on-primary hover:bg-primary-hover"
          onclick={onCreate}
        >
          New issue
        </button>
      </div>
    {/if}

    {#if accessError && items.length > 0}
      <div
        class="flex shrink-0 items-start gap-1.5 border-b border-border bg-elevated/40 px-2.5 py-1.5"
      >
        <TriangleAlert size={12} class="mt-0.5 shrink-0 text-warning" />
        <p class="text-[0.625rem] leading-relaxed text-dimmed">{accessError}</p>
      </div>
    {/if}
    {#if transientError && items.length > 0}
      <div
        class="flex shrink-0 items-start gap-1.5 border-b border-border bg-elevated/40 px-2.5 py-1.5"
      >
        <TriangleAlert size={12} class="mt-0.5 shrink-0 text-warning" />
        <p class="text-[0.625rem] leading-relaxed text-dimmed">{transientError}</p>
      </div>
    {/if}

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if loading && items.length === 0}
        <div class="flex items-center justify-center gap-2 py-10 text-[0.6875rem] text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Loading issues…
        </div>
      {:else if accessError && items.length === 0}
        <div class="flex flex-col items-center gap-3 px-5 py-8 text-center">
          <TriangleAlert size={18} class="text-danger" />
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
      {:else if transientError && items.length === 0}
        <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <TriangleAlert size={18} class="text-warning" />
          <p class="text-[0.625rem] leading-relaxed text-dimmed">{transientError}</p>
        </div>
      {:else if items.length === 0}
        <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <CircleDot size={18} class="text-dimmed" />
          <p class="text-[0.6875rem] leading-relaxed text-dimmed">
            No {state === 'all' ? '' : state} issues.
          </p>
          {#if filter !== 'all'}
            <p class="text-[0.5625rem] leading-relaxed text-dimmed">
              The {issueListFilterLabel(filter)} filter is on.
            </p>
          {/if}
        </div>
      {:else}
        {#each items as issue (issue.number)}
          {@const Icon = issueStateIcon(issue)}
          {@const labels = issue.labels ?? []}
          {@const shownLabels = labels.slice(0, VISIBLE_LABELS)}
          {@const hiddenLabels = labels.slice(VISIBLE_LABELS)}
          <IssueRowContextMenu
            {issue}
            onOpen={(target) => onAction({ kind: 'open', targets: [target] })}
            onOpenInBrowser={(target) => onAction({ kind: 'open-in-browser', targets: [target] })}
            onCopyLink={(target) => onAction({ kind: 'copy-links', targets: [target] })}
            onWorkOn={(target) => onAction({ kind: 'work-on', targets: [target] })}
            onCreatePullRequest={(target) => onAction({ kind: 'create-pr', targets: [target] })}
            onEditLabels={(target) => onAction({ kind: 'labels', targets: [target] })}
            onEditAssignees={(target) => onAction({ kind: 'assignees', targets: [target] })}
            onEditMilestone={(target) => onAction({ kind: 'milestone', targets: [target] })}
            onClose={(target) => onAction({ kind: 'close', targets: [target] })}
            onReopen={(target) => onAction({ kind: 'reopen', targets: [target] })}
          >
            <div
              class="group flex w-full cursor-pointer items-start gap-2 border-b border-border/50 px-3 py-2 text-left transition-colors hover:bg-elevated"
              role="button"
              tabindex="0"
              onpointerenter={() => warm(issue)}
              onfocus={() => warm(issue)}
              onclick={() => onOpen(issue)}
              onkeydown={(event: KeyboardEvent) => {
                if (keymapState.matches('ui-activate', event)) onOpen(issue)
              }}
            >
              <Icon size={13} class="mt-0.5 shrink-0 {issueStateToneClass(issue)}" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-[0.6875rem] font-medium text-foreground">{issue.title}</p>
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
                  <span class="truncate"
                    >#{issue.number} by {githubDisplayLogin(issue.authorLogin)}</span
                  >
                  {#if issue.authorIsBot}
                    <BotBadge />
                  {/if}
                  <span class="shrink-0">· {relativeTime(issue.updatedAt)}</span>
                </p>
                {#if (issue.assignees && issue.assignees.length > 0) || issue.milestone}
                  <p class="mt-0.5 flex min-w-0 items-center gap-1 text-[0.5625rem] text-dimmed">
                    {#if issue.assignees && issue.assignees.length > 0}
                      <span class="truncate"
                        >{issue.assignees
                          .map((assignee) => githubDisplayLogin(assignee.login))
                          .join(', ')}</span
                      >
                    {/if}
                    {#if issue.milestone}
                      <span class="shrink-0">· {issue.milestone.title}</span>
                    {/if}
                  </p>
                {/if}
              </div>
              <div class="flex shrink-0 flex-col items-end gap-1">
                {#if issue.comments > 0}
                  <span
                    class="flex shrink-0 items-center gap-0.5 text-[0.5625rem] tabular-nums text-dimmed"
                    title={commentLabel(issue.comments)}
                  >
                    <MessageSquare size={10} />
                    {issue.comments}
                  </span>
                {/if}
              </div>
            </div>
          </IssueRowContextMenu>
        {/each}
      {/if}
    </div>

    {#if page > 1 || hasMore}
      <div
        class="flex shrink-0 items-center justify-between gap-2 border-t border-border px-2 py-1.5"
      >
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          disabled={page <= 1}
          onclick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={11} />
          Previous
        </button>
        <span class="text-[0.5625rem] tabular-nums text-dimmed">Page {page}</span>
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!hasMore}
          onpointerenter={warmNextPage}
          onclick={() => onPageChange(page + 1)}
        >
          Next
          <ChevronRight size={11} />
        </button>
      </div>
    {/if}
  {/if}
</div>
