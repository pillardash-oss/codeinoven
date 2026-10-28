import { ipcMain, app, BrowserWindow } from 'electron'
import { join, relative, extname } from 'node:path'
import { mkdir, rm, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { authoredWorkRoot } from '../design/authored-work-root'
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
import { snapVideoFrame } from '../../lib/video/frame-grid'
import { VideoFramePreview } from './video-frame-preview'
import { resolveServedEntry, servedFileUrl } from '../preview/served-folder'
import {
  readVideoStudio,
  writeVideoStudio,
  videoFile,
  videoFolder,
  videoOutput,
  videoScratch,
  videoTargetFolder,
  videoExportFile
} from './video-paths'
import { VideoJobs } from './video-jobs'
import { VideoPackagesService } from './video-packages'
import { exportVideo } from './video-export'
import { probeVideo, inspectVideo } from './video-inspection'
import { videoWaveformDataUrl } from './video-waveform'
import { videoProcess } from './video-process'
import { readCompositionManifest } from './video-manifest'
import type { VideoProjectManifest } from '../../lib/video/project'
import { installVideoRuntime } from './video-runtime-install'
import { copyVideoStarter } from './video-starters'
import { videoStartersRoot } from './video-starters-root'
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
  'scaffold',
  'captions',
  'track',
  'analyze-motion',
  'remove-background'
] as const
export interface VideoStudioOptions {
  database: Database
  previews: DirectoryPreviewService
  speech: () => SpeechService | null
  config: () => Promise<AppConfig>
  /**
   * Called when a save rewrote the composition's studio.json.
   *
   * A saved edit is a change the folder's history has not seen, and the board's
   * history pane reloads when it hears about one. The folder is the project-relative
   * directory, the same form `design:historyChanged` carries.
   */
  onChanged?: (projectId: string, directory: string) => void
  captureHistory?: (
    projectId: string,
    threadId: string,
    directory: string,
    cause: 'user' | 'agent'
  ) => Promise<void>
}
function revision(document: VideoStudioDocument): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex')
}

export class VideoStudioService {
  private readonly framePreviews = new VideoFramePreview()
  readonly jobs = new VideoJobs()
  /** The optional GPU matting stack, installed on demand from Settings. */
  readonly packages = new VideoPackagesService()
  private readonly writes = new Map<string, Promise<unknown>>()
  constructor(private readonly options: VideoStudioOptions) {
    void this.packages.initialize()
  }
  /**
   * The absolute root of one composition's scope, and the composition folder
   * inside it.
   *
   * The thread is part of the question rather than optional: a project thread's
   * work sits in its checkout, while an assistant task's, a chat's and a browser
   * tab's work sits in the workspace that conversation runs in, and only the
   * thread can say which of those workspaces that is.
   */
  private async folder(
    projectId: string,
    threadId: string,
    directory: unknown
  ): Promise<{ root: string; folder: string }> {
    const scope = await authoredWorkRoot(this.options.database, projectId, threadId)
    return {
      root: scope.path,
      folder: await videoFolder(scope.path, directory ?? currentWorkRoot('video', projectId))
    }
  }
  /**
   * The export one composition already has, as a project-relative path.
   *
   * The board asks this for the folder in front rather than remembering an answer,
   * because the answer has to outlive a job record: an export made in another
   * thread of the same project, or before the app restarted, still belongs to the
   * composition that produced it. A composition that has never been exported
   * answers null, and the board falls back to what it has.
   */
  async latestExport(
    projectId: string,
    threadId: string,
    directory: unknown
  ): Promise<string | null> {
    const { root, folder } = await this.folder(projectId, threadId, directory)
    const file = await videoExportFile(root, relative(root, folder))
    return file === null ? null : relative(root, file)
  }
  async read(
    projectId: string,
    threadId: string,
    directory: unknown
  ): Promise<{
    document: VideoStudioDocument
    revision: string
    manifest: VideoProjectManifest | null
  }> {
    const { folder } = await this.folder(projectId, threadId, directory)
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
    threadId: string,
    directory: unknown,
    raw: unknown,
    expected: unknown,
    cause: 'user' | 'agent' = 'user'
  ): Promise<{
    document: VideoStudioDocument
    revision: string
    manifest: VideoProjectManifest | null
  }> {
    const { root, folder } = await this.folder(projectId, threadId, directory)
    const previous = this.writes.get(folder) ?? Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        const current = await readVideoStudio(folder)
        if (typeof expected !== 'string' || revision(current) !== expected)
          throw new Error('The agent changed these controls. Reload them before saving.')
        const document = validateVideoStudio(raw)
        for (const track of document.audioTracks) await videoFile(folder, track.source)
        const savedDirectory = relative(root, folder).replaceAll('\\', '/')
        // Save both sides even when no history panel is mounted.
        await this.options.captureHistory?.(projectId, threadId, savedDirectory, cause)
        await writeVideoStudio(folder, document)
        await this.options.captureHistory?.(projectId, threadId, savedDirectory, cause)
        // A saved control edit is a step in the folder's history, so the pane that
        // shows that history is told, exactly as a design restore tells it.
        this.options.onChanged?.(projectId, relative(root, folder).replaceAll('\\', '/'))
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
    threadId: string,
    directory: unknown,
    source: unknown,
    offset: unknown,
    duration: unknown
  ): Promise<string | null> {
    const { root, folder } = await this.folder(projectId, threadId, directory)
    const file = await videoFile(folder, source)
    // Clamped rather than validated: a track's `duration` may legally be as long
    // as the document allows, and a lane that cannot be pictured is a plain band
    // rather than a hard error the timeline would have to swallow.
    const from = videoBoundedSeconds(offset, 0, 0, 3600)
    const length = videoBoundedSeconds(duration, 10, 0.01, 3600)
    return videoWaveformDataUrl(root, file, from, length, new AbortController().signal)
  }

