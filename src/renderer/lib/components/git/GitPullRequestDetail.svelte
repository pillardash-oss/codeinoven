<script lang="ts">
  import {
    ArrowLeft,
    Bot,
    Check,
    ExternalLink,
    GitCommitHorizontal,
    Loader2,
    MessageSquare,
    Merge,
    Send,
    ThumbsUp,
    TriangleAlert
  } from '@lucide/svelte'
  import { AlertDialog } from 'bits-ui'
  import { gitState } from '$lib/stores/git.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { relativeTime } from '$lib/format/relative-time'
  import type {
    PrMergeMethod,
    PrReviewEvent,
    PullRequestComment,
    PullRequestCommit,
    PullRequestDetail,
    PullRequestSummary
  } from '$shared/types'

  interface Props {
    projectId: string
    identity: { owner: string; repo: string }
    summary: PullRequestSummary
    onBack: () => void
    /** Hand this PR to an agent for a worktree review. */
    onAgentReview: (pr: PullRequestSummary) => void
  }

  let { projectId, identity, summary, onBack, onAgentReview }: Props = $props()

  type DetailTab = 'commits' | 'comments'

  const mergeMethods: Array<{ id: PrMergeMethod; label: string }> = [
    { id: 'squash', label: 'Squash' },
    { id: 'merge', label: 'Merge' },
    { id: 'rebase', label: 'Rebase' }
  ]

  let detail = $state<PullRequestDetail | null>(null)
  let commits = $state<PullRequestCommit[]>([])
  let comments = $state<PullRequestComment[]>([])
  let tab = $state<DetailTab>('commits')
  let loading = $state(false)
  let commentBody = $state('')
  let method = $state<PrMergeMethod>('squash')
  let mergeConfirm = $state(false)
  let notice = $state('')
  let loadedNumber = $state(0)

  const number = $derived(summary.number)
  const posting = $derived(gitState.isBusy('pr-comment'))
  const reviewing = $derived(gitState.isBusy('pr-review'))
  const merging = $derived(gitState.isBusy('pr-merge'))
  const open = $derived((detail?.state ?? summary.state) === 'open')

  async function load(): Promise<void> {
    loading = true
    loadedNumber = number
    try {
      const [nextDetail, nextCommits, nextComments] = await Promise.all([
        gitState.getPullRequest(projectId, identity.owner, identity.repo, number),
        gitState.listPullRequestCommits(projectId, identity.owner, identity.repo, number),
        gitState.listPullRequestComments(projectId, identity.owner, identity.repo, number)
      ])
      detail = nextDetail
      commits = nextCommits
      comments = nextComments
    } finally {
      loading = false
    }
  }

  async function postComment(): Promise<void> {
    const body = commentBody.trim()
    if (!body) return
    const created = await gitState.commentOnPullRequest(
      projectId,
      identity.owner,
      identity.repo,
      number,
      body
    )
    if (created) {
      comments = [...comments, created]
      commentBody = ''
      tab = 'comments'
      notice = 'Comment posted'
    }
  }

  async function submitReview(event: PrReviewEvent): Promise<void> {
    const body = commentBody.trim()
    const done = await gitState.reviewPullRequest(
      projectId,
      identity.owner,
      identity.repo,
      number,
      event,
      body
    )
    if (done) {
      commentBody = ''
      notice =
        event === 'APPROVE'
          ? 'Pull request approved'
          : event === 'REQUEST_CHANGES'
            ? 'Changes requested'
            : 'Review comment submitted'
      await load()
    }
  }

  async function merge(): Promise<void> {
    mergeConfirm = false
    const merged = await gitState.mergePullRequest(
      projectId,
      identity.owner,
      identity.repo,
      number,
      method
    )
    if (merged) {
      notice = `Merged with ${method}`
      await load()
    }
  }

  $effect(() => {
    if (number !== loadedNumber) void load()
  })
</script>

