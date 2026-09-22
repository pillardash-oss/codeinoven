<script lang="ts">
  /**
   * The pull request conversation, as GitHub organises it.
   *
   * Each unit of the stream is one thing that happened: the description, a
   * comment, or a submitted review together with the inline threads that review
   * wrote. Top-level units are peers, so they simply follow each other with room
   * between them; the tree belongs to a unit that has children, which is a review
   * over the threads it wrote and a thread over the replies to it.
   *
   * Replying is deliberately two different acts, because GitHub treats them
   * differently: an inline thread takes a real reply through the review-comment
   * reply endpoint, while a conversation comment can only be answered by a new
   * comment that quotes it. The reply box says which one it is doing.
   */
  import { MessageSquareReply, MessagesSquare } from '@lucide/svelte'
  import type { Attachment } from 'svelte/attachments'
  import { gitState } from '$lib/stores/git.svelte'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import { flashElement } from '$lib/reveal-flash'
  import type { PullRequestFile } from '$shared/types'
  import PrCommentCard from './PrCommentCard.svelte'
  import PrReplyBox from './PrReplyBox.svelte'
  import PrReviewThread from './PrReviewThread.svelte'
  import GitPullRequestDetailCommentDialogs from './GitPullRequestDetailCommentDialogs.svelte'
  import {
    conversationKindLabel,
    conversationQuoteBlock,
    filePatchFor,
    reviewBadgeClass,
    type ConversationEntry,
    type ConversationNode,
    type ReviewThread
  } from './git-pull-request-detail-format'

  interface Props {
    nodes: ConversationNode[]
    /** Changed files, so a thread can read the patch its line lives in. */
    files: PullRequestFile[]
    projectId: string
    identity: { owner: string; repo: string }
    number: number
    /** Login that authored the pull request, for the description's edit permission. */
    authorLogin: string
    /** Insert a quote of this entry into the reader's composer. */
    onQuote: (entry: ConversationEntry) => void
    /** Open a read-only side chat anchored on this entry: explain it, or attach
     *  it to an empty quick chat the reader writes into. */
    onCommentChat: (entry: ConversationEntry, mode: 'explain' | 'quick') => void
    /** Hand one entry to an agent as an assignment. */
    onAssignAgent: (entry: ConversationEntry) => void
    /** Surface a one-line confirmation in the reader's header. */
    onNotice: (message: string) => void
    /** Reload the bundle after a mutation. */
    onRefresh: () => Promise<void>
    /**
     * An entry to bring into view, with a token that changes per request.
     *
     * The token is what makes a second request for the same comment a new
     * request: the identity of this object, not the URL inside it, is what the
     * reveal effect watches.
     */
    reveal?: { url: string; token: number } | null
    /**
     * Called once a reveal has been applied, so the surface that asked for it can
     * drop the request. Without this, leaving the conversation and coming back
     * would jump to that same comment again.
     */
    onRevealDone?: () => void
  }

  let {
    nodes,
    files,
    projectId,
    identity,
    number,
    authorLogin,
    onQuote,
    onCommentChat,
    onAssignAgent,
    onNotice,
    onRefresh,
    reveal = null,
    onRevealDone
  }: Props = $props()

  /** The row a Delete confirmation is open for, or null. */
  let deletingEntry = $state<ConversationEntry | null>(null)
  /**
   * The conversation entry whose reply box is open, or null. One entry is enough
   * to identify it: a unit's reply box belongs to the comment it answers.
   */
  let replyEntry = $state<ConversationEntry | null>(null)

  /**
   * Take the reader to the entry a report asked to see, and say which one it was.
   *
   * An attachment, so this is the stream element's own concern: it runs when the
   * stream mounts, and again on every request, because reading `reveal` is what
   * makes it reactive. Each entry carries its provider permalink as
   * `data-entry-url`, which is the one identity a comment keeps across a rebuild
   * of the stream. The scroll alone answers "somewhere here"; the flash answers
   * "this one", which is what a reader needs after landing among comments that
   * all look alike.
   */
  const revealEntry: Attachment<HTMLDivElement> = (element) => {
    const request = reveal
    if (!request) return
    const target = [...element.querySelectorAll<HTMLElement>('[data-entry-url]')].find(
      (candidate) => candidate.dataset.entryUrl === request.url
    )
    if (!target) return
    target.scrollIntoView({ block: 'start' })
    flashElement(target)
    onRevealDone?.()
  }

  const busy = $derived(gitState.isBusy('pr-comment-reply') || gitState.isBusy('pr-comment'))

  /**
   * Post a reply to a conversation comment.
   *
   * GitHub has no threading for these, so the answer is a new conversation
   * comment that quotes the one it answers, which is how the two stay readable
   * together on github.com as well.
   */
  async function submitReply(body: string): Promise<boolean> {
    const target = replyEntry
    if (!target) return false
    const posted = await gitState.commentOnPullRequest(
      projectId,
      identity.owner,
      identity.repo,
      number,
      `${conversationQuoteBlock(target)}${body}`
    )
    if (!posted) return false
    replyEntry = null
    onNotice('Reply posted')
    await onRefresh()
    return true
  }

  /** The pill that names what a conversation unit is. */
  function nodeBadge(node: ConversationNode): { label: string; class: string } | null {
    if (node.kind === 'threads') return null
    return {
      label: conversationKindLabel(node.entry.kind, node.entry.meta),
      class: reviewBadgeClass(node.entry.meta)
    }
  }
