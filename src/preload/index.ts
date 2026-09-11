import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppConfig, AppConfigPatch, AttachmentStorageScope } from '../lib/types'
import {
  NO_TRAFFIC_LIGHT,
  TRAFFIC_LIGHT_ARG_PREFIX,
  TRAFFIC_LIGHT_OFFSET,
  parseTrafficLight,
  type TrafficLightInfo
} from '../lib/traffic-light'
import {
  IPC_INVOKE_CONTRACT,
  type EventArgs as ContractEventArgs,
  type IpcEventContract,
  type InvokeArgs,
  type InvokeChannel,
  type InvokeResult
} from '../lib/ipc-contract'
export type { InvokeArgs, InvokeChannel, InvokeResult } from '../lib/ipc-contract'

/* Every renderer-invokable channel in the IPC contract is exposed here.
 * The list is derived from the contract itself, so an entry and its
 * exposure can never drift apart. */
const INVOKE_CHANNELS = Object.keys(IPC_INVOKE_CONTRACT) as InvokeChannel[]

type MissingInvokeChannel = Exclude<InvokeChannel, (typeof INVOKE_CHANNELS)[number]>
const allInvokeChannelsRegistered: [MissingInvokeChannel] extends [never] ? true : never = true
void allInvokeChannelsRegistered

const SEND_CHANNELS = ['pty:resize', 'pty:write', 'terminal:focusState'] as const
const EVENT_CHANNELS = [
  'app:featuresReady',
  'account:profileChanged',
  'agent:event',
  'agent:processesChanged',
  'taskManager:processesChanged',
  'agent:temporaryChatExpired',
  'app:toast',
  'notification:playSound',
  'notification:show',
  'notification:threadClicked',
  'notification:permissionStatus',
  'providers:status',
  'thread:deleted',
  'thread:updated',
  'thread:branchUpdated',
  'note:changed',
  'window:beforeQuit',
  'window:confirmClose',
  'window:closeShortcut',
  'window:newTerminalShortcut',
  'window:historyBack',
  'window:historyForward',
  'updater:status',
  'updater:waiting-for-threads',
  'computerUse:pipFrame',
  'computerUse:pipState',
  'browser:state',
  'gateway:state',
  'browser:console',
  'browser:openRequested',
  'browser:permissionRequested',
  'browser:permissionResolved',
  'browser:download',
  'switcher:select',
  'switcher:highlight',
  'switcher:closed',
  'remote:status',
  'remote:stepUpPending',
  'speech:progress',
  'providerAccounts:oauthEvent'
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
