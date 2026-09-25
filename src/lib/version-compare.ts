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

function versionParts(version: string): [number, number, number] {
  const [major, minor, patch] = version.split('.').map((part) => Number.parseInt(part, 10))
  return [major ?? 0, minor ?? 0, patch ?? 0]
}

/**
 * Three-part numeric compare (prerelease/build metadata ignored). Returns > 0
 * when `a` is newer than `b`, < 0 when older, 0 when equal.
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
