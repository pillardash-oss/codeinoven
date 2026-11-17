import { stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { Database } from '../../database/database'
import type { AuthoredWorkKind } from '../../../lib/ipc/design'
import { currentWorkRoot } from '../work-roots-state'
import { isInsideProject, resolveServedFolder } from '../../preview/served-folder'
import { authoredWorkRoots } from './scope-roots'
import type { AuthoredWorkRoot } from './roots'

/**
 * One folder of authored work, resolved to the checkout that really holds it.
 *
 * Every surface that reads, serves, moves or exports authored work resolves its
 * folder through here, so the design board and the video board cannot disagree
 * about which checkout a design or a composition lives in.
 */
export interface AuthoredWorkFolder {
  /** The checkout holding the folder, with its git and ownership facts. */
  root: AuthoredWorkRoot
  /** Absolute folder path. */
  absolute: string
  /**
   * The spelling the board uses: project-relative for a folder inside the primary
   * root, absolute for a folder in another checkout. This is what keeps two designs
   * of the same name in two scopes apart in every record the app keeps.
   */
  display: string
  /**
   * The folder's spelling inside `root`, which is what containment-checked code
   * (the video paths, the served-folder resolver) takes.
   */
  relative: string
}

/** What one authored-work lookup is about. */
export interface AuthoredWorkQuery {
  projectId: string
  threadId: string
  kind: AuthoredWorkKind
}

/** Folders are stored with forward slashes, on every platform. */
export function slashPath(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/')
}

/** The folder's spelling relative to a root, which is what a preview is served by. */
export function rootRelativePath(root: string, absolute: string): string {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return slashPath(absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute)
}

function folderOf(root: AuthoredWorkRoot, absolute: string, display: string): AuthoredWorkFolder {
  return { root, absolute, display, relative: rootRelativePath(root.path, absolute) }
}

/**
 * Resolve one caller's folder against the roots it may live in, without searching.
 *
 * A folder the app itself listed from another root is spelled as its absolute path,
 * which is what keeps two designs of the same name in two scopes apart. Such a
 * spelling is accepted only when it sits inside one of this project's own roots, so
 * a hand-written or model-written absolute path is still refused exactly as before:
 * this resolves folders the app already owns, it does not grant permission.
 */
export function resolveAuthoredWork(
  roots: readonly AuthoredWorkRoot[],
  directory: unknown,
  kind: AuthoredWorkKind,
  projectId: string
): AuthoredWorkFolder {
  const primary = roots[0]
  if (!primary) throw new Error('This project has no folder for authored work')
  const spelled = typeof directory === 'string' ? slashPath(directory.trim()) : ''
  if (isAbsolute(spelled)) {
    const root = roots.find((candidate) => isInsideProject(candidate.path, spelled))
    if (!root) {
      throw new Error('This folder is outside every folder this project writes work into')
    }
    return folderOf(root, resolve(spelled), spelled)
  }
  const folder = resolveServedFolder(primary.path, directory, currentWorkRoot(kind, projectId))
  return folderOf(primary, folder.absolute, folder.display)
}

/**
 * Resolve one caller's folder, finding it in whichever root actually holds it.
 *
 * A relative spelling is what an agent writes (`.cio/designs/hero`), and it is
 * relative to the session's own checkout: a thread running in a scope worktree
 * names the same spelling as one in the project's checkout, and only one of them is
 * there. The primary root wins when it holds the folder, and otherwise the first
 * additional root that does is the answer, which is what lets work written in a
 * worktree be opened, exported and revealed by the spelling the agent used.
 */
export async function findAuthoredWork(
  database: Database,
  query: AuthoredWorkQuery,
  directory: unknown
): Promise<AuthoredWorkFolder> {
  const roots = await authoredWorkRoots(database, query.projectId, query.threadId)
  const direct = resolveAuthoredWork(roots, directory, query.kind, query.projectId)
  const placed = await withExistingRoot(roots, direct)
  return placed ?? direct
}

/**
 * The same lookup for one file inside a folder, named as the agent named it.
 *
 * A media file an agent asks a composition to use is spelled relative to its own
 * checkout, exactly like a folder is, so the file is what decides which checkout the
 * command is about.
 */
export async function findAuthoredWorkFile(
  database: Database,
  query: AuthoredWorkQuery,
  file: unknown
): Promise<AuthoredWorkFolder> {
  const roots = await authoredWorkRoots(database, query.projectId, query.threadId)
  const primary = roots[0]
  if (!primary) throw new Error('This project has no folder for authored work')
  const spelled = typeof file === 'string' ? slashPath(file.trim()) : ''
  if (!spelled) throw new Error('A file is required')
  if (isAbsolute(spelled)) {
    const root = roots.find((candidate) => isInsideProject(candidate.path, spelled))
    if (!root) throw new Error('This file is outside every folder this project owns')
    return folderOf(root, resolve(spelled), spelled)
  }
  const preferred = folderOf(primary, resolve(primary.path, spelled), spelled)
  const placed = await withExistingRoot(roots, preferred)
  return placed ?? preferred
}

/** Move a placement to the first root that holds it, when the named one does not. */
async function withExistingRoot(
  roots: readonly AuthoredWorkRoot[],
  direct: AuthoredWorkFolder
): Promise<AuthoredWorkFolder | null> {
  if (await exists(direct.absolute)) return direct
  if (isAbsolute(direct.display)) return null
  for (const root of roots.slice(1)) {
    const absolute = resolve(root.path, direct.display)
    if (!(await exists(absolute))) continue
    return folderOf(root, absolute, slashPath(absolute))
  }
  return null
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false
  )
}
