import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSISTANT_CWD_DIR, BROWSER_CWD_DIR } from '../../lib/project-artifacts'
import { getConfigRoot } from '../../lib/utils'
import {
  ASSISTANT_SPACE_ID,
  CHATS_CWD_DIR,
  DEFAULT_SCOPE_BUCKET_ID,
  GLOBAL_BROWSER_PROJECT_ID,
  INBOX_PROJECT_ID,
  isManagedScopeRoot,
  type Project,
  type ScopeBoard
} from '../../lib/types'
import type { CioCleanupTarget } from '../../lib/types/cio-cleanup'
import { CIO_SCRATCH_DIRECTORY } from '../../lib/cio-cleanup'
import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { RoutineRepo } from '../database/repositories/routine-repo'

/**
 * Every folder CIO Cleanup sweeps.
 *
 * One rule decides the list: a workspace keeps its scratch in a `.cio` folder at
 * its own root, so the sweep follows the same roots the app boots a session in.
 * Those are a project's checkout per scope, a managed scope's worktree, and the
 * three app-owned workspaces a conversation can own (a chat, an assistant
 * routine, a browser tab). The folder is only listed when it exists, and a
 * managed scope whose checkout is unhealthy is skipped rather than resolved to
 * the project root, exactly as `ScopeRootResolver` demands.
 */

export interface CioCleanupScopeResolver {
  resolve: (target: {
    projectId: string
    scopeBucketId: string
  }) => Promise<{ ok: true; root: string } | { ok: false }>
}

export interface CioCleanupTargetDeps {
  database: Database
  /** Scope boards, main-owned (never renderer state). */
  boards: { getBoard(projectId: string): ScopeBoard }
  /** The single authority that turns a scope into a filesystem root. */
  scopeRoots: CioCleanupScopeResolver
  /**
   * Whether an agent is working in the scope right now. A scope mid-turn is left
   * entirely alone, so a sweep can never remove a file out from under a run.
   */
  hasActiveProcesses?: (projectId: string, scopeBucketId: string) => Promise<boolean>
}

export async function listCioCleanupTargets(
  deps: CioCleanupTargetDeps
): Promise<CioCleanupTarget[]> {
  const targets: CioCleanupTarget[] = []
  const seen = new Set<string>()
  const projects = await new ProjectRepo(deps.database).listViaWorker()

  for (const project of projects) {
    if (project.source !== 'local' || !project.path) continue
    await appendProjectTargets(deps, project, targets, seen)
  }

  await appendAppWorkspaceTargets(
    deps.database,
    join(getConfigRoot(), CHATS_CWD_DIR),
    INBOX_PROJECT_ID,
    'Chat',
    targets,
    seen
  )
  await appendAppWorkspaceTargets(
    deps.database,
    join(getConfigRoot(), ASSISTANT_CWD_DIR),
    ASSISTANT_SPACE_ID,
    'Assistant',
    targets,
    seen
  )
  await appendAppWorkspaceTargets(
    deps.database,
    join(getConfigRoot(), BROWSER_CWD_DIR),
    GLOBAL_BROWSER_PROJECT_ID,
    'Browser',
    targets,
    seen
  )
  await appendLegacyTargets(targets, seen)

  return targets
}

/** One target per active scope of a local project: its checkout's `.cio`. */
async function appendProjectTargets(
  deps: CioCleanupTargetDeps,
  project: Project,
  targets: CioCleanupTarget[],
  seen: Set<string>
): Promise<void> {
  if (!project.path) return
  let board: ScopeBoard
  try {
    board = deps.boards.getBoard(project.id)
  } catch {
    // A board that cannot be read is not a reason to skip the project's own
    // checkout, which is the Default scope's root and needs no board to resolve.
    board = { buckets: [] } as unknown as ScopeBoard
  }

  const buckets = board.buckets.filter((bucket) => bucket.archivedAt === undefined)
  if (buckets.length === 0) {
    await pushProjectRootTarget(deps, project, DEFAULT_SCOPE_BUCKET_ID, project.name, targets, seen)
    return
  }

  for (const bucket of buckets) {
    if (bucket.root.kind === 'project') {
      await pushProjectRootTarget(
        deps,
        project,
        bucket.id,
        `${project.name} · ${bucket.name}`,
        targets,
        seen
      )
      continue
    }
    if (!isManagedScopeRoot(bucket.root)) continue
    const resolution = await deps.scopeRoots.resolve({
      projectId: project.id,
      scopeBucketId: bucket.id
    })
    if (!resolution.ok) continue
    await pushTargetIfIdle(
      deps,
      {
        id: `scope:${project.id}:${bucket.id}:${bucket.root.directoryName}`,
        kind: 'project',
        label: `${project.name} · ${bucket.name} (worktree)`,
        mounts: [{ projectId: project.id, scopeBucketId: bucket.id }],
        scratchRoot: join(resolution.root, CIO_SCRATCH_DIRECTORY)
      },
      targets,
      seen
    )
  }
}

/** One project-rooted scope's `.cio`, skipped while an agent works in that scope. */
async function pushProjectRootTarget(
  deps: CioCleanupTargetDeps,
  project: Project,
  scopeBucketId: string,
  label: string,
  targets: CioCleanupTarget[],
  seen: Set<string>
): Promise<void> {
  if (!project.path) return
  await pushTargetIfIdle(
    deps,
    {
      id: `project:${project.id}:${scopeBucketId}`,
      kind: 'project',
      label,
      mounts: [{ projectId: project.id, scopeBucketId }],
      scratchRoot: join(project.path, CIO_SCRATCH_DIRECTORY)
    },
    targets,
    seen
  )
}

