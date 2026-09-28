<script lang="ts">
  import type { Attachment } from 'svelte/attachments'
  import type { MainView } from '$lib/stores/renderer-recovery.svelte'
  import WorkingCountBadge from '$lib/components/shared/WorkingCountBadge.svelte'
  import AppRailButton from './AppRailButton.svelte'
  import AppRailUtilities from './AppRailUtilities.svelte'
  import type { HeaderViewOption, HeaderViewOptionId } from './AppHeaderNavigationController.svelte'
  import { ViewRailActivity, viewBadgeFor } from './view-rail-activity.svelte'

  interface Props {
    /** The primary-view options, already ordered by the navigation controller. */
    options: HeaderViewOption[]
    /** The option the rail currently reflects, or null on takeover views. */
    shownOption: HeaderViewOptionId | null
    /** The view the shell shows, so the utility group can mark Settings. */
    activeView: MainView
    navigate: (view: MainView) => void
    /** Warm the target view's thread/chunk before a nav click lands. */
    onOptionHover: (id: HeaderViewOptionId) => void
  }

  let { options, shownOption, activeView, navigate, onOptionHover }: Props = $props()

  const activity = new ViewRailActivity()

  let railEl = $state<HTMLElement | null>(null)
  /** Where the current-item surface sits right now; null when no item is current. */
  let surface = $state<{ top: number; height: number } | null>(null)
  /** Last measured box, kept while no item is current so the surface fades in
   *  place instead of snapping back to the top of the rail. */
  let lastSurface = $state({ top: 0, height: 32 })

  /**
   * The surface follows whichever item carries `aria-current`   a view button or
   * the Settings utility   so switching views slides one highlight across the
   * rail rather than fading two separate ones.
   */
  function syncSurface(): void {
    const root = railEl
    const current = root?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!root || !current) {
      surface = null
      return
    }
    const rootBox = root.getBoundingClientRect()
    const itemBox = current.getBoundingClientRect()
    // Measured into a local first: assigning `lastSurface` to `surface` directly
    // would read the state this effect writes, which Svelte treats as a loop.
    const box = { top: itemBox.top - rootBox.top, height: itemBox.height }
    lastSurface = box
    surface = box
  }

  const measureRail: Attachment<HTMLElement> = (element) => {
    railEl = element
    const observer = new ResizeObserver(syncSurface)
    observer.observe(element)
    return () => {
      observer.disconnect()
      railEl = null
    }
  }

  // The rail's own box never changes when the view does, so the item change is
  // what re-measures here; the attachment's observer covers layout resizes (the
  // utility group is pinned to the bottom, so a shorter window moves it).
  $effect(() => {
    void activeView
    void shownOption
    syncSurface()
  })

  function isActive(id: HeaderViewOptionId): boolean {
    return id === shownOption
  }
</script>

<!--
  The view rail: a fixed-width vertical rail pinned to the left window edge,
  mirroring the right context dock. It holds the primary view switcher that used
  to live in the app header, plus the utility group (update status, task manager,
  settings) that used to sit in the project sidebar footer. Each view item
  carries the activity badge of its own family.
-->
<nav
  class="relative flex h-full w-10 shrink-0 flex-col items-center gap-0.5 bg-surface py-2"
  aria-label="Primary views"
  data-region="view-rail"
  {@attach measureRail}
>
  <!-- One current-item surface for the whole rail, shared by the view buttons and
       the utility group, so a view switch slides it to the icon that took over. -->
  <span
    class="pointer-events-none absolute left-1 right-1 rounded-lg bg-elevated transition-[transform,height,opacity] duration-200 ease-out motion-reduce:transition-none {surface
      ? 'opacity-100'
      : 'opacity-0'}"
    style:transform="translateY({surface?.top ?? lastSurface.top}px)"
    style:height="{surface?.height ?? lastSurface.height}px"
    aria-hidden="true"
  >
    <span class="absolute right-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"></span>
  </span>

  <div class="flex flex-col items-center gap-0.5" data-onboarding="view-switcher">
    {#each options as option (option.id)}
      {@const activityBadge = viewBadgeFor(option.id, shownOption, activity.counts)}
      <AppRailButton
        label={option.label}
        icon={option.icon}
        active={isActive(option.id)}
        shortcut={option.keys}
        onSelect={option.select}
        onHover={() => onOptionHover(option.id)}
      >
        {#snippet badge()}
          {#if activityBadge}
            <WorkingCountBadge
              icon={activityBadge.icon}
              count={activityBadge.count}
              label={activityBadge.label}
              tone={activityBadge.tone}
              class="absolute -top-1 -right-1"
            />
          {/if}
        {/snippet}
      </AppRailButton>
    {/each}
  </div>

  <AppRailUtilities {navigate} {activeView} />
</nav>
