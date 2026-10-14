import { ipcMain, app, BrowserWindow } from 'electron'
import { join, relative, extname } from 'node:path'
import { mkdir, rm, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { atomicWrite } from '../../lib/utils'
import { requireLocalProjectViaWorker } from '../../lib/project-artifacts'
import {
  validateVideoStudio,
  videoText,
  videoNumber,
  videoRecord,
  trimVideoCaptions,
  parseVideoSrt,
  type VideoStudioDocument
} from '../../lib/video/studio'
import { currentWorkRoot } from '../design/work-roots-state'
import { videoBoundedSeconds } from '../../lib/video/timeline'
import {
  readVideoStudio,
  writeVideoStudio,
  videoFile,
  videoFolder,
  videoOutput,
  videoScratch
} from './video-paths'
import { VideoJobs } from './video-jobs'
import { VideoPackagesService } from './video-packages'
import { exportVideo } from './video-export'
import { probeVideo, inspectVideo } from './video-inspection'
import { videoWaveformDataUrl } from './video-waveform'
import { videoProcess } from './video-process'
import { readCompositionManifest } from './video-manifest'
import type { VideoProjectManifest } from '../../lib/video/project'
import { videoRuntimeSource } from './video-runtime'
import { videoWorkerJob } from './video-worker-job'
import { sendToRenderer } from '../ipc/renderer-delivery'
import type { Database } from '../database/database'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import type { SpeechService } from '../speech/speech-service'
import type { AppConfig } from '../../lib/types'
import type { VideoCapabilityExecutor } from '../utilities/utility-orchestration-service'

export const VIDEO_STUDIO_OPERATIONS = [
  'probe',
  'filmstrip',
  'waveform',
  'listen',
  'transcribe',
  'cut',
  'export',
  'jobs',
  'studio',
  'runtime',
  'captions',
  'track',
  'remove-background'
] as const
export interface VideoStudioOptions {
  database: Database
  previews: DirectoryPreviewService
  speech: () => SpeechService | null
  config: () => Promise<AppConfig>
}
function revision(document: VideoStudioDocument): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex')
}

