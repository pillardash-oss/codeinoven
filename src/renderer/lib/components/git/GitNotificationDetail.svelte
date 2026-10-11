<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    BellOff,
    Bookmark,
    BookmarkCheck,
    ChevronLeft,
    ExternalLink,
    Loader2,
    MessageSquare,
    TriangleAlert
  } from '@lucide/svelte'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import type { GithubRepoContext } from '$lib/github-references'
  import PrAvatar from './PrAvatar.svelte'
  import {
    reasonLabel,
    subjectIcon,
    subjectKindLabel,
    subjectStateLabel,
    subjectStateToneClass
  } from './notification-view'
  import type { GitHubNotification, GitHubNotificationSubject } from '$shared/types'

  interface Props {
    /** The notification being read. Its facts stand even when the thread cannot. */
    item: GitHubNotification
    /** The thread it points at, once GitHub has answered with one. */
    subject: GitHubNotificationSubject | null
    loading: boolean
    error: string | null
    /** Whether a per-thread action is in flight for this notification. */
    busy: boolean
    onBack: () => void
    onToggleDone: () => void
    onToggleSaved: () => void
    onUnsubscribe: () => void
    onOpenInBrowser: () => void
  }

  let {
    item,
    subject,
    loading,
    error,
    busy,
    onBack,
    onToggleDone,
    onToggleSaved,
    onUnsubscribe,
    onOpenInBrowser
  }: Props = $props()

  const SubjectIcon = $derived(subjectIcon(item.subjectType))

  /**
   * The repository the thread was authored in, so GitHub's own reference
   * linkification works in its markdown even when that repository is not the one
   * the Git panel is standing in.
   */
  const repository = $derived.by((): GithubRepoContext | null => {
    const [owner, repo] = item.repositoryFullName.split('/')
    return owner && repo ? { owner, repo } : null
  })

  const body = $derived(subject?.body?.trim() ?? '')
  const comments = $derived(subject?.comments ?? [])

  const actionClass =
    'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40'
</script>

