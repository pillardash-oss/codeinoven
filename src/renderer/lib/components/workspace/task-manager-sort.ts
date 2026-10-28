/**
 * The task manager's ordering, kept as plain logic so the modal and its sort
 * menu only carry state and markup.
 *
 * One key is chosen at a time and the direction flips that key. Equal values
 * never reshuffle between the manager's 5s polls: name, then project, then a
 * stable row id break every tie, always ascending, so two rows with the same
 * RAM reading keep the same order instead of trading places on every refresh.
 */

/** The column the list is ordered by. */
export type TaskSortKey = 'memory' | 'cpu' | 'name' | 'project'

/** Which way the chosen key runs. */
export type TaskSortDirection = 'asc' | 'desc'

/** One ordering: the key and its direction. */
export interface TaskSort {
  key: TaskSortKey
  direction: TaskSortDirection
}

/** Every key, in the order the menu lists them: resources first, then name,
 *  then project. */
export const TASK_SORT_KEYS: readonly TaskSortKey[] = ['memory', 'cpu', 'name', 'project']

export const TASK_SORT_LABELS: Record<TaskSortKey, string> = {
  memory: 'Memory',
  cpu: 'CPU',
  name: 'Name',
  project: 'Project'
}

export const TASK_SORT_HINTS: Record<TaskSortKey, string> = {
  memory: 'Order by the memory each row uses',
  cpu: 'Order by the CPU each row uses',
  name: 'Order alphabetically by name',
  project: 'Order by the project that owns the row'
}

/** Resources are read as "the heaviest first", text as "A to Z". */
export function defaultDirectionFor(key: TaskSortKey): TaskSortDirection {
  return key === 'memory' || key === 'cpu' ? 'desc' : 'asc'
}

/** Memory, heaviest first: the ordering the manager opens with. */
export const DEFAULT_TASK_SORT: TaskSort = {
  key: 'memory',
  direction: defaultDirectionFor('memory')
}

/** One comparable row, whatever it represents: a process, a service, or a whole
 *  owner node. */
export interface SortableRow {
  /** The name shown on the row. */
  label: string
  /** The project that owns the row; app-owned rows pass the app's own name. */
  projectLabel: string
  memoryBytes: number
  cpuPercent: number
  /** Final, unique tie-break so the order is total and stable. */
  sortId: string
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' })
}

function comparePrimary(a: SortableRow, b: SortableRow, key: TaskSortKey): number {
  switch (key) {
    case 'memory':
      return a.memoryBytes - b.memoryBytes
    case 'cpu':
      return a.cpuPercent - b.cpuPercent
    case 'name':
      return compareText(a.label, b.label)
    case 'project':
      return compareText(a.projectLabel, b.projectLabel)
  }
}

/** Compare two rows by the current sort, then by name, project and id. */
export function compareSortRows(a: SortableRow, b: SortableRow, sort: TaskSort): number {
  const primary = comparePrimary(a, b, sort.key)
  if (primary !== 0) return sort.direction === 'asc' ? primary : -primary
  if (sort.key !== 'name') {
    const byName = compareText(a.label, b.label)
    if (byName !== 0) return byName
  }
  if (sort.key !== 'project') {
    const byProject = compareText(a.projectLabel, b.projectLabel)
    if (byProject !== 0) return byProject
  }
  return compareText(a.sortId, b.sortId)
}
