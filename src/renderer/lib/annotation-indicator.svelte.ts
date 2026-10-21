import { SvelteMap } from 'svelte/reactivity'

/**
 * Where the reader dragged each annotation indicator.
 *
 * An indicator is drawn by whichever surface owns the thing being commented on,
 * and that surface already knows the place the comment belongs to: a passage, a
 * mark on a picture, a section of a specification. A drag is the one thing the
 * surface cannot know, and it has to outlive a re-render, so it is kept here,
 * per indicator, for as long as the app is running. Offsets are relative to the
 * place the surface chose, which means scrolling, re-measuring and resizing all
 * keep working while a moved indicator stays where the reader put it.
 */
const offsets = new SvelteMap<string, { x: number; y: number }>()

/** The stored drag for one indicator, or the origin when it was never moved. */
export function annotationIndicatorOffset(key: string): { x: number; y: number } {
  return offsets.get(key) ?? { x: 0, y: 0 }
}

export function setAnnotationIndicatorOffset(key: string, x: number, y: number): void {
  offsets.set(key, { x, y })
}

/** Send one indicator back to the place its surface chose. */
export function resetAnnotationIndicatorOffset(key: string): void {
  offsets.delete(key)
}
