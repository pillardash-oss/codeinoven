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

/**
 * The identity of one indicator: the surface drawing it plus the comment it draws.
 *
 * One function, because a surface that anchors something to an indicator (a
 * comment box under its own pin) has to reach the very indicator the component
 * registered, and two spellings of the same key would silently miss.
 */
export function annotationIndicatorKey(surface: string, id: string): string {
  return `${surface}:${id}`
}

/**
 * The element each indicator is drawn as, registered by the indicator itself.
 *
 * A surface needs this to place the comment box under the pin the reader is
 * editing, and only the component that draws the button knows which element it
 * is, so the component owns the registration. Every surface used to repeat the
 * same fixture   a reactive element map, a stable attachment per comment and a
 * lookup   and one of those copies wrote that map from a template expression,
 * which Svelte refuses. There is one copy, and it lives here.
 */
const elements = new SvelteMap<string, HTMLElement>()

/** The element one indicator is drawn as right now, or `undefined` before it mounts. */
export function annotationIndicatorElement(surface: string, id: string): HTMLElement | undefined {
  return elements.get(annotationIndicatorKey(surface, id))
}

/** Called by the indicator as it mounts; the returned function drops it again. */
export function registerAnnotationIndicatorElement(key: string, element: HTMLElement): () => void {
  elements.set(key, element)
  return () => {
    if (elements.get(key) === element) elements.delete(key)
  }
}

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
