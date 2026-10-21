import { mkdir, rename, rm, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  SearchDownloadMode,
  SearchDownloadState,
  SearchModelArtifact
} from '../../lib/search/types'
import {
  discardLegacyStagingDirectories,
  discardStagedArtifact,
  downloadStagedArtifact,
  stagedArtifactBytes
} from '../util/staged-artifact-download'
import type { SearchStorage } from './search-storage'

export interface SearchModelDownloadHost {
  catalog(): readonly SearchModelArtifact[]
  emitDownload(artifactId: string, download: SearchDownloadState): void
  recordInstalled(artifact: SearchModelArtifact, installedAt: number): Promise<void>
}

/**
 * Streams catalog embedding models into their model directories with resumable,
 * checksum-verified downloads and throttled progress reporting. Mirrors the
 * speech artifact downloader so both domains share one behaviour: a stopped
 * download keeps its staged bytes under a stable per-artifact path and is
 * resumed from them, or restarted from zero on request.
 */
export class SearchModelDownloader {
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly storage: SearchStorage,
    private readonly host: SearchModelDownloadHost
  ) {}

  async download(artifactId: string, mode: SearchDownloadMode = 'resume'): Promise<void> {
    if (this.controllers.has(artifactId)) throw new Error('Model download is already active.')
    const artifact = this.host.catalog().find((item) => item.id === artifactId)
    if (!artifact) throw new Error('Model artifact was not found.')
    const controller = new AbortController()
    this.controllers.set(artifactId, controller)
    const destination = this.storage.modelDirectory(artifactId)
    // One staging directory per artifact, never per attempt, so a cancelled or
    // interrupted download leaves bytes the next attempt continues from.
    const staging = this.storage.stagingFile(`${artifactId}.download`)
    if (mode === 'restart') await discardStagedArtifact(staging)
    else await discardLegacyStagingDirectories(staging, artifact.id)
    const kept = mode === 'restart' ? 0 : await stagedArtifactBytes(staging, artifact.files)
    try {
      await mkdir(dirname(staging), { recursive: true })
      await this.assertDiskSpace(staging, Math.max(0, artifact.byteSize - kept))
      this.host.emitDownload(artifactId, {
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
          this.host.emitDownload(artifactId, {
            state: 'downloading',
            bytesReceived: receivedSoFar,
            totalBytes: artifact.byteSize,
            ...(kept > 0 ? { resumedFromBytes: kept } : {})
          })
        }
      })
      this.host.emitDownload(artifactId, {
        state: 'verifying',
        bytesReceived: received,
        totalBytes: artifact.byteSize
      })
      const previous = `${destination}.previous`
      const hadPrevious = await this.storage.exists(destination)
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
      this.host.emitDownload(artifactId, { state: 'installed', installedAt })
    } catch (cause) {
      // Keep the staged bytes: they are what a resume (or a retry after a
      // dropped connection) continues from.
      const keptBytes = await stagedArtifactBytes(staging, artifact.files)
      if (controller.signal.aborted) {
        this.host.emitDownload(artifactId, {
          state: 'cancelled',
          cancelledAt: Date.now(),
          bytesReceived: keptBytes,
          totalBytes: artifact.byteSize
        })
      } else {
        this.host.emitDownload(artifactId, {
          state: 'failed',
          failedAt: Date.now(),
          message: cause instanceof Error ? cause.message : 'The download failed.',
          bytesReceived: keptBytes,
          totalBytes: artifact.byteSize
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

  /**
   * Preflight against the disk space still needed, not the whole artifact: bytes
   * a resume already has on disk are not asked for twice.
   */
  private async assertDiskSpace(path: string, remainingBytes: number): Promise<void> {
    if (!Number.isFinite(remainingBytes) || remainingBytes <= 0) return
    try {
      const stats = await statfs(dirname(path))
      const available = Number(stats.bavail) * Number(stats.bsize)
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
      // statfs failing must never block a download; the streaming write below
      // still surfaces a real error if the disk is genuinely unwritable.
    }
  }
}