export class VideoStudioService {
  readonly jobs = new VideoJobs()
  /** The optional GPU matting stack, installed on demand from Settings. */
  readonly packages = new VideoPackagesService()
  private readonly writes = new Map<string, Promise<unknown>>()
  constructor(private readonly options: VideoStudioOptions) {
    void this.packages.initialize()
  }
  private async folder(
    projectId: string,
    directory: unknown
  ): Promise<{ root: string; folder: string }> {
    const project = await requireLocalProjectViaWorker(this.options.database, projectId)
    return {
      root: project.path,
      folder: await videoFolder(project.path, directory ?? currentWorkRoot('video'))
    }
  }
  async read(
    projectId: string,
    directory: unknown
  ): Promise<{
    document: VideoStudioDocument
    revision: string
    manifest: VideoProjectManifest | null
  }> {
    const { folder } = await this.folder(projectId, directory)
    const document = await readVideoStudio(folder)
    // The manifest comes along because a timeline is drawn from it: its duration
    // is the ruler and its rate is the frame step, and neither is in studio.json.
    // A folder with no readable composition is not an error here: the reader
    // already refuses to serve one, and the panel shows an empty ruler.
    return {
      document,
      revision: revision(document),
      manifest: await readCompositionManifest(folder)
    }
  }
  async save(
    projectId: string,
    directory: unknown,
    raw: unknown,
    expected: unknown
  ): Promise<{
    document: VideoStudioDocument
    revision: string
    manifest: VideoProjectManifest | null
  }> {
    const { folder } = await this.folder(projectId, directory)
    const previous = this.writes.get(folder) ?? Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        const current = await readVideoStudio(folder)
        if (typeof expected !== 'string' || revision(current) !== expected)
          throw new Error('The agent changed these controls. Reload them before saving.')
        const document = validateVideoStudio(raw)
        for (const track of document.audioTracks) await videoFile(folder, track.source)
        await writeVideoStudio(folder, document)
        return {
          document,
          revision: revision(document),
          manifest: await readCompositionManifest(folder)
        }
      })
    this.writes.set(folder, task)
    try {
      return await task
    } finally {
      if (this.writes.get(folder) === task) this.writes.delete(folder)
    }
  }
  /**
   * A waveform picture for one audio source's used range, as a data URL.
   *
   * The source is resolved against the composition folder, exactly as the export
   * resolves it, so a lane pictures the sound the composition will actually play.
   * A folder-relative audio path and a project-root-relative one both work, since
   * the file is canonicalised before it is drawn.
   */
  async waveform(
    projectId: string,
    directory: unknown,
    source: unknown,
    offset: unknown,
    duration: unknown
  ): Promise<string | null> {
    const { root, folder } = await this.folder(projectId, directory)
    const file = await videoFile(folder, source)
    // Clamped rather than validated: a track's `duration` may legally be as long
    // as the document allows, and a lane that cannot be pictured is a plain band
    // rather than a hard error the timeline would have to swallow.
    const from = videoBoundedSeconds(offset, 0, 0, 3600)
    const length = videoBoundedSeconds(duration, 10, 0.01, 3600)
    return videoWaveformDataUrl(root, file, from, length, new AbortController().signal)
  }

  readonly execute: VideoCapabilityExecutor = async (operation, input, context) => {
    const project = await requireLocalProjectViaWorker(this.options.database, context.projectId)
    const root = project.path
    if (operation === 'jobs') return this.jobs.list(context.projectId, context.threadId)
    if (operation === 'studio') {
      if (input.document === undefined) return this.read(context.projectId, input.directory)
      return this.save(context.projectId, input.directory, input.document, input.revision)
    }
    if (operation === 'runtime') {
      const folder = await videoFolder(root, input.directory)
      const path = join(folder, 'cio-video.js')
      const source = videoRuntimeSource()
      // Never replace a file authored by someone else, and never leave a partial
      // one behind: a matching runtime is reused, anything else is refused, and
      // the write itself goes through the same atomic rename studio.json uses, so
      // an interrupted install cannot leave a truncated cio-video.js that would
      // then be refused forever as "different content".
      const existing = await videoFile(folder, 'cio-video.js').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return null
        }
      )
      if (existing === null) await atomicWrite(path, source)
      else if ((await stat(existing)).size > 64000 || (await readFile(existing, 'utf8')) !== source)
        throw new Error(
          'cio-video.js already exists with different content. Keep it or rename it before installing the runtime.'
        )
      return {
        file: relative(root, path).replaceAll('\\', '/'),
        reference: './cio-video.js',
        api: [
          'CIOVideo.ready',
          'CIOVideo.parameters',
          'CIOVideo.bind(draw)',
          'CIOVideo.useCanvas(canvas)',
          'CIOVideo.drawCaptions(ctx, seconds, width, height)',
          'CIOVideo.progress(seconds,start,duration)',
          'CIOVideo.interpolate(from,to,progress)',
          'CIOVideo.ease(progress)',
          'CIOVideo.strokePath(ctx,d,length,reveal,options)',
          'CIOVideo.pivot(ctx,x,y,angle,scale)',
          'CIOVideo.trackingAt(points,seconds)',
          'CIOVideo.seekMedia(media,seconds)',
          'CIOVideo.mediaReady(media)'
        ]
      }
    }
    if (operation === 'captions') {
      const folder = await videoFolder(root, input.directory)
      const state = await this.read(context.projectId, input.directory)
      let captions = state.document.captions
      if (input.source !== undefined) {
        const file = await videoFile(root, input.source)
        if ((await stat(file)).size > 2 * 1024 * 1024)
          throw new Error('Caption input exceeds 2 MiB')
        const text = await readFile(file, 'utf8')
        if (extname(file).toLowerCase() === '.srt') captions = parseVideoSrt(text)
        else {
          const raw: unknown = JSON.parse(text)
          const entries = Array.isArray(raw) ? raw : videoRecord(raw).captions
          captions = validateVideoStudio({ captions: entries }).captions
        }
      }
      if (input.from !== undefined || input.to !== undefined) {
        if (input.from === undefined || input.to === undefined)
          throw new Error('from and to are required together to retime captions after a cut')
        captions = trimVideoCaptions(
          captions,
          videoNumber(input.from, 'from', 0, 3600),
          videoNumber(input.to, 'to', 0.001, 3600),
          videoNumber(input.at ?? 0, 'at', 0, 3600)
        )
      }
      const saved = await this.save(
        context.projectId,
        input.directory,
        { ...state.document, captions, captionStyle: input.style ?? state.document.captionStyle },
        state.revision
      )
      return { ...saved, directory: relative(root, folder) }
    }
    if (operation === 'probe')
      return probeVideo(root, videoText(input.source, 'source'), AbortSignal.timeout(30000))
    if (!VIDEO_STUDIO_OPERATIONS.some((name) => name === operation))
      throw new Error('Unsupported video operation')
    // Fail before a job or a worker is started when the optional pack is absent.
    if (operation === 'remove-background') {
      await this.packages.refresh()
      if (!this.packages.state().installed)
        throw new Error(
          'Background removal needs the optional video pack. Install it in Settings > Design and video.'
        )
    }
    const folder = operation === 'export' ? await videoFolder(root, input.directory) : null
    const source = folder ? null : await videoFile(root, input.source)
    const config = operation === 'transcribe' ? await this.options.config() : null
    return this.jobs.start(context.projectId, context.threadId, operation, async (job) => {
      if (folder) return exportVideo(root, folder, this.options.previews, job)
      if (operation === 'track' || operation === 'remove-background' || operation === 'cut') {
        const info = await probeVideo(root, relative(root, source!), job.signal)
        const start = videoNumber(input.start ?? 0, 'start', 0, 3600)
        const requested = videoNumber(
          input.duration ?? Math.min(info.duration ?? 10, 60),
          'duration',
          0.1,
          60
        )
        if (!info.width || info.duration === null || start >= info.duration)
          throw new Error('A finite video source is required')
        const duration = Math.min(requested, info.duration - start)
        const output = await videoOutput(root, operation === 'cut' ? 'cuts' : 'layers')
        if (operation === 'cut') {
          const file = join(output, 'clip.mp4')
          try {
            await videoProcess(
              [
                '-ss',
                String(start),
                '-t',
                String(duration),
                '-i',
                source!,
                '-c:v',
                'libx264',
                '-threads',
                '2',
                '-preset',
                'fast',
                '-c:a',
                'aac',
                '-movflags',
                '+faststart',
                '-y',
                file
              ],
              root,
              job.signal
            )
            return { files: [relative(root, file).replaceAll('\\', '/')] }
          } catch (error) {
            await rm(output, { recursive: true, force: true })
            throw error
          }
        }
        if (operation === 'track') {
          const x = videoNumber(input.x, 'x', 0, 1),
            y = videoNumber(input.y, 'y', 0, 1)
          const width = videoNumber(input.width, 'width', 0.01, 1 - x)
          const height = videoNumber(input.height, 'height', 0.01, 1 - y)
          return videoWorkerJob(
            'track',
            root,
            { root, source, output, start, duration, x, y, width, height },
            job
          )
        }
        // Normalize to a bounded 720p clip before GPU inference. Source remains untouched.
        const scratch = await videoScratch(root, 'matting')
        const prepared = join(scratch, 'input.mp4')
        try {
          await videoProcess(
            [
              '-ss',
              String(start),
              '-t',
              String(duration),
              '-i',
              source!,
              '-an',
              '-vf',
              "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
              '-c:v',
              'libx264',
              '-threads',
              '2',
              '-preset',
              'fast',
              '-y',
              prepared
            ],
            root,
            job.signal
          )
          await mkdir(join(root, '.cio/tmp'), { recursive: true })
          await videoFolder(root, '.cio/tmp')
          // Weights live in the durable app config root, not project scratch:
          // CIO Cleanup sweeps `.cio/tmp`, which would re-download them.
          const cache = this.packages.modelsDir
          await mkdir(cache, { recursive: true })
          const model = input.model ?? 'modnet'
          if (model !== 'modnet' && model !== 'ben2-base')
            throw new Error('model must be modnet or ben2-base')
          return await videoWorkerJob(
            'remove-background',
            root,
            { source: prepared, output, cache, packages: this.packages.packagesDir, model },
            job
          )
        } finally {
          await rm(scratch, { recursive: true, force: true })
        }
      }
      return inspectVideo(
        operation,
        root,
        input,
        job,
        this.options.speech(),
        config?.sound.asrArtifactId
      )
    })
  }
  registerIpc(): void {
    const id = (value: unknown): string => videoText(value, 'identifier', 128)
    ipcMain.handle('video:studio', (_event, projectId, directory) =>
      this.read(id(projectId), directory)
    )
    ipcMain.handle('video:save', (_event, projectId, directory, document, expected) =>
      this.save(id(projectId), directory, document, expected)
    )
    ipcMain.handle('video:jobs', (_event, projectId, threadId) =>
      this.jobs.list(id(projectId), id(threadId))
    )
    ipcMain.handle('video:cancel', (_event, projectId, threadId, jobId) =>
      this.jobs.cancel(id(projectId), id(threadId), id(jobId))
    )
    ipcMain.handle('video:export', (_event, projectId, threadId, directory) =>
      this.execute('export', { directory }, { projectId: id(projectId), threadId: id(threadId) })
    )
    ipcMain.handle('video:waveform', (_event, projectId, directory, source, offset, duration) =>
      this.waveform(id(projectId), directory, source, offset, duration)
    )
    const stopPackProgress = this.packages.onProgress((state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        sendToRenderer(window.webContents, 'video:packages:progress', state)
      }
    })
    ipcMain.handle('video:packages:state', async () => {
      await this.packages.initialize()
      return this.packages.state()
    })
    ipcMain.handle('video:packages:install', () => this.packages.install())
    ipcMain.handle('video:packages:remove', () => this.packages.remove())
    ipcMain.handle('video:packages:cancel', () => this.packages.cancel())
    app.once('before-quit', () => {
      stopPackProgress()
      this.jobs.dispose()
    })
  }
}
