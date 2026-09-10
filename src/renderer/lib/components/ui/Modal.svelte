<script lang="ts">
  import { X } from '@lucide/svelte'
  import { Dialog } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { registerOverlayClose } from '$lib/overlay-close.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import {
    registerModalPrimaryAction,
    findPanelPrimaryAction,
    focusOwnsEnter,
    isFocusableTarget,
    PRIMARY_BUTTON_SELECTOR
  } from '$lib/modal-primary-action.svelte'

  const INPUT_FIELD_SELECTOR = [
    'input:not([type="hidden"]):not([disabled]):not([readonly])',
    'textarea:not([disabled]):not([readonly])',
    'select:not([disabled])',
    '[contenteditable="true"]:not([aria-disabled="true"])'
  ].join(',')

  interface Props {
    open: boolean
    title: string
    onClose: () => void
    children: Snippet
    footer?: Snippet
    size?: 'md' | 'lg' | 'xl'
    contentClass?: string
    fill?: boolean
    /** Clicking the backdrop calls onClose. Off for surfaces that hold drafts. */
    closeOnBackdrop?: boolean
  }

  let {
    open,
    title,
    onClose,
    children,
    footer,
    size = 'md',
    contentClass = 'overflow-y-auto p-6',
    fill = false,
    closeOnBackdrop = true
  }: Props = $props()

  const widths = {
    md: 'max-w-md',
    lg: 'max-w-2xl',
    xl: 'max-w-5xl'
  } as const


  // The browser's native view floats above every DOM surface (see
  // ContextSidebarState.setFullscreenSurfaceActive), so this shared modal must
  // suppress it while open — otherwise a still-visible browser tab covers the
  // dialog's content and footer buttons, making them unclickable. Keyed per
  // instance so stacked modals don't clear each other's suppression.
  const suppressionKey = `modal-${Math.random().toString(36).slice(2)}`
  $effect(() => {
    contextSidebarState.setFullscreenSurfaceActive(suppressionKey, open)
    return () => contextSidebarState.setFullscreenSurfaceActive(suppressionKey, false)
  })

  let panelEl = $state<HTMLElement | null>(null)

  $effect(() => {
    if (!open) return
    return registerOverlayClose(() => onClose())
  })

  // ⌘/Ctrl+Enter runs this modal's primary action. This instance registers a
  // resolver on the shared LIFO stack while open, so the shortcut always
  // activates the topmost (focused) modal's action.
  $effect(() => {
    if (!open) return
    return registerModalPrimaryAction(() => {
      if (!panelEl || focusOwnsEnter(panelEl)) return false
      const action = findPanelPrimaryAction(panelEl)
      if (!action) return false
      action.click()
      return true
    })
  })

  function focusInitialElement(event: Event) {
    // Own the initial focus (input field, else the primary action) instead
    // of bits-ui's default of focusing the panel itself.
    event.preventDefault()
    if (!panelEl) return
    const inputField = firstTextField(panelEl)
    const defaultAction = findPanelPrimaryAction(panelEl)
    ;(inputField ?? defaultAction)?.focus({ preventScroll: true })
  }

  function firstTextField(panel: HTMLElement): HTMLElement | undefined {
    return Array.from(panel.querySelectorAll<HTMLElement>(INPUT_FIELD_SELECTOR)).find(
      isFocusableTarget
    )
  }
</script>

<Dialog.Root {open} onOpenChange={(next) => !next && onClose()}>
  <Dialog.Portal>
    <!-- 13% opacity so the workspace stays visible behind -->
    <Dialog.Overlay class="fixed inset-0 z-60 bg-overlay/70 backdrop-blur-[1px]" />
    <div class="pointer-events-none fixed inset-0 z-60 flex items-center justify-center">
      <Dialog.Content
        bind:ref={panelEl}
        onOpenAutoFocus={focusInitialElement}
        onInteractOutside={(event) => {
          if (!closeOnBackdrop) event.preventDefault()
        }}
        class="pointer-events-auto relative mx-6 flex max-h-[calc(100vh-3rem)] w-full flex-col overflow-hidden rounded-2xl border bg-surface shadow-xl {fill
          ? 'h-[calc(100vh-3rem)]'
          : ''} {widths[size]}"
      >
        <div class="flex shrink-0 items-center justify-between border-b px-6 py-4">
          <Dialog.Title class="text-base font-semibold">{title}</Dialog.Title>
          <Dialog.Close
            class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Close"
            title="Close"
          >
            <X size={16} />
          </Dialog.Close>
        </div>

        <div class="min-h-0 flex-1 {contentClass}">
          {@render children()}
        </div>

        {#if footer}
          <div
            class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-surface px-6 py-4"
            data-modal-footer
          >
            {@render footer()}
          </div>
        {/if}
      </Dialog.Content>
    </div>
  </Dialog.Portal>
</Dialog.Root>
