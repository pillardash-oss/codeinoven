<script lang="ts">
  import type { MainView } from '$lib/stores/renderer-recovery.svelte'
  import WorkingCountBadge from '$lib/components/shared/WorkingCountBadge.svelte'
  import AppRailButton from './AppRailButton.svelte'
  import AppRailUtilities from './AppRailUtilities.svelte'
  import RailHighlight from './RailHighlight.svelte'
  import type { HeaderViewOption, HeaderViewOptionId } from './AppHeaderNavigationController.svelte'
  import { ViewRailActivity, viewBadgesFor } from './view-rail-activity.svelte'

  interface Props {
    /** The primary-view options, already ordered by the navigation controller. */
    options: HeaderViewOption[]
    /** The option the rail currently reflects, or null on takeover views. */
    shownOption: HeaderViewOptionId | null
    /** The option that carries the project family's activity badge   the live
     *  project view, or the last one the user was on when the Browser is shown. */
    projectBadgeOption: HeaderViewOptionId | null
    /** The view the shell shows, so the utility group can mark Settings. */
    activeView: MainView
    navigate: (view: MainView) => void
    /** Warm the target view's thread/chunk before a nav click lands. */
    onOptionHover: (id: HeaderViewOptionId) => void
  }

  let { options, shownOption, projectBadgeOption, activeView, navigate, onOptionHover }: Props =
    $props()

  const activity = new ViewRailActivity()

  /** Identity of what the rail currently shows, plus its item list: either one
   *  changing moves the current item, which is the only thing that re-measures
   *  the shared surface. */
  let highlightRevision = $derived(
    `${activeView}|${shownOption ?? ''}|${options.map((option) => option.id).join(',')}`
  )

  function isActive(id: HeaderViewOptionId): boolean {
    return id === shownOption
  }
</script>

<!--
  The view rail: a fixed-width vertical rail pinned to the left window edge,
  mirroring the right context dock. It holds the primary view switcher that used
  to live in the app header, plus the utility group (update status, task manager,
  settings) that used to sit in the project sidebar footer. Each view item
  carries the activity badge of its own family, so the project family's shared
  badge rides the last project view the user was on while Chat, Assistant or
  Browser is on screen. The Browser owns no listed thread family, so its item
  carries the tab assistant conversations behind it, falling back to the browser
  profile's outstanding downloads.
-->
<nav
  class="relative flex h-full w-10 shrink-0 flex-col items-center gap-0.5 bg-surface py-2"
  aria-label="Primary views"
  data-region="view-rail"
>
  <!-- One current-item surface for the whole rail, shared by the view buttons and
       the utility group, so a view switch slides it to the icon that took over. -->
  <RailHighlight revision={highlightRevision} currentValue="page" accentSide="right" />

  <div class="flex flex-col items-center gap-0.5" data-onboarding="view-switcher">
    {#each options as option (option.id)}
      {@const badges = viewBadgesFor(
        option.id,
        projectBadgeOption,
        activity.counts,
        activity.browserTransfers,
        activity.browserAssistant
      )}
      <AppRailButton
        label={option.label}
        icon={option.icon}
        active={isActive(option.id)}
        shortcut={option.keys}
        onSelect={option.select}
        onHover={() => onOptionHover(option.id)}
      >
        {#snippet badge()}
          {#if badges.activity || badges.unread}
            <span class="absolute -top-1 -right-1 flex items-center gap-0.5">
              {#if badges.activity}
                <WorkingCountBadge
                  icon={badges.activity.icon}
                  count={badges.activity.count}
                  label={badges.activity.label}
                  tone={badges.activity.tone}
                />
              {/if}
              {#if badges.unread}
                <WorkingCountBadge
                  icon={badges.unread.icon}
                  count={badges.unread.count}
                  label={badges.unread.label}
                  tone={badges.unread.tone}
                  colors={badges.unread.colors}
                />
              {/if}
            </span>
          {/if}
        {/snippet}
      </AppRailButton>
    {/each}
  </div>

  <AppRailUtilities {navigate} {activeView} />
</nav>
