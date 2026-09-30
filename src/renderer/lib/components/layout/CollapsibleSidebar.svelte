<script lang="ts">
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import type { Snippet } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { sidebarState } from '$lib/stores/sidebar.svelte'
  import { motionDuration, slideWidth } from '$lib/motion'
  import { trackBrowserOcclusion } from '$lib/stores/browser-visibility.svelte'
  import SidebarResizeHandle from '$lib/components/layout/SidebarResizeHandle.svelte'

  interface Props {
    /** Sidebar header title, e.g. "Projects" or "Chats". */
    title: string
    /**
     * Pinned sidebars are always docked (e.g. Settings)   they ignore the
     * shared collapsed state but still share the global width.
     */
    pinned?: boolean
    /** Content rendered in the sidebar header action area (e.g. add button). */
    header?: Snippet
    /** Content rendered before the title in the sidebar header (e.g. back icon). */
    titlePrefix?: Snippet
    /** Replaces the static title label (e.g. a view-switcher dropdown). */
    titleSnippet?: Snippet
    /** Hide the generic title/action row when the child supplies contextual navigation. */
    hideHeader?: boolean
    /**
     * Content pinned above the scroller, for a sidebar whose own chrome must
     * stay in view while its body scrolls (the browser's address and history).
     * Rendered between the header and the scrollable body in both docked and
     * floating states.
     */
    chrome?: Snippet
    /** Accessible name for the sidebar element. */
    label?: string
    /** `data-region` value, which is how probes and tests find this sidebar. */
    region?: string
    /**
     * Whether the onboarding tour's anchor points at this sidebar. Only the
     * workspace sidebar is the anchor, so every other sidebar opts out instead
     * of publishing a second element for the same selector.
     */
    onboardingAnchor?: boolean
    /** Full-width footer slot at the bottom of the sidebar (e.g. settings button). */
    footer?: Snippet
    /** Binds the sidebar's scrollable content element so the owner can keep
     *  the active thread in view and detect user-initiated scrolling. */
    scroller?: HTMLElement | null
    /**
     * Optional OS file-drop target on the sidebar body: `active` drives the
     * drop affordance. The handlers attach to the scrollable content element
     * itself rather than to a wrapper, because children size themselves from
     * that element's definite height (e.g. the scoped-threads stage rail) and
     * an extra wrapper would collapse them.
     */
    fileDrop?: {
      active: boolean
      onDragOver: (event: DragEvent) => void
      onDragLeave: (event: DragEvent) => void
      onDrop: (event: DragEvent) => void
    }
    /**
     * How a native overlay is handling this sidebar's floating panel while a
     * browser page covers it.
     *
     *   - `none`: nothing native is drawing it, so the DOM panel draws and
     *     publishes its occlusion as it always has;
     *   - `pending`: the overlay has been asked to draw it. The DOM panel keeps
     *     drawing   the sliver beside the page stays visible while the overlay's
     *     window loads   but it must not occlude: publishing here would detach
     *     the page, and the overlay mirrors the very frame that would vanish;
     *   - `live`: the overlay is drawing it, so the DOM panel steps aside.
     */
    overlayPhase?: 'none' | 'pending' | 'live'
    children: Snippet
  }

  let {
    title,
    pinned = false,
    header,
    titlePrefix,
    titleSnippet,
    hideHeader = false,
    chrome = undefined,
    label = undefined,
    region = undefined,
    onboardingAnchor = true,
    footer,
    scroller = $bindable(null),
    fileDrop = undefined,
    overlayPhase = 'none',
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
    class="relative flex h-full shrink-0 flex-col bg-surface"
    data-onboarding={onboardingAnchor ? 'project-sidebar' : undefined}
    data-region={region}
    aria-label={label}
    style="width: {sidebarState.width}px"
    class:select-none={resizing}
    in:slideWidth={{ duration: motionDuration(200), easing: cubicOut }}
    out:slideWidth={{ duration: motionDuration(160), easing: cubicOut }}
  >
    {#if !hideHeader}
      <div class="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <div class="flex min-w-0 items-center gap-2">
          {@render titlePrefix?.()}
          {#if titleSnippet}
            {@render titleSnippet()}
          {:else}
            <h2 class="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted">
              {title}
            </h2>
          {/if}
        </div>
        {@render header?.()}
      </div>
    {/if}

    {#if chrome}
      {@render chrome()}
    {/if}

    <div
      class="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2"
      class:ring-2={fileDrop?.active}
      class:ring-primary={fileDrop?.active}
      class:ring-inset={fileDrop?.active}
      role={fileDrop ? 'region' : undefined}
      aria-label={fileDrop ? 'Files dropped here open in CodeInOven' : undefined}
      data-drop-region={fileDrop ? 'sidebar' : undefined}
      ondragover={fileDrop?.onDragOver}
      ondragleave={fileDrop?.onDragLeave}
      ondrop={fileDrop?.onDrop}
      {@attach captureScroller}
    >
      {@render children()}
    </div>

    {#if footer}
      <div class="shrink-0 border-t">
        {@render footer()}
      </div>
    {/if}

    <!-- Resize handle -->
    <SidebarResizeHandle
      side="right"
      width={sidebarState.width}
      label="Resize sidebar"
      onResize={(width) => (sidebarState.width = sidebarState.clampWidth(width))}
      onResizeEnd={() => sidebarState.persist()}
      bind:resizing
    />
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
      class="fixed top-12 bottom-0 left-0 z-50 flex flex-col bg-surface shadow-2xl"
      data-onboarding={onboardingAnchor ? 'project-sidebar' : undefined}
      data-region={region}
      aria-label={label}
      style="width: {sidebarState.width}px"
      class:invisible={overlayPhase === 'live'}
      class:pointer-events-none={overlayPhase === 'live'}
      transition:fly={{ x: -sidebarState.width, duration: 180 }}
      onmouseenter={onOverlayEnter}
      onmouseleave={onOverlayLeave}
      {@attach overlayPhase === 'none' && trackBrowserOcclusion}
    >
      {#if !hideHeader}
        <div class="flex h-10 shrink-0 items-center justify-between border-b px-3">
          <div class="flex min-w-0 items-center gap-2">
            {@render titlePrefix?.()}
            {#if titleSnippet}
              {@render titleSnippet()}
            {:else}
              <h2 class="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted">
                {title}
              </h2>
            {/if}
          </div>
          {@render header?.()}
        </div>
      {/if}

      {#if chrome}
        {@render chrome()}
      {/if}

      <div
        class="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2"
        class:ring-2={fileDrop?.active}
        class:ring-primary={fileDrop?.active}
        class:ring-inset={fileDrop?.active}
        role={fileDrop ? 'region' : undefined}
        aria-label={fileDrop ? 'Files dropped here open in CodeInOven' : undefined}
        data-drop-region={fileDrop ? 'sidebar' : undefined}
        ondragover={fileDrop?.onDragOver}
        ondragleave={fileDrop?.onDragLeave}
        ondrop={fileDrop?.onDrop}
        {@attach captureScroller}
      >
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
