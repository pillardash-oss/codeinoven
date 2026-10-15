<script lang="ts" generics="Filter extends string, Sort extends string">
  import { Check, ListFilter } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'

  /**
   * The filter-and-sort menu both GitHub listings share.
   *
   * A listing carries a state chip row plus a relationship filter plus an
   * ordering, which is more chrome than a sidebar-width row can hold, so the two
   * choices live behind one "Filters" menu the way GitHub's own list does them.
   * The option sets are supplied by the caller because a pull request and an issue
   * narrow by different relationships, and nothing here may know which listing it
   * is drawing.
   */
  interface Props {
    filter: Filter
    sort: Sort
    filterOptions: Array<{ id: Filter; label: string; hint?: string }>
    sortOptions: Array<{ id: Sort; label: string }>
    onFilterChange: (next: Filter) => void
    onSortChange: (next: Sort) => void
    /** Accessible name of the trigger, e.g. `Filter and sort pull requests`. */
    label: string
    /** The current choices, read out after the label in the accessible name. */
    current: string
    /** Whether a non-default choice is active, so the trigger shows it. */
    narrowed: boolean
    /**
     * Whether the filter section is drawn. The notification panel turns it off
     * for its Saved and Done views, which are not a filtered live listing and
     * only have an ordering.
     */
    showFilter?: boolean
  }

  let {
    filter,
    sort,
    filterOptions,
    sortOptions,
    onFilterChange,
    onSortChange,
    label,
    current,
    narrowed,
    showFilter = true
  }: Props = $props()

  const itemClass =
    'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated'
  const sectionClass =
    'px-2 pt-1.5 pb-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed'

  /**
   * A radio group reports its value as a plain string, so the option lists decide
   * whether that string names a choice this menu offers. No cast.
   */
  function handleFilterChange(value: string): void {
    const next = filterOptions.find((option) => option.id === value)
    if (next) onFilterChange(next.id)
  }

  function handleSortChange(value: string): void {
    const next = sortOptions.find((option) => option.id === value)
    if (next) onSortChange(next.id)
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex h-6 shrink-0 cursor-pointer items-center gap-1 px-1.5 text-[0.625rem] font-medium transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground {narrowed
      ? 'bg-elevated text-foreground'
      : 'text-muted'}"
    title={label}
    aria-label="{label}, currently {current}"
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
      class="z-50 w-52 overflow-hidden border border-border bg-surface py-1 shadow-xl"
    >
      {#if showFilter}
        <p class={sectionClass}>Show</p>
        <DropdownMenu.RadioGroup value={filter} onValueChange={handleFilterChange}>
          {#each filterOptions as option (option.id)}
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
      {/if}
      <p class={sectionClass}>Order by</p>
      <DropdownMenu.RadioGroup value={sort} onValueChange={handleSortChange}>
        {#each sortOptions as option (option.id)}
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
