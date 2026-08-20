import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppConfig, AppConfigPatch, AttachmentStorageScope } from '../lib/types'
import {
  NO_TRAFFIC_LIGHT,
  TRAFFIC_LIGHT_ARG_PREFIX,
  TRAFFIC_LIGHT_OFFSET,
  parseTrafficLight,
  type TrafficLightInfo
} from '../lib/traffic-light'
import type {
  EventArgs as ContractEventArgs,
  IpcEventContract,
  InvokeArgs,
  InvokeChannel,
  InvokeResult
} from '../lib/ipc-contract'
export type { InvokeArgs, InvokeChannel, InvokeResult } from '../lib/ipc-contract'

const INVOKE_CHANNELS = [
  'account:getLocalUsage',
  'account:getProfile',
  'account:beginSignIn',
  'account:syncProfile',
  'account:signOut',
  'brainstorm:ensureWorkflow',
  'brainstorm:getWorkflow',
  'brainstorm:chooseEntry',
  'brainstorm:resetWorkflow',
  'brainstorm:getActive',
  'brainstorm:listVersions',
  'brainstorm:createDraft',
  'brainstorm:saveDraft',
  'brainstorm:createVersion',
  'brainstorm:addAnnotation',
  'brainstorm:updateAnnotation',
  'brainstorm:resolveAnnotation',
  'brainstorm:addDecisionComment',
  'brainstorm:finalize',
  'agent:chooseBrainstormEntry',
  'agent:reviewBrainstorm',
  'agent:finalizeBrainstorm',
  'assignment:getActive',
  'assignment:listVersions',
  'assignment:saveDraft',
  'assignment:addAnnotation',
  'assignment:updateAnnotation',
  'assignment:resolveAnnotation',
  'assignment:updateUnlinkedWorkerModel',
  'assignment:validate',
  'assignment:openInEditor',
  'assignment:revealInFiles',
  'memory:getLayers',
  'agent:abort',
  'agent:compact',
  'agent:answerQuestion',
  'agent:dismissQuestion',
  'agent:ensureInitialSpec',
  'agent:ensureAuditSession',
  'agent:ensureAssignmentAuditorThread',
  'agent:ensureSession',
  'agent:getTemporaryChatStatus',
  'agent:getSessionStatus',
  'agent:dismissSessionError',
  'agent:getChildSessionStatus',
  'agent:retryChildSession',
  'agent:retryAssignmentWorker',
  'agent:resumeAssignmentAttention',
  'agent:abortChildSession',
  'agent:generateSpec',
  'agent:generateAudit',
  'agent:generateAssignmentAudit',
  'agent:generateAssignmentDraft',
  'agent:ensureAchievementScope',
  'agent:ensureAchievementAuditorThread',
  'agent:generateAchievementAudit',
  'agent:submitAchievementAuditFeedback',
  'agent:returnAchievementAuditToOffer',
  'agent:submitAssignmentAuditFeedback',
  'agent:startAssignment',
  'agent:stopAssignment',
  'agent:resumeAssignment',
  'agent:listCommands',
  'agent:listPermissions',
  'agent:listProviders',
  'agent:listProviderSnapshot',
  'agent:refreshProviderCatalog',
  'agent:refreshAccountUsage',
  'agent:getHarnessAuthStatus',
  'agent:listTools',
  'agent:listContextCapabilities',
  'agent:listArtifacts',
  'agent:listProcesses',
  'agent:killProcess',
  'agent:killThreadProcesses',
  'capabilities:readSkill',
  'capabilities:updateSkill',
  'capabilities:deleteSkill',
  'capabilities:readMcp',
  'capabilities:updateMcp',
  'capabilities:deleteMcp',
  'capabilities:listAll',
  'agent:listQuestions',
  'agent:updateQuestion',
  'agent:loadMessages',
  'agent:loadSessionMessages',
  'agent:loadTemporaryChatMessages',
  'agent:replyPermission',
  'agent:listImageDescriptorErrors',
  'agent:replyImageDescriptor',
  'agent:runCommand',
  'agent:sendPrompt',
  'agent:steerPrompt',
  'agent:sendTemporaryPrompt',
  'agent:steerTemporaryPrompt',
  'agent:abortTemporaryChat',
  'agent:touchTemporaryChat',
  'agent:closeTemporaryChat',
  'agent:truncateMessages',
  'temporary-chat:convertToThread',
  'baseUrlProviders:list',
  'baseUrlProviders:create',
  'baseUrlProviders:update',
  'baseUrlProviders:delete',
  'baseUrlProviders:copyProviderToClipboard',
  'checklist:generate',
  'checklist:get',
  'checklist:updateItem',
  'checkpoint:diff',
  'checkpoint:list',
  'checkpoint:rollback',
  'checkpoint:rollbackPaths',
  'checkpoint:redoPaths',
  'config:get',
  'config:update',
  'config:syncAgentRole',
  'cioPrompts:list',
  'cioPrompts:save',
  'cioPrompts:reset',
  'workerNames:getSettings',
  'workerNames:saveCustom',
  'dialog:pickFolder',
  'attachment:saveText',
  'clipboard:saveImage',
  'clipboard:writeText',
  'clipboard:readText',
  'dialog:pickFile',
  'dialog:pickFiles',
  'dialog:pickImage',
  'diagnostics:export',
  'file:read',
  'file:readAsDataUrl',
  'editors:detect',
  'editors:getPreferred',
  'editors:setPreferred',
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
  'git:init',
  'git:branches',
  'git:checkout',
  'git:createBranch',
  'git:deleteBranch',
  'git:log',
  'git:commitDiff',
  'git:commitFileDiff',
  'git:amend',
  'git:reset',
  'git:deleteCommit',
  'git:getIdentity',
  'git:setIdentity',
  'git:remotes',
  'git:addRemote',
  'git:removeRemote',
  'git:fetch',
  'git:fetchBranch',
  'git:pull',
  'git:pullIntegrate',
  'git:push',
  'git:getCredentialStatus',
  'git:setCredential',
  'git:removeCredential',
  'git:merge',
  'git:rebase',
  'git:preparePrResolve',
  'git:stash',
  'git:ignore',
  'git:discard',
  'git:stashList',
  'git:stashPop',
  'git:stashDrop',
  'git:stashDiff',
  'git:stashFileDiff',
  'git:abortMerge',
  'git:abortRebase',
  'pr:create',
  'pr:list',
  'pr:merge',
  'pr:ready',
  'pr:compare',
  'pr:reopen',
  'pr:close',
  'pr:page',
  'pr:detail',
  'deployment:overview',
  'deployment:detail',
  'deployment:runDetail',
  'deployment:jobLog',
  'cloudDeploy:getConfig',
  'cloudDeploy:saveConfig',
  'cloudDeploy:clearConfig',
  'cloudDeploy:updateContainer',
  'cloudDeploy:removeContainer',
  'cloudDeploy:listAccounts',
  'cloudDeploy:createAccount',
  'cloudDeploy:updateAccount',
  'cloudDeploy:rotateAccountSecret',
  'cloudDeploy:removeAccount',
  'cloudDeploy:attachAccount',
  'cloudDeploy:detachAccount',
  'cloudDeploy:setActiveAccount',
  'cloudDeploy:overview',
  'cloudDeploy:availableContainers',
  'cloudDeploy:deployments',
  'cloudDeploy:containerStatus',
  'cloudDeploy:containerLog',
  'pr:bundle',
  'pr:commitFiles',
  'pr:agentReport',
  'pr:comment',
  'pr:review',
  'pr:reviewWorkspace',
  'pr:update',
  'pr:composeWithAgent',
  'github:authStatus',
  'github:startDeviceFlow',
  'github:poll',
  'github:logout',
  'history:append',
  'history:load',
  'history:search',
  'memory:getRaw',
  'memory:saveRaw',
  'memory:getEntries',
  'memory:saveEntries',
  'memory:getMergedEntries',
  'memory:addEntry',
  'memory:removeEntry',
  'memory:searchEntries',
  'memory:getPendingProposals',
  'memory:approveProposal',
  'memory:rejectProposal',
  'memory:createProposal',
  'memory:export',
  'memory:import',
  'memory:importApply',
  'notification:test',
  'notification:getPermissionStatus',
  'notification:openSettings',
  'scope:get',
  'scope:save',
  'plan:approve',
  'plan:get',
  'plan:save',
  'project:create',
  'project:delete',
  'project:ensureInbox',
  'project:get',
  'project:getIcon',
  'project:list',
  'project:openInEditor',
  'project:reorder',
  'project:search',
  'project:setPinned',
  'project:setIcon',
  'project:clearIcon',
  'project:update',
  'projectFiles:list',
  'projectFiles:search',
  'projectFiles:resolveCitationPaths',
  'projectFiles:resolveExternalCitationPaths',
  'projectFiles:create',
  'projectFiles:createDirectory',
  'projectFiles:delete',
  'projectFiles:info',
  'projectFiles:openInEditor',
  'projectFiles:openInEditorWith',
  'projectFiles:saveAs',
  'projectFiles:paste',
  'projectFiles:importPaths',
  'projectFiles:dropPaths',
  'projectFiles:read',
  'projectFiles:rename',
  'projectFiles:save',
  'providers:check',
  'providers:checkAll',
  'providers:getStatus',
  'harnessUpdates:check',
  'harnessUpdates:checkAll',
  'harnessUpdates:handoff',
  'harnessInstall:getInfo',
  'harnessUninstall:handoff',
  'harnessManifest:list',
  'harnessManifest:confirm',
  'harnessManifest:reset',
  'harnessAutoUpdate:list',
  'harnessAutoUpdate:set',
  'providerAccounts:getAuthStatus',
  'providerAccounts:beginLogin',
  'providerAccounts:listOffered',
  'providerAccounts:logout',
  'providerAccounts:getHidden',
  'providerAccounts:setHidden',
  'utilities:list',
  'utilities:get',
  'utilities:create',
  'utilities:installBundle',
  'utilities:setupWithAgent',
  'utilities:searchSkillMarket',
  'utilities:listSkillMarket',
  'utilities:getSkillMarketDetail',
  'utilities:installMarketSkill',
  'utilities:update',
  'utilities:delete',
  'utilities:setCredential',
  'utilities:removeCredential',
  'utilities:resolve',
  'computerUse:getCuaStatus',
  'computerUse:setCuaEnabled',
  'computerUse:pipGetState',
  'computerUse:pipBringToFront',
  'computerUse:pipDismiss',
  'pty:create',
  'pty:createCommand',
  'pty:destroy',
  'repository:init',
  'repository:preflight',
  'repository:remoteOrigin',
  'shell:openExternal',
  'shell:revealPath',
  'shell:revealExternalPath',
  'web:favicon',
  'browser:show',
  'browser:hide',
  'browser:navigate',
  'browser:goBack',
  'browser:goForward',
  'browser:reload',
  'browser:stop',
  'browser:getConsole',
  'browser:clearConsole',
  'browser:destroy',
  'browser:destroyProject',
  'spec:addAnnotation',
  'spec:addDecisionComment',
  'spec:approve',
  'spec:captureContext',
  'spec:createDraft',
  'spec:createVersion',
  'spec:dismissValidationIssue',
  'spec:exportMarkdown',
  'spec:getActive',
  'spec:getContextAttachments',
  'spec:importMarkdown',
  'spec:listVersions',
  'spec:openInEditor',
  'spec:revealInFiles',
  'spec:resolveAnnotation',
  'spec:updateAnnotation',
  'spec:saveDraft',
  'spec:setContext',
  'spec:setReview',
  'spec:validate',
  'audit:getActive',
  'audit:listVersions',
  'audit:save',
  'audit:addAnnotation',
  'audit:updateAnnotation',
  'audit:resolveAnnotation',
  'audit:complete',
  'audit:beginRework',
  'audit:returnToOffer',
  'audit:openInEditor',
  'audit:revealInFiles',
  'brainstorm:openInEditor',
  'brainstorm:revealInFiles',
  'thread:create',
  'thread:delete',
  'thread:dismissSpecReview',
  'thread:fork',
  'thread:get',
  'thread:list',
  'thread:listAll',
  'thread:listRecent',
  'thread:listHistoryPage',
  'threads:search',
  'thread:loadMessages',
  'thread:loadMessagesAround',
  'thread:exportTranscript',
  'thread:loadUserMessages',
  'thread:reorder',
  'thread:setSortOrder',
  'thread:reorderPinned',
  'thread:reorderPinnedGlobal',
  'thread:reorderScope',
  'thread:markRead',
  'thread:setPinned',
  'thread:setContextUsage',
  'thread:harnessUsage',
  'thread:efficiencyKpis',
  'thread:setStatus',
  'thread:update',
  'thread:updateSettings',
  'note:get',
  'note:save',
  'note:delete',
  'note:list',
  'updater:check',
  'updater:getStatus',
  'updater:download',
  'updater:install',
  'remote:getStatus',
  'remote:ensureGateway',
  'remote:toggle',
  'remote:listDevices',
  'remote:disconnectDevice',
  'remote:renameDevice',
  'remote:revokeDevice',
  'remote:approveStepUp',
  'remote:rejectStepUp',
  'remote:listPendingApprovals',
  'remote:listAuditEvents',
  'remote:beginCloudEnrollment',
  'remote:resetCloudEnrollment',
  'app:confirmClose',
  'app:waitForFeatures',
  'app:rendererReady'
] as const satisfies readonly InvokeChannel[]

