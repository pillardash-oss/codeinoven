/**
 * Generated TypeScript source for the app-owned Pi status extension.
 *
 * The PiDriver launches `pi --mode rpc --extension <this file>` for every
 * session. The extension subscribes to pi's agent lifecycle events and calls
 * `ctx.ui.setStatus(key, text)`, which pi's RPC mode forwards to stdout as a
 * fire-and-forget `extension_ui_request` record with `method: "setStatus"`.
 * `PiRpcClient` surfaces those records so the driver can emit authoritative
 * `session.status` events (working / idle) that match what codex, claude-code,
 * and opencode drivers report. The extension is inert outside RPC mode: a
 * footer status entry is harmless in the TUI.
 *
 * Every payload is prefixed with the app marker so the driver can ignore
 * `setStatus` entries from the user's own extensions.
 */

export const PI_STATUS_EXTENSION_KEY = 'codeinoven-status'
export const PI_STATUS_WORKING = 'cio:working'
export const PI_STATUS_IDLE = 'cio:idle'
export const PI_STATUS_COMPACTING = 'cio:compacting'

export function piStatusExtension(): string {
  return `import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

const KEY = '${PI_STATUS_EXTENSION_KEY}'
const WORKING = '${PI_STATUS_WORKING}'
const IDLE = '${PI_STATUS_IDLE}'
const COMPACTING = '${PI_STATUS_COMPACTING}'

export default function (pi: ExtensionAPI) {
  const report = (state: string, ctx: ExtensionContext | undefined) => {
    // A stale lifecycle callback can arrive after the run already settled; the
    // authoritative idle check wins so the driver never latches a dead turn.
    if (state !== IDLE && ctx?.isIdle()) {
      ctx.ui.setStatus(KEY, IDLE)
      return
    }
    if (!ctx) return
    ctx.ui.setStatus(KEY, state)
  }

  pi.on('agent_start', async (_event, ctx) => {
    report(WORKING, ctx)
  })

  // Auto-compaction runs between agent runs; its dedicated extension events
  // keep the status honest while the session is busy but not streaming.
  pi.on('session_before_compact', async (_event, ctx) => {
    report(COMPACTING, ctx)
  })

  pi.on('session_compact', async (_event, ctx) => {
    report(WORKING, ctx)
  })

  pi.on('agent_settled', async (_event, ctx) => {
    if (!ctx.isIdle()) return
    ctx.ui.setStatus(KEY, IDLE)
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    ctx.ui.setStatus(KEY, undefined)
  })
}
`
}
