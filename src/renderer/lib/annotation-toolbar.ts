import { createContext } from 'svelte'

/** Scoped destination for annotation controls in a media preview header. */
interface AnnotationToolbarHost {
  target: () => HTMLElement | undefined
}

export const [getAnnotationToolbarHost, setAnnotationToolbarHost, hasAnnotationToolbarHost] =
  createContext<AnnotationToolbarHost>()
