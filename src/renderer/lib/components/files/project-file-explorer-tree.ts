import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { ProjectFileEntry } from '$shared/types'
import { posixDirname } from '$shared/paths'
import type { AppBridge } from '../../../../preload/index'
import { isCioScratchPath } from '$lib/stores/cio-search-visibility.svelte'

declare global {
  interface Window {
    api: AppBridge
  }
}

export const TREE_ROW_HEIGHT = 28
export const TREE_VERTICAL_PADDING = 4
export const TREE_OVERSCAN = 8

export interface EntryTreeRow {
  kind: 'entry'
  key: string
  entry: ProjectFileEntry
  depth: number
}

export interface CreateTreeRow {
  kind: 'create'
  key: string
  directory: string
  depth: number
}

export interface ErrorTreeRow {
  kind: 'error'
  key: string
  entry: ProjectFileEntry
  depth: number
  message: string
}

export type TreeRow = EntryTreeRow | CreateTreeRow | ErrorTreeRow

export interface VirtualTreeRow {
  row: TreeRow
  offset: number
}

export type InlineEdit =
  | { kind: 'create'; directory: string; value: string }
  | { kind: 'create-directory'; directory: string; value: string }
  | { kind: 'rename'; entry: ProjectFileEntry; value: string }

/** Everything the filtered tree render depends on, passed explicitly so the
 *  tree rules stay pure and testable outside the component. */
export interface TreeFilterInput {
  entriesByDirectory: Record<string, ProjectFileEntry[]>
  expandedDirectories: Record<string, boolean>
  directoryErrors: Record<string, string>
  inlineEdit: InlineEdit | null
  filterQuery: string
  lastTurnOnly: boolean
  conflictsOnly: boolean
  lastTurnPathSet: ReadonlySet<string>
  conflictPathSet: ReadonlySet<string>
  filterOpen: boolean
  includeCio: boolean
  searchResultPaths: ReadonlySet<string>
  searchResultsQuery: string
  searchResultDirectories: ReadonlySet<string>
  collapsedOverrides: ReadonlySet<string>
}

export function parentDirectory(path: string): string {
  return posixDirname(path)
}

export function pasteDirectory(entry: ProjectFileEntry | null): string {
  if (!entry) return ''
  return entry.kind === 'directory' ? entry.path : parentDirectory(entry.path)
}

export function selectionPathsFor(
  entry: ProjectFileEntry | null,
  selectedPaths: string[]
): string[] {
  if (!entry) return selectedPaths
  if (selectedPaths.includes(entry.path)) return selectedPaths
  return [entry.path]
}

export function selectionLabel(paths: string[]): string {
  return paths.length === 1 ? 'Item' : `${paths.length} items`
}

/** Whether any path in `paths` sits inside `path` (or is `path`). */
export function directoryContainsPath(paths: ReadonlySet<string>, path: string): boolean {
  const prefix = path ? `${path}/` : ''
  for (const candidate of paths) {
    if (candidate.startsWith(prefix)) return true
  }
  return false
}

/** Directories that contain (or are) a backend search result, derived once per
 *  result set instead of per row per render. */
export function collectSearchResultDirectories(paths: Iterable<string>): SvelteSet<string> {
  const directories = new SvelteSet<string>()
  for (const resultPath of paths) {
    const segments = resultPath.split('/')
    segments.pop()
    for (let index = 1; index <= segments.length; index++) {
      directories.add(segments.slice(0, index).join('/'))
    }
  }
  return directories
}

export function collectAncestorDirectories(paths: readonly string[]): string[] {
  const directories = new SvelteSet<string>()
  for (const entry of paths) {
    const segments = entry.split('/')
    segments.pop()
    for (let index = 0; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index + 1).join('/'))
    }
  }
  return [...directories].sort((left, right) => left.split('/').length - right.split('/').length)
}

/** Whether an entry survives the active filter session (search + last turn +
 *  conflicts). Directories survive when any descendant matches. */
function matchesActiveFilter(
  entry: ProjectFileEntry,
  query: string,
  queryMatches: Record<string, boolean>,
  input: TreeFilterInput
): boolean {
  // While a search session is open with `.cio` excluded, hide every entry
  // inside the scratch directory regardless of the query.
  if (!input.includeCio && input.filterOpen && isCioScratchPath(entry.path)) {
    return false
  }
  const matchesLastTurn =
    !input.lastTurnOnly ||
    (entry.kind === 'file'
      ? input.lastTurnPathSet.has(entry.path)
      : directoryContainsPath(input.lastTurnPathSet, entry.path))
  if (!matchesLastTurn) return false
  const matchesConflicts =
    !input.conflictsOnly ||
    (entry.kind === 'file'
      ? input.conflictPathSet.has(entry.path)
      : directoryContainsPath(input.conflictPathSet, entry.path))
  if (!matchesConflicts) return false
  if (!query) return true
  // Fresh backend results are the source of truth: files match by result
  // membership, directories by being (or containing) a result. This keeps
  // intention-based queries ("settings/", "settings/*") showing the files
  // inside a matched directory, which local name matching would hide.
  if (input.searchResultsQuery === query) {
    return entry.kind === 'file'
      ? input.searchResultPaths.has(entry.path)
      : input.searchResultPaths.has(entry.path) || input.searchResultDirectories.has(entry.path)
  }
  // Fallback while the backend search is still in flight: match names
  // locally so the tree does not flash empty between keystrokes.
  return (
    entry.name.toLocaleLowerCase().includes(query) ||
    (entry.kind === 'directory' && (queryMatches[entry.path] ?? false))
  )
}

