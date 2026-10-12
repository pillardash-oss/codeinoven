import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SearchDownloadState, SearchModelArtifact } from '../../lib/search/types'
import { downloadFileResumable } from '../util/resumable-download'
import type { SearchStorage } from './search-storage'

export interface SearchModelDownloadHost {
  catalog(): readonly SearchModelArtifact[]
  emitDownload(artifactId: string, download: SearchDownloadState): void
  recordInstalled(artifact: SearchModelArtifact, installedAt: number): Promise<void>
}

/**
 * Streams catalog embedding models into their model directories with resumable,
 * checksum-verified downloads and throttled progress reporting. Mirrors the
 * speech artifact downloader so both domains share one behaviour.
 */
export class SearchModelDownloader {
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly storage: SearchStorage,
    private readonly host: SearchModelDownloadHost
  ) {}

  async download(artifactId: string): Promise<void> {
    if (this.controllers.has(artifactId)) throw new Error('Model download is already active.')
    const artifact = this.host.catalog().find((item) => item.id === artifactId)
    if (!artifact) throw new Error('Model artifact was not found.')
    const controller = new AbortController()
    this.controllers.set(artifactId, controller)
    const staging = this.storage.stagingFile(`${artifactId}.${randomUUID()}.download`)
    const destination = this.storage.modelDirectory(artifactId)
    let received = 0
    try {
      await this.assertDiskSpace(staging, artifact.byteSize)
      await mkdir(staging, { recursive: true })
      this.host.emitDownload(artifactId, {
        state: 'downloading',
        bytesReceived: 0,
        totalBytes: artifact.byteSize
      })
      let lastEmitAt = 0
      for (const file of artifact.files) {
        const target = join(staging, file.path)
        await mkdir(dirname(target), { recursive: true })
        received += await downloadFileResumable({
          url: file.sourceUrl,
          destination: target,
          expectedBytes: file.byteSize,
          checksum: {
            algorithm: 'sha256',
            encoding: 'hex',
            digest: file.sha256
          },
          signal: controller.signal,
          onProgress: (fileReceivedSoFar) => {
            const now = Date.now()
            if (now - lastEmitAt < 120) return
            lastEmitAt = now
            this.host.emitDownload(artifactId, {
              state: 'downloading',
              bytesReceived: received + fileReceivedSoFar,
              totalBytes: artifact.byteSize
            })
          }
        })
        this.host.emitDownload(artifactId, {
          state: 'downloading',
          bytesReceived: received,
          totalBytes: artifact.byteSize
        })
      }
      this.host.emitDownload(artifactId, {
        state: 'verifying',
        bytesReceived: received,
        totalBytes: artifact.byteSize
      })
      const previous = `${destination}.${randomUUID()}.previous`
      const hadPrevious = await this.storage.exists(destination)
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
      this.host.emitDownload(artifactId, { state: 'installed', installedAt })
    } catch (cause) {
      await rm(staging, { recursive: true, force: true })
      if (controller.signal.aborted) {
        this.host.emitDownload(artifactId, { state: 'cancelled', cancelledAt: Date.now() })
      } else {
        this.host.emitDownload(artifactId, {
          state: 'failed',
          failedAt: Date.now(),
          message: cause instanceof Error ? cause.message : 'The download failed.'
        })
      }
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

  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }

  private async assertDiskSpace(path: string, byteSize: number): Promise<void> {
    if (!Number.isFinite(byteSize) || byteSize <= 0) return
    try {
      const stats = await statfs(path)
      const available = Number(stats.bavail) * Number(stats.bsize)
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
      // statfs failing must never block a download; the streaming write below
      // still surfaces a real error if the disk is genuinely unwritable.
    }
  }
}
