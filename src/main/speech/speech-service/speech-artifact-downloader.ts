import { access, mkdir, rename, rm, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  SpeechDownloadMode,
  SpeechDownloadState,
  SpeechModelArtifact,
  SpeechModelCatalog
} from '../../../lib/speech/types'
import {
  discardLegacyStagingDirectories,
  discardStagedArtifact,
  downloadStagedArtifact,
  stagedArtifactBytes
} from '../../util/staged-artifact-download'
import { toSpeechError } from './speech-error-mapping'

/** Storage access the downloader needs to stage and install an artifact. */
export interface SpeechArtifactStorage {
  stagingFile(name: string): string
  modelDirectory(artifactId: string): string
}

/** Catalog, progress, and installed-index hooks owned by the speech service. */
export interface SpeechArtifactDownloaderHost {
  catalog(): SpeechModelCatalog
  emitDownload(artifact: SpeechModelArtifact, download: SpeechDownloadState): void
  recordInstalled(artifact: SpeechModelArtifact, installedAt: number): Promise<void>
}

/**
 * Streams catalog artifacts into their model directories with resumable,
 * checksum-verified downloads and progress reporting.
 *
 * A stopped download is a pause, not a dead end: the bytes it already fetched
 * stay in the artifact's own staging directory (the same path every attempt
 * uses), so the user is offered a resume from them or a restart that discards
 * them. Nothing here requires the application to be restarted, and a resume also
 * works across launches because the staging path is derived from the artifact id
 * alone.
 */
export class SpeechArtifactDownloader {
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly storage: SpeechArtifactStorage,
    private readonly host: SpeechArtifactDownloaderHost
  ) {}

  async download(artifactId: string, mode: SpeechDownloadMode = 'resume'): Promise<void> {
    if (this.controllers.has(artifactId)) throw new Error('Model download is already active.')
    const artifact = this.host.catalog().artifacts.find((item) => item.id === artifactId)
    if (!artifact) throw new Error('Model artifact was not found.')
    if (artifact.qualification.status === 'retired') {
      throw new Error('Retired model artifacts cannot be downloaded.')
    }
    const controller = new AbortController()
    this.controllers.set(artifactId, controller)
    const destination = this.storage.modelDirectory(artifactId)
    // One staging directory per artifact, never per attempt, so an interrupted
    // or cancelled download leaves bytes a later attempt can continue from.
    const staging = this.storage.stagingFile(`${artifactId}.download`)
    if (mode === 'restart') await discardStagedArtifact(staging)
    else await discardLegacyStagingDirectories(staging, artifact.id)
    const kept = mode === 'restart' ? 0 : await stagedArtifactBytes(staging, artifact.files)
    try {
      await mkdir(dirname(staging), { recursive: true })
      await this.assertDiskSpace(staging, Math.max(0, artifact.byteSize - kept))
      this.host.emitDownload(artifact, {
        state: 'downloading',
        bytesReceived: kept,
        totalBytes: artifact.byteSize,
        ...(kept > 0 ? { resumedFromBytes: kept } : {})
      })
      let lastEmitAt = 0
      const received = await downloadStagedArtifact({
        stagingDirectory: staging,
        files: artifact.files,
        restart: mode === 'restart',
        signal: controller.signal,
        onProgress: (receivedSoFar) => {
          const now = Date.now()
          if (now - lastEmitAt < 120) return
          lastEmitAt = now
          this.host.emitDownload(artifact, {
            state: 'downloading',
            bytesReceived: receivedSoFar,
            totalBytes: artifact.byteSize,
            ...(kept > 0 ? { resumedFromBytes: kept } : {})
          })
        }
      })
      this.host.emitDownload(artifact, {
        state: 'verifying',
        bytesReceived: received,
        totalBytes: artifact.byteSize
      })
      const previous = `${destination}.previous`
      const hadPrevious = await access(destination)
        .then(() => true)
        .catch(() => false)
      if (hadPrevious) {
        // A previous run that died mid-install leaves this path behind, and a
        // rename onto an existing directory would fail.
        await rm(previous, { recursive: true, force: true })
        await rename(destination, previous)
      }
      try {
        await rename(staging, destination)
      } catch (cause) {
        if (hadPrevious) await rename(previous, destination).catch(() => undefined)
        throw cause
      }
      if (hadPrevious) await rm(previous, { recursive: true, force: true })
      const installedAt = Date.now()
      await this.host.recordInstalled(artifact, installedAt)
      this.host.emitDownload(artifact, { state: 'installed', installedAt })
    } catch (cause) {
      // The staged bytes are deliberately kept: a cancellation or a dropped
      // connection is exactly what the resume path continues from.
      const cancelled = controller.signal.aborted
      const keptBytes = await stagedArtifactBytes(staging, artifact.files)
      this.host.emitDownload(
        artifact,
        cancelled
          ? {
              state: 'cancelled',
              cancelledAt: Date.now(),
              bytesReceived: keptBytes,
              totalBytes: artifact.byteSize
            }
          : {
              state: 'failed',
              failedAt: Date.now(),
              error: toSpeechError(cause, 'download-failed'),
              bytesReceived: keptBytes,
              totalBytes: artifact.byteSize
            }
      )
      throw cause
    } finally {
      this.controllers.delete(artifactId)
    }
  }

  cancel(artifactId: string): boolean {
    const controller = this.controllers.get(artifactId)
    if (!controller) return false
    controller.abort()
    return true
  }

  /** Abort every in-flight download, used on shutdown. */
  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }

  /**
   * Preflight a model download against the available disk space so a nearly
   * full disk produces a clear, actionable error up front instead of a raw
   * ENOSPC failure midway through writing gigabytes of model files. It is
   * measured against the bytes still missing, since resumed bytes already occupy
   * the disk.
   */
  private async assertDiskSpace(path: string, remainingBytes: number): Promise<void> {
    if (!Number.isFinite(remainingBytes) || remainingBytes <= 0) return
    try {
      const stats = await statfs(dirname(path))
      const available = Number(stats.bavail) * Number(stats.bsize)
      // Require the artifact size plus a small working margin (the app
      // database, logs, and temp files share the same volume).
      const margin = Math.min(Math.max(remainingBytes * 0.05, 64 * 1024 * 1024), 1_073_741_824)
      if (available < remainingBytes + margin) {
        throw new Error(
          `Not enough disk space to download this model: ${Math.round(
            (remainingBytes + margin) / (1024 * 1024)
          )} MB is needed, ${Math.round(available / (1024 * 1024))} MB is available. Free up space and try again.`
        )
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith('Not enough disk space')) throw cause
      // statfs itself failing must never block a download; the streaming write
      // below still surfaces a real error if the disk is genuinely unwritable.
    }
  }
}
