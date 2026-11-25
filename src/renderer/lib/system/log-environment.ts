import { invoke } from '$lib/ipc.svelte'
import { buildEnvironmentLabel, type BuildEnvironment } from '$shared/build-environment'
import { formatLogEnvironment, type LogEnvironment } from '$shared/log-environment'

/**
 * The build and host facts the durable Logger stamps on every record, as the
 * renderer's Exceptions panel needs them.
 *
 * The main-process logger owns these values — the version it was packaged with
 * (nightly suffix included), the OS version and the CPU — and answers them over
 * `logger:environment`. Nothing here resolves a second copy, so a stack trace
 * pasted from the panel and a line read from the durable log on the same machine
 * name the same build.
 *
 * The Logger resolves these facts during startup and the bridge that answers
 * for them is registered after that, so a fast window's first ask can reach
 * nothing. Nothing here resolves a second copy: it asks again instead.
 */
let facts: LogEnvironment | null = null
let inFlight: Promise<void> | null = null
let attempts = 0

/** How long a window that asked before the bridge existed keeps asking. */
const RETRY_DELAY_MS = 250
const MAX_ATTEMPTS = 20

/** Readers waiting for the first final answer, e.g. a panel with entries
 *  recorded while the logger was still resolving its own facts. */
const waiting = new Set<() => void>()

/** Name a checkout or a probe beside the version; absent on a shipped build. */
function buildLabel(): string | null {
  if (typeof window === 'undefined') return null
  const bridge = window as { api?: { windowInfo?: { buildEnvironment?: BuildEnvironment } } }
  return buildEnvironmentLabel(bridge.api?.windowInfo?.buildEnvironment)
}

/** Ask main for the logger's facts, unless a final answer is already held. */
export function requestLogEnvironment(): void {
  if (facts || inFlight) return
  inFlight = invoke('logger:environment')
    .then((environment) => {
      if (environment.appVersion === 'unknown') return
      facts = environment
      for (const listener of waiting) listener()
      waiting.clear()
    })
    .catch(() => {
      // The channel is registered once startup has finished wiring the durable
      // log bridge, which is after this window exists, so the first ask of a
      // fast renderer reaches nothing. Ask again rather than giving up: the
      // answer is what stamps every later stack trace.
      if (attempts >= MAX_ATTEMPTS) return
      attempts += 1
      setTimeout(requestLogEnvironment, RETRY_DELAY_MS)
    })
    .finally(() => {
      inFlight = null
    })
}

/**
 * Run `listener` once the logger's facts are known, or now when they already are.
 *
 * A captured failure has to be recorded the moment it happens, so an entry can
 * predate the answer; this is how it gets stamped afterwards instead of keeping
 * a blank where its build belongs.
 */
export function onLogEnvironment(listener: () => void): void {
  if (facts) listener()
  else waiting.add(listener)
}

/**
 * The build and host line a captured stack trace carries.
 *
 * Undefined while the logger's answer is still pending: an entry with no line
 * is truer than one naming no build at all.
 */
export function logEnvironmentLine(): string | undefined {
  requestLogEnvironment()
  return facts ? formatLogEnvironment(facts, buildLabel()) : undefined
}
