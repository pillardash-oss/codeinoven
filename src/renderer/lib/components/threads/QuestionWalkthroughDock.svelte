<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioClipboardList from '@pdslng/cio-icon/CioClipboardList.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import { APP_SLUG } from '$shared/brand'
  import { copyText } from '$lib/copy-text'
  import { questionWalkthrough } from '$lib/stores/question-walkthrough.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import DockRow from '../ui/DockRow.svelte'
  import { splitWalkthroughLinks } from './question-walkthrough-links'

  /**
   * The step-by-step text attached to a question or to one of its options.
   *
   * The walkthrough is what the user must run or paste to produce the answer (a
   * command, a script, an ordered procedure). It lives outside the entry's
   * description precisely so it can be copied verbatim instead of transcribed
   * from a wrapped paragraph, so this panel renders it as selectable text and
   * offers a single copy control for the whole block.
   *
   * It is one of the two ways to understand an entry; the other is the visual the
   * agent drew. An entry may carry either or both, and the card shows both
   * buttons side by side when it has both.
   *
   * It is a dockable panel rather than a blocking dialog, mounted at the app root
   * because following the walkthrough means leaving the app: the steps are run in
   * a terminal or on a provider's site, and the user comes back for the next one.
   * Minimizing leaves a chip they restore from, and the panel outlives the card
   * that opened it, which is replaced the moment the question settles.
   */
  const storageKey = `${APP_SLUG}.questionWalkthrough.v1`

  /**
   * The text this panel last copied.
   *
   * Held as the copied text rather than a bare `true`, so a walkthrough replaced
   * under a stale confirmation never keeps claiming "Copied" for text the user
   * never copied.
   */
  let copiedText = $state<string | null>(null)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  const copied = $derived(copiedText === questionWalkthrough.text)

  /**
   * The walkthrough with its addresses as anchors.
   *
   * A walkthrough routinely says "open this link", and rendering it as one text
   * node left that address unclickable. The copy control still copies the whole
   * block as written, so selectability and copying are unchanged.
   */
  const segments = $derived(splitWalkthroughLinks(questionWalkthrough.text))

  $effect(() => () => clearTimeout(copyResetTimer))

  async function copy(): Promise<void> {
    try {
      await copyText(questionWalkthrough.text, null)
      copiedText = questionWalkthrough.text
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copiedText = null), 1500)
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
  offered no Copy at all. This panel exists to be copied from, so it keeps the
  app's own selection behaviour: in this document `TextSelectionContextMenu`
  answers the right-click with Copy and Select All, exactly as it does for the
  rest of the app's text.
-->
<DockableModal
  open={questionWalkthrough.open}
  title="Walkthrough: {questionWalkthrough.subject}"
  minimized={questionWalkthrough.minimized}
  closable
  onMinimize={() => questionWalkthrough.minimize()}
  onClose={() => questionWalkthrough.close()}
  {storageKey}
  dragLabel="Drag to move the walkthrough panel"
  defaultHeight={420}
>
  {#snippet dock()}
    <DockRow {storageKey} label="Move the docked walkthrough">
      <div class="flex items-center gap-1 border bg-surface p-1.5 shadow-xl">
        <button
          type="button"
          class="flex min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
          title="Show the walkthrough again"
          aria-label="Show the walkthrough again"
          onclick={() => questionWalkthrough.restore()}
        >
          <CioClipboardList size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
          <span class="flex min-w-0 flex-col">
            <span class="text-xs font-medium leading-tight text-foreground">Walkthrough</span>
            <span class="max-w-40 truncate text-xs leading-tight text-muted"
              >{questionWalkthrough.subject}</span
            >
          </span>
        </button>
        <span class="h-5 w-px bg-border"></span>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Close the walkthrough"
          title="Close the walkthrough"
          onclick={() => questionWalkthrough.close()}
        >
          <CioClose size={14} />
        </button>
      </div>
    </DockRow>
  {/snippet}

  <div class="space-y-2">
    <p class="text-xs text-muted">
      Follow this to produce the answer. Select any part you need, or copy the whole walkthrough.
    </p>
    <pre
      class="border bg-elevated px-3 py-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground select-text">{#each segments as segment, index (index)}{#if segment.href}<a
            href={segment.href}
            target="_blank"
            rel="noreferrer noopener"
            class="text-primary underline underline-offset-2 break-all hover:opacity-80"
            >{segment.text}</a
          >{:else}{segment.text}{/if}{/each}</pre>
  </div>

  {#snippet footer()}
    <button
      type="button"
      data-modal-dismiss
      class="cursor-pointer border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
      onclick={() => questionWalkthrough.close()}
    >
      Close
    </button>
    <button
      type="button"
      data-modal-primary
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
</DockableModal>
