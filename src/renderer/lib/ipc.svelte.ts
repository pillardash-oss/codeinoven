import { ovenRootArguments, ovenRootTarget, type OvenRootBinding } from '$lib/oven-root-target'
/// <reference types="vite/client" />

import type {
  AppBridge,
  EventArgs,
  EventChannel,
  InvokeArgs,
  InvokeChannel,
  InvokeResult
} from '../../preload/index'
import { isOvenRootChannel } from '$shared/oven-root-routing'
import {
  isGitInvocationSuccess,
  isGitRefusedOperation,
  isGitRemoteUnavailable,
  type GitInvocationValue,
  type GitRefusingChannel
} from '$shared/ipc-contract'
import { GitRemoteUnavailableError } from '$lib/ipc-errors'
import { agentDebug } from '$lib/stores/agent-debug.svelte'
import { logRendererError } from '$lib/system/renderer-logger'

declare global {
  interface Window {
    api: AppBridge
  }
}

/** IPC channels registered before the first renderer paint. */
const HYDRATION_CHANNELS = new Set<InvokeChannel>([
  'app:confirmClose',
  'app:parkWindow',
  'app:quitDirect',
  'app:instanceRole',
  'app:openInstanceOwner',
  'app:transferInstanceControl',
  'app:rendererReady',
  'app:waitForFeatures',
  // Registered with the same pre-navigation surface
  // (`registerGlobalBrowserIpcHandlers`), and read by the Ctrl+Tab switcher and
  // by `loadBrowser` while the browser's own modules are still unloaded. Waiting
  // for the post-paint feature graph here would hold the browser open behind a
  // graph that has nothing to do with its tab list.
  'browser:loadTabs',
  'config:get',
  'project:ensureInbox',
  // Registered on the hydration surface so Assistant View's first pass resolves
  // it immediately instead of waiting for the post-paint feature graph.
  'routine:ensureSpace',
  'project:get',
  'project:getIcon',
  'project:list',
  'note:get',
  'scope:get',
  'thread:get',
  'thread:listRecent',
  'thread:listAlwaysVisible',
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
  const target = isOvenRootChannel(channel) ? ovenRootTarget(channel, plainArgs) : null
  const result = target
    ? await invokeAtOvenRootBinding(channel, target, ovenRootArguments(channel, plainArgs))
    : await window.api.invoke(channel, ...plainArgs)
  if (import.meta.env.DEV) {
    agentDebug.trackInvoke(channel, plainArgs)
    agentDebug.trackResult(channel, result)
  }
  return result
}

/**
 * A captured root operation keeps background work bound to its own checkout.
 *
 * Saving a draft after the user selected another Oven must reach the Oven the
 * editor was opened on, not whichever thread happens to be selected now.
 */
export async function invokeAtOvenRoot<Channel extends InvokeChannel>(
  channel: Channel,
  target: { threadId: string; ovenId: string },
  ...args: InvokeArgs<Channel>
): Promise<InvokeResult<Channel>> {
  await waitForFeatureHandlers(channel)
  const projectId = args[0]
  if (typeof projectId !== 'string' || !isOvenRootChannel(channel))
    throw new Error('Invalid root operation.')
  return await invokeAtOvenRootBinding(
    channel,
    { projectId, threadId: target.threadId, ovenId: target.ovenId },
    args.slice(1).map((arg) => $state.snapshot(arg))
  )
}

/** One routed call: the whole renderer reaches an Oven checkout through here. */
async function invokeAtOvenRootBinding<Channel extends InvokeChannel>(
  channel: Channel,
  target: OvenRootBinding,
  args: readonly unknown[]
): Promise<InvokeResult<Channel>> {
  return (await window.api.invoke(
    'oven:rootOperation',
    target.projectId,
    target.threadId,
    channel,
    [...args],
    target.ovenId
  )) as InvokeResult<Channel>
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
 * A remote the checkout cannot use travels the same way, as `{ ok: false, issue }`,
 * and is re-thrown as a `GitRemoteUnavailableError` carrying that verdict. The
 * store that started the round trip decides whether it is a notice or an error,
 * and either way nothing reaches the log.
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
  if (isGitRemoteUnavailable(result)) throw new GitRemoteUnavailableError(result.issue)
  // A channel that honoured its contract returns the `{ ok: true, value }`
  // envelope on success, so the value the caller asked for is one level down.
  if (isGitInvocationSuccess(result)) {
    return result.value as GitInvocationValue<InvokeResult<Channel>>
  }
  // A handler that returned the plain value (no envelope) passes through
  // untouched; the compiler cannot see through the generic channel lookup,
  // so the result is asserted either way.
  return result as GitInvocationValue<InvokeResult<Channel>>
}

/** Subscribe to an IPC event channel, returns unsubscribe function */
export function subscribe<Channel extends EventChannel>(
  channel: Channel,
  callback: (...args: EventArgs<Channel>) => void
): () => void {
  return window.api.on(channel, callback)
}

/**
 * Subscribe to an IPC event channel without letting one unknown channel take the
 * caller, and everything the caller does after it, down with it.
 *
 * `subscribe` throws for a channel this window's preload does not expose, which
 * is the right answer on its own: the preload is a built artifact that only
 * changes when the app restarts, while this bundle is hot-reloaded on every
 * save, so right after a channel is added the two can disagree and the mistake
 * has to be visible. A caller that wires a whole subsystem, though, must not
 * lose the rest of its wiring to that one disagreement: left unguarded, the
 * throw aborts the caller, and every subscription after it is simply never made
 * while the app keeps running, so the symptom looks nothing like the cause.
 * Here the channel is named in the log, what it carries stays off until the
 * window reloads against a preload that knows it, and every other channel is
 * subscribed as usual.
 */
export function subscribeGuarded<Channel extends EventChannel>(
  channel: Channel,
  callback: (...args: EventArgs<Channel>) => void
): () => void {
  try {
    return window.api.on(channel, callback)
  } catch (error) {
    logRendererError(
      `This window's bridge does not expose "${channel}", so what it carries stays off until the window reloads against a matching build.`,
      error
    )
    return () => {}
  }
}
