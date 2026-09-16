<script lang="ts">
  import {
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
  import { onDestroy } from 'svelte'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { prReaderRailState } from '$lib/stores/pr-reader-rail.svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  // The `@query` detection is shared with the chat composer rather than
  // re-implemented here: it already knows to stay silent inside code spans and
  // quoted passages, which a second copy would have to relearn.
  import { composerMentionQuery } from '../chats/composer-mentions'
  import PrMentionMenu from './PrMentionMenu.svelte'
  import GitJobLogView from './GitJobLogView.svelte'
  // The identity row is one component now, shared with the Git panel's own
  // action row, so this file no longer draws the state and check pills; only
  // the view id remains shared.
  import PrIdentityRow from './PrIdentityRow.svelte'
  import type { PrDetailTabId } from './pr-view'
  import {
    mentionCandidates,
    mentionHandle,
    mentionKeyAction,
    mentionMenuMaxHeight,
    participantMentionUsers
  } from './pr-mentions'
  import type {
    GitHubDeploymentJobLog,
    PrAgentReport,
    PrMergeMethod,
    PrReviewEvent,
    PullRequestCheck,
    PullRequestFile,
    PullRequestSummary,
    RepositoryMentionUser
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
     * The view the reader shows. The Git panel owns it so its own checks pill
     * can switch this reader to the Checks view.
     */
    tab?: PrDetailTabId
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
    variant = 'dock',
    tab = $bindable('conversation')
  }: Props = $props()

  const mergeMethods: Array<{ id: PrMergeMethod; label: string }> = [
    { id: 'squash', label: 'Squash' },
    { id: 'merge', label: 'Merge' },
    { id: 'rebase', label: 'Rebase' }
  ]

  /**
   * Dock only. The sidebar is narrow enough that the write actions need a
   * disclosure, but the full screen rail pins the composer open instead, so
   * this flag is never read there.
   */
  let composerOpen = $state(false)

  /**
   * Full screen reader rail. The width itself lives in the shared store, so the
   * dock and the full screen reader cannot disagree about it and a reopen always
   * shows the width the user chose.
   */
  let stopRailResize: (() => void) | null = null

  /**
   * The drag listens on the window, the way the file explorer and both sidebars
   * do, so it keeps following the pointer once it leaves the 6px handle and the
   * release always lands somewhere that can finish the drag.
   */
  function startRailResize(event: PointerEvent): void {
    event.preventDefault()
    event.stopPropagation()
    if (stopRailResize) return
    prReaderRailState.resizing = true
    const startX = event.clientX
    const startWidth = prReaderRailState.width
    // The rail is on the right, so dragging left widens it.
    const onMove = (moveEvent: PointerEvent): void => {
      prReaderRailState.set(startWidth + (startX - moveEvent.clientX))
    }
    const finish = (): void => {
      stopRailResize = null
      prReaderRailState.resizing = false
      prReaderRailState.persist()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
    }
    stopRailResize = finish
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    // A drag that ends because the window lost focus never gets a pointerup.
    window.addEventListener('blur', finish)
  }

  function resizeRailWithKeyboard(event: KeyboardEvent): void {
    const delta = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0
    if (delta === 0) return
    event.preventDefault()
    prReaderRailState.set(prReaderRailState.width + delta)
  }

  onDestroy(() => stopRailResize?.())
  let commentBody = $state('')
  /**
   * `@`-mention autocomplete for the comment box.
   *
   * People already on the pull request are derived from the bundle and shown the
   * moment `@` is typed; the repository directory is fetched lazily on the first
   * mention and merged in behind them, so the popover never blocks on a network
   * call to show the likely candidates.
   */
  let commentEditor: RichMarkdownEditor | undefined
  let mentionOpen = $state(false)
  let mentionQuery = $state('')
  let mentionIndex = $state(0)
  let mentionDirectory = $state<RepositoryMentionUser[]>([])
  let mentionLoading = $state(false)
  let mentionRequestId = 0
  let mentionTimer: ReturnType<typeof setTimeout> | undefined
  let lastMentionCaretText = ''
  /** Ceiling for the popover, measured when it opens. See `measureMentionRoom`. */
  let mentionMaxHeight = $state(mentionMenuMaxHeight(Number.POSITIVE_INFINITY))
  let mentionAnchor: HTMLDivElement | undefined
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
  /** Accounts already on this pull request, available without a fetch. */
  const mentionParticipants = $derived(
    participantMentionUsers([
      summary.authorLogin,
      identity.owner,
      ...(bundle?.comments ?? []).map((comment) => comment.authorLogin),
      ...(bundle?.reviews ?? []).map((review) => review.authorLogin),
      ...(bundle?.reviewComments ?? []).map((comment) => comment.authorLogin)
    ])
  )
  const mentionEntries = $derived(
    mentionCandidates(mentionParticipants, mentionDirectory, mentionQuery)
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
      closeMentions()
      tab = 'conversation'
      notice = 'Comment posted'
      await refresh()
    }
  }

  /**
   * The top of the box an upward-opening popover is clipped by: the nearest
   * ancestor with a non-visible overflow, which in the dock is the sidebar's
   * content region and in full screen is the surface itself.
   */
  function clipTop(element: HTMLElement): number {
    let node = element.parentElement
    while (node) {
      if (getComputedStyle(node).overflowY !== 'visible') return node.getBoundingClientRect().top
      node = node.parentElement
    }
    return 0
  }

  /**
   * Cap the popover to the room above the composer, so a long candidate list in a
   * short sidebar scrolls inside the panel instead of having its first rows cut
   * off by the panel's own clipping.
   */
  function measureMentionRoom(): void {
    if (!mentionAnchor) {
      mentionMaxHeight = mentionMenuMaxHeight(Number.POSITIVE_INFINITY)
      return
    }
    const anchorTop = mentionAnchor.getBoundingClientRect().top
    // 8px keeps the popover off the edge it is clipped at.
    mentionMaxHeight = mentionMenuMaxHeight(anchorTop - clipTop(mentionAnchor) - 8)
  }

  function closeMentions(): void {
    mentionRequestId += 1
    if (mentionTimer) clearTimeout(mentionTimer)
    mentionOpen = false
  }

  /**
   * Debounced so a fast typist issues one directory lookup, not one per letter.
   * The popover opens immediately on the participants regardless, so this delay
   * is never visible as a wait.
   */
  function scheduleMentionSearch(textBeforeCaret: string): void {
    if (mentionTimer) clearTimeout(mentionTimer)
    const query = composerMentionQuery(textBeforeCaret)
    if (query === null) {
      closeMentions()
      return
    }
    mentionQuery = query
    mentionIndex = 0
    mentionOpen = true
    measureMentionRoom()
    mentionTimer = setTimeout(() => void loadMentionDirectory(), 120)
  }

  /**
   * Repository accounts, fetched once per repository per ten minutes by the
   * store. A token without the permission this needs resolves to an empty list,
   * which leaves the participants on screen rather than surfacing an error: an
   * autocomplete that cannot reach the directory is still useful.
   */
  async function loadMentionDirectory(): Promise<void> {
    const requestId = ++mentionRequestId
    mentionLoading = true
    try {
      const users = await gitState.mentionUsersFor(projectId, identity.owner, identity.repo)
      if (requestId !== mentionRequestId) return
      mentionDirectory = users
    } finally {
      if (requestId === mentionRequestId) mentionLoading = false
    }
  }

  function selectMention(user: RepositoryMentionUser): void {
    const handle = `@${mentionHandle(user)} `
    closeMentions()
    // The editor rewrites the `@query` the caret sits in, keeping the caret's
    // surroundings intact; the bound value is the fallback for the case where it
    // cannot resolve a caret (the box was never focused).
    const replaced = commentEditor?.replaceTextBeforeCaret(
      /(^|\s)@[^\s@]*$/u,
      (_match: string, prefix: string) => `${prefix}${handle}`
    )
    if (replaced) return
    commentBody = commentBody.replace(
      /(^|\s)@[^\s@]*$/u,
      (_match: string, prefix: string) => `${prefix}${handle}`
    )
  }

  /**
   * Capture phase, so the menu claims the key before the editor acts on it:
   * Enter would otherwise insert a line break instead of accepting a candidate.
   * Every key the popover does not claim falls straight through to the editor.
   */
  function handleMentionKeydown(event: KeyboardEvent): void {
    if (!mentionOpen) return
    const count = mentionEntries.length
    const action = mentionKeyAction(event.key, count)
    if (action.kind === 'passthrough') return
    event.preventDefault()
    if (action.kind === 'close') {
      closeMentions()
      return
    }
    if (action.kind === 'move') {
      mentionIndex = (mentionIndex + action.delta + count) % count
      return
    }
    const entry = mentionEntries[mentionIndex]
    if (entry) selectMention(entry)
  }

  function handleMentionCaretText(textBeforeCaret: string, supportsCommands: boolean): void {
    if (textBeforeCaret === lastMentionCaretText) return
    lastMentionCaretText = textBeforeCaret
    scheduleMentionSearch(supportsCommands ? textBeforeCaret : '')
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

{#snippet viewMenu()}
  <!--
    One definition of the view switcher: the full screen rail draws it in its
    header row, and the dock draws it beside the title. Its classes and
    behaviour are unchanged.
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
{/snippet}

{#snippet panelHead()}
  <!-- Header -->
  <div class="shrink-0 border-b border-border px-3 py-2.5">
    {#if variant === 'fullscreen'}
      <!--
        Rail only. The Git panel's action row carries the identity row for the
        dock, so this row is the rail's own: identity, then full screen, refresh
        and external link, then the view menu.
      -->
      <div class="flex items-center gap-1">
        <PrIdentityRow
          {summary}
          {detail}
          {checks}
          {onBack}
          onOpenChecks={() => (tab = 'checks')}
          showChecksLabel
        />
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
        {@render viewMenu()}
      </div>
      <p class="mt-1.5 text-[0.75rem] font-medium leading-snug text-foreground">{summary.title}</p>
    {:else}
      <!--
        Dock only. The Git panel's action row owns the identity row above, so
        the title and the view menu share this line and the meta line sits
        underneath.
      -->
      <div class="flex min-w-0 items-center gap-1.5">
        <p class="min-w-0 flex-1 truncate text-[0.75rem] font-medium leading-snug text-foreground">
          {summary.title}
        </p>
        {@render viewMenu()}
      </div>
    {/if}
    <!--
      One meta line instead of two: the refs, the author, the age and the change
      summary all describe the same thing. The refs read as ordinary adjacent
      text and wrap onto the next line when the rail is narrow, so nothing here
      can outgrow the panel.
    -->
    <p
      class="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.5625rem] text-dimmed"
    >
      <span class="font-mono">{summary.headRef}</span>
      <span class="font-mono">→ {summary.baseRef}</span>
      <span class="shrink-0">· {summary.authorLogin}</span>
      <span class="shrink-0">· {relativeTime(summary.updatedAt)}</span>
      {#if detail}
        <span class="flex shrink-0 items-center gap-1.5 tabular-nums">
          <span class="text-success">+{detail.additions}</span>
          <span class="text-danger">−{detail.deletions}</span>
          <span>{detail.changedFiles} files</span>
          <span>{detail.commitCount} commits</span>
        </span>
      {/if}
      {#if open && gitState.hasPrIssue(identity.owner, identity.repo, number)}
        <span class="flex shrink-0 items-center gap-1 text-warning">
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
      composer open instead, so it has no use for this. It keeps its word rather
      than collapsing to a bare icon: the row has the space, and when the sidebar
      is at its narrowest the merge label is the one that truncates. The text is
      the accessible name, so no aria-label competes with it.
    -->
    <button
      type="button"
      class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[0.625rem] font-medium transition-colors {composerOpen
        ? 'border-primary bg-primary/10 text-foreground'
        : 'border-border text-foreground hover:bg-elevated'}"
      aria-expanded={composerOpen}
      title={composerOpen ? 'Hide the comment box' : 'Write a comment or review'}
      onclick={() => (composerOpen = !composerOpen)}
    >
      <MessageSquare size={12} class="shrink-0" />
      <span class="shrink-0">Comment</span>
    </button>
  {/if}
{/snippet}

{#snippet closePullRequestButton()}
  <!--
    Closing is a direct button, not a one-item overflow menu: an ellipsis over a
    single action costs a click and never says what it holds. The panel footer
    has the room to spell the action out, so the label is the full one in both
    variants. The confirm dialog still guards the action.
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
      <Loader2 size={12} class="shrink-0 animate-spin" />
    {:else}
      <X size={12} class="shrink-0" />
    {/if}
    <span class="min-w-0 truncate">Close without merging</span>
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
        <Loader2 size={12} class="shrink-0 animate-spin" />
      {:else}
        <Check size={12} class="shrink-0" />
      {/if}
      <span class="min-w-0 truncate">Ready for review</span>
    </button>
  {:else}
    <!--
      The method picker is a dropdown trigger inside the merge button's own
      outline (the EditorOpenControl split-button pattern) rather than a bare
      <select>.

      The wrapper is `rounded-xs` because every button in the app is rounded by
      `:where(button) { border-radius: 2px !important }` in app.css. A larger
      radius on this wrapper made the one primary action in the panel the only
      control with pill corners: the outside has to match the halves it clips.
    -->
    <div
      class="flex h-7 min-w-0 items-stretch overflow-hidden rounded-xs {variant === 'fullscreen'
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
                <span class="truncate text-[0.6875rem] font-medium text-foreground"
                  >{entry.author}</span
                >
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
                  <MarkdownView
                    text={entry.body}
                    class="text-[0.6875rem] leading-relaxed"
                    allowHtml
                  />
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
                <!--
                  No `failedSteps` here on purpose: a check is named after its job, and
                  the log's sections are named after steps, so there is nothing to match.
                  The view marks the step GitHub flagged with an error in the log itself.
                -->
                <GitJobLogView
                  log={checkLogs[key] ?? null}
                  loading={loadingCheckLogs[key] === true}
                  error={checkLogErrors[key] ?? ''}
                  class="max-h-72 overflow-auto px-3 py-2"
                />
                {#if runId !== null}
                  <div class="border-t border-border/40 px-3 py-1.5">
                    <button
                      type="button"
                      class="flex h-6 min-w-0 cursor-pointer items-center gap-1 text-[0.625rem] font-medium text-muted transition-colors hover:text-foreground"
                      title="Open this workflow run in the Deployments tab to inspect every job and step"
                      onclick={() => onOpenWorkflowRun(runId)}
                    >
                      <Rocket size={11} class="shrink-0" />
                      <span class="min-w-0 truncate">Open the full run in Deployments</span>
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
              class="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
              title="Open the review thread already running for this pull request"
              onclick={() => onOpenThread(agentReport?.threadId ?? '')}
            >
              <Bot size={12} class="shrink-0" />
              <span class="min-w-0 truncate">Open review thread</span>
            </button>
          {/if}
          <button
            type="button"
            class="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover"
            onclick={() => onAgentReview(summary)}
          >
            <Bot size={12} class="shrink-0" />
            <span class="min-w-0 truncate">Start agent review</span>
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
    <!--
      `relative` anchors the mention popover, and the capture-phase keydown
      handler lets it claim Enter/Tab/arrows before the editor does. Both belong
      to this wrapper rather than the panel so the menu stays scoped to the box
      it completes: a window-level handler would also fire for the chat composer.
    -->
    <div
      class="relative px-3 pt-2.5"
      bind:this={mentionAnchor}
      onkeydowncapture={handleMentionKeydown}
    >
      <RichMarkdownEditor
        bind:this={commentEditor}
        bind:value={commentBody}
        placeholder="Leave a comment, or write the feedback for a review…"
        ariaLabel="Pull request comment"
        containerClass="border border-border bg-elevated focus-within:border-primary"
        class="min-h-36 max-h-56 w-full resize-y overflow-y-auto px-3.5 pt-3 pb-2 text-foreground outline-none"
        onCaretTextChange={handleMentionCaretText}
      />
      {#if mentionOpen}
        <PrMentionMenu
          entries={mentionEntries}
          activeIndex={mentionIndex}
          query={mentionQuery}
          loading={mentionLoading}
          maxHeight={mentionMaxHeight}
          onSelect={selectMention}
        />
      {/if}
    </div>

    <!--
      Comment and review both consume the box above, so they read as one
      toolbar (shared border, no gaps) instead of three loose buttons. Each one
      grows from its own label rather than from zero, so no label is squeezed
      under its own width until the rail really is too narrow; past that they
      truncate instead of wrapping onto a second line inside the fixed height row.
    -->
    <div class="px-3 py-2.5">
      <div class="flex h-8 items-stretch overflow-hidden rounded-lg border border-border">
        <button
          type="button"
          class="flex min-w-0 flex-auto cursor-pointer items-center justify-center gap-1.5 bg-primary px-2 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40"
          title={hasBody ? 'Post this as a comment' : 'Write something first'}
          disabled={posting || !hasBody}
          onclick={() => void postComment()}
        >
          {#if posting}
            <Loader2 size={12} class="shrink-0 animate-spin" />
          {:else}
            <MessageSquare size={12} class="shrink-0" />
          {/if}
          <span class="min-w-0 truncate">Comment</span>
        </button>
        <button
          type="button"
          class="flex min-w-0 flex-auto cursor-pointer items-center justify-center gap-1.5 border-l border-border text-[0.625rem] font-medium text-success transition-colors hover:bg-success/10 disabled:cursor-default disabled:opacity-40"
          title={open
            ? 'Approve this pull request (a comment is optional)'
            : 'This pull request is no longer open'}
          disabled={!open || reviewing}
          onclick={() => void submitReview('APPROVE')}
        >
          <ThumbsUp size={12} class="shrink-0" />
          <span class="min-w-0 truncate">Approve</span>
        </button>
        <button
          type="button"
          class="flex min-w-0 flex-auto cursor-pointer items-center justify-center gap-1.5 border-l border-border text-[0.625rem] font-medium text-warning transition-colors hover:bg-warning/10 disabled:cursor-default disabled:opacity-40"
          title={!open
            ? 'This pull request is no longer open'
            : hasBody
              ? 'Request changes on this pull request'
              : 'Write what needs to change first, GitHub requires a comment'}
          disabled={!open || reviewing || !hasBody}
          onclick={() => void submitReview('REQUEST_CHANGES')}
        >
          <TriangleAlert size={12} class="shrink-0" />
          <span class="min-w-0 truncate">Request changes</span>
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
            class="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-2.5 text-[0.625rem] font-medium text-warning transition-colors hover:bg-warning/20 disabled:cursor-default disabled:opacity-40"
            title="Check out this branch locally, merge the base in, and resolve the conflicts in your editor"
            disabled={resolving}
            onclick={() => (resolveConfirm = true)}
          >
            {#if resolving}
              <Loader2 size={12} class="shrink-0 animate-spin" />
            {:else}
              <Merge size={12} class="shrink-0" />
            {/if}
            <span class="min-w-0 truncate">Resolve locally</span>
          </button>
          <button
            type="button"
            class="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated"
            title="Have an agent resolve the conflicts and push the fix"
            onclick={() => onResolveWithAgent?.(summary)}
          >
            <Bot size={12} class="shrink-0" />
            <span class="min-w-0 truncate">Resolve with agent</span>
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
      style="width: {prReaderRailState.width}px"
    >
      <button
        type="button"
        class="absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/30 focus:bg-primary/30 focus:outline-none {prReaderRailState.resizing
          ? 'bg-primary/30'
          : ''}"
        title="Resize pull request details"
        aria-label="Resize pull request details"
        onpointerdown={startRailResize}
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
