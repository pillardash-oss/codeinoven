<script lang="ts">
  import {
    ArrowLeft,
    Bot,
    Check,
    CircleDot,
    CircleSlash,
    ExternalLink,
    FileDiff,
    GitCommitHorizontal,
    Loader2,
    MessageSquare,
    Merge,
    MessagesSquare,
    RefreshCw,
    RotateCcw,
    Send,
    ShieldCheck,
    ThumbsUp,
    TriangleAlert,
    X
  } from '@lucide/svelte'
  import { AlertDialog } from 'bits-ui'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { relativeTime } from '$lib/format/relative-time'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import type {
    PrAgentReport,
    PrMergeMethod,
    PrReviewEvent,
    PullRequestCheck,
    PullRequestFile,
    PullRequestSummary
  } from '$shared/types'

  interface Props {
    projectId: string
    identity: { owner: string; repo: string }
    summary: PullRequestSummary
    onBack: () => void
    /** Hand this PR to an agent for a worktree review. */
    onAgentReview: (pr: PullRequestSummary) => void
    /** Reopen the thread that owns this PR's agent review. */
    onOpenThread: (threadId: string) => void
  }

  let { projectId, identity, summary, onBack, onAgentReview, onOpenThread }: Props = $props()

  type DetailTab = 'conversation' | 'commits' | 'files' | 'checks' | 'agent'

  const mergeMethods: Array<{ id: PrMergeMethod; label: string }> = [
    { id: 'squash', label: 'Squash' },
    { id: 'merge', label: 'Merge' },
    { id: 'rebase', label: 'Rebase' }
  ]

  let tab = $state<DetailTab>('conversation')
  let commentBody = $state('')
  let method = $state<PrMergeMethod>('squash')
  let mergeConfirm = $state(false)
  let closeConfirm = $state(false)
  let commitTitle = $state('')
  let commitMessage = $state('')
  let notice = $state('')
  let expandedCommit = $state<string | null>(null)
  let commitFiles = $state<Record<string, PullRequestFile[]>>({})
  let loadingCommit = $state<string | null>(null)
  let expandedFile = $state<string | null>(null)
  let agentReport = $state<PrAgentReport | null>(null)

  const number = $derived(summary.number)
  const bundle = $derived(
    gitState.prBundles[GitState.bundleKey(identity.owner, identity.repo, number)]
  )
  const detail = $derived(bundle?.detail ?? null)
  const checks = $derived(bundle?.checks ?? null)
  const loading = $derived(gitState.isBusy('pr-detail') && !bundle)
  const posting = $derived(gitState.isBusy('pr-comment'))
  const reviewing = $derived(gitState.isBusy('pr-review'))
  const merging = $derived(gitState.isBusy('pr-merge'))
  const reopening = $derived(gitState.isBusy('pr-reopen'))
  const closing = $derived(gitState.isBusy('pr-close'))
  const prState = $derived(detail?.state ?? summary.state)
  const open = $derived(prState === 'open')
  const hasBody = $derived(commentBody.trim().length > 0)
  /** Why merging may not be a good idea right now — shown next to the button. */
  const mergeBlocker = $derived.by(() => {
    if (!open) return ''
    if (detail?.mergeable === false) return 'conflicts with the base branch'
    if (checks?.state === 'failure') return 'checks are failing'
    if (checks?.state === 'pending') return 'checks are still running'
    return ''
  })

  /**
   * Conversation as one chronological stream: the PR description, issue
   * comments, submitted reviews, and inline code comments — the same context
   * GitHub shows, so a merge decision never needs the browser.
   */
  const conversation = $derived.by(() => {
    if (!bundle) return []
    const entries: Array<{
      key: string
      author: string
      at: string
      body: string
      kind: 'description' | 'comment' | 'review' | 'inline'
      meta?: string
    }> = []
    if (bundle.detail.body.trim()) {
      entries.push({
        key: 'body',
        author: bundle.detail.authorLogin,
        at: bundle.detail.createdAt,
        body: bundle.detail.body,
        kind: 'description'
      })
    }
    for (const comment of bundle.comments) {
      entries.push({
        key: `c${comment.id}`,
        author: comment.authorLogin,
        at: comment.createdAt,
        body: comment.body,
        kind: 'comment'
      })
    }
    for (const review of bundle.reviews) {
      entries.push({
        key: `r${review.id}`,
        author: review.authorLogin,
        at: review.submittedAt,
        body: review.body,
        kind: 'review',
        meta: review.state.replace(/_/gu, ' ').toLowerCase()
      })
    }
    for (const comment of bundle.reviewComments) {
      entries.push({
        key: `rc${comment.id}`,
        author: comment.authorLogin,
        at: comment.createdAt,
        body: comment.body,
        kind: 'inline',
        meta: comment.line === null ? comment.path : `${comment.path}:${comment.line}`
      })
    }
    return entries
      .filter((entry) => entry.body.trim() || entry.kind === 'review')
      .sort((a, b) => Date.parse(a.at || '0') - Date.parse(b.at || '0'))
  })

  type EntryKind = 'description' | 'comment' | 'review' | 'inline'

  /** Human label for a conversation entry's badge. */
  function kindLabel(kind: EntryKind, meta?: string): string {
    if (kind === 'description') return 'description'
    if (kind === 'inline') return 'inline review'
    if (kind === 'review') return meta ?? 'review'
    return 'comment'
  }

  /** Badge colour — approvals and change requests read at a glance. */
  function kindClass(kind: EntryKind, meta?: string): string {
    if (kind === 'review' && meta === 'approved') return 'bg-success/10 text-success'
    if (kind === 'review' && meta === 'changes requested') return 'bg-warning/10 text-warning'
    if (kind === 'description') return 'bg-primary/10 text-primary'
    return 'bg-elevated text-dimmed'
  }

  /** Matching left edge on the card so the stream scans vertically. */
  function accentClass(kind: EntryKind, meta?: string): string {
    if (kind === 'review' && meta === 'approved') return 'border-l-2 border-l-success'
    if (kind === 'review' && meta === 'changes requested') return 'border-l-2 border-l-warning'
    if (kind === 'description') return 'border-l-2 border-l-primary'
    return ''
  }

  /** Badge colour for the PR state pill in the header. */
  function stateBadgeClass(state: string): string {
    if (state === 'merged') return 'bg-primary/10 text-primary'
    if (state === 'closed') return 'bg-danger/10 text-danger'
    return 'bg-success/10 text-success'
  }

  /** Badge colour for the checks-summary pill in the header. */
  function checksBadgeClass(state: string): string {
    if (state === 'failure') return 'bg-danger/10 text-danger hover:bg-danger/20'
    if (state === 'pending') return 'bg-warning/10 text-warning hover:bg-warning/20'
    return 'bg-success/10 text-success hover:bg-success/20'
  }

  /** Stable background colour for an author's avatar, keyed off their name. */
  const avatarPalette = [
    'bg-primary/20 text-primary',
    'bg-success/20 text-success',
    'bg-warning/20 text-warning',
    'bg-danger/20 text-danger',
    'bg-accent/20 text-accent'
  ]
  function avatarClass(author: string): string {
    let hash = 0
    for (let i = 0; i < author.length; i += 1) hash = (hash * 31 + author.charCodeAt(i)) | 0
    return avatarPalette[Math.abs(hash) % avatarPalette.length]
  }

  async function refresh(): Promise<void> {
    await gitState.ensurePullRequestBundle(projectId, identity.owner, identity.repo, number, true)
    agentReport = await gitState.loadAgentReport(projectId, number)
  }

  async function toggleCommit(sha: string): Promise<void> {
    if (expandedCommit === sha) {
      expandedCommit = null
      return
    }
    expandedCommit = sha
    if (commitFiles[sha]) return
    loadingCommit = sha
    try {
      const files = await gitState.getCommitFiles(projectId, identity.owner, identity.repo, sha)
      commitFiles = { ...commitFiles, [sha]: files }
    } finally {
      loadingCommit = null
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
      commentBody = ''
      tab = 'conversation'
      notice = 'Comment posted'
      await refresh()
    }
  }

  async function submitReview(event: PrReviewEvent): Promise<void> {
    const done = await gitState.reviewPullRequest(
      projectId,
      identity.owner,
      identity.repo,
      number,
      event,
      commentBody.trim()
    )
    if (done) {
      commentBody = ''
      notice =
        event === 'APPROVE'
          ? 'Pull request approved'
          : event === 'REQUEST_CHANGES'
            ? 'Changes requested'
            : 'Review comment submitted'
      await refresh()
    }
  }

  async function merge(): Promise<void> {
    mergeConfirm = false
    // GitHub ignores custom title/message for rebase, which preserves the
    // original commits. Trimmed-empty values are omitted so GitHub uses its own.
    const merged = await gitState.mergePullRequest(
      projectId,
      identity.owner,
      identity.repo,
      number,
      method,
      method === 'rebase' ? undefined : commitTitle.trim() || undefined,
      method === 'rebase' ? undefined : commitMessage.trim() || undefined
    )
    if (merged) {
      notice = `Merged with ${method}`
      await refresh()
    }
  }

  /** Prefill the merge commit title/message the way GitHub does, per method. */
  function openMergeConfirm(): void {
    commitTitle =
      method === 'merge' ? `Merge pull request #${number} from ${summary.headRef}` : summary.title
    commitMessage = method === 'squash' ? (detail?.body ?? '') : ''
    mergeConfirm = true
  }

  /** Reopen a closed pull request, the same way GitHub does. */
  async function reopen(): Promise<void> {
    const reopened = await gitState.reopenPullRequest(
      projectId,
      identity.owner,
      identity.repo,
      number
    )
    if (reopened) {
      notice = 'Pull request reopened'
      await refresh()
    }
  }

  /** Close an open pull request without merging, the same way GitHub does. */
  async function closePullRequest(): Promise<void> {
    closeConfirm = false
    const closed = await gitState.closePullRequest(projectId, identity.owner, identity.repo, number)
    if (closed) {
      notice = 'Pull request closed'
      await refresh()
    }
  }

  /** Post the agent's report into the PR conversation, verbatim. */
  async function postAgentReport(): Promise<void> {
    if (!agentReport?.content.trim()) return
    const created = await gitState.commentOnPullRequest(
      projectId,
      identity.owner,
      identity.repo,
      number,
      agentReport.content
    )
    if (created) {
      notice = 'Agent review posted to the pull request'
      tab = 'conversation'
      await refresh()
    }
  }

  function checkIcon(check: PullRequestCheck): typeof Check {
    if (check.status !== 'completed') return CircleDot
    if (check.conclusion === 'success') return Check
    if (check.conclusion === 'skipped' || check.conclusion === 'neutral') return CircleSlash
    return X
  }

  function checkClass(check: PullRequestCheck): string {
    if (check.status !== 'completed') return 'text-warning'
    if (check.conclusion === 'success') return 'text-success'
    if (check.conclusion === 'skipped' || check.conclusion === 'neutral') return 'text-dimmed'
    return 'text-danger'
  }

  /** Colorize a unified patch the way the rest of the app renders diffs. */
  function patchLineClass(line: string): string {
    if (line.startsWith('@@')) return 'text-primary'
    if (line.startsWith('+')) return 'bg-success/10 text-success'
    if (line.startsWith('-')) return 'bg-danger/10 text-danger'
    return 'text-muted'
  }

  $effect(() => {
    const owner = identity.owner
    const repo = identity.repo
    void gitState.ensurePullRequestBundle(projectId, owner, repo, number)
  })

  $effect(() => {
    const pull = number
    void gitState.loadAgentReport(projectId, pull).then((report) => {
      agentReport = report
    })
  })
