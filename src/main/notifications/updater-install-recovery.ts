import { opendir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Logger } from '../system/logger'

/**
 * Bounded install retries and abandoned-staging cleanup for the updater.
 *
 * electron-updater hands the downloaded payload to the platform installer and
 * quits. On macOS that means ShipIt validates the staged bundle's signature
 * *after* the app is gone, so a rejected bundle produces no `error` event: the
 * app simply relaunches on the old version. With auto-download and auto-install
 * both enabled, every launch then re-armed the same install and each attempt
 * staged another full app copy in the system temp directory   39 copies in five
 * minutes before this guard existed.
 *
 * Two independent protections live here:
 *
 *   1. A dispatch record written before `quitAndInstall()`. Comparing it with
 *      the version the app is actually running tells us on every platform
 *      whether the install applied, without depending on the installer to
 *      report anything back.
 *   2. A sweep of the staging directories each platform's installer abandons
 *      when that install fails.
 */

/** Persisted just before the update payload is handed to the platform installer. */
export const INSTALL_DISPATCH_FILE = 'updater/install-dispatch.json'
/** Persisted record of installs that were handed off but never applied. */
export const INSTALL_FAILURE_FILE = 'updater/install-failures.json'

/**
 * How many times one version may be handed to the platform installer before
 * the automatic install stops. ShipIt already retries three times per cycle, so
 * this bounds whole relaunch cycles rather than individual installer attempts.
 */
export const INSTALL_ATTEMPT_LIMIT = 3

/**
 * How long a version that exhausted its attempts stays suppressed. The
 * suppression clears on its own in case the failure was environmental rather
 * than a property of the build (a full disk, an app that would not release its
 * files, an unsigned test bundle being replaced by a signed one).
 */
export const INSTALL_RETRY_COOLDOWN_MS = 12 * 60 * 60 * 1000

/** A live AppImage mount point younger than this belongs to a running instance. */
const MOUNT_POINT_MIN_AGE_MS = 60 * 60 * 1000

/** Ceiling on how many staging directories one sweep removes. */
const MAX_SWEEP_REMOVALS = 64

/** How many staged entries one sweep is allowed to inspect per directory. */
const MAX_SWEEP_CANDIDATES = 512

/** An install we handed to the platform installer but which never applied. */
export interface InstallDispatch {
  version: string
  dispatchedAt: number
}

/** Consecutive failed installs of a single version. */
export interface InstallFailureState {
  version: string
  attempts: number
  lastAttemptAt: number
}

export type DispatchOutcome =
  | { outcome: 'none' }
  | { outcome: 'applied'; version: string }
  | { outcome: 'failed'; version: string; dispatchedAt: number }

/** Trailing build counter of a prerelease tag, e.g. `nightly.9` in `0.5.58-nightly.9`. */
const PRERELEASE_BUILD = /(\d+)$/

/** The prerelease tag, e.g. `nightly.5`; null for a bare release. */
export function prereleaseTag(version: string): string | null {
  return version.split('-')[1] ?? null
}

/**
 * The release base of a version, e.g. `0.5.66` for `0.5.66-nightly.5`.
 *
 * `nightly`'s package version IS the next stable version (`deploy-nightly.sh`),
 * so the base of a nightly names the stable release it is a preview of.
 */
export function baseVersion(version: string): string {
  return version.split('-')[0] ?? version
}

/**
 * Compare two semver-shaped version strings, tolerating a prerelease suffix
 * (`0.5.58-nightly.5`). Missing segments read as zero, so `0.5.58` and
 * `0.5.58.0` compare equal, and the suffix's trailing number orders nightly
 * builds numerically rather than lexically, so `nightly.10` beats `nightly.9`.
 */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0
  const core = (value: string): number[] =>
    value
      .split('-')[0]
      .split('.')
      .map((part) => {
        const parsed = Number.parseInt(part, 10)
        return Number.isFinite(parsed) ? parsed : 0
      })
  const left = core(a)
  const right = core(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  const suffix = (value: string): string | null => value.split('-')[1] ?? null
  const leftSuffix = suffix(a)
  const rightSuffix = suffix(b)
  // A bare release outranks any prerelease of the same version.
  if (leftSuffix === null || rightSuffix === null) {
    if (leftSuffix === rightSuffix) return 0
    return leftSuffix === null ? 1 : -1
  }
  const leftBuild = Number.parseInt(PRERELEASE_BUILD.exec(leftSuffix)?.[1] ?? '', 10)
  const rightBuild = Number.parseInt(PRERELEASE_BUILD.exec(rightSuffix)?.[1] ?? '', 10)
  if (Number.isFinite(leftBuild) && Number.isFinite(rightBuild) && leftBuild !== rightBuild) {
    return leftBuild > rightBuild ? 1 : -1
  }
  return a > b ? 1 : -1
}

