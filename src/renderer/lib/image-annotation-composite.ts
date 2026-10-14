import type { PromptAttachment, AttachmentStorageScope } from '$shared/types'
import { toPosixPath, posixBasename } from '$shared/paths'
import { invoke } from '$lib/ipc.svelte'
import { fileUrlToPath, pathToFileUrl } from '$lib/mime'
import { threadArtifactLocationForUrl } from '$lib/thread-artifact-url'
import {
  IMAGE_MARK_BADGE_SIZE,
  imageMarkBadgePoint,
  isImageMarkTap,
  type ImageMarkPoint
} from '$lib/image-annotation'
import { referenceLabelNumber } from '$lib/reference-labels'
import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'

/**
 * The annotated screenshot the agent receives for the marks a user drew.
 *
 * A mark is stored as normalized points, which say where on the picture it is
 * but which no model can see. Sending the marks as text alone would ask the
 * agent to imagine the area; sending the picture with the marks drawn on it is
 * what the user describes ("a screenshot with annotations"), and the numbered
 * badges on it line up with the `Mark N` blocks in the prompt.
 *
 * This is the one place the picture is rebuilt with its marks. It runs at send
 * time rather than at draw time, so editing or removing a mark is reflected in
 * what actually leaves, and the composer draft never carries a stale screenshot.
 */

/**
 * Longest edge of a composed screenshot. Artifacts are bounded at 512 MiB by the
 * preview table, which is far larger than any model should be handed for a
 * picture the user marked; downscaling keeps the attachment inside the app's own
 * image limits and small enough to upload quickly.
 */
const MAX_ANNOTATED_EDGE = 1600

/**
 * Ceiling on distinct pictures composed into one send. Each composition is a
 * decode plus a draw, so a pathological composer holding a mark on every
 * artifact cannot turn a send into a batch job; the remaining marks still reach
 * the agent as their text descriptors.
 */
const MAX_COMPOSED_IMAGES = 4

/** Fallback for the accent when the app's theme cannot be read (tests, SSR). */
const FALLBACK_ACCENT = '#e5484d'

interface ComposedMark {
  points: ImageMarkPoint[]
  number: number
}

interface MarkGroup {
  url: string
  marks: ComposedMark[]
}

/** The stroke color, read from the live theme so the screenshot matches the app. */
function accentColor(): string {
  if (typeof document === 'undefined') return FALLBACK_ACCENT
  const value = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
  return value || FALLBACK_ACCENT
}

/**
 * Group the marks by the picture they were drawn on, numbering each one from
 * the label the composer shows so the badge and the prompt block agree.
 */
function groupMarks(references: readonly ResponseReferenceAnchor[]): MarkGroup[] {
  const groups = new Map<string, MarkGroup>()
  references.forEach((reference, position) => {
    if (reference.kind !== 'image' || !reference.imageUrl) return
    const points = reference.points
    if (!points || points.length === 0) return
    const group = groups.get(reference.imageUrl) ?? {
      url: reference.imageUrl,
      marks: []
    }
    group.marks.push({
      points: [...points],
      number: referenceLabelNumber(reference.label, position)
    })
    groups.set(reference.imageUrl, group)
  })
  return [...groups.values()]
}

