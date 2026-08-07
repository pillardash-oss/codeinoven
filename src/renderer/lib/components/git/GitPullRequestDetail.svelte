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
  const open = $derived((detail?.state ?? summary.state) === 'open')

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
    const merged = await gitState.mergePullRequest(
      projectId,
      identity.owner,
      identity.repo,
      number,
      method
    )
    if (merged) {
      notice = `Merged with ${method}`
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

{#snippet fileList(files: PullRequestFile[], keyPrefix: string)}
  {#each files as file (file.path)}
    {@const fileKey = `${keyPrefix}:${file.path}`}
    <div class="border-b border-border/50">
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-elevated"
        onclick={() => (expandedFile = expandedFile === fileKey ? null : fileKey)}
      >
        <FileDiff size={11} class="shrink-0 text-dimmed" />
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
      {#if checks && checks.state !== 'none'}
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors {checks.state ===
          'failure'
            ? 'bg-danger/10 text-danger hover:bg-danger/20'
            : checks.state === 'pending'
              ? 'bg-warning/10 text-warning hover:bg-warning/20'
              : 'bg-success/10 text-success hover:bg-success/20'}"
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
        <Icon size={11} />
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
        <p class="px-4 py-8 text-center text-[11px] text-dimmed">Nothing has been said yet.</p>
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
                  class="flex size-4 shrink-0 items-center justify-center rounded-full bg-border text-[8px] font-semibold uppercase text-muted"
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
        <p class="px-4 py-8 text-center text-[11px] text-dimmed">No commits on this branch.</p>
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
                <Loader2 size={11} class="mt-0.5 shrink-0 animate-spin text-dimmed" />
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
        <p class="px-4 py-8 text-center text-[11px] text-dimmed">No changed files.</p>
      {:else}
        {@render fileList(bundle.files, 'pr')}
      {/if}
    {:else if tab === 'checks'}
      {#if !checks || checks.checks.length === 0}
        <p class="px-4 py-8 text-center text-[11px] text-dimmed">
          No checks have reported on this branch.
        </p>
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
                <ExternalLink size={11} />
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
              <Bot size={11} />
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
            <Send size={11} />
            Post to PR
          </button>
        </div>
        <MarkdownView text={agentReport.content} class="text-[11px] leading-relaxed" />
      </div>
    {:else}
      <div class="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <Bot size={20} class="text-dimmed" />
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
        <strong class="text-foreground">{method}</strong> method.
        {#if checks?.state === 'failure'}
          Checks are currently <strong class="text-danger">failing</strong> on this branch.
        {/if}
        This runs on GitHub and cannot be undone from here.
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
