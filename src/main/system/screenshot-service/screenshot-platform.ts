/** Which region selector this session can use. */

export type ScreenshotSelector = 'macos' | 'overlay'

export function screenshotSelector(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): ScreenshotSelector | null {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'overlay'
  if (platform !== 'linux') return null
  // Wayland hands a screen over only through its portal. XWayland is no way
  // round that: it captures black, so the session decides and not the backend.
  if (env['XDG_SESSION_TYPE'] === 'wayland' || env['WAYLAND_DISPLAY']) return null
  return env['DISPLAY'] ? 'overlay' : null
}

/** Why this session has no selector, phrased for a toast. */
export function unsupportedScreenshotReason(platform: NodeJS.Platform = process.platform): string {
  return platform === 'linux'
    ? 'Region screenshots need an X11 session. Wayland is not supported yet: choose an X11 session when you sign in to use them.'
    : 'Region screenshots are not supported on this platform.'
}
