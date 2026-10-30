import { BrowserWindow, webContents, type WebContents } from 'electron'
import { constants } from 'node:fs'
import { copyFile, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateVideoStudio, type VideoStudioDocument } from '../../lib/video/studio'
import {
  applyVideoEditOperations,
  validateVideoEditRect,
  validateVideoBrushStroke,
  validateCaptionAppearance,
  type VideoEditAsset,
  type VideoEditorGesture,
  type VideoEditorSelection
} from '../../lib/video/edit'
import type { VideoProjectManifest } from '../../lib/video/project'
import type { Database } from '../database/database'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import { authoredWorkRoot } from '../design/authored-work-root'
import { videoFile, videoFolder } from './video-paths'
import { probeVideo } from './video-inspection'
import { requireCompositionManifest } from './video-manifest'
import { migrateVideoEdit } from './video-edit-migration'
import { installVideoRuntime } from './video-runtime-install'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'

export interface VideoEditorRead {
  document: VideoStudioDocument
  revision: string
  manifest: VideoProjectManifest | null
}
interface Options {
  database: Database
  previews: DirectoryPreviewService
  resolveImportPath?: (path: unknown) => Promise<string>
  read(projectId: string, threadId: string, directory: unknown): Promise<VideoEditorRead>
  save(
    projectId: string,
    threadId: string,
    directory: unknown,
    document: unknown,
    revision: unknown,
    cause?: 'user' | 'agent'
  ): Promise<VideoEditorRead>
}