/** For every loaded directory, whether any entry in its subtree matches the
 *  active filter. Computed once bottom-up (deepest folders first, so a
 *  parent's result reuses its children's) per filter change instead of being
 *  re-derived recursively on every tree render. */
export function computeFilterMatchesByDirectory(input: TreeFilterInput): Record<string, boolean> {
  const matches: Record<string, boolean> = {}
  const query = input.filterQuery.trim().toLocaleLowerCase()
  const loaded = input.entriesByDirectory
  if (!query) return matches

  const directories = Object.keys(loaded).sort(
    (left, right) => right.split('/').length - left.split('/').length
  )
  for (const directory of directories) {
    const children = loaded[directory] ?? []
    matches[directory] = children.some((entry) => matchesActiveFilter(entry, query, matches, input))
  }
  return matches
}

export function visibleEntries(
  directory: string,
  input: TreeFilterInput,
  filterMatches: Record<string, boolean>
): ProjectFileEntry[] {
  const query = input.filterQuery.trim().toLocaleLowerCase()
  const entries = input.entriesByDirectory[directory] ?? []
  return entries.filter((entry) => matchesActiveFilter(entry, query, filterMatches, input))
}

export function shouldRenderDirectory(path: string, input: TreeFilterInput): boolean {
  // A deliberate fold during a filter session hides the subtree even when
  // the filter would otherwise force-render it as a matching ancestor.
  if (input.collapsedOverrides.has(path)) return false
  if (input.expandedDirectories[path]) return true
  if (input.lastTurnOnly && directoryContainsPath(input.lastTurnPathSet, path)) return true
  if (input.conflictsOnly && directoryContainsPath(input.conflictPathSet, path)) return true
  // Search matching controls which directory rows are visible. The search
  // effect already expands and loads every ancestor of each result, so a
  // matching but collapsed directory must not render its descendants.
  return false
}

/** Flatten the expanded tree into fixed-height display rows. Keeping the full
 *  model in memory is cheap; the virtual slice limits component and DOM
 *  creation to the viewport plus overscan. */
export function buildTreeRows(
  input: TreeFilterInput,
  filterMatches: Record<string, boolean>
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (directory: string, depth: number): void => {
    const edit = input.inlineEdit
    if (
      (edit?.kind === 'create' || edit?.kind === 'create-directory') &&
      edit.directory === directory
    ) {
      rows.push({
        kind: 'create',
        key: `create:${directory}`,
        directory,
        depth
      })
    }
    for (const entry of visibleEntries(directory, input, filterMatches)) {
      rows.push({ kind: 'entry', key: `entry:${entry.path}`, entry, depth })
      if (entry.kind !== 'directory') continue
      const error = input.directoryErrors[entry.path]
      if (input.expandedDirectories[entry.path] && error) {
        rows.push({
          kind: 'error',
          key: `error:${entry.path}`,
          entry,
          depth,
          message: error
        })
      } else if (shouldRenderDirectory(entry.path, input)) {
        walk(entry.path, depth + 1)
      }
    }
  }
  walk('', 0)
  return rows
}

export function buildEntryRowIndex(rows: readonly TreeRow[]): SvelteMap<string, number> {
  const indexByPath = new SvelteMap<string, number>()
  rows.forEach((row, index) => {
    if (row.kind === 'entry') indexByPath.set(row.entry.path, index)
  })
  return indexByPath
}

export function buildEntryIndexFromEntries(
  entries: readonly ProjectFileEntry[]
): SvelteMap<string, number> {
  const indexByPath = new SvelteMap<string, number>()
  entries.forEach((entry, index) => indexByPath.set(entry.path, index))
  return indexByPath
}

export function buildRowIndexByKey(rows: readonly TreeRow[]): SvelteMap<string, number> {
  const indexByKey = new SvelteMap<string, number>()
  rows.forEach((row, index) => indexByKey.set(row.key, index))
  return indexByKey
}

export function computeVirtualTree(
  rows: readonly TreeRow[],
  scrollTop: number,
  viewportHeight: number
): { rows: VirtualTreeRow[]; total: number } {
  const total = rows.length * TREE_ROW_HEIGHT
  if (rows.length === 0) return { rows: [], total }
  const viewport = Math.max(viewportHeight, TREE_ROW_HEIGHT)
  const maxScrollTop = Math.max(0, total + TREE_VERTICAL_PADDING * 2 - viewport)
  const effectiveTop = Math.min(scrollTop, maxScrollTop)
  const contentTop = Math.max(0, effectiveTop - TREE_VERTICAL_PADDING)
  const start = Math.max(0, Math.floor(contentTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN)
  const end = Math.min(
    rows.length,
    Math.ceil((contentTop + viewport) / TREE_ROW_HEIGHT) + TREE_OVERSCAN
  )
  const virtualRows: VirtualTreeRow[] = []
  for (let index = start; index < end; index += 1) {
    virtualRows.push({ row: rows[index], offset: index * TREE_ROW_HEIGHT })
  }
  return { rows: virtualRows, total }
}

/** Resolve absolute paths for OS-dropped File objects (folder/file). */
export function droppedFilePaths(files: FileList | null): string[] {
  if (!files) return []
  const paths: string[] = []
  for (const file of Array.from(files)) {
    try {
      const path = window.api.getPathForFile(file)
      if (path) paths.push(path)
    } catch {
      // Not a local file; skip.
    }
  }
  return paths
}

/** Resolve absolute paths from an OS file paste (uses items, like the composer). */
export function pastedFilePaths(data: DataTransfer | null): string[] {
  if (!data) return []
  const paths: string[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (!file) continue
    try {
      const path = window.api.getPathForFile(file)
      if (path) paths.push(path)
    } catch {
      // Pasted item is not a local file; skip.
    }
  }
  return paths
}
