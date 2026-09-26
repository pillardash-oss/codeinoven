import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Serving one project folder, shared by every capability that does it.
 *
 * The design and video capabilities both hand a folder to the loopback
 * directory preview server and both resolve an entry file inside it from a
 * model-written argument, so the containment check and the entry rules live
 * here rather than in a copy per capability: a second copy is how one of them
 * ends up accepting a path the other refuses.
 *
 * Resolving the folder itself belongs here for the same reason. The two
 * capabilities used to have a resolver each, and the two were the same function
 * with a different default; now that the default is the user's setting, a copy
 * would let one capability honour the setting and the other keep a constant.
 */

/** File a served folder is expected to hold, and the one a preview falls back to. */
export const SERVED_FOLDER_ENTRY_FILE = 'index.html'

/** Ceiling on the entry field, so a hand-written call cannot inflate a log line. */
export const MAX_PREVIEW_ENTRY_LENGTH = 512

/** Ceiling on a folder field, so a hand-written call cannot inflate a log line. */
export const MAX_SERVED_FOLDER_LENGTH = 1_024

/** Whether `target` is inside `root` and is not `root` itself. */
export function isInsideProject(root: string, target: string): boolean {
  const relativePath = relative(root, target)
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

/** One project-relative folder a capability resolved, and how it is spelled back. */
export interface ResolvedServedFolder {
  /** Absolute path of the folder, which always sits inside the project. */
  absolute: string
  /** Project-relative spelling with forward slashes, which is what a reply names. */
  display: string
}

/**
 * Resolve one project-relative folder a capability may touch.
 *
 * The folder is resolved from a model-written argument, so an absolute path, a
 * name that escapes the project and the project root itself are all refused
 * here: every capability that writes or serves a folder goes through this, and a
 * check per call site is how one of them ends up missing.
 *
 * `defaultRoot` is the user's setting for the capability's kind, passed in rather
 * than read here so that a resolver stays a pure function of its arguments and
 * the caller's own notion of "where this work lives" is the one that applies.
 */
export function resolveServedFolder(
  projectPath: string,
  raw: unknown,
  defaultRoot: string
): ResolvedServedFolder {
  let requested = defaultRoot
  if (raw !== undefined) {
    if (typeof raw !== 'string') throw new Error('directory must be a project-relative path')
    const trimmed = raw.trim()
    if (trimmed.length > MAX_SERVED_FOLDER_LENGTH) throw new Error('directory is too long')
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

/** One entry file inside a served folder, split into the spellings callers need. */
export interface ResolvedServedEntry {
  /** The path as the caller wrote it, which is what a reply names. */
  requested: string
  /** Path segments, already checked, ready to encode into a URL. */
  segments: string[]
  /** Absolute path on disk. */
  absolute: string
}

async function existsAsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Reject an entry that could name anything outside the served folder. */
function parseEntry(raw: string): ResolvedServedEntry {
  if (raw.length > MAX_PREVIEW_ENTRY_LENGTH) throw new Error('entry is too long')
  if (isAbsolute(raw) || /^[a-zA-Z]:/u.test(raw)) {
    throw new Error('entry must be relative to the served folder')
  }
  const segments = raw.split(/[\\/]+/u).filter((segment) => segment.length > 0)
  if (segments.length === 0 || segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error('entry must name a file inside the served folder')
  }
  return { requested: raw, segments, absolute: resolve(...segments) }
}

/**
 * The entry file to show, or null to let the folder listing show.
 *
 * A named entry must exist, because serving a listing for a file the caller
 * named would hide the mistake. With no entry named, `index.html` is used when
 * the folder has one.
 */
export async function resolveServedEntry(
  directoryAbsolute: string,
  raw: unknown
): Promise<ResolvedServedEntry | null> {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new Error('entry must be a path inside the served folder')
  }
  const requested = typeof raw === 'string' ? raw.trim() : ''
  if (requested.length === 0) {
    return (await existsAsFile(resolve(directoryAbsolute, SERVED_FOLDER_ENTRY_FILE)))
      ? parseEntry(SERVED_FOLDER_ENTRY_FILE)
      : null
  }
  const parsed = parseEntry(requested)
  const absolute = resolve(directoryAbsolute, ...parsed.segments)
  if (!isInsideProject(directoryAbsolute, absolute)) {
    throw new Error('entry must name a file inside the served folder')
  }
  if (!(await existsAsFile(absolute))) {
    throw new Error(`The served folder has no file named "${requested}".`)
  }
  return { ...parsed, absolute }
}

/** The absolute URL a served file is reached at, or the folder root when no entry was named. */
export function servedFileUrl(baseUrl: string, entry: ResolvedServedEntry | null): string {
  return entry
    ? `${baseUrl}${entry.segments.map((segment) => encodeURIComponent(segment)).join('/')}`
    : baseUrl
}
