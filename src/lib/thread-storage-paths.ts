import { join } from 'path'
import { getConfigRoot } from './utils'
import { PROJECT_DATA_DIRECTORY } from './project-artifacts'
import type { Project } from './types'

/**
 * Single source of truth for where a thread's on-disk artifacts live.
 * `attachmentDirectory` is used to create/write files; `ownedDirectories` is
 * used to remove everything a thread owns on disk when it (or its project)
 * is deleted. Add new thread-scoped disk locations here so both stay in
 * sync automatically instead of drifting across call sites.
 */

/** Where composer attachments for this thread should be written. */
export function threadAttachmentDirectory(
  project: Pick<Project, 'source' | 'path'> | null,
  scope: { kind: 'project' | 'chat'; projectId: string; threadId: string }
): string {
  if (project?.source === 'local' && project.path) {
    return join(project.path, PROJECT_DATA_DIRECTORY, 'tmp', 'attachments', scope.threadId)
  }
  return scope.kind === 'chat'
    ? join(getConfigRoot(), 'chats', scope.threadId, 'tmp')
    : join(getConfigRoot(), 'projects', scope.projectId, 'threads', scope.threadId, 'tmp')
}

/**
 * Every directory this thread could have written to, app-owned config-root
 * data only (never a location inside a local project's own working tree —
 * that belongs to the user, not app scratch space). Callers should remove
 * these with `{ recursive: true, force: true }` since most will not exist
 * for any given thread.
 */
export function threadOwnedDirectories(
  project: Pick<Project, 'source' | 'path'> | null,
  projectId: string,
  threadId: string
): string[] {
  const dirs = [
    // Chat-scope (no project) attachments/exports.
    join(getConfigRoot(), 'chats', threadId),
    // Non-local project attachments/exports.
    join(getConfigRoot(), 'projects', projectId, 'threads', threadId)
  ]
  if (project?.source === 'local' && project.path) {
    dirs.push(join(project.path, PROJECT_DATA_DIRECTORY, 'tmp', 'attachments', threadId))
  }
  return dirs
}
