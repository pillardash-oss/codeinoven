#!/usr/bin/env bun
/// <reference types="node" />

/**
 * publish-release-mirror — copy a published GitHub release to dl.codeinoven.com.
 *
 * Downloads from GitHub Releases are slow for users, so every release is copied
 * to our own origin after CI has validated and built it. The mirror is a pure
 * copy: nothing is rebuilt, and no byte is uploaded before it has been verified
 * against the release's own `SHA256SUMS.txt`, so the mirror can never diverge
 * from what GitHub published.
 *
 * Bucket keys (served from `DOWNLOAD_MIRROR_URL`, see src/lib/download-mirror.ts):
 *
 *   <channel>/<artifact file name>   the installers the download page offers:
 *                                    macOS .dmg, Windows .exe, Linux .AppImage and .deb
 *   <channel>/latest-mac.yml         the channel's update feed, per platform
 *   <channel>/latest.yml
 *   <channel>/latest-linux.yml
 *   <channel>/SHA256SUMS.txt         checksums of the newest release
 *   <channel>/RELEASE.json           machine-readable manifest for download pages
 *
 * The mirror carries only what a user downloads by hand (see
 * MIRRORED_EXTENSIONS); the macOS auto-update `.zip` and the differential
 * `.blockmap` files stay on GitHub, which is the archive, so nothing is
 * duplicated at a size that matters.
 *
 * Upload order matters: artifacts first, the feed and manifest last, so a
 * consumer never sees a feed pointing at a file that is not there yet. Every
 * uploaded key is then HEAD-verified for size, and the previous release is
 * deleted from the channel: with the default `--keep 1` a channel holds exactly
 * the release it serves, because GitHub Releases is the archive. Publishing a
 * release older than the one the channel serves is refused unless
 * `--allow-downgrade` is passed, so a mis-typed backfill cannot replace the live
 * download with a stale one.
 *
 * Run this from CI. A release is about 750 MB of multipart uploads, which a home
 * uplink turns into an hour-long job. A run that is killed leaves its unfinished
 * multipart uploads behind: the key stays unreadable (the origin answers 404 for
 * it), but the parts are billed and the bucket lists them as a half-uploaded
 * object. Every publish therefore aborts the unfinished uploads of an earlier
 * run in the channel it is about to write, and the bucket lifecycle rule
 * (docs/DOWNLOAD-MIRROR.md) is the backstop for a channel that is never
 * published again.
 *
 * Usage:
 *   bun scripts/publish-release-mirror.ts --tag v0.5.57
 *   bun scripts/publish-release-mirror.ts --tag v0.5.57-nightly.5 --channel nightly
 *   bun scripts/publish-release-mirror.ts --tag v0.5.57 --artifacts-dir ./release-assets --dry-run
 *
 * Flags:
 *   --tag <tag>              Published release tag to mirror (required).
 *   --channel auto|stable|nightly
 *                            Mirror directory. `auto` (default) derives it from
 *                            the release's prerelease flag.
 *   --artifacts-dir <dir>    Use release assets already on disk instead of
 *                            downloading them with `gh` (default:
 *                            .cio/tmp/download-mirror/<tag>).
 *   --keep <n>               Releases retained per channel (default 1: only the
 *                            release the channel is serving; 0 keeps every
 *                            release ever mirrored, which is never needed on R2
 *                            because GitHub Releases is the archive).
 *   --allow-downgrade        Mirror a release older than the one the channel
 *                            currently serves. Without it the run refuses,
 *                            because the sweep would delete the newer release.
 *   --public-base <url>      Public mirror origin for the manifest URLs
 *                            (default https://dl.codeinoven.com).
 *   --dry-run                Print the plan, including what the sweep would
 *                            delete, and upload nothing.
 *
 * Environment (required unless --dry-run):
 *   DOWNLOAD_MIRROR_S3_ENDPOINT         e.g. https://<account>.r2.cloudflarestorage.com
 *   DOWNLOAD_MIRROR_S3_BUCKET           e.g. codeinoven-downloads
 *   DOWNLOAD_MIRROR_S3_ACCESS_KEY_ID
 *   DOWNLOAD_MIRROR_S3_SECRET_ACCESS_KEY
 *   DOWNLOAD_MIRROR_S3_REGION           optional, default `auto` (Cloudflare R2)
 *
 * Exit codes: 0 on success (including --dry-run), 1 on bad flags, missing
 * configuration, a release that is not published, a release older than the one
 * the channel serves, or a verification failure.
 */

import { execFileSync } from 'node:child_process'
import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  abortInterruptedUpload,
  fetchObjectPrefix,
  listInterruptedUploads,
  type InterruptedUpload
} from './lib/s3-request'
import {
  DOWNLOAD_MIRROR_URL,
  MIRROR_CHECKSUMS_FILE,
  MIRROR_FEED_FILES,
  MIRROR_MANIFEST_FILE,
  MIRROR_MANIFEST_SCHEMA_VERSION,
  mirrorArtifactUrl,
  mirrorChannelUrl,
  type MirrorFeedPlatform,
  type ReleaseChannel,
  type ReleaseManifest,
  type ReleaseManifestArtifact
} from '../src/lib/download-mirror'

