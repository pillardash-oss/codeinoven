/**
 * Tracks whether any embedded Ghostty terminal currently holds DOM focus.
 *
 * On Windows (and other non-mac platforms) Ctrl+W is both the app's "close the
 * active surface" shortcut and the shell's unix-word-rubout (delete the word
 * behind the cursor). When a terminal is focused the key must reach the shell,
 * so we mirror the focus state to the main process — which normally intercepts
 * Ctrl+W in `before-input-event` — and the renderer's own fallback shortcut
 * handler skips it too. macOS never treats Ctrl+W as a close shortcut, so this
 * only ever gates the non-mac path.
 */
let terminalFocused = false

/** Whether a terminal is currently focused (for renderer-side shortcut guards). */
export function isTerminalFocused(): boolean {
  return terminalFocused
}

/** Update focus state and mirror it to the main process for shortcut routing. */
export function setTerminalFocused(next: boolean): void {
  if (terminalFocused === next) return
  terminalFocused = next
  window.api?.send('terminal:focusState', next)
}
