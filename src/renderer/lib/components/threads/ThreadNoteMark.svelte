<script lang="ts">
  import { feature } from '$lib/feature-registry'
  import { threadNotesState } from '$lib/stores/thread-notes.svelte'

  /**
   * The mark that says a thread carries a user note.
   *
   * It lives here rather than inline in one row because more than one row is
   * responsible for telling the truth about a thread: the sidebar's own thread
   * row and an assistant task row both list a thread, and a note that only one
   * of them admitted would make the other read as a thread with nothing on it.
   * The feature registry owns the glyph and the name, so the mark cannot drift
   * from the panel it opens.
   */
  interface Props {
    /** The thread whose note presence is reported. */
    threadId: string
    /** Glyph size in pixels, so a dense row can match its neighbours. */
    size?: number
  }

  let { threadId, size = 11 }: Props = $props()

  const hasNote = $derived(threadNotesState.has(threadId))
</script>

{#if hasNote}
  {@const ThreadNoteIcon = feature('thread-note').icon}
  <span
    class="flex shrink-0 items-center text-warning"
    title={`${feature('thread-note').name} attached`}
    role="img"
    aria-label={`${feature('thread-note').name} attached`}
  >
    <ThreadNoteIcon {size} />
  </span>
{/if}
