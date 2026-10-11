<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    Bell,
    BellOff,
    Bookmark,
    BookmarkCheck,
    CircleDot,
    ExternalLink,
    GitCommitHorizontal,
    GitPullRequest,
    Inbox,
    Loader2,
    MessageSquare,
    Tag,
    TriangleAlert
  } from '@lucide/svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import { onMount } from 'svelte'
  import { githubNotificationsUrl } from '$lib/github-references'
  import { openInBrowser } from '$lib/open-in-browser'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { githubNotifications } from '$lib/stores/github-notifications.svelte'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
  import GitListOptionsMenu from './GitListOptionsMenu.svelte'
  import GitNotificationsGroupMenu from './GitNotificationsGroupMenu.svelte'
  import PrAvatar from './PrAvatar.svelte'
  import type {
    GitHubNotification,
    GitHubNotificationFilter,
    GitHubNotificationSort,
    GitHubNotificationTab
  } from '$shared/types'

  interface Props {
    /** Whether a GitHub account is signed in; the panel offers sign-in otherwise. */
    githubConnected: boolean
    onSignIn: () => void
  }

  let { githubConnected, onSignIn }: Props = $props()

  /**
   * Open the panel's data on first mount. The store guards against a second
   * load, so a remount after the sidebar was hidden costs nothing.
   */
  onMount(() => {
    void githubNotifications.ensureLoaded()
    // A sign-in that lands while this panel is open changes whose inbox it is,
    // and the panel is already mounted through it, so nothing else would refetch
    // the listing it was refused.
    return githubSignIn.onAuthorized(() => void githubNotifications.load())
  })

  const tabOptions: Array<{ id: GitHubNotificationTab; label: string; count: number }> = $derived([
    { id: 'inbox', label: 'Inbox', count: githubNotifications.counts.inbox },
    { id: 'saved', label: 'Saved', count: githubNotifications.counts.saved },
    { id: 'done', label: 'Done', count: githubNotifications.counts.done }
  ])

  /**
   * GitHub's own filter set. `default` is the plain inbox; the rest narrow by
   * reason, except `all`, which brings read threads back in.
   */
  const filterOptions: Array<{ id: GitHubNotificationFilter; label: string; hint: string }> = [
    { id: 'default', label: 'Inbox', hint: 'Everything still unread in your inbox' },
    { id: 'all', label: 'All', hint: 'Read and unread notifications' },
    { id: 'assigned', label: 'Assigned', hint: 'Issues and pull requests assigned to you' },
    { id: 'participating', label: 'Participating', hint: 'Threads you take part in' },
    { id: 'mentioned', label: 'Mentioned', hint: 'Threads that @mention you' },
    {
      id: 'team-mentioned',
      label: 'Team mentioned',
      hint: 'Threads that mention a team you are on'
    },
    {
      id: 'review-requested',
      label: 'Review requested',
      hint: 'Pull requests waiting on your review'
    },
    { id: 'security', label: 'Security alerts', hint: 'Vulnerabilities GitHub found' },
    { id: 'ci', label: 'CI activity', hint: 'Workflow runs you triggered' }
  ]

  const sortOptions: Array<{ id: GitHubNotificationSort; label: string }> = [
    { id: 'newest', label: 'Newest first' },
    { id: 'oldest', label: 'Oldest first' }
  ]

  const activeFilterLabel = $derived(
    filterOptions.find((option) => option.id === githubNotifications.filter)?.label ?? 'Inbox'
  )
  const activeSortLabel = $derived(
    sortOptions.find((option) => option.id === githubNotifications.sort)?.label ?? 'Newest first'
  )
  const filterNarrowed = $derived(githubNotifications.filter !== 'default')
  const sortNarrowed = $derived(githubNotifications.sort !== 'newest')

  /** Reason codes rendered as words, matching github.com's own labels. */
  const REASON_LABELS: Record<string, string> = {
    assign: 'Assigned',
    author: 'Author',
    ci_activity: 'CI activity',
    comment: 'Comment',
    invitation: 'Invitation',
    manual: 'Subscribed',
    mention: 'Mention',
    review_requested: 'Review requested',
    security_alert: 'Security alert',
    state_change: 'State change',
    subscribed: 'Watching',
    team_mention: 'Team mention',
    approval_requested: 'Approval requested'
  }

  function reasonLabel(reason: string): string {
    return REASON_LABELS[reason] ?? reason.replace(/_/gu, ' ')
  }

  /** Subject kind as its glyph, so a row reads at a glance what it addresses. */
  function subjectIcon(type: string): typeof CircleDot {
    if (type === 'PullRequest') return GitPullRequest
    if (type === 'Issue') return CircleDot
    if (type === 'Discussion') return MessageSquare
    if (type === 'Commit') return GitCommitHorizontal
    if (type === 'Release') return Tag
    return Bell
  }

  const DATE_ORDER = ['Today', 'Yesterday', 'This week', 'This month', 'Earlier'] as const

  /** The section a thread falls in under date grouping. */
  function dateGroupLabel(updatedAt: string): string {
    const timestamp = Date.parse(updatedAt)
    if (!Number.isFinite(timestamp)) return 'Earlier'
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const day = 86_400_000
    if (timestamp >= startOfToday) return 'Today'
    if (timestamp >= startOfToday - day) return 'Yesterday'
    if (timestamp >= startOfToday - 7 * day) return 'This week'
    if (timestamp >= startOfToday - 30 * day) return 'This month'
    return 'Earlier'
  }

  const sortedItems = $derived.by(() => {
    const items = [...githubNotifications.items]
    items.sort((a, b) => {
      const left = Date.parse(a.updatedAt)
      const right = Date.parse(b.updatedAt)
      return githubNotifications.sort === 'newest' ? right - left : left - right
    })
    return items
  })

  /**
   * The listing bucketed into sections. Date grouping keeps github.com's order
   * (newest bucket first); repository grouping is alphabetical by full name.
   */
  const groups = $derived.by(() => {
    const buckets: Array<{ label: string; items: GitHubNotification[] }> = []
    for (const item of sortedItems) {
      const label =
        githubNotifications.group === 'repository'
          ? item.repositoryFullName || 'Unknown repository'
          : dateGroupLabel(item.updatedAt)
      const bucket = buckets.find((entry) => entry.label === label)
      if (bucket) bucket.items.push(item)
      else buckets.push({ label, items: [item] })
    }
    buckets.sort((a, b) =>
      githubNotifications.group === 'repository'
        ? a.label.localeCompare(b.label)
        : DATE_ORDER.indexOf(a.label as (typeof DATE_ORDER)[number]) -
          DATE_ORDER.indexOf(b.label as (typeof DATE_ORDER)[number])
    )
    return buckets
  })

  /** Open the thread on github.com, marking it read here and there. */
  function openThread(item: GitHubNotification): void {
    if (item.unread) void githubNotifications.markRead(item.id)
    void openInBrowser(item.url ?? githubNotificationsUrl())
  }

  const rowTitleClass =
    'min-w-0 flex-1 cursor-pointer truncate text-left text-[0.6875rem] leading-snug transition-colors'
  const rowActionClass =
    'flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40'
