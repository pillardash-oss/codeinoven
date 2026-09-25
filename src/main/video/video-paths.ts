import { isAbsolute, relative, resolve, sep } from 'node:path'
import { VIDEO_PROJECT_ROOT } from '../../lib/video/project'
import { isInsideProject } from '../preview/served-folder'

/**
 * The one place the video capability turns a project-relative string into a
 * folder it may touch.
 *
 * Two operations resolve a folder from a model-written argument, `preview` to
 * serve it and `capture` to read its manifest, so the default, the ceiling and
 * the escape check live here rather than in each executor: a second copy is how
 * one of them ends up accepting a path the other refuses.
 */

/** Ceiling on the path field, so a hand-written call cannot inflate a log line. */
export const MAX_VIDEO_DIRECTORY_LENGTH = 1_024

export interface ResolvedVideoDirectory {
  /** Absolute path of the folder, which always sits inside the project. */
  absolute: string
  /** Project-relative spelling with forward slashes, which is what a reply names. */
  display: string
}

/**
 * Resolve one project-relative folder, defaulted to the composition root and
 * refused when it could name anything outside the project.
 */
export function resolveVideoDirectory(projectPath: string, raw: unknown): ResolvedVideoDirectory {
  let requested = VIDEO_PROJECT_ROOT
  if (raw !== undefined) {
    if (typeof raw !== 'string') throw new Error('directory must be a project-relative path')
    const trimmed = raw.trim()
    if (trimmed.length > MAX_VIDEO_DIRECTORY_LENGTH) throw new Error('directory is too long')
    if (trimmed.length > 0) requested = trimmed
  }
  if (isAbsolute(requested)) throw new Error('directory must be relative to the project')
  const absolute = resolve(projectPath, requested)
  if (!isInsideProject(projectPath, absolute)) {
    throw new Error(
      'directory must be a folder inside the project, and not the project root itself'
    )
  }
  return { absolute, display: relative(projectPath, absolute).split(sep).join('/') }
}
