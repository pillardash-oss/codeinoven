import { app } from 'electron'

/**
 * The two rendering defaults Windows gets wrong for this app, corrected before
 * the app is ready.
 *
 * Chromium reads both once, when the renderer starts, so they have to be
 * appended before the ready event. Nothing is appended on macOS or Linux: each
 * already settles on the behaviour this app wants.
 *
 * ## Text: grayscale antialiasing instead of ClearType
 *
 * `app.css` asks every document for `-webkit-font-smoothing: antialiased`. macOS
 * honours it and draws grayscale text; Windows ignores the property and keeps
 * ClearType, which is subpixel antialiasing. Chromium's own default confirms the
 * split: `is_lcd_text_enabled_` ends up `false` on macOS and `true` on Windows
 * (content/renderer/render_thread_impl.cc).
 *
 * Subpixel antialiasing fringes a light glyph on a dark surface with colour
 * because it drives the three subpixels of a pixel separately. On this app's
 * dark, monospaced surfaces that fringe reads as roughness rather than
 * crispness, and it is the one thing about Windows text that has no macOS
 * counterpart. `disable-lcd-text` drops Chromium to grayscale antialiasing and
 * makes Windows draw the way the app already draws on macOS.
 *
 * The switch is process wide, so the pages shown in the in-app browser take it
 * too. On a light surface grayscale text sits slightly softer than ClearType;
 * that is the price of matching the app's own rendering, and it is the same
 * price macOS already pays.
 *
 * ## Scrolling: animated regardless of the Windows animation setting
 *
 * Chromium animates main-thread scrolling only when it believes the system
 * does: `prefs.enable_scroll_animator` is set from `--enable-smooth-scrolling`,
 * or from `(!--disable-smooth-scrolling &&
 * gfx::Animation::ScrollAnimationsEnabledBySystem())`
 * (content/browser/web_contents/web_contents_impl.cc). That call is platform
 * specific, and the two desktop platforms resolve it differently:
 *
 * - Windows reads the "Animate controls and elements inside windows" setting,
 *   and falls back to `false` inside a Remote Desktop session
 *   (ui/gfx/animation/animation_win.cc). On a machine set that way the app
 *   scrolls in single jumps, which is the Windows-only symptom this fixes.
 * - macOS reads its own `NSScrollAnimationEnabled` default instead
 *   (ui/gfx/animation/animation_mac.mm).
 *
 * `enable-smooth-scrolling` takes the decision away from the Windows setting
 * entirely, so scrolling animates on Windows whatever the machine and session
 * are set to.
 *
 * ## Not used
 *
 * `disable-font-subpixel-positioning` looks like the third member of this set
 * but is Linux only. Chromium reads it in `font_render_params_linux.cc`; on
 * Windows the `FontRenderParams` come from `SPI_GETFONTSMOOTHING` in
 * `font_render_params_win.cc` and glyph subpixel positioning follows that
 * setting instead. Appending it here would change nothing, so it is left out.
 */
export function installWindowsRenderingDefaults(): void {
  if (process.platform !== 'win32') return
  app.commandLine.appendSwitch('disable-lcd-text')
  app.commandLine.appendSwitch('enable-smooth-scrolling')
}