/**
 * Register a target unless an agent is working in its scope.
 *
 * A run in flight is writing into the very folder the sweep walks, so the whole
 * scope is left alone until it settles. Files a run just wrote are newer than
 * any cutoff anyway; this only removes the race entirely.
 */
async function pushTargetIfIdle(
  deps: CioCleanupTargetDeps,
  target: CioCleanupTarget,
  targets: CioCleanupTarget[],
  seen: Set<string>
): Promise<void> {
  const [primaryMount] = target.mounts
  if (deps.hasActiveProcesses) {
    try {
      if (
        primaryMount &&
        (await deps.hasActiveProcesses(primaryMount.projectId, primaryMount.scopeBucketId))
      ) {
        return
      }
    } catch {
      // A probe that fails must not silently drop the folder from the sweep.
    }
  }
  pushTarget(targets, seen, target)
}

/**
 * One target per conversation workspace under an app-owned root. The
 * directories are read from disk rather than from a thread list so a workspace
 * whose row is already gone is still reclaimed, and each is labelled with the
 * thread (or routine) it belongs to.
 */
async function appendAppWorkspaceTargets(
  database: Database,
  workspaceRoot: string,
  projectId: string,
  label: string,
  targets: CioCleanupTarget[],
  seen: Set<string>
): Promise<void> {
  const workspaceIds = await listDirectoryNames(workspaceRoot)
  if (workspaceIds.length === 0) return

  const threadRepo = new ThreadRepo(database)
  const titles = await threadRepo.listTitlesViaWorker([...workspaceIds])
  const isAssistant = projectId === ASSISTANT_SPACE_ID
  const routineNames = isAssistant
    ? new Map(
        (await new RoutineRepo(database).listViaWorker()).map((routine) => [
          routine.id,
          routine.name
        ])
      )
    : new Map<string, string>()
  // A routine's workspace is mounted by every task in it, so the one directory
  // answers to the routine's own name and to each task's id. An exclusion set
  // from any task's file tree therefore protects the folder they all share.
  const taskIdsByRoutine = isAssistant
    ? await threadRepo.listAssistantTaskIdsByRoutineViaWorker(workspaceIds)
    : new Map<string, string[]>()
  const kind =
    projectId === ASSISTANT_SPACE_ID
      ? 'assistant'
      : projectId === INBOX_PROJECT_ID
        ? 'chat'
        : 'browser'

  for (const workspaceId of workspaceIds) {
    const name = routineNames.get(workspaceId) ?? titles.get(workspaceId)
    const aliases = new Set<string>([workspaceId, ...(taskIdsByRoutine.get(workspaceId) ?? [])])
    pushTarget(targets, seen, {
      id: `${projectId}:${workspaceId}`,
      kind,
      label: name ? `${label} · ${name}` : `${label} · ${workspaceId}`,
      mounts: [...aliases].map((threadId) => ({
        projectId,
        scopeBucketId: DEFAULT_SCOPE_BUCKET_ID,
        threadId
      })),
      scratchRoot: join(workspaceRoot, workspaceId, CIO_SCRATCH_DIRECTORY)
    })
  }
}

/**
 * Scratch the app used before every conversation owned a workspace, still on
 * disk under the config root. These folders are entirely app scratch, so the
 * folder itself is the sweep root, and the same staleness rule applies.
 */
async function appendLegacyTargets(targets: CioCleanupTarget[], seen: Set<string>): Promise<void> {
  const configRoot = getConfigRoot()

  for (const legacyRoot of ['chat-artifacts', 'chats-artifacts']) {
    const scratchRoot = join(configRoot, legacyRoot)
    if (!(await directoryExists(scratchRoot))) continue
    pushTarget(targets, seen, {
      id: `legacy:${legacyRoot}`,
      kind: 'legacy',
      label: `Legacy scratch · ${legacyRoot}`,
      mounts: [
        {
          projectId: INBOX_PROJECT_ID,
          scopeBucketId: DEFAULT_SCOPE_BUCKET_ID,
          threadId: legacyRoot
        }
      ],
      scratchRoot
    })
  }

  for (const chatId of await listDirectoryNames(join(configRoot, 'chats'))) {
    pushTarget(targets, seen, {
      id: `legacy:chats:${chatId}`,
      kind: 'legacy',
      label: `Legacy scratch · chat ${chatId}`,
      mounts: [
        {
          projectId: INBOX_PROJECT_ID,
          scopeBucketId: DEFAULT_SCOPE_BUCKET_ID,
          threadId: chatId
        }
      ],
      scratchRoot: join(configRoot, 'chats', chatId)
    })
  }

  for (const projectId of await listDirectoryNames(join(configRoot, 'projects'))) {
    const threadsRoot = join(configRoot, 'projects', projectId, 'threads')
    for (const threadId of await listDirectoryNames(threadsRoot)) {
      pushTarget(targets, seen, {
        id: `legacy:projects:${projectId}:${threadId}`,
        kind: 'legacy',
        label: `Legacy scratch · ${projectId}/${threadId}`,
        mounts: [{ projectId, scopeBucketId: DEFAULT_SCOPE_BUCKET_ID, threadId }],
        scratchRoot: join(threadsRoot, threadId)
      })
    }
  }
}

/** Register a target unless its scratch folder is already covered by one. */
function pushTarget(
  targets: CioCleanupTarget[],
  seen: Set<string>,
  target: CioCleanupTarget
): void {
  if (seen.has(target.scratchRoot)) return
  seen.add(target.scratchRoot)
  targets.push(target)
}

/** Directory names directly under a root, or an empty list when it is absent. */
async function listDirectoryNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter(
        (entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')
      )
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Whether a path is a directory that exists. */
async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}
