<script lang="ts">
  import { Check, Loader2, MessagesSquare, MoreHorizontal } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { relativeTime } from '$lib/format/relative-time'
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
  import PrCommentActionsMenu from './PrCommentActionsMenu.svelte'
  import GitPullRequestDetailCommentDialogs from './GitPullRequestDetailCommentDialogs.svelte'
  import {
    canDeleteConversationEntry,
    canEditConversationEntry,
    canHideConversationEntry,
    conversationAccentClass,
    conversationKindClass,
    conversationKindLabel,
    type ConversationEntry
  } from './git-pull-request-detail-format'
  import type { PrMinimizeReason } from '$shared/types'

  interface Props {
    entries: ConversationEntry[]
    projectId: string
    identity: { owner: string; repo: string }
    number: number
    /** Login that authored the pull request, for the description's edit permission. */
    authorLogin: string
    /** Insert a quote of this entry into the reader's composer. */
    onQuote: (entry: ConversationEntry) => void
    /** Surface a one-line confirmation in the reader's header. */
    onNotice: (message: string) => void
    /** Reload the bundle after a mutation. */
    onRefresh: () => Promise<void>
  }

  let { entries, projectId, identity, number, authorLogin, onQuote, onNotice, onRefresh }: Props =
    $props()

  /** The conversation row whose body is being rewritten in place, if any. */
  let editingKey = $state<string | null>(null)
  let editBody = $state('')
  /** The row a Delete confirmation is open for, or null. */
  let deletingEntry = $state<ConversationEntry | null>(null)

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

  function openEntryOnGitHub(entry: ConversationEntry): void {
    if (entry.url) void openInBrowser(entry.url)
  }

  async function copyEntryLink(entry: ConversationEntry): Promise<void> {
    if (!entry.url) return
    await copyText(entry.url)
    onNotice('Comment link copied')
  }

  async function copyEntryMarkdown(entry: ConversationEntry): Promise<void> {
    await copyText(entry.body.trim())
    onNotice('Comment Markdown copied')
  }

  /**
   * GitHub's "Reference in new issue" carries the comment into a new issue. There
   * is no issue composer in this app, so the reference is copied as markdown and
   * the repository's new-issue page opens with the same text prefilled: the same
   * result, with the writing still happening where issues are written.
   */
  async function referenceInNewIssue(entry: ConversationEntry): Promise<void> {
    const reference = `${entry.body.trim()}\n\n_Originally posted by @${entry.author} in ${entry.url}_`
    await copyText(reference)
    await openInBrowser(githubNewIssueUrl(identity.owner, identity.repo, reference))
    onNotice('Reference copied, new issue opened on GitHub')
  }

  function startEdit(entry: ConversationEntry): void {
    editingKey = entry.key
    editBody = entry.body
    onNotice('')
  }

  function cancelEdit(): void {
    editingKey = null
    editBody = ''
  }

  async function saveEdit(entry: ConversationEntry): Promise<void> {
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

  async function hideEntry(entry: ConversationEntry, reason: PrMinimizeReason): Promise<void> {
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
  async function reportEntry(entry: ConversationEntry): Promise<void> {
    if (entry.url) await copyText(entry.url)
    await openInBrowser(githubAbuseReportUrl())
    onNotice(
      entry.url
        ? 'Comment link copied, GitHub abuse report form opened'
        : 'Opened the GitHub abuse report form'
    )
  }

  async function blockAuthor(entry: ConversationEntry): Promise<void> {
    await openInBrowser(githubBlockUserUrl(entry.author))
    onNotice(`Opened GitHub's blocked-accounts settings for @${entry.author}`)
  }
</script>

{#if entries.length === 0}
  <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
    <MessagesSquare size={18} class="text-dimmed" />
    <p class="text-[0.6875rem] leading-relaxed text-dimmed">Nothing has been said yet.</p>
  </div>
{:else}
  <div class="flex flex-col gap-2 p-2">
    {#each entries as entry (entry.key)}
      <article
        class="overflow-hidden rounded-lg border border-border bg-surface {conversationAccentClass(
          entry.kind,
          entry.meta
        )}"
      >
        <header
          class="flex items-start gap-1.5 border-b border-border/60 bg-elevated/50 px-2.5 py-1.5"
        >
          <PrAvatar login={entry.author} avatarUrl={entry.avatarUrl} size="md" />
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="truncate text-[0.6875rem] font-medium text-foreground"
                >{entry.author}</span
              >
              {#if entry.isBot}
                <!-- GitHub's own badge for an app account. It is what tells a
                     reader that the next paragraph was written by a bot and not
                     by a colleague, which the login alone (`name[bot]`) only
                     hints at. -->
                <span
                  class="shrink-0 rounded-full border border-border px-1.5 text-[0.5625rem] font-medium text-muted"
                  title="This account is an App, not a person"
                >
                  Bot
                </span>
              {/if}
              <span
                class="shrink-0 rounded px-1.5 py-px text-[0.5625rem] font-medium {conversationKindClass(
                  entry.kind,
                  entry.meta
                )}"
              >
                {conversationKindLabel(entry.kind, entry.meta)}
              </span>
            </div>
            <p class="flex items-center gap-1 text-[0.5625rem] text-dimmed">
              <button
                type="button"
                class="cursor-pointer hover:text-foreground hover:underline"
                title="Open this comment on GitHub"
                aria-label="Open {entry.author}'s comment on GitHub"
                onclick={() => openEntryOnGitHub(entry)}
              >
                {relativeTime(entry.at)}
              </button>
              {#if entry.updatedAt && entry.updatedAt !== entry.at}
                <!-- GitHub marks an edited comment here rather than only
                     changing the timestamp, so a reader can tell that what they
                     are looking at is not what was first posted. -->
                <span title="Edited {relativeTime(entry.updatedAt)}">· edited</span>
              {/if}
            </p>
          </div>
          {#if editingKey !== entry.key}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dimmed hover:bg-overlay hover:text-foreground data-[state=open]:bg-overlay data-[state=open]:text-foreground"
                aria-label="Actions for {entry.author}'s comment"
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
                    canEdit={canEditConversationEntry(
                      entry,
                      gitState.githubViewerLogin,
                      authorLogin
                    )}
                    canDelete={canDeleteConversationEntry(entry, gitState.githubViewerLogin)}
                    canHide={canHideConversationEntry(entry)}
                    busy={commentActionBusy}
                    onCopyLink={() => void copyEntryLink(entry)}
                    onCopyMarkdown={() => void copyEntryMarkdown(entry)}
                    onQuote={() => onQuote(entry)}
                    onReferenceInNewIssue={() => void referenceInNewIssue(entry)}
                    onEdit={() => startEdit(entry)}
                    onDelete={() => (deletingEntry = entry)}
                    onHide={(reason) => void hideEntry(entry, reason)}
                    onReport={() => void reportEntry(entry)}
                    onBlock={() => void blockAuthor(entry)}
                  />
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          {/if}
        </header>
        {#if entry.kind === 'inline' && entry.meta}
          <p
            class="truncate border-b border-border/40 bg-elevated/20 px-2.5 py-1 font-mono text-[0.5625rem] text-dimmed"
          >
            {entry.meta}
          </p>
        {/if}
        {#if editingKey === entry.key}
          <!-- Edit swaps the rendered body for the same composer the panel
               posts with, so an edit looks and behaves like writing rather than
               like a second, plainer textarea. -->
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
                onclick={() => void saveEdit(entry)}
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
        {:else if entry.body.trim()}
          <div class="px-2.5 py-2">
            <!-- GitHub's dialect includes HTML, so PR prose needs it to read
                 correctly; the sanitizer still strips anything executable.
                 Agent-authored text elsewhere keeps it off, and `repository` is
                 what turns #150 and @login into links the way github.com does. -->
            <MarkdownView
              text={entry.body}
              class="text-[0.6875rem] leading-relaxed"
              allowHtml
              {repository}
            />
          </div>
        {/if}
      </article>
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
