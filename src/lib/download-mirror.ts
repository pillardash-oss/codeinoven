/**
 * The CodeInOven download mirror: our own origin for release artifacts.
 *
 * GitHub Releases stays the published feed and the fallback. The app resolves
 * update metadata (a few KB of YAML/JSON) from GitHub, then downloads the
 * artifact bytes from the mirror first and falls back to GitHub when the mirror
 * is unreachable or does not carry that file yet (see
 * `src/main/notifications/updater-download.ts`).
 *
 * Bucket keys, served from {@link DOWNLOAD_MIRROR_URL}:
 *
 *   <channel>/<artifact file name>   e.g. stable/codeinoven-0.5.57-arm64.zip
 *   <channel>/latest-mac.yml         the channel's update feed, one per platform
 *   <channel>/latest.yml
 *   <channel>/latest-linux.yml
 *   <channel>/SHA256SUMS.txt         checksums of the channel's newest release
 *   <channel>/RELEASE.json           machine-readable manifest of that release
 *
 * Each channel directory is a self-contained generic update-feed root: the feed
 * and the artifacts it points at live side by side, so pointing a feed provider
 * at a different channel is a base-URL change, never a layout change.
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

export interface ReleaseManifestArtifact {
  /** File name inside the channel directory. */
  name: string
  /** `macos` | `windows` | `linux`. */
  platform: string
  /** `arm64` | `x64`. */
  arch: string
  /** `dmg` | `zip` | `installer` | `appimage` | `deb`. */
  kind: string
  sizeBytes: number
  sha256: string
  /** Absolute public download URL on the mirror. */
  url: string
}

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

/** Public URL of one artifact inside a channel directory. */
export function mirrorArtifactUrl(
  fileName: string,
  channel: ReleaseChannel,
  base: string = DOWNLOAD_MIRROR_URL
): string {
  return `${mirrorChannelUrl(channel, base)}/${encodeURIComponent(fileName)}`
}
