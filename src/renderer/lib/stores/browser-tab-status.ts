/**
 * Pure status rules for the audio and capture indicators a browser tab shows in
 * place of its favicon. Main reports the raw state through `browser:state`; this
 * module owns which indicator that state produces and how it is labelled, so the
 * sidebar strip, the fullscreen strip and any future surface cannot disagree.
 */

/** Live audio and capture state of one browser tab. */
export interface BrowserTabRuntime {
  /** True while the page is emitting audio to the output device. */
  audible: boolean
  /** True while the user muted this tab's audio output. */
  muted: boolean
  /** True while the page holds a live microphone, camera or screen capture. */
  capturing: boolean
}

/** The state of a tab nothing has been reported for, shared so an unknown tab
 *  never allocates a new object on every render. */
export const IDLE_BROWSER_TAB_RUNTIME: BrowserTabRuntime = Object.freeze({
  audible: false,
  muted: false,
  capturing: false
})

/**
 * The indicator kinds a tab can show in place of its favicon.
 * - `capture`: the tab is recording (microphone, camera or screen).
 * - `audio`: the tab is playing audio, or the user muted it and can unmute it.
 */
export type BrowserTabIndicator = 'capture' | 'audio'

/**
 * Which indicators a tab shows, in paint order. Capture leads, because a tab
 * that is recording is the state the user must not miss, and a tab can do both
 * at once: recording a call while that call plays audio. Muted counts as an
 * audio indicator so the crossed speaker stays on screen as the way back to
 * sound once the page goes quiet.
 */
export function browserTabIndicators(runtime: BrowserTabRuntime): BrowserTabIndicator[] {
  const indicators: BrowserTabIndicator[] = []
  if (runtime.capturing) indicators.push('capture')
  if (runtime.audible || runtime.muted) indicators.push('audio')
  return indicators
}

/** Accessible name and tooltip of the capture indicator. */
export const BROWSER_TAB_CAPTURE_LABEL = 'This tab is recording audio or screen'

/**
 * The width a tab's leading slot must reserve for a row of `count` indicators, so
 * the row can never paint over the tab title.
 *
 * The row starts 2px left of the slot (the indicator's own hit area) and each
 * indicator is 16px wide with a 2px gap: one indicator therefore covers exactly
 * the 12px a favicon occupies, while two need 26px, which is the 12px slot plus
 * the tab's icon-to-title spacing.
 */
export function browserTabIndicatorSlotClass(count: number): string {
  return count > 1 ? 'w-[1.625rem]' : 'w-3'
}

/** Accessible name and tooltip of the audio indicator, which is also the mute
 *  control: clicking it toggles the tab's audio output. */
export function browserTabMuteLabel(muted: boolean): string {
  return muted ? 'Unmute tab audio' : 'Mute tab audio'
}
