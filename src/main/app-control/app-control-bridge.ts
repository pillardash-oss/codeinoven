import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AppControlRequest, AppControlResponse, AppControlTarget } from '../../lib/app-control'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'

/**
 * Main's half of the app-control bridge.
 *
 * The agent's tool call runs in main, but the app it wants to drive lives in the
 * renderer: only there can a channel be invoked exactly as the UI invokes it,
 * and only there do the navigation and panel actions that are not channels
 * exist. So a call becomes an `appControl:request` event with a fresh id, and
 * this module parks a promise under that id until the renderer answers on
 * `appControl:respond`, or the wait expires.
 *
 * The shape (a pending map keyed by request id, drained by a paired reply
 * channel) is the app's existing pattern for scope confirmations and the
 * browser's screen-share picker; this only generalizes it to any call.
 */

interface PendingAppControl {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingAppControl>()

/**
 * The one renderer that answers app-control requests.
 *
 * The app can have more than one window (a second instance, the browser overlay)
 * and a request with a side effect must run exactly once, so the bridge is not
 * broadcast: a renderer announces itself on `appControl:ready` and main sends
 * every request to that window alone. A window that goes away is forgotten, so
 * the next mount becomes the responder.
 */
let responder: WebContents | null = null

/** Adopt a renderer as the bridge's executor, replacing any previous one. */
export function setAppControlResponder(sender: WebContents): void {
  if (responder === sender) return
  responder = sender
  sender.once('destroyed', () => {
    if (responder === sender) responder = null
  })
}

/**
 * How long main waits for the renderer to answer.
 *
 * Generous on purpose: an agent may drive a channel that raises a native dialog
 * (picking a folder) or a network call (a deployment overview), and the user is
 * allowed to take their time answering it. The timeout exists to fail a wedged
 * or absent renderer, not to hurry a person.
 */
const APP_CONTROL_TIMEOUT_MS = 120_000

/** Resolve one parked app-control call from the renderer's answer. */
export function resolveAppControl(response: AppControlResponse): void {
  const entry = pending.get(response.requestId)
  if (!entry) return
  pending.delete(response.requestId)
  clearTimeout(entry.timer)
  if (response.ok) entry.resolve(response.result)
  else entry.reject(new Error(response.error ?? 'The app declined the operation.'))
}

/** Fail every parked call, so a renderer teardown never leaves a promise hanging. */
export function rejectAllAppControl(reason: string): void {
  for (const [requestId, entry] of pending) {
    pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
}

/**
 * Perform one app call through the renderer.
 *
 * Returns whatever the renderer resolved the channel or action to. Throws when
 * no renderer accepted the request, when the wait expired, or when the renderer
 * reported a failure.
 */
export async function requestAppControl<T = unknown>(
  target: AppControlTarget,
  timeoutMs = APP_CONTROL_TIMEOUT_MS
): Promise<T> {
  const requestId = randomUUID()
  const request: AppControlRequest = { requestId, target }
  const answer = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('The app did not answer the operation in time.'))
    }, timeoutMs)
    pending.set(requestId, {
      resolve: resolve as (result: unknown) => void,
      reject,
      timer
    })
  })
  let delivered = false
  if (responder && !responder.isDestroyed()) {
    delivered = sendToRenderer(responder, 'appControl:request', request)
  }
  if (!delivered) {
    const entry = pending.get(requestId)
    if (entry) {
      pending.delete(requestId)
      clearTimeout(entry.timer)
    }
    throw new Error('No running CodeInOven window can perform the operation.')
  }
  Logger.dev('App control request dispatched', { requestId, kind: target.kind })
  return answer
}
