<script lang="ts">
  import {
    ArrowLeft,
    Bot,
    Check,
    ChevronDown,
    ChevronRight,
    CircleDot,
    CircleSlash,
    ExternalLink,
    FileDiff,
    GitCommitHorizontal,
    Loader2,
    Maximize2,
    MessageSquare,
    Merge,
    MessagesSquare,
    RefreshCw,
    Rocket,
    RotateCcw,
    Send,
    ShieldCheck,
    ThumbsUp,
    TriangleAlert,
    X
  } from '@lucide/svelte'
  import { AlertDialog, DropdownMenu } from 'bits-ui'
  import { onMount } from 'svelte'
  import { APP_SLUG } from '$shared/brand'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { relativeTime } from '$lib/format/relative-time'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import type {
    GitHubDeploymentJobLog,
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
    /** Reveal a GitHub Actions check in the in-app Deployments tab. */
    onOpenWorkflowRun: (runId: number) => void
    /** Resolve a conflicting PR locally: check out the head, merge base, show conflict UI. */
    onResolveLocally?: (pr: PullRequestSummary) => void
    /** Hand a conflicting PR to an agent to resolve and push. */
    onResolveWithAgent?: (pr: PullRequestSummary) => void
    /** Open this pull request in the full screen reader, like the file editor. */
    onFullscreen?: () => void
    /**
     * `dock` is the narrow sidebar column: read-only chrome stacked above the
     * body. `fullscreen` moves the title, tabs and write actions into a rail so
     * the body gets the whole height.
     */
    variant?: 'dock' | 'fullscreen'
  }

  let {
    projectId,
    identity,
    summary,
    onBack,
    onAgentReview,
    onOpenThread,
    onOpenWorkflowRun,
    onResolveLocally,
    onResolveWithAgent,
    onFullscreen,
    variant = 'dock'
  }: Props = $props()

  type DetailTab = 'conversation' | 'commits' | 'files' | 'checks' | 'agent'

  const mergeMethods: Array<{ id: PrMergeMethod; label: string }> = [
    { id: 'squash', label: 'Squash' },
    { id: 'merge', label: 'Merge' },
    { id: 'rebase', label: 'Rebase' }
  ]

  let tab = $state<DetailTab>('conversation')
  /**
   * Dock only. The sidebar is narrow enough that the write actions need a
   * disclosure, but the full screen rail pins the composer open instead, so
   * this flag is never read there.
   */
  let composerOpen = $state(false)

  /**
   * Full screen reader rail. Adjustable and persisted, because how much room the
   * conversation needs against the write actions is a per-user judgement.
   */
  const RAIL_WIDTH_KEY = `${APP_SLUG}:prReaderRailWidth`
  const RAIL_DEFAULT_WIDTH = 320
  const RAIL_MIN_WIDTH = 272
  const RAIL_MAX_WIDTH = 520
  let railWidth = $state(RAIL_DEFAULT_WIDTH)
  let resizingRail = $state(false)
  let railPointerId = 0
  let railStartX = 0
  let railStartWidth = 0

  function clampRailWidth(width: number): number {
    // Always leave the conversation a usable column, and never exceed the window.
    const viewportMaximum = Math.max(RAIL_MIN_WIDTH, window.innerWidth - 480)
    return Math.min(
      Math.max(Math.round(width), RAIL_MIN_WIDTH),
      Math.min(RAIL_MAX_WIDTH, viewportMaximum)
    )
  }

  function applyRailWidth(width: number, persist = false): void {
    railWidth = clampRailWidth(width)
    if (persist) localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth))
  }

  function startRailResize(event: PointerEvent & { currentTarget: HTMLButtonElement }): void {
    resizingRail = true
    railPointerId = event.pointerId
    railStartX = event.clientX
    railStartWidth = railWidth
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  /** The rail is on the right, so dragging left widens it. */
  function resizeRail(event: PointerEvent): void {
    if (!resizingRail || event.pointerId !== railPointerId) return
    applyRailWidth(railStartWidth + (railStartX - event.clientX))
  }

  function finishRailResize(event: PointerEvent): void {
    if (!resizingRail || event.pointerId !== railPointerId) return
    resizingRail = false
    applyRailWidth(railWidth, true)
  }

  function resizeRailWithKeyboard(event: KeyboardEvent): void {
    const delta = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0
    if (delta === 0) return
    event.preventDefault()
    applyRailWidth(railWidth + delta, true)
  }

  onMount(() => {
    const stored = Number.parseInt(localStorage.getItem(RAIL_WIDTH_KEY) ?? '', 10)
    if (Number.isFinite(stored)) applyRailWidth(stored)
  })
  let commentBody = $state('')
  let method = $state<PrMergeMethod>('squash')
  let mergeConfirm = $state(false)
  let closeConfirm = $state(false)
  let resolveConfirm = $state(false)
  let commitTitle = $state('')
  let commitMessage = $state('')
  let notice = $state('')
  let expandedCommit = $state<string | null>(null)
  let commitFiles = $state<Record<string, PullRequestFile[]>>({})
  let loadingCommit = $state<string | null>(null)
  let expandedFile = $state<string | null>(null)
  let agentReport = $state<PrAgentReport | null>(null)
  /** Which check's log is open, keyed the way the checks list is keyed. */
  let expandedCheck = $state<string | null>(null)
  let checkLogs = $state<Record<string, GitHubDeploymentJobLog>>({})
  let checkLogErrors = $state<Record<string, string>>({})
  let loadingCheckLogs = $state<Record<string, boolean>>({})

  const number = $derived(summary.number)
  /**
   * The dock reader and the full screen reader can be mounted at the same time,
   * so the merge dialog's field ids must not be shared: a label resolves `for`
   * to the first match in the document, and the closed dialog of the other
   * instance has no such element at all, leaving the label dead.
   */
  const mergeFieldSuffix = $derived(`${number}-${variant}`)
  const bundle = $derived(
    gitState.prBundles[GitState.bundleKey(identity.owner, identity.repo, number)]
  )
  const detail = $derived(bundle?.detail ?? null)
  const checks = $derived(bundle?.checks ?? null)
  const loading = $derived(gitState.isBusy('pr-detail') && !bundle)
  const posting = $derived(gitState.isBusy('pr-comment'))
  const reviewing = $derived(gitState.isBusy('pr-review'))
  /**
   * True while the merge is actively running OR while the detail view is still
   * waiting for the PR state to flip to "merged" after a successful merge. This
   * keeps the merge button disabled and showing a spinner for the whole
   * operation, so it's never re-enabled while the PR still reads "open".
   */
  let mergePending = $state(false)
  const merging = $derived(gitState.isBusy('pr-merge') || mergePending)
  /** True while a local conflict-resolution checkout+merge is being prepared. */
  const resolving = $derived(gitState.isBusy('merge'))
  const reopening = $derived(gitState.isBusy('pr-reopen'))
  const closing = $derived(gitState.isBusy('pr-close'))
  const markingReady = $derived(gitState.isBusy('pr-ready'))
  const prState = $derived(detail?.state ?? summary.state)
  const open = $derived(prState === 'open')
  const draft = $derived(detail?.draft ?? summary.draft)
  const hasBody = $derived(commentBody.trim().length > 0)
  /** Why merging may not be a good idea right now   shown next to the button. */
  const mergeBlocker = $derived.by(() => {
    if (!open) return ''
    if (gitState.hasPrIssue(identity.owner, identity.repo, number)) {
      return 'conflicts with the base branch'
    }
    if (checks?.state === 'failure') return 'checks are failing'
    if (checks?.state === 'pending') return 'checks are still running'
    return ''
  })

  /**
   * Conversation as one chronological stream: the PR description, issue
   * comments, submitted reviews, and inline code comments   the same context
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

  /**
   * The active view is one of these. In the full screen reader they become a
   * dropdown in the header instead of a row of tabs, because the rail is too
   * narrow to hold both the tabs and the actions comfortably.
   */
  const tabs = $derived([
    {
      id: 'conversation' as const,
      label: 'Conversation',
      icon: MessagesSquare,
      count: conversation.length
    },
    {
      id: 'commits' as const,
      label: 'Commits',
      icon: GitCommitHorizontal,
      count: bundle?.commits.length ?? 0
    },
    { id: 'files' as const, label: 'Files', icon: FileDiff, count: bundle?.files.length ?? 0 },
    {
      id: 'checks' as const,
      label: 'Checks',
      icon: ShieldCheck,
      count: checks?.checks.length ?? 0
    },
    { id: 'agent' as const, label: 'Agent', icon: Bot, count: agentReport?.content ? 1 : 0 }
  ])
  /** The tab the header's dropdown button names while it is closed. */
  const activeTabEntry = $derived(tabs.find((entry) => entry.id === tab) ?? null)

  type EntryKind = 'description' | 'comment' | 'review' | 'inline'

  /** Human label for a conversation entry's badge. */
  function kindLabel(kind: EntryKind, meta?: string): string {
    if (kind === 'description') return 'description'
    if (kind === 'inline') return 'inline review'
    if (kind === 'review') return meta ?? 'review'
    return 'comment'
  }

  /** Badge colour   approvals and change requests read at a glance. */
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

  /** Wording for the rolled-up check state, sentence-cased for a label or title. */
  function checksStateLabel(state: string): string {
    if (state === 'failure') return 'Checks failing'
    if (state === 'pending') return 'Checks running'
    return 'Checks passing'
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
    mergePending = true
    try {
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
        // The merge already succeeded, but the detail still reads "open" until
        // GitHub propagates the new state. Keep refreshing so the merge button
        // stays in its loading state (never re-enabled while it says "open")
        // until the status flips to "merged" or an error surfaces.
        for (let attempt = 0; attempt < 4 && prState === 'open' && !gitState.error; attempt += 1) {
          await refresh()
        }
      }
    } finally {
      mergePending = false
    }
  }

  /** Promote a draft PR to ready-for-review so GitHub will allow it to merge. */
  async function markReadyForReview(): Promise<void> {
    const ready = await gitState.markPullRequestReadyForReview(
      projectId,
      identity.owner,
      identity.repo,
      number
    )
    if (ready) {
      notice = 'Pull request marked ready for review'
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

  /** Stable key for one check row, shared by the list key and the log cache. */
  function checkKey(check: PullRequestCheck): string {
    return check.name + (check.url ?? '')
  }

  /** Human wording for a check's progress, so `in_progress` is not shown raw. */
  function checkStateLabel(check: PullRequestCheck): string {
    if (check.status !== 'completed') return check.status.replace('_', ' ')
    return check.conclusion ?? 'done'
  }

  /**
   * The job behind a check. Actions names the job in the check's `details_url`,
   * which is exact even for one leg of a matrix run; when the provider only gives
   * the run, the job is matched by name so the wrong leg's log is never shown.
   */
  async function resolveCheckJobId(check: PullRequestCheck): Promise<number | null> {
    if (check.jobId !== null) return check.jobId
    if (check.workflowRunId === null) return null
    const run = await gitState
      .ensureWorkflowRunDetail(projectId, identity.owner, identity.repo, check.workflowRunId)
      .catch(() => null)
    return run?.jobs.find((job) => job.name === check.name)?.id ?? null
  }

  /** Name the two failures a reader can actually act on, then quote the rest. */
  function checkLogMessage(reason: unknown): string {
    const text = reason instanceof Error ? reason.message : ''
    if (/HTTP 404/u.test(text)) return 'This job has not published a log yet.'
    if (/HTTP (401|403)/u.test(text)) return 'Your GitHub access cannot read this job log.'
    return text || 'The log could not be loaded.'
  }

  /**
   * Job logs are wrapped for a terminal: CSI colour sequences and OSC 8 hyperlink
   * wrappers. This pane is plain text, so all of it would only render as `[0m`
   * noise. Built from character codes because a literal escape in a regex trips
   * `no-control-regex`, the same reason provider-account-orchestrator builds its
   * ANSI pattern this way.
   */
  const ANSI_ESCAPE = String.fromCharCode(27)
  const ANSI_BELL = String.fromCharCode(7)
  /** String Terminator, the other way an OSC sequence can end. */
  const ANSI_ST = ANSI_ESCAPE + String.fromCharCode(92)
  const LOG_ANSI_PATTERNS = [
    // OSC, which must not be allowed to run past the next escape or line break.
    new RegExp(`${ANSI_ESCAPE}\\][^${ANSI_BELL}${ANSI_ESCAPE}]*`, 'gu'),
    // CSI: colour, weight, cursor movement.
    new RegExp(`${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'gu'),
    new RegExp(ANSI_BELL, 'gu')
  ]

  function plainLog(text: string): string {
    const stripped = LOG_ANSI_PATTERNS.reduce(
      (result, pattern) => result.replace(pattern, ''),
      text
    )
    return stripped.split(ANSI_ST).join('')
  }

  async function toggleCheckLog(check: PullRequestCheck): Promise<void> {
    const key = checkKey(check)
    if (expandedCheck === key) {
      expandedCheck = null
      return
    }
    expandedCheck = key
    if (checkLogs[key] || loadingCheckLogs[key]) return
    loadingCheckLogs = { ...loadingCheckLogs, [key]: true }
    checkLogErrors = { ...checkLogErrors, [key]: '' }
    try {
      const jobId = await resolveCheckJobId(check)
      if (jobId === null) {
        checkLogErrors = {
          ...checkLogErrors,
          [key]: 'This check does not name a job, so its log has to be read on GitHub.'
        }
        return
      }
      const log = await gitState.ensureDeploymentJobLog(
        projectId,
        identity.owner,
        identity.repo,
        jobId
      )
      if (log) checkLogs = { ...checkLogs, [key]: log }
    } catch (reason) {
      checkLogErrors = { ...checkLogErrors, [key]: checkLogMessage(reason) }
    } finally {
      loadingCheckLogs = { ...loadingCheckLogs, [key]: false }
    }
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

  // Seed the merge method from the configured default (squash by default).
  $effect(() => {
    void invoke('config:get')
      .then((config) => {
        if (config?.defaultMergeMethod) method = config.defaultMergeMethod
      })
      .catch(() => undefined)
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
    <p class="text-[0.6875rem] leading-relaxed text-dimmed">{text}</p>
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
        <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-foreground">
          {file.path}
        </span>
        <span class="shrink-0 text-[0.5625rem] tabular-nums">
          <span class="text-success">+{file.additions}</span>
          <span class="text-danger">−{file.deletions}</span>
        </span>
      </button>
      {#if expandedFile === fileKey}
        {#if file.patch}
          <pre
            class="overflow-x-auto bg-elevated/40 px-3 py-1.5 font-mono text-[0.5625rem] leading-relaxed"><!--
         -->{#each file.patch.split('\n') as line, index (index)}<span
                class="block {patchLineClass(line)}">{line || ' '}</span
              >{/each}</pre>
        {:else}
          <p class="px-3 py-2 text-[0.625rem] text-dimmed">
            No inline diff for this file (binary or too large).
          </p>
        {/if}
      {/if}
    </div>
  {/each}
{/snippet}

{#snippet panelHead()}
  <!-- Header -->
  <div class="shrink-0 border-b border-border px-3 py-2.5">
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
      <span class="font-mono text-[0.625rem] text-dimmed">#{number}</span>
      <span
        class="min-w-0 shrink truncate rounded px-1.5 py-0.5 text-[0.5625rem] font-medium uppercase tracking-wide {stateBadgeClass(
          detail?.state ?? summary.state
        )}"
      >
        {detail?.state ?? summary.state}{draft ? ' · draft' : ''}
      </span>
      {#if checks && checks.state !== 'none'}
        <!--
          In the dock the pill drops its words and keeps its colour: the header
          row has to hold the view dropdown as well, and the same state is named
          in full inside the dropdown's Checks entry.
        -->
        <button
          type="button"
          class="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[0.5625rem] font-medium transition-colors {checksBadgeClass(
            checks.state
          )}"
          title="{checksStateLabel(checks.state)}, open check results"
          aria-label="{checksStateLabel(checks.state)}, open check results"
          onclick={() => (tab = 'checks')}
        >
          <ShieldCheck size={10} />
          {#if variant === 'fullscreen'}{checksStateLabel(checks.state)}{/if}
        </button>
      {/if}
      <span class="min-w-0 flex-1"></span>
      {#if onFullscreen}
        <button
          type="button"
          class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Open in full screen"
          aria-label="Open in full screen"
          onclick={onFullscreen}
        >
          <Maximize2 size={13} />
        </button>
      {/if}
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
      {#if variant === 'dock'}
        <!--
          Dock only: the sidebar cannot spare a tab strip of its own, so the
          active view sits here as one dropdown, right after the external link.
          The rail is tall enough for a visible list, so it does not use this.
        -->
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex h-6 min-w-0 shrink cursor-pointer items-center gap-1 rounded px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
            title="Switch pull request view"
            aria-label="Switch pull request view"
          >
            {#if activeTabEntry}
              {@const ActiveIcon = activeTabEntry.icon}
              <ActiveIcon size={12} class="shrink-0" />
            {/if}
            <span class="min-w-0 truncate">{activeTabEntry?.label ?? 'View'}</span>
            <ChevronDown size={10} class="shrink-0 text-dimmed" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="end"
              sideOffset={4}
              collisionPadding={8}
              class="z-90 w-44 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-lg"
            >
              {#each tabs as entry (entry.id)}
                {@const EntryIcon = entry.icon}
                <DropdownMenu.Item
                  class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                  onSelect={() => (tab = entry.id)}
                >
                  <EntryIcon size={12} class="shrink-0 text-dimmed" />
                  <span class="min-w-0 flex-1 truncate">{entry.label}</span>
                  {#if entry.count > 0}
                    <span class="shrink-0 tabular-nums text-dimmed">{entry.count}</span>
                  {/if}
                  {#if tab === entry.id}
                    <Check size={12} class="shrink-0 text-primary" />
                  {/if}
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {/if}
    </div>
    <p class="mt-1.5 text-[0.75rem] font-medium leading-snug text-foreground">{summary.title}</p>
    <!--
      One meta line instead of two: the refs, the author, the age and the change
      summary all describe the same thing. `flex-wrap` means a narrow rail moves
      the numbers down rather than truncating the branch names away.
    -->
    <p class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.5625rem] text-dimmed">
      <span class="min-w-0 truncate font-mono">
        {summary.headRef} → {summary.baseRef}
      </span>
      <span>· {summary.authorLogin}</span>
      <span>· {relativeTime(summary.updatedAt)}</span>
      {#if detail}
        <span class="flex items-center gap-1.5 tabular-nums">
          <span class="text-success">+{detail.additions}</span>
          <span class="text-danger">−{detail.deletions}</span>
          <span>{detail.changedFiles} files</span>
          <span>{detail.commitCount} commits</span>
        </span>
      {/if}
      {#if open && gitState.hasPrIssue(identity.owner, identity.repo, number)}
        <span class="flex items-center gap-1 text-warning">
          <TriangleAlert size={10} />
          conflicts
        </span>
      {/if}
    </p>
  </div>

  {#if notice}
    <p
      class="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1 text-[0.625rem] text-success"
    >
      <Check size={12} />
      {notice}
    </p>
  {/if}

  {#if gitState.error}
    <p
      class="flex shrink-0 items-center gap-1 border-b border-danger/30 bg-danger/10 px-3 py-1 text-[0.625rem] text-danger"
      title={gitState.error}
      aria-label={gitState.error}
    >
      <TriangleAlert size={12} class="shrink-0" />
      {gitState.error}
    </p>
  {/if}
{/snippet}

{#snippet panelTabs()}
  <!--
    Rail only. A visible list beats a dropdown here: the rail is tall, and the
    active view stays readable without spending the body's height on it. It takes
    the rail's spare height, and scrolls instead of pushing the pinned write
    actions off a short window.
  -->
  <nav
    class="min-h-0 flex-1 overflow-y-auto border-b border-border p-1.5"
    aria-label="Pull request views"
  >
    {#each tabs as entry (entry.id)}
      {@const Icon = entry.icon}
      <button
        type="button"
        class={[
          'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.625rem] font-medium transition-colors',
          tab === entry.id ? 'bg-elevated text-foreground' : 'text-muted hover:text-foreground'
        ]}
        aria-current={tab === entry.id}
        onclick={() => (tab = entry.id)}
      >
        <Icon size={12} class="shrink-0" />
        <span class="min-w-0 flex-1 truncate">{entry.label}</span>
        {#if entry.count > 0}
          <span class="shrink-0 tabular-nums text-dimmed">{entry.count}</span>
        {/if}
      </button>
    {/each}
  </nav>
{/snippet}

{#snippet commentToggle()}
  {#if variant === 'dock'}
    <!--
      The comment box is a button here rather than a disclosure bar of its own:
      commenting and merging are both things you do to this pull request, so they
      share one row and the conversation keeps the height. The rail pins the
      composer open instead, so it has no use for this. Icon only, because the
      row also has to carry Close and Merge at the sidebar's 340px minimum; the
      word stays on the composer's own submit button.
    -->
    <button
      type="button"
      class="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors {composerOpen
        ? 'border-primary bg-primary/10 text-foreground'
        : 'border-border text-foreground hover:bg-elevated'}"
      aria-expanded={composerOpen}
      title={composerOpen ? 'Hide the comment box' : 'Write a comment or review'}
      aria-label={composerOpen ? 'Hide the comment box' : 'Write a comment or review'}
      onclick={() => (composerOpen = !composerOpen)}
    >
      <MessageSquare size={12} />
    </button>
  {/if}
{/snippet}

{#snippet closePullRequestButton()}
  <!--
    Closing is a direct button, not a one-item overflow menu: an ellipsis over a
    single action costs a click and never says what it holds. The dock's row
    cannot spell it out, so it takes the short label; the rail names it in full.
    The confirm dialog still guards the action.
  -->
  <button
    type="button"
    class="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-danger/30 px-2.5 text-[0.625rem] font-medium text-danger transition-colors hover:bg-danger/10 disabled:cursor-default disabled:opacity-40 {variant ===
    'fullscreen'
      ? 'w-full justify-center'
      : 'shrink-0'}"
    title="Close this pull request without merging it"
    disabled={closing || markingReady}
    onclick={() => (closeConfirm = true)}
  >
    {#if closing}
      <Loader2 size={12} class="animate-spin" />
    {:else}
      <X size={12} />
    {/if}
    {variant === 'fullscreen' ? 'Close without merging' : 'Close'}
  </button>
{/snippet}

{#snippet mergeAction()}
  {#if draft}
    <button
      type="button"
      class="flex h-7 cursor-pointer items-center gap-1 rounded-md bg-primary px-2.5 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40 {variant ===
      'fullscreen'
        ? 'w-full justify-center'
        : 'shrink-0'}"
      title="Mark this draft pull request ready for review before merging"
      disabled={markingReady}
      onclick={() => void markReadyForReview()}
    >
      {#if markingReady}
        <Loader2 size={12} class="animate-spin" />
      {:else}
        <Check size={12} />
      {/if}
      Ready for review
    </button>
  {:else}
    <!--
      The method picker is a dropdown trigger inside the merge button's own
      outline (the EditorOpenControl split-button pattern) rather than a bare
      <select>.
    -->
    <div
      class="flex h-7 min-w-0 items-stretch overflow-hidden rounded-md {variant === 'fullscreen'
        ? 'w-full'
        : 'shrink'}"
    >
      <button
        type="button"
        class="flex min-w-0 cursor-pointer items-center gap-1 bg-primary px-2.5 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40 {variant ===
        'fullscreen'
          ? 'flex-1 justify-center'
          : ''}"
        title={`Merge this pull request into ${summary.baseRef} using ${method}`}
        disabled={merging}
        onclick={openMergeConfirm}
      >
        {#if merging}
          <Loader2 size={12} class="animate-spin" />
        {:else}
          <Merge size={12} class="shrink-0" />
        {/if}
        <!-- Truncates rather than pushing the row off the panel: a long base
             ref is the one thing here that can outgrow the sidebar. -->
        <span class="min-w-0 truncate">Merge into {summary.baseRef}</span>
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="flex w-6 cursor-pointer items-center justify-center border-l border-on-primary/25 bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40"
          title="Choose a merge method"
          aria-label="Choose a merge method"
          disabled={merging}
        >
          <ChevronDown size={12} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="end"
            sideOffset={6}
            class="z-90 w-40 overflow-hidden rounded-lg border-border bg-surface p-1 shadow-lg"
          >
            <p
              class="px-2.5 py-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-dimmed"
            >
              Merge method
            </p>
            {#each mergeMethods as option (option.id)}
              <DropdownMenu.Item
                class="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs text-foreground outline-none transition-colors data-[highlighted]:bg-elevated"
                onSelect={() => (method = option.id)}
              >
                {option.label}
                {#if method === option.id}
                  <Check size={13} class="shrink-0 text-primary" />
                {/if}
              </DropdownMenu.Item>
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  {/if}
{/snippet}

{#snippet panelBody()}
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if loading}
      <div class="flex items-center justify-center gap-2 py-10 text-[0.6875rem] text-dimmed">
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
                  class="flex size-5 shrink-0 items-center justify-center rounded-full text-[0.5625rem] font-semibold uppercase {avatarClass(
                    entry.author
                  )}"
                  aria-hidden="true"
                >
                  {entry.author.slice(0, 1)}
                </span>
                <span class="truncate text-[0.6875rem] font-medium text-foreground">{entry.author}</span>
                <span
                  class="shrink-0 rounded px-1.5 py-px text-[0.5625rem] font-medium {kindClass(
                    entry.kind,
                    entry.meta
                  )}"
                >
                  {kindLabel(entry.kind, entry.meta)}
                </span>
                <span class="flex-1"></span>
                <span class="shrink-0 text-[0.5625rem] text-dimmed">{relativeTime(entry.at)}</span>
              </header>
              {#if entry.kind === 'inline' && entry.meta}
                <p
                  class="truncate border-b border-border/40 bg-elevated/20 px-2.5 py-1 font-mono text-[0.5625rem] text-dimmed"
                >
                  {entry.meta}
                </p>
              {/if}
              {#if entry.body.trim()}
                <div class="px-2.5 py-2">
                  <!-- GitHub's dialect includes HTML, so PR prose needs it to
                       read correctly; the sanitizer still strips anything
                       executable. Agent-authored text elsewhere keeps it off. -->
                  <MarkdownView text={entry.body} class="text-[0.6875rem] leading-relaxed" allowHtml />
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
                <p class="truncate text-[0.6875rem] text-foreground">{commit.message}</p>
                <p class="truncate text-[0.5625rem] text-dimmed">
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
                <p class="px-3 py-2 text-[0.625rem] text-dimmed">No files in this commit.</p>
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
        {#each checks.checks as check (checkKey(check))}
          {@const Icon = checkIcon(check)}
          {@const key = checkKey(check)}
          {@const runId = check.workflowRunId}
          {@const isOpen = expandedCheck === key}
          <div class="border-b border-border/50">
            <!--
              The whole row is the log toggle: a check's result is only half the
              story, and the reason to open the tab is to read why it failed.
            -->
            <div class="flex items-center gap-2 px-3 py-1.5">
              <button
                type="button"
                class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                title={isOpen ? `Hide the ${check.name} log` : `Show the ${check.name} log`}
                aria-expanded={isOpen}
                onclick={() => void toggleCheckLog(check)}
              >
                <ChevronRight
                  size={11}
                  class="shrink-0 text-dimmed transition-transform {isOpen ? 'rotate-90' : ''}"
                />
                <Icon size={12} class="shrink-0 {checkClass(check)}" />
                <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-foreground">
                  {check.name}
                </span>
                <span class="shrink-0 text-[0.5625rem] text-dimmed">
                  {checkStateLabel(check)}
                </span>
              </button>
              {#if check.url}
                <button
                  type="button"
                  class="shrink-0 cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  title="Open {check.name} externally"
                  aria-label="Open {check.name} externally"
                  onclick={() => void openInBrowser(check.url ?? '')}
                >
                  <ExternalLink size={12} />
                </button>
              {/if}
            </div>
            {#if isOpen}
              <div class="border-t border-border/50 bg-elevated/20">
                {#if loadingCheckLogs[key]}
                  <div class="flex items-center gap-2 px-3 py-2 text-[0.6875rem] text-dimmed">
                    <Loader2 size={12} class="animate-spin" />
                    Loading log…
                  </div>
                {:else if checkLogErrors[key]}
                  <p class="px-3 py-2 text-[0.625rem] leading-relaxed text-dimmed">
                    {checkLogErrors[key]}
                  </p>
                {:else if checkLogs[key]}
                  <pre
                    class="max-h-72 overflow-auto px-3 py-2 font-mono text-[0.5625rem] leading-relaxed text-muted">{plainLog(
                      checkLogs[key].log
                    )}</pre>
                  {#if checkLogs[key].truncated}
                    <p class="px-3 pb-2 text-[0.5625rem] text-dimmed">
                      GitHub truncated this log. Open it externally for the rest.
                    </p>
                  {/if}
                {/if}
                {#if runId !== null}
                  <div class="border-t border-border/40 px-3 py-1.5">
                    <button
                      type="button"
                      class="flex h-6 cursor-pointer items-center gap-1 text-[0.625rem] font-medium text-muted transition-colors hover:text-foreground"
                      title="Open this workflow run in the Deployments tab to inspect every job and step"
                      onclick={() => onOpenWorkflowRun(runId)}
                    >
                      <Rocket size={11} />
                      Open the full run in Deployments
                    </button>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    {:else if agentReport?.content.trim()}
      <div class="px-3 py-2">
        <div class="mb-2 flex items-center gap-2">
          <p class="flex-1 truncate text-[0.5625rem] text-dimmed">
            {agentReport.path} · {relativeTime(agentReport.updatedAt)}
          </p>
          {#if agentReport.threadId}
            <button
              type="button"
              class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="Open the thread that produced this review"
              onclick={() => onOpenThread(agentReport?.threadId ?? '')}
            >
              <Bot size={12} />
              Open thread
            </button>
          {/if}
          <button
            type="button"
            class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
            title="Post this report as a comment on the pull request"
            disabled={posting}
            onclick={() => void postAgentReport()}
          >
            <Send size={12} />
            Post to PR
          </button>
        </div>
        <MarkdownView text={agentReport.content} class="text-[0.6875rem] leading-relaxed" />
      </div>
    {:else}
      <div class="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <Bot size={18} class="text-dimmed" />
        <p class="text-[0.6875rem] leading-relaxed text-muted">
          No agent review yet. "Agent review" opens a thread where an agent checks this PR out in a
          worktree and writes its findings to <span class="font-mono"
            >.cio/git/pr/{number}/review.md</span
          >. The report shows up here when it lands.
        </p>
        <div class="flex items-center gap-2">
          {#if agentReport?.threadId}
            <button
              type="button"
              class="flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
              title="Open the review thread already running for this pull request"
              onclick={() => onOpenThread(agentReport?.threadId ?? '')}
            >
              <Bot size={12} />
              Open review thread
            </button>
          {/if}
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover"
            onclick={() => onAgentReview(summary)}
          >
            <Bot size={12} />
            Start agent review
          </button>
        </div>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet panelComposer()}
  <!--
    Square, because this sits against the edge of the panel rather than floating
    in it, and at least five rows tall so a real review fits without scrolling.
    The editor is the same rich markdown component the rest of the app uses.
    Padding matches what its placeholder overlay expects (px-3.5 / pt-3), and the
    height is sized against the 0.8125rem/1.8 the editor sets for itself in
    `src/renderer/app.css`, which outranks a text size utility here.
  -->
  <div class="shrink-0">
    <div class="px-3 pt-2.5">
      <RichMarkdownEditor
        bind:value={commentBody}
        placeholder="Leave a comment, or write the feedback for a review…"
        ariaLabel="Pull request comment"
        containerClass="border border-border bg-elevated focus-within:border-primary"
        class="min-h-36 max-h-56 w-full resize-y overflow-y-auto px-3.5 pt-3 pb-2 text-foreground outline-none"
      />
    </div>

    <!--
      Comment and review both consume the box above, so they read as one
      toolbar (shared border, no gaps) instead of three loose buttons.
    -->
    <div class="px-3 py-2.5">
      <div class="flex h-8 items-stretch overflow-hidden rounded-lg border border-border">
        <button
          type="button"
          class="flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 bg-primary px-2 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40"
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
        <button
          type="button"
          class="flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 border-l border-border text-[0.625rem] font-medium text-success transition-colors hover:bg-success/10 disabled:cursor-default disabled:opacity-40"
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
          class="flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 border-l border-border text-[0.625rem] font-medium text-warning transition-colors hover:bg-warning/10 disabled:cursor-default disabled:opacity-40"
          title={!open
            ? 'This pull request is no longer open'
            : hasBody
              ? 'Request changes on this pull request'
              : 'Write what needs to change first   GitHub requires a comment'}
          disabled={!open || reviewing || !hasBody}
          onclick={() => void submitReview('REQUEST_CHANGES')}
        >
          <TriangleAlert size={12} />
          Request changes
        </button>
      </div>
      {#if open && !hasBody}
        <p class="mt-1.5 text-[0.5625rem] leading-relaxed text-dimmed">
          Requesting changes needs a comment saying what to change. Approving does not.
        </p>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet panelMerge()}
  <!--
      Merging is a repo operation, not a review   a tinted, separate zone
      keeps it from reading as one more button in the toolbar above. The
      method picker and close action live behind dropdowns (matching
      EditorOpenControl's split-button pattern) instead of a bare <select>
      and a third loose button.
    -->
  <div class="border-t border-border bg-elevated/40 px-3 py-2.5">
    {#if open && detail?.mergeable === false}
      <div class="mb-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
        <div class="flex items-center gap-1.5">
          <TriangleAlert size={13} class="shrink-0 text-warning" />
          <p class="text-[0.625rem] font-semibold text-warning">
            This pull request has merge conflicts
          </p>
        </div>
        <p class="mt-1 text-[0.5625rem] leading-relaxed text-dimmed">
          {summary.baseRef} has changes that conflict with {summary.headRef}. Resolve them and push,
          or have the agent fix them for you.
        </p>
        <div class="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-2.5 text-[0.625rem] font-medium text-warning transition-colors hover:bg-warning/20 disabled:cursor-default disabled:opacity-40"
            title="Check out this branch locally, merge the base in, and resolve the conflicts in your editor"
            disabled={resolving}
            onclick={() => (resolveConfirm = true)}
          >
            {#if resolving}
              <Loader2 size={12} class="animate-spin" />
            {:else}
              <Merge size={12} />
            {/if}
            Resolve locally
          </button>
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated"
            title="Have an agent resolve the conflicts and push the fix"
            onclick={() => onResolveWithAgent?.(summary)}
          >
            <Bot size={12} />
            Resolve with agent
          </button>
        </div>
      </div>
    {/if}
    {#if open}
      <!--
        The state note takes a line of its own: sharing the row squeezed it to
        nothing the moment the row also held Close and Merge.
      -->
      {#if draft}
        <p class="mb-1.5 flex items-center gap-1 text-[0.5625rem] text-warning">
          <CircleDot size={10} class="shrink-0" />
          Draft pull request
        </p>
      {:else if mergeBlocker}
        <p class="mb-1.5 flex items-center gap-1 text-[0.5625rem] text-warning">
          <TriangleAlert size={10} class="shrink-0" />
          {mergeBlocker}
        </p>
      {/if}
      {#if variant === 'fullscreen'}
        <!--
          The rail is narrow enough that "Close without merging" beside "Merge
          into main" would have to truncate one of them, so each takes a row.
        -->
        <div class="flex flex-col gap-1.5">
          {@render closePullRequestButton()}
          {@render mergeAction()}
        </div>
      {:else}
        <div class="flex items-center gap-1.5">
          {@render commentToggle()}
          <span class="flex-1"></span>
          {@render closePullRequestButton()}
          {@render mergeAction()}
        </div>
      {/if}
    {:else if prState === 'closed'}
      <div class="flex items-center gap-1.5">
        {@render commentToggle()}
        <span class="flex min-w-0 items-center gap-1 text-[0.5625rem] text-dimmed">
          <CircleSlash size={10} class="shrink-0" />
          <span class="truncate">Closed without merging</span>
        </span>
        <span class="flex-1"></span>
        <button
          type="button"
          class="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-40"
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
      <div class="flex items-center gap-1.5">
        {@render commentToggle()}
        <span class="flex min-w-0 items-center gap-1 text-[0.5625rem] text-dimmed">
          <Merge size={10} class="shrink-0" />
          <span class="truncate">Merged nothing more to do</span>
        </span>
      </div>
    {/if}
  </div>
{/snippet}

{#if variant === 'fullscreen'}
  <!--
    Full screen: the title, the view list and every write action move into a rail
    on the right, so the conversation gets the whole height and the left edge of
    the reader stays put when the rail is resized. The rail width is the user's
    to choose.
  -->
  <div class="flex h-full min-h-0">
    <div class="flex min-w-0 flex-1 flex-col">
      {@render panelBody()}
    </div>
    <aside
      class="relative flex shrink-0 flex-col border-l border-border"
      style="width: {railWidth}px"
    >
      <button
        type="button"
        class="absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/30 focus:bg-primary/30 focus:outline-none {resizingRail
          ? 'bg-primary/30'
          : ''}"
        title="Resize pull request details"
        aria-label="Resize pull request details"
        onpointerdown={startRailResize}
        onpointermove={resizeRail}
        onpointerup={finishRailResize}
        onpointercancel={finishRailResize}
        onkeydown={resizeRailWithKeyboard}
      ></button>
      {@render panelHead()}
      {@render panelTabs()}
      <!--
        The rail pins its write actions: the comment box and the merge row stay
        put while the conversation beside them scrolls, so merging never needs a
        scroll to the end of a long review.
      -->
      {@render panelComposer()}
      {@render panelMerge()}
    </aside>
  </div>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    {@render panelHead()}
    {@render panelBody()}
    {#if composerOpen}
      {@render panelComposer()}
    {/if}
    {@render panelMerge()}
  </div>
{/if}

<AlertDialog.Root open={mergeConfirm} onOpenChange={(value) => (mergeConfirm = value)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-90 bg-black/40" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-90 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
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
          class="mt-3 rounded-lg border border-border bg-surface px-3 py-2 text-[0.625rem] leading-relaxed text-dimmed"
        >
          Rebase preserves the original commits, so there's no custom commit message to add.
        </p>
      {:else}
        <div class="mt-3 space-y-2">
          <div>
            <label
              class="mb-1 block text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
              for="merge-commit-title-{mergeFieldSuffix}"
            >
              Commit title
            </label>
            <input
              id="merge-commit-title-{mergeFieldSuffix}"
              class="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
              placeholder={method === 'merge'
                ? `Merge pull request #${number} from ${summary.headRef}`
                : 'Title of the squashed commit'}
              bind:value={commitTitle}
            />
          </div>
          <div>
            <label
              class="mb-1 block text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
              for="merge-commit-message-{mergeFieldSuffix}"
            >
              Commit message
            </label>
            <textarea
              id="merge-commit-message-{mergeFieldSuffix}"
              class="min-h-16 w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed text-foreground outline-none placeholder:text-dimmed focus:border-primary"
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

<AlertDialog.Root open={resolveConfirm} onOpenChange={(value) => (resolveConfirm = value)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-90 bg-black/40" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-90 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Resolve conflicts for PR #{number}?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        This checks out the <strong class="text-foreground">{summary.headRef}</strong> branch
        locally as <code class="font-mono">pr-{number}</code>, merges
        <strong class="text-foreground">{summary.baseRef}</strong> into it, and switches the Git panel
        to the changes tab. You'll resolve each conflicted file in your editor, then commit and push to
        update the pull request.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 cursor-pointer rounded-lg bg-warning px-3 text-xs font-medium text-on-primary hover:bg-warning/90"
          onclick={() => {
            resolveConfirm = false
            onResolveLocally?.(summary)
          }}
        >
          Resolve locally
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<AlertDialog.Root open={closeConfirm} onOpenChange={(value) => (closeConfirm = value)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-90 bg-black/40" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-90 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
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
