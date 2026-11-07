<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import { copyText } from '$lib/copy-text'
  import Modal from '../ui/Modal.svelte'

  /**
   * Shows the walkthrough attached to a question or to one of its options.
   *
   * The walkthrough is the step-by-step text the user must run or paste to
   * produce the answer (a command, a script, an ordered procedure). It lives
   * outside the entry's description precisely so it can be copied verbatim
   * instead of transcribed from a wrapped paragraph, so this modal renders it as
   * selectable text and offers a single copy control for the whole block.
   *
   * It is one of the two ways to understand an entry; the other is the visual the
   * agent drew. An entry may carry either or both, and the card shows both
   * buttons side by side when it has both.
   */
  interface Props {
    open: boolean
    /** What the walkthrough belongs to: the question header or an option label. */
    subject: string
    walkthrough: string
    onClose: () => void
  }

  let { open, subject, walkthrough, onClose }: Props = $props()

  let copied = $state(false)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  $effect(() => () => clearTimeout(copyResetTimer))

  async function copy(): Promise<void> {
    try {
      await copyText(walkthrough, null)
      copied = true
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copied = false), 1500)
    } catch {
      // Clipboard unavailable   the block stays selectable by hand.
    }
  }
</script>

<!--
  Drawn in the app window instead of being projected into the native overlay.

  A blocking dialog is normally projected into the overlay window, which is a
  separate document: its text is selectable there, but nothing in that window
  owns a right-click, so selecting part of this walkthrough and right-clicking
  offered no Copy at all. This modal exists to be copied from, so it keeps the
  app's own selection behaviour: in this document `TextSelectionContextMenu`
  answers the right-click with Copy and Select All, exactly as it does for the
  rest of the app's text.
-->
<Modal {open} {onClose} title="Walkthrough: {subject}" size="lg" nativePresentation={false}>
  <div class="space-y-2">
    <p class="text-xs text-muted">
      Follow this to produce the answer. Select any part you need, or copy the whole walkthrough.
    </p>
    <pre
      class="max-h-[60dvh] overflow-auto border bg-elevated px-3 py-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground select-text">{walkthrough}</pre>
  </div>

  {#snippet footer()}
    <button
      type="button"
      data-modal-dismiss
      class="border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
      onclick={onClose}
    >
      Close
    </button>
    <button
      type="button"
      class="flex items-center gap-1.5 bg-primary px-3 py-2 text-sm font-semibold text-on-primary transition-opacity hover:opacity-90"
      onclick={() => void copy()}
    >
      {#if copied}
        <CioCheck size={14} />
        Copied
      {:else}
        <CioCopy size={14} />
        Copy walkthrough
      {/if}
    </button>
  {/snippet}
</Modal>
