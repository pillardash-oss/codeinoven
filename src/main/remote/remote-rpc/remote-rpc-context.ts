/**
 * Shared call context for the remote RPC bridge.
 *
 * The dispatcher constructs one context and hands it to the per-domain channel
 * handlers (agent, studios, git). Handlers get explicit services instead of
 * reaching back into the dispatcher, so each domain module stays a plain
 * function over the same main-process services the desktop IPC path uses.
 */

import type { ThreadManager } from '../../../lib/engines/thread-manager'
import type { EngineeringLifecycleEngine } from '../../../lib/engines/engineering-lifecycle-engine'
import type { PrdEngine } from '../../../lib/engines/prd-engine'
import type { ProjectManager } from '../../../lib/engines/project-manager'
import type { ScopeManager } from '../../../lib/engines/scope-manager'
import type { SpecEngine } from '../../../lib/engines/spec-engine'
import type { BrainstormEngine } from '../../../lib/engines/brainstorm-engine'
import type { AuditEngine } from '../../../lib/engines/audit-engine'
import type { AssignmentEngine } from '../../../lib/engines/assignment-engine'
import type { ThreadCreationCoordinator } from '../../chat/thread-creation-coordinator'
import type { ThreadDeletionCoordinator } from '../../chat/thread-deletion-coordinator'
import type { SpecContextService } from '../../chat/spec-context-service'
import type { NoteRepo } from '../../database/repositories/note-repo'
import type { ProjectFilesService } from '../../editor/project-files-service'
import type { ScopeWorktreeService } from '../../git/scope-worktree-service'
import type { RepositoryService } from '../../git/repository-service'
import type { GitService } from '../../git/git-service'
import type { SyncPeerService } from '../../git/sync-peer-service'
import type { GitHubAuthService } from '../../git/github-auth-service'
import type { CheckpointManager } from '../../storage/checkpoint-manager'
import type { MemoryService } from '../../chat/memory-service'
import type { SecretVault } from '../../storage/secret-vault'
import type { StorageEngine } from '../../storage/storage-engine'
import type { scopeRootProvider } from '../../workspaces/scope-root-resolver'
import type { RemoteRpcServices } from './remote-rpc-types'
import type { RemoteAttachmentStore } from './remote-rpc-attachments'
import type { DeviceCredentialService } from '../device-credential-service'

/**
 * Sentinel returned by a domain handler when the channel is not one of its
 * cases. The dispatcher then tries the next domain, so every channel keeps
 * exactly one owner and unknown channels still fail closed.
 */
export const REMOTE_RPC_UNHANDLED: unique symbol = Symbol('remote-rpc:unhandled')

export interface RemoteRpcCallContext {
  chatEngine: RemoteRpcServices['chatEngine']
  threadManager: ThreadManager
  threadCreation: ThreadCreationCoordinator
  threadDeletion: ThreadDeletionCoordinator
  projectManager: ProjectManager
  projectFilesService: ProjectFilesService
  scopeManager: ScopeManager
  scopeWorktreeService: ScopeWorktreeService
  scopeRoots: ReturnType<typeof scopeRootProvider>
  /** Resolves a sync's other end: every checkout and branch, named once. */
  syncPeers: SyncPeerService
  specEngine: SpecEngine
  engineeringLifecycleEngine: EngineeringLifecycleEngine
  prdEngine: PrdEngine
  brainstormEngine: BrainstormEngine
  auditEngine: AuditEngine
  assignmentEngine: AssignmentEngine
  specContextService: SpecContextService
  checkpointManager: CheckpointManager
  memoryService: MemoryService
  repositoryService: RepositoryService
  gitService: GitService
  vault: SecretVault
  githubAuthService: GitHubAuthService
  storage: StorageEngine
  noteRepo: NoteRepo
  attachments: RemoteAttachmentStore
  credentials: DeviceCredentialService | null
}
