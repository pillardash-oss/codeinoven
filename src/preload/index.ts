import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppConfig, AppConfigPatch } from '../lib/types'
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
  'agent:getChildSessionStatus',
  'agent:retryChildSession',
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
  'agent:listCommands',
  'agent:listPermissions',
  'agent:listProviders',
  'agent:listProviderSnapshot',
  'agent:refreshProviderCatalog',
  'agent:refreshAccountUsage',
  'agent:listTools',
  'agent:listContextCapabilities',
  'agent:listProcesses',
  'agent:killProcess',
  'agent:killThreadProcesses',
  'capabilities:readSkill',
  'capabilities:updateSkill',
  'capabilities:deleteSkill',
  'capabilities:readMcp',
  'capabilities:updateMcp',
  'capabilities:deleteMcp',
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
  'config:get',
  'config:update',
  'config:syncAgentRole',
  'workerNames:getSettings',
  'workerNames:saveCustom',
  'dialog:pickFolder',
  'clipboard:saveImage',
  'clipboard:writeText',
  'clipboard:readText',
  'dialog:pickFile',
  'dialog:pickImage',
  'diagnostics:export',
  'file:read',
  'file:readAsDataUrl',
  'editors:detect',
  'editors:getPreferred',
  'editors:setPreferred',
  'git:status',
  'git:diff',
  'git:stage',
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
  'git:pull',
  'git:push',
  'git:getCredentialStatus',
  'git:setCredential',
  'git:removeCredential',
  'git:merge',
  'git:rebase',
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
  'pr:page',
  'deployment:overview',
  'pr:bundle',
  'pr:commitFiles',
  'pr:agentReport',
  'pr:comment',
  'pr:review',
  'pr:reviewWorkspace',
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
  'notification:test',
  'notification:getPermissionStatus',
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
  'projectFiles:create',
  'projectFiles:delete',
  'projectFiles:info',
  'projectFiles:openInEditor',
  'projectFiles:openInEditorWith',
  'projectFiles:saveAs',
  'projectFiles:paste',
  'projectFiles:importPaths',
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
  'web:favicon',
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
  'threads:search',
  'thread:loadMessages',
  'thread:loadMessagesAround',
  'thread:loadUserMessages',
  'thread:reorder',
  'thread:reorderScope',
  'thread:markRead',
  'thread:setArchived',
  'thread:setPinned',
  'thread:setContextUsage',
  'thread:harnessUsage',
  'thread:setStatus',
  'thread:update',
  'thread:updateSettings',
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
  'app:requestClose',
  'app:rendererReady'
] as const satisfies readonly InvokeChannel[]

type MissingInvokeChannel = Exclude<InvokeChannel, (typeof INVOKE_CHANNELS)[number]>
const allInvokeChannelsRegistered: MissingInvokeChannel extends never ? true : never = true
void allInvokeChannelsRegistered

const SEND_CHANNELS = ['pty:resize', 'pty:write'] as const
const EVENT_CHANNELS = [
  'agent:event',
  'agent:processesChanged',
  'agent:temporaryChatExpired',
  'app:toast',
  'notification:playSound',
  'notification:show',
  'notification:threadClicked',
  'providers:status',
  'thread:updated',
  'window:beforeQuit',
  'window:confirmClose',
  'window:closeShortcut',
  'updater:status',
  'updater:waiting-for-threads',
  'computerUse:pipFrame',
  'computerUse:pipState',
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
  /** Resolve the native path of a File object dropped/pasted in the renderer. */
  getPathForFile: (file: File) => string
}

const trafficLightArg = process.argv.find((arg) => arg.startsWith(TRAFFIC_LIGHT_ARG_PREFIX))

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
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('api', bridge)
