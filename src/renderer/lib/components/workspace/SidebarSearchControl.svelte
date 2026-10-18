<script lang="ts">
  import CioClose from '@codeinoven/icons/CioClose.svelte'
  import CioSearch from '@codeinoven/icons/CioSearch.svelte'
  import CioSpinner from '@codeinoven/icons/CioSpinner.svelte'
  import { Popover } from 'bits-ui'
  import type { Attachment } from 'svelte/attachments'
  import { NativeFloatingPanel } from '$lib/native-floating-panel.svelte'
  import type { BrowserViewBounds } from '$shared/ipc-contract'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'

  interface Props {
    /** Whether the search popover is currently open. */
    open: boolean
    /** Current search query value. */
    query: string
    /** Called when the search should open/close (Escape, re-click, close button). */
    onOpenChange: (open: boolean) => void
    /** Called when the user types in the search input. */
    onQueryChange: (value: string) => void
    /**
     * Whether a search for the typed query is still in flight. Shows the
     * indicator in the input row, which is where the only visible sign of a
     * search in progress lives: the list behind the popover keeps the rows it
     * was showing until results replace them.
     */
    loading?: boolean
    /** Accessible label for the trigger button and popover. */
    ariaLabel: string
    /** Tooltip shown on the trigger button. */
    title: string
    /** Placeholder text inside the search input. */
    placeholder: string
    /** Trigger size   'sm' for dense rows, 'md' for sidebar header toolbars. */
    size?: 'sm' | 'md'
  }

  let {
    open,
    query,
    onOpenChange,
    onQueryChange,
    ariaLabel,
    title,
    placeholder,
    loading = false,
    size = 'sm'
  }: Props = $props()

  const triggerClass = $derived(
    size === 'md'
      ? 'flex h-7 w-7 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground'
      : 'flex h-5 w-5 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-overlay data-[state=open]:text-foreground'
  )

  const nativeId = `search-panel-${crypto.randomUUID()}`
  // Editable popovers use the live host shared by DockableModal. Projection-only
  // floating docks deliberately refuse editable fields because they cannot own typing.
  const native = new NativeFloatingPanel(nativeId)
  const nativeArmed = $derived(open && browserVisibility.canUseNativeDock && !native.failed)
  let box = $state<BrowserViewBounds | null>(null)
  const mountNative: Attachment<HTMLElement> = (element) => native.mount(element)

  // Measure the source frame, which stays in Floating UI's layout after the
  // live panel moves into the native window with its own coordinate space.
  const measureFrame: Attachment<HTMLDivElement> = (element) => {
    let previous: BrowserViewBounds | null = null
    const measure = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      if (
        previous?.x === rect.x &&
        previous.y === rect.y &&
        previous.width === rect.width &&
        previous.height === rect.height
      )
        return
      previous = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      box = previous
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    const positionObserver = new MutationObserver(measure)
    if (element.parentElement?.parentElement)
      positionObserver.observe(element.parentElement.parentElement, {
        attributes: true,
        attributeFilter: ['style']
      })
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    measure()
    return () => {
      observer.disconnect()
      positionObserver.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      box = null
    }
  }

  // Restore the adopted node before Svelte removes its original conditional block.
  $effect.pre(() => {
    if (!open) native.restore()
  })
  $effect(() => {
    native.update(nativeArmed, open && box !== null, box ?? { x: 0, y: 0, width: 1, height: 1 })
  })
  $effect(() => browserVisibility.hideWhile(nativeId, 'fullscreen-surface', open && native.failed))

  const focusSearchInput: Attachment<HTMLInputElement> = (element) => {
    element.focus()
  }
</script>

<Popover.Root {open} {onOpenChange}>
  <Popover.Trigger class={`titlebar-no-drag ${triggerClass}`} aria-label={ariaLabel} {title}>
    <CioSearch size={size === 'md' ? 15 : 12} strokeWidth={size === 'md' ? 1.8 : undefined} />
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      side="right"
      align="start"
      sideOffset={8}
      collisionPadding={16}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onInteractOutside={(e) => e.preventDefault()}
      class="titlebar-no-drag z-50"
      trapFocus={!nativeArmed}
      aria-label={ariaLabel}
    >
      <div
        {@attach measureFrame}
        class="h-11 w-80"
        style:opacity={nativeArmed && !native.live ? 0 : 1}
      >
        <div
          {@attach mountNative}
          class="titlebar-no-drag flex h-11 w-80 items-center overflow-hidden border bg-surface p-1.5 shadow-lg"
        >
          <div class="flex w-full items-center gap-1.5">
            <CioSearch size={14} class="shrink-0 text-dimmed" />
            <input
              {@attach focusSearchInput}
              type="text"
              class="h-7 min-w-0 flex-1 bg-app px-2 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed"
              {placeholder}
              aria-label={ariaLabel}
              onkeydown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  onOpenChange(false)
                }
              }}
              value={query}
              oninput={(e: Event) => onQueryChange((e.currentTarget as HTMLInputElement).value)}
            />
            {#if loading}
              <span
                class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed"
                role="status"
                aria-label="Searching"
              >
                <CioSpinner size={13} class="animate-spin" />
              </span>
            {/if}
            <!-- One control, one meaning: the X dismisses the whole search. It used
             to be two X's side by side ("clear" and "close"), so clicking the
             left one emptied the query, wiped the sidebar results and left the
             panel open - a dismiss that only looked like one. Dismissal already
             clears the query and its results. -->
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              aria-label="Dismiss search"
              title="Dismiss search"
              onclick={() => onOpenChange(false)}
            >
              <CioClose size={13} />
            </button>
          </div>
        </div>
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
