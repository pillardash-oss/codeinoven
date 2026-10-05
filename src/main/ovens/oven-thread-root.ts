import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { usesThreadWorkspaceMount } from '../../lib/types'
import type { Project, Thread } from '../../lib/types'
import type { OvenService } from './oven-service'
import { ovenScopeRoot } from './remote/oven-root-paths'

const execute = promisify(execFile)

/** What one GitHub origin looks like, whatever form the remote was saved in. */
const GITHUB_ORIGIN =
  /^(?:git@github\.com:|https?:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/iu

/** One authoritative remote checkout for a thread, plus the project it came from. */
export interface OvenThreadRoot {
  ovenId: string
  root: string
  /** Local checkout the repository came from, when this project has one. */
  localRepository?: string
  /** GitHub SSH URL the Oven must clone, when the project has a GitHub origin. */
  origin?: string
}

/**
 * The single checkout a remote thread reads and writes through.
 *
 * Chat, the file tree, Git panels, and every root action resolve here, so they
 * can never disagree about which directory a thread works in. A thread with an
 * explicit `ovenPath` keeps it; otherwise the scope-owned directory is prepared
 * on the Oven, cloned from the project's GitHub origin when there is one, and
 * left exactly as it stands when it already exists.
 */
export async function resolveOvenThreadRoot(
  service: OvenService,
  thread: Thread,
  projects: { getProject(id: string): Promise<Project | null> }
): Promise<OvenThreadRoot> {
  const ovenId = thread.settings?.ovenId
  if (!ovenId || ovenId === 'local') throw new Error('This thread has no remote Oven.')
  const project = await projects.getProject(thread.projectId)
  const localRepository = project?.source === 'local' ? project.path : undefined
  if (thread.settings?.ovenPath)
    return {
      ovenId,
      root: thread.settings.ovenPath,
      ...(localRepository ? { localRepository } : {})
    }
  const probe = await service.probe(ovenId)
  const scopeId = usesThreadWorkspaceMount(thread.projectId)
    ? thread.id
    : thread.scopeBucketId || 'default'
  const root = ovenScopeRoot(probe.home, thread.projectId, scopeId)
  const origin = localRepository ? await githubOrigin(localRepository) : null
  const prepared = await service.workspace(
    ovenId,
    origin ? { operation: 'clone', root, url: origin } : { operation: 'ensure', root },
    localRepository
  )
  return {
    ovenId,
    root: prepared.root,
    ...(localRepository ? { localRepository } : {}),
    ...(origin ? { origin } : {})
  }
}

/**
 * The project's GitHub origin in SSH form, or null for anything else.
 *
 * The clone runs on the Oven over SSH, so an HTTPS remote is rewritten to its
 * SSH equivalent rather than guessed at with a credential the Oven never holds.
 */
async function githubOrigin(repository: string): Promise<string | null> {
  const remote = await execute('git', ['-C', repository, 'remote', 'get-url', 'origin'], {
    timeout: 5_000,
    maxBuffer: 16 * 1024
  }).catch(() => null)
  const match = remote?.stdout.trim().match(GITHUB_ORIGIN)
  return match ? `git@github.com:${match[1]}/${match[2]}.git` : null
}
