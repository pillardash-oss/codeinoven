<script lang="ts">
  import {
    ChevronLeft,
    ExternalLink,
    GitPullRequest,
    Hammer,
    Loader2,
    MessageSquare,
    Milestone,
    RotateCcw,
    Send,
    Tag,
    TriangleAlert,
    UserPlus,
    X
  } from '@lucide/svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import { openInBrowser } from '$lib/open-in-browser'
  import { GitState, gitState } from '$lib/stores/git.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import PrAvatar from './PrAvatar.svelte'
  import BotBadge from './BotBadge.svelte'
  import {
    issueReferenceLabel,
    issueStateIcon,
    issueStateReasonLabel,
    issueStateToneClass,
    issueTimelineLine,
    type IssueTimelineLine
  } from './issue-view'
  import { prLabelStyle, type PrMetadataMode } from './pr-view'
  import PrReactionPicker from './PrReactionPicker.svelte'
  import PrReactionChips from './PrReactionChips.svelte'
  import IssueRelationships from './IssueRelationships.svelte'
  import type { GithubRepoContext } from '$lib/github-references'
  import type {
    IssueComment,
    IssueRelationshipItem,
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
    onBack: () => void
    onWorkOn: (issue: IssueSummary) => void
    onCreatePr: (issue: IssueSummary) => void
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
    onOpenInBrowser
  }: Props = $props()

  const repository: GithubRepoContext = $derived({
    owner: identity.owner,
    repo: identity.repo
  })

  const bundleKey = $derived(GitState.issueBundleKey(identity.owner, identity.repo, issue.number))
  const bundle = $derived(gitState.issueBundles[bundleKey] ?? null)
  const detail = $derived(bundle?.detail ?? null)
  /**
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
  const timeline = $derived(gitState.issueTimelines[bundleKey]?.value ?? [])

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
    void gitState.ensureIssueTimeline(projectId, owner, repo, number, false)
    void gitState.ensureIssueRelationships(projectId, owner, repo, number, false)
  })

  let draft = $state('')
  let editingId = $state<number | null>(null)
  let editingBody = $state('')
  let confirmingDelete = $state<IssueComment | null>(null)

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
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void submitComment()
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <!-- Header: back, state, number, title, and the work actions this issue offers. -->
  <div class="flex shrink-0 flex-col gap-1.5 border-b border-border px-2.5 py-2">
    <div class="flex items-center gap-1.5">
      <button
        type="button"
        class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Back to issues"
        aria-label="Back to issues"
        onclick={onBack}
      >
        <ChevronLeft size={13} />
      </button>
      <span
        class="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.5625rem] font-semibold {issueStateToneClass(
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
        class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Open this issue on GitHub"
        aria-label="Open this issue on GitHub"
        onclick={() => onOpenInBrowser(subject)}
      >
        <ExternalLink size={12} />
      </button>
    </div>
    <p class="text-[0.75rem] font-semibold leading-snug text-foreground">{subject.title}</p>
    <div class="flex flex-wrap items-center gap-1">
      <button
        type="button"
        class="flex h-6 cursor-pointer items-center gap-1 rounded-md bg-primary/10 px-2 text-[0.625rem] font-medium text-primary transition-colors hover:bg-primary/20"
        title="Open a new agent thread seeded with this issue"
        onclick={() => onWorkOn(subject)}
      >
        <Hammer size={11} />
        Work on this issue
      </button>
      <button
        type="button"
        class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Open a pull request prefilled to close this issue"
        onclick={() => onCreatePr(subject)}
      >
        <GitPullRequest size={11} />
        Create pull request
      </button>
      {#if subject.state === 'open'}
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.625rem] font-medium text-danger transition-colors hover:bg-danger/10"
          title="Close this issue"
          onclick={() => onRequestClose(subject)}
        >
          <X size={11} />
          Close
        </button>
      {:else}
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Reopen this issue"
          onclick={() => onReopen(subject)}
        >
          <RotateCcw size={11} />
          Reopen
        </button>
      {/if}
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
    {#if loading}
      <div class="flex items-center justify-center gap-2 py-10 text-[0.6875rem] text-dimmed">
        <Loader2 size={13} class="animate-spin" />
        Loading issue…
      </div>
    {:else}
      <!-- Metadata: what the issue carries, each chip a control that opens its picker. -->
      <div class="flex flex-wrap items-center gap-1">
        {#each subject.labels ?? [] as label (label.name)}
          <button
            type="button"
            class="max-w-[14ch] cursor-pointer truncate rounded-full px-1.5 py-0.5 text-[0.5625rem] font-medium leading-none transition-opacity hover:opacity-80"
            style={prLabelStyle(label.color)}
            title="Edit labels"
            onclick={() => onEditMetadata('labels', subject)}
          >
            {label.name}
          </button>
        {/each}
        <button
          type="button"
          class="flex h-5 cursor-pointer items-center gap-1 rounded-full border border-border px-1.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Edit labels"
          onclick={() => onEditMetadata('labels', subject)}
        >
          <Tag size={9} />
          Labels
        </button>
        <button
          type="button"
          class="flex h-5 cursor-pointer items-center gap-1 rounded-full border border-border px-1.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Edit assignees"
          onclick={() => onEditMetadata('assignees', subject)}
        >
          <UserPlus size={9} />
          {#if subject.assignees && subject.assignees.length > 0}
            {subject.assignees.map((entry) => githubDisplayLogin(entry.login)).join(', ')}
          {:else}
            Assign
          {/if}
        </button>
        <button
          type="button"
          class="flex h-5 cursor-pointer items-center gap-1 rounded-full border border-border px-1.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Set milestone"
          onclick={() => onEditMetadata('milestone', subject)}
        >
          <Milestone size={9} />
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
        onOpenIssue={onOpenRelated}
        onOpenRemote={(item) => void openInBrowser(item.url)}
      />

      <!-- The issue body, rendered as the author wrote it. -->
      <div class="mt-2 rounded-lg border border-border bg-surface/60">
        <div class="flex items-center gap-1.5 px-2.5 pt-2.5">
          <PrAvatar login={subject.authorLogin} avatarUrl={subject.authorAvatarUrl} />
          <span class="text-[0.625rem] font-medium text-foreground"
            >{githubDisplayLogin(subject.authorLogin)}</span
          >
          {#if subject.authorIsBot}
            <BotBadge />
          {/if}
          <span class="text-[0.5625rem] text-dimmed">opened {relativeTime(subject.createdAt)}</span>
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
        <MessageSquare size={11} class="text-dimmed" />
        <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed">
          {comments.length === 1 ? '1 comment' : `${comments.length} comments`}
        </span>
      </div>

      <!--
        The stream: every comment and every change to the issue, in the order they
        happened. Keeping them together is the point   a close with no assignment or
        label in sight is a history a reader cannot follow.
      -->
      {#each flow as item (item.key)}
        {#if item.kind === 'comment'}
          {@const comment = item.comment}
          {@const commentReactions = reactions[comment.nodeId ?? ''] ?? []}
          <div class="mt-2 rounded-lg border border-border bg-surface/60">
            <div class="flex items-center gap-1.5 px-2.5 pt-2.5">
              <PrAvatar login={comment.authorLogin} avatarUrl={comment.authorAvatarUrl} />
              <span class="text-[0.625rem] font-medium text-foreground"
                >{githubDisplayLogin(comment.authorLogin)}</span
              >
              {#if comment.authorIsBot}
                <BotBadge />
              {/if}
              <span class="text-[0.5625rem] text-dimmed">{relativeTime(comment.createdAt)}</span>
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
                    class="flex h-5 cursor-pointer items-center rounded-md px-1.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
                    onclick={() => {
                      editingId = null
                      editingBody = ''
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="flex h-5 cursor-pointer items-center rounded-md bg-primary px-1.5 text-[0.5625rem] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                    disabled={busyCommentId || editingBody.trim().length === 0}
                    onclick={() => void saveEdit()}
                  >
                    Save
                  </button>
                {:else}
                  <button
                    type="button"
                    class="flex h-5 cursor-pointer items-center rounded-md px-1.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
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
                    class="flex h-5 cursor-pointer items-center rounded-md px-1.5 text-[0.5625rem] font-medium text-danger transition-colors hover:bg-danger/10"
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
                  class="min-h-24 w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 text-xs text-foreground outline-none focus:border-primary"
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
        {:else}
          <!--
            One change to the issue. Drawn lighter than a comment because it has no
            body to read: the avatar says who, the sentence says what.
          -->
          <div class="mt-2 flex items-start gap-1.5 px-0.5">
            <PrAvatar login={item.event.actorLogin} avatarUrl={item.event.actorAvatarUrl} />
            <p class="min-w-0 flex-1 text-[0.625rem] leading-relaxed text-muted">
              <span class="font-medium text-foreground"
                >{githubDisplayLogin(item.event.actorLogin)}</span
              >
              {#if item.event.actorIsBot}
                <BotBadge />
              {/if}
              <span> {item.line.lead}</span>
              {#if item.line.label}
                <span
                  class="mx-1 inline-block max-w-[14ch] truncate rounded-full px-1.5 py-0.5 align-middle text-[0.5625rem] font-medium leading-none"
                  style={prLabelStyle(item.line.label.color)}
                >
                  {item.line.label.name}
                </span>
              {/if}
              {#if item.line.reference}
                {@const reference = item.line.reference}
                <button
                  type="button"
                  class="mx-1 cursor-pointer text-[0.625rem] font-medium text-primary hover:underline"
                  title={`Open ${issueReferenceLabel(reference, repositoryName)} on GitHub`}
                  onclick={() => void openInBrowser(reference.url)}
                >
                  {issueReferenceLabel(reference, repositoryName)}
                </button>
              {/if}
              {#if item.line.trail}
                <span> {item.line.trail}</span>
              {/if}
              <span class="text-dimmed"> · {relativeTime(item.at)}</span>
            </p>
          </div>
        {/if}
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
        class="min-h-20 w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 text-xs text-foreground outline-none placeholder:text-dimmed focus:border-primary"
        placeholder="Leave a comment…"
        aria-label="Comment on this issue"
        bind:value={draft}
        onkeydown={onComposerKeydown}></textarea>
      <div class="mt-1.5 flex items-center justify-end gap-2">
        <span class="text-[0.5625rem] text-dimmed">⌘/Ctrl+Enter to post</span>
        <button
          type="button"
          class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-semibold text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          disabled={posting || draft.trim().length === 0}
          onclick={() => void submitComment()}
        >
          {#if posting}
            <Loader2 size={12} class="animate-spin" />
          {/if}
          <Send size={12} />
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
      <TriangleAlert size={12} class="mt-0.5 shrink-0 text-warning" />
      <span class="line-clamp-4">{confirmingDelete.body.trim()}</span>
    </p>
  {/if}
</ConfirmDialog>