</script>

<div class="relative flex h-full min-h-0 flex-col bg-app" data-region="git-notifications-panel">
  <!--
    One row: the three views, the listing's filter and ordering, then the count.
    The listing's own actions (refresh, mark all read, settings) live in the
    panel's header action group with every other view's actions. GitHub's filters
    sit here rather than in the header because none of them describe the
    repository the Git panel is standing in   notifications are account-wide.
  -->
  <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
    <div role="tablist" aria-label="Notification views" class="flex items-center gap-0.5">
      {#each tabOptions as tab (tab.id)}
        <button
          type="button"
          role="tab"
          aria-selected={githubNotifications.tab === tab.id}
          class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.625rem] font-medium transition-colors {githubNotifications.tab ===
          tab.id
            ? 'bg-elevated text-foreground'
            : 'text-muted hover:text-foreground'}"
          title="Show {tab.label.toLowerCase()} notifications"
          onclick={() => void githubNotifications.setTab(tab.id)}
        >
          {tab.label}
          {#if tab.count > 0}
            <span class="tabular-nums text-dimmed">{tab.count}</span>
          {/if}
        </button>
      {/each}
    </div>
    <GitListOptionsMenu
      filter={githubNotifications.filter}
      sort={githubNotifications.sort}
      {filterOptions}
      {sortOptions}
      onFilterChange={(next) => void githubNotifications.setFilter(next)}
      onSortChange={(next) => githubNotifications.setSort(next)}
      label="Filter and sort notifications"
      current="{activeFilterLabel}, {activeSortLabel}"
      narrowed={filterNarrowed || sortNarrowed}
      showFilter={githubNotifications.tab === 'inbox'}
    />
    <GitNotificationsGroupMenu
      group={githubNotifications.group}
      onGroupChange={(next) => githubNotifications.setGroup(next)}
    />
    <span class="min-w-0 flex-1"></span>
    <span
      class="shrink-0 cursor-default text-[0.5625rem] tabular-nums text-dimmed"
      title="Notifications shown in this view"
    >
      {githubNotifications.items.length}
    </span>
  </div>

  {#if githubNotifications.error}
    <!--
      A transient failure, in the strip every GitHub listing in the panel uses
      for one. Nothing here is actionable beyond trying again, and the panel's
      own Refresh reloads this listing, so no second control is repeated here.
    -->
    <div
      class="flex shrink-0 items-start gap-1.5 border-b border-border bg-elevated/40 px-2.5 py-1.5"
    >
      <TriangleAlert size={12} class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <p class="text-[0.625rem] leading-relaxed text-dimmed">{githubNotifications.error}</p>
    </div>
  {/if}

  {#if !githubConnected}
    <EmptyState
      icon={Bell}
      title="Sign in to GitHub"
      description="Notifications belong to your GitHub account, so sign in to read and act on them here."
    >
      {#snippet action()}
        <button
          type="button"
          class="cursor-pointer rounded-md bg-primary px-3 py-1 text-[0.6875rem] font-medium text-on-primary transition-colors hover:opacity-90"
          onclick={onSignIn}
        >
          Sign in
        </button>
      {/snippet}
    </EmptyState>
  {:else if githubNotifications.access}
    <!--
      A sign-in GitHub will not serve notifications to. It is actionable now that
      the app signs in with an OAuth App: the grant needs the notifications
      scope, and signing in again asks for it, so the panel offers the control
      instead of only stating the cause.
    -->
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <VendorIcon name="GitHub" size={20} class="text-dimmed" />
      <p class="max-w-[42ch] text-[0.6875rem] leading-relaxed text-muted">
        {githubNotifications.access.message}
      </p>
      <button
        type="button"
        class="cursor-pointer rounded-md bg-primary px-3 py-1 text-[0.6875rem] font-medium text-on-primary transition-colors hover:opacity-90"
        onclick={onSignIn}
      >
        Sign in to GitHub
      </button>
    </div>
  {:else if githubNotifications.loading && githubNotifications.items.length === 0}
    <div class="flex flex-1 items-center justify-center gap-2 text-[0.625rem] text-muted">
      <Loader2 size={14} class="animate-spin" aria-hidden="true" />
      Loading notifications
    </div>
  {:else if githubNotifications.items.length === 0}
    <EmptyState
      icon={Inbox}
      title={githubNotifications.tab === 'saved'
        ? 'Nothing saved'
        : githubNotifications.tab === 'done'
          ? 'Nothing marked done'
          : 'Inbox zero'}
      description={githubNotifications.tab === 'saved'
        ? 'Save a notification from the inbox to keep it here.'
        : githubNotifications.tab === 'done'
          ? 'Notifications you mark as done are kept here so you can restore them.'
          : 'No notifications match this view right now.'}
    />
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto px-1 py-1">
      {#each groups as group (group.label)}
        <div class="mb-1">
          <p
            class="sticky top-0 z-10 bg-app px-2 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
          >
            {group.label}
          </p>
          {#each group.items as item (item.id)}
            {@const SubjectIcon = subjectIcon(item.subjectType)}
            <div
              class="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-elevated {item.unread
                ? 'bg-primary/5'
                : ''}"
              data-notification-id={item.id}
            >
              <span
                class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full {item.unread
                  ? 'bg-primary'
                  : 'bg-transparent'}"
                aria-hidden="true"
              ></span>
              {#if item.actorLogin}
                <span class="mt-0.5 shrink-0">
                  <PrAvatar login={item.actorLogin} />
                </span>
              {:else}
                <SubjectIcon size={13} class="mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
              {/if}
              <div class="min-w-0 flex-1">
                <button
                  type="button"
                  class="{rowTitleClass} {item.unread
                    ? 'font-medium text-foreground'
                    : 'text-muted'} hover:text-primary"
                  title={item.url ?? item.title}
                  data-external-url={item.url ?? ''}
                  onclick={() => openThread(item)}
                >
                  {item.title}
                </button>
                <div class="flex items-center gap-1 text-[0.5625rem] text-dimmed">
                  <span class="truncate">{item.repositoryFullName}</span>
                  <span aria-hidden="true">·</span>
                  <span class="shrink-0">{reasonLabel(item.reason)}</span>
                  <span aria-hidden="true">·</span>
                  <span class="shrink-0" title={item.updatedAt}>{relativeTime(item.updatedAt)}</span
                  >
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  class={rowActionClass}
                  title={item.done ? 'Restore to inbox' : 'Mark as done'}
                  aria-label={item.done
                    ? 'Restore notification to inbox'
                    : 'Mark notification as done'}
                  disabled={githubNotifications.busyThreadId === item.id}
                  onclick={() => void githubNotifications.setDone(item.id, !item.done)}
                >
                  {#if item.done}
                    <ArchiveRestore size={13} aria-hidden="true" />
                  {:else}
                    <Archive size={13} aria-hidden="true" />
                  {/if}
                </button>
                <button
                  type="button"
                  class={rowActionClass}
                  title="Unsubscribe from this thread"
                  aria-label="Unsubscribe from this notification thread"
                  disabled={githubNotifications.busyThreadId === item.id}
                  onclick={() => void githubNotifications.unsubscribe(item.id)}
                >
                  <BellOff size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class={rowActionClass}
                  title={item.saved ? 'Remove from saved' : 'Save notification'}
                  aria-label={item.saved ? 'Remove notification from saved' : 'Save notification'}
                  disabled={githubNotifications.busyThreadId === item.id}
                  onclick={() => void githubNotifications.setSaved(item.id, !item.saved)}
                >
                  {#if item.saved}
                    <BookmarkCheck size={13} class="text-primary" aria-hidden="true" />
                  {:else}
                    <Bookmark size={13} aria-hidden="true" />
                  {/if}
                </button>
                <button
                  type="button"
                  class={rowActionClass}
                  title="Open on GitHub"
                  aria-label="Open notification on GitHub"
                  data-external-url={item.url ?? ''}
                  onclick={() => openThread(item)}
                >
                  <ExternalLink size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/each}

      {#if githubNotifications.tab === 'inbox' && githubNotifications.hasMore}
        <div class="flex justify-center px-2 py-2">
          <button
            type="button"
            class="cursor-pointer rounded-md border border-border px-3 py-1 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
            disabled={githubNotifications.loadingMore}
            onclick={() => void githubNotifications.loadMore()}
          >
            {githubNotifications.loadingMore ? 'Loading' : 'Load more'}
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>