/**
 * Whether the build the app is running is already the newest the feed resolved
 * for its channel, so an offered update must not be downloaded or installed
 * again.
 *
 * electron-updater is left as the authority on "is there something newer", but
 * when the channel it was left on is stale (the setting read failed and the
 * previous channel stayed in place) it can offer a prerelease that is older
 * than the release already installed: `0.5.61-nightly.2` is lower than
 * `0.5.61`, and handing it to the installer is exactly what made a launch
 * re-download and replay the same install on every start. Nothing equal to or
 * older than the running build is ever an update, so this is the last word that
 * stops the loop before a download begins.
 *
 * A bare release whose base equals the running nightly's base is the same
 * release the nightly previews (`0.5.66` next to `0.5.66-nightly.5`), so it is
 * not an upgrade either: crossing over only re-downloads and re-installs the
 * build the user effectively already runs.
 */
export function isRunningNewestBuild(runningVersion: string, offeredVersion: string): boolean {
  if (compareVersions(runningVersion, offeredVersion) >= 0) return true
  const runningFromNightly = prereleaseTag(runningVersion) !== null
  const offeredIsStable = prereleaseTag(offeredVersion) === null
  return (
    runningFromNightly &&
    offeredIsStable &&
    baseVersion(runningVersion) === baseVersion(offeredVersion)
  )
}

/**
 * Pick the release a nightly-channel install should move to.
 *
 * Stable only wins when its base is genuinely newer than the nightly feed's,
 * which is the one case where a nightly user has to cross over (the cycle that
 * nightly was previewing is published, and nightlies have moved past it). Once
 * stable has caught up to the nightly's own base the two are the same release,
 * so switching to it is churn and the nightly feed stays the source of truth.
 */
export function selectNightlyChannelRelease<T extends { version: string }>(
  nightly: T,
  stable: T
): T {
  return compareVersions(baseVersion(stable.version), baseVersion(nightly.version)) > 0
    ? stable
    : nightly
}

/**
 * Decide what a dispatch record means now that we know which version is
 * running. A version at or past the dispatched one means the install landed
 * (a user installing something even newer counts as applied); anything older
 * means the platform installer refused it without telling us.
 */
export function resolveDispatchOutcome(
  dispatch: InstallDispatch | null,
  runningVersion: string
): DispatchOutcome {
  if (dispatch === null) return { outcome: 'none' }
  if (compareVersions(runningVersion, dispatch.version) >= 0) {
    return { outcome: 'applied', version: dispatch.version }
  }
  return { outcome: 'failed', version: dispatch.version, dispatchedAt: dispatch.dispatchedAt }
}

/** Fold one failure into the record, restarting the count for a different version. */
export function nextFailureState(
  previous: InstallFailureState | null,
  version: string,
  attemptedAt: number
): InstallFailureState {
  const attempts = previous !== null && previous.version === version ? previous.attempts + 1 : 1
  return { version, attempts, lastAttemptAt: attemptedAt }
}

/**
 * Whether the unattended path may hand `version` to the platform installer.
 * A different version than the one that failed always starts with a clean slate.
 */
export function nextInstallPermitted(
  state: InstallFailureState | null,
  version: string,
  now: number
): boolean {
  if (state === null || state.version !== version) return true
  if (state.attempts < INSTALL_ATTEMPT_LIMIT) return true
  return now - state.lastAttemptAt >= INSTALL_RETRY_COOLDOWN_MS
}