/** Asset work stays asynchronous and serial; a gesture bridge waits without polling. */
export class VideoEditorService {
  private readonly bridges = new Map<number, object>()
  private importTail: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: Options) {}

  private async folder(projectId: string, threadId: string, directory: unknown): Promise<string> {
    const scope = await authoredWorkRoot(this.options.database, projectId, threadId)
    return videoFolder(scope.path, directory)
  }

  async enable(projectId: string, threadId: string, directory: string): Promise<VideoEditorRead> {
    const state = await this.options.read(projectId, threadId, directory)
    const folder = await this.folder(projectId, threadId, directory)
    // Reading the manifest here rather than trusting the first answer is what
    // separates a delivery from a manifest that is merely being rewritten: a
    // folder the author is saving must open, and a folder whose manifest is wrong
    // must say which field is wrong instead of claiming there is no manifest.
    const manifest = await requireCompositionManifest(folder, directory, state.manifest)
    await installVideoRuntime(folder, folder)
    if (state.document.edit) return state
    const edit = await migrateVideoEdit(
      folder,
      state.document,
      manifest,
      new AbortController().signal
    )
    return this.options.save(
      projectId,
      threadId,
      directory,
      { ...state.document, edit },
      state.revision
    )
  }

  async apply(
    projectId: string,
    threadId: string,
    directory: string,
    revision: unknown,
    operations: unknown
  ): Promise<VideoEditorRead> {
    const state = await this.options.read(projectId, threadId, directory)
    if (!state.document.edit) throw new Error('Enable the editable timeline first')
    if (revision !== state.revision)
      throw new Error('The edit changed. Read the current revision before applying commands.')
    state.document.edit = applyVideoEditOperations(
      state.document.edit,
      operations,
      state.manifest?.fps ?? 30
    )
    return this.options.save(
      projectId,
      threadId,
      directory,
      state.document,
      state.revision,
      'agent'
    )
  }

  async importAssets(
    projectId: string,
    threadId: string,
    directory: string,
    paths: unknown
  ): Promise<VideoEditAsset[]> {
    if (
      !Array.isArray(paths) ||
      paths.length < 1 ||
      paths.length > 16 ||
      paths.some((path) => typeof path !== 'string')
    )
      throw new Error('Import between one and sixteen files at a time')
    const previous = this.importTail
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        const folder = await this.folder(projectId, threadId, directory)
        await mkdir(join(folder, 'assets'), { recursive: true })
        const destination = await videoFolder(folder, 'assets')
        const result: VideoEditAsset[] = []
        for (const raw of paths as string[]) {
          const input = isAbsolute(raw)
            ? await this.options.resolveImportPath?.(raw)
            : await videoFile(folder, raw)
          if (!input) throw new Error('Choose or drop the file before importing it')
          const source = await realpath(input),
            metadata = await stat(source)
          if (!metadata.isFile() || metadata.size < 1)
            throw new Error('Choose a nonempty media file')
          const extension = extname(source).toLowerCase()
          const kind = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.avif'].includes(extension)
            ? 'image'
            : ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'].includes(extension)
              ? 'audio'
              : ['.mp4', '.mov', '.mkv', '.webm', '.m4v'].includes(extension)
                ? 'video'
                : null
          if (!kind) throw new Error(`Unsupported media file: ${basename(source)}`)
          const id = randomUUID(),
            name = basename(source)
              .replace(/[^\w. -]/gu, '_')
              .slice(-100)
          const filename = `${id}-${name}`,
            temporary = join(destination, `.${id}.importing`),
            output = join(destination, filename)
          try {
            await copyFile(source, temporary, constants.COPYFILE_FICLONE)
            await rename(temporary, output)
            const relative = `assets/${filename}`
            const info =
              kind === 'image'
                ? null
                : await probeVideo(folder, relative, new AbortController().signal)
            if (kind === 'audio' && !info?.hasAudio)
              throw new Error('This file has no readable audio stream')
            result.push({
              id,
              name: basename(source),
              source: relative,
              kind,
              duration: info?.duration ?? 5,
              width: info?.width ?? 0,
              height: info?.height ?? 0,
              hasAudio: info?.hasAudio ?? false
            })
          } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined)
            await rm(output, { force: true }).catch(() => undefined)
            throw error
          }
        }
        return result
      })
    this.importTail = task
    return task
  }

  /** Push unsaved edits to this composition's existing views, never to an export. */
  async preview(
    projectId: string,
    threadId: string,
    directory: string,
    raw: unknown,
    selection: VideoEditorSelection
  ): Promise<void> {
    const document = validateVideoStudio(raw)
    const folder = await this.folder(projectId, threadId, directory)
    const registration = await this.options.previews.open(folder)
    const origin = new URL(registration.url).origin
    const payload = JSON.stringify(document),
      selected = JSON.stringify(selection)
    const matching = webContents
      .getAllWebContents()
      .filter((contents) => {
        try {
          return !contents.isDestroyed() && new URL(contents.getURL()).origin === origin
        } catch {
          return false
        }
      })
      .slice(0, 8)
    for (const contents of matching) {
      const accepted: unknown = await contents
        .executeJavaScript(
          `(async () => {
        if (globalThis.__cioEditPreviewDisabled || !globalThis.CIOVideo?.setStudio) return false;
        await globalThis.CIOVideo.setStudio(${payload}, ${selected}); return true;
      })()`
        )
        .catch(() => false)
      if (accepted === true && !this.bridges.has(contents.id))
        this.armGesture(contents, projectId, threadId, directory)
    }
  }

  private armGesture(
    contents: WebContents,
    projectId: string,
    threadId: string,
    directory: string
  ): void {
    if (contents.isDestroyed()) return
    const token = {},
      id = contents.id
    this.bridges.set(id, token)
    void contents
      .executeJavaScript('globalThis.CIOVideo?.takeGesture?.()')
      .then((raw: unknown) => {
        if (this.bridges.get(id) !== token || contents.isDestroyed()) return
        this.bridges.delete(id)
        if (!raw || typeof raw !== 'object') return
        const value = raw as Record<string, unknown>,
          selection = value.selection
        if (!selection || typeof selection !== 'object') return
        const item = selection as Record<string, unknown>
        let target: Exclude<VideoEditorSelection, null>
        if (
          (item.kind === 'clip' || item.kind === 'region') &&
          typeof item.id === 'string' &&
          item.id.length <= 96
        )
          target = { kind: item.kind, id: item.id }
        else if (
          item.kind === 'caption' &&
          typeof item.index === 'number' &&
          Number.isInteger(item.index) &&
          item.index >= 0 &&
          item.index < 10000
        )
          target = { kind: 'caption', index: item.index }
        else return
        const gesture: VideoEditorGesture = {
          selection: target,
          rect: validateVideoEditRect(value.rect),
          ...(value.kind === 'select' || value.kind === 'context' || value.kind === 'paint'
            ? { kind: value.kind }
            : {}),
          ...(target.kind === 'caption' && value.captionAppearance !== undefined
            ? { captionAppearance: validateCaptionAppearance(value.captionAppearance) }
            : {})
        }
        if (gesture.kind === 'paint') {
          gesture.stroke = validateVideoBrushStroke(value.stroke)
          if (
            typeof value.brushSize !== 'number' ||
            !Number.isFinite(value.brushSize) ||
            value.brushSize <= 0 ||
            value.brushSize > 2
          )
            return
          gesture.brushSize = value.brushSize
        }
        if (gesture.kind === 'context' && value.point && typeof value.point === 'object') {
          const point = value.point as Record<string, unknown>
          if (
            typeof point.x !== 'number' ||
            typeof point.y !== 'number' ||
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y)
          )
            return
          gesture.point = {
            x: Math.max(0, Math.min(1, point.x)),
            y: Math.max(0, Math.min(1, point.y))
          }
        }
        for (const window of BrowserWindow.getAllWindows())
          sendToRenderer(
            window.webContents,
            'video:gesture',
            projectId,
            threadId,
            directory,
            gesture
          )
        this.armGesture(contents, projectId, threadId, directory)
      })
      .catch((error: unknown) => {
        if (this.bridges.get(id) === token) this.bridges.delete(id)
        if (!contents.isDestroyed()) Logger.dev('Video editing gesture ended', error)
      })
  }

  async stop(projectId: string, threadId: string, directory: string): Promise<void> {
    const folder = await this.folder(projectId, threadId, directory)
    const registration = await this.options.previews.open(folder)
    const origin = new URL(registration.url).origin
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed() || !contents.getURL().startsWith(`${origin}/`)) continue
      this.bridges.delete(contents.id)
      await contents
        .executeJavaScript('globalThis.CIOVideo?.stopEditing?.()')
        .catch(() => undefined)
    }
  }
}
