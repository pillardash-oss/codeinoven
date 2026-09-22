/// <reference types="vite/client" />

import type {
  AppBridge,
  EventArgs,
  EventChannel,
  InvokeArgs,
  InvokeChannel,
  InvokeResult
} from '../../preload/index'
import {
  isGitRefusedOperation,
  type GitInvocationValue,
  type GitRefusingChannel
} from '$shared/ipc-contract'
import { agentDebug } from '$lib/stores/agent-debug.svelte'

declare global {
  interface Window {
    api: AppBridge
  }
}

/** IPC channels registered before the first renderer paint. */
const HYDRATION_CHANNELS = new Set<InvokeChannel>([
  'app:confirmClose',
  'app:rendererReady',
  'app:waitForFeatures',
  'config:get',
  'project:ensureInbox',
  'project:get',
  'project:getIcon',
  'project:list',
  'note:get',
  'scope:get',
  'thread:get',
  'thread:listRecent',
  'thread:listRecentPerProject',
  'thread:listProjectPage',
  'thread:loadMessages',
  'thread:loadMessagesAround',
  'thread:loadUserMessages'
])

let featureReadyPromise: Promise<void> | null = null

async function waitForFeatureHandlers(channel: InvokeChannel): Promise<void> {
  // Hydration channels are registered before navigation, so they are always
  // answerable; every other feature channel waits for the post-paint graph.
  if (HYDRATION_CHANNELS.has(channel)) return
  featureReadyPromise ??= window.api.invoke('app:waitForFeatures')
  await featureReadyPromise
}

/**
 * Typed IPC invoke helper. Channel determines both its argument tuple and result.
 *
 * Electron's contextBridge cannot structured-clone Proxy objects, and Svelte 5
 * `$state` values are deep proxies   passing one straight to the bridge throws
 * "An object could not be cloned". `$state.snapshot` unwraps each argument into
 * a plain static copy in a single pass (no string intermediate), so callers can
 * hand reactive state to `invoke` directly. Primitives pass through untouched.
 */
export async function invoke<Channel extends InvokeChannel>(
  channel: Channel,
  ...args: InvokeArgs<Channel>
): Promise<InvokeResult<Channel>> {
  await waitForFeatureHandlers(channel)
  const plainArgs = args.map((arg) => $state.snapshot(arg)) as InvokeArgs<Channel>
  const result = await window.api.invoke(channel, ...plainArgs)
  if (import.meta.env.DEV) {
    agentDebug.trackInvoke(channel, plainArgs)
    agentDebug.trackResult(channel, result)
  }
  return result
}

/**
 * Typed invoke for the git channels that report an expected refusal as data.
 *
 * Electron logs every rejected `ipcMain.handle` call with `console.error`, so a
 * refusal the user resolves by acting (an uncommitted working tree, an open
 * integration, a branch that is not fully merged) comes back as
 * `{ ok: false, refusal }` instead of a rejection. It is re-thrown here, on this
 * side of the boundary, so the refusal reaches no log and no IPC hop, every
 * store keeps the failure handling it already has, and this app's logs stay
 * unchanged for a state the UI renders anyway.
 *
 * Restricted to the channels whose contract result is a `GitInvocation`, so a
 * non-refusing channel cannot be routed through it by mistake.
 */
export async function invokeGit<Channel extends GitRefusingChannel>(
  channel: Channel,
  ...args: InvokeArgs<Channel>
): Promise<GitInvocationValue<InvokeResult<Channel>>> {
  const result: unknown = await invoke(channel, ...args)
  if (isGitRefusedOperation(result)) throw new Error(result.refusal)
  // The guard above is what proves the shape at runtime; the compiler cannot see
  // through the generic channel lookup, so the unwrapped value is asserted here.
  return result as GitInvocationValue<InvokeResult<Channel>>
}

/** Subscribe to an IPC event channel, returns unsubscribe function */
export function subscribe<Channel extends EventChannel>(
  channel: Channel,
  callback: (...args: EventArgs<Channel>) => void
): () => void {
  return window.api.on(channel, callback)
}
