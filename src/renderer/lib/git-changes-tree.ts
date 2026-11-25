import type { GitFileChange } from '$shared/types'

/**
 * The staging list's folder tree, and the folding that keeps it short.
 *
 * Only the shape lives here: the component owns the switches, context menus and
 * diff panels, and asks this module what the tree is and which row a directory
 * should be drawn as.
 */
export interface GitChangeTreeNode {
  /** The last path segment, e.g. `journal`. Empty for the section root. */
  name: string
  /** Whole path from the repository root, e.g. `apps/application/src/lib`. */
  path: string
  dirs: Map<string, GitChangeTreeNode>
  files: GitFileChange[]
}

/** How one directory row is drawn after single-child chains are folded in. */
export interface GitChangeDirRow {
  /** The directory whose files and subdirectories the row opens. */
  node: GitChangeTreeNode
  /** The chain of names the row names, e.g. `apps/application/src/lib`. */
  label: string
}

/** Build the folder tree of one section's files. */
export function buildChangeTree(files: readonly GitFileChange[]): GitChangeTreeNode {
  const root: GitChangeTreeNode = { name: '', path: '', dirs: new Map(), files: [] }
  for (const change of files) {
    const segments = change.path.split('/')
    let node = root
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] ?? ''
      let child = node.dirs.get(segment)
      if (!child) {
        child = {
          name: segment,
          path: segments.slice(0, index + 1).join('/'),
          dirs: new Map(),
          files: []
        }
        node.dirs.set(segment, child)
      }
      node = child
    }
    node.files.push(change)
  }
  return root
}

/** A node's subdirectories, alphabetically. */
export function sortTreeDirs(dirs: ReadonlyMap<string, GitChangeTreeNode>): GitChangeTreeNode[] {
  return [...dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Every file under a node, depth first. */
export function filesForNode(node: GitChangeTreeNode): GitFileChange[] {
  const files = [...node.files]
  for (const child of node.dirs.values()) files.push(...filesForNode(child))
  return files
}

/** Every path under a node, for staging, stashing and discarding a folder. */
export function pathsForNode(node: GitChangeTreeNode): string[] {
  return filesForNode(node).map((change) => change.path)
}

/**
 * The changed files a query names, best match first.
 *
 * A file is found by its name or by any part of its path, which is how people
 * look for one: `journal` finds the folder's files, `account` the account ones,
 * and `src/lib/design` narrows to that subtree. The name is ranked above the
 * path so a query that matches the file itself is not buried under files that
 * merely sit in a folder that happens to match.
 */
export function matchChangeFiles(
  files: readonly GitFileChange[],
  query: string,
  limit: number
): GitFileChange[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const scored: Array<{ change: GitFileChange; score: number }> = []
  for (const change of files) {
    const name = splitChangePath(change.path).name.toLowerCase()
    const path = change.path.toLowerCase()
    if (name === needle) scored.push({ change, score: 0 })
    else if (name.startsWith(needle)) scored.push({ change, score: 1 })
    else if (name.includes(needle)) scored.push({ change, score: 2 })
    else if (path.includes(needle)) scored.push({ change, score: 3 })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.change.path.localeCompare(b.change.path))
    .slice(0, limit)
    .map((entry) => entry.change)
}

/** A path split into the file it names and the folders it sits in. */
export interface ChangePathParts {
  /** The file name alone, which is what a row leads with. */
  name: string
  /** Everything before it, without a trailing slash. Empty at the root. */
  dir: string
}

/**
 * Split a repository path at its last slash.
 *
 * A row leads with the file name because that is what identifies the change;
 * the folders are context. Truncating the whole path from the right, as the
 * list used to, threw the name away first and left `…/journal/accoun…`: the one
 * word a reader needs was the one word the row dropped.
 */
export function splitChangePath(path: string): ChangePathParts {
  const slash = path.lastIndexOf('/')
  if (slash === -1) return { name: path, dir: '' }
  return { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

/**
 * Every folder above a file, outermost first.
 *
 * `apps/src/journal.ts` gives `apps`, `apps/src`: what has to be open for that
 * file's row to be on screen. The file itself is not included, and a root file
 * has no ancestors.
 */
export function ancestorDirPaths(path: string): string[] {
  const segments = path.split('/')
  const dirs: string[] = []
  for (let index = 1; index < segments.length; index += 1) {
    dirs.push(segments.slice(0, index).join('/'))
  }
  return dirs
}

/**
 * The sections the Changes view draws, in the order it draws them.
 *
 * The tree keys a folder's open state by the section it is listed in, so the
 * thing that reveals a searched file has to know these names to open the right
 * folders.
 */
export const CHANGE_SECTION_TITLES = ['Conflicts', 'Staged', 'Unstaged', 'Untracked'] as const

/**
 * The open-state keys of a folder and everything under it.
 *
 * A folder's own expand-all control acts on this whole subtree, which is why it
 * is a list of keys and not a flag: the tree stores open state per row, and the
 * rows further down are not reachable from the parent without walking it.
 */
export function subtreeDirKeys(node: GitChangeTreeNode, sectionKey: string): string[] {
  const keys = [dirExpansionKey(sectionKey, node.path)]
  for (const child of node.dirs.values()) keys.push(...subtreeDirKeys(child, sectionKey))
  return keys
}

/**
 * The key a folder's open state is stored under.
 *
 * The same directory appears in Staged, Unstaged and Untracked whenever the same
 * tree is touched on both sides of the index, so the section is part of the key:
 * keyed by the path alone, opening `apps` under Untracked also opened the staged
 * run of `apps`, and folding one folded the other.
 */
export function dirExpansionKey(sectionKey: string, path: string): string {
  return `${sectionKey}\u0000${path}`
}

/**
 * Fold a directory's single-child chain into one row.
 *
 * `apps` → `application` → `src` → `lib`, where each step holds exactly one
 * child and no files of its own, is one directory in everything but name, and
 * four rows to reach the first place a file can be chosen. The folded row names
 * the whole chain (`apps/application/src/lib`) and points at the deepest node,
 * so the count, the open state and the folder actions still describe exactly the
 * same files as before: only the number of rows changes.
 *
 * A directory that holds files of its own stops the fold, because its files have
 * to stay under the name the reader knows them by, and so does one that branches.
 */
export function compressDirChain(node: GitChangeTreeNode): GitChangeDirRow {
  let deepest = node
  let label = node.name
  while (deepest.files.length === 0 && deepest.dirs.size === 1) {
    const child = deepest.dirs.values().next().value
    if (!child) break
    deepest = child
    label = `${label}/${child.name}`
  }
  return { node: deepest, label }
}
