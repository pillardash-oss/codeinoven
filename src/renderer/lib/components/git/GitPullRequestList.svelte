<script lang="ts">
  import {
    ChevronLeft,
    ChevronRight,
    GitMerge,
    GitPullRequest,
    GitPullRequestClosed,
    GitPullRequestDraft,
    Loader2,
    MessageSquare,
    RefreshCw
  } from '@lucide/svelte'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import type { PrState, PullRequestSummary } from '$shared/types'

  interface Props {
    projectId: string
    /** Repository the PRs belong to; null when origin isn't a GitHub remote. */
    identity: { owner: string; repo: string } | null
    githubConnected: boolean
    onOpen: (pr: PullRequestSummary) => void
    onSignIn: () => void
  }

  let { projectId, identity, githubConnected, onOpen, onSignIn }: Props = $props()

  const states: Array<{ id: PrState; label: string }> = [
    { id: 'open', label: 'Open' },
    { id: 'closed', label: 'Closed' },
    { id: 'all', label: 'All' }
  ]

  let prState = $state<PrState>('open')
  let page = $state(1)

  /** Cached page for the current filter — renders instantly on tab re-entry. */
  const cached = $derived(
    identity
      ? gitState.prPages[GitState.pageKey(identity.owner, identity.repo, prState, page)]
      : undefined
  )
  const items = $derived(cached?.page.items ?? [])
  const hasMore = $derived(cached?.page.hasMore ?? false)
  const loading = $derived(gitState.isBusy('pr-list'))

  async function load(force = false): Promise<void> {
    if (!identity || !githubConnected) return
    await gitState.ensurePullRequestPage(
      projectId,
      identity.owner,
      identity.repo,
      prState,
      page,
      force
    )
  }

  function selectState(next: PrState): void {
    if (next === prState) return
    prState = next
    page = 1
  }

  function icon(pr: PullRequestSummary): typeof GitPullRequest {
    if (pr.state === 'merged') return GitMerge
    if (pr.state === 'closed') return GitPullRequestClosed
    return pr.draft ? GitPullRequestDraft : GitPullRequest
  }

  function stateClass(pr: PullRequestSummary): string {
    if (pr.state === 'merged') return 'text-primary'
    if (pr.state === 'closed') return 'text-danger'
    return pr.draft ? 'text-dimmed' : 'text-success'
  }

  $effect(() => {
    // Re-runs whenever the repo, filter, or page changes; the store decides
    // whether that actually needs a network call.
    if (identity && githubConnected) {
      const owner = identity.owner
      const repo = identity.repo
      void gitState.ensurePullRequestPage(projectId, owner, repo, prState, page)
    }
  })
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if !githubConnected}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <VendorIcon name="GitHub" size={22} class="text-dimmed" />
      <p class="text-[11px] leading-relaxed text-muted">
        Sign in to GitHub to review, comment on, and merge pull requests from here.
      </p>
      <button
        type="button"
        class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary hover:bg-primary-hover"
        onclick={onSignIn}
      >
        Sign in to GitHub
      </button>
    </div>
  {:else if !identity}
    <p class="px-4 py-6 text-center text-[11px] leading-relaxed text-dimmed">
      This project's origin remote isn't a GitHub repository, so there are no pull requests to show.
    </p>
  {:else}
    <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
      {#each states as option (option.id)}
        <button
          type="button"
          class="h-6 cursor-pointer rounded-md px-2 text-[10px] font-medium transition-colors {prState ===
          option.id
            ? 'bg-elevated text-foreground'
            : 'text-muted hover:text-foreground'}"
          onclick={() => selectState(option.id)}
        >
          {option.label}
        </button>
      {/each}
      <span class="flex-1"></span>
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

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if loading && items.length === 0}
        <div class="flex items-center justify-center gap-2 py-10 text-[11px] text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Loading pull requests…
        </div>
      {:else if items.length === 0}
        <p class="px-4 py-8 text-center text-[11px] text-dimmed">
          No {prState === 'all' ? '' : prState} pull requests.
        </p>
      {:else}
        {#each items as pr (pr.number)}
          {@const Icon = icon(pr)}
          <button
            type="button"
            class="flex w-full cursor-pointer items-start gap-2 border-b border-border/50 px-3 py-2 text-left transition-colors hover:bg-elevated"
            onclick={() => onOpen(pr)}
          >
            <Icon size={13} class="mt-0.5 shrink-0 {stateClass(pr)}" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-[11px] font-medium text-foreground">{pr.title}</p>
              <p class="mt-0.5 truncate text-[9px] text-dimmed">
                #{pr.number} by {pr.authorLogin} · {relativeTime(pr.updatedAt)}
              </p>
              <p class="mt-0.5 truncate font-mono text-[9px] text-dimmed">
                {pr.headRef} → {pr.baseRef}
              </p>
            </div>
            {#if pr.comments > 0}
              <span class="flex shrink-0 items-center gap-0.5 text-[9px] tabular-nums text-dimmed">
                <MessageSquare size={10} />
                {pr.comments}
              </span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>

    {#if page > 1 || hasMore}
      <div class="flex shrink-0 items-center justify-between border-t border-border px-3 py-1.5">
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[10px] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
          disabled={page === 1 || loading}
          onclick={() => (page -= 1)}
        >
          <ChevronLeft size={11} />
          Previous
        </button>
        <span class="text-[9px] tabular-nums text-dimmed">Page {page}</span>
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[10px] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
          disabled={!hasMore || loading}
          onclick={() => (page += 1)}
        >
          Next
          <ChevronRight size={11} />
        </button>
      </div>
    {/if}
  {/if}
</div>
