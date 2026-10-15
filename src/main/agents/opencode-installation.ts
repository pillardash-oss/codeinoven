import {
  OPENCODE_COMMAND,
  OPENCODE_COMMAND_CANDIDATES,
  parseOpenCodeMajor,
  type OpenCodeInstallation
} from '../../lib/opencode-version'
import { selectNewestCandidate } from '../../lib/version-compare'
import {
  discoverHarnessRuntimes,
  probeHarnessRuntime,
  type HarnessRuntime
} from '../drivers/harness-runtime'
import { Logger } from '../system/logger'

/**
 * Which OpenCode install the app should drive, resolved once and remembered.
 *
 * The harness is a single `opencode` entry; its V1 and V2 lines speak different
 * server APIs, so the driver must know which one is installed before it spawns
 * anything. `ProviderConnectionService` probes the same candidates during its
 * pass and refreshes this cache whenever the install or version changes, and the
 * chat engine warms it before building its driver map so a V2-only machine never
 * starts a turn on the V1 transport.
 */

let cachedInstallation: OpenCodeInstallation | null = null

/** The one in-flight probe, shared by every caller that wants the install. */
let detectionInFlight: Promise<OpenCodeInstallation | null> | null = null

/** True once a probe has settled, so later callers reuse the memory. */
let detectionSettled = false

/** The last resolved install, or null when nothing has been probed yet. */
export function cachedOpenCodeInstallation(): OpenCodeInstallation | null {
  return cachedInstallation
}

/** Record a probe result (null clears it, e.g. the harness was uninstalled). */
export function rememberOpenCodeInstallation(installation: OpenCodeInstallation | null): void {
  cachedInstallation = installation
}

/** Test seam: forget the memoized install so a fresh detection can run. */
export function resetOpenCodeInstallationCache(): void {
  cachedInstallation = null
  detectionInFlight = null
  detectionSettled = false
}

/**
 * Start (or join) the one in-flight installation probe.
 *
 * The install decides which OpenCode transport a turn speaks, so callers that
 * are about to start a turn await the result. Callers that only keep the app
 * interactive, such as the post-paint boot, start it here instead of awaiting
 * it: the probe runs behind a visible window, and a completed probe refreshes
 * the already-built driver rather than holding `features:ready`. Single-flight
 * so a second caller (the provider catalog pass, the account orchestrator)
 * joins the same probe instead of spawning the same candidates again.
 */
export function warmOpenCodeInstallation(): Promise<OpenCodeInstallation | null> {
  // Once a probe has settled, the resolved install is the answer. A caller that
  // acquires the driver on every turn must not re-spawn the probe each time; a
  // mid-session install change is detected by `ProviderConnectionService`, which
  // re-probes and calls `rememberOpenCodeInstallation` directly.
  if (detectionSettled) return Promise.resolve(cachedInstallation)
  detectionInFlight ??= detectOpenCodeInstallation()
    .then((installation) => {
      detectionSettled = true
      return installation
    })
    .finally(() => {
      detectionInFlight = null
    })
  return detectionInFlight
}

/**
 * The version line of the install the driver factory will actually use.
 *
 * The compliance gate and the driver must agree on one install identity.
 * Installation detection probes every candidate and selects the NEWEST
 * (`selectNewestCandidate`), and `opencode-harness-driver` reads that same cache,
 * so a proof recorded and checked against this version always covers the
 * harness the app drives rather than a lower-version candidate that merely
 * answered first.
 *
 * Asynchronous and single-flight (`warmOpenCodeInstallation`), so a caller never
 * blocks the main thread on a child process. Returns null when no install
 * answers; detection has already logged the per-candidate attempt list.
 */
export async function openCodeInstallationVersion(): Promise<string | null> {
  const installation = await warmOpenCodeInstallation().catch((error: unknown) => {
    Logger.dev('opencode install detection failed (non-fatal):', error)
    return null
  })
  return installation?.version ?? null
}

function firstLine(output: string): string {
  return output.split(/\r?\n/u)[0]?.trim() ?? ''
}

/**
 * Probe every candidate command and remember the newest install that answers.
 *
 * Resolution is bounded and non-fatal: a missing binary, a failed spawn, or a
 * `--version` that never answers simply drops that candidate. The result is
 * memoized for the driver factory and the Harnesses page.
 */
export async function detectOpenCodeInstallation(
  options: { force?: boolean } = {}
): Promise<OpenCodeInstallation | null> {
  let runtimes: Map<string, HarnessRuntime | null>
  try {
    runtimes = await discoverHarnessRuntimes([...OPENCODE_COMMAND_CANDIDATES], {
      force: options.force
    })
  } catch (error) {
    Logger.dev('opencode install discovery failed (non-fatal):', error)
    return cachedInstallation
  }

  const candidates: Array<{ version: string; value: HarnessRuntime }> = []
  // Per-candidate reasons, kept so an unanswered detection is diagnosable at
  // dev level instead of a silent null.
  const attempts: Array<{ command: string; executable: string | null; reason: string }> = []
  // Probe every candidate at once: each probe is an independent `--version`
  // child process, so running them sequentially only makes the pass pay the
  // slowest one once per candidate. A bounded handful of candidates keeps this
  // from hammering a low-end machine.
  const probed = await Promise.all(
    OPENCODE_COMMAND_CANDIDATES.map(async (command) => {
      const runtime = runtimes.get(command)
      if (!runtime) {
        attempts.push({ command, executable: null, reason: 'not found on the app PATH' })
        return null
      }
      const result = await probeHarnessRuntime(runtime, ['--version'])
      if (!result.ok) {
        attempts.push({ command, executable: runtime.executable, reason: result.reason })
        return null
      }
      const version = firstLine(result.stdout || result.stderr)
      if (!version) {
        attempts.push({
          command,
          executable: runtime.executable,
          reason: 'answered an empty --version line'
        })
        return null
      }
      return { version, value: runtime }
    })
  )
  for (const candidate of probed) {
    if (candidate) candidates.push(candidate)
  }

  const best = selectNewestCandidate(candidates)
  const installation: OpenCodeInstallation | null = best
    ? {
        command: best.value.command,
        version: best.version,
        major: parseOpenCodeMajor(best.version)
      }
    : null
  if (!installation) {
    Logger.dev('opencode version detection could not resolve an installed harness', {
      candidates: [...OPENCODE_COMMAND_CANDIDATES],
      platform: process.platform,
      attempts
    })
  }
  rememberOpenCodeInstallation(installation)
  return installation
}

/** The command to spawn for the cached install, canonical `opencode` when unknown. */
export function resolvedOpenCodeCommand(): string {
  return cachedInstallation?.command ?? OPENCODE_COMMAND
}
