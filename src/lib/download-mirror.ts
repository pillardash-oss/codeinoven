/**
 * The CodeInOven download mirror: our own origin for release artifacts.
 *
 * GitHub Releases stays the published feed, the archive and the fallback. The
 * app resolves update metadata (a few KB of YAML/JSON) from GitHub, then only
 * downloads the artifact bytes from the mirror when the mirror publishes the
 * same hash for that file (see {@link findMirrorArtifact}); otherwise the bytes
 * come from GitHub itself.
 *
 * Bucket keys, served from {@link DOWNLOAD_MIRROR_URL}:
 *
 *   <channel>/codeinoven-arm64.dmg   the artifacts, named without a version:
 *   <channel>/codeinoven-arm64.zip   the installers a user downloads by hand,
 *   <channel>/codeinoven-setup.exe   plus the macOS `.zip`, which is the payload
 *   <channel>/codeinoven.AppImage    electron-updater installs an update from.
 *   <channel>/codeinoven.deb         A channel serves one release, so its file
 *                                    names are the channel's names and a link
 *                                    to the mirror never rots
 *   <channel>/latest-mac.yml         the release's own update feeds, per platform
 *   <channel>/latest.yml
 *   <channel>/latest-linux.yml
 *   <channel>/SHA256SUMS.txt         checksums of the artifacts, for the names
 *                                    the mirror actually serves
 *   <channel>/RELEASE.json           machine-readable manifest of that release
 *
 * macOS therefore carries two artifacts in a channel, `.dmg` and `.zip`: a
 * consumer of `RELEASE.json` selects by `kind`, never by `platform` alone.
 *
 * Each channel directory is the channel's current download set: one release,
 * under versionless names, plus the feeds and the manifest that describe it. A
 * channel holds one release at a time, the one it currently serves: publishing
 * the next release overwrites the same keys and deletes everything the channel
 * no longer serves, because GitHub Releases is the archive. Nothing here links to
 * an older version; a user who wants one downloads it from GitHub.
 *
 * Written by `scripts/publish-release-mirror.ts`, documented in
 * `docs/DOWNLOAD-MIRROR.md`.
 */

/** Public origin that serves mirrored release artifacts. */
export const DOWNLOAD_MIRROR_URL = 'https://dl.codeinoven.com'

/** Release channel a mirror directory serves. */
export type ReleaseChannel = 'stable' | 'nightly'

/** Every channel the mirror serves, in publishing order. */
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['stable', 'nightly']

export function isReleaseChannel(value: string): value is ReleaseChannel {
  return (RELEASE_CHANNELS as readonly string[]).includes(value)
}

/** Update feed file name inside a channel directory, per platform. */
export type MirrorFeedPlatform = 'darwin' | 'win32' | 'linux'

export const MIRROR_FEED_FILES: Readonly<Record<MirrorFeedPlatform, string>> = {
  darwin: 'latest-mac.yml',
  win32: 'latest.yml',
  linux: 'latest-linux.yml'
}

/** Checksums of the newest release in a channel directory. */
export const MIRROR_CHECKSUMS_FILE = 'SHA256SUMS.txt'

/** Machine-readable manifest of the newest release in a channel directory. */
export const MIRROR_MANIFEST_FILE = 'RELEASE.json'

/**
 * Contract version of {@link ReleaseManifest}. Version 2 added the per-artifact
 * `sha512` the updater compares against the GitHub feed before it trusts the
 * mirror for a download. Version 3 adds `source`, the GitHub release asset name
 * each served file came from, because the mirror's own file names are versionless
 * and the update feed's entry is not.
 */
export const MIRROR_MANIFEST_SCHEMA_VERSION = 3

/** How long the updater waits for a channel manifest before falling back to GitHub. */
export const MIRROR_MANIFEST_TIMEOUT_MS = 8_000

export interface ReleaseManifestArtifact {
  /** File name inside the channel directory, without a version. */
  name: string
  /**
   * The file name in the GitHub release this copy came from, with its version,
   * e.g. `codeinoven-0.5.57-arm64.dmg`. The update feed points at this name, so
   * it is what the app matches a mirror entry against.
   */
  source: string
  /** `macos` | `windows` | `linux`. */
  platform: string
  /** `arm64` | `x64`. */
  arch: string
  /** `dmg` | `zip` | `installer` | `appimage` | `deb`. */
  kind: string
  sizeBytes: number
  sha256: string
  /**
   * Base64 sha512 of the file, byte-identical to the `sha512` the release's own
   * update feed reports for it. This is the value the app compares with GitHub's
   * before it downloads an update from the mirror.
   */
  sha512: string
  /** Absolute public download URL on the mirror. */
  url: string
}

/** The manifest fields the mirror trust check reads; the rest is ignored. */
export type MirrorManifestArtifact = Pick<
  ReleaseManifestArtifact,
  'name' | 'source' | 'sha512' | 'sizeBytes'
>

/**
 * Contract of `<channel>/RELEASE.json`: everything a download page needs to
 * render buttons without calling the GitHub API.
 */
export interface ReleaseManifest {
  schemaVersion: number
  channel: ReleaseChannel
  /** Full version in the artifacts, e.g. `0.5.57` or `0.5.57-nightly.5`. */
  version: string
  /** GitHub release tag, e.g. `v0.5.57-nightly.5`. */
  tag: string
  /** ISO timestamp of the GitHub release publication. */
  publishedAt: string
  /** GitHub release page this mirror copy came from. */
  sourceUrl: string
  artifacts: ReleaseManifestArtifact[]
  /** Source feed asset -> mirror key, so the mapping is auditable. */
  feeds: { source: string; key: string }[]
}

function withoutTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/** Directory URL of one channel, e.g. `https://dl.codeinoven.com/stable`. */
export function mirrorChannelUrl(
  channel: ReleaseChannel,
  base: string = DOWNLOAD_MIRROR_URL
): string {
  return `${withoutTrailingSlash(base)}/${channel}`
}

/** Public URL of one versionless artifact inside a channel directory. */
export function mirrorArtifactUrl(
  fileName: string,
  channel: ReleaseChannel,
  base: string = DOWNLOAD_MIRROR_URL
): string {
  return `${mirrorChannelUrl(channel, base)}/${encodeURIComponent(fileName)}`
}

/** Public URL of a channel's `RELEASE.json` manifest. */
export function mirrorManifestUrl(
  channel: ReleaseChannel,
  base: string = DOWNLOAD_MIRROR_URL
): string {
  return `${mirrorChannelUrl(channel, base)}/${MIRROR_MANIFEST_FILE}`
}

/** Bytes of a base64 (padded or not) or hex digest; null when it is neither. */
function digestBytes(value: string): Uint8Array | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
    const bytes = new Uint8Array(trimmed.length / 2)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(trimmed.slice(index * 2, index * 2 + 2), 16)
    }
    return bytes
  }
  const base64 = trimmed.replace(/[-_]/g, (character) => (character === '-' ? '+' : '/'))
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) return null
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

/**
 * Whether two digests describe the same bytes, tolerating base64 padding and a
 * hex encoding of the same value. A digest that decodes to nothing only ever
 * matches itself, so an unreadable value can never be mistaken for a match.
 */
export function digestMatches(left: string, right: string): boolean {
  const leftTrimmed = left.trim()
  const rightTrimmed = right.trim()
  if (leftTrimmed.length === 0 || rightTrimmed.length === 0) return false
  if (leftTrimmed === rightTrimmed) return true
  const leftBytes = digestBytes(leftTrimmed)
  const rightBytes = digestBytes(rightTrimmed)
  if (leftBytes === null || rightBytes === null) return false
  if (leftBytes.length !== rightBytes.length) return false
  return leftBytes.every((byte, index) => byte === rightBytes[index])
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Read the artifact entries out of an untrusted manifest body, keeping only
 * entries complete enough to compare: name, sha512 and size. Returns null when
 * the body is not a manifest at all, so a caller can tell "not a manifest" from
 * "a manifest without this file" (both mean "do not trust the mirror").
 */
export function parseMirrorManifestArtifacts(value: unknown): MirrorManifestArtifact[] | null {
  const manifest = asRecord(value)
  if (manifest === null) return null
  const rawArtifacts = manifest['artifacts']
  if (!Array.isArray(rawArtifacts)) return null
  const artifacts: MirrorManifestArtifact[] = []
  for (const entry of rawArtifacts) {
    const record = asRecord(entry)
    if (record === null) continue
    const name = record['name']
    const source = record['source']
    const sha512 = record['sha512']
    const sizeBytes = record['sizeBytes']
    if (typeof name !== 'string' || name.length === 0) continue
    if (typeof sha512 !== 'string' || sha512.length === 0) continue
    if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) continue
    // A schema-2 manifest has no `source`: there the mirror file name was the
    // release asset name, so the two are the same value.
    artifacts.push({
      name,
      source: typeof source === 'string' && source.length > 0 ? source : name,
      sha512,
      sizeBytes
    })
  }
  return artifacts
}

/**
 * One artifact a channel manifest can vouch for: the file the update feed
 * points at, with the digest and size the feed reports for it.
 */
export interface MirrorTrustQuery {
  /** Release asset file name from the update feed, e.g. `codeinoven-0.5.57-arm64.zip`. */
  fileName: string
  /** Base64 sha512 from the update feed. */
  sha512: string
  /** Byte count from the update feed; `0` when the feed does not report one. */
  size: number
}

/**
 * The channel manifest entry that vouches for exactly the artifact the update
 * feed points at, or null when none does: it must list that file name with an
 * identical sha512 and, when the feed reports a size, an identical size. The
 * versioned release asset name is matched through `source` (or through `name`,
 * which is what a schema-2 manifest carried); the returned entry is the mirror's
 * own versionless file, and its `name` is what a download URL is built from. A
 * mirror that lags behind the feed, or was populated from different bytes, fails
 * this check and is never downloaded from.
 */
export function findMirrorArtifact(
  artifacts: readonly MirrorManifestArtifact[],
  query: MirrorTrustQuery
): MirrorManifestArtifact | null {
  return (
    artifacts.find(
      (artifact) =>
        (artifact.source === query.fileName || artifact.name === query.fileName) &&
        digestMatches(artifact.sha512, query.sha512) &&
        (query.size === 0 || artifact.sizeBytes === query.size)
    ) ?? null
  )
}

/**
 * Fetch a channel's manifest and return the artifacts it vouches for, or null
 * when it cannot be read: an unreachable or slow origin, a non-2xx answer, an
 * aborted request, or a body that is not a manifest. Callers treat null as
 * "the mirror is not trustworthy right now" and use GitHub instead.
 */
export async function fetchMirrorManifestArtifacts(options: {
  channel: ReleaseChannel
  /** Mirror origin override (tests, staging); defaults to the published mirror. */
  base?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<MirrorManifestArtifact[] | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(mirrorManifestUrl(options.channel, options.base), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? MIRROR_MANIFEST_TIMEOUT_MS)
    })
    if (!response.ok) return null
    return parseMirrorManifestArtifacts(await response.json())
  } catch {
    return null
  }
}
