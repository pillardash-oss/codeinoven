<script lang="ts">
  import {
    Bot,
    Check,
    ChevronDown,
    CircleDot,
    CircleSlash,
    ExternalLink,
    Loader2,
    Maximize2,
    MessageSquare,
    Merge,
    RefreshCw,
    RotateCcw,
    ThumbsUp,
    TriangleAlert,
    X
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { onDestroy, tick } from 'svelte'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { threadSettings } from '$lib/stores/thread-settings.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { prReaderRailState } from '$lib/stores/pr-reader-rail.svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  // The `@query` detection is shared with the chat composer rather than
  // re-implemented here: it already knows to stay silent inside code spans and
  // quoted passages, which a second copy would have to relearn.
  import { composerMentionQuery } from '../chats/composer-mentions'
  import PrMentionMenu from './PrMentionMenu.svelte'
  // The identity row is one component now, shared with the Git panel's own
  // action row, so this file no longer draws the state and check pills; only
  // the view id remains shared.
  import PrIdentityRow from './PrIdentityRow.svelte'
  import BotBadge from './BotBadge.svelte'
  import GitPullRequestDetailConversation from './GitPullRequestDetailConversation.svelte'
  import GitPullRequestDetailChanges from './GitPullRequestDetailChanges.svelte'
  import GitPullRequestDetailChecks from './GitPullRequestDetailChecks.svelte'
  import GitPullRequestDetailAgentReport from './GitPullRequestDetailAgentReport.svelte'
  import { assignAgentToCheck, assignAgentToComment } from './git-status-panel-agent-actions'
  import GitPullRequestDetailMergeDialogs from './GitPullRequestDetailMergeDialogs.svelte'
  import PrMergeConfirmDialog from './PrMergeConfirmDialog.svelte'
  import {
    buildConversation,
    conversationKindLabel,
    conversationQuoteBlock,
    type ConversationEntry
  } from './git-pull-request-detail-format'
  import {
    prCommentChatContext,
    prCommentExplainPrompt,
    type PrCommentChatSubject
  } from './git-status-panel-prompts'
  import { PR_DETAIL_VIEWS, prViewCount, type PrDetailTabId } from './pr-view'
  import {
    mentionCandidates,
    mentionHandle,
    mentionKeyAction,
    mentionMenuMaxHeight,
    participantMentionUsers
  } from './pr-mentions'
  import type {
    PrAgentReport,
    PrMergeMethod,
    PrReviewEvent,
    PullRequestCheck,
    PullRequestSummary,
    RepositoryMentionUser
  } from '$shared/types'

  interface Props {
    projectId: string
    /** Thread whose sidebar hosts the comment side chats this reader opens. */
    threadId: string
    identity: { owner: string; repo: string }
    summary: PullRequestSummary
    onBack: () => void
    /** Hand this pull request to an agent to triage, test, and report back on. */
    onAssignAgent: (pr: PullRequestSummary) => void
    /** Reopen the thread that owns this pull request's agent assignment. */
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
    threadId,
    identity,
    summary,
    onBack,
    onAssignAgent,
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
  /** Every agent assignment on this pull request, newest first. */
  let agentReports = $state<PrAgentReport[]>([])
  /**
   * A conversation entry an agent report asked to be shown, with a token that
   * changes on every request so asking twice for the same comment still jumps.
   */
  let commentReveal = $state<{ url: string; token: number } | null>(null)

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
   * comments, submitted reviews, and inline code comments, the same context
   * GitHub shows, so a merge decision never needs the browser.
   */
  const conversation = $derived(buildConversation(bundle))

  /**
   * The active view is one of these. In the full screen reader they become a
   * dropdown in the header instead of a row of tabs, because the rail is too
   * narrow to hold both the tabs and the actions comfortably.
   */
  const tabs = $derived(
    PR_DETAIL_VIEWS.map((view) => ({
      ...view,
      count: prViewCount(view.id, bundle, agentReports.length)
    }))
  )

  async function refresh(): Promise<void> {
    await gitState.ensurePullRequestBundle(projectId, identity.owner, identity.repo, number, true)
    agentReports = await gitState.loadAgentReports(projectId, number)
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
   * The facts the comment-shaped actions need, resolved once.
   *
   * Both the side chats and the agent assignment describe the same comment, so the
   * mapping from a conversation entry to a subject lives here rather than being
   * written out twice and drifting.
   */
  function commentSubject(entry: ConversationEntry): PrCommentChatSubject {
    return {
      author: githubDisplayLogin(entry.author),
      url: entry.url,
      kindLabel: conversationKindLabel(entry.kind, entry.meta),
      ...(entry.kind === 'inline' && entry.meta ? { location: entry.meta } : {}),
      ...(entry.diffHunk ? { diffHunk: entry.diffHunk } : {})
    }
  }

  /**
   * Open a read-only sidebar side chat anchored on one comment.
   *
   * The comment rides as the selection, and the pinned context carries the pull
   * request plus the comment's own permalink, so the agent can look the thread
   * up and, when the user agrees, ground its answer in the remote copy of what
   * the comment references. Explain auto-sends the grounding brief; Quick chat
   * opens with the comment attached and the reader writing the question.
   */
  function openCommentChat(entry: ConversationEntry, mode: 'explain' | 'quick'): void {
    const subject = commentSubject(entry)
    contextSidebarState.openTemporaryChat(
      projectId,
      threadId,
      mode === 'explain' ? 'elaborate' : 'quick',
      entry.body,
      prCommentChatContext(subject, summary, `${identity.owner}/${identity.repo}`),
      threadSettings.lastUsed,
      true,
      mode === 'explain' ? prCommentExplainPrompt(subject) : undefined
    )
  }

  /**
   * Hand one comment to an agent as an assignment.
   *
   * Done here rather than through a prop, unlike the pull request-level action: the
   * reader is the only surface that knows which entry a menu row belongs to, and it
   * already owns the other comment-shaped work on this pull request.
   */
  function assignCommentToAgent(entry: ConversationEntry): void {
    void assignAgentToComment(
      projectId,
      summary,
      `${identity.owner}/${identity.repo}`,
      commentSubject(entry),
      entry.body
    )
  }

  /**
   * Hand one failed check to an agent as an assignment.
   *
   * The reader owns this rather than a prop, for the same reason it owns the
   * comment-shaped work: it holds the identity and the pull request the check
   * belongs to, and the check itself arrives from the row that was clicked.
   */
  function assignCheckToAgent(check: PullRequestCheck): Promise<void> {
    return assignAgentToCheck(projectId, summary, identity, check)
  }

  /**
   * Quote a comment into the composer, the way GitHub's own action does.
   *
   * The composer is a disclosure in the dock, so it has to be opened first, and
   * the editor only exists after the next tick, which is also what lets the caret
   * land at the end of the inserted quote instead of nowhere.
   */
  async function quoteEntry(entry: ConversationEntry): Promise<void> {
    tab = 'conversation'
    composerOpen = true
    const block = conversationQuoteBlock(entry)
    commentBody = commentBody.trim() ? `${commentBody.trim()}\n\n${block}` : block
    await tick()
    commentEditor?.focusAtBookmark(null)
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

  /**
   * Post an agent's report into the PR conversation, verbatim.
   *
   * The report is named by the caller rather than read from a selection: the
   * Agent view shows every assignment at once, so there is no "current" report
   * for this to pick up.
   */
  async function postAgentReport(report: PrAgentReport): Promise<void> {
    if (!report.content.trim()) return
    const created = await gitState.commentOnPullRequest(
      projectId,
      identity.owner,
      identity.repo,
      number,
      report.content
    )
    if (created) {
      notice = 'Agent report posted to the pull request'
      tab = 'conversation'
      await refresh()
    }
  }

  /**
   * Take an agent report's reader to the comment it answered.
   *
   * The conversation is what holds the comment, so this switches views and hands
   * the permalink down; the conversation scrolls to that entry and flashes it,
   * which is the difference between opening a view and finding the thing.
   */
  function showReportComment(report: PrAgentReport): void {
    if (!report.url) return
    commentReveal = { url: report.url, token: (commentReveal?.token ?? 0) + 1 }
    tab = 'conversation'
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
    void gitState.loadAgentReports(projectId, pull).then((reports) => {
      agentReports = reports
    })
  })
</script>

{#snippet panelHead()}
  <!-- Header -->
  <div class="shrink-0 border-b border-border px-3 py-2.5">
    {#if variant === 'fullscreen'}
      <!--
        Rail only. The Git panel's action row carries the identity row for the
        dock, so this row is the rail's own: identity, then full screen, refresh
        and external link. The view list below already names every view, so no
        switcher is repeated up here.
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
          data-external-url={summary.url}
          onclick={() => void openInBrowser(summary.url)}
        >
          <ExternalLink size={13} />
        </button>
      </div>
      <p class="mt-1.5 text-[0.75rem] font-medium leading-snug text-foreground">{summary.title}</p>
    {:else}
      <!--
        Dock only. The panel's action row carries the identity row, the view
        switcher and the remote actions, so this line is the title alone.
      -->
      <p
        class="min-w-0 truncate text-[0.75rem] font-medium leading-snug text-foreground"
        title={summary.title}
      >
        {summary.title}
      </p>
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
      <span class="shrink-0">· {githubDisplayLogin(summary.authorLogin)}</span>
      <!--
        The name above lost its `[bot]` suffix, so this badge is what says the
        account is an App. Without it a bot's pull request reads as a person's.
      -->
      {#if summary.authorIsBot}
        <BotBadge />
      {/if}
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
      <GitPullRequestDetailConversation
        nodes={conversation}
        files={bundle?.files ?? []}
        {projectId}
        {identity}
        {number}
        authorLogin={summary.authorLogin}
        reveal={commentReveal}
        onRevealDone={() => (commentReveal = null)}
        onQuote={(entry) => void quoteEntry(entry)}
        onCommentChat={openCommentChat}
        onAssignAgent={assignCommentToAgent}
        onNotice={(message) => (notice = message)}
        onRefresh={refresh}
      />
    {:else if tab === 'commits'}
      <GitPullRequestDetailChanges
        mode="commits"
        commits={bundle?.commits ?? []}
        files={bundle?.files ?? []}
        loadCommitFiles={(sha) =>
          gitState.getCommitFiles(projectId, identity.owner, identity.repo, sha)}
      />
    {:else if tab === 'files'}
      <GitPullRequestDetailChanges
        mode="files"
        commits={bundle?.commits ?? []}
        files={bundle?.files ?? []}
        loadCommitFiles={(sha) =>
          gitState.getCommitFiles(projectId, identity.owner, identity.repo, sha)}
      />
    {:else if tab === 'checks'}
      <GitPullRequestDetailChecks
        {projectId}
        {identity}
        {checks}
        {onOpenWorkflowRun}
        onAssignCheck={assignCheckToAgent}
        onRefresh={refresh}
      />
    {:else}
      <GitPullRequestDetailAgentReport
        {number}
        {projectId}
        {summary}
        reports={agentReports}
        {posting}
        {onOpenThread}
        {onAssignAgent}
        onShowInConversation={showReportComment}
        onPostReport={(report) => void postAgentReport(report)}
      />
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
      Two clusters on one row: the verdicts on the left, where a review reads
      left to right, and the plain comment on the right, where the submit action
      belongs. The verdicts share one outline (the join reads as one control); the
      comment is its own button. Both are `rounded-xs` because every button in the
      app is pinned to 2px by `:where(button) { border-radius: 2px !important }`
      in app.css, and a wrapper with a larger radius is what made these read as
      pill-shaped.
    -->
    <div class="flex items-stretch gap-2 px-3 py-2.5">
      <div class="flex h-8 min-w-0 items-stretch overflow-hidden rounded-xs border border-border">
        <button
          type="button"
          class="flex min-w-0 flex-auto cursor-pointer items-center justify-center gap-1.5 px-2 text-[0.625rem] font-medium text-success transition-colors hover:bg-success/10 disabled:cursor-default disabled:opacity-40"
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
          class="flex min-w-0 flex-auto cursor-pointer items-center justify-center gap-1.5 border-l border-border px-2 text-[0.625rem] font-medium text-warning transition-colors hover:bg-warning/10 disabled:cursor-default disabled:opacity-40"
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
      <span class="min-w-0 flex-1"></span>
      <button
        type="button"
        class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-xs bg-primary px-2.5 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40"
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

<GitPullRequestDetailMergeDialogs
  {number}
  {summary}
  bind:closeOpen={closeConfirm}
  bind:resolveOpen={resolveConfirm}
  onResolveLocally={() => onResolveLocally?.(summary)}
  onClosePullRequest={() => void closePullRequest()}
/>

<PrMergeConfirmDialog
  {number}
  {summary}
  {method}
  checksFailure={checks?.state === 'failure'}
  fieldSuffix={mergeFieldSuffix}
  busy={merging}
  bind:open={mergeConfirm}
  bind:commitTitle
  bind:commitMessage
  onConfirm={() => void merge()}
/>