</script>

{#snippet emptyState(Icon: typeof Bot, text: string)}
  <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
    <Icon size={18} class="text-dimmed" />
    <p class="text-[11px] leading-relaxed text-dimmed">{text}</p>
  </div>
{/snippet}

{#snippet fileList(files: PullRequestFile[], keyPrefix: string)}
  {#each files as file (file.path)}
    {@const fileKey = `${keyPrefix}:${file.path}`}
    <div class="border-b border-border/50">
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-elevated"
        onclick={() => (expandedFile = expandedFile === fileKey ? null : fileKey)}
      >
        <FileDiff size={12} class="shrink-0 text-dimmed" />
        <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground">
          {file.path}
        </span>
        <span class="shrink-0 text-[9px] tabular-nums">
          <span class="text-success">+{file.additions}</span>
          <span class="text-danger">−{file.deletions}</span>
        </span>
      </button>
      {#if expandedFile === fileKey}
        {#if file.patch}
          <pre
            class="overflow-x-auto bg-elevated/40 px-3 py-1.5 font-mono text-[9px] leading-relaxed"><!--
         -->{#each file.patch.split('\n') as line, index (index)}<span
                class="block {patchLineClass(line)}">{line || ' '}</span
              >{/each}</pre>
        {:else}
          <p class="px-3 py-2 text-[10px] text-dimmed">
            No inline diff for this file (binary or too large).
          </p>
        {/if}
      {/if}
    </div>
  {/each}
{/snippet}

<div class="flex h-full min-h-0 flex-col">
  <!-- Header -->
  <div class="shrink-0 border-b border-border px-3 py-2.5">
    <div class="flex items-center gap-1.5">
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
        class="rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide {stateBadgeClass(
          detail?.state ?? summary.state
        )}"
      >
        {detail?.state ?? summary.state}{summary.draft ? ' · draft' : ''}
      </span>
      {#if checks && checks.state !== 'none'}
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors {checksBadgeClass(
            checks.state
          )}"
          title="View check results"
          onclick={() => (tab = 'checks')}
        >
          <ShieldCheck size={10} />
          {checks.state === 'failure'
            ? 'checks failing'
            : checks.state === 'pending'
              ? 'checks running'
              : 'checks passing'}
        </button>
      {/if}
      <span class="flex-1"></span>
      <button
        type="button"
        class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-50"
        title="Refresh pull request"
        aria-label="Refresh pull request"
        disabled={gitState.isBusy('pr-detail')}
        onclick={() => void refresh()}
      >
        <RefreshCw size={12} class={gitState.isBusy('pr-detail') ? 'animate-spin' : ''} />
      </button>
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
    <p class="mt-1.5 text-[12px] font-medium leading-snug text-foreground">{summary.title}</p>
    <p class="mt-1 truncate font-mono text-[9px] text-dimmed">
      {summary.headRef} → {summary.baseRef} · {summary.authorLogin} · {relativeTime(
        summary.updatedAt
      )}
    </p>
    {#if detail}
      <p class="mt-1.5 flex items-center gap-2 text-[9px] tabular-nums text-dimmed">
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

  {#if notice}
    <p
      class="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1 text-[10px] text-success"
    >
      <Check size={12} />
      {notice}
    </p>
  {/if}

  <!-- Tabs -->
  <div
    class="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1.5"
  >
    {#each [{ id: 'conversation' as const, label: 'Conversation', icon: MessagesSquare, count: conversation.length }, { id: 'commits' as const, label: 'Commits', icon: GitCommitHorizontal, count: bundle?.commits.length ?? 0 }, { id: 'files' as const, label: 'Files', icon: FileDiff, count: bundle?.files.length ?? 0 }, { id: 'checks' as const, label: 'Checks', icon: ShieldCheck, count: checks?.checks.length ?? 0 }, { id: 'agent' as const, label: 'Agent', icon: Bot, count: agentReport?.content ? 1 : 0 }] as entry (entry.id)}
      {@const Icon = entry.icon}
      <button
        type="button"
        class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[10px] font-medium transition-colors {tab ===
        entry.id
          ? 'bg-elevated text-foreground'
          : 'text-muted hover:text-foreground'}"
        onclick={() => (tab = entry.id)}
      >
        <Icon size={12} />
        {entry.label}
        {#if entry.count > 0}<span class="tabular-nums text-dimmed">{entry.count}</span>{/if}
      </button>
    {/each}
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if loading}
      <div class="flex items-center justify-center gap-2 py-10 text-[11px] text-dimmed">
        <Loader2 size={13} class="animate-spin" />
        Loading pull request…
      </div>
    {:else if tab === 'conversation'}
      {#if conversation.length === 0}
        {@render emptyState(MessagesSquare, 'Nothing has been said yet.')}
      {:else}
        <div class="flex flex-col gap-2 p-2">
          {#each conversation as entry (entry.key)}
            <article
              class="overflow-hidden rounded-lg border border-border bg-surface {accentClass(
                entry.kind,
                entry.meta
              )}"
            >
              <header
                class="flex items-center gap-1.5 border-b border-border/60 bg-elevated/50 px-2.5 py-1.5"
              >
                <span
                  class="flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold uppercase {avatarClass(
                    entry.author
                  )}"
                  aria-hidden="true"
                >
                  {entry.author.slice(0, 1)}
                </span>
                <span class="truncate text-[11px] font-medium text-foreground">{entry.author}</span>
                <span
                  class="shrink-0 rounded px-1.5 py-px text-[9px] font-medium {kindClass(
                    entry.kind,
                    entry.meta
                  )}"
                >
                  {kindLabel(entry.kind, entry.meta)}
                </span>
                <span class="flex-1"></span>
                <span class="shrink-0 text-[9px] text-dimmed">{relativeTime(entry.at)}</span>
              </header>
              {#if entry.kind === 'inline' && entry.meta}
                <p
                  class="truncate border-b border-border/40 bg-elevated/20 px-2.5 py-1 font-mono text-[9px] text-dimmed"
                >
                  {entry.meta}
                </p>
              {/if}
              {#if entry.body.trim()}
                <div class="px-2.5 py-2">
                  <!-- GitHub's dialect includes HTML, so PR prose needs it to
                       read correctly; the sanitizer still strips anything
                       executable. Agent-authored text elsewhere keeps it off. -->
                  <MarkdownView text={entry.body} class="text-[11px] leading-relaxed" allowHtml />
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    {:else if tab === 'commits'}
      {#if !bundle || bundle.commits.length === 0}
        {@render emptyState(GitCommitHorizontal, 'No commits on this branch.')}
      {:else}
        {#each bundle.commits as commit (commit.sha)}
          <div class="border-b border-border/50">
            <button
              type="button"
              class="flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-elevated"
              title="Show the files changed in {commit.shortSha}"
              onclick={() => void toggleCommit(commit.sha)}
            >
              <GitCommitHorizontal size={12} class="mt-0.5 shrink-0 text-dimmed" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-[11px] text-foreground">{commit.message}</p>
                <p class="truncate text-[9px] text-dimmed">
                  <span class="font-mono">{commit.shortSha}</span>
                  · {commit.authorName} · {relativeTime(commit.date)}
                </p>
              </div>
              {#if loadingCommit === commit.sha}
                <Loader2 size={12} class="mt-0.5 shrink-0 animate-spin text-dimmed" />
              {/if}
            </button>
            {#if expandedCommit === commit.sha}
              {@const files = commitFiles[commit.sha] ?? []}
              {#if files.length === 0 && loadingCommit !== commit.sha}
                <p class="px-3 py-2 text-[10px] text-dimmed">No files in this commit.</p>
              {:else}
                <div class="border-t border-border/50 bg-elevated/20">
                  {@render fileList(files, commit.sha)}
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      {/if}
    {:else if tab === 'files'}
      {#if !bundle || bundle.files.length === 0}
        {@render emptyState(FileDiff, 'No changed files.')}
      {:else}
        {@render fileList(bundle.files, 'pr')}
      {/if}
    {:else if tab === 'checks'}
      {#if !checks || checks.checks.length === 0}
        {@render emptyState(ShieldCheck, 'No checks have reported on this branch.')}
      {:else}
        {#each checks.checks as check (check.name + (check.url ?? ''))}
          {@const Icon = checkIcon(check)}
          <div class="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
            <Icon size={12} class="shrink-0 {checkClass(check)}" />
            <span class="min-w-0 flex-1 truncate text-[11px] text-foreground">{check.name}</span>
            <span class="shrink-0 text-[9px] text-dimmed">
              {check.status === 'completed' ? (check.conclusion ?? 'done') : check.status}
            </span>
            {#if check.url}
              <button
                type="button"
                class="shrink-0 cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                title="Open {check.name} results"
                aria-label="Open {check.name} results"
                onclick={() => void openInBrowser(check.url ?? '')}
              >
                <ExternalLink size={12} />
              </button>
            {/if}
          </div>
        {/each}
      {/if}
    {:else if agentReport?.content.trim()}
      <div class="px-3 py-2">
        <div class="mb-2 flex items-center gap-2">
          <p class="flex-1 truncate text-[9px] text-dimmed">
            {agentReport.path} · {relativeTime(agentReport.updatedAt)}
          </p>
          {#if agentReport.threadId}
            <button
              type="button"
              class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[10px] text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="Open the thread that produced this review"
              onclick={() => onOpenThread(agentReport?.threadId ?? '')}
            >
              <Bot size={12} />
              Open thread
            </button>
          {/if}
          <button
            type="button"
            class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[10px] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
            title="Post this report as a comment on the pull request"
            disabled={posting}
            onclick={() => void postAgentReport()}
          >
            <Send size={12} />
            Post to PR
          </button>
        </div>
        <MarkdownView text={agentReport.content} class="text-[11px] leading-relaxed" />
      </div>
    {:else}
      <div class="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <Bot size={18} class="text-dimmed" />
        <p class="text-[11px] leading-relaxed text-muted">
          No agent review yet. "Agent review" opens a thread where an agent checks this PR out in a
          worktree and writes its findings to <span class="font-mono"
            >.cio/git/pr/{number}/review.md</span
          >. The report shows up here when it lands.
        </p>
        <div class="flex items-center gap-2">
          {#if agentReport?.threadId}
            <button
              type="button"
              class="flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-border px-3 text-[11px] font-medium text-muted hover:bg-elevated hover:text-foreground"
              title="Open the review thread already running for this pull request"
              onclick={() => onOpenThread(agentReport?.threadId ?? '')}
            >
              <Bot size={12} />
              Open review thread
            </button>
          {/if}
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary hover:bg-primary-hover"
            onclick={() => onAgentReview(summary)}
          >
            <Bot size={12} />
            Start agent review
          </button>
        </div>
      </div>
    {/if}
  </div>

  <!--
    Everything that consumes what you write lives here, under the editor.
    Approve and Request changes used to sit in a bar at the top of the panel,
    far from the text they submit — which is why requesting changes with an
    empty box only failed once GitHub rejected it.
  -->
  <div class="shrink-0 border-t border-border">
    <div class="px-3 pt-2.5">
      <div
        class="rounded-lg border border-border bg-elevated focus-within:border-primary"
        role="presentation"
      >
        <RichMarkdownEditor
          bind:value={commentBody}
          placeholder="Leave a comment, or write the feedback for a review…"
          ariaLabel="Pull request comment"
          class="max-h-40 min-h-[52px] w-full overflow-y-auto px-2 py-1.5 text-[11px] leading-relaxed text-foreground outline-none"
        />
      </div>
    </div>

    <!-- Comment and review both consume the box above, so they share one row. -->
    <div class="flex flex-wrap items-center gap-1.5 px-3 py-2.5">
      <button
        type="button"
        class="flex h-7 cursor-pointer items-center gap-1 rounded-md bg-primary px-2.5 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40"
        title={hasBody ? 'Post this as a comment' : 'Write something first'}
        disabled={posting || !hasBody}
        onclick={() => void postComment()}
      >
        {#if posting}
          <Loader2 size={12} class="animate-spin" />
        {:else}
          <MessageSquare size={12} />
        {/if}
        Comment
      </button>
      <span class="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>
      <button
        type="button"
        class="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 text-[10px] font-medium text-success transition-colors hover:bg-success/10 disabled:cursor-default disabled:opacity-40"
        title={open
          ? 'Approve this pull request (a comment is optional)'
          : 'This pull request is no longer open'}
        disabled={!open || reviewing}
        onclick={() => void submitReview('APPROVE')}
      >
        <ThumbsUp size={12} />
        Approve
      </button>
      <button
        type="button"
        class="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 text-[10px] font-medium text-warning transition-colors hover:bg-warning/10 disabled:cursor-default disabled:opacity-40"
        title={!open
          ? 'This pull request is no longer open'
          : hasBody
            ? 'Request changes on this pull request'
            : 'Write what needs to change first — GitHub requires a comment'}
        disabled={!open || reviewing || !hasBody}
        onclick={() => void submitReview('REQUEST_CHANGES')}
      >
        <TriangleAlert size={12} />
        Request changes
      </button>
    </div>

    {#if open && !hasBody}
      <p class="px-3 pb-2.5 text-[9px] leading-relaxed text-dimmed">
        Requesting changes needs a comment saying what to change. Approving does not.
      </p>
    {/if}

    <!--
      Merging is a repo operation, not a review — a tinted, separate zone
      keeps it from reading as one more button in the review row above.
    -->
    <div class="border-t border-border bg-elevated/40 px-3 py-2.5">
      {#if open}
        <div class="flex items-center gap-1.5">
          <select
            id="pr-merge-method"
            class="h-7 cursor-pointer rounded-md border border-border bg-surface px-1.5 text-[10px] text-foreground outline-none disabled:cursor-default disabled:opacity-40"
            title="How the commits are combined when merging"
            aria-label="Merge method"
            bind:value={method}
          >
            {#each mergeMethods as option (option.id)}
              <option value={option.id}>{option.label}</option>
            {/each}
          </select>
          <span class="flex-1"></span>
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[10px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:cursor-default disabled:opacity-40"
            title="Close this pull request without merging"
            disabled={closing}
            onclick={() => (closeConfirm = true)}
          >
            {#if closing}
              <Loader2 size={12} class="animate-spin" />
            {:else}
              <X size={12} />
            {/if}
            Close
          </button>
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1 rounded-md bg-primary px-2.5 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40"
            title={`Merge this pull request into ${summary.baseRef}`}
            disabled={merging}
            onclick={openMergeConfirm}
          >
            {#if merging}
              <Loader2 size={12} class="animate-spin" />
            {:else}
              <Merge size={12} />
            {/if}
            Merge into {summary.baseRef}
          </button>
        </div>
        {#if mergeBlocker}
          <p class="mt-1.5 flex items-center gap-1 text-[9px] text-warning">
            <TriangleAlert size={10} class="shrink-0" />
            {mergeBlocker}
          </p>
        {/if}
      {:else if prState === 'closed'}
        <div class="flex items-center gap-1.5">
          <span class="flex min-w-0 items-center gap-1 text-[9px] text-dimmed">
            <CircleSlash size={10} class="shrink-0" />
            <span class="truncate">Closed without merging</span>
          </span>
          <span class="flex-1"></span>
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 text-[10px] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-40"
            title="Reopen this pull request"
            disabled={reopening}
            onclick={() => void reopen()}
          >
            {#if reopening}
              <Loader2 size={12} class="animate-spin" />
            {:else}
              <RotateCcw size={12} />
            {/if}
            Reopen
          </button>
        </div>
      {:else if prState === 'merged'}
        <span class="flex min-w-0 items-center gap-1 text-[9px] text-dimmed">
          <Merge size={10} class="shrink-0" />
          <span class="truncate">Merged — nothing more to do</span>
        </span>
      {/if}
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
        <strong class="text-foreground">{method}</strong> method.
        {#if checks?.state === 'failure'}
          Checks are currently <strong class="text-danger">failing</strong> on this branch.
        {/if}
        This runs on GitHub and cannot be undone from here.
      </AlertDialog.Description>

      {#if method === 'rebase'}
        <p
          class="mt-3 rounded-lg border border-border bg-surface px-3 py-2 text-[10px] leading-relaxed text-dimmed"
        >
          Rebase preserves the original commits, so there's no custom commit message to add.
        </p>
      {:else}
        <div class="mt-3 space-y-2">
          <div>
            <label
              class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted"
              for="merge-commit-title"
            >
              Commit title
            </label>
            <input
              id="merge-commit-title"
              class="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 font-mono text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
              placeholder={method === 'merge'
                ? `Merge pull request #${number} from ${summary.headRef}`
                : 'Title of the squashed commit'}
              bind:value={commitTitle}
            />
          </div>
          <div>
            <label
              class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted"
              for="merge-commit-message"
            >
              Commit message
            </label>
            <textarea
              id="merge-commit-message"
              class="min-h-16 w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground outline-none placeholder:text-dimmed focus:border-primary"
              placeholder={method === 'merge'
                ? 'Describe the merge (optional)'
                : 'Commit message for the squashed changes'}
              bind:value={commitMessage}></textarea>
          </div>
        </div>
      {/if}
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

<AlertDialog.Root open={closeConfirm} onOpenChange={(value) => (closeConfirm = value)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-black/40" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Close pull request #{number}?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        <strong class="text-foreground">{summary.title}</strong> will be closed without merging. You can
        reopen it later from this view.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 cursor-pointer rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:bg-danger/90"
          onclick={() => void closePullRequest()}
        >
          Close
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
