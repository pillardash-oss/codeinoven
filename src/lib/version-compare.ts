/**
 * Numeric semver helpers shared by harness install detection and update checks.
 *
 * Platform-safe: no Node-only or Electron imports, so both the main process and
 * the renderer can use it.
 */

/** Pull the first integer out of a version-ish string (`opencode v2.0.14` -> 2). */
export function parseMajorVersion(version: string): number {
  const match = /v?(\d+)/u.exec(version)
  const major = match ? Number.parseInt(match[1], 10) : Number.NaN
  return major
}

/** First `major[.minor[.patch]]` sequence anywhere in a version-ish string. */
const VERSION_SEQUENCE_PATTERN = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/u

/**
 * Numeric parts of a version string, read from the first numeric sequence it
 * contains. Raw `--version` lines (`opencode v2.0.18`, `codex-cli 0.44.0`) are
 * therefore comparable by their numbers instead of degrading to NaN, which
 * would make every ordering test fail and silently keep the first candidate.
 */
function versionParts(version: string): [number, number, number] {
  const match = VERSION_SEQUENCE_PATTERN.exec(version)
  if (!match) return [0, 0, 0]
  return [
    Number.parseInt(match[1] ?? '0', 10),
    Number.parseInt(match[2] ?? '0', 10),
    Number.parseInt(match[3] ?? '0', 10)
  ]
}

/**
 * Three-part numeric compare of a version line or plain version (prerelease and
 * build metadata ignored). Returns > 0 when `a` is newer than `b`, < 0 when
 * older, 0 when equal   a string carrying no number at all counts as 0.0.0.
 */
export function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = versionParts(a)
  const [bMajor, bMinor, bPatch] = versionParts(b)
  if (aMajor !== bMajor) return aMajor - bMajor
  if (aMinor !== bMinor) return aMinor - bMinor
  return aPatch - bPatch
}

/** A probed thing that reported a version. */
export interface VersionedCandidate<T> {
  version: string
  value: T
}

/**
 * Pick the candidate reporting the newest version, or null when none did. Ties
 * keep the earliest entry, so a caller can order its candidates by preference
 * (for example canonical binary name first).
 */
export function selectNewestCandidate<T>(
  candidates: readonly VersionedCandidate<T>[]
): VersionedCandidate<T> | null {
  let best: VersionedCandidate<T> | null = null
  for (const candidate of candidates) {
    if (!best || compareVersions(candidate.version, best.version) > 0) {
      best = candidate
    }
  }
  return best
}
