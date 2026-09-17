import { invokeAccountContract } from './ipc/invoke-account'
import { invokeAgentContract } from './ipc/invoke-agent'
import { invokeThreadContract } from './ipc/invoke-thread'
import { invokeProviderContract } from './ipc/invoke-provider'
import { invokeProjectContract } from './ipc/invoke-project'
import { invokeAppContract } from './ipc/invoke-app'
import { invokeEngineeringContract } from './ipc/invoke-engineering'
import { invokeGitContract } from './ipc/invoke-git'
import { invokeRemoteContract } from './ipc/invoke-remote'
import { invokeBrowserContract } from './ipc/invoke-browser'
import { invokeNotificationContract } from './ipc/invoke-notification'
import { invokeUpdaterContract } from './ipc/invoke-updater'
import { invokeSpeechContract } from './ipc/invoke-speech'
import { IPC_EVENT_CONTRACT } from './ipc/events'

export * from './ipc/updater'
export * from './ipc/browser'
export * from './ipc/logging'
export * from './ipc/notifications'
export * from './ipc/remote'
export * from './ipc/events'

export const IPC_INVOKE_CONTRACT = {
  ...invokeAccountContract,
  ...invokeAgentContract,
  ...invokeThreadContract,
  ...invokeProviderContract,
  ...invokeProjectContract,
  ...invokeAppContract,
  ...invokeEngineeringContract,
  ...invokeGitContract,
  ...invokeRemoteContract,
  ...invokeBrowserContract,
  ...invokeNotificationContract,
  ...invokeUpdaterContract,
  ...invokeSpeechContract
}

export type IpcInvokeContract = typeof IPC_INVOKE_CONTRACT
export type IpcEventContract = typeof IPC_EVENT_CONTRACT
export type InvokeChannel = keyof IpcInvokeContract
export type InvokeArgs<Channel extends InvokeChannel> = IpcInvokeContract[Channel]['args']
export type InvokeResult<Channel extends InvokeChannel> = IpcInvokeContract[Channel]['result']
export type EventArgs<Channel extends keyof IpcEventContract> = IpcEventContract[Channel]
