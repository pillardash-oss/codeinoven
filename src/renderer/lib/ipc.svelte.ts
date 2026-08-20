/// <reference types="vite/client" />

import type {
  AppBridge,
  EventArgs,
  EventChannel,
  InvokeArgs,
  InvokeChannel,
  InvokeResult
} from '../../preload/index'
import { agentDebug } from '$lib/stores/agent-debug.svelte'
import { isRemotePwaRuntime } from '$lib/runtime-context'

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
  'thread:listRecent'
])

let featureReadyPromise: Promise<void> | null = null

async function waitForFeatureHandlers(channel: InvokeChannel): Promise<void> {
  // The remote PWA talks to the desktop through the capability-scoped RPC
  // bridge. `app:waitForFeatures` is an Electron renderer lifecycle channel,
  // not a remote capability, and the desktop is necessarily ready before its
  // remote gateway can serve workspace RPC.
  if (isRemotePwaRuntime() || HYDRATION_CHANNELS.has(channel)) return
  featureReadyPromise ??= window.api.invoke('app:waitForFeatures')
  await featureReadyPromise
}

/**
 * Typed IPC invoke helper. Channel determines both its argument tuple and result.
 *
 * Electron's contextBridge cannot structured-clone Proxy objects, and Svelte 5
 * `$state` values are deep proxies — passing one straight to the bridge throws
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

/** Subscribe to an IPC event channel, returns unsubscribe function */
export function subscribe<Channel extends EventChannel>(
  channel: Channel,
  callback: (...args: EventArgs<Channel>) => void
): () => void {
  return window.api.on(channel, callback)
}
