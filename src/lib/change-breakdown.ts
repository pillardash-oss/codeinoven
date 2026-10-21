/** One changed file, with the line counts the area grouping can weigh. */
export interface ChangeBreakdownFile {
  path: string
  additions?: number
  deletions?: number
}

/**
 * One area of a change set: a directory the changed files share, with what that
 * directory holds. `path` is project-relative and empty for the project root.
 */
export interface ChangeArea {
  path: string
  /** The area's own name: its last directory segment, or `root`. */
  label: string
  files: number
  additions: number
  deletions: number
  /** Share of the change this area holds: of the lines when known, else of the files. */
  percentage: number
}

export interface ChangeBreakdown {
  totalFiles: number
  additions: number
  deletions: number
  areas: ChangeArea[]
}

/**
 * Groups a change set by the directories its files share, so a reader sees where
 * the work happened (`components`, `storage`, `tests`) instead of a flat file list.
 *
 * The rule is one sentence: a directory holding at most four changed files is one
 * area, a bigger directory splits into child areas of three or more files, and
 * everything smaller stays with the directory itself. A directory that holds no
 * files of its own and has one child is never a step of its own, so a single deep
 * path reports its deepest real directory rather than every wrapper above it.
 *
 * This function stays self-contained (no module-scope references, no imports):
 * the main process serializes its source into a worker.
 */
