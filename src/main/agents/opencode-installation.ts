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
  for (const command of OPENCODE_COMMAND_CANDIDATES) {
    const runtime = runtimes.get(command)
    if (!runtime) continue
    const result = await probeHarnessRuntime(runtime, ['--version'])
    if (!result.ok) continue
    const version = firstLine(result.stdout || result.stderr)
    candidates.push({ version, value: runtime })
  }

  const best = selectNewestCandidate(candidates)
  const installation: OpenCodeInstallation | null = best
    ? {
        command: best.value.command,
        version: best.version,
        major: parseOpenCodeMajor(best.version)
      }
    : null
  rememberOpenCodeInstallation(installation)
  return installation
}

/** The command to spawn for the cached install, canonical `opencode` when unknown. */
export function resolvedOpenCodeCommand(): string {
  return cachedInstallation?.command ?? OPENCODE_COMMAND
}
