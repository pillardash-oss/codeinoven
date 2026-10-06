import { join } from 'path'
import { getConfigRoot, getRoutinePath } from './utils'
import {
  ASSISTANT_CWD_DIR,
  PROJECT_DATA_DIRECTORY,
  assistantThreadWorkspaceDirectory,
  browserThreadWorkspaceDirectory,
  chatThreadWorkspaceDirectory
} from './project-artifacts'
import { CONFIG_UTILITIES_DIRECTORY, THREAD_UTILITIES_DIRECTORY } from './utility-scope-paths'
import {
  ASSISTANT_SPACE_ID,
  GLOBAL_BROWSER_PROJECT_ID,
  INBOX_PROJECT_ID,
  type Project
} from './types'

/**
 * Single source of truth for where a thread's on-disk artifacts live.
 * `threadScratchDirectory` and `threadAttachmentDirectory` resolve where files
 * are created and written; `threadOwnedDirectories` is used to remove
 * everything a thread owns on disk when it (or its project) is deleted. Add new
 * thread-scoped disk locations here so both stay in sync automatically instead
 * of drifting across call sites.
 *
 * One rule per conversation kind:
 *
 * - a thread inside a local project works in the project's own checkout, so its
 *   scratch is that repo's `.cio/tmp`;
 * - a standalone chat owns `chats-cwd/<threadId>` in app storage;
 * - an assistant task shares `assistant-cwd/<routineId>` with its routine;
 * - a browser tab's agent chat owns `browser-cwd/<threadId>`, where the thread id
 *   is the tab's own id, so one tab owns one directory;
 * - anything else that is not local (a remote project) keeps the generic
 *   app-storage area.
 *
 * Thread-scoped utility installs sit outside all of that, in
 * `utilities/threads/<threadId>` under the app config root: they belong to the
 * conversation, not to the folder it happens to run in.
 */

/** The project a thread belongs to, as far as its storage paths care. */
type ScratchProject = Pick<Project, 'source' | 'path'> | null

/**
 * Scratch pad (`.cio/tmp`) of one conversation, resolved to the directory its
 * session actually runs in so one conversation owns one directory instead of
 * staging its files in a root every other conversation shares.
 */
export function threadScratchDirectory(
  project: ScratchProject,
  scope: { projectId: string; threadId: string; routineId?: string | null }
): string {
  // A project thread works inside the repo, so its scratch is the repo's own
  // `.cio/tmp`: the same directory the agent is told to write to, inside the
  // checkout the user can see, and gone with the project rather than hidden in
  // app storage.
  if (project?.source === 'local' && project.path) {
    return join(project.path, PROJECT_DATA_DIRECTORY, 'tmp')
  }
  if (scope.projectId === INBOX_PROJECT_ID) {
    return join(
      getConfigRoot(),
      chatThreadWorkspaceDirectory(scope.threadId),
      PROJECT_DATA_DIRECTORY,
      'tmp'
    )
  }
  if (scope.projectId === ASSISTANT_SPACE_ID) {
    return join(
      getConfigRoot(),
      assistantThreadWorkspaceDirectory(scope.threadId, scope.routineId),
      PROJECT_DATA_DIRECTORY,
      'tmp'
    )
  }
  if (scope.projectId === GLOBAL_BROWSER_PROJECT_ID) {
    return join(
      getConfigRoot(),
      browserThreadWorkspaceDirectory(scope.threadId),
      PROJECT_DATA_DIRECTORY,
      'tmp'
    )
  }
  return join(getConfigRoot(), 'projects', scope.projectId, 'threads', scope.threadId, 'tmp')
}

/** Where composer attachments for this thread should be written.
 *
 * A thread with a local project folder stages them in that project's own
 * scratch pad (`.cio/tmp/attachments`), one folder per thread. A conversation
 * with no folder of its own stages them in the scratch pad of the workspace it
 * runs in, so nothing it stages is scattered across app storage; because a
 * routine's workspace is shared by every task in it, an assistant task keeps a
 * folder of its own inside the routine's. */
export function threadAttachmentDirectory(
  project: ScratchProject,
  scope: { projectId: string; threadId: string; routineId?: string | null }
): string {
  if (project?.source === 'local' && project.path) {
    return join(project.path, PROJECT_DATA_DIRECTORY, 'tmp', 'attachments', scope.threadId)
  }
  const scratchDirectory = threadScratchDirectory(project, scope)
  return scope.projectId === ASSISTANT_SPACE_ID
    ? join(scratchDirectory, 'attachments', scope.threadId)
    : join(scratchDirectory, 'attachments')
}

/**
 * Absolute directory holding every utility installed for one thread: a
 * thread-scoped skill or MCP server is installed here and nowhere else, so the
 * install is private to that conversation and goes when the thread goes.
 */
export function threadUtilitiesDirectory(threadId: string): string {
  return join(getConfigRoot(), CONFIG_UTILITIES_DIRECTORY, THREAD_UTILITIES_DIRECTORY, threadId)
}

/**
 * Every directory this thread could have written to, app-owned config-root
 * data only (never a location inside a local project's own working tree, which
 * belongs to the user, not app scratch space). Callers should remove these with
 * `{ recursive: true, force: true }` since most will not exist for any given
 * thread.
 */
export function threadOwnedDirectories(
  project: ScratchProject,
  projectId: string,
  threadId: string,
  routineId?: string | null
): string[] {
  const dirs: string[] = []
  if (projectId === INBOX_PROJECT_ID) {
    // A chat owns one workspace: its session directory, the mount root of its
    // file tree, its attachments and exports, and its generated artifacts.
    dirs.push(join(getConfigRoot(), chatThreadWorkspaceDirectory(threadId)))
  }
  if (projectId === GLOBAL_BROWSER_PROJECT_ID) {
    // A browser tab's conversation owns one workspace too, and it dies with the
    // tab that opened it, so the whole directory goes.
    dirs.push(join(getConfigRoot(), browserThreadWorkspaceDirectory(threadId)))
  }
  if (projectId === ASSISTANT_SPACE_ID) {
    // The routine's workspace holds every task's scratch, so only this task's
    // own attachment folder goes with the task; the rest is the routine's and
    // `routineOwnedDirectories` removes it.
    dirs.push(threadAttachmentDirectory(null, { projectId, threadId, routineId }))
  }
  dirs.push(
    // Thread-scoped utility installs: a skill or MCP server installed for this
    // conversation only, which the registry cannot resolve for any thread once
    // this one is gone.
    threadUtilitiesDirectory(threadId),
    // Legacy chat-scope attachments/exports root, superseded by the workspace
    // above. Kept so a chat that predates the move is still cleaned up in full.
    join(getConfigRoot(), 'chats', threadId),
    // Non-local project attachments/exports.
    join(getConfigRoot(), 'projects', projectId, 'threads', threadId)
  )
  if (project?.source === 'local' && project.path) {
    dirs.push(join(project.path, PROJECT_DATA_DIRECTORY, 'tmp', 'attachments', threadId))
  }
  return dirs
}

/**
 * Every app-owned directory one routine owns on disk: its icon and how-to
 * checkpoint folder, and the workspace every task in it mounts. Deleting a
 * routine removes both, so its artifacts never outlive the container the user
 * removed. Callers should remove these with `{ recursive: true, force: true }`
 * since either may be absent.
 */
export function routineOwnedDirectories(routineId: string): string[] {
  return [getRoutinePath(routineId), join(getConfigRoot(), ASSISTANT_CWD_DIR, routineId)]
}
