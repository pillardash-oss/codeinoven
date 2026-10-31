import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'

/**
 * The two footer lanes under the editor's tracks, read as pure data.
 *
 * The fullscreen editor draws its tracks from the composition's edit, and the
 * conversation's comments and the agent's edits are not part of that document:
 * they arrive from two different stores. Both lanes need the same two things, a
 * place on the shared time scale and a way to stay readable when two of them
 * land on the same pixel, so the geometry lives here rather than inside the
 * markup.
 */

/** One comment written on this composition, wherever it was written from. */
export interface TimelineComment {
  reference: ResponseReferenceAnchor
  /**
   * The comment's number in the conversation's reference list, which is the
   * number its composer chip and the model use. A comment shown as `2` on the
   * timeline is `Video note 2` in the prompt.
   */
  number: number
  /** The second the comment sits at on the composition's timeline. */
  seconds: number
  /**
   * Whether the comment was drawn with the annotation tool on a frame rather
   * than written on a moment. A moment is a place on the timeline; a frame
   * annotation is a stroke over the picture shown there, so the two are named
   * differently even though both are a comment at one second.
   */
  annotation: boolean
}

/**
 * This composition's comments.
 *
 * A video note names its composition's folder, so a note written on another
 * composition in the same conversation never lands on this timeline. A frame
 * annotation names the folder for the same reason, and carries the second whose
 * frame was on screen when the stroke was drawn: a mark drawn on a still picture
 * (an artifact image, a captured picture with no composition) has no second on
 * this timeline and is drawn by the surface that owns the picture instead.
 */
export function timelineComments(
  references: readonly ResponseReferenceAnchor[],
  directory: string
): TimelineComment[] {
  if (!directory) return []
  const comments: TimelineComment[] = []
  for (const [index, reference] of references.entries()) {
    if (reference.directory !== directory) continue
    if (reference.kind === 'video') {
      comments.push({
        reference,
        number: index + 1,
        seconds: Math.max(0, reference.seconds ?? 0),
        annotation: false
      })
    } else if (reference.kind === 'image' && reference.markSeconds !== undefined) {
      comments.push({
        reference,
        number: index + 1,
        seconds: Math.max(0, reference.markSeconds),
        annotation: true
      })
    }
  }
  return comments.sort((left, right) => left.seconds - right.seconds)
}

/** The comments sitting inside one clip, so a track row can mark its own. */
export function commentsInsideClip(
  comments: readonly TimelineComment[],
  clip: { start: number; duration: number }
): TimelineComment[] {
  const end = clip.start + clip.duration
  return comments.filter((comment) => comment.seconds >= clip.start && comment.seconds < end)
}

/** Marks that read as one because they sit within a marker's width of each other. */
export interface TimelineCluster<T> {
  /** Stable key for the cluster, taken from its first mark. */
  key: string
  /** Left edge of the cluster on the shared time scale, in pixels. */
  x: number
  /** Every mark the cluster stands for, in time order. */
  items: T[]
}

/**
 * Fold marks that would overlap into one.
 *
 * Both lanes are a single row: a review lane's markers are squares and a
 * comment lane's are numbered badges, and two of either at the same second would
 * draw on top of each other, hiding one of them and taking its click. A cluster
 * keeps every mark reachable through its count and its title rather than
 * pretending the missing ones were never there.
 *
 * The gap is compared against the previous mark of the same cluster rather than
 * against the cluster's first mark, so a run of marks a couple of pixels apart
 * spreads across the lane instead of collapsing into one badge at the start of
 * the run.
 */
export function clusterTimelineMarks<T>(
  items: readonly T[],
  x: (item: T) => number,
  key: (item: T) => string,
  gap: number
): TimelineCluster<T>[] {
  const sorted = [...items].sort((left, right) => x(left) - x(right))
  const clusters: TimelineCluster<T>[] = []
  for (const item of sorted) {
    const left = x(item)
    const last = clusters[clusters.length - 1]
    const previous = last ? last.items[last.items.length - 1] : undefined
    if (last && previous !== undefined && left - x(previous) < gap) {
      last.items.push(item)
      continue
    }
    clusters.push({ key: key(item), x: left, items: [item] })
  }
  return clusters
}
