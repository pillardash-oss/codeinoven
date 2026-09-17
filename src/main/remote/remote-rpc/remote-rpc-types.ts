/**
 * Shared types for the remote RPC bridge.
 *
 * The dispatcher (`remote-rpc.ts`) re-exports every type declared here, so the
 * public surface stays identical while the implementation is split by concern.
 */

import type { Database } from '../../database/database'
import type { ChatEngine } from '../../chat/chat-engine'
import type { ProjectManager } from '../../../lib/engines/project-manager'
import type { ThreadCreationCoordinator } from '../../chat/thread-creation-coordinator'
import type { ThreadDeletionCoordinator } from '../../chat/thread-deletion-coordinator'
import type { StorageEngine } from '../../storage/storage-engine'
import type { DeviceCredentialService } from '../device-credential-service'
import type { RemoteRpcDeviceContext } from '../../../lib/remote-rpc'

export interface RemoteRpcServices {
  database: Database
  chatEngine: Pick<
    ChatEngine,
    | 'loadMessages'
    | 'loadTurnStreamParts'
    | 'deleteThreadSession'
    | 'activeTurnChangeSummary'
    | 'listProviderSnapshot'
    | 'getSessionStatus'
    | 'getHarnessAuthStatus'
    | 'ensureSession'
    | 'sendPrompt'
    | 'steerPrompt'
    | 'discardSteer'
    | 'abort'
    | 'listPermissions'
    | 'replyPermission'
    | 'listImageDescriptorErrors'
    | 'replyImageDescriptor'
    | 'listQuestions'
    | 'answerQuestion'
    | 'listCommands'
    | 'runCommand'
    | 'compactSession'
    | 'truncateMessages'
    | 'deleteMessages'
    | 'dismissQuestion'
    | 'updateQuestion'
    | 'listContextCapabilities'
    | 'listProcesses'
    | 'killProcess'
    | 'killThreadProcesses'
    | 'listArtifacts'
    | 'deleteSkill'
    | 'deleteMcp'
    | 'sendTemporaryPrompt'
    | 'steerTemporaryPrompt'
    | 'loadTemporaryConversation'
    | 'getTemporaryChatStatus'
    | 'abortTemporaryChat'
    | 'touchTemporaryChat'
    | 'listProviders'
    | 'refreshAccountUsage'
    | 'loadSessionMessages'
    | 'getChildSessionStatus'
    | 'dismissSessionError'
    | 'retryChildSession'
    | 'abortChildSession'
    | 'closeTemporaryChat'
    | 'chooseBrainstormEntry'
    | 'reviewBrainstorm'
    | 'finalizeBrainstorm'
    | 'generatePrd'
    | 'ensureInitialSpec'
    | 'readPrototypePreviewChunk'
    | 'ensureImplementationAuditorThread'
    | 'startAssignment'
    | 'stopAssignment'
    | 'resumeAssignment'
    | 'generateAudit'
    | 'ensureAssignmentAuditorThread'
    | 'generateAssignmentAudit'
    | 'generateAssignmentDraft'
    | 'ensureAchievementScope'
    | 'ensureAchievementAuditorThread'
    | 'generateAchievementAudit'
    | 'submitAchievementAuditFeedback'
    | 'returnAchievementAuditToOffer'
    | 'submitAssignmentAuditFeedback'
  >
  /** Storage engine   needed for config and the memory/spec/assignment engines. */
  storage?: StorageEngine
  projectManager?: ProjectManager
  /**
   * Device credential service used to enforce per-device scopes and local
   * step-up approval for remote invocations. Optional so the desktop-reuse
   * dispatcher and isolated tests can construct it without device state.
   */
  credentials?: DeviceCredentialService
  threadCreation?: ThreadCreationCoordinator
  threadDeletion?: ThreadDeletionCoordinator
}

/** A remote RPC invoke request that reached the main process. */
export interface RemoteInvoke {
  id: number
  channel: string
  args: unknown[]
  /** The authenticated device this invocation belongs to, when known. */
  device?: RemoteRpcDeviceContext
}

export type RemoteRpcResult = { ok: true; result: unknown } | { ok: false; message: string }