const DEFAULT_KEEP = 1
const DEFAULT_ARTIFACTS_DIR_ROOT = '.cio/tmp/download-mirror'

/** Bytes of every uploaded object read back for verification after a publish. */
const VERIFY_PREFIX_BYTES = 1024

/** Installer file names produced by electron-builder's `artifactName` templates. */
const ARTIFACT_PATTERN =
  /^codeinoven-(\d+\.\d+\.\d+(?:-nightly[.-]\d+)?)(?:-(arm64|x64|setup))?\.(dmg|zip|exe|appimage|deb)$/i

/**
 * Release feed asset name per platform, exactly as electron-builder writes it:
 * the channel prefixes the platform name (`latest-mac.yml` / `nightly-mac.yml`),
 * except Windows, where the channel *is* the name (`latest.yml` / `nightly.yml`).
 */
const FEED_SOURCE_NAMES: Readonly<Record<MirrorFeedPlatform, Record<ReleaseChannel, string>>> = {
  darwin: { stable: 'latest-mac.yml', nightly: 'nightly-mac.yml' },
  win32: { stable: 'latest.yml', nightly: 'nightly.yml' },
  linux: { stable: 'latest-linux.yml', nightly: 'nightly-linux.yml' }
}

const EXTENSION_KINDS: Readonly<
  Record<string, { platform: 'macos' | 'windows' | 'linux'; kind: string }>
> = {
  dmg: { platform: 'macos', kind: 'dmg' },
  zip: { platform: 'macos', kind: 'zip' },
  exe: { platform: 'windows', kind: 'installer' },
  appimage: { platform: 'linux', kind: 'appimage' },
  deb: { platform: 'linux', kind: 'deb' }
}

/**
 * The installers the mirror carries: exactly one per platform a user installs
 * from the download page (macOS `.dmg`, Windows NSIS `.exe`, Linux `.AppImage`
 * and `.deb`).
 *
 * GitHub Releases stays the archive, so anything the page does not offer stays
 * on GitHub instead of being duplicated here:
 *
 * - the macOS `.zip` is electron-updater's auto-update payload. The app's trust
 *   check only uses the mirror when its manifest lists the exact file the update
 *   feed points at, so with no zip here a mac update downloads from GitHub (see
 *   `src/main/notifications/updater-download.ts`).
 * - `.blockmap` files only serve differential downloads. The app pre-downloads
 *   the whole artifact into electron-updater's pending cache, so it never asks
 *   for one.
 */
const MIRRORED_EXTENSIONS: readonly string[] = ['dmg', 'exe', 'appimage', 'deb']

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  dmg: 'application/x-apple-diskimage',
  zip: 'application/zip',
  exe: 'application/vnd.microsoft.portable-executable',
  appimage: 'application/octet-stream',
  deb: 'application/vnd.debian.binary-package',
  blockmap: 'application/octet-stream',
  yml: 'text/yaml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8'
}

const MIRROR_ENV = {
  endpoint: 'DOWNLOAD_MIRROR_S3_ENDPOINT',
  bucket: 'DOWNLOAD_MIRROR_S3_BUCKET',
  accessKeyId: 'DOWNLOAD_MIRROR_S3_ACCESS_KEY_ID',
  secretAccessKey: 'DOWNLOAD_MIRROR_S3_SECRET_ACCESS_KEY',
  region: 'DOWNLOAD_MIRROR_S3_REGION'
} as const

const DEFAULT_REGION = 'auto'

/** S3 client type without importing the `bun` module namespace. */
type MirrorBucket = InstanceType<typeof Bun.S3Client>

interface CliFlags {
  tag: string
  channel: ReleaseChannel | 'auto'
  artifactsDir: string | null
  keep: number
  publicBase: string
  dryRun: boolean
  allowDowngrade: boolean
}

