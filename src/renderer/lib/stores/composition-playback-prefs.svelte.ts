import { APP_SLUG } from '$shared/brand'

const LOOP_KEY = `${APP_SLUG}.compositionLoop.v1`

function loadLoop(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem(LOOP_KEY)
    if (raw === 'on') return true
    if (raw === 'off') return false
  } catch {
    // Storage unavailable — fall back to the default.
  }
  return false
}

/**
 * How the user likes a composition played, kept across every video they watch.
 *
 * A composition's playback state belongs to the page that draws it, and a page
 * is armed again on every reload and started from its own defaults: looping off,
 * from the beginning. That is right for the page and wrong for the reader, who
 * turns looping off once and expects the next film to respect it. The preference
 * lives here, in the app rather than in a document, so a change made on one
 * composition is how the next one plays.
 */
class CompositionPlaybackPrefs {
  /** Whether playback starts again at the end. */
  loop = $state(loadLoop())
  mutedTabs = $state<Record<string, boolean>>({})

  setLoop(on: boolean): void {
    if (this.loop === on) return
    this.loop = on
    this.persist()
  }

  toggleLoop(): void {
    this.setLoop(!this.loop)
  }

  private persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(LOOP_KEY, this.loop ? 'on' : 'off')
    } catch {
      // The preference is optional; unavailable storage must not break playback.
    }
  }
}

export const compositionPlaybackPrefs = new CompositionPlaybackPrefs()
