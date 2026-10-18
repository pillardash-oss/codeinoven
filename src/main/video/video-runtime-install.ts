import { readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { atomicWrite } from '../../lib/utils'
import { videoFile } from './video-paths'
import { videoRuntimeSource } from './video-runtime'

/** The generated helper, installed beside a composition and never hand-authored. */
export const VIDEO_RUNTIME_FILE = 'cio-video.js'

/** Ceiling on a file someone else authored under the runtime's name. */
const MAX_FOREIGN_RUNTIME_BYTES = 64000

/** What a composition can reach once the helper beside it is installed. */
export interface VideoRuntimeInstall {
  file: string
  reference: string
  api: string[]
}

/**
 * Put the composition runtime beside one composition folder.
 *
 * A matching runtime is reused rather than rewritten, anything else under that
 * name is refused rather than replaced, and the write goes through the same
 * atomic rename studio.json uses: an interrupted install must not leave a
 * truncated cio-video.js that would then be refused forever as different content.
 */
export async function installVideoRuntime(
  root: string,
  folder: string
): Promise<VideoRuntimeInstall> {
  const path = join(folder, VIDEO_RUNTIME_FILE)
  const source = videoRuntimeSource()
  const existing = await videoFile(folder, VIDEO_RUNTIME_FILE).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    }
  )
  if (existing === null) await atomicWrite(path, source)
  else if (
    (await stat(existing)).size > MAX_FOREIGN_RUNTIME_BYTES ||
    (await readFile(existing, 'utf8')) !== source
  )
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
      'CIOVideo.easings(curve)',
      'CIOVideo.strokePath(ctx,d,length,reveal,options)',
      'CIOVideo.pivot(ctx,x,y,angle,scale)',
      'CIOVideo.trackingAt(points,seconds)',
      'CIOVideo.seekMedia(media,seconds)',
      'CIOVideo.mediaReady(media)'
    ]
  }
}
