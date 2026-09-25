<script lang="ts">
  import { Check, ListFilter } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { PrListFilter, PrListSort } from '$shared/types'
  import {
    PR_LIST_FILTER_OPTIONS,
    PR_LIST_SORT_OPTIONS,
    prListFilterLabel,
    prListSortLabel
  } from './pr-view'

  interface Props {
    filter: PrListFilter
    sort: PrListSort
    onFilterChange: (next: PrListFilter) => void
    onSortChange: (next: PrListSort) => void
  }

  let { filter, sort, onFilterChange, onSortChange }: Props = $props()

  /**
   * One control for both choices, the way GitHub's own list carries a "Filters"
   * menu: a state chip row plus a relationship filter plus an ordering is more
   * chrome than a sidebar-width row can hold, and these two are asked together
   * ("open, mine, newest first") rather than one at a time.
   */
  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated'
  const sectionClass =
    'px-2 pt-1.5 pb-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed'

  /** A non-default choice is worth showing on the row, since it hides rows. */
  const narrowed = $derived(filter !== 'all' || sort !== 'updated')

  /**
   * A radio group reports its value as a plain string, so the option lists decide
   * whether that string names a choice this menu offers. No cast.
   */
  function handleFilterChange(value: string): void {
    const next = PR_LIST_FILTER_OPTIONS.find((option) => option.id === value)
    if (next) onFilterChange(next.id)
  }

  function handleSortChange(value: string): void {
    const next = PR_LIST_SORT_OPTIONS.find((option) => option.id === value)
    if (next) onSortChange(next.id)
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[0.625rem] font-medium transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground {narrowed
      ? 'bg-elevated text-foreground'
      : 'text-muted'}"
    title="Filter and sort pull requests"
    aria-label="Filter and sort pull requests, currently {prListFilterLabel(
      filter
    )}, {prListSortLabel(sort)}"
  >
    <!--
      The icon never changes, so the control does not move around as choices
      change; the tint plus the surface it picks up while narrowed is what says a
      filter is on. A narrowing the reader forgot about is how a list starts
      looking empty for no reason.
    -->
    <ListFilter size={11} class="shrink-0" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      class="z-50 w-52 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-xl"
    >
      <p class={sectionClass}>Show</p>
      <DropdownMenu.RadioGroup value={filter} onValueChange={handleFilterChange}>
        {#each PR_LIST_FILTER_OPTIONS as option (option.id)}
          <DropdownMenu.RadioItem value={option.id} class={itemClass} title={option.hint}>
            <span class="min-w-0 flex-1 truncate">{option.label}</span>
            <Check
              size={12}
              class={['shrink-0', option.id === filter ? 'text-primary' : 'invisible']}
              aria-hidden="true"
            />
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
      <DropdownMenu.Separator class="my-1 h-px bg-border" />
      <p class={sectionClass}>Order by</p>
      <DropdownMenu.RadioGroup value={sort} onValueChange={handleSortChange}>
        {#each PR_LIST_SORT_OPTIONS as option (option.id)}
          <DropdownMenu.RadioItem value={option.id} class={itemClass}>
            <span class="min-w-0 flex-1 truncate">{option.label}</span>
            <Check
              size={12}
              class={['shrink-0', option.id === sort ? 'text-primary' : 'invisible']}
              aria-hidden="true"
            />
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
