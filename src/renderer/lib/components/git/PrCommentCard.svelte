<script lang="ts">
  /**
   * One comment in a pull request conversation: who wrote it, when, what it says,
   * and everything that can be done to it.
   *
   * Every conversation unit renders through this one component, which is what
   * keeps a thread's reply, a review's summary and the pull request's description
   * looking and behaving the same. The unit around it decides the frame: a review
   * frames its summary together with the threads that review wrote, so this row
   * draws no border of its own when it is embedded (`framed={false}`).
   */
  import type { Snippet } from 'svelte'
  import { Check, ChevronDown, Loader2, MoreHorizontal } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { relativeTime } from '$lib/format/relative-time'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import {
    githubAbuseReportUrl,
    githubBlockUserUrl,
    githubNewIssueUrl
  } from '$lib/github-references'
  import { copyText } from '$lib/copy-text'
  import { openInBrowser } from '$lib/open-in-browser'
  import { gitState } from '$lib/stores/git.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import PrAvatar from './PrAvatar.svelte'
  import BotBadge from './BotBadge.svelte'
  import IdentityBadge from './IdentityBadge.svelte'
  import PrCommentActionsMenu from './PrCommentActionsMenu.svelte'
  import {
    canDeleteConversationEntry,
    canEditConversationEntry,
    canHideConversationEntry,
    commentRoleBadges,
    type ConversationEntry
  } from './git-pull-request-detail-format'
  import type { PrMinimizeReason } from '$shared/types'

  interface Props {
    entry: ConversationEntry
    /** The pill beside the author's name, when this row carries one. */
    badge?: { label: string; class: string } | null
    projectId: string
    identity: { owner: string; repo: string }
    number: number
    /** Login that authored the pull request, for the description's edit permission. */
    authorLogin: string
    /** Draw this row's own card frame. False when the unit around it is framed. */
    framed?: boolean
    /** Rendered inside the frame, under the body: the reply affordance. */
    footer?: Snippet<[ConversationEntry]>
    /** Insert a quote of this entry into the reader's composer. */
    onQuote: (entry: ConversationEntry) => void
    /**
     * Open a read-only side chat anchored on this entry: explain it, or attach it
     * to an empty quick chat the reader writes into. Omitted where the surface
     * cannot host one.
     */
    onCommentChat?: (entry: ConversationEntry, mode: 'explain' | 'quick') => void
    /**
     * Hand this comment to an agent as an assignment. Omitted where the surface
     * cannot host a thread, which is also where the chat rows are omitted.
     */
    onAssignAgent?: (entry: ConversationEntry) => void
    /** Answer this exact comment, when the surface has somewhere to answer it. */
    onReply?: (entry: ConversationEntry) => void
    /** Open the Delete confirmation for this entry. */
    onDelete: (entry: ConversationEntry) => void
    /** Surface a one-line confirmation in the reader's header. */
    onNotice: (message: string) => void
    /** Reload the bundle after a mutation. */
    onRefresh: () => Promise<void>
  }

  let {
    entry,
    badge = null,
    projectId,
    identity,
    number,
    authorLogin,
    framed = true,
    footer,
    onQuote,
    onCommentChat,
    onAssignAgent,
    onReply,
    onDelete,
    onNotice,
    onRefresh
  }: Props = $props()

  /** True while this row's body is being rewritten in place. */
  let editing = $state(false)
  let editBody = $state('')
  /**
   * True while the reader has this row folded down to its header. Local to the
   * mount on purpose: a fold is how someone is reading right now, not a property
   * of the comment, so reopening the pull request shows every body again.
   */
  let folded = $state(false)

  const savingComment = $derived(gitState.isBusy('pr-comment-edit'))
  /** Any per-comment action in flight, so one row's menu cannot double-fire. */
  const commentActionBusy = $derived(
    savingComment ||
      gitState.isBusy('pr-comment-delete') ||
      gitState.isBusy('pr-comment-hide') ||
      gitState.isBusy('pr-update')
  )
  /**
   * The repository this conversation was authored in, for GitHub reference
   * linkification inside a comment body (`#150`, `@login`).
   */
  const repository = $derived({ owner: identity.owner, repo: identity.repo })
  const displayLogin = $derived(githubDisplayLogin(entry.author))
  /**
   * What this commenter is to the repository: the account that opened the pull
   * request, a member, a collaborator, a contributor. Every fact they hold, so
   * an author who is also a member wears both; empty for an account with no
   * relationship to name, and the row then wears no role at all.
   */
  const roleBadges = $derived(commentRoleBadges(entry, authorLogin))
  /**
   * The login this row answers, for a reply inside a thread. Null for a comment
   * that opened its own unit, which is every row outside a thread.
   */
  const repliesTo = $derived(entry.repliesTo ? githubDisplayLogin(entry.repliesTo) : null)

  function openEntryOnGitHub(): void {
    if (entry.url) void openInBrowser(entry.url)
  }

  async function copyEntryLink(): Promise<void> {
    if (!entry.url) return
    await copyText(entry.url)
    onNotice('Comment link copied')
  }

  async function copyEntryMarkdown(): Promise<void> {
    await copyText(entry.body.trim())
    onNotice('Comment Markdown copied')
  }

  /**
   * The markdown a reference carries: the comment, attributed and linked.
   *
   * Extracted because two callers need byte-identical text: the row that copies it
   * and opens the new-issue page, and the URL that same row declares for the
   * shared right-click menu, which has to be the page the row actually opens.
   */
  function commentReference(): string {
    return `${entry.body.trim()}\n\n_Originally posted by @${displayLogin} in ${entry.url}_`
  }

  /**
   * GitHub's "Reference in new issue" carries the comment into a new issue. There
   * is no issue composer in this app, so the reference is copied as markdown and
   * the repository's new-issue page opens with the same text prefilled: the same
   * result, with the writing still happening where issues are written.
   */
  async function referenceInNewIssue(): Promise<void> {
    const reference = commentReference()
    await copyText(reference)
    await openInBrowser(githubNewIssueUrl(identity.owner, identity.repo, reference))
    onNotice('Reference copied, new issue opened on GitHub')
  }

  function startEdit(): void {
    editing = true
    editBody = entry.body
    onNotice('')
  }

  function cancelEdit(): void {
    editing = false
    editBody = ''
  }

  async function saveEdit(): Promise<void> {
    const body = editBody.trim()
    if (!body || body === entry.body.trim()) {
      cancelEdit()
      return
    }
    const saved =
      entry.commentId === null
        ? (await gitState.updatePullRequest(
            projectId,
            identity.owner,
            identity.repo,
            number,
            undefined,
            body
          )) !== null
        : await gitState.editPrComment(
            projectId,
            identity.owner,
            identity.repo,
            number,
            entry.commentKind,
            entry.commentId,
            body
          )
    if (!saved) return
    cancelEdit()
    onNotice(entry.commentId === null ? 'Description saved' : 'Comment saved')
    await onRefresh()
  }

  async function hideEntry(reason: PrMinimizeReason): Promise<void> {
    if (!entry.nodeId) return
    const hidden = await gitState.minimizePrComment(
      projectId,
      identity.owner,
      identity.repo,
      number,
      entry.nodeId,
      reason
    )
    if (!hidden) return
    onNotice('Comment hidden')
    await onRefresh()
  }

  /**
   * The two abuse actions leave the app on purpose: the account's OAuth scope is
   * `repo`, and blocking an account needs `user`, so github.com is the only place
   * either can actually be carried out.
   *
   * The report form asks which content is being reported, so the comment's link is
   * copied first: the user pastes it there instead of hunting for it again.
   */
  async function reportEntry(): Promise<void> {
    if (entry.url) await copyText(entry.url)
    await openInBrowser(githubAbuseReportUrl())
    onNotice(
      entry.url
        ? 'Comment link copied, GitHub abuse report form opened'
        : 'Opened the GitHub abuse report form'
    )
  }

  async function blockAuthor(): Promise<void> {
    await openInBrowser(githubBlockUserUrl(entry.author))
    onNotice(`Opened GitHub's blocked-accounts settings for @${displayLogin}`)
  }
