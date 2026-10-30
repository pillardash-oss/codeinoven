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
 * How long a second look at a manifest waits before absence is believed.
 *
 * A manifest is a file an author edits: an agent rewrites it with a script, an
 * editor writes it, and the app itself rewrites it on every save. A read that
 * lands between two writes sees no readable manifest at all, and reporting that
 * as "this folder is not a composition" describes a momentary state as a fact.
 * One short wait is enough for a rename to land and costs a settled file nothing.
 */
const MANIFEST_SETTLE_DELAY_MS = 120

/**
 * The manifest beside a composition, given one brief second look.
 *
 * For a caller that is about to refuse the folder: a manifest being written is
 * not a folder without one, so the absence is only believed once it survives
 * {@link MANIFEST_SETTLE_DELAY_MS}.
 */
export async function readSettledCompositionManifest(
  absoluteFolder: string
): Promise<VideoProjectManifest | null> {
  const first = await readCompositionManifest(absoluteFolder)
  if (first) return first
  await new Promise((resolve) => setTimeout(resolve, MANIFEST_SETTLE_DELAY_MS))
  return readCompositionManifest(absoluteFolder)
}

/**
 * Whether a folder has a manifest file at all, whatever it holds.
 *
 * The difference between "no manifest" and "a manifest that cannot be read" is
 * the difference between a delivery and an authoring mistake, so it decides which
 * sentence a caller says.
 */
export async function hasCompositionManifestFile(absoluteFolder: string): Promise<boolean> {
  const info = await stat(join(absoluteFolder, VIDEO_PROJECT_MANIFEST)).catch(() => null)
  return info?.isFile() === true
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

/**
 * The manifest a composition must have to be edited, or why it cannot be.
 *
 * Three cases are told apart, because they are three different things to the user
 * and to the agent reading the reply. A folder with no manifest is a delivery of
 * media that plays where it is. A manifest that is there but wrong is a mistake in
 * the file, and the validator's own sentence about the field is the only useful
 * answer. A manifest that only looked absent because it was being rewritten opens
 * the folder, exactly as it would have a moment later.
 */
export async function requireCompositionManifest(
  absoluteFolder: string,
  display: string,
  known?: VideoProjectManifest | null
): Promise<VideoProjectManifest> {
  if (known) return known
  const settled = await readSettledCompositionManifest(absoluteFolder)
  if (settled) return settled
  if (!(await hasCompositionManifestFile(absoluteFolder))) {
    throw new Error(
      'This folder has no composition.json, so there is no frame size, rate or length to edit. A video delivered for the conversation plays where it is and is not an editable composition.'
    )
  }
  // The file is there, so the fault is in what it holds: name that instead of
  // sending the author looking for a missing file that is right in front of them.
  try {
    return await loadCompositionManifest(absoluteFolder, display)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const sentence = reason.endsWith('.') ? reason : `${reason}.`
    throw new Error(
      `${VIDEO_PROJECT_MANIFEST} is there but cannot be read as a composition yet: ${sentence} Nothing in the folder is lost; correct that field and open it again.`,
      { cause: error }
    )
  }
}
