/**
 * Remote RPC protocol shared by the phone client and the desktop gateway.
 *
 * The phone PWA and the desktop renderer both speak the same `invoke` /
 * `subscribe` surface as the Electron IPC layer. Over the WebSocket bridge
 * that surface is carried as JSON frames wrapped in the existing AES-GCM
 * `remote:data` envelope, so every request/response is encrypted end to end.
 *
 * Frame shapes (payloads of `remote:data`, after decryption):
 *
 * - phone → desktop: `{ rpc: 'invoke', id, channel, args }`
 * - desktop → phone: `{ rpc: 'result', id, result }` | `{ rpc: 'error', id, message }`
 * - desktop → phone: `{ rpc: 'event', channel, payload }`
 *
 * `id` correlates an invoke to its result; events are pushed unsolicited. The
 * `RemoteInvokeChannel` union reuses the shared IPC channel contract so the
 * phone calls the exact same channels as the desktop renderer.
 */

export type RemoteRpcRequest = {
  rpc: 'invoke'
  id: number
  channel: string
  args: unknown[]
  /**
   * The authenticated device this invocation belongs to. When present the
   * main-process dispatcher enforces device scopes and step-up policy; when
   * absent (the trusted desktop renderer path) only the allowlist applies.
   */
  device?: RemoteRpcDeviceContext
}

export type RemoteRpcResult = { rpc: 'result'; id: number; result: unknown }

export type RemoteRpcError = { rpc: 'error'; id: number; message: string }

export type RemoteRpcEvent = { rpc: 'event'; channel: string; payload: unknown }

export type RemoteRpcFrame = RemoteRpcRequest | RemoteRpcResult | RemoteRpcError | RemoteRpcEvent

/**
 * Channels a phone client is allowed to invoke.
 *
 * This is the full desktop workspace surface the reused components need:
 * sidebar rows (FolderRow/ThreadRow), search, the conversation screen
 * (ThreadView, which embeds ChatComposer), the notification/memory/spec
 * panels, and the scope ("charts") board. Electron-only helpers the phone
 * cannot use (native dialogs, clipboard, "reveal in finder") are allowed but
 * dispatched to no-op handlers so the shared renderer never errors.
 */
