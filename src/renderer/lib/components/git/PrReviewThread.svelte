<script lang="ts">
  /**
   * One inline review thread: the file it is about, the diff GitHub showed when
   * it was written, the comments in the thread, and the box that answers them.
   *
   * This is the unit GitHub threads replies into, and the only place a reply can
   * be a real reply rather than a quote: GitHub files the answer under the
   * comment it addresses, so the reply box here posts into the thread instead of
   * the pull request's conversation.
   *
   * It draws no frame of its own. A review frames its summary together with the
   * threads that review wrote, and threads whose review the provider did not
   * return are framed by the stream, so the frame belongs to whoever owns the
   * unit.
   */
  import { ChevronDown, ExternalLink, MessageSquareReply } from '@lucide/svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
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
  const root = $derived(thread.comments[0])
  const replies = $derived(thread.comments.length - 1)
  const outdated = $derived(thread.line === null)

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

  function openOnGitHub(): void {
    if (root?.url) void openInBrowser(root.url)
  }
</script>

<div class="border-t border-border/60 first:border-t-0">
  <div class="flex items-center gap-1.5 bg-elevated/40 px-2.5 py-1.5">
    <button
      type="button"
      class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
      aria-expanded={!collapsed}
      title={collapsed ? 'Show this thread' : 'Fold this thread'}
      onclick={() => (collapsed = !collapsed)}
    >
      <ChevronDown size={11} class={['shrink-0 text-dimmed', collapsed && '-rotate-90']} />
      <FileTypeIcon path={thread.path} size={12} class="shrink-0" />
      <span class="min-w-0 truncate font-mono text-[0.625rem] text-foreground">{thread.path}</span>
      {#if thread.line !== null}
        <span class="shrink-0 font-mono text-[0.5625rem] text-dimmed">:{thread.line}</span>
      {/if}
      {#if outdated}
        <!-- The line the thread was written about is gone from the diff, which is
             the only reason GitHub keeps a thread around as outdated. -->
        <span
          class="shrink-0 rounded bg-warning/10 px-1.5 py-px text-[0.5625rem] font-medium text-warning"
          title="The line this thread was written about is no longer in the diff">outdated</span
        >
      {/if}
      <span class="shrink-0 text-[0.5625rem] text-dimmed">
        {thread.comments.length}
        {thread.comments.length === 1 ? 'comment' : 'comments'}
        {#if replies > 0}· {replies} {replies === 1 ? 'reply' : 'replies'}{/if}
      </span>
    </button>
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
    <PrDiffHunk hunk={threadDiffHunk(thread)} anchor={thread.line} side={thread.side} />

    <div class="divide-y divide-border/50">
      {#each thread.comments as comment, index (comment.key)}
        <!--
          A reply belongs to the comment above it, so it steps in under a guide
          line instead of reading as another comment in the thread. One step only:
          a thread is a conversation about one line of code, and nesting it by
          reply depth would walk the text off the panel. The row itself names the
          comment it answers, so the indent never has to carry whose reply it is.
        -->
        <div class={index === 0 ? '' : 'border-l border-border/60 pl-2.5'}>
          <PrCommentCard
            entry={comment}
            framed={false}
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

    <div class="border-t border-border/50 p-1.5">
      {#if replyTo}
        <PrReplyBox
          recipient={githubDisplayLogin(replyTo.author)}
          hint="Posts this reply into the thread"
          {busy}
          onSubmit={submitReply}
          onCancel={() => (replyTo = null)}
        />
      {:else}
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-[0.6875rem] text-muted hover:bg-elevated hover:text-foreground"
          title="Reply to this thread"
          onclick={() => openReply()}
        >
          <MessageSquareReply size={12} class="shrink-0 text-dimmed" />
          Reply to this thread
        </button>
      {/if}
    </div>
  {/if}
</div>
