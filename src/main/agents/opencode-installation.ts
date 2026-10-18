import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import {
  OPENCODE_COMMAND,
  OPENCODE_COMMAND_CANDIDATES,
  parseOpenCodeMajor,
  type OpenCodeInstallation
} from '../../lib/opencode-version'
import { compareVersions, selectNewestCandidate } from '../../lib/version-compare'
import { buildProcessEnvironment, resolveExecutablePaths } from '../drivers/cli-environment'
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

/** Installs at a version other than the canonical one, so drift is reportable. */
let cachedDuplicates: OpenCodeInstall[] = []

/** The canonical install, remembered so a caller can read its runtime. */
let cachedCanonicalInstall: OpenCodeInstall | null = null

/** When the assessment last ran, so a repeated pass reuses it instead of re-probing. */
let assessedAt = 0

/**
 * How long an assessment stands before it is probed again.
 *
 * The Harnesses page re-derives its status on demand, and a `--version` spawn
 * per install per pass is work a machine should not repeat while nothing has
 * changed. A refresh that means it asks for `force`.
 */
const INSTALL_CACHE_TTL_MS = 30_000

/**
 * One OpenCode install the machine can run, identified by its real executable.
 *
 * OpenCode arrives through more than one channel: a package manager installs it
 * under the manager's prefix, and the harness's own `upgrade` writes beneath
 * `~/.opencode`. The two drift, so a machine routinely carries two versions at
 * once, and a bare name cannot tell them apart because PATH silently decides
 * which one a spawn reaches.
 */
export interface OpenCodeInstall {
  /** The candidate name that resolved this executable. */
  command: string
  /** Absolute path of the executable that answered `--version`. */
  executable: string
  /** Real path, so one binary reached under two names counts as one install. */
  identity: string
  version: string
  /** Parsed major version, or NaN when the line carried no number. */
  major: number
  /** The resolved runtime, for callers that need its execution target. */
  runtime: HarnessRuntime
}

/** Every OpenCode install found at a version other than the canonical one. */
export function cachedOpenCodeDuplicates(): OpenCodeInstall[] {
  return cachedDuplicates
}

/** The canonical install itself, with the runtime it was resolved as. */
export function cachedOpenCodeInstall(): OpenCodeInstall | null {
  return cachedCanonicalInstall
}

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
  cachedCanonicalInstall = null
  cachedDuplicates = []
  assessedAt = 0
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

/** The root OpenCode's own installer writes to (`~/.opencode`). */
function managedInstallRoot(env: NodeJS.ProcessEnv): string {
  const home =
    env['HOME'] ?? (process.platform === 'win32' ? (env['USERPROFILE'] ?? homedir()) : homedir())
  return join(home, '.opencode')
}

/** Whether one executable is the copy the harness's own `upgrade` maintains. */
function isManagedInstall(executable: string, env: NodeJS.ProcessEnv): boolean {
  const root = managedInstallRoot(env)
  return executable === root || executable.startsWith(`${root}${sep}`)
}

function realPathOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Every OpenCode install this machine can run, best first.
 *
 * `OPENCODE_COMMAND_CANDIDATES` names what to look for; resolving a name to its
 * first PATH hit then hides every install behind it, which is exactly the pair a
 * package manager and the harness's own `upgrade` create. Every PATH match for
 * every name is probed instead, one real path counts once, and the order is the
 * canonical rule: newest version first, the managed `~/.opencode` copy before a
 * package manager's copy at the same version (the app then drives the install
 * its own updater maintains), then PATH order.
 *
 * Bounded and non-fatal: an install that will not answer `--version` is dropped,
 * so a broken copy cannot take detection down with it.
 */
