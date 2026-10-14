import type { ResponseReferenceAnchor } from './stores/response-references.svelte'
import type { BrowserCompositionTab } from '$shared/ipc-contract'
import { videoCaptionAt, videoFrameAt, videoTimecode } from '$shared/video/timeline'
import type { VideoStudioDocument } from '$shared/video/studio'

/**
 * Turning a moment on a composition's timeline into a composer reference.
 *
 * A video note is a `PromptReference` like a response selection, a picked design
 * element and a document annotation, so the send path, the queue, the recovery
 * snapshot and the composer chips all carry it the same way. What differs is the
 * text the model reads: a design element is found by its CSS path, but a note on
 * a timeline is found by a time, so the descriptor answers "where in this file"
 * with a timecode, a frame number and what the composition is showing there.
 */

/** Ceiling on the descriptor, consistent with the design element reference. */
const MAX_DESCRIPTOR_LENGTH = 4_000

/** What a note needs to name its moment well, beyond the playhead itself. */
export interface VideoNoteContext {
  /** Project-relative composition folder the moment belongs to. */
  directory: string
  /** The composition the tab is showing, for duration and rate. */
  composition: BrowserCompositionTab | null
  /** The composition's saved edits, for the caption the moment falls inside. */
  document: VideoStudioDocument | null
  /** The browser tab showing the composition, when one is open. */
  tabId?: string
}

/**
 * The descriptor the model reads inside `<video>`.
 *
 * Deliberately plain `key: value` lines rather than JSON: the same text is
 * rendered in the composer popover, and a block of readable lines is what a
 * human wants there too. A caption the moment falls inside is quoted because it
 * is the most direct answer to "what is on screen here".
 */
export function videoNoteDescriptor(seconds: number, context: VideoNoteContext): string {
  const fps = context.composition?.fps ?? null
  const duration = context.composition?.duration ?? null
  const caption = videoCaptionAt(context.document, seconds)
  const lines = [
    `Composition: ${context.directory}`,
    `timecode: ${videoTimecode(seconds)}`,
    `seconds: ${Number.isFinite(seconds) ? Math.max(0, seconds).toFixed(3) : '0.000'}`,
    fps ? `frame: ${videoFrameAt(seconds, fps)} (at ${fps} fps)` : null,
    duration !== null ? `duration: ${duration}` : null,
    caption ? `caption: ${JSON.stringify(caption.text)}` : null
  ].filter((line): line is string => line !== null)
  return lines.join('\n').slice(0, MAX_DESCRIPTOR_LENGTH)
}

/**
 * Build the composer reference for one moment.
 *
 * The id is minted here rather than by a page, because nothing outside the app
 * draws this note: the timeline draws it, and the reference id is what ties the
 * composer chip back to the row on that timeline.
 */
export function videoNoteReference(
  id: string,
  seconds: number,
  context: VideoNoteContext
): ResponseReferenceAnchor {
  return {
    id,
    kind: 'video',
    // Renumbered to `Video note N` with its position when it is stored.
    label: 'Video note',
    text: videoNoteDescriptor(seconds, context),
    seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
    directory: context.directory,
    ...(context.tabId ? { tabId: context.tabId } : {})
  }
}

/** Mint an id for a note. Distinct from a page marker's id by its prefix. */
export function newVideoNoteId(): string {
  return `video-note-${crypto.randomUUID()}`
}
