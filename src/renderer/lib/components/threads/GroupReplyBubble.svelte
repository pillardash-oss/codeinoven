<script lang="ts">
  import type { Snippet } from 'svelte'
  import GroupSpeakerMark from './GroupSpeakerMark.svelte'
  import { openThreadById } from '$lib/threads/open-thread-by-id'

  /**
   * One reply in a group conversation: the speaker's mark and name, and then
   * whatever the speaker is saying, which may be a working trace, a streamed
   * answer, or both.
   *
   * It exists because a group thread is a conversation between several places,
   * and a reply has to open with who is speaking before it shows any work. The
   * speaker line is also the way back to that place: clicking it opens the thread
   * the reply came from, so a bubble is a door and not just a card.
   */
  interface Props {
    name: string
    icon?: string | null
    color?: string
    /** Draw the speaker's mark the way its tile does, for a speaker that owns a plate (Don). */
    plate?: boolean
    /**
     * The thread this reply belongs to. When it is named, the speaker line opens
     * it; a reply to the conversation's own thread has nowhere to go, so it
     * passes none and stays a plain label.
     */
    projectId?: string
    threadId?: string
    /** The thread's own title, shown beside the speaker when it is not the thread
     *  the reader is already in. */
    threadTitle?: string
    children: Snippet
  }

  let {
    name,
    icon = null,
    color,
    plate = false,
    projectId,
    threadId,
    threadTitle,
    children
  }: Props = $props()

  const opensThread = $derived(Boolean(projectId && threadId))
  const openTitle = $derived(
    threadTitle ? `Open ${threadTitle}` : `Open the conversation ${name} is working in`
  )

  function open(event: MouseEvent): void {
    if (!opensThread || !projectId || !threadId) return
    event.preventDefault()
    void openThreadById(projectId, threadId)
  }
</script>

<div
  class="message-block min-w-0 max-w-[90%] border border-border bg-surface px-3.5 py-2.5 text-[0.8125rem] text-foreground"
>
  <div class="mb-1.5 flex min-w-0 items-center gap-1.5">
    {#if opensThread}
      <button
        type="button"
        class="group/speaker flex min-w-0 items-center gap-1.5 border-l-2 pl-1.5 text-left text-[0.6875rem] transition-colors hover:text-foreground"
        style="border-color: {color ?? 'var(--color-border)'}"
        title={openTitle}
        aria-label={openTitle}
        onclick={open}
      >
        <GroupSpeakerMark {icon} {color} {plate} />
        <span class="truncate font-medium text-foreground">{name}</span>
        {#if threadTitle}
          <span class="shrink-0 truncate text-dimmed">· {threadTitle}</span>
        {/if}
      </button>
    {:else}
      <div
        class="flex min-w-0 items-center gap-1.5 border-l-2 pl-1.5 text-[0.6875rem]"
        style="border-color: {color ?? 'var(--color-border)'}"
      >
        <GroupSpeakerMark {icon} {color} {plate} />
        <span class="truncate font-medium text-foreground">{name}</span>
        {#if threadTitle}
          <span class="shrink-0 truncate text-dimmed">· {threadTitle}</span>
        {/if}
      </div>
    {/if}
  </div>
  {@render children()}
</div>
