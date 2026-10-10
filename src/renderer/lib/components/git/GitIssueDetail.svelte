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
  import { GitState, gitState } from '$lib/stores/git.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import PrAvatar from './PrAvatar.svelte'
  import BotBadge from './BotBadge.svelte'
  import { issueStateIcon, issueStateReasonLabel, issueStateToneClass } from './issue-view'
  import { prLabelStyle, type PrMetadataMode } from './pr-view'
  import type { GithubRepoContext } from '$lib/github-references'
  import type { IssueComment, IssueSummary } from '$shared/types'

  interface Props {
    projectId: string
    identity: { owner: string; repo: string }
    issue: IssueSummary
    onBack: () => void
    onWorkOn: (issue: IssueSummary) => void
    onCreatePr: (issue: IssueSummary) => void
    onEditMetadata: (mode: PrMetadataMode, issue: IssueSummary) => void
    onStateChange: (issue: IssueSummary, state: 'open' | 'closed') => void
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
    onStateChange,
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
  const loading = $derived(gitState.isBusy('issue-detail') && bundle === null)
  const posting = $derived(gitState.isBusy('issue-comment'))
  const busyCommentId = $derived(
    gitState.isBusy('issue-comment-edit') || gitState.isBusy('issue-comment-delete')
  )

  const StateIcon = $derived(issueStateIcon(subject))
  const reasonLabel = $derived(issueStateReasonLabel(subject.stateReason))

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
          onclick={() => onStateChange(subject, 'closed')}
        >
          <X size={11} />
          Close
        </button>
      {:else}
        <button
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Reopen this issue"
          onclick={() => onStateChange(subject, 'open')}
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

      <!-- The issue body, rendered as the author wrote it. -->
      <div class="mt-2 rounded-lg border border-border bg-surface/60 p-2.5">
        <div class="mb-1.5 flex items-center gap-1.5">
          <PrAvatar login={subject.authorLogin} avatarUrl={subject.authorAvatarUrl} />
          <span class="text-[0.625rem] font-medium text-foreground"
            >{githubDisplayLogin(subject.authorLogin)}</span
          >
          {#if subject.authorIsBot}
            <BotBadge />
          {/if}
          <span class="text-[0.5625rem] text-dimmed">opened {relativeTime(subject.createdAt)}</span>
        </div>
        {#if detail?.body}
          <MarkdownView text={detail.body} allowHtml {repository} />
        {:else}
          <p class="text-[0.625rem] italic text-dimmed">This issue has no description.</p>
        {/if}
      </div>

      <!-- The conversation. -->
      <div class="mt-3 flex items-center gap-1.5">
        <MessageSquare size={11} class="text-dimmed" />
        <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed">
          {comments.length === 1 ? '1 comment' : `${comments.length} comments`}
        </span>
      </div>

      {#each comments as comment (comment.id)}
        <div class="mt-2 rounded-lg border border-border bg-surface/60 p-2.5">
          <div class="mb-1.5 flex items-center gap-1.5">
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
            <textarea
              class="min-h-24 w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 text-xs text-foreground outline-none focus:border-primary"
              aria-label="Edit comment"
              bind:value={editingBody}></textarea>
          {:else}
            <MarkdownView text={comment.body} allowHtml {repository} />
          {/if}
        </div>
      {/each}

      <!-- The composer: the one place a comment is written. -->
      <div class="mt-3 rounded-lg border border-border bg-surface/60 p-2">
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
