import type { Database } from '../../database/database'
import { ProjectRepo } from '../../database/repositories/project-repo'
import { ThreadRepo } from '../../database/repositories/thread-repo'
import { ScopeManager } from '../../../lib/engines/scope-manager'
import { isManagedScopeRoot } from '../../../lib/types'
import { resolveThreadBoundScope } from '../../../lib/bound-scope'
import type { ThreadScopeRootProvider } from '../../../lib/engines/thread-manager'
import { authoredWorkRoot, type AuthoredWorkRoot } from './roots'

/**
 * Every checkout one project's authored work can physically live in.
 *
 * A design or a composition belongs to the project, never to one thread: it has to
 * stay reachable from every thread of that project, so nothing here is resolved
 * against whichever scope happens to be on screen. But a scope whose root is a
 * managed worktree is a separate checkout on disk, and an agent runs in it, so work
 * written from a thread in that scope lands there. Reading only the project's own
 * folder is how that work became invisible from every other thread, and reading
 * only the thread's scope is how work made in the project folder disappeared the
 * moment the user switched scope.
 *
 * So authored work is answered from all of a project's roots at once: the
 * conversation's own workspace or the project checkout (the primary root, and the
 * one new work is written into), the checkout of a project an assistant task is
 * bound to, and every managed scope worktree of that project.
 *
 * The scope authority is bound once at startup rather than threaded through every
 * capability executor: the design board, the video board and the preview executors
 * all read authored work, and a resolver argument on each of them is how one caller
 * ends up resolving a different folder from the rest. Without a provider the
 * checkout is the only root, which is what a process that never wired scopes (a
 * test, or an Oven root standing in for one) still expects.
 */
let scopeRoots: ThreadScopeRootProvider | null = null

/** Wire the scope authority the additional authored-work roots are resolved through. */
export function installAuthoredWorkScopeRoots(provider: ThreadScopeRootProvider): void {
  scopeRoots = provider
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
