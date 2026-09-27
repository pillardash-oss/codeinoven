<script lang="ts">
  import type { HeaderViewOption, HeaderViewOptionId } from './AppHeaderNavigationController.svelte'
  import WorkingCountBadge from '$lib/components/shared/WorkingCountBadge.svelte'
  import { ViewRailActivity, viewBadgeFor } from './view-rail-activity.svelte'

  interface Props {
    /** The primary-view options, already ordered by the navigation controller. */
    options: HeaderViewOption[]
    /** The option the rail currently reflects. */
    shownOption: HeaderViewOptionId
    /** Warm the target view's thread/chunk before a nav click lands. */
    onOptionHover: (id: HeaderViewOptionId) => void
  }

  let { options, shownOption, onOptionHover }: Props = $props()

  const activity = new ViewRailActivity()

  function isActive(id: HeaderViewOptionId): boolean {
    return id === shownOption
  }
</script>

<!--
  The view rail: a fixed-width vertical rail pinned to the left window edge,
  mirroring the right context dock. It holds the primary view switcher that used
  to live in the app header, so the header keeps only the page title (plus
  back/forward and per-view actions). Each item carries the activity badge of its
  own family.
-->
<nav
  class="flex h-full w-10 shrink-0 flex-col items-center gap-0.5 border-r border-border bg-surface py-2"
  aria-label="Primary views"
  data-region="view-rail"
>
  <div class="flex flex-col items-center gap-0.5" data-onboarding="view-switcher">
    {#each options as option (option.id)}
      {@const Icon = option.icon}
      {@const badge = viewBadgeFor(option.id, activity.counts)}
      <button
        type="button"
        class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 {isActive(
          option.id
        )
          ? 'bg-elevated text-foreground'
          : 'text-muted hover:bg-elevated hover:text-foreground'}"
        aria-label={option.label}
        aria-current={isActive(option.id) ? 'page' : undefined}
        title={option.label}
        data-shortcut={option.keys.length > 0 ? option.keys.join(',') : undefined}
        onpointerenter={() => onOptionHover(option.id)}
        onclick={option.select}
      >
        <span
          class="absolute right-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary transition-opacity duration-150 {isActive(
            option.id
          )
            ? 'opacity-100'
            : 'opacity-0'}"
          aria-hidden="true"
        ></span>
        <Icon size={16} strokeWidth={1.8} />
        {#if badge}
          <WorkingCountBadge
            icon={badge.icon}
            count={badge.count}
            label={badge.label}
            tone={badge.tone}
            class="absolute -top-1 -right-1"
          />
        {/if}
      </button>
    {/each}
  </div>
</nav>
