import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  downloadFileResumable,
  PermanentDownloadError,
  type DownloadChecksum
} from '../util/resumable-download'

/**
 * The subset of electron-updater's `UpdateInfo` the resumable pre-download
 * needs, as delivered by the `update-available` event.
 */
export interface UpdateArtifactInfo {
  version: string
  files: readonly {
    url?: unknown
    sha512?: unknown
    size?: unknown
    isAdminRightsRequired?: unknown
  }[]
}

export interface ResolvedUpdateArtifact {
  /** Absolute download URL of the platform update artifact. */
  url: string
  /** File name electron-updater expects inside its pending-update cache dir. */
  fileName: string
  /** Base64-encoded sha512 digest from the update feed. */
  sha512: string
  /** Expected byte count from the update feed; `0` when unknown. */
  size: number
  isAdminRightsRequired: boolean
}

export interface UpdaterCacheLocation {
  cacheDir: string
  pendingDir: string
}

function fileEntryName(entry: { url?: unknown }): string | null {
  if (typeof entry.url !== 'string' || entry.url.length === 0) return null
  // electron-updater names the cached update file after the URL basename; a
  // plain basename also prevents a hostile feed entry from escaping the cache
  // directory.
  return path.basename(entry.url)
}

function isArm64FileName(name: string): boolean {
  return name.toLowerCase().includes('arm64')
}

/** Whether this mac is an Apple Silicon machine, including Rosetta emulation. */
function isArm64MacHost(arch: string): boolean {
  if (arch === 'arm64') return true
  try {
    const translated = execFileSync('sysctl', ['sysctl.proc_translated'], {
      encoding: 'utf8'
    })
    return translated.includes(': 1')
  } catch {
    return false
  }
}

/**
 * Mirror of `MacUpdater.filterFilesForArch`: arm64 macs (including Rosetta)
 * prefer arm64 artifacts when the feed provides any; x64 hosts never receive
 * arm64 artifacts.
 */
function filterMacEntries<T extends { name: string }>(entries: T[], arch: string): T[] {
  const isArm64File = (entry: { name: string }) => isArm64FileName(entry.name)
  const isArm64Mac = isArm64MacHost(arch)
  if (isArm64Mac && entries.some(isArm64File)) return entries.filter(isArm64File)
  return entries.filter((entry) => !isArm64File(entry))
}

/** First entry whose file name ends with one of `extensions`, arch match preferred. */
function pickEntry<T extends { name: string }>(
  entries: T[],
  extensions: string[],
  arch: string
): T | null {
  const matching = entries.filter((entry) =>
    extensions.some((ext) => entry.name.toLowerCase().endsWith(`.${ext.toLowerCase()}`))
  )
  if (matching.length === 0) return null
  return matching.find((entry) => entry.name.includes(arch)) ?? matching[0]
}

/**
 * Resolve the single update artifact electron-updater would download for this
 * platform and architecture, replicating its per-updater file selection:
 * macOS zip (arm64-aware, pkg/dmg fallback), Windows NSIS exe, Linux AppImage.
 * Returns null when the feed has no usable entry, letting the caller fall
 * back to electron-updater's own download path.
 */
export function resolveUpdateArtifact(
  info: UpdateArtifactInfo,
  platform: NodeJS.Platform,
  arch: string,
  downloadBase: string
): ResolvedUpdateArtifact | null {
  const candidates: Array<{
    name: string
    entry: UpdateArtifactInfo['files'][number]
  }> = []
  for (const entry of info.files) {
    const name = fileEntryName(entry)
    if (name === null || typeof entry.sha512 !== 'string' || entry.sha512.length === 0) continue
    candidates.push({ name, entry })
  }
  if (candidates.length === 0) return null

  let picked: { name: string; entry: UpdateArtifactInfo['files'][number] } | null
  if (platform === 'darwin') {
    const filtered = filterMacEntries(candidates, arch)
    picked = pickEntry(filtered, ['zip'], arch) ?? pickEntry(filtered, ['pkg', 'dmg'], arch)
  } else if (platform === 'win32') {
    picked = pickEntry(candidates, ['exe'], arch)
  } else if (platform === 'linux') {
    picked = pickEntry(candidates, ['AppImage'], arch)
  } else {
    picked = null
  }
  if (picked === null) return null

  const sha512 = typeof picked.entry.sha512 === 'string' ? picked.entry.sha512 : null
  if (sha512 === null || sha512.length === 0) return null
  const size =
    typeof picked.entry.size === 'number' && Number.isFinite(picked.entry.size)
      ? picked.entry.size
      : 0
  return {
    url: `${downloadBase}/v${info.version}/${picked.name}`,
    fileName: picked.name,
    sha512,
    size,
    isAdminRightsRequired: picked.entry.isAdminRightsRequired === true
  }
}

