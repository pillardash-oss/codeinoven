<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioReplyMark from '$lib/components/icons/cio/CioReplyMark.svelte'
  import type { DirectReplyTarget } from '$shared/types'

  /**
   * The conversation the composer is answering, shown where attachments sit.
   *
   * A bubble in a group chat is a door into the thread that spoke it, and this is
   * what says the door is open: the next message leaves the conversation on
   * screen and is delivered to this one, so the chip names the speaker and the
   * conversation rather than showing a bare label. It closes like an attachment,
   * and its own row is where a failed delivery says why.
   */
  interface Props {
    target: DirectReplyTarget
    /** True while the message is being delivered. */
    busy: boolean
    /** Why the last delivery failed, when it did. */
    error: string
    onClear: () => void
    /** Opens the conversation being answered. */
    onOpen: () => void
  }

  let { target, busy, error, onClear, onOpen }: Props = $props()
</script>

<div class="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Reply target">
  <div
    class="flex max-w-full items-center border border-accent/30 bg-accent/10 text-[0.6875rem] font-medium text-foreground"
  >
    <button
      type="button"
      class="flex min-w-0 items-center gap-1.5 px-2 py-1 text-left"
      title={`Replying in ${target.title}. Open that conversation`}
      aria-label={`Replying in ${target.title}. Open that conversation`}
      onclick={onOpen}
    >
      {#if busy}
        <CioSpinner size={11} class="shrink-0 animate-spin text-accent" />
      {:else}
        <CioReplyMark size={11} class="shrink-0 text-accent" />
      {/if}
      <span class="shrink-0 text-dimmed">Replying to</span>
      <span class="shrink-0 truncate">{target.speakerName}</span>
      <span class="shrink-0 text-dimmed">·</span>
      <span class="min-w-0 truncate text-dimmed">{target.title}</span>
    </button>
    <button
      type="button"
      class="flex h-full items-center pr-1.5 pl-0.5 text-dimmed transition-colors hover:text-danger"
      title="Stop replying to that conversation"
      aria-label="Stop replying to that conversation"
      onclick={onClear}
    >
      <CioClose size={11} />
    </button>
  </div>
  {#if error}
    <span class="min-w-0 truncate text-[0.6875rem] text-danger">{error}</span>
  {/if}
</div>
