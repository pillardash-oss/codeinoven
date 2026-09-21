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
 *   <channel>/<artifact file name>   installers and their .blockmap files
 *   <channel>/latest-mac.yml         the channel's update feed, per platform
 *   <channel>/latest.yml
 *   <channel>/latest-linux.yml
 *   <channel>/SHA256SUMS.txt         checksums of the newest release
 *   <channel>/RELEASE.json           machine-readable manifest for download pages
 *
 * Upload order matters: artifacts first, the feed and manifest last, so a
 * consumer never sees a feed pointing at a file that is not there yet. Every
 * uploaded key is then HEAD-verified for size, and versions older than
 * `--keep` (default 3) are pruned from the channel.
 *
 * Run this from CI. A release is about 970 MB of multipart uploads, which a home
 * uplink turns into an hour-long job; an interrupted run leaves orphaned upload
 * parts until the bucket's lifecycle rule aborts them (docs/DOWNLOAD-MIRROR.md).
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
 *   --keep <n>               Releases retained per channel (default 3, 0 keeps
 *                            every release ever mirrored).
 *   --public-base <url>      Public mirror origin for the manifest URLs
 *                            (default https://dl.codeinoven.com).
 *   --dry-run                Print the plan and upload nothing.
 *
 * Environment (required unless --dry-run):
 *   DOWNLOAD_MIRROR_S3_ENDPOINT         e.g. https://<account>.r2.cloudflarestorage.com
 *   DOWNLOAD_MIRROR_S3_BUCKET           e.g. codeinoven-downloads
 *   DOWNLOAD_MIRROR_S3_ACCESS_KEY_ID
 *   DOWNLOAD_MIRROR_S3_SECRET_ACCESS_KEY
 *   DOWNLOAD_MIRROR_S3_REGION           optional, default `auto` (Cloudflare R2)
 *
 * Exit codes: 0 on success (including --dry-run), 1 on bad flags, missing
 * configuration, a release that is not published, or a verification failure.
 */

import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DOWNLOAD_MIRROR_URL,
  MIRROR_CHECKSUMS_FILE,
  MIRROR_FEED_FILES,
  MIRROR_MANIFEST_FILE,
  mirrorArtifactUrl,
  mirrorChannelUrl,
  type MirrorFeedPlatform,
  type ReleaseChannel,
  type ReleaseManifest,
  type ReleaseManifestArtifact
} from '../src/lib/download-mirror'

const DEFAULT_KEEP = 3
const DEFAULT_ARTIFACTS_DIR_ROOT = '.cio/tmp/download-mirror'

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