export const REMOTE_ALLOWED_CHANNELS: readonly string[] = [
  // Projects + threads
  'project:list',
  'project:get',
  'project:getIcon',
  'project:ensureInbox',
  'thread:listAll',
  'thread:list',
  'thread:get',
  'thread:create',
  'thread:markRead',
  'thread:setPinned',
  'thread:setStatus',
  'thread:updateSettings',
  'thread:setContextUsage',
  'thread:harnessUsage',
  'thread:efficiencyKpis',
  'thread:loadMessages',
  'thread:exportTranscript',
  'thread:update',
  'thread:delete',
  'thread:fork',
  'thread:reorderScope',
  'threads:search',
  'note:get',
  'note:list',
  'note:save',
  'note:delete',
  'attachment:beginRemoteUpload',
  'attachment:appendRemoteUpload',
  'attachment:finishRemoteUpload',
  'attachment:cancelRemoteUpload',
  'attachment:readRemoteChunk',
  'remotePush:getPublicKey',
  'remotePush:subscribe',
  'remotePush:unsubscribe',
  // Config + scope board ("charts")
  'config:get',
  'config:update',
  'config:syncAgentRole',
  'scope:get',
  'scope:save',
  // Agent chat surface
  'agent:loadMessages',
  'agent:loadSessionMessages',
  'agent:listProviderSnapshot',
  'agent:refreshProviderCatalog',
  'agent:refreshAccountUsage',
  'agent:getHarnessAuthStatus',
  'agent:getSessionStatus',
  'agent:ensureSession',
  'agent:sendPrompt',
  'agent:steerPrompt',
  'agent:abort',
  'agent:listPermissions',
  'agent:replyPermission',
  'agent:listQuestions',
  'agent:answerQuestion',
  'agent:dismissQuestion',
  'agent:updateQuestion',
  'agent:listCommands',
  'agent:runCommand',
  'agent:compact',
  'agent:truncateMessages',
  'agent:listContextCapabilities',
  'agent:listProcesses',
  'agent:listArtifacts',
  'agent:killProcess',
  'agent:killThreadProcesses',
  'capabilities:deleteSkill',
  'capabilities:deleteMcp',
  'agent:sendTemporaryPrompt',
  'agent:steerTemporaryPrompt',
  'agent:loadTemporaryChatMessages',
  'agent:getTemporaryChatStatus',
  'agent:abortTemporaryChat',
  'agent:touchTemporaryChat',
  'agent:closeTemporaryChat',
  'agent:getChildSessionStatus',
  'agent:dismissSessionError',
  'agent:retryChildSession',
  'agent:abortChildSession',
  // Engineering workflow (spec/assignment/audit/brainstorm studios)
  'agent:chooseBrainstormEntry',
  'agent:reviewBrainstorm',
  'agent:finalizeBrainstorm',
  'agent:ensureAuditSession',
  'agent:startAssignment',
  'agent:stopAssignment',
  'agent:resumeAssignment',
  'agent:generateAudit',
  'agent:ensureAssignmentAuditorThread',
  'agent:generateAssignmentAudit',
  'agent:generateAssignmentDraft',
  'agent:ensureAchievementScope',
  'agent:ensureAchievementAuditorThread',
  'agent:generateAchievementAudit',
  'agent:submitAchievementAuditFeedback',
  'agent:returnAchievementAuditToOffer',
  'agent:submitAssignmentAuditFeedback',
  'spec:getActive',
  'spec:listVersions',
  'spec:saveDraft',
  'spec:createVersion',
  'spec:dismissValidationIssue',
  'spec:setReview',
  'spec:approve',
  'spec:validate',
  'spec:addAnnotation',
  'spec:addDecisionComment',
  'spec:resolveAnnotation',
  'spec:updateAnnotation',
  'spec:setContext',
  'spec:captureContext',
  'spec:getContextAttachments',
  'assignment:getActive',
  'assignment:listVersions',
  'assignment:saveDraft',
  'assignment:addAnnotation',
  'assignment:updateAnnotation',
  'assignment:resolveAnnotation',
  'assignment:updateUnlinkedWorkerModel',
  'audit:getActive',
  'audit:listVersions',
  'audit:save',
  'audit:addAnnotation',
  'audit:updateAnnotation',
  'audit:resolveAnnotation',
  'audit:complete',
  'audit:returnToOffer',
  'brainstorm:getActive',
  'brainstorm:getWorkflow',
  'brainstorm:resetWorkflow',
  'brainstorm:listVersions',
  'brainstorm:saveDraft',
  'brainstorm:addAnnotation',
  'brainstorm:updateAnnotation',
  'brainstorm:resolveAnnotation',
  // Checkpoints
  'checkpoint:list',
  'checkpoint:diff',
  'checkpoint:rollbackPaths',
  // Memory (proposal panel + memory sidebar)
  'memory:getPendingProposals',
  'memory:approveProposal',
  'memory:rejectProposal',
  'memory:getEntries',
  'memory:saveEntries',
  // Files (composer @-file tags + citation paths)
  'projectFiles:resolveCitationPaths',
  'projectFiles:resolveExternalCitationPaths',
  'projectFiles:search',
  // Repo metadata (thread hover popover)
  'repository:remoteOrigin',
  // Git management — the same surface the desktop git sidebar drives. The
  // phone is a paired, authenticated extension of the user's own desktop and
  // already commands an agent with full repository access, so read/write git
  // is not a widening of trust. GitHub device-flow sign-in and pull-request
  // creation stay desktop-only; only the read-only auth status is exposed so
  // the panel can render without erroring.
  'repository:preflight',
  'git:status',
  'git:diff',
  'git:analyzeConflict',
  'git:prepareConflictWorkFile',
  'git:saveConflictDraft',
  'git:saveConflictResolution',
  'git:stage',
  'git:resolveConflicted',
  'git:unstage',
  'git:commit',
  'git:amend',
  'git:init',
  'git:branches',
  'git:checkout',
  'git:createBranch',
  'git:deleteBranch',
  'git:log',
  'git:commitDiff',
  'git:commitFileDiff',
  'git:reset',
  'git:deleteCommit',
  'git:getIdentity',
  'git:setIdentity',
  'git:remotes',
  'git:addRemote',
  'git:removeRemote',
  'git:fetch',
  'git:pull',
  'git:push',
  'git:getCredentialStatus',
  'git:merge',
  'git:rebase',
  'git:stash',
  'git:stashList',
  'git:stashPop',
  'git:stashDrop',
  'git:stashDiff',
  'git:stashFileDiff',
  'git:abortMerge',
  'git:abortRebase',
  'github:authStatus',
  // Electron-only helpers — allowed so the shared components never error,
  // but dispatched to no-op handlers on the phone.
  'dialog:pickFile',
  'dialog:pickFiles',
  'clipboard:saveImage',
  'shell:revealPath',
  'shell:openExternal'
]

