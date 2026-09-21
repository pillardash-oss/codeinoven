<script lang="ts">
  /**
   * The pull request conversation, as GitHub organises it.
   *
   * Each unit of the stream is one thing that happened: the description, a
   * comment, or a submitted review together with the inline threads that review
   * wrote. The rail on the left is what makes the order readable, and a unit's
   * dot carries its kind so the stream scans without reading every badge.
   *
   * Replying is deliberately two different acts, because GitHub treats them
   * differently: an inline thread takes a real reply through the review-comment
   * reply endpoint, while a conversation comment can only be answered by a new
   * comment that quotes it. The reply box says which one it is doing.
   */
  import { MessageSquareReply, MessagesSquare } from '@lucide/svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import PrCommentCard from './PrCommentCard.svelte'
  import PrReplyBox from './PrReplyBox.svelte'
  import PrReviewThread from './PrReviewThread.svelte'
  import GitPullRequestDetailCommentDialogs from './GitPullRequestDetailCommentDialogs.svelte'
  import {
    conversationKindLabel,
    conversationNodeDotClass,
    conversationQuoteBlock,
    reviewBadgeClass,
    type ConversationEntry,
    type ConversationNode,
    type ReviewThread
  } from './git-pull-request-detail-format'

  interface Props {
    nodes: ConversationNode[]
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
    /** Surface a one-line confirmation in the reader's header. */
    onNotice: (message: string) => void
    /** Reload the bundle after a mutation. */
    onRefresh: () => Promise<void>
  }

  let {
    nodes,
    projectId,
    identity,
    number,
    authorLogin,
    onQuote,
    onCommentChat,
    onNotice,
    onRefresh
  }: Props = $props()

  /** The row a Delete confirmation is open for, or null. */
  let deletingEntry = $state<ConversationEntry | null>(null)
  /**
   * The conversation entry whose reply box is open, or null. One entry is enough
   * to identify it: a unit's reply box belongs to the comment it answers.
   */
  let replyEntry = $state<ConversationEntry | null>(null)

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
  {#each threads as thread (thread.key)}
    <PrReviewThread
      {thread}
      {projectId}
      {identity}
      {number}
      {authorLogin}
      {onQuote}
      {onCommentChat}
      onDelete={(entry) => (deletingEntry = entry)}
      {onNotice}
      {onRefresh}
    />
  {/each}
{/snippet}

{#if nodes.length === 0}
  <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
    <MessagesSquare size={18} class="text-dimmed" />
    <p class="text-[0.6875rem] leading-relaxed text-dimmed">Nothing has been said yet.</p>
  </div>
{:else}
  <div class="flex flex-col p-2">
    {#each nodes as node, index (node.key)}
      <!--
        The rail is decoration around the stream's order: the dot marks where a
        unit starts and the line joins it to the next one, so a long review and a
        one-line comment read as the same sequence.
      -->
      <div class="flex gap-1.5">
        <div class="relative w-3.5 shrink-0" aria-hidden="true">
          {#if index > 0}
            <span class="absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-border"></span>
          {/if}
          {#if index < nodes.length - 1}
            <span class="absolute bottom-0 left-1/2 top-3 w-px -translate-x-1/2 bg-border"></span>
          {/if}
          <span
            class="absolute left-1/2 top-3 size-2 -translate-x-1/2 rounded-full {conversationNodeDotClass(
              node
            )}"
          ></span>
        </div>
        <div class="min-w-0 flex-1 pb-2.5">
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
              onReply={(entry) => (replyEntry = entry)}
              onDelete={(entry) => (deletingEntry = entry)}
              {onNotice}
              {onRefresh}
              footer={replyFooter}
            />
          {:else if node.kind === 'review'}
            <!-- A review and the threads it wrote are one unit: the summary says
                 what the reviewer concluded, and the threads below it are the
                 evidence for that conclusion. -->
            <div class="overflow-hidden rounded-lg border border-border bg-surface">
              <PrCommentCard
                entry={node.entry}
                badge={nodeBadge(node)}
                framed={false}
                {projectId}
                {identity}
                {number}
                {authorLogin}
                {onQuote}
                {onCommentChat}
                onReply={(entry) => (replyEntry = entry)}
                onDelete={(entry) => (deletingEntry = entry)}
                {onNotice}
                {onRefresh}
                footer={replyFooter}
              />
              {@render reviewThreads(node.threads)}
            </div>
          {:else}
            <div class="overflow-hidden rounded-lg border border-border bg-surface">
              {@render reviewThreads(node.threads)}
            </div>
          {/if}
        </div>
      </div>
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
