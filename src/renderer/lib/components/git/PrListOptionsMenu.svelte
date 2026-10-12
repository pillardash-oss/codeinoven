<script lang="ts">
  import type { PrListFilter, PrListSort } from '$shared/types'
  import GitListOptionsMenu from './GitListOptionsMenu.svelte'
  import {
    PR_LIST_FILTER_OPTIONS,
    PR_LIST_SORT_OPTIONS,
    prListFilterLabel,
    prListSortLabel
  } from './pr-view'

  /**
   * The pull request form of the shared filter-and-sort menu.
   *
   * Kept as its own component so the pull request list keeps a narrow, typed prop
   * surface while the presentation lives once in `GitListOptionsMenu`.
   */
  interface Props {
    filter: PrListFilter
    sort: PrListSort
    onFilterChange: (next: PrListFilter) => void
    onSortChange: (next: PrListSort) => void
  }

  let { filter, sort, onFilterChange, onSortChange }: Props = $props()

  /** A non-default choice is worth showing on the row, since it hides rows. */
  const narrowed = $derived(filter !== 'all' || sort !== 'updated')
</script>

<GitListOptionsMenu
  {filter}
  {sort}
  filterOptions={PR_LIST_FILTER_OPTIONS}
  sortOptions={PR_LIST_SORT_OPTIONS}
  {onFilterChange}
  {onSortChange}
  label="Filter and sort pull requests"
  current="{prListFilterLabel(filter)}, {prListSortLabel(sort)}"
  {narrowed}
/>
