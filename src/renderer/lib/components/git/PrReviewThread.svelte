<script lang="ts">
  /**
   * One inline review thread: the file it is about, the code the comment was
   * written against, the comments in the thread, and the box that answers them.
   *
   * This is the unit GitHub threads replies into, and the only place a reply can
   * be a real reply rather than a quote: GitHub files the answer under the
   * comment it addresses, so the reply box here posts into the thread instead of
   * the pull request's conversation.
   *
   * It draws no frame of its own. The stream indents a review's threads under the
   * review that wrote them, so the frame belongs to whoever owns the unit; what
   * this component owns is the tree inside it, where a reply steps in under the
   * comment it answers.
   */
  import {
    CheckCircle2,
    ChevronDown,
    ExternalLink,
    Loader2,
    MessageSquareReply,
    RotateCcw
  } from '@lucide/svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { openProjectFileFromAbsolutePath } from '$lib/reveal-file'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import PrCommentCard from './PrCommentCard.svelte'
  import PrDiffHunk from './PrDiffHunk.svelte'
  import PrReplyBox from './PrReplyBox.svelte'
  import {
    threadDiffHunk,
    type ConversationEntry,
    type ReviewThread
  } from './git-pull-request-detail-format'

  interface Props {
    thread: ReviewThread
    /** The file's own patch, which carries the lines after the commented one. */
    patch: string | null
    projectId: string
    identity: { owner: string; repo: string }
    number: number
    /** Login that authored the pull request, for the description's edit permission. */
    authorLogin: string
    onQuote: (entry: ConversationEntry) => void
    /** Open a read-only side chat anchored on one of the thread's comments. */
    onCommentChat?: (entry: ConversationEntry, mode: 'explain' | 'quick') => void
    /** Open the Delete confirmation for one comment in the thread. */
    onDelete: (entry: ConversationEntry) => void
    onNotice: (message: string) => void
    onRefresh: () => Promise<void>
  }

  let {
    thread,
    patch,
    projectId,
    identity,
    number,
    authorLogin,
    onQuote,
    onCommentChat,
    onDelete,
    onNotice,
    onRefresh
  }: Props = $props()

  /** Folded threads keep the stream scannable without losing the file they are about. */
  let collapsed = $state(false)
  /** The comment a reply answers, or null while the box is closed. */
  let replyTo = $state<ConversationEntry | null>(null)

  const busy = $derived(gitState.isBusy('pr-comment-reply'))
  const resolving = $derived(gitState.isBusy('pr-thread-resolve'))
  const root = $derived(thread.comments[0])
  const replies = $derived(thread.comments.length - 1)
  const outdated = $derived(thread.line === null)
  /** Where the thread's file and line read, for the button and its accessible name. */
  const location = $derived(thread.line === null ? thread.path : `${thread.path}:${thread.line}`)

  /**
   * The reply's target: the comment the reader chose, or the thread's opening
   * comment. GitHub files a reply under the comment it answers, but it only
   * accepts the id of the comment that opened a thread: replying to a reply is
   * still addressed to the thread's root, which is what keeps the answer in the
   * same thread instead of being refused.
   */
  function openReply(entry?: ConversationEntry): void {
    replyTo = entry ?? root ?? null
  }

  async function submitReply(body: string): Promise<boolean> {
    const targetId = root?.commentId
    if (targetId === null || targetId === undefined) return false
    const posted = await gitState.replyToPrReviewComment(
      projectId,
      identity.owner,
      identity.repo,
      number,
      targetId,
      body
    )
    if (!posted) return false
    replyTo = null
    onNotice('Reply posted')
    await onRefresh()
    return true
  }

  /**
   * Settle or reopen the thread.
   *
   * Resolution is the state the merge is gated on, and GitHub keeps it on the
   * thread rather than on any comment, so this addresses the thread's node id.
   */
  async function toggleResolved(): Promise<void> {
    const nodeId = thread.threadNodeId
    if (!nodeId || resolving) return
    const next = !thread.resolved
    const saved = await gitState.setPrReviewThreadResolved(
      projectId,
      identity.owner,
      identity.repo,
      number,
      nodeId,
      next
    )
    if (!saved) return
    onNotice(next ? 'Thread resolved' : 'Thread reopened')
    await onRefresh()
  }

  /**
   * Open the file this thread is about at the line it is about, in the app's own
   * editor. The code under a thread stops where GitHub's diff stops; the file is
   * where the rest of it is.
   */
  async function openFileAtLine(): Promise<void> {
    const opened = await openProjectFileFromAbsolutePath(
      projectId,
      thread.path,
      thread.line ?? undefined
    )
    if (!opened) onNotice(`${thread.path} is not in this working tree`)
  }

  function openOnGitHub(): void {
    if (root?.url) void openInBrowser(root.url)
  }
</script>

