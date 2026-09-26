import { invokeAccountContract } from './ipc/invoke-account'
import { invokeAgentContract } from './ipc/invoke-agent'
import { invokeThreadContract } from './ipc/invoke-thread'
import { invokeProviderContract } from './ipc/invoke-provider'
import { invokeProjectContract } from './ipc/invoke-project'
import { invokeAppContract } from './ipc/invoke-app'
import { invokeEngineeringContract } from './ipc/invoke-engineering'
import { invokeGitContract } from './ipc/invoke-git'
import { invokeBrowserContract } from './ipc/invoke-browser'
import { invokeNotificationContract } from './ipc/invoke-notification'
import { invokeUpdaterContract } from './ipc/invoke-updater'
import { invokeSpeechContract } from './ipc/invoke-speech'
import { invokeAssistantContract } from './ipc/invoke-assistant'
import { invokeTypesafeContract } from './ipc/invoke-typesafe'
import { invokeDesignContract } from './ipc/invoke-design'
import { invokeExpertContract } from './ipc/invoke-expert'
import { invokeMediaContract } from './ipc/invoke-media'
import { IPC_EVENT_CONTRACT } from './ipc/events'
import type { GitInvocation, GitRefusedOperation } from './types'

export * from './ipc/updater'
export * from './ipc/browser'
export * from './ipc/design'
export * from './ipc/expert'
export * from './ipc/media'
export * from './ipc/logging'
export * from './ipc/notifications'
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
  ...invokeBrowserContract,
  ...invokeNotificationContract,
  ...invokeUpdaterContract,
  ...invokeSpeechContract,
  ...invokeTypesafeContract,
  ...invokeAssistantContract,
  ...invokeDesignContract,
  ...invokeExpertContract,
  ...invokeMediaContract
}

export type IpcInvokeContract = typeof IPC_INVOKE_CONTRACT
export type IpcEventContract = typeof IPC_EVENT_CONTRACT
export type InvokeChannel = keyof IpcInvokeContract
export type InvokeArgs<Channel extends InvokeChannel> = IpcInvokeContract[Channel]['args']
export type InvokeResult<Channel extends InvokeChannel> = IpcInvokeContract[Channel]['result']
export type EventArgs<Channel extends keyof IpcEventContract> = IpcEventContract[Channel]

/**
 * Channels whose expected refusals cross IPC as data rather than as a rejected
 * invoke. Derived from the contract, so a channel that starts or stops refusing
 * cannot leave a hand-maintained list behind: every call site of `invokeGit`
 * becomes a type error instead.
 */
export type GitRefusingChannel = {
  [Channel in InvokeChannel]: InvokeResult<Channel> extends GitInvocation<unknown> ? Channel : never
}[InvokeChannel]

/** The value a refusing channel yields once `invokeGit` unwraps its envelope. */
export type GitInvocationValue<Result> = Result extends { ok: true; value: infer Value }
  ? Value
  : never

/**
 * Whether a value is a refusal a refusing git channel returned instead of a
 * rejection. Guards the decode in `invokeGit`, so a channel that ever handed
 * back something else is passed through untouched rather than misread.
 */
export function isGitRefusedOperation(value: unknown): value is GitRefusedOperation {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { ok?: unknown; refusal?: unknown }
  return candidate.ok === false && typeof candidate.refusal === 'string'
}

/**
 * Whether a value is the success half of a `GitInvocation` envelope, meaning the
 * payload the caller asked for sits one level down in `value`. Guards the decode
 * in `invokeGit` so the success path is runtime-checked the way the refusal path
 * is, rather than trusted blind.
 */
export function isGitInvocationSuccess(value: unknown): value is { ok: true; value: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { ok?: unknown; value?: unknown }
  return candidate.ok === true && 'value' in candidate
}