</script>

<article
  class={['overflow-hidden bg-surface', framed && 'rounded-lg border border-border']}
  data-entry-url={entry.url}
>
  <header
    class={[
      'flex items-start gap-1.5 px-2.5 py-1.5',
      framed ? 'border-b border-border/60 bg-elevated/50' : 'bg-elevated/40'
    ]}
  >
    <PrAvatar login={entry.author} avatarUrl={entry.avatarUrl} size="md" />
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-1.5">
        <!--
          The labels that can follow the name: what the commenter is to this
          repository (the account that opened the pull request, a member, a
          collaborator, a contributor, whichever of those hold at once), and
          whether the account is an App at all.
          The `[bot]` suffix GitHub keeps on a bot's login is left off the name,
          because the badge says the same thing without the noise.
        -->
        <span class="truncate text-[0.6875rem] font-medium text-foreground">{displayLogin}</span>
        {#each roleBadges as role (role.label)}
          <IdentityBadge label={role.label} title={role.title} />
        {/each}
        {#if entry.isBot}
          <BotBadge />
        {/if}
        {#if badge}
          <span class="shrink-0 rounded px-1.5 py-px text-[0.5625rem] font-medium {badge.class}">
            {badge.label}
          </span>
        {/if}
      </div>
      <p class="flex items-center gap-1 text-[0.5625rem] text-dimmed">
        <button
          type="button"
          class="cursor-pointer hover:text-foreground hover:underline"
          title="Open this comment on GitHub"
          aria-label="Open {displayLogin}'s comment on GitHub"
          data-external-url={entry.url}
          onclick={openEntryOnGitHub}
        >
          {relativeTime(entry.at)}
        </button>
        {#if entry.updatedAt && entry.updatedAt !== entry.at}
          <!-- GitHub marks an edited comment here rather than only changing the
               timestamp, so a reader can tell that what they are looking at is
               not what was first posted. -->
          <span title="Edited {relativeTime(entry.updatedAt)}">· edited</span>
        {/if}
        {#if repliesTo}
          <!-- A thread is linear, so the row says which comment it answers: the
               indent only shows that it is an answer, not whose. -->
          <span>· replying to @{repliesTo}</span>
        {/if}
      </p>
    </div>
    {#if !editing && entry.body.trim()}
      <button
        type="button"
        class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dimmed hover:bg-overlay hover:text-foreground"
        aria-expanded={!folded}
        aria-label={folded ? `Expand ${displayLogin}'s comment` : `Fold ${displayLogin}'s comment`}
        title={folded ? 'Show this comment' : 'Fold this comment'}
        onclick={() => (folded = !folded)}
      >
        <ChevronDown size={13} class={['transition-transform', folded && '-rotate-90']} />
      </button>
    {/if}
    {#if !editing}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dimmed hover:bg-overlay hover:text-foreground data-[state=open]:bg-overlay data-[state=open]:text-foreground"
          aria-label="Actions for {displayLogin}'s comment"
          title="Comment actions"
        >
          <MoreHorizontal size={13} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            class="z-50 min-w-52 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
            side="bottom"
            align="end"
            sideOffset={4}
            collisionPadding={8}
          >
            <PrCommentActionsMenu
              author={entry.author}
              viewerLogin={gitState.githubViewerLogin}
              canEdit={canEditConversationEntry(entry, gitState.githubViewerLogin, authorLogin)}
              canDelete={canDeleteConversationEntry(entry, gitState.githubViewerLogin)}
              canHide={canHideConversationEntry(entry)}
              busy={commentActionBusy}
              externalUrls={{
                reference: githubNewIssueUrl(identity.owner, identity.repo, commentReference()),
                report: githubAbuseReportUrl(),
                block: githubBlockUserUrl(entry.author)
              }}
              onCopyLink={() => void copyEntryLink()}
              onCopyMarkdown={() => void copyEntryMarkdown()}
              onQuote={() => onQuote(entry)}
              onReply={onReply ? () => onReply(entry) : undefined}
              onExplain={onCommentChat && entry.body.trim()
                ? () => onCommentChat(entry, 'explain')
                : undefined}
              onQuickChat={onCommentChat && entry.body.trim()
                ? () => onCommentChat(entry, 'quick')
                : undefined}
              onAssignAgent={onAssignAgent && entry.body.trim()
                ? () => onAssignAgent(entry)
                : undefined}
              onReferenceInNewIssue={() => void referenceInNewIssue()}
              onEdit={startEdit}
              onDelete={() => onDelete(entry)}
              onHide={(reason) => void hideEntry(reason)}
              onReport={() => void reportEntry()}
              onBlock={() => void blockAuthor()}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    {/if}
  </header>

  {#if editing}
    <!-- Edit swaps the rendered body for the same composer the panel posts with,
         so an edit looks and behaves like writing rather than like a second,
         plainer textarea. -->
    <div class="p-2">
      <RichMarkdownEditor
        class="max-h-72 overflow-y-auto rounded-lg border border-border bg-elevated px-2.5 py-2"
        bind:value={editBody}
        placeholder="Edit this comment…"
        ariaLabel="Edit comment"
        autofocus
      />
      <div class="mt-1.5 flex items-center justify-end gap-1.5">
        <button
          type="button"
          class="h-7 cursor-pointer rounded-lg border border-border px-2.5 text-[0.6875rem] text-foreground hover:bg-elevated"
          title="Discard this edit"
          onclick={cancelEdit}
        >
          Cancel
        </button>
        <button
          type="button"
          class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40"
          title="Save this comment"
          disabled={!editBody.trim() || savingComment}
          onclick={() => void saveEdit()}
        >
          {#if savingComment}
            <Loader2 size={12} class="animate-spin" />
            Saving…
          {:else}
            <Check size={12} />
            Save
          {/if}
        </button>
      </div>
    </div>
  {:else if !folded && entry.body.trim()}
    <div class="px-2.5 py-2">
      <!--
        GitHub's dialect includes HTML, so PR prose needs it to read correctly;
        the sanitizer still strips anything executable. Agent-authored text
        elsewhere keeps it off, and `repository` is what turns #150 and @login
        into links the way github.com does.

        No type step is set here: `.markdown-body` already carries the app's
        conversation reading size for prose, and it is the step a reader gets in
        every other prose surface, so a comment body must not fight it.
      -->
      <MarkdownView text={entry.body} allowHtml {repository} />
    </div>
  {/if}

  {#if footer && !editing && !folded}
    {@render footer(entry)}
  {/if}
</article>