interface MirrorConfig {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

interface ReleaseInfo {
  tag: string
  isPrerelease: boolean
  publishedAt: string
  url: string
}

/** One installer recognized in the release assets. */
export interface ClassifiedArtifact {
  name: string
  version: string
  platform: string
  arch: string
  kind: string
  extension: string
}

interface VerifiedArtifact extends ClassifiedArtifact {
  bytes: number
  sha256: string
  /** Base64 sha512, the encoding the release's update feed reports. */
  sha512: string
}

interface PlannedUpload {
  key: string
  role: 'artifact' | 'blockmap' | 'feed' | 'checksums' | 'manifest'
  contentType: string
  bytes: number
  /** Source file on disk, for everything except the generated manifest. */
  file: string | null
  /** Inline body, used for the generated manifest. */
  content: string | null
}

function say(line: string): void {
  process.stdout.write(`${line}\n`)
}

/** GitHub Actions annotation when running in CI; a plain line otherwise. */
function annotate(level: 'notice' | 'warning' | 'error', message: string): void {
  if (process.env['GITHUB_ACTIONS'] === 'true') say(`::${level}::${message}`)
}

function fail(message: string): number {
  process.stderr.write(`publish-release-mirror: ${message}\n`)
  annotate('error', `Download mirror: ${message}`)
  return 1
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function parseFlags(argv: string[]): CliFlags {
  const values = new Map<string, string>()
  const known = new Set([
    '--tag',
    '--channel',
    '--artifacts-dir',
    '--keep',
    '--public-base',
    '--dry-run',
    '--allow-downgrade'
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    const [name, inline] = argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, null]
    if (!known.has(name)) throw new Error(`Unknown flag: ${name}`)
    if (name === '--dry-run' || name === '--allow-downgrade') {
      values.set(name, 'true')
      continue
    }
    const value = inline ?? argv[index + 1]
    if (value === undefined) throw new Error(`Flag ${name} needs a value`)
    if (inline === null) index += 1
    values.set(name, value)
  }

  const tag = values.get('--tag')
  if (tag === undefined || tag.length === 0) throw new Error('--tag is required')

  const rawChannel = values.get('--channel') ?? 'auto'
  if (rawChannel !== 'auto' && rawChannel !== 'stable' && rawChannel !== 'nightly') {
    throw new Error(`--channel must be auto, stable or nightly (got ${rawChannel})`)
  }

  const rawKeep = values.get('--keep') ?? String(DEFAULT_KEEP)
  const keep = Number(rawKeep)
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error(`--keep must be a non-negative integer (got ${rawKeep})`)
  }

  return {
    tag,
    channel: rawChannel,
    artifactsDir: values.get('--artifacts-dir') ?? null,
    keep,
    publicBase: values.get('--public-base') ?? DOWNLOAD_MIRROR_URL,
    dryRun: values.get('--dry-run') === 'true',
    allowDowngrade: values.get('--allow-downgrade') === 'true'
  }
}

/** Mirror upload configuration from the environment, with the missing names listed. */
export function resolveMirrorConfig(env: Record<string, string | undefined> = process.env): {
  config: MirrorConfig | null
  missing: string[]
} {
  const read = (name: string): string => (env[name] ?? '').trim()
  const endpoint = read(MIRROR_ENV.endpoint)
  const bucket = read(MIRROR_ENV.bucket)
  const accessKeyId = read(MIRROR_ENV.accessKeyId)
  const secretAccessKey = read(MIRROR_ENV.secretAccessKey)
  const region = read(MIRROR_ENV.region) || DEFAULT_REGION
  const missing: string[] = []
  if (endpoint.length === 0) missing.push(MIRROR_ENV.endpoint)
  if (bucket.length === 0) missing.push(MIRROR_ENV.bucket)
  if (accessKeyId.length === 0) missing.push(MIRROR_ENV.accessKeyId)
  if (secretAccessKey.length === 0) missing.push(MIRROR_ENV.secretAccessKey)
  if (missing.length > 0) return { config: null, missing }
  return { config: { endpoint, bucket, region, accessKeyId, secretAccessKey }, missing: [] }
}

/** Whether an asset is an electron-updater differential blockmap (not an installer). */
export function isBlockmap(name: string): boolean {
  return name.toLowerCase().endsWith('.blockmap')
}

/** Classify an installer (or its `.blockmap`) from its release asset name. */
export function classifyArtifact(name: string): ClassifiedArtifact | null {
  const withoutBlockmap = isBlockmap(name) ? name.slice(0, -'.blockmap'.length) : name
  const match = ARTIFACT_PATTERN.exec(withoutBlockmap)
  if (match === null) return null
  const [, version, archSuffix, rawExtension] = match
  if (version === undefined || rawExtension === undefined) return null
  const extension = rawExtension.toLowerCase()
  const descriptor = EXTENSION_KINDS[extension]
  if (descriptor === undefined) return null
  const arch =
    archSuffix === 'arm64'
      ? 'arm64'
      : archSuffix === 'x64'
        ? 'x64'
        : descriptor.platform === 'macos'
          ? 'arm64'
          : 'x64'
  return { name, version, platform: descriptor.platform, arch, kind: descriptor.kind, extension }
}

/**
 * Whether the mirror carries this release asset; see {@link MIRRORED_EXTENSIONS}.
 * A `.blockmap` is never carried, never mind which installer it belongs to.
 */
export function isMirroredArtifact(name: string): boolean {
  if (isBlockmap(name)) return false
  const classified = classifyArtifact(name)
  return classified !== null && MIRRORED_EXTENSIONS.includes(classified.extension)
}

/** Content type R2 serves the object with, from the file extension. */
export function contentTypeFor(name: string): string {
  const extension = path.extname(name).replace(/^\./, '').toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

/** Feed asset name in the release, per platform and channel. */
export function feedSourceName(platform: MirrorFeedPlatform, channel: ReleaseChannel): string {
  return FEED_SOURCE_NAMES[platform][channel]
}

/** Parse `sha256sum` output (`<digest>  ./<name>`) into name -> digest. */
export function parseChecksums(text: string): Map<string, string> {
  const checksums = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line)
    if (match === null) continue
    const [, digest, rawPath] = match
    if (digest === undefined || rawPath === undefined) continue
    checksums.set(path.basename(rawPath.trim()), digest.toLowerCase())
  }
  return checksums
}