type MissingInvokeChannel = Exclude<InvokeChannel, (typeof INVOKE_CHANNELS)[number]>
const allInvokeChannelsRegistered: [MissingInvokeChannel] extends [never] ? true : never = true
void allInvokeChannelsRegistered

const SEND_CHANNELS = ['pty:resize', 'pty:write', 'terminal:focusState'] as const
const EVENT_CHANNELS = [
  'app:featuresReady',
  'account:profileChanged',
  'agent:event',
  'agent:processesChanged',
  'agent:temporaryChatExpired',
  'app:toast',
  'notification:playSound',
  'notification:show',
  'notification:threadClicked',
  'notification:permissionStatus',
  'providers:status',
  'thread:deleted',
  'thread:updated',
  'note:changed',
  'window:beforeQuit',
  'window:confirmClose',
  'window:closeShortcut',
  'window:newTerminalShortcut',
  'updater:status',
  'updater:waiting-for-threads',
  'computerUse:pipFrame',
  'computerUse:pipState',
  'browser:state',
  'browser:console',
  'browser:openRequested',
  'remote:status',
  'remote:stepUpPending'
] as const

export type SendChannel = (typeof SEND_CHANNELS)[number]
export type EventChannel =
  (typeof EVENT_CHANNELS)[number] | `pty:data:${string}` | `pty:exit:${string}`
