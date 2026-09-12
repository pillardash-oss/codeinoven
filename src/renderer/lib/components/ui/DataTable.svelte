<script module lang="ts">
  /**
   * Definition for one column of a {@link DataTable}.
   * `key` doubles as the sort key: `null` marks a non-sortable column.
   */
  export interface DataTableColumn<
    Row,
    SortKey extends string = string,
    Sortable extends boolean = boolean
  > {
    /** Unique column identifier. `null` renders a non-sortable column. */
    key: Sortable extends true ? SortKey : SortKey | null
    /** Header text. */
    header: string
    /** Extra classes for the `<th>` (e.g. `sr-only` for action columns). */
    headerClass?: string
    /** Extra classes for every body cell of this column (e.g. `tabular-nums`). */
    cellClass?: string
    /** Column width hint applied to the header cell (e.g. `w-10`). */
    width?: string
    /** Cell alignment. Defaults to `left`. */
    align?: 'left' | 'right'
    /** Sort accessor. `null` values sink below non-null ones in both directions. */
    sortValue?: (row: Row) => string | number | null
    /**
     * Full custom comparator, used instead of `sortValue` when provided.
     * `direction` is `1` for ascending and `-1` for descending so primary
     * comparison keys can be flipped while tie-breakers stay direction-neutral.
     */
    compare?: (left: Row, right: Row, direction: 1 | -1) => number
    /** Direction applied when the column first becomes active. Defaults to `desc`. */
    defaultDirection?: DataTableSortDirection
  }

  export type DataTableSortDirection = 'asc' | 'desc'
</script>

<script lang="ts" generics="Row, SortKey extends string">
  import type { Snippet } from 'svelte'
  import { ArrowDown, ArrowUp } from '@lucide/svelte'

  interface Props {
    rows: Row[]
    columns: ReadonlyArray<DataTableColumn<Row, SortKey>>
    /** Stable row identity for keyed updates. */
    getRowId: (row: Row) => string
    /** Accessible name for the table. */
    label: string
    /** Renders the content of one body cell for `row` in `column`. */
    cell: Snippet<[Row, DataTableColumn<Row, SortKey>]>
    /** Allow a third click on the active column to reset to the default order. */
    clearable?: boolean
    /** Column active before any header click. */
    initialSortKey?: SortKey | null
    /** Direction applied with {@link Props.initialSortKey}. Defaults to `desc`. */
    initialSortDirection?: DataTableSortDirection
  }

  let {
    rows,
    columns,
    getRowId,
    label,
    cell,
    clearable = false,
    initialSortKey = null,
    initialSortDirection = 'desc'
  }: Props = $props()

  // Initial-only capture is intentional: the caller seeds the sort state,
  // then the table owns it for the rest of its lifetime.
  // svelte-ignore state_referenced_locally
  let sortKey = $state<SortKey | null>(initialSortKey)
  // svelte-ignore state_referenced_locally
  let sortDirection = $state<DataTableSortDirection>(initialSortDirection)

  const activeColumn = $derived(
    sortKey === null ? undefined : columns.find((column) => column.key === sortKey)
  )
  const sortedRows = $derived.by(() => {
    const column = activeColumn
    if (!column) return rows
    const direction: 1 | -1 = sortDirection === 'asc' ? 1 : -1
    return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const result = compareRows(left.row, right.row, column, direction)
        // Equal keys keep the caller-provided default order.
        return result !== 0 ? result : left.index - right.index
      })
      .map((entry) => entry.row)
  })

  function compareRows(
    left: Row,
    right: Row,
    column: DataTableColumn<Row, SortKey>,
    direction: 1 | -1
  ): number {
    if (column.compare) return column.compare(left, right, direction)
    const leftValue = column.sortValue ? column.sortValue(left) : null
    const rightValue = column.sortValue ? column.sortValue(right) : null
    // Nulls (missing values) sink below scored ones regardless of direction.
    if (leftValue === null || rightValue === null) {
      if (leftValue === rightValue) return 0
      return leftValue === null ? 1 : -1
    }
    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      return (leftValue - rightValue) * direction
    }
    return String(leftValue).localeCompare(String(rightValue), 'en-US') * direction
  }

  function toggleSort(column: DataTableColumn<Row, SortKey>): void {
    if (column.key === null) return
    const fallback: DataTableSortDirection = column.defaultDirection ?? 'desc'
    if (sortKey !== column.key) {
      sortKey = column.key
      sortDirection = fallback
      return
    }
    if (sortDirection === fallback) {
      sortDirection = fallback === 'desc' ? 'asc' : 'desc'
      return
    }
    if (clearable) {
      // Third click on the same column restores the caller-provided order.
      sortKey = null
      sortDirection = 'desc'
      return
    }
    sortDirection = fallback
  }

  function sortTitle(column: DataTableColumn<Row, SortKey>): string {
    if (column.key === null || sortKey !== column.key) return `Sort by ${column.header}`
    const descending = sortDirection === 'desc'
    const nextAction = descending
      ? 'click for low to high'
      : clearable
        ? 'click to reset to the default order'
        : 'click for high to low'
    return `${column.header} sorted ${descending ? 'high to low' : 'low to high'}, ${nextAction}`
  }

  function ariaSort(column: DataTableColumn<Row, SortKey>): 'ascending' | 'descending' | 'none' {
    if (column.key === null || sortKey !== column.key) return 'none'
    return sortDirection === 'asc' ? 'ascending' : 'descending'
  }
</script>

<div class="overflow-x-auto rounded-xl border bg-surface">
  <table class="w-full text-left text-xs" aria-label={label}>
    <thead>
      <tr class="border-b text-[0.6875rem] uppercase tracking-wide text-muted">
        {#each columns as column (column.header)}
          <th
            scope="col"
            class="px-4 py-2 font-medium {column.width ?? ''} {column.headerClass ?? ''}"
            aria-sort={ariaSort(column)}
          >
            {#if column.key !== null}
              <button
                type="button"
                class="flex items-center gap-1 transition-colors hover:text-foreground {sortKey ===
                column.key
                  ? 'text-foreground'
                  : ''}"
                title={sortTitle(column)}
                aria-label={`${column.header}: ${sortTitle(column)}`}
                onclick={() => toggleSort(column)}
              >
                {column.header}
                {#if sortKey === column.key}
                  {#if sortDirection === 'desc'}
                    <ArrowDown size={11} class="shrink-0 text-primary" aria-hidden="true" />
                  {:else}
                    <ArrowUp size={11} class="shrink-0 text-primary" aria-hidden="true" />
                  {/if}
                {/if}
              </button>
            {:else}
              <span class="{column.align === 'right' ? 'text-right' : ''}">{column.header}</span>
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody class="divide-y">
      {#each sortedRows as row (getRowId(row))}
        <tr>
          {#each columns as column (column.header)}
            <td
              class="px-4 py-3 {column.cellClass ?? ''} {column.align === 'right' ? 'text-right' : ''}"
            >
              {@render cell(row, column)}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