<section class="flex min-w-0 flex-col gap-1.5">
  <div class="flex items-center gap-1">
    <button
      type="button"
      class="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-dimmed hover:bg-overlay hover:text-foreground"
      aria-expanded={!collapsed}
      aria-label={collapsed ? 'Show this thread' : 'Fold this thread'}
      title={collapsed ? 'Show this thread' : 'Fold this thread'}
      onclick={() => (collapsed = !collapsed)}
    >
      <ChevronDown size={11} class={['shrink-0', collapsed && '-rotate-90']} />
    </button>
    <!--
      The file is the way back to the code the thread is about: the diff here
      stops on the commented line, and the file does not. It opens in this
      project's own editor, on that line.
    -->
    <button
      type="button"
      class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-elevated/60"
      title="Open {location} in this project"
      onclick={() => void openFileAtLine()}
    >
      <FileTypeIcon path={thread.path} size={12} class="shrink-0" />
      <span class="min-w-0 truncate font-mono text-[0.625rem] text-foreground">{thread.path}</span>
      {#if thread.line !== null}
        <span class="shrink-0 font-mono text-[0.5625rem] text-dimmed">:{thread.line}</span>
      {/if}
    </button>
    {#if outdated}
      <!-- The line the thread was written about is gone from the diff, which is
           the only reason GitHub keeps a thread around as outdated. -->
      <span
        class="shrink-0 rounded bg-warning/10 px-1.5 py-px text-[0.5625rem] font-medium text-warning"
        title="The line this thread was written about is no longer in the diff">outdated</span
      >
    {/if}
    {#if thread.resolved}
      <span
        class="flex shrink-0 items-center gap-1 rounded bg-success/10 px-1.5 py-px text-[0.5625rem] font-medium text-success"
        title="This thread is resolved"
      >
        <CheckCircle2 size={10} class="shrink-0" />
        Resolved
      </span>
    {/if}
    <span class="shrink-0 text-[0.5625rem] text-dimmed">
      {thread.comments.length}
      {thread.comments.length === 1 ? 'comment' : 'comments'}
      {#if replies > 0}· {replies} {replies === 1 ? 'reply' : 'replies'}{/if}
    </span>
    <button
      type="button"
      class="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-dimmed hover:bg-overlay hover:text-foreground"
      title="Open this thread on GitHub"
      aria-label="Open the thread on {thread.path} on GitHub"
      onclick={openOnGitHub}
    >
      <ExternalLink size={11} />
    </button>
  </div>

  {#if !collapsed}
    <!--
      The code the comment was written about. The file's patch is preferred
      because GitHub's comment hunk stops on the commented line, so on its own it
      can never show what comes after; the hunk is the fallback for a file the
      patch could not place.
    -->
    <PrDiffHunk
      {patch}
      hunk={threadDiffHunk(thread)}
      anchor={thread.line}
      side={thread.side}
      class="overflow-hidden rounded-lg border border-border/60 bg-elevated/20 py-1"
    />

    <div class="flex flex-col gap-2">
      {#each thread.comments as comment, index (comment.key)}
        <!--
          A reply belongs to the comment above it, so it steps in behind a guide
          line with room of its own instead of reading as another comment in the
          thread. One step only: a thread is a conversation about one line of code,
          and nesting it by reply depth would walk the text off the panel.
        -->
        <div class={index === 0 ? '' : 'ml-3 border-l-2 border-border/60 pl-3'}>
          <PrCommentCard
            entry={comment}
            {projectId}
            {identity}
            {number}
            {authorLogin}
            {onQuote}
            {onCommentChat}
            onReply={openReply}
            {onDelete}
            {onNotice}
            {onRefresh}
          />
        </div>
      {/each}
    </div>
  {/if}

  <!--
    Resolve stays reachable while the thread is folded: it is the state the merge
    is gated on, so it must not need the thread opened to be settled.
  -->
  <div class="flex items-center gap-1.5 pt-0.5">
    {#if !collapsed}
      {#if replyTo}
        <div class="min-w-0 flex-1">
          <PrReplyBox
            recipient={githubDisplayLogin(replyTo.author)}
            hint="Posts this reply into the thread"
            {busy}
            onSubmit={submitReply}
            onCancel={() => (replyTo = null)}
          />
        </div>
      {:else}
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[0.6875rem] text-muted hover:bg-elevated hover:text-foreground"
          title="Reply to this thread"
          onclick={() => openReply()}
        >
          <MessageSquareReply size={12} class="shrink-0 text-dimmed" />
          Reply
        </button>
      {/if}
    {/if}
    {#if thread.threadNodeId}
      <button
        type="button"
        class="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[0.6875rem] disabled:opacity-40 {thread.resolved
          ? 'border-border text-muted hover:bg-elevated hover:text-foreground'
          : 'border-success/40 bg-success/10 text-success hover:bg-success/20'}"
        title={thread.resolved ? 'Reopen this thread' : 'Resolve this thread'}
        disabled={resolving}
        onclick={() => void toggleResolved()}
      >
        {#if resolving}
          <Loader2 size={12} class="shrink-0 animate-spin" />
          Saving…
        {:else if thread.resolved}
          <RotateCcw size={12} class="shrink-0" />
          Reopen
        {:else}
          <CheckCircle2 size={12} class="shrink-0" />
          Resolve
        {/if}
      </button>
    {/if}
  </div>
</section>
