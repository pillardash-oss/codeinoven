/**
 * The app-control bridge's wire types.
 *
 * `@cio-hey` lets an agent work the app itself, so it needs to reach the two
 * halves of what a person can do which the plain orchestration tools cannot:
 * the app's own renderer-invokable IPC channels, and the renderer-local
 * navigation/panel/browser actions that have no channel at all.
 *
 * Main owns the request; the renderer owns the execution, because the renderer
 * is the only place a channel can be invoked exactly as the UI invokes it. A
 * request carries a `requestId`, the renderer answers on `appControl:respond`
 * with the same id, and main resolves the call it parked under that id. This is
 * the same `Map<requestId, resolve>` shape the app already uses for scope
 * confirmations and the browser's screen-share picker.
 */

/** One thing the agent asked the app to do. */
export type AppControlTarget =
  | {
      /** Invoke an app IPC channel with positional arguments, as the UI would. */
      kind: 'channel'
      channel: string
      args: unknown[]
    }
  | {
      /** Run a renderer-registered UI action (navigate, open a panel, ...). */
      kind: 'action'
      action: string
      params: Record<string, unknown>
    }
  | {
      /** Ask the renderer to list the UI actions it currently offers. */
      kind: 'actions'
    }

/** A request main parks and awaits. */
export interface AppControlRequest {
  requestId: string
  target: AppControlTarget
}

/** The renderer's answer to one request. */
export interface AppControlResponse {
  requestId: string
  ok: boolean
  /** Present when `ok`. */
  result?: unknown
  /** Present when the call failed; a human-readable reason. */
  error?: string
}

/** One UI action the renderer exposes to the bridge. */
export interface AppControlActionSummary {
  id: string
  description: string
  params: string[]
}
