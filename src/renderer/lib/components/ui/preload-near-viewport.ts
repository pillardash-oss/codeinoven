/**
 * Fetch a media element's metadata only once the element is about to be seen.
 *
 * A conversation can hold dozens of recordings, and a mount-time
 * `preload="metadata"` made every one of them fetch its header while the thread
 * was still opening. Measured in the app browser against a 40 MiB MP4, the
 * first frame costs 6.3 MiB of read-ahead when the file's index sits at the
 * head and 8.0 MiB over 3 range requests when the index sits at the tail, which
 * is what a recording exported without `-movflags +faststart` looks like. None
 * of that work is wanted for a video the reader never scrolls to.
 *
 * The element keeps `preload="none"` in markup and this action flips it when
 * the observed node nears the viewport. Playback is unaffected: `play()`
 * selects the source whether or not the metadata was prefetched, and the
 * attribute is in place before any control can be reached, because reaching one
 * means the element was visible.
 */
const NEAR_VIEWPORT = '400px 0px'

interface PreloadNearViewportOptions {
  /**
   * The element to load, when it is not the node this action sits on.
   *
   * The audio player's element is `hidden` by design (the player draws its own
   * controls), and a hidden element never intersects the viewport, so the
   * action observes the player's surface and loads the element it finds there.
   */
  media?: () => HTMLMediaElement | null | undefined
}

export function preloadNearViewport(
  node: HTMLElement,
  options: PreloadNearViewportOptions = {}
): { destroy(): void } {
  /** The media element this action is about, once the node is in the document. */
  const resolveMedia = (): HTMLMediaElement | null => {
    const explicit = options.media?.()
    if (explicit) return explicit
    if (node instanceof HTMLMediaElement) return node
    return node.querySelector('audio, video')
  }

  const loadMetadata = (): void => {
    const media = resolveMedia()
    if (!media || media.preload === 'metadata') return
    media.preload = 'metadata'
    // The attribute alone does not always restart resource selection on an
    // element that was already told `none`, so ask it explicitly once.
    if (media.networkState === HTMLMediaElement.NETWORK_EMPTY) media.load()
  }

  if (typeof IntersectionObserver === 'undefined') {
    loadMetadata()
    return { destroy: () => undefined }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      loadMetadata()
    },
    { rootMargin: NEAR_VIEWPORT }
  )
  observer.observe(node)
  return { destroy: () => observer.disconnect() }
}
