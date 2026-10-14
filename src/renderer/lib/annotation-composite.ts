import type { PromptAttachment, AttachmentStorageScope } from '$shared/types'
import { mimeTypeForPath } from '$shared/mime-types'
import { toPosixPath, posixBasename } from '$shared/paths'
import { invoke } from '$lib/ipc.svelte'
import { fileUrlToPath, pathToFileUrl } from '$lib/mime'
import { threadArtifactLocationForUrl } from '$lib/thread-artifact-url'
import { clampMarkStrokeWidth, markColor } from '$lib/annotation-marks'
import {
  annotatedFilename,
  baseBitmap,
  composePicture,
  type RasterMark
} from '$lib/annotation-raster'
import { referenceLabelNumber } from '$lib/reference-labels'
import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'

/**
 * The annotated picture the agent receives for the marks a user drew.
 *
 * A mark is stored as normalized points, which say where on the picture it is but
 * which no model can see. Sending the marks as text alone would ask the agent to
 * imagine the area; sending the picture with the marks drawn on it is what the
 * user describes ("the frame with a circle around the logo"), and the numbered
 * badges on it line up with the `Mark N` blocks in the prompt.
 *
 * This is the app half of that: it finds the file, reads its bytes and registers
 * the result as an attachment. The pixels are drawn by `$lib/annotation-raster`,
 * which is the same code for a still and for a frame of a video, so a frame
 * annotation costs the agent nothing extra to understand: it receives a picture,
 * like any other mark, beside text that names the file and the moment.
 *
 * It runs at send time rather than at draw time, so editing or removing a mark is
 * reflected in what actually leaves, and the composer draft never carries a stale
 * picture of a file that has since changed.
 */

/**
 * Ceiling on distinct pictures composed into one send. Each composition is a
 * decode plus a draw, and a video one also seeks and decodes a frame, so a
 * pathological composer holding a mark on every artifact cannot turn a send into
 * a batch job; the remaining marks still reach the agent as their text
 * descriptors.
 */
const MAX_COMPOSED_PICTURES = 4

interface MarkGroup {
  /** The media part the marks were drawn on. */
  url: string
  /** The second whose frame they belong to, or null for a still. */
  seconds: number | null
  marks: RasterMark[]
}

/**
 * Group the marks by the picture they were drawn on, numbering each one from the
 * label the composer shows so the badge and the prompt block agree.
 *
 * A frame annotation groups by its second as well, because one video holds many
 * moments: two marks four seconds apart are two pictures, and composing them onto
 * one frame would show the agent something the user never saw.
 */
function groupMarks(references: readonly ResponseReferenceAnchor[]): MarkGroup[] {
  const groups = new Map<string, MarkGroup>()
  references.forEach((reference, position) => {
    if (reference.kind !== 'image' || !reference.mediaUrl) return
    const points = reference.points
    if (!points || points.length === 0) return
    const seconds =
      reference.markSeconds !== undefined && Number.isFinite(reference.markSeconds)
        ? Math.max(0, reference.markSeconds)
        : null
    const key = `${reference.mediaUrl}\u0000${seconds === null ? '' : seconds.toFixed(3)}`
    const group = groups.get(key) ?? { url: reference.mediaUrl, seconds, marks: [] }
    group.marks.push({
      color: markColor(reference.markColor),
      number: referenceLabelNumber(reference.label, position),
      points: [...points],
      strokeWidth: clampMarkStrokeWidth(reference.markStrokeWidth),
      surfaceEdge: reference.markSurfaceEdge
    })
    groups.set(key, group)
  })
  return [...groups.values()]
}

/**
 * The bytes of an artifact picture.
 *
 * The part URL is an `appfile://` serve URL, which the renderer can display but
 * cannot read into a canvas without tainting it. The file itself lives inside
 * the project, so it is read back through the same scoped `file:read` the
 * rest of the renderer uses. A remote project has no local path to read, so its
 * marks reach the agent as text only rather than as a broken attachment.
 */
async function artifactBytes(
  url: string,
  projectPath: string
): Promise<Uint8Array<ArrayBuffer> | null> {
  const location = threadArtifactLocationForUrl(url)
  if (location) {
    const root = toPosixPath(projectPath).replace(/\/+$/u, '')
    if (!root) return null
    return window.api.readFile(`${root}/${location.relativePath}`)
  }
  if (url.startsWith('file://')) return window.api.readFile(fileUrlToPath(url))
  return null
}

/** The path a part URL names, so a media type and a filename can be derived. */
function pathForUrl(url: string): string {
  return threadArtifactLocationForUrl(url)?.relativePath ?? fileUrlToPath(url)
}

/** Compose one picture and its marks into a PNG attachment, or null. */
async function composeOne(
  group: MarkGroup,
  projectPath: string,
  scope: AttachmentStorageScope
): Promise<PromptAttachment | null> {
  const bytes = await artifactBytes(group.url, projectPath)
  if (!bytes) return null
  const path = pathForUrl(group.url)
  const bitmap = await baseBitmap({
    bytes,
    seconds: group.seconds,
    mime: mimeTypeForPath(path)
  })
  try {
    const blob = await composePicture(bitmap, group.marks)
    if (!blob) return null
    const filename = annotatedFilename(posixBasename(path) || 'image', group.seconds)
    const retained = await window.api.registerFileSelection(
      new File([blob], filename, { type: 'image/png' }),
      scope
    )
    if (!retained) return null
    return { mime: 'image/png', url: pathToFileUrl(retained), filename }
  } finally {
    bitmap.close()
  }
}

/**
 * The local workspace root a project's artifacts are served from.
 *
 * A remote project has no readable local root, and answers null: its marks then
 * travel as their own reference text instead of as a picture.
 */
async function localProjectPath(projectId: string): Promise<string | null> {
  try {
    const project = await invoke('project:get', projectId)
    return project && project.source === 'local' && project.path ? project.path : null
  } catch {
    return null
  }
}

/**
 * The annotated pictures for the marks in one outgoing message.
 *
 * Answers an empty list when there is nothing to draw, when the app has no
 * bridge (a test environment), or when a picture could not be read at all; a
 * send must never fail because a picture could not be produced.
 */
export async function composeMarkAttachments(input: {
  projectId: string
  scope: AttachmentStorageScope
  references: readonly ResponseReferenceAnchor[]
}): Promise<PromptAttachment[]> {
  if (typeof window === 'undefined' || !window.api) return []
  const groups = groupMarks(input.references).slice(0, MAX_COMPOSED_PICTURES)
  if (groups.length === 0) return []
  const projectPath = await localProjectPath(input.projectId)
  if (!projectPath) return []
  const attachments: PromptAttachment[] = []
  for (const group of groups) {
    try {
      const attachment = await composeOne(group, projectPath, input.scope)
      if (attachment) attachments.push(attachment)
    } catch {
      // One unreadable or undecodable picture must not sink the message: the
      // marks still travel as their own reference text.
    }
  }
  return attachments
}
