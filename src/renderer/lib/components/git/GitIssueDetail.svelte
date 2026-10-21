<script lang="ts">
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioExternalLink from '@pdslng/cio-icon/CioExternalLink.svelte'
  import CioHammer from '@pdslng/cio-icon/CioHammer.svelte'
  import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
  import CioMilestone from '@pdslng/cio-icon/CioMilestone.svelte'
  import CioPersonPlus from '@pdslng/cio-icon/CioPersonPlus.svelte'
  import CioPullRequest from '@pdslng/cio-icon/CioPullRequest.svelte'
  import CioSend from '@pdslng/cio-icon/CioSend.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTag from '@pdslng/cio-icon/CioTag.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { formatCompactAge } from '$shared/date-time-format'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import { openInBrowser } from '$lib/open-in-browser'
  import { GitState, gitState } from '$lib/stores/git.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import PrAvatar from './PrAvatar.svelte'
  import BotBadge from './BotBadge.svelte'
  import {
    issueStateIcon,
    issueStateReasonLabel,
    issueStateToneClass,
    issueTimelineLine,
    type IssueTimelineLine
  } from './issue-view'
  import TimelineCollapsedRows from './TimelineCollapsedRows.svelte'
  import TimelineEventRow from './TimelineEventRow.svelte'
  import TimelineRailItem from './TimelineRailItem.svelte'
  import { timelineCollapsePlan } from './timeline-view'
  import { prLabelStyle, type PrMetadataMode } from './pr-view'
  import PrReactionPicker from './PrReactionPicker.svelte'
  import PrReactionChips from './PrReactionChips.svelte'
  import IssueRelationships from './IssueRelationships.svelte'
  import IssueRelationshipPicker from './IssueRelationshipPicker.svelte'
  import type { GithubRepoContext } from '$lib/github-references'
  import type {
    IssueComment,
    IssueRelationshipItem,
    IssueRelationshipMode,
    IssueSummary,
    IssueTimelineEvent,
    PrReactionContent
  } from '$shared/types'

  /**
   * One row of the issue's stream: a comment, or one thing that happened to it.
   *
   * A discriminated pair rather than one shape with optional halves, so the row
   * that draws a comment cannot be handed an event and read a missing body.
   */
  type IssueFlowItem =
    | { kind: 'comment'; key: string; at: string; comment: IssueComment }
    | {
        kind: 'event'
        key: string
        at: string
        event: IssueTimelineEvent
        line: IssueTimelineLine
      }

  interface Props {
    projectId: string
    identity: { owner: string; repo: string }
    issue: IssueSummary
    /**
     * Return to the list this reader was opened from. Omitted when the host owns
     * the back control, which is how the Git panel draws its action row: the row
     * carries the control and its label names the view actually being returned to.
     */
    onBack?: () => void
    onWorkOn: (issue: IssueSummary) => void
    /**
     * Open a pull request prefilled to close this issue. Omitted for an issue that
     * lives in another repository: the sheet it opens composes a pull request in
     * the project, which would close a number belonging to somewhere else.
     */
    onCreatePr?: (issue: IssueSummary) => void
    onEditMetadata: (mode: PrMetadataMode, issue: IssueSummary) => void
    /**
     * Ask to close the issue. The view owns the confirmation and the reason, so
     * every entry point   this button and the list row menu   raises the one
     * dialog instead of each drawing its own copy of it.
     */
    onRequestClose: (issue: IssueSummary) => void
    /** Bring a closed issue back, which needs no confirmation: it adds state back. */
    onReopen: (issue: IssueSummary) => void
    /** Open an issue this one relates to, when it lives in the same repository. */
    onOpenRelated: (item: IssueRelationshipItem) => void
    /**
     * Open a commit this issue's history references, in the Git panel.
     *
     * A reference event names its commit by hash, and the commit belongs to the
     * repository the reader is already in, so the reader hands the hash over
     * instead of deciding where a commit is read.
     */
    onOpenCommit: (commitId: string) => void
    onOpenInBrowser: (issue: IssueSummary) => void
  }

  let {
    projectId,
    identity,
    issue,
    onBack,
    onWorkOn,
    onCreatePr,
    onEditMetadata,
    onRequestClose,
    onReopen,
    onOpenRelated,
    onOpenCommit,
    onOpenInBrowser
  }: Props = $props()

  const repository: GithubRepoContext = $derived({
    owner: identity.owner,
    repo: identity.repo
  })

  const bundleKey = $derived(GitState.issueBundleKey(identity.owner, identity.repo, issue.number))
  const bundle = $derived(gitState.issueBundles[bundleKey] ?? null)
  const detail = $derived(bundle?.detail ?? null) /**
   * The subject the surface draws: the fetched record once it is in, otherwise the
   * summary the list handed over, so the header never flashes empty.
   */
  const subject = $derived(detail ?? issue)
  const comments = $derived(bundle?.comments ?? [])
  /**
   * The issue's history, from its own cache entry: read after the bundle rather
   * than with it, so a heavily referenced issue's slow timeline never holds back
   * the description and the conversation the reader came for.
   */
  const timeline = $derived(
    gitState.conversationTimeline(identity.owner, identity.repo, issue.number)
  )

  /** The issue's parent, sub-issues and dependencies, read the same way. */
  const relationships = $derived(gitState.issueRelationships[bundleKey]?.value ?? null)
  const loading = $derived(gitState.isBusy('issue-detail') && bundle === null)
  const posting = $derived(gitState.isBusy('issue-comment'))
  const busyCommentId = $derived(
    gitState.isBusy('issue-comment-edit') || gitState.isBusy('issue-comment-delete')
  )

  const StateIcon = $derived(issueStateIcon(subject))
  const reasonLabel = $derived(issueStateReasonLabel(subject.stateReason))

  /**
   * The issue's history, merged with its comments into the one stream GitHub
   * shows: the description above, then everything that happened after it in the
   * order it happened. The events carry their own wording already, so the row does
   * no work beyond drawing it.
   */
  const flow = $derived.by((): IssueFlowItem[] => {
    const items: IssueFlowItem[] = [
      ...comments.map((comment): IssueFlowItem => ({
        kind: 'comment',
        key: `comment:${comment.id}`,
        at: comment.createdAt,
        comment
      })),
      ...timeline.map((event): IssueFlowItem => ({
        kind: 'event',
        key: `event:${event.id}`,
        at: event.createdAt,
        event,
        line: issueTimelineLine(event)
      }))
    ]
    // ISO timestamps compare correctly as strings, so no date arithmetic is needed
    // to put the stream in order.
    return items.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0))
  })

  /** `owner/repo`, for telling a cross-repository reference from a local one. */
  const repositoryName = $derived(`${identity.owner}/${identity.repo}`)

  /**
   * The middle of a long history this reader has opened, if it has.
   *
   * Held against the issue rather than as a plain flag, because opening another
   * issue does not remount this reader: a flag would hand the next issue an already
   * opened middle it never asked for.
   */
  let openedMiddleFor = $state<number | null>(null)
  const plan = $derived(timelineCollapsePlan(flow))

  /** Reactions on the issue and its comments, keyed by the subject's node id. */
  const reactions = $derived(bundle?.reactions ?? {})
  /** The issue's own node id, or null for a payload that carried none. */
  const issueNodeId = $derived(detail?.nodeId ?? null)
  /** The reactions on the issue itself, which the chip row draws. */
  const issueReactions = $derived(issueNodeId ? (reactions[issueNodeId] ?? []) : [])

  /** Add or take back the reader's reaction on one subject of this conversation. */
  function reactTo(nodeId: string | null, content: PrReactionContent, add: boolean): void {
    if (!nodeId) return
    void gitState.setIssueReaction(
      projectId,
      identity.owner,
      identity.repo,
      issue.number,
      nodeId,
      content,
      add
    )
  }

  async function load(force = false): Promise<void> {
    await gitState.ensureIssueBundle(projectId, identity.owner, identity.repo, issue.number, force)
  }

  $effect(() => {
    const number = issue.number
    const owner = identity.owner
    const repo = identity.repo
    void number
    void owner
    void repo
    void gitState.ensureIssueBundle(projectId, owner, repo, number, false)
    // The history and the relationships are independent reads. Nothing in the reader
    // waits on either, and one the provider cannot answer leaves the issue readable.
    void gitState.ensureConversationTimeline(projectId, owner, repo, number, false)
    void gitState.ensureIssueRelationships(projectId, owner, repo, number, false)
  })

  let draft = $state('')
  let editingId = $state<number | null>(null)
  let editingBody = $state('')
  let confirmingDelete = $state<IssueComment | null>(null)
  /** The relationship being added, or null while the picker is closed. */
  let linking = $state<IssueRelationshipMode | null>(null)
  /** The link being undone, which is confirmed before anything is written. */
  let unlinking = $state<{ mode: IssueRelationshipMode; item: IssueRelationshipItem } | null>(null)
  const unlinkBusy = $derived(gitState.isBusy('issue-relationship'))

  /**
   * The issue numbers already related, so the picker does not offer them again.
   *
   * Every group is pooled into one list: the same issue cannot usefully be both a
   * sub-issue and a blocker of this one, and a picker that offered it twice would be
   * inviting a link GitHub would reject.
   */
  const relatedNumbers = $derived(
    relationships === null
      ? []
      : [
          ...(relationships.parent ? [relationships.parent.number] : []),
          ...relationships.subIssues.map((item) => item.number),
          ...relationships.blockedBy.map((item) => item.number),
          ...relationships.blocking.map((item) => item.number)
        ]
  )

  /**
   * Undo the link the reader asked to remove.
   *
   * The mode decides which side holds the relationship: a sub-issue is detached from
   * its parent, so the parent is the issue named first, while a blocker is removed
   * from this issue's own list. Both writes are the same mutation with the two ids
   * swapped, which is why the direction is decided here and not in the payload.
   */
  async function unlink(): Promise<void> {
    const pending = unlinking
    const ownNodeId = issueNodeId
    if (!pending || !ownNodeId || pending.item.nodeId === null) return
    const related = pending.item.nodeId
    const link = (mode: IssueRelationshipMode, first: string, second: string): Promise<boolean> =>
      mode === 'blocked-by' || mode === 'blocking'
        ? gitState.removeIssueBlockedBy(
            projectId,
            identity.owner,
            identity.repo,
            issue.number,
            first,
            second
          )
        : gitState.removeIssueSubIssue(
            projectId,
            identity.owner,
            identity.repo,
            issue.number,
            first,
            second
          )
    // Which side holds the link: a parent and an issue this one blocks are held by
    // the other issue, while a sub-issue and a blocker are held by this one. Getting
    // this backwards addresses the mutation at the wrong issue, which GitHub answers
    // with a refusal rather than a wrong link.
    const heldByRelated = pending.mode === 'parent' || pending.mode === 'blocking'
    const landed = await link(
      pending.mode,
      heldByRelated ? related : ownNodeId,
      heldByRelated ? ownNodeId : related
    )
    if (landed) unlinking = null
  }

  async function submitComment(): Promise<void> {
    const body = draft.trim()
    if (!body || posting) return
    const posted = await gitState.createIssueComment(
      projectId,
      identity.owner,
      identity.repo,
      issue.number,
      body
    )
    if (!posted) return
    draft = ''
    await load(true)
  }

  async function saveEdit(): Promise<void> {
    if (editingId === null) return
    const body = editingBody.trim()
    if (!body) return
    const saved = await gitState.updateIssueComment(
      projectId,
      identity.owner,
      identity.repo,
      editingId,
      body
    )
    if (!saved) return
    editingId = null
    editingBody = ''
    await load(true)
  }

  async function confirmDelete(): Promise<void> {
    const comment = confirmingDelete
    if (!comment) return
    const deleted = await gitState.deleteIssueComment(
      projectId,
      identity.owner,
      identity.repo,
      comment.id
    )
    confirmingDelete = null
    if (deleted) await load(true)
  }

  /** Only the author may rewrite or delete their own comment, as GitHub enforces. */
  function isOwnComment(comment: IssueComment): boolean {
    const viewer = gitState.githubViewerLogin
    return viewer !== null && viewer.toLowerCase() === comment.authorLogin.toLowerCase()
  }

  function onComposerKeydown(event: KeyboardEvent): void {
    if (keymapState.matches('ui-modal-primary-action', event)) {
      event.preventDefault()
      void submitComment()
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <!-- Header: back, state, number, title, and the work actions this issue offers. -->
  <div class="flex shrink-0 flex-col gap-1.5 border-b border-border px-2.5 py-2">
    <div class="flex items-center gap-1.5">
      {#if onBack}
        <button
          type="button"
          class="flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Back to issues"
          aria-label="Back to issues"
          onclick={onBack}
        >
          <CioBack size={13} />
        </button>
      {/if}
      <span
        class="flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide {issueStateToneClass(
          subject
        )}"
      >
        <StateIcon size={10} />
        {subject.state === 'open' ? 'Open' : 'Closed'}
      </span>
      <span class="shrink-0 font-mono text-[0.625rem] text-dimmed">#{subject.number}</span>
      <span class="flex-1"></span>
      <button
        type="button"
        class="flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Open this issue on GitHub"
        aria-label="Open this issue on GitHub"
        onclick={() => onOpenInBrowser(subject)}
      >
        <CioExternalLink size={12} />
      </button>
    </div>
    <p class="text-[0.75rem] font-semibold leading-snug text-foreground">{subject.title}</p>
    <div class="flex flex-wrap items-center gap-1">
      <button
        type="button"
        class="flex h-6 cursor-pointer items-center gap-1 bg-primary/10 px-2 text-[0.625rem] font-medium text-primary transition-colors hover:bg-primary/20"
        title="Open a new agent thread seeded with this issue"
        onclick={() => onWorkOn(subject)}
      >
        <CioHammer size={11} />
        Work on this issue
      </button>
      {#if onCreatePr}
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 px-2 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Open a pull request prefilled to close this issue"
          onclick={() => onCreatePr?.(subject)}
        >
          <CioPullRequest size={11} />
          Create pull request
        </button>
      {/if}
      {#if subject.state === 'open'}
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 px-2 text-[0.625rem] font-medium text-danger transition-colors hover:bg-danger/10"
          title="Close this issue"
          onclick={() => onRequestClose(subject)}
        >
          <CioClose size={11} />
          Close
        </button>
      {:else}
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 px-2 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Reopen this issue"
          onclick={() => onReopen(subject)}
        >
          <CioUndo size={11} />
          Reopen
        </button>
      {/if}
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
    {#if loading}
      <div class="flex items-center justify-center gap-2 py-10 text-[0.6875rem] text-dimmed">
        <CioSpinner size={13} class="animate-spin" />
        Loading issue…
      </div>
    {:else}
      <!-- Metadata: what the issue carries, each chip a control that opens its picker. -->
      <div class="flex flex-wrap items-center gap-1">
        {#each subject.labels ?? [] as label (label.name)}
          <button
            type="button"
            class="max-w-[14ch] cursor-pointer truncate px-1.5 py-0.5 text-[0.5625rem] font-medium leading-none transition-opacity hover:opacity-80"
            style={prLabelStyle(label.color)}
            title="Edit labels"
            onclick={() => onEditMetadata('labels', subject)}
          >
            {label.name}
          </button>
        {/each}
        <button
          type="button"
          class="flex h-5 cursor-pointer items-center gap-1 border border-border px-1.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Edit labels"
          onclick={() => onEditMetadata('labels', subject)}
        >
          <CioTag size={9} />
          Labels
        </button>
        <button
          type="button"
          class="flex h-5 cursor-pointer items-center gap-1 border border-border px-1.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Edit assignees"
          onclick={() => onEditMetadata('assignees', subject)}
        >
          <CioPersonPlus size={9} />
          {#if subject.assignees && subject.assignees.length > 0}
            {subject.assignees.map((entry) => githubDisplayLogin(entry.login)).join(', ')}
          {:else}
            Assign
          {/if}
        </button>
        <button
          type="button"
          class="flex h-5 cursor-pointer items-center gap-1 border border-border px-1.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Set milestone"
          onclick={() => onEditMetadata('milestone', subject)}
        >
          <CioMilestone size={9} />
          {subject.milestone ? subject.milestone.title : 'Milestone'}
        </button>
        {#if reasonLabel}
          <span class="text-[0.5625rem] text-dimmed">Closed as {reasonLabel.toLowerCase()}</span>
        {/if}
      </div>

      <!--
        What this issue relates to, in the same place github.com puts it: beside the
        labels and assignees rather than buried under the conversation, because a
        parent or a blocker changes how the issue should be read.
      -->
      <IssueRelationships
        repository={repositoryName}
        {relationships}
        {issueNodeId}
        onOpenIssue={onOpenRelated}
        onOpenRemote={(item) => void openInBrowser(item.url)}
        onAdd={(mode) => (linking = mode)}
        onRemove={(mode, item) => (unlinking = { mode, item })}
      />

      <!-- The issue body, rendered as the author wrote it. -->
      <div class="mt-2 border border-border bg-surface/60">
        <div class="flex items-center gap-1.5 px-2.5 pt-2.5">
          <PrAvatar login={subject.authorLogin} avatarUrl={subject.authorAvatarUrl} />
          <span class="text-[0.625rem] font-medium text-foreground"
            >{githubDisplayLogin(subject.authorLogin)}</span
          >
          {#if subject.authorIsBot}
            <BotBadge />
          {/if}
          <span class="text-[0.5625rem] text-dimmed"
            >opened {formatCompactAge(subject.createdAt)}</span
          >
          <span class="flex-1"></span>
          {#if issueNodeId}
            <PrReactionPicker
              nodeId={issueNodeId}
              groups={issueReactions}
              onToggle={(content, add) => reactTo(issueNodeId, content, add)}
            />
          {/if}
        </div>
        <div class="px-2.5 py-2">
          {#if detail?.body}
            <MarkdownView text={detail.body} allowHtml {repository} />
          {:else}
            <p class="text-[0.625rem] italic text-dimmed">This issue has no description.</p>
          {/if}
        </div>
        {#if issueNodeId && issueReactions.length > 0}
          <PrReactionChips
            nodeId={issueNodeId}
            groups={issueReactions}
            onToggle={(content, add) => reactTo(issueNodeId, content, add)}
          />
        {/if}
      </div>

      <!-- The conversation. -->
      <div class="mt-3 flex items-center gap-1.5">
        <CioMessage size={11} class="text-dimmed" />
        <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed">
          {comments.length === 1 ? '1 comment' : `${comments.length} comments`}
        </span>
      </div>

      <!--
        The stream: every comment and every change to the issue, in the order they
        happened, hung on one rail so the history reads as one story rather than as a
        list. Keeping them together is the point   a close with no assignment or
        label in sight is a history a reader cannot follow.
      -->
      {#snippet flowRow(item: IssueFlowItem, first: boolean, last: boolean)}
        {#if item.kind === 'comment'}
          {@const comment = item.comment}
          {@const commentReactions = reactions[comment.nodeId ?? ''] ?? []}
          <!--
            A comment's mark on the rail is its author, where an event's is a glyph:
            who wrote this is the first thing a reader looks for.
          -->
          <TimelineRailItem {first} {last}>
            {#snippet gutter()}
              <PrAvatar login={comment.authorLogin} avatarUrl={comment.authorAvatarUrl} />
            {/snippet}
            <div class="border border-border bg-surface/60">
              <div class="flex items-center gap-1.5 px-2.5 pt-2.5">
                <span class="text-[0.625rem] font-medium text-foreground"
                  >{githubDisplayLogin(comment.authorLogin)}</span
                >
                {#if comment.authorIsBot}
                  <BotBadge />
                {/if}
                <span class="text-[0.5625rem] text-dimmed"
                  >{formatCompactAge(comment.createdAt)}</span
                >
                {#if comment.updatedAt}
                  <span class="text-[0.5625rem] text-dimmed">· edited</span>
                {/if}
                <span class="flex-1"></span>
                {#if comment.nodeId}
                  <PrReactionPicker
                    nodeId={comment.nodeId}
                    groups={commentReactions}
                    onToggle={(content, add) => reactTo(comment.nodeId, content, add)}
                  />
                {/if}
                {#if isOwnComment(comment)}
                  {#if editingId === comment.id}
                    <button
                      type="button"
                      class="flex h-5 cursor-pointer items-center px-1.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
                      onclick={() => {
                        editingId = null
                        editingBody = ''
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="flex h-5 cursor-pointer items-center bg-primary px-1.5 text-[0.5625rem] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                      disabled={busyCommentId || editingBody.trim().length === 0}
                      onclick={() => void saveEdit()}
                    >
                      Save
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="flex h-5 cursor-pointer items-center px-1.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
                      title="Edit your comment"
                      onclick={() => {
                        editingId = comment.id
                        editingBody = comment.body
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      class="flex h-5 cursor-pointer items-center px-1.5 text-[0.5625rem] font-medium text-danger transition-colors hover:bg-danger/10"
                      title="Delete your comment"
                      onclick={() => (confirmingDelete = comment)}
                    >
                      Delete
                    </button>
                  {/if}
                {/if}
              </div>
              {#if editingId === comment.id}
                <div class="px-2.5 py-2">
                  <textarea
                    class="min-h-24 w-full resize-y border border-border bg-elevated px-2.5 py-2 text-xs text-foreground outline-none focus:border-primary"
                    aria-label="Edit comment"
                    bind:value={editingBody}></textarea>
                </div>
              {:else}
                <div class="px-2.5 py-2">
                  <MarkdownView text={comment.body} allowHtml {repository} />
                </div>
              {/if}
              {#if comment.nodeId && commentReactions.length > 0}
                <PrReactionChips
                  nodeId={comment.nodeId}
                  groups={commentReactions}
                  onToggle={(content, add) => reactTo(comment.nodeId, content, add)}
                />
              {/if}
            </div>
          </TimelineRailItem>
        {:else}
          <TimelineEventRow
            event={item.event}
            line={item.line}
            repository={repositoryName}
            {first}
            {last}
            {onOpenCommit}
          />
        {/if}
      {/snippet}

      {#each plan.head as item, index (item.key)}
        {@render flowRow(
          item,
          index === 0,
          plan.hidden.length === 0 && index === plan.head.length - 1
        )}
      {/each}
      {#if plan.hidden.length > 0 && openedMiddleFor !== issue.number}
        <TimelineCollapsedRows
          hidden={plan.hidden.length}
          onExpand={() => (openedMiddleFor = issue.number)}
        />
      {/if}
      {#if openedMiddleFor === issue.number}
        {#each plan.hidden as item (item.key)}
          {@render flowRow(item, false, false)}
        {/each}
      {/if}
      {#each plan.tail as item, index (item.key)}
        {@render flowRow(item, false, index === plan.tail.length - 1)}
      {/each}
    {/if}
  </div>

  <!--
    The composer is a footer rather than the last row of the scroll: it is the one
    control a reader reaches for from anywhere in a long conversation, and burying
    it under the comments would mean scrolling to the bottom before every reply.
    This is the same shape the pull request reader uses for its own composer.
  -->
  {#if !loading}
    <div class="shrink-0 border-t border-border bg-surface/60 p-2">
      <textarea
        class="min-h-20 w-full resize-y border border-border bg-elevated px-2.5 py-2 text-xs text-foreground outline-none placeholder:text-dimmed focus:border-primary"
        placeholder="Leave a comment…"
        aria-label="Comment on this issue"
        bind:value={draft}
        onkeydown={onComposerKeydown}></textarea>
      <div class="mt-1.5 flex items-center justify-end gap-2">
        <span class="text-[0.5625rem] text-dimmed"
          >{keymapState.labelFor('ui-modal-primary-action')} to post</span
        >
        <button
          type="button"
          class="flex h-7 cursor-pointer items-center gap-1.5 bg-primary px-3 text-[0.6875rem] font-semibold text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          disabled={posting || draft.trim().length === 0}
          onclick={() => void submitComment()}
        >
          {#if posting}
            <CioSpinner size={12} class="animate-spin" />
          {/if}
          <CioSend size={12} />
          Comment
        </button>
      </div>
    </div>
  {/if}
</div>

<ConfirmDialog
  open={confirmingDelete !== null}
  title="Delete this comment?"
  confirmLabel="Delete comment"
  variant="danger"
  busy={busyCommentId}
  onCancel={() => (confirmingDelete = null)}
  onConfirm={() => void confirmDelete()}
>
  <p class="text-xs leading-relaxed text-muted">
    This removes the comment from GitHub permanently. It cannot be undone.
  </p>
  {#if confirmingDelete && (confirmingDelete.body ?? '').trim().length > 0}
    <p class="mt-2 flex items-start gap-1.5 text-[0.6875rem] leading-relaxed text-dimmed">
      <CioAttention size={12} class="mt-0.5 shrink-0 text-warning" />
      <span class="line-clamp-4">{confirmingDelete.body.trim()}</span>
    </p>
  {/if}
</ConfirmDialog>

<!--
  Unlinking is confirmed, like every other action that detaches work: it changes what
  the issue is part of, and GitHub does not offer an undo.
-->
<ConfirmDialog
  open={unlinking !== null}
  title="Unlink #{unlinking?.item.number ?? ''}?"
  confirmLabel="Unlink"
  busy={unlinkBusy}
  onCancel={() => (unlinking = null)}
  onConfirm={() => void unlink()}
>
  <p class="text-xs leading-relaxed text-muted">
    <strong class="text-foreground">{unlinking?.item.title ?? ''}</strong> stops being
    {unlinking?.mode === 'parent'
      ? 'the parent of this issue'
      : unlinking?.mode === 'sub-issue'
        ? 'a sub-issue of this one'
        : unlinking?.mode === 'blocked-by'
          ? 'a blocker of this one'
          : 'blocked by this one'}.
  </p>
  <p class="mt-2 text-[0.6875rem] leading-relaxed text-dimmed">
    Both issues stay exactly as they are. Only the link between them is removed.
  </p>
</ConfirmDialog>

{#if linking && issueNodeId}
  <IssueRelationshipPicker
    {projectId}
    owner={identity.owner}
    repo={identity.repo}
    issueNumber={issue.number}
    {issueNodeId}
    mode={linking}
    excluded={relatedNumbers}
    onClose={() => (linking = null)}
  />
{/if}
