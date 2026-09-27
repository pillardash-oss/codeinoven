<script lang="ts">
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
  class="flex h-full w-10 shrink-0 flex-col items-center gap-0.5 bg-surface py-2"
  aria-label="Primary views"
  data-region="view-rail"
>
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
