import type { AgentEvent } from '$shared/types'
import { subscribe } from '$lib/ipc.svelte'
import { logRendererDev } from './renderer-logger'

/**
 * Dev-only liveness watchdog for the agent event stream.
 *
 * When the app went quiet after a stop/abort click during earlier sessions,
 * there was no record of what the renderer last saw before it stopped
 * reacting. This keeps a small ring buffer of recent `agent:event` traffic
 * and flags the gap on disk (once per silence) if too long passes between
 * events while a run is presumably still in flight, so a future stall has a
 * trail instead of nothing.
 *
 * Entirely inert in production: `install()` no-ops unless `import.meta.env.DEV`,
 * so this never allocates a timer, a listener, or a buffer entry outside dev.
 */

const RING_SIZE = 25
const CHECK_INTERVAL_MS = 10_000
const STALL_THRESHOLD_MS = 45_000

interface RingEntry {
  type: string
  sessionId?: string
  at: number
}

let installed = false

export function installStallWatchdog(): void {
  if (!import.meta.env.DEV) return
  if (installed) return
  installed = true

  const ring: RingEntry[] = []
  let lastEventAt = Date.now()
  let warnedForThisSilence = false

  subscribe('agent:event', (...args: unknown[]) => {
    const event = args[0] as AgentEvent | undefined
    if (!event) return
    lastEventAt = Date.now()
    warnedForThisSilence = false
    const sessionId = 'sessionId' in event ? event.sessionId : undefined
    ring.push({ type: event.type, sessionId, at: lastEventAt })
    if (ring.length > RING_SIZE) ring.shift()
  })

  setInterval(() => {
    const silentFor = Date.now() - lastEventAt
    if (silentFor < STALL_THRESHOLD_MS || warnedForThisSilence) return
    warnedForThisSilence = true
    const trail = ring
      .map((entry) => `${new Date(entry.at).toISOString()} ${entry.type} ${entry.sessionId ?? ''}`)
      .join('\n')
    logRendererDev(
      `[stall-watchdog] no agent:event received for ${Math.round(silentFor / 1000)}s. Last ${ring.length} events:\n${trail || '(none observed yet)'}`
    )
  }, CHECK_INTERVAL_MS)
}
