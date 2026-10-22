import { mkdir, readdir, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { Logger } from '../system/logger'
import { downloadFileResumable } from './resumable-download'

/**
 * One file of a catalog artifact. Only what the transfer needs: where it comes
 * from, where it lands inside the artifact directory, and how to verify it.
 */
export interface StagedArtifactFile {
  /** Artifact-relative path, already validated by the catalog. */
  path: string
  sourceUrl: string
  byteSize: number
  sha256: string
}

export interface StagedArtifactDownloadRequest {
  /** Directory the artifact is assembled in before it is installed. */
  stagingDirectory: string
  files: readonly StagedArtifactFile[]
  /**
   * Throw away whatever an earlier attempt left in the staging directory and
   * start from zero. Without it the download continues from the kept bytes,
   * which is what a cancelled-then-resumed download wants.
   */
  restart?: boolean
  signal: AbortSignal
  /** Cumulative bytes across every file of the artifact, including kept bytes. */
  onProgress?: (receivedSoFar: number) => void
}

/** Bytes a file on disk occupies, or null when it is not there yet. */
async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

/**
 * Bytes an earlier attempt already put on disk for this artifact, which is
 * exactly where a resumed download continues from. A file larger than the
 * catalog's byte count is a corrupt leftover rather than progress, so it is
 * dropped instead of counted.
 */
export async function stagedArtifactBytes(
  stagingDirectory: string,
  files: readonly StagedArtifactFile[]
): Promise<number> {
  let total = 0
  for (const file of files) {
    const target = join(stagingDirectory, file.path)
    const size = await fileSize(target)
    if (size === null || size === 0) continue
    if (file.byteSize > 0 && size > file.byteSize) {
      await rm(target, { force: true }).catch(() => undefined)
      continue
    }
    total += size
  }
  return total
}

/** Remove every staged byte of an artifact (a restart, or a finished install). */
export async function discardStagedArtifact(stagingDirectory: string): Promise<void> {
  await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Every file of the artifact is downloaded into the staging directory, each one
 * continuing from the bytes already on disk for it. Progress is reported as a
 * running total across the artifact so the caller shows one bar for the whole
 * model rather than one per file. Returns the bytes present at the end.
 */
export async function downloadStagedArtifact(
  request: StagedArtifactDownloadRequest
): Promise<number> {
  const { stagingDirectory, files, signal, onProgress } = request
  if (request.restart === true) await discardStagedArtifact(stagingDirectory)
  await mkdir(stagingDirectory, { recursive: true })
  await pruneUnknownFiles(stagingDirectory, files)
  let received = 0
  for (const file of files) {
    const target = join(stagingDirectory, file.path)
    await mkdir(dirname(target), { recursive: true })
    // A file already at its full size needs no transfer: the resumable
    // downloader verifies it locally and only fetches it again if the checksum
    // does not match.
    const kept = (await fileSize(target)) ?? 0
    received += await downloadFileResumable({
      url: file.sourceUrl,
      destination: target,
      expectedBytes: file.byteSize,
      checksum: { algorithm: 'sha256', encoding: 'hex', digest: file.sha256 },
      signal,
      resumeFromBytes: kept,
      onProgress: (fileReceivedSoFar) => onProgress?.(received + fileReceivedSoFar)
    })
    onProgress?.(received)
  }
  return received
}

/**
 * Drop staging directories left behind by the previous naming scheme, which gave
 * every attempt its own `<id>.<uuid>.download` directory. Those bytes can never
 * be resumed into the stable directory, so leaving them would waste the disk
 * space of every download the user ever cancelled.
 */
export async function discardLegacyStagingDirectories(
  stagingDirectory: string,
  artifactId: string
): Promise<void> {
  const escaped = artifactId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const legacy = new RegExp(`^${escaped}\\.[0-9a-f-]{36}\\.download$`)
  const entries = await readdir(dirname(stagingDirectory)).catch(() => [])
  for (const entry of entries) {
    if (!legacy.test(entry)) continue
    await discardStagedArtifact(join(dirname(stagingDirectory), entry))
  }
}

/** Depth a staging tree is walked to prune it; artifacts nest only a folder or two. */
const PRUNE_MAX_DEPTH = 6
/** Files a single artifact may stage; far above any real model's file count. */
const PRUNE_MAX_FILES = 256

/**
 * Remove anything in the staging directory the artifact does not list, so a
 * partial left by an older revision of the same artifact can never be installed
 * alongside the files that are actually wanted.
 */
async function pruneUnknownFiles(
  stagingDirectory: string,
  files: readonly StagedArtifactFile[]
): Promise<void> {
  const expected = new Set(files.map((file) => file.path))
  const visited: string[] = []
  let budget = PRUNE_MAX_FILES
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > PRUNE_MAX_DEPTH || budget <= 0) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (budget <= 0) return
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path, depth + 1)
        continue
      }
      budget -= 1
      // Catalog paths are always '/'-separated, whatever the platform join used.
      const artifactPath = relative(stagingDirectory, path).split(sep).join('/')
      if (expected.has(artifactPath)) continue
      visited.push(path)
    }
  }
  await walk(stagingDirectory, 1)
  for (const path of visited) {
    Logger.dev(`Discarding staged file ${basename(path)} that the artifact no longer lists.`)
    await unlink(path).catch(() => undefined)
  }
}