export function buildChangeBreakdown(files: readonly ChangeBreakdownFile[]): ChangeBreakdown {
  /** A directory keeps every file it holds while it holds at most this many. */
  const AREA_MAX_FILES = 4
  /** A child directory only becomes an area of its own with at least this many files. */
  const MIN_SPLIT_FILES = 3
  /** Areas kept individually; the smallest remainder folds into one `other` row. */
  const MAX_AREAS = 8

  interface Node {
    path: string
    name: string
    ownFiles: number
    ownAdditions: number
    ownDeletions: number
    ownTests: number
    files: number
    additions: number
    deletions: number
    tests: number
    children: Map<string, Node>
  }
  interface Draft {
    path: string
    name: string
    files: number
    additions: number
    deletions: number
    tests: number
  }

  const isTestPath = (path: string): boolean => {
    const name = path.split('/').at(-1) ?? path
    return (
      /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|fixtures)(\/|$)/.test(path) ||
      /(^|[._-])(test|spec)([._-]|$)/.test(name) ||
      /_test\.(go|rs|py)$/.test(name) ||
      /^test_.*\.py$/.test(name)
    )
  }

  const root: Node = {
    path: '',
    name: 'root',
    ownFiles: 0,
    ownAdditions: 0,
    ownDeletions: 0,
    ownTests: 0,
    files: 0,
    additions: 0,
    deletions: 0,
    tests: 0,
    children: new Map()
  }
  const seen = new Set<string>()
  for (const file of files) {
    const path = file.path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '')
    if (!path || seen.has(path)) continue
    seen.add(path)
    const additions = Math.max(0, file.additions ?? 0)
    const deletions = Math.max(0, file.deletions ?? 0)
    const segments = path.split('/').filter(Boolean)
    const directories = segments.slice(0, -1)
    const test = isTestPath(path.toLowerCase()) ? 1 : 0
    let node = root
    node.files += 1
    node.additions += additions
    node.deletions += deletions
    node.tests += test
    for (const segment of directories) {
      let child = node.children.get(segment)
      if (!child) {
        child = {
          path: node.path ? `${node.path}/${segment}` : segment,
          name: segment,
          ownFiles: 0,
          ownAdditions: 0,
          ownDeletions: 0,
          ownTests: 0,
          files: 0,
          additions: 0,
          deletions: 0,
          tests: 0,
          children: new Map()
        }
        node.children.set(segment, child)
      }
      child.files += 1
      child.additions += additions
      child.deletions += deletions
      child.tests += test
      node = child
    }
    node.ownFiles += 1
    node.ownAdditions += additions
    node.ownDeletions += deletions
    node.ownTests += test
  }

  const collect = (node: Node): Draft[] => {
    if (node.ownFiles === 0 && node.children.size === 1) {
      const only = node.children.values().next().value
      return only ? collect(only) : []
    }
    const whole: Draft = {
      path: node.path,
      name: node.name,
      files: node.files,
      additions: node.additions,
      deletions: node.deletions,
      tests: node.tests
    }
    if (node.files <= AREA_MAX_FILES) return [whole]
    const carried: Draft = {
      path: node.path,
      name: node.name,
      files: node.ownFiles,
      additions: node.ownAdditions,
      deletions: node.ownDeletions,
      tests: node.ownTests
    }
    const drafts: Draft[] = []
    const children = [...node.children.values()].sort(
      (left, right) => right.files - left.files || (left.name < right.name ? -1 : 1)
    )
    // The project root keeps its children as areas of their own (`tests`, `scripts`)
    // because a top-level directory already names the area a reader looks for.
    // Every other directory takes its small children in, so the tree never reports
    // a run of one-file areas.
    const absorbing = node.path !== '' || children.every((child) => child.files < MIN_SPLIT_FILES)
    let absorbed: Draft | undefined
    let absorbedCount = 0
    for (const child of children) {
      if (absorbing && child.files < MIN_SPLIT_FILES) {
        carried.files += child.files
        carried.additions += child.additions
        carried.deletions += child.deletions
        carried.tests += child.tests
        absorbed = child
        absorbedCount += 1
        continue
      }
      for (const draft of collect(child)) drafts.push(draft)
    }
    if (carried.files > 0) {
      // A directory that only took one child in is that child's area, so it keeps
      // the child's name (`src` holding only `src/main` reports `main`).
      if (node.ownFiles === 0 && absorbedCount === 1 && absorbed) {
        carried.path = absorbed.path
        carried.name = absorbed.name
      }
      drafts.push(carried)
    }
    return drafts
  }

  const drafts = root.files > 0 ? collect(root) : []

  // A run that is mostly tests is the one thing a reader asks about by name, so
  // every area holding nothing but test files reports as one `tests` row.
  const owned: Draft[] = []
  let tests: Draft | undefined
  for (const draft of drafts) {
    if (draft.files === 0 || draft.tests < draft.files) {
      owned.push(draft)
      continue
    }
    tests ??= { path: '', name: 'tests', files: 0, additions: 0, deletions: 0, tests: 0 }
    tests.files += draft.files
    tests.additions += draft.additions
    tests.deletions += draft.deletions
    tests.tests += draft.tests
  }
  const grouped = tests ? [...owned, tests] : owned

  const totalLines = root.additions + root.deletions
  const weightOf = (draft: Draft): number =>
    totalLines > 0 ? draft.additions + draft.deletions : draft.files
  const totalWeight = totalLines > 0 ? totalLines : root.files
  const share = (weight: number): number =>
    totalWeight > 0 ? Number(((weight / totalWeight) * 100).toFixed(1)) : 0
  const labelCounts = new Map<string, number>()
  for (const draft of grouped) labelCounts.set(draft.name, (labelCounts.get(draft.name) ?? 0) + 1)
  /** Two areas named alike fall back to their last two segments so both stay readable. */
  const labelOf = (draft: Draft): string => {
    if ((labelCounts.get(draft.name) ?? 0) < 2) return draft.name
    const segments = draft.path.split('/').filter(Boolean)
    return segments.slice(-2).join('/') || draft.name
  }
  const areas: ChangeArea[] = grouped.map((draft) => ({
    path: draft.path,
    label: labelOf(draft),
    files: draft.files,
    additions: draft.additions,
    deletions: draft.deletions,
    percentage: share(weightOf(draft))
  }))
  areas.sort(
    (left, right) =>
      (totalLines > 0
        ? right.additions + right.deletions - (left.additions + left.deletions)
        : right.files - left.files) ||
      right.files - left.files ||
      (left.label < right.label ? -1 : 1)
  )
  if (areas.length > MAX_AREAS) {
    const rest = areas.splice(MAX_AREAS - 1)
    const folded = rest.reduce(
      (fold, area) => ({
        path: '',
        label: 'other',
        files: fold.files + area.files,
        additions: fold.additions + area.additions,
        deletions: fold.deletions + area.deletions,
        percentage: fold.percentage + area.percentage
      }),
      { path: '', label: 'other', files: 0, additions: 0, deletions: 0, percentage: 0 }
    )
    folded.percentage = Number(folded.percentage.toFixed(1))
    areas.push(folded)
  }
  return {
    totalFiles: root.files,
    additions: root.additions,
    deletions: root.deletions,
    areas
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** One compact clause per area: its line counts when known, else its file share. */
export function formatChangeArea(area: ChangeArea): string {
  const lines = area.additions + area.deletions
  return lines > 0
    ? `${area.label} +${area.additions} −${area.deletions} (${plural(area.files, 'file')})`
    : `${area.label} ${area.percentage}% (${plural(area.files, 'file')})`
}

/**
 * The plain-text summary shared by the rail tooltip, the changes panel header and
 * the pull request header. Older checkpoints stored a category list, so a
 * breakdown without areas renders as totals only.
 */
export function formatChangeSummary(
  breakdown: ChangeBreakdown | undefined | null,
  totals?: { additions: number; deletions: number; partial?: boolean } | null,
  fileCount = breakdown?.totalFiles ?? 0
): string {
  const areas = Array.isArray(breakdown?.areas) ? breakdown.areas : []
  const shown = areas.slice(0, 6)
  return [
    totals
      ? `Lines +${totals.additions} −${totals.deletions}${totals.partial ? ' (partial)' : ''}`
      : null,
    `Total ${plural(fileCount, 'file')}`,
    ...shown.map(formatChangeArea),
    areas.length > shown.length ? `${plural(areas.length - shown.length, 'more area')}` : null
  ]
    .filter(Boolean)
    .join(' · ')
}
