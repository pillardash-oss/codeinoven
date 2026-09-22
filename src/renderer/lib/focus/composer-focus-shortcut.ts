/**
 * Double-tap the primary modifier (Cmd on macOS, Ctrl elsewhere) to put the
 * caret back in the open chat composer, from anywhere in the app.
 *
 * The gesture is registered on the capture phase: global handlers further down
 * the tree stop keydown propagation for their own inputs (git rows, thread and
 * project selectors), and the gesture has to work while one of those holds
 * focus. A bare modifier keydown is inert for every input, so claiming it this
 * early is safe.
 */

import { isOverlayOpen } from '$lib/overlay-close.svelte'
import { isMacPlatform } from '$lib/shortcut-display'
import { getVoiceRecordingShortcut } from '$lib/speech/voice-shortcut'
import { focusVisibleComposer } from './composer-focus-registry'
import { PrimaryModifierTapDetector } from './primary-modifier-tap'

/** Install the gesture. Returns the uninstall function. */
export function initComposerFocusShortcut(): () => void {
  const detector = new PrimaryModifierTapDetector({
    primaryKey: isMacPlatform() ? 'Meta' : 'Control'
  })

  const onKeydown = (event: KeyboardEvent): void => {
    if (!detector.handleKeydown(event)) return
    // A modal surface (modal, sheet, palette, media preview, full screen
    // browser or terminal) runs its own focus trap, so focus must not be yanked
    // to a composer behind it.
    if (isOverlayOpen()) return
    // When the user moved their dictation binding onto the primary modifier,
    // that binding owns this tap: the app's voice shortcut already outranks
    // built-in chords, and doing both would start a recording and move focus at
    // the same time.
    if (isDictationBoundToPrimaryModifier()) return
    focusVisibleComposer()
  }

  const onKeyup = (event: KeyboardEvent): void => detector.handleKeyup(event)
  // A pointer press (Ctrl+click multi-select is not a tap) and a lost window
  // (which can deliver the modifier's keyup to another application) both cancel
  // a forming pair.
  const onReset = (): void => detector.reset()

  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('keyup', onKeyup, true)
  window.addEventListener('pointerdown', onReset, true)
  window.addEventListener('blur', onReset)
  return () => {
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('keyup', onKeyup, true)
    window.removeEventListener('pointerdown', onReset, true)
    window.removeEventListener('blur', onReset)
  }
}

/** True while the dictation binding is a double-tap of the platform's primary modifier. */
function isDictationBoundToPrimaryModifier(): boolean {
  const binding = getVoiceRecordingShortcut()
  if (!binding.doubleTap) return false
  return isMacPlatform()
    ? binding.code === 'MetaLeft' || binding.code === 'MetaRight'
    : binding.code === 'ControlLeft' || binding.code === 'ControlRight'
}