/** sha256 (hex, for `SHA256SUMS.txt` and the manifest) and sha512 (base64, the
 * encoding the release's update feed and the mirror trust check use). */
async function digestsOfFile(file: string): Promise<{ sha256: string; sha512: string }> {
  const sha256 = new Bun.CryptoHasher('sha256')
  const sha512 = new Bun.CryptoHasher('sha512')
  for await (const chunk of Bun.file(file).stream()) {
    sha256.update(chunk)
    sha512.update(chunk)
  }
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

async function fileBytes(file: string): Promise<number> {
  return stat(file).then((info) => info.size)
}

/** Compare `X.Y.Z[-nightly.N]` versions; `> 0` when `left` is newer. */
export function compareVersions(left: string, right: string): number {
  const [leftBase, leftPre] = splitVersion(left)
  const [rightBase, rightPre] = splitVersion(right)
  const leftParts = leftBase.split('.').map(Number)
  const rightParts = rightBase.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (leftPre === null && rightPre === null) return 0
  // A stable release of the same base outranks its nightlies.
  if (leftPre === null) return 1
  if (rightPre === null) return -1
  return leftPre - rightPre
}

function splitVersion(version: string): [string, number | null] {
  const match = /^(\d+\.\d+\.\d+)-nightly[.-](\d+)$/.exec(version)
  if (match === null) return [version, null]
  return [match[1]!, Number(match[2]!)]
}

/**
 * Classified release artifacts in a channel listing whose version is newer than
 * `version`: the objects a publish must never take away from the channel, because
 * they are (or include) the release it currently serves.
 */
export function newerArtifacts(keys: readonly string[], version: string): string[] {
  return keys.filter((key) => {
    const classified = classifyArtifact(path.basename(key))
    return classified !== null && compareVersions(classified.version, version) > 0
  })
}

/**
 * Keys to delete from a channel directory once a publish has been uploaded and
 * verified: installers and blockmaps belonging to a release the channel no
 * longer retains. The release being published is always retained, plus the
 * `keep - 1` newest versions already in the channel, so with the default
 * `keep` of 1 the channel ends up holding exactly the release it serves, which
 * is the point of the sweep: GitHub Releases is the archive, R2 is the current
 * download.
 *
 * Feeds, checksums, the manifest and anything unrecognized are never deleted, so
 * a sweep can neither break the channel nor leave it feedless; unrecognized
 * objects are reported instead of removed.
 *
 * `publishedKeys` is what this run uploads. The release being published holds
 * exactly that set, so an object of the published version that this run does not
 * write is a leftover from an earlier layout (a macOS zip, a differential
 * blockmap) and is deleted too. Without it, objects of that version would be
 * retained by version alone and a layout change could never reach the bucket.
 */
export function pruneTargets(
  keys: readonly string[],
  keep: number,
  retainVersion: string | null = null,
  publishedKeys: readonly string[] = []
): string[] {
  if (keep <= 0) return []
  const published = new Set(publishedKeys)
  const older = [...new Set(versionsIn(keys))]
    .filter((version) => version !== retainVersion)
    .sort((left, right) => compareVersions(right, left))
  const retained = new Set(retainVersion === null ? [] : [retainVersion])
  for (const version of older.slice(0, Math.max(0, keep - retained.size))) retained.add(version)
  return keys.filter((key) => {
    const classified = classifyArtifact(path.basename(key))
    if (classified === null) return false
    if (!retained.has(classified.version)) return true
    return published.size > 0 && classified.version === retainVersion && !published.has(key)
  })
}

/** Versions of the installers and blockmaps present in a set of channel keys. */
function versionsIn(keys: readonly string[]): string[] {
  const versions: string[] = []
  for (const key of keys) {
    const classified = classifyArtifact(path.basename(key))
    if (classified !== null) versions.push(classified.version)
  }
  return versions
}

/**
 * Channel objects that are neither a release artifact nor one of the files a
 * publish writes (feeds, checksums, manifest); leftovers worth reporting.
 */
export function unrecognizedKeys(keys: readonly string[], channel: ReleaseChannel): string[] {
  const ownKeys = new Set([
    ...Object.values(MIRROR_FEED_FILES).map((name) => `${channel}/${name}`),
    `${channel}/${MIRROR_CHECKSUMS_FILE}`,
    `${channel}/${MIRROR_MANIFEST_FILE}`
  ])
  return keys.filter((key) => classifyArtifact(path.basename(key)) === null && !ownKeys.has(key))
}

function fetchReleaseInfo(tag: string): ReleaseInfo {
  const stdout = execFileSync(
    'gh',
    ['release', 'view', tag, '--json', 'tagName,isPrerelease,publishedAt,url'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  )
  const parsed = JSON.parse(stdout) as {
    tagName?: unknown
    isPrerelease?: unknown
    publishedAt?: unknown
    url?: unknown
  }
  if (typeof parsed.tagName !== 'string' || parsed.tagName.length === 0) {
    throw new Error(`gh returned no release for tag ${tag}`)
  }
  return {
    tag: parsed.tagName,
    isPrerelease: parsed.isPrerelease === true,
    publishedAt: typeof parsed.publishedAt === 'string' ? parsed.publishedAt : '',
    url: typeof parsed.url === 'string' ? parsed.url : ''
  }
}

function downloadReleaseAssets(tag: string, directory: string): void {
  say(`Downloading release assets for ${tag} into ${directory}...`)
  execFileSync('gh', ['release', 'download', tag, '--dir', directory, '--clobber'], {
    stdio: 'inherit'
  })
}

function createBucket(config: MirrorConfig): MirrorBucket {
  return new Bun.S3Client({
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey
  })
}

async function listChannel(bucket: MirrorBucket, channel: ReleaseChannel): Promise<string[]> {
  const keys: string[] = []
  let continuationToken: string | undefined
  for (;;) {
    const page = await bucket.list({
      prefix: `${channel}/`,
      ...(continuationToken === undefined ? {} : { continuationToken })
    })
    for (const entry of page.contents ?? []) keys.push(entry.key)
    if (page.isTruncated !== true || page.nextContinuationToken === undefined) break
    continuationToken = page.nextContinuationToken
  }
  return keys
}

/**
 * Abort the multipart uploads an earlier run started and never finished.
 *
 * Installers are uploaded with multipart requests, so a run that is killed
 * (Ctrl-C, a cancelled CI job, a dropped connection) leaves its parts behind.
 * The key never becomes readable, but the parts are billed and the bucket
 * dashboard lists them as a half-uploaded object. This run owns the channel
 * while it runs, so every unfinished upload in the channel that was started
 * before it began is a leftover and is aborted; one started after this run began
 * belongs to a concurrent process and is left alone.
 */
async function sweepInterruptedUploads(
  config: MirrorConfig,
  channel: ReleaseChannel,
  runStartedAt: Date,
  dryRun: boolean
): Promise<void> {
  let uploads: InterruptedUpload[]
  try {
    uploads = await listInterruptedUploads(config, `${channel}/`)
  } catch (error) {
    annotate(
      'warning',
      `Download mirror: could not list unfinished uploads in ${channel}/ (${reasonOf(error)}); the bucket lifecycle rule still clears them`
    )
    return
  }

  if (uploads.length === 0) {
    say(`Unfinished uploads: none in ${channel}/`)
    return
  }

  const startedAtMs = runStartedAt.getTime()
  const leftover = uploads.filter((upload) => {
    const initiated = Date.parse(upload.initiated)
    return Number.isNaN(initiated) || initiated <= startedAtMs
  })
  const inFlight = uploads.length - leftover.length
  const list = (items: readonly InterruptedUpload[]): void => {
    for (const upload of items.slice(0, 8)) say(`  - ${upload.key} (started ${upload.initiated})`)
    if (items.length > 8) say(`  and ${items.length - 8} more`)
  }

  if (leftover.length === 0) {
    say(`Unfinished uploads: ${uploads.length} in flight from another process; left alone`)
    return
  }
  if (dryRun) {
    say(`Unfinished uploads: would abort ${leftover.length} left by an earlier run:`)
    list(leftover)
    return
  }

  const aborted: InterruptedUpload[] = []
  for (const upload of leftover) {
    try {
      await abortInterruptedUpload(config, upload)
    } catch (error) {
      annotate('warning', `Download mirror: could not abort ${upload.key} (${reasonOf(error)})`)
      continue
    }
    aborted.push(upload)
  }
  say(`Unfinished uploads: aborted ${aborted.length} left by an earlier run:`)
  list(aborted)
  if (inFlight > 0) say(`  ${inFlight} more are in flight from another process; left alone`)
}

/**
 * The first `length` bytes of a planned upload, read without loading the whole
 * file: a 223 MB installer is compared byte for byte at its head, not in full.
 */
async function expectedPrefix(item: PlannedUpload, length: number): Promise<Buffer> {
  if (item.content !== null) return Buffer.from(item.content, 'utf8').subarray(0, length)
  if (item.file === null) throw new Error(`${item.key} has neither a file nor inline content`)
  const handle = await open(item.file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function upload(bucket: MirrorBucket, item: PlannedUpload): Promise<void> {
  const startedAt = Date.now()
  const file = bucket.file(item.key)
  if (item.content !== null) {
    await file.write(item.content, { type: item.contentType })
  } else if (item.file !== null) {
    await file.write(Bun.file(item.file), { type: item.contentType })
  } else {
    throw new Error(`${item.key} has neither a file nor inline content`)
  }
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000)
  const rate = item.bytes / (1024 * 1024) / elapsedSeconds
  say(
    `  ${item.key}  ${megabytes(item.bytes)}  ${elapsedSeconds.toFixed(1)}s  ${rate.toFixed(1)} MB/s`
  )
}

/** Build the manifest download pages read; only real installers are listed. */
function buildManifest(input: {
  channel: ReleaseChannel
  version: string
  release: ReleaseInfo
  artifacts: readonly VerifiedArtifact[]
  feeds: readonly { source: string; key: string }[]
  publicBase: string
}): ReleaseManifest {
  const artifacts: ReleaseManifestArtifact[] = input.artifacts
    .map((artifact) => ({
      name: artifact.name,
      platform: artifact.platform,
      arch: artifact.arch,
      kind: artifact.kind,
      sizeBytes: artifact.bytes,
      sha256: artifact.sha256,
      sha512: artifact.sha512,
      url: mirrorArtifactUrl(artifact.name, input.channel, input.publicBase)
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return {
    schemaVersion: MIRROR_MANIFEST_SCHEMA_VERSION,
    channel: input.channel,
    version: input.version,
    tag: input.release.tag,
    publishedAt: input.release.publishedAt,
    sourceUrl: input.release.url,
    artifacts,
    feeds: [...input.feeds]
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const runStartedAt = new Date()
  let flags: CliFlags
  try {
    flags = parseFlags(argv)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }

  const { config, missing } = resolveMirrorConfig()
  if (config === null && !flags.dryRun) {
    return fail(
      `Missing mirror configuration: ${missing.join(', ')}. See docs/DOWNLOAD-MIRROR.md for the R2 setup and the GitHub Actions variables/secrets.`
    )
  }

  let release: ReleaseInfo
  try {
    release = fetchReleaseInfo(flags.tag)
  } catch (error) {
    return fail(
      `Could not read release ${flags.tag} with gh (is it published, and is gh authenticated?): ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  const channel: ReleaseChannel =
    flags.channel === 'auto' ? (release.isPrerelease ? 'nightly' : 'stable') : flags.channel
  if (release.isPrerelease !== (channel === 'nightly')) {
    return fail(
      `Release ${release.tag} is ${release.isPrerelease ? 'a prerelease' : 'stable'} but --channel ${channel} was requested`
    )
  }

  const tagVersion = flags.tag.replace(/^v/, '')
  const channelUrl = mirrorChannelUrl(channel, flags.publicBase)
  say(`Mirroring ${release.tag} (${channel}) to ${channelUrl}`)

  // --- assets on disk ------------------------------------------------------
  const artifactsDir = flags.artifactsDir ?? path.join(DEFAULT_ARTIFACTS_DIR_ROOT, flags.tag)
  if (flags.artifactsDir !== null) {
    const info = await stat(artifactsDir).catch(() => null)
    if (info === null || !info.isDirectory()) {
      return fail(`--artifacts-dir ${artifactsDir} is not a directory`)
    }
  } else {
    await mkdir(artifactsDir, { recursive: true })
    try {
      downloadReleaseAssets(flags.tag, artifactsDir)
    } catch (error) {
      return fail(
        `gh release download ${flags.tag} failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  const entries = await readdir(artifactsDir, { withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)

  // --- verify against the release's own checksums ---------------------------
  const checksumsPath = path.join(artifactsDir, MIRROR_CHECKSUMS_FILE)
  const checksumsText = await readFile(checksumsPath, 'utf8').catch(() => null)
  if (checksumsText === null) {
    return fail(
      `${MIRROR_CHECKSUMS_FILE} is missing from ${artifactsDir}; refusing to mirror unverified bytes`
    )
  }
  const checksums = parseChecksums(checksumsText)

  const installers: ClassifiedArtifact[] = []
  for (const name of files) {
    if (isBlockmap(name)) continue
    const classified = classifyArtifact(name)
    if (classified !== null) installers.push(classified)
  }
  if (installers.length === 0) {
    return fail(`No installer artifacts found in ${artifactsDir}`)
  }

  // Only the installers the download page offers are copied here; the rest stay
  // on GitHub, which is the archive (see MIRRORED_EXTENSIONS).
  const mirrored = installers.filter((installer) => isMirroredArtifact(installer.name))
  if (mirrored.length === 0) {
    return fail(
      `No mirrored installer in ${artifactsDir}: expected at least one of ${MIRRORED_EXTENSIONS.join(', ')}`
    )
  }
  const skipped = installers.filter((installer) => !isMirroredArtifact(installer.name))

  const versions = new Set(installers.map((installer) => installer.version))
  if (versions.size !== 1) {
    return fail(`Artifacts in ${artifactsDir} span several versions: ${[...versions].join(', ')}`)
  }
  const version = installers[0]!.version
  if (version !== tagVersion) {
    return fail(`Artifacts are version ${version} but the tag is ${flags.tag}`)
  }

  const verified: VerifiedArtifact[] = []
  for (const installer of mirrored) {
    const expected = checksums.get(installer.name)
    if (expected === undefined) {
      return fail(`${installer.name} is not listed in ${MIRROR_CHECKSUMS_FILE}`)
    }
    const digests = await digestsOfFile(path.join(artifactsDir, installer.name))
    if (digests.sha256 !== expected) {
      return fail(
        `Checksum mismatch for ${installer.name}: expected ${expected}, computed ${digests.sha256}`
      )
    }
    verified.push({
      ...installer,
      bytes: await fileBytes(path.join(artifactsDir, installer.name)),
      sha256: digests.sha256,
      sha512: digests.sha512
    })
  }
  say(`Verified ${verified.length} installers against ${MIRROR_CHECKSUMS_FILE}`)
  if (skipped.length > 0) {
    say(
      `Not mirrored (kept on GitHub only): ${skipped.map((installer) => installer.name).join(', ')}`
    )
  }

  // Every installer the release lists must be on disk, or the mirror would be partial.
  for (const name of checksums.keys()) {
    if (isBlockmap(name)) continue
    if (classifyArtifact(name) !== null && !files.includes(name)) {
      return fail(`${name} is listed in ${MIRROR_CHECKSUMS_FILE} but missing from ${artifactsDir}`)
    }
  }

  // --- feeds ---------------------------------------------------------------
  const feeds: { source: string; key: string }[] = []
  for (const platform of Object.keys(MIRROR_FEED_FILES) as MirrorFeedPlatform[]) {
    const source = feedSourceName(platform, channel)
    if (!files.includes(source)) {
      return fail(`Release ${release.tag} has no ${source} update feed`)
    }
    feeds.push({ source, key: `${channel}/${MIRROR_FEED_FILES[platform]}` })
  }

  const manifest = buildManifest({
    channel,
    version,
    release,
    artifacts: verified,
    feeds,
    publicBase: flags.publicBase
  })

  // --- upload plan ---------------------------------------------------------
  const plan: PlannedUpload[] = []
  for (const artifact of verified) {
    plan.push({
      key: `${channel}/${artifact.name}`,
      role: 'artifact',
      contentType: contentTypeFor(artifact.name),
      bytes: artifact.bytes,
      file: path.join(artifactsDir, artifact.name),
      content: null
    })
  }
  for (const feed of feeds) {
    plan.push({
      key: feed.key,
      role: 'feed',
      contentType: contentTypeFor(feed.source),
      bytes: await fileBytes(path.join(artifactsDir, feed.source)),
      file: path.join(artifactsDir, feed.source),
      content: null
    })
  }
  plan.push({
    key: `${channel}/${MIRROR_CHECKSUMS_FILE}`,
    role: 'checksums',
    contentType: contentTypeFor(MIRROR_CHECKSUMS_FILE),
    bytes: Buffer.byteLength(checksumsText, 'utf8'),
    file: checksumsPath,
    content: null
  })
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`
  plan.push({
    key: `${channel}/${MIRROR_MANIFEST_FILE}`,
    role: 'manifest',
    contentType: contentTypeFor(MIRROR_MANIFEST_FILE),
    bytes: Buffer.byteLength(manifestBody, 'utf8'),
    file: null,
    content: manifestBody
  })

  const totalBytes = plan.reduce((sum, item) => sum + item.bytes, 0)
  const publishedKeys = new Set(plan.map((item) => item.key))
  say('')
  say(`Plan (${plan.length} objects, ${megabytes(totalBytes)}):`)
  for (const item of plan) say(`  ${item.role.padEnd(9)} ${item.key}  ${megabytes(item.bytes)}`)

  // --- what the channel gives up for this release --------------------------
  // The channel listing happens before the upload, so a sweep that would break
  // the channel stops the run while nothing has been written yet.
  const bucket = config === null ? null : createBucket(config)
  const listed =
    bucket === null
      ? null
      : await listChannel(bucket, channel).then(
          (keys) => ({ keys, error: null as unknown }),
          (error: unknown) => ({ keys: null, error })
        )
  const listError = listed?.error ?? null
  const sweep =
    listed?.keys === null || listed?.keys === undefined
      ? null
      : pruneTargets(listed.keys, flags.keep, version, [...publishedKeys])
  say('')
  if (flags.keep === 0) {
    say('Sweep: disabled (--keep 0); the channel keeps every release it is given')
  } else if (sweep === null) {
    say(
      `Sweep: keeps the newest ${flags.keep} release(s) in ${channel}/; the deletion list is computed after the upload`
    )
  } else if (sweep.length === 0) {
    say(`Sweep: nothing to delete; ${channel}/ already serves only this release`)
  } else {
    say(`Sweep: deletes ${sweep.length} object(s) ${channel}/ no longer serves:`)
    for (const key of sweep.slice(0, 8)) say(`  - ${key}`)
    if (sweep.length > 8) say(`  and ${sweep.length - 8} more`)
  }
  if (listError !== null) {
    annotate(
      'warning',
      `Download mirror: could not list ${channel}/ on the origin (${reasonOf(listError)}); the sweep will be computed after the upload`
    )
  }

  // Refuse to replace a newer release the channel already serves with an older
  // one: the sweep would delete the live download, and GitHub is only the
  // fallback. This reads the channel listing, not the sweep, so `--keep` cannot
  // hide a downgrade, and the deletion step applies the same protection again to
  // the post-upload listing in case the listing above failed or a newer release
  // appeared while this run was uploading.
  const newerTargets = newerArtifacts(listed?.keys ?? [], version)
  if (newerTargets.length > 0 && !flags.allowDowngrade) {
    return fail(
      `${channel}/ serves a newer release than ${release.tag}: mirroring it would replace the live download and delete ${newerTargets.length} object(s) of that release. Pass --allow-downgrade to mirror it anyway.`
    )
  }

  // --- abort the parts an earlier run left behind --------------------------
  if (config !== null) {
    say('')
    await sweepInterruptedUploads(config, channel, runStartedAt, flags.dryRun)
  }

  if (flags.dryRun || bucket === null || config === null) {
    say('')
    say(flags.dryRun ? 'Dry run: nothing was uploaded.' : 'Dry run: no configuration.')
    return 0
  }

  // --- upload, artifacts first so the feed never points at a missing file ---
  say('')
  say('Uploading...')
  let uploadedBytes = 0
  for (const item of plan) {
    try {
      await upload(bucket, item)
    } catch (error) {
      return fail(`Upload of ${item.key} failed: ${reasonOf(error)}`)
    }
    uploadedBytes += item.bytes
  }

  // --- verify what the origin actually serves ------------------------------
  // A ranged read, not a HEAD or `S3File.stat()`: Cloudflare compresses the
  // text/plain and application/json objects, so their HEAD carries no
  // content-length and `stat()` reports 0 (see scripts/lib/s3-request.ts).
  say('')
  say('Verifying uploaded objects...')
  for (const item of plan) {
    const prefix = await expectedPrefix(item, VERIFY_PREFIX_BYTES).catch((error: unknown) => {
      throw new Error(`could not read ${item.key} locally: ${reasonOf(error)}`)
    })
    const probe = await fetchObjectPrefix(config, item.key, VERIFY_PREFIX_BYTES).catch(
      (error: unknown) => {
        throw new Error(`could not read ${item.key} back: ${reasonOf(error)}`)
      }
    )
    if (probe === null) return fail(`${item.key} is missing from the bucket after upload`)
    if (probe.size !== item.bytes) {
      return fail(`${item.key} is ${probe.size} bytes on the origin but ${item.bytes} locally`)
    }
    if (!Buffer.from(probe.bytes).subarray(0, prefix.length).equals(prefix)) {
      return fail(`${item.key} does not serve the bytes that were uploaded`)
    }
  }
  say(`Verified ${plan.length} objects (${megabytes(uploadedBytes)})`)

  // --- delete the release the channel no longer serves ---------------------
  let deleted = 0
  if (flags.keep > 0) {
    const keys = await listChannel(bucket, channel).catch(() => null)
    if (keys === null) {
      return fail(
        `Uploaded ${plan.length} objects but could not list ${channel}/ to delete the previous release; re-run the job to finish the sweep`
      )
    }
    for (const key of unrecognizedKeys(keys, channel)) {
      annotate('warning', `Download mirror: unexpected object ${key} in ${channel}/`)
    }
    // A release newer than this one can be in the channel even though the
    // pre-upload listing did not show it: that listing may have failed, or
    // another run may have published while this one was uploading. Its objects
    // are the live download, so they are left in place unless --allow-downgrade
    // asked for exactly that replacement.
    const protectedKeys = new Set(flags.allowDowngrade ? [] : newerArtifacts(keys, version))
    for (const key of pruneTargets(keys, flags.keep, version, [...publishedKeys])) {
      if (protectedKeys.has(key)) continue
      try {
        await bucket.file(key).delete()
      } catch (error) {
        return fail(`Could not delete ${key}: ${reasonOf(error)}`)
      }
      deleted += 1
      say(`  deleted ${key}`)
    }
    if (protectedKeys.size > 0) {
      const message = `${channel}/ holds ${protectedKeys.size} object(s) of a release newer than ${release.tag}; left in place. Run the mirror job for that release, or pass --allow-downgrade to replace it.`
      say(`Warning: ${message}`)
      annotate('warning', `Download mirror: ${message}`)
    }
    if (deleted === 0) {
      say(
        protectedKeys.size === 0
          ? `Nothing to delete; ${channel}/ serves only ${release.tag}`
          : `Nothing deleted; ${channel}/ also holds a newer release's objects`
      )
    } else {
      say(`Deleted ${deleted} object(s) from earlier releases`)
    }
  }

  say('')
  say(`Mirrored ${release.tag} to ${channelUrl}`)
  for (const artifact of verified) {
    annotate(
      'notice',
      `Download mirror: ${artifact.name} -> ${mirrorArtifactUrl(artifact.name, channel, flags.publicBase)}`
    )
  }
  annotate(
    'notice',
    `Download mirror: ${channel} manifest at ${channelUrl}/${MIRROR_MANIFEST_FILE} (version ${version})`
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  process.exitCode = await main()
}