export type EventArgs<Channel extends EventChannel> = Channel extends keyof IpcEventContract
  ? ContractEventArgs<Channel>
  : unknown[]

const invokeChannels = new Set<string>(INVOKE_CHANNELS)
const sendChannels = new Set<string>(SEND_CHANNELS)
const eventChannels = new Set<string>(EVENT_CHANNELS)

function assertInvokeChannel(channel: string): asserts channel is InvokeChannel {
  if (!invokeChannels.has(channel))
    throw new TypeError(`Unsupported IPC invoke channel: ${channel}`)
}

function assertSendChannel(channel: string): asserts channel is SendChannel {
  if (!sendChannels.has(channel)) throw new TypeError(`Unsupported IPC send channel: ${channel}`)
}

function assertEventChannel(channel: string): asserts channel is EventChannel {
  if (
    !eventChannels.has(channel) &&
    !channel.startsWith('pty:data:') &&
    !channel.startsWith('pty:exit:')
  ) {
    throw new TypeError(`Unsupported IPC event channel: ${channel}`)
  }
}

export interface AppBridge {
  invoke: <Channel extends InvokeChannel>(
    channel: Channel,
    ...args: InvokeArgs<Channel>
  ) => Promise<InvokeResult<Channel>>
  send: (channel: SendChannel, ...args: unknown[]) => void
  on: <Channel extends EventChannel>(
    channel: Channel,
    callback: (...args: EventArgs<Channel>) => void
  ) => () => void
  config: {
    get: () => Promise<AppConfig>
    update: (patch: AppConfigPatch) => Promise<AppConfig>
  }
  /** Desktop window chrome for the current OS — read once at startup. */
  windowInfo: {
    platform: NodeJS.Platform
    trafficLight: TrafficLightInfo
  }
  /** Read a local file into bytes for renderer-side preview use. The read is
   *  performed by the validated main-process `file:read` channel so the preload
   *  never touches the filesystem directly and only scoped paths can be read. */
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>
  /** Resolve and register a File from a drop/paste gesture. Pathless browser
   *  files are persisted into the supplied attachment scope. */
  registerFileSelection: (file: File, scope?: AttachmentStorageScope) => Promise<string>
  /** Resolve the absolute path of a native File from a drop/paste gesture ('' when unavailable). */
  getPathForFile: (file: File) => string
  /** Resolve and begin a native filesystem drag during the active drag gesture. */
  startFileDrag: (projectId: string, relativePaths: string[]) => void
}

