<script lang="ts">
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioFork from '@pdslng/cio-icon/CioFork.svelte'
  import CioMessagePlus from '@pdslng/cio-icon/CioMessagePlus.svelte'
  import CioNote from '@pdslng/cio-icon/CioNote.svelte'
  import CioTemporaryChat from '@pdslng/cio-icon/CioTemporaryChat.svelte'
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import { copyText } from '$lib/copy-text'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import {
    placeSelectionMenu,
    type SelectionMenuAnchor,
    type SelectionMenuSize
  } from '$lib/selection-anchors'

  interface Props {
    /** The highlighted text the menu acts on. */
    text: string
    anchor: SelectionMenuAnchor
    /** What the selection was taken from, for the menu's accessible name.
     *  A conversation quotes a response; a document quotes a passage. */
    selectionLabel?: string
    /**
     * Whether the selection already carries an annotation.
     *
     * A passage the user has commented on is offered an edit of that comment
     * rather than a second annotation on the same words.
     */
    annotated?: boolean
    onComment: () => void
    /** Opening a nested temp chat makes no sense inside one; hidden when omitted. */
    onElaborate?: () => void
    /** Opening a nested temp chat makes no sense inside one; hidden when omitted. */
    onQuickChat?: () => void
    /** Spinning the selection off into a fresh thread is always valid. */
    onNewThread?: () => void
    onClose: () => void
  }

  let {
    text,
    anchor,
    selectionLabel = 'response',
    annotated = false,
    onComment,
    onElaborate,
    onQuickChat,
    onNewThread,
    onClose
  }: Props = $props()

  const itemClass =
    'flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs text-foreground outline-none hover:bg-elevated focus-visible:bg-elevated'

  /** Read by the dismiss check, so a click inside the menu is not a dismissal. */
  let menuEl: HTMLDivElement | null = null
  let menuWidth = $state(0)
  let menuHeight = $state(0)
  /** Painting before the menu has been measured would jump it on the first
   *  frame, so the placement starts from the box a five-row menu roughly takes
   *  and corrects itself as soon as the real one is known. */
  const sizeEstimate: SelectionMenuSize = { width: 176, height: 150 }

  const placement = $derived(
    placeSelectionMenu(
      anchor,
      { width: menuWidth || sizeEstimate.width, height: menuHeight || sizeEstimate.height },
      { width: window.innerWidth, height: window.innerHeight }
    )
  )

  function dismiss(event: MouseEvent): void {
    if (menuEl && event.target instanceof Node && menuEl.contains(event.target)) return
    onClose()
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (keymapState.matches('palette-close', event)) onClose()
  }

  /** Copy the highlighted text, so the same menu that comments on a passage can
   *  also take it away. */
  async function copySelection(): Promise<void> {
    try {
      await copyText(text)
    } catch {
      toast.error('Failed to copy text')
    }
    onClose()
  }

  onMount(() => {
    // Capture phase for the scroll: a scroller's own scroll event never reaches
    // the window, and a menu left behind by a scrolled selection would point at
    // text that has moved.
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', handleKeydown, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', handleKeydown, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  })
</script>

<div
  bind:this={menuEl}
  bind:clientWidth={menuWidth}
  bind:clientHeight={menuHeight}
  class="fixed z-50 flex min-w-44 flex-col border border-border bg-surface p-1 shadow-xl"
  style:left={`${placement.left}px`}
  style:top={`${placement.top}px`}
  role="menu"
  aria-label={`Actions for the selected ${selectionLabel}: ${text}`}
>
  <button type="button" class={itemClass} role="menuitem" onclick={onComment}>
    {#if annotated}
      <CioNote class="size-3.5 shrink-0 text-text-muted" />
    {:else}
      <CioMessagePlus size={ICON_SIZE.inline} class="shrink-0 text-text-muted" />
    {/if}
    {annotated ? 'Edit comment' : 'Comment'}
  </button>
  {#if onElaborate}
    <button
      type="button"
      class={itemClass}
      role="menuitem"
      title="Explain this selection in a temporary read-only chat"
      onclick={onElaborate}
    >
      <CioTemporaryChat size={ICON_SIZE.inline} class="shrink-0 text-text-muted" />
      Explain
    </button>
  {/if}
  {#if onQuickChat}
    <button
      type="button"
      class={itemClass}
      role="menuitem"
      title="Start a temporary read-only chat with this selection"
      onclick={onQuickChat}
    >
      <CioTemporaryChat size={ICON_SIZE.inline} class="shrink-0 text-text-muted" />
      Quick chat
    </button>
  {/if}
  {#if onNewThread}
    <button
      type="button"
      class={itemClass}
      role="menuitem"
      title="Start a new thread with this selection already in the composer"
      onclick={onNewThread}
    >
      <CioFork size={ICON_SIZE.inline} class="shrink-0 text-text-muted" />
      New thread
    </button>
  {/if}
  <button type="button" class={itemClass} role="menuitem" onclick={copySelection}>
    <CioCopy size={ICON_SIZE.inline} class="shrink-0 text-text-muted" />
    Copy
  </button>
</div>
