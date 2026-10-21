import './app.css'
import { mount } from 'svelte'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { applyAppTypography, applyContrastLevel } from '$lib/app-typography'
import { logRendererError } from '$lib/system/renderer-logger'
import type { AppConfig } from '$shared/types'

/**
 * The entry for the browser overlay window.
 *
 * It loads the app's own stylesheet, because what is drawn here has to be what
 * the app window draws, down to the tokens and the font, and it mounts one
 * component: the surfaces that render the content the app renderer publishes
 * (the toast stack, and the browser's floating tab strip). Nothing else of the
 * app runs in this window, which is what keeps a second renderer cheap enough to
 * open for the duration of a toast or a hover.
 *
 * The theme arrives as a query parameter so the first paint is already in the
 * right palette; the content carries it from then on. The fonts are the app's own
 * appearance setting and are not part of that content, so they are read once
 * here: without them the same card draws at the stylesheet's default size in this
 * window and at the user's chosen one in the app window, and the handover
 * visibly resizes its text.
 */

document.documentElement.classList.toggle(
  'dark',
  new URLSearchParams(window.location.search).get('theme') === 'dark'
)

/**
 * Read the app's own appearance into this document.
 *
 * The windows this entry serves are the toast overlay and the floating tab
 * strip, and both draw with the app's stylesheet. Typography and the contrast
 * level are not part of the content that arrives afterwards, so they are applied
 * here, once, and again whenever the user changes one.
 */
function applyAppearance(config: AppConfig): void {
  applyAppTypography(document.documentElement, config)
  applyContrastLevel(document.documentElement, config.contrastLevel)
}

void invoke('config:get')
  .then(applyAppearance)
  .catch(() => {})

const stopTypography = subscribe('config:changed', applyAppearance)
window.addEventListener('pagehide', stopTypography, { once: true })

const target = document.getElementById('browser-overlay')
if (target) {
  const mode = new URLSearchParams(window.location.search).get('surface')
  document.documentElement.toggleAttribute('data-native-toasts', mode === 'toasts')
  const failed = (error: unknown): void =>
    logRendererError('The native overlay could not load', error)
  /**
   * One `import()` per surface, each in its own statement on purpose.
   *
   * Written as one expression that picks between three dynamic imports (a
   * ternary), the bundler emits a single shared preload list for all three and
   * computes it for only one branch. The toasts surface then never preloaded
   * `svelte-sonner`'s stylesheet   the card background, its border and the
   * absolute positioning of the stack   so in production, where that stylesheet
   * is a lazily-loaded CSS chunk rather than a style tag injected by the dev
   * server, every card drew transparent and unpositioned. Keep them separate, and
   * check `out/renderer`: every emitted `.css` must be named by the bundle or the
   * document that loads it.
   */
  if (mode === 'toasts') {
    void import('$lib/components/ui/NativeToastSurface.svelte')
      .then(({ default: component }) => mount(component, { target }))
      .catch(failed)
  } else if (mode === 'strip') {
    void import('$lib/components/ui/NativeStripSurface.svelte')
      .then(({ default: component }) => mount(component, { target }))
      .catch(failed)
  } else {
    void import('$lib/components/ui/BrowserOverlaySurface.svelte')
      .then(({ default: component }) => mount(component, { target }))
      .catch(failed)
  }
}
