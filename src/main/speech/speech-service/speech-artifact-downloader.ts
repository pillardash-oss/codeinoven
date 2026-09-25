import { randomUUID } from 'node:crypto'
import { access, mkdir, rename, rm, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  SpeechDownloadState,
  SpeechModelArtifact,
  SpeechModelCatalog
} from '../../../lib/speech/types'
import { downloadFileResumable } from '../../util/resumable-download'
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
 */
export class SpeechArtifactDownloader {
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly storage: SpeechArtifactStorage,
    private readonly host: SpeechArtifactDownloaderHost
  ) {}

  async download(artifactId: string): Promise<void> {
    if (this.controllers.has(artifactId)) throw new Error('Model download is already active.')
    const artifact = this.host.catalog().artifacts.find((item) => item.id === artifactId)
    if (!artifact) throw new Error('Model artifact was not found.')
    if (artifact.qualification.status === 'retired') {
      throw new Error('Retired model artifacts cannot be downloaded.')
    }
    const controller = new AbortController()
    this.controllers.set(artifactId, controller)
    const staging = this.storage.stagingFile(`${artifactId}.${randomUUID()}.download`)
    const destination = this.storage.modelDirectory(artifactId)
    let received = 0
    try {
      await this.assertDiskSpace(staging, artifact.byteSize)
      await mkdir(staging, { recursive: true })
      this.host.emitDownload(artifact, {
        state: 'downloading',
        bytesReceived: 0,
        totalBytes: artifact.byteSize
      })
      let lastEmitAt = 0
      for (const file of artifact.files) {
        const target = join(staging, file.path)
        await mkdir(dirname(target), { recursive: true })
        received += await this.downloadFile(
          file.sourceUrl,
          target,
          file.byteSize,
          file.sha256,
          controller.signal,
          (fileReceivedSoFar) => {
            const now = Date.now()
            if (now - lastEmitAt < 120) return
            lastEmitAt = now
            this.host.emitDownload(artifact, {
              state: 'downloading',
              bytesReceived: received + fileReceivedSoFar,
              totalBytes: artifact.byteSize
            })
          }
        )
        this.host.emitDownload(artifact, {
          state: 'downloading',
          bytesReceived: received,
          totalBytes: artifact.byteSize
        })
      }
      this.host.emitDownload(artifact, {
        state: 'verifying',
        bytesReceived: received,
        totalBytes: artifact.byteSize
      })
      const previous = `${destination}.${randomUUID()}.previous`
      const hadPrevious = await access(destination)
        .then(() => true)
        .catch(() => false)
      if (hadPrevious) await rename(destination, previous)
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
      await rm(staging, { recursive: true, force: true })
      const cancelled = controller.signal.aborted
      this.host.emitDownload(
        artifact,
        cancelled
          ? { state: 'cancelled', cancelledAt: Date.now() }
          : {
              state: 'failed',
              failedAt: Date.now(),
              error: toSpeechError(cause, 'download-failed')
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
   * ENOSPC failure midway through writing gigabytes of model files.
   */
  private async assertDiskSpace(path: string, byteSize: number): Promise<void> {
    if (!Number.isFinite(byteSize) || byteSize <= 0) return
    try {
      const stats = await statfs(path)
      const available = Number(stats.bavail) * Number(stats.bsize)
      // Require the artifact size plus a small working margin (the app
      // database, logs, and temp files share the same volume).
      const margin = Math.min(Math.max(byteSize * 0.05, 64 * 1024 * 1024), 1_073_741_824)
      if (available < byteSize + margin) {
        throw new Error(
          `Not enough disk space to download this model: ${Math.round(
            (byteSize + margin) / (1024 * 1024)
          )} MB is needed, ${Math.round(available / (1024 * 1024))} MB is available. Free up space and try again.`
        )
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith('Not enough disk space')) throw cause
      // statfs itself failing must never block a download; the streaming write
      // below still surfaces a real error if the disk is genuinely unwritable.
    }
  }

  private downloadFile(
    url: string,
    destination: string,
    expectedBytes: number,
    expectedSha256: string,
    signal: AbortSignal,
    onProgress?: (receivedSoFar: number) => void
  ): Promise<number> {
    return downloadFileResumable({
      url,
      destination,
      expectedBytes,
      checksum: { algorithm: 'sha256', encoding: 'hex', digest: expectedSha256 },
      signal,
      onProgress
    })
  }
}
