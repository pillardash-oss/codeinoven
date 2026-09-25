/**
 * App-level keyboard shortcuts intercepted before the renderer sees them.
 * `terminalFocused` is supplied by the caller because only the renderer knows
 * whether a terminal currently owns the keys.
 */

/**
 * Whether the shortcut closes the active surface. macOS only treats Cmd+W as
 * close (Ctrl+W must never close anything there); other platforms use Ctrl+W.
 */
export function isCloseShortcut(input: Electron.Input): boolean {
  return (
    input.type === 'keyDown' &&
    !input.isAutoRepeat &&
    (process.platform === 'darwin' ? input.meta : input.control) &&
    !input.alt &&
    input.key.toLowerCase() === 'w'
  )
}

/**
 * Whether the shortcut opens a new terminal tab while a terminal is focused.
 * macOS uses Cmd+T; other platforms use Ctrl+T.
 */
export function isNewTerminalShortcut(input: Electron.Input): boolean {
  return (
    input.type === 'keyDown' &&
    !input.isAutoRepeat &&
    (process.platform === 'darwin' ? input.meta : input.control) &&
    !input.alt &&
    input.key.toLowerCase() === 't'
  )
}
