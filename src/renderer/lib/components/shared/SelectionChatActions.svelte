<script lang="ts">
  import CioTemporaryChat from '@pdslng/cio-icon/CioTemporaryChat.svelte'

  /**
   * The Explain and Quick Chat pair an annotation offers.
   *
   * Every surface that lets a user comment on something (a studio passage, an
   * element picked in an online artifact, a mark on a published picture, a moment
   * in the video editor, an element picked in the design inspector) has to let the
   * user ask about that thing before committing to a comment. The two actions are
   * the same everywhere, so they are one component and each caller only names what
   * is being asked about: the titles have to say it, because the same words sit in
   * six different footers.
   */
  interface Props {
    /**
     * What the actions are about, in the caller's words: "selection", "artifact
     * element", "mark", "moment", "design element", "passage". It completes both
     * titles, so no two surfaces share one accessible name.
     */
    subject: string
    onExplain: () => void
    onQuickChat: () => void
  }

  let { subject, onExplain, onQuickChat }: Props = $props()
</script>

<div
  class="flex flex-wrap items-center gap-1"
  aria-label="Read-only chat about the selected {subject}"
>
  <button
    type="button"
    class="flex h-8 items-center gap-1.5 px-2 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
    title="Explain the selected {subject} in a temporary read-only chat"
    onclick={onExplain}
  >
    <CioTemporaryChat size={13} aria-hidden="true" />
    Explain
  </button>
  <button
    type="button"
    class="flex h-8 items-center gap-1.5 px-2 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
    title="Start a temporary read-only chat with the selected {subject}"
    onclick={onQuickChat}
  >
    <CioTemporaryChat size={13} aria-hidden="true" />
    Quick Chat
  </button>
</div>