  readonly execute: VideoCapabilityExecutor = async (operation, input, context) => {
    const scope = await authoredWorkRoot(this.options.database, context.projectId, context.threadId)
    const root = scope.path
    if (operation === 'jobs') return this.jobs.list(context.projectId, context.threadId)
    if (operation === 'studio') {
      if (input.document === undefined)
        return this.read(context.projectId, context.threadId, input.directory)
      return this.save(
        context.projectId,
        context.threadId,
        input.directory,
        input.document,
        input.revision,
        'agent'
      )
    }
    if (operation === 'scaffold') {
      const target = await videoTargetFolder(root, input.directory)
      const copied = await copyVideoStarter({
        startersRoot: videoStartersRoot(),
        target,
        name: videoText(input.starter, 'starter')
      })
      const runtime = await installVideoRuntime(root, target)
      // What a caller needs to start work: the film, the runtime it needs, and the
      // guide that says which parts of it are placeholders.
      return {
        ...copied,
        runtime: runtime.file,
        reference: runtime.reference,
        guide: copied.files.includes('README.md') ? 'README.md' : null,
        note: `${copied.starter.seconds ?? '?'} seconds at ${copied.starter.frame ?? '?'}, runtime installed. Read README.md beside the composition for the beat map, then preview it.`
      }
    }
    // The install itself lives in one module, because a scaffold and an explicit
    // runtime install must produce the same file.
    if (operation === 'runtime')
      return installVideoRuntime(root, await videoFolder(root, input.directory))
    if (operation === 'captions') {
      const folder = await videoFolder(root, input.directory)
      const state = await this.read(context.projectId, context.threadId, input.directory)
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
        context.threadId,
        input.directory,
        { ...state.document, captions, captionStyle: input.style ?? state.document.captionStyle },
        state.revision,
        'agent'
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
      if (
        operation === 'track' ||
        operation === 'analyze-motion' ||
        operation === 'remove-background' ||
        operation === 'cut'
      ) {
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
        if (operation === 'track' || operation === 'analyze-motion') {
          const x = videoNumber(input.x, 'x', 0, 1),
            y = videoNumber(input.y, 'y', 0, 1)
          const width = videoNumber(input.width, 'width', 0.01, 1 - x)
          const height = videoNumber(input.height, 'height', 0.01, 1 - y)
          return videoWorkerJob(
            'track',
            root,
            {
              root,
              source,
              output,
              start,
              duration,
              x,
              y,
              width,
              height,
              analyze: operation === 'analyze-motion'
            },
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
    ipcMain.handle(
      'video:frameStrip',
      async (_event, projectId, threadId, directory, times: unknown) => {
        if (
          !Array.isArray(times) ||
          times.length > 24 ||
          times.some(
            (time: unknown) => typeof time !== 'number' || !Number.isFinite(time) || time < 0
          )
        )
          throw new Error('Frame previews require up to 24 valid times')
        if (!times.length) return []
        const { folder } = await this.folder(id(projectId), id(threadId), directory)
        const manifest = await readCompositionManifest(folder)
        if (
          !manifest ||
          manifest.width > 8192 ||
          manifest.height > 8192 ||
          manifest.width * manifest.height > 3840 * 2160
        )
          return []
        const entry = await resolveServedEntry(folder, 'index.html')
        if (!entry) return []
        const registration = await this.options.previews.open(folder)
        return this.framePreviews.render(servedFileUrl(registration.url, entry), manifest, [
          ...new Set(
            (times as number[]).map((time) => snapVideoFrame(time, manifest.duration, manifest.fps))
          )
        ])
      }
    )
    const id = (value: unknown): string => videoText(value, 'identifier', 128)
    ipcMain.handle('video:studio', (_event, projectId, threadId, directory) =>
      this.read(id(projectId), id(threadId), directory)
    )
    ipcMain.handle('video:save', (_event, projectId, threadId, directory, document, expected) =>
      this.save(id(projectId), id(threadId), directory, document, expected)
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
    ipcMain.handle('video:latestExport', (_event, projectId, threadId, directory) =>
      this.latestExport(id(projectId), id(threadId), directory)
    )
    ipcMain.handle(
      'video:waveform',
      (_event, projectId, threadId, directory, source, offset, duration) =>
        this.waveform(id(projectId), id(threadId), directory, source, offset, duration)
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
      this.framePreviews.dispose()
    })
  }
}
