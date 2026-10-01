import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  VIDEO_PROJECT_MANIFEST,
  describeVideoProjectManifest,
  type VideoProjectManifest
} from '../../lib/video/project'

/**
 * Reading a composition's manifest, shared by everything that needs the timeline
 * before the page runs.
 *
 * Two callers ask the same question and must not disagree about the answer: the
 * `capture` operation, which has to clamp a requested second to the composition's
 * own length, and the browser tab, which has to know how long the transport runs
 * before it arms it. A second copy of this parse is how a frame past the end of a
 * timeline ends up capturable but unplayable.
 *
 * The manifest is the only thing that says how long a composition runs, so a
 * folder without a readable one has no timeline at all: `readCompositionManifest`
 * answers null and the caller decides what that means, while
 * `loadCompositionManifest` refuses with the sentence a model should read.
 */

/** The manifest beside a composition, or null when there is none to read. */
export async function readCompositionManifest(
  absoluteFolder: string
): Promise<VideoProjectManifest | null> {
  let raw: string
  try {
    raw = await readFile(join(absoluteFolder, VIDEO_PROJECT_MANIFEST), 'utf8')
  } catch {
    return null
  }
  try {
    return describeVideoProjectManifest(JSON.parse(raw))
  } catch {
    // A manifest that is present but wrong is still no timeline: the reader that
    // wants to explain why is the one that throws, not this one.
    return null
  }
}

/**
 * The manifest, or the sentence that says why there is not one.
 *
 * A folder that is not there is a path mistake rather than an unfinished
 * composition, so the two are told apart before the message is chosen.
 */
export async function loadCompositionManifest(
  absoluteFolder: string,
  display: string
): Promise<VideoProjectManifest> {
  const manifestPath = join(absoluteFolder, VIDEO_PROJECT_MANIFEST)
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    const folderExists = await stat(absoluteFolder)
      .then((entry) => entry.isDirectory())
      .catch(() => false)
    throw new Error(
      folderExists
        ? `The composition folder has no ${VIDEO_PROJECT_MANIFEST}. Write the manifest beside index.html first; it declares the frame, the rate and the length the app needs before the page runs.`
        : `A frame cannot be captured from "${display}" because that folder is not there yet. Write the composition into it first, or name a folder that exists.`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${VIDEO_PROJECT_MANIFEST} is not valid JSON.`)
  }
  return describeVideoProjectManifest(parsed)
}