<div class="flex h-full min-h-0 flex-col">
  <!-- Header -->
  <div class="shrink-0 border-b border-border px-3 py-2">
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Back to pull requests"
        aria-label="Back to pull requests"
        onclick={onBack}
      >
        <ArrowLeft size={13} />
      </button>
      <span class="font-mono text-[10px] text-dimmed">#{number}</span>
      <span
        class="rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide {detail?.state ===
        'merged'
          ? 'bg-primary/10 text-primary'
          : detail?.state === 'closed'
            ? 'bg-danger/10 text-danger'
            : 'bg-success/10 text-success'}"
      >
        {detail?.state ?? summary.state}{summary.draft ? ' · draft' : ''}
      </span>
      <span class="flex-1"></span>
      <button
        type="button"
        class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Open pull request on GitHub"
        aria-label="Open pull request on GitHub"
        onclick={() => void openInBrowser(summary.url)}
      >
        <ExternalLink size={13} />
      </button>
    </div>
    <p class="mt-1 text-[12px] font-medium leading-snug text-foreground">{summary.title}</p>
    <p class="mt-0.5 truncate font-mono text-[9px] text-dimmed">
      {summary.headRef} → {summary.baseRef} · {summary.authorLogin} · {relativeTime(
        summary.updatedAt
      )}
    </p>
    {#if detail}
      <p class="mt-1 flex items-center gap-2 text-[9px] tabular-nums text-dimmed">
        <span class="text-success">+{detail.additions}</span>
        <span class="text-danger">−{detail.deletions}</span>
        <span>{detail.changedFiles} files</span>
        <span>{detail.commitCount} commits</span>
        {#if open && detail.mergeable === false}
          <span class="flex items-center gap-1 text-warning">
            <TriangleAlert size={10} />
            conflicts
          </span>
        {/if}
      </p>
    {/if}
  </div>

  <!-- Actions -->
  <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
    <button
      type="button"
      class="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[10px] text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title="Review this pull request with an agent"
      onclick={() => onAgentReview(summary)}
    >
      <Bot size={11} />
      Agent review
    </button>
    <button
      type="button"
      class="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[10px] text-success transition-colors hover:bg-success/10 disabled:cursor-default disabled:opacity-40"
      title="Approve this pull request"
      disabled={!open || reviewing}
      onclick={() => void submitReview('APPROVE')}
    >
      <ThumbsUp size={11} />
      Approve
    </button>
    <button
      type="button"
      class="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[10px] text-warning transition-colors hover:bg-warning/10 disabled:cursor-default disabled:opacity-40"
      title="Request changes on this pull request"
      disabled={!open || reviewing}
      onclick={() => void submitReview('REQUEST_CHANGES')}
    >
      <TriangleAlert size={11} />
      Request changes
    </button>
    <span class="flex-1"></span>
    <select
      class="h-6 cursor-pointer rounded-md border border-border bg-elevated px-1 text-[10px] text-foreground outline-none"
      title="Merge method"
      aria-label="Merge method"
      bind:value={method}
      disabled={!open}
    >
      {#each mergeMethods as option (option.id)}
        <option value={option.id}>{option.label}</option>
      {/each}
    </select>
    <button
      type="button"
      class="flex h-6 cursor-pointer items-center gap-1 rounded-md bg-primary px-2 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40"
      title="Merge this pull request"
      disabled={!open || merging}
      onclick={() => (mergeConfirm = true)}
    >
      {#if merging}
        <Loader2 size={11} class="animate-spin" />
      {:else}
        <Merge size={11} />
      {/if}
      Merge
    </button>
  </div>

  {#if notice}
    <p
      class="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1 text-[10px] text-success"
    >
      <Check size={11} />
      {notice}
    </p>
  {/if}

  <!-- Tabs -->
  <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
    <button
      type="button"
      class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[10px] font-medium transition-colors {tab ===
      'commits'
        ? 'bg-elevated text-foreground'
        : 'text-muted hover:text-foreground'}"
      onclick={() => (tab = 'commits')}
    >
      <GitCommitHorizontal size={11} />
      Commits
      {#if commits.length > 0}<span class="tabular-nums text-dimmed">{commits.length}</span>{/if}
    </button>
    <button
      type="button"
      class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[10px] font-medium transition-colors {tab ===
      'comments'
        ? 'bg-elevated text-foreground'
        : 'text-muted hover:text-foreground'}"
      onclick={() => (tab = 'comments')}
    >
      <MessageSquare size={11} />
      Comments
      {#if comments.length > 0}<span class="tabular-nums text-dimmed">{comments.length}</span>{/if}
    </button>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if loading}
      <div class="flex items-center justify-center gap-2 py-10 text-[11px] text-dimmed">
        <Loader2 size={13} class="animate-spin" />
        Loading pull request…
      </div>
    {:else if tab === 'commits'}
      {#if commits.length === 0}
        <p class="px-4 py-8 text-center text-[11px] text-dimmed">No commits on this branch.</p>
      {:else}
        {#each commits as commit (commit.sha)}
          <div class="flex items-start gap-2 border-b border-border/50 px-3 py-1.5">
            <GitCommitHorizontal size={12} class="mt-0.5 shrink-0 text-dimmed" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-[11px] text-foreground">{commit.message}</p>
              <p class="truncate text-[9px] text-dimmed">
                <span class="font-mono">{commit.shortSha}</span>
                · {commit.authorName} · {relativeTime(commit.date)}
              </p>
            </div>
          </div>
        {/each}
      {/if}
    {:else if comments.length === 0}
      <p class="px-4 py-8 text-center text-[11px] text-dimmed">No comments yet.</p>
    {:else}
      {#each comments as comment (comment.id)}
        <div class="border-b border-border/50 px-3 py-2">
          <p class="text-[9px] text-dimmed">
            {comment.authorLogin} · {relativeTime(comment.createdAt)}
          </p>
          <p
            class="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground"
          >
            {comment.body}
          </p>
        </div>
      {/each}
    {/if}
  </div>

  <!-- Comment composer -->
  <div class="shrink-0 border-t border-border px-3 py-2">
    <textarea
      class="min-h-[52px] w-full resize-y rounded-lg border border-border bg-elevated px-2 py-1.5 text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
      placeholder="Leave a comment or review note…"
      bind:value={commentBody}></textarea>
    <div class="mt-1.5 flex items-center gap-1">
      <button
        type="button"
        class="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[10px] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
        title="Submit as a review comment"
        disabled={!open || reviewing || !commentBody.trim()}
        onclick={() => void submitReview('COMMENT')}
      >
        <MessageSquare size={11} />
        Review comment
      </button>
      <span class="flex-1"></span>
      <button
        type="button"
        class="flex h-6 cursor-pointer items-center gap-1 rounded-md bg-primary px-2 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40"
        title="Post comment"
        disabled={posting || !commentBody.trim()}
        onclick={() => void postComment()}
      >
        {#if posting}
          <Loader2 size={11} class="animate-spin" />
        {:else}
          <Send size={11} />
        {/if}
        Comment
      </button>
    </div>
  </div>
</div>

<AlertDialog.Root open={mergeConfirm} onOpenChange={(value) => (mergeConfirm = value)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-black/40" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Merge pull request #{number}?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        <strong class="text-foreground">{summary.title}</strong> will be merged into
        <strong class="text-foreground">{summary.baseRef}</strong> using the
        <strong class="text-foreground">{method}</strong> method. This runs on GitHub and cannot be undone
        from here.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover"
          onclick={() => void merge()}
        >
          Merge
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