/**
 * The bytes of an artifact picture.
 *
 * The part URL is an `appfile://` serve URL, which the renderer can display but
 * cannot read into a canvas without tainting it. The file itself lives inside
 * the project, so it is read back through the same scoped `file:read` the rest
 * of the renderer uses. A remote project has no local path to read, so its
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

/** Draw one mark: a haloed stroke for a drawn area, a dot for a tap. */
function drawMark(
  context: OffscreenCanvasRenderingContext2D,
  mark: ComposedMark,
  width: number,
  height: number,
  accent: string,
  strokeWidth: number
): void {
  const scale = Math.min(width, height)
  const first = mark.points[0]
  if (!first) return
  context.lineJoin = 'round'
  context.lineCap = 'round'
  if (isImageMarkTap(mark.points)) {
    const radius = strokeWidth * 1.6
    const x = first.x * width
    const y = first.y * height
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fillStyle = accent
    context.fill()
    context.lineWidth = strokeWidth
    context.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    context.stroke()
  } else {
    const trace = (): void => {
      context.beginPath()
      context.moveTo(first.x * width, first.y * height)
      for (const point of mark.points.slice(1)) {
        context.lineTo(point.x * width, point.y * height)
      }
      context.stroke()
    }
    // A light halo under the colored stroke keeps the mark readable over both a
    // bright and a dark picture, which is the whole point of drawing it.
    context.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    context.lineWidth = strokeWidth * 3
    trace()
    context.strokeStyle = accent
    context.lineWidth = strokeWidth
    trace()
  }

  const badge = imageMarkBadgePoint(mark.points)
  const radius = Math.max(IMAGE_MARK_BADGE_SIZE, Math.round(scale * 0.028)) / 2
  const x = Math.min(Math.max(badge.x * width, radius), width - radius)
  const y = Math.min(Math.max(badge.y * height, radius), height - radius)
  context.beginPath()
  context.arc(x, y, radius, 0, Math.PI * 2)
  context.fillStyle = accent
  context.fill()
  context.lineWidth = Math.max(2, radius / 5)
  context.strokeStyle = '#ffffff'
  context.stroke()
  context.fillStyle = '#ffffff'
  context.font = `600 ${Math.round(radius * 1.2)}px system-ui, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(String(mark.number), x, y)
}

/** Compose one picture and its marks into a PNG attachment, or null. */
async function composeOne(
  group: MarkGroup,
  projectPath: string,
  scope: AttachmentStorageScope
): Promise<PromptAttachment | null> {
  const bytes = await artifactBytes(group.url, projectPath)
  if (!bytes) return null
  const bitmap = await createImageBitmap(new Blob([bytes]))
  try {
    const longest = Math.max(bitmap.width, bitmap.height)
    const scale = longest > MAX_ANNOTATED_EDGE ? MAX_ANNOTATED_EDGE / longest : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0, width, height)
    const accent = accentColor()
    const strokeWidth = Math.max(3, Math.round(Math.min(width, height) * 0.007))
    for (const mark of group.marks) {
      drawMark(context, mark, width, height, accent, strokeWidth)
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const filename = annotatedFilename(
      posixBasename(threadArtifactLocationForUrl(group.url)?.relativePath ?? '') || 'image'
    )
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

function annotatedFilename(filename: string): string {
  const trimmed = filename.trim() || 'image'
  const withoutExtension = trimmed.replace(/\.[a-z0-9]{1,8}$/iu, '')
  return `${withoutExtension || 'image'}-annotated.png`
}

/**
 * The local workspace root a project's artifacts are served from.
 *
 * A remote project has no readable local root, and answers null: its marks then
 * travel as their own reference text instead of as a screenshot.
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
 * The annotated screenshots for the marks in one outgoing message.
 *
 * Answers an empty list when there is nothing to draw, when the app has no
 * bridge (a test environment), or when a picture could not be read at all; a
 * send must never fail because a screenshot could not be produced.
 */
export async function composeImageMarkAttachments(input: {
  projectId: string
  scope: AttachmentStorageScope
  references: readonly ResponseReferenceAnchor[]
}): Promise<PromptAttachment[]> {
  if (typeof window === 'undefined' || !window.api) return []
  const groups = groupMarks(input.references).slice(0, MAX_COMPOSED_IMAGES)
  if (groups.length === 0) return []
  const projectPath = await localProjectPath(input.projectId)
  if (!projectPath) return []
  const attachments: PromptAttachment[] = []
  for (const group of groups) {
    try {
      const attachment = await composeOne(group, projectPath, input.scope)
      if (attachment) attachments.push(attachment)
    } catch {
      // One unreadable or undecodable artifact must not sink the message: the
      // marks still travel as their own reference text.
    }
  }
  return attachments
}
