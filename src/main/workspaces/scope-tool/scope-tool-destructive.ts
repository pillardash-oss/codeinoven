/**
 * Wording for destructive scope actions: the challenge summary and the
 * consequence list shown to the user (and the model) before anything is
 * removed. The strings are part of the confirmation contract.
 */

import type { GitStatus, ScopeBucket, ScopeLifecycleSnapshot } from '../../../lib/types'
import type { ScopeToolCall } from './scope-tool-types'

/** How to finish an in-progress merge or rebase after resolving files. */
export function conflictNextStep(status: GitStatus): string {
  if (status.conflictState === 'rebase') {
    return 'Resolve each file, stage it with `git add`, then run `git rebase --continue`. Run `git rebase --abort` to give up.'
  }
  if (status.conflictState === 'merge') {
    return 'Resolve each file, stage it with `git add`, then run `git commit` to finish the merge. Run `git merge --abort` to give up.'
  }
  return 'Resolve each conflicted file and stage it with `git add`.'
}

export function destructiveSummary(
  call: ScopeToolCall,
  bucket: ScopeBucket,
  mergeTargetName?: string
): string {
  const label = bucket.root.kind === 'worktree' ? 'the worktree scope' : 'the scope'
  switch (call.action) {
    case 'detach_worktree':
      return `detach the worktree from ${label} “${bucket.name}” (the scope and its branch stay; only the checkout is removed)`
    case 'delete_scope':
      return `delete ${label} “${bucket.name}”${call.deleteBranch ? ' and its branch' : ''}`
    case 'merge_into_project':
      return `merge the scope “${bucket.name}” into ${mergeTargetName ?? 'the project'}`
    default:
      return `change ${label} “${bucket.name}”`
  }
}

export function destructiveConsequences(
  call: ScopeToolCall,
  bucket: ScopeBucket,
  snapshot: ScopeLifecycleSnapshot | null,
  threadCount: number
): string[] {
  const consequences: string[] = []
  if (call.action === 'detach_worktree') {
    consequences.push('The worktree checkout directory is removed.')
    consequences.push('The scope, its threads and its branch are kept.')
  }
  if (call.action === 'delete_scope') {
    consequences.push('The scope is removed from the project board.')
    if (bucket.root.kind === 'worktree') {
      consequences.push('Its worktree checkout is removed.')
      consequences.push(
        call.deleteBranch
          ? 'Its managed branch is deleted permanently.'
          : 'Its managed branch is kept.'
      )
    }
    if (threadCount > 0) {
      consequences.push(
        call.threads === 'delete'
          ? `${threadCount} thread${threadCount === 1 ? '' : 's'} and their conversations are deleted permanently.`
          : `${threadCount} thread${threadCount === 1 ? '' : 's'} move to the Default scope.`
      )
    }
  }
  if (call.action === 'merge_into_project') {
    const mode = call.mode ?? 'merge-keep'
    consequences.push('The scope’s branch is merged into the target scope’s checkout.')
    if (mode === 'merge-delete') {
      consequences.push('Then the source scope, its worktree and its branch are deleted.')
    } else if (mode === 'merge-move-to-default') {
      consequences.push(
        'Then the source scope is deleted and its threads move to the Default scope.'
      )
    } else {
      consequences.push('The source scope, its worktree and its branch are kept.')
    }
    consequences.push('Nothing is pushed to a remote.')
  }
  if (snapshot && snapshot.dirtyFiles.length > 0) {
    consequences.push(
      `${snapshot.dirtyFiles.length} uncommitted file${snapshot.dirtyFiles.length === 1 ? '' : 's'} in the checkout are discarded.`
    )
  }
  if (snapshot && snapshot.unpushedCommits > 0) {
    consequences.push(
      `${snapshot.unpushedCommits} commit${snapshot.unpushedCommits === 1 ? '' : 's'} on the scope branch exist nowhere else.`
    )
  }
  return consequences
}