<div class="flex h-full min-h-0 flex-col bg-app" data-region="git-notification-detail">
  <!--
    Header: back to the list, then which thread this is, then the actions the
    notification itself offers. The thread's own content is fetched separately, so
    this line stands as soon as the row is opened.
  -->
  <div class="flex shrink-0 flex-col gap-1 border-b border-border px-2.5 py-2">
    <div class="flex items-center gap-1.5">
      <button
        type="button"
        class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Back to notifications"
        aria-label="Back to notifications"
        onclick={onBack}
      >
        <ChevronLeft size={13} />
      </button>
      <span
        class="flex size-5 shrink-0 items-center justify-center rounded {item.unread
          ? 'text-primary'
          : 'text-dimmed'}"
        role="img"
        title={item.unread ? 'Unread notification' : 'Read notification'}
        aria-label={item.unread ? 'Unread notification' : 'Read notification'}
      >
        <SubjectIcon size={13} />
      </span>
      <span class="shrink-0 text-[0.625rem] font-medium text-muted">
        {subjectKindLabel(item.subjectType)}
      </span>
      <span class="min-w-0 flex-1"></span>
      <button
        type="button"
        class={actionClass}
        title={item.done ? 'Restore to inbox' : 'Mark as done'}
        aria-label={item.done ? 'Restore notification to inbox' : 'Mark notification as done'}
        disabled={busy}
        onclick={onToggleDone}
      >
        {#if item.done}
          <ArchiveRestore size={13} aria-hidden="true" />
        {:else}
          <Archive size={13} aria-hidden="true" />
        {/if}
      </button>
      <button
        type="button"
        class={actionClass}
        title="Unsubscribe from this thread"
        aria-label="Unsubscribe from this notification thread"
        disabled={busy}
        onclick={onUnsubscribe}
      >
        <BellOff size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        class={actionClass}
        title={item.saved ? 'Remove from saved' : 'Save notification'}
        aria-label={item.saved ? 'Remove notification from saved' : 'Save notification'}
        disabled={busy}
        onclick={onToggleSaved}
      >
        {#if item.saved}
          <BookmarkCheck size={13} class="text-primary" aria-hidden="true" />
        {:else}
          <Bookmark size={13} aria-hidden="true" />
        {/if}
      </button>
      <button
        type="button"
        class={actionClass}
        title="Open on GitHub"
        aria-label="Open notification on GitHub"
        data-external-url={item.url ?? ''}
        onclick={onOpenInBrowser}
      >
        <ExternalLink size={13} aria-hidden="true" />
      </button>
    </div>
    <p class="text-[0.75rem] font-semibold leading-snug text-foreground">{item.title}</p>
    <div class="flex flex-wrap items-center gap-1 text-[0.5625rem] text-dimmed">
      <span class="truncate">{item.repositoryFullName}</span>
      <span aria-hidden="true">·</span>
      <span class="shrink-0">{reasonLabel(item.reason)}</span>
      <span aria-hidden="true">·</span>
      <span class="shrink-0" title={item.updatedAt}>{relativeTime(item.updatedAt)}</span>
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
    {#if loading}
      <div class="flex items-center justify-center gap-2 py-6 text-[0.625rem] text-muted">
        <Loader2 size={14} class="animate-spin" aria-hidden="true" />
        Loading thread
      </div>
    {:else if error}
      <div class="flex items-start gap-1.5 rounded-lg border border-border bg-elevated/40 p-2.5">
        <TriangleAlert size={12} class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <p class="text-[0.625rem] leading-relaxed text-dimmed">{error}</p>
      </div>
    {:else if subject && subject.readable}
      <!-- The subject itself: who wrote it, its state, and its description. -->
      <div class="rounded-lg border border-border">
        <div class="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
          {#if subject.state}
            <span
              class="flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[0.5625rem] font-semibold {subjectStateToneClass(
                subject.state
              )}"
            >
              {subjectStateLabel(subject.state)}
            </span>
          {/if}
          {#if subject.authorLogin}
            <PrAvatar login={subject.authorLogin} avatarUrl={subject.authorAvatarUrl} />
            <span class="text-[0.625rem] font-medium text-foreground">{subject.authorLogin}</span>
          {/if}
          {#if subject.createdAt}
            <span class="text-[0.5625rem] text-dimmed" title={subject.createdAt}>
              {relativeTime(subject.createdAt)}
            </span>
          {/if}
          <span class="min-w-0 flex-1"></span>
          {#if subject.comments.length > 0}
            <span class="flex shrink-0 items-center gap-1 text-[0.5625rem] text-dimmed">
              <MessageSquare size={10} aria-hidden="true" />
              {subject.comments.length}
            </span>
          {/if}
        </div>
        {#if subject.labels.length > 0}
          <div class="flex flex-wrap gap-1 border-b border-border px-2.5 py-1.5">
            {#each subject.labels as label (label)}
              <span class="rounded-full bg-elevated px-1.5 py-0.5 text-[0.5625rem] text-muted">
                {label}
              </span>
            {/each}
          </div>
        {/if}
        <div class="px-2.5 py-2">
          {#if body}
            <MarkdownView text={subject.body ?? ''} allowHtml {repository} />
          {:else}
            <p class="text-[0.625rem] text-dimmed">No description was given.</p>
          {/if}
        </div>
      </div>

      {#if comments.length > 0}
        <p
          class="px-0.5 pt-2 pb-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
        >
          {comments.length}
          {comments.length === 1 ? 'comment' : 'comments'}
        </p>
        <!--
          The conversation, oldest first, which is the order GitHub answers with
          and the order a thread is read in.
        -->
        <div class="flex flex-col gap-1.5">
          {#each comments as comment (comment.id)}
            <div class="rounded-lg border border-border">
              <div class="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
                {#if comment.authorLogin}
                  <PrAvatar login={comment.authorLogin} avatarUrl={comment.authorAvatarUrl} />
                  <span class="text-[0.625rem] font-medium text-foreground"
                    >{comment.authorLogin}</span
                  >
                {/if}
                <span class="text-[0.5625rem] text-dimmed" title={comment.createdAt}>
                  {relativeTime(comment.createdAt)}
                </span>
              </div>
              <div class="px-2.5 py-2">
                <MarkdownView text={comment.body} allowHtml {repository} />
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <!--
        A kind GitHub serves no REST thread for, in practice a discussion, which
        exists only through GraphQL. The notification's own facts are already
        above, and the thread itself is one click away rather than absent.
      -->
      <div
        class="flex flex-col items-center gap-2 rounded-lg border border-border px-4 py-6 text-center"
      >
        <SubjectIcon size={18} class="text-dimmed" aria-hidden="true" />
        <p class="max-w-[38ch] text-[0.625rem] leading-relaxed text-muted">
          GitHub serves this kind of thread ({subjectKindLabel(item.subjectType)}) only on
          github.com, so its full content opens there.
        </p>
      </div>
    {/if}
  </div>
</div>