function readYamlString(configText: string, key: string): string | null {
  for (const line of configText.split(/\r?\n/)) {
    const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`).exec(line)
    if (match) return match[1].replace(/^['"]|['"]$/g, '')
  }
  return null
}

function getAppCacheDir(platform: NodeJS.Platform, homedir: string): string {
  if (platform === 'win32') {
    return process.env['LOCALAPPDATA'] ?? path.join(homedir, 'AppData', 'Local')
  }
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Caches')
  return process.env['XDG_CACHE_HOME'] ?? path.join(homedir, '.cache')
}

/**
 * Locate electron-updater's pending-update cache dir: `{app cache dir}/
 * {updaterCacheDirName}/pending`, where the dir name comes from the packaged
 * `app-update.yml`. Returns null when not packaged or the config is missing,
 * so the caller can fall back to electron-updater's own download path.
 */
export function resolveUpdaterCacheLocation(
  resourcesPath: string = process.resourcesPath ?? '',
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir()
): UpdaterCacheLocation | null {
  if (!resourcesPath) return null
  let configText: string
  try {
    configText = readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf-8')
  } catch {
    return null
  }
  const cacheDirName = readYamlString(configText, 'updaterCacheDirName')
  if (!cacheDirName) return null
  const cacheDir = path.join(getAppCacheDir(platform, homedir), cacheDirName)
  return { cacheDir, pendingDir: path.join(cacheDir, 'pending') }
}

function checksumOf(sha512: string): DownloadChecksum {
  return { algorithm: 'sha512', encoding: 'base64', digest: sha512 }
}

/** Streaming sha512-base64 digest of a fully written file. */
function hashExistingFile(file: string, checksum: DownloadChecksum): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash(checksum.algorithm)
    hash.on('error', () => resolve(null)).setEncoding(checksum.encoding)
    createReadStream(file, { highWaterMark: 1024 * 1024 })
      .on('error', () => resolve(null))
      .on('end', () => {
        hash.end()
        resolve(hash.read())
      })
      .pipe(hash, { end: false })
  })
}

/**
 * Resumably pre-download `artifact` into electron-updater's pending cache dir
 * and write the `update-info.json` marker electron-updater validates before it
 * accepts a cached file. The marker is written only after the full file's
 * sha512 verifies, so a crash mid-download leaves an unmarked partial that
 * the next attempt (or launch) resumes instead of restarting. Corrupt data
 * (checksum mismatch, unexpected HTTP status) is removed rather than cached.
 */
export async function seedUpdaterCache(
  artifact: ResolvedUpdateArtifact,
  pendingDir: string,
  signal: AbortSignal,
  onProgress?: (receivedBytes: number, totalBytes: number) => void
): Promise<void> {
  await mkdir(pendingDir, { recursive: true })
  const destination = path.join(pendingDir, artifact.fileName)
  const checksum = checksumOf(artifact.sha512)
  let resumeFromBytes = await stat(destination)
    .then((info) => (info.isFile() ? info.size : 0))
    .catch(() => 0)
  const writeMarker = async (): Promise<void> => {
    // Same shape electron-updater writes after its own successful download;
    // it is what makes `validateDownloadedPath` accept the cached file.
    await writeFile(
      path.join(pendingDir, 'update-info.json'),
      JSON.stringify({
        fileName: artifact.fileName,
        sha512: artifact.sha512,
        isAdminRightsRequired: artifact.isAdminRightsRequired
      }),
      'utf-8'
    )
  }
  if (resumeFromBytes > artifact.size) {
    // Leftover from a different (older or bogus) artifact; do not resume it.
    await rm(destination, { force: true })
    resumeFromBytes = 0
  }
  if (artifact.size > 0 && resumeFromBytes === artifact.size) {
    // The previous run wrote every byte but crashed before the marker: verify
    // the file as-is instead of asking the server for a pointless Range GET.
    const digest = await hashExistingFile(destination, checksum)
    if (digest === artifact.sha512) {
      await writeMarker()
      onProgress?.(artifact.size, artifact.size)
      return
    }
    await rm(destination, { force: true })
    resumeFromBytes = 0
  }
  try {
    const received = await downloadFileResumable({
      url: artifact.url,
      destination,
      expectedBytes: artifact.size,
      checksum,
      signal,
      resumeFromBytes,
      onProgress: onProgress === undefined ? undefined : (bytes) => onProgress(bytes, artifact.size)
    })
    if (artifact.size === 0) onProgress?.(received, received)
    await writeMarker()
  } catch (cause) {
    if (cause instanceof PermanentDownloadError) {
      // A checksum mismatch or HTTP-status failure means the bytes on disk
      // (fresh or resumed) are unusable; never cache them for future resumes.
      await rm(destination, { force: true })
    }
    throw cause
  }
}