/** True once the attempts for `version` are used up and the cooldown has not passed. */
export function isInstallSuppressed(
  state: InstallFailureState | null,
  version: string,
  now: number
): boolean {
  return !nextInstallPermitted(state, version, now)
}

/** User-facing reason the automatic install is holding off, or null when it is not. */
export function suppressedInstallReason(
  state: InstallFailureState | null,
  version: string
): string | null {
  if (state === null || state.version !== version) return null
  if (state.attempts < INSTALL_ATTEMPT_LIMIT) return null
  return `Automatic install of ${version} is paused after ${state.attempts} failed attempts. Restart to install it anyway.`
}

/**
 * Resolve the macOS bundle identifier from the packaged app, because ShipIt
 * names every staging directory after it. Returns null in development and on
 * platforms without an `Info.plist`, where no ShipIt staging can exist anyway.
 */
export async function readMacBundleIdentifier(
  resourcesPath: string | undefined
): Promise<string | null> {
  if (!resourcesPath) return null
  try {
    const plist = await readFile(join(dirname(resourcesPath), 'Info.plist'), 'utf-8')
    const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/** Where this platform's abandoned install staging lives. */
export interface StagingSweepContext {
  platform: NodeJS.Platform
  /** System temp directory the platform installer stages into. */
  tmpDir: string
  /** Per-user cache root (`~/Library/Caches`, `%LOCALAPPDATA%`, `~/.cache`). */
  cacheHome: string
  /** electron-updater's cache dir, when the packaged app resolves one. */
  updaterCacheDir: string | null
  /** macOS bundle identifier; gates the ShipIt rules. */
  bundleId: string | null
  /** Lowercased package name (`codeinoven`); the AppImage mount prefix uses its first six characters. */
  appName: string
}

export interface StagingSweepResult {
  /** Absolute paths that were removed, in removal order. */
  removed: string[]
  /** Whether the electron-updater pending payload was dropped too. */
  pendingDropped: boolean
  /** Candidates left behind because the scan was capped. */
  deferred: number
}

/** One attributable source of abandoned staging for a single platform. */
interface StagingRule {
  label: string
  directory: string
  minAgeMs: number
  matches: (name: string) => boolean
  /**
   * Extra ownership proof for staging that lives in a directory other apps
   * share, checked before anything is removed.
   */
  ownedBy?: (entry: string) => Promise<boolean>
}

const NSIS_PLUGIN_DIR = /^ns[A-Za-z0-9]{4,8}\.tmp$/
// Exact helper bytes shipped before ownership markers were introduced.
const LEGACY_WINDOWS_HELPER_HASHES = new Set([
  'a2979a7e8c4d5c3138c0a6cb47f1d566f69f4b9f07eb0fe430c19b1a25d424ec',
  '2e2f6e66b010902ef20cfa3ed81efb335cac641c8d2e651030190c45510079ef'
])
/**
 * NSIS `$PLUGINSDIR` lives in `%TEMP%` under a generic `nsXXXXXX.tmp` name
 * shared by every NSIS installer on the machine, so a name match alone is not
 * proof of ownership. Require our installer marker or exact legacy helper
 * bytes; generic archives and 7z-out also belong to unrelated applications.
 */
async function ownsNsisPluginDir(entry: string): Promise<boolean> {
  try {
    const marker = join(entry, 'codeinoven-update-owner')
    if ((await stat(marker)).size !== 10) return false
    return (await readFile(marker, 'utf8')) === 'CodeInOven'
  } catch {
    try {
      const helper = join(entry, 'close-windows-app.ps1')
      if ((await stat(helper)).size > 64 * 1024) return false
      const digest = createHash('sha256')
        .update((await readFile(helper, 'utf8')).replaceAll('\r\n', '\n'))
        .digest('hex')
      return LEGACY_WINDOWS_HELPER_HASHES.has(digest)
    } catch {
      return false
    }
  }
}

function stagingRules(context: StagingSweepContext): StagingRule[] {
  const bundleId = context.bundleId
  switch (context.platform) {
    case 'darwin': {
      if (bundleId === null) return []
      return [
        {
          // ShipIt unpacks and code-signature-checks the incoming bundle here.
          label: 'ShipIt staging copy',
          directory: context.tmpDir,
          minAgeMs: 0,
          matches: (name) => name.startsWith(`${bundleId}.ShipIt.`)
        },
        {
          // ShipIt's own extracted-update cache, also named after the bundle id.
          label: 'ShipIt update cache',
          directory: join(context.cacheHome, `${bundleId}.ShipIt`),
          minAgeMs: 0,
          matches: (name) => name.startsWith('update.')
        }
      ]
    }
    case 'win32':
      return [
        {
          // electron-builder unpacks the whole app into `$PLUGINSDIR` before
          // copying it into the install directory; a killed installer leaves it.
          label: 'NSIS plugin directory',
          directory: context.tmpDir,
          minAgeMs: 24 * 60 * 60 * 1000,
          matches: (name) => NSIS_PLUGIN_DIR.test(name),
          ownedBy: ownsNsisPluginDir
        }
      ]
    case 'linux': {
      const mountPrefix = `.mount_${context.appName.slice(0, 6)}`
      return [
        {
          // The AppImage runtime's FUSE mount point. The running instance owns
          // the live one, so only long-abandoned ones are eligible.
          label: 'AppImage mount point',
          directory: context.tmpDir,
          minAgeMs: MOUNT_POINT_MIN_AGE_MS,
          matches: (name) => name.startsWith(mountPrefix)
        }
      ]
    }
    default:
      return []
  }
}

/**
 * Remove the staging this platform's installer abandoned. Only entries this app
 * can positively attribute to itself are touched, and each rule carries the age
 * its own installer requires: zero for staging that only exists while an
 * installer process is alive on macOS, a day for marked Windows directories,
 * and an hour for mount points a running instance may still hold open.
 */
export async function purgeAbandonedInstallStaging(
  context: StagingSweepContext,
  options: { now?: number; dropPendingPayload?: boolean } = {}
): Promise<StagingSweepResult> {
  const now = options.now ?? Date.now()
  const removed: string[] = []
  let deferred = 0

  for (const rule of stagingRules(context)) {
    if (removed.length >= MAX_SWEEP_REMOVALS) {
      deferred += 1
      continue
    }
    let inspected = 0
    try {
      const entries = await opendir(rule.directory)
      for await (const candidate of entries) {
        if (++inspected > MAX_SWEEP_CANDIDATES || removed.length >= MAX_SWEEP_REMOVALS) {
          deferred += 1
          break
        }
        if (!candidate.isDirectory() || !rule.matches(candidate.name)) continue
        const entry = join(rule.directory, candidate.name)
        try {
          const info = await stat(entry)
          if (now - info.mtimeMs < rule.minAgeMs) continue
          if (rule.ownedBy && !(await rule.ownedBy(entry))) continue
          await rm(entry, { recursive: true, force: true })
          removed.push(entry)
        } catch (error: unknown) {
          Logger.dev(`Updater: could not remove staging ${entry}`, error)
        }
      }
    } catch (error: unknown) {
      Logger.dev(`Updater: staging sweep skipped ${rule.label}`, error)
    }
  }

  let pendingDropped = false
  if (options.dropPendingPayload === true && context.updaterCacheDir !== null) {
    // The payload that refused to install would be replayed verbatim on the
    // next attempt. Dropping it makes the retry fetch fresh bytes instead.
    const pending = join(context.updaterCacheDir, 'pending')
    try {
      const entries = await readdir(pending)
      if (entries.length > 0) {
        await rm(pending, { recursive: true, force: true })
        pendingDropped = true
        Logger.dev(`Updater: dropped ${entries.length} staged update files from ${pending}`)
      }
    } catch (error: unknown) {
      Logger.dev(`Updater: could not clear ${pending}`, error)
    }
  }

  if (removed.length > 0) {
    Logger.dev(`Updater: removed ${removed.length} abandoned install staging entries`)
    for (const entry of removed) Logger.dev('Updater: removed staging', entry)
  }
  if (deferred > 0) {
    Logger.dev(`Updater: staging sweep left ${deferred} candidates for the next pass`)
  }
  return { removed, pendingDropped, deferred }
}
