import { stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { ScopeManager } from '../../lib/engines/scope-manager'
import { isManagedScopeRoot } from '../../lib/types'
import { resolveThreadBoundScope } from '../../lib/bound-scope'
import type { ThreadScopeRootProvider } from '../../lib/engines/thread-manager'
import type { AuthoredWorkKind, DesignEntry } from '../../lib/ipc/design'
import { authoredWorkRoot, type AuthoredWorkRoot } from './authored-work-root'
import { listProjectWorkFolders } from './design-listing'
import {
  isInsideProject,
  resolveServedFolder,
  type ResolvedServedFolder
} from '../preview/served-folder'

/**
 * Every place one project's authored work can physically live.
 *
 * A design belongs to the project, never to one thread: it has to stay reachable
 * from every thread of that project, which is why nothing here is resolved against
 * whichever scope happens to be on screen. But a scope whose root is a managed
 * worktree is a separate checkout on disk, and an agent runs in it, so a design
 * written from a thread in that scope lands there. Reading only the project's own
 * folder is how that design became invisible from every other thread, and reading
 * only the thread's scope is how a design made in the project folder disappeared
 * the moment the user switched scope.
 *
 * So authored work is answered from all of a project's roots at once: the
 * conversation's own workspace or the project checkout (the primary root, and the
 * one new work is written into), the checkout of a project an assistant task is
 * bound to, and every managed scope worktree of that project. Listing is additive
 * and resolution picks the root a folder really lives in, so no design can be
 * hidden by the scope the user happens to be in.
 *
 * The scope authority is bound once at startup rather than threaded through every
 * capability executor: the design service, the video studio and the preview
 * executors all read authored work, and a resolver argument on each of them is how
 * one caller ends up resolving a different folder from the rest. Without a
 * provider the checkout is the only root, which is what a process that never wired
 * scopes (a test, or an Oven root standing in for one) still expects.
 */
let scopeRoots: ThreadScopeRootProvider | null = null

/** Wire the scope authority the extra authored-work roots are resolved through. */
export function installAuthoredWorkScopeRoots(provider: ThreadScopeRootProvider): void {
  scopeRoots = provider
}

/** One folder of authored work, with the root it was found in. */
export interface AuthoredWorkPlacement {
  root: AuthoredWorkRoot
  folder: ResolvedServedFolder
}

/** Folders are stored with forward slashes, on every platform. */
function slashPath(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/')
}

/**
 * How long a project's managed scope roots are reused before they are resolved
 * again.
 *
 * Resolving a managed scope can ask Git for the repository's worktrees, and a board
 * reads its listing on every thread activity. The roots are a property of the scope
 * board, which changes when the user creates or removes a scope, so a short
 * lifetime keeps a new worktree visible while a board refresh never pays for a Git
 * process per scope. The promise is cached rather than its result, so concurrent
 * reads share one resolution instead of racing for it.
 */
const SCOPE_ROOT_TTL_MS = 30_000
const scopeRootCache = new Map<string, { resolvedAt: number; roots: Promise<string[]> }>()

function managedScopeRoots(database: Database, projectId: string): Promise<string[]> {
  const now = Date.now()
  const cached = scopeRootCache.get(projectId)
  if (cached && now - cached.resolvedAt < SCOPE_ROOT_TTL_MS) return cached.roots
  const resolved = resolveManagedScopeRoots(database, projectId).catch(() => [])
  scopeRootCache.set(projectId, { resolvedAt: now, roots: resolved })
  return resolved
}

async function resolveManagedScopeRoots(database: Database, projectId: string): Promise<string[]> {
  const provider = scopeRoots
  if (!provider) return []
  const board = new ScopeManager(database).getBoard(projectId)
  const paths: string[] = []
  for (const bucket of board.buckets) {
    if (!isManagedScopeRoot(bucket.root)) continue
    // One unhealthy worktree must not cost the user every other design: the roots
    // are best-effort, and the ones that resolve are listed.
    const path = await provider.resolveCompatibilityRoot(projectId, bucket.id).catch(() => null)
    if (path) paths.push(path)
  }
  return paths
}

/**
 * All the roots one project's authored work can live in, primary first.
 *
 * The first entry is the primary root: the conversation's own workspace, or the
 * project checkout. Everything after it is an additional checkout the same work may
 * have been written into, and nothing is added twice.
 */
export async function authoredWorkRoots(
  database: Database,
  projectId: string,
  threadId?: string
): Promise<AuthoredWorkRoot[]> {
  const primary = await authoredWorkRoot(database, projectId, threadId)
  const roots: AuthoredWorkRoot[] = [primary]
  const add = (path: string, checkout: AuthoredWorkRoot): void => {
    if (roots.some((root) => root.path === path)) return
    roots.push({ ...checkout, path, appOwned: false })
  }
  const thread = threadId ? await new ThreadRepo(database).getViaWorker(threadId) : null
  const bound = resolveThreadBoundScope(thread)
  // A task bound into a project works in that project's checkout, while its own
  // workspace is where an unbound agent writes, so both are read.
  const scopeProjectId = bound !== null ? bound.projectId : primary.appOwned ? '' : projectId
  if (scopeProjectId === '') return roots
  const project = await new ProjectRepo(database).getViaWorker(scopeProjectId)
  if (project?.source !== 'local' || !project.path) return roots
  const checkout: AuthoredWorkRoot = {
    path: project.path,
    appOwned: false,
    gitMode: project.changeTrackingMode === 'git',
    assistantId: primary.assistantId
  }
  add(project.path, checkout)
  for (const path of await managedScopeRoots(database, scopeProjectId)) add(path, checkout)
  return roots
}

/**
 * Resolve one caller's folder against the roots it may live in.
 *
 * A folder the app itself listed from another root is spelled as its absolute
 * path, which is what keeps two designs of the same name in two scopes apart. Such
 * a spelling is accepted only when it sits inside one of this project's own roots,
 * so a hand-written or model-written absolute path is still refused exactly as
 * before: this resolves folders the app already owns, it does not grant permission.
 */
export function resolveAuthoredFolder(
  roots: readonly AuthoredWorkRoot[],
  directory: unknown,
  defaultRoot: string
): AuthoredWorkPlacement {
  const primary = roots[0]
  if (!primary) throw new Error('This project has no folder for authored work')
  const spelled = typeof directory === 'string' ? slashPath(directory.trim()) : ''
  if (isAbsolute(spelled)) {
    const root = roots.find((candidate) => isInsideProject(candidate.path, spelled))
    if (!root) {
      throw new Error('This folder is outside every folder this project writes work into')
    }
    return { root, folder: { absolute: resolve(spelled), display: spelled } }
  }
  return { root: primary, folder: resolveServedFolder(primary.path, directory, defaultRoot) }
}

/**
 * Resolve a folder, finding it in whichever root actually holds it.
 *
 * A relative spelling is what an agent writes (`.cio/designs/hero`), and it is
 * relative to the session's own checkout: a thread running in a scope worktree
 * names the same spelling as one in the project's checkout, and only one of them is
 * there. The primary root wins when it holds the folder, and otherwise the first
 * additional root that does is the answer, which is what lets a design written in a
 * worktree be opened, exported and revealed by the spelling the agent used.
 */
export async function findAuthoredFolder(
  roots: readonly AuthoredWorkRoot[],
  directory: unknown,
  defaultRoot: string
): Promise<AuthoredWorkPlacement> {
  const direct = resolveAuthoredFolder(roots, directory, defaultRoot)
  if (isAbsolute(direct.folder.display)) return direct
  if (await isDirectory(direct.folder.absolute)) return direct
  for (const root of roots.slice(1)) {
    const absolute = resolve(root.path, direct.folder.display)
    if (!(await isDirectory(absolute))) continue
    return { root, folder: { absolute, display: slashPath(absolute) } }
  }
  return direct
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** The folder's spelling relative to a root, which is what a preview is served by. */
export function insideRootPath(root: string, absolute: string): string {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return slashPath(absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute)
}

/**
 * The work folders of every additional root, spelled by absolute path.
 *
 * Only the canonical root folder is read, and only from disk: the project's own
 * registry is keyed by project-relative folder, so a row there cannot describe a
 * checkout the project does not own. Nothing is repeated, because a root that
 * answers with the same absolute folder is the same design.
 */
export async function listAuthoredWorkFromExtraRoots(
  roots: readonly AuthoredWorkRoot[],
  kindRoot: string,
  kind: AuthoredWorkKind = 'design'
): Promise<DesignEntry[]> {
  const folders: DesignEntry[] = []
  for (const root of roots.slice(1)) {
    const listed = await listProjectWorkFolders(root.path, kindRoot, kind)
    for (const entry of listed) {
      folders.push({ ...entry, directory: slashPath(resolve(root.path, entry.directory)) })
    }
  }
  return folders
}
