import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  describeVideoProjectManifest,
  VIDEO_PROJECT_ENTRY,
  VIDEO_PROJECT_MANIFEST
} from '../../lib/video/project'

/**
 * The films the app ships as starting points.
 *
 * A starter is a finished composition, not a blank form: it exists so the first
 * frame of the work is a film that already plays and already exports, and so the
 * author has a real answer to "what does a beat look like" instead of a guess.
 * This module only finds them and copies one; the Electron side resolves where
 * they are installed (see `video-starters-root.ts`), and the service installs the
 * runtime into the copy.
 */

/** A shipped film, as much of it as a caller needs before copying it. */
export interface VideoStarter {
  name: string
  /** Seconds the film runs, from its own manifest. */
  seconds: number | null
  /** Frame size, from its own manifest. */
  frame: string | null
}

/** Folder names are lowercase and carry no separators, so a name is never a path. */
const STARTER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/** The generated helper the app installs, never part of a shipped film's source. */
export const VIDEO_STARTER_RUNTIME_FILE = 'cio-video.js'

/** One line naming the films that are actually installed, for an error message. */
async function describeAvailable(startersRoot: string): Promise<string> {
  const starters = await listVideoStarters(startersRoot)
  if (!starters.length) return 'No films are installed in this build.'
  return `Films this app ships: ${starters.map((starter) => starter.name).join(', ')}.`
}

/** The manifest and size of one shipped film, or null when the folder is not one. */
async function readStarter(startersRoot: string, name: string): Promise<VideoStarter | null> {
  const folder = join(startersRoot, name)
  try {
    await stat(join(folder, VIDEO_PROJECT_ENTRY))
    const manifest = describeVideoProjectManifest(
      JSON.parse(await readFile(join(folder, VIDEO_PROJECT_MANIFEST), 'utf8'))
    )
    return { name, seconds: manifest.duration, frame: `${manifest.width}x${manifest.height}` }
  } catch {
    // A folder that is not a composition is not a starter. Nothing here explains
    // it: the caller that asked for a name gets the list of the ones that are.
    return null
  }
}

/** Every shipped film that is genuinely a composition, in name order. */
export async function listVideoStarters(startersRoot: string): Promise<VideoStarter[]> {
  const entries = await readdir(startersRoot, { withFileTypes: true }).catch(() => [])
  const found: VideoStarter[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !STARTER_NAME_PATTERN.test(entry.name)) continue
    const starter = await readStarter(startersRoot, entry.name)
    if (starter) found.push(starter)
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Copy one shipped film into a composition folder.
 *
 * Files only, and directories walked rather than followed: a shipped film is
 * authored content, so a link or a device node in one is a mistake rather than
 * something to reproduce inside a user's project. The generated runtime is
 * skipped because the caller installs the current one, and a copy that carried an
 * old one would silently pin a composition to a helper the app has moved past.
 */
async function copyTree(
  source: string,
  target: string,
  prefix: string,
  files: string[]
): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (name === VIDEO_STARTER_RUNTIME_FILE) continue
    const from = join(source, entry.name)
    if (entry.isDirectory()) {
      await mkdir(join(target, entry.name), { recursive: true })
      await copyTree(from, join(target, entry.name), name, files)
    } else if (entry.isFile()) {
      await copyFile(from, join(target, entry.name))
      files.push(name)
    }
  }
}

/** Whether a folder already holds a composition, which a copy must not walk over. */
async function holdsComposition(target: string): Promise<boolean> {
  for (const name of [VIDEO_PROJECT_ENTRY, VIDEO_PROJECT_MANIFEST]) {
    if (
      await stat(join(target, name)).then(
        () => true,
        () => false
      )
    )
      return true
  }
  return false
}

/**
 * Start a composition from a shipped film.
 *
 * The target is refused rather than merged when it already holds a composition:
 * losing an authored film to a scaffold is not a trade anyone asked for, and an
 * empty folder is the normal case.
 */
export async function copyVideoStarter(input: {
  startersRoot: string
  target: string
  name: string
}): Promise<{ files: string[]; starter: VideoStarter }> {
  const name = input.name.trim()
  if (!STARTER_NAME_PATTERN.test(name)) {
    throw new Error(
      `"${input.name}" is not the name of a shipped film. ${await describeAvailable(input.startersRoot)}`
    )
  }
  const starter = await readStarter(input.startersRoot, name)
  if (!starter) {
    throw new Error(
      `There is no film named "${name}" in this build. ${await describeAvailable(input.startersRoot)}`
    )
  }
  if (await holdsComposition(input.target)) {
    throw new Error(
      'That folder already holds a composition. Name a folder that does not have one, or edit the composition that is there.'
    )
  }
  const files: string[] = []
  await mkdir(input.target, { recursive: true })
  await copyTree(join(input.startersRoot, name), input.target, '', files)
  return { files: files.sort(), starter }
}