/** Channels the desktop pushes to the phone as live events. */
export const REMOTE_FORWARDED_EVENTS: readonly string[] = [
  'agent:event',
  'agent:processesChanged',
  'thread:updated',
  'thread:deleted',
  'notification:show',
  'providers:status'
] as const

// ─── Device identity, scope, and step-up contract (A-04) ────────────────

/**
 * Scope identifiers a device may be granted. This union is the single source
 * of truth shared by the main-process authorization registry, the device
 * credential service, and the persisted device records.
 */
export type RemoteScope =
  | 'workspace.read'
  | 'workspace.write'
  | 'workspace.delete'
  | 'config.read'
  | 'config.write'
  | 'conversation.read'
  | 'conversation.control'
  | 'permission.reply'
  | 'command.run'
  | 'workflow.read'
  | 'workflow.write'
  | 'workflow.approve'
  | 'rollback'
  | 'memory.read'
  | 'memory.write'
  | 'filesystem.read'
  | 'git.read'
  | 'git.write'
  | 'local.system'

/**
 * Step-up policy for a channel.
 *
 * - `none`: allowed within scope, no additional local approval.
 * - `conditional`: the safe/read-only form runs within scope; every mutating
 *   form additionally requires a local step-up approval.
 * - `always`: every invocation requires a local step-up approval.
 */
export type RemoteStepUpPolicy = 'none' | 'conditional' | 'always'

export interface RemoteChannelAuthorization {
  scope: RemoteScope
  stepUp: RemoteStepUpPolicy
  /**
   * Channels in the workflow.write set that require step-up even though other
   * workflow.write draft/annotation operations only need the scope.
   */
  requiresStepUp?: true
}

/** The device identity attached to a remote RPC invocation for authorization. */
export interface RemoteRpcDeviceContext {
  deviceId: string
  name: string
  fingerprint: string
  authVersion: number
  sessionId: string
  requestId: string
  scopes: RemoteScope[]
  transport: 'lan' | 'relay'
  /** Whether the device may reach every project (local explicit choice). */
  allProjects: boolean
  /** Project ids allowed when `allProjects` is false (enforced server-side). */
  projectIds: string[]
}

/**
 * Typed authorization denial surfaced to a remote caller instead of a raw
 * service error.
 */
export interface RemoteRpcDenied {
  code: 'authorization_denied'
  scope: RemoteScope | null
  reason: string
}

/** A pending local step-up approval the desktop must disposition. */
export interface RemoteRpcStepUpRequired {
  code: 'step_up_required'
  approvalId: string
  expiresAt: number
  action: string
  resource: string | null
}

/**
 * The exhaustive channel → (scope, step-up) authorization registry. This is
 * the single source of truth for which scopes a phone may use; `isAllowed`
 * and the dispatcher's capability checks both derive from it. Every channel
 * in `REMOTE_ALLOWED_CHANNELS` must appear exactly once (enforced by
 * `assertRemoteChannelRegistry`).
 */
