import type {
  ManagedWorktreeDescriptor,
  ScopeSetupCommandRecord,
  ScopeSetupCommandSpec,
  ScopeWorktreeProgress
} from '../../../lib/types'
import type { ScopeManager } from '../../../lib/engines/scope-manager'
import type { ProjectManager } from '../../../lib/engines/project-manager'
import { runSetupCommand } from '../scope-worktree-process'
import { propagateEnvironment } from './scope-worktree-environment'

function bucketIdFor(
  scopes: ScopeManager,
  projectId: string,
  descriptor: ManagedWorktreeDescriptor
): string {
  const board = scopes.getBoard(projectId)
  const bucket = board.buckets.find(
    (candidate) =>
      candidate.root.kind === 'worktree' &&
      candidate.root.directoryName === descriptor.directoryName
  )
  if (!bucket) throw new Error(`No bucket owns ${descriptor.directoryName}`)
  return bucket.id
}

/**
 * Propagate environment files, then run ordered setup commands sequentially.
 * When resuming, `resume.startIndex` skips already-succeeded commands and
 * their records are carried into the persisted status.
 */
export async function runEnvironmentAndSetup(
  scopes: ScopeManager,
  projects: Pick<ProjectManager, 'getProject'>,
  projectId: string,
  worktreePath: string,
  descriptor: ManagedWorktreeDescriptor,
  commands: ScopeSetupCommandSpec[],
  progress?: (event: ScopeWorktreeProgress) => void,
  resume?: { startIndex: number }
): Promise<void> {
  await propagateEnvironment(
    projects,
    projectId,
    worktreePath,
    descriptor.environmentMode,
    progress
  )

  const startIndex = resume?.startIndex ?? 0
  const carried: ScopeSetupCommandRecord[] =
    resume?.startIndex === undefined
      ? []
      : commands.slice(0, startIndex).map((spec, index) => ({
          index,
          executable: spec.executable,
          args: spec.args,
          state: 'succeeded' as const
        }))
  progress?.({ stage: 'setup', detail: String(startIndex) })

  const records: ScopeSetupCommandRecord[] = [...carried]
  const startedAt = Date.now()
  scopes.attachManagedRoot(projectId, bucketIdFor(scopes, projectId, descriptor), {
    ...descriptor,
    setup: { state: 'running', commands: [...carried], startedAt }
  })

  for (let index = startIndex; index < commands.length; index += 1) {
    const spec = commands[index]
    if (!spec) continue
    const record: ScopeSetupCommandRecord = {
      index,
      executable: spec.executable,
      args: spec.args,
      state: 'running',
      startedAt: Date.now()
    }
    records.push(record)
    progress?.({ stage: 'setup', detail: String(index + 1) })
    let result
    try {
      result = await runSetupCommand(spec, { cwd: worktreePath })
    } catch (error) {
      // Missing executable or spawn failure: mark interrupted/preserve.
      records[index] = { ...record, state: 'interrupted', finishedAt: Date.now() }
      scopes.attachManagedRoot(projectId, bucketIdFor(scopes, projectId, descriptor), {
        ...descriptor,
        setup: { state: 'interrupted', commands: records, startedAt, finishedAt: Date.now() }
      })
      throw error
    }
    records[index] = {
      ...record,
      state: result.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: result.exitCode,
      finishedAt: Date.now()
    }
    if (result.exitCode !== 0) {
      scopes.attachManagedRoot(projectId, bucketIdFor(scopes, projectId, descriptor), {
        ...descriptor,
        setup: {
          state: 'failed',
          commands: records.map((entry) => ({ ...entry })),
          startedAt,
          finishedAt: Date.now()
        }
      })
      progress?.({ stage: 'failed', detail: spec.executable })
      throw new Error(`Setup command ${index + 1} failed (${spec.executable})`)
    }
  }

  scopes.attachManagedRoot(projectId, bucketIdFor(scopes, projectId, descriptor), {
    ...descriptor,
    setup: {
      state: 'succeeded',
      commands: records.map((entry) => ({ ...entry })),
      startedAt,
      finishedAt: Date.now()
    }
  })
  progress?.({ stage: 'done' })
}