export function parseFlags(argv: string[]): CliFlags {
  const values = new Map<string, string>()
  const known = new Set([
    '--tag',
    '--channel',
    '--artifacts-dir',
    '--keep',
    '--public-base',
    '--dry-run'
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    const [name, inline] = argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, null]
    if (!known.has(name)) throw new Error(`Unknown flag: ${name}`)
    if (name === '--dry-run') {
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
    dryRun: values.get('--dry-run') === 'true'
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

async function sha256OfFile(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk)
  return hasher.digest('hex')
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
 * Keys to delete from a channel directory: everything belonging to a version
 * outside the newest `keep`. Feed files, checksums, the manifest and anything
 * unrecognized are never pruned.
 */
export function pruneTargets(keys: readonly string[], keep: number): string[] {
  if (keep <= 0) return []
  const byVersion = new Map<string, string[]>()
  for (const key of keys) {
    const classified = classifyArtifact(path.basename(key))
    if (classified === null) continue
    const bucket = byVersion.get(classified.version) ?? []
    bucket.push(key)
    byVersion.set(classified.version, bucket)
  }
  const versions = [...byVersion.keys()].sort((left, right) => compareVersions(right, left))
  return versions.slice(keep).flatMap((version) => byVersion.get(version) ?? [])
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
      url: mirrorArtifactUrl(artifact.name, input.channel, input.publicBase)
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return {
    schemaVersion: 1,
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

  const versions = new Set(installers.map((installer) => installer.version))
  if (versions.size !== 1) {
    return fail(`Artifacts in ${artifactsDir} span several versions: ${[...versions].join(', ')}`)
  }
  const version = installers[0]!.version
  if (version !== tagVersion) {
    return fail(`Artifacts are version ${version} but the tag is ${flags.tag}`)
  }

  const verified: VerifiedArtifact[] = []
  for (const installer of installers) {
    const expected = checksums.get(installer.name)
    if (expected === undefined) {
      return fail(`${installer.name} is not listed in ${MIRROR_CHECKSUMS_FILE}`)
    }
    const actual = await sha256OfFile(path.join(artifactsDir, installer.name))
    if (actual !== expected) {
      return fail(
        `Checksum mismatch for ${installer.name}: expected ${expected}, computed ${actual}`
      )
    }
    verified.push({
      ...installer,
      bytes: await fileBytes(path.join(artifactsDir, installer.name)),
      sha256: actual
    })
  }
  say(`Verified ${verified.length} installers against ${MIRROR_CHECKSUMS_FILE}`)

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
  for (const artifact of verified) {
    const blockmapName = `${artifact.name}.blockmap`
    if (!files.includes(blockmapName)) continue
    plan.push({
      key: `${channel}/${blockmapName}`,
      role: 'blockmap',
      contentType: contentTypeFor(blockmapName),
      bytes: await fileBytes(path.join(artifactsDir, blockmapName)),
      file: path.join(artifactsDir, blockmapName),
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
  say('')
  say(`Plan (${plan.length} objects, ${megabytes(totalBytes)}):`)
  for (const item of plan) say(`  ${item.role.padEnd(9)} ${item.key}  ${megabytes(item.bytes)}`)
  if (flags.keep > 0) {
    say(`Prune: keeping the newest ${flags.keep} releases in ${channel}/`)
  } else {
    say('Prune: disabled (--keep 0)')
  }

  if (flags.dryRun || config === null) {
    say('')
    say(flags.dryRun ? 'Dry run: nothing was uploaded.' : 'Dry run: no configuration.')
    return 0
  }

  // --- upload, artifacts first so the feed never points at a missing file ---
  const bucket = createBucket(config)
  say('')
  say('Uploading...')
  let uploadedBytes = 0
  for (const item of plan) {
    try {
      await upload(bucket, item)
    } catch (error) {
      return fail(
        `Upload of ${item.key} failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    uploadedBytes += item.bytes
  }

  // --- verify what the origin actually serves ------------------------------
  say('')
  say('Verifying uploaded objects...')
  for (const item of plan) {
    const stats = await bucket
      .file(item.key)
      .stat()
      .catch(() => null)
    if (stats === null) return fail(`${item.key} is missing from the bucket after upload`)
    if (stats.size !== item.bytes) {
      return fail(`${item.key} is ${stats.size} bytes on the origin but ${item.bytes} locally`)
    }
  }
  say(`Verified ${plan.length} objects (${megabytes(uploadedBytes)})`)

  // --- prune older releases ------------------------------------------------
  let pruned = 0
  if (flags.keep > 0) {
    const keys = await listChannel(bucket, channel)
    const targets = pruneTargets(keys, flags.keep)
    for (const key of targets) {
      await bucket.file(key).delete()
      pruned += 1
      say(`  pruned ${key}`)
    }
    say(pruned === 0 ? 'Nothing to prune' : `Pruned ${pruned} objects`)
    const unrecognized = keys.filter(
      (key) => classifyArtifact(path.basename(key)) === null && !key.endsWith('.yml')
    )
    for (const key of unrecognized) {
      if (key.endsWith(`/${MIRROR_CHECKSUMS_FILE}`) || key.endsWith(`/${MIRROR_MANIFEST_FILE}`))
        continue
      annotate('warning', `Download mirror: unexpected object ${key} in ${channel}/`)
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
