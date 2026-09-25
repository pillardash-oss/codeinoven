/**
 * App-owned thread workspace roots.
 *
 * A conversation that is not project file work still needs a browsable file
 * tree, and its directory lives in app storage rather than in a project folder:
 * standalone chats own `chats-artifacts/<threadId>` and assistant tasks own
 * `assistant-cwd/<routineId ?? threadId>`. Both are resolved (and created) on
 * demand so a conversation with no files yet still opens a real, empty root,
 * and both mirror the exact directory the agent runs in, so the tree never
 * shows a folder the session does not actually use.
 */

import type { Database } from '../../database/database'
import { ThreadRepo } from '../../database/repositories/thread-repo'
import {
  assistantThreadWorkspaceDirectory,
  chatThreadArtifactDirectory
} from '../../../lib/project-artifacts'
import { ensureDir } from '../../../lib/utils'
import type { StorageEngine } from '../../storage/storage-engine'
import type {
  ProjectFilesAssistantRootLookup,
  ProjectFilesChatArtifactRootLookup,
  ProjectFilesThreadWorkspaceRoots
} from './project-files-roots'

/** Build both thread workspace lookups from the app storage root. */
export function createThreadWorkspaceRoots(
  storage: StorageEngine,
  database: Database
): ProjectFilesThreadWorkspaceRoots {
  const threads = new ThreadRepo(database)
  return {
    chatArtifacts: createChatArtifactRoots(storage),
    assistant: createAssistantRoots(storage, threads)
  }
}

function createChatArtifactRoots(storage: StorageEngine): ProjectFilesChatArtifactRootLookup {
  return {
    resolve: async (threadId: string) => {
      const root = storage.resolve(chatThreadArtifactDirectory(threadId))
      await ensureDir(root)
      return root
    }
  }
}

function createAssistantRoots(
  storage: StorageEngine,
  threads: ThreadRepo
): ProjectFilesAssistantRootLookup {
  return {
    resolve: async (threadId: string) => {
      // The task's routine decides its directory, so the mount follows the
      // routine a task belongs to rather than the task itself. A thread row
      // that is already gone falls back to its own id: the tree then shows an
      // empty root instead of failing the whole panel.
      const routineId = threads.get(threadId)?.routineId
      const root = storage.resolve(assistantThreadWorkspaceDirectory(threadId, routineId))
      await ensureDir(root)
      return root
    }
  }
}
