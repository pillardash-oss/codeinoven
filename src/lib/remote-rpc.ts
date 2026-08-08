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
  'thread:listAll',
  'thread:list',
  'thread:get',
  'thread:create',
  'thread:markRead',
  'thread:setArchived',
  'thread:setPinned',
  'thread:setStatus',
  'thread:updateSettings',
  'thread:setContextUsage',
  'thread:loadMessages',
  'thread:update',
  'thread:delete',
  'thread:fork',
  'thread:reorderScope',
  'threads:search',
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
  'agent:closeTemporaryChat',
  'agent:getChildSessionStatus',
  'agent:retryChildSession',
  'agent:abortChildSession',
  // Engineering workflow (spec/assignment/audit/brainstorm studios)
  'agent:chooseBrainstormEntry',
  'agent:reviewBrainstorm',
  'agent:finalizeBrainstorm',
  'agent:ensureAuditSession',
  'agent:startAssignment',
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
  'git:stage',
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
  'git:revert',
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
  'clipboard:saveImage',
  'shell:revealPath',
  'shell:openExternal'
]

/** Channels the desktop pushes to the phone as live events. */
export const REMOTE_FORWARDED_EVENTS: readonly string[] = [
  'agent:event',
  'thread:updated',
  'providers:status'
] as const
