/**
 * Read-only projections of a scope: the summary the tool reports, the detailed
 * status, and the conflict state. Every function takes its dependencies
 * explicitly so the service stays the composition root.
 */

import { getScopeRootPath } from '../../../lib/utils'
import { APP_SCOPE_UTILITY_ID } from '../../../lib/utility-ids'
import type { GitStatus, ScopeBoard, ScopeBucket, ScopeWorktreeHealth } from '../../../lib/types'
import type { ScopeThreadLifecycle } from '../../git/scope-worktree-service'
import { conflictNextStep } from './scope-tool-destructive'
import type { ScopeSummary } from './scope-tool-types'

export interface ScopeReadDeps {
  scopes: { getBoard(projectId: string): ScopeBoard }
  worktrees: {
    health(target: { projectId: string; scopeBucketId: string }): Promise<ScopeWorktreeHealth>
  }
  git: { getStatus(projectPath: string): Promise<GitStatus> }
  options: { scopeThreads?: ScopeThreadLifecycle }
}

export interface ScopeReadContext {
  projectId: string
  scopeBucketId: string
}

export async function summarizeBucket(
  deps: ScopeReadDeps,
  context: ScopeReadContext,
  projectPath: string,
  bucket: ScopeBucket
): Promise<ScopeSummary> {
  const threadCount =
    (await deps.options.scopeThreads?.countThreadsInScope(context.projectId, bucket.id)) ?? 0
  if (bucket.root.kind !== 'worktree') {
    return {
      id: bucket.id,
      name: bucket.name,
      kind: 'project',
      path: projectPath,
      threadCount,
      archived: bucket.archivedAt !== undefined,
      pinned: bucket.pinned === true,
      active: bucket.id === context.scopeBucketId
    }
  }
  return {
    id: bucket.id,
    name: bucket.name,
    kind: 'worktree',
    path: getScopeRootPath(context.projectId, bucket.root.directoryName),
    branch: bucket.root.branch,
    baseBranch: bucket.root.baseBranch,
    directoryName: bucket.root.directoryName,
    setupState: bucket.root.setup.state,
    health: await deps.worktrees.health({
      projectId: context.projectId,
      scopeBucketId: bucket.id
    }),
    threadCount,
    archived: bucket.archivedAt !== undefined,
    pinned: bucket.pinned === true,
    active: bucket.id === context.scopeBucketId
  }
}

export async function describeScope(
  deps: ScopeReadDeps,
  context: ScopeReadContext,
  projectPath: string,
  bucket: ScopeBucket
): Promise<unknown> {
  const summary = await summarizeBucket(deps, context, projectPath, bucket)
  const healthy = summary.kind !== 'worktree' || summary.health?.category === 'healthy'
  const git = healthy ? await deps.git.getStatus(summary.path) : null
  return {
    scope: summary,
    git,
    setup:
      bucket.root.kind === 'worktree'
        ? {
            state: bucket.root.setup.state,
            commands: bucket.root.setup.commands.map((record) => ({
              index: record.index,
              executable: record.executable,
              args: record.args,
              state: record.state,
              exitCode: record.exitCode
            }))
          }
        : null,
    ...(healthy
      ? {}
      : {
          guidance: `This scope’s checkout is unhealthy (${summary.health?.category}). Run ${APP_SCOPE_UTILITY_ID} with action "repair" before working in it.`
        })
  }
}

export async function readConflicts(
  deps: ScopeReadDeps,
  context: ScopeReadContext,
  projectPath: string,
  bucket: ScopeBucket
): Promise<unknown> {
  const summary = await summarizeBucket(deps, context, projectPath, bucket)
  if (summary.kind === 'worktree' && summary.health?.category !== 'healthy') {
    throw new Error(
      `The scope “${bucket.name}” is unhealthy (${summary.health?.category}), so its conflicts cannot be read. Run ${APP_SCOPE_UTILITY_ID} with action "repair" first.`
    )
  }
  const status = await deps.git.getStatus(summary.path)
  return {
    scope: { id: bucket.id, name: bucket.name, path: summary.path },
    conflictState: status.conflictState,
    conflicted: status.conflicted,
    clean: status.clean,
    ...(status.conflicted.length === 0 ? {} : { next: conflictNextStep(status) })
  }
}