export async function detectOpenCodeInstallations(): Promise<OpenCodeInstall[]> {
  const env = buildProcessEnvironment()
  const seen = new Set<string>()
  const probes: Array<Promise<(OpenCodeInstall & { pathOrder: number }) | null>> = []
  let pathOrder = 0
  for (const command of OPENCODE_COMMAND_CANDIDATES) {
    for (const executable of resolveExecutablePaths(command, env)) {
      const identity = realPathOf(executable)
      if (seen.has(identity)) continue
      seen.add(identity)
      const order = pathOrder
      pathOrder += 1
      const runtime: HarnessRuntime = {
        command,
        executable,
        resolvedPath: executable,
        target: { kind: 'native' }
      }
      probes.push(
        probeHarnessRuntime(runtime, ['--version'], env).then((result) => {
          if (!result.ok) return null
          const version = firstLine(result.stdout || result.stderr)
          if (!version) return null
          return {
            command,
            executable,
            identity,
            version,
            major: parseOpenCodeMajor(version),
            runtime,
            pathOrder: order
          }
        })
      )
    }
  }
  const probed = await Promise.all(probes)
  return probed
    .filter((entry): entry is OpenCodeInstall & { pathOrder: number } => entry !== null)
    .sort((a, b) => {
      const byVersion = compareVersions(b.version, a.version)
      if (byVersion !== 0) return byVersion
      const byManaged = Number(isManagedInstall(b.executable, env)) - Number(isManagedInstall(a.executable, env))
      if (byManaged !== 0) return byManaged
      return a.pathOrder - b.pathOrder
    })
    .map(({ pathOrder: _pathOrder, ...install }) => install)
}

/**
 * Name the installs that disagree with the canonical one.
 *
 * Nothing is removed here: a package-managed copy belongs to the user, and the
 * app only needs the drift to stop being silent. The canonical install is the
 * one every spawn uses, so a stale copy is dead weight rather than a second
 * answer.
 */
function reportInstalls(installs: OpenCodeInstall[], canonical: OpenCodeInstall | undefined): void {
  const duplicates = canonical
    ? installs.filter(
        (install) => install.identity !== canonical.identity && install.version !== canonical.version
      )
    : []
  cachedDuplicates = duplicates
  if (!canonical) return
  if (duplicates.length === 0) {
    Logger.dev(`[opencode] one install: ${canonical.executable} (${canonical.version})`)
    return
  }
  Logger.info(
    `[opencode] ${installs.length} installs; driving ${canonical.executable} (${canonical.version}); ` +
      `other versions: ${duplicates
        .map((install) => `${install.executable} (${install.version})`)
        .join(', ')}`
  )
}

/**
 * Assess this machine's OpenCode installs and adopt the canonical one.
 *
 * One function decides, so every consumer agrees: the driver factory, the
 * Harnesses page, the auth handoff and the updater all read this result instead
 * of resolving `opencode` by name on their own. A name-based resolution is what
 * let a package-managed copy sit at one version while another copy self-updated,
 * and what let a login run a different binary than the driver.
 */
export async function resolveOpenCodeInstall(
  options: { force?: boolean } = {}
): Promise<OpenCodeInstall | null> {
  if (!options.force && cachedCanonicalInstall && Date.now() - assessedAt < INSTALL_CACHE_TTL_MS) {
    return cachedCanonicalInstall
  }
  const installs = await detectOpenCodeInstallations().catch((error: unknown) => {
    Logger.dev('opencode install probe failed (non-fatal):', error)
    return []
  })
  const canonical = installs[0] ?? null
  reportInstalls(installs, canonical ?? undefined)
  cachedCanonicalInstall = canonical
  assessedAt = Date.now()
  rememberOpenCodeInstallation(
    canonical
      ? { command: canonical.executable, version: canonical.version, major: canonical.major }
      : null
  )
  return canonical
}

/**
 * Resolve and remember the install the app will drive.
 *
 * The canonical install is spawned by its own path, never by a bare name: PATH
 * would hand a spawn whichever copy comes first, which is how a login ran a
 * different binary than the driver and how a package-managed copy stayed on an
 * older version while another copy self-updated. A machine whose install is
 * only reachable some other way (WSL) falls back to resolving by name.
 */
export async function detectOpenCodeInstallation(
  options: { force?: boolean } = {}
): Promise<OpenCodeInstallation | null> {
  const canonical = await resolveOpenCodeInstall(options)
  if (canonical) return cachedInstallation
  return detectOpenCodeInstallationByName(options)
}

/**
 * The name-based probe, for an install this process cannot reach as a path.
 *
 * A Windows machine can drive OpenCode inside a WSL distribution, where the
 * executable lives behind a distro hop and `discoverHarnessRuntimes` is what
 * knows the name and the distribution to reach it in. Returns the memoized
 * install unchanged when discovery itself fails.
 */
async function detectOpenCodeInstallationByName(
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

/**
 * The command to spawn for the cached install, canonical `opencode` when unknown.
 *
 * For a native install this is the executable's own path, so a spawn cannot land
 * on a different copy than the one the app assessed; a WSL install keeps its
 * command name, because the distribution hop is what resolves it.
 */
export function resolvedOpenCodeCommand(): string {
  return cachedInstallation?.command ?? OPENCODE_COMMAND
}