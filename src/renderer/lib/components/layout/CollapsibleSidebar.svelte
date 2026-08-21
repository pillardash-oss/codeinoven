<script lang="ts">
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import type { Snippet } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { sidebarState } from '$lib/stores/sidebar.svelte'
  import { motionDuration } from '$lib/motion'

  interface Props {
    /** Sidebar header title, e.g. "Projects" or "Chats". */
    title: string
    /**
     * Pinned sidebars are always docked (e.g. Settings) — they ignore the
     * shared collapsed state but still share the global width.
     */
    pinned?: boolean
    /** Content rendered in the sidebar header action area (e.g. add button). */
    header?: Snippet
    /** Content rendered before the title in the sidebar header (e.g. back icon). */
    titlePrefix?: Snippet
    /** Hide the generic title/action row when the child supplies contextual navigation. */
    hideHeader?: boolean
    /** Full-width footer slot at the bottom of the sidebar (e.g. settings button). */
    footer?: Snippet
    /** Binds the sidebar's scrollable content element so the owner can keep
     *  the active thread in view and detect user-initiated scrolling. */
    scroller?: HTMLElement | null
    children: Snippet
  }

  let {
    title,
    pinned = false,
    header,
    titlePrefix,
    hideHeader = false,
    footer,
    scroller = $bindable(null),
    children
  }: Props = $props()

  let resizing = $state(false)
  let overlayHovered = $state(false)
  let hideTimeout: ReturnType<typeof setTimeout> | undefined

  let docked = $derived(pinned || sidebarState.docked)

  const captureScroller: Attachment<HTMLElement> = (element) => {
    scroller = element
    return () => {
      if (scroller === element) scroller = null
    }
  }

  function startResize(e: PointerEvent): void {
    e.preventDefault()
    resizing = true
    const startX = e.clientX
    const startWidth = sidebarState.width
    const onMove = (ev: PointerEvent): void => {
      sidebarState.width = sidebarState.clampWidth(startWidth + (ev.clientX - startX))
    }
    const onUp = (): void => {
      resizing = false
      sidebarState.persist()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function onEdgeEnter(): void {
    if (!sidebarState.collapsed) return
    clearTimeout(hideTimeout)
    sidebarState.hoverOpen = true
  }

  function onOverlayEnter(): void {
    clearTimeout(hideTimeout)
    overlayHovered = true
  }

  function onOverlayLeave(): void {
    overlayHovered = false
    hideTimeout = setTimeout(() => {
      if (!overlayHovered) sidebarState.hoverOpen = false
    }, 260)
  }
</script>

{#if docked}
  <!-- Docked sidebar: occupies layout, resizable -->
  <aside
    class="relative flex h-full shrink-0 flex-col border-r bg-surface"
    data-onboarding="project-sidebar"
    style="width: {sidebarState.width}px"
    class:select-none={resizing}
    in:fly={{ x: -sidebarState.width, duration: motionDuration(200), easing: cubicOut }}
    out:fly={{ x: -sidebarState.width, duration: motionDuration(160), easing: cubicOut }}
  >
    {#if !hideHeader}
      <div class="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <div class="flex min-w-0 items-center gap-2">
          {@render titlePrefix?.()}
          <h2 class="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
            {title}
          </h2>
        </div>
        {@render header?.()}
      </div>
    {/if}

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2" {@attach captureScroller}>
      {@render children()}
    </div>

    {#if footer}
      <div class="shrink-0 border-t">
        {@render footer()}
      </div>
    {/if}

    <!-- Resize handle -->
    <div
      class="absolute inset-y-0 right-0 w-1 cursor-col-resize transition-colors hover:bg-primary/20 {resizing
        ? 'bg-primary/30'
        : ''}"
      role="separator"
      aria-orientation="vertical"
      onpointerdown={startResize}
    ></div>
  </aside>
{:else}
  <!-- Edge hover zone -->
  <div
    class="fixed top-12 bottom-0 left-0 z-40 w-2"
    aria-hidden="true"
    onmouseenter={onEdgeEnter}
  ></div>

  <!-- Floating overlay -->
  {#if sidebarState.hoverOpen}
    <aside
      class="fixed top-12 bottom-0 left-0 z-50 flex flex-col border-r bg-surface shadow-2xl"
      data-onboarding="project-sidebar"
      style="width: {sidebarState.width}px"
      transition:fly={{ x: -sidebarState.width, duration: 180 }}
      onmouseenter={onOverlayEnter}
      onmouseleave={onOverlayLeave}
    >
      {#if !hideHeader}
        <div class="flex h-10 shrink-0 items-center justify-between border-b px-3">
          <div class="flex min-w-0 items-center gap-2">
            {@render titlePrefix?.()}
            <h2 class="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
              {title}
            </h2>
          </div>
          {@render header?.()}
        </div>
      {/if}

      <div class="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2" {@attach captureScroller}>
        {@render children()}
      </div>

      {#if footer}
        <div class="shrink-0 border-t">
          {@render footer()}
        </div>
      {/if}
    </aside>
  {/if}
{/if}