</script>

{#snippet replyFooter(entry: ConversationEntry)}
  <div class="border-t border-border/60 p-1.5">
    {#if replyEntry?.key === entry.key}
      <PrReplyBox
        recipient={githubDisplayLogin(entry.author)}
        hint="Posts a new comment quoting @{githubDisplayLogin(entry.author)}"
        {busy}
        onSubmit={submitReply}
        onCancel={() => (replyEntry = null)}
      />
    {:else}
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-[0.6875rem] text-muted hover:bg-elevated hover:text-foreground"
        title="Reply to @{githubDisplayLogin(entry.author)}"
        onclick={() => (replyEntry = entry)}
      >
        <MessageSquareReply size={12} class="shrink-0 text-dimmed" />
        Reply
      </button>
    {/if}
  </div>
{/snippet}

{#snippet reviewThreads(threads: ReviewThread[])}
  <div class="flex min-w-0 flex-col gap-3">
    {#each threads as thread (thread.key)}
      <PrReviewThread
        {thread}
        patch={filePatchFor(files, thread.path)}
        {projectId}
        {identity}
        {number}
        {authorLogin}
        {onQuote}
        {onCommentChat}
        {onAssignAgent}
        onDelete={(entry) => (deletingEntry = entry)}
        {onNotice}
        {onRefresh}
      />
    {/each}
  </div>
{/snippet}

{#if nodes.length === 0}
  <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
    <MessagesSquare size={18} class="text-dimmed" />
    <p class="text-[0.6875rem] leading-relaxed text-dimmed">Nothing has been said yet.</p>
  </div>
{:else}
  <!--
    Peers with room between them, not a rail: the order is the reading order, and
    a unit that owns children draws their tree itself.
  -->
  <div {@attach revealEntry} class="flex flex-col gap-3 p-2.5">
    {#each nodes as node (node.key)}
      {#if node.kind === 'description' || node.kind === 'comment'}
        <PrCommentCard
          entry={node.entry}
          badge={nodeBadge(node)}
          {projectId}
          {identity}
          {number}
          {authorLogin}
          {onQuote}
          {onCommentChat}
          {onAssignAgent}
          onReply={(entry) => (replyEntry = entry)}
          onDelete={(entry) => (deletingEntry = entry)}
          {onNotice}
          {onRefresh}
          footer={replyFooter}
        />
      {:else if node.kind === 'review'}
        <!--
          A review and the threads it wrote are one unit: the summary says what the
          reviewer concluded, and the threads are the evidence for that conclusion,
          so they step in under it rather than reading as separate comments.
        -->
        <div class="flex min-w-0 flex-col gap-2">
          <PrCommentCard
            entry={node.entry}
            badge={nodeBadge(node)}
            {projectId}
            {identity}
            {number}
            {authorLogin}
            {onQuote}
            {onCommentChat}
            {onAssignAgent}
            onReply={(entry) => (replyEntry = entry)}
            onDelete={(entry) => (deletingEntry = entry)}
            {onNotice}
            {onRefresh}
            footer={replyFooter}
          />
          {#if node.threads.length > 0}
            <div class="ml-3 border-l-2 border-border/60 pl-3">
              {@render reviewThreads(node.threads)}
            </div>
          {/if}
        </div>
      {:else}
        {@render reviewThreads(node.threads)}
      {/if}
    {/each}
  </div>
{/if}

<GitPullRequestDetailCommentDialogs
  {projectId}
  {identity}
  {number}
  entry={deletingEntry}
  onClose={() => (deletingEntry = null)}
  {onNotice}
  {onRefresh}
/>
