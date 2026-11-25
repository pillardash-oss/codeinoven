import { BrowserWindow, app } from 'electron'

/**
 * Report whether this instance's window holds the keyboard.
 *
 * The region-screenshot chord is claimed by one process while the capture has to
 * land in the window the user is looking at, so every instance has to be able to
 * say where the user is. Electron's app-level focus events fire in the process
 * that owns the window, which is exactly the fact needed, and they cover the
 * popups and overlays this app opens beside its workspace window: any of them
 * taking focus means the user is working in this instance.
 *
 * The answer is published one turn later on purpose. A blur and the focus that
 * follows it (moving between two of this app's own windows, or between two
 * instances) arrive as two events, and only the state after both is true: asking
 * the window server once they have settled keeps a window switch from writing
 * "unfocused" and immediately undoing it.
 */
export function watchWindowFocus(publish: (focused: boolean) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null

  const publishSoon = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      publish(BrowserWindow.getFocusedWindow() !== null)
    }, 0)
    timer.unref?.()
  }

  app.on('browser-window-focus', publishSoon)
  app.on('browser-window-blur', publishSoon)
  // A window can already hold focus when this is installed, and no event will
  // repeat that: seed the answer so the first chord pressed after launch is
  // routed by the window that is on screen now.
  publish(BrowserWindow.getFocusedWindow() !== null)

  return () => {
    app.off('browser-window-focus', publishSoon)
    app.off('browser-window-blur', publishSoon)
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