export const REMOTE_CHANNEL_AUTHORIZATION: Readonly<Record<string, RemoteChannelAuthorization>> = {
  // workspace.read — default, no step-up
  'project:list': { scope: 'workspace.read', stepUp: 'none' },
  'project:get': { scope: 'workspace.read', stepUp: 'none' },
  'project:getIcon': { scope: 'workspace.read', stepUp: 'none' },
  'project:ensureInbox': { scope: 'workspace.read', stepUp: 'none' },
  'thread:listAll': { scope: 'workspace.read', stepUp: 'none' },
  'thread:list': { scope: 'workspace.read', stepUp: 'none' },
  'thread:get': { scope: 'workspace.read', stepUp: 'none' },
  'thread:harnessUsage': { scope: 'workspace.read', stepUp: 'none' },
  'thread:efficiencyKpis': { scope: 'workspace.read', stepUp: 'none' },
  'thread:loadMessages': { scope: 'workspace.read', stepUp: 'none' },
  'threads:search': { scope: 'workspace.read', stepUp: 'none' },
  'remotePush:getPublicKey': { scope: 'workspace.read', stepUp: 'none' },
  'scope:get': { scope: 'workspace.read', stepUp: 'none' },
  'note:get': { scope: 'workspace.read', stepUp: 'none' },
  'note:list': { scope: 'workspace.read', stepUp: 'none' },
  'attachment:readRemoteChunk': { scope: 'conversation.read', stepUp: 'none' },

  // workspace.write — default-No, no step-up
  'thread:exportTranscript': { scope: 'workspace.write', stepUp: 'none' },
  'thread:create': { scope: 'workspace.write', stepUp: 'none' },
  'attachment:beginRemoteUpload': { scope: 'workspace.write', stepUp: 'none' },
  'attachment:appendRemoteUpload': { scope: 'workspace.write', stepUp: 'none' },
  'attachment:finishRemoteUpload': { scope: 'workspace.write', stepUp: 'none' },
  'attachment:cancelRemoteUpload': { scope: 'workspace.write', stepUp: 'none' },
  'remotePush:subscribe': { scope: 'workspace.write', stepUp: 'none' },
  'remotePush:unsubscribe': { scope: 'workspace.write', stepUp: 'none' },
  'thread:markRead': { scope: 'workspace.write', stepUp: 'none' },
  'thread:setPinned': { scope: 'workspace.write', stepUp: 'none' },
  'thread:setStatus': { scope: 'workspace.write', stepUp: 'none' },
  'thread:updateSettings': { scope: 'workspace.write', stepUp: 'none' },
  'thread:setContextUsage': { scope: 'workspace.write', stepUp: 'none' },
  'thread:update': { scope: 'workspace.write', stepUp: 'none' },
  'thread:fork': { scope: 'workspace.write', stepUp: 'none' },
  'thread:reorderScope': { scope: 'workspace.write', stepUp: 'none' },
  'scope:save': { scope: 'workspace.write', stepUp: 'none' },
  'note:save': { scope: 'workspace.write', stepUp: 'none' },

  // workspace.delete — explicitly scoped and confirmed in the mobile UI.
  // Requiring a second desktop-local approval made a remote-only delete
  // impossible: the phone request had already failed before approval and its
  // retry received a different request id. The authenticated device scope plus
  // the destructive-action confirmation remains the authorization boundary.
  'thread:delete': { scope: 'workspace.delete', stepUp: 'none' },
  'note:delete': { scope: 'workspace.delete', stepUp: 'none' },

  // config.read — read-only settings exposure, no step-up (the phone's theme
  // sync and the memory panel's enable-state load depend on it). Mutating
  // workstation config stays behind an always step-up.
  'config:get': { scope: 'config.read', stepUp: 'none' },
  'config:update': { scope: 'config.write', stepUp: 'always' },
  'config:syncAgentRole': { scope: 'config.write', stepUp: 'always' },

  // conversation.read — default, no step-up
  'agent:loadMessages': { scope: 'conversation.read', stepUp: 'none' },
  'agent:loadSessionMessages': { scope: 'conversation.read', stepUp: 'none' },
  'agent:listProviderSnapshot': { scope: 'conversation.read', stepUp: 'none' },
  'agent:refreshProviderCatalog': { scope: 'conversation.read', stepUp: 'none' },
  'agent:refreshAccountUsage': { scope: 'conversation.read', stepUp: 'none' },
  'agent:getHarnessAuthStatus': { scope: 'conversation.read', stepUp: 'none' },
  'agent:getSessionStatus': { scope: 'conversation.read', stepUp: 'none' },
  'agent:listPermissions': { scope: 'conversation.read', stepUp: 'none' },
  'agent:listQuestions': { scope: 'conversation.read', stepUp: 'none' },
  'agent:listCommands': { scope: 'conversation.read', stepUp: 'none' },
  'agent:listContextCapabilities': { scope: 'conversation.read', stepUp: 'none' },
  'agent:listProcesses': { scope: 'conversation.read', stepUp: 'none' },
  'agent:listArtifacts': { scope: 'conversation.read', stepUp: 'none' },
  'agent:getChildSessionStatus': { scope: 'conversation.read', stepUp: 'none' },
  'agent:getTemporaryChatStatus': { scope: 'conversation.read', stepUp: 'none' },
  'agent:loadTemporaryChatMessages': { scope: 'conversation.read', stepUp: 'none' },
  'agent:touchTemporaryChat': { scope: 'conversation.read', stepUp: 'none' },

  // conversation.control — default, no step-up
  'agent:ensureSession': { scope: 'conversation.control', stepUp: 'none' },
  'agent:sendPrompt': { scope: 'conversation.control', stepUp: 'none' },
  'agent:steerPrompt': { scope: 'conversation.control', stepUp: 'none' },
  'agent:sendTemporaryPrompt': { scope: 'conversation.control', stepUp: 'none' },
  'agent:steerTemporaryPrompt': { scope: 'conversation.control', stepUp: 'none' },
  'agent:abortTemporaryChat': { scope: 'conversation.control', stepUp: 'none' },
  'agent:abort': { scope: 'conversation.control', stepUp: 'none' },
  'agent:answerQuestion': { scope: 'conversation.control', stepUp: 'none' },
  'agent:dismissQuestion': { scope: 'conversation.control', stepUp: 'none' },
  'agent:updateQuestion': { scope: 'conversation.control', stepUp: 'none' },
  'agent:compact': { scope: 'conversation.control', stepUp: 'none' },
  // Destructive process control — the panels confirm before invoking, and a
  // desktop-local step-up can never complete for a remote request.
  'agent:killProcess': { scope: 'conversation.control', stepUp: 'none' },
  'agent:killThreadProcesses': { scope: 'conversation.control', stepUp: 'none' },
  'agent:closeTemporaryChat': { scope: 'conversation.control', stepUp: 'none' },
  'agent:retryChildSession': { scope: 'conversation.control', stepUp: 'none' },
  'agent:dismissSessionError': { scope: 'conversation.control', stepUp: 'none' },
  'agent:abortChildSession': { scope: 'conversation.control', stepUp: 'none' },

  // permission.reply — default-No, always step-up
  'agent:replyPermission': { scope: 'permission.reply', stepUp: 'always' },

  // command.run — default-No, always step-up
  'agent:runCommand': { scope: 'command.run', stepUp: 'always' },
  'agent:truncateMessages': { scope: 'command.run', stepUp: 'always' },

  // workflow.read — default, no step-up
  'spec:getActive': { scope: 'workflow.read', stepUp: 'none' },
  'spec:listVersions': { scope: 'workflow.read', stepUp: 'none' },
  'spec:validate': { scope: 'workflow.read', stepUp: 'none' },
  'spec:getContextAttachments': { scope: 'workflow.read', stepUp: 'none' },
  'assignment:getActive': { scope: 'workflow.read', stepUp: 'none' },
  'assignment:listVersions': { scope: 'workflow.read', stepUp: 'none' },
  'audit:getActive': { scope: 'workflow.read', stepUp: 'none' },
  'audit:listVersions': { scope: 'workflow.read', stepUp: 'none' },
  'brainstorm:getActive': { scope: 'workflow.read', stepUp: 'none' },
  'brainstorm:getWorkflow': { scope: 'workflow.read', stepUp: 'none' },
  'brainstorm:listVersions': { scope: 'workflow.read', stepUp: 'none' },
  'checkpoint:list': { scope: 'workflow.read', stepUp: 'none' },
  'checkpoint:diff': { scope: 'workflow.read', stepUp: 'none' },

  // workflow.write — default-No, conditional step-up
  'agent:chooseBrainstormEntry': { scope: 'workflow.write', stepUp: 'conditional' },
  'agent:reviewBrainstorm': { scope: 'workflow.write', stepUp: 'conditional' },
  'agent:finalizeBrainstorm': {
    scope: 'workflow.write',
    stepUp: 'conditional',
    requiresStepUp: true
  },
  'agent:ensureAuditSession': { scope: 'workflow.write', stepUp: 'conditional' },
  'agent:startAssignment': { scope: 'workflow.write', stepUp: 'conditional', requiresStepUp: true },
  'agent:stopAssignment': { scope: 'workflow.write', stepUp: 'conditional', requiresStepUp: true },
  'agent:resumeAssignment': {
    scope: 'workflow.write',
    stepUp: 'conditional',
    requiresStepUp: true
  },
  'agent:generateAudit': { scope: 'workflow.write', stepUp: 'conditional', requiresStepUp: true },
  'agent:ensureAssignmentAuditorThread': { scope: 'workflow.write', stepUp: 'conditional' },
  'agent:generateAssignmentAudit': {
    scope: 'workflow.write',
    stepUp: 'conditional',
    requiresStepUp: true
  },
  'agent:generateAssignmentDraft': {
    scope: 'workflow.write',
    stepUp: 'conditional',
    requiresStepUp: true
  },
  'agent:ensureAchievementScope': { scope: 'workflow.write', stepUp: 'conditional' },
  'agent:ensureAchievementAuditorThread': { scope: 'workflow.write', stepUp: 'conditional' },
  'agent:generateAchievementAudit': {
    scope: 'workflow.write',
    stepUp: 'conditional',
    requiresStepUp: true
  },
  'agent:submitAchievementAuditFeedback': {
    scope: 'workflow.write',
    stepUp: 'conditional',
    requiresStepUp: true
  },
  'agent:returnAchievementAuditToOffer': {
    scope: 'workflow.write',
    stepUp: 'conditional',
    requiresStepUp: true
  },
  'agent:submitAssignmentAuditFeedback': {
    scope: 'workflow.write',
    stepUp: 'conditional',
    requiresStepUp: true
  },
  'spec:saveDraft': { scope: 'workflow.write', stepUp: 'conditional' },
  'spec:createVersion': { scope: 'workflow.write', stepUp: 'conditional' },
  'spec:dismissValidationIssue': { scope: 'workflow.write', stepUp: 'conditional' },
  'spec:setReview': { scope: 'workflow.write', stepUp: 'conditional' },
  'spec:addAnnotation': { scope: 'workflow.write', stepUp: 'conditional' },
  'spec:addDecisionComment': { scope: 'workflow.write', stepUp: 'conditional' },
  'spec:resolveAnnotation': { scope: 'workflow.write', stepUp: 'conditional' },
  'spec:updateAnnotation': { scope: 'workflow.write', stepUp: 'conditional' },
  'spec:setContext': { scope: 'workflow.write', stepUp: 'conditional' },
  'spec:captureContext': { scope: 'workflow.write', stepUp: 'conditional' },
  'assignment:saveDraft': { scope: 'workflow.write', stepUp: 'conditional' },
  'assignment:addAnnotation': { scope: 'workflow.write', stepUp: 'conditional' },
  'assignment:updateAnnotation': { scope: 'workflow.write', stepUp: 'conditional' },
  'assignment:resolveAnnotation': { scope: 'workflow.write', stepUp: 'conditional' },
  'assignment:updateUnlinkedWorkerModel': {
    scope: 'workflow.write',
    stepUp: 'conditional',
    requiresStepUp: true
  },
  'audit:save': { scope: 'workflow.write', stepUp: 'conditional' },
  'audit:addAnnotation': { scope: 'workflow.write', stepUp: 'conditional' },
  'audit:updateAnnotation': { scope: 'workflow.write', stepUp: 'conditional' },
  'audit:resolveAnnotation': { scope: 'workflow.write', stepUp: 'conditional' },
  'audit:returnToOffer': { scope: 'workflow.write', stepUp: 'conditional', requiresStepUp: true },
  'brainstorm:resetWorkflow': { scope: 'workflow.write', stepUp: 'conditional' },
  'brainstorm:saveDraft': { scope: 'workflow.write', stepUp: 'conditional' },
  'brainstorm:addAnnotation': { scope: 'workflow.write', stepUp: 'conditional' },
  'brainstorm:updateAnnotation': { scope: 'workflow.write', stepUp: 'conditional' },
  'brainstorm:resolveAnnotation': { scope: 'workflow.write', stepUp: 'conditional' },

  // workflow.approve — default-No, always step-up
  'spec:approve': { scope: 'workflow.approve', stepUp: 'always' },
  'audit:complete': { scope: 'workflow.approve', stepUp: 'always' },

  // rollback — default-No, always step-up
  'checkpoint:rollbackPaths': { scope: 'rollback', stepUp: 'always' },

  // memory.read — default, no step-up
  'memory:getPendingProposals': { scope: 'memory.read', stepUp: 'none' },
  'memory:getEntries': { scope: 'memory.read', stepUp: 'none' },

  // memory.write — default-No, no step-up. Approve/reject/save are explicit,
  // confirmed user actions in the memory panel; a desktop-local step-up can
  // never complete for a remote request.
  'memory:approveProposal': { scope: 'memory.write', stepUp: 'none' },
  'memory:rejectProposal': { scope: 'memory.write', stepUp: 'none' },
  'memory:saveEntries': { scope: 'memory.write', stepUp: 'none' },

  // filesystem.read — read-only path/origin lookups, no step-up. The phone's
  // git panel preflight and the composer's @-file mentions depend on these.
  'projectFiles:resolveCitationPaths': { scope: 'filesystem.read', stepUp: 'none' },
  'projectFiles:resolveExternalCitationPaths': { scope: 'filesystem.read', stepUp: 'none' },
  'projectFiles:search': { scope: 'filesystem.read', stepUp: 'none' },
  'repository:remoteOrigin': { scope: 'filesystem.read', stepUp: 'none' },
  'repository:preflight': { scope: 'filesystem.read', stepUp: 'none' },

  // git.read — default, no step-up
  'git:status': { scope: 'git.read', stepUp: 'none' },
  'git:diff': { scope: 'git.read', stepUp: 'none' },
  'git:analyzeConflict': { scope: 'git.read', stepUp: 'none' },
  'git:prepareConflictWorkFile': { scope: 'git.write', stepUp: 'none' },
  'git:branches': { scope: 'git.read', stepUp: 'none' },
  'git:log': { scope: 'git.read', stepUp: 'none' },
  'git:commitDiff': { scope: 'git.read', stepUp: 'none' },
  'git:commitFileDiff': { scope: 'git.read', stepUp: 'none' },
  'git:getIdentity': { scope: 'git.read', stepUp: 'none' },
  'git:remotes': { scope: 'git.read', stepUp: 'none' },
  'git:getCredentialStatus': { scope: 'git.read', stepUp: 'none' },
  'git:stashList': { scope: 'git.read', stepUp: 'none' },
  'git:stashDiff': { scope: 'git.read', stepUp: 'none' },
  'git:stashFileDiff': { scope: 'git.read', stepUp: 'none' },
  'github:authStatus': { scope: 'git.read', stepUp: 'none' },

  // git.write — default-No, no step-up. The phone drives the same read/write
  // git surface as the desktop sidebar and already commands an agent with full
  // repository access over this bridge, so git mutations do not widen trust.
  // Step-up cannot gate these: the remote request fails before a desktop-local
  // approval could land and the retry carries a fresh request id (the same
  // reasoning that made thread:delete step-up free). The device scope plus the
  // panels' destructive-action confirmations remain the boundary.
  'git:stage': { scope: 'git.write', stepUp: 'none' },
  'git:saveConflictDraft': { scope: 'git.write', stepUp: 'none' },
  'git:saveConflictResolution': { scope: 'git.write', stepUp: 'none' },
  'git:resolveConflicted': { scope: 'git.write', stepUp: 'none' },
  'git:unstage': { scope: 'git.write', stepUp: 'none' },
  'git:commit': { scope: 'git.write', stepUp: 'none' },
  'git:amend': { scope: 'git.write', stepUp: 'none' },
  'git:init': { scope: 'git.write', stepUp: 'none' },
  'git:checkout': { scope: 'git.write', stepUp: 'none' },
  'git:createBranch': { scope: 'git.write', stepUp: 'none' },
  'git:deleteBranch': { scope: 'git.write', stepUp: 'none' },
  'git:reset': { scope: 'git.write', stepUp: 'none' },
  'git:deleteCommit': { scope: 'git.write', stepUp: 'none' },
  'git:setIdentity': { scope: 'git.write', stepUp: 'none' },
  'git:addRemote': { scope: 'git.write', stepUp: 'none' },
  'git:removeRemote': { scope: 'git.write', stepUp: 'none' },
  'git:fetch': { scope: 'git.write', stepUp: 'none' },
  'git:pull': { scope: 'git.write', stepUp: 'none' },
  'git:push': { scope: 'git.write', stepUp: 'none' },
  'git:merge': { scope: 'git.write', stepUp: 'none' },
  'git:rebase': { scope: 'git.write', stepUp: 'none' },
  'git:stash': { scope: 'git.write', stepUp: 'none' },
  'git:stashPop': { scope: 'git.write', stepUp: 'none' },
  'git:stashDrop': { scope: 'git.write', stepUp: 'none' },
  'git:abortMerge': { scope: 'git.write', stepUp: 'none' },
  'git:abortRebase': { scope: 'git.write', stepUp: 'none' },

  // local.system — default-No, always step-up
  'dialog:pickFile': { scope: 'local.system', stepUp: 'always' },
  'dialog:pickFiles': { scope: 'local.system', stepUp: 'always' },
  'clipboard:saveImage': { scope: 'local.system', stepUp: 'always' },
  'shell:revealPath': { scope: 'local.system', stepUp: 'always' },
  'shell:openExternal': { scope: 'local.system', stepUp: 'always' },
  'capabilities:deleteSkill': { scope: 'workspace.write', stepUp: 'none' },
  'capabilities:deleteMcp': { scope: 'workspace.write', stepUp: 'none' }
}

/** Return the typed authorization entry for a channel, or `null` if unmapped. */
export function authorizationForChannel(channel: string): RemoteChannelAuthorization | null {
  return REMOTE_CHANNEL_AUTHORIZATION[channel] ?? null
}

/**
 * Enforce the single-registry contract: every allowlisted channel has exactly
 * one authorization entry and no entry names a channel outside the allowlist.
 * Build/test enforcement must fail when the two drift apart.
 */
export function assertRemoteChannelRegistry(): string[] {
  const errors: string[] = []
  for (const channel of REMOTE_ALLOWED_CHANNELS) {
    if (!REMOTE_CHANNEL_AUTHORIZATION[channel]) {
      errors.push(`Remote channel "${channel}" has no authorization entry`)
    }
  }
  for (const channel of Object.keys(REMOTE_CHANNEL_AUTHORIZATION)) {
    if (!REMOTE_ALLOWED_CHANNELS.includes(channel)) {
      errors.push(`Authorization entry "${channel}" is absent from the remote allowlist`)
    }
  }
  return errors
}