const trafficLightArg = process.argv.find((arg) => arg.startsWith(TRAFFIC_LIGHT_ARG_PREFIX))
const MAX_PATHLESS_ATTACHMENT_BYTES = 32 * 1024 * 1024

/**
 * Platform truth the flag is only an enhancement for. macOS always draws its
 * traffic lights inset on the left — never fall back to "none" there, even if
 * the `additionalArguments` flag is missing (e.g. a partial build), otherwise
 * the header content would slide under the window controls.
 */
function defaultTrafficLight(platform: NodeJS.Platform): TrafficLightInfo {
  return platform === 'darwin'
    ? { present: true, side: 'left', offset: TRAFFIC_LIGHT_OFFSET }
    : NO_TRAFFIC_LIGHT
}

const bridge: AppBridge = {
  invoke: <Channel extends InvokeChannel>(
    channel: Channel,
    ...args: InvokeArgs<Channel>
  ): Promise<InvokeResult<Channel>> => {
    assertInvokeChannel(channel)
    return ipcRenderer.invoke(channel, ...args) as Promise<InvokeResult<Channel>>
  },
  send: (channel: SendChannel, ...args: unknown[]) => {
    assertSendChannel(channel)
    ipcRenderer.send(channel, ...args)
  },
  on: <Channel extends EventChannel>(
    channel: Channel,
    callback: (...args: EventArgs<Channel>) => void
  ) => {
    assertEventChannel(channel)
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      callback(...(args as EventArgs<Channel>))
    }
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  },
  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<AppConfig>,
    update: (patch: AppConfigPatch) =>
      ipcRenderer.invoke('config:update', patch) as Promise<AppConfig>
  },
  windowInfo: {
    platform: process.platform,
    trafficLight:
      parseTrafficLight(trafficLightArg?.slice(TRAFFIC_LIGHT_ARG_PREFIX.length)) ??
      defaultTrafficLight(process.platform)
  },
  readFile: async (path: string): Promise<Uint8Array<ArrayBuffer>> => {
    const data = await ipcRenderer.invoke('file:read', path)
    if (data === null) throw new Error('Could not read the requested file')
    return data as Uint8Array<ArrayBuffer>
  },
  registerFileSelection: async (file: File, scope?: AttachmentStorageScope): Promise<string> => {
    const path = webUtils.getPathForFile(file)
    if (path) {
      const registered = await ipcRenderer.invoke('file:registerSelection', path, scope)
      return typeof registered === 'string' ? registered : ''
    }
    if (!scope) return ''
    if (file.size === 0) throw new TypeError('Dropped attachment is empty')
    if (file.size > MAX_PATHLESS_ATTACHMENT_BYTES) {
      throw new TypeError('Dropped browser attachment must be at most 32 MB')
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const registered = await ipcRenderer.invoke(
      'file:registerSelection',
      { filename: file.name, bytes },
      scope
    )
    return typeof registered === 'string' ? registered : ''
  },
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  startFileDrag: (projectId: string, relativePaths: string[]): void =>
    ipcRenderer.send(
      'projectFiles:startDrag',
      projectId,
      Array.from(relativePaths ?? []).map(String)
    )
}

contextBridge.exposeInMainWorld('api', bridge)
