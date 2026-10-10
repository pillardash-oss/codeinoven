import type { AppControlRequest, AppControlResponse } from '$shared/app-control'
import { invoke, subscribe } from '$lib/ipc.svelte'
import {
  listAppControlActions,
  registerAppControlBuiltins,
  runAppControlAction
} from './app-control-actions'

/**
 * The renderer's half of the app-control bridge.
 *
 * It is the one place a call from the agent becomes a call the app would make
 * itself: a `channel` request goes straight through the preload's typed invoke,
 * exactly as a panel would, and an `action` request runs a registered UI action.
 * The answer is returned on the `appControl:respond` invoke with the request id
 * main parked the call under.
 *
 * Started once by the app shell. Until it starts, a request simply never
 * arrives, which is the correct behaviour for a window that has not mounted.
 */

let started = false

/** Begin answering app-control requests. Idempotent. */
export function startAppControlResponder(): void {
  if (started) return
  started = true
  registerAppControlBuiltins()
  subscribe('appControl:request', (request) => {
    void answer(request)
  })
  // Claim the bridge: main sends every request to the window that announced
  // itself last, so a request with a side effect runs exactly once even when a
  // second window is open.
  void invoke('appControl:ready').catch(() => undefined)
}

/**
 * Invoke an arbitrary channel by name.
 *
 * The typed `invoke` helper wants a literal channel; this is the one place the
 * name is dynamic, and the main process has already validated it against the
 * contract, so the cast is the boundary rather than a hole.
 */
const invokeDynamic = invoke as unknown as (channel: string, ...args: unknown[]) => Promise<unknown>

async function perform(request: AppControlRequest): Promise<unknown> {
  const target = request.target
  if (target.kind === 'actions') return listAppControlActions()
  if (target.kind === 'action') return runAppControlAction(target.action, target.params)
  return invokeDynamic(target.channel, ...target.args)
}

async function answer(request: AppControlRequest): Promise<void> {
  let response: AppControlResponse
  try {
    response = { requestId: request.requestId, ok: true, result: await perform(request) }
  } catch (error) {
    response = {
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  await invoke('appControl:respond', response).catch(() => undefined)
}
